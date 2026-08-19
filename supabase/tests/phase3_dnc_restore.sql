\set ON_ERROR_STOP on
\pset pager off

-- ============================================================================
-- Taking a lead back off do-not-call — 20260819130000_dnc_restore.sql
-- ============================================================================
-- Two writes that look alike and are not. Clearing leads.is_dnc undoes a
-- misclick nobody asked for; clearing telephony_opt_outs re-enables contacting
-- someone who texted STOP. The assertions below are the ones that decide
-- whether the second can happen by accident while doing the first.
--
-- SAME CAVEAT AS phase2_telephony, phase3_number_release AND phase4_sdr: the
-- blanket grant on the next line hands `authenticated` privileges the
-- migrations deliberately withheld — including the DELETE on telephony_opt_outs
-- whose absence is the entire reason clear_phone_opt_out is SECURITY DEFINER,
-- and the UPDATE/DELETE on dnc_restore_log that make it append-only. No
-- assertion below reads a grant held by `authenticated`. What §7 does assert is
-- the anon side, which this line does not touch, and the reason CHECK, which is
-- a constraint and survives any grant.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

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

-- Four leads, one per way this can go wrong.
--
--   0301 misclick  — flagged is_dnc by a mis-tapped disposition, never opted out
--   0302 stopped   — texted STOP, nothing else wrong with the lead
--   0303 unscrubbed— texted STOP AND is an unscrubbed cold-list row
--   0304 both      — flagged is_dnc AND opted out, the pair that must not
--                    collapse into one action
INSERT INTO leads (id, team_id, name, phone, address, city, state, source,
                   tcpa_opt_in, tcpa_opt_in_at, consent_sms,
                   skip_traced, dnc_scrubbed)
VALUES
  ('22220000-0000-4000-8000-000000000001', '70551e00-0000-4000-8000-000000000001',
   'Misclick Seller',   '(912) 555-0301', '1 Wrong Row Ct', 'Savannah', 'GA',
   'website',   true, now(), true,  false, false),
  ('22220000-0000-4000-8000-000000000002', '70551e00-0000-4000-8000-000000000001',
   'Stopped Seller',    '(912) 555-0302', '2 Stop Text Ln', 'Savannah', 'GA',
   'website',   true, now(), false, false, false),
  ('22220000-0000-4000-8000-000000000003', '70551e00-0000-4000-8000-000000000001',
   'Unscrubbed Seller', '(912) 555-0303', '3 Cold List Rd', 'Savannah', 'GA',
   'cold_list', false, NULL,  false, false, false),
  ('22220000-0000-4000-8000-000000000004', '70551e00-0000-4000-8000-000000000001',
   'Both Seller',       '(912) 555-0304', '4 Belt And Braces Way', 'Savannah', 'GA',
   'website',   true, now(), false, false, false)
ON CONFLICT (id) DO NOTHING;

-- Written the way the inbound webhook writes them: phone_key form, source
-- sms_stop. 0303's is a dnc_scrub hit instead, so §6 can show that the prior
-- source is preserved and that the two are told apart afterwards.
INSERT INTO telephony_opt_outs (team_id, phone_key, source, note, opted_out_at)
VALUES
  ('70551e00-0000-4000-8000-000000000001', phone_key('9125550302'), 'sms_stop',
   'replied STOP', now() - interval '3 days'),
  ('70551e00-0000-4000-8000-000000000001', phone_key('9125550303'), 'dnc_scrub',
   'federal DNC hit at import', now() - interval '9 days'),
  ('70551e00-0000-4000-8000-000000000001', phone_key('9125550304'), 'sms_stop',
   'replied STOP', now() - interval '1 day')
ON CONFLICT (team_id, phone_key) DO NOTHING;

