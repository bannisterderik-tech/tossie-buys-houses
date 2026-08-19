import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import DispositionBar from '../components/DispositionBar.jsx';
import { callingWindow } from '../lib/calling-window.js';
import { formatPhone, fullAddress, titleize, timeAgo, fullDate } from '../lib/format.js';

/** A day's work, not a database dump. Past this the operator reloads. */
const QUEUE_LIMIT = 200;

/** How many of the waiting leads to draw. The queue is worked from the front. */
const PEEK = 25;

/**
 * The call queue.
 *
 * Call, disposition, next. That loop is the page; everything else on it is
 * context for the one lead in front of you.
 *
 * What is deliberately not here is the browser softphone. Reoperative dials
 * through @twilio/voice-sdk into a Twilio conference per session
 * (`BrowserDialer.jsx`, `PowerDialer.jsx`), which needs an npm dependency this
 * app has not taken and Twilio credentials that do not exist yet. Until both
 * land, Call hands off to the operating system with `tel:` — a real way to
 * place the call today. The queue, its order, the compliance readout and the
 * disposition loop are where the value is, and none of them change when the
 * softphone arrives: at that point this one button starts a call leg instead of
 * opening the dialer app, and the rest of the page stays as it is.
 *
 * The cost of `tel:` is that the calling-window check on this page is currently
 * the ONLY one a call passes through — there is no voice edge function to
 * re-check it at dial time the way `twilio-send-sms` re-checks it for texts.
 * That is why every surface that can start a call has to run the same check:
 * see the matching gate in LeadDetail. Dialability is different — that one is
 * `lead_is_dialable()` in the database, never re-derived here.
 */
export default function DialerPage() {
  const [rows, setRows] = useState([]);
  const [optedOut, setOptedOut] = useState(() => new Set());
  const [pos, setPos] = useState(0);
  const [logged, setLogged] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  // The calling window is a clock, not a snapshot. Re-read it every minute so a
  // queue left open at 8:59pm stops offering Call at 9:00 rather than whenever
  // somebody next reloads.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);

    const [due, fresh, opts] = await Promise.all([
      // Half one: promises already come due. due_leads is the same view Today
      // reads, so the two pages cannot disagree about what is owed, and it
      // carries lead_is_dialable() as `dialable` already.
      supabase
        .from('due_leads')
        .select('*')
        .order('next_follow_up_at', { ascending: true })
        .limit(QUEUE_LIMIT),

      // Half two: leads nobody has scheduled yet. Disjoint from the view by
      // construction — due_leads requires next_follow_up_at <= now(), this
      // requires it to be null — so the halves concatenate without deduping.
      //
      // `dialable:lead_is_dialable` is the database function as a computed
      // column. Re-deriving the rule in JavaScript is how the UI and the dialer
      // drift apart, and the opt-out half of it is not even expressible here:
      // it reads telephony_opt_outs.
      supabase
        .from('leads')
        .select('*, dialable:lead_is_dialable')
        .eq('trashed', false)
        .is('next_follow_up_at', null)
        .not('status', 'in', '("dead","closed")')
        .order('created_at', { ascending: false })
        .limit(QUEUE_LIMIT),

      // Only so a suppressed lead can be told apart from an unscrubbed one in
      // the blocked list below. Nothing here decides dialability.
      supabase.from('telephony_opt_outs').select('phone_key'),
    ]);

    const failure = due.error || fresh.error || opts.error;
    setErr(failure ? failure.message : null);

    // Due first: an overdue follow-up gets worse with age, so oldest promise
    // leads. Then the unworked leads newest first, which is the opposite
    // direction on purpose — a website form that arrived ten minutes ago is the
    // most likely conversation of the day, and a cold-list row that has sat a
    // week is no more urgent than one that has sat a day.
    setRows([...(due.data ?? []), ...(fresh.data ?? [])]);
    setOptedOut(new Set((opts.data ?? []).map((o) => o.phone_key)));
    setPos(0);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const queue = useMemo(() => rows.filter((l) => l.dialable), [rows]);
  const blocked = useMemo(() => rows.filter((l) => !l.dialable), [rows]);

  const current = queue[pos] ?? null;

  // Both Skip and a logged disposition do the same thing to the queue: move
  // forward. Nothing is removed, so the position is the only state to reason
  // about and "3 of 40" keeps meaning what it says.
  const advance = () => setPos((p) => p + 1);

  function afterDisposition() {
    setLogged((n) => n + 1);
    advance();
  }

  if (loading) return <div className="empty">Building the queue…</div>;

  const remaining = Math.max(queue.length - pos, 0);

  return (
    <>
      <header>
        <h1>Dialer</h1>
        <span className="count">
          {[
            `${remaining} to call`,
            blocked.length > 0 && `${blocked.length} blocked`,
            logged > 0 && `${logged} logged`,
          ].filter(Boolean).join(' · ')}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <button className="btn ghost" onClick={load}>Rebuild queue</button>
      </div>

      {current ? (
        <OnDeck lead={current} at={pos} of={queue.length} now={now} onSkip={advance} onDone={afterDisposition} />
      ) : (
        <div className="card">
          <div className="empty">
            <strong>{queue.length === 0 ? 'Nothing to dial' : 'Queue clear'}</strong>
            {queue.length === 0
              ? 'Follow-ups arrive here when they come due. New leads arrive once they are skip traced and DNC scrubbed.'
              : `${logged} logged this session. Rebuild the queue to pick up anything that has come due since.`}
          </div>
        </div>
      )}

      {remaining > 1 && <UpNext leads={queue.slice(pos + 1)} now={now} onJump={(i) => setPos(pos + 1 + i)} />}

      {blocked.length > 0 && <Blocked leads={blocked} optedOut={optedOut} />}
    </>
  );
}

