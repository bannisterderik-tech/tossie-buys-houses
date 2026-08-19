\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
--
-- SAME CAVEAT AS phase1_lead_intake, phase2_telephony and phase4_sdr: this
-- blanket grant hands `authenticated` table privileges the migration itself
-- decides individually, so nothing below asserts a table privilege for that
-- role — the assertion would pass alone and fail after any earlier suite ran
-- the same line against the same database. Privileges that ARE assertable are
-- anon's (no suite grants anon anything) and function EXECUTE (no suite grants
-- ROUTINES), and §11 checks both.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO allowed_signups (email) VALUES ('acq@tossiebuyshouses.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('cccccccc-0000-4000-8000-000000000007', 'acq@tossiebuyshouses.com',
        '{"full_name":"Acquisitions"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO prospect_lists (id, team_id, name, description, source_vendor, created_by)
VALUES ('f7000000-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001',
        'Chatham absentee + high equity',
        'Bought Aug 2026',
        'test-vendor',
        'cccccccc-0000-4000-8000-000000000007')
ON CONFLICT (id) DO NOTHING;

-- Six rows differing in exactly one compliance fact each, so the callability
-- assertions below name a single cause rather than a combination. 555 numbers
-- throughout — the reserved fictional block, never a number that could ring.
INSERT INTO prospects (
  id, team_id, list_id, address, city, state, zip, owner_name,
  is_absentee, pre_foreclosure,
  skip_traced, skip_traced_at, skip_trace_provider, skip_trace_confidence,
  phone_mobile, phone_landline, email_primary,
  dnc_scrubbed, dnc_scrubbed_at, is_dnc, is_litigator,
  call_status, call_attempts, last_called_at, call_notes, vendor_id
) VALUES
  -- clean: traced, scrubbed, nothing flagged
  ('f7000000-0000-4000-8000-000000000101', '70551e00-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001', '14 Habersham St', 'Savannah', 'GA', '31401',
   'Marlene Osgood', true, false,
   true, now() - interval '2 days', 'test-provider', 88,
   '+19125557201', NULL, 'm.osgood@example.com',
   true, now() - interval '2 days', false, false,
   'called', 2, now() - interval '1 day', 'Wants to sell after the estate settles', 'V-101'),

  -- traced but never scrubbed
  ('f7000000-0000-4000-8000-000000000102', '70551e00-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001', '22 Barnard St', 'Savannah', 'GA', '31401',
   'Unscrubbed Owner', true, false,
   true, now(), 'test-provider', 74,
   '+19125557202', NULL, NULL,
   false, NULL, false, false,
   'not_called', 0, NULL, NULL, 'V-102'),

  -- traced, scrubbed, and the scrub came back a litigator
  ('f7000000-0000-4000-8000-000000000103', '70551e00-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001', '31 Bull St', 'Savannah', 'GA', '31401',
   'Serial Plaintiff', true, true,
   true, now(), 'test-provider', 91,
   '+19125557203', NULL, NULL,
   true, now(), false, true,
   'not_called', 0, NULL, NULL, 'V-103'),

  -- on the federal DNC
  ('f7000000-0000-4000-8000-000000000104', '70551e00-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001', '48 Whitaker St', 'Savannah', 'GA', '31401',
   'Registered Owner', false, false,
   true, now(), 'test-provider', 65,
   '+19125557204', NULL, NULL,
   true, now(), true, false,
   'not_called', 0, NULL, NULL, 'V-104'),

  -- traced and scrubbed, but the trace found nothing to dial
  ('f7000000-0000-4000-8000-000000000105', '70551e00-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001', '55 Drayton St', 'Savannah', 'GA', '31401',
   'No Contact Found', false, false,
   true, now(), 'test-provider', 12,
   NULL, NULL, NULL,
   true, now(), false, false,
   'not_called', 0, NULL, NULL, 'V-105'),

  -- clean on paper, but the LANDLINE opted out
  ('f7000000-0000-4000-8000-000000000106', '70551e00-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001', '63 Jones St', 'Savannah', 'GA', '31401',
   'Asked Us To Stop', true, false,
   true, now(), 'test-provider', 80,
   '+19125557206', '+19125557216', NULL,
   true, now(), false, false,
   'no_answer', 1, now() - interval '3 days', NULL, 'V-106')
ON CONFLICT (id) DO NOTHING;

INSERT INTO telephony_opt_outs (team_id, phone_key, source, note)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('+19125557216'),
        'verbal', 'Said do not call again')
ON CONFLICT (team_id, phone_key) DO NOTHING;

