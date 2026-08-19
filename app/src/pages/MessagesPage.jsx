import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import { formatPhone, timeAgo, fullDate } from '../lib/format.js';

/**
 * Two-way SMS inbox.
 *
 * Reoperative's MessagesPage is 2,377 lines because it is also a team chat app,
 * a notification centre and a CRM proxy. This is the part Tossie needs: the
 * conversations, one thread, and a box to type in.
 *
 * Three things this page is deliberately not:
 *   - It is not the enforcement point. Every rail (opt-out, DNC, calling window,
 *     A2P, the two kill switches) is re-checked inside twilio-send-sms with the
 *     service role. What is disabled here is a courtesy so Tossie does not type
 *     a message that was never going to leave; the refusal is what actually
 *     stops it.
 *   - It never talks to Twilio. The auth token lives in edge function secrets
 *     and a VITE_ build would publish it to every visitor of the marketing site.
 *   - It cannot un-suppress a number. `authenticated` has no DELETE grant on
 *     telephony_opt_outs on purpose — only an inbound START, handled by the
 *     webhook on the service role, clears a STOP.
 */

/**
 * The refusal vocabulary shared with twilio-send-sms.
 *
 * The function answers a refusal with a non-2xx and `{ ok:false, sent:false,
 * reason, message }`. The key here is `reason`, spelled exactly as the function
 * spells it — these strings are a contract with supabase/functions/twilio-send-sms
 * and a typo is invisible, because an unknown reason silently falls through to
 * the server's own sentence. Grep both files together before renaming one.
 *
 * The map exists because "failed" leaves Tossie unable to tell a carrier hiccup
 * (resend it) from a STOP (never send to this number again), and those two have
 * very different price tags. Every entry answers the only two questions worth
 * answering: did it go out, and what do I do now.
 */
const REFUSALS = {
  opted_out:
    'This number replied STOP. Nothing was sent. Texting it again is a per-message TCPA violation, so the send path refuses it — only a START reply from the same number clears it, and there is no way to clear it from this app.',
  lead_dnc:
    'Nothing was sent: this lead is flagged do-not-contact. Clear the flag on the lead first if that is wrong.',
  lead_litigator:
    'Nothing was sent: this number is flagged as a known TCPA litigator. Do not contact it by any channel.',
  outside_texting_window:
    'Nothing was sent. It is outside 8am–9pm in the seller’s own local time, resolved from their area code. Send it again inside their window.',
  suppression_check_failed:
    'Nothing was sent: the opt-out list could not be checked, and a send that skips that check is the one that costs $500 a message. Try again shortly.',
  a2p_not_approved:
    'Nothing was sent. A2P 10DLC registration is not approved yet, and carriers reject unregistered traffic, so the send is held rather than burned.',
  number_not_sms_enabled:
    'Nothing was sent: the sending number is voice-only. SMS turns on once A2P is approved and the number is flipped to SMS-enabled in phone settings.',
  sms_send_paused:
    'Nothing was sent. SMS sending is paused in telephony settings. Unpause it there to resume.',
  sms_send_disabled:
    'Nothing was sent. The owner kill switch (teams.sms_send_disabled) is on, and only an owner can turn it off.',
  no_sending_number:
    'Nothing was sent: no SMS-capable number is connected to this team yet.',
  lead_not_found:
    'Nothing was sent: that lead is not on this team. Reload the page.',
  lead_not_dialable:
    'Nothing was sent: lead_is_dialable() says no. A cold-list lead has to be skip traced and DNC scrubbed before it can be contacted; a website lead needs its TCPA opt-in on file. Fix the lead, not the message.',
  lead_check_failed:
    'Nothing was sent: the lead’s compliance flags could not be read, and a send that skips that check is the one that costs $500 a message. Try again shortly.',
  kill_switch_check_failed:
    'Nothing was sent: neither SMS kill switch could be read, so the send path assumed one of them was on. Try again shortly.',
  unsupported_destination:
    'Nothing was sent: that is not a valid US or Canadian number.',
  duplicate_send:
    'The identical message went out moments ago — this one was dropped instead of double-texting the seller. Check the thread before retyping it.',
  not_recorded:
    'Nothing was sent. The message could not be written to the record first, and an unrecorded text is a text nobody can prove the wording of. Safe to try again.',
  twilio_not_configured:
    'Nothing was sent: Twilio credentials are not set on the send function. That is a deploy step, not something this page can fix.',
  twilio_error:
    'Twilio rejected the message, so it did not go out. The Twilio code in the sentence above says whether a retry has any chance.',
  not_authenticated:
    'Nothing was sent: your session expired. Reload the page and sign in again.',
};

