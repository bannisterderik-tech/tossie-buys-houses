// supabase/functions/twilio-send-sms/index.ts
// ============================================================================
// The one door every outbound text goes through.
// ============================================================================
// The operator UI, the power dialer and the AI SDR all call this function. That
// is the whole point of it: a compliance rail that lives in three send paths is
// three rails that can drift, and the one that drifts is the one that texts a
// homeowner who already said STOP. So every gate is here and nowhere else, and
// nothing else in the system is allowed to POST to Twilio's Messages endpoint.
//
// The browser never talks to Twilio, and cannot: the auth token is a Supabase
// edge secret, never in the database, never in a VITE_ variable, never in a
// response body. The caller proves it is a signed-in team member with its JWT;
// this function verifies that and then acts on the service role.
//
// REFUSALS ARE LOUD. Every rejection returns a specific machine-readable
// `reason` plus a sentence the UI can show verbatim. A silent no-op here means
// Tossie believes he texted a seller and did not — worse than an error, because
// the follow-up never happens and nobody finds out until the deal is gone.
//
// Reasons, all of which the UI should be able to render:
//   not_authenticated        missing or invalid JWT
//   no_team                  signed in but not on a team
//   bad_request              missing to/body, or body over 1600 characters
//   unsupported_destination  not a valid US/CA 10-digit number
//   sms_send_disabled        teams.sms_send_disabled — the owner-only hard kill
//   sms_send_paused          telephony_settings.sms_send_paused — operator pause
//   kill_switch_check_failed could not read either switch; fails closed
//   opted_out                destination is in telephony_opt_outs
//   suppression_check_failed could not read the opt-out list; fails closed
//   lead_not_found           lead_id given but not on this team
//   lead_dnc                 leads.is_dnc
//   lead_litigator           leads.is_litigator
//   lead_not_dialable        lead_is_dialable() is false for some other reason —
//                            trashed, phone_invalid, or no consent basis yet
//   lead_check_failed        could not evaluate dialability; fails closed
//   no_sending_number        nothing pinned, defaulted or primary
//   number_not_sms_enabled   phone_numbers.sms_enabled is false
//   a2p_not_approved         phone_numbers.a2p_status is not 'approved'
//   outside_texting_window   8am-9pm in the CALLED PARTY's local time
//   duplicate_send           idempotency hit; the prior message is returned
//   not_recorded             could not write the row, so nothing was sent
//   twilio_not_configured    edge secrets missing
//   twilio_error             Twilio rejected it (code and message included)
//   method_not_allowed       not a POST
//   not_configured           the Supabase environment is incomplete
//
// Request:  { to, body, lead_id?, from_number_id?, idempotency_key? }
// Success:  200 { ok:true, sent:true, message_id, twilio_sid, status, from, to }
// Refusal:  4xx/5xx { ok:false, sent:false, reason, message, ... }
//
// Non-2xx bodies are still JSON. Through supabase-js that arrives as a
// FunctionsHttpError whose `.context` is the Response, so the UI reads the
// reason with `await error.context.json()`.
//
// Edge secrets (Supabase → Edge Functions → Secrets. Never in the database,
// never prefixed VITE_):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_STATUS_CALLBACK_URL   optional. When set, Twilio posts delivery
//                                receipts there. Omitted rather than guessed —
//                                a wrong callback URL strands every message at
//                                'queued' forever and looks like a send bug.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders, jsonResponse } from '../_shared/cors.ts';
import { normalizeE164, phoneKey } from '../_shared/phone-validation.ts';
import { isWithinContactWindow } from '../_shared/calling-window.ts';

// Twilio's hard limit on one message body.
const MAX_BODY_CHARS = 1600;

// How long an identical outbound text to the same number counts as a repeat
// rather than a new message. Long enough to swallow a double-tap and a network
// retry; short enough that deliberately sending "?" twice in a live
// conversation is not blocked for the rest of the afternoon.
const DEDUP_WINDOW_SECONDS = 120;

/**
 * Every refusal has the same shape, so the UI has exactly one thing to read.
 * `sent` is stated explicitly rather than implied by the status code because
 * the one question the operator has is "did it go out or not".
 */
function refuse(
  cors: Record<string, string>,
  status: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse({ ok: false, sent: false, reason, message, ...extra }, cors, status);
}