/* ── the one lead in front of you ────────────────────────────────────────── */

function OnDeck({ lead, at, of, now, onSkip, onDone }) {
  // The mobile first, matching lead_is_dialable()'s COALESCE(phone_mobile,
  // phone): it is the number a skip trace verified and the one that answers.
  const number = lead.phone_mobile || lead.phone;
  const win = callingWindow(lead, now);

  // Re-ask the database whether this specific lead is still dialable, right
  // before offering the button.
  //
  // The queue is a snapshot: `load()` evaluates lead_is_dialable() once and the
  // operator then works that list for an hour. In that hour a seller can text
  // STOP, the webhook writes telephony_opt_outs on the service role, and
  // nothing tells this page. telephony_opt_outs is not in the realtime
  // publication, so there is no subscription to lean on — and because Call is a
  // `tel:` link there is no server-side dial path left to catch it either. One
  // round trip per lead, on a page that shows one lead at a time, is a cheap
  // price for not calling somebody forty minutes after they opted out.
  const [check, setCheck] = useState('checking');
  useEffect(() => {
    // `cancelled` because the operator can tap through leads faster than the
    // round trip: without it a slow answer about the previous lead lands on the
    // current one, which is the exact wrong direction for this particular flag.
    let cancelled = false;
    setCheck('checking');
    supabase
      .from('leads')
      .select('dialable:lead_is_dialable')
      .eq('id', lead.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        // An error is not a yes. If we cannot confirm dialability we do not
        // offer the call — the operator can rebuild the queue and find out why.
        if (error || data?.dialable !== true) setCheck(error ? 'error' : 'blocked');
        else setCheck('ok');
      })
      // supabase-js normally folds transport failures into `error`, but a
      // rejection here would otherwise strand the button on "Checking…", which
      // reads as a hang rather than as a refusal. Say which it is.
      .catch(() => { if (!cancelled) setCheck('error'); });
    return () => { cancelled = true; };
  }, [lead.id]);

  const callable = check === 'ok' && win.allowed;

  return (
    <>
      <div className="card oncall">
        <h2>On deck · {at + 1} of {of}</h2>
        <div className="body">
          <div className="oncall-head">
            <div>
              <h3>{lead.address || lead.name || 'Untitled lead'}</h3>
              {/* Same trim Today uses: the street is already the heading. */}
              <p className="sub">{fullAddress(lead).replace(`${lead.address} · `, '') || 'No address on file'}</p>
            </div>
            <div className="oncall-actions">
              {callable ? (
                /* tel: hands off to whatever the machine dials with, and it
                   cannot report back. Nothing is written here on purpose: the
                   attempt is counted by log_disposition when the outcome is
                   tapped below, and call_log rows come from Twilio's webhook,
                   never from a browser that only knows a link was clicked. */
                <a className="btn big" href={`tel:${number.replace(/[^\d+]/g, '')}`}>
                  Call {formatPhone(number)}
                </a>
              ) : (
                <span className="btn big stopped" aria-disabled="true">
                  {check === 'checking' ? 'Checking…'
                    : check === 'blocked' ? 'No longer dialable'
                    : check === 'error' ? 'Cannot confirm'
                    : 'Outside calling hours'}
                </span>
              )}
              <button className="btn ghost" onClick={onSkip}>Skip</button>
            </div>
          </div>

          {check === 'blocked' && (
            <div className="notice">
              <strong>This lead stopped being dialable since the queue was built.</strong>
              Usually a STOP text that arrived while you were working, or a do-not-call logged
              elsewhere. Skip it and rebuild the queue when you are done.
            </div>
          )}

          {check === 'error' && (
            <div className="notice">
              <strong>Could not confirm this lead is still dialable.</strong>
              The check failed rather than came back no, so the call is held either way — an
              unanswered compliance question is not a yes. Rebuild the queue to retry.
            </div>
          )}

          {check === 'ok' && !win.allowed && (
            <div className="notice">
              <strong>
                {win.reason === 'unknown_timezone'
                  ? 'Cannot work out what time it is for this number.'
                  : `It is ${win.localTime} for this number — ${win.reason === 'before_8am' ? 'before 8am' : 'after 9pm'}.`}
              </strong>
              TCPA allows calls only between 8am and 9pm in the called party&rsquo;s local time, and the
              damages are $500–$1,500 per call. This one waits.
            </div>
          )}

          {callable && win.guessed && (
            <div className="notice">
              <strong>Time zone is a guess.</strong>
              Neither the area code nor a state on this lead resolved, so {win.localTime} is Eastern by
              default. Check before dialing near the edges of the window.
            </div>
          )}

          <div className="oncall-facts">
            <Fact k="Seller" v={lead.name || lead.owner_name || '—'} />
            <Fact k="Calling" v={formatPhone(number)} />
            <Fact k="Their time" v={win.localTime || '—'} />
            <Fact k="Attempts" v={lead.call_attempts} />
            <Fact k="Last contact" v={lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : 'never'} />
            <Fact k="Due" v={lead.next_follow_up_at ? fullDate(lead.next_follow_up_at) : 'not scheduled'} />
            <Fact k="Status" v={titleize(lead.status)} />
            <Fact k="Source" v={titleize(lead.source)} />
          </div>

          {(lead.motivation || lead.timeline) && (
            <p className="oncall-why">
              {[lead.motivation, lead.timeline].filter(Boolean).join(' · ')}
            </p>
          )}

          <div>
            <a className="btn ghost" href={`/app/leads/${lead.id}`}>Open the full lead</a>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>What happened</h2>
        <p className="cardnote">
          Logging the outcome counts the attempt, sets the status, schedules the next follow-up and
          moves to the next lead. Skipping does none of that — a skip is not a disposition.
        </p>
        <div className="body">
          {/* Keyed by lead so the note and follow-up fields are empty for the
              next seller rather than carrying the last one's words forward. */}
          <DispositionBar key={lead.id} leadId={lead.id} onDone={onDone} />
        </div>
      </div>
    </>
  );
}