\echo '=== 1. a prospect is not callable until traced AND scrubbed ==='
\echo '-- The whole reason this table is separate. There is no consent branch to'
\echo '-- fall back on the way lead_is_dialable has one: on a cold list nobody'
\echo '-- has agreed to anything, so the scrub is the only route to a dial.'
SELECT p.owner_name, p.skip_traced, p.dnc_scrubbed, p.is_dnc, p.is_litigator,
       prospect_is_callable(p.*) AS callable
FROM prospects p
WHERE p.list_id = 'f7000000-0000-4000-8000-000000000001'
ORDER BY p.id;

\echo '-- Named individually, because each of these is a different lawsuit:'
SELECT prospect_is_callable(p.*) AS unscrubbed_is_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000102';
SELECT prospect_is_callable(p.*) AS litigator_is_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000103';
SELECT prospect_is_callable(p.*) AS dnc_is_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000104';
SELECT prospect_is_callable(p.*) AS no_phone_is_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000105';

\echo '-- ...and an opt-out recorded against the landline suppresses the mobile'
\echo '-- too. Someone who said "stop calling" said it about themselves, not'
\echo '-- about one of their phones.'
SELECT prospect_is_callable(p.*) AS opted_out_on_landline_is_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000106';

\echo '-- The one clean row is callable. A rail that never says yes gets removed.'
SELECT prospect_is_callable(p.*) AS clean_is_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000101';

\echo '=== 2. there is no way to text a prospect, and no place to record one ==='
\echo '-- Not a UI policy — a structural fact (§12). Tossie A2P campaign is Low'
\echo '-- Volume Mixed, registered for appointment reminders; cold SMS does not'
\echo '-- match it, and consent nobody gave cannot be stored where a send path'
\echo '-- would find it. Zero consent-shaped columns on the table:'
SELECT count(*) AS consent_columns_on_prospects
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'prospects'
  AND column_name ~ 'consent|opt_in|opted_in|tcpa';

\echo '-- Zero functions named as though they text one:'
SELECT count(*) AS textability_functions
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname ~ 'prospect'
  AND p.proname ~ 'text|sms|messag|broadcast|blast';

\echo '-- And the complete list of functions that take a prospect at all. If this'
\echo '-- ever grows a second entry, somebody read the model wrong.'
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND 'public.prospects'::regtype = ANY(p.proargtypes::oid[])
ORDER BY 1;

\echo '=== 3. prospect_is_callable is STABLE and in no index ==='
\echo '-- Same discipline as lead_is_dialable (20260818120000). It reads'
\echo '-- telephony_opt_outs, so IMMUTABLE would let the planner cache a decision'
\echo '-- no opt-out could ever invalidate — and a STABLE function cannot sit in'
\echo '-- an index expression, so nothing may start depending on that.'
SELECT provolatile AS volatility, prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'prospect_is_callable';

SELECT count(*) AS indexes_referencing_it
FROM pg_indexes WHERE indexdef LIKE '%prospect_is_callable%';

\echo '=== 4. conversion refuses an empty consent source ==='
\echo '-- What is being created is a consent record. A consent record with no'
\echo '-- answer to "how did you obtain this" is not evidence of anything, which'
\echo '-- is also what makes this un-bulk-able: only a human who had the'
\echo '-- conversation can fill it in.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  PERFORM convert_prospect_to_lead('f7000000-0000-4000-8000-000000000101', '');
  RAISE EXCEPTION 'FAIL: a prospect was converted with no consent source';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: an empty consent source is refused';
END $$;

DO $$
BEGIN
  PERFORM convert_prospect_to_lead('f7000000-0000-4000-8000-000000000101', '   ');
  RAISE EXCEPTION 'FAIL: whitespace passed for a consent source';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: whitespace is not a consent source';
END $$;

DO $$
BEGIN
  PERFORM convert_prospect_to_lead('f7000000-0000-4000-8000-000000000101', NULL);
  RAISE EXCEPTION 'FAIL: NULL passed for a consent source';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: NULL is not a consent source';
END $$;

\echo '-- ...and nothing was written on the way to refusing. Counted by the'
\echo '-- prospect stamp in raw_payload rather than by source, because the import'
\echo '-- page writes source = cold_list too and earlier suites have used it.'
SELECT count(*) AS leads_created_by_the_refusals FROM leads
WHERE raw_payload ? 'prospect';
COMMIT;

\echo '=== 5. a real conversion carries the property across and records consent ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;
SELECT id AS lead_a FROM convert_prospect_to_lead(
  'f7000000-0000-4000-8000-000000000101',
  'verbal, cold call — she asked us to follow up with an offer',
  'Estate settles in October'
) \gset
COMMIT;

