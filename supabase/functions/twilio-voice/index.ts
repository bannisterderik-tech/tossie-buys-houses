// supabase/functions/twilio-voice/index.ts
// ============================================================================
// The voice brain. Every TwiML decision and every call_log write lives here.
// ============================================================================
// Ported from reoperative's twilio-voice (2,893 lines) and cut hard. What came
// across: inbound call routing, the conference pattern the browser softphone
// joins, outbound leg TwiML, AMD, recording callbacks, status callbacks. What
// did not, and why:
//
//   - Per-team Twilio subaccounts, encrypted per-team credentials, master/BYO
//     credential resolution, auto-provisioned API keys and TwiML apps. Tossie
//     is one business with one Twilio account. Credentials come from edge
//     function secrets; nothing about them is in the database.
//   - Usage metering, wholesale/retail cost lookups, bundle balances. That is
//     the machinery for reselling telephony (BUILD_PLAN §6).
//   - The AI receptionist, the Grok media-stream bridge, and its seven gates.
//   - Transcription and AI call coaching. Recordings are captured; deciding
//     what to do with them is a later phase and a separate spend.
//   - The signature check's log-only canary mode. It shipped disabled behind
//     TWILIO_SIG_ENFORCE, which means it protected nothing until somebody
//     remembered to flip an env var. Here it fails closed from the first
//     request, because an unsigned webhook is an anonymous stranger writing
//     into our call records.
//   - The browser client's direct number dial (Device.connect({To:'+1…'})).
//     Cutting it leaves exactly ONE way to originate an outbound call — the
//     `dial` action below — which is the only reason the TCPA gate can be
//     trusted. Two entry points means two places to forget it.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: no outbound call is placed unless
// public.lead_is_dialable() is true for a lead matching the number AND the
// called party's local time is inside 8am-9pm. Enforced here, in the function
// that talks to Twilio, because the UI is not what a court looks at — the call
// detail record is. See docs/BUILD_PLAN.md §5.
//
// Secrets (supabase secrets set …, never VITE_, never in a table):
//   TWILIO_ACCOUNT_SID     AC…    account that owns the numbers
//   TWILIO_AUTH_TOKEN      …      signs webhooks and authenticates REST calls
//   TWILIO_API_KEY_SID     SK…    signs browser Voice SDK tokens
//   TWILIO_API_KEY_SECRET  …
//   TWILIO_TWIML_APP_SID   AP…    the TwiML app whose voice URL points here
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders, jsonResponse } from '../_shared/cors.ts';
import { validateTwilioSignature } from '../_shared/twilio-signature.ts';
import { normalizeE164, phoneKey } from '../_shared/phone-validation.ts';
import { isWithinContactWindow } from '../_shared/calling-window.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_API_KEY_SID = Deno.env.get('TWILIO_API_KEY_SID') || '';
const TWILIO_API_KEY_SECRET = Deno.env.get('TWILIO_API_KEY_SECRET') || '';
const TWILIO_TWIML_APP_SID = Deno.env.get('TWILIO_TWIML_APP_SID') || '';

// Every callback URL we hand Twilio points back at this function. Derived from
// SUPABASE_URL rather than configured separately so there is no second place
// for a project reference to be wrong.
const SELF_URL = `${SUPABASE_URL}/functions/v1/twilio-voice`;

// Twilio call statuses we treat as final. An earlier webhook arriving late must
// never walk one of these back — Twilio redelivers, and out-of-order delivery
// is normal, so "completed" turning back into "ringing" is a real failure mode.
const TERMINAL = ['completed', 'failed', 'no-answer', 'busy', 'canceled'];

// ── small helpers ───────────────────────────────────────────────────────────

/** Anything interpolated into TwiML goes through this. Names contain apostrophes. */
function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { 'Content-Type': 'text/xml' },
  });
}

/** Twilio ignores TwiML on status callbacks, but it must still get valid XML. */
const EMPTY_TWIML = () => twiml('<Response></Response>');

/**
 * Conference names travel in a query string and land inside an XML element, so
 * they are reduced to the character set that cannot mean anything in either.
 */
