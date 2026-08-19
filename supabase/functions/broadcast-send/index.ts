// ============================================================================
// broadcast-send — drains one broadcast campaign's recipient ledger.
// ============================================================================
// Ported from reoperative's functions/broadcast-send/index.ts (3,006 lines,
// six channels, a wallet, a price book and an AI copywriter). What is kept is
// the only part that was hard: the atomic claim, the retry budget, the
// per-recipient state machine and idempotency. Everything else was SaaS.
//
// THE ONE RULE. This function does not talk to Twilio. Every message is handed
// to twilio-send-sms, which owns both kill switches, the opt-out list,
// lead_is_dialable(), the A2P and sms_enabled checks on the sending number, and
// the 8am-9pm window in the CALLED PARTY's local time. reoperative's version
// POSTed to api.twilio.com directly from this file, with a hand-written
// eligibility check beside it; that is two rails, and the one that drifts is
// the one that texts a buyer who said STOP — at two hundred a minute, which is
// the worst possible way to find out. The HTTP hop costs milliseconds against a
// send pace measured in whole seconds, so there is no throughput argument for
// going around it. There is no Twilio credential in this file and there must
// never be one.
//
// WHAT MATERIALISE ALREADY DECIDED, AND WHAT IS RE-DECIDED HERE.
// materialise_campaign froze the audience: one row per distinct number,
// including every suppressed one, each carrying its skip reason and its frozen
// match score. That happened when the operator hit preview, which may have been
// hours ago. Consent is not a fact about the past, so two things are re-asked at
// send time: buyer_skip_reason() for every buyer in the batch (a buyer who was
// paused, blacklisted, or who texted STOP since preview), and — for a leads
// audience — lead_is_dialable(), which twilio-send-sms runs itself the moment we
// pass it a lead_id. Passing lead_id is therefore not optional; it is how the
// consent-basis gate gets applied to this path at all.
//
// QUEUED BEFORE SENT, AND NEVER AUTOMATICALLY REQUEUED. The recipient row moves
// to 'queued' BEFORE twilio-send-sms is called, not after. reoperative left the
// row 'pending' across the call and leaned on an idempotency key, which does not
// actually hold: twilio-send-sms replaces its 'pending:' claim token with the
// real SID the instant Twilio accepts, so a worker that dies in that window
// leaves nothing for a replay to collide with, and the stale-claim reaper hands
// the row to a second worker ten minutes later, which sends it again. Writing
// 'queued' first converts that duplicate into a stranded row: visible in
// queued_count, countable, and fixable by a person. There is deliberately no
// automatic requeue of stuck 'queued' rows, because an automatic requeue is
// precisely the duplicate text this design exists to prevent. A stranded row is
// a question; a second text to a cash buyer is an answer nobody wanted.
//
// PACING. Tossie's A2P 10DLC campaign is registered Low Volume Mixed, the
// lowest-throughput tier there is. Blasting past the carrier's cap does not
// bounce — it gets filtered, silently, and repeated filtering is what gets a
// campaign suspended. So sends are paced to one per second by default and the
// time spent waiting is reported back and written into the deal event, because
// "the blast took four minutes" is the only way anyone finds out the pacing is
// working. The exact carrier figures are a property of Tossie's registration,
// not of this file, so they live in edge secrets (BROADCAST_MPS,
// BROADCAST_DAILY_CAP) rather than as constants somebody guessed.
//
// ONE BATCH PER INVOCATION. The function claims a bounded batch, drains it
// inside a wall-clock budget, releases whatever it still holds and returns
// `more_pending`. Cron or the UI calls it again. A loop that tries to finish a
// 400-buyer campaign in one invocation gets killed by the platform mid-send,
// which is the exact state the paragraph above is about.
//
// Request:  POST { campaign_id, confirm?, limit? }
//   confirm  required only to move a campaign out of 'draft'. Calling without
//            it returns the ledger and sends nothing — that is the preview, and
//            making it a refusal rather than a separate endpoint is what stops
//            "blast every buyer" from being one click.
//   limit    shrink the batch. Cannot grow it past BROADCAST_BATCH.
//
// Refusal reasons, all of which the UI should be able to render:
//   method_not_allowed      not a POST
//   not_configured          the Supabase environment is incomplete
//   bad_request             no campaign_id
//   not_authenticated       missing or invalid JWT
//   no_team                 signed in but not on a team
//   campaign_not_found      no such campaign on this team
//   unsupported_channel     channel is not 'sms'
//   not_materialised        the audience was never frozen; nothing to send
//   not_confirmed           draft campaign, no confirm:true — the preview
//   campaign_paused         somebody stopped it; resume it deliberately
//   campaign_finished       already 'sent' or 'failed'
//   unknown_placeholder     the body uses a {{token}} this function cannot fill
//   unresolved_placeholder  a known token that is empty on this deal
//   body_too_long           the body renders past 1600 characters
//   daily_cap_reached       BROADCAST_DAILY_CAP is set and today is spent
//   send_blocked            twilio-send-sms refused in a way that affects every
//                           recipient (kill switch, A2P, no sending number).
//                           The campaign is paused; a human has to act.
//   send_unavailable        the same, but transient. Status stays 'sending' so
//                           the next cron run picks it up.
//
// Edge secrets (Supabase → Edge Functions → Secrets):
//   BROADCAST_MPS        messages per second. Default 1.
//   BROADCAST_BATCH      max recipients per invocation. Default 100.
//   BROADCAST_BUDGET_MS  wall-clock budget per invocation. Default 90000.
//   BROADCAST_DAILY_CAP  optional. Team-wide sends per UTC day; unset = no cap.
//
// Deploy with verify_jwt = true. Both callers present a JWT: an operator's
// session, or the service key from cron. Nothing here is safe to expose
// unauthenticated — it is the trigger on a bulk send.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// No TWILIO_* here, deliberately, and no import of calling-window.ts or
// phone-validation.ts either. This function must not be able to answer a
// compliance question on its own; the only correct answer is whatever
// twilio-send-sms says.

