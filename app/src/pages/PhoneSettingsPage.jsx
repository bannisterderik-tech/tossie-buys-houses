import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import InlineField from '../components/InlineField.jsx';
import { formatPhone, fullDate } from '../lib/format.js';

/**
 * Phone and telephony settings — /settings/phone.
 *
 * This page reads and edits what the database knows about Tossie's numbers.
 * There is no Twilio credential in the browser and there must never be one,
 * because the auth token signs API calls that can buy numbers and place calls
 * on the account. Two buttons here do reach Twilio, and they reach it the only
 * way the browser is allowed to: by invoking the `twilio-numbers` edge
 * function, which holds the secret and does the talking.
 *
 *   Sync from Twilio        read-only. Pulls the account's numbers in so nobody
 *                           has to type an E.164 or a SID by hand — the two
 *                           values a typo makes silently wrong.
 *   Point webhooks at this  writes to the Twilio account. Deliberately per
 *   app                     number, deliberately not part of the sync, and
 *                           deliberately labelled as changing something over
 *                           there rather than here.
 *
 * Buying a number and filing A2P registration still happen in the Twilio
 * console; nothing on this page does either.
 *
 * The A2P section gets more words than anything else on purpose. "Pending" is
 * the state that generates every "why aren't my texts sending" question, and the
 * honest answer — it is a carrier queue, nothing here can hurry it, and there is
 * nothing to fix — is cheaper to write once than to explain repeatedly.
 */

/**
 * What each A2P 10DLC state actually means for the person running the business.
 * Tone drives colour only; `pending` is deliberately not styled as an error,
 * because it isn't one.
 */
const A2P = {
  not_started: {
    tone: 'wait',
    label: 'Not registered for texting',
    body: 'No A2P 10DLC brand or campaign has been filed for this number. Voice calls work today. Texting does not, and will not, until registration is filed in Twilio and the carriers approve it.',
  },
  pending: {
    tone: 'wait',
    label: 'Filed — waiting on the carriers',
    body: 'Texting is off until the carriers approve this, usually days to weeks. This is not an error and there is nothing on this page to fix. It is a queue at the mobile carriers, it moves on its own schedule, and sending anyway from an unregistered number gets the traffic filtered and can cost the campaign its approval.',
  },
  approved: {
    tone: 'ok',
    label: 'Approved for texting',
    body: 'The carriers cleared this number for application-to-person messaging. Turning on SMS below is what actually lets the app send from it.',
  },
  rejected: {
    tone: 'stop',
    label: 'Registration rejected',
    body: 'The carriers turned this filing down. Texting stays off until it is corrected and refiled in the Twilio console. Rejection is common on the first submission — usually a business detail that does not match the EIN record — and refiling is the normal path, not a dead end.',
  },
};

const A2P_STATUSES = Object.keys(A2P);

/**
 * The two fields on this page whose value Twilio consumes verbatim at call
 * time: forward_to_e164 goes into a <Dial> and voicemail_url into a <Play>.
 * Neither column has a database constraint — both are plain text — so a typo
 * saves cleanly, reads back looking correct, and then fails on a live call,
 * where the only person who finds out is the seller listening to silence.
 * This is the only place that can be caught, so it refuses the write.
 *
 * An empty value is always allowed: clearing the field is how the behaviour
 * gets turned off, and both columns are nullable for exactly that.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

function rejectionReason(fields) {
  if (fields.forward_to_e164 && !E164.test(fields.forward_to_e164)) {
    return 'Enter the forwarding number in E.164 — a plus sign, the country code, then digits, no spaces or dashes. Twilio dials this string exactly as stored.';
  }
  if (fields.voicemail_url && !/^https?:\/\/\S+$/.test(fields.voicemail_url)) {
    return 'The voicemail audio has to be a URL Twilio can fetch over the public internet — an mp3 or wav at http(s)://…';
  }
  return null;
}

/**
 * PostgREST answers an UPDATE that matched no row with 204 and no error — the
 * same shape as success. On a page whose switches decide whether texts go out,
 * that is the worst possible failure mode: the operator pauses sending, sees no
 * complaint, and the send path is still live. Asking for the affected rows back
 * is what turns "matched nothing" into something we can say out loud.
 */
