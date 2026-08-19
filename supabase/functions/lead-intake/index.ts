// supabase/functions/lead-intake/index.ts
// ============================================================================
// Inbound leads from third-party sources — portals, PPC vendors, partner sites.
// ============================================================================
// Give a vendor one URL and one secret:
//
//   POST {SUPABASE_URL}/functions/v1/lead-intake/{slug}
//   x-lead-secret: <the secret they were given>
//   Content-Type: application/json
//
// DEPLOYMENT: this function MUST be deployed with JWT verification off
// (`supabase functions deploy lead-intake --no-verify-jwt`), for the same
// reason twilio-webhook is: a lead vendor cannot present a Supabase JWT, and
// with the default on every post is rejected at the gateway before a line of
// this file runs — silently, because the error appears in the vendor's logs and
// not in ours.
//
// WHICH MEANS THIS FUNCTION OWNS ITS OWN AUTHENTICATION, and the shape of it is
// the whole point of the file. A per-source shared secret, verified against a
// bcrypt hash in public.lead_sources by authorize_lead_intake(). What must not
// happen here is the obvious shortcut — an endpoint with verify_jwt off, no
// secret, and an INSERT into `leads` at the end of it. That is a spam funnel
// with write access to the CRM, and the damage is not "some junk rows": an
// operator who cannot trust the lead list stops working the lead list.
//
// FOUR RULES THIS FILE IS BUILT AROUND:
//
// 1. THE DATABASE DECIDES CONSENT, NOT THIS FILE. Everything below does is
//    *report* what the vendor claimed. ingest_lead_from_source() decides whether
//    that claim becomes tcpa_opt_in, and it only does so when the source is
//    marked as genuinely collecting consent AND the payload carries the
//    disclosure and the timestamp. Putting the rule here instead would mean the
//    next intake path gets to re-decide it.
//
// 2. THE SECRET NEVER GOES IN A URL. Header only. Query strings land in access
//    logs, browser history, and Referer headers on any redirect, and a lead
//    vendor's stack is not ours to audit. A secret in a query string is a
//    secret in somebody else's logs.
//
// 3. NOTHING IS THROWN AWAY. The entire payload as posted goes into
//    leads.raw_payload, whatever shape it arrived in. Vendors change formats
//    without telling anyone, and the first sign is usually a lead that came
//    through with half its fields empty — recoverable only if the original is
//    still there.
//
// 4. AN UNKNOWN SLUG AND A BAD SECRET ANSWER IDENTICALLY. Otherwise this is a
//    slug enumerator: guess names until one stops saying "unknown".
//
// No CORS and no OPTIONS handler, deliberately, exactly as twilio-webhook has
// none: these callers are servers. A browser has no business here, so it gets
// no preflight to work with, and an endpoint that answers OPTIONS from anywhere
// is a bigger target than one that answers POST only.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

// Structural, so this file does not depend on which supabase-js specifier the
// rest of the functions settle on.
// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

// A lead is a few hundred bytes. Anything approaching this is either a vendor
// posting an entire export in one request or somebody testing what we accept;
// both should be refused before the JSON parser sees them.
const MAX_BODY_BYTES = 64 * 1024;