function envInt(name: string, fallback: number): number {
  const n = parseInt(Deno.env.get(name) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// One message per second unless told otherwise. Chosen as the pace, not as a
// belief about the carrier's ceiling: pacing below the cap costs seconds, and
// exceeding it costs filtered traffic that nobody sees fail.
const MPS = envInt('BROADCAST_MPS', 1);
const BATCH = envInt('BROADCAST_BATCH', 100);
const BUDGET_MS = envInt('BROADCAST_BUDGET_MS', 90_000);

// Unset means uncapped. A number invented here would be worse than no number:
// it would look authoritative and be wrong the day the campaign is upgraded.
const DAILY_CAP = parseInt(Deno.env.get('BROADCAST_DAILY_CAP') ?? '', 10);

// Six tries, matching reoperative's budget. What this retries is transient —
// Twilio 5xx, a lost response, a momentarily locked row — and those clear in
// minutes. Anything still failing on the sixth attempt is a bad number or a
// carrier block, and needs a person rather than a longer sleep. The interval
// between them is broadcast_next_retry() in SQL, not a constant here, because
// the claim query filters on next_retry_at and the two have to agree.
const MAX_ATTEMPTS = 6;

// Twilio's hard ceiling on one body, and the threshold twilio-send-sms answers
// `bad_request` on. The CHECK on broadcast_campaigns.body caps the TEMPLATE at
// 1600; "{{address}}" is eleven characters that become forty, so the rendered
// text is the thing that has to be measured. Unmeasured it comes back as
// bad_request, which is in HALT_AND_PAUSE — one long buyer name would stop the
// whole campaign and read as an account-level block.
const MAX_BODY_CHARS = 1600;

// A hung hand-off is the one failure the budget cannot bound on its own: fetch
// has no default timeout, so a twilio-send-sms that never answers holds the
// invocation until the platform kills it, and the row it was holding stays
// 'queued' forever — a state this design deliberately never auto-requeues. The
// timeout converts that into an ordinary 'retry' that replays the same
// idempotency key. Well under the five-minute claim grace, so a timed-out row
// is never in flight at the same time as a second worker's copy of it.
const SEND_TIMEOUT_MS = 30_000;

function refuse(
  cors: Record<string, string>,
  status: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse({ ok: false, reason, message, ...extra }, cors, status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── template rendering ─────────────────────────────────────────────────────
// Substitution happens here rather than in SQL because the body is stored raw
// on purpose: the audit has to show what was authored, and what was authored is
// the thing with the {{tokens}} still in it.
//
// The token set is closed. An open one — "substitute anything that looks like a
// column" — is how a body ends up quoting a number the buyer was never meant to
// see, and the number a wholesaler most has to keep straight is which of the
// two spreads he is quoting. {{spread}} is buyer_spread, which subtracts
// Tossie's assignment fee. There is deliberately no token for the wholesaler's
// own margin.
const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

interface Rendered {
  text: string;
  /** Tokens this function has no value for at all. A composer bug. */
  unknown: string[];
  /** Known tokens whose value is null or blank on this deal or this contact. */
  empty: string[];
}

function renderTemplate(template: string, values: Record<string, string | null>): Rendered {
  const unknown = new Set<string>();
  const empty = new Set<string>();
  const text = template.replace(TOKEN, (_match, raw: string) => {
    const key = raw.toLowerCase();
    if (!(key in values)) {
      unknown.add(key);
      return '';
    }
    const v = values[key];
    if (v === null || v === '') {
      empty.add(key);
      return '';
    }
    return v;
  });
  return { text, unknown: [...unknown], empty: [...empty] };
}

/** Whole dollars with a $ and thousands separators. The schema stores integers. */
function money(v: unknown): string | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US')}` : null;
}

/** numeric(4,1) arrives as a string. "3.0" reads wrong in a text; "3" does not. */
function decimal(v: unknown): string | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function plain(v: unknown): string | null {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
}

function count(v: unknown): string | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : null;
}

/** The deal half of the token map. Every key exists even when the deal does not. */
function dealValues(deal: Record<string, unknown> | null): Record<string, string | null> {
  const d = deal ?? {};
  return {
    address: plain(d.address),
    city: plain(d.city),
    state: plain(d.state),
    zip: plain(d.zip),
    county: plain(d.county),
    property_type: plain(d.property_type),
    rehab_level: plain(d.rehab_level),
    occupancy: plain(d.occupancy),
    beds: decimal(d.beds),
    baths: decimal(d.baths),
    sqft: count(d.sqft),
    year_built: d.year_built ? String(d.year_built) : null,
    // buyer_price and buyer_spread, never contract_price and never the
    // wholesaler's margin. These are the two numbers the buyer checks.
    price: money(d.buyer_price),
    arv: money(d.arv_estimate),
    repairs: money(d.repair_estimate),
    spread: money(d.buyer_spread),
  };
}

/** The first token of a name. "Marcus Webb Holdings LLC" greets as "Marcus". */
function firstName(full: string | null): string | null {
  if (!full) return null;
  const first = full.trim().split(/\s+/)[0];
  return first || null;
}

// ─── the outcome of one hand-off to twilio-send-sms ─────────────────────────
// Five shapes, and the difference between them is the whole state machine.
//
//   sent   it went out. Record the SID.
//   skip   terminal, and the reason is in the closed skip vocabulary. The
//          recipient will never be tried again in this campaign.
//   defer  the calling window is shut. NOT a failure — the buyer is fine, the
//          clock is wrong — so it goes back to pending with next_retry_at at
//          the moment the window reopens.
//   retry  transient, or an outcome we cannot determine. Back to pending on the
//          SQL backoff.
//   halt   nothing about this recipient; a rail that applies to every recipient
//          in the campaign. Stop the run rather than collecting two hundred
//          identical refusals — and in the a2p_not_approved case, rather than
//          logging two hundred failed attempts against a brand under review.
type Outcome =
  | { kind: 'sent'; sid: string | null }
  | { kind: 'skip'; reason: string; error: string }
  | { kind: 'defer'; until: string | null; error: string }
  | { kind: 'retry'; error: string }
  | { kind: 'halt'; pause: boolean; error: string };

// Refusals that are a property of the account, not of this contact. Every one
// of them will answer the same way for the next recipient.
const HALT_AND_PAUSE = new Set([
  'sms_send_disabled',      // owner-only hard kill; somebody meant this
  'sms_send_paused',        // operator pause in telephony settings
  'a2p_not_approved',       // the registration is not clear; do not keep trying
  'number_not_sms_enabled', // the sending number is voice-only
  'no_sending_number',      // nothing pinned, defaulted or primary
  'bad_request',            // our payload is malformed — a bug, not a blip
]);

const HALT_AND_RETRY = new Set([
  'kill_switch_check_failed',  // could not read the switches; fails closed
  'suppression_check_failed',  // could not read the opt-out list; fails closed
  'twilio_not_configured',     // secrets missing
  'not_configured',
  'not_authenticated',
  'no_team',
  'method_not_allowed',
]);

// Per-recipient refusals that have an exact entry in the skip vocabulary. These
// are recorded under their own reason rather than lumped into 'send_refused',
// because the skip breakdown is the point of the ledger and "send_refused: 4"
// is the uncountable free text the schema comment warns about. The raw refusal
// still goes into `error` either way.
const SKIP_REASON_FOR: Record<string, string> = {
  opted_out: 'opted_out',
  lead_dnc: 'dnc',
  lead_litigator: 'litigator',
  unsupported_destination: 'phone_invalid',
};

function classify(
  httpOk: boolean,
  payload: Record<string, any>,
  priorAttempts: number,
  /**
   * lead_skip_reason() for this recipient's lead, when it has one.
   * twilio-send-sms answers 'lead_not_dialable' for four different situations —
   * trashed, phone_invalid, no consent basis, opted out on the other number —
   * and filing all four under one label would make the skip breakdown claim a
   * consent problem where there was a data problem. This is the same CASE the
   * gate reads, used only to name what the gate decided.
   */
  leadSkip: string | null,
): Outcome {
  if (httpOk && payload?.sent === true) {
    return { kind: 'sent', sid: typeof payload.twilio_sid === 'string' ? payload.twilio_sid : null };
  }

  const reason = typeof payload?.reason === 'string' ? payload.reason : 'unknown';
  const detail = typeof payload?.message === 'string' ? payload.message : reason;

  if (HALT_AND_PAUSE.has(reason)) return { kind: 'halt', pause: true, error: detail };
  if (HALT_AND_RETRY.has(reason)) return { kind: 'halt', pause: false, error: detail };

  if (reason === 'outside_texting_window') {
    return {
      kind: 'defer',
      until: typeof payload.next_open_at === 'string' ? payload.next_open_at : null,
      error: detail,
    };
  }

  // twilio-send-sms's idempotency answered. Two very different situations wear
  // the same reason, and the attempt count tells them apart.
  if (reason === 'duplicate_send') {
    // A real SID means the message is already with the carrier — its content
    // dedup matched a send that succeeded. That is the idempotency working, and
    // the honest record is 'sent'. A 'pending:' claim token is not a SID and
    // must never be stored as one.
    const sid = typeof payload.twilio_sid === 'string' && !payload.twilio_sid.startsWith('pending:')
      ? payload.twilio_sid
      : null;
    if (sid) return { kind: 'sent', sid };

    // No SID, and we have been here before: this is our own stranded claim
    // token from an earlier attempt whose response was lost. twilio-send-sms
    // holds that token precisely so a retry cannot become a second text, which
    // means every future attempt will get this same answer. The message may or
    // may not have reached the buyer, and 'failed' is the closest the status
    // vocabulary comes to "unknown" — so the truth goes in `error` where a
    // human will read it.
    if (priorAttempts > 0) {
      return {
        kind: 'skip',
        reason: 'send_refused',
        error: `A previous attempt's outcome is unknown — twilio-send-sms is still holding its claim on this send, so it may or may not have reached the buyer. Check the thread before texting again. (${detail})`,
      };
    }

    // First attempt, no SID: somebody sent this exact text to this number
    // concurrently. The one-minute backoff lands inside twilio-send-sms's
    // 120-second content-dedup window, so the retry will either find the
    // finished send and record its SID, or send properly if that one failed.
    return { kind: 'retry', error: detail };
  }

  const mapped = SKIP_REASON_FOR[reason];
  if (mapped) return { kind: 'skip', reason: mapped, error: detail };

  if (reason === 'lead_not_dialable') {
    // 'send_refused' when the explanation query came back empty — better an
    // uncounted skip than a counted one that names the wrong cause.
    return { kind: 'skip', reason: leadSkip ?? 'send_refused', error: detail };
  }

  if (reason === 'lead_not_found') {
    return { kind: 'skip', reason: 'send_refused', error: detail };
  }

  // lead_check_failed and not_recorded both state plainly that nothing was
  // sent, so retrying them is safe. twilio_error does not: twilio-send-sms uses
  // that one reason both for a Twilio rejection (definitely not sent) and for a
  // request whose response was lost (unknown). Retrying is still correct — the
  // lost-response case is holding a claim token and will come back as
  // duplicate_send above rather than as a second text.
  return { kind: 'retry', error: detail };
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

  const campaignId = typeof payload.campaign_id === 'string' ? payload.campaign_id : '';
  if (!campaignId) return refuse(cors, 400, 'bad_request', 'campaign_id is required.');
  const confirmed = payload.confirm === true;

  // ── 1. Who is asking ──────────────────────────────────────────────────────
  // The same two-caller split as twilio-send-sms, for the same reason: an
  // operator pressing send has a session, and the cron run that finishes the
  // campaign forty minutes later does not.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return refuse(cors, 401, 'not_authenticated', 'Sign in to send a campaign.');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const isInternal = bearer === SERVICE_KEY;

  let teamId: string | null = null;
  if (!isInternal) {
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) {
      return refuse(cors, 401, 'not_authenticated', 'Your session has expired. Sign in again.');
    }
    const { data: profile } = await admin
      .from('profiles').select('team_id').eq('id', user.id).maybeSingle();
    teamId = profile?.team_id ?? null;
    if (!teamId) return refuse(cors, 403, 'no_team', 'Your account is not on a team yet.');
  }

  // ── 2. The campaign ───────────────────────────────────────────────────────
  // Everything past here runs on the service role, which bypasses RLS, so the
  // team scoping is by hand on every query. A missing .eq('team_id', …) is a
  // cross-tenant bug rather than an empty result.
  let campaignQuery = admin
    .from('broadcast_campaigns')
    .select('id, team_id, name, audience_kind, deal_id, body, channel, status, materialised_at, total_recipients, skipped_count, pending_count, queued_count, sent_count, delivered_count, failed_count')
    .eq('id', campaignId);
  if (teamId) campaignQuery = campaignQuery.eq('team_id', teamId);

  const { data: campaign, error: campaignErr } = await campaignQuery.maybeSingle();
  if (campaignErr) {
    console.error('[broadcast-send] campaign read failed:', campaignErr.message);
    return refuse(cors, 503, 'send_unavailable', 'The campaign could not be read. Nothing was sent.');
  }
  if (!campaign) return refuse(cors, 404, 'campaign_not_found', 'That campaign is not on this team.');
  teamId = campaign.team_id;

  if (campaign.channel !== 'sms') {
    return refuse(cors, 400, 'unsupported_channel',
      `This worker only sends SMS; that campaign's channel is "${campaign.channel}".`);
  }
  if (!campaign.materialised_at) {
    return refuse(cors, 409, 'not_materialised',
      'The audience has not been frozen yet. Run materialise_campaign() first — the recipient ledger is what makes a send auditable, and there is nothing to send without it.');
  }

  const ledger = () => ({
    total_recipients: campaign.total_recipients,
    pending_count: campaign.pending_count,
    queued_count: campaign.queued_count,
    skipped_count: campaign.skipped_count,
    sent_count: campaign.sent_count,
    delivered_count: campaign.delivered_count,
    failed_count: campaign.failed_count,
  });

  /**
   * Skips grouped by reason. The breakdown is the A2P segmentation evidence.
   * A const rather than a hoisted declaration so it reads `campaign` as the
   * non-null it was checked to be above.
   */
  const skipBreakdown = async (): Promise<Record<string, number>> => {
    const { data } = await admin
      .from('broadcast_recipients')
      .select('skip_reason')
      .eq('campaign_id', campaignId)
      .eq('status', 'skipped');
    const out: Record<string, number> = {};
    for (const row of data ?? []) {
      const k = row.skip_reason ?? 'unknown';
      out[k] = (out[k] ?? 0) + 1;
    }
    // PostgREST truncates a select at its max-rows ceiling, so a large
    // suppressed set comes back short — and a breakdown that silently totals
    // less than skipped_count understates the exact number it exists to prove.
    // Naming the shortfall keeps the two figures reconcilable.
    const counted = Object.values(out).reduce((a, b) => a + b, 0);
    const shortfall = (campaign.skipped_count ?? 0) - counted;
    if (shortfall > 0) out.unreported = shortfall;
    return out;
  };

  // ── 3. Starting is a separate decision from sending ───────────────────────
  // A draft with a frozen audience is a loaded gun. Calling without confirm
  // returns the ledger and the skip breakdown and sends nothing — that is the
  // preview, and it lives here rather than in a read-only endpoint so that the
  // thing the operator confirms is literally the thing that then runs. The
  // transition to 'sending' is also what fires broadcast_campaigns_log_start,
  // which writes the dispo_blast_started event onto the deal.
  if (campaign.status === 'draft') {
    if (!confirmed) {
      return refuse(cors, 409, 'not_confirmed',
        `"${campaign.name}" is ready: ${campaign.pending_count} of ${campaign.total_recipients} will be texted, ${campaign.skipped_count} are suppressed. Nothing has been sent. Send again with confirm to start.`,
        { campaign_id: campaignId, ledger: ledger(), skips: await skipBreakdown() });
    }
    const { error: startErr } = await admin
      .from('broadcast_campaigns')
      .update({ status: 'sending', started_at: new Date().toISOString() })
      .eq('id', campaignId)
      .eq('team_id', teamId)
      // Only from 'draft'. Two confirms racing must not both count as the start,
      // or the deal timeline gets two dispo_blast_started events for one blast.
      .eq('status', 'draft');
    if (startErr) {
      console.error('[broadcast-send] could not start the campaign:', startErr.message);
      return refuse(cors, 503, 'send_unavailable', 'The campaign could not be started. Nothing was sent.');
    }
    campaign.status = 'sending';
  }

  if (campaign.status === 'paused') {
    return refuse(cors, 409, 'campaign_paused',
      'This campaign is paused. Set it back to sending to resume it — deliberately, because something stopped it.',
      { ledger: ledger() });
  }
  if (campaign.status === 'sent' || campaign.status === 'failed') {
    return refuse(cors, 409, 'campaign_finished',
      `This campaign is already "${campaign.status}".`, { ledger: ledger() });
  }

  // ── 4. The deal, and the body it renders into ─────────────────────────────
  let deal: Record<string, any> | null = null;
  if (campaign.deal_id) {
    const { data } = await admin
      .from('deals')
      .select('id, status, address, city, state, zip, county, property_type, rehab_level, occupancy, beds, baths, sqft, year_built, buyer_price, buyer_spread, arv_estimate, repair_estimate')
      .eq('id', campaign.deal_id)
      .eq('team_id', teamId)
      .maybeSingle();
    deal = data ?? null;
  }
  const dealTokens = dealValues(deal);

  // Pre-flight, before a single row is claimed. A body with a token this
  // function cannot fill, or a token that is empty on this deal, fails
  // identically for every recipient — so it is a composer bug, and the cheapest
  // moment to say so is before anyone has been texted a sentence with a hole in
  // it. The sentinel names are there so this pass only judges the deal tokens;
  // per-contact names are checked per row below.
  const probe = renderTemplate(campaign.body, { ...dealTokens, first_name: 'x', name: 'x' });
  if (probe.unknown.length > 0) {
    return refuse(cors, 400, 'unknown_placeholder',
      `The message uses ${probe.unknown.map((t) => `{{${t}}}`).join(', ')}, which this sender has no value for. Nothing was sent.`,
      { unknown: probe.unknown });
  }
  if (probe.empty.length > 0) {
    return refuse(cors, 400, 'unresolved_placeholder',
      `The message uses ${probe.empty.map((t) => `{{${t}}}`).join(', ')}, and ${deal ? 'this deal has no value for' : 'this campaign has no deal attached, so there is nothing to fill'} ${probe.empty.length === 1 ? 'it' : 'them'}. Fill the deal in, or reword the message. Nothing was sent.`,
      { empty: probe.empty });
  }
  // Measured on the rendered text, not the stored template. A per-contact name
  // can still push an individual message over — that is caught per row below —
  // but a body already over the line with the deal filled in fails for every
  // recipient, so it is a composer bug and belongs here, where nothing has been
  // claimed yet.
  if (probe.text.length > MAX_BODY_CHARS) {
    return refuse(cors, 400, 'body_too_long',
      `With this deal filled in, the message is ${probe.text.length} characters and the limit is ${MAX_BODY_CHARS}. Shorten it. Nothing was sent.`,
      { rendered_length: probe.text.length, limit: MAX_BODY_CHARS });
  }

  // ── 5. The daily cap ──────────────────────────────────────────────────────
  // Only when BROADCAST_DAILY_CAP is set. Counts the whole team's day, not this
  // campaign's, because the cap a carrier enforces is on the brand.
  // How many more this run may send before the cap. Infinity when uncapped.
  // Checking the cap once and then draining a whole batch would sail straight
  // past it — a cap of 200 with 195 spent and a batch of 100 sends 295 — and a
  // carrier cap that is exceeded does not bounce, it filters silently. This is
  // still best-effort against a concurrent worker; it is a governor, not a lock.
  let capHeadroom = Number.POSITIVE_INFINITY;
  if (Number.isFinite(DAILY_CAP) && DAILY_CAP > 0) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { count: sentToday, error: capErr } = await admin
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .in('status', ['sent', 'delivered'])
      .gte('sent_at', dayStart.toISOString());
    // Fails closed, like every other count that decides whether to send: a cap
    // that cannot be read is not a cap that is clear.
    if (capErr) {
      console.error('[broadcast-send] daily cap read failed:', capErr.message);
      return refuse(cors, 503, 'send_unavailable',
        'The daily send count could not be read, so nothing was sent. Try again shortly.');
    }
    if ((sentToday ?? 0) >= DAILY_CAP) {
      return refuse(cors, 429, 'daily_cap_reached',
        `${sentToday} messages have gone out today and the cap is ${DAILY_CAP}. The campaign stays open and resumes tomorrow.`,
        { sent_today: sentToday, daily_cap: DAILY_CAP, ledger: ledger() });
    }
    capHeadroom = DAILY_CAP - (sentToday ?? 0);
  }

  // ── 6. Claim a batch ──────────────────────────────────────────────────────
  // The reaper first: a worker that died holding claims leaves rows that look
  // busy forever, and the ten-minute window it uses is deliberately longer than
  // the five-minute grace in claim_broadcast_recipients so the two never fight
  // over the same row.
  const { error: reapErr } = await admin.rpc('reap_stale_broadcast_claims');
  if (reapErr) console.error('[broadcast-send] reaper failed (non-fatal):', reapErr.message);

  const intervalMs = Math.max(1, Math.round(1000 / MPS));
  const requested = typeof payload.limit === 'number' && payload.limit > 0
    ? Math.floor(payload.limit)
    : BATCH;
  // Never claim more than the wall-clock budget can actually pace out. Claiming
  // 400 rows and getting through 90 leaves 310 locked until the reaper frees
  // them ten minutes later, which stalls the campaign for no reason. The daily
  // cap bounds it the same way, for the same reason: a row claimed and not sent
  // is a row nobody else can have.
  const runCap = Math.max(
    1,
    Math.min(BATCH, requested, Math.floor(BUDGET_MS / intervalMs), capHeadroom),
  );

  const { data: claimRows, error: claimErr } = await admin.rpc('claim_broadcast_recipients', {
    p_campaign_id: campaignId,
    p_limit: runCap,
  });
  if (claimErr) {
    console.error('[broadcast-send] claim failed:', claimErr.message);
    return refuse(cors, 503, 'send_unavailable', 'Recipients could not be claimed. Nothing was sent.');
  }

  const claimed: Array<{ recipient_id: string; claim_id: string }> = Array.isArray(claimRows)
    ? claimRows
    : [];

  /** Always pass the claim we were given; release_broadcast_claim ignores anything else. */
  async function release(recipientId: string, claimId: string) {
    const { error } = await admin.rpc('release_broadcast_claim', {
      p_recipient_id: recipientId, p_claim: claimId,
    });
    if (error) console.error('[broadcast-send] claim release failed:', error.message);
  }

  const startedAt = Date.now();
  let sent = 0, skipped = 0, deferred = 0, retrying = 0, failed = 0, throttleMs = 0;
  let halt: { pause: boolean; error: string } | null = null;

  if (claimed.length > 0) {
    const byId = new Map(claimed.map((c) => [c.recipient_id, c.claim_id]));

    const { data: recipients, error: recipientErr } = await admin
      .from('broadcast_recipients')
      .select('id, buyer_id, lead_id, phone_e164, attempts, idempotency_key')
      .in('id', [...byId.keys()])
      .eq('team_id', teamId)
      .order('created_at', { ascending: true });

    if (recipientErr) {
      console.error('[broadcast-send] recipient read failed:', recipientErr.message);
      for (const c of claimed) await release(c.recipient_id, c.claim_id);
      return refuse(cors, 503, 'send_unavailable', 'The claimed recipients could not be read. Nothing was sent.');
    }

    const rows = recipients ?? [];

    // ── consent, re-asked ───────────────────────────────────────────────────
    // buyer_skip_reason is a PostgREST computed column over the buyers row, and
    // the migration's suite asserts it agrees with buyer_is_textable on every
    // row — so this is the same gate the matcher used, not a second copy of it.
    // It is re-asked because materialise may have run hours ago and consent is
    // not a fact about the past: a buyer can be paused, blacklisted, or send
    // STOP in between. Leads are not re-checked here on purpose; passing
    // lead_id to twilio-send-sms makes it run lead_is_dialable() itself, which
    // is the one definition and covers strictly more than a check here would.
    const buyerIds = rows.map((r) => r.buyer_id).filter(Boolean) as string[];
    const buyers = new Map<string, { name: string | null; skip: string | null }>();
    if (buyerIds.length > 0) {
      const { data, error } = await admin
        .from('buyers')
        .select('id, name, skip:buyer_skip_reason')
        .in('id', buyerIds)
        .eq('team_id', teamId);
      if (error) {
        console.error('[broadcast-send] buyer consent re-check failed:', error.message);
        for (const c of claimed) await release(c.recipient_id, c.claim_id);
        return refuse(cors, 503, 'send_unavailable',
          'Buyer consent could not be re-checked, so nothing was sent. Try again shortly.');
      }
      for (const b of data ?? []) buyers.set(b.id, { name: b.name, skip: b.skip ?? null });
    }

    // lead_skip_reason is carried for labelling only, never to decide anything:
    // twilio-send-sms's lead_is_dialable() call is the gate, and this is the
    // sentence that explains which branch of it fired.
    const leadIds = rows.map((r) => r.lead_id).filter(Boolean) as string[];
    const leads = new Map<string, { name: string | null; skip: string | null }>();
    if (leadIds.length > 0) {
      const { data } = await admin
        .from('leads')
        .select('id, name, owner_name, skip:lead_skip_reason')
        .in('id', leadIds)
        .eq('team_id', teamId);
      for (const l of data ?? []) {
        leads.set(l.id, {
          name: plain(l.name) ?? plain(l.owner_name),
          skip: l.skip ?? null,
        });
      }
    }

    // ── the drain ───────────────────────────────────────────────────────────
    let nextSlot = Date.now();

    for (const r of rows) {
      const claimId = byId.get(r.id)!;
      byId.delete(r.id);

      if (halt) { await release(r.id, claimId); continue; }

      // Stop cleanly rather than being killed mid-send. A recipient marked
      // 'queued' whose process dies is a stranded row nobody requeues; the
      // budget exists so that never happens on a predictable boundary.
      if (Date.now() - startedAt > BUDGET_MS) { await release(r.id, claimId); continue; }

      const subjectName = r.buyer_id
        ? (buyers.get(r.buyer_id)?.name ?? null)
        : r.lead_id
        ? (leads.get(r.lead_id)?.name ?? null)
        : null;
      const leadSkip = r.lead_id ? (leads.get(r.lead_id)?.skip ?? null) : null;

      // ── the subject has to still exist ──────────────────────────────────
      // buyer_id and lead_id are ON DELETE SET NULL so the ledger outlives the
      // contact, which means "deleted since materialise" reaches this loop as a
      // NULL id — never as an id that fails to resolve. Both halves are a
      // compliance hole if this row is allowed through:
      //
      //   a buyers row with no buyer_id has nobody left to ask, and
      //   buyer_skip_reason() is the ONLY thing on this path that reads
      //   consent_sms, tcpa_opt_in and status='blacklisted';
      //
      //   a leads row with no lead_id is worse, because lead_id is what makes
      //   twilio-send-sms run lead_is_dialable(). Without it the DNC flag, the
      //   litigator flag, the trashed flag and the consent basis are not
      //   evaluated at all, and the only surviving rail is the opt-out list for
      //   the one number on the row.
      //
      // Deleting a contact is exactly what an operator does when somebody says
      // take me off your list, so this has to be a refusal rather than a send
      // to a frozen number with nothing left standing behind it.
      if (!r.buyer_id && !r.lead_id) {
        await admin.from('broadcast_recipients').update({
          status: 'skipped',
          skip_reason: 'send_refused',
          error: 'The contact was removed from the CRM after the audience was frozen, so consent could not be re-checked at send time.',
          last_attempt_at: new Date().toISOString(),
        }).eq('id', r.id).eq('team_id', teamId);
        skipped++;
        await release(r.id, claimId);
        continue;
      }

      // Consent revoked since preview. Terminal, and recorded under the reason
      // the gate function gave rather than a generic refusal.
      const buyerSkip = r.buyer_id ? (buyers.get(r.buyer_id)?.skip ?? null) : null;
      if (r.buyer_id && !buyers.has(r.buyer_id)) {
        // Not the deletion case above — the id is set but the row did not come
        // back, so consent is unknown rather than absent. Same answer either
        // way: a re-check that could not run is not a re-check that passed.
        await admin.from('broadcast_recipients').update({
          status: 'skipped',
          skip_reason: 'send_refused',
          error: 'This buyer could not be read at send time, so consent could not be re-checked.',
          last_attempt_at: new Date().toISOString(),
        }).eq('id', r.id).eq('team_id', teamId);
        skipped++;
        await release(r.id, claimId);
        continue;
      }
      if (buyerSkip) {
        await admin.from('broadcast_recipients').update({
          status: 'skipped',
          skip_reason: buyerSkip,
          error: 'Consent changed after the audience was frozen; re-checked at send time.',
          last_attempt_at: new Date().toISOString(),
        }).eq('id', r.id).eq('team_id', teamId);
        skipped++;
        await release(r.id, claimId);
        continue;
      }

      // Per-contact tokens. The deal tokens were pre-flighted; a name that is
      // missing is a per-row problem and must not send "Hi ," to a cash buyer.
      const rendered = renderTemplate(campaign.body, {
        ...dealTokens,
        first_name: firstName(subjectName),
        name: subjectName,
      });
      if (rendered.empty.length > 0) {
        await admin.from('broadcast_recipients').update({
          status: 'skipped',
          skip_reason: 'send_refused',
          error: `The message uses ${rendered.empty.map((t) => `{{${t}}}`).join(', ')} and this contact has no name on file.`,
          last_attempt_at: new Date().toISOString(),
        }).eq('id', r.id).eq('team_id', teamId);
        skipped++;
        await release(r.id, claimId);
        continue;
      }
      // The template fits (pre-flighted); this contact's name may not. Refused
      // per row rather than sent truncated — twilio-send-sms would answer
      // bad_request, and bad_request halts and pauses the whole campaign.
      if (rendered.text.length > MAX_BODY_CHARS) {
        await admin.from('broadcast_recipients').update({
          status: 'skipped',
          skip_reason: 'send_refused',
          error: `With this contact's name filled in the message is ${rendered.text.length} characters; the limit is ${MAX_BODY_CHARS}.`,
          last_attempt_at: new Date().toISOString(),
        }).eq('id', r.id).eq('team_id', teamId);
        skipped++;
        await release(r.id, claimId);
        continue;
      }

      // ── queued BEFORE the send ────────────────────────────────────────────
      // See the header. This UPDATE is the only thing standing between a worker
      // that dies mid-flight and a buyer who gets the same deal twice. attempts
      // is incremented here, not after, for the same reason: an attempt that
      // was made and lost still happened.
      //
      // .select() is what makes it a guard rather than a gesture. A filtered
      // UPDATE that matches nothing is not an error in PostgREST — it is a
      // success with no rows — so reading only `error` would let the one case
      // this exists to catch through: a second worker took the row under the
      // five-minute stale grace while this one was still in flight, moved it to
      // 'queued' first, and this one would send anyway. That is the duplicate
      // text. No row back means somebody else owns this send.
      const attempts = (r.attempts ?? 0) + 1;
      const { data: queuedRow, error: queueErr } = await admin
        .from('broadcast_recipients').update({
          status: 'queued',
          attempts,
          last_attempt_at: new Date().toISOString(),
          next_retry_at: null,
        })
        .eq('id', r.id).eq('team_id', teamId).eq('status', 'pending')
        .select('id').maybeSingle();
      if (queueErr) {
        // Could not record the attempt, so do not make it. Same rule as
        // twilio-send-sms's not_recorded: an unrecorded text is worse than an
        // unsent one, because nobody finds out.
        console.error('[broadcast-send] could not mark recipient queued:', queueErr.message);
        await release(r.id, claimId);
        continue;
      }
      if (!queuedRow) {
        console.error('[broadcast-send] recipient was no longer pending; another worker has it:', r.id);
        await release(r.id, claimId);
        continue;
      }

      // ── pace ──────────────────────────────────────────────────────────────
      const wait = nextSlot - Date.now();
      if (wait > 0) { throttleMs += wait; await sleep(wait); }
      nextSlot = Math.max(Date.now(), nextSlot) + intervalMs;

      // ── the one door ──────────────────────────────────────────────────────
      // Always on the service key with an explicit team_id, never on the
      // operator's JWT. A blast outlives the session that started it — cron
      // finishes what a person began — and a token expiring at message 40 would
      // turn the rest of the campaign into not_authenticated refusals.
      // broadcast_campaigns.created_by already records who authored it.
      //
      // lead_id is passed whenever there is one. That is what applies
      // lead_is_dialable() — the consent basis, the trashed and phone_invalid
      // flags, and the opt-out check across BOTH numbers on the lead — to this
      // path, and it is also what puts the message on the lead's timeline.
      let outcome: Outcome;
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/twilio-send-sms`, {
          method: 'POST',
          // fetch waits forever by default. See SEND_TIMEOUT_MS: a hang here
          // burns the whole invocation and strands this row in 'queued', which
          // nothing requeues on purpose.
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({
            to: r.phone_e164,
            body: rendered.text,
            team_id: teamId,
            lead_id: r.lead_id ?? undefined,
            // Frozen on the recipient row at materialise time, so a retry after
            // a crash replays the same key rather than minting a new one.
            idempotency_key: r.idempotency_key,
          }),
        });
        const body = await res.json().catch(() => ({}));
        outcome = classify(res.ok, body, attempts - 1, leadSkip);
      } catch (err) {
        // The send function never answered — unreachable, or it took longer
        // than SEND_TIMEOUT_MS. Unknown, not failed: a timed-out request may
        // well have reached Twilio. Retrying is still the safe move because the
        // idempotency key is replayed, so twilio-send-sms answers duplicate_send
        // rather than sending a second text.
        const e = err as Error;
        outcome = {
          kind: 'retry',
          error: e.name === 'TimeoutError'
            ? `twilio-send-sms did not answer within ${SEND_TIMEOUT_MS / 1000}s; the outcome of that attempt is unknown.`
            : `twilio-send-sms was unreachable: ${e.message}`,
        };
      }

      const now = new Date().toISOString();
      switch (outcome.kind) {
        case 'sent': {
          await admin.from('broadcast_recipients').update({
            status: 'sent', twilio_sid: outcome.sid, sent_at: now, error: null, next_retry_at: null,
          }).eq('id', r.id).eq('team_id', teamId);
          sent++;
          break;
        }
        case 'skip': {
          await admin.from('broadcast_recipients').update({
            status: 'skipped', skip_reason: outcome.reason, error: outcome.error.slice(0, 1000),
            next_retry_at: null,
          }).eq('id', r.id).eq('team_id', teamId);
          skipped++;
          break;
        }
        case 'defer': {
          // The clock is shut, not the buyer. Back to pending, scheduled at the
          // moment twilio-send-sms said the window reopens, so a blast started
          // at 8:50pm finishes at 8am instead of dropping half the list.
          //
          // It does count as an attempt. Six deferrals means the number's
          // timezone never resolves or the blast only ever runs at 2am — either
          // way a person should look, so the last one is terminal and lands in
          // the skip vocabulary where it can be counted.
          if (attempts >= MAX_ATTEMPTS) {
            await admin.from('broadcast_recipients').update({
              status: 'skipped', skip_reason: 'outside_calling_window',
              error: outcome.error.slice(0, 1000), next_retry_at: null,
            }).eq('id', r.id).eq('team_id', teamId);
            skipped++;
          } else {
            await admin.from('broadcast_recipients').update({
              status: 'pending', error: outcome.error.slice(0, 1000),
              next_retry_at: outcome.until ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }).eq('id', r.id).eq('team_id', teamId);
            deferred++;
          }
          break;
        }
        case 'retry': {
          if (attempts >= MAX_ATTEMPTS) {
            await admin.from('broadcast_recipients').update({
              status: 'failed', error: outcome.error.slice(0, 1000), next_retry_at: null,
            }).eq('id', r.id).eq('team_id', teamId);
            failed++;
          } else {
            // broadcast_next_retry() rather than a constant: the claim query
            // filters on next_retry_at, so the schedule belongs on that side.
            const { data: backoff } = await admin.rpc('broadcast_next_retry', { p_attempts: attempts });
            await admin.from('broadcast_recipients').update({
              status: 'pending', error: outcome.error.slice(0, 1000),
              next_retry_at: nextRetryFrom(backoff),
            }).eq('id', r.id).eq('team_id', teamId);
            retrying++;
          }
          break;
        }
        case 'halt': {
          // Not this recipient's fault. Put it back exactly as it was — pending
          // and un-attempted — so the campaign resumes without burning a retry
          // on a rail that had nothing to do with it.
          await admin.from('broadcast_recipients').update({
            status: 'pending', attempts: attempts - 1, error: outcome.error.slice(0, 1000),
          }).eq('id', r.id).eq('team_id', teamId);
          halt = { pause: outcome.pause, error: outcome.error };
          break;
        }
      }

      await release(r.id, claimId);
    }

    // Anything claimed that we never reached — budget exhausted, halted, or a
    // row that vanished between the claim and the read.
    for (const [recipientId, claimId] of byId) await release(recipientId, claimId);
  }

  // ── 7. Where the campaign stands now ──────────────────────────────────────
  const { data: after } = await admin
    .from('broadcast_campaigns')
    .select('status, total_recipients, pending_count, queued_count, skipped_count, sent_count, delivered_count, failed_count')
    .eq('id', campaignId).eq('team_id', teamId).maybeSingle();

  const counts = after ?? campaign;
  let finalStatus = counts.status ?? 'sending';

  if (halt?.pause) {
    // A rail that needs a human. Pausing stops cron from re-running into the
    // same wall every minute and makes the stoppage visible instead of it
    // looking like a slow campaign.
    await admin.from('broadcast_campaigns').update({ status: 'paused' })
      .eq('id', campaignId).eq('team_id', teamId);
    finalStatus = 'paused';
  } else if ((counts.pending_count ?? 0) === 0 && (counts.queued_count ?? 0) === 0 && finalStatus === 'sending') {
    // Nothing in SQL closes a campaign; the schema is explicit about that. A
    // campaign where every single row failed is 'failed' rather than 'sent',
    // because "sent" next to zero sends is the kind of number this ledger
    // exists to stop being printed.
    //
    // The deal's own status is deliberately not consulted. A dispo blast that
    // is still draining when the deal goes to buyer_selected has already
    // texted most of the list; stopping the rest halfway leaves an audience
    // split for no auditable reason. The operator pauses it if they want it
    // stopped.
    finalStatus = (counts.sent_count ?? 0) === 0 && (counts.failed_count ?? 0) > 0 ? 'failed' : 'sent';
    await admin.from('broadcast_campaigns')
      .update({ status: finalStatus, completed_at: new Date().toISOString() })
      .eq('id', campaignId).eq('team_id', teamId).eq('status', 'sending');

    // The other half of the trigger's dispo_blast_started. Non-fatal: the
    // messages are already gone, and failing the call because an append-only
    // event row did not land would tell the operator to run it again.
    if (campaign.deal_id) {
      const { error: eventErr } = await admin.from('deal_events').insert({
        team_id: teamId,
        deal_id: campaign.deal_id,
        type: 'dispo_blast_completed',
        actor_kind: 'system',
        summary: `${counts.sent_count} of ${counts.total_recipients} buyers texted about this deal; ${counts.skipped_count} suppressed, ${counts.failed_count} failed.`,
        payload: {
          campaign_id: campaignId,
          total_recipients: counts.total_recipients,
          sent: counts.sent_count,
          delivered: counts.delivered_count,
          skipped: counts.skipped_count,
          failed: counts.failed_count,
          // What the pacing cost, recorded rather than inferred. A blast that
          // finished suspiciously fast is a blast that was not paced.
          mps: MPS,
          throttled_ms: throttleMs,
        },
      });
      if (eventErr) console.error('[broadcast-send] completion event failed:', eventErr.message);
    }
  }

  if (halt) {
    return refuse(
      cors,
      halt.pause ? 403 : 503,
      halt.pause ? 'send_blocked' : 'send_unavailable',
      halt.pause
        ? `The send stopped: ${halt.error} No further messages were attempted, and the campaign is paused.`
        : `The send stopped and will resume on its own: ${halt.error}`,
      {
        campaign_id: campaignId,
        status: finalStatus,
        sent, skipped, deferred, retrying, failed,
        throttled_ms: throttleMs,
        ledger: counts,
      },
    );
  }

  return jsonResponse({
    ok: true,
    campaign_id: campaignId,
    status: finalStatus,
    claimed: claimed.length,
    sent,
    skipped,
    deferred,
    retrying,
    failed,
    mps: MPS,
    throttled_ms: throttleMs,
    elapsed_ms: Date.now() - startedAt,
    // The caller's cue to invoke again. Deferred rows count: they are pending
    // with a future next_retry_at, and the next run will claim only the ones
    // whose time has come.
    more_pending: (counts.pending_count ?? 0) > 0,
    ledger: counts,
  }, cors, 200);
});

/**
 * broadcast_next_retry() returns a Postgres interval, which PostgREST hands back
 * as 'HH:MM:SS' (or '00:01:00'). Parsed here rather than asking SQL for an
 * absolute timestamp, so the one place the schedule is defined stays the SQL
 * function. Anything unparseable falls back to a minute — the shortest value the
 * ladder produces, so a parse bug can only ever retry sooner, never strand a row.
 */
function nextRetryFrom(interval: unknown): string {
  const m = /^(\d+):(\d{2}):(\d{2})/.exec(String(interval ?? ''));
  const seconds = m
    ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
    : 60;
  return new Date(Date.now() + Math.max(seconds, 60) * 1000).toISOString();
}
