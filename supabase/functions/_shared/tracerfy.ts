// supabase/functions/_shared/tracerfy.ts
// ============================================================================
// Tracerfy skip-trace helper — retry-aware POST wrapper.
// ============================================================================
// Ported from reoperative's _shared/tracerfy.ts. Same shape as batchdata.ts on
// purpose: skip-trace calls both providers in one pass, and two helpers with
// different transient-error semantics would mean the trace and the scrub
// disagreed about what "it failed" means, in a function whose whole job is to
// know the difference.
//
// Why the retry: the fetch this replaced had none, so one 5xx blip marked the
// prospect's trace failed. That is not a compliance failure the way a swallowed
// DNC check is — an untraced prospect has no number and cannot be dialled — but
// it is a wasted lookup and a row an operator then re-traces by hand, paying
// twice for the same record.
//
// The timeout is longer than BatchData's (30s vs 15s) because a trace is a
// people-search across several data sources and genuinely takes seconds, where
// a DNC lookup is a list membership test. Aborting a slow trace at 15s would
// retry a request that was about to succeed and pay for both.
//
// No public API docs exist for Tracerfy; the 429/Retry-After handling matches
// BatchData's, which is the industry convention. Nothing here fabricates a
// response — a call that does not answer returns `ok: false`, never a result.
// ============================================================================

const TRACERFY_BASE = Deno.env.get('TRACERFY_BASE_URL') || 'https://api.tracerfy.com';

export interface TracerfyResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

interface TracerfyPostOpts {
  apiKey?: string;
  timeoutMs?: number;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    backoffFactor?: number;
    maxDelayMs?: number;
  };
}

const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 750,
  backoffFactor: 4,
  maxDelayMs: 20000,
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the key is absent, so the caller can name it in the refusal. */
export function tracerfyConfigured(): boolean {
  return (Deno.env.get('TRACERFY_API_KEY') || '') !== '';
}

/**
 * POST a JSON payload to a Tracerfy endpoint, retrying transient errors.
 * Never throws on a non-2xx — the caller branches on `.ok`.
 *
 * @param path  Path under the base host, e.g. '/v1/api/trace/lookup/'.
 * @param body  Request body; the caller owns its shape.
 */
export async function tracerfyPost<T = unknown>(
  path: string,
  body: unknown,
  opts: TracerfyPostOpts = {},
): Promise<TracerfyResult<T>> {
  const apiKey = opts.apiKey || Deno.env.get('TRACERFY_API_KEY') || '';
  if (!apiKey) {
    return { ok: false, status: 0, error: 'TRACERFY_API_KEY not configured' };
  }

  const timeoutMs = opts.timeoutMs ?? 30000;
  const retry = { ...DEFAULT_RETRY, ...(opts.retry || {}) };
  const url = `${TRACERFY_BASE}${path}`;

  let lastErr: TracerfyResult<T> = { ok: false, status: 0, error: 'no attempt made' };
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

      const errMsg = readError(data) || `Tracerfy ${resp.status}`;
      lastErr = { ok: false, status: resp.status, data: data as T, error: errMsg };
      if (!isRetryableStatus(resp.status)) {
        // Permanent: bad input, missing key, expired plan. No point retrying.
        console.error(`[tracerfy] non-retryable ${resp.status} on ${path}: ${errMsg}`);
        return lastErr;
      }
      const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
      const delayMs = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(retry.maxDelayMs, retry.baseDelayMs * Math.pow(retry.backoffFactor, attempt - 1));
      if (attempt < retry.maxAttempts) {
        console.warn(`[tracerfy] ${resp.status} on ${path}, attempt ${attempt}/${retry.maxAttempts}, retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    } catch (err) {
      const msg = (err as Error)?.message || 'network error';
      console.warn(`[tracerfy] threw on attempt ${attempt}: ${msg}`);
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
