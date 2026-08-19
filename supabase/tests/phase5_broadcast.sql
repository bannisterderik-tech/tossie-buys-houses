\set ON_ERROR_STOP on
\pset pager off

-- ============================================================================
-- Phase 5b — the dispo blast — 20260820130000_broadcast.sql
-- ============================================================================
-- Six things this suite exists to hold down, in the order they would hurt:
--
--   1. A SUPPRESSED RECIPIENT GETS A ROW WITH A REASON. Never omitted from the
--      audience, never silently filtered. This is the whole feature: a campaign
--      reporting "sent to 1" out of an audience of 6 has to be able to say what
--      happened to the other 5, or it cannot be defended to a carrier, to a
--      plaintiff's lawyer, or to the operator wondering why the list is quiet.
--   2. One number gets one message per campaign, whatever the formatting, and
--      when a number reaches the audience twice with two different decisions
--      the SUPPRESSED one wins. Fail-closed, not first-write-wins.
--   3. The skip-reason functions cannot drift away from the gate functions they
--      explain. If they ever disagree, this suite fails before the blast does.
--   4. An audience, once frozen, cannot be edited out from under its own audit
--      trail — and a campaign that has decided who it would text cannot be
--      deleted.
--   5. There is no way to blast the CRM. A leads campaign must name every
--      recipient and is capped; there is no "all" and no filter that means one.
--   6. RLS keeps another team out, and anon — whose key ships in the browser
--      bundle — holds nothing.
--
-- SAME CAVEAT AS EVERY OTHER SUITE HERE: the blanket grant two lines down hands
-- `authenticated` privileges the migration deliberately withheld — DELETE on
-- broadcast_recipients. Nothing below asserts a grant held by `authenticated`,
-- because such an assertion would pass alone and fail in sequence. What §4 DOES
-- assert is that a materialised campaign is undeletable anyway, which is why
-- that rule is a trigger and not a missing grant: the trigger survives this
-- line, and it survives the service role too.
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

-- ── the property being dispo'd ──────────────────────────────────────────────
-- Effingham County / 31329 on purpose: phase5_deals works a Chatham property,
-- and every buyer below names a county, so neither suite's buyers wander into
-- the other's matcher output. Vacant and light rehab so that occupancy and
-- rehab tolerance are not quietly doing the filtering work in §2.
--   buyer_price  = 100,000 + 10,000            = 110,000
--   buyer_spread = 200,000 - 30,000 - 110,000  =  60,000
INSERT INTO leads (id, team_id, name, phone, address, city, state, county, source,
                   tcpa_opt_in, tcpa_opt_in_at)
VALUES ('cc660000-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001', 'Blast Seller', '(912) 555-0700',
        '700 Marsh Ln', 'Springfield', 'GA', 'Effingham', 'website', true, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO deals (
  id, team_id, lead_id, address, city, state, zip, county,
  property_type, beds, baths, occupancy, rehab_level,
  contract_price, arv_estimate, repair_estimate, target_assignment_fee,
  status, exit_strategy
) VALUES (
  'ee660000-0000-4000-8000-000000000001',
  '70551e00-0000-4000-8000-000000000001',
  'cc660000-0000-4000-8000-000000000001',
  '700 Marsh Ln', 'Springfield', 'GA', '31329', 'Effingham',
  'single_family', 3, 2, 'vacant', 'light',
  100000, 200000, 30000, 10000,
  'dispo', 'assign'
) ON CONFLICT (id) DO NOTHING;

-- A second property that is over, for §9.
INSERT INTO deals (
  id, team_id, address, city, state, zip, county, status
) VALUES (
  'ee660000-0000-4000-8000-000000000002',
  '70551e00-0000-4000-8000-000000000001',
  '9 Gone Ct', 'Springfield', 'GA', '31329', 'Effingham', 'draft'
) ON CONFLICT (id) DO NOTHING;
UPDATE deals SET status = 'dead' WHERE id = 'ee660000-0000-4000-8000-000000000002';

-- ── the buyers list ─────────────────────────────────────────────────────────
-- Rows 1-4 share ONE buy box, exactly fitting the deal. That is the point: the
-- only thing separating them is a compliance fact, so a skip reason of
-- 'not_in_buy_box' on any of 2, 3 or 4 would prove the gates were never
-- consulted. 555 numbers throughout — the documentation range, as everywhere
-- else in these suites. Nothing here could ring.
INSERT INTO buyers (
  id, team_id, name, entity_name, phone, email, status,
  counties, zips, property_types, price_min, price_max, beds_min,
  min_spread, rehab_tolerance, funding, typical_close_days, takes_occupied,
  deals_closed, deals_reneged, rating,
  consent_sms, tcpa_opt_in, tcpa_opt_in_at
) VALUES
  -- The only buyer who should end up 'pending'.
  ('bb660000-0000-4000-8000-000000000001', '70551e00-0000-4000-8000-000000000001',
   'Blast Ready Buyer', 'Marsh Capital LLC', '(912) 555-0701', 'ready@example.com', 'active',
   '{Effingham}', '{31329}', '{single_family}', 50000, 200000, 3,
   25000, 'medium', 'cash', 14, true, 3, 0, 5,
   true, true, now()),

  -- Texted STOP. Same box, same consent flags: only the opt-out separates them.
  ('bb660000-0000-4000-8000-000000000002', '70551e00-0000-4000-8000-000000000001',
   'Opted Out Buyer', NULL, '(912) 555-0702', 'stopped@example.com', 'active',
   '{Effingham}', '{31329}', '{single_family}', 50000, 200000, 3,
   25000, 'medium', 'cash', 14, true, 2, 0, 4,
   true, true, now()),

  -- Never agreed to be texted.
  ('bb660000-0000-4000-8000-000000000003', '70551e00-0000-4000-8000-000000000001',
   'No Consent Buyer', NULL, '(912) 555-0703', 'quiet@example.com', 'active',
   '{Effingham}', '{31329}', '{single_family}', 50000, 200000, 3,
   25000, 'medium', 'cash', 14, true, 1, 0, 4,
   false, false, NULL),

  -- Paused: on the list, not being sent to right now.
  ('bb660000-0000-4000-8000-000000000004', '70551e00-0000-4000-8000-000000000001',
   'Paused Buyer', NULL, '(912) 555-0704', 'paused@example.com', 'paused',
   '{Effingham}', '{31329}', '{single_family}', 50000, 200000, 3,
   25000, 'medium', 'cash', 14, true, 6, 0, 5,
   true, true, now()),

  -- Perfectly textable, wrong county. The only legitimate 'not_in_buy_box'.
  ('bb660000-0000-4000-8000-000000000005', '70551e00-0000-4000-8000-000000000001',
   'Wrong County Buyer', NULL, '(912) 555-0705', 'bulloch@example.com', 'active',
   '{Bulloch}', '{}', '{single_family}', 50000, 200000, 3,
   25000, 'medium', 'cash', 14, true, 2, 0, 4,
   true, true, now()),

  -- Email only. Consenting, in the box, and unreachable by SMS.
  ('bb660000-0000-4000-8000-000000000006', '70551e00-0000-4000-8000-000000000001',
   'No Phone Buyer', NULL, NULL, 'nophone@example.com', 'active',
   '{Effingham}', '{31329}', '{single_family}', 50000, 200000, 3,
   25000, 'medium', 'cash', 14, true, 1, 0, 3,
   true, true, now())
ON CONFLICT (id) DO NOTHING;

-- The STOP, written the way the inbound webhook writes it: phone_key form.
INSERT INTO telephony_opt_outs (team_id, phone_key, source, note)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('(912) 555-0702'),
        'sms_stop', 'buyer replied STOP to a deal blast'),
       ('70551e00-0000-4000-8000-000000000001', phone_key('(912) 555-0713'),
        'sms_stop', 'seller replied STOP')
