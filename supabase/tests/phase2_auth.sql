\set ON_ERROR_STOP on
\pset pager off

\echo '=== 1. an allow-listed address can sign up ==='
INSERT INTO auth.users (id, email) VALUES
  ('cccccccc-0000-4000-8000-000000000001', 'info@tossiebuyshouses.com');
SELECT email, (SELECT count(*) FROM profiles WHERE id = 'cccccccc-0000-4000-8000-000000000001') AS profile_created
FROM auth.users WHERE id = 'cccccccc-0000-4000-8000-000000000001';

\echo '=== 2. case does not matter — the gate lowercases ==='
INSERT INTO allowed_signups (email) VALUES ('mixed@example.com');
INSERT INTO auth.users (id, email) VALUES
  ('cccccccc-0000-4000-8000-000000000002', 'MiXeD@Example.COM');
SELECT 'signed up as ' || email AS result FROM auth.users
WHERE id = 'cccccccc-0000-4000-8000-000000000002';

\echo '=== 3. a stranger is refused before any row is written ==='
\echo '-- This is what makes shouldCreateUser:true safe in the app.'
DO $$
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES ('dddddddd-0000-4000-8000-000000000001', 'attacker@evil.example');
  RAISE EXCEPTION 'FAIL: a stranger created an account';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: stranger refused';
END $$;

SELECT count(*) AS stranger_auth_rows FROM auth.users WHERE email = 'attacker@evil.example';
SELECT count(*) AS stranger_profiles   FROM profiles  WHERE email = 'attacker@evil.example';
SELECT count(*) AS stranger_team_rows  FROM team_members
WHERE user_id = 'dddddddd-0000-4000-8000-000000000001';

\echo '=== 4. the allow-list is not readable by anon ==='
SELECT
  has_table_privilege('anon',          'public.allowed_signups', 'SELECT') AS anon_can_read,
  has_table_privilege('authenticated', 'public.allowed_signups', 'SELECT') AS authed_has_grant;

\echo '=== 5. a non-owner member cannot read or extend the allow-list ==='
\echo '-- The list of who can get in is itself a list worth phishing.'
INSERT INTO allowed_signups (email) VALUES ('member@example.com');
INSERT INTO auth.users (id, email) VALUES
  ('cccccccc-0000-4000-8000-000000000003', 'member@example.com');

BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000003';
SET LOCAL ROLE authenticated;
SELECT count(*) AS rows_visible_to_member FROM allowed_signups;
COMMIT;

\echo '=== 6. the owner can ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT count(*) AS rows_visible_to_owner FROM allowed_signups;
COMMIT;

\echo '=== 7. the first signup owns the team, later ones do not ==='
SELECT p.email, p.app_role, tm.role AS team_role
FROM profiles p JOIN team_members tm ON tm.user_id = p.id
ORDER BY p.created_at;