\echo '=== 1. an empty reason is refused by both RPCs ==='
\echo '-- A blank reason makes the audit trail prove only that somebody clicked,'
\echo '-- which is exactly the thing it exists not to be.'
DO $$
DECLARE tried text;
BEGIN
  SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  FOREACH tried IN ARRAY ARRAY['', '   ']
  LOOP
    BEGIN
      PERFORM clear_lead_dnc('22220000-0000-4000-8000-000000000004', tried);
      RAISE EXCEPTION 'FAIL: clear_lead_dnc accepted a blank reason';
    EXCEPTION WHEN invalid_parameter_value THEN
      RAISE NOTICE 'PASS: clear_lead_dnc refused a blank reason';
    END;

    BEGIN
      PERFORM clear_phone_opt_out('22220000-0000-4000-8000-000000000002', '9125550302', tried);
      RAISE EXCEPTION 'FAIL: clear_phone_opt_out accepted a blank reason';
    EXCEPTION WHEN invalid_parameter_value THEN
      RAISE NOTICE 'PASS: clear_phone_opt_out refused a blank reason';
    END;
  END LOOP;

  -- NULL is the same failure arriving by a different door: a client that omits
  -- the field must not get further than one that sends "".
  BEGIN
    PERFORM clear_lead_dnc('22220000-0000-4000-8000-000000000004', NULL);
    RAISE EXCEPTION 'FAIL: clear_lead_dnc accepted a NULL reason';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'PASS: a NULL reason is refused too';
  END;
END $$;

\echo '-- and nothing was written while all of that was being refused'
SELECT count(*) AS audit_rows_from_refusals FROM dnc_restore_log;

\echo '=== 2. the misclick case: log_disposition sets it, clear_lead_dnc lifts it ==='
\echo '-- This is the whole reason the feature exists. The operator aimed at the'
\echo '-- row above and tapped Do not call; nobody ever asked not to be called.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT is_dnc AS flagged, consent_sms AS consent_after_dnc, status
FROM log_disposition('22220000-0000-4000-8000-000000000001', 'do_not_call', 'meant the row above');
COMMIT;

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT lead_is_dialable(l.*) AS dialable_while_flagged
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000001';

-- status stays 'dead' and consent_sms stays false. Neither is rewound: what
-- the status was before the mis-tap is not recorded anywhere this function
-- could read, so restoring it would be a guess. The lead comes back DIALABLE,
-- not back into the queue — the operator sets the status themselves.
SELECT is_dnc AS flag_after_clear,
       consent_sms AS consent_after_clear,
       status AS status_not_rewound
FROM clear_lead_dnc('22220000-0000-4000-8000-000000000001', 'Mis-tap on the disposition bar; this seller never asked to be removed.');

SELECT lead_is_dialable(l.*) AS dialable_after_clear
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000001';
COMMIT;

\echo '-- consent_sms stays where log_disposition left it. Lifting a suppression'
\echo '-- says we are no longer refusing to contact this person; consent says'
\echo '-- they agreed to be contacted. Re-granting the second on an operator''s'
\echo '-- say-so is the part that would create real exposure.'
SELECT consent_sms AS consent_not_auto_restored
FROM leads WHERE id = '22220000-0000-4000-8000-000000000001';

\echo '-- a second call is a no-op, not a second audit row claiming a second'
\echo '-- restoration. A double-tap must not be recorded as two decisions.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  PERFORM clear_lead_dnc('22220000-0000-4000-8000-000000000001', 'again');
END $$;

SELECT count(*) AS audit_rows_for_the_misclick
FROM dnc_restore_log WHERE lead_id = '22220000-0000-4000-8000-000000000001';

\echo '=== 3. clearing the lead flag does NOT remove an opt-out ==='
\echo '-- THE assertion this migration exists to make. Both suppressions are on'
\echo '-- lead 0304. Clearing the internal flag must leave the STOP standing,'
\echo '-- and the lead must still be undialable afterwards — because the person'
\echo '-- did in fact tell us to stop, and a misclick fix does not undo that.'
SELECT count(*) AS optout_rows_before
FROM telephony_opt_outs
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND phone_key = phone_key('9125550304');

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT is_dnc AS flag_cleared
FROM clear_lead_dnc('22220000-0000-4000-8000-000000000004', 'Flagged during a call that turned out to be a different lead.');
COMMIT;

SELECT count(*) AS optout_rows_after,
       (SELECT source FROM telephony_opt_outs
         WHERE team_id = '70551e00-0000-4000-8000-000000000001'
           AND phone_key = phone_key('9125550304')) AS source_untouched
FROM telephony_opt_outs
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND phone_key = phone_key('9125550304');

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT is_dnc AS flag_is_clear, lead_is_dialable(l.*) AS still_not_dialable
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000004';
COMMIT;

\echo '=== 4. clearing the opt-out restores dialability — but only on its own ==='
\echo '-- 0302 has nothing else wrong with it: website source, opt-in on file.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT lead_is_dialable(l.*) AS dialable_before
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000002';

