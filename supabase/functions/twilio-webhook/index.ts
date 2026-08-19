// supabase/functions/twilio-webhook/index.ts
// ============================================================================
// Inbound SMS from Twilio, and delivery receipts for what we sent.
// ============================================================================
// Twilio POSTs application/x-www-form-urlencoded with From, To, Body,
// MessageSid, AccountSid, NumSegments, NumMedia. Configure it at
// Twilio Console -> Phone Number -> Messaging -> "A message comes in":
//
//   {SUPABASE_URL}/functions/v1/twilio-webhook
//
// The SAME URL is what twilio-send-sms hands Twilio as StatusCallback, so this
// function answers two different webhooks that share one shape. See the
// discriminator note below — that is the load-bearing part.
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
// listing-agent feature).
//
// THE SDR HOOK. An ordinary reply from a matched lead is handed to ai-sdr's
// continue_conversation after the message is stored. It is a notification and
// nothing more: this file decides only that a seller said something real, and
// ai-sdr decides whether anyone is allowed to answer — the team switch, the
// per-lead switch, draft-vs-auto, the grace period and the conversation lock
// all live over there, at the one choke point every SDR path funnels through.
// Re-deciding any of that here would be a second copy of a rule about texting
// a homeowner, and the copy that drifts is the one that answers a STOP.
// See notifySdr() for why it cannot fail this request.
//
// Two places this is deliberately stricter than the original:
//   - No unsigned path at all. reoperative had a TWILIO_WEBHOOK_UNSAFE dev
//     bypass; a bypass flag that exists is a bypass flag that eventually ships.
//   - Unexpected failures answer 500 so Twilio retries. The original always
//     answered 200, which means a transient database blip silently ate a
//     seller's reply. Retrying is only safe because of the idempotency claim
//     below, so the two changes are one change.
//
// A STRANGER'S FIRST TEXT IS A LEAD. An inbound message matching no lead used
// to be stored with lead_id NULL and left there. Keeping it was right; leaving
// it was not — a stranger texting this number is a seller answering a yard sign
// or a postcard, and nothing in the product ever showed it to anyone. Step 4
// below creates the lead. The consent record it writes, and the reasoning for
// why an inbound text is a genuine opt-in basis, live in inbound-lead.ts.
//
// ORDER OF WRITES, and why it is the way it is.
//
//   1. Signature check. First, always, and it fails closed — everything below
//      is a write on the service role, so an unsigned request is a stranger
//      with a pen. AccountSid is checked immediately after it.
//   2. DELIVERY RECEIPT BRANCH. Sits here, ahead of everything, because it is
//      the only branch that must be unable to reach the inbound path: a status
//      callback carries our own number as From and the seller as To, so if it
//      ever fell through it would be filed as a message the seller never sent.
//      It returns before From/To are resolved, before classify() is called and
//      before a single suppression write — a receipt can therefore never
//      trigger STOP handling, no matter what it carries, and it returns long
//      before step 4, so a status callback can never create a lead either.
//   3. Suppression (STOP/START), BEFORE the idempotency claim.
//   4. LEAD CREATION for an unmatched, non-keyword message. After suppression
//      so that nothing is ever inserted ahead of the compliance writes, and
//      before the claim so the message in step 5 can be filed against the lead
//      it just created rather than landing unattached and needing a second
//      pass to fix. It cannot fail the request — see createLeadFromInboundSms.
//   5. The idempotency claim (the sms_messages insert; twilio_sid is UNIQUE).
//   6. The timeline, the SDR notification and the auto-reply record.
//
// Step 4 is guarded on keyword === null, which is what actually keeps a STOP
// from creating a lead. Someone texting STOP to a number they were never on is
// precisely the person not to add to a CRM: they are telling you they do not
// want to hear from you, and answering that by opening a record on them —
// stamped, worse, with a consent basis — is the fact pattern that turns a
// complaint into a claim. HELP and START are excluded for the same reason. The
// ordering is a second line of defence, not the first: by the time step 4 could
// run, a STOP has already written its opt-out row above.
//
// It is guarded a second time on WHO sent it — senderCanOpenALead() in
// inbound-lead.ts — because two senders are not a homeowner and both of them
// would get a consent record saying one was: our own numbers, and any sender
// with fewer than ten digits, which matchLead() can never match again and which
// would therefore open a fresh lead on every message it ever sends.
//
// Steps 3 and 5 are in that order and not the other one. The claim exists to
// stop a Twilio retry from doubling the thread, which means everything behind it
// is skipped on a retry — so anything that must survive a failure has to happen
// in front of it. Put the opt-out behind the claim and a failed suppression
// write becomes permanent: the 500 makes Twilio retry, the retry collides on the
// claim, returns the "you are unsubscribed" confirmation, and the opt-out row
// never exists. Both suppression writes are idempotent (ON CONFLICT DO NOTHING;
// a DELETE that matches nothing), so re-running them on every delivery is free.
//
// THE DISCRIMINATOR. A delivery receipt is recognised by TWO facts that must
// both hold: MessageStatus is present and is not 'received', AND there is no
// Body key at all. Twilio's inbound webhook carries Body on every message —
// empty string for a photo-only MMS, but present — and reports its state in
// SmsStatus, never MessageStatus. A status callback is the mirror image: it
// carries MessageStatus (and SmsStatus alongside it) and no Body whatsoever.
//
// Requiring both is what makes it unable to misfire in the direction that
// costs something. A single signal could break either way if Twilio ever
// changed the payload; the conjunction can only fail one way. If Twilio starts
// sending MessageStatus on inbound messages, Body is still there, so the text
// is still handled as a text. If Twilio starts sending Body on status
// callbacks, the receipt falls through to the inbound path — where it collides
// on the UNIQUE twilio_sid of the outbound row it is a receipt FOR, is logged
// as a duplicate, and answers 200. That degrades to today's bug (statuses stop
// updating, visible on every thread) rather than to a fabricated inbound
// message or, far worse, a dropped STOP.
//
// That argument was made when the worst thing behind this branch was a mis-filed
// row, and step 4 would have widened it to a fabricated consent record: the From
// on a status callback is our own line, so the fall-through would open a lead on
// our own number. It cannot, because step 4 refuses our own numbers as senders.
// The degradation is still the one argued for above.
//
// 'received' is excluded explicitly rather than left to the Body test, because
// 'received' is the one MessageStatus value that describes an inbound message.
// If it ever shows up on the inbound webhook, that alone must not be enough to
// make this function stop storing seller replies.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateTwilioSignature } from '../_shared/twilio-signature.ts';
import { normalizeE164, phoneKey } from '../_shared/phone-validation.ts';
import { buildInboundLead, inboundConsentSummary, senderCanOpenALead } from './inbound-lead.ts';
import { classify, type Keyword, opensALead } from './keywords.ts';

