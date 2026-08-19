// supabase/functions/twilio-webhook/inbound-lead_test.ts
// ============================================================================
//   deno test supabase/functions/
// ============================================================================
// The consent record is the part of this feature that has to be right when
// somebody hostile reads it. These assertions are written from that angle: not
// "does the row have the fields" but "does the row claim anything that did not
// happen, and does it drop anything that did".
//
// Numbers are from the reserved 555 fictional block on Savannah's 912, the same
// convention the SQL suites use. Nothing here is a real number or a real SID.
// ============================================================================

import { deepEqual, equal, match, notEqual, ok } from './test-assert.ts';
import {
  buildInboundLead,
  CONSENT_VERSION,
  type InboundLeadInput,
  senderCanOpenALead,
} from './inbound-lead.ts';

const TEAM = '70551e00-0000-4000-8000-000000000001';
const SELLER = '+19125557201';
const OURS = '+19125557299';
const AT = '2026-08-19T15:04:05.000Z';
// Twilio's shape — SM plus 32 hex — with obviously fictional digits.
const SID = 'SM00000000000000000000000000000001';

function input(over: Partial<InboundLeadInput> = {}): InboundLeadInput {
  return {
    teamId: TEAM,
    from: SELLER,
    to: OURS,
    body: 'Saw your sign on Bull St. What would you pay for my mothers house',
    messageSid: SID,
    receivedAt: AT,
    mediaUrls: [],
    ...over,
  };
}

// ── the consent record ──────────────────────────────────────────────────────

Deno.test('the opt-in is asserted with its timestamp, never without', () => {
  const row = buildInboundLead(input());
  equal(row.tcpa_opt_in, true);
  // leads_opt_in_needs_provenance (20260821120000) rejects the boolean without
  // this column, so dropping it does not produce a weaker lead — it produces an
  // insert that fails and a seller who is never called back.
  equal(row.tcpa_opt_in_at, AT);
});

Deno.test('the timestamp is the one the caller passed, not a fresh clock reading', () => {
  // The builder is pure on purpose. If it reached for now() itself, the consent
  // timestamp, the follow-up and the activity row would each be a few
  // milliseconds apart, and "when did they agree" would have three answers.
  const row = buildInboundLead(input({ receivedAt: '2026-01-02T03:04:05.000Z' }));
  equal(row.tcpa_opt_in_at, '2026-01-02T03:04:05.000Z');
  equal(row.first_contact_at, '2026-01-02T03:04:05.000Z');
  equal(row.next_follow_up_at, '2026-01-02T03:04:05.000Z');
});

Deno.test('the disclosure source names the inbound text, both numbers and the SID', () => {
  const src = String(buildInboundLead(input()).tcpa_disclosure_source);
  match(src, /inbound text/i);
  ok(src.includes(SELLER), 'the seller number is who consented');
  ok(src.includes(OURS), 'which of our numbers they texted');
  ok(src.includes(AT), 'when');
  // The SID is the handle that pulls the original message out of Twilio's own
  // records — the one copy of the evidence we do not control.
  ok(src.includes(SID), 'the Twilio SID');
});

Deno.test('a missing SID degrades to a shorter sentence, not to the word null', () => {
  const src = String(buildInboundLead(input({ messageSid: '' })).tcpa_disclosure_source);
  ok(!/null|undefined|Twilio \)/.test(src), `reads badly: ${src}`);
  ok(src.includes(SELLER) && src.includes(AT), 'who and when survive a missing SID');
});

Deno.test('the disclosure says plainly that no disclosure was shown', () => {
  const text = String(buildInboundLead(input()).tcpa_disclosure_text);
  match(text, /no disclosure was presented/i);
});

Deno.test('the disclosure never dresses an inbound text up as a web form', () => {
  // The failure this whole module exists to prevent. A disclosure_source of
  // 'website' on a lead that never saw a form is a fabricated record, and the
  // fabrication is the part that gets quoted back at you.
  const row = buildInboundLead(input());
  const claim = `${row.tcpa_disclosure_source} ${row.tcpa_disclosure_text}`;
  for (const lie of [/website/i, /web form/i, /landing page/i, /checkbox/i, /checked the box/i]) {
    ok(!lie.test(claim), `claims something that did not happen: ${lie}`);
  }
  equal(row.source, 'inbound_sms');
  notEqual(row.source, 'website');
});

Deno.test('SMS consent does not silently become email consent', () => {
  const row = buildInboundLead(input());
  equal(row.consent_sms, true);
  // They texted. They said nothing about email and we do not even have an
  // address for them. record_lead_consent() sets both because an operator
  // asked; nobody asked here.
  ok(!('consent_email' in row) || row.consent_email === false, 'email consent must not be inferred from a text');
});

Deno.test('the disclosure version matches every other consent door in the system', () => {
  // record_lead_consent() and convert_prospect_to_lead() both stamp this.
  // One string across every door, so "which regime was this captured under" is
  // one question with one answer.
  equal(CONSENT_VERSION, 'v1-2026-08');
  equal(buildInboundLead(input()).tcpa_disclosure_version, 'v1-2026-08');
});

// ── the evidence ────────────────────────────────────────────────────────────