ON CONFLICT (team_id, phone_key) DO NOTHING;

-- ── sellers, for the leads audience ─────────────────────────────────────────
-- The first two share a number deliberately. One is clean, one is on the
-- internal DNC list, and §3 asserts which decision the ledger keeps.
INSERT INTO leads (id, team_id, name, phone, source, tcpa_opt_in, tcpa_opt_in_at,
                   is_dnc, is_litigator, phone_invalid, trashed,
                   skip_traced, dnc_scrubbed)
VALUES
  ('cc660000-0000-4000-8000-000000000011', '70551e00-0000-4000-8000-000000000001',
   'Clean Seller', '(912) 555-0711', 'website', true, now(),
   false, false, false, false, false, false),
  ('cc660000-0000-4000-8000-000000000012', '70551e00-0000-4000-8000-000000000001',
   'Same Number DNC Seller', '912-555-0711', 'website', true, now(),
   true, false, false, false, false, false),
  ('cc660000-0000-4000-8000-000000000013', '70551e00-0000-4000-8000-000000000001',
   'Opted Out Seller', '(912) 555-0713', 'website', true, now(),
   false, false, false, false, false, false),
  ('cc660000-0000-4000-8000-000000000014', '70551e00-0000-4000-8000-000000000001',
   'No Consent Seller', '(912) 555-0714', 'list', false, NULL,
   false, false, false, false, false, false),
  ('cc660000-0000-4000-8000-000000000015', '70551e00-0000-4000-8000-000000000001',
   'Trashed Seller', '(912) 555-0715', 'website', true, now(),
   false, false, false, true, false, false),
  ('cc660000-0000-4000-8000-000000000016', '70551e00-0000-4000-8000-000000000001',
   'Litigator Seller', '(912) 555-0716', 'website', true, now(),
   false, true, false, false, false, false),
  ('cc660000-0000-4000-8000-000000000017', '70551e00-0000-4000-8000-000000000001',
   'Wrong Number Seller', '(912) 555-0717', 'website', true, now(),
   false, false, true, false, false, false)
ON CONFLICT (id) DO NOTHING;


\echo '=== 1. the skip-reason functions cannot drift from the gates ==='
\echo '-- buyer_skip_reason EXPLAINS buyer_is_textable; it does not get to reach'
\echo '-- a different answer. Same for lead_skip_reason and lead_is_dialable.'
\echo '-- If these ever disagree, the blast is deciding by one rule and'
\echo '-- reporting by another, and the ledger becomes fiction.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT b.name, buyer_skip_reason(b.*) AS skip_reason, buyer_is_textable(b.*) AS textable
FROM buyers b ORDER BY b.name;
COMMIT;

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.buyers b
   WHERE (public.buyer_skip_reason(b.*) IS NULL) <> public.buyer_is_textable(b.*);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'FAIL: % buyer(s) where the skip reason and the gate disagree', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.leads l
   WHERE (public.lead_skip_reason(l.*) IS NULL) <> public.lead_is_dialable(l.*);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'FAIL: % lead(s) where the skip reason and the gate disagree', v_bad;
  END IF;

  RAISE NOTICE 'PASS: skip reasons and gate functions agree on every row';