function safeConferenceName(raw: string): string {
  return String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * '7am in America/Chicago' — the half of a refusal an operator can act on.
 *
 * localHour is null when Intl could not read the clock at all, and that case
 * must not be printed as a time. Formatting null through the arithmetic below
 * yields a confident "12am", and a made-up hour is exactly what talks somebody
 * into overriding a refusal they should have respected.
 */
function describeLocalHour(localHour: number | null, tz: string): string {
  if (localHour === null) return `an unreadable local time (${tz})`;
  const h12 = localHour % 12 === 0 ? 12 : localHour % 12;
  return `${h12}${localHour < 12 ? 'am' : 'pm'} in ${tz}`;
}

/**
 * Take a message. Used when there is no forward number, when the forward leg
 * was not answered, and as the safe landing for anything unexpected on an
 * inbound call — a seller who hears silence hangs up and does not call back.
 *
 * A recorded voicemail is consented to by the act of leaving one, so this needs
 * no disclosure the way a recorded live conversation does.
 */
function voicemailTwiml(voicemailUrl?: string | null): Response {
  const greeting = voicemailUrl
    ? `<Play>${escapeXml(voicemailUrl)}</Play>`
    : '<Say>Thanks for calling. Please leave your name, number and the property address after the tone, and we will call you right back.</Say>';
  return twiml(`
<Response>
  ${greeting}
  <Record maxLength="180" timeout="5" playBeep="true" transcribe="false" recordingStatusCallback="${escapeXml(SELF_URL)}" recordingStatusCallbackMethod="POST"/>
  <Hangup/>
</Response>`);
}

// ── the dial gate ───────────────────────────────────────────────────────────

interface LeadRow {
  id: string;
  name: string | null;
  state: string | null;
  phone: string | null;
  phone_mobile: string | null;
  dialable: boolean;
}

type GateResult =
  | { ok: true; lead: LeadRow }
  | { ok: false; code: string; message: string; lead: LeadRow | null };

/**
 * Every lead whose phone or mobile reduces to the same public.phone_key().
 *
 * Narrowed by a wildcard-interleaved ILIKE in SQL and confirmed on the full ten
 * digits in TypeScript: numbers are stored in whatever shape they arrived in —
 * Twilio posts +19125550134, the website form captured "(912) 555-0134" — so an
 * equality filter on the raw column misses its own leads. phone_key() is the
 * join key everywhere else in this system; this is that same key, applied where
 * PostgREST cannot call the SQL function for us.
 *
 * The pattern carries ALL TEN digits (`*912*555*0134*`), the same shape
 * twilio-webhook's matchLead uses, and that is not cosmetic. An earlier version
 * narrowed on the last four only, which matches any of ~0.07% of all numbers —
 * on a skip-traced list of 200k leads that is well over a hundred rows, so the
 * row cap below would silently drop candidates. Dropping a candidate is the one
 * failure this function cannot have: the gate refuses when ANY lead sharing the
 * number is suppressed, so a truncated candidate set turns a DNC lead into a
 * dialable one. Ten interleaved digits reduce the candidate set to duplicates of
 * the same number, which is exactly the set we want all of.
 */
async function leadsForNumber(
  db: ReturnType<typeof admin>,
  teamId: string,
  e164: string,
): Promise<LeadRow[]> {
  const key = phoneKey(e164);
  if (!key || key.length !== 10) return [];
  const pattern = `*${key.slice(0, 3)}*${key.slice(3, 6)}*${key.slice(6)}*`;

  // `dialable:lead_is_dialable` is a PostgREST computed column: a function
  // taking the table's row type is selectable as if it were one. This is the
  // point — the answer comes from the database function that the queue builder,
  // the SDR and the SMS path all use, which already accounts for DNC, litigator
  // and opt-out status on BOTH of the lead's numbers. Reimplementing the rule
  // here would be a second copy to forget to update, and the cost of the two
  // copies disagreeing is measured in statutory damages.
  const { data, error } = await db
    .from('leads')
    .select('id, name, state, phone, phone_mobile, dialable:lead_is_dialable')
    .eq('team_id', teamId)
    .eq('trashed', false)
    .or(`phone.ilike.${pattern},phone_mobile.ilike.${pattern}`)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`lead lookup failed: ${error.message}`);
  return ((data || []) as LeadRow[])
    .filter((l) => phoneKey(l.phone) === key || phoneKey(l.phone_mobile) === key);
}

/**
 * May we place this call, right now, to this number?
 *
 * Three refusals, all of them deliberate:
 *
 *  1. No lead matches the number. A number with no lead record has no evidence
 *     of a skip trace, a DNC scrub or an opt-in behind it, so there is nothing
 *     that makes it callable. If Tossie needs to ring a title company, that is
 *     a phone call — not a feature of the seller dialer.
 *  2. ANY matching lead is not dialable. Over-suppression is the intended
 *     direction: two leads can share a household number, and a STOP or a DNC
 *     flag on either of them is a refusal for the number, not for the row.
 *  3. Outside 8am-9pm in the called party's local time.
 */
