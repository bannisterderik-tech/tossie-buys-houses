// supabase/functions/twilio-webhook/index.ts
// ============================================================================
// Inbound SMS from Twilio.
// ============================================================================
// Twilio POSTs application/x-www-form-urlencoded with From, To, Body,
// MessageSid, AccountSid, NumSegments, NumMedia. Configure it at
// Twilio Console -> Phone Number -> Messaging -> "A message comes in":
//
//   {SUPABASE_URL}/functions/v1/twilio-webhook
//
// DEPLOYMENT: this function must be deployed with JWT verification OFF
// (`supabase functions deploy twilio-webhook --no-verify-jwt`). Twilio cannot
// send a Supabase JWT, so with the default on, every inbound text is rejected
// at the gateway and none of the code below ever runs — and it fails silently,
// because Twilio's error shows up in Twilio's console, not ours. The signature
// check below is what authenticates the caller instead, and it is strictly
// stronger than a shared bearer token: it proves possession of the auth token
// AND that the body was not altered.
//
// Ported from reoperative's twilio-webhook (577 lines). Stripped, per
// BUILD_PLAN §6: the master-account/subaccount credential resolution and the
// AES-GCM encrypted per-team BYO auth tokens (Tossie is one business paying
// one Twilio bill), the FollowUpBoss note mirroring (there is no outside CRM —
// the lead detail panel is the CRM) and the text-for-info keyword router (a
// listing-agent feature). The AI SDR dispatch is left out until Phase 4 builds
// the SDR; the hook for it is marked below.
//
// Two places this is deliberately stricter than the original:
//   - No unsigned path at all. reoperative had a TWILIO_WEBHOOK_UNSAFE dev
//     bypass; a bypass flag that exists is a bypass flag that eventually ships.
//   - Unexpected failures answer 500 so Twilio retries. The original always
//     answered 200, which means a transient database blip silently ate a
//     seller's reply. Retrying is only safe because of the idempotency claim
//     below, so the two changes are one change.
//
// ORDER OF WRITES, and why it is the way it is. Suppression (STOP/START) is
// written BEFORE the idempotency claim; the message row, the timeline and the
// auto-reply record come after. The claim exists to stop a Twilio retry from
// doubling the thread, which means everything behind it is skipped on a retry —
// so anything that must survive a failure has to happen in front of it. Put the
// opt-out behind the claim and a failed suppression write becomes permanent: the
// 500 makes Twilio retry, the retry collides on the claim, returns the "you are
// unsubscribed" confirmation, and the opt-out row never exists. Both suppression
// writes are idempotent (ON CONFLICT DO NOTHING; a DELETE that matches nothing),
// so re-running them on every delivery is free.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateTwilioSignature } from '../_shared/twilio-signature.ts';
import { normalizeE164, phoneKey } from '../_shared/phone-validation.ts';

// Structural, so this file does not depend on which supabase-js specifier the
// rest of the functions settle on.
// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

// The name the seller sees in an auto-reply. Carriers require the message to
// say who is texting; an unbranded "You have been unsubscribed" is both a
// compliance finding and a confusing thing to receive.
const BRAND = 'Tossie Buys Houses';

// Whole-message keywords, matched exactly, case- and punctuation-insensitive.
//
// Deliberately NOT fuzzy: "stop by tomorrow at 3" is a hot seller confirming an
// appointment, and suppressing them would be worse than useless. A message that
// means stop without saying STOP is caught by a human reading the thread and
// adding a manual opt-out — which is what source 'manual' exists for.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const HELP_WORDS = new Set(['HELP', 'INFO']);
// Twilio's standard opt-in list also includes YES. Excluded on purpose: "yes"
// is the most common reply in a seller conversation, and reading it as "resume
// texting a number that opted out" gets that exactly backwards. START and
// UNSTOP cannot mean anything else.
const START_WORDS = new Set(['START', 'UNSTOP']);