END $$;

\echo '-- The lead vocabulary, one row per way a seller drops out.'
SELECT l.name, lead_skip_reason(l.*) AS skip_reason
FROM leads l
WHERE l.id::text LIKE 'cc660000%'
ORDER BY l.name;


\echo '=== 2. materialise records EVERY suppressed recipient, with a reason ==='
\echo '-- The audience is 6 buyers. One is sendable. The other five must each'
\echo '-- leave a row saying why not — that is the difference between a campaign'
\echo '-- that can be defended and a number that says "sent to 1".'
INSERT INTO broadcast_campaigns (
  id, team_id, name, audience_kind, deal_id, body, created_by
) VALUES (
  'aa660000-0000-4000-8000-000000000001',
  '70551e00-0000-4000-8000-000000000001',
  'Dispo — 700 Marsh Ln', 'deal_match',
  'ee660000-0000-4000-8000-000000000001',
  'New off-market: {{address}}, {{beds}}/{{baths}}. Asking {{buyer_price}}. Reply YES for the deal sheet, STOP to opt out.',
  'aaaaaaaa-0000-4000-8000-000000000001'
) ON CONFLICT (id) DO NOTHING;

SELECT * FROM materialise_campaign('aa660000-0000-4000-8000-000000000001');

\echo '-- Who landed where, and why.'
SELECT b.name, r.status, r.skip_reason, r.phone_e164, r.match_score
FROM broadcast_recipients r
LEFT JOIN buyers b ON b.id = r.buyer_id
WHERE r.campaign_id = 'aa660000-0000-4000-8000-000000000001'
ORDER BY r.status, b.name;

DO $$
DECLARE
  v_buyers int;
  v_rows   int;
  v_reason text;