// Structural, so this file does not depend on which supabase-js specifier the
// rest of the functions settle on.
// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

// The name the seller sees in an auto-reply. Carriers require the message to
// say who is texting; an unbranded "You have been unsubscribed" is both a
// compliance finding and a confusing thing to receive.
const BRAND = 'Tossie Buys Houses';

/**
 * How far along a message is, as a number that only ever goes up.
 *
 * twilio-voice keeps a flat TERMINAL list for calls and refuses to write a
 * non-terminal status over a terminal one; this is that rule for messages, plus
 * the rung below it. Rank 2 IS the terminal set — delivered, undelivered and
 * failed are the end of a message's story, and a 'sent' that took a slow detour
 * through a carrier queue must not reopen one. Ranking 'queued' under 'sent' as
 * well costs nothing and closes the other out-of-order case: Twilio's 'sending'
 * maps to 'queued' (see mapTwilioStatus), so without the lower rung a late
 * 'sending' would report a message that is already gone as still waiting.
 *
 * Out-of-order delivery is not an edge case here. Twilio fires a callback per
 * transition and retries any it does not get a 2xx for, so receipts routinely
 * arrive late, twice, and in the wrong order.
 */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  undelivered: 2,
  failed: 2,
};
const TERMINAL_RANK = 2;