type Keyword = 'stop' | 'help' | 'start' | null;

/** Classify the whole message, or null if it is an ordinary reply. */
function classify(body: string): Keyword {
  const word = (body || '').trim().toUpperCase().replace(/^\W+|\W+$/g, '');
  if (STOP_WORDS.has(word)) return 'stop';
  if (HELP_WORDS.has(word)) return 'help';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * The only auto-replies we send. STOP and HELP confirmations are carrier-
 * mandated, and the STOP confirmation is the one message that may be sent to a
 * number that has just opted out.
 *
 * Neither kill switch applies here — not teams.sms_send_disabled and not
 * telephony_settings.sms_send_paused. Those stop outreach. Pausing outreach is
 * not a reason to stop confirming that someone has been unsubscribed, and a
 * silent STOP is the complaint that gets a campaign deregistered.
 */
function replyFor(keyword: Keyword): string {
  switch (keyword) {
    case 'stop':
      return `You are unsubscribed from ${BRAND} messages. No more messages will be sent. Reply START to resubscribe.`;
    case 'help':
      return `${BRAND}: we text about your property inquiry. Reply STOP to unsubscribe. Msg & data rates may apply.`;
    case 'start':
      return `You are resubscribed to ${BRAND} messages. Reply STOP to opt out. Msg & data rates may apply.`;
    default:
      return '';
  }
}

Deno.serve(async (req: Request) => {
  // No OPTIONS handler and no CORS: Twilio is a server. A browser has no
  // business here, so it gets no preflight to work with.
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
  if (!authToken) {
    // Fail closed. Without the token we cannot tell Twilio from anyone else,
    // and "accept it anyway" is how an open endpoint gets written by accident.
    console.error('[twilio-webhook] TWILIO_AUTH_TOKEN is not set — refusing to accept unverifiable webhooks');
    return new Response('Server misconfigured', { status: 500 });
  }

  // Read the body once, as text: the signature covers the exact parameters, so
  // they have to be parsed out of the same bytes that were signed.
  const bodyText = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(bodyText).entries()) params[k] = v;

  const signature = req.headers.get('x-twilio-signature') || '';
  if (!(await validateTwilioSignature(req.url, params, signature, authToken))) {
    console.warn(`[twilio-webhook] rejected: bad or missing signature (sid=${params['MessageSid'] || 'none'})`);
    return new Response('Forbidden', { status: 403 });
  }

  // Belt to the signature's braces. A valid signature already proves the caller
  // holds our auth token, so a foreign AccountSid means either the token leaked
  // or a second Twilio account was pointed at this URL — both worth refusing
  // loudly rather than absorbing. Only enforced when the secret is set.
  const expectedAccount = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
  if (expectedAccount && params['AccountSid'] && params['AccountSid'] !== expectedAccount) {
    console.error(`[twilio-webhook] rejected: AccountSid ${params['AccountSid']} is not this project's account`);
    return new Response('Forbidden', { status: 403 });
  }

  const admin: SupabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const from = normalizeE164(params['From']);
  const to = normalizeE164(params['To']);
  // Body may legitimately be empty: an MMS carrying only a photo of the roof
  // has no text. reoperative dropped those; we store them, because "the seller
  // sent something we never saw" is the failure mode that costs a deal.
  const body = params['Body'] ?? '';
  const messageSid = params['MessageSid'] || params['SmsSid'] || '';
  const keyword = classify(body);

  // Twilio posts media as NumMedia plus MediaUrl0..N-1. Capped, because the
  // count is attacker-controlled only in the sense that a signed Twilio request
  // could carry a large one; the loop should not be unbounded on a number we
  // did not choose. Twilio's own limit is 10 per message.
  const mediaUrls: string[] = [];
  const numMedia = Math.min(Number(params['NumMedia']) || 0, 10);
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) mediaUrls.push(url);
  }

  if (!from || !to) {
    console.error(`[twilio-webhook] malformed payload, no From/To (sid=${messageSid || 'none'})`);
    return twiml(''); // 200: retrying will not add the missing fields
  }

  try {
    // ── Which of our numbers was texted ────────────────────────────────────
    // Matched on phone_key, not on the raw string, like every other Twilio ->
    // database join. Tossie owns a handful of numbers, so the whole table comes
    // back and the match happens here; that is cheaper and more honest than
    // contorting public.phone_key() into a PostgREST filter.
    const { data: numbers, error: numErr } = await admin
      .from('phone_numbers')
      .select('id, team_id, e164');
    if (numErr) throw numErr;

    const toKey = phoneKey(to);
    const ours = (numbers || []).find((n: { e164: string }) => phoneKey(n.e164) === toKey) ?? null;
    const fromKey = phoneKey(from);

    // Everything downstream is team-scoped, so the team has to be resolved
    // before anything else. Normally it is the owner of the number that was
    // texted. When there is no row for that number it is usually a
    // configuration error — a Twilio number points here but was never added in
    // the app — but it is also exactly what a released or deleted number looks
    // like: sms_messages.phone_number_id is ON DELETE SET NULL, so the
    // conversations outlive the row. Dropping the message there would mean
    // dropping a STOP from someone we demonstrably texted, which is the one
    // failure that costs $500-$1,500 per later message. So fall back to
    // whichever team the number was last used by.
    const teamId: string | null = ours?.team_id ?? (await teamFromNumberHistory(admin, toKey));
    if (!teamId) {
      // Genuinely unknown in both directions: no row, no history. Nothing can
      // be filed. Logged at error level because it is invisible to the seller.
      console.error(
        `[twilio-webhook] no phone_numbers row and no history for ${to} — message from ${from} dropped. Add the number in the app.`,
      );
      return twiml('');
    }
    if (!ours) {
      console.error(
        `[twilio-webhook] ${to} has no phone_numbers row — filing under team ${teamId} from prior traffic on it. Add the number in the app.`,
      );
    }
    // sms_enabled is deliberately not checked. It gates what we may SEND from a
    // number while A2P is pending; a seller who texts a voice-only line still
    // said something, and dropping it because of our registration state would
    // lose a deal for a reason that has nothing to do with them.

    const leadId = await matchLead(admin, teamId, fromKey);
    const ctx: ReplyContext = {
      teamId,
      leadId,
      phoneNumberId: ours?.id ?? null,
      ourE164: to,
      theirE164: from,
      inboundSid: messageSid,
    };

    // ── Suppression, ahead of the claim ────────────────────────────────────
    // See the note at the top of the file: these two writes are the ones that
    // must not be skippable by a retry, so they run first and they run every
    // time. Both are idempotent, so a redelivery costs one no-op statement.
    if (keyword === 'stop') {
      // phone_key, never the raw number: the column stores the already-reduced
      // value, so a STOP typed from a landline suppresses the mobile too.
      // ignoreDuplicates keeps the original opted_out_at — the date they first
      // said stop is the one that matters if this is ever questioned.
      const { error: optErr } = await admin
        .from('telephony_opt_outs')
        .upsert(
          {
            team_id: teamId,
            phone_key: fromKey,
            source: 'sms_stop',
            note: `Replied "${body.trim().slice(0, 40)}" to ${to}`,
          },
          { onConflict: 'team_id,phone_key', ignoreDuplicates: true },
        );
      // Never answer OK on a suppression we failed to write. Throwing lands on
      // the 500 below and Twilio retries the whole request, suppression first.
      if (optErr) throw optErr;

      if (leadId) {
        // is_dnc as well as consent_sms, because a text saying stop is not a
        // channel preference. lead_is_dialable() reads is_dnc, so this is what
        // takes them out of the dialer's queue and not just out of SMS.
        //
        // The error is checked rather than ignored: the opt-out row above is
        // what lead_is_dialable() actually enforces, but is_dnc is what an
        // operator sees on the lead, and a lead that reads "callable" after a
        // STOP is how someone dials them by hand.
        const { error: leadErr } = await admin.from('leads')
          .update({ consent_sms: false, is_dnc: true })
          .eq('id', leadId);
        if (leadErr) throw leadErr;
      }
      console.log(`[twilio-webhook] opt-out recorded for team ${teamId}`);
    } else if (keyword === 'start') {
      // Deleting the row is the un-suppression, and the service role is the
      // only thing that can do it: `authenticated` has no DELETE grant on
      // telephony_opt_outs, so there is no path from the operator UI to
      // un-suppressing anyone. It takes the person themselves, by text.
      const { error: delErr } = await admin
        .from('telephony_opt_outs')
        .delete()
        .eq('team_id', teamId)
        .eq('phone_key', fromKey);
      if (delErr) throw delErr;

      if (leadId) {
        // consent_sms comes back; is_dnc deliberately does not. That flag may
        // have been set by the federal DNC scrub rather than by their STOP, and
        // clearing it here would put a listed number back in the dial queue on
        // the strength of one text. A human clears it after reading the note.
        const { error: leadErr } = await admin.from('leads')
          .update({ consent_sms: true })
          .eq('id', leadId);
        if (leadErr) throw leadErr;
      }
      console.log(`[twilio-webhook] opt-in recorded for team ${teamId}`);
    }

    // ── Idempotency ────────────────────────────────────────────────────────
    // Twilio retries when it does not get our TwiML — a timeout, a 5xx, a
    // dropped connection. The insert IS the claim: sms_messages.twilio_sid is
    // UNIQUE, so a redelivery collides (23505) instead of doubling the thread,
    // and everything below it — the message row and the timeline — happens once.
    // Suppression is above it on purpose; see the note at the top of the file.
    //
    // Done this way rather than with reoperative's separate processed_webhooks
    // ledger so there is no second table that can drift out of agreement with
    // the messages themselves. The schema was built for it — see the note on
    // twilio_sid in 20260818120000_telephony.sql.
    const { data: inserted, error: insErr } = await admin
      .from('sms_messages')
      .insert({
        team_id: teamId,
        lead_id: leadId,
        phone_number_id: ctx.phoneNumberId,
        direction: 'inbound',
        from_e164: from,
        to_e164: to,
        body,
        status: 'received',
        twilio_sid: messageSid || null,
        num_segments: Number(params['NumSegments']) || null,
      })
      .select('id')
      .single();

    if (insErr) {
      if (insErr.code !== '23505') throw insErr;
      // Already stored, and suppression was re-applied above regardless. Still
      // answer with the keyword reply: a retry means Twilio never received our
      // first response, so the seller never got the confirmation that reply
      // owes them.
      console.log(`[twilio-webhook] duplicate ${messageSid} — message already stored`);
      return await respond(admin, ctx, keyword);
    }

    // ── Timeline ───────────────────────────────────────────────────────────
    // The lead detail panel is the CRM, so an inbound text has to appear in the
    // one timeline an operator reads. Unmatched messages have no lead to hang
    // off; they sit in sms_messages until someone attaches them.
    if (leadId) {
      await logActivity(admin, {
        team_id: teamId,
        lead_id: leadId,
        actor_kind: 'system',
        type: 'sms_received',
        summary: body ? `Texted: ${body.slice(0, 140)}` : 'Sent a picture message',
        payload: {
          sms_id: inserted.id,
          twilio_sid: messageSid || null,
          from,
          to,
          keyword,
          num_media: mediaUrls.length,
          // Twilio holds the media, not us, and these URLs are the only handle
          // on it. The count alone tells an operator a photo of the roof exists
          // and gives them no way to open it.
          media_urls: mediaUrls,
        },
      });

      if (keyword === 'stop') {
        await logActivity(admin, {
          team_id: teamId,
          lead_id: leadId,
          actor_kind: 'system',
          type: 'sms_opt_out',
          summary: 'Texted STOP — suppressed for SMS and calls',
          payload: { phone: from, source: 'sms_stop' },
        });
      } else if (keyword === 'start') {
        await logActivity(admin, {
          team_id: teamId,
          lead_id: leadId,
          actor_kind: 'system',
          type: 'sms_opt_in',
          summary: 'Texted START — SMS resumed. Review the DNC flag before calling.',
          payload: { phone: from, source: 'sms_start' },
        });
      }
    } else {
      console.warn(
        `[twilio-webhook] inbound from ${from} matched no lead — stored unattached ` +
          `(sms ${inserted.id}, ${mediaUrls.length} media)`,
      );
    }

    // ── Answer ─────────────────────────────────────────────────────────────
    // The keyword confirmation, or an empty <Response/> for an ordinary reply.
    // Phase 4 hooks the AI SDR in on that last case: lead matched, no keyword,
    // dispatch continue_conversation. Until the SDR exists there is no
    // auto-reply, which is the right thing to ship — an operator reading the
    // thread beats a bot guessing at it, and this is a homeowner, not a support
    // queue.
    return await respond(admin, ctx, keyword);
  } catch (err) {
    // 500, not 200: Twilio retries. The retry is safe because suppression is
    // idempotent and the twilio_sid claim absorbs the duplicate message, so the
    // seller's message survives a transient database failure.
    console.error(`[twilio-webhook] failed (sid=${messageSid}):`, (err as Error)?.message || err);
    return new Response('Internal error', { status: 500 });
  }
});

