-- ============================================================================
-- Part II §11 item 2 — skip tracing, and the DNC + litigator scrub.
-- ============================================================================
-- 20260822120000 gave prospects the columns a trace and a scrub write into
-- (skip_traced*, phone_mobile/landline/voip, dnc_scrubbed*, is_dnc,
-- is_litigator) and prospect_is_callable(), which refuses to dial anything
-- missing either half. This migration adds the two things that were still
-- missing once a provider is actually wired up.
--
-- 1. A RECORD OF WHAT WAS SPENT. Roughly $0.04 a trace plus $0.002 each for the
--    DNC and litigator checks. Individually invisible; across a 5,000-row
--    absentee list it is $220, and Tossie cannot tell whether a vendor's list
--    was worth buying without knowing what it cost to make it callable.
--    reoperative had a cost column, but it was a resale price book for its
--    tenants — the honest version for a single operator is one row per run
--    saying how many lookups were made, at what unit price, and what came back.
--
-- 2. A PLACE TO SAY THE SCRUB FAILED. This is the compliance half, and it is
--    the reason this file exists at all rather than the edge function shipping
--    alone. reoperative ran the DNC and litigator checks inside
--    `try / catch (non-fatal)`: one transient 503 skipped the litigator check
--    silently, left the flag false, and the number was cold-called. A serial
--    TCPA plaintiff seeds their number onto exactly the pre-foreclosure and
--    absentee lists a wholesaler buys, and the bill is $500-$1,500 per call.
--
--    The fix in the edge function is that a failed scrub does not set
--    dnc_scrubbed, so prospect_is_callable() keeps saying no. The fix here is
--    that the row can say WHY it is unscrubbed — never attempted, or attempted
--    and failed — because otherwise the safe state is indistinguishable from the
--    untouched one and nobody knows there is anything to retry.
--
-- Nothing in this file can text anybody, and nothing in it records consent.
-- Both remain impossible from `prospects` by construction (§10, §12).
-- ============================================================================

