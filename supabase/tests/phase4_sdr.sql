\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
--
-- SAME CAVEAT AS phase2_telephony: this blanket grant hands `authenticated`
-- privileges the migration deliberately withheld — DELETE on sdr_conversations,
-- INSERT and UPDATE on sdr_sends. An assertion on those grants would pass when
-- this suite runs alone and fail when it runs after phase0, which already ran
-- the same line against the same database. So nothing here asserts them; the
-- place to confirm the send ledger is append-only-by-the-server is the live
-- project. Function privileges ARE assertable, because no suite grants
-- ROUTINES, and §9 checks the ones that matter.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO allowed_signups (email) VALUES ('tossie@tossiebuyshouses.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'tossie@tossiebuyshouses.com',
        '{"full_name":"Tossie Griner"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO leads (id, team_id, name, phone, address, city, state, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('cccccccc-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001', 'SDR Test Seller', '9125552000',
        '9 Bay St', 'Savannah', 'GA', 'website', true, now())
ON CONFLICT (id) DO NOTHING;

\echo '=== 1. the one team got SDR settings, and they are the safe ones ==='
\echo '-- Disabled, drafting, SMS only. Nothing here starts talking on its own.'
SELECT enabled, default_mode, grace_period_seconds, sms_channel_enabled, email_channel_enabled
FROM sdr_settings WHERE team_id = '70551e00-0000-4000-8000-000000000001';

\echo '=== 2. auto-send needs the owner flag, which also ships off ==='
\echo '-- Half the gate lives here; the other half is the choke point in ai-sdr.'
SELECT sdr_auto_send_approved FROM teams WHERE id = '70551e00-0000-4000-8000-000000000001';

\echo '=== 3. default_mode cannot be set to something that is not a mode ==='
DO $$
BEGIN
  UPDATE sdr_settings SET default_mode = 'yolo'
   WHERE team_id = '70551e00-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: an unknown SDR mode was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: default_mode is constrained to draft/auto';
END $$;

\echo '=== 4. the step machine is the wholesaler one, not the retail one ==='
\echo '-- reoperative qualifies buyers: intent, area_property, financial. A step'
\echo '-- name that survived the port unedited fails here rather than in prod.'
INSERT INTO sdr_conversations (id, team_id, lead_id, step)
VALUES ('dddddddd-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000001', 'motivation');

DO $$
BEGIN
  UPDATE sdr_conversations SET step = 'area_property'
   WHERE id = 'dddddddd-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: a retail qualification step was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: retail steps are not part of this ladder';
END $$;

SELECT step, mode, channel, active, drip_count
FROM sdr_conversations WHERE id = 'dddddddd-0000-4000-8000-000000000001';

\echo '=== 5. one live conversation per lead ==='
\echo '-- A lead that arrives twice must not get two SDRs texting in parallel.'
DO $$
BEGIN
  INSERT INTO sdr_conversations (team_id, lead_id)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'FAIL: a second active conversation was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: one active conversation per lead';
END $$;

\echo '-- ...but a finished conversation does not block re-enrolling later.'
UPDATE sdr_conversations SET active = false, step = 'completed'
 WHERE id = 'dddddddd-0000-4000-8000-000000000001';
INSERT INTO sdr_conversations (id, team_id, lead_id, step)
VALUES ('dddddddd-0000-4000-8000-000000000002',
        '70551e00-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000001', 'greeting');
SELECT count(*) AS conversations_for_lead,
       count(*) FILTER (WHERE active) AS active_ones
FROM sdr_conversations WHERE lead_id = 'cccccccc-0000-4000-8000-000000000001';

\echo '=== 6. the send ledger refuses to claim the same turn twice ==='
\echo '-- This is the guard between a retried cron run and a homeowner getting'
\echo '-- the same text two or three times.'
INSERT INTO sdr_sends (team_id, conversation_id, lead_id, idem_key, origin, body_hash)
VALUES ('70551e00-0000-4000-8000-000000000001',
        'dddddddd-0000-4000-8000-000000000002',
        'cccccccc-0000-4000-8000-000000000001',
        'sdr:dddddddd-0000-4000-8000-000000000002:0', 'auto', 'deadbeef');