/** Everything respond() needs to record the auto-reply it is about to send. */
type ReplyContext = {
  teamId: string;
  leadId: string | null;
  phoneNumberId: string | null;
  ourE164: string;
  theirE164: string;
  inboundSid: string;
};

/**
 * Leads and messages store numbers however they were typed — "(912) 555-0134",
 * "912-555-0134", "+19125550134" — and PostgREST cannot call phone_key() in a
 * filter. A wildcard-interleaved ILIKE pulls a small candidate set out of the
 * database and phone_key equality decides from there. The loose half can only
 * over-fetch, so it can never produce a wrong match on its own.
 *
 * Safe to interpolate into a PostgREST or() filter: `key` is digits only, so it
 * cannot contain the comma or parenthesis that would break out of the clause.
 */
function likePattern(key: string): string {
  return `*${key.slice(0, 3)}*${key.slice(3, 6)}*${key.slice(6)}*`;
}

/**
 * Which team last used one of our numbers, for a number that no longer has a
 * phone_numbers row. Not team-scoped, obviously — finding the team is the point.
 */
async function teamFromNumberHistory(admin: SupabaseAdmin, ourKey: string | null): Promise<string | null> {
  if (!ourKey || ourKey.length !== 10) return null;
  const pattern = likePattern(ourKey);
  const { data } = await admin
    .from('sms_messages')
    .select('team_id')
    .or(`from_e164.ilike.${pattern},to_e164.ilike.${pattern}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.team_id ?? null;
}

/**
 * Answer with the keyword auto-reply, and record that we sent it.
 *
 * TwiML replies are sent by Twilio off the back of this response, so they never
 * pass through twilio-send-sms and would otherwise leave no trace. sms_messages
 * is the evidence of what was said to a homeowner — it has no DELETE grant for
 * exactly that reason — and the STOP confirmation is the single message most
 * likely to be asked about later. It also matters to the operator: a thread
 * showing the seller's "STOP" and no answer reads as if we ignored them.
 *
 * The synthetic 'reply:' twilio_sid borrows twilio-send-sms's 'pending:' trick.
 * twilio_sid is the only UNIQUE column on the table, so keying it to the inbound
 * SID means a Twilio retry — which reaches the duplicate branch and re-answers
 * with this same TwiML — records one reply rather than two. It cannot collide
 * with a real SID; Twilio's are SM/MM followed by 32 hex.
 */
async function respond(admin: SupabaseAdmin, ctx: ReplyContext, keyword: Keyword): Promise<Response> {
  const text = replyFor(keyword);
  if (!text) return twiml('');

  const { error } = await admin.from('sms_messages').insert({
    team_id: ctx.teamId,
    lead_id: ctx.leadId,
    phone_number_id: ctx.phoneNumberId,
    direction: 'outbound',
    from_e164: ctx.ourE164,
    to_e164: ctx.theirE164,
    body: text,
    // 'sent', not 'delivered': Twilio sends this one from our TwiML and there is
    // no status callback attached to it, so delivery is genuinely unknown.
    status: 'sent',
    twilio_sid: ctx.inboundSid ? `reply:${ctx.inboundSid}` : null,
    sent_at: new Date().toISOString(),
  });
  // Deliberately not fatal. A 500 here would make Twilio retry and re-answer
  // with the same TwiML, so the seller gets their confirmation either way —
  // failing the request would only risk the reply being sent twice.
  if (error && error.code !== '23505') {
    console.error(`[twilio-webhook] auto-reply sent but not recorded (sid=${ctx.inboundSid}):`, error.message);
  }
  return twiml(text);
}

/**
 * Timeline writes are best-effort and loud. supabase-js does not throw, so an
 * unchecked insert here fails in total silence; but throwing is worse, because
 * the retry would collide on the message claim and skip the timeline anyway.
 * Log it and keep the compliance path moving.
 */
// deno-lint-ignore no-explicit-any
async function logActivity(admin: SupabaseAdmin, row: Record<string, any>): Promise<void> {
  const { error } = await admin.from('lead_activity').insert(row);
  if (error) {
    console.error(`[twilio-webhook] timeline write failed (${row.type}, lead ${row.lead_id}):`, error.message);
  }
}

/**
 * Find the lead this number belongs to, strongest link first: the lead's own
 * phone, then a thread we have already had with this number, then a call.
 * Returns null rather than guessing — an unmatched message is stored
 * unattached, never filed against the wrong seller.
 */
async function matchLead(
  admin: SupabaseAdmin,
  teamId: string,
  key: string | null,
): Promise<string | null> {
  if (!key || key.length !== 10) return null;

  // See likePattern: loose ILIKE narrows, phone_key equality decides. This
  // cannot attach a message to the wrong lead — the exact half is the one that
  // returns a hit.
  const pattern = likePattern(key);

  const { data: leads } = await admin
    .from('leads')
    .select('id, phone, phone_mobile')
    .eq('team_id', teamId)
    .or(`phone.ilike.${pattern},phone_mobile.ilike.${pattern}`)
    .order('created_at', { ascending: false })
    .limit(25);
  const hit = (leads || []).find(
    (l: { phone: string | null; phone_mobile: string | null }) =>
      phoneKey(l.phone) === key || phoneKey(l.phone_mobile) === key,
  );
  if (hit) return hit.id;

  // No lead carries this number, but we may have texted it before — covers a
  // lead whose phone was corrected after the conversation started.
  const { data: prev } = await admin
    .from('sms_messages')
    .select('lead_id')
    .eq('team_id', teamId)
    .not('lead_id', 'is', null)
    .or(`from_e164.ilike.${pattern},to_e164.ilike.${pattern}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prev?.lead_id) return prev.lead_id;

  // Someone texting back the number that just called them is the same person.
  const { data: call } = await admin
    .from('call_log')
    .select('lead_id')
    .eq('team_id', teamId)
    .not('lead_id', 'is', null)
    .or(`from_e164.ilike.${pattern},to_e164.ilike.${pattern}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return call?.lead_id ?? null;
}

/** Twilio wants TwiML back. An empty <Response/> means "no auto-reply". */
function twiml(message: string): Response {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return new Response(xml, { headers: { 'Content-Type': 'text/xml' } });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