BEGIN
  SELECT count(*) INTO v_buyers FROM public.buyers
   WHERE team_id = '70551e00-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_rows FROM public.broadcast_recipients
   WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001';

  -- The headline assertion of this whole file: nobody is missing.
  IF v_rows <> v_buyers THEN
    RAISE EXCEPTION
      'FAIL: % buyers on the list but only % recipient rows — % were filtered out with no record',
      v_buyers, v_rows, v_buyers - v_rows;
  END IF;
  RAISE NOTICE 'PASS: every buyer in the pool has a row (% of %)', v_rows, v_buyers;

  -- And each one is skipped for the RIGHT reason. Rows 2, 3 and 4 share a buy
  -- box with row 1, so a reason of 'not_in_buy_box' on any of them would mean
  -- the compliance gates were never reached.
  FOR v_reason IN
    SELECT r.skip_reason FROM public.broadcast_recipients r
     WHERE r.campaign_id = 'aa660000-0000-4000-8000-000000000001'
       AND r.buyer_id = 'bb660000-0000-4000-8000-000000000002'
  LOOP
    IF v_reason IS DISTINCT FROM 'opted_out' THEN
      RAISE EXCEPTION 'FAIL: the opted-out buyer was recorded as "%"', v_reason;
    END IF;
  END LOOP;

  IF (SELECT skip_reason FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000003') <> 'no_consent'
  THEN RAISE EXCEPTION 'FAIL: the non-consenting buyer was not recorded as no_consent'; END IF;

  IF (SELECT skip_reason FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000004') <> 'buyer_inactive'
  THEN RAISE EXCEPTION 'FAIL: the paused buyer was not recorded as buyer_inactive'; END IF;

  IF (SELECT skip_reason FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000005') <> 'not_in_buy_box'
  THEN RAISE EXCEPTION 'FAIL: the wrong-county buyer was not recorded as not_in_buy_box'; END IF;

  -- The buyer with no number at all still gets a row. Dropping those is the
  -- same failure in miniature, and it is how a list quietly stops working.
  IF (SELECT skip_reason FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000006') <> 'no_phone'
  THEN RAISE EXCEPTION 'FAIL: the buyer with no number left no row'; END IF;

  IF (SELECT status FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000001') <> 'pending'
  THEN RAISE EXCEPTION 'FAIL: the one sendable buyer is not pending'; END IF;

  RAISE NOTICE 'PASS: every suppression is recorded with its own specific reason';
END $$;

\echo '-- A skipped row without a reason is the unauditable state. Refused.'
DO $$
BEGIN
  INSERT INTO broadcast_recipients (team_id, campaign_id, phone_e164, status)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'aa660000-0000-4000-8000-000000000001', '+19125550799', 'skipped');
  RAISE EXCEPTION 'FAIL: a recipient was skipped with no reason given';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: skipped without a reason is refused';
END $$;

\echo '-- ...and a reason on a row that DID send would make the counts lie the'
\echo '-- other way, so that is refused too.'
DO $$
BEGIN
  INSERT INTO broadcast_recipients (team_id, campaign_id, phone_e164, status, skip_reason)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'aa660000-0000-4000-8000-000000000001', '+19125550798', 'sent', 'opted_out');
  RAISE EXCEPTION 'FAIL: a sent row carried a skip reason';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: a skip reason belongs only to a skipped row';
END $$;

\echo '-- The vocabulary is closed, so skips can be counted rather than read.'
DO $$
BEGIN
  INSERT INTO broadcast_recipients (team_id, campaign_id, phone_e164, status, skip_reason)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'aa660000-0000-4000-8000-000000000001', '+19125550797', 'skipped', 'he seemed busy');
  RAISE EXCEPTION 'FAIL: a free-text skip reason was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: the skip vocabulary is closed';
END $$;


\echo '=== 3. one number, one message — whatever the formatting ==='
\echo '-- The buyer is already in this campaign as "(912) 555-0701". Adding the'
\echo '-- same line in E.164 is the same person and the second text is the one'
\echo '-- that gets Tossie muted.'
DO $$
BEGIN
  INSERT INTO broadcast_recipients (team_id, campaign_id, phone_e164, status)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'aa660000-0000-4000-8000-000000000001', '+19125550701', 'pending');
  RAISE EXCEPTION 'FAIL: the same number entered this campaign twice';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: deduped on phone_key, so formatting cannot defeat it';
END $$;

\echo '-- Re-materialising a draft tops up rather than duplicating.'
DO $$
DECLARE v_before int; v_after int;
BEGIN
  SELECT count(*) INTO v_before FROM public.broadcast_recipients
   WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001';
  PERFORM public.materialise_campaign('aa660000-0000-4000-8000-000000000001');
  SELECT count(*) INTO v_after FROM public.broadcast_recipients
   WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'FAIL: re-materialising changed the audience (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE 'PASS: materialise is idempotent on a draft';
END $$;

\echo '-- Two sellers, one phone line, opposite decisions. The SUPPRESSED one'
\echo '-- must win: first-write-wins here would let a duplicate row launder a'
\echo '-- DNC flag into a delivered message.'
INSERT INTO broadcast_campaigns (
  id, team_id, name, audience_kind, audience_filter, body, created_by
) VALUES (
  'aa660000-0000-4000-8000-000000000002',
  '70551e00-0000-4000-8000-000000000001',
  'Follow-up — hand-picked sellers', 'leads',
  jsonb_build_object('lead_ids', jsonb_build_array(
    'cc660000-0000-4000-8000-000000000011', 'cc660000-0000-4000-8000-000000000012',
    'cc660000-0000-4000-8000-000000000013', 'cc660000-0000-4000-8000-000000000014',
    'cc660000-0000-4000-8000-000000000015', 'cc660000-0000-4000-8000-000000000016',
    'cc660000-0000-4000-8000-000000000017')),
  'Following up on your property. Still interested in a cash offer? Reply STOP to opt out.',
  'aaaaaaaa-0000-4000-8000-000000000001'
) ON CONFLICT (id) DO NOTHING;

SELECT * FROM materialise_campaign('aa660000-0000-4000-8000-000000000002');

SELECT l.name, r.status, r.skip_reason, r.phone_e164
FROM broadcast_recipients r
LEFT JOIN leads l ON l.id = r.lead_id
WHERE r.campaign_id = 'aa660000-0000-4000-8000-000000000002'
ORDER BY r.skip_reason NULLS FIRST, l.name;

DO $$
DECLARE v_rows int; v_status text; v_reason text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.broadcast_recipients
   WHERE campaign_id = 'aa660000-0000-4000-8000-000000000002'
     AND public.phone_key(phone_e164) = public.phone_key('912-555-0711');
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the shared number produced % rows, not 1', v_rows;
  END IF;

  SELECT status, skip_reason INTO v_status, v_reason
    FROM public.broadcast_recipients
   WHERE campaign_id = 'aa660000-0000-4000-8000-000000000002'
     AND public.phone_key(phone_e164) = public.phone_key('912-555-0711');
  IF v_status <> 'skipped' OR v_reason <> 'dnc' THEN
    RAISE EXCEPTION
      'FAIL: the shared number resolved to %/% — the clean duplicate beat the DNC flag',
      v_status, v_reason;
  END IF;
  RAISE NOTICE 'PASS: on a collision the suppressed decision wins (fail closed)';
END $$;


\echo '=== 4. a frozen audience stays frozen ==='
\echo '-- Materialise a tight buyer list, collect clean skip rows, then swap the'
\echo '-- body for something the A2P campaign was never registered for, and the'
\echo '-- audit now vouches for a message it never saw. Refused.'
DO $$
BEGIN
  UPDATE broadcast_campaigns
     SET body = 'Totally different offer. STOP to opt out.'
   WHERE id = 'aa660000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: the body of a materialised campaign was rewritten';
EXCEPTION WHEN object_not_in_prerequisite_state THEN
  RAISE NOTICE 'PASS: the body is frozen once the audience is';
END $$;

DO $$
BEGIN
  UPDATE broadcast_campaigns
     SET audience_filter = '{"min_score": 0}'::jsonb
   WHERE id = 'aa660000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: the audience of a materialised campaign was changed';
EXCEPTION WHEN object_not_in_prerequisite_state THEN
  RAISE NOTICE 'PASS: the audience is frozen too';
END $$;

\echo '-- Status and counts still move, or the campaign could never send.'
UPDATE broadcast_campaigns SET status = 'sending', started_at = now()
 WHERE id = 'aa660000-0000-4000-8000-000000000001';

\echo '-- Materialising again once it has left draft would grow the audience'
\echo '-- mid-send, and nothing could then report on it.'
DO $$
BEGIN
  PERFORM public.materialise_campaign('aa660000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'FAIL: a sending campaign was re-materialised';
EXCEPTION WHEN object_not_in_prerequisite_state THEN
  RAISE NOTICE 'PASS: only a draft can be materialised';
END $$;

\echo '-- And the evidence cannot be deleted. A draft nobody materialised can.'
DO $$
BEGIN
  DELETE FROM broadcast_campaigns WHERE id = 'aa660000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: a materialised campaign was deleted';
EXCEPTION WHEN restrict_violation THEN
  RAISE NOTICE 'PASS: a materialised campaign is a record, not a draft';
END $$;

INSERT INTO broadcast_campaigns (id, team_id, name, audience_kind, body)
VALUES ('aa660000-0000-4000-8000-000000000009',
        '70551e00-0000-4000-8000-000000000001',
        'Never sent', 'buyers', 'Draft. STOP to opt out.')
ON CONFLICT (id) DO NOTHING;
DELETE FROM broadcast_campaigns WHERE id = 'aa660000-0000-4000-8000-000000000009';
SELECT count(*) AS unmaterialised_draft_still_there
FROM broadcast_campaigns WHERE id = 'aa660000-0000-4000-8000-000000000009';


\echo '=== 5. the counts are derived, so "sent to 1 of 6" is honest ==='
\echo '-- total_recipients includes the skipped rows. It is the denominator that'
\echo '-- makes the suppressions visible instead of vanishing into a smaller'
\echo '-- audience nobody questions.'
SELECT name, total_recipients, pending_count, skipped_count, sent_count, failed_count
FROM broadcast_campaigns
WHERE id IN ('aa660000-0000-4000-8000-000000000001',
             'aa660000-0000-4000-8000-000000000002')
ORDER BY name;

DO $$
DECLARE c public.broadcast_campaigns;
BEGIN
  SELECT * INTO c FROM public.broadcast_campaigns
   WHERE id = 'aa660000-0000-4000-8000-000000000001';
  IF c.total_recipients <> c.pending_count + c.skipped_count + c.queued_count
                          + c.sent_count + c.failed_count THEN
    RAISE EXCEPTION 'FAIL: the campaign counts do not add up to the audience';
  END IF;
  IF c.total_recipients <> (SELECT count(*) FROM public.broadcast_recipients
                             WHERE campaign_id = c.id) THEN
    RAISE EXCEPTION 'FAIL: total_recipients drifted from the recipient rows';
  END IF;
  IF c.skipped_count = 0 THEN
    RAISE EXCEPTION 'FAIL: five suppressions and a skipped_count of zero';
  END IF;
  RAISE NOTICE 'PASS: counts reconcile against the ledger (% total, % skipped)',
    c.total_recipients, c.skipped_count;
END $$;


\echo '=== 6. there is no way to blast the CRM ==='
\echo '-- Bulk SMS to a cold seller list is not defensible under a Low Volume'
\echo '-- Mixed campaign registered for reminders and confirmations. So a leads'
\echo '-- campaign has to name its recipients; there is no filter meaning "all".'
DO $$
BEGIN
  INSERT INTO broadcast_campaigns (team_id, name, audience_kind, audience_filter, body)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Everyone', 'leads',
          '{"status": "new"}'::jsonb, 'Cash offer today. STOP to opt out.');
  RAISE EXCEPTION 'FAIL: a leads campaign was created from a filter';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: a leads audience must be an explicit id list';
END $$;

DO $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO broadcast_campaigns (team_id, name, audience_kind, audience_filter, body)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Empty pick', 'leads',
          '{"lead_ids": []}'::jsonb, 'Cash offer today. STOP to opt out.')
  RETURNING id INTO v_id;
  PERFORM public.materialise_campaign(v_id);
  RAISE EXCEPTION 'FAIL: an empty leads campaign materialised';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: an empty pick is refused rather than silently sending nothing';