SELECT name, phone, email, address, city, state, zip, owner_name,
       is_absentee, source, source_detail, status, call_attempts
FROM leads WHERE id = :'lead_a';

\echo '-- The provenance shape record_lead_consent() writes. tcpa_opt_in_at is'
\echo '-- not decoration: leads_opt_in_needs_provenance (20260821120000) rejects'
\echo '-- the boolean without it, so a conversion that forgot it would fail here'
\echo '-- rather than produce a consent nobody can date.'
SELECT tcpa_opt_in, tcpa_opt_in_at IS NOT NULL AS has_timestamp,
       tcpa_disclosure_source, tcpa_disclosure_version,
       tcpa_disclosure_text IS NOT NULL AS has_disclosure,
       consent_sms, consent_email
FROM leads WHERE id = :'lead_a';

\echo '-- The skip trace and the scrub come across too, so the lead does not have'
\echo '-- to be re-traced to be dialable.'
SELECT skip_traced, dnc_scrubbed, is_dnc, is_litigator,
       phone_mobile IS NOT NULL AS kept_mobile
FROM leads WHERE id = :'lead_a';

\echo '=== 6. the created lead passes lead_is_dialable ==='
\echo '-- The point of the conversion: the person moves onto the rail that has a'
\echo '-- consent branch, and every send path in the system asks that rail.'
SELECT lead_is_dialable(l.*) AS dialable FROM leads l WHERE id = :'lead_a';

\echo '=== 7. the prospect is marked, not deleted ==='
\echo '-- The list is the record of what was bought and worked. Deleting the rows'
\echo '-- that worked would make every vendor look worse than they were.'
SELECT converted_lead_id = :'lead_a' AS points_at_the_lead,
       converted_at IS NOT NULL AS dated,
       call_status AS ladder_untouched
FROM prospects WHERE id = 'f7000000-0000-4000-8000-000000000101';

\echo '-- ...and it drops out of the dial queue, because the lead governs now.'
\echo '-- Leaving it callable would mean two systems dialling one homeowner.'
SELECT prospect_is_callable(p.*) AS converted_still_callable FROM prospects p
WHERE id = 'f7000000-0000-4000-8000-000000000101';

\echo '=== 8. the timeline says where they came from AND how consent arrived ==='
\echo '-- Either fact alone invites the wrong conclusion six months later.'
SELECT type, summary,
       payload ->> 'consent_source' AS consent_source,
       payload ->> 'vendor_id'      AS vendor_id
FROM lead_activity
WHERE lead_id = :'lead_a' AND type = 'converted_from_prospect';

\echo '=== 9. conversion is idempotent ==='
\echo '-- A double-click, or a retried request, is not a request for a second'
\echo '-- consent record on the same person.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;
SELECT id AS lead_b FROM convert_prospect_to_lead(
  'f7000000-0000-4000-8000-000000000101',
  'verbal, cold call — she asked us to follow up with an offer'
) \gset
COMMIT;

SELECT :'lead_a' = :'lead_b' AS same_lead_returned;
SELECT count(*) AS leads_for_that_prospect FROM leads
WHERE raw_payload -> 'prospect' ->> 'prospect_id' = 'f7000000-0000-4000-8000-000000000101';
SELECT count(*) AS conversion_activity_rows FROM lead_activity
WHERE lead_id = :'lead_a' AND type = 'converted_from_prospect';

\echo '=== 10. a litigator can be converted, and still cannot be dialled ==='
\echo '-- Refusing the conversion would be the wrong rail: the conversation'
\echo '-- already happened and the record of it should exist. The flags travel'
\echo '-- with the person, and lead_is_dialable goes on saying no. One veto, in'
\echo '-- one place, rather than two half-vetoes that disagree.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;
SELECT id AS lit_lead FROM convert_prospect_to_lead(
  'f7000000-0000-4000-8000-000000000103', 'verbal, inbound call from the owner'
) \gset
COMMIT;

SELECT is_litigator, tcpa_opt_in FROM leads WHERE id = :'lit_lead';
SELECT lead_is_dialable(l.*) AS litigator_lead_dialable FROM leads l WHERE id = :'lit_lead';

\echo '=== 11. a prospect with nothing to call and nothing to email is refused ==='
\echo '-- leads_has_contact would reject it anyway; catching it here tells the'
\echo '-- operator which field is missing instead of a constraint name.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM convert_prospect_to_lead('f7000000-0000-4000-8000-000000000105', 'verbal');
  RAISE EXCEPTION 'FAIL: a prospect with no phone and no email became a lead';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: an untraceable prospect cannot be converted';