async function checkDialGate(
  db: ReturnType<typeof admin>,
  teamId: string,
  toE164: string,
  now: Date,
): Promise<GateResult> {
  const leads = await leadsForNumber(db, teamId, toE164);

  if (leads.length === 0) {
    return {
      ok: false,
      code: 'no_lead',
      message: 'That number does not match a lead. Only leads can be dialed from here.',
      lead: null,
    };
  }

  const blocked = leads.find((l) => !l.dialable);
  if (blocked) {
    return {
      ok: false,
      code: 'not_dialable',
      message: 'This number is suppressed: it is on the DNC or opt-out list, or it has not been skip traced and scrubbed yet.',
      lead: blocked,
    };
  }

  // Prefer the lead's own state over nothing; the area code is the stronger
  // signal and isWithinContactWindow already treats it that way. Take the state
  // from a lead that actually has one rather than from whichever row sorted
  // first — with two leads on a household number, one of them may be a bare
  // skip-trace row with no address yet.
  const lead = leads.find((l) => l.state) || leads[0];
  const target = { phone: toE164, state: lead.state };

  // When neither the area code nor the state resolves, the helper hands back
  // America/New_York and marks the reason '_unresolved_tz'. Taking that guess as
  // a fact is how you ring a Seattle homeowner at 5am: the area-code table
  // covers a fraction of NANP's 350+ codes, and Eastern is the EARLIEST US zone,
  // so an unresolved guess is wrong in the dangerous direction every single
  // time. An unresolved number therefore gets the intersection of the window
  // across the continental zones — 11am-9pm Eastern is 8am-6pm Pacific, and
  // inside 8am-9pm everywhere between. This is the same narrowing the SMS send
  // path applies; a live call is the more exposed of the two, so it cannot be
  // the looser of the two.
  const probe = isWithinContactWindow(target, now);
  const tzUnresolved = probe.reason.endsWith('_unresolved_tz');
  const win = tzUnresolved
    ? isWithinContactWindow(target, now, { startHour: 11, endHour: 21 })
    : probe;

  if (!win.allowed) {
    return {
      ok: false,
      code: 'outside_calling_window',
      message: tzUnresolved
        ? `This seller's timezone could not be worked out from their area code or state, so calling them is held to 11am-9pm Eastern — the only span that is inside 8am-9pm everywhere it could be. It is ${describeLocalHour(win.localHour, win.tz)}.`
        : `It is ${describeLocalHour(win.localHour, win.tz)} for this seller. Calls are allowed 8am to 9pm their time.`,
      lead,
    };
  }

  return { ok: true, lead };
}

/**
 * A refused dial is evidence too. It goes on the lead's timeline so that "why
 * did nobody call this lead back" has an answer, and so a pattern of refusals
 * is visible rather than buried in edge function logs.
 */
async function logBlockedDial(
  db: ReturnType<typeof admin>,
  teamId: string,
  gate: Extract<GateResult, { ok: false }>,
  toE164: string,
  actorId: string | null,
  // The lead the operator pressed call on. The gate reasons about the NUMBER and
  // can refuse without having matched a lead to it at all ('no_lead'), but the
  // dial path always knows whose row the button was on — and a refusal that
  // leaves no trace on that row is the silent failure this timeline exists to
  // prevent: the operator sees a red toast, and tomorrow nobody can tell whether
  // the lead was ever attempted.
  fallbackLeadId?: string | null,
) {
  console.warn('[twilio-voice] dial refused', JSON.stringify({ code: gate.code, key: phoneKey(toE164) }));
  const leadId = gate.lead?.id || fallbackLeadId;
  if (!leadId) return;
  await db.from('lead_activity').insert({
    team_id: teamId,
    lead_id: leadId,
    actor_id: actorId,
    actor_kind: actorId ? 'user' : 'system',
    type: 'call_blocked',
    summary: gate.message,
    payload: { reason: gate.code, to: toE164 },
  });
}

// ── Twilio REST ─────────────────────────────────────────────────────────────

async function twilioPost(path: string, body: Record<string, string>) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json: json as Record<string, string> };
}

