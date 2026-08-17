\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

\echo '=== 1. signup trigger: first user becomes owner/admin ==='
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'tossie@tossiebuyshouses.com',
        '{"full_name":"Tossie Griner"}'::jsonb);

SELECT p.full_name, p.app_role, tm.role AS team_role,
       p.team_id = '70551e00-0000-4000-8000-000000000001' AS on_the_one_team
FROM profiles p JOIN team_members tm ON tm.user_id = p.id
WHERE p.id = 'aaaaaaaa-0000-4000-8000-000000000001';

\echo '=== 2. second user is a plain member ==='
INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 'va@example.com');
SELECT p.app_role, tm.role AS team_role FROM profiles p
  JOIN team_members tm ON tm.user_id = p.id
WHERE p.id = 'aaaaaaaa-0000-4000-8000-000000000002';

\echo '=== 3. teams.created_by was backfilled to the first user ==='
SELECT created_by = 'aaaaaaaa-0000-4000-8000-000000000001' AS owner_set FROM teams;

\echo '=== 4. website lead insert (service-role path, bypasses RLS) ==='
INSERT INTO leads (team_id, name, phone, email, address, city, state, source,
                   tcpa_opt_in, tcpa_opt_in_at, consent_sms, consent_email,
                   tcpa_disclosure_text, page_path)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Jane Seller', '(912) 555-0134',
        'jane@example.com', '14 Oak St', 'Savannah', 'GA', 'website',
        true, now(), true, true, 'By submitting you agree to be contacted...', '/sell-my-house-fast/savannah-ga/');

\echo '=== 5. dialability ==='
SELECT name,
       lead_is_dialable(l.*) AS dialable
FROM leads l;

\echo '-- a cold-list lead, traced but not scrubbed, must NOT be dialable'
INSERT INTO leads (team_id, name, phone_mobile, address, source, skip_traced, dnc_scrubbed)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Cold Lead A', '9125550199', '9 Pine Ave', 'cold_list', true, false);
\echo '-- same lead once scrubbed clean IS dialable'
INSERT INTO leads (team_id, name, phone_mobile, address, source, skip_traced, dnc_scrubbed)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Cold Lead B', '9125550200', '11 Pine Ave', 'cold_list', true, true);
\echo '-- a scrubbed lead flagged litigator must NOT be dialable'
INSERT INTO leads (team_id, name, phone_mobile, address, source, skip_traced, dnc_scrubbed, is_litigator)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Litigator', '9125550201', '13 Pine Ave', 'cold_list', true, true, true);

SELECT name, source, skip_traced, dnc_scrubbed, is_litigator, lead_is_dialable(l.*) AS dialable
FROM leads l ORDER BY created_at;

\echo '=== 6. contact-required constraint rejects a lead with no way to reach it ==='
DO $$
BEGIN
  INSERT INTO leads (team_id, name, address)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'No Contact', '1 Nowhere');
  RAISE EXCEPTION 'FAIL: constraint did not fire';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: leads_has_contact rejected the row';
END $$;

\echo '=== 7. status change writes a timeline entry ==='
UPDATE leads SET status = 'contacted' WHERE name = 'Jane Seller';
SELECT type, summary, actor_kind FROM lead_activity;

\echo '=== 8. RLS: teammate sees the leads ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT count(*) AS leads_visible_to_teammate FROM leads;
COMMIT;

\echo '=== 9. RLS: an outsider on another team sees nothing ==='
INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000001', 'Someone Else');
INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'outsider@example.com');
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000001'
  WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT count(*) AS leads_visible_to_outsider FROM leads;
COMMIT;

\echo '=== 10. RLS: a non-owner member cannot flip the SDR auto-send gate ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
UPDATE teams SET sdr_auto_send_approved = true
  WHERE id = '70551e00-0000-4000-8000-000000000001';
SELECT count(*) AS rows_member_could_update FROM teams WHERE sdr_auto_send_approved;
COMMIT;

\echo '=== 11. RLS: the owner can ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
UPDATE teams SET sdr_auto_send_approved = true
  WHERE id = '70551e00-0000-4000-8000-000000000001';
COMMIT;
SELECT sdr_auto_send_approved AS owner_could_update FROM teams
WHERE id = '70551e00-0000-4000-8000-000000000001';

\echo '=== 12. default pipeline seeded ==='
SELECT p.name AS pipeline, count(s.id) AS stages
FROM pipelines p LEFT JOIN pipeline_stages s ON s.pipeline_id = p.id
GROUP BY p.name;

\echo '=== 13. phone lookup by digits (inbound webhook path) ==='
\echo '-- Twilio sends E.164; the seller typed a formatted number. Both must hit.'
SELECT name FROM leads WHERE phone_key(phone) = phone_key('+1 (912) 555-0134');

\echo '=== 14. every new lead was auto-placed on the board ==='
SELECT l.name, p.name AS pipeline, s.name AS stage
FROM leads l
JOIN lead_pipeline_memberships m ON m.lead_id = l.id
JOIN pipelines p ON p.id = m.pipeline_id
JOIN pipeline_stages s ON s.id = m.stage_id
ORDER BY l.created_at;

\echo '=== 15. every new lead logged a creation event ==='
SELECT type, count(*) FROM lead_activity GROUP BY type ORDER BY type;

\echo '=== 16. trigger functions are not reachable as REST endpoints ==='
\echo '-- Supabase publishes public-schema functions at /rest/v1/rpc/<name>.'
\echo '-- Expect false for every role on every trigger function.'
SELECT p.proname,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('handle_new_user', 'log_lead_status_change',
                    'place_new_lead_on_pipeline', 'touch_updated_at')
ORDER BY p.proname;

\echo '=== 17. RLS helpers stay executable by authenticated, never by anon ==='
\echo '-- Policy expressions run as the querying role: revoking from'
\echo '-- authenticated would make every policy error, not merely deny.'
SELECT p.proname,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('get_my_team_id', 'is_team_owner', 'phone_key', 'lead_is_dialable')
ORDER BY p.proname;

\echo '=== 18. the public anon key cannot touch the public schema at all ==='
\echo '-- This key ships in the browser bundle. RLS already denies it; the'
\echo '-- table grants are the second lock. Expect false on every anon column.'
SELECT
  has_table_privilege('anon',          'public.leads',    'SELECT') AS anon_leads_select,
  has_table_privilege('anon',          'public.leads',    'INSERT') AS anon_leads_insert,
  has_table_privilege('anon',          'public.profiles', 'SELECT') AS anon_profiles_select,
  has_table_privilege('authenticated', 'public.leads',    'SELECT') AS authed_leads_select,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND 'anon' = ANY(roles)) AS policies_naming_anon;

\echo '=== 19. no table in the public schema is missing RLS ==='
SELECT count(*) AS tables_without_rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

\echo '=== 20. the leads feed is published to realtime ==='
\echo '-- Without this the app subscribes successfully and receives nothing.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
ORDER BY tablename;