END $$;

DO $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO broadcast_campaigns (team_id, name, audience_kind, audience_filter, body)
  SELECT '70551e00-0000-4000-8000-000000000001', 'Too many', 'leads',
         jsonb_build_object('lead_ids', jsonb_agg(gen_random_uuid())),
         'Cash offer today. STOP to opt out.'
    FROM generate_series(1, 251)
  RETURNING id INTO v_id;
  PERFORM public.materialise_campaign(v_id);
  RAISE EXCEPTION 'FAIL: 251 hand-picked sellers went through';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: the leads audience is capped';
END $$;

\echo '-- Every bulk message carries its own way out. A buyer who cannot find'
\echo '-- the exit reports the number, which costs more than the buyer did.'
DO $$
BEGIN
  INSERT INTO broadcast_campaigns (team_id, name, audience_kind, body)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'No exit', 'buyers',
          'New deal in Effingham, 110k, reply YES.');
  RAISE EXCEPTION 'FAIL: a bulk body with no opt-out language was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: the body must tell people how to stop';
END $$;

\echo '-- A dispo blast with no property attached is a blast about nothing.'
DO $$
BEGIN
  INSERT INTO broadcast_campaigns (team_id, name, audience_kind, body)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Orphan', 'deal_match',
          'New deal. Reply YES. STOP to opt out.');
  RAISE EXCEPTION 'FAIL: a deal_match campaign was created with no deal';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: deal_match requires a deal';