/** Twilio's hard ceiling on a single API call. */
const MAX_BODY = 1600;

/**
 * Mirrors public.phone_key(): the last ten digits.
 *
 * Only used to group an unmatched inbound thread. Twilio posts +19125550134 and
 * a seller's second line may arrive formatted differently; without the same
 * reduction the browser would show one homeowner as two conversations.
 */
const phoneKey = (v) => (v || '').replace(/\D/g, '').slice(-10);

/**
 * The GSM-7 alphabet. Anything outside it forces the whole message into UCS-2,
 * where a segment is 70 characters instead of 160.
 *
 * This matters more than it looks: a curly apostrophe is the single most common
 * way to cross that line, and macOS, iOS and Word all insert one automatically.
 * "Hi, we’d like to buy your house" pasted from Notes is a UCS-2 message, so a
 * 150-character text that reads as one segment is really three. Counting it as
 * one understates both the bill and the carrier-filtering risk on a 10DLC number.
 */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\f^{}\\[~\]|€]*$/;

/** The seven GSM-7 characters that occupy two septets instead of one. */
const GSM7_DOUBLE = /[\f^{}\\[~\]|€]/g;

/**
 * Segments, the way Twilio bills them.
 *
 * Concatenated SMS spends part of every segment on a header once there is more
 * than one, which is why the second segment onward holds 153 (GSM-7) or 67
 * (UCS-2) rather than the full 160 or 70.
 */