const NOTHING_SAVED =
  'Nothing was saved — the row was not found or the change was refused, so the setting is unchanged from what is shown.';

/**
 * supabase-js raises FunctionsHttpError for any non-2xx and does not read the
 * body, so the reason the edge function refused is sitting unread on the
 * Response. Pulling it out is the difference between "Twilio sync failed" and
 * "TWILIO_AUTH_TOKEN is not set on this function" — and the second one is the
 * only version anybody can act on. The function goes to the trouble of naming
 * the exact missing secret; throwing that away here would waste it.
 */
async function explainInvokeError(error, fallback) {
  let payload = null;
  try { payload = await error?.context?.json?.(); } catch { /* not JSON; fall through */ }
  return payload?.message || payload?.error || error?.message || fallback;
}

export default function PhoneSettingsPage() {
  const [numbers, setNumbers] = useState([]);
  // Whether the last read came back. Empty state and "no such row" are honest
  // conclusions only when a query actually answered; after a failure they are
  // guesses, and both of this page's empty states name a specific cause that
  // would send someone off fixing the wrong thing.
  const [readFailed, setReadFailed] = useState(false);
  const [settings, setSettings] = useState(null);
  const [hardKill, setHardKill] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  // null | 'sms' | 'recording'. Two controls on this page ask before acting and
  // only one can be open at a time, so the key is the state rather than a flag
  // per control.
  const [confirming, setConfirming] = useState(null);
  const [syncing, setSyncing] = useState(false);
  // The per-number outcome of the last sync. Kept separate from `numbers`
  // because it answers a different question: the list says what is on file now,
  // this says what the sync did — and "unchanged" is the answer that stops
  // somebody clicking again wondering whether it worked.
  const [syncResult, setSyncResult] = useState(null);
  const [syncErr, setSyncErr] = useState(null);

  const load = useCallback(async () => {
    const [n, s, t] = await Promise.all([
      supabase.from('phone_numbers').select('*')
        .order('is_primary', { ascending: false }).order('created_at'),
      supabase.from('telephony_settings').select('*').eq('team_id', TEAM_ID).maybeSingle(),
      // Read-only here. teams.sms_send_disabled is the owner-only hard kill —
      // RLS restricts UPDATE to the owner — so this page reports it and does
      // not offer to flip it. A checkbox that silently fails is worse than none.
      supabase.from('teams').select('sms_send_disabled').eq('id', TEAM_ID).maybeSingle(),
    ]);
    const failed = n.error || s.error || t.error;
    // Clearing on success matters as much as setting on failure. Without it one
    // transient error leaves a red banner up for the rest of the session, and an
    // operator who learns to ignore the banner stops reading the one place this
    // page reports that a switch did not take.
    setErr(failed ? failed.message : null);
    setReadFailed(Boolean(failed));
    // Only overwrite from a query that actually answered. A failed read used to
    // land as an empty array, which renders the "nothing is set up yet" wizard
    // over an account that already has numbers — and that wizard's insert sets
    // is_primary, which then collides with the primary that really exists.
    if (!n.error) setNumbers(n.data ?? []);
    if (!s.error) setSettings(s.data ?? null);
    if (!t.error) setHardKill(Boolean(t.data?.sms_send_disabled));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchSettings = useCallback(async (fields) => {
    const bad = rejectionReason(fields);
    if (bad) { setErr(bad); return; }              // never optimistically show a value we refused
    setErr(null);
    setSettings((prev) => ({ ...prev, ...fields }));   // optimistic
    const { data, error } = await supabase
      .from('telephony_settings').update(fields).eq('team_id', TEAM_ID).select('team_id');
    // Reload before reporting, not after. load() owns the error banner and
    // clears it on a clean read, so setting the message first would have it
    // wiped a moment later — and the operator would see the switch snap back
    // with no explanation, which is the failure this was meant to end.
    await load();
    if (error) setErr(error.message);
    else if (!data?.length) setErr(NOTHING_SAVED);
  }, [load]);

  const patchNumber = useCallback(async (id, fields) => {
    const bad = rejectionReason(fields);
    if (bad) { setErr(bad); return; }
    setErr(null);
    setNumbers((prev) => prev.map((n) => (n.id === id ? { ...n, ...fields } : n)));
    const { data, error } = await supabase
      .from('phone_numbers').update(fields).eq('id', id).select('id');
    await load();                                       // see patchSettings
    if (error) setErr(error.message);
    else if (!data?.length) setErr(NOTHING_SAVED);
  }, [load]);

  /**
   * phone_numbers_one_primary_idx is a partial unique index on (team_id) WHERE
   * is_primary, so the old primary has to be cleared before the new one is set
   * — setting first just bounces off the index. That leaves a window with no
   * primary if the second statement fails, which is the safe direction to fail:
   * the send path reads "no default number" and refuses, rather than sending
   * from a number the seller has never seen.
   */
  async function makePrimary(id) {
    setErr(null);
    const cleared = await supabase.from('phone_numbers')
      .update({ is_primary: false }).eq('team_id', TEAM_ID).eq('is_primary', true);
    if (cleared.error) { await load(); setErr(cleared.error.message); return; }
    // .select() here is not cosmetic: the clear above already ran, so a second
    // statement that quietly matches nothing leaves the team with no primary at
    // all and no complaint on screen. Say so, because it needs a second attempt.
    const set = await supabase.from('phone_numbers')
      .update({ is_primary: true }).eq('id', id).select('id');
    await load();                                       // see patchSettings
    if (set.error) setErr(set.error.message);
    else if (!set.data?.length) {
      setErr('The primary was cleared but not reassigned, so no number is primary right now. Try again.');
    }
  }

  /**
   * Read Twilio, write the database. Nothing in the Twilio account changes, and
   * that is why this one is a plain button with no confirmation step: it is
   * safe to press at any time, and making it feel dangerous would train the
   * operator to hesitate over the wrong button.
   */
  const syncFromTwilio = useCallback(async () => {
    setSyncing(true);
    setSyncErr(null);
    setSyncResult(null);
    const { data, error } = await supabase.functions.invoke('twilio-numbers', {
      body: { action: 'sync' },
    });
    if (error) {
      setSyncErr(await explainInvokeError(error, 'The sync failed and the server gave no reason.'));
    } else if (data?.ok === false) {
      // Unreachable today — every refusal is a non-2xx — but a refusal answered
      // with 200 and read as success would leave the operator believing their
      // numbers are on file when none of them are.
      setSyncErr(data.message || 'The sync was refused and the server gave no reason.');
    } else {
      setSyncResult(data);
      await load();   // the rows the sync just wrote, read back from the database
    }
    setSyncing(false);
  }, [load]);

  if (loading) return <div className="empty">Loading…</div>;

  return (
    <>
      <header>
        <h1>Phone</h1>
        <span className="count">
          {readFailed && numbers.length === 0 ? 'not loaded'
            : numbers.length === 0 ? 'no numbers yet'
            : `${numbers.length} number${numbers.length === 1 ? '' : 's'}`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {hardKill && (
        <div className="banner stop">
          <strong>Account-level SMS kill switch is on.</strong>
          Nothing sends a text right now, whatever the switches below say. That flag
          lives on the team record and only the owner can clear it.
        </div>
      )}

      <div className="card">
        <h2>Numbers</h2>
        <p className="cardnote">
          What Twilio holds for this account. Numbers are bought and registered in the{' '}
          <a href="https://console.twilio.com/" target="_blank" rel="noreferrer">Twilio console</a>;
          the sync below is how the app finds out about them, so nobody has to
          copy a number or a SID across by eye.
        </p>

        <div className="body syncbar">
          <button className="btn ghost" onClick={syncFromTwilio} disabled={syncing}>
            {syncing ? 'Reading Twilio…' : 'Sync from Twilio'}
          </button>
          <p className="fine" style={{ marginTop: 6 }}>
            Reads the account and updates this list. It changes nothing in Twilio,
            and it never switches texting on — carrier capability is not A2P
            approval, so a synced number arrives voice-only and stays that way
            until someone turns texting on deliberately.
          </p>
        </div>

        {syncErr && <div className="err" style={{ margin: '0 17px 14px' }}>{syncErr}</div>}
        {syncResult && <SyncReport result={syncResult} />}

        {readFailed && numbers.length === 0 ? (
          <div className="empty">
            <strong>Could not read the numbers</strong>
            The reason is in the banner above. This is not the same as having no
            numbers, so nothing should be recorded here until the read works —
            adding one now would fight whatever is already on the account.
          </div>
        ) : numbers.length === 0 ? <NoNumbers onAdded={load} /> : (
          <>
            {numbers.map((n) => (
              <PhoneRow
                key={n.id}
                number={n}
                onPatch={(fields) => patchNumber(n.id, fields)}
                onMakePrimary={() => makePrimary(n.id)}
              />
            ))}
            <div className="body" style={{ borderTop: '1px solid var(--line)' }}>
              <AddNumber onAdded={load} isFirst={false} />
            </div>
          </>
        )}
      </div>

      {settings === null ? (
        <div className="card">
          <h2>Settings</h2>
          {readFailed ? (
            <div className="empty">
              <strong>Could not read the settings</strong>
              The reason is in the banner above. A read that did not answer is not
              evidence the row is missing, so this is not a migration problem until
              the read works and still comes back empty.
            </div>
          ) : (
            <div className="empty">
              <strong>No settings row for this team</strong>
              The telephony migration seeds one. If it is missing, the migration has
              not been applied to this project.
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="card">
            <h2>Calls</h2>
            <div className="body">
              <dl className="facts editable">
                <dt>Send from</dt>
                <dd>
                  {/* Distinct from is_primary: primary is the number that
                      represents the business, this is the one the send and dial
                      paths pick when the caller does not name one. Usually the
                      same number, and they are separate so they can differ. */}
                  <select
                    value={settings.default_number_id ?? ''}
                    onChange={(e) => patchSettings({ default_number_id: e.target.value || null })}
                    style={{ maxWidth: 260 }}
                  >
                    <option value="">— none chosen —</option>
                    {/* The "voice only" suffix is not decoration: picking a
                        number that is not SMS enabled silently stops every
                        text, because the send path refuses it. Saying so in the
                        option beats finding out from a refusal on the first
                        message a seller was supposed to get. */}
                    {numbers.map((n) => (
                      <option key={n.id} value={n.id}>
                        {formatPhone(n.e164)}
                        {n.friendly_name ? ` · ${n.friendly_name}` : ''}
                        {n.sms_enabled ? '' : ' — voice only'}
                      </option>
                    ))}
                  </select>
                </dd>

                <InlineField
                  label="Forward calls to"
                  value={settings.forward_to_e164}
                  onSave={(v) => patchSettings({ forward_to_e164: v })}
                  format={formatPhone}
                  placeholder="+19125550134"
                />
                <InlineField
                  label="Voicemail audio"
                  value={settings.voicemail_url}
                  onSave={(v) => patchSettings({ voicemail_url: v })}
                  placeholder="https://… (mp3 or wav)"
                />
              </dl>
              <p className="fine">
                A call nobody answers rings the forward-to number; if that does not
                pick up either, the voicemail audio plays. Leave both empty and an
                unanswered inbound call simply ends.
              </p>
            </div>
          </div>

          <div className="card">
            <h2>Call recording</h2>
            <div className="body">
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.recording_enabled}
                  onChange={(e) => {
                    // Turning recording OFF is the safe direction and goes
                    // through on the click. Turning it ON is the only control
                    // on this page that creates legal exposure the moment the
                    // next call connects, and a call recorded without the
                    // disclosure cannot be un-recorded — there is no undo to
                    // fall back on, so it asks first.
                    if (e.target.checked) setConfirming('recording');
                    else patchSettings({ recording_enabled: false });
                  }}
                />
                <span>
                  <strong>Record calls</strong>
                  <small>
                    Georgia and South Carolina are one-party-consent states. Florida
                    requires every party on the call to consent, and Florida is in the
                    six-state footprint this site markets to — so a recorded call with
                    a Florida homeowner needs a disclosure they can actually hear,
                    before the recording starts. That is a statement of where the law
                    differs, not legal advice: have your attorney review the wording
                    and where in the call it plays before you turn this on.
                  </small>
                </span>
              </label>

              {confirming === 'recording' && (
                <div className="confirm">
                  <strong>Start recording calls?</strong>
                  <p>
                    From the next call on, every call is recorded. If a Florida
                    homeowner is on the line and has not heard a disclosure they
                    could consent to, that recording is already made by the time
                    anyone notices — turning this back off does not undo it. Have
                    the disclosure wording and its placement in the call agreed
                    before saying yes.
                  </p>
                  <div className="confirmbtns">
                    <button
                      className="btn"
                      onClick={() => {
                        patchSettings({ recording_enabled: true });
                        setConfirming(null);
                      }}
                    >
                      Yes, record calls
                    </button>
                    <button className="btn ghost" onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Outbound texting</h2>
            <div className="body">
              <dl className="facts">
                <dt>Account kill switch</dt>
                <dd>
                  {hardKill
                    ? <span className="badge stop">On — nothing sends</span>
                    : <span className="badge ok">Off</span>}
                  <span className="fine"> owner-only, set on the team record</span>
                </dd>
                <dt>Sending</dt>
                <dd>
                  {settings.sms_send_paused
                    ? <span className="badge stop">Paused</span>
                    : <span className="badge ok">Live</span>}
                </dd>
                <dt>Last changed</dt>
                <dd>{fullDate(settings.updated_at)}</dd>
              </dl>

              {confirming === 'sms' ? (
                <div className="confirm">
                  <strong>
                    {settings.sms_send_paused
                      ? 'Resume outbound texting?'
                      : 'Pause outbound texting?'}
                  </strong>
                  <p>
                    {settings.sms_send_paused
                      ? 'Every part of the app that sends a text starts sending again the moment this is off. Queued follow-ups and SDR drafts that came due while it was paused do not replay by themselves — this only stops refusing new sends.'
                      : 'This refuses every outbound text, immediately, everywhere: the message box on a lead, the dialer’s follow-ups, and the SDR. Inbound texts still arrive and STOP is still honoured — suppression never depends on this switch.'}
                  </p>
                  <div className="confirmbtns">
                    <button
                      className="btn"
                      onClick={() => {
                        patchSettings({ sms_send_paused: !settings.sms_send_paused });
                        setConfirming(null);
                      }}
                    >
                      {settings.sms_send_paused ? 'Yes, resume sending' : 'Yes, pause all sending'}
                    </button>
                    <button className="btn ghost" onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  className={settings.sms_send_paused ? 'btn' : 'btn ghost'}
                  onClick={() => setConfirming('sms')}
                  style={{ marginTop: 12 }}
                >
                  {settings.sms_send_paused ? 'Resume outbound texting' : 'Pause all outbound texting'}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ── one number ─────────────────────────────────────────────────────────── */

function PhoneRow({ number: n, onPatch, onMakePrimary }) {
  const a2p = A2P[n.a2p_status] ?? A2P.not_started;
  // The database does not stop sms_enabled going true on an unregistered
  // number, and neither does this checkbox once A2P says approved — it only
  // refuses to be the place that turns texting on for a number the carriers
  // have not cleared. The real rail is the send path, which checks A2P itself.
  const canEnableSms = n.a2p_status === 'approved' || n.sms_enabled;

  return (
    <div className="phonerow">
      <div className="phonehead">
        <span className="e164">{formatPhone(n.e164)}</span>
        {n.friendly_name && <span className="nick">{n.friendly_name}</span>}
        <span className="spacer" />
        {n.is_primary
          ? <span className="badge ok">Primary</span>
          : <button className="chip" onClick={onMakePrimary}>Make primary</button>}
      </div>

      <div className={`a2p ${a2p.tone}`}>
        <div className="head">A2P 10DLC · {a2p.label}</div>
        <p>{a2p.body}</p>
        <p className="fine">
          Registration and its status live in Twilio —{' '}
          <a href="https://www.twilio.com/docs/messaging/compliance/a2p-10dlc" target="_blank" rel="noreferrer">
            what A2P 10DLC is
          </a>. Until a poller syncs it, the dropdown below is how this app learns
          what Twilio already decided; changing it here changes nothing at the carriers.
        </p>
      </div>

      <div className="toggles">
        <label className={n.voice_enabled ? '' : 'off'}>
          <input
            type="checkbox"
            checked={n.voice_enabled}
            onChange={(e) => onPatch({ voice_enabled: e.target.checked })}
          />
          Calls
        </label>
        <label className={n.sms_enabled ? '' : 'off'}>
          <input
            type="checkbox"
            checked={n.sms_enabled}
            disabled={!canEnableSms}
            onChange={(e) => onPatch({ sms_enabled: e.target.checked })}
          />
          Texts
        </label>
        {!canEnableSms && (
          <span className="why">Texting stays off until A2P reads approved.</span>
        )}
      </div>

      <dl className="facts editable">
        <InlineField
          label="Label"
          value={n.friendly_name}
          onSave={(v) => onPatch({ friendly_name: v })}
          placeholder="what this number is for"
        />
        <InlineField
          label="A2P status"
          value={n.a2p_status}
          onSave={(v) => {
            const next = v || 'not_started';
            // Recording that a number lost its approval has to take texting off
            // with it. The send path refuses a non-approved number regardless,
            // so leaving sms_enabled true would not actually send anything — it
            // would leave this row reading "Texts on" for a number the carriers
            // have not cleared, which is exactly the state someone spends an
            // afternoon on before finding the real answer.
            return onPatch(next === 'approved'
              ? { a2p_status: next }
              : { a2p_status: next, sms_enabled: false });
          }}
          options={A2P_STATUSES}
        />
        <InlineField
          label="Forward calls to"
          value={n.forward_to_e164}
          onSave={(v) => onPatch({ forward_to_e164: v })}
          format={formatPhone}
          placeholder="uses the team setting"
        />
        <dt>Twilio SID</dt>
        <dd style={{ wordBreak: 'break-all', color: 'var(--muted)' }}>
          {n.twilio_sid || <span>— <span className="fine">run a sync to fill this in</span></span>}
        </dd>
      </dl>

      <WebhookAction number={n} />
    </div>
  );
}

/* ── point one number's webhooks at this app ────────────────────────────── */

/**
 * The only control on this page that changes something in the Twilio account
 * rather than in this database, which is the entire reason it is a separate,
 * per-number, explicitly-labelled action instead of a step inside the sync.
 * Sync is safe to press at any time; this rewrites live call and message
 * routing, and if it points at the wrong place the person who finds out is a
 * seller listening to silence. Two different risks should not share a button.
 *
 * State is local rather than lifted: each row's outcome belongs to that row,
 * and a shared banner would make it ambiguous which number it was talking about
 * on an account with several.
 */
function WebhookAction({ number: n }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    const { data, error } = await supabase.functions.invoke('twilio-numbers', {
      body: { action: 'configure', number_id: n.id },
    });
    if (error) {
      setErr(await explainInvokeError(error, 'Twilio was not updated and gave no reason.'));
    } else if (data?.ok === false) {
      setErr(data.message || 'Twilio was not updated and gave no reason.');
    } else {
      setResult(data);
    }
    setBusy(false);
  }

  return (
    <div className="hookrow">
      <div className="hookhead">
        <button className="chip" onClick={run} disabled={busy}>
          {busy ? 'Updating Twilio…' : 'Point webhooks at this app'}
        </button>
        <span className="fine">
          Changes settings <strong>in the Twilio account</strong>, not here. Sets this
          number's voice and message webhooks to this app so inbound calls and texts
          reach it. Receiving texts needs no A2P approval — and it is what makes STOP
          work — so this is safe to do while registration is still pending.
        </span>
      </div>

      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}

      {result && (
        // The URLs are read back from Twilio's own response, not echoed from what
        // was sent, so what is printed here is what Twilio actually holds.
        <div className={`banner ${result.matches_requested ? '' : 'warn'}`} style={{ marginTop: 10 }}>
          <strong>
            {result.matches_requested
              ? 'Twilio updated.'
              : 'Twilio saved something other than what was asked for.'}
          </strong>
          <div className="hookurls">
            <span>Calls → <code>{result.voice_url || '—'}</code> ({result.voice_method || '—'})</span>
            <span>Texts → <code>{result.sms_url || '—'}</code> ({result.sms_method || '—'})</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── what the last sync did ─────────────────────────────────────────────── */

/**
 * Per number, not a count. "3 numbers synced" is the report that hides the one
 * thing worth knowing — which number changed, and how — and the whole point of
 * syncing rather than typing is that the values came from Twilio, so they are
 * worth showing back. `unchanged` is listed as loudly as the rest: a re-sync
 * that reports nothing at all looks like a sync that did not run.
 */
function SyncReport({ result }) {
  const TONE = { added: 'ok', updated: 'ok', unchanged: 'cold', failed: 'stop' };
  const { added = 0, updated = 0, unchanged = 0, failed = 0 } = result.counts ?? {};

  return (
    <div className="body syncreport">
      <strong style={{ fontSize: '0.9rem' }}>
        Read {result.twilio_count} number{result.twilio_count === 1 ? '' : 's'} from Twilio
        {' · '}{added} added, {updated} updated, {unchanged} unchanged
        {failed ? `, ${failed} failed` : ''}
      </strong>

      <ul className="synclist">
        {(result.numbers ?? []).map((r) => (
          <li key={r.e164}>
            <div className="line">
              <span className="e164">{formatPhone(r.e164)}</span>
              <span className={`badge ${TONE[r.result] ?? 'cold'}`}>{r.result}</span>
              {/* What Twilio says the line can carry. Shown because it is the
                  fact nobody can look up from memory, and because seeing "sms"
                  here next to texting still switched off is what prompts the
                  question the note below answers. */}
              <span className="fine">
                {['voice', 'sms', 'mms'].filter((c) => r.capabilities?.[c]).join(' · ') || 'no capabilities reported'}
              </span>
            </div>
            {r.message && <div className="fine">{r.message}</div>}
            {r.changed?.length > 0 && (
              <div className="fine">Updated: {r.changed.join(', ')}</div>
            )}
          </li>
        ))}
      </ul>

      {result.not_in_twilio?.length > 0 && (
        <p className="fine">
          On file here but not returned by Twilio:{' '}
          {result.not_in_twilio.map(formatPhone).join(', ')}. Left alone rather than
          deleted — messages and calls reference these rows. The usual cause is a
          number released in the console.
        </p>
      )}
    </div>
  );
}

/* ── nothing set up yet ─────────────────────────────────────────────────── */

/**
 * The empty state is the most useful screen this page has, because it is the
 * one an operator sees before anything works. It says what has to happen and in
 * what order rather than showing an empty table.
 */
function NoNumbers({ onAdded }) {
  return (
    <div className="body">
      <p style={{ marginTop: 0 }}>
        No numbers yet. Three things have to happen, in this order, and none of
        them can happen from this page:
      </p>
      <ol className="steps">
        <li>
          <strong>A Twilio account.</strong> One account for the business, paying
          its own bill. Voice needs nothing else — a number can dial the day it is
          bought.
        </li>
        <li>
          <strong>Buy a number</strong> in the{' '}
          <a href="https://console.twilio.com/" target="_blank" rel="noreferrer">Twilio console</a>,
          then press <strong>Sync from Twilio</strong> above so the app knows it
          exists. Prefer the sync to typing it in below: it brings the SID and the
          carrier capabilities with it, and those are the two fields a hand-entered
          row gets wrong in a way nothing complains about. Texting from the number
          also needs A2P 10DLC brand and campaign registration, which is filed in the
          same console and then waits on the carriers.
        </li>
        <li>
          <strong>Put the credentials in Supabase edge function secrets</strong> —
          <code>TWILIO_ACCOUNT_SID</code> and <code>TWILIO_AUTH_TOKEN</code>. The sync
          button needs both, and it will say which one is missing by name. Secrets
          only: never a <code>VITE_</code> variable and never a database column. The
          anon key ships in the JavaScript every visitor downloads, so anything
          reachable from the browser is public, and that token can place calls and
          spend money on the account.{' '}
          <a href="https://supabase.com/docs/guides/functions/secrets" target="_blank" rel="noreferrer">
            How Supabase stores function secrets
          </a>.
        </li>
      </ol>
      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <AddNumber onAdded={onAdded} isFirst />
      </div>
    </div>
  );
}

/**
 * Records a number that already exists in Twilio. This is bookkeeping, not
 * provisioning: it writes a row, it does not buy anything, verify anything or
 * point a webhook anywhere. Typing a number here that the account does not own
 * produces a row that nothing will ever match.
 */
function AddNumber({ onAdded, isFirst }) {
  const [open, setOpen] = useState(isFirst);
  const [e164, setE164] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const value = e164.trim();
    // E.164 is how Twilio reports every number, and matching happens on
    // phone_key() anyway — so a formatted number would still match. Insisting on
    // E.164 keeps the stored value byte-identical to what the webhooks post, so
    // nobody has to reconcile two spellings of the same number by eye later.
    if (!/^\+[1-9]\d{7,14}$/.test(value)) {
      setErr('Enter the number exactly as Twilio shows it, in E.164 — a plus sign, country code, then digits.');
      return;
    }
    setErr(null);
    setBusy(true);
    const { error } = await supabase.from('phone_numbers').insert({
      team_id: TEAM_ID,
      e164: value,
      friendly_name: name.trim() || null,
      // First number on the account becomes primary, because one number that is
      // nobody's primary is a configuration trap: the send path finds no default
      // and refuses, with nothing on screen explaining why.
      is_primary: isFirst,
    });
    setBusy(false);
    if (error) {
      // 23505 covers two different collisions here and both messages contain
      // the word "duplicate": the unique constraint on e164, and
      // phone_numbers_one_primary_idx, which this insert can hit because it
      // claims is_primary for the first number. Reporting the second as "already
      // recorded" sends the operator hunting for a number that is not in the
      // list, so the constraint name gets read rather than just the code.
      const dup = error.code === '23505';
      setErr(dup && /e164/.test(error.message) ? 'That number is already recorded.'
        : dup && /one_primary/.test(error.message)
          ? 'Another number is already the primary for this team. Reload the page — the list was out of date — and record this one from there.'
          : error.message);
      return;
    }
    setE164('');
    setName('');
    setOpen(isFirst);
    onAdded();
  }

  if (!open) {
    return <button className="btn ghost" onClick={() => setOpen(true)}>Record another number</button>;
  }

  return (
    <form onSubmit={submit}>
      <strong style={{ fontSize: '0.9rem' }}>Record a number you already own</strong>
      <p className="fine" style={{ marginTop: 4 }}>
        This writes down what Twilio already has. It does not buy the number,
        verify it, or configure its webhooks. <strong>Sync from Twilio</strong> does
        the same job without the typing and brings the SID with it; this is the
        fallback for a number the sync did not return.
      </p>
      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
      <div className="fields" style={{ marginTop: 10 }}>
        <label>Number (E.164)
          <input value={e164} onChange={(ev) => setE164(ev.target.value)} placeholder="+19125550134" />
        </label>
        <label>Label
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="main line" />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Record number'}
        </button>
        {!isFirst && (
          <button className="btn ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
        )}
      </div>
    </form>
  );
}
