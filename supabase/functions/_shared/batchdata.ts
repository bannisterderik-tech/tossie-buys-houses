// supabase/functions/_shared/batchdata.ts
// ============================================================================
// BatchData REST helper — retry-aware POST wrapper.
// ============================================================================
// Ported from reoperative's _shared/batchdata.ts, which exists because the code
// it wrapped had no retry at all. For the property-search callers that was a
// reliability annoyance. For the one caller that matters here it was a
// compliance hole, and the distinction is worth spelling out because it decides
// how this file is allowed to be used:
//
//   reoperative's skip-trace ran the DNC and litigator scrub inside a
//   `try / catch (non-fatal)`. A single transient 503 from BatchData therefore
//   skipped the TCPA-litigator check SILENTLY, left the flag unset, and the
//   number got cold-called anyway. Nobody found out until the demand letter.
//
// Retrying is half the fix and it is the half that lives here. The other half
// lives in the caller and cannot be moved into this file: **a scrub that did not
// answer is not a scrub that came back clean.** skip-trace/index.ts refuses to
// set `dnc_scrubbed` when either check fails after the retry budget, which keeps
// the prospect out of the dial queue — the safe direction — instead of marking
// it checked on the strength of an error.
//
// What this helper does:
//   - retries 429 / 5xx with exponential backoff, honouring Retry-After
//   - applies an abort timeout per call, because fetch has no default one
//   - returns a uniform { ok, status, data, error } so callers branch on .ok
//     rather than wrapping every fetch in a try/catch that swallows the reason
//
// What it deliberately does NOT do: cost control. BatchData bills per record,
// and the guardrails (batch caps, dry-run, the per-run spend record) belong to
// the caller where they can be reasoned about against a list size. A helper that
// silently declined to call would look exactly like a clean scrub.
//
// Reference: docs.batchdata.com (REST API).
// ============================================================================

// Overridable so a staging key can be pointed at a sandbox host without a code
// change. Both are edge secrets — nothing here reads the database, and no
// provider credential may ever be stored in it or prefixed VITE_.
const BATCHDATA_BASE = Deno.env.get('BATCHDATA_BASE_URL') || 'https://api.batchdata.com/api/v1';

export interface BatchDataResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

interface BatchDataPostOpts {
  /** Override the BATCHDATA_API_KEY env var. */
  apiKey?: string;
  /** Per-call timeout in ms. Default 15s. */
  timeoutMs?: number;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    backoffFactor?: number;
    maxDelayMs?: number;
  };
}

// Three attempts over ~10 seconds. Tuned for the failure this exists to survive
// — a momentary 503 or a rate-limit burst — not for an outage. Waiting longer
// would not fix an outage and would push a batch past the invocation budget,
// which strands rows mid-scrub for no gain.
const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoffFactor: 4,
  maxDelayMs: 15000,
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the key is absent, so the caller can refuse loudly rather than skip quietly. */
export function batchDataConfigured(): boolean {
  return (Deno.env.get('BATCHDATA_API_KEY') || '') !== '';
}

/**
 * POST a JSON payload to a BatchData endpoint, retrying transient errors.
 * Never throws on a non-2xx — the caller branches on `.ok`.
 *
 * @param path  Endpoint path under /api/v1, e.g. '/phone/dnc', '/phone/litigator'.
 * @param body  Request body; the caller owns its shape.
 */
export async function batchDataPost<T = unknown>(
  path: string,
  body: unknown,
  opts: BatchDataPostOpts = {},
): Promise<BatchDataResult<T>> {
  // reoperative read BATCHLEADS_API_KEY here, a name left over from when the
  // vendor was BatchLeads. Renamed to BATCHDATA_API_KEY so the secret is named
  // after the account it belongs to; there is no old secret to stay compatible
  // with on this project.
  const apiKey = opts.apiKey || Deno.env.get('BATCHDATA_API_KEY') || '';
  if (!apiKey) {
    return { ok: false, status: 0, error: 'BATCHDATA_API_KEY not configured' };
  }

  const timeoutMs = opts.timeoutMs ?? 15000;
  const retry = { ...DEFAULT_RETRY, ...(opts.retry || {}) };
  const url = `${BATCHDATA_BASE}${path}`;

  let lastErr: BatchDataResult<T> = { ok: false, status: 0, error: 'no attempt made' };
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await resp.json().catch(() => null);
      if (resp.ok) return { ok: true, status: resp.status, data: data as T };

      const errMsg = readError(data) || `BatchData ${resp.status}`;
      lastErr = { ok: false, status: resp.status, data: data as T, error: errMsg };
      if (!isRetryableStatus(resp.status)) {
        // Anything 4xx other than 429 is permanent — bad key, malformed body,
        // plan limit. Failing fast surfaces the real reason instead of burying
        // it under three rounds of backoff.
        console.error(`[batchdata] non-retryable ${resp.status} on ${path}: ${errMsg}`);
        return lastErr;
      }
      const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
      const delayMs = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(retry.maxDelayMs, retry.baseDelayMs * Math.pow(retry.backoffFactor, attempt - 1));
      if (attempt < retry.maxAttempts) {
        console.warn(`[batchdata] ${resp.status} on ${path}, attempt ${attempt}/${retry.maxAttempts}, retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    } catch (err) {
      // AbortSignal.timeout raises DOMException 'TimeoutError'; a network
      // failure raises TypeError. Both are transient, so both retry.
      const msg = (err as Error)?.message || 'network error';
      console.warn(`[batchdata] threw on attempt ${attempt}: ${msg}`);
      lastErr = { ok: false, status: 0, error: msg };
      if (attempt < retry.maxAttempts) {
        await sleep(retry.baseDelayMs * Math.pow(retry.backoffFactor, attempt - 1));
      }
    }
  }
  return lastErr;
}

/** Pull whatever the error body called the message, without asserting a shape. */
function readError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  for (const k of ['message', 'error', 'detail']) {
    if (typeof d[k] === 'string' && d[k]) return d[k] as string;
  }
  return null;
}
