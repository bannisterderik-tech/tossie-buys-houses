import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import InlineField from '../components/InlineField.jsx';
import DispositionBar from '../components/DispositionBar.jsx';
import { callingWindow } from '../lib/calling-window.js';
import {
  STATUSES, TEMPERATURES, OCCUPANCY,
  titleize, formatPhone, fullAddress, fullDate, timeAgo,
} from '../lib/format.js';

const money = (v) => `$${Number(v).toLocaleString()}`;

/**
 * Mirrors public.phone_key(): the last ten digits, never the formatted number.
 *
 * telephony_opt_outs stores keys, not numbers, because Twilio posts
 * +19125550134 and the seller typed (912) 555-0134. Matching on anything else
 * here would show "no opt-out on file" for a lead who is in fact suppressed —
 * the one direction this page must never be wrong in.
 */
function phoneKey(v) {
  return String(v ?? '').replace(/\D/g, '').slice(-10) || null;
}

/**
 * telephony_opt_outs.source in words. Not titleize(): the stored values are
 * storage, and "Sms stop" on the one line an operator reads before overriding a
 * suppression is the wrong register for what that line has to convey.
 */
const OPT_OUT_SOURCE = {
  sms_stop:  'a STOP text',
  manual:    'a manual entry',
  verbal:    'a verbal request',
  dnc_scrub: 'a DNC scrub',
};
const optOutSource = (s) => OPT_OUT_SOURCE[s] || s || 'an unrecorded source';