END $$;


\echo '=== 7. claim locking: two workers, one campaign, one message ==='
\echo '-- A cron run overlapping a manual "send now" is the normal way this'
\echo '-- race happens, and the cost of losing it is a buyer texted twice.'
DO $$
DECLARE
  v_claim uuid;
  v_rid   uuid;
  v_n     int;
BEGIN
  SELECT recipient_id, claim_id INTO v_rid, v_claim
    FROM public.claim_broadcast_recipients('aa660000-0000-4000-8000-000000000001', 10);
  IF v_rid IS NULL THEN
    RAISE EXCEPTION 'FAIL: the one pending recipient was not claimable';
  END IF;
  RAISE NOTICE 'PASS: a worker claimed the pending recipient';

  SELECT count(*) INTO v_n
    FROM public.claim_broadcast_recipients('aa660000-0000-4000-8000-000000000001', 10);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a second worker claimed % already-claimed row(s)', v_n;
  END IF;
  RAISE NOTICE 'PASS: the second worker got nothing';

  -- Releasing with the wrong claim id must be a no-op. Without the claim id in
  -- the WHERE, a worker whose claim already expired would clear the SECOND
  -- worker's lock on its way out and the row would go a third time.
  PERFORM public.release_broadcast_claim(v_rid, gen_random_uuid());
  IF (SELECT processing_claim_id FROM public.broadcast_recipients WHERE id = v_rid)
     IS DISTINCT FROM v_claim THEN
    RAISE EXCEPTION 'FAIL: a stranger released somebody else''s claim';
  END IF;
  RAISE NOTICE 'PASS: only the holder can release a claim';

  PERFORM public.release_broadcast_claim(v_rid, v_claim);
  IF (SELECT processing_claim_id FROM public.broadcast_recipients WHERE id = v_rid)
     IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the holder could not release its own claim';
  END IF;
  RAISE NOTICE 'PASS: the holder released it';
END $$;

\echo '-- And a worker that dies holding a claim does not wedge the campaign.'
DO $$
DECLARE v_cleared int;
BEGIN
  UPDATE public.broadcast_recipients
     SET processing_claim_id = gen_random_uuid(),
         processing_started_at = now() - interval '20 minutes'
   WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
     AND status = 'pending';

  v_cleared := public.reap_stale_broadcast_claims();
  IF v_cleared < 1 THEN
    RAISE EXCEPTION 'FAIL: the reaper freed nothing';
  END IF;
  RAISE NOTICE 'PASS: the reaper freed % stale claim(s)', v_cleared;
END $$;

\echo '-- Backoff is defined here rather than in the worker, because the claim'
\echo '-- query filters on next_retry_at and the two have to agree.'
SELECT broadcast_next_retry(0) AS first_retry,
       broadcast_next_retry(1) AS second_retry,
       broadcast_next_retry(2) AS third_retry,
       broadcast_next_retry(9) AS capped;


\echo '=== 8. a sent dispo message becomes buyer_deal_interest ==='
\echo '-- "blasted" has to be written down at the moment it becomes true, or the'
\echo '-- dispo funnel (blasted -> interested -> offered -> assigned) cannot be'
\echo '-- measured. Doing it in a trigger means a worker that crashes after the'
\echo '-- Twilio call still leaves the funnel correct.'
UPDATE broadcast_recipients
   SET status = 'sent', sent_at = now(), attempts = 1, last_attempt_at = now(),
       twilio_sid = 'SM-test-not-a-real-sid', cost_cents = 1
 WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
   AND buyer_id = 'bb660000-0000-4000-8000-000000000001';

SELECT b.name, i.status, i.match_score, i.notified_at IS NOT NULL AS notified,
       cardinality(i.match_reasons) > 0 AS has_reasons
