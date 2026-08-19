// supabase/functions/_shared/phone-validation.ts
// ============================================================================
// Phone normalisation for every Twilio-facing function.
// ============================================================================
// Ported from reoperative's _shared/phone-validation.ts, keeping only the pure
// functions. What was dropped, and why:
//
//   - checkPhoneEligibility()'s DNC and opt-out reads. Suppression lives in the
//     database here — public.is_opted_out() and public.lead_is_dialable() — so
//     there is exactly one answer to "may we contact this number" and it is the
//     same one whether the caller is the dialer, the SMS send path or the SDR.
//     A second copy in TypeScript is a second thing to forget to update.
//   - the Twilio Lookup v2 line-type cache and its per-lookup usage metering.
//     The metering is the resale billing machinery BUILD_PLAN §6 cuts. The
//     lookup itself belongs to the send path, not to an inbound webhook; port
//     it there when it is needed and can be tested.
// ============================================================================

/**
 * Best-effort E.164. Twilio always posts E.164 already; this exists for the
 * numbers humans typed into the app or into the website form.
 *
 * Returns '' rather than a half-formed number when there is nothing to work
 * with, so callers can test truthiness instead of parsing failure modes.
 */
export function normalizeE164(raw: string | null | undefined): string {
  const cleaned = (raw || '').replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  return cleaned.length > 0 ? '+' + cleaned : '';
}

/** Shape check only — says nothing about whether the number is reachable. */
export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/**
 * The join key between Twilio and our rows: the last 10 digits.
 *
 * This MUST stay byte-identical to public.phone_key(text) in
 * 20260817120100_leads.sql — `NULLIF(right(regexp_replace(v,'\D','','g'),10),'')`
 * — because it is the same key on both sides of the boundary. Twilio posts
 * +19125550134, the seller typed "(912) 555-0134", and the two only collide
 * here. If the two implementations ever disagree, inbound texts stop matching
 * their own leads and nothing errors: the message just arrives unattached.
 *
 * Fewer than 10 digits passes through as-is, exactly as SQL right() does.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw || '').replace(/\D/g, '');
  const key = digits.slice(-10);
  return key || null;
}
