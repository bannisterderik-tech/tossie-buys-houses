\set ON_ERROR_STOP on
\pset pager off

-- ============================================================================
-- Releasing a number — 20260819120000_number_release.sql
-- ============================================================================
-- Releasing is the one irreversible operation in the build: the number goes
-- back to Twilio's pool and can be claimed by a stranger the same afternoon.
-- The assertions below are the ones that decide whether the app can be trusted
-- to be the thing that does it.
--
-- SAME CAVEAT AS phase2_telephony AND phase4_sdr: the blanket grant on the next
-- line hands `authenticated` privileges the migrations deliberately withheld,
-- so no assertion here reads a table-level grant. The release rule is enforced
-- by a TRIGGER rather than by a column grant precisely so it survives this line
-- — which means §7 below is a real test of the shipped rule, not of its setup.
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

-- This suite owns the primary slot for the duration, whether it runs alone or
-- after phase2_telephony (which leaves +19125550100 primary). Without this the
-- "a released number cannot be primary" assertion in §4 could pass by hitting
-- the one-primary index instead of the CHECK, which is a different rule and
-- would leave the one under test unexercised.
UPDATE phone_numbers SET is_primary = false
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND is_primary;

INSERT INTO phone_numbers (id, team_id, e164, friendly_name, twilio_sid, is_primary, sms_enabled, a2p_status)
VALUES ('11110000-0000-4000-8000-000000000001', '70551e00-0000-4000-8000-000000000001',
        '+19125550110', 'Keeper', 'PN_fixture_keeper', true, true, 'approved'),
       ('11110000-0000-4000-8000-000000000002', '70551e00-0000-4000-8000-000000000001',
        '+19125550111', 'Doomed', 'PN_fixture_doomed', false, true, 'approved')
ON CONFLICT (id) DO NOTHING;