FROM buyer_deal_interest i JOIN buyers b ON b.id = i.buyer_id
WHERE i.deal_id = 'ee660000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.buyer_deal_interest
     WHERE deal_id = 'ee660000-0000-4000-8000-000000000001'
       AND buyer_id = 'bb660000-0000-4000-8000-000000000001'
       AND status = 'notified' AND notified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: a sent dispo message left no interest row';
  END IF;

  -- Nobody else. The five suppressed buyers were never told about this house,
  -- and an interest row for one of them would be a fabricated notification.
  IF (SELECT count(*) FROM public.buyer_deal_interest
       WHERE deal_id = 'ee660000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FAIL: a buyer who was never texted has an interest row';
  END IF;
  RAISE NOTICE 'PASS: exactly the buyer who was texted is on the deal';
END $$;

\echo '-- A second blast about the same house must not walk a buyer who already'
\echo '-- replied back to "notified" — that is the most valuable state here.'
UPDATE buyer_deal_interest SET status = 'interested', responded_at = now()
 WHERE deal_id = 'ee660000-0000-4000-8000-000000000001'
   AND buyer_id = 'bb660000-0000-4000-8000-000000000001';

UPDATE broadcast_recipients SET status = 'pending', skip_reason = NULL
 WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
   AND buyer_id = 'bb660000-0000-4000-8000-000000000001';
UPDATE broadcast_recipients SET status = 'sent', sent_at = now()
 WHERE campaign_id = 'aa660000-0000-4000-8000-000000000001'
   AND buyer_id = 'bb660000-0000-4000-8000-000000000001';

DO $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.buyer_deal_interest
   WHERE deal_id = 'ee660000-0000-4000-8000-000000000001'
     AND buyer_id = 'bb660000-0000-4000-8000-000000000001';
  IF v_status <> 'interested' THEN
    RAISE EXCEPTION 'FAIL: a re-blast downgraded an interested buyer to "%"', v_status;
  END IF;
  RAISE NOTICE 'PASS: a re-blast refreshes notified_at and downgrades nothing';
END $$;

\echo '-- And the blast is on the deal''s immutable history.'
SELECT type, actor_kind, summary
FROM deal_events
WHERE deal_id = 'ee660000-0000-4000-8000-000000000001'
  AND type = 'dispo_blast_started';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.deal_events
     WHERE deal_id = 'ee660000-0000-4000-8000-000000000001'
       AND type = 'dispo_blast_started'
       AND (payload ->> 'skipped')::int > 0
  ) THEN
    RAISE EXCEPTION 'FAIL: the blast left no deal event, or lost the skip count';
  END IF;
  RAISE NOTICE 'PASS: the blast and its suppression count are in the deal history';
END $$;


\echo '=== 9. a blast about a property that is gone ==='
\echo '-- Texting a buyers list about a dead deal is how the list stops being'
\echo '-- read, which costs more than any single deal.'
DO $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO broadcast_campaigns (team_id, name, audience_kind, deal_id, body)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Dead deal blast', 'deal_match',
          'ee660000-0000-4000-8000-000000000002',
          'New off-market deal. Reply YES. STOP to opt out.')
  RETURNING id INTO v_id;
  PERFORM public.materialise_campaign(v_id);
  RAISE EXCEPTION 'FAIL: a dead deal was blasted';
EXCEPTION WHEN object_not_in_prerequisite_state THEN
  RAISE NOTICE 'PASS: a dead deal cannot be dispo''d';
END $$;


\echo '=== 10. the buyers audience is a different question from the box ==='
\echo '-- A general note to the list is legitimate — these are people who asked'
\echo '-- to hear from Tossie. The buy box does not apply, but every consent'
\echo '-- gate still does, and the skips are still on the record.'
INSERT INTO broadcast_campaigns (id, team_id, name, audience_kind, body)
VALUES ('aa660000-0000-4000-8000-000000000003',
        '70551e00-0000-4000-8000-000000000001',
        'Buyers list note', 'buyers',
        'We are at the Savannah REIA Tuesday. Reply STOP to opt out.')
ON CONFLICT (id) DO NOTHING;

SELECT * FROM materialise_campaign('aa660000-0000-4000-8000-000000000003');

SELECT b.name, r.status, r.skip_reason
FROM broadcast_recipients r LEFT JOIN buyers b ON b.id = r.buyer_id
WHERE r.campaign_id = 'aa660000-0000-4000-8000-000000000003'
ORDER BY r.status, b.name;

DO $$
BEGIN
  -- The wrong-county buyer is textable; only the buy box excluded him from the
  -- dispo blast, and there is no buy box here.
  IF (SELECT status FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000003'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000005') <> 'pending' THEN
    RAISE EXCEPTION 'FAIL: a buy-box filter leaked into a general buyers campaign';
  END IF;
  IF (SELECT skip_reason FROM public.broadcast_recipients
       WHERE campaign_id = 'aa660000-0000-4000-8000-000000000003'
         AND buyer_id = 'bb660000-0000-4000-8000-000000000002') <> 'opted_out' THEN
    RAISE EXCEPTION 'FAIL: the opt-out did not apply to a general buyers campaign';
  END IF;
  IF EXISTS (SELECT 1 FROM public.broadcast_recipients
              WHERE campaign_id = 'aa660000-0000-4000-8000-000000000003'
                AND skip_reason = 'not_in_buy_box') THEN
    RAISE EXCEPTION 'FAIL: not_in_buy_box appeared in a campaign that has no box';
  END IF;
  RAISE NOTICE 'PASS: consent gates apply everywhere, the buy box only to dispo';
END $$;


\echo '=== 11. RLS: another team sees none of it ==='
BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT (SELECT count(*) FROM broadcast_campaigns)  AS campaigns_visible,
       (SELECT count(*) FROM broadcast_recipients) AS recipients_visible;
COMMIT;

\echo '-- materialise_campaign is SECURITY INVOKER, so a rival cannot use it to'
\echo '-- enumerate Tossie''s buyers list — which IS the business.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.materialise_campaign('aa660000-0000-4000-8000-000000000003');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: an outsider materialised another team''s campaign';
  EXCEPTION WHEN no_data_found THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: another team''s campaign does not exist as far as they know';
  END;
END $$;

DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO broadcast_campaigns (team_id, name, audience_kind, body)
    VALUES ('70551e00-0000-4000-8000-000000000001', 'Planted', 'buyers',
            'Planted message. STOP to opt out.');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: an outsider planted a campaign in another team';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: WITH CHECK rejected the cross-team insert';
  END;
