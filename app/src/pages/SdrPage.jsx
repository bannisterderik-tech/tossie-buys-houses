import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import SdrPersonas from '../components/SdrPersonas.jsx';
import { timeAgo, titleize, fullAddress } from '../lib/format.js';
import { refusalFrom } from '../lib/sms-refusals.js';

/**
 * The AI SDR — /sdr.
 *
 * Two things live here, and the second one is the product.
 *
 * The mode card says what the SDR is currently allowed to do, in a sentence
 * rather than as three switches an operator has to assemble in their head.
 * "Auto" needs both halves — sdr_settings.default_mode = 'auto' AND
 * teams.sdr_auto_send_approved — and the second half is owner-only by RLS.
 *
 * The queue is every draft waiting on a human. Draft mode is not a trial period
 * that ends; it is how the SDR is supposed to run until Tossie has read enough
 * of its writing to believe it, and possibly forever. So the queue is the top of
 * the page's attention, and approving is a deliberate act with the seller's own
 * words sitting above the reply — an approval made without reading what was
 * asked is worth nothing.
 *
 * NOTHING ON THIS PAGE SENDS. Approving invokes ai-sdr, which writes the send
 * ledger and then hands the message to twilio-send-sms — the one door to Twilio,
 * holding the opt-out list, both kill switches, lead_is_dialable() and the
 * calling window. A refusal from any of those comes back here as a sentence.
 */

/**
 * The same expression as resolveMode() in supabase/functions/ai-sdr/index.ts,
 * and deliberately NOT the gate. The edge function re-resolves this on every
 * turn from the live config; if this display ever disagrees with it, the
 * function wins and the bug is on this page. It exists so an operator can read
 * one line instead of inferring the answer from two switches in two tables.
 */
function resolvedMode(settings, team) {
  return settings?.default_mode === 'auto' && team?.sdr_auto_send_approved === true ? 'auto' : 'draft';
}

/**
 * Would applying `fields` leave the SDR writing to sellers with nobody reading?
 *
 * The owner-approval button below asks before the permission is granted. This
 * asks before it is first exercised, which is a different moment and the one
 * that actually puts a message on the wire. Granting approval on a team whose
 * default mode is still 'draft' changes nothing; the flip of that dropdown, or
 * the SDR-enabled checkbox, is what starts it — and without this check that flip
 * is one click, unconfirmed, on the same page that makes the other half of the
 * same decision a two-step. The gate is two switches, so the question has to be
 * asked at whichever of them is thrown second.
 */
function goesLive(settings, team, fields) {
  const next = { ...settings, ...fields };
  return Boolean(next.enabled) && resolvedMode(next, team) === 'auto';
}

/**
 * PostgREST answers an UPDATE that matched no row with 204 and no error — the
 * same shape as success. Every write on this page therefore asks for the
 * affected rows back: on the full-auto switch that empty result IS the RLS
 * refusal, and it is the difference between "you are not the owner" and an
 * operator believing they just authorised a machine to text homeowners.
 */
const NOTHING_SAVED =
  'Nothing was saved — the row was not found or the change was refused, so the setting is unchanged from what is shown.';

const NOT_OWNER =
  'Nothing changed: approving full auto is owner-only, enforced by row-level security on teams, and this account is not the owner. Ask whoever owns the team to make the call — that is the point of the restriction, not a bug.';

/**
 * ai-sdr's own refusals. twilio-send-sms's vocabulary is handled by
 * refusalFrom(); these are the ones that never reach the send path, and each
 * one means the operator should look again rather than click again.
 */
const SDR_ERRORS = {
  draft_changed:
    'The SDR replaced this draft while it was on screen — the seller probably texted again. Nothing was sent. Reload and read the new one.',
  no_pending_draft: 'That draft is already gone; somebody approved or discarded it. Nothing was sent.',
  duplicate_turn: 'This exact message was already claimed for sending, so it was not sent a second time. Check the thread.',
  lead_has_no_phone: 'Nothing was sent: the lead has no phone number on it.',
  conversation_not_found: 'That conversation no longer exists. Reload the page.',
  ai_unavailable: 'The model could not be reached. Nothing was sent.',
};

/**
 * supabase-js raises FunctionsHttpError for any non-2xx and does not read the
 * body, so the reason ai-sdr refused is sitting unread on the Response. Pulling
 * it out is the difference between "approve failed" and "the seller texted
 * again while you were reading this".
 */
