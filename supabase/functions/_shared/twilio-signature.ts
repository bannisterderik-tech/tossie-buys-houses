// ============================================================================
// twilio-signature.ts — prove a webhook actually came from Twilio.
// ============================================================================
// Ported from reoperative. Without this check, our webhook URLs are an open
// endpoint: anyone who learns one can POST a form body with a CallSid and a
// From number and have us log calls that never happened, mark a real call
// completed mid-conversation, or (on the SMS side) inject a fake inbound
// message. The URLs are handed to Twilio, but they are not secret — they show
// up in Twilio console screenshots, support tickets and browser history.
//
// The algorithm is Twilio's, replicated from the Node SDK because that SDK's
// crypto.createHmac does not run on the Deno edge runtime:
//   form-encoded : HMAC-SHA1(authToken, URL + concat(sortedKey + value)) base64
//   json body    : HMAC-SHA1(authToken, URL-with-?bodySHA256=hex) base64,
//                  AND SHA-256(rawBody) hex must equal that bodySHA256
//
// Twilio's signer is inconsistent about the standard port and about query
// string encoding, so the official validator tries four URL variants. We try
// those, plus an https-forced and a SUPABASE_URL-rebuilt form, because TLS
// terminates at the Supabase edge proxy and `req.url` reaches the function as
// http:// with a possibly-rewritten path. Widening the candidate set cannot
// weaken the check: we only ever accept on a valid HMAC against the real auth
// token, so extra candidates can only stop false rejections of genuine Twilio
// requests.
//
// Docs: https://www.twilio.com/docs/usage/security
// ============================================================================

/** Length-independent compare so a failed check leaks no timing information. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The string Twilio signs for a form-encoded webhook: the URL followed by every
 * parameter as key+value, keys sorted. Repeated keys are deduped and sorted,
 * matching the Node SDK's toFormUrlEncodedParam.
 */
function buildFormSignedData(url: string, params: Record<string, string | string[]>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (Array.isArray(v)) {
      for (const val of Array.from(new Set(v)).sort()) data += key + val;
    } else {
      data += key + v;
    }
  }
  return data;
}

/** Mirrors `addPort` in the Node SDK: force the standard port into the URL. */
function addStandardPort(parsed: URL): string {
  if (parsed.port) return parsed.toString();
  const port = parsed.protocol === 'https:' ? ':443' : ':80';
  return `${parsed.protocol}//${parsed.host}${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function removePort(parsed: URL): string {
  const u = new URL(parsed.toString());
  u.port = '';
  return u.toString();
}

/**
 * Re-encode the query string form-urlencoded style. Twilio's signer sometimes
 * percent-encodes special characters differently from what the WHATWG URL
 * parser produces, and the difference is one byte in a signed string.
 */
function withLegacyQuerystring(url: string): string {
  const parsed = new URL(url);
  if (!parsed.search) return url;
  const qs = new URLSearchParams(parsed.search.slice(1)).toString();
  parsed.search = '';
  return `${parsed.toString()}?${qs}`;
}

/**
 * Validate a form-encoded (or query-only GET) Twilio request.
 *
 * @param url        full request URL including query string
 * @param params     parsed body params; pass {} for GET
 * @param signature  the X-Twilio-Signature header
 * @param authToken  the account auth token, from edge function secrets
 */
export async function validateTwilioSignature(
  url: string,
  params: Record<string, string | string[]>,
  signature: string,
  authToken: string,
): Promise<boolean> {
  if (!signature || !authToken) return false;

  const baseUrls = new Set<string>([url]);
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      const https = new URL(u.toString());
      https.protocol = 'https:';
      baseUrls.add(https.toString());
    }
    // Rebuild the canonical public URL. Twilio signs the exact URL it was
    // handed — usually `${SUPABASE_URL}/functions/v1/twilio-voice?...` from a
    // TwiML action attribute — but behind the edge proxy the request can reach
    // us with the /functions/v1 prefix already stripped.
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    if (supabaseUrl) {
      try {
        const origin = new URL(supabaseUrl).origin;
        const path = u.pathname.startsWith('/functions/v1/')
          ? u.pathname
          : `/functions/v1${u.pathname.startsWith('/') ? '' : '/'}${u.pathname}`;
        baseUrls.add(`${origin}${path}${u.search}`);
        baseUrls.add(`${origin}${u.pathname}${u.search}`);
      } catch { /* malformed SUPABASE_URL — the other candidates still apply */ }
    }
  } catch { /* non-absolute url — keep the original only */ }

  const candidates = new Set<string>();
  for (const b of baseUrls) {
    const parsed = new URL(b);
    const noPort = removePort(parsed);
    const withPort = addStandardPort(parsed);
    candidates.add(noPort);
    candidates.add(withPort);
    candidates.add(withLegacyQuerystring(noPort));
    candidates.add(withLegacyQuerystring(withPort));
  }

  for (const candidateUrl of candidates) {
    const expected = await hmacSha1Base64(authToken, buildFormSignedData(candidateUrl, params));
    if (constantTimeEqual(expected, signature)) return true;
  }
  return false;
}

/**
 * Validate a JSON-body Twilio request. Twilio puts SHA-256(rawBody) into a
 * `bodySHA256` query parameter and signs the URL; both halves must hold or the
 * body could be swapped under a valid URL signature.
 */
export async function validateTwilioJsonSignature(
  url: string,
  rawBody: string,
  signature: string,
  authToken: string,
): Promise<boolean> {
  if (!signature || !authToken) return false;
  const expectedBodyHash = new URL(url).searchParams.get('bodySHA256') || '';
  if (!expectedBodyHash) return false;
  if (!constantTimeEqual(await sha256Hex(rawBody), expectedBodyHash)) return false;
  return validateTwilioSignature(url, {}, signature, authToken);
}