/**
 * Twilio's message statuses are a superset of what sms_messages.status allows —
 * 'accepted', 'scheduled' and 'sending' are not in the CHECK constraint. Map
 * before writing: an unmapped value fails the constraint, and the row we would
 * lose is the only record that this text was ever sent.
 */
function mapTwilioStatus(s: unknown): string {
  switch (String(s || '').toLowerCase()) {
    case 'delivered': return 'delivered';
    case 'sent': return 'sent';
    case 'failed': return 'failed';
    case 'undelivered': return 'undelivered';
    default: return 'queued'; // accepted / scheduled / sending / queued / unknown
  }
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return refuse(cors, 405, 'method_not_allowed', 'POST only.');

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return refuse(cors, 500, 'not_configured', 'The Supabase environment is incomplete on this function.');
  }

  // ── 1. Input ──────────────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return refuse(cors, 400, 'bad_request', 'The request body must be JSON.');
  }

  const toRaw = typeof payload.to === 'string' ? payload.to.trim() : '';
  const messageBody = typeof payload.body === 'string' ? payload.body.trim() : '';
  const leadId = typeof payload.lead_id === 'string' && payload.lead_id ? payload.lead_id : null;
  const fromNumberId = typeof payload.from_number_id === 'string' && payload.from_number_id
    ? payload.from_number_id
    : null;
  const idempotencyKey = typeof payload.idempotency_key === 'string' && payload.idempotency_key
    ? payload.idempotency_key.slice(0, 200)
    : null;

  if (!toRaw || !messageBody) {
    return refuse(cors, 400, 'bad_request', 'Both "to" and "body" are required.');
  }
  if (messageBody.length > MAX_BODY_CHARS) {
    return refuse(cors, 400, 'bad_request',
      `That message is ${messageBody.length} characters. The limit is ${MAX_BODY_CHARS}.`);
  }

  // normalizeE164 is best-effort and will happily hand back an international
  // number. This path refuses anything that is not NANP rather than guessing:
  // the timezone map, phone_key() and the entire compliance story are US/CA
  // only, and a mistyped country code is also how you buy a $40 premium-rate
  // text. First digit of both the area code and the exchange must be 2-9.
  const to = normalizeE164(toRaw);
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(to)) {
    return refuse(cors, 400, 'unsupported_destination', 'That is not a valid US or Canadian number.');
  }

  // ── 2. Who is asking ──────────────────────────────────────────────────────
  // The JWT is verified by asking the auth server, not by decoding it here. An
  // edge function that trusts an unverified `sub` claim is an open relay.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return refuse(cors, 401, 'not_authenticated', 'Sign in to send messages.');

  // Everything past this point runs on the service role, which bypasses RLS.
  // That is why teamId is resolved once here and then used to scope every read
  // and write by hand — RLS is not doing it for us, so a missing
  // .eq('team_id', …) is a cross-tenant bug rather than an empty result. Every
  // query below carries one.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Two kinds of caller, and only two.
  //
  // A signed-in operator, which is every send from the UI and every approved
  // SDR draft: the JWT is verified and the team comes from their profile.
  //
  // Or another edge function on the service role — the AI SDR's autonomous
  // sends and the dialer's follow-up texts, which run from cron with no user
  // session to borrow. Those cannot call auth.getUser(): the service key is a
  // JWT with no `sub`, so GoTrue rejects it. They pass team_id explicitly
  // instead, and it is trusted precisely because holding the service key
  // already means holding the whole database.
  //
  // The distinction is kept rather than collapsed because it decides who the
  // timeline says sent this: a person, or the SDR.
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const isInternal = !!serviceKey && bearer === serviceKey;

  let callerUserId: string | null = null;
  let teamId: string | null = null;

  if (isInternal) {
    teamId = typeof payload.team_id === 'string' && payload.team_id ? payload.team_id : null;
    if (!teamId) {
      return refuse(cors, 400, 'bad_request',
        'An internal caller must pass team_id — there is no session to read it from.');
    }
  } else {
    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) {
      return refuse(cors, 401, 'not_authenticated', 'Your session has expired. Sign in again.');
    }
    callerUserId = user.id;

    const { data: profile } = await admin
      .from('profiles')
      .select('team_id')
      .eq('id', user.id)
      .maybeSingle();

    teamId = profile?.team_id ?? null;
    if (!teamId) return refuse(cors, 403, 'no_team', 'Your account is not on a team yet.');
  }

  // ── 3. The two kill switches ──────────────────────────────────────────────
  // Checked before anything costs money or reaches a homeowner. Both exist and
  // both are honoured: teams.sms_send_disabled is the owner-only hard kill
  // (RLS restricts the UPDATE), telephony_settings.sms_send_paused is the
  // "stop while we sort out a carrier problem" switch any operator can flip.
  const [teamRes, settingsRes] = await Promise.all([
    admin.from('teams').select('sms_send_disabled').eq('id', teamId).maybeSingle(),
    admin.from('telephony_settings')
      .select('default_number_id, sms_send_paused')
      .eq('team_id', teamId)
      .maybeSingle(),
  ]);

  // FAILS CLOSED, for the same reason the opt-out check does. Reading `data`
  // and dropping `error` on the floor would mean a transient database blip
  // silently turns both kill switches off — and the whole premise of a kill
  // switch is that somebody flipped it because texting had to stop right now.
  // A switch whose state could not be read is not a switch that is off.
  if (teamRes.error || settingsRes.error) {
    console.error('[twilio-send-sms] kill-switch read failed:',
      teamRes.error?.message || settingsRes.error?.message);
    return refuse(cors, 503, 'kill_switch_check_failed',
      'The send switches could not be read, so nothing was sent. Try again shortly.');
  }
  const team = teamRes.data;
  const settings = settingsRes.data;

  if (team?.sms_send_disabled === true) {
    return refuse(cors, 403, 'sms_send_disabled',
      'SMS sending is disabled for this account. Only the owner can turn it back on.');
  }
  if (settings?.sms_send_paused === true) {
    return refuse(cors, 403, 'sms_send_paused', 'SMS sending is paused in telephony settings.');
  }

  // ── 4. Suppression ────────────────────────────────────────────────────────
  // is_opted_out() reduces its argument through phone_key(), so the stored
  // last-10-digits form and Twilio's E.164 form compare equal. p_team is passed
  // explicitly because the service role bypasses RLS and would otherwise read
  // every team's suppression list as one list.
  //
  // FAILS CLOSED. If the check errors, the send is refused. A suppression check
  // that degrades to "assume they didn't opt out" is not a rail — and what it
  // is protecting against is $500-$1,500 per text.
  const { data: optedOut, error: optOutErr } = await admin.rpc('is_opted_out', {
    p_team: teamId,
    p_number: to,
  });
  if (optOutErr) {
    console.error('[twilio-send-sms] opt-out check failed:', optOutErr.message);
    return refuse(cors, 503, 'suppression_check_failed',
      'The opt-out list could not be checked, so nothing was sent. Try again shortly.');
  }
  if (optedOut === true) {
    return refuse(cors, 403, 'opted_out', 'This number has opted out. Texting it again is not permitted.');
  }

  // ── 5. The lead, when there is one ────────────────────────────────────────
  // A text can go to a number with no lead attached — a cash buyer, a title
  // company — so lead_id is optional. When it is given, the gate is
  // public.lead_is_dialable(), not a hand-written subset of it.
  //
  // `dialable:lead_is_dialable` is a PostgREST computed column: a function
  // whose only argument is the table's row type is selectable as though it were
  // a column. twilio-voice asks the same way, and that matters — it is the one
  // definition of "may we contact this person", so the dialer, the SDR and this
  // path cannot drift apart. Checking is_dnc and is_litigator by hand here and
  // stopping there would have left three rules unenforced on the SMS path:
  //
  //   - trashed and phone_invalid leads are still textable
  //   - the CONSENT BASIS is never checked. A cold-list lead is only
  //     contactable once skip_traced AND dnc_scrubbed; a website lead needs
  //     tcpa_opt_in. BUILD_PLAN §Phase 1.5 makes that a database-level
  //     guarantee precisely because the cost of getting it wrong is statutory
  //     damages per text, and this path was going around it.
  //   - the opt-out list is checked against BOTH numbers on the lead. Step 4
  //     above only ever sees the one number being texted, so a STOP that
  //     arrived on the landline would not have stopped a text to the mobile —
  //     the exact fact pattern 20260818120000_telephony.sql calls out.
  //
  // is_dnc and is_litigator are still read, only so the refusal can name the
  // reason. lead_is_dialable() would refuse both anyway.
  let lead: { id: string; state: string | null; first_contact_at: string | null } | null = null;

  if (leadId) {
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, state, is_dnc, is_litigator, first_contact_at, dialable:lead_is_dialable')
      .eq('id', leadId)
      .eq('team_id', teamId)
      .maybeSingle();

    // Separated from lead_not_found deliberately. Collapsing a failed query
    // into "that lead is not on this team" sends the operator hunting for the
    // wrong problem, and a dialability check that could not run must never
    // degrade to a send.
    if (leadErr) {
      console.error('[twilio-send-sms] lead dialability check failed:', leadErr.message);
      return refuse(cors, 503, 'lead_check_failed',
        'This lead could not be checked for compliance, so nothing was sent. Try again shortly.');
    }
    if (!leadRow) return refuse(cors, 404, 'lead_not_found', 'That lead is not on this team.');
    if (leadRow.is_dnc) {
      return refuse(cors, 403, 'lead_dnc', 'This lead is on the Do Not Call list.');
    }
    if (leadRow.is_litigator) {
      return refuse(cors, 403, 'lead_litigator',
        'This number is flagged as a TCPA litigator. Do not contact it.');
    }
    // `!== true` rather than `=== false`, so a null from a future change to the
    // function is a refusal instead of a send.
    if (leadRow.dialable !== true) {
      return refuse(cors, 403, 'lead_not_dialable',
        'This lead is not contactable yet. A cold-list lead has to be skip traced and DNC scrubbed first; a website lead needs its TCPA opt-in on file.');
    }
    lead = leadRow;
  }

  // ── 6. The sending number ─────────────────────────────────────────────────
  // Order: the number the caller pinned, then the team default, then the
  // primary. The dialer and the SDR pin one so a conversation keeps the same
  // From across every message — a seller who gets replies from three different
  // numbers reports all three as spam.
  //
  // released_at IS NULL is applied to all three, including the pinned-id case.
  // A released number is not ours any more — it is back in Twilio's pool and
  // may already belong to somebody else — so a send from it would either fail
  // at Twilio or, worse, be attributed to a stranger's line. The SDR and the
  // dialer pin a number id and can hold a stale one across a release, which is
  // exactly why the filter cannot live only on the fallback branches.
  let numberQuery = admin
    .from('phone_numbers')
    .select('id, e164, sms_enabled, a2p_status')
    .eq('team_id', teamId)
    .is('released_at', null);

  if (fromNumberId) numberQuery = numberQuery.eq('id', fromNumberId);
  else if (settings?.default_number_id) numberQuery = numberQuery.eq('id', settings.default_number_id);
  else numberQuery = numberQuery.eq('is_primary', true);

  const { data: fromNumber } = await numberQuery.limit(1).maybeSingle();

  if (!fromNumber) {
    // The pinned case gets its own sentence. "No sending number is configured"
    // is actively misleading when the team has several — the caller named one
    // that has since been released, and telling them to go add a number sends
    // them to a settings page that already looks fine.
    return refuse(cors, 400, 'no_sending_number',
      fromNumberId
        ? 'The number this conversation sends from is no longer available — it was released back to Twilio, or it is not on this team. Nothing was sent.'
        : 'No sending number is configured. Add one in telephony settings.');
  }
  // sms_enabled defaults false and a2p_status defaults 'not_started': a number
  // is voice-only until A2P clears and someone deliberately turns texting on.
  // Sending before then does not fail politely — carriers answer 30007/30008
  // and the attempt counts against the brand's standing while it is still being
  // vetted, which can lose the registration outright.
  if (!fromNumber.sms_enabled) {
    return refuse(cors, 403, 'number_not_sms_enabled',
      `${fromNumber.e164} is a voice-only number. Enable SMS on it first.`);
  }
  if (fromNumber.a2p_status !== 'approved') {
    return refuse(cors, 403, 'a2p_not_approved',
      `A2P 10DLC registration for ${fromNumber.e164} is "${fromNumber.a2p_status}". Texting is blocked until it is approved.`);
  }

  // ── 7. The calling window ─────────────────────────────────────────────────
  // 8am-9pm in the CALLED PARTY's local time, resolved from their area code
  // with the lead's state as the fallback. Enforced here rather than by hiding
  // the send button, because a drip step, a dialer follow-up text and a cron
  // retry never see the send button. The 2am queued drip is exactly the case
  // this catches.
  //
  // When neither the area code nor the lead's state resolves, the helper hands
  // back America/New_York and marks the reason '_unresolved_tz'. Treating that
  // guess as a fact is how you text a Seattle homeowner at 5am: the area-code
  // table covers ~70 of NANP's 350+ codes, and Eastern is the EARLIEST US zone,
  // so an unresolved guess is wrong in the dangerous direction every single
  // time. An unresolved number therefore gets the intersection of the window
  // across the continental zones instead — 11am-9pm Eastern is 8am-6pm Pacific,
  // and inside 8am-9pm everywhere between. Losing three hours of texting on a
  // number whose location we do not know is the right side to lose on.
  // One instant for both calls, not two `new Date()`s: the helper takes the
  // moment as an argument specifically so every question is asked about a fixed
  // point, and a second call that lands across an hour boundary would answer a
  // different question than the one that decided which window to apply.
  const askedAt = new Date();
  const target = { phone: to, state: lead?.state ?? null };
  const probe = isWithinContactWindow(target, askedAt);
  const tzUnresolved = probe.reason.endsWith('_unresolved_tz');
  const win = tzUnresolved
    ? isWithinContactWindow(target, askedAt, { startHour: 11, endHour: 21 })
    : probe;

  if (!win.allowed) {
    // localHour is null when Intl could not read the clock at all, which is a
    // different failure from an unresolved zone and must not be printed as
    // "00:00" — a made-up time is what talks somebody into overriding this.
    const hh = win.localHour === null ? null : String(win.localHour).padStart(2, '0');
    return refuse(cors, 403, 'outside_texting_window',
      hh === null
        ? `The local time for this number could not be read (${win.tz}). Texting is only permitted 8am-9pm their time, so this send is refused rather than guessed at.`
        : tzUnresolved
        ? `This number's timezone could not be determined, so texting it is held to 11am-9pm Eastern — the only span that is inside 8am-9pm everywhere it could be. It is ${hh}:00 Eastern.`
        : `It is ${hh}:00 where this number is (${win.tz}). Texting is only permitted 8am-9pm their time.`,
      {
        local_hour: win.localHour,
        tz: win.tz,
        tz_unresolved: tzUnresolved,
        window_reason: win.reason,
        next_open_at: win.nextOpen.toISOString(),
      });
  }

  // ── 8. Idempotency ────────────────────────────────────────────────────────
  // There is no send_idempotency table and Twilio has no Idempotency-Key header
  // (checked: their REST API does not implement one), so the guard is built out
  // of what the schema already has, in two layers that catch different races.
  //
  //   (a) A recent identical outbound message. Catches the sequential repeat —
  //       the double-tap where the first send already finished, and the cron
  //       step that re-runs work it already did.
  //   (b) A claim row whose twilio_sid is a deterministic 'pending:' token.
  //       twilio_sid is the only UNIQUE column on sms_messages, so the second
  //       of two genuinely concurrent requests loses the insert and stops. The
  //       token cannot collide with a real SID — Twilio's are SM/MM followed by
  //       32 hex — so the inbound and status webhooks can never match one.
  //
  // On success the token is replaced by the real SID, which is what the status
  // webhook correlates on. From that moment layer (a) is what holds, which is
  // why the window is a duration and not a single attempt.
  const sinceIso = new Date(Date.now() - DEDUP_WINDOW_SECONDS * 1000).toISOString();
  const { data: recent } = await admin
    .from('sms_messages')
    .select('id, twilio_sid, status, created_at')
    .eq('team_id', teamId)
    .eq('direction', 'outbound')
    .eq('to_e164', to)
    .eq('body', messageBody)
    .gte('created_at', sinceIso)
    // A failed or undelivered row is not a duplicate to defend against — it is
    // a message the seller never received. Matching it would answer a
    // deliberate retry with "that exact message was just sent to this number",
    // which is the lie this whole file exists to prevent, only inverted: the
    // operator believes the text went out, stops retrying, and the follow-up
    // never happens.
    .not('status', 'in', '(failed,undelivered)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent) {
    return refuse(cors, 409, 'duplicate_send', 'That exact message was just sent to this number.', {
      message_id: recent.id,
      twilio_sid: recent.twilio_sid,
      status: recent.status,
      original_sent_at: recent.created_at,
    });
  }

  // A caller-supplied key wins over the content hash so an automated retry of
  // the same logical send still collides even if the body was regenerated —
  // the SDR does not produce byte-identical text twice.
  const claimSource = idempotencyKey
    ? `${teamId}|key|${idempotencyKey}`
    : `${teamId}|${to}|${messageBody}|${Math.floor(Date.now() / (DEDUP_WINDOW_SECONDS * 1000))}`;
  const claimToken = `pending:${(await sha256Hex(claimSource)).slice(0, 40)}`;

  // The row is written BEFORE Twilio is called, so a response we never receive
  // still leaves evidence that a text may have gone out. The alternative —
  // send first, record after — loses the message entirely if the function is
  // killed mid-flight, and an unrecorded text to a seller is indistinguishable
  // from one that was never sent.
  const { data: claimed, error: claimErr } = await admin
    .from('sms_messages')
    .insert({
      team_id: teamId,
      lead_id: lead?.id ?? null,
      phone_number_id: fromNumber.id,
      direction: 'outbound',
      from_e164: fromNumber.e164,
      to_e164: to,
      body: messageBody,
      status: 'queued',
      twilio_sid: claimToken,
    })
    .select('id')
    .maybeSingle();

  if (claimErr) {
    // 23505 is the unique violation on twilio_sid: an identical send is already
    // in flight on another request. Refusing is the correct outcome, not a bug.
    if (claimErr.code === '23505') {
      return refuse(cors, 409, 'duplicate_send',
        'An identical message to this number is already being sent.');
    }
    console.error('[twilio-send-sms] could not record the outbound message:', claimErr.message);
    return refuse(cors, 500, 'not_recorded',
      'Nothing was sent, because the message could not be recorded first.');
  }
  const messageId = (claimed as { id: string }).id;

  // ── 9. Twilio ─────────────────────────────────────────────────────────────
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
  if (!accountSid || !authToken) {
    // The row stays, marked failed, rather than being deleted. sms_messages has
    // no DELETE grant for anyone but the service role for exactly this reason:
    // it is the evidence of what was and was not said to a homeowner.
    //
    // The 'pending:' claim token is cleared, though. Nothing was sent and no
    // SID exists, so holding the token would only make the retry — after
    // somebody sets the secrets — collide on twilio_sid and get reported as
    // "already being sent". NULL is allowed on that UNIQUE column and is the
    // honest value.
    await admin.from('sms_messages')
      .update({ status: 'failed', error_code: 'twilio_not_configured', twilio_sid: null })
      .eq('id', messageId);
    return refuse(cors, 500, 'twilio_not_configured',
      'Twilio credentials are not set on this function.', { message_id: messageId });
  }

  const form = new URLSearchParams({ To: to, From: fromNumber.e164, Body: messageBody });
  const statusCallback = Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || '';
  if (statusCallback) form.set('StatusCallback', statusCallback);

  let twilio: Record<string, unknown> = {};
  let twilioOk = false;
  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          // Basic auth over TLS is Twilio's own scheme. The token exists only
          // in this process's environment; it is never logged, never stored and
          // never returned to the caller.
          Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    twilio = await resp.json();
    twilioOk = resp.ok;
  } catch (err) {
    // The claim token is deliberately KEPT here, unlike every other failure
    // path. A request that was sent and whose response was lost is
    // indistinguishable from one that never left, so the outcome is unknown —
    // and holding the token is what stops an immediate retry from being the
    // second text a seller gets. Refusing a possible duplicate is recoverable;
    // sending one is not.
    await admin.from('sms_messages')
      .update({ status: 'failed', error_code: 'network' })
      .eq('id', messageId);
    console.error('[twilio-send-sms] Twilio request failed:', (err as Error)?.message);
    return refuse(cors, 502, 'twilio_error',
      'Twilio did not answer. The message may or may not have gone out — check the thread before sending it again.',
      { message_id: messageId });
  }

  if (!twilioOk) {
    const code = twilio.code ? String(twilio.code) : 'unknown';
    const detail = typeof twilio.message === 'string' ? twilio.message : 'Twilio rejected the message.';

    // Twilio answered and refused, so this text definitively did not go out.
    // Clearing the claim token lets a corrected retry inside the dedup window
    // claim its own row instead of colliding on twilio_sid and being told an
    // identical message is "already being sent" — same false reassurance, just
    // a different shape.
    await admin.from('sms_messages')
      .update({ status: 'failed', error_code: code, twilio_sid: null })
      .eq('id', messageId);

    // 21610 is Twilio's own "this recipient replied STOP". Twilio keeps an
    // opt-out list per sending number that our webhook can miss — a STOP sent
    // before this platform existed, or one that arrived while the webhook was
    // down. Learning it from the rejection and writing it into
    // telephony_opt_outs is what makes the next attempt fail at step 4 instead
    // of reaching Twilio again. phone_key() first: the column stores the
    // already-reduced value, never a raw number. ignoreDuplicates is the
    // ON CONFLICT (team_id, phone_key) DO NOTHING the STOP path uses.
    if (code === '21610') {
      const { error: optOutWriteErr } = await admin.from('telephony_opt_outs')
        .upsert({
          team_id: teamId,
          phone_key: phoneKey(to),
          source: 'sms_stop',
          note: 'Learned from Twilio error 21610 on an outbound send.',
        }, { onConflict: 'team_id,phone_key', ignoreDuplicates: true });
      if (optOutWriteErr) {
        console.error('[twilio-send-sms] could not record 21610 opt-out:', optOutWriteErr.message);
      }

      return refuse(cors, 403, 'opted_out',
        'This number has opted out. Texting it again is not permitted.',
        { message_id: messageId, twilio_code: code });
    }

    return refuse(cors, 502, 'twilio_error', detail, { message_id: messageId, twilio_code: code });
  }

  // ── 10. It went out ───────────────────────────────────────────────────────
  const twilioSid = typeof twilio.sid === 'string' ? twilio.sid : null;
  const status = mapTwilioStatus(twilio.status);
  const parsedSegments = twilio.num_segments ? parseInt(String(twilio.num_segments), 10) : NaN;
  const numSegments = Number.isFinite(parsedSegments) ? parsedSegments : null;
  const sentAt = new Date().toISOString();

  const { error: updateErr } = await admin
    .from('sms_messages')
    .update({
      // Replacing the claim token with the real SID is what lets the status
      // webhook find this row when the delivery receipt arrives.
      twilio_sid: twilioSid,
      status,
      num_segments: numSegments,
      sent_at: sentAt,
    })
    .eq('id', messageId);

  if (updateErr) {
    // The text is gone and nothing can un-send it. Log loudly — a clean success
    // response over an unrecorded send is the failure this whole file exists to
    // prevent — but still return success, because it did send.
    console.error('[twilio-send-sms] sent but not updated:', updateErr.message, 'sid=', twilioSid);
  }

  // The timeline writes are deliberately non-fatal. The message is already with
  // Twilio; failing the call because an activity row did not land would tell the
  // operator to send it again, which is the one thing we must not do.
  if (lead) {
    const { error: activityErr } = await admin.from('lead_activity').insert({
      team_id: teamId,
      lead_id: lead.id,
      actor_id: callerUserId,
      // An autonomous send has no person behind it, and the timeline has to say
      // so — 'user' with a null actor_id would read as "somebody did this and we
      // lost track of who", which is the opposite of the truth.
      actor_kind: callerUserId ? 'user' : 'ai',
      type: 'sms_sent',
      summary: messageBody.length > 120 ? `${messageBody.slice(0, 117)}...` : messageBody,
      payload: {
        to,
        from: fromNumber.e164,
        message_id: messageId,
        twilio_sid: twilioSid,
        num_segments: numSegments,
      },
    });
    if (activityErr) console.error('[twilio-send-sms] activity row failed:', activityErr.message);

    // first_contact_at is set once and never moved; last_contacted_at is what
    // the follow-up queue sorts on, so a text has to count as contact or the
    // lead surfaces again tomorrow as though nobody had touched it.
    const { error: leadTouchErr } = await admin.from('leads')
      .update({
        last_contacted_at: sentAt,
        ...(lead.first_contact_at ? {} : { first_contact_at: sentAt }),
      })
      .eq('id', lead.id)
      .eq('team_id', teamId);
    if (leadTouchErr) console.error('[twilio-send-sms] lead touch failed:', leadTouchErr.message);
  }

  return jsonResponse({
    ok: true,
    sent: true,
    message_id: messageId,
    twilio_sid: twilioSid,
    status,
    from: fromNumber.e164,
    to,
    num_segments: numSegments,
    ...(updateErr ? { warning: 'Message sent, but the record could not be updated.' } : {}),
  }, cors, 200);
});