async function explainInvokeError(error, fallback) {
  let payload = null;
  try { payload = await error?.context?.json?.(); } catch { /* not JSON; fall through */ }
  const reason = payload?.error || payload?.reason || null;
  return SDR_ERRORS[reason] || payload?.message || reason || error?.message || fallback;
}

/**
 * How many drafts one read brings back. There has to be a ceiling, so the only
 * real question is which end of the queue falls off it — and the answer decides
 * whether the cap is harmless or is the bug. Ordered oldest-first, the rows past
 * the cap are the ones written seconds ago; ordered newest-first they are the
 * sellers who have been waiting longest, which is the opposite of what a queue
 * is for. The exact count is read alongside so the header can say 140 when 100
 * are on screen; a header that counts only what was fetched tells an operator
 * they are done when forty sellers are still waiting.
 */
const QUEUE_LIMIT = 100;

/** The last thing the seller actually typed, for the draft that answers it. */
function lastSellerMessage(conv) {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'lead') return msgs[i];
  }
  return null;
}

/**
 * Whether the clock is running.
 *
 * Reads sdr_scheduler_status(), which reports the SHAPE of the stored
 * credential and never the credential itself — its length and whether it
 * parses as a JWT. That is enough to tell "nothing stored" from "somebody
 * pasted the placeholder" from "armed", and none of it is a secret.
 */
function SchedulerBanner() {
  const [s, setS] = useState(null);

  useEffect(() => {
    supabase.rpc('sdr_scheduler_status').then(({ data }) => {
      setS(Array.isArray(data) ? data[0] : data);
    });
  }, []);

  if (!s) return null;
  if (s.armed) {
    return (
      <div className="banner ok">
        <strong>The SDR clock is running</strong>
        {s.reason}
      </div>
    );
  }
  return (
    <div className="banner stop">
      <strong>Enrolling leads will not send anything yet</strong>
      {s.reason}
      {' '}The schedule itself is fine — {s.jobs} of 2 jobs active
      {s.last_status ? `, last call returned ${s.last_status}` : ''}. Store the project's
      service role key in Vault under the name <code>sdr_cron_service_key</code> and the
      next tick picks it up; nothing needs redeploying.
    </div>
  );
}

