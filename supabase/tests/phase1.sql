\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- Signups are gated by allowed_signups (20260817140000). Production requires an
-- operator to be allow-listed before they can ever sign in; the fixtures below
-- have to earn their way in the same way, or they are testing a path real users
-- do not have.
INSERT INTO allowed_signups (email) VALUES
  ('tossie@tossiebuyshouses.com'), ('va@example.com'), ('outsider@example.com')
ON CONFLICT (email) DO NOTHING;

-- These run as the caller, so the suite has to be a real signed-in user.
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'tossie@tossiebuyshouses.com',
        '{"full_name":"Tossie Griner"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO leads (team_id, name, phone, address, city, state, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Disposition Test', '9125551000',
        '1 Test St', 'Savannah', 'GA', 'website', true, now());

\echo '=== 1. no_answer: attempting, +1 day, attempt counted ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT status, call_attempts,
       round(extract(epoch FROM (next_follow_up_at - now())) / 3600) AS follow_up_in_hours
FROM log_disposition(
  (SELECT id FROM leads WHERE name = 'Disposition Test'),
  'no_answer', 'rang out');
COMMIT;

\echo '=== 2. an explicit follow-up time overrides the default ladder ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT status, call_attempts,
       round(extract(epoch FROM (next_follow_up_at - now())) / 3600) AS follow_up_in_hours
FROM log_disposition(
  (SELECT id FROM leads WHERE name = 'Disposition Test'),
  'callback_requested', 'asked for Tuesday', now() + interval '96 hours');
COMMIT;

\echo '=== 3. do_not_call kills dialability — the whole point of the control ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT status, is_dnc, consent_sms FROM log_disposition(
  (SELECT id FROM leads WHERE name = 'Disposition Test'), 'do_not_call', 'told us to stop');
COMMIT;

SELECT name, is_dnc, lead_is_dialable(l.*) AS still_dialable
FROM leads l WHERE name = 'Disposition Test';

\echo '=== 4. wrong_number flags without deleting, and drops it from the queue ==='
\echo '-- No email on this one, exactly like a real cold-list lead. Nulling the'
\echo '-- phones here would violate leads_has_contact and fail the disposition.'
INSERT INTO leads (team_id, name, phone, phone_mobile, address, source, skip_traced, dnc_scrubbed)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Wrong Number', '9125552000', '9125552001',
        '2 Test St', 'cold_list', true, true);
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT phone, phone_mobile, phone_invalid FROM log_disposition(
  (SELECT id FROM leads WHERE name = 'Wrong Number'), 'wrong_number');
COMMIT;
SELECT name, phone IS NOT NULL AS number_kept, lead_is_dialable(l.*) AS still_dialable
FROM leads l WHERE name = 'Wrong Number';

\echo '=== 5. an unknown outcome is rejected, not silently accepted ==='
DO $$
BEGIN
  PERFORM log_disposition((SELECT id FROM leads WHERE name = 'Wrong Number'), 'vibes');
  RAISE EXCEPTION 'FAIL: unknown outcome was accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: unknown disposition rejected';
END $$;

\echo '=== 6. board move writes the card and the activity row ==='
-- tcpa_opt_in now requires a timestamp (leads_opt_in_needs_provenance): asserting
-- consent without recording when it was given is not evidence of anything.
INSERT INTO leads (team_id, name, phone, address, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Board Move', '9125553000', '3 Test St', 'website', true, now());

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT move_lead_to_stage(
  (SELECT id FROM leads WHERE name = 'Board Move'),
  (SELECT id FROM pipeline_stages WHERE name = 'Qualified'));
COMMIT;

SELECT l.name, s.name AS stage
FROM leads l
JOIN lead_pipeline_memberships m ON m.lead_id = l.id
JOIN pipeline_stages s ON s.id = m.stage_id
WHERE l.name = 'Board Move';

SELECT type, summary FROM lead_activity
WHERE lead_id = (SELECT id FROM leads WHERE name = 'Board Move') AND type = 'stage_changed';

\echo '=== 7. moving to the same stage is a no-op, not a duplicate log ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT move_lead_to_stage(
  (SELECT id FROM leads WHERE name = 'Board Move'),
  (SELECT id FROM pipeline_stages WHERE name = 'Qualified'));
COMMIT;
SELECT count(*) AS stage_changed_rows FROM lead_activity
WHERE lead_id = (SELECT id FROM leads WHERE name = 'Board Move') AND type = 'stage_changed';

\echo '=== 8. RLS still applies inside the RPCs (SECURITY INVOKER) ==='
\echo '-- An outsider must not be able to disposition another team''s lead.'
INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000001', 'Someone Else')
ON CONFLICT (id) DO NOTHING;
INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'outsider@example.com')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000001'
  WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';

DO $$
DECLARE v_lead uuid;
BEGIN
  SELECT id INTO v_lead FROM leads WHERE name = 'Board Move';
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM log_disposition(v_lead, 'no_answer');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: outsider dispositioned another team''s lead';
  EXCEPTION WHEN no_data_found THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: outsider could not see the lead to disposition it';
  END;
END $$;

\echo '=== 9. the due queue surfaces only what is actually due ==='
UPDATE leads SET next_follow_up_at = now() - interval '1 hour' WHERE name = 'Board Move';
UPDATE leads SET next_follow_up_at = now() + interval '5 days'  WHERE name = 'Wrong Number';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, dialable FROM due_leads ORDER BY name;
COMMIT;

\echo '=== 10. the due view respects RLS (security_invoker) ==='
\echo '-- A plain view runs as its owner and would hand every team to everyone.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT count(*) AS due_visible_to_outsider FROM due_leads;
COMMIT;