// ════════════════════════════════════════════════════════════════════════════
// Handler
// ════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // ── conference hold audio ────────────────────────────────────────────────
  // Twilio GETs the conference waitUrl with no body, so this has to be handled
  // before anything that assumes a form-encoded POST. A 405 or an error here
  // drops the leg that is waiting — for the softphone that is the operator's
  // own leg, which ends the conference and cancels the call they were placing.
  //
  // Signature-checked like everything else. Twilio signs GET requests over the
  // full URL with no parameters appended, which is what an empty params object
  // produces.
  if (req.method === 'GET' && action === 'hold') {
    const valid = await validateTwilioSignature(
      req.url, {}, req.headers.get('x-twilio-signature') || '', TWILIO_AUTH_TOKEN,
    );
    if (!valid) return new Response('invalid Twilio signature', { status: 403 });
    // Silence, not hold music. A seller who picks up and hears muzak hangs up.
    // 60s is far longer than any leg legitimately waits here.
    return twiml('<Response><Pause length="60"/></Response>');
  }

  const contentType = (req.headers.get('content-type') || '').toLowerCase();

  // ══════════════════════════════════════════════════════════════════════════
  // TWILIO WEBHOOKS — form-encoded POST, no Authorization header
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && contentType.includes('application/x-www-form-urlencoded')) {
    const rawBody = await req.text();
    const p: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody).entries()) p[k] = v;

    // Fail closed. These URLs are not secret — they appear in the Twilio
    // console, in support threads and in browser history — and without this
    // check anyone holding one can invent calls, close open ones, or overwrite
    // a recording URL with something they control.
    const valid = await validateTwilioSignature(
      req.url, p, req.headers.get('x-twilio-signature') || '', TWILIO_AUTH_TOKEN,
    );
    if (!valid) {
      console.warn('[twilio-voice] rejected unsigned or forged webhook', url.pathname + url.search);
      return new Response('invalid Twilio signature', { status: 403 });
    }

    // Same silent hold as the GET above. Twilio is asked for GET on the
    // waitUrl, but a POST here would otherwise fall through to the status
    // handler and return an empty Response — which ends the wait and drops the
    // waiting leg. Cheap to answer twice; expensive to get wrong once.
    if (action === 'hold') return twiml('<Response><Pause length="60"/></Response>');

    const db = admin();
    const callSid = p.CallSid || '';
    const callStatus = p.CallStatus || '';
    const from = p.From || '';
    const to = p.To || '';
    const direction = p.Direction || '';

    // ── outbound lead leg joins the conference ────────────────────────────
    // Fetched when the seller's phone is answered, on the leg `dial` created.
    //
    // No database work in this branch, on purpose: a Supabase edge worker is
    // terminated as soon as the Response is returned, so an unawaited write
    // here gets cancelled mid-flight and Twilio plays "an application error has
    // occurred" to the seller. Everything this branch needs travels in the
    // query string, which `dial` built and Twilio's signature covers.
    if (action === 'lead_leg') {
      const conference = safeConferenceName(url.searchParams.get('conf') || '');
      if (!conference) return twiml('<Response><Hangup/></Response>');

      // Single-line (the softphone): nobody else is being dialed, so there is
      // no simultaneous-answer race to isolate. Join live — unmuted, off hold,
      // starting the conference — so the operator and the seller are talking
      // the instant the seller says hello.
      //
      // Multi-line (the power dialer, later): muted, and not starting the
      // conference. That pair is the audio isolation that stops two sellers who
      // pick up at the same moment from being bridged to each other. Muted means
      // they cannot speak into the room; startConferenceOnEnter="false" means the
      // room has not started, so all they hear is waitUrl — the silence below —
      // and not each other. The orchestrator then un-mutes and un-holds the
      // winner through the Conference Participants API once AMD says a human
      // answered.
      //
      // There is deliberately no hold="…" attribute here. <Conference> has no
      // such attribute (name/muted/beep/startConferenceOnEnter/endConferenceOnExit/
      // waitUrl/waitMethod/record/trim/coach/… only); hold is settable solely
      // through the Participants REST API. Writing one produced invalid TwiML
      // and, worse, read as though the isolation were already handled — which
      // for a multi-line dialer is the difference between two strangers hearing
      // silence and two strangers hearing each other.
      const solo = url.searchParams.get('solo') === '1';
      const holdUrl = `${SELF_URL}?action=hold`;

      // Recording disclosure. Georgia and South Carolina are one-party consent,
      // but Florida is two-party and it is in the site's footprint, so the
      // seller is told before any audio is captured. `rec` is stamped on the
      // URL at origination so this branch needs no lookup to know.
      const disclose = url.searchParams.get('rec') === '1'
        ? '<Say>This call may be recorded.</Say>'
        : '';

      return twiml(`
<Response>
  ${disclose}
  <Dial>
    <Conference startConferenceOnEnter="${solo}" endConferenceOnExit="false" beep="false" muted="${!solo}" waitUrl="${escapeXml(holdUrl)}" waitMethod="GET">${escapeXml(conference)}</Conference>
  </Dial>
</Response>`);
    }

    // ── the browser softphone joins its conference ────────────────────────
    // The Voice SDK sends whatever string the app passed to Device.connect, so
    // a `conference:` prefix is how the operator's leg asks for a room.
    // endConferenceOnExit="true": when the operator hangs up, the seller's leg
    // goes with it. That is what the hang-up button means.
    if (to.startsWith('conference:')) {
      const conference = safeConferenceName(to.slice('conference:'.length));
      if (!conference) return twiml('<Response><Hangup/></Response>');
      // No waitUrl here, deliberately: while the operator is the only
      // participant Twilio plays its default hold audio, which is at least
      // audible proof the call is live. Pointing this at action=hold would give
      // them the same silence the seller gets and no way to tell a ringing
      // phone from a dead one. A ringback tone asset is the real fix.
      return twiml(`
<Response>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false" muted="false">${escapeXml(conference)}</Conference>
  </Dial>
</Response>`);
    }

    // ── the inbound forward leg finished ──────────────────────────────────
    // Fires when the <Dial> to the forward number ends, whatever the outcome.
    // This is the only callback that carries DialCallDuration — the actual
    // bridged talk time. Without it a twenty-minute conversation logs as zero
    // seconds, because no other webhook reports the bridged leg's length.
    //
    // MUST stay ahead of the RecordingUrl branch below. When recording_enabled
    // is on, the <Dial record="record-from-answer-dual"> action callback carries
    // RecordingUrl too — so a generic "has a RecordingUrl" test earlier in the
    // chain would eat this request, return an empty <Response>, and hang up in
    // silence on an inbound seller whose call nobody answered, precisely when
    // voicemail is the whole point. Order is the fix; the branch below stays
    // general because recordingStatusCallback carries no action of its own.
    if (action === 'forward_done') {
      const callLogId = url.searchParams.get('call') || '';
      const dialStatus = p.DialCallStatus || '';
      const dialDuration = parseInt(p.DialCallDuration || '0', 10);

      const { data: logRow } = callLogId
        ? await db.from('call_log').select('team_id').eq('id', callLogId).maybeSingle()
        : { data: null };

      const patch: Record<string, unknown> = { ended_at: new Date().toISOString(), status: dialStatus };
      // Only write a duration Twilio actually reported. A no-answer sends zero,
      // and zero would clobber a real value another callback already wrote.
      if (dialDuration > 0) patch.duration_seconds = dialDuration;
      // Recorded forwards deliver the URL here as well as on the recording
      // callback; taking it from whichever arrives first costs nothing.
      if (p.RecordingUrl) patch.recording_url = p.RecordingUrl;
      if (callLogId) await db.from('call_log').update(patch).eq('id', callLogId);

      // Nobody picked up, so take a message rather than hanging up on a seller
      // who is holding a "we buy houses" postcard.
      if (dialStatus !== 'completed') {
        const { data: settings } = logRow?.team_id
          ? await db.from('telephony_settings').select('voicemail_url').eq('team_id', logRow.team_id).maybeSingle()
          : { data: null };
        return voicemailTwiml(settings?.voicemail_url);
      }
      return EMPTY_TWIML();
    }

    // ── answering machine detection ───────────────────────────────────────
    // Twilio posts AnsweredBy asynchronously a second or two after pickup:
    // human, machine_start, machine_end_beep, machine_end_silence, fax, unknown.
    //
    // We record it and do nothing else. Auto-hanging-up on a machine is how you
    // hang up on a real person with a slow "…hello?", and on the softphone the
    // operator is already listening and can hear a greeting for themselves. The
    // value here is the after-the-fact number — what share of a list is
    // voicemail — and giving the multi-line dialer its winner signal later.
    //
    // Only the dedicated AMD callback (AnsweredBy and no CallStatus) is answered
    // here. AnsweredBy also rides along on the ordinary status callbacks once AMD
    // has run — AsyncAmdStatusCallback and StatusCallback are the same URL — so
    // returning early on "has AnsweredBy" swallowed the CallStatus that came with
    // it. The row then never reached 'completed', never got ended_at and never
    // got a duration; with recording off, nothing downstream would have closed
    // it, and the call record would read as a call still ringing hours later.
    // The call record is the evidence of what happened to a homeowner, so it is
    // the one thing that has to be right. Everything with a CallStatus falls
    // through to the status handler, which now carries answered_by along.
    if (p.AnsweredBy && callSid && !callStatus) {
      await db.from('call_log').update({ answered_by: p.AnsweredBy }).eq('twilio_call_sid', callSid);
      return EMPTY_TWIML();
    }

    // ── recording ready ───────────────────────────────────────────────────
    // Also the most reliable end-of-call signal Twilio sends: it only fires
    // once the audio is finalised. Used to backstop status and duration when a
    // <Dial action> callback did not land, without ever overwriting a terminal
    // status that already did.
    if (p.RecordingUrl && callSid) {
      const recDuration = parseInt(p.RecordingDuration || '0', 10);
      const { data: existing } = await db
        .from('call_log')
        .select('status, duration_seconds, ended_at')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();

      // A recorded call's own status callback carries RecordingUrl as well as
      // CallStatus and CallDuration, so it lands in this branch too. When Twilio
      // has told us what actually happened, write that rather than the assumed
      // 'completed' — the assumption is only for the standalone recording
      // callback, which reports on the audio and not on the call.
      const callDuration = parseInt(p.CallDuration || '0', 10);
      const reported = callStatus && TERMINAL.includes(callStatus) ? callStatus : 'completed';

      const patch: Record<string, unknown> = { recording_url: p.RecordingUrl };
      if (existing && !TERMINAL.includes(existing.status || '')) patch.status = reported;
      if (p.AnsweredBy) patch.answered_by = p.AnsweredBy;
      const duration = callDuration > 0 ? callDuration : recDuration;
      if (duration > 0 && !existing?.duration_seconds) patch.duration_seconds = duration;
      if (!existing?.ended_at) patch.ended_at = new Date().toISOString();

      await db.from('call_log').update(patch).eq('twilio_call_sid', callSid);
      return EMPTY_TWIML();
    }

    // ── a fresh inbound call ──────────────────────────────────────────────
    // Twilio labels browser-originated legs Direction=inbound too — from its
    // network's point of view the client dialled in — so `client:` senders are
    // excluded or every softphone call would be routed to voicemail.
    //
    // The status filter matters as much as the `client:` one: a terminal status
    // callback on a call we somehow have no row for would otherwise re-enter
    // this flow, insert a second row and answer a call that already ended.
    const isFromBrowser = from.startsWith('client:');
    const isFreshRing = callStatus === '' || callStatus === 'ringing' || callStatus === 'in-progress';
    if (direction === 'inbound' && !isFromBrowser && isFreshRing && callSid) {
      // Idempotency: Twilio redelivers, and later status callbacks on the same
      // call arrive here too. If we have already greeted this CallSid, fall
      // through to the status handler instead of starting the flow again.
      const { data: existingLog } = await db
        .from('call_log').select('id').eq('twilio_call_sid', callSid).maybeSingle();

      if (!existingLog) {
        // Which of our numbers was reached. Deliberately not team-scoped: an
        // inbound call is how we DISCOVER the team, so the number has to be
        // found before there is a team to filter by.
        //
        // Narrowed in SQL rather than fetched-and-scanned. A row cap over an
        // unfiltered read is a trap that springs the day the DID pool outgrows
        // it — the number stops being found and real sellers hear "this number
        // is not in service" — so the ILIKE does the narrowing and phone_key
        // still decides, the same two-step every other Twilio match uses.
        //
        // NOT filtered by released_at, unlike every outbound path. A released
        // number should never route here again — Twilio hands it to whoever
        // bought it — but if one somehow does, the call still has to be logged
        // against the right team, and dropping an inbound to a number we
        // demonstrably used is the failure that costs the most. Inbound is
        // permissive on purpose; twilio-webhook takes the same position.
        const toKey = phoneKey(to);
        const numPattern = toKey && toKey.length === 10
          ? `*${toKey.slice(0, 3)}*${toKey.slice(3, 6)}*${toKey.slice(6)}*`
          : null;
        const { data: numbers } = numPattern
          ? await db.from('phone_numbers')
              .select('id, team_id, e164, forward_to_e164').ilike('e164', numPattern)
          : { data: [] };
        const numRow = (numbers || []).find((n) => phoneKey(n.e164) === toKey);

        if (!numRow) {
          // A number is pointed at this function that we have no row for. We
          // cannot log the call (call_log.team_id is NOT NULL) and we cannot
          // guess who should answer it, so say something human and hang up.
          console.error('[twilio-voice] inbound to an unknown number', to);
          return twiml('<Response><Say>Sorry, this number is not in service.</Say><Hangup/></Response>');
        }

        const { data: settings } = await db
          .from('telephony_settings')
          .select('forward_to_e164, recording_enabled, voicemail_url')
          .eq('team_id', numRow.team_id)
          .maybeSingle();

        // Match the caller to a lead so the call lands on their timeline. An
        // ambiguous match (two leads, one household number) stays unlinked
        // rather than guessing — a call attached to the wrong seller is worse
        // than one attached to none.
        //
        // Swallowed on failure, and only here. leadsForNumber throws on a lookup
        // error, which is right for the dial gate — refusing to call is the safe
        // answer there. On a ringing inbound call it is the opposite: an
        // uncaught throw returns 500 to Twilio, which plays "an application
        // error has occurred" to a seller holding our postcard. Attribution is
        // recoverable later from the number on the row; that call is not.
        let lead: LeadRow | null = null;
        try {
          const matches = await leadsForNumber(db, numRow.team_id, from);
          lead = matches.length === 1 ? matches[0] : null;
        } catch (e) {
          console.error('[twilio-voice] inbound lead match failed', (e as Error)?.message);
        }

        const { data: inserted, error: insertErr } = await db.from('call_log').insert({
          team_id: numRow.team_id,
          lead_id: lead?.id || null,
          direction: 'inbound',
          from_e164: from,
          to_e164: to,
          twilio_call_sid: callSid,
          status: callStatus || 'ringing',
          started_at: new Date().toISOString(),
        }).select('id').maybeSingle();

        // The existingLog check above is a read-then-write, so two redelivered
        // webhooks for one CallSid can both pass it and race here. The UNIQUE on
        // twilio_call_sid is what actually settles that race — one insert wins,
        // the loser gets 23505 — so the loser reads the winner's id rather than
        // carrying an empty one into the action URL, which would leave the call
        // with no duration and no end time and nothing in the logs saying why.
        let logRow = inserted;
        if (insertErr) {
          console.error('[twilio-voice] inbound call_log insert failed', insertErr.code, insertErr.message);
          const { data: raced } = await db
            .from('call_log').select('id').eq('twilio_call_sid', callSid).maybeSingle();
          logRow = raced;
        }

        // Per-number forwarding wins over the team default: a marketing number
        // and the office line do not have to ring the same phone.
        const forwardTo = normalizeE164(numRow.forward_to_e164 || settings?.forward_to_e164 || '');
        if (!forwardTo) return voicemailTwiml(settings?.voicemail_url);

        const recording = settings?.recording_enabled
          ? ` record="record-from-answer-dual" recordingStatusCallback="${escapeXml(SELF_URL)}" recordingStatusCallbackMethod="POST"`
          : '';
        const disclose = settings?.recording_enabled ? '<Say>This call may be recorded.</Say>' : '';
        const doneUrl = `${SELF_URL}?action=forward_done&call=${logRow?.id || ''}`;

        // callerId is our own business number, not the seller's. If the forward
        // number is the operator's cell and the seller happens to be calling
        // from that same cell — which is exactly what happens the first time
        // anyone tests this — dialling from their own number puts them into
        // their carrier's voicemail login instead of the call.
        return twiml(`
<Response>
  ${disclose}
  <Dial callerId="${escapeXml(to)}" timeout="25" answerOnBridge="true"${recording} action="${escapeXml(doneUrl)}" method="POST">
    <Number>${escapeXml(forwardTo)}</Number>
  </Dial>
</Response>`);
      }
    }

    // ── status callbacks ──────────────────────────────────────────────────
    // Everything that reaches here is Twilio reporting on a call we already
    // know about: initiated, ringing, answered, completed.
    if (callSid && callStatus) {
      const { data: existing } = await db
        .from('call_log').select('status').eq('twilio_call_sid', callSid).maybeSingle();

      // Late and out-of-order delivery is normal. Once a call is finished it
      // stays finished; a redelivered 'ringing' must not reopen it.
      if (existing && TERMINAL.includes(existing.status || '') && !TERMINAL.includes(callStatus)) {
        return EMPTY_TWIML();
      }

      const duration = parseInt(p.CallDuration || p.Duration || '0', 10);
      const patch: Record<string, unknown> = { status: callStatus };
      // AMD's verdict rides along on these once it has run; write it with the
      // status rather than needing its own request to have arrived.
      if (p.AnsweredBy) patch.answered_by = p.AnsweredBy;
      if (duration > 0) patch.duration_seconds = duration;
      if (TERMINAL.includes(callStatus)) patch.ended_at = new Date().toISOString();
      await db.from('call_log').update(patch).eq('twilio_call_sid', callSid);
    }

    return EMPTY_TWIML();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OPERATOR API — JSON POST from the app, Authorization required
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return jsonResponse({ error: 'missing authorization' }, cors, 401);

  // Identify the caller with their own JWT, so RLS decides who they are, and
  // read their team from their profile rather than trusting a body parameter.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return jsonResponse({ error: 'unauthorized' }, cors, 401);

  const db = admin();
  const { data: profile } = await db.from('profiles').select('team_id').eq('id', user.id).maybeSingle();
  const teamId = profile?.team_id;
  if (!teamId) return jsonResponse({ error: 'no team' }, cors, 403);

  let body: Record<string, string> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'body must be json' }, cors, 400);
  }

  try {
    // ── a Voice SDK token for the browser softphone ───────────────────────
    // Hand-rolled because Twilio's Node SDK does not run on the edge runtime.
    // It is a plain HS256 JWT signed with the API key secret; the `cty` header
    // is what tells Twilio it is an access token rather than an ordinary one.
    if (body.action === 'token') {
      if (!TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
        return jsonResponse({ error: 'voice sdk credentials are not configured' }, cors, 503);
      }
      const identity = `agent_${user.id.replace(/-/g, '')}`;
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
      const payload = {
        jti: `${TWILIO_API_KEY_SID}-${now}`,
        iss: TWILIO_API_KEY_SID,
        sub: TWILIO_ACCOUNT_SID,
        exp: now + 3600,
        grants: {
          identity,
          // incoming.allow lets Twilio ring this browser; outgoing is pinned to
          // the TwiML app, which points at this function — so a token cannot be
          // used to place a call that skips the gate below.
          voice: { incoming: { allow: true }, outgoing: { application_sid: TWILIO_TWIML_APP_SID } },
        },
      };
      const enc = new TextEncoder();
      const b64url = (d: Uint8Array) =>
        btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const headerB64 = b64url(enc.encode(JSON.stringify(header)));
      const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
      const key = await crypto.subtle.importKey(
        'raw', enc.encode(TWILIO_API_KEY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${headerB64}.${payloadB64}`)));
      return jsonResponse({ token: `${headerB64}.${payloadB64}.${b64url(sig)}`, identity }, cors);
    }

    // ── place an outbound call ────────────────────────────────────────────
    // The one and only way a seller's phone rings because of this system.
    //
    // The operator's browser is already in `conference`; this creates the
    // seller's leg and points it at action=lead_leg, which drops them into the
    // same room. Same pattern the multi-line dialer will use, so the gate,
    // the logging and the TwiML have one implementation rather than two.
    if (body.action === 'dial') {
      const conference = safeConferenceName(body.conference || '');
      if (!conference) return jsonResponse({ error: 'conference is required' }, cors, 400);

      // The lead is the subject of the call; the number is derived from it,
      // never taken from the request, so a caller cannot dial an arbitrary
      // number by naming a dialable lead.
      const leadId = body.lead_id || '';
      if (!leadId) return jsonResponse({ error: 'lead_id is required' }, cors, 400);

      // No dialability check on this read: checkDialGate below asks the
      // question for the NUMBER, which covers this lead and every other lead
      // sharing it. Checking here as well would invite the two answers to
      // diverge, and the narrower one is the wrong one.
      const { data: lead } = await db
        .from('leads')
        .select('id, name, phone, phone_mobile')
        .eq('team_id', teamId)
        .eq('id', leadId)
        .maybeSingle();
      if (!lead) return jsonResponse({ error: 'lead not found' }, cors, 404);

      // Mobile first: it is the number a skip trace verified, and the one a
      // seller actually answers. lead_is_dialable() reads the same preference.
      const toE164 = normalizeE164(lead.phone_mobile || lead.phone || '');
      if (!toE164) return jsonResponse({ error: 'lead has no phone number' }, cors, 400);

      const gate = await checkDialGate(db, teamId, toE164, new Date());
      if (!gate.ok) {
        await logBlockedDial(db, teamId, gate, toE164, user.id, lead.id);
        return jsonResponse({ error: gate.message, code: gate.code }, cors, 403);
      }

      // Which of our numbers to call from: the configured default, else the
      // primary, else any voice-enabled number. Refuse rather than let Twilio
      // pick, because the number a seller sees is the number they call back.
      //
      // Released numbers are excluded at the query, not filtered later. The
      // last branch here is "any voice-enabled number", which is precisely the
      // branch that would have reached for a released row — and the number a
      // seller sees is the number they call back, which for a released number
      // means calling a stranger.
      const { data: settings } = await db
        .from('telephony_settings')
        .select('default_number_id, recording_enabled')
        .eq('team_id', teamId)
        .maybeSingle();
      const { data: numbers } = await db
        .from('phone_numbers')
        .select('id, e164, is_primary')
        .eq('team_id', teamId)
        .eq('voice_enabled', true)
        .is('released_at', null);
      const fromRow = (numbers || []).find((n) => n.id === settings?.default_number_id)
        || (numbers || []).find((n) => n.is_primary)
        || (numbers || [])[0];
      if (!fromRow) return jsonResponse({ error: 'no voice-enabled number is configured' }, cors, 503);

      const recording = !!settings?.recording_enabled;

      // Write the row before Twilio is called and fill in the SID after, per
      // the schema's dedup contract: twilio_call_sid is UNIQUE but nullable, so
      // a redelivered webhook collides with the existing row instead of forking
      // the history. Doing it in this order also means a call that Twilio
      // accepted can never go unlogged.
      const { data: logRow, error: logErr } = await db.from('call_log').insert({
        team_id: teamId,
        lead_id: lead.id,
        direction: 'outbound',
        from_e164: fromRow.e164,
        to_e164: toE164,
        status: 'queued',
        started_at: new Date().toISOString(),
      }).select('id').single();
      // No row, no call. A call placed without a record of it is the one thing
      // this system must never do — the log IS the evidence of what was said to
      // a homeowner, and call_log carries no DELETE grant for that reason.
      if (logErr || !logRow) {
        console.error('[twilio-voice] call_log insert failed', logErr?.message);
        return jsonResponse({ error: 'could not log the call, so it was not placed' }, cors, 500);
      }

      const legUrl = `${SELF_URL}?action=lead_leg&conf=${encodeURIComponent(conference)}&solo=1`
        + (recording ? '&rec=1' : '');
      const callBody: Record<string, string> = {
        To: toE164,
        From: fromRow.e164,
        Url: legUrl,
        Method: 'POST',
        StatusCallback: SELF_URL,
        StatusCallbackMethod: 'POST',
        // No 'initiated' event: it can fire before the update below has written
        // the SID onto the row, and a status callback that matches no row is a
        // silent no-op. It would also tell us nothing — we just created the row.
        StatusCallbackEvent: 'ringing answered completed',
        Timeout: '25',
        // MachineDetection=Enable rather than DetectMessageEnd: we only need to
        // know whether a human answered, and Enable reports in about a second
        // instead of waiting out the whole voicemail greeting.
        MachineDetection: 'Enable',
        AsyncAmd: 'true',
        AsyncAmdStatusCallback: SELF_URL,
        AsyncAmdStatusCallbackMethod: 'POST',
      };
      if (recording) {
        callBody.Record = 'true';
        callBody.RecordingStatusCallback = SELF_URL;
        callBody.RecordingStatusCallbackMethod = 'POST';
      }

      const call = await twilioPost('/Calls.json', callBody);
      if (!call.ok || !call.json.sid) {
        await db.from('call_log').update({
          status: 'failed',
          ended_at: new Date().toISOString(),
        }).eq('id', logRow.id);
        return jsonResponse({ error: call.json.message || `twilio returned ${call.status}` }, cors, 502);
      }

      // Only the SID. Writing Twilio's 'queued' back would race the first status
      // callback, which starts matching this row the instant the SID lands and
      // may already have written 'ringing'.
      await db.from('call_log').update({ twilio_call_sid: call.json.sid }).eq('id', logRow.id);

      await db.from('lead_activity').insert({
        team_id: teamId,
        lead_id: lead.id,
        actor_id: user.id,
        actor_kind: 'user',
        type: 'call_placed',
        summary: `Called ${toE164}`,
        payload: { call_log_id: logRow.id, conference },
      });

      return jsonResponse({ call_sid: call.json.sid, call_log_id: logRow.id, to: toE164, from: fromRow.e164 }, cors);
    }

    return jsonResponse({ error: `unknown action: ${body.action || ''}` }, cors, 400);
  } catch (err) {
    // Never echo the message back to the browser: it can carry a Postgres error
    // string naming columns and constraints. The logs get the detail.
    console.error('[twilio-voice] unhandled error', (err as Error)?.message);
    return jsonResponse({ error: 'request failed' }, cors, 500);
  }
});
