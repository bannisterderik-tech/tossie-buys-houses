// supabase/functions/skip-trace/index.ts
// ============================================================================
// Skip trace + DNC/litigator scrub, over PROSPECTS.
// ============================================================================
// The only thing that turns a purchased list into something Tossie may legally
// dial. prospect_is_callable() refuses everything that has not been traced AND
// scrubbed (20260822120000); this function is what supplies both, and the whole
// design is organised around one rule:
//
//     A SCRUB THAT DID NOT ANSWER IS NOT A SCRUB THAT CAME BACK CLEAN.
//
// reoperative's version ran the DNC and litigator checks inside a
// `try / catch (non-fatal)`. One transient 503 from BatchData therefore skipped
// the litigator check silently, left the flag false, marked the lead scrubbed
// anyway, and the number was cold-called. Serial TCPA plaintiffs seed their
// numbers onto exactly the absentee and pre-foreclosure lists a wholesaler buys,
// and the statutory damages are $500-$1,500 per call. So here, when either
// check fails after its retry budget, `dnc_scrubbed` is NOT set. The prospect
// stays out of the dial queue — the safe direction — `scrub_error` says why, and
// scrub_failed_count on the run row is the retry list.
//
// The same rule is applied one level down, to the response body rather than the
// HTTP status: if a number we submitted comes back without an explicit answer,
// that number is unscrubbed. reoperative matched results by phone number and
// left `dnc = false` for anything unmatched, which turns a partial response —
// or a response whose shape changed — into a clean bill of health for numbers
// nobody checked. That is the same hole with a 200 on it.
//
// PROSPECTS, NOT LEADS. This function never touches `leads`, never records
// consent, and cannot send anything. §10's separation is what makes that
// structural: there is no consent column on `prospects` to set, and the only
// door between the tables is convert_prospect_to_lead(), which is granted to
// `authenticated` and explicitly NOT to service_role — so this function could
// not bulk-convert a scrubbed list even if it tried.
//
// LINE TYPE IS KEPT SEPARATE. phone_mobile / phone_landline / phone_voip are
// three columns because which one you dial matters: a mobile is a cell for TCPA
// purposes, and a VOIP number is where the disconnected and the reassigned
// live. Collapsing them to "best phone" loses the fact the dialer needs.
//
// DRY RUN IS THE DEFAULT. A request that does not say `confirm: true` reports
// what would be traced and what it would cost, and spends nothing. Same reason
// broadcast-send makes a draft campaign refuse without confirm: the expensive
// action should be the one you asked for, not the one you got.
//
// Request:  POST {
//     list_id?      trace/scrub every eligible prospect on this list
//     prospect_ids? trace/scrub these (max SKIP_TRACE_BATCH)
//     confirm?      true to actually spend. Absent/false = dry run.
//     force?        re-trace prospects that were already traced
//     limit?        shrink the batch; cannot grow it past SKIP_TRACE_BATCH
//     team_id?      required only on a service-key call, which has no session
//   }
//   Exactly one of list_id / prospect_ids.
//
// Refusal reasons, all of which the UI should be able to render:
//   method_not_allowed       not a POST
//   not_configured           the Supabase environment is incomplete
//   bad_request              no selector, both selectors, or a malformed body
//   not_authenticated        missing or invalid JWT
//   no_team                  signed in but not on a team
//   list_not_found           no such prospect list on this team
//   nothing_to_do            nothing on this team needs a trace or a scrub
//   provider_not_configured  an edge secret is missing; the message names it
//   run_not_recorded         the run row could not be written, so nothing ran
//   select_failed            the prospects could not be read
//
// Edge secrets (Supabase → Edge Functions → Secrets. Never in the database,
// never prefixed VITE_):
//   TRACERFY_API_KEY       the trace provider
//   BATCHDATA_API_KEY      the DNC + litigator provider
//   SKIP_TRACE_BATCH       max prospects per invocation. Default 100.
//   SKIP_TRACE_BUDGET_MS   wall-clock budget per invocation. Default 90000.
//   SKIP_TRACE_INTERVAL_MS pause between prospects. Default 200.
//   SKIP_TRACE_COST_TRACE_MICROS / _DNC_MICROS / _LITIGATOR_MICROS
//                          Tossie's contracted unit prices, in millionths of a
//                          dollar. Defaults are BUILD_PLAN §11's figures
//                          ($0.04 / $0.002 / $0.002).
//
// Deploy with verify_jwt = true. Both callers present a JWT: an operator's
// session, or the service key from cron. This endpoint spends money and writes
// the compliance flags the dialer reads — there is no version of it that is safe
// to expose unauthenticated.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders, jsonResponse } from '../_shared/cors.ts';
import { batchDataConfigured, batchDataPost } from '../_shared/batchdata.ts';
import { tracerfyConfigured, tracerfyPost } from '../_shared/tracerfy.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const TRACE_PROVIDER = 'tracerfy';
const SCRUB_PROVIDER = 'batchdata';

