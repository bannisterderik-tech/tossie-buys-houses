\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
--
-- NOTE ON WHAT THIS BLANKET GRANT MAKES UNTESTABLE: the migration deliberately
-- withholds DELETE from `authenticated` on sms_messages, call_log and
-- telephony_opt_outs, so no operator UI can erase an opt-out or a thread. This
-- line hands it straight back, and phase0/phase1 run the same line against the
-- same database first, so an assertion on that grant would pass when this suite
-- runs alone and fail when it runs in sequence. Nothing here checks it, and
-- saying so is better than an assertion that only tests its own setup — the
-- place to confirm it is the live project, where the grants are whatever the
-- migrations left them.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- Signups are gated by allowed_signups (20260817140000), so the fixtures have
-- to earn their way in the same way a real operator would.
INSERT INTO allowed_signups (email) VALUES
  ('tossie@tossiebuyshouses.com'), ('outsider@example.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'tossie@tossiebuyshouses.com',
        '{"full_name":"Tossie Griner"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000001', 'Someone Else')
ON CONFLICT (id) DO NOTHING;
INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'outsider@example.com')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000001'
  WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';

\echo '=== 1. the one team got a settings row, with the safe defaults ==='
\echo '-- recording off (FL is two-party consent), SMS not paused.'
SELECT team_id = '70551e00-0000-4000-8000-000000000001' AS the_one_team,
       recording_enabled, sms_send_paused
FROM telephony_settings;

\echo '=== 2. a number bought during A2P vetting is voice-only by default ==='
\echo '-- Texting from an unregistered number is what gets a campaign rejected.'
INSERT INTO phone_numbers (team_id, e164, friendly_name, is_primary)
VALUES ('70551e00-0000-4000-8000-000000000001', '+19125550100', 'Main line', true);

SELECT friendly_name, voice_enabled, sms_enabled, a2p_status
FROM phone_numbers WHERE e164 = '+19125550100';

\echo '=== 3. a team cannot have two primary numbers ==='
\echo '-- Otherwise "which number do we send from" resolves by planner luck.'
DO $$
BEGIN
  INSERT INTO phone_numbers (team_id, e164, is_primary)
  VALUES ('70551e00-0000-4000-8000-000000000001', '+19125550101', true);
  RAISE EXCEPTION 'FAIL: a second primary number was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: one primary per team';
END $$;

\echo '=== 4. a redelivered Twilio webhook cannot double the thread ==='
\echo '-- Twilio retries any non-2xx. twilio_sid UNIQUE is the dedup.'
INSERT INTO leads (team_id, name, phone, address, city, state, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Stop Test', '(912) 555-0777',
        '77 Opt Out Ln', 'Savannah', 'GA', 'website', true, now());

INSERT INTO sms_messages (team_id, lead_id, direction, from_e164, to_e164, body, status, twilio_sid)
VALUES ('70551e00-0000-4000-8000-000000000001',
        (SELECT id FROM leads WHERE name = 'Stop Test'),
        'inbound', '+19125550777', '+19125550100', 'STOP', 'received', 'SM_fixture_stop_1');

DO $$
BEGIN
  INSERT INTO sms_messages (team_id, direction, from_e164, to_e164, body, status, twilio_sid)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'inbound', '+19125550777', '+19125550100', 'STOP', 'received', 'SM_fixture_stop_1');
  RAISE EXCEPTION 'FAIL: the same Twilio SID was stored twice';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: redelivered webhook deduped on twilio_sid';
END $$;

\echo '=== 5. the lead is dialable right up until the STOP is recorded ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, lead_is_dialable(l.*) AS dialable_before
FROM leads l WHERE name = 'Stop Test';
COMMIT;

\echo '-- the webhook writes phone_key form, never the formatted number'
INSERT INTO telephony_opt_outs (team_id, phone_key, source, note)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('+19125550777'),
        'sms_stop', 'replied STOP');

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, lead_is_dialable(l.*) AS dialable_after
FROM leads l WHERE name = 'Stop Test';
COMMIT;

\echo '=== 6. a second STOP is a no-op, not a second row ==='
\echo '-- Twilio retries, and sellers text STOP more than once when annoyed.'
INSERT INTO telephony_opt_outs (team_id, phone_key, source)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('912-555-0777'), 'sms_stop')
ON CONFLICT (team_id, phone_key) DO NOTHING;

SELECT count(*) AS opt_out_rows_for_that_number
FROM telephony_opt_outs WHERE phone_key = phone_key('+19125550777');

\echo '=== 7. is_opted_out matches across every format the number arrives in ==='
\echo '-- Twilio posts E.164, the seller typed parentheses, the list had dashes.'
SELECT
  is_opted_out('70551e00-0000-4000-8000-000000000001', '+19125550777')     AS e164,
  is_opted_out('70551e00-0000-4000-8000-000000000001', '(912) 555-0777')   AS formatted,
  is_opted_out('70551e00-0000-4000-8000-000000000001', '912-555-0777')     AS dashed,
  is_opted_out('70551e00-0000-4000-8000-000000000001', '9125550777')       AS bare,
  is_opted_out('70551e00-0000-4000-8000-000000000001', '1 912 555 0777')   AS with_country_code,
  is_opted_out('70551e00-0000-4000-8000-000000000001', '+19125550778')     AS different_number,
  is_opted_out('70551e00-0000-4000-8000-000000000001', NULL)               AS null_number;

