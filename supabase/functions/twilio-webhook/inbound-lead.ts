// supabase/functions/twilio-webhook/inbound-lead.ts
// ============================================================================
// The leads row a stranger's first text becomes.
// ============================================================================
// Split out of index.ts for one reason: what this builds is a consent record,
// and a consent record is the part of the webhook that has to survive being
// read out loud rather than merely work in production. Kept pure — it takes
// what Twilio sent plus a timestamp and returns a row, touching no client and
// no clock of its own — so inbound-lead_test.ts can assert its shape without a
// database, a network or a Twilio signature.
//
// THE CONSENT BASIS, stated plainly, because it is the whole point.
//
// Someone who texts the business number FIRST has initiated the conversation.
// Replying to them sits squarely inside consent: they chose the channel, they
// chose the moment, and the evidence is a message in their own words stored in
// sms_messages — a table with no DELETE grant for anyone. As evidence that is
// stronger than most tcpa_opt_in rows in this system, which rest on a checkbox
// nobody can reproduce a screenshot of.
//
// So tcpa_opt_in is true here, and the provenance records exactly what did and
// did not happen: no disclosure was presented, because until they texted there
// was nobody to present one to. What must never happen is dressing this up as
// something it was not — a disclosure_source naming a website form on a lead
// that never saw a form is a fabricated record, and a fabricated record is
// worse than a missing one, because the fabrication is the part that gets
// quoted back at you.
//
// BUILD_PLAN §12 names this case directly: "Texting is for people who texted
// first, opted in, or are buyers." This is the first of those three, and until
// now it was the one with no way into the system.
// ============================================================================

/**
 * The disclosure version every consent record in this system is stamped with.
 * Matches record_lead_consent() and convert_prospect_to_lead() — one version
 * string across every door consent can come in by, so "which disclosure regime
 * was this lead captured under" is one question with one answer.
 */
export const CONSENT_VERSION = 'v1-2026-08';

/** What the webhook knows about the message at the moment it decides. */
export type InboundLeadInput = {
  teamId: string;
  /** The seller's number, already normalised to E.164 by the caller. */
  from: string;
  /** Which of our numbers they texted — the marketing channel, in effect. */
  to: string;
  /** Exactly as they typed it. May be empty: a photo-only MMS has no text. */
  body: string;
  messageSid: string;
  /** ISO-8601. Twilio's inbound webhook carries no send time, so this is ours. */
  receivedAt: string;
  mediaUrls: string[];
};

/**
 * Long bodies are clipped for the disclosure line and nowhere else.
 *
 * tcpa_disclosure_text is read by a human in the lead panel, so it wants to
 * stay a sentence. The untruncated message lives in two places that are not
 * clipped: sms_messages.body, which is the canonical evidence, and
 * raw_payload.inbound_sms.body on the lead itself, so the lead is still
 * self-contained if the thread is ever read separately from it.
 */
const EVIDENCE_CLIP = 300;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Turn one inbound text into the lead it represents.
 *
 * Every field below is either a fact Twilio gave us or a decision with a reason
 * written next to it. Nothing is inferred about the seller that they did not
 * say — no name, no address, no motivation — because a CRM row full of guesses
 * is how an operator ends up calling someone by the wrong name.
 */