// ── field mapping ───────────────────────────────────────────────────────────
// Every vendor names things differently and none of them will change for us.
// Keys are compared with punctuation and case removed, so "Property Address",
// "property_address" and "propertyAddress" are one entry.
//
// Order within each list is priority order: the first alias present wins. That
// matters for phone — a vendor sending both `phone` and `mobile` means the
// mobile is the extra, not the correction.
const FIELD_ALIASES: Record<string, string[]> = {
  name: ['name', 'fullname', 'contactname', 'sellername', 'leadname', 'customername'],
  phone: ['phone', 'phonenumber', 'primaryphone', 'homephone', 'telephone', 'tel', 'contactphone'],
  phone_mobile: ['phonemobile', 'mobile', 'mobilephone', 'cell', 'cellphone', 'cellular'],
  email: ['email', 'emailaddress', 'primaryemail', 'contactemail'],
  address: ['address', 'propertyaddress', 'streetaddress', 'street', 'address1', 'addressline1', 'siteaddress', 'subjectproperty'],
  city: ['city', 'propertycity', 'town'],
  state: ['state', 'propertystate', 'statecode', 'st', 'province'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode', 'propertyzip'],
  county: ['county', 'propertycounty', 'parish'],
  owner_name: ['ownername', 'owner', 'propertyowner'],
  motivation: ['motivation', 'reasonforselling', 'reason', 'situation', 'sellingreason', 'timeline'],
  notes: ['notes', 'comments', 'message', 'additionalinfo', 'details', 'description'],
  property_type: ['propertytype', 'hometype', 'type'],
};

// The consent evidence, read out of the same flattened payload. Nothing here
// grants anything — see rule 1 at the top of the file.
const CONSENT_ALIASES: Record<string, string[]> = {
  claimed: ['consent', 'tcpaconsent', 'optin', 'optedin', 'smsconsent', 'consentgiven', 'tcpaoptin', 'hasconsent'],
  text: ['consenttext', 'disclosure', 'disclosuretext', 'tcpalanguage', 'consentlanguage', 'tcpatext'],
  at: ['consentat', 'consenttimestamp', 'consentdate', 'optinat', 'optindate', 'tcpatimestamp', 'consenttime'],
  ip: ['consentip', 'ipaddress', 'ip', 'userip', 'leadip', 'originip'],
  version: ['consentversion', 'disclosureversion', 'tcpaversion'],
};

// Envelopes vendors wrap the lead in. lead_sources.format records which one a
// source is supposed to use; this list is what makes the function work anyway
// when a vendor quietly changes it.
const WRAPPER_KEYS = ['data', 'lead', 'payload', 'contact', 'form', 'fields', 'result', 'record', 'submission'];

const normalizeKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Flatten a posted object into one lookup table of normalized key -> value.
 *
 * Two passes of unwrapping, because the real shapes are `{ data: { ... } }` and
 * `{ lead: { contact: {...}, address: {...} } }`. Outer keys win over inner
 * ones: a vendor who sends a top-level `email` and a nested `contact.email`
 * means the top-level one, and taking the deepest match would silently prefer
 * whichever branch the recursion happened to reach last.
 *
 * Arrays and objects that survive to the leaves are kept as JSON text rather
 * than dropped — a value we cannot map is still better read than lost, and the
 * untouched original goes to raw_payload regardless.
 */
function flatten(input: unknown, depth = 0, out: Record<string, string> = {}): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

  const entries = Object.entries(input as Record<string, unknown>);
  const nested: unknown[] = [];

  // Two passes, and the order is the whole reason "outer wins" is true. Doing
  // it in one pass would descend into a nested object the moment it appears,
  // so an inner `email` would claim the key before a sibling outer `email`
  // three entries later ever got looked at — and which one won would depend on
  // the order the vendor happened to serialise their JSON in.
  for (const [rawKey, value] of entries) {
    const key = normalizeKey(rawKey);
    if (!key) continue;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      nested.push(value);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (key in out) continue;

    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.trim() !== '') out[key] = text.trim();
  }

  // Depth 2 covers `{data: {address: {...}}}` and stops well short of anything
  // that could be used to make this loop expensive.
  if (depth < 2) for (const value of nested) flatten(value, depth + 1, out);

  return out;
}