\echo '=== 8. an opt-out on one team does not suppress another team''s lead ==='
\echo '-- is_opted_out takes p_team because the service role bypasses RLS and'
\echo '-- would otherwise see every team''s suppression list as one list.'
INSERT INTO leads (team_id, name, phone, address, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Other Team Opt Out', '(912) 555-0888',
        '88 Elsewhere Rd', 'website', true, now());
INSERT INTO telephony_opt_outs (team_id, phone_key, source)
VALUES ('99999999-0000-4000-8000-000000000001', phone_key('+19125550888'), 'manual')
ON CONFLICT (team_id, phone_key) DO NOTHING;

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, lead_is_dialable(l.*) AS still_dialable
FROM leads l WHERE name = 'Other Team Opt Out';
COMMIT;

\echo '=== 9. a STOP on the landline suppresses the mobile too ==='
\echo '-- Dialing the mobile because the STOP arrived on the other line is the'
\echo '-- exact fact pattern that gets a wholesaler sued.'
INSERT INTO leads (team_id, name, phone, phone_mobile, address, source, skip_traced, dnc_scrubbed)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Two Lines', '9125550901', '9125550902',
        '9 Two Line Way', 'cold_list', true, true);
INSERT INTO telephony_opt_outs (team_id, phone_key, source)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('9125550901'), 'sms_stop')
ON CONFLICT (team_id, phone_key) DO NOTHING;

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, lead_is_dialable(l.*) AS dialable
FROM leads l WHERE name = 'Two Lines';
COMMIT;

\echo '=== 10. the inbound webhook finds its lead by phone_key, not by string ==='
\echo '-- Twilio sent +19125550777; the seller typed (912) 555-0777.'
SELECT l.name
FROM sms_messages m
JOIN leads l ON phone_key(l.phone) = phone_key(m.from_e164)
WHERE m.twilio_sid = 'SM_fixture_stop_1';

\echo '=== 11. START removes the suppression and the lead is dialable again ==='
\echo '-- Only the service role can do this; authenticated has no DELETE grant.'
DELETE FROM telephony_opt_outs
WHERE team_id = '70551e00-0000-4000-8000-000000000001'
  AND phone_key = phone_key('+19125550777');

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, lead_is_dialable(l.*) AS dialable_after_start
FROM leads l WHERE name = 'Stop Test';
COMMIT;

\echo '=== 12. RLS: an outsider sees none of it ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT (SELECT count(*) FROM sms_messages)       AS sms_visible,
       (SELECT count(*) FROM phone_numbers)      AS numbers_visible,
       (SELECT count(*) FROM call_log)           AS calls_visible,
       (SELECT count(*) FROM telephony_settings) AS settings_visible,
       -- One row, and it is the outsider's own — proof the count above is
       -- filtering rather than the table simply being empty.
       (SELECT count(*) FROM telephony_opt_outs) AS opt_outs_visible;
COMMIT;

\echo '=== 13. RLS: an outsider cannot write into our team either ==='
\echo '-- Without WITH CHECK, forging an inbound message would be one INSERT.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO sms_messages (team_id, direction, from_e164, to_e164, body)
    VALUES ('70551e00-0000-4000-8000-000000000001', 'inbound',
            '+19125559999', '+19125550100', 'forged');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: outsider inserted a message into another team';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: WITH CHECK rejected the cross-team insert';
  END;
END $$;

\echo '=== 14. the public anon key has zero reach into telephony ==='
\echo '-- This key is in the browser bundle. Expect false on every column.'
SELECT
  has_table_privilege('anon', 'public.sms_messages',       'SELECT') AS anon_sms_select,
  has_table_privilege('anon', 'public.sms_messages',       'INSERT') AS anon_sms_insert,
  has_table_privilege('anon', 'public.telephony_opt_outs', 'SELECT') AS anon_opt_outs_select,
  has_table_privilege('anon', 'public.telephony_opt_outs', 'DELETE') AS anon_opt_outs_delete,
  has_table_privilege('anon', 'public.phone_numbers',      'SELECT') AS anon_numbers_select,
  has_table_privilege('anon', 'public.call_log',           'SELECT') AS anon_calls_select,
  has_table_privilege('anon', 'public.telephony_settings', 'SELECT') AS anon_settings_select,
  has_function_privilege('anon', 'public.is_opted_out(uuid, text)', 'EXECUTE') AS anon_is_opted_out,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('phone_numbers','sms_messages','telephony_opt_outs',
                        'call_log','telephony_settings')
      AND 'anon' = ANY(roles)) AS policies_naming_anon;

\echo '=== 15. every telephony table has RLS on ==='
SELECT c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('phone_numbers','sms_messages','telephony_opt_outs',
                    'call_log','telephony_settings')
ORDER BY c.relname;

\echo '=== 16. lead_is_dialable dropped to STABLE, and nothing indexed it ==='
\echo '-- A function that reads a table and claims IMMUTABLE gets folded into a'
\echo '-- cached plan that no STOP message will ever invalidate. s = stable.'
SELECT p.proname, p.provolatile
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('is_opted_out', 'lead_is_dialable')
ORDER BY p.proname;

\echo '-- The claim the migration comment makes, asserted: no index was broken'
\echo '-- by the volatility change, and none may be added later.'
SELECT count(*) AS indexes_referencing_lead_is_dialable
FROM pg_indexes
WHERE schemaname = 'public' AND indexdef LIKE '%lead_is_dialable%';

\echo '=== 17. the message thread is published to realtime ==='
\echo '-- Without this the thread subscribes, succeeds, and never updates.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
ORDER BY tablename;
