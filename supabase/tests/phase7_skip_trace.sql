\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
--
-- SAME CAVEAT AS phase7_prospects, phase2_telephony and phase4_sdr: this blanket
-- grant hands `authenticated` privileges the migration itself decides
-- individually, so nothing below asserts a table privilege for that role — the
-- assertion would pass alone and fail once an earlier suite ran the same line
-- against the same database. skip_trace_runs is meant to be SELECT-only to
-- `authenticated`, and §9 asserts the part that survives: anon has nothing, and
-- another team sees nothing.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO allowed_signups (email) VALUES ('trace@tossiebuyshouses.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('cccccccc-0000-4000-8000-000000000008', 'trace@tossiebuyshouses.com',
        '{"full_name":"Acquisitions"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO prospect_lists (id, team_id, name, source_vendor, created_by)
VALUES ('f8000000-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001',
        'Chatham pre-foreclosure', 'test-vendor',
        'cccccccc-0000-4000-8000-000000000008')
ON CONFLICT (id) DO NOTHING;

-- Four rows in the four states a skip-trace batch can leave behind. 555 numbers
-- throughout — the reserved fictional block, never a number that could ring.
INSERT INTO prospects (
  id, team_id, list_id, address, city, state, zip, owner_name, pre_foreclosure,
  skip_traced, skip_traced_at, skip_trace_provider, skip_trace_confidence,
  phone_mobile, phone_landline,
  dnc_scrubbed, dnc_scrubbed_at, is_dnc, is_litigator, scrub_error, vendor_id
) VALUES
  -- (a) untouched: the state before any run
  ('f8000000-0000-4000-8000-000000000101', '70551e00-0000-4000-8000-000000000001',
   'f8000000-0000-4000-8000-000000000001', '9 Price St', 'Savannah', 'GA', '31401',
   'Never Traced', true,
   false, NULL, NULL, NULL, NULL, NULL,
   false, NULL, false, false, NULL, 'W-101'),

  -- (b) traced, and the scrub did not answer. THE ROW THIS WHOLE JOB IS ABOUT.
  ('f8000000-0000-4000-8000-000000000102', '70551e00-0000-4000-8000-000000000001',
   'f8000000-0000-4000-8000-000000000001', '17 Gwinnett St', 'Savannah', 'GA', '31401',
   'Scrub Timed Out', true,
   true, now(), 'test-provider', 82,
   '+19125557301', NULL,
   false, NULL, false, false,
   'The litigator check did not answer: 503', 'W-102'),

  -- (c) traced and scrubbed clean
  ('f8000000-0000-4000-8000-000000000103', '70551e00-0000-4000-8000-000000000001',
   'f8000000-0000-4000-8000-000000000001', '25 Taylor St', 'Savannah', 'GA', '31401',
   'Traced And Clean', true,
   true, now(), 'test-provider', 90,
   '+19125557303', NULL,
   true, now(), false, false, NULL, 'W-103'),

  -- (d) traced, scrubbed, and the litigator file said yes
  ('f8000000-0000-4000-8000-000000000104', '70551e00-0000-4000-8000-000000000001',
   'f8000000-0000-4000-8000-000000000001', '33 Charlton St', 'Savannah', 'GA', '31401',
   'Files Lawsuits', true,
   true, now(), 'test-provider', 95,
   '+19125557304', NULL,
   true, now(), false, true, NULL, 'W-104')
ON CONFLICT (id) DO NOTHING;

\echo '=== 1. a failed scrub leaves the prospect UNDIALABLE ==='
\echo '-- The entire point. reoperative ran the DNC and litigator checks inside a'
\echo '-- try/catch(non-fatal), so one 503 marked the row scrubbed anyway and the'
\echo '-- number got cold-called. Here the failure means dnc_scrubbed stays false,'
\echo '-- which prospect_is_callable already refuses — the safe direction. Note'
\echo '-- that (b) is traced, has a phone, and is flagged neither DNC nor'
\echo '-- litigator: the ONLY thing keeping it out of the queue is the missing'
\echo '-- scrub.'
SELECT p.owner_name, p.skip_traced, p.dnc_scrubbed,
       p.phone_mobile IS NOT NULL AS has_a_number,
       p.is_dnc, p.is_litigator,
       p.scrub_error IS NOT NULL AS says_why,
       prospect_is_callable(p.*) AS callable
FROM prospects p
WHERE p.list_id = 'f8000000-0000-4000-8000-000000000001'
ORDER BY p.id;

SELECT prospect_is_callable(p.*) AS failed_scrub_is_callable FROM prospects p
WHERE id = 'f8000000-0000-4000-8000-000000000102';

\echo '-- ...and the retry queue is expressible as a query, which is what makes'
\echo '-- the failure recoverable rather than merely safe. This is the index'
\echo '-- prospects_scrub_pending_idx exists for.'
SELECT count(*) AS awaiting_a_scrub FROM prospects
WHERE team_id = '70551e00-0000-4000-8000-000000000001'
  AND skip_traced AND NOT dnc_scrubbed AND converted_at IS NULL;

\echo '=== 2. a completed scrub with a litigator hit is still undialable ==='
\echo '-- Two-tenths of a cent to never speak to a serial TCPA plaintiff. The'
\echo '-- flag is set by the scrub and vetoed by prospect_is_callable — the scrub'
\echo '-- does not get to decide dialability, it only supplies the fact.'
SELECT prospect_is_callable(p.*) AS litigator_is_callable FROM prospects p
WHERE id = 'f8000000-0000-4000-8000-000000000104';
SELECT prospect_is_callable(p.*) AS clean_is_callable FROM prospects p
WHERE id = 'f8000000-0000-4000-8000-000000000103';

\echo '=== 3. the run records what was spent, and the total cannot drift ==='
\echo '-- estimated_cost_micros is GENERATED from the lookup counts and the unit'
\echo '-- prices snapshotted on the run, so no writer can report a total that'
\echo '-- disagrees with its own line items.'
INSERT INTO skip_trace_runs (
  id, team_id, list_id, started_by, mode, status,
  trace_provider, scrub_provider,
  selected_count, traced_count, trace_failed_count,
  scrubbed_count, scrub_failed_count,
  phones_found, emails_found, dnc_hits, litigator_hits,
  trace_lookups, dnc_lookups, litigator_lookups,
  failures, finished_at
) VALUES (
  'f8000000-0000-4000-8000-000000000201', '70551e00-0000-4000-8000-000000000001',
  'f8000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000008',
  'live', 'completed', 'tracerfy', 'batchdata',
  4, 3, 0, 2, 1,
  5, 2, 0, 1,
  3, 5, 5,
  '[{"prospect_id":"f8000000-0000-4000-8000-000000000102","phase":"scrub","error":"503"}]'::jsonb,
  now()
) ON CONFLICT (id) DO NOTHING;

\echo '-- 3 traces at $0.04 + 5 DNC and 5 litigator lookups at $0.002 = $0.14.'
\echo '-- Micros, not cents: at a fifth of a cent per lookup, rounding to cents'
\echo '-- loses more than the litigator scrub costs.'
SELECT trace_lookups, dnc_lookups, litigator_lookups,
       estimated_cost_micros,
       round(estimated_cost_micros / 1000000.0, 4) AS estimated_cost_dollars
FROM skip_trace_runs WHERE id = 'f8000000-0000-4000-8000-000000000201';

\echo '-- scrub_failed_count is the number an operator has to see. It is the'
\echo '-- count of prospects that were traced, cost money, and still may not be'
\echo '-- dialled — the retry list, with a price on it.'
SELECT scrub_failed_count, failures -> 0 ->> 'phase' AS first_failure_phase
FROM skip_trace_runs WHERE id = 'f8000000-0000-4000-8000-000000000201';

\echo '=== 4. a dry run cannot spend ==='
\echo '-- Dry run is what the edge function does when a request does not say'
\echo '-- confirm, so a malformed call reports a cost instead of incurring one.'
\echo '-- A dry run that recorded a lookup would mean the mode did not do what'
\echo '-- its name says, so the database refuses to store one.'
DO $$
BEGIN
  INSERT INTO skip_trace_runs (team_id, mode, status, trace_lookups, finished_at)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'dry_run', 'completed', 1, now());
  RAISE EXCEPTION 'FAIL: a dry run recorded a paid lookup';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: a dry run cannot record a lookup';