export default function LeadDetail({ id }) {
  const [lead, setLead] = useState(null);
  const [activity, setActivity] = useState([]);
  const [notes, setNotes] = useState([]);
  const [optOuts, setOptOuts] = useState([]);
  const [restores, setRestores] = useState([]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [l, a, n, r] = await Promise.all([
      // `dialable:lead_is_dialable` is the database function as a computed
      // column, the same way the dialer queue reads it. This page used to
      // re-derive the rule in JavaScript, and by the time telephony landed that
      // copy was already wrong: it had no idea telephony_opt_outs existed, so a
      // seller who had texted STOP still showed "Dialable: Yes" next to a live
      // Call button. Any rule with two implementations has one that is stale.
      supabase.from('leads').select('*, dialable:lead_is_dialable').eq('id', id).single(),
      supabase.from('lead_activity').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      supabase.from('lead_notes').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      // Every suppression an operator has lifted on this lead. Loaded whether
      // or not the lead is currently blocked, because the point of it is to be
      // visible long after the thing it records stopped having any effect.
      supabase.from('dnc_restore_log').select('*').eq('lead_id', id).order('restored_at', { ascending: false }),
    ]);
    if (l.error) setErr(l.error.message);

    // Opt-outs are keyed by number rather than by lead, so this one cannot join
    // the batch above — there is nothing to ask for until the lead row says
    // which numbers to ask about. Scoped to those keys rather than pulling the
    // team's whole suppression list into the browser to filter it here.
    const keys = [...new Set([phoneKey(l.data?.phone), phoneKey(l.data?.phone_mobile)].filter(Boolean))];
    const o = keys.length
      ? await supabase.from('telephony_opt_outs').select('*').in('phone_key', keys)
      : { data: [] };

    setLead(l.data ?? null);
    setActivity(a.data ?? []);
    setNotes(n.data ?? []);
    setRestores(r.data ?? []);
    setOptOuts(o.data ?? []);
    setLoading(false);
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const patch = useCallback(async (fields) => {
    setErr(null);
    setLead((prev) => ({ ...prev, ...fields }));   // optimistic
    const { error } = await supabase.from('leads').update(fields).eq('id', id);
    if (error) setErr(error.message);
    load();                                        // truth, plus any activity the triggers wrote
  }, [id, load]);

  // Numbers arrive from inputs as strings; the columns are integers.
  const patchNumber = (field) => (v) =>
    patch({ [field]: v === null ? null : Number(String(v).replace(/[^\d.-]/g, '')) || null });

  async function addNote(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const { error } = await supabase.from('lead_notes').insert({
      lead_id: id,
      team_id: lead.team_id,
      body,
      author_id: (await supabase.auth.getUser()).data.user?.id ?? null,
    });
    if (error) setErr(error.message);
    load();
  }

  if (loading) return <div className="empty">Loading…</div>;
  if (!lead) return <div className="empty"><strong>Lead not found</strong><a href="/app">Back to leads</a></div>;

  // Mobile first, matching lead_is_dialable()'s COALESCE(phone_mobile, phone).
  // Reading them the other way round meant the button dialed the landline on a
  // lead whose skip trace had found a verified mobile.
  const phone = lead.phone_mobile || lead.phone;
  // `=== true` because an undefined column must not read as dialable. If the
  // computed column ever stops arriving, this page refuses to offer a call
  // rather than offering one it cannot justify.
  const dialable = lead.dialable === true;
  // The same window the dialer enforces. This page is one click from every
  // blocked lead in the dialer ("Open the full lead"), so leaving the check off
  // here made that block cosmetic — the operator just clicked through to a live
  // Call button at 2am. `now` is not on a timer here because the detail page is
  // read and acted on, not left open as a queue; the dialer owns that case.
  const win = callingWindow(lead);
  const blocked = blockedWhy(lead, optOuts);

  return (
    <>
      <header>
        <h1>{lead.address || lead.name || 'Lead'}</h1>
        <span className="count">{fullAddress(lead)}</span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <button className="btn ghost" onClick={() => navigate('/')}>← All leads</button>
        {phone && dialable && win.allowed && (
          <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>Call {formatPhone(phone)}</a>
        )}
        {phone && dialable && !win.allowed && (
          <span className="badge warm" style={{ alignSelf: 'center' }}>
            {win.reason === 'unknown_timezone'
              ? 'Local time unknown — not callable'
              : `${win.localTime} there — outside 8am–9pm`}
          </span>
        )}
        {phone && !dialable && (
          <span className="badge stop" style={{ alignSelf: 'center' }}>
            Do not call — {blocked}
          </span>
        )}
        <select value={lead.status} onChange={(e) => patch({ status: e.target.value })}>
          {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={lead.temperature} onChange={(e) => patch({ temperature: e.target.value })}>
          {TEMPERATURES.map((t) => <option key={t} value={t}>{titleize(t)}</option>)}
        </select>
      </div>

      <div className="card">
        <h2>Log a call</h2>
        <div className="body">
          <DispositionBar leadId={id} onDone={load} />
        </div>
      </div>

      <div className="detail">
        <div>
          <div className="card">
            <h2>Seller</h2>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Name"   value={lead.name}  onSave={(v) => patch({ name: v })} />
                <InlineField label="Phone"  value={lead.phone} onSave={(v) => patch({ phone: v })} format={formatPhone} />
                <InlineField label="Email"  value={lead.email} onSave={(v) => patch({ email: v })} type="email" />
                <InlineField label="Second contact" value={lead.co_contact_name} onSave={(v) => patch({ co_contact_name: v })} placeholder="spouse, sibling, executor…" />
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Qualifying</h2>
            <p className="cardnote">
              The answers that decide whether this is a deal. Click any value to edit.
            </p>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Motivation" value={lead.motivation} onSave={(v) => patch({ motivation: v })} placeholder="why are they selling?" />
                <InlineField label="Timeline"   value={lead.timeline}   onSave={(v) => patch({ timeline: v })} placeholder="how fast do they need out?" />
                <InlineField label="Occupancy"  value={lead.occupancy}  onSave={(v) => patch({ occupancy: v })} options={OCCUPANCY} />
                <InlineField label="Condition"  value={lead.condition_notes} onSave={(v) => patch({ condition_notes: v })} type="textarea" placeholder="roof, HVAC, foundation, what they volunteered" />
                <InlineField label="Asking"     value={lead.asking_price}  onSave={patchNumber('asking_price')}  format={money} placeholder="what do they want?" />
                <InlineField label="ARV est."   value={lead.arv_estimate}  onSave={patchNumber('arv_estimate')}  format={money} />
                <InlineField label="Repairs est." value={lead.repair_estimate} onSave={patchNumber('repair_estimate')} format={money} />
                <InlineField label="Mortgage"   value={lead.mortgage_balance} onSave={patchNumber('mortgage_balance')} format={money} />
              </dl>

              <div className="flags">
                <Flag label="Already listed with an agent" on={lead.already_listed}
                      onChange={(v) => patch({ already_listed: v })} />
                <Flag label="Under contract with someone else" on={lead.under_contract_elsewhere}
                      onChange={(v) => patch({ under_contract_elsewhere: v })} />
                <Flag label="Liens or back taxes" on={lead.has_liens}
                      onChange={(v) => patch({ has_liens: v })} />
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Notes</h2>
            <div className="body">
              <form onSubmit={addNote}>
                <textarea
                  className="note"
                  placeholder="What did the seller say?"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div style={{ marginTop: 9 }}>
                  <button className="btn" type="submit" disabled={!draft.trim()}>Add note</button>
                </div>
              </form>

              {notes.length > 0 && (
                <ul className="timeline" style={{ marginTop: 16 }}>
                  {notes.map((n) => (
                    <li key={n.id}>
                      {n.body}
                      <span className="when">{fullDate(n.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Compliance</h2>
            <div className="body">
              <dl className="facts">
                <dt>Dialable</dt>
                <dd>
                  {/* The value is lead_is_dialable() itself, read off the row.
                      blockedWhy() only names the answer — it does not decide
                      it, which is why its vague last case is acceptable. */}
                  {dialable
                    ? <span className="badge ok">Yes</span>
                    : <span className="badge stop">{blocked}</span>}
                </dd>
                <dt>Local time there</dt>
                <dd>
                  {win.localTime || 'unknown'}
                  {win.guessed && ' (guessed — no area code or state resolved)'}
                </dd>
                <dt>Attempts</dt><dd>{lead.call_attempts}</dd>
                <dt>Last contact</dt><dd>{lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : 'never'}</dd>
                <dt>Next follow-up</dt><dd>{lead.next_follow_up_at ? fullDate(lead.next_follow_up_at) : '—'}</dd>
                <dt>TCPA opt-in</dt><dd>{lead.tcpa_opt_in ? fullDate(lead.tcpa_opt_in_at) : 'No'}</dd>
                <dt>Consent</dt>
                <dd>{[lead.consent_sms && 'SMS', lead.consent_email && 'Email'].filter(Boolean).join(' · ') || 'None'}</dd>
                <dt>Skip traced</dt><dd>{lead.skip_traced ? fullDate(lead.skip_traced_at) : 'No'}</dd>
                <dt>DNC scrubbed</dt><dd>{lead.dnc_scrubbed ? fullDate(lead.dnc_scrubbed_at) : 'No'}</dd>
              </dl>

              {lead.tcpa_disclosure_text && (
                <details style={{ marginTop: 14, fontSize: '0.83rem', color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    Disclosure shown ({lead.tcpa_disclosure_version})
                  </summary>
                  <p style={{ marginTop: 8 }}>{lead.tcpa_disclosure_text}</p>
                </details>
              )}

              {/* The two corrections, and they are deliberately not siblings in
                  weight. Clearing the flag is data repair; clearing an opt-out
                  is a decision about somebody who told us to stop. Anything
                  that presented them as two options in one list would be
                  inviting the operator to treat them as interchangeable. */}
              {lead.is_dnc && <ClearFlagAction leadId={id} hasOptOut={optOuts.length > 0} onDone={load} />}

              {optOuts.map((o) => (
                <ClearOptOutAction key={o.id} leadId={id} optOut={o} lead={lead} onDone={load} />
              ))}

              {restores.length > 0 && <RestoreHistory rows={restores} />}
            </div>
          </div>

          <div className="card">
            <h2>Capture</h2>
            <div className="body">
              <dl className="facts">
                <dt>Source</dt><dd>{titleize(lead.source)}</dd>
                <dt>Page</dt><dd style={{ wordBreak: 'break-all' }}>{lead.page_path || '—'}</dd>
                <dt>Created</dt><dd>{fullDate(lead.created_at)}</dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Timeline</h2>
            <div className="body">
              {activity.length === 0 ? (
                <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.88rem' }}>Nothing yet.</p>
              ) : (
                <ul className="timeline">
                  {activity.map((a) => (
                    <li key={a.id}>
                      {a.summary || titleize(a.type)}
                      <span className="when">{timeAgo(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Why lead_is_dialable() said no, in the order the reasons matter: the ones that
 * are somebody's legal position first, then the ones that are unfinished work.
 *
 * This decides nothing — the database already did, and `dialable` is its answer
 * verbatim. It only names the answer, which is why the vague fallback at the end
 * is acceptable and a re-derivation of the rule would not be.
 *
 * It used to end at "Suppressed" for anything involving an opt-out, because the
 * page did not read telephony_opt_outs and genuinely could not tell a STOP apart
 * from an unmet consent basis. It reads them now — a page that offers to clear
 * an opt-out has to be able to say one is there — so the STOP is named.
 */
function blockedWhy(lead, optOuts = []) {
  if (lead.is_dnc) return 'On DNC';
  if (lead.is_litigator) return 'Known litigator';
  if (lead.phone_invalid) return 'Wrong number';
  if (!lead.phone_mobile && !lead.phone) return 'No number';
  if (optOuts.length > 0) return 'Texted STOP';
  if (lead.trashed) return 'Trashed';
  if (lead.source === 'website' && !lead.tcpa_opt_in) return 'No opt-in on file';
  if (!lead.skip_traced) return 'Not skip traced';
  if (!lead.dnc_scrubbed) return 'Not DNC scrubbed';
  return 'Suppressed';
}

function Flag({ label, on, onChange }) {
  return (
    <label className="flag">
      <input type="checkbox" checked={Boolean(on)} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ── (A) the internal flag ───────────────────────────────────────────────── */

/**
 * Undoing a mis-tap, and shaped like it.
 *
 * leads.is_dnc is Tossie's own flag. It gets set by log_disposition
 * ('do_not_call') and by a wrong-number disposition, both of which are one tap
 * on a bar of eleven chips — so the realistic way a lead ends up here is that
 * the operator was aiming at the row above. When that is what happened, nobody
 * ever asked not to be called and there is nothing legally loaded about putting
 * it back.
 *
 * So this is a quiet link with one required field. The reason is required
 * because the flag is also set by real requests — a seller who said "don't call
 * me again" on the phone — and the difference between those two cases lives
 * nowhere except in the sentence the operator types. clear_lead_dnc refuses a
 * blank one; this disables the button so the refusal is not the first the
 * operator hears of it.
 */
function ClearFlagAction({ leadId, hasOptOut, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('clear_lead_dnc', {
      p_lead_id: leadId,
      p_reason: reason.trim(),
    });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    setOpen(false);
    setReason('');
    onDone?.();
  }

  if (!open) {
    return (
      <div className="repairbar">
        <button className="linkbtn" onClick={() => setOpen(true)}>Remove the do-not-call flag…</button>
        <span className="fine">
          Tossie&rsquo;s own flag, usually set by a disposition. Removing it is ordinary data repair.
        </span>
      </div>
    );
  }

  return (
    <div className="repairpanel">
      <strong>Remove the do-not-call flag?</strong>
      <p className="fine">
        This flag is set by a <em>Do not call</em> or wrong-number disposition. It is not a record of
        anything the seller sent us. If they did ask to be left alone, that is an opt-out and lives
        separately — this does not touch it.
      </p>
      {hasOptOut && (
        <p className="fine">
          <strong>There is also an opt-out on this lead.</strong> Removing this flag will not lift it,
          and the lead stays undialable until that is dealt with on its own.
        </p>
      )}
      {/* The disposition that set the flag also set the status to Dead and
          cleared the follow-up. Neither is rewound — what the status was
          beforehand is not recorded anywhere — so the lead comes back dialable
          but does not come back into the queue. Said here rather than left to
          be discovered, because the operator is one control away from fixing it
          and would otherwise conclude the removal did not work. */}
      <p className="fine">
        The status the disposition set is not undone with it. Set the status and the next follow-up
        above if this lead should go back into the queue.
      </p>

      <label className="repairfield">
        Why is it being removed? Kept on the lead.
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="mis-tapped the disposition bar on the row above"
          autoComplete="off"
        />
      </label>

      {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

      <div className="confirmbtns">
        <button className="btn" onClick={run} disabled={!reason.trim() || busy}>
          {busy ? 'Removing…' : 'Remove the flag'}
        </button>
        <button
          className="btn ghost"
          onClick={() => { setOpen(false); setReason(''); setErr(null); }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── (B) the opt-out the person asked for ────────────────────────────────── */

/**
 * The most legally loaded write in the product, and it does not get to look
 * like the control above it.
 *
 * A telephony_opt_outs row usually means this person texted STOP. Under the
 * TCPA the consumer is the party who revokes their own opt-out, by texting
 * START — an operator clearing it is making a decision on Tossie's behalf, not
 * fixing a typo. There are two defensible reasons to do it (the STOP came from
 * a number misattributed to this lead, or the person has since asked to be
 * contacted again, which is itself consent) and this panel says so, because an
 * operator who has one of those reasons should not have to guess whether the
 * app will let them.
 *
 * Four things separate it from ClearFlagAction, and every one costs a moment:
 *
 * 1. IT IS ALREADY LOUD WHEN CLOSED. The flag control is a grey link. This one
 *    states the fact — this person texted STOP, on this date — before anybody
 *    has clicked anything, because the operator needs to know that whether or
 *    not they intend to do something about it.
 * 2. IT SAYS WHO IS ACCOUNTABLE. Not "this is recorded" in the passive: the
 *    operator's name and their sentence go into dnc_restore_log and onto the
 *    lead timeline, and they read that here before they type.
 * 3. TYPE THE NUMBER. A reason box measures intent to write something. Typing
 *    the ten digits aims a few seconds of attention at the fact that decides
 *    whether this is the misattribution case — which number this actually is.
 * 4. THE SUPPRESSION IS ALL THAT LIFTS. Consent is not restored, and the panel
 *    says that too, so nobody comes away believing this re-opened the SMS
 *    channel by itself.
 */
function ClearOptOutAction({ leadId, optOut, lead, onDone }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Which of the lead's numbers this suppression is on. The stored value is a
  // phone_key, so it is matched rather than compared: the lead holds
  // "(912) 555-0134" and the opt-out holds "9125550134".
  const onNumber = [lead.phone_mobile, lead.phone]
    .filter(Boolean)
    .find((n) => phoneKey(n) === optOut.phone_key) || optOut.phone_key;

  // Compared on digits rather than byte-for-byte, unlike the release confirm on
  // the phone settings page: what is stored here IS the digits, so demanding a
  // particular punctuation would be testing typing rather than attention.
  const confirmed = phoneKey(typed) === optOut.phone_key;

  // sms_stop is the one that means the person themselves sent it. The others
  // were entered by us — a scrub hit, a note taken on a call — and the panel
  // says which, because "somebody told us to stop" and "a vendor's list said
  // so" are not the same thing to be overriding.
  const fromThePerson = optOut.source === 'sms_stop';

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('clear_phone_opt_out', {
      p_lead_id: leadId,
      p_number: optOut.phone_key,
      p_reason: reason.trim(),
    });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    setOpen(false);
    setTyped('');
    setReason('');
    onDone?.();
  }

  return (
    <div className="stoprepair">
      <strong>
        {fromThePerson
          ? `This person texted STOP from ${formatPhone(onNumber)}`
          : `${formatPhone(onNumber)} is on the suppression list`}
      </strong>
      <p className="fine">
        {fromThePerson
          ? 'Recorded by the inbound webhook when the message arrived on '
          : `Added by ${optOutSource(optOut.source)} on `}
        {fullDate(optOut.opted_out_at)}.
        {optOut.note ? ` “${optOut.note}”` : ''} Nothing may be sent or dialed to this number while
        it stands, and that is the right outcome unless one of two things is true.
      </p>

      {!open ? (
        <button className="btn danger sm" onClick={() => setOpen(true)}>
          Clear this opt-out…
        </button>
      ) : (
        <>
          <ul className="consequences">
            <li>
              Texting and dialing this number become <strong>possible again</strong> — the
              suppression that is stopping them is deleted.
            </li>
            <li>
              Normally the person lifts their own opt-out by texting <strong>START</strong>. Doing it
              for them is defensible in two cases: the STOP came from a number that is not
              theirs, or they have since asked to be contacted again.
            </li>
            <li>
              <strong>You are the one accountable for it.</strong> Your name, the date and the
              sentence you type below are written to the restore log and onto this lead&rsquo;s
              timeline, and stay there.
            </li>
            <li>
              SMS consent is <strong>not</strong> restored. Lifting a suppression is not the same as
              the seller agreeing to be contacted, and this does not claim it is.
            </li>
          </ul>

          <label className="repairfield stop">
            Type <code>{optOut.phone_key}</code> to confirm which number this is
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={optOut.phone_key}
              autoComplete="off"
              spellCheck="false"
              inputMode="numeric"
            />
          </label>

          <label className="repairfield stop">
            Why is this being cleared? Recorded with your name.
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="seller called in on the 14th and asked us to keep in touch"
              autoComplete="off"
            />
          </label>

          {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

          <div className="confirmbtns">
            <button className="btn danger" onClick={run} disabled={!confirmed || !reason.trim() || busy}>
              {busy ? 'Clearing…' : 'Clear the opt-out in my name'}
            </button>
            <button
              className="btn ghost"
              onClick={() => { setOpen(false); setTyped(''); setReason(''); setErr(null); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── what was lifted, and when ───────────────────────────────────────────── */

/**
 * Shown for as long as the lead exists, whether or not anything is currently
 * blocking it.
 *
 * A cleared STOP that leaves no visible mark is a thing that quietly happened
 * once: the lead looks ordinary afterwards, and the next person to work it has
 * no way to know that the number in front of them was suppressed until somebody
 * decided otherwise. That is the fact most worth knowing before dialing.
 *
 * Who did it is not repeated here — dnc_restore_log stores restored_by as a
 * uuid with no join to profiles through PostgREST, and the timeline entry above
 * already carries the name in its own sentence. This is the compact index; the
 * timeline is the account.
 */
function RestoreHistory({ rows }) {
  return (
    <div className="restorelog">
      <strong>Suppressions lifted on this lead</strong>
      <ul className="timeline">
        {rows.map((r) => (
          <li key={r.id}>
            {r.kind === 'opt_out'
              ? <>Opt-out cleared on {formatPhone(r.phone_key)}{r.prior_source ? ` (was ${optOutSource(r.prior_source)})` : ''}</>
              : <>Do-not-call flag removed</>}
            <span className="why">{r.reason}</span>
            <span className="when">{fullDate(r.restored_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