/**
 * Twilio's message statuses are a superset of what sms_messages.status allows —
 * 'accepted', 'scheduled' and 'sending' are not in the CHECK constraint.
 *
 * The twin of this lives in twilio-send-sms, for the same reason and with the
 * same mapping: an unmapped value fails the constraint, and a rejected write
 * here means the receipt is lost and the operator keeps reading 'queued'.
 * Deliberately not hoisted into _shared/ — it is five lines and a comment, and
 * a shared module that two functions each import for one switch statement is
 * more coupling than the duplication costs. Grep both together before editing
 * either.
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

  // ── Delivery receipt, or a message from a seller? ─────────────────────────
  // Both signals, and the whole reasoning behind requiring both, are in the
  // DISCRIMINATOR note at the top of the file. This has to stay above
  // everything else in the handler: below this line the request is treated as
  // something a homeowner typed, which for a status callback would mean filing
  // our own outbound number as an inbound sender and running classify() over a
  // body that does not exist.
  const messageStatus = (params['MessageStatus'] || '').trim().toLowerCase();
  if (messageStatus && messageStatus !== 'received' && !('Body' in params)) {
    return await applyDeliveryReceipt(admin, params);
  }

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
    // The same table answers a second question, so it is asked here rather than
    // by a second query: is the SENDER one of ours? A message from our own line
    // is not a homeowner reaching out, and the two places that would treat it
    // as one — lead creation and the SDR hand-off — are the two that write or
    // say something. See senderCanOpenALead for what reaches this shape.
    const fromIsOneOfOurs = fromKey !== null &&
      (numbers || []).some((n: { e164: string }) => phoneKey(n.e164) === fromKey);

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

    // `let`, because step 4 below may fill it in. Every write after that point
    // reads this one variable, so the message, the timeline, the SDR hand-off
    // and the auto-reply record all agree on which lead they are about.
    let leadId = await matchLead(admin, teamId, fromKey);

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

    // ── A stranger's first text is a lead ──────────────────────────────────
    // opensALead() is the whole guard, and it lives in keywords.ts next to the
    // classifier it depends on so a test can assert the rule that a STOP never
    // creates a lead. Read it there; it is four lines.
    //
    // A photo-only MMS with no body still qualifies. classify('') is null, and
    // a stranger who sends a picture of a roof is reaching out; the consent
    // record says in words that the message carried no text, so nothing is
    // being claimed that did not happen.
    //
    // senderCanOpenALead() is the other half of the guard, and it is about who
    // sent the message rather than what it said: our own numbers and senders
    // too short to ever match again. Its reasoning is next to the consent
    // record it protects, in inbound-lead.ts.
    if (opensALead(keyword, leadId) && senderCanOpenALead(fromKey, fromIsOneOfOurs)) {
      leadId = await createLeadFromInboundSms(admin, {
        teamId,
        from,
        to,
        body,
        messageSid,
        mediaUrls,
      });
    }

    const ctx: ReplyContext = {
      teamId,
      leadId,
      phoneNumberId: ours?.id ?? null,
      ourE164: to,
      theirE164: from,
      inboundSid: messageSid,
    };

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
      // Two ways to land here now, and they are not the same event. A keyword
      // from a stranger is the design working: a STOP is suppressed and filed
      // and deliberately given no lead. Anything else means step 4 tried and
      // failed, which it has already logged at error level — this line is the
      // reminder that a real seller's message is sitting unattached.
      console.warn(
        `[twilio-webhook] inbound from ${from} has no lead — stored unattached ` +
          `(sms ${inserted.id}, keyword=${keyword ?? 'none'}, ${mediaUrls.length} media)`,
      );
    }

    // ── The AI SDR ─────────────────────────────────────────────────────────
    // Three conditions, and each one is a message the SDR must not see:
    //
    //   keyword === null   a STOP, START or HELP is a compliance instruction,
    //                      not a conversation. Answering a STOP with a
    //                      generated question is the single worst thing this
    //                      system could do, so the SDR is never told about one.
    //                      This branch is downstream of the suppression writes
    //                      above, so by the time anything could be dispatched
    //                      the opt-out row already exists — but the keyword
    //                      check is what actually stops it, not the ordering.
    //   leadId             normally satisfied now, because step 4 creates the
    //                      lead for exactly the messages that reach here — a
    //                      stranger's first text is the single most valuable
    //                      thing this endpoint receives and the SDR should see
    //                      it. Still checked, because step 4 is allowed to fail
    //                      without failing the request, and a lead id it did not
    //                      produce is not one to invent here. ai-sdr opens the
    //                      conversation itself off the stored inbound message
    //                      (see openInboundConversation) after running the same
    //                      gates every other send path runs; none of that is
    //                      re-decided here.
    //   body.trim()        an MMS of the roof with no caption. ai-sdr requires
    //                      inbound_message and would refuse it, and there is
    //                      nothing in a photo for a text model to answer.
    //   not one of ours    a message whose sender is one of our own lines is
    //                      our own outbound copy coming back — a lead typed
    //                      with one of our numbers is enough to produce it.
    //                      Handing that to the SDR is two numbers holding a
    //                      conversation with each other, a paid model call per
    //                      turn and nothing in the loop that ends it. Checked
    //                      here as well as at lead creation because a lead
    //                      already carrying one of our numbers is matched, not
    //                      created, and would walk past that guard.
    //
    // Placed after the idempotency claim on purpose: a Twilio redelivery
    // returns from the duplicate branch above and never reaches here, so one
    // inbound text produces at most one SDR turn. The cost is that a crash
    // between the claim and this line loses the notification, since the retry
    // is then a duplicate — a missed reply the operator can see in the thread,
    // rather than a seller texted twice by a machine.
    if (keyword === null && leadId && body.trim() && !fromIsOneOfOurs) {
      notifySdr({ leadId, body, messageSid });
    }

    // ── Answer ─────────────────────────────────────────────────────────────
    // The keyword confirmation, or an empty <Response/> for an ordinary reply.
    // The SDR's reply, when there is one, does NOT come back through this
    // TwiML: it goes out through twilio-send-sms minutes later at the earliest,
    // because a draft waits for a human and even an auto send has to clear the
    // opt-out list, the kill switches and the calling window first. Twilio is
    // answered now, in milliseconds, either way.
    return await respond(admin, ctx, keyword);
  } catch (err) {
    // 500, not 200: Twilio retries. The retry is safe because suppression is
    // idempotent and the twilio_sid claim absorbs the duplicate message, so the
    // seller's message survives a transient database failure.
    console.error(`[twilio-webhook] failed (sid=${messageSid}):`, (err as Error)?.message || err);
    return new Response('Internal error', { status: 500 });
  }
});

/**
 * Twilio telling us what became of a message we sent.
 *
 * Without this, every outbound row sits at 'queued' for the rest of time and
 * the operator cannot tell a text the seller read from one a carrier silently
 * dropped. For a wholesaler that is the difference between following up and
 * writing the lead off.
 *
 * Correlated on twilio_sid, which is UNIQUE, so the match is exact. Three
 * things narrow the write, and each one is load-bearing:
 *
 *   direction = 'outbound'
 *     A receipt can only ever be about a message we sent. Twilio's inbound
 *     webhook and a Messaging Service's account-wide status callback both carry
 *     a MessageSid, and an inbound row's SID is the inbound message's own — so
 *     without this filter a stray callback could overwrite a seller's stored
 *     'received' with 'delivered' and quietly rewrite what the thread says
 *     happened. The auto-reply rows are safe either way: they are keyed
 *     'reply:<sid>' and can never match a real SID.
 *
 *   the rank filter
 *     `status IN (…)` on the way in, listing only the states this receipt is
 *     allowed to advance FROM. A terminal receipt has no filter, because
 *     nothing outranks it. This is one atomic UPDATE rather than a read, a
 *     decision and a write — two receipts arriving at once would both pass a
 *     read-then-write check, and the loser would be the one that stuck.
 *
 *   delivered_at, only on 'delivered'
 *     It is a fact about one transition, not a general timestamp, and the
 *     UPDATE that carries it is the only one that may claim it.
 *
 * error_code is written when Twilio sends one and never cleared, because the
 * code IS the explanation for a terminal status and a later redelivery that
 * omitted it would erase the only thing on the row that tells the operator
 * whether to retry.
 *
 * A receipt for a SID we hold no row for answers 200. Twilio retries any
 * non-2xx until it gives up, so erroring on an unknown SID would buy an
 * indefinite retry loop for a message that is never going to appear —
 * a text sent from the Twilio console, or one whose row predates this handler.
 */
