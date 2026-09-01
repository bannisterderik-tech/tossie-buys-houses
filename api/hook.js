/**
 * POST /api/hook?s={slug}&k={secret} — a front door for lead vendors that only
 * let you configure a URL.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE NORMAL PATH.
 *
 * lead-intake takes its secret in a header, and its own file says why in as
 * many words: a secret in a query string is a secret in somebody else's logs.
 * That rule is right and it stays. But some vendors — PropertyLeads.com among
 * them — give you one field, a URL, and nothing else. The choice there is not
 * "header or query string", it is "query string or no integration", and a lead
 * that never arrives is the worse outcome.
 *
 * So the compromise is contained rather than spread:
 *
 *   - It lives here, in a shim, instead of loosening lead-intake. The header
 *     path stays the only way into that function, so a vendor that CAN send a
 *     header still gets the stronger arrangement.
 *   - Every rail still applies. This forwards to lead-intake and nothing else:
 *     the same bcrypt check, the same per-source rate limit, the same
 *     lead_intake_log, the same field mapping. No parsing and no database
 *     access of its own — a second copy of the mapping table is how the two
 *     paths start disagreeing about what a lead is.
 *   - The secret is per source. A leak here rotates one vendor and nothing else.
 *
 * ON THE FILENAME. This was api/hook/[slug].js first, with the slug as a path
 * segment, and Vercel served it as 404 while top-level api/lead.js worked. A
 * webhook URL somebody else has to paste into their admin screen is not worth
 * debugging a router over, so the slug moved into the query string where it
 * needs no dynamic route at all.
 *
 * Treat any secret used through this route as lower-trust than a header one.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fvkxdhuwfjnsvkjjordm.supabase.co';

/** Same ceiling lead-intake enforces, applied before we spend a round trip. */
const MAX_BODY_BYTES = 64 * 1024;

/** Matches lead_sources_slug_shape, so a malformed slug never leaves this box. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const slug = String(req.query.s || req.query.slug || '').trim().toLowerCase();
  // `k` is short on purpose: some vendors truncate long URLs in their own admin
  // screens, and the parameter name is overhead in a string that already
  // carries a 43-character credential.
  const secret = String(req.query.k || req.query.secret || '').trim();

  // Deliberately one answer for all three. Telling a caller which part was
  // wrong turns this into a slug enumerator, which is the same reasoning
  // lead-intake gives for matching its own responses.
  if (!SLUG_RE.test(slug) || !secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Vercel parses JSON bodies; anything else arrives as a string or Buffer.
  // Re-serialise rather than stream, so the size check is against what will
  // actually be forwarded.
  let body;
  let contentType = 'application/json';
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    body = req.body.toString('utf8');
    contentType = req.headers['content-type'] || 'text/plain';
  } else {
    body = JSON.stringify(req.body ?? {});
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'payload too large' });
  }

  const forwardedFor = req.headers['x-forwarded-for'] || '';

  let upstream;
  try {
    upstream = await fetch(`${SUPABASE_URL}/functions/v1/lead-intake/${slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'x-lead-secret': secret,
        // Preserved so the rate limiter and lead_intake_log record the vendor's
        // address rather than a Vercel edge node's.
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      body,
    });
  } catch (e) {
    console.error('[hook] could not reach lead-intake:', e.message);
    // 502, not 500: the vendor should retry, and most of them do on a 5xx.
    return res.status(502).json({ error: 'upstream unavailable' });
  }

  // Passed through verbatim, status included. A vendor's delivery log is the
  // only place some of these are ever read, and rewriting a 401 into a friendly
  // 200 is how a broken integration looks healthy for a month.
  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
  return res.send(text);
}