export function buildInboundLead(o: InboundLeadInput): Record<string, unknown> {
  const text = o.body.trim();

  // What we can honestly say we hold. A photo of a roof with no caption is
  // still someone reaching out, and saying so beats an empty pair of quotes
  // that reads like the message was lost.
  const evidence = text
    ? `"${clip(text, EVIDENCE_CLIP)}"`
    : `no text, ${o.mediaUrls.length} attachment${o.mediaUrls.length === 1 ? '' : 's'}`;

  return {
    team_id: o.teamId,

    // No name. We do not have one, and deriving a placeholder from the phone
    // number would put a string that looks like a name into the field an
    // operator greets people by. The list renders a dash; the dash is true.
    phone: o.from,

    source: 'inbound_sms',
    // Which number they texted is which piece of marketing worked — the yard
    // sign line and the postcard line are different numbers. Recording it here
    // is the difference between "an inbound text" and "the sign on Bull St".
    source_detail: `Texted ${o.to}`,

    // 'new', deliberately, and NOT the 'contacted' that convert_prospect_to_lead
    // uses. There, a human had just finished a conversation. Here nobody on our
    // side has done anything at all yet — that is the entire complaint this
    // change answers — so the lead belongs in the untouched pile where somebody
    // will pick it up.
    status: 'new',
    // first_contact_at, not last_contacted_at: contact happened, but it was not
    // us doing the contacting, and last_contacted_at drives "have we gone quiet
    // on them" logic that must not be satisfied by the seller's own message.
    first_contact_at: o.receivedAt,
    // Due immediately. Without this the lead exists and still nobody works it:
    // due_leads is keyed on next_follow_up_at, so a lead with none never
    // reaches the Today page. A stranger holding their phone right now is the
    // most time-sensitive thing this system receives.
    next_follow_up_at: o.receivedAt,

    // ── consent ──────────────────────────────────────────────────────────
    tcpa_opt_in: true,
    // Not optional: leads_opt_in_needs_provenance (20260821120000) rejects the
    // boolean without a timestamp, because "when did they agree" is the first
    // question anyone asks. This is the moment their message reached us.
    tcpa_opt_in_at: o.receivedAt,
    // Names the inbound text, its direction, both numbers and the Twilio SID —
    // the SID being the handle that pulls the original message out of Twilio's
    // own records years from now, which is the one copy we do not control.
    tcpa_disclosure_source: `Inbound text from ${o.from} to ${o.to} on ${o.receivedAt}` +
      (o.messageSid ? ` (Twilio ${o.messageSid})` : ''),
    tcpa_disclosure_version: CONSENT_VERSION,
    tcpa_disclosure_text:
      'Seller initiated contact by text message. No disclosure was presented — ' +
      'there was no prior contact to present one in. The consent basis is their ' +
      `own inbound message, received ${o.receivedAt}: ${evidence}`,
    consent_sms: true,
    // consent_email stays false. They texted; they said nothing whatsoever
    // about email, and we do not even have an address for them. Carrying SMS
    // consent across to a channel they never mentioned is exactly the small
    // over-claim that makes the whole record look invented.

    // ── the evidence, in full ────────────────────────────────────────────
    raw_payload: {
      inbound_sms: {
        twilio_sid: o.messageSid || null,
        from: o.from,
        to: o.to,
        received_at: o.receivedAt,
        // Untruncated and unedited. The clipped copy above is for reading; this
        // is for proving.
        body: o.body,
        num_media: o.mediaUrls.length,
        media_urls: o.mediaUrls,
      },
    },
  };
}

/**
 * Whether the number a message came FROM is one a lead may be opened for.
 *
 * The keyword guard in keywords.ts answers "is this message a person talking".
 * This answers the other half — "is this sender a person at all" — and both
 * senders it refuses would otherwise get a consent record asserting that one
 * was.
 *
 * ONE OF OUR OWN LINES. index.ts recognises a delivery receipt by two signals
 * and argues, correctly, that the conjunction can only fail in the harmless
 * direction: a status callback that ever started carrying a Body would fall
 * through to the inbound path and collide on the SID of the message it is a
 * receipt for. That argument was written when the worst case downstream was a
 * mis-filed row, and lead creation changed it — the From on that payload is our
 * own line, so it would open a lead on our own Twilio number stamped with a
 * consent basis quoting our own outreach copy back as the seller's words. It
 * does not take a change at Twilio to reach, either: one lead whose phone was
 * typed as another of our numbers is enough, and then every message we send it
 * arrives here as an inbound text. With the SDR now answering strangers that is
 * two of our numbers talking to each other, one paid model call per turn, with
 * nothing in the loop that ends it.
 *
 * A SENDER WE COULD NEVER MATCH AGAIN. phone_key is the last ten digits and
 * matchLead() refuses to guess from fewer, so a short code — or anything else
 * whose number is shorter — never matches the lead its own first message
 * created. Left open, message two opens a second lead, message three a third,
 * without bound. Nothing that texts from five digits is selling a house.
 */
export function senderCanOpenALead(fromKey: string | null, fromIsOneOfOurs: boolean): boolean {
  return !fromIsOneOfOurs && fromKey !== null && fromKey.length === 10;
}

/**
 * The one-line summary of the consent activity row, kept next to the record it
 * describes so the two cannot drift into telling different stories.
 */
export function inboundConsentSummary(): string {
  return 'Consent recorded: the seller texted us first';
}
