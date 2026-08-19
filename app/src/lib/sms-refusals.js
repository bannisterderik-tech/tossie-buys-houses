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