function segments(s) {
  if (s.length === 0) return 0;
  if (!GSM7.test(s)) return s.length <= 70 ? 1 : Math.ceil(s.length / 67);
  const septets = s.length + (s.match(GSM7_DOUBLE)?.length ?? 0);
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

export default function MessagesPage() {
  const [msgs, setMsgs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [teamKill, setTeamKill] = useState(false);
  const [activeKey, setActiveKey] = useState(null);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [warning, setWarning] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const scroller = useRef(null);
  const reloadTimer = useRef(null);

  /**
   * One flat fetch, grouped in the browser.
   *
   * A conversation view wants the newest message of every thread plus the whole
   * body of one thread, which in SQL is either a view or two round trips. At
   * Tossie's volume — one operator, one number — a thousand rows is the whole
   * message history, so the flat read is both simpler and fewer requests. The
   * limit is the ceiling to watch: when it is regularly hit, this becomes a
   * `sms_threads` view and a per-thread fetch, not a bigger number.
   */
  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('sms_messages')
      .select('*, leads(id, name, address, city, state, zip, phone, phone_mobile)')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) setErr(error.message);
    else setMsgs(data ?? []);
    setLoading(false);
  }, []);

  /**
   * Realtime fires once per row. Opening a thread of twenty unread marks twenty
   * rows read, which comes back as twenty change events, which would be twenty
   * refetches of the whole history for one identical result. One trailing
   * reload lands the same state.
   */
  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(load, 250);
  }, [load]);

  useEffect(() => {
    load();

    // The telephony context changes when someone buys a number or A2P clears —
    // rare enough to read once per mount rather than subscribe to.
    //
    // The errors are surfaced rather than shrugged off because every one of
    // these reads feeds the banner, and a failed read silently produces the
    // reassuring answer: no kill switch, sending fine. The send path still
    // refuses, so the cost is a wasted round trip, not a wrong text — but the
    // operator should know the banner is guessing.
    Promise.all([
      supabase.from('telephony_settings').select('*').maybeSingle(),
      // Live numbers only. This list feeds the "sending from" banner, which
      // exists to describe the number twilio-send-sms will actually pick — and
      // that function filters released numbers out, so including them here
      // would make the banner name a number the send would then refuse.
      supabase.from('phone_numbers').select('*')
        .is('released_at', null).order('is_primary', { ascending: false }),
      supabase.from('teams').select('sms_send_disabled').eq('id', TEAM_ID).maybeSingle(),
    ]).then(([s, n, t]) => {
      const failed = [s.error, n.error, t.error].find(Boolean);
      if (failed) {
        setErr(`Could not read the telephony settings (${failed.message}), so the banner below may be wrong. The send path still enforces every rail.`);
      }
      setSettings(s.data ?? null);
      setNumbers(n.data ?? []);
      setTeamKill(Boolean(t.data?.sms_send_disabled));
    });

    // A seller's reply has to land on screen while Tossie is looking at it. The
    // webhook writes the inbound row on the service role, so this subscription
    // is the only thing that turns that write into a visible message.
    const channel = supabase
      .channel('sms-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sms_messages' }, reload)
      .subscribe();

    return () => {
      clearTimeout(reloadTimer.current);
      supabase.removeChannel(channel);
    };
  }, [load, reload]);

  /**
   * Group into threads. `msgs` is newest-first, so the map preserves that order
   * for the list and each thread's own array is newest-first too.
   *
   * Threads key on lead_id when there is one and on the counterparty's phone key
   * when there is not. sms_messages.lead_id is nullable by design — an inbound
   * from a number nobody has a lead for still has to be readable, because for a
   * wholesaler that is usually the seller calling back from their other line.
   */
  const threads = useMemo(() => {
    const by = new Map();
    for (const m of msgs) {
      const other = m.direction === 'inbound' ? m.from_e164 : m.to_e164;
      const key = m.lead_id || `phone:${phoneKey(other)}`;
      let t = by.get(key);
      if (!t) {
        t = { key, leadId: m.lead_id, lead: m.leads ?? null, counterparty: other, messages: [], unread: 0 };
        by.set(key, t);
      }
      t.messages.push(m);
      if (m.direction === 'inbound' && !m.read_at) t.unread += 1;
    }
    return [...by.values()];
  }, [msgs]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((t) =>
      [t.lead?.name, t.lead?.address, t.lead?.city, t.counterparty, t.messages[0]?.body]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)));
  }, [threads, q]);

  /**
   * Derived rather than stored, so a thread that arrives via realtime cannot
   * leave the page pointing at a key that no longer exists.
   *
   * Looked up in `threads`, not `shown`: typing in the search box must never
   * re-point the composer. If the open conversation falls out of the filter,
   * the fallback would quietly swap in whoever is now first in the list, and
   * the next Send would text a stranger.
   */
  const active = threads.find((t) => t.key === activeKey) ?? shown[0] ?? null;

  /**
   * Changing conversation empties the box.
   *
   * A half-typed message to one homeowner that follows the operator into the
   * next thread is a cold text to someone who was never in that conversation —
   * the one class of mistake on this page that no server-side rail can catch,
   * because the send is perfectly legitimate, just to the wrong person.
   */
  useEffect(() => {
    setDraft('');
    setRefusal(null);
  }, [active?.key]);

  /**
   * Opening a thread is the read receipt. Optimistic first so the bold clears on
   * the click rather than on the round trip; the effect re-runs after the state
   * change, finds nothing unread, and stops.
   */
  useEffect(() => {
    if (!active) return;
    const ids = active.messages.filter((m) => m.direction === 'inbound' && !m.read_at).map((m) => m.id);
    if (ids.length === 0) return;

    const now = new Date().toISOString();
    setMsgs((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, read_at: now } : m)));
    supabase.from('sms_messages').update({ read_at: now }).in('id', ids)
      .then(({ error }) => { if (error) setErr(error.message); });
  }, [active]);

  // Newest message at the bottom, the way every phone shows it.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.key, active?.messages.length]);

  /**
   * The number this team texts from. telephony_settings.default_number_id wins,
   * then the primary, then whatever exists — the same order twilio-send-sms
   * resolves server-side, so the banner describes the number that will actually
   * be used rather than a hopeful guess.
   */
  const sender =
    numbers.find((n) => n.id === settings?.default_number_id) ||
    numbers.find((n) => n.is_primary) ||
    numbers[0] || null;

  const blocked =
    teamKill ? 'SMS is switched off for the team by the owner kill switch.'
      : settings?.sms_send_paused ? 'SMS sending is paused in telephony settings.'
      : !sender ? 'No number is connected yet.'
      : !sender.sms_enabled ? 'The sending number is voice-only until A2P is approved.'
      : !active?.counterparty ? 'This conversation has no number to reply to.'
      : null;

  async function send(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !active || sending) return;

    setSending(true);
    setRefusal(null);
    setWarning(null);
    setErr(null);

    // The function owns the rails, the Twilio call and the sms_messages row.
    // The browser only hands it the three facts it cannot infer.
    const { data, error } = await supabase.functions.invoke('twilio-send-sms', {
      body: { lead_id: active.leadId, to: active.counterparty, body },
    });

    if (error) {
      setRefusal(await explainRefusal(error));
    } else if (data?.ok === false || data?.sent === false) {
      // Belt and braces: every refusal today is a non-2xx, so this branch is
      // unreachable. It exists because the failure it guards against — a
      // refusal answered with 200, read as success, draft cleared — looks
      // exactly like a message that was sent.
      setRefusal(refusalFrom(data, 'The send was refused and the server gave no reason.'));
    } else {
      setDraft('');
      // The text is already at Twilio and cannot be un-sent, but its row still
      // says "queued" with no SID. Say so, because the natural reaction to a
      // message that never leaves "queued" is to send it again.
      if (data?.warning) setWarning(`${data.warning} It did go out — do not send it again.`);
    }

    setSending(false);
    load();   // truth, including the queued row the function just wrote
  }

  if (loading) return <div className="empty">Loading messages…</div>;

  return (
    <>
      <header>
        <h1>Messages</h1>
        <span className="count">
          {threads.length} conversation{threads.length === 1 ? '' : 's'}
          {sender && ` · from ${formatPhone(sender.e164)}`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {warning && (
        <div className="banner warn">
          <strong>Sent, but not fully recorded.</strong> {warning}
        </div>
      )}

      <SendingStateBanner teamKill={teamKill} settings={settings} sender={sender} numbers={numbers} />

      <div className="msgs">
        <div className="card threadlist">
          <div className="threadsearch">
            <input
              placeholder="Search name, address, number…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {shown.length === 0 ? (
            <div className="empty">
              <strong>{threads.length ? 'Nothing matches' : 'No conversations yet'}</strong>
              {threads.length === 0 && 'Text a seller from their lead, or wait for an inbound reply.'}
            </div>
          ) : (
            <ul>
              {shown.map((t) => {
                const last = t.messages[0];
                return (
                  <li
                    key={t.key}
                    className={`threadrow${t.key === active?.key ? ' on' : ''}${t.unread ? ' unread' : ''}`}
                    onClick={() => setActiveKey(t.key)}
                  >
                    <div className="who">
                      <span>{t.lead?.name || t.lead?.address || formatPhone(t.counterparty) || 'Unknown number'}</span>
                      {t.unread > 0 && <span className="dot">{t.unread}</span>}
                    </div>
                    <div className="preview">
                      {last.direction === 'outbound' && <span className="dir">You: </span>}
                      {last.body}
                    </div>
                    <div className="when">{timeAgo(last.created_at)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card thread">
          {!active ? (
            <div className="empty">Pick a conversation.</div>
          ) : (
            <>
              <h2 className="threadhead">
                <span>
                  {active.lead?.name || active.lead?.address || 'Unknown number'}
                  {' · '}
                  {formatPhone(active.counterparty)}
                </span>
                {active.leadId
                  ? <a href={`/app/leads/${active.leadId}`}>Open lead</a>
                  : <span title="No lead matched this number on its last ten digits">No matching lead</span>}
              </h2>

              <div className="bubbles" ref={scroller}>
                {[...active.messages].reverse().map((m) => (
                  <div key={m.id} className={`bubble ${m.direction === 'inbound' ? 'in' : 'out'}`}>
                    <div className="text">{m.body}</div>
                    <div className="meta">
                      {fullDate(m.sent_at || m.created_at)}
                      {m.direction === 'outbound' && ` · ${m.status}`}
                      {/* The error code is the difference between "resend it" and
                          "the carrier will never take this". Never hide it. */}
                      {m.error_code && ` · Twilio ${m.error_code}`}
                    </div>
                  </div>
                ))}
              </div>

              <form className="composer" onSubmit={send}>
                {refusal && (
                  <div className="err">
                    <strong>Not sent.</strong> {refusal.text}
                    {refusal.reason && <span className="code"> ({refusal.reason})</span>}
                  </div>
                )}

                <textarea
                  className="note"
                  placeholder={blocked || 'Write to the seller…'}
                  value={draft}
                  maxLength={MAX_BODY}
                  disabled={Boolean(blocked)}
                  onChange={(e) => setDraft(e.target.value)}
                />

                <div className="composerfoot">
                  <span className="count">
                    {draft.length}/{MAX_BODY} · {segments(draft)} segment{segments(draft) === 1 ? '' : 's'}
                  </span>
                  <button className="btn" type="submit" disabled={Boolean(blocked) || sending || !draft.trim()}>
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Why texting is or is not possible right now, in the order a refusal would
 * actually happen. A voice-only number is the expected state for weeks while
 * A2P 10DLC is in review, so it reads as a status, not a fault — otherwise the
 * first instinct is to go looking for a bug that is not there.
 */
function SendingStateBanner({ teamKill, settings, sender, numbers }) {
  if (teamKill) {
    return (
      <div className="banner stop">
        <strong>SMS is off.</strong> The owner kill switch (teams.sms_send_disabled) is on.
        Every outbound message is refused until an owner turns it off. Inbound replies still arrive.
      </div>
    );
  }

  if (settings?.sms_send_paused) {
    return (
      <div className="banner warn">
        <strong>Sending is paused.</strong> telephony_settings.sms_send_paused is on.
        Replies keep coming in; nothing goes out until it is unpaused.
      </div>
    );
  }

  if (numbers.length === 0 || !sender) {
    return (
      <div className="banner warn">
        <strong>No number connected.</strong> Add a Twilio number in telephony settings before texting.
      </div>
    );
  }

  if (!sender.sms_enabled) {
    const status = sender.a2p_status || 'not_started';
    return (
      <div className="banner warn">
        <strong>Texting is off on {formatPhone(sender.e164)} — this is expected.</strong>{' '}
        A2P 10DLC registration is <em>{status.replace(/_/g, ' ')}</em>. Carriers reject unregistered
        business texting, so the number stays voice-only until the campaign is approved and SMS is
        switched on for it. Nothing is broken and calling is unaffected. Inbound texts are still
        recorded, and STOP still suppresses.
      </div>
    );
  }

  if (sender.a2p_status !== 'approved') {
    return (
      <div className="banner warn">
        <strong>SMS is on but A2P is {(sender.a2p_status || 'not_started').replace(/_/g, ' ')}.</strong>{' '}
        Expect carrier filtering and 30007/30008 errors until the campaign is approved.
      </div>
    );
  }

  return null;
}

/**
 * One refusal payload, one on-screen sentence.
 *
 * The server's own `message` is kept alongside the mapped text rather than
 * replaced by it, because the specifics live there — which number, which hour,
 * which Twilio code — and those are what turn "outside the window" into "it is
 * 6:00 in America/Los_Angeles".
 */
function refusalFrom(payload, fallback) {
  const reason = payload?.reason || null;
  const detail = payload?.message || payload?.error || null;
  const known = reason ? REFUSALS[reason] : null;

  return {
    reason,
    // An unmapped reason still speaks, in the server's words. A rail added
    // server-side is visible here the day it ships, not the day someone
    // remembers to update this file.
    text: [detail, known].filter(Boolean).join(' ') || fallback,
  };
}

/**
 * supabase-js raises FunctionsHttpError for any non-2xx and does not read the
 * body, so the reason the send was refused is sitting unread on the Response.
 * Pulling it out is the difference between a specific answer and "failed".
 */
async function explainRefusal(error) {
  let payload = null;
  try { payload = await error?.context?.json?.(); } catch { /* not JSON; fall through */ }

  return refusalFrom(
    payload,
    error?.message
      || 'The send failed and the server gave no reason, so whether the text went out is unknown. Check the thread before retyping it.',
  );
}