END $$;

DO $$
BEGIN
  INSERT INTO skip_trace_runs (team_id, mode, status, litigator_lookups, finished_at)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'dry_run', 'completed', 3, now());
  RAISE EXCEPTION 'FAIL: a dry run recorded a litigator lookup';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: a dry run cannot record a litigator lookup';
END $$;

\echo '-- A zero-cost dry run is fine, and costs zero.'
INSERT INTO skip_trace_runs (id, team_id, list_id, mode, status, selected_count, finished_at)
VALUES ('f8000000-0000-4000-8000-000000000202', '70551e00-0000-4000-8000-000000000001',
        'f8000000-0000-4000-8000-000000000001', 'dry_run', 'completed', 4, now())
ON CONFLICT (id) DO NOTHING;
SELECT mode, selected_count, estimated_cost_micros
FROM skip_trace_runs WHERE id = 'f8000000-0000-4000-8000-000000000202';

\echo '=== 5. the ladders are closed, and a finished run is dated ==='
\echo '-- A typo in mode or status becomes a run nobody filters for, which is a'
\echo '-- spend nobody totals.'
DO $$
BEGIN
  INSERT INTO skip_trace_runs (team_id, mode, status, finished_at)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'preview', 'completed', now());
  RAISE EXCEPTION 'FAIL: an unknown mode was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: mode is constrained to dry_run/live';