-- ── skip_trace_runs ─────────────────────────────────────────────────────────
-- One row per invocation of the skip-trace function, including dry runs.
--
-- Written by the edge function on the service role, read by the operator. That
-- asymmetry is the point and it is enforced in the grants below: a spend record
-- an operator can edit is a spend record, not evidence.
CREATE TABLE IF NOT EXISTS public.skip_trace_runs (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- ON DELETE SET NULL, not CASCADE. Throwing away a list imported against the
  -- wrong column mapping is the documented remedy (20260822120000 grants DELETE
  -- for exactly that), but the money spent tracing it was still spent, and a
  -- cost record that disappears with the thing it was spent on makes every
  -- vendor look cheaper in hindsight than they were.
  list_id uuid REFERENCES public.prospect_lists(id) ON DELETE SET NULL,

  -- Null for a run started by cron rather than a person. Losing which operator
  -- pressed the button is survivable; losing the run is not.
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- 'dry_run' spends nothing and exists so the cost of a list can be seen
  -- before it is incurred. It is the default the edge function falls back to
  -- when a request does not explicitly confirm, so a malformed call cannot
  -- spend money.
  mode   text NOT NULL,
  status text NOT NULL DEFAULT 'running',

  -- Recorded rather than assumed. Providers get swapped, and a run from March
  -- has to keep saying who answered it.
  trace_provider text,
  scrub_provider text,

  -- ── what happened ─────────────────────────────────────────────────────────
  -- selected_count is what the run picked up; the rest is what became of them.
  -- They do not have to sum to it: a prospect that was already traced and only
  -- needed a scrub counts in scrubbed_count and in neither trace counter.
  selected_count     integer NOT NULL DEFAULT 0,
  traced_count       integer NOT NULL DEFAULT 0,
  trace_failed_count integer NOT NULL DEFAULT 0,
  scrubbed_count     integer NOT NULL DEFAULT 0,

  -- THE NUMBER THIS TABLE IS FOR. Every one of these is a prospect that was
  -- traced, has a phone number, and has NOT been checked against the DNC and
  -- litigator files — sitting out of the dial queue waiting for someone to run
  -- the scrub again. In reoperative this number did not exist, because the
  -- failure it counts was caught and discarded.
  scrub_failed_count integer NOT NULL DEFAULT 0,

  phones_found   integer NOT NULL DEFAULT 0,
  emails_found   integer NOT NULL DEFAULT 0,
  dnc_hits       integer NOT NULL DEFAULT 0,
  litigator_hits integer NOT NULL DEFAULT 0,

  -- ── what it cost ──────────────────────────────────────────────────────────
  -- Lookups are counted per provider call that ANSWERED. A call that failed
  -- after the retry budget is not counted, because the run's own accounting
  -- should not claim a charge nobody can find on the invoice.
  trace_lookups     integer NOT NULL DEFAULT 0,
  dnc_lookups       integer NOT NULL DEFAULT 0,
  litigator_lookups integer NOT NULL DEFAULT 0,

  -- Micros — millionths of a dollar — not cents. A DNC lookup is $0.002, which
  -- is a fifth of a cent, and reoperative's answer to that was to round the
  -- whole per-lead cost up to 5c. Rounding is fine for a price book and useless
  -- for "what did this list actually cost": at 5,000 rows the rounding error is
  -- larger than the litigator scrub. Integers, so nothing is lost to binary
  -- floating point on the way in either.
  --
  -- Snapshotted per run rather than read from a constant, because vendor prices
  -- change and a run from six months ago has to keep the price it paid. The
  -- defaults are BUILD_PLAN §11's figures; the edge function overrides them from
  -- its own env when Tossie's contracted rate differs.
  trace_unit_micros     integer NOT NULL DEFAULT 40000,
  dnc_unit_micros       integer NOT NULL DEFAULT 2000,
  litigator_unit_micros integer NOT NULL DEFAULT 2000,

  -- Generated, so the total can never disagree with the counts it is made of.
  -- ESTIMATED, and named so: the authority on what Tossie was charged is the
  -- provider's invoice. This is what the run believes it bought, which is the
  -- number worth having on the day rather than at the end of the month.
  estimated_cost_micros bigint GENERATED ALWAYS AS (
    trace_lookups::bigint     * trace_unit_micros
    + dnc_lookups::bigint       * dnc_unit_micros
    + litigator_lookups::bigint * litigator_unit_micros
  ) STORED,

  -- Per-prospect failures: [{prospect_id, phase, error}]. Bounded by the batch
  -- cap, so this is tens of entries and not thousands. Kept on the run rather
  -- than in a child table because it is read exactly once — when somebody asks
  -- why the scrubbed count is short — and a table nobody joins to is furniture.
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Set when the run itself fell over, as opposed to individual prospects.
  error text,

  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,

  CONSTRAINT skip_trace_runs_mode_check   CHECK (mode IN ('dry_run', 'live')),
  CONSTRAINT skip_trace_runs_status_check CHECK (status IN ('running', 'completed', 'failed')),

  -- A finished run has to be dated, or "how long did the list take" is
  -- unanswerable and a stuck run is indistinguishable from a fast one.
  CONSTRAINT skip_trace_runs_finished_is_dated
    CHECK (status = 'running' OR finished_at IS NOT NULL),

  -- A dry run that recorded a lookup is a dry run that spent money, which means
  -- the mode did not do what its name says. Cheaper to make that impossible
  -- than to notice it on a statement.
  CONSTRAINT skip_trace_runs_dry_run_spends_nothing CHECK (
    mode <> 'dry_run'
    OR (trace_lookups = 0 AND dnc_lookups = 0 AND litigator_lookups = 0)
  ),

  CONSTRAINT skip_trace_runs_counts_nonneg CHECK (
    selected_count >= 0 AND traced_count >= 0 AND trace_failed_count >= 0
    AND scrubbed_count >= 0 AND scrub_failed_count >= 0
    AND trace_lookups >= 0 AND dnc_lookups >= 0 AND litigator_lookups >= 0
    AND trace_unit_micros >= 0 AND dnc_unit_micros >= 0 AND litigator_unit_micros >= 0
  ),

  CONSTRAINT skip_trace_runs_failures_is_array CHECK (jsonb_typeof(failures) = 'array')
);

-- The two reads: "what have we spent lately" on the money screen, and "what did
-- this list cost" on the list itself.
CREATE INDEX IF NOT EXISTS skip_trace_runs_team_started_idx
  ON public.skip_trace_runs(team_id, started_at DESC);
CREATE INDEX IF NOT EXISTS skip_trace_runs_list_started_idx
  ON public.skip_trace_runs(list_id, started_at DESC) WHERE list_id IS NOT NULL;

COMMENT ON TABLE public.skip_trace_runs IS
  'One row per skip-trace invocation, including dry runs: what was selected, what came back, what it is believed to have cost, and which prospects failed. Written by the skip-trace edge function on the service role; read-only to the operator, because a spend record that can be edited is not evidence.';
COMMENT ON COLUMN public.skip_trace_runs.scrub_failed_count IS
  'Prospects whose DNC or litigator check did not answer. They are left dnc_scrubbed = false and stay out of the dial queue. This count is the retry list.';