async function applyDeliveryReceipt(
  admin: SupabaseAdmin,
  params: Record<string, string>,
): Promise<Response> {
  const sid = params['MessageSid'] || params['SmsSid'] || '';
  const status = mapTwilioStatus(params['MessageStatus']);
  const errorCode = (params['ErrorCode'] || '').trim();

  if (!sid) {
    // 200, not 500: a retry cannot add a field Twilio did not send.
    console.error(`[twilio-webhook] status callback with no MessageSid (status=${status}) — nothing to correlate`);
    return twiml('');
  }

  const patch: Record<string, unknown> = { status };
  if (errorCode) patch.error_code = errorCode;
  if (status === 'delivered') patch.delivered_at = new Date().toISOString();

  let update = admin
    .from('sms_messages')
    .update(patch)
    .eq('twilio_sid', sid)
    .eq('direction', 'outbound');

  const rank = STATUS_RANK[status];
  if (rank < TERMINAL_RANK) {
    update = update.in(
      'status',
      Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s] <= rank),
    );
  }

  const { data, error } = await update.select('id');
  if (error) {
    // 500 so Twilio redelivers. Safe precisely because of the rank filter: the
    // retry either applies the same transition or is refused by it.
    console.error(`[twilio-webhook] delivery receipt not applied (sid=${sid}, status=${status}):`, error.message);
    return new Response('Internal error', { status: 500 });
  }

  if (!data || data.length === 0) {
    // Zero rows means one of two very different things, and an operator reading
    // these logs needs to know which — "we have never heard of this message" is
    // a configuration problem, "this arrived out of order" is the guard working
    // exactly as intended. One extra read on a path that is already rare.
    const { data: existing } = await admin
      .from('sms_messages')
      .select('status, direction')
      .eq('twilio_sid', sid)
      .maybeSingle();
    if (!existing) {
      console.warn(`[twilio-webhook] delivery receipt for unknown ${sid} (status=${status}) — no row to update`);
    } else {
      console.log(
        `[twilio-webhook] ignored out-of-order receipt for ${sid}: ${status} does not outrank stored ${existing.status}`,
      );
    }
    return twiml('');
  }

  console.log(`[twilio-webhook] ${sid} -> ${status}${errorCode ? ` (Twilio ${errorCode})` : ''}`);
  return twiml('');
}

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
 * Tell ai-sdr the seller replied. Fire-and-forget, and deliberately so.
 *
 * Twilio retries any non-2xx and treats a slow response as a failure, so the
 * SDR turn — a model call plus a database round trip, seconds at best — must be
 * unable to delay or fail this request. Two things make that true:
 *
 *   1. Nothing is awaited. The promise is handed to EdgeRuntime.waitUntil(),
 *      which keeps the isolate alive after the response is returned instead of
 *      tearing the work down mid-flight. Without it a detached promise is a
 *      coin flip: the response returns, the isolate is reclaimed, and the SDR
 *      never runs — silently, and only in production, where the seller is.
 *   2. Every failure is swallowed into a log line. A rejected fetch here would
 *      surface as an unhandled rejection; a thrown error would land on the
 *      catch in the handler and answer 500, which is a retry storm caused by
 *      the model being slow. The seller's message is already stored and the
 *      opt-out state is already written, so there is nothing left in this
 *      request worth retrying for.
 *
 * The abort is about this isolate, not about the SDR: ai-sdr is a separate
 * invocation and keeps working on its own turn regardless. Ninety seconds is
 * past the point where waiting tells us anything.
 *
 * Service key, because ai-sdr runs with verify_jwt off and authenticates the
 * caller itself — the service key is what marks this as an internal caller
 * allowed to act on a lead it did not have to prove it can see.
 */