SELECT clear_phone_opt_out('22220000-0000-4000-8000-000000000002', '(912) 555-0302',
                           'Seller called in today and asked us to keep in touch.') AS rows_removed;

SELECT lead_is_dialable(l.*) AS dialable_after
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000002';
COMMIT;

\echo '-- 0303 is a cold-list row that was never skip traced or scrubbed. Its'
\echo '-- opt-out goes, and it is STILL not dialable — lifting a suppression is'
\echo '-- not the same as clearing every other reason the dialer refuses.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT clear_phone_opt_out('22220000-0000-4000-8000-000000000003', '912-555-0303',
                           'DNC scrub matched the wrong household; the county record is a different owner.') AS rows_removed;

SELECT is_opted_out(team_id, phone) AS still_opted_out,
       lead_is_dialable(l.*)        AS dialable_with_the_optout_gone
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000003';
COMMIT;

\echo '-- and once the work that was actually missing is done, it is dialable.'
\echo '-- Proves the false above was the trace and the scrub, not a leftover'
\echo '-- suppression this RPC failed to remove.'
UPDATE leads SET skip_traced = true, skip_traced_at = now(),
                 dnc_scrubbed = true, dnc_scrubbed_at = now()
WHERE id = '22220000-0000-4000-8000-000000000003';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT lead_is_dialable(l.*) AS dialable_once_traced_and_scrubbed
FROM leads l WHERE id = '22220000-0000-4000-8000-000000000003';
COMMIT;

\echo '-- clearing an opt-out that is not there removes nothing and files'
\echo '-- nothing. An audit row here would describe an event that never happened.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT clear_phone_opt_out('22220000-0000-4000-8000-000000000002', '9125550302',
                           'trying again') AS rows_removed_second_time;
COMMIT;

SELECT count(*) AS audit_rows_for_0302
FROM dnc_restore_log WHERE lead_id = '22220000-0000-4000-8000-000000000002';

\echo '-- a number that is not on the lead is refused, so the audit row''s'
\echo '-- lead_id can never be a fiction attached to an unrelated seller.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  BEGIN
    PERFORM clear_phone_opt_out('22220000-0000-4000-8000-000000000002', '9125550304',
                                'clearing somebody else''s STOP through this lead');
    RAISE EXCEPTION 'FAIL: an unrelated number was cleared through this lead';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'PASS: the number has to belong to the lead named';
  END;
END $$;

SELECT count(*) AS the_0304_optout_survived
FROM telephony_opt_outs
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND phone_key = phone_key('9125550304');

\echo '=== 5. the audit row says who, when, why, and what was there before ==='
\echo '-- prior_source is the column that stops "we cleared it" from being the'
\echo '-- whole story: a seller''s STOP and a bulk dnc_scrub hit are not the'
\echo '-- same decision to have made, and after the DELETE there is no other copy.'
SELECT l.name,
       r.kind,
       r.phone_key,
       r.reason,
       r.prior_source,
       r.prior_opted_out_at IS NOT NULL AS prior_timestamp_kept,
       r.restored_by = 'aaaaaaaa-0000-4000-8000-000000000001' AS attributed,
       r.restored_at IS NOT NULL AS timed
FROM dnc_restore_log r
LEFT JOIN leads l ON l.id = r.lead_id
ORDER BY r.kind, r.phone_key;

\echo '-- the lead timeline names the person, not just an actor_id. A cleared'
\echo '-- STOP that reads like something the system did on its own is the one'
\echo '-- thing this must never look like.'
SELECT type, summary
FROM lead_activity
WHERE type IN ('dnc_restored', 'opt_out_cleared')
ORDER BY type, summary;

\echo '=== 6. a lead can be deleted; the record that it was un-suppressed cannot ==='
\echo '-- lead_id is ON DELETE SET NULL rather than CASCADE. CASCADE would let'
\echo '-- deleting a lead erase the evidence of the one write on it that most'
\echo '-- needs evidence.'
SELECT confdeltype = 'n' AS lead_id_on_delete_set_null
FROM pg_constraint
WHERE conrelid = 'public.dnc_restore_log'::regclass
  AND contype = 'f'
  AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'public.dnc_restore_log'::regclass
                        AND attname = 'lead_id')];

DELETE FROM leads WHERE id = '22220000-0000-4000-8000-000000000003';

SELECT count(*) AS orphaned_rows_kept,
       count(*) FILTER (WHERE reason <> '' AND phone_key IS NOT NULL) AS still_says_what_and_why
