/**
 * The TCPA consent disclosure — single source of truth.
 *
 * Two things need this string and they must never drift: the form on the
 * marketing site renders it, and api/lead.js stores a copy on the lead as
 * proof of what the seller actually agreed to. If a plaintiff's attorney ever
 * asks what the disclosure said on the day the lead came in, the answer has to
 * come out of the database, not out of a guess about which copy was live.
 *
 * WHEN YOU CHANGE THE WORDING, BUMP THE VERSION. Old leads keep their old
 * version and their own stored text; only new leads get the new one.
 */

export const CONSENT_VERSION = 'v1-2026-08';

/** Plain text, stored verbatim on the lead. */
export const consentText = (businessName) =>
  `By submitting, you agree to our Terms and Privacy Policy and consent to receive ` +
  `calls, texts, and emails from ${businessName} about your property. Message ` +
  `frequency varies. Reply STOP to opt out. Consent is not a condition of any purchase.`;

/** The same sentence with the two policy links, for the rendered form. */
export const consentHtml = (businessName) =>
  `By submitting, you agree to our <a href="/terms/">Terms</a> and ` +
  `<a href="/privacy/">Privacy Policy</a> and consent to receive calls, texts, and ` +
  `emails from ${businessName} about your property. Message frequency varies. ` +
  `Reply STOP to opt out. Consent is not a condition of any purchase.`;