INSERT INTO leads (id, team_id, name, phone, address, city, state, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('11110000-0000-4000-8000-00000000000a', '70551e00-0000-4000-8000-000000000001',
        'Release Suite Seller', '9125550115', '15 Released Rd', 'Savannah', 'GA',
        'website', true, now())
ON CONFLICT (id) DO NOTHING;

-- Two messages on the number that is about to be released. These are the rows
-- the whole soft-delete decision exists to protect.
INSERT INTO sms_messages (team_id, lead_id, phone_number_id, direction, from_e164, to_e164, body, status, twilio_sid)
VALUES ('70551e00-0000-4000-8000-000000000001', '11110000-0000-4000-8000-00000000000a',
        '11110000-0000-4000-8000-000000000002', 'outbound', '+19125550111', '+19125550115',
        'Are you still interested in selling?', 'delivered', 'SM_fixture_release_1'),
       ('70551e00-0000-4000-8000-000000000001', '11110000-0000-4000-8000-00000000000a',
        '11110000-0000-4000-8000-000000000002', 'inbound', '+19125550115', '+19125550111',
        'Stop calling me', 'received', 'SM_fixture_release_2')
ON CONFLICT (twilio_sid) DO NOTHING;

-- The doomed number is also the team's send-from default, which is the state
-- that makes §6 worth asserting rather than hypothetical.
UPDATE telephony_settings SET default_number_id = '11110000-0000-4000-8000-000000000002'
WHERE team_id = '70551e00-0000-4000-8000-000000000001';

\echo '=== 1. a new number starts live, and live is the absence of a mark ==='
\echo '-- released_at IS NULL is the single predicate every operational path'
\echo '-- filters on. A status enum would have invited a third state.'
SELECT e164, released_at IS NULL AS live, released_by IS NULL AS no_releaser,
       release_reason IS NULL AS no_reason
FROM phone_numbers WHERE e164 IN ('+19125550110', '+19125550111') ORDER BY e164;

\echo '=== 2. releasing marks the row — it never deletes it ==='
\echo '-- This is the write the edge function makes AFTER Twilio confirms, on'
\echo '-- the service role. Marking first would leave a number that still bills'
\echo '-- and still rings but is invisible to the app.'
UPDATE phone_numbers
SET released_at = now(),
    released_by = 'aaaaaaaa-0000-4000-8000-000000000001',
    release_reason = 'Consolidating onto one line'
WHERE id = '11110000-0000-4000-8000-000000000002';

SELECT e164, released_at IS NOT NULL AS released, release_reason,
       released_by = 'aaaaaaaa-0000-4000-8000-000000000001' AS attributed
FROM phone_numbers WHERE e164 = '+19125550111';

\echo '=== 3. the conversation survives the release with its link intact ==='
\echo '-- THE reason this is a soft delete. sms_messages.phone_number_id is ON'
\echo '-- DELETE SET NULL, so deleting the row would have succeeded quietly and'
\echo '-- nulled the link on every message — the text would survive, which of'
\echo '-- our numbers it happened on would not. That includes the STOP below.'
SELECT m.body, m.direction,
       m.phone_number_id = '11110000-0000-4000-8000-000000000002' AS still_linked,
       p.e164 AS resolves_back_to
FROM sms_messages m JOIN phone_numbers p ON p.id = m.phone_number_id
WHERE m.twilio_sid IN ('SM_fixture_release_1', 'SM_fixture_release_2')
ORDER BY m.twilio_sid;

\echo '=== 4. a released number cannot be primary ==='
\echo '-- Asserted with no other primary in the way, so the only constraint that'
\echo '-- can reject this is the CHECK — not the one-primary unique index.'
BEGIN;
UPDATE phone_numbers SET is_primary = false
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND is_primary;
DO $$
BEGIN
  UPDATE phone_numbers SET is_primary = true
  WHERE id = '11110000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: a released number was made primary';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: released numbers are refused the primary badge';
END $$;
ROLLBACK;

\echo '-- and the reverse: a live number that is already primary cannot be'
\echo '-- released out from under the badge either. The edge function refuses'
\echo '-- first with a sentence; this is what makes the refusal a guarantee.'
DO $$
BEGIN
  UPDATE phone_numbers SET released_at = now()
  WHERE id = '11110000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: the primary number was released';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: the primary number cannot be released while it is primary';
END $$;

\echo '=== 5. the one-primary index was NOT narrowed to exclude released rows ==='
\echo '-- Narrowing it would have ALLOWED a released row to keep is_primary,'
\echo '-- alongside a live one — two rows satisfying is_primary, which is the'
\echo '-- state the index exists to prevent. Three call sites pick the sending'
\echo '-- number with a bare is_primary test and would have picked either.'
SELECT indexdef LIKE '%WHERE is_primary%'  AS still_the_original_predicate,
       indexdef NOT LIKE '%released%'      AS not_narrowed
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'phone_numbers_one_primary_idx';

\echo '-- and it still bites: a live number can be made primary while another'
\echo '-- number sits released, but two live primaries are still impossible.'
UPDATE phone_numbers SET is_primary = true WHERE id = '11110000-0000-4000-8000-000000000001';
DO $$
BEGIN
  INSERT INTO phone_numbers (team_id, e164, is_primary)
  VALUES ('70551e00-0000-4000-8000-000000000001', '+19125550119', true);
  RAISE EXCEPTION 'FAIL: a second primary was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: one primary per team, unchanged';
END $$;

\echo '=== 6. a released number is not selectable as a from-number ==='
\echo '-- The three ways the send and dial paths resolve "which number do we'
\echo '-- send from", run here as the exact predicates twilio-send-sms and'
\echo '-- twilio-voice use. Every one has to come back empty for the released'
\echo '-- number, including the pinned-id case, because the SDR and the dialer'
\echo '-- pin a number id to keep one conversation on one From.'

\echo '-- (a) pinned by id — the caller named the released number explicitly'
SELECT count(*) AS pinned_released_number_selectable
FROM phone_numbers
WHERE team_id = '70551e00-0000-4000-8000-000000000001'
  AND id = '11110000-0000-4000-8000-000000000002'
  AND released_at IS NULL;

\echo '-- (b) the team default still points at it: telephony_settings was never'
\echo '-- updated. The send path resolves nothing and refuses out loud, which'
\echo '-- beats silently promoting a number the seller has never seen.'
SELECT (SELECT default_number_id = '11110000-0000-4000-8000-000000000002'
        FROM telephony_settings WHERE team_id = '70551e00-0000-4000-8000-000000000001')
         AS default_still_points_at_it,
       (SELECT count(*) FROM phone_numbers p
        JOIN telephony_settings s ON s.default_number_id = p.id
        WHERE s.team_id = '70551e00-0000-4000-8000-000000000001'
          AND p.released_at IS NULL) AS default_resolves_to_a_live_number;

\echo '-- (c) fall back to the primary — guaranteed live by the CHECK in §4'
SELECT e164, released_at IS NULL AS live
FROM phone_numbers
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND is_primary;

\echo '-- (d) twilio-voice''s last resort is "any voice-enabled number", which'
\echo '-- is the one that would have reached for the released row if the filter'
\echo '-- were missing. With it, only the keeper is left.'
SELECT string_agg(e164, ', ' ORDER BY e164) AS dialable_from
FROM phone_numbers
WHERE team_id = '70551e00-0000-4000-8000-000000000001'
  AND voice_enabled AND released_at IS NULL;

\echo '=== 7. the browser cannot mark a number released ==='
\echo '-- authenticated holds UPDATE on phone_numbers because labels, A2P'
\echo '-- status and forwarding are operator-managed. A release mark written'
\echo '-- from there would be a number that still bills and still rings with no'
\echo '-- Twilio call ever made. RLS does not help — the row IS on their team —'
\echo '-- so the rule is a trigger, and the blanket grant at the top of this'
\echo '-- file cannot undo it.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE phone_numbers SET released_at = now()
    WHERE id = '11110000-0000-4000-8000-000000000001';
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: the browser marked a number released';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: release marks are refused to authenticated';
  END;
END $$;

\echo '-- un-releasing is refused the same way. Clearing the mark does not get'
\echo '-- the number back from Twilio; it only makes the app lie about it.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE phone_numbers SET released_at = NULL, release_reason = NULL
    WHERE id = '11110000-0000-4000-8000-000000000002';
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: the browser un-released a number';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: the mark cannot be cleared from the browser either';
  END;
END $$;

\echo '-- nor recorded as already-released on the way in'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO phone_numbers (team_id, e164, released_at)
    VALUES ('70551e00-0000-4000-8000-000000000001', '+19125550118', now());
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: a pre-released number was recorded';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: a number cannot be recorded as already released';
  END;
END $$;

\echo '-- and the trigger is a scalpel, not a blanket: everything else on the'
\echo '-- row still edits normally, including on the released row, whose label'
\echo '-- the operator may still want to correct.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
UPDATE phone_numbers SET friendly_name = 'Doomed (released Aug 2026)'
WHERE id = '11110000-0000-4000-8000-000000000002';
SELECT friendly_name AS label_still_editable
FROM phone_numbers WHERE id = '11110000-0000-4000-8000-000000000002';
COMMIT;

\echo '=== 8. the team can still SEE its released numbers ==='
\echo '-- The UI shows them in a quiet "Released" section rather than hiding'
\echo '-- them. A number that vanished with no trace is how somebody concludes'
\echo '-- the app lost their data — and the released row is the only place the'
\echo '-- reason and the date are written down.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT count(*) FILTER (WHERE released_at IS NULL)     AS live_visible,
       count(*) FILTER (WHERE released_at IS NOT NULL) AS released_visible
FROM phone_numbers;
COMMIT;

\echo '=== 9. RLS: an outsider sees no released number and cannot forge one ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT count(*) AS any_numbers_visible,
       count(*) FILTER (WHERE released_at IS NOT NULL) AS released_visible
FROM phone_numbers;
COMMIT;

DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE phone_numbers SET released_at = now()
    WHERE id = '11110000-0000-4000-8000-000000000001';
    RESET ROLE;
    -- An UPDATE that matches no row is not an error, so a silent zero-row
    -- result is the expected shape of this denial. The assertion is the count.
    RAISE NOTICE 'checked: outsider UPDATE raised nothing, see the count below';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: outsider refused outright';
  END;
END $$;

SELECT released_at IS NULL AS keeper_still_live
FROM phone_numbers WHERE id = '11110000-0000-4000-8000-000000000001';

\echo '=== 10. the public anon key has no reach into the new columns ==='
\echo '-- This key ships in the browser bundle every visitor downloads.'
SELECT
  has_table_privilege('anon', 'public.phone_numbers', 'SELECT') AS anon_numbers_select,
  has_table_privilege('anon', 'public.phone_numbers', 'UPDATE') AS anon_numbers_update,
  has_column_privilege('anon', 'public.phone_numbers', 'released_at', 'SELECT') AS anon_released_at_select,
  has_column_privilege('anon', 'public.phone_numbers', 'release_reason', 'SELECT') AS anon_reason_select,
  has_function_privilege('anon', 'public.phone_numbers_guard_release()', 'EXECUTE') AS anon_can_call_guard,
  has_function_privilege('authenticated', 'public.phone_numbers_guard_release()', 'EXECUTE') AS authed_can_call_guard,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'phone_numbers'
      AND 'anon' = ANY(roles)) AS policies_naming_anon;

\echo '=== 11. released_by survives the operator being deleted ==='
\echo '-- ON DELETE SET NULL, not CASCADE: losing who released it is tolerable,'
\echo '-- losing the record that it happened is not — and CASCADE here would'
\echo '-- have deleted the phone_numbers row itself, taking the thread links'
\echo '-- with it. Which is the whole thing this migration refuses to do.'
SELECT confdeltype = 'n' AS on_delete_set_null
FROM pg_constraint
WHERE conrelid = 'public.phone_numbers'::regclass
  AND contype = 'f'
  AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'public.phone_numbers'::regclass
                        AND attname = 'released_by')];