DO $$
BEGIN
  INSERT INTO sdr_sends (team_id, conversation_id, lead_id, idem_key, origin, body_hash)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'dddddddd-0000-4000-8000-000000000002',
          'cccccccc-0000-4000-8000-000000000001',
          'sdr:dddddddd-0000-4000-8000-000000000002:0', 'auto', 'deadbeef');
  RAISE EXCEPTION 'FAIL: the same turn was claimed twice';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: a repeat claim collides instead of double-sending';
END $$;

\echo '=== 7. a send is either autonomous or approved, and says which ==='
\echo '-- "Did a human read this before it went out" is the question the whole'
\echo '-- draft-by-default design exists to answer, so it is a stored column.'
DO $$
BEGIN
  INSERT INTO sdr_sends (team_id, idem_key, origin, body_hash)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'x', 'somehow', 'abc');
  RAISE EXCEPTION 'FAIL: an unknown send origin was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: origin is auto or approved';
END $$;

\echo '=== 8. conversation locking: two workers cannot both take a turn ==='
SELECT public.try_sdr_conversation_lock('dddddddd-0000-4000-8000-000000000002')
       IS NOT NULL AS first_worker_got_it \gset
SELECT public.try_sdr_conversation_lock('dddddddd-0000-4000-8000-000000000002')
       IS NULL AS second_worker_blocked \gset
SELECT :'first_worker_got_it' AS first_worker_got_it,
       :'second_worker_blocked' AS second_worker_blocked;

