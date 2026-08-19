// supabase/functions/_shared/cors.ts
// ============================================================================
// CORS for the edge functions the operator app calls from the browser.
// ============================================================================
// Ported from reoperative's _shared/cors.ts with its permissiveness removed.
// That version echoed back whatever Origin it was handed, because reoperative
// hosts booking pages and chat widgets on customer-owned domains it cannot
// enumerate at build time. Tossie has no customer domains — there are exactly
// four origins the app is ever served from — so this is a strict allow-list and
// an unrecognised origin gets no CORS headers at all.
//
// Twilio webhooks need none of this: Twilio is a server, it never sends an
// Origin and never preflights. Do not import this into a webhook — an endpoint
// that answers OPTIONS from anywhere is a bigger target than one that answers
// POST only.
// ============================================================================

const ALLOWED_ORIGINS = [
  'https://tossiebuyshouses.com',
  'https://www.tossiebuyshouses.com',
  'https://tossie-buys-houses.vercel.app',
  // Vite dev server; app/vite.config.js pins the port, so this stays one entry.
  'http://localhost:5174',
];

/**
 * CORS headers for a request, or an empty object when the origin is not ours.
 * Returning nothing is the right failure: the browser blocks the response and
 * the function never had to decide whether to trust the caller.
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // Required whenever the allowed origin varies by request, or a shared cache
    // will hand one origin's response to another.
    'Vary': 'Origin',
  };
}

/** Convenience: a JSON response carrying the request's CORS headers. */
export function jsonResponse(body: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