export default function SdrPage() {
  const [settings, setSettings] = useState(null);
  const [team, setTeam] = useState(null);
  const [drafts, setDrafts] = useState([]);
  // Every draft waiting, not just the ones this read fetched. See QUEUE_LIMIT.
  const [waiting, setWaiting] = useState(0);
  const [loading, setLoading] = useState(true);
  // Whether the last read answered. "No drafts waiting" and "the SDR is off"
  // are honest conclusions only after a query came back; after a failed one
  // they are guesses, and both would tell an operator to stop looking.
  const [readFailed, setReadFailed] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmingAuto, setConfirmingAuto] = useState(false);

  const load = useCallback(async () => {
    const [s, t, d] = await Promise.all([
      supabase.from('sdr_settings').select('*').eq('team_id', TEAM_ID).maybeSingle(),
      // sdr_auto_send_approved is the half of the auto gate the owner holds;
      // sms_send_disabled is read because it makes approving pointless — the
      // send path refuses every outbound text while it is on, and finding that
      // out by pressing approve is finding it out too late.
      supabase.from('teams').select('sdr_auto_send_approved, sms_send_disabled')
        .eq('id', TEAM_ID).maybeSingle(),
      // The queue, longest-waiting first. `leads` embeds through the one foreign
      // key sdr_conversations has to it, so the row carries who this is about.
      // count:'exact' is the true depth of the queue regardless of the cap.
      supabase.from('sdr_conversations')
        .select('*, leads(id, name, owner_name, address, city, state, zip, sdr_persona_id)', { count: 'exact' })
        .not('pending_draft', 'is', null)
        .order('pending_draft_at', { ascending: true })
        .limit(QUEUE_LIMIT),
    ]);

    const failed = s.error || t.error || d.error;
    // Clearing on success matters as much as setting on failure: an operator
    // who learns to ignore a stuck red banner stops reading the one place this
    // page says a switch did not take.
    setErr(failed ? failed.message : null);
    setReadFailed(Boolean(failed));
    if (!s.error) setSettings(s.data ?? null);
    if (!t.error) setTeam(t.data ?? null);
    if (!d.error) {
      setDrafts(d.data ?? []);
      // ?? the fetched length rather than 0: a null count from PostgREST would
      // otherwise read as an empty queue with rows on screen underneath it.
      setWaiting(d.count ?? (d.data?.length ?? 0));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // A draft that needs a page refresh to appear is a seller waiting an extra
    // ten minutes. sdr_conversations is in the realtime publication for exactly
    // this (see the note at the end of 20260818130000_sdr.sql).
    const channel = supabase
      .channel('sdr-drafts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sdr_conversations' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const patchSettings = useCallback(async (fields) => {
    setErr(null);
    setSettings((prev) => ({ ...prev, ...fields }));      // optimistic
    const { data, error } = await supabase
      .from('sdr_settings').update(fields).eq('team_id', TEAM_ID).select('team_id');
    // Reload before reporting: load() owns the banner and clears it on a clean
    // read, so a message set first would be wiped a moment later and the switch
    // would snap back with no explanation.
    await load();
    if (error) setErr(error.message);
    else if (!data?.length) setErr(NOTHING_SAVED);
  }, [load]);

  const setAutoApproved = useCallback(async (value) => {
    setErr(null);
    setConfirmingAuto(false);
    const { data, error } = await supabase
      .from('teams').update({ sdr_auto_send_approved: value }).eq('id', TEAM_ID).select('id');
    await load();
    if (error) setErr(error.message);
    // Zero rows here is the RLS refusal, not a missing row — the SELECT policy
    // let us read this same team a moment ago.
    else if (!data?.length) setErr(NOT_OWNER);
  }, [load]);

  if (loading) return <div className="empty">Loading the SDR…</div>;

  const mode = resolvedMode(settings, team);
  const enabled = Boolean(settings?.enabled);

  return (
    <>
      <header>
        <h1>AI SDR</h1>
        <span className="count">
          {waiting === 0 ? 'no drafts waiting' : `${waiting} draft${waiting === 1 ? '' : 's'} waiting`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {!settings && !readFailed && (
        <div className="banner stop">
          <strong>There is no SDR settings row for this team</strong>
          The SDR treats a missing row exactly like a disabled one, so nothing is texting anyone.
          Re-running <code>20260818130000_sdr.sql</code> seeds it back, disabled and in draft mode.
        </div>
      )}

      {/* Armed or not, stated before anything else on the page.

          The SDR can be switched on, have leads enrolled, have a persona, and
          still never say a word — because the thing that actually sends the
          first message is a scheduled sweep, and that sweep needs a credential
          nobody can see from in here. When it is missing or wrong the only
          symptom is silence, which is indistinguishable from "no leads are
          due". This says which. */}
      <SchedulerBanner />

      <ModeCard
        settings={settings}
        team={team}
        mode={mode}
        enabled={enabled}
        confirmingAuto={confirmingAuto}
        setConfirmingAuto={setConfirmingAuto}
        onPatch={patchSettings}
        onSetAutoApproved={setAutoApproved}
      />

      <div className="card">
        <h2>Waiting for you</h2>
        {drafts.length === 0 ? (
          <div className="empty">
            <strong>
              {readFailed ? 'The queue could not be read' : enabled ? 'Nothing waiting' : 'The SDR is off'}
            </strong>
            {readFailed
              ? 'The error above is why. This is not the same as an empty queue.'
              : enabled
              ? 'Every reply the SDR has drafted has been approved, discarded or superseded by the seller texting again.'
              : 'Nothing is generating drafts. Turn the SDR on above once you want to read what it would say.'}
          </div>
        ) : (
          <>
            {/* Said out loud rather than left to the scrollbar: the rows past
                the cap are drafts for real sellers, and an operator who clears
                the visible hundred should know the queue is not empty. */}
            {waiting > drafts.length && (
              <div className="banner warn sdr-queuenote">
                <strong>Showing the {drafts.length} that have waited longest</strong>
                {waiting} are pending in total. Work through these and the next {waiting - drafts.length} appear.
              </div>
            )}
            {drafts.map((conv) => (
              <DraftRow key={conv.id} conv={conv} mode={mode} onDone={load} />
            ))}
          </>
        )}
      </div>

      <SdrPersonas />
    </>
  );
}

/** What the SDR is currently allowed to do, and the two switches that decide. */
function ModeCard({ settings, team, mode, enabled, confirmingAuto, setConfirmingAuto, onPatch, onSetAutoApproved }) {
  const approved = team?.sdr_auto_send_approved === true;
  const wantsAuto = settings?.default_mode === 'auto';

  // The settings change that would take the SDR live, held until it is
  // confirmed. Nothing is written while this is set — the controls below are
  // controlled by `settings`, so the switch visibly snaps back, which is the
  // truth: it has not been saved.
  const [pendingLive, setPendingLive] = useState(null);

  // Only asks on the transition. Re-asking on every toggle once the SDR is
  // already live is how a confirm becomes something people click through.
  const guardedPatch = (fields) => {
    if (goesLive(settings, team, fields) && !goesLive(settings, team, {})) setPendingLive(fields);
    else onPatch(fields);
  };

  return (
    <div className="card">
      <h2>Mode</h2>
      <div className="body">
        <div className={`a2p ${!enabled ? 'wait' : mode === 'auto' ? 'stop' : 'ok'}`}>
          <div className="head">
            {!enabled
              ? 'Off — the SDR is not reading or answering anything'
              : mode === 'auto'
              ? 'Full auto — replies go to sellers without anyone reading them'
              : 'Draft — every reply waits here for your approval'}
          </div>
          <p>
            {!enabled
              ? 'Inbound texts are still stored and still appear on the lead. Nothing is drafted and nothing is sent.'
              : mode === 'auto'
              ? 'The SDR writes and sends on its own. It still cannot name a price, and every message still passes the opt-out list, the kill switches and the 8am–9pm window in the seller’s local time — but no person sees it first.'
              : 'The SDR reads the reply, writes what it would say, and stops. Nothing reaches a seller until you press approve below.'}
          </p>
        </div>

        {team?.sms_send_disabled && (
          <div className="banner stop">
            <strong>The owner kill switch is on</strong>
            teams.sms_send_disabled stops every outbound text, so approving a draft here will be refused by the
            send path. Turn it off in phone settings first — only an owner can.
          </div>
        )}

        {enabled && !settings?.sms_channel_enabled && (
          <div className="banner warn">
            <strong>The SMS channel is off</strong>
            The SDR is on but sdr_settings.sms_channel_enabled is false, so it will not work a conversation over
            text. Nothing will appear in the queue.
          </div>
        )}

        {/* Same component as the owner-approval confirmation below, because it is
            the same kind of question asked at the other switch. */}
        {pendingLive && (
          <div className="confirm">
            <strong>This turns the SDR loose on sellers right now</strong>
            <p>
              Full auto is already approved for this team, so saving this leaves nothing between the model and a
              homeowner’s phone. Replies still clear the opt-out list, both kill switches and the 8am–9pm window in
              the seller’s own local time — what stops applying is a person reading the words first.
            </p>
            <div className="confirmbtns">
              <button className="btn" onClick={() => { setPendingLive(null); onPatch(pendingLive); }}>
                Yes, go live
              </button>
              <button className="btn ghost" onClick={() => setPendingLive(null)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="toggles" style={{ marginTop: 14 }}>
          <label className={enabled ? '' : 'off'}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => guardedPatch({ enabled: e.target.checked })}
            />
            SDR enabled
          </label>
          <label className={settings?.sms_channel_enabled ? '' : 'off'}>
            <input
              type="checkbox"
              checked={Boolean(settings?.sms_channel_enabled)}
              onChange={(e) => onPatch({ sms_channel_enabled: e.target.checked })}
            />
            Answer by SMS
          </label>
          <span className="why">
            Individual leads can still be taken off the SDR one at a time; this is the switch for all of them.
          </span>
        </div>

        <div className="sdr-modepick">
          <label>
            Default mode
            <select
              value={settings?.default_mode ?? 'draft'}
              onChange={(e) => guardedPatch({ default_mode: e.target.value })}
            >
              <option value="draft">Draft — hold every reply for approval</option>
              <option value="auto">Auto — send without approval</option>
            </select>
          </label>
          {/* Setting this to auto on its own changes nothing, and saying so here
              is cheaper than an operator concluding the setting is broken. */}
          <p className="fine">
            {wantsAuto && !approved
              ? 'Set to auto, and it is doing nothing: full auto also needs the owner’s approval below. Until then every reply is still a draft.'
              : 'This is the team default. A lead can override it to draft on its own record.'}
          </p>
        </div>

        {/* The owner gate. Turning it ON asks first, because it is the one
            control on this page that lets a machine speak to a homeowner with
            nobody reading; turning it OFF is one click, because a de-escalation
            that makes you confirm is a de-escalation that happens too slowly. */}
        <div className={`sdr-owner ${approved ? 'on' : ''}`}>
          <strong>{approved ? 'Full auto is approved' : 'Full auto is not approved'}</strong>
          <p className="fine">
            teams.sdr_auto_send_approved. The teams_update_owner policy restricts UPDATE on the whole row to the
            team owner, so this is the half of the gate a member cannot flip — setting the default mode to auto
            above is the other half, and neither works alone.
          </p>

          {approved ? (
            <button className="btn ghost" onClick={() => onSetAutoApproved(false)}>
              Withdraw approval
            </button>
          ) : confirmingAuto ? (
            <div className="confirm">
              <strong>Let the SDR text sellers with nobody reading first?</strong>
              <p>
                Every message it sends is from Tossie Buys Houses, to a homeowner, in Tossie’s name. The price
                guardrail, the opt-out list and the calling window all still apply — what stops applying is you.
                Read a couple of weeks of drafts before this, not after.
              </p>
              <div className="confirmbtns">
                <button className="btn" onClick={() => onSetAutoApproved(true)}>Approve full auto</button>
                <button className="btn ghost" onClick={() => setConfirmingAuto(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn ghost" onClick={() => setConfirmingAuto(true)}>
              Approve full auto…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One draft: what the seller said, what the SDR wants to say back, and the three
 * things a person can do about it.
 *
 * The body is editable before approving. ai-sdr deliberately does not re-run the
 * price guardrail on an edited draft — the guardrail exists because a model
 * cannot be trusted with a number, and a human who types one is the judgment
 * this whole design defers to.
 */
/**
 * Thumbs on one message, with the note being the part that matters.
 *
 * A bare thumbs-down teaches nothing — apply_sdr_feedback refuses one without a
 * note, deliberately — so the note box opens with the rating rather than hiding
 * behind a second click. Rating the SDR's draft rather than the operator's
 * edited version is the whole point: the edit is a human's sentence, and what
 * needs correcting is the script that produced the original.
 */
function RateMessage({ conv, lead, body }) {
  const [sent, setSent] = useState(null);
  const [rating, setRating] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!body) return null;
  if (sent) return <span className="fine">Thanks — noted{sent === 'down' ? ' for the script' : ''}.</span>;

  async function save(r) {
    setBusy(true);
    const { error } = await supabase.from('sdr_message_feedback').insert({
      team_id: TEAM_ID,
      conversation_id: conv.id,
      lead_id: lead?.id ?? null,
      persona_id: lead?.sdr_persona_id ?? null,
      rating: r,
      body,
      note: note.trim() || null,
    });
    setBusy(false);
    if (!error) setSent(r);
  }

  if (!rating) {
    return (
      <span className="ratebtns">
        <button className="btn ghost" title="Good message" onClick={() => setRating('up')}>Good</button>
        <button className="btn ghost" title="Bad message — say why" onClick={() => setRating('down')}>Bad</button>
      </span>
    );
  }

  return (
    <span className="ratebtns">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={rating === 'down' ? 'What was wrong with it?' : 'What worked? (optional)'}
        disabled={busy}
      />
      <button className="btn" disabled={busy || (rating === 'down' && !note.trim())} onClick={() => save(rating)}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => { setRating(null); setNote(''); }}>
        Cancel
      </button>
    </span>
  );
}

function DraftRow({ conv, mode, onDone }) {
  const [body, setBody] = useState(conv.pending_draft ?? '');
  const [busy, setBusy] = useState(null);   // null | 'approve' | 'discard' | 'claim'
  const [problem, setProblem] = useState(null);

  // The draft can be replaced under us by the seller texting again. Following
  // the row rather than keeping the first value means the operator is never
  // editing words that no longer exist.
  useEffect(() => { setBody(conv.pending_draft ?? ''); }, [conv.pending_draft]);

  const lead = conv.leads ?? null;
  const inbound = lastSellerMessage(conv);
  const edited = body.trim() !== (conv.pending_draft ?? '').trim();

  const act = useCallback(async (kind, payload) => {
    setBusy(kind);
    setProblem(null);
    const { data, error } = await supabase.functions.invoke('ai-sdr', { body: payload });
    setBusy(null);

    if (error) {
      setProblem(await explainInvokeError(error, 'The SDR refused and gave no reason. Nothing was sent.'));
      return;
    }
    // A blocked send comes back 200 with a reason from twilio-send-sms's
    // vocabulary — opted_out, outside_texting_window, sms_send_paused. Reading
    // it as success would tell the operator a seller got a message they never
    // got, and clear the draft that is the only copy of it.
    //
    // Keyed on sent === false alone, with no `&& data.reason`: a refusal that
    // arrives without a reason is the least known outcome there is, and treating
    // it as success is the one reading that is certainly wrong. SDR_ERRORS is
    // consulted first because ai-sdr can refuse before the send path is ever
    // reached — duplicate_turn comes back here as a `reason`, and refusalFrom
    // only knows twilio-send-sms's vocabulary, so it would answer with the
    // fallback sentence while the accurate one sat unused two screens up.
    if (data?.sent === false) {
      setProblem(
        SDR_ERRORS[data.reason]
          || refusalFrom(data, 'The send was refused and the server gave no reason, so whether the text went out is unknown. Check the thread before retyping it.').text,
      );
      return;
    }
    if (data?.error) {
      setProblem(SDR_ERRORS[data.error] || data.error);
      return;
    }
    await onDone();
  }, [onDone]);

  return (
    <div className="sdr-draft">
      <div className="sdr-draft-head">
        <div>
          {lead
            ? <a href={`/app/leads/${lead.id}`}><strong>{lead.name || lead.owner_name || 'Unnamed seller'}</strong></a>
            : <strong>Lead unavailable</strong>}
          <span className="sub">{lead ? (fullAddress(lead) || 'no address on file') : ''}</span>
        </div>
        <div className="sdr-draft-meta">
          <span className="badge">{titleize(conv.step)}</span>
          {typeof conv.score === 'number' && <span className="badge">score {conv.score}</span>}
          <span className="fine">{timeAgo(conv.pending_draft_at)}</span>
        </div>
      </div>

      {/* The seller's words, above the reply, always. An approval given without
          reading what was asked is a signature on a blank page. */}
      <div className="sdr-said">
        <span className="k">They said</span>
        {inbound ? <p>{inbound.content}</p> : <p className="fine">No inbound message on this conversation yet.</p>}
      </div>

      <label className="sdr-reply">
        <span className="k">The SDR wants to reply</span>
        <textarea
          className="note"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>

      <div className="sdr-draft-foot">
        <span className="fine">
          {body.length} characters{body.length > 160 ? ' — over one SMS segment' : ''}
          {edited ? ' · edited' : ''}
        </span>
        {/* Rated on what the SDR wrote, not on the operator's edit — the point
            is to teach the script, and an edited body is the human's sentence. */}
        <RateMessage conv={conv} lead={lead} body={conv.pending_draft ?? ''} />
        <div className="confirmbtns">
          <button
            className="btn"
            disabled={busy !== null || !body.trim()}
            onClick={() => act('approve', {
              action: 'approve_draft',
              conversation_id: conv.id,
              body,
              // Approve exactly what was read: if the SDR regenerated this
              // draft between render and click, ai-sdr refuses rather than
              // sending words nobody saw.
              expected_hash: conv.pending_draft_hash,
            })}
          >
            {busy === 'approve' ? 'Sending…' : edited ? 'Send my version' : 'Approve & send'}
          </button>
          <button
            className="btn ghost"
            disabled={busy !== null}
            onClick={() => act('discard', { action: 'discard_draft', conversation_id: conv.id })}
          >
            Discard
          </button>
          {/* Standing the SDR down is not the same as throwing one draft away:
              it stops the follow-ups too, which is what someone means when they
              say "I'll text this one myself". */}
          <button
            className="btn ghost"
            disabled={busy !== null}
            onClick={() => act('claim', { action: 'claim_lead', conversation_id: conv.id })}
          >
            I’ll take this one
          </button>
        </div>
      </div>

      {problem && <div className="err" style={{ margin: '12px 0 0' }}>{problem}</div>}

      {mode === 'auto' && (
        <p className="fine">
          This one is a draft even though the team is on full auto — the lead is set to draft, or the SDR stopped
          itself on this turn.
        </p>
      )}
    </div>
  );
}