END $$;

DO $$
BEGIN
  INSERT INTO skip_trace_runs (team_id, mode, status, finished_at)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'live', 'partial', now());
  RAISE EXCEPTION 'FAIL: an unknown status was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: status is constrained to running/completed/failed';
END $$;

DO $$
BEGIN
  INSERT INTO skip_trace_runs (team_id, mode, status)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'live', 'completed');
  RAISE EXCEPTION 'FAIL: a finished run was stored with no finish time';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: a finished run has to be dated';
END $$;

\echo '-- A run in progress legitimately has no finish time.'
INSERT INTO skip_trace_runs (id, team_id, mode, status)
VALUES ('f8000000-0000-4000-8000-000000000203', '70551e00-0000-4000-8000-000000000001',
        'live', 'running')
ON CONFLICT (id) DO NOTHING;
SELECT status, finished_at IS NULL AS still_open
FROM skip_trace_runs WHERE id = 'f8000000-0000-4000-8000-000000000203';

\echo '=== 6. deleting the list does not delete the receipt ==='
\echo '-- Throwing away a list imported against the wrong column mapping is the'
\echo '-- documented remedy. The money spent tracing it was still spent, and a'
\echo '-- cost record that vanishes with the list makes every vendor look cheaper'
\echo '-- in hindsight than they were.'
INSERT INTO prospect_lists (id, team_id, name)
VALUES ('f8000000-0000-4000-8000-000000000002',
        '70551e00-0000-4000-8000-000000000001', 'Mis-mapped import')
ON CONFLICT (id) DO NOTHING;
INSERT INTO skip_trace_runs (id, team_id, list_id, mode, status, trace_lookups, finished_at)
VALUES ('f8000000-0000-4000-8000-000000000204', '70551e00-0000-4000-8000-000000000001',
        'f8000000-0000-4000-8000-000000000002', 'live', 'completed', 10, now())
ON CONFLICT (id) DO NOTHING;