function Fact({ k, v }) {
  return (
    <div>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/* ── the rest of the queue ───────────────────────────────────────────────── */

function UpNext({ leads, now, onJump }) {
  const shown = leads.slice(0, PEEK);

  return (
    <div className="card">
      <h2>Up next · {leads.length}</h2>
      <table className="leads">
        <tbody>
          {shown.map((l, i) => {
            const win = callingWindow(l, now);
            return (
              /* A click jumps the queue to this lead rather than opening it.
                 On this page the useful verb is "call this one next"; the last
                 cell still gets you to the record. */
              <tr key={l.id} onClick={() => onJump(i)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="addr">{l.address || l.name || 'Untitled'}</span>
                  <span className="sub">{formatPhone(l.phone_mobile || l.phone)}</span>
                </td>
                <td className="hide-sm">
                  {l.name || l.owner_name || '—'}
                  <span className="sub">{titleize(l.status)}</span>
                </td>
                <td className="hide-sm sub">
                  {l.call_attempts > 0 ? `${l.call_attempts} attempt${l.call_attempts === 1 ? '' : 's'}` : 'never called'}
                  <br />
                  {l.last_contacted_at ? `last ${timeAgo(l.last_contacted_at)}` : ''}
                </td>
                <td>
                  {win.allowed
                    ? <span className="badge ok">Callable</span>
                    : (
                      <span className="badge warm">
                        {win.reason === 'before_8am' ? 'Too early there'
                          : win.reason === 'after_9pm' ? 'Too late there'
                          : 'Time zone unknown'}
                      </span>
                    )}
                </td>
                <td>
                  <a
                    className="btn ghost"
                    href={`/app/leads/${l.id}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {leads.length > shown.length && (
        <p className="cardnote" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
          …and {leads.length - shown.length} more behind these.
        </p>
      )}
    </div>
  );
}

/* ── the ones the queue will not take ────────────────────────────────────── */

/**
 * Shown, never hidden. A lead that silently vanishes reads as "the list is
 * empty" — and the reason it vanished is usually a piece of compliance work
 * somebody still has to do, which nobody will do if nobody can see it.
 */
function Blocked({ leads, optedOut }) {
  return (
    <div className="card">
      <h2>Not dialable · {leads.length}</h2>
      <p className="cardnote">
        These are due or waiting, but lead_is_dialable() says no. The database refuses them at dial
        time regardless of what this page shows.
      </p>
      <table className="leads">
        <tbody>
          {leads.map((l) => (
            <tr key={l.id} onClick={() => navigate(`/leads/${l.id}`)} style={{ cursor: 'pointer' }}>
              <td>
                <span className="addr">{l.address || l.name || 'Untitled'}</span>
                <span className="sub">{formatPhone(l.phone_mobile || l.phone) || 'no number'}</span>
              </td>
              <td className="hide-sm">
                {l.name || l.owner_name || '—'}
                <span className="sub">{titleize(l.status)}</span>
              </td>
              <td className="hide-sm sub">
                {l.next_follow_up_at ? `due ${timeAgo(l.next_follow_up_at)}` : `added ${timeAgo(l.created_at)}`}
              </td>
              <td><span className="badge stop">{blockedReason(l, optedOut)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Why this lead is not dialable, in the order the reasons matter: the two that
 * are somebody's legal position first, then the ones that are unfinished work.
 *
 * This does not decide anything — lead_is_dialable() already did, in the
 * database. It only names the answer, which is why the vague fallback at the
 * end is acceptable and a re-derivation of the rule would not be.
 */
function blockedReason(lead, optedOut) {
  if (lead.is_dnc) return 'On DNC';
  if (lead.is_litigator) return 'Known litigator';
  if (lead.phone_invalid) return 'Wrong number';

  const numbers = [lead.phone_mobile, lead.phone].filter(Boolean);
  if (numbers.length === 0) return 'No number';
  // Mirrors public.phone_key(): telephony_opt_outs stores the last ten digits,
  // never the raw number, because Twilio says +19125550134 and the seller typed
  // (912) 555-0134.
  if (numbers.some((n) => optedOut.has(n.replace(/\D/g, '').slice(-10)))) return 'Texted STOP';

  if (lead.source === 'website' && !lead.tcpa_opt_in) return 'No opt-in on file';
  if (!lead.skip_traced) return 'Not skip traced';
  if (!lead.dnc_scrubbed) return 'Not DNC scrubbed';
  return 'Suppressed';
}