function notifySdr(opts: { leadId: string; body: string; messageSid: string }): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.error('[twilio-webhook] cannot reach ai-sdr: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
    return;
  }

  const task = fetch(`${url}/functions/v1/ai-sdr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      action: 'continue_conversation',
      lead_id: opts.leadId,
      // Raw, as the seller typed it. ai-sdr sanitises it and wraps it in
      // <seller_message> before the model sees it; cleaning it here would mean
      // two sanitisers with two opinions, and the transcript it stores would no
      // longer match sms_messages.
      inbound_message: opts.body,
      // No team_id: continue_conversation resolves the team from the lead, and
      // a team_id in the payload would read as if it were part of the check.
    }),
    signal: AbortSignal.timeout(90_000),
  })
    .then(async (res) => {
      // Logged, not acted on. Every interesting outcome — the SDR is off, the
      // lead has no conversation, a human claimed it — comes back as 200 with a
      // reason, and all of them mean the same thing here: nothing more to do.
      const detail = await res.text().catch(() => '');
      if (!res.ok) {
        console.error(`[twilio-webhook] ai-sdr refused (sid=${opts.messageSid}, ${res.status}): ${detail.slice(0, 300)}`);
      } else {
        console.log(`[twilio-webhook] ai-sdr notified (sid=${opts.messageSid}): ${detail.slice(0, 200)}`);
      }
    })
    .catch((err: unknown) => {
      console.error(`[twilio-webhook] ai-sdr not reached (sid=${opts.messageSid}):`, (err as Error)?.message || err);
    });

  // Feature-detected rather than assumed: outside the Supabase edge runtime —
  // a local `deno run`, a test harness — the global is absent, and the promise
  // above is already running either way.
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') runtime.waitUntil(task);
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

/**
 * Open a lead for a number nobody here has heard from before.
 *
 * The row itself — and the reasoning behind treating an inbound text as a real
 * consent basis — is in inbound-lead.ts, which is pure and tested. This
 * function is only the write, plus the one rule that belongs to the webhook
 * rather than to the record.
 *
 * HOW THIS IS KEPT FROM EVER FAILING THE WEBHOOK. Twilio retries any non-2xx,
 * so a throw out of here would turn a bad insert into a retry storm — and since
 * each retry re-runs the whole handler, an insert that fails systematically (a
 * constraint tightened, a column renamed) would multiply every inbound message
 * by Twilio's full retry schedule and still never succeed. That is strictly
 * worse than the bug this function exists to fix, because a failure degrades
 * back to exactly the old behaviour: the message is stored, unattached, and a
 * human can attach it. So there are two layers, because they catch different
 * things:
 *
 *   - supabase-js reports failures in `error` rather than throwing, so the
 *     insert and the activity write are checked and logged, never rethrown.
 *   - the whole body sits in a try/catch anyway, for the failures that are not
 *     the query: the client throwing on a transport error, a serialisation
 *     problem, anything the shape of the SDK makes possible.
 *
 * Either way the caller gets null, which is the unmatched case the rest of the
 * handler has always handled. Nothing above or below this call reads a thrown
 * error from it, and nothing here returns a Response.
 *
 * Not idempotent, and it does not need to be: it runs behind matchLead(), which
 * finds a lead by its phone, and it runs ahead of the twilio_sid claim, so a
 * Twilio retry of the same message finds the lead the first attempt created, so
 * opensALead() is false and the retry walks past. The window where a retry could
 * double a lead is the gap between this insert and the claim below it —
 * milliseconds, and the cost if it ever lands is two lead rows on one thread,
 * which an operator merges. The alternative, claiming first, would mean a
 * failure anywhere after the claim leaves a seller's message permanently
 * unattached, because the retry that would have fixed it is swallowed.
 */
async function createLeadFromInboundSms(
  admin: SupabaseAdmin,
  opts: {
    teamId: string;
    from: string;
    to: string;
    body: string;
    messageSid: string;
    mediaUrls: string[];
  },
): Promise<string | null> {
  // Twilio's inbound webhook carries no send timestamp — only the outbound
  // status callbacks do — so the moment it reached us is the honest answer to
  // "when did they agree", and it is the same value the consent record, the
  // follow-up and the activity row all use.
  const receivedAt = new Date().toISOString();

  try {
    const { data, error } = await admin
      .from('leads')
      .insert(buildInboundLead({ ...opts, receivedAt }))
      .select('id')
      .single();

    if (error) {
      console.error(
        `[twilio-webhook] could not open a lead for ${opts.from} (sid=${opts.messageSid}): ${error.message}` +
          ' — message will be stored unattached',
      );
      return null;
    }

    // The insert trigger already writes a 'lead_created' row saying the source
    // was inbound_sms. This one is the consent event, in the same shape and
    // with the same type record_lead_consent() uses, so the timeline reads the
    // same whether consent arrived through an operator or through the seller's
    // own phone. actor_kind 'system' because no person decided it — the seller
    // did, by texting.
    await logActivity(admin, {
      team_id: opts.teamId,
      lead_id: data.id,
      actor_kind: 'system',
      type: 'consent_recorded',
      summary: inboundConsentSummary(),
      payload: {
        source: 'inbound_sms',
        twilio_sid: opts.messageSid || null,
        from: opts.from,
        to: opts.to,
        received_at: receivedAt,
      },
    });

    console.log(
      `[twilio-webhook] opened lead ${data.id} for ${opts.from} — texted in first (sid=${opts.messageSid})`,
    );
    return data.id;
  } catch (err) {
    console.error(
      `[twilio-webhook] lead creation threw for ${opts.from} (sid=${opts.messageSid}):`,
      (err as Error)?.message || err,
    );
    return null;
  }
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