/** First alias present in the flattened payload, or null. */
function pick(flat: Record<string, string>, aliases: string[]): string | null {
  for (const a of aliases) {
    const v = flat[a];
    if (v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * Vendors express yes in about eight ways and no in about six. Anything not
 * recognised is NOT consent — the default has to be the safe one, because this
 * is the value that decides whether somebody gets called.
 */
function truthy(v: string | null): boolean {
  if (!v) return false;
  return ['true', 'yes', 'y', '1', 'on', 'checked', 'granted', 'accepted'].includes(v.trim().toLowerCase());
}

/**
 * Map a posted payload onto lead columns.
 *
 * Split names are handled after the whole-name aliases so a vendor sending both
 * `name` and `first_name` does not get "John Smith Smith".
 */
function mapLead(flat: Record<string, string>): Record<string, string | null> {
  const lead: Record<string, string | null> = {};
  for (const [column, aliases] of Object.entries(FIELD_ALIASES)) {
    lead[column] = pick(flat, aliases);
  }

  if (!lead.name) {
    const first = pick(flat, ['firstname', 'fname', 'givenname']);
    const last = pick(flat, ['lastname', 'lname', 'surname', 'familyname']);
    const joined = [first, last].filter(Boolean).join(' ').trim();
    lead.name = joined || null;
  }

  // Two-letter states only — anything else is a full state name or junk, and
  // storing "Georgia" in a column every filter treats as a code is worse than
  // storing nothing. The full value survives in raw_payload.
  if (lead.state && !/^[A-Za-z]{2}$/.test(lead.state)) lead.state = null;
  else if (lead.state) lead.state = lead.state.toUpperCase();

  // A ZIP+4 or a stray "GA 31401" in the zip field reduces to the five digits.
  if (lead.zip) {
    const m = lead.zip.match(/\d{5}/);
    lead.zip = m ? m[0] : null;
  }

  return lead;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  // The slug identifies the source and is fine in the URL; the secret is not,
  // and is read from headers only. See rule 2 at the top.
  const url = new URL(req.url);
  const pathSlug = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const slug = (req.headers.get('x-lead-source') || (pathSlug === 'lead-intake' ? '' : pathSlug) || '').trim();

  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const secret = (req.headers.get('x-lead-secret') || bearer || '').trim();

  // The forwarded address, for the log and for nothing else. Never used to
  // authorize: an IP allow-list would be a second thing to keep current every
  // time a vendor changes hosting, and the secret is the actual gate.
  const remoteIp = firstIp(req.headers.get('x-forwarded-for'));

  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  const bodyText = await req.text();
  // Checked again: content-length is a claim, not a measurement. Comparing
  // string length rather than encoded bytes errs the safe way — a UTF-8 body is
  // never shorter than its JS string length, so nothing over the cap slips past.
  if (bodyText.length > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  // ── parse ────────────────────────────────────────────────────────────────
  // JSON is what most vendors post; form-encoded is what the rest post, usually
  // the ones whose integration is an HTML form action pointed at a URL.
  //
  // Parsed BEFORE authorizing, which looks backwards and is not. The body is
  // already capped at 64KB, so this is a trivial amount of work next to the
  // bcrypt verify the caller is about to make us do anyway — and doing it in
  // this order means a malformed body from an authenticated vendor reaches
  // ingest_lead_from_source() and gets LOGGED. The rate limiter counts log
  // rows, so a path that returns 400 without writing one is a path a caller
  // with a valid secret can hammer for free.
  let raw: Record<string, unknown> | null = null;
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  try {
    raw = contentType.includes('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(bodyText).entries())
      : JSON.parse(bodyText || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = null;
  } catch {
    raw = null;
  }

  const admin: SupabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // ── authenticate ─────────────────────────────────────────────────────────
  const { data: authRows, error: authErr } = await admin.rpc('authorize_lead_intake', {
    p_slug: slug,
    p_secret: secret,
    p_ip: remoteIp,
  });

  if (authErr) {
    console.error(`[lead-intake] authorization failed for slug "${slug}":`, authErr.message);
    return json({ error: 'internal_error' }, 500);
  }

  const auth = Array.isArray(authRows) ? authRows[0] : authRows;
  if (!auth?.allowed) {
    const reason = auth?.reason ?? 'unknown_source';
    console.warn(`[lead-intake] rejected slug "${slug}" from ${remoteIp ?? 'unknown ip'}: ${reason}`);

    if (reason === 'rate_limited') {
      // Retry-After is what makes a well-behaved vendor back off instead of
      // spinning. The window in authorize_lead_intake() is one minute.
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }
    if (reason === 'inactive') {
      // Only reachable with the right secret, so it is safe to be specific —
      // and being specific is the difference between a vendor emailing us and a
      // vendor debugging a credential problem they do not have.
      return json({ error: 'source_inactive' }, 403);
    }
    // unknown_source, bad_secret and no_slug are one answer. See rule 4.
    return json({ error: 'unauthorized' }, 401);
  }

  // ── map ──────────────────────────────────────────────────────────────────
  // An unparseable body still goes to the database, so the attempt is logged
  // and counted. It maps to no phone and no email, which is the branch
  // ingest_lead_from_source() rejects — and the bytes ride along so the reason
  // a vendor's integration broke is recoverable from the log.
  if (raw === null) {
    console.warn(`[lead-intake] ${slug}: unparseable body (${contentType || 'no content-type'})`);
    await admin.rpc('ingest_lead_from_source', {
      p_source_id: auth.source_id,
      p_lead: {},
      p_raw: { _unparsed: bodyText.slice(0, 2000), _content_type: contentType || null },
      p_consent: {},
      p_ip: remoteIp,
    });
    return json({ error: 'bad_payload', detail: 'Body is not valid JSON or form encoding' }, 400);
  }

  // Unwrap the envelope if there is one. The wrapper is kept in `raw` — what
  // gets flattened is a view for mapping, never a replacement for the original.
  let mappable: Record<string, unknown> = raw;
  for (const k of WRAPPER_KEYS) {
    const inner = raw[k];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && Object.keys(raw).length <= 3) {
      mappable = inner as Record<string, unknown>;
      break;
    }
  }

  const flat = flatten(mappable);
  // Vendors that wrap also sometimes put the consent evidence *outside* the
  // wrapper, next to it. Merge the outer level in underneath so those fields
  // are still found, without letting them shadow the mapped ones.
  if (mappable !== raw) {
    for (const [k, v] of Object.entries(flatten(raw))) if (!(k in flat)) flat[k] = v;
  }

  const lead = mapLead(flat);

  // What the vendor *claims*. The database decides what it is worth.
  const consent = {
    claimed: truthy(pick(flat, CONSENT_ALIASES.claimed)),
    text: pick(flat, CONSENT_ALIASES.text),
    at: pick(flat, CONSENT_ALIASES.at),
    ip: pick(flat, CONSENT_ALIASES.ip),
    version: pick(flat, CONSENT_ALIASES.version),
  };

  // ── store ────────────────────────────────────────────────────────────────
  const { data: rows, error: insErr } = await admin.rpc('ingest_lead_from_source', {
    p_source_id: auth.source_id,
    p_lead: lead,
    p_raw: raw,
    p_consent: consent,
    p_ip: remoteIp,
  });

  if (insErr) {
    // 500 so a vendor with retries tries again. ingest_lead_from_source() is
    // one transaction and dedups on phone_key, so a retry that arrives after a
    // write we failed to hear about updates the lead instead of doubling it.
    console.error(`[lead-intake] ${slug}: insert failed:`, insErr.message);
    return json({ error: 'internal_error' }, 500);
  }

  const result = Array.isArray(rows) ? rows[0] : rows;

  if (result?.action === 'rejected') {
    return json({ error: 'bad_payload', detail: result.message ?? 'Lead rejected' }, 400);
  }

  console.log(
    `[lead-intake] ${slug}: ${result?.action} lead ${result?.lead_id}` +
      ` (consent ${result?.consent_granted ? 'recorded' : 'not granted'})` +
      (result?.message ? ` — ${result.message}` : ''),
  );

  // The vendor is told what happened to their lead and nothing about ours. No
  // consent field in the response either: a vendor who can see that we refused
  // their claim is a vendor who can iterate until we accept it.
  //
  // 200 for both accepted and updated, rather than the tidier 201/200 split.
  // Integrations in the wild check for exactly 200 far more often than they
  // check for 2xx, and a vendor that reads our 201 as a failure retries — which
  // is a lead posted twice and an on-call page for something that worked.
  return json({
    ok: true,
    id: result?.lead_id ?? null,
    action: result?.action ?? 'accepted',
  });
});

/** First public address in X-Forwarded-For, or null. Shape-checked only. */
function firstIp(xff: string | null): string | null {
  const first = (xff || '').split(',')[0].trim();
  return first && /^[0-9a-fA-F.:]+$/.test(first) ? first : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