DELETE FROM prospect_lists WHERE id = 'f8000000-0000-4000-8000-000000000002';

SELECT list_id IS NULL AS list_forgotten,
       estimated_cost_micros AS spend_remembered
FROM skip_trace_runs WHERE id = 'f8000000-0000-4000-8000-000000000204';

\echo '=== 7. deleting the run does not un-trace the prospects it paid for ==='
\echo '-- The other direction of the same rule. skip_trace_run_id is ON DELETE'
\echo '-- SET NULL, so losing the run can never read as losing the trace — and'
\echo '-- crucially can never read as losing the scrub, which would put a row'
\echo '-- back in the dial queue.'
UPDATE prospects SET skip_trace_run_id = 'f8000000-0000-4000-8000-000000000201'
WHERE id IN ('f8000000-0000-4000-8000-000000000103', 'f8000000-0000-4000-8000-000000000104');

DELETE FROM skip_trace_runs WHERE id = 'f8000000-0000-4000-8000-000000000201';

SELECT owner_name, skip_trace_run_id IS NULL AS run_forgotten,
       skip_traced, dnc_scrubbed, is_litigator
FROM prospects
WHERE id IN ('f8000000-0000-4000-8000-000000000103', 'f8000000-0000-4000-8000-000000000104')
ORDER BY id;

SELECT prospect_is_callable(p.*) AS litigator_callable_after_run_deleted FROM prospects p
WHERE id = 'f8000000-0000-4000-8000-000000000104';

\echo '=== 8. nothing here added a way to text or to consent ==='
\echo '-- This migration touches prospects. §10 stands: no consent-shaped column,'
\echo '-- and the complete set of functions taking a prospect is still exactly'
\echo '-- one. If either of these moves, somebody wired the scrub into a send'
\echo '-- path.'
SELECT count(*) AS consent_columns_on_prospects
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'prospects'
  AND column_name ~ 'consent|opt_in|opted_in|tcpa';

SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND 'public.prospects'::regtype = ANY(p.proargtypes::oid[])
ORDER BY 1;

\echo '-- ...and no function anywhere is named as though a run could text.'
SELECT count(*) AS textability_functions
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname ~ 'skip_trace|scrub'
  AND p.proname ~ 'text|sms|messag|broadcast|blast|consent';

\echo '=== 9. RLS: another team sees no runs, and anon sees nothing at all ==='
INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000008', 'Rival Wholesaler 2')
ON CONFLICT (id) DO NOTHING;
INSERT INTO allowed_signups (email) VALUES ('rival-trace@example.com')
ON CONFLICT (email) DO NOTHING;
INSERT INTO auth.users (id, email) VALUES
  ('dddddddd-0000-4000-8000-000000000008', 'rival-trace@example.com')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000008'
 WHERE id = 'dddddddd-0000-4000-8000-000000000008';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000008';
SET LOCAL ROLE authenticated;
SELECT count(*) AS runs_visible_to_rival FROM skip_trace_runs;
COMMIT;

\echo '-- The operator does see the spend on their own team. A rail that never'
\echo '-- says yes gets removed.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000008';
SET LOCAL ROLE authenticated;
SELECT count(*) > 0 AS operator_sees_own_runs FROM skip_trace_runs;
COMMIT;

\echo '-- anon keeps nothing. The anon key ships in the browser bundle, and this'
\echo '-- table says how much Tossie spends and on which lists.'
SELECT has_table_privilege('anon', 'public.skip_trace_runs', 'SELECT') AS anon_reads_runs,
       has_table_privilege('anon', 'public.skip_trace_runs', 'INSERT') AS anon_writes_runs,
       has_table_privilege('anon', 'public.skip_trace_runs', 'UPDATE') AS anon_edits_runs;

SELECT relrowsecurity AS rls_enabled
FROM pg_class WHERE oid = 'public.skip_trace_runs'::regclass;