function envInt(name: string, fallback: number): number {
  const n = parseInt(Deno.env.get(name) ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// 100 matches reoperative's MAX_BULK_SIZE. The ceiling that actually binds is
// the wall-clock budget below — at 200ms of pacing plus two round trips per
// prospect, a hundred rows is already most of a 90-second invocation.
const BATCH = Math.max(1, envInt('SKIP_TRACE_BATCH', 100));
const BUDGET_MS = Math.max(1000, envInt('SKIP_TRACE_BUDGET_MS', 90_000));

// Politeness, not a documented rate limit. Neither provider publishes one, and
// the cost of pacing is seconds where the cost of being throttled is a batch
// that half-finishes and leaves rows traced-but-unscrubbed.
const INTERVAL_MS = envInt('SKIP_TRACE_INTERVAL_MS', 200);

// BUILD_PLAN §11: ~$0.044 a prospect all-in. Overridable because a contracted
// rate is a property of Tossie's account, not of this file — a number hardcoded
// here would look authoritative and be wrong the day the rate changes.
const TRACE_UNIT_MICROS = envInt('SKIP_TRACE_COST_TRACE_MICROS', 40_000);
const DNC_UNIT_MICROS = envInt('SKIP_TRACE_COST_DNC_MICROS', 2_000);
const LITIGATOR_UNIT_MICROS = envInt('SKIP_TRACE_COST_LITIGATOR_MICROS', 2_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function refuse(
  cors: Record<string, string>,
  status: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse({ ok: false, reason, message, ...extra }, cors, status);
}

/** Micros to a printable dollar figure. Four decimals, because $0.002 rounds to $0.00. */
function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

// ─── what the providers give back ───────────────────────────────────────────

type LineType = 'mobile' | 'landline' | 'voip' | 'unknown';

interface TracedPhone {
  number: string;
  type: LineType;
  /** The provider's own connectivity claim. Undefined when it did not make one. */
  connected?: boolean;
  /** Tri-state on purpose. `undefined` is "not checked yet" and must never read as false. */
  dnc?: boolean;
  litigator?: boolean;
}

interface TracedEmail {
  address: string;
  verified?: boolean;
}

interface TraceResult {
  phones: TracedPhone[];
  emails: TracedEmail[];
  /**
   * Null when the provider did not give one. reoperative substituted 80 when
   * phones came back and 30 when they did not, which is a number an operator
   * would read as the provider's opinion and act on. An invented confidence is
   * a fabricated API response; null is the honest answer.
   */
  confidence: number | null;
  raw: unknown;
}

function asLineType(v: unknown): LineType {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('mobile') || s === 'cell' || s === 'wireless') return 'mobile';
  if (s.includes('landline') || s === 'wireline' || s === 'residential') return 'landline';
  if (s.includes('voip')) return 'voip';
  return 'unknown';
}

/** Last ten digits — the same join key phone_key() uses in SQL, for the same reason. */
function digits10(v: unknown): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

function boolOrUndefined(...vals: unknown[]): boolean | undefined {
  for (const v of vals) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * Shape the Tracerfy body into our own. The tolerant key reading is ported from
 * reoperative rather than invented — the provider has no public schema and this
 * is the set of keys its responses were observed to use there. What is NOT
 * ported is the habit of defaulting a missing field to a confident value.
 */
function parseTrace(body: unknown): TraceResult {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;

  const rawPhones = Array.isArray(data.phones) ? data.phones : [];
  const phones: TracedPhone[] = [];
  for (const entry of rawPhones) {
    const p = (entry ?? {}) as Record<string, unknown>;
    const number = String(p.number ?? p.phone ?? '').trim();
    if (!number || digits10(number).length !== 10) continue; // US/CA only; anything else we cannot dial
    phones.push({
      number,
      type: asLineType(p.type ?? p.line_type),
      connected: boolOrUndefined(p.is_connected, p.connected),
    });
  }

  const rawEmails = Array.isArray(data.emails) ? data.emails : [];
  const emails: TracedEmail[] = [];
  for (const entry of rawEmails) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const address = String(e.email ?? e.address ?? '').trim();
    if (!address || !address.includes('@')) continue;
    emails.push({ address, verified: boolOrUndefined(e.verified) });
  }

  const c = data.confidence;
  const confidence = typeof c === 'number' && Number.isFinite(c)
    ? Math.max(0, Math.min(100, Math.round(c)))
    : null;

  return { phones, emails, confidence, raw: body };
}

/**
 * Pull `{last-ten-digits → flag}` out of a BatchData scrub response.
 *
 * Returns null when the body cannot be read as a list of per-phone answers at
 * all. Null is not "everything is clean" — the caller treats it as a failed
 * scrub, which is the entire point. The alternative, and reoperative's actual
 * behaviour, was to iterate zero results and leave every flag false.
 */
function parseScrub(body: unknown, keys: string[]): Map<string, boolean> | null {
  const root = (body ?? {}) as Record<string, unknown>;
  const results = (root.results ?? {}) as Record<string, unknown>;
  const candidates = [
    (results as Record<string, unknown>).phones,
    root.results,
    root.data,
    root.phones,
  ];

  let rows: unknown[] | null = null;
  for (const c of candidates) {
    if (Array.isArray(c)) { rows = c; break; }
  }
  if (!rows) return null;

  const out = new Map<string, boolean>();
  for (const entry of rows) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const key = digits10(r.phone ?? r.number);
    if (!key) continue;
    // Every key the provider has been seen to use for the answer. If none of
    // them is present the number has no answer and stays out of the map — which
    // fails the completeness check below rather than defaulting to "clean".
    const flag = boolOrUndefined(...keys.map((k) => r[k]));
    if (flag === undefined) continue;
    out.set(key, flag);
  }
  return out;
}

const DNC_KEYS = ['dnc', 'isDnc', 'is_dnc', 'onDnc', 'on_dnc', 'registered'];
const LITIGATOR_KEYS = ['litigator', 'isLitigator', 'is_litigator', 'tcpa', 'tcpaLitigator'];

// ─── selection ──────────────────────────────────────────────────────────────

/**
 * The number we would actually dial for one line type: first entry of that type
 * that is neither DNC-listed nor a litigator, and that the provider has not said
 * is disconnected.
 *
 * `connected === false` is rejected; `undefined` is accepted. A provider that
 * declined to say is not a provider that said no, and dropping every number
 * without an explicit connectivity claim would throw away most of a trace.
 *
 * Numbers rejected here are not lost — the full scrub outcome goes into
 * raw_data.skip_trace, so "we found this number and deliberately did not keep
 * it" stays on the record. NOTHING MAY DIAL FROM raw_data.
 */
function pick(phones: TracedPhone[], type: LineType): string | null {
  const hit = phones.find((p) =>
    p.type === type && p.dnc !== true && p.litigator !== true && p.connected !== false
  );
  return hit ? hit.number : null;
}

// ─── one prospect's outcome ─────────────────────────────────────────────────

interface Tally {
  selected: number;
  traced: number;
  traceFailed: number;
  scrubbed: number;
  scrubFailed: number;
  phonesFound: number;
  emailsFound: number;
  dncHits: number;
  litigatorHits: number;
  traceLookups: number;
  dncLookups: number;
  litigatorLookups: number;
  failures: Array<{ prospect_id: string; phase: string; error: string }>;
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return refuse(cors, 405, 'method_not_allowed', 'POST only.');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return refuse(cors, 500, 'not_configured', 'The Supabase environment is incomplete on this function.');
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return refuse(cors, 400, 'bad_request', 'The request body must be JSON.');
  }

  const listId = typeof payload.list_id === 'string' ? payload.list_id : null;
  const prospectIds = Array.isArray(payload.prospect_ids)
    ? payload.prospect_ids.filter((v): v is string => typeof v === 'string')
    : null;

  // Exactly one selector. Accepting both would mean silently choosing which one
  // wins, and the losing interpretation is a list of five thousand.
  if (!listId && (!prospectIds || prospectIds.length === 0)) {
    return refuse(cors, 400, 'bad_request', 'Give either a list_id or a non-empty prospect_ids array.');
  }
  if (listId && prospectIds && prospectIds.length > 0) {
    return refuse(cors, 400, 'bad_request', 'Give a list_id or prospect_ids, not both.');
  }
  // Refused rather than silently truncated. Trimming the array would trace the
  // first hundred, report success, and leave the caller believing the other
  // four hundred were done — an unscrubbed prospect nobody knows about.
  if (prospectIds && prospectIds.length > BATCH) {
    return refuse(cors, 400, 'bad_request',
      `${prospectIds.length} prospects were named and the batch limit is ${BATCH}. Send them in batches, or pass a list_id and call again until more_pending is false.`);
  }

  const live = payload.confirm === true;
  const force = payload.force === true;

  // ── 1. Who is asking ──────────────────────────────────────────────────────
  // The same two-caller split as broadcast-send, for the same reason: an
  // operator pressing "trace this list" has a session, and the cron run that
  // finishes the remaining four thousand rows an hour later does not.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return refuse(cors, 401, 'not_authenticated', 'Sign in to run a skip trace.');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const isInternal = bearer === SERVICE_KEY;

  let teamId: string | null = null;
  let userId: string | null = null;

  if (isInternal) {
    // A service-key call has no session to resolve a team from, so it must name
    // one. Everything below scopes on team_id by hand — the service role
    // bypasses RLS, so a missing .eq('team_id', …) is a cross-tenant bug rather
    // than an empty result.
    teamId = typeof payload.team_id === 'string' ? payload.team_id : null;
    if (!teamId) return refuse(cors, 400, 'bad_request', 'A service-role call must name team_id.');
  } else {
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) {
      return refuse(cors, 401, 'not_authenticated', 'Your session has expired. Sign in again.');
    }
    userId = user.id;
    const { data: profile } = await admin
      .from('profiles').select('team_id').eq('id', user.id).maybeSingle();
    teamId = profile?.team_id ?? null;
    if (!teamId) return refuse(cors, 403, 'no_team', 'Your account is not on a team yet.');
  }

  // ── 2. The list, if one was named ─────────────────────────────────────────
  let listName: string | null = null;
  if (listId) {
    const { data: list, error: listErr } = await admin
      .from('prospect_lists').select('id, name')
      .eq('id', listId).eq('team_id', teamId).maybeSingle();
    if (listErr) {
      console.error('[skip-trace] list read failed:', listErr.message);
      return refuse(cors, 503, 'select_failed', 'The list could not be read. Nothing was traced.');
    }
    if (!list) return refuse(cors, 404, 'list_not_found', 'That prospect list is not on this team.');
    listName = list.name;
  }

  // ── 3. What needs doing ───────────────────────────────────────────────────
  // Two independent phases per row, which is what makes a failed scrub
  // recoverable at a fifth of a cent instead of four and a half:
  //
  //   needs_trace   never traced (or force)
  //   needs_scrub   has a number and dnc_scrubbed is false
  //
  // A prospect that traced fine and whose scrub 503'd comes back through here
  // as scrub-only. Re-tracing it would pay $0.04 to relearn a number already on
  // the row.
  //
  // Converted prospects are excluded outright: they are leads now, the lead
  // carries its own copy of the trace and the scrub, and spending on the
  // prospect row would buy nothing anybody reads.
  const columns =
    'id, list_id, owner_name, address, city, state, zip, ' +
    'skip_traced, dnc_scrubbed, phone_mobile, phone_landline, phone_voip, raw_data';

  let query = admin.from('prospects').select(columns)
    .eq('team_id', teamId)
    .is('converted_at', null);
  query = listId ? query.eq('list_id', listId) : query.in('id', prospectIds!);

  // "Needs work" goes in the QUERY, not in a loop over an over-fetched window.
  // It was in the loop, and on any list longer than the window that is not a
  // slow path, it is a wrong answer: the database has no idea which rows are
  // finished, so every invocation re-reads the same oldest N and the window
  // never advances. Four batches of a hundred, and a five-thousand-row list
  // starts answering `nothing_to_do` — "everything on this list is already
  // traced and scrubbed" — with 4,600 prospects that have never been touched.
  // The operator is then told a cold list is safe to dial on the strength of a
  // pagination bug.
  //
  // Never traced, OR carrying a number that has not been scrubbed. `force`
  // means every unconverted row needs work, so it gets no filter at all.
  //
  // The phone half is distributed over the three columns rather than written as
  // a nested or() inside the and(), which says the same thing with one level of
  // logic instead of two. Deliberate: this string is parsed by PostgREST, a
  // malformed one 503s the whole function, and the flat shape is the one the
  // filter grammar's own examples use.
  //
  // The phone test is not optional. Without it a traced row that came back with
  // no number would match forever, occupy a slot in every batch, and reinstate
  // the stuck window this filter exists to fix.
  if (!force) {
    query = query.or([
      'skip_traced.is.false',
      'and(dnc_scrubbed.is.false,phone_mobile.not.is.null)',
      'and(dnc_scrubbed.is.false,phone_landline.not.is.null)',
      'and(dnc_scrubbed.is.false,phone_voip.not.is.null)',
    ].join(','));
  }

  const requested = typeof payload.limit === 'number' && payload.limit > 0
    ? Math.floor(payload.limit)
    : BATCH;
  const runCap = Math.max(1, Math.min(BATCH, requested));

  // Rows nothing has ever been spent on come first, then oldest. A trace that
  // fails permanently — input the provider will reject every time — still
  // "needs work" and still sorts oldest-first, so on created_at alone a hundred
  // dead rows at the head of a list would be retried on every invocation and
  // the rest of the list would never be reached. The run stamp written on a
  // trace failure (§8a) is what lets the next pass step over them.
  const { data: rows, error: selectErr } = await query
    .order('skip_trace_run_id', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(runCap);

  if (selectErr) {
    console.error('[skip-trace] prospect read failed:', selectErr.message);
    return refuse(cors, 503, 'select_failed', 'The prospects could not be read. Nothing was traced.');
  }

  type Row = {
    id: string; list_id: string; owner_name: string | null;
    address: string | null; city: string | null; state: string | null; zip: string | null;
    skip_traced: boolean; dnc_scrubbed: boolean;
    phone_mobile: string | null; phone_landline: string | null; phone_voip: string | null;
    raw_data: Record<string, unknown> | null;
  };

  interface Work { row: Row; needsTrace: boolean; needsScrub: boolean }

  const work: Work[] = [];
  // Through `unknown`: the select string is built above rather than inlined, so
  // supabase-js cannot infer the row shape from it and lands on its
  // parse-error type. Row is what the column list actually asks for.
  //
  // The filter is restated here only to decide WHICH half each row needs — the
  // query above already guarantees every row needs one of them. The guard stays
  // so a future change to the filter string cannot silently start working rows
  // that need nothing.
  for (const r of (rows ?? []) as unknown as Row[]) {
    const hasPhone = Boolean(r.phone_mobile || r.phone_landline || r.phone_voip);
    const needsTrace = force || !r.skip_traced;
    // A re-trace ALWAYS needs a re-scrub, even on a row that already reads
    // dnc_scrubbed. The trace can return numbers the previous scrub never saw,
    // and a row carrying new numbers under an old clean bill of health is the
    // same defect as an unchecked scrub — it just took two runs to create.
    const needsScrub = needsTrace || (!r.dnc_scrubbed && hasPhone);
    if (needsTrace || needsScrub) work.push({ row: r, needsTrace, needsScrub });
  }

  if (work.length === 0) {
    // 409 rather than 200: the request was well-formed and cannot proceed, the
    // same shape broadcast-send uses for a campaign that is already finished.
    return refuse(cors, 409, 'nothing_to_do',
      listName
        ? `Everything on "${listName}" is already traced and scrubbed.`
        : 'Those prospects are already traced and scrubbed.',
      { list_id: listId, selected: 0 });
  }

  // ── 4. Cost, stated before it is incurred ─────────────────────────────────
  // The dry run's whole output, and also what the live run reports as its
  // estimate. Counted the way the providers bill: one trace per row that needs
  // one, and one DNC plus one litigator lookup per PHONE NUMBER submitted —
  // which is why an already-traced row costs a known amount and an untraced one
  // can only be guessed at (we do not know how many numbers it will return).
  const traceCandidates = work.filter((w) => w.needsTrace).length;
  const scrubCandidates = work.filter((w) => w.needsScrub);
  // One number per untraced row is the floor, not a promise. Labelled as a
  // minimum in the response rather than dressed up as a forecast.
  const knownNumbers = scrubCandidates.reduce((n, w) => {
    const c = [w.row.phone_mobile, w.row.phone_landline, w.row.phone_voip].filter(Boolean).length;
    return n + (c > 0 ? c : 1);
  }, 0);
  const estimateMicros =
    traceCandidates * TRACE_UNIT_MICROS +
    knownNumbers * (DNC_UNIT_MICROS + LITIGATOR_UNIT_MICROS);

  // ── 5. Credentials, checked before a cent is spent ────────────────────────
  // Named individually, because "the provider is not configured" sends somebody
  // to the wrong settings screen. Both are checked even when only one is needed
  // for this batch: a run that traces successfully and then discovers it cannot
  // scrub has already spent $0.04 a row on numbers nobody may dial.
  //
  // Missing BATCHDATA_API_KEY is a REFUSAL, not a skip. reoperative treated an
  // absent key as "quietly skip the scrub", which is how a whole list gets
  // traced, marked, and dialled without ever having been checked against the
  // litigator file.
  if (live) {
    const missing: string[] = [];
    if (traceCandidates > 0 && !tracerfyConfigured()) missing.push('TRACERFY_API_KEY');
    if (!batchDataConfigured()) missing.push('BATCHDATA_API_KEY');
    if (missing.length > 0) {
      return refuse(cors, 503, 'provider_not_configured',
        `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set in this project's edge function secrets, so nothing was traced and nothing was charged. Set ${missing.length === 1 ? 'it' : 'them'} in Supabase → Edge Functions → Secrets. Until then, run without confirm for a dry run.`,
        {
          missing,
          would_select: work.length,
          estimated_cost_micros: estimateMicros,
          estimated_cost: dollars(estimateMicros),
        });
    }
  }

  // ── 6. The run row ────────────────────────────────────────────────────────
  // Written BEFORE anything is spent, and a failure to write it is a refusal.
  // An unrecorded spend is worse than an unspent one: the money is gone and
  // there is nothing to show for it on the money screen, so the next person to
  // ask what a list cost gets a number that is quietly too low.
  const { data: run, error: runErr } = await admin.from('skip_trace_runs').insert({
    team_id: teamId,
    list_id: listId,
    started_by: userId,
    mode: live ? 'live' : 'dry_run',
    status: 'running',
    trace_provider: live ? TRACE_PROVIDER : null,
    scrub_provider: live ? SCRUB_PROVIDER : null,
    selected_count: work.length,
    trace_unit_micros: TRACE_UNIT_MICROS,
    dnc_unit_micros: DNC_UNIT_MICROS,
    litigator_unit_micros: LITIGATOR_UNIT_MICROS,
  }).select('id').single();

  if (runErr || !run) {
    console.error('[skip-trace] run row insert failed:', runErr?.message);
    return refuse(cors, 503, 'run_not_recorded',
      'The run could not be recorded, so nothing was traced. An unrecorded spend is money with no receipt.');
  }
  const runId = run.id as string;

  // ── 7. The dry run stops here ─────────────────────────────────────────────
  if (!live) {
    await admin.from('skip_trace_runs').update({
      status: 'completed', finished_at: new Date().toISOString(),
    }).eq('id', runId);

    return jsonResponse({
      ok: true,
      dry_run: true,
      run_id: runId,
      list_id: listId,
      list_name: listName,
      selected: work.length,
      would_trace: traceCandidates,
      would_scrub: scrubCandidates.length,
      // "At least", because an untraced row may come back with three numbers and
      // each of them is scrubbed. Never presented as the price.
      minimum_scrub_lookups: knownNumbers,
      estimated_cost_micros: estimateMicros,
      estimated_cost_at_least: dollars(estimateMicros),
      unit_prices: {
        trace: dollars(TRACE_UNIT_MICROS),
        dnc: dollars(DNC_UNIT_MICROS),
        litigator: dollars(LITIGATOR_UNIT_MICROS),
      },
      providers_configured: {
        TRACERFY_API_KEY: tracerfyConfigured(),
        BATCHDATA_API_KEY: batchDataConfigured(),
      },
      message: `${work.length} prospect${work.length === 1 ? '' : 's'} would be worked: ${traceCandidates} traced, ${scrubCandidates.length} scrubbed. At least ${dollars(estimateMicros)}. Nothing was spent — send confirm: true to run it.`,
    }, cors, 200);
  }

  // ── 8. The live run ───────────────────────────────────────────────────────
  const t: Tally = {
    selected: work.length,
    traced: 0, traceFailed: 0, scrubbed: 0, scrubFailed: 0,
    phonesFound: 0, emailsFound: 0, dncHits: 0, litigatorHits: 0,
    traceLookups: 0, dncLookups: 0, litigatorLookups: 0,
    failures: [],
  };

  const touchedLists = new Set<string>();
  const startedAt = Date.now();
  let processed = 0;

  const note = (prospectId: string, phase: string, error: string) => {
    // Bounded, because `failures` sits in one jsonb column and a provider
    // outage would otherwise put the entire batch in it. The counters stay
    // exact either way — they are what the retry query is driven from.
    if (t.failures.length < BATCH) {
      t.failures.push({ prospect_id: prospectId, phase, error: error.slice(0, 500) });
    }
  };

  for (const w of work) {
    // Stop on a predictable boundary rather than being killed mid-prospect. A
    // process that dies between the trace and the scrub leaves a row traced and
    // unscrubbed — recoverable, and prospect_is_callable already refuses it, but
    // it is a row somebody has to notice.
    if (Date.now() - startedAt > BUDGET_MS) break;
    if (processed > 0 && INTERVAL_MS > 0) await sleep(INTERVAL_MS);
    processed++;

    const r = w.row;
    touchedLists.add(r.list_id);

    const updates: Record<string, unknown> = { skip_trace_run_id: runId };
    let phones: TracedPhone[] = [];
    let emails: TracedEmail[] = [];
    let confidence: number | null = null;
    let traceRaw: unknown = null;

    // ── 8a. trace ───────────────────────────────────────────────────────────
    if (w.needsTrace) {
      const name = (r.owner_name ?? '').trim();
      const space = name.indexOf(' ');
      const traceOut = await tracerfyPost('/v1/api/trace/lookup/', {
        first_name: space > 0 ? name.slice(0, space) : name,
        last_name: space > 0 ? name.slice(space + 1) : '',
        address: r.address ?? '',
        city: r.city ?? '',
        state: r.state ?? '',
        zip: r.zip ?? '',
      });

      if (!traceOut.ok) {
        // After the retry budget this is either permanent (bad input) or an
        // exhausted transient. Either way we learned nothing, so no trace fact
        // is written: skip_traced stays false and the row is picked up again
        // next run. Marking it traced with no numbers would retire it
        // permanently.
        //
        // The run id IS written, and it is the only thing written. Two reasons.
        // A row whose trace fails every time is otherwise indistinguishable
        // from one nothing has ever run against, which is the gap
        // 20260822130000 exists to close for the scrub half and left open for
        // this one. And the selection above orders un-stamped rows first, so
        // without the stamp the same dead rows would be re-tried on every
        // invocation and the rest of the list would never be reached.
        console.error(`[skip-trace] trace failed for ${r.id}: ${traceOut.status} ${traceOut.error}`);
        t.traceFailed++;
        note(r.id, 'trace', traceOut.error ?? `Tracerfy ${traceOut.status}`);
        const { error: stampErr } = await admin.from('prospects')
          .update({ skip_trace_run_id: runId }).eq('id', r.id).eq('team_id', teamId);
        if (stampErr) console.error(`[skip-trace] could not stamp ${r.id}: ${stampErr.message}`);
        continue;
      }

      t.traceLookups++;
      const parsed = parseTrace(traceOut.data);
      phones = parsed.phones;
      emails = parsed.emails;
      confidence = parsed.confidence;
      traceRaw = parsed.raw;

      t.traced++;
      t.phonesFound += phones.length;
      t.emailsFound += emails.length;

      updates.skip_traced = true;
      updates.skip_traced_at = new Date().toISOString();
      updates.skip_trace_provider = TRACE_PROVIDER;
      // Null when the provider did not say. See TraceResult.confidence.
      updates.skip_trace_confidence = confidence;
      // Verified first, provider order otherwise — Array.sort is stable, so the
      // provider's own ranking survives among equals. Taking [0] and [1] off
      // that ordering rather than indexing the raw array: picking the verified
      // address for primary and then `emails[1]` for secondary writes the SAME
      // address into both columns whenever the verified one happened to be
      // second, which reads as two corroborating contacts and is one.
      //
      // Both are written unconditionally, like the phone columns below and for
      // the same reason: this pass re-traced the record, so what it did not
      // find is not still true from last time.
      const ranked = [...emails].sort(
        (a, b) => Number(b.verified === true) - Number(a.verified === true),
      );
      updates.email_primary = ranked[0]?.address ?? null;
      updates.email_secondary = ranked[1]?.address ?? null;
    } else {
      // Scrub-only: the numbers already on the row are what gets checked. Line
      // type is carried over from the column each one lives in, which is the
      // only record of it we have once the trace response is gone.
      if (r.phone_mobile) phones.push({ number: r.phone_mobile, type: 'mobile' });
      if (r.phone_landline) phones.push({ number: r.phone_landline, type: 'landline' });
      if (r.phone_voip) phones.push({ number: r.phone_voip, type: 'voip' });
    }

    // ── 8b. scrub ───────────────────────────────────────────────────────────
    // The half that is not allowed to fail quietly.
    let scrubbed = false;
    let scrubError: string | null = null;

    if (phones.length === 0) {
      // Nothing to check. dnc_scrubbed stays false — not because this row is
      // unsafe, but because the counter has to mean "checked against the files",
      // and a list reporting "scrubbed: 5,000 of 5,000" when nine hundred of
      // them had no number is the kind of figure somebody relies on.
      // prospect_is_callable refuses it anyway for having no phone.
      scrubError = w.needsTrace
        ? 'The trace returned no phone number, so there was nothing to scrub.'
        : null;
    } else if (w.needsScrub) {
      const numbers = phones.map((p) => p.number);
      const keys = numbers.map(digits10);
      const body = { requests: numbers.map((phone) => ({ phone })) };

      const dncOut = await batchDataPost('/phone/dnc', body);
      const litOut = dncOut.ok ? await batchDataPost('/phone/litigator', body) : null;

      if (!dncOut.ok) {
        scrubError = `The DNC check did not answer: ${dncOut.error ?? dncOut.status}`;
      } else if (!litOut || !litOut.ok) {
        // Counted even though the run as a whole failed for this prospect: the
        // DNC lookup answered, so it will be on the invoice.
        t.dncLookups += numbers.length;
        scrubError = `The litigator check did not answer: ${litOut?.error ?? litOut?.status}`;
      } else {
        t.dncLookups += numbers.length;
        t.litigatorLookups += numbers.length;

        const dncMap = parseScrub(dncOut.data, DNC_KEYS);
        const litMap = parseScrub(litOut.data, LITIGATOR_KEYS);

        // COMPLETENESS, not just a 200. Every number we submitted must come
        // back with an explicit answer. A response whose shape we cannot read,
        // or that silently dropped a number, leaves that number unchecked — and
        // reoperative's loop would have left its flag false, which reads as
        // "checked and clean" to everything downstream.
        const missing = !dncMap || !litMap
          ? keys
          : keys.filter((k) => !dncMap.has(k) || !litMap.has(k));

        if (missing.length > 0) {
          scrubError = `The scrub came back without an answer for ${missing.length} of ${keys.length} number${keys.length === 1 ? '' : 's'}. An unanswered number is an unchecked number.`;
        } else {
          for (const p of phones) {
            const k = digits10(p.number);
            p.dnc = dncMap!.get(k);
            p.litigator = litMap!.get(k);
          }
          scrubbed = true;
        }
      }
    }

    if (scrubbed) {
      const anyDnc = phones.some((p) => p.dnc === true);
      const anyLitigator = phones.some((p) => p.litigator === true);
      const cleanLeft = phones.some((p) => p.dnc !== true && p.litigator !== true);

      // THE ASYMMETRY, and it is deliberate.
      //
      // DNC registration is a property of a NUMBER. If the mobile is listed and
      // the landline is not, the landline may be called — so is_dnc goes true
      // only when nothing clean survived. The listed number is simply not kept
      // in a dialable column.
      //
      // A litigator flag is a property of a PERSON. Somebody who sues over cold
      // calls will sue over the call to their other phone as well, and the whole
      // point of paying two-tenths of a cent is to never speak to them. So one
      // litigator hit anywhere on the record suppresses the record.
      updates.is_dnc = anyDnc && !cleanLeft;

      // And because it is a fact about the person rather than about a number,
      // it is written ONE WAY. Recomputing it would have a later scrub lift the
      // suppression on its own: a force re-trace that returns a mobile the
      // previous trace never found asks the litigator file about a DIFFERENT
      // number, gets "clean", and un-suppresses somebody the last scrub told us
      // to never call — the prospect goes straight back into the dial queue and
      // the $500-$1,500-per-call plaintiff gets dialled. Clearing it is a
      // deliberate act on the row, the way clear_lead_dnc() is for a lead;
      // there is no automated path back. is_dnc above is recomputed precisely
      // because it is per-number and the numbers on the row just changed.
      if (anyLitigator) updates.is_litigator = true;

      updates.dnc_scrubbed = true;
      updates.dnc_scrubbed_at = new Date().toISOString();
      updates.scrub_error = null;

      if (anyDnc) t.dncHits++;
      if (anyLitigator) t.litigatorHits++;
      t.scrubbed++;
    } else if (w.needsScrub) {
      // THE COMPLIANCE BRANCH. dnc_scrubbed is written FALSE rather than left
      // alone, because "left alone" is only safe on a row that was never
      // scrubbed. On a re-traced row it would preserve a previous run's true
      // over numbers this run just replaced — which is precisely the state
      // prospect_is_callable trusts.
      //
      // is_dnc and is_litigator are NOT reset. A litigator hit from an earlier
      // scrub is a fact about the person, and a check that failed today is no
      // reason to forget it. Suppression only ever gets lifted deliberately.
      updates.dnc_scrubbed = false;
      updates.dnc_scrubbed_at = null;

      if (phones.length > 0) {
        t.scrubFailed++;
        if (scrubError) note(r.id, 'scrub', scrubError);
        console.warn(`[skip-trace] scrub incomplete for ${r.id}: ${scrubError}`);
      }
    }

    if (scrubError !== null) updates.scrub_error = scrubError;

    // ── 8c. the numbers we keep ─────────────────────────────────────────────
    // Only written when the trace ran: a scrub-only pass must not rewrite
    // columns from data it did not fetch. When a scrub found a flagged number,
    // pick() drops it and the column goes null — which is the removal doing its
    // job, not data loss, because the full result is preserved below.
    if (w.needsTrace) {
      updates.phone_mobile = pick(phones, 'mobile');
      updates.phone_landline = pick(phones, 'landline');
      updates.phone_voip = pick(phones, 'voip');
    } else if (scrubbed) {
      // Scrub-only, and it found something. Clear whichever existing columns
      // are now flagged; leave the rest. Without this a landline that turns up
      // on the litigator file on a re-scrub would stay in a dialable column.
      for (const [col, type] of [
        ['phone_mobile', 'mobile'], ['phone_landline', 'landline'], ['phone_voip', 'voip'],
      ] as Array<[string, LineType]>) {
        const current = (r as unknown as Record<string, string | null>)[col];
        if (!current) continue;
        const hit = phones.find((p) => p.number === current);
        if (hit && (hit.dnc === true || hit.litigator === true)) updates[col] = null;
      }
    }

    // Everything the providers said, kept verbatim under its own key. This is
    // the evidence that the scrub happened and what it found, including the
    // numbers deliberately not kept above — the DNC file is not queryable after
    // the fact and "we checked" has to be provable.
    //
    // The trace half is carried forward when this pass did not trace. A
    // scrub-only retry costs two-fifths of a cent and must not be able to
    // destroy the $0.04 trace record it is standing on: without this, a
    // re-scrub after a provider outage would rewrite the stamp with a null
    // confidence and no provider response, and the evidence of where those
    // phone numbers came from would be gone.
    //
    // NOTHING MAY DIAL FROM raw_data. It is a record, not a phone book.
    const prior = ((r.raw_data ?? {}).skip_trace ?? {}) as Record<string, unknown>;
    const stamp = {
      run_id: runId,
      at: new Date().toISOString(),
      trace_provider: w.needsTrace ? TRACE_PROVIDER : (prior.trace_provider ?? null),
      scrub_provider: w.needsScrub ? SCRUB_PROVIDER : (prior.scrub_provider ?? null),
      confidence: w.needsTrace ? confidence : (prior.confidence ?? null),
      scrubbed,
      scrub_error: scrubError,
      phones: phones.map((p) => ({
        number: p.number, type: p.type, connected: p.connected ?? null,
        dnc: p.dnc ?? null, litigator: p.litigator ?? null,
      })),
      emails: w.needsTrace
        ? emails.map((e) => ({ address: e.address, verified: e.verified ?? null }))
        : (prior.emails ?? []),
      trace_raw: w.needsTrace ? traceRaw : (prior.trace_raw ?? null),
    };
    updates.raw_data = { ...(r.raw_data ?? {}), skip_trace: stamp };

    const { error: updErr } = await admin.from('prospects')
      .update(updates).eq('id', r.id).eq('team_id', teamId);
    if (updErr) {
      // The lookups were paid for and the result is gone. Loud, and counted as
      // both a trace and a scrub failure so the retry query picks the row up
      // again — paying twice is better than dialling an unscrubbed number.
      console.error(`[skip-trace] could not save results for ${r.id}: ${updErr.message}`);
      note(r.id, 'save', updErr.message);
      if (w.needsTrace) { t.traced--; t.traceFailed++; }
      if (scrubbed) { t.scrubbed--; t.scrubFailed++; }
    }
  }

  // ── 9. List counters ──────────────────────────────────────────────────────
  // refresh_prospect_list_counts recomputes rather than increments, which is
  // what makes it safe to call once per list at the end of a batch instead of
  // per row. Non-fatal: the trace and the scrub are already saved, and failing
  // the whole call over a denormalised counter would invite a re-run that pays
  // for all of it again.
  for (const l of touchedLists) {
    const { error } = await admin.rpc('refresh_prospect_list_counts', { p_list_id: l });
    if (error) console.error('[skip-trace] counter refresh failed (non-fatal):', error.message);
  }

  // ── 10. Close the run ─────────────────────────────────────────────────────
  const spentMicros =
    t.traceLookups * TRACE_UNIT_MICROS +
    t.dncLookups * DNC_UNIT_MICROS +
    t.litigatorLookups * LITIGATOR_UNIT_MICROS;

  // 'failed' only when the run accomplished nothing at all — a provider outage,
  // not a handful of bad rows. A run that traced ninety and lost ten is a
  // completed run with ten in scrub_failed_count, and calling it 'failed' would
  // hide the ninety.
  const status = (t.traced === 0 && t.scrubbed === 0) && (t.traceFailed > 0 || t.scrubFailed > 0)
    ? 'failed'
    : 'completed';

  const { error: closeErr } = await admin.from('skip_trace_runs').update({
    status,
    finished_at: new Date().toISOString(),
    selected_count: processed,
    traced_count: t.traced,
    trace_failed_count: t.traceFailed,
    scrubbed_count: t.scrubbed,
    scrub_failed_count: t.scrubFailed,
    phones_found: t.phonesFound,
    emails_found: t.emailsFound,
    dnc_hits: t.dncHits,
    litigator_hits: t.litigatorHits,
    trace_lookups: t.traceLookups,
    dnc_lookups: t.dncLookups,
    litigator_lookups: t.litigatorLookups,
    failures: t.failures,
    error: status === 'failed' ? 'Every prospect in this batch failed; the provider is probably down.' : null,
  }).eq('id', runId);
  if (closeErr) console.error('[skip-trace] run close failed:', closeErr.message);

  return jsonResponse({
    ok: true,
    dry_run: false,
    run_id: runId,
    list_id: listId,
    status,
    selected: processed,
    traced: t.traced,
    trace_failed: t.traceFailed,
    scrubbed: t.scrubbed,
    // Called out at the top level rather than buried in the tally: every one of
    // these is a prospect the dialer will not touch until somebody runs this
    // again, and the UI should say so rather than report a clean batch.
    scrub_failed: t.scrubFailed,
    phones_found: t.phonesFound,
    emails_found: t.emailsFound,
    dnc_hits: t.dncHits,
    litigator_hits: t.litigatorHits,
    lookups: {
      trace: t.traceLookups,
      dnc: t.dncLookups,
      litigator: t.litigatorLookups,
    },
    estimated_cost_micros: spentMicros,
    estimated_cost: dollars(spentMicros),
    failures: t.failures,
    elapsed_ms: Date.now() - startedAt,
    // The caller's cue to invoke again: the batch cap or the wall-clock budget
    // stopped us, not the work running out.
    more_pending: processed < work.length || work.length >= runCap,
    message: t.scrubFailed > 0
      ? `${t.traced} traced, ${t.scrubbed} scrubbed, and ${t.scrubFailed} could not be checked against the DNC and litigator files. Those ${t.scrubFailed} stay out of the dial queue until this is run again. About ${dollars(spentMicros)}.`
      : `${t.traced} traced, ${t.scrubbed} scrubbed, ${t.dncHits} on the DNC list and ${t.litigatorHits} flagged as litigators. About ${dollars(spentMicros)}.`,
  }, cors, 200);
});