END $$;

\echo '-- The composite FK is the belt to RLS''s braces: the worker runs on the'
\echo '-- service role and bypasses RLS entirely, so a buggy worker must still'
\echo '-- be unable to file a recipient under a different team than its campaign.'
DO $$
BEGIN
  INSERT INTO broadcast_recipients (team_id, campaign_id, phone_e164, status)
  VALUES ('99999999-0000-4000-8000-000000000001',
          'aa660000-0000-4000-8000-000000000003', '+19125550796', 'pending');
  RAISE EXCEPTION 'FAIL: a recipient landed under a different team than its campaign';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'PASS: recipient and campaign cannot disagree about tenancy';
END $$;

\echo '=== 12. both new tables have RLS on ==='
SELECT c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('broadcast_campaigns', 'broadcast_recipients')
ORDER BY c.relname;

\echo '=== 13. the public anon key holds nothing here ==='
\echo '-- This key is in the browser bundle. What leaks here is the buyers list'
\echo '-- crossed with every message Tossie ever sent it.'
SELECT
  has_table_privilege('anon', 'public.broadcast_campaigns',  'SELECT') AS anon_campaigns_select,
  has_table_privilege('anon', 'public.broadcast_campaigns',  'INSERT') AS anon_campaigns_insert,
  has_table_privilege('anon', 'public.broadcast_campaigns',  'UPDATE') AS anon_campaigns_update,
  has_table_privilege('anon', 'public.broadcast_recipients', 'SELECT') AS anon_recipients_select,
  has_table_privilege('anon', 'public.broadcast_recipients', 'INSERT') AS anon_recipients_insert,
  has_table_privilege('anon', 'public.broadcast_recipients', 'DELETE') AS anon_recipients_delete;

SELECT
  has_function_privilege('anon', 'public.materialise_campaign(uuid)',                'EXECUTE') AS anon_can_materialise,
  has_function_privilege('anon', 'public.claim_broadcast_recipients(uuid,integer)',  'EXECUTE') AS anon_can_claim,
  has_function_privilege('anon', 'public.release_broadcast_claim(uuid,uuid)',        'EXECUTE') AS anon_can_release,
  has_function_privilege('anon', 'public.reap_stale_broadcast_claims()',             'EXECUTE') AS anon_can_reap,
  has_function_privilege('anon', 'public.buyer_skip_reason(public.buyers)',          'EXECUTE') AS anon_can_read_buyer_reason,
  has_function_privilege('anon', 'public.lead_skip_reason(public.leads)',            'EXECUTE') AS anon_can_read_lead_reason,
  has_function_privilege('anon', 'public.broadcast_next_retry(integer)',             'EXECUTE') AS anon_can_read_backoff,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('broadcast_campaigns', 'broadcast_recipients')
      AND 'anon' = ANY(roles)) AS policies_naming_anon;

\echo '-- The broadcast worker runs on the service role. Without these it fails'
\echo '-- at exactly the moment it is about to send.'
SELECT
  has_function_privilege('service_role', 'public.materialise_campaign(uuid)',               'EXECUTE') AS worker_can_materialise,
  has_function_privilege('service_role', 'public.claim_broadcast_recipients(uuid,integer)', 'EXECUTE') AS worker_can_claim,
  has_function_privilege('service_role', 'public.release_broadcast_claim(uuid,uuid)',       'EXECUTE') AS worker_can_release,
  has_function_privilege('service_role', 'public.reap_stale_broadcast_claims()',            'EXECUTE') AS worker_can_reap,
  has_function_privilege('service_role', 'public.buyer_skip_reason(public.buyers)',         'EXECUTE') AS worker_can_explain;

\echo '=== 14. the volatility and security claims in the migration, asserted ==='
\echo '-- s = stable for anything reading telephony_opt_outs: IMMUTABLE would'
\echo '-- let a cached plan outlive a STOP message. And prosecdef must be false'
\echo '-- everywhere — nothing here does anything the caller could not.'
SELECT p.proname, p.provolatile, p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('buyer_skip_reason', 'lead_skip_reason', 'broadcast_next_retry',
                    'materialise_campaign', 'claim_broadcast_recipients',
                    'release_broadcast_claim', 'reap_stale_broadcast_claims')
ORDER BY p.proname;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND p.proname IN ('buyer_skip_reason', 'lead_skip_reason', 'broadcast_next_retry',
                       'materialise_campaign', 'claim_broadcast_recipients',
                       'release_broadcast_claim', 'reap_stale_broadcast_claims');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'FAIL: % broadcast function(s) are SECURITY DEFINER', v_n;
  END IF;
  RAISE NOTICE 'PASS: every broadcast function is SECURITY INVOKER';
END $$;

SELECT count(*) AS indexes_referencing_skip_reason_fns
FROM pg_indexes
WHERE schemaname = 'public'
  AND (indexdef LIKE '%buyer_skip_reason%' OR indexdef LIKE '%lead_skip_reason%');

\echo '=== 15. a blast in flight is published to realtime ==='
\echo '-- A progress bar that needs a page refresh is a progress bar nobody'
\echo '-- believes, and an operator who does not believe it sends again.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('broadcast_campaigns', 'broadcast_recipients')
ORDER BY tablename;