Deno.test('the message body is quoted as the evidence of contact', () => {
  const body = 'Saw your sign on Bull St. What would you pay for my mothers house';
  const row = buildInboundLead(input({ body }));
  ok(String(row.tcpa_disclosure_text).includes(body), 'their words, in the record');
});

Deno.test('a long message is clipped for reading and kept whole for proving', () => {
  const body = 'a'.repeat(1200);
  const row = buildInboundLead(input({ body }));
  const text = String(row.tcpa_disclosure_text);
  ok(text.length < 900, 'the human-readable line stays a sentence');
  match(text, /…/, 'and says it was clipped');
  // deno-lint-ignore no-explicit-any
  equal((row.raw_payload as any).inbound_sms.body, body, 'the evidence is not clipped');
});

Deno.test('the raw payload carries the whole message unedited, media included', () => {
  const media = ['https://api.twilio.com/2010-04-01/Media/ME0001', 'https://api.twilio.com/2010-04-01/Media/ME0002'];
  // deno-lint-ignore no-explicit-any
  const p = (buildInboundLead(input({ mediaUrls: media })).raw_payload as any).inbound_sms;
  equal(p.twilio_sid, SID);
  equal(p.from, SELLER);
  equal(p.to, OURS);
  equal(p.received_at, AT);
  equal(p.num_media, 2);
  deepEqual(p.media_urls, media);
});

Deno.test('a photo-only MMS still produces an honest record', () => {
  // Someone sending a picture of their roof with no caption is reaching out.
  // The record must say the message carried no text rather than showing an
  // empty pair of quotes that reads like the body was lost.
  const row = buildInboundLead(input({ body: '', mediaUrls: ['https://api.twilio.com/2010-04-01/Media/ME0003'] }));
  const text = String(row.tcpa_disclosure_text);
  match(text, /no text/i);
  match(text, /1 attachment\b/);
  ok(!text.includes('""'), 'no empty quotes standing in for a message');
  equal(row.tcpa_opt_in, true);
  equal(row.tcpa_opt_in_at, AT);
});

// ── the rest of the row ─────────────────────────────────────────────────────

Deno.test('the lead is reachable and nothing about the seller is invented', () => {
  const row = buildInboundLead(input());
  // leads_has_contact needs one of phone / phone_mobile / email. The sender's
  // number is the only contact fact we hold.
  equal(row.phone, SELLER);
  // No name, no address, no motivation. A placeholder name derived from the
  // phone number would end up in the field an operator greets people by.
  ok(!('name' in row), 'no invented name');
  ok(!('address' in row), 'no invented address');
  ok(!('phone_mobile' in row), 'line type is unknown until a skip trace says otherwise');
});

Deno.test('the lead lands in the untouched pile and comes due immediately', () => {
  const row = buildInboundLead(input());
  // 'new', not the 'contacted' convert_prospect_to_lead uses: there, a human
  // had just finished a conversation. Here nobody on our side has done
  // anything, which is the entire complaint this change answers.
  equal(row.status, 'new');
  // due_leads is keyed on next_follow_up_at, so without this the lead exists
  // and still nobody works it.
  equal(row.next_follow_up_at, AT);
  // last_contacted_at drives "have we gone quiet on them" logic and must not be
  // satisfied by the seller's own message.
  ok(!('last_contacted_at' in row), 'we have not contacted them; they contacted us');
});

Deno.test('the source records which number was texted, because that is which advert worked', () => {
  const row = buildInboundLead(input());
  equal(row.source, 'inbound_sms');
  ok(String(row.source_detail).includes(OURS), 'which number they texted is which advert worked');
});

Deno.test('the row is team-scoped from the number that was texted', () => {
  equal(buildInboundLead(input()).team_id, TEAM);
});

// ── who is allowed to open one ───────────────────────────────────────────────

Deno.test('a homeowner texting in from a ten-digit number opens a lead', () => {
  equal(senderCanOpenALead('9125557201', false), true);
});

Deno.test('one of our own numbers never opens a lead', () => {
  // The delivery-receipt fall-through and the mistyped lead phone both arrive
  // as a message From our own line. Opening a lead on it would write a consent
  // record quoting our own outreach copy back as the seller's words, and hand
  // the SDR a conversation with itself.
  equal(senderCanOpenALead('9125557299', true), false);
});

Deno.test('a sender we could never match again opens nothing', () => {
  // matchLead() refuses to guess from fewer than ten digits, so a short code
  // never matches the lead its own first message created — message two would
  // open a second, message three a third, without bound.
  for (const key of ['22395', '', null]) {
    equal(senderCanOpenALead(key, false), false, `${JSON.stringify(key)} must not open a lead`);
  }
});

Deno.test('nothing in the row asserts a scrub that never ran', () => {
  // A prospect earns is_dnc / dnc_scrubbed from a paid scrub. This lead has had
  // none, and writing those columns here would tell the dialer a scrub happened.
  const row = buildInboundLead(input());
  for (const col of ['skip_traced', 'dnc_scrubbed', 'is_dnc', 'is_litigator', 'phone_invalid']) {
    ok(!(col in row), `${col} must be left to its default, not asserted here`);
  }
});