FROM dnc_restore_log WHERE lead_id IS NULL;

\echo '=== 7. the audit trail cannot be blanked, and anon cannot see it ==='
\echo '-- The reason CHECK is a constraint, so it holds against the blanket'
\echo '-- grant at the top of this file and against any future writer.'
DO $$
BEGIN
  INSERT INTO dnc_restore_log (team_id, lead_id, phone_key, kind, reason)
  VALUES ('70551e00-0000-4000-8000-000000000001', NULL, '9125550999', 'opt_out', '  ');
  RAISE EXCEPTION 'FAIL: a blank reason was stored';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: a blank reason is refused at the table too';
END $$;

\echo '-- an opt_out row that cannot say which number is refused as well'
DO $$
BEGIN
  INSERT INTO dnc_restore_log (team_id, phone_key, kind, reason)
  VALUES ('70551e00-0000-4000-8000-000000000001', NULL, 'opt_out', 'no number named');
  RAISE EXCEPTION 'FAIL: an opt_out restoration was stored with no number';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: an opt_out row must name the number it un-suppressed';
END $$;

\echo '-- the public anon key ships in the browser bundle every visitor'
\echo '-- downloads. This table names phone numbers and the operator who'
\echo '-- un-suppressed them.'
SELECT
  has_table_privilege('anon', 'public.dnc_restore_log', 'SELECT') AS anon_select,
  has_table_privilege('anon', 'public.dnc_restore_log', 'INSERT') AS anon_insert,
  has_table_privilege('anon', 'public.dnc_restore_log', 'UPDATE') AS anon_update,
  has_table_privilege('anon', 'public.dnc_restore_log', 'DELETE') AS anon_delete,
  has_function_privilege('anon', 'public.clear_lead_dnc(uuid, text)', 'EXECUTE')            AS anon_can_clear_flag,
  has_function_privilege('anon', 'public.clear_phone_opt_out(uuid, text, text)', 'EXECUTE') AS anon_can_clear_optout,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dnc_restore_log'
      AND 'anon' = ANY(roles)) AS policies_naming_anon,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.dnc_restore_log'::regclass) AS rls_on;

\echo '=== 8. both RPCs are SECURITY DEFINER and both check the team by hand ==='
\echo '-- DEFINER is what lets clear_phone_opt_out delete from a table'
\echo '-- authenticated has no DELETE on. It also bypasses RLS, so the team'
\echo '-- check cannot be left to a policy — hence the assertion below that an'
\echo '-- outsider gets nowhere.'
SELECT proname, prosecdef AS security_definer,
       proconfig::text LIKE '%search_path=public, pg_catalog%' AS search_path_pinned
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('clear_lead_dnc', 'clear_phone_opt_out')
ORDER BY proname;

\echo '-- an operator on another team cannot reach either one. Both refuse at'
\echo '-- the lead lookup, which is scoped to get_my_team_id() explicitly.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  BEGIN
    PERFORM clear_lead_dnc('22220000-0000-4000-8000-000000000004', 'not my lead');
    RAISE EXCEPTION 'FAIL: an outsider cleared a DNC flag on another team';
  EXCEPTION WHEN no_data_found THEN
    RAISE NOTICE 'PASS: clear_lead_dnc refuses an outsider';
  END;

  BEGIN
    PERFORM clear_phone_opt_out('22220000-0000-4000-8000-000000000004', '9125550304', 'not my lead');
    RAISE EXCEPTION 'FAIL: an outsider cleared an opt-out on another team';
  EXCEPTION WHEN no_data_found THEN
    RAISE NOTICE 'PASS: clear_phone_opt_out refuses an outsider';
  END;
END $$;

\echo '-- a caller with no profile at all — an unauthenticated RPC hit — is'
\echo '-- refused before either function reads anything.'
DO $$
BEGIN
  BEGIN
    PERFORM clear_phone_opt_out('22220000-0000-4000-8000-000000000004', '9125550304', 'anonymous');
    RAISE EXCEPTION 'FAIL: a caller with no team cleared an opt-out';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: no team, no restoration';
  END;
END $$;

\echo '-- and the STOP the outsider went after is still standing'
SELECT count(*) AS optout_survived_the_outsider,
       (SELECT count(*) FROM dnc_restore_log
         WHERE team_id = '99999999-0000-4000-8000-000000000001') AS audit_rows_on_the_other_team
FROM telephony_opt_outs
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND phone_key = phone_key('9125550304');