END $$;
COMMIT;

\echo '=== 12. the list counters recompute from the rows ==='
\echo '-- Recomputed, not incremented, so a half-failed import cannot leave'
\echo '-- "scrubbed: all of them" on a list that is not.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;
SELECT total_count, skip_traced_count, scrubbed_count, called_count, converted_count
FROM refresh_prospect_list_counts('f7000000-0000-4000-8000-000000000001');
COMMIT;

\echo '=== 13. the same vendor record cannot land on one list twice ==='
\echo '-- Vendors return the same rows on a re-pull. A duplicate is a second call'
\echo '-- to the same homeowner from a system that thinks it never called.'
DO $$
BEGIN
  INSERT INTO prospects (team_id, list_id, owner_name, vendor_id)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'f7000000-0000-4000-8000-000000000001', 'Duplicate Pull', 'V-101');
  RAISE EXCEPTION 'FAIL: a vendor record was imported onto the same list twice';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: vendor ids are unique within a list';
END $$;

\echo '-- ...and the call-status ladder is closed. A typo becomes a row nobody'
\echo '-- filters for, which is a homeowner nobody calls back.'
DO $$
BEGIN
  INSERT INTO prospects (team_id, list_id, owner_name, call_status)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'f7000000-0000-4000-8000-000000000001', 'Bad Ladder', 'maybe_later');
  RAISE EXCEPTION 'FAIL: an unknown call_status was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: call_status is constrained to the ladder';
END $$;

\echo '=== 14. RLS: another team sees no lists, no prospects, and converts none ==='
INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000007', 'Rival Wholesaler')
ON CONFLICT (id) DO NOTHING;
INSERT INTO allowed_signups (email) VALUES ('rival-prospects@example.com')
ON CONFLICT (email) DO NOTHING;
INSERT INTO auth.users (id, email) VALUES
  ('dddddddd-0000-4000-8000-000000000007', 'rival-prospects@example.com')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000007'
 WHERE id = 'dddddddd-0000-4000-8000-000000000007';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000007';
SET LOCAL ROLE authenticated;
SELECT count(*) AS lists_visible_to_rival     FROM prospect_lists;
SELECT count(*) AS prospects_visible_to_rival FROM prospects;

\echo '-- Not just invisible: unconvertible. A leaked uuid buys nothing.'
DO $$
BEGIN
  PERFORM convert_prospect_to_lead('f7000000-0000-4000-8000-000000000102', 'verbal');
  RAISE EXCEPTION 'FAIL: another team converted a prospect it cannot see';
EXCEPTION WHEN no_data_found THEN
  RAISE NOTICE 'PASS: a prospect in another team does not exist to convert';
END $$;
COMMIT;

\echo '=== 15. anon keeps nothing, and no background job may convert ==='
\echo '-- The service_role grant is withheld on purpose: a job that could turn a'
\echo '-- purchased list into consented leads unattended is exactly the thing'
\echo '-- this whole model exists to make impossible.'
SELECT has_table_privilege('anon', 'public.prospects',      'SELECT') AS anon_reads_prospects,
       has_table_privilege('anon', 'public.prospects',      'INSERT') AS anon_writes_prospects,
       has_table_privilege('anon', 'public.prospect_lists', 'SELECT') AS anon_reads_lists;

SELECT has_function_privilege('anon',         'public.prospect_is_callable(public.prospects)', 'EXECUTE') AS anon_can_check_callable,
       has_function_privilege('authenticated','public.prospect_is_callable(public.prospects)', 'EXECUTE') AS operator_can_check_callable,
       has_function_privilege('service_role', 'public.prospect_is_callable(public.prospects)', 'EXECUTE') AS worker_can_check_callable;

SELECT has_function_privilege('anon',         'public.convert_prospect_to_lead(uuid,text,text)', 'EXECUTE') AS anon_can_convert,
       has_function_privilege('authenticated','public.convert_prospect_to_lead(uuid,text,text)', 'EXECUTE') AS operator_can_convert,
       has_function_privilege('service_role', 'public.convert_prospect_to_lead(uuid,text,text)', 'EXECUTE') AS worker_can_convert;

\echo '=== 16. realtime publishes the lists, never the rows ==='
\echo '-- A skip-trace batch touches thousands of prospects in minutes; the'
\echo '-- browser is watching one progress number, which lives on the list.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('prospects', 'prospect_lists')
ORDER BY tablename;