DO $$
DECLARE v_claim uuid;
BEGIN
  SELECT processing_claim_id INTO v_claim FROM sdr_conversations
   WHERE id = 'dddddddd-0000-4000-8000-000000000002';
  PERFORM public.release_sdr_conversation_lock('dddddddd-0000-4000-8000-000000000002', v_claim);
  IF (SELECT processing_claim_id FROM sdr_conversations
       WHERE id = 'dddddddd-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: release did not clear the claim';
  END IF;
  IF public.try_sdr_conversation_lock('dddddddd-0000-4000-8000-000000000002') IS NULL THEN
    RAISE EXCEPTION 'FAIL: a released conversation could not be re-locked';
  END IF;
  RAISE NOTICE 'PASS: release frees the conversation for the next worker';
END $$;

\echo '-- A worker whose lock already expired must not release its successor.'
DO $$
BEGIN
  PERFORM public.release_sdr_conversation_lock(
    'dddddddd-0000-4000-8000-000000000002', gen_random_uuid());
  IF (SELECT processing_claim_id FROM sdr_conversations
       WHERE id = 'dddddddd-0000-4000-8000-000000000002') IS NULL THEN
    RAISE EXCEPTION 'FAIL: a stale claim id released someone else''s lock';
  END IF;
  RAISE NOTICE 'PASS: release only matches its own claim';
END $$;

\echo '-- A crashed worker leaves a claim behind; the reaper clears it, but only'
\echo '-- once it is old enough to be unambiguously abandoned.'
SELECT public.reap_stale_sdr_claims() AS fresh_claims_reaped;
UPDATE sdr_conversations SET processing_started_at = now() - interval '20 minutes'
 WHERE id = 'dddddddd-0000-4000-8000-000000000002';
SELECT public.reap_stale_sdr_claims() AS stale_claims_reaped;
SELECT processing_claim_id IS NULL AS lock_is_free
FROM sdr_conversations WHERE id = 'dddddddd-0000-4000-8000-000000000002';

\echo '=== 9. the lock RPCs are not reachable from a browser ==='
\echo '-- They exist for the cron workers, which run on the service role. An'
\echo '-- operator who can take a worker lock can wedge the SDR.'
SELECT has_function_privilege('authenticated', 'public.try_sdr_conversation_lock(uuid)', 'EXECUTE') AS authed_can_lock,
       has_function_privilege('anon',          'public.try_sdr_conversation_lock(uuid)', 'EXECUTE') AS anon_can_lock,
       has_function_privilege('authenticated', 'public.reap_stale_sdr_claims()',        'EXECUTE') AS authed_can_reap,
       has_function_privilege('service_role',  'public.try_sdr_conversation_lock(uuid)', 'EXECUTE') AS worker_can_lock;

\echo '=== 10. per-lead overrides: NULL inherits, garbage is refused ==='
\echo '-- NULL rather than false, so switching the SDR on does not silently'
\echo '-- enrol every lead already in the database, and does not leave them all'
\echo '-- opted out forever either.'
SELECT sdr_enabled IS NULL AS inherits_by_default,
       sdr_mode    IS NULL AS mode_inherits_by_default
FROM leads WHERE id = 'cccccccc-0000-4000-8000-000000000001';

DO $$
BEGIN
  UPDATE leads SET sdr_mode = 'full_send' WHERE id = 'cccccccc-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: an unknown per-lead SDR mode was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: per-lead sdr_mode is constrained too';
END $$;

\echo '=== 11. a stage move by the SDR is not logged as a person ==='
\echo '-- move_lead_to_stage used to hardcode actor_kind = user. The SDR runs on'
\echo '-- the service role with no auth.uid(), so every AI move claimed a human'
\echo '-- had dragged the card.'
SELECT public.move_lead_to_stage(
  'cccccccc-0000-4000-8000-000000000001',
  (SELECT id FROM pipeline_stages
    WHERE pipeline_id = '70551e00-0000-4000-8000-000000000010' AND name = 'Qualified')
);
SELECT actor_kind, actor_id IS NULL AS no_human_attached, summary
FROM lead_activity
WHERE lead_id = 'cccccccc-0000-4000-8000-000000000001' AND type = 'stage_changed'
ORDER BY created_at DESC LIMIT 1;

\echo '-- ...and the same call by a signed-in operator still logs as a user.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT public.move_lead_to_stage(
  'cccccccc-0000-4000-8000-000000000001',
  (SELECT id FROM pipeline_stages
    WHERE pipeline_id = '70551e00-0000-4000-8000-000000000010' AND name = 'Appointment Set')
);
SELECT actor_kind, actor_id IS NOT NULL AS human_attached
FROM lead_activity
WHERE lead_id = 'cccccccc-0000-4000-8000-000000000001' AND type = 'stage_changed'
ORDER BY created_at DESC LIMIT 1;
COMMIT;

\echo '=== 12. RLS: another team cannot read this conversation ==='
INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000002', 'Rival Wholesaler')
ON CONFLICT (id) DO NOTHING;
INSERT INTO allowed_signups (email) VALUES ('rival@example.com') ON CONFLICT (email) DO NOTHING;
INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-0000-4000-8000-000000000002', 'rival@example.com')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000002'
 WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT count(*) AS conversations_visible_to_rival FROM sdr_conversations;
SELECT count(*) AS sends_visible_to_rival        FROM sdr_sends;
SELECT count(*) AS settings_visible_to_rival     FROM sdr_settings;
COMMIT;

\echo '=== 13. the SDR tables are on the realtime publication ==='
\echo '-- The approval queue has to fill in while the operator is looking at it.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename = 'sdr_conversations';

\echo '=== 14. anon keeps nothing ==='
SELECT has_table_privilege('anon', 'public.sdr_conversations', 'SELECT') AS anon_reads_transcripts,
       has_table_privilege('anon', 'public.sdr_sends',         'SELECT') AS anon_reads_ledger,
       has_table_privilege('anon', 'public.sdr_settings',      'SELECT') AS anon_reads_settings;
