/**
 * The refusal vocabulary shared with twilio-send-sms.
 *
 * The function answers a refusal with a non-2xx and `{ ok:false, sent:false,
 * reason, message }`. The keys below are `reason`, spelled exactly as the
 * function spells it — these strings are a contract with
 * supabase/functions/twilio-send-sms and a typo is invisible, because an unknown
 * reason silently falls through to the server's own sentence. Grep both files
 * together before renaming one.
 *
 * It lives in lib/ rather than beside one page because there are now two
 * composers — the inbox and the lead detail panel — and two copies of a
 * compliance vocabulary is one copy that drifts. The one that drifts is the one
 * that tells an operator "failed" about a message a seller never received.
 *
 * The map exists because "failed" leaves Tossie unable to tell a carrier hiccup
 * (resend it) from a STOP (never send to this number again), and those two have
 * very different price tags. Every entry answers the only two questions worth
 * answering: did it go out, and what do I do now.
 */
export const REFUSALS = {
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
    'Nothing was sent: lead_is_dialable() says no. A cold-list lead has to be skip traced and DNC scrubbed before it can be contacted; a lead with no consent basis needs consent recorded on it first. Fix the lead, not the message.',
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
  no_team:
    'Nothing was sent: your account is not on a team yet.',
  bad_request:
    'Nothing was sent: the send function rejected the request itself. The sentence above is its own.',
};

/** Twilio's hard ceiling on a single message body. */
export const MAX_BODY = 1600;

/* ── what became of a message we sent ─────────────────────────────────────────

   The refusals above answer "the send was refused". These answer the question
   after it: the send was accepted, Twilio took the message — and then what.

   Until twilio-webhook grew a MessageStatus branch there was no answer at all.
   Every outbound row sat at 'queued' forever, which the two composers rendered
   verbatim, so a delivered text and one the carrier silently dropped looked
   identical on screen. For a wholesaler that is the difference between
   following up on a seller and writing them off.

   Same contract rule as REFUSALS: these keys are sms_messages.status values,
   spelled the way the CHECK constraint in 20260818120000_telephony.sql spells
   them. An unknown status falls through to the raw string rather than
   disappearing. */

/**
 * One entry per status the schema allows on an outbound row.
 *
 * `tone` is what the CSS keys off, and there are only three of them on purpose.
 * 'wait' is not styled as a problem — it is the normal first second of every
 * message's life, and colouring it would train the operator to ignore the
 * colour that matters.
 */
export const DELIVERY = {
  queued: {
    label: 'Queued',
    tone: 'wait',
    // No headline: this is not a failure, and a bubble that explains itself
    // while nothing is wrong is a bubble nobody reads when something is.
    headline: null,
  },
  sent: {
    label: 'Sent',
    tone: 'wait',
    // Deliberately not reassuring. 'sent' means the carrier accepted it, not
    // that a handset ever showed it — the receipt that says so is 'delivered',
    // and conflating the two is how a dropped text gets treated as read.
    headline: null,
  },
  delivered: {
    label: 'Delivered',
    tone: 'ok',
    headline: null,
  },
  undelivered: {
    label: 'Undelivered',
    tone: 'dead',
    headline: 'Undelivered — it left us and the carrier never handed it over. The seller does not have this message.',
  },
  failed: {
    label: 'Failed',
    tone: 'dead',
    headline: 'Failed — it never left. The seller does not have this message.',
  },
};

/**
 * Twilio's error codes, in words an operator can act on.
 *
 * `setup` is the field that matters. 30003/30005/30006 are facts about the
 * seller's handset: this person cannot be reached by text, so call them and
 * move on. 30007 and 30034 are facts about US — our messaging registration or
 * our sending reputation — and they do not stop at one seller. Every text on
 * that number is failing the same way, so an operator who reads them as "this
 * lead is unreachable" will work down a whole list drawing that conclusion one
 * seller at a time. Saying which kind of problem it is, on the bubble, is the
 * only thing that stops that.
 *
 * Keys are strings because sms_messages.error_code is text — twilio-send-sms
 * writes non-numeric codes into it too ('network', 'twilio_not_configured').
 */
export const TWILIO_ERRORS = {
  30003: {
    setup: false,
    text: 'The handset was unreachable — switched off, out of coverage, or the number is no longer in service. Worth one retry later; if it repeats, call instead.',
  },
  30005: {
    setup: false,
    text: 'The carrier does not recognise this number. It is disconnected or was never a mobile. Retrying will not change that — call the seller or find a better number.',
  },
  30006: {
    setup: false,
    text: 'It is a landline, or a carrier that cannot take texts at all. This seller will never receive an SMS at this number. Call them.',
  },
  30007: {
    setup: true,
    text: 'The carrier filtered it as spam. This is our messaging setup, not this seller — the same block is hitting every text from this number. Stop the queue and fix the registration or the content before sending more.',
  },
  30034: {
    setup: true,
    text: 'The sending number is not registered to an A2P 10DLC campaign. Nothing sent from it will be delivered until registration clears. This is our setup, not this seller.',
  },
  network: {
    setup: true,
    text: 'Twilio never answered the send. Whether the text went out is genuinely unknown — read the thread before retyping it.',
  },
  twilio_not_configured: {
    setup: true,
    text: 'Twilio credentials are not set on the send function. Nothing was sent, and nothing will send until that deploy step is done.',
  },
  21610: {
    setup: false,
    text: 'Twilio has this number on its own opt-out list: they replied STOP at some point. It is now on ours too, and only a START from them clears it.',
  },
};

/**
 * The delivery state of one message row, ready to render.
 *
 * Returns null for inbound — an inbound message has no delivery state worth
 * showing; it is here, which is the whole story.
 *
 * `failed` is the flag the composers style on, and it is deliberately true for
 * BOTH failed and undelivered. Those are two different mechanisms and the
 * headline says which, but they mean the identical thing to whoever is working
 * the lead: the seller did not get it.
 */
export function deliveryState(m) {
  if (!m || m.direction === 'inbound') return null;

  const status = m.status || 'queued';
  const known = DELIVERY[status] || null;
  const code = m.error_code ? String(m.error_code) : null;
  const err = code ? TWILIO_ERRORS[code] || null : null;

  return {
    status,
    // An unmapped status still shows, in the database's own word. A status
    // added server-side is visible here the day it ships.
    label: known?.label || status,
    tone: known?.tone || 'wait',
    failed: status === 'failed' || status === 'undelivered',
    headline: known?.headline || null,
    code,
    // The plain-English translation, when there is one. An untranslated code is
    // never swallowed — the bare number goes on screen, because a code an
    // operator can search for beats no code at all.
    codeText: err?.text || null,
    // True only for the codes that mean "your messaging setup is wrong" rather
    // than "this seller is unreachable".
    setupProblem: !!err?.setup,
  };
}

/**
 * One refusal payload, one on-screen sentence.
 *
 * The server's own `message` is kept alongside the mapped text rather than
 * replaced by it, because the specifics live there — which number, which hour,
 * which Twilio code — and those are what turn "outside the window" into "it is
 * 6:00 in America/Los_Angeles".
 */
export function refusalFrom(payload, fallback) {
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
export async function explainRefusal(error) {
  let payload = null;
  try { payload = await error?.context?.json?.(); } catch { /* not JSON; fall through */ }

  return refusalFrom(
    payload,
    error?.message
      || 'The send failed and the server gave no reason, so whether the text went out is unknown. Check the thread before retyping it.',
  );
}