\echo '=== 10. realtime publishes the runs, still never the prospects ==='
\echo '-- A run row is written twice in its life, which is what a progress'
\echo '-- indicator needs. Publishing prospects instead would push one message'
\echo '-- per row of a 5,000-row batch at a browser watching one number.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('prospects', 'prospect_lists', 'skip_trace_runs')
ORDER BY tablename;

\echo '=== 11. a trace that failed is stamped, and a stamp is not a trace ==='
\echo '-- The edge function writes skip_trace_run_id and NOTHING else when the'
\echo '-- trace fails after its retry budget. Two properties have to hold at once'
\echo '-- and they pull in opposite directions, so both are asserted here.'
INSERT INTO skip_trace_runs (id, team_id, list_id, mode, status, trace_lookups, finished_at)
VALUES ('f8000000-0000-4000-8000-000000000205', '70551e00-0000-4000-8000-000000000001',
        'f8000000-0000-4000-8000-000000000001', 'live', 'completed', 0, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO prospects (id, team_id, list_id, address, city, state, zip, owner_name,
                       skip_traced, dnc_scrubbed, skip_trace_run_id, vendor_id)
VALUES ('f8000000-0000-4000-8000-000000000105', '70551e00-0000-4000-8000-000000000001',
        'f8000000-0000-4000-8000-000000000001', '41 Habersham St', 'Savannah', 'GA', '31401',
        'Provider Rejects This Row',
        false, false, 'f8000000-0000-4000-8000-000000000205', 'W-105')
ON CONFLICT (id) DO NOTHING;

\echo '-- First: the stamp must not retire the row. skip_traced is still false,'
\echo '-- so the row is still owed a trace and is still refused by the dialer.'
\echo '-- A stamp that read as "done" would silently drop prospects out of the'
\echo '-- work queue on the strength of a provider error.'
SELECT owner_name, skip_traced, skip_trace_run_id IS NOT NULL AS attempted,
       prospect_is_callable(p.*) AS callable
FROM prospects p WHERE id = 'f8000000-0000-4000-8000-000000000105';

\echo '-- Second: the stamp is what makes a permanently-failing row orderable'
\echo '-- behind the untouched ones. Without it the same dead rows sort first on'
\echo '-- created_at on every invocation and the rest of the list is never'
\echo '-- reached — the batch spins and the list never finishes.'
SELECT owner_name, skip_trace_run_id IS NULL AS never_attempted
FROM prospects
WHERE list_id = 'f8000000-0000-4000-8000-000000000001'
  AND NOT skip_traced
ORDER BY skip_trace_run_id NULLS FIRST, created_at;

\echo '-- ...and both rows are still in the work set. This predicate is the one'
\echo '-- the edge function now sends to PostgREST: never traced, OR carrying a'
\echo '-- number nobody has scrubbed. It runs in the QUERY rather than over an'
\echo '-- over-fetched window, because a window that cannot tell which rows are'
\echo '-- finished re-reads the same oldest hundred forever and then reports a'
\echo '-- five-thousand-row cold list as fully scrubbed.'
SELECT count(*) AS still_needs_work FROM prospects
WHERE team_id = '70551e00-0000-4000-8000-000000000001'
  AND converted_at IS NULL
  AND (NOT skip_traced
       OR (NOT dnc_scrubbed
           AND (phone_mobile IS NOT NULL OR phone_landline IS NOT NULL OR phone_voip IS NOT NULL)));

\echo '=== 12. the list counters still recompute, now including the scrub ==='
\echo '-- The edge function calls this after every batch. scrubbed_count counts'
\echo '-- dnc_scrubbed rows only, so the row whose scrub failed is excluded — a'
\echo '-- counter that said "scrubbed: 4 of 4" over one unchecked number is'
\echo '-- exactly the figure somebody would rely on.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000008';
SET LOCAL ROLE authenticated;
SELECT total_count, skip_traced_count, scrubbed_count, converted_count
FROM refresh_prospect_list_counts('f8000000-0000-4000-8000-000000000001');
COMMIT;