COMMENT ON COLUMN public.skip_trace_runs.estimated_cost_micros IS
  'Millionths of a dollar, generated from the lookup counts and the unit prices snapshotted on this run. An estimate — the provider invoice is authoritative.';
COMMENT ON COLUMN public.skip_trace_runs.mode IS
  'dry_run reports what would be traced and what it would cost, and is what the edge function does when a request does not explicitly confirm. live is the only mode that spends.';

-- No touch_updated_at trigger here, unlike every other table in this schema.
-- A run has a started_at and a finished_at, which are facts about the job; an
-- updated_at would only ever restate finished_at, and on a row that is written
-- twice in its life the third timestamp is noise.

-- ── the two columns on prospects ────────────────────────────────────────────
-- Both exist to answer one question at the row level: this prospect is traced
-- but not scrubbed — is that because nothing has run yet, or because the check
-- failed? Without an answer the safe state and the untouched state look
-- identical, and "there is something here to retry" gets lost.
ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS skip_trace_run_id uuid
    REFERENCES public.skip_trace_runs(id) ON DELETE SET NULL,
  -- Null means no scrub has ever failed on this row. Set when a check did not
  -- answer, cleared the moment one does — so a stale message can never sit next
  -- to a successful scrub and argue with it.
  ADD COLUMN IF NOT EXISTS scrub_error text;

-- SET NULL rather than CASCADE for the same reason as list_id above, in the
-- other direction: deleting a run must not un-trace the prospects it paid for.
COMMENT ON COLUMN public.prospects.skip_trace_run_id IS
  'The run that last wrote this row''s trace or scrub. Nullable and ON DELETE SET NULL — losing the run must never look like losing the trace.';
COMMENT ON COLUMN public.prospects.scrub_error IS
  'Why the DNC/litigator check did not complete, when it did not. Non-null with dnc_scrubbed = false is the retryable state; both null is simply untouched.';

CREATE INDEX IF NOT EXISTS prospects_skip_trace_run_idx
  ON public.prospects(skip_trace_run_id) WHERE skip_trace_run_id IS NOT NULL;

-- The retry queue, as an index. "Traced, has a number, and the scrub owes us an
-- answer" is the query the operator runs after a provider outage, and it must
-- not be a sequential scan over a list of fifty thousand.
CREATE INDEX IF NOT EXISTS prospects_scrub_pending_idx
  ON public.prospects(team_id, list_id)
  WHERE skip_traced AND NOT dnc_scrubbed AND converted_at IS NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.skip_trace_runs ENABLE ROW LEVEL SECURITY;

-- Same FOR ALL shape as every other team-scoped table. It looks broader than
-- this table is meant to be and it is not: read-only is enforced by the grants
-- below, exactly as append-only is for dnc_restore_log. A policy cannot withhold
-- a privilege the role does not hold, and a grant cannot be talked around by a
-- policy somebody adds later.
DROP POLICY IF EXISTS skip_trace_runs_team_all ON public.skip_trace_runs;
CREATE POLICY skip_trace_runs_team_all ON public.skip_trace_runs
  FOR ALL TO authenticated
  USING (team_id = public.get_my_team_id())
  WITH CHECK (team_id = public.get_my_team_id());

-- ── grants ──────────────────────────────────────────────────────────────────
-- 20260817120300 set default privileges so anon inherits nothing on new tables.
-- Restated anyway, as every table since has: the anon key ships in the browser
-- bundle, and this table says how much Tossie spends and on which lists.
REVOKE ALL ON public.skip_trace_runs FROM PUBLIC, anon;

-- SELECT and nothing else. Every row here is written by the edge function on
-- the service role, which is the only caller that knows what the providers
-- actually answered. There is no legitimate reason for a browser to insert a
-- run, and an UPDATE grant would let the one number that matters —
-- scrub_failed_count — be tidied away by the same person it is meant to inform.
--
-- service_role is not granted explicitly: Supabase's default privileges already
-- cover it, and every other table in this schema relies on the same thing.
GRANT SELECT ON public.skip_trace_runs TO authenticated;

-- ── realtime ────────────────────────────────────────────────────────────────
-- Published, unlike `prospects` itself. A run row is inserted once and updated
-- as the batch drains, so this is a handful of messages for a job that can take
-- minutes — which is exactly what a progress indicator needs, and the opposite
-- of publishing the rows, where a 5,000-row batch would push 5,000 messages at
-- a browser watching one number (20260822120000).
--
-- Guarded like 20260817120200: ALTER PUBLICATION ADD errors on a duplicate and
-- would make a re-run of this migration fail.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['skip_trace_runs']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
