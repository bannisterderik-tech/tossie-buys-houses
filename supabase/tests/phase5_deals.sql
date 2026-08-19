\set ON_ERROR_STOP on
\pset pager off

-- ============================================================================
-- Phase 5 — deals, buyers, dispo — 20260820120000_deals_buyers.sql
-- ============================================================================
-- Five things this suite exists to hold down, in the order they would hurt:
--
--   1. The buy-box matcher never returns a buyer who did not agree to be
--      texted, or who texted STOP, or who is paused. That is the difference
--      between a defensible A2P campaign and a suspended one.
--   2. The fallback paths a wholesaler actually walks — buyer reneges and you
--      re-dispo, seller backs out, extension, terminate in inspection — are
--      legal transitions and not dead ends.
--   3. deal_events cannot be rewritten by anybody, including the service role.
--   4. RLS keeps another team out of every one of the six new tables.
--   5. anon, whose key ships in the browser bundle, holds nothing.
--
-- SAME CAVEAT AS phase2_telephony, phase3_* AND phase4_sdr: the blanket grant
-- two lines down hands `authenticated` privileges the migration deliberately
-- withheld — DELETE on deals, DELETE on buyer_deal_interest, UPDATE and DELETE
-- on deal_events. Nothing below asserts a grant held by `authenticated`,
-- because such an assertion would pass alone and fail in sequence. What §5 DOES
-- assert is that deal_events is append-only anyway, which is precisely why that
-- rule is a trigger and not a missing grant: the trigger survives this line,
-- and it survives the service role too.
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

-- ── the deal every buyer is measured against ────────────────────────────────
-- Chatham County, 31401, tenant-occupied, heavy rehab.
--   buyer_price  = 120,000 + 15,000              = 135,000
--   buyer_spread = 260,000 - 60,000 - 135,000    =  65,000
-- Both are generated columns; §2 asserts them rather than trusting the arithmetic.
INSERT INTO leads (id, team_id, name, phone, address, city, state, county, source,
                   tcpa_opt_in, tcpa_opt_in_at)
VALUES ('cc550000-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001', 'Deal Seller', '(912) 555-0501',
        '501 Contract Ln', 'Savannah', 'GA', 'Chatham', 'website', true, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO deals (
  id, team_id, lead_id, address, city, state, zip, county,
  property_type, beds, baths, occupancy, rehab_level,
  contract_price, arv_estimate, repair_estimate, target_assignment_fee,
  status, exit_strategy
) VALUES (
  'dd550000-0000-4000-8000-000000000001',
  '70551e00-0000-4000-8000-000000000001',
  'cc550000-0000-4000-8000-000000000001',
  '501 Contract Ln', 'Savannah', 'GA', '31401', 'Chatham',
  'single_family', 3, 2, 'tenant', 'heavy',
  120000, 260000, 60000, 15000,
  'draft', 'assign'
) ON CONFLICT (id) DO NOTHING;

-- ── the buyers list, one row per way this can go right or wrong ─────────────
-- 555 numbers throughout: the range reserved for documentation, same as every
-- other suite here. Nothing in this file is a number that could ring.
INSERT INTO buyers (
  id, team_id, name, entity_name, phone, email, status,
  counties, zips, property_types, price_min, price_max, beds_min,
  min_spread, rehab_tolerance, funding, typical_close_days, takes_occupied,
  deals_closed, deals_reneged, last_purchase_date, rating,
  consent_sms, tcpa_opt_in, tcpa_opt_in_at
) VALUES
  -- The one who should top the list: in the box, closes, never reneged.
  ('bb550000-0000-4000-8000-000000000001', '70551e00-0000-4000-8000-000000000001',
   'Clean Record Buyer', 'Clean Record Holdings LLC', '(912) 555-0601', 'clean@example.com', 'active',
   '{Chatham}', '{31401}', '{single_family}', 50000, 250000, 2,
   30000, 'heavy', 'cash', 10, true,
   4, 0, now()::date - 20, 5,
   true, true, now()),

  -- Same box, more volume, three walked deals. Must rank BELOW the clean one;
  -- this is the assertion the whole deals_reneged column exists for.
  ('bb550000-0000-4000-8000-000000000002', '70551e00-0000-4000-8000-000000000001',
   'Reneger Buyer', 'Reneger Capital LLC', '(912) 555-0602', 'reneger@example.com', 'active',
   '{Chatham}', '{31401}', '{single_family}', 50000, 250000, 2,
   30000, 'heavy', 'cash', 10, true,
   9, 3, now()::date - 15, 5,
   true, true, now()),

  -- No SMS consent. Perfect box; never blastable.
  ('bb550000-0000-4000-8000-000000000003', '70551e00-0000-4000-8000-000000000001',
   'No Consent Buyer', NULL, '(912) 555-0603', 'noconsent@example.com', 'active',
   '{Chatham}', '{31401}', '{single_family}', 50000, 250000, 2,
   30000, 'heavy', 'cash', 10, true,
   6, 0, now()::date - 10, 5,
   false, false, NULL),

  -- Consented, then texted STOP. §4 puts the opt-out row in.
  ('bb550000-0000-4000-8000-000000000004', '70551e00-0000-4000-8000-000000000001',
   'Opted Out Buyer', NULL, '(912) 555-0604', 'optout@example.com', 'active',
   '{Chatham}', '{31401}', '{single_family}', 50000, 250000, 2,
   30000, 'heavy', 'cash', 10, true,
   6, 0, now()::date - 10, 5,
   true, true, now()),

  -- Out of money this quarter. Comes back later; not on this list.
  ('bb550000-0000-4000-8000-000000000005', '70551e00-0000-4000-8000-000000000001',
   'Paused Buyer', NULL, '(912) 555-0605', 'paused@example.com', 'paused',
   '{Chatham}', '{31401}', '{single_family}', 50000, 250000, 2,
   30000, 'heavy', 'cash', 10, true,
   6, 0, now()::date - 10, 5,
   true, true, now()),

  -- Wrong county, and no zips either.
  ('bb550000-0000-4000-8000-000000000006', '70551e00-0000-4000-8000-000000000001',
   'Wrong County Buyer', NULL, '(912) 555-0606', 'county@example.com', 'active',
   '{Bulloch}', '{}', '{single_family}', 50000, 250000, 2,
   30000, 'heavy', 'cash', 10, true,
   2, 0, NULL, 3,
   true, true, now()),

  -- Ceiling is below what the end buyer would actually pay.
  ('bb550000-0000-4000-8000-000000000007', '70551e00-0000-4000-8000-000000000001',
   'Small Ticket Buyer', NULL, '(912) 555-0607', 'small@example.com', 'active',
   '{Chatham}', '{}', '{}', 40000, 90000, NULL,
   NULL, 'heavy', 'cash', 10, true,
   1, 0, NULL, 3,
   true, true, now()),

  -- Cosmetic work only; this one needs a roof.
  ('bb550000-0000-4000-8000-000000000008', '70551e00-0000-4000-8000-000000000001',
   'Light Touch Buyer', NULL, '(912) 555-0608', 'light@example.com', 'active',
   '{Chatham}', '{}', '{}', NULL, NULL, NULL,
   NULL, 'light', 'financed', 30, true,
   1, 0, NULL, 3,
   true, true, now()),

  -- Will not take a tenant in place, and there is one in place.
  ('bb550000-0000-4000-8000-000000000009', '70551e00-0000-4000-8000-000000000001',
   'Vacant Only Buyer', NULL, '(912) 555-0609', 'vacant@example.com', 'active',
   '{Chatham}', '{}', '{}', NULL, NULL, NULL,
   NULL, 'full_gut', 'cash', 14, false,
   1, 0, NULL, 3,
   true, true, now()),

  -- Empty box everywhere. Must still match: an empty array is "no restriction",
  -- not "matches nothing", or nobody would ever add a buyer mid-phone-call.
  ('bb550000-0000-4000-8000-000000000010', '70551e00-0000-4000-8000-000000000001',
   'Anywhere Buyer', NULL, '(912) 555-0610', 'anywhere@example.com', 'active',
   '{}', '{}', '{}', NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, true,
   0, 0, NULL, NULL,
   true, true, now())
ON CONFLICT (id) DO NOTHING;

-- The STOP, written exactly as the inbound webhook writes it: phone_key form.
INSERT INTO telephony_opt_outs (team_id, phone_key, source, note)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('(912) 555-0604'),
        'sms_stop', 'buyer replied STOP to a deal blast')
ON CONFLICT (team_id, phone_key) DO NOTHING;


\echo '=== 1. buyers carry the same consent shape as leads, and it is provable ==='
\echo '-- A boolean with no timestamp is not evidence of anything. Identical'
\echo '-- constraint to leads_opt_in_needs_provenance, identical reason.'
DO $$
BEGIN
  INSERT INTO buyers (team_id, name, phone, tcpa_opt_in)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Bare Assertion Buyer',
          '(912) 555-0699', true);
  RAISE EXCEPTION 'FAIL: opt-in was asserted with no timestamp';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: opt-in without provenance is refused';
END $$;

\echo '-- ...and the RPC that satisfies it, so the constraint is not a trap.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT (public.record_buyer_consent(
          'bb550000-0000-4000-8000-000000000003',
          'verbal at the Tuesday meetup',
          'asked to be added to the deal blast')).tcpa_opt_in AS opt_in_recorded;
COMMIT;
SELECT tcpa_opt_in, tcpa_opt_in_at IS NOT NULL AS has_timestamp,
       tcpa_disclosure_source, consent_sms
FROM buyers WHERE id = 'bb550000-0000-4000-8000-000000000003';

\echo '-- Undone again, because §4 needs this buyer non-consenting.'
UPDATE buyers SET tcpa_opt_in = false, consent_sms = false, consent_email = false,
                  tcpa_opt_in_at = NULL
 WHERE id = 'bb550000-0000-4000-8000-000000000003';

\echo '-- A blank source is refused: "how was this obtained" is the whole point.'
DO $$
BEGIN
  PERFORM public.record_buyer_consent('bb550000-0000-4000-8000-000000000003', '   ');
  RAISE EXCEPTION 'FAIL: consent was recorded with no source';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: a consent source is required';
END $$;

\echo '=== 2. the deal numbers a buyer is judged on are generated, not typed ==='
\echo '-- buyer_spread subtracts OUR fee. Matching min_spread against the'
\echo '-- wholesaler spread would promise buyers a margin we are taking.'
SELECT contract_price, target_assignment_fee, buyer_price, buyer_spread,
       arv_estimate - repair_estimate - contract_price AS our_spread_for_contrast
FROM deals WHERE id = 'dd550000-0000-4000-8000-000000000001';

\echo '=== 3. one buyer per number: a duplicate row is a duplicate text ==='
DO $$
BEGIN
  INSERT INTO buyers (team_id, name, phone)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Same Buyer Again', '912-555-0601');
  RAISE EXCEPTION 'FAIL: a second buyer row took the same number';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: deduped on phone_key, whatever the formatting';
END $$;

\echo '=== 4. buyer_is_textable is the gate, one buyer at a time ==='
\echo '-- consent, opt-out and status, checked the same way lead_is_dialable'
\echo '-- checks them for a seller. Expect true only for the first row.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT name, buyer_is_textable(b.*) AS textable
FROM buyers b
WHERE id IN ('bb550000-0000-4000-8000-000000000001',
             'bb550000-0000-4000-8000-000000000003',
             'bb550000-0000-4000-8000-000000000004',
             'bb550000-0000-4000-8000-000000000005')
ORDER BY name;
COMMIT;

\echo '=== 5. the matcher: who comes back, in what order, and why ==='
\echo '-- Never the non-consenting, opted-out or paused buyer, regardless of'
\echo '-- how well the box fits. That is a filter, not a score penalty, because'
\echo '-- a scored list invites somebody to send to the bottom of it.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT b.name, m.score, m.reasons
FROM match_buyers_for_deal('dd550000-0000-4000-8000-000000000001') m
JOIN buyers b ON b.id = m.buyer_id
ORDER BY m.score DESC, b.name;
COMMIT;

\echo '-- Asserted rather than eyeballed.'
DO $$
DECLARE
  v_matched  uuid[];
  v_clean    int;
  v_reneger  int;
BEGIN
  SELECT array_agg(buyer_id) INTO v_matched
    FROM public.match_buyers_for_deal('dd550000-0000-4000-8000-000000000001');

  IF 'bb550000-0000-4000-8000-000000000003' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: a buyer with no SMS consent was matched';
  END IF;
  IF 'bb550000-0000-4000-8000-000000000004' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: an opted-out buyer was matched';
  END IF;
  IF 'bb550000-0000-4000-8000-000000000005' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: a paused buyer was matched';
  END IF;
  RAISE NOTICE 'PASS: no-consent, opted-out and paused buyers are all excluded';

  IF 'bb550000-0000-4000-8000-000000000006' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: a buyer whose counties exclude this one was matched';
  END IF;
  IF 'bb550000-0000-4000-8000-000000000007' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: price ceiling below buyer_price did not exclude';
  END IF;
  IF 'bb550000-0000-4000-8000-000000000008' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: a light-rehab-only buyer was shown a heavy rehab';
  END IF;
  IF 'bb550000-0000-4000-8000-000000000009' = ANY(v_matched) THEN
    RAISE EXCEPTION 'FAIL: a vacant-only buyer was shown a tenanted property';
  END IF;
  RAISE NOTICE 'PASS: geography, price, rehab and occupancy all filter';

  -- An empty buy box is "no restriction", not "matches nothing".
  IF NOT ('bb550000-0000-4000-8000-000000000010' = ANY(v_matched)) THEN
    RAISE EXCEPTION 'FAIL: a buyer with an empty buy box was excluded';
  END IF;
  RAISE NOTICE 'PASS: an empty buy box still matches';

  SELECT score INTO v_clean FROM public.match_buyers_for_deal('dd550000-0000-4000-8000-000000000001')
   WHERE buyer_id = 'bb550000-0000-4000-8000-000000000001';
  SELECT score INTO v_reneger FROM public.match_buyers_for_deal('dd550000-0000-4000-8000-000000000001')
   WHERE buyer_id = 'bb550000-0000-4000-8000-000000000002';

  -- Same box, more closings, three walked deals. If volume won here the list
  -- would put the man who ties up your contracts at the top of every blast.
  IF v_reneger >= v_clean THEN
    RAISE EXCEPTION 'FAIL: a buyer with 3 reneges outranked one with none (% vs %)',
      v_reneger, v_clean;
  END IF;
  RAISE NOTICE 'PASS: reneges outweigh volume (clean %, reneger %)', v_clean, v_reneger;
END $$;

\echo '-- Every match explains itself. An unranked, unexplained list is one'
\echo '-- nobody trusts, and an untrusted list gets replaced by "text everyone".'
SELECT count(*) AS matches,
       count(*) FILTER (WHERE cardinality(reasons) = 0) AS matches_with_no_reason
FROM match_buyers_for_deal('dd550000-0000-4000-8000-000000000001');

\echo '-- The reneger says so, in words, without opening the record.'
SELECT EXISTS (
  SELECT 1 FROM match_buyers_for_deal('dd550000-0000-4000-8000-000000000001')
   WHERE buyer_id = 'bb550000-0000-4000-8000-000000000002'
     AND 'RENEGED on 3' = ANY(reasons)
) AS reneger_is_labelled;

\echo '-- Case and stray whitespace in a hand-typed buy box do not lose a buyer.'
UPDATE buyers SET counties = '{"  chatham "}', zips = '{}'
 WHERE id = 'bb550000-0000-4000-8000-000000000001';
SELECT EXISTS (
  SELECT 1 FROM match_buyers_for_deal('dd550000-0000-4000-8000-000000000001')
   WHERE buyer_id = 'bb550000-0000-4000-8000-000000000001'
) AS still_matches_on_messy_county;
UPDATE buyers SET counties = '{Chatham}', zips = '{31401}'
 WHERE id = 'bb550000-0000-4000-8000-000000000001';

\echo '=== 6. the fallback paths are first-class, not dead ends ==='
\echo '-- Buyer reneges and you re-dispo; seller backs out; you need an'
\echo '-- extension; you terminate inside inspection. This is a normal month.'
INSERT INTO deals (id, team_id, address, city, state, county, zip, status,
                   contract_price, target_assignment_fee)
VALUES ('dd550000-0000-4000-8000-000000000002',
        '70551e00-0000-4000-8000-000000000001',
        '502 Fallback Rd', 'Savannah', 'GA', 'Chatham', '31401', 'draft',
        100000, 12000)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_deal uuid := 'dd550000-0000-4000-8000-000000000002';
  v_step text;
  -- The route through the whole model, in the order it actually happens.
  v_path text[] := ARRAY[
    'under_contract',        -- signed
    'dispo',                 -- out to the buyers list
    'buyer_selected',        -- somebody said yes
    'assigned',              -- assignment papered
    'buyer_fell_through',    -- ...and then he vanished
    'dispo',                 -- back out to the list, which is the point
    'buyer_selected',
    'extension_pending',     -- calendar ran out, addendum pending
    'buyer_selected',
    'assigned',
    'closed'                 -- paid
  ];
BEGIN
  FOREACH v_step IN ARRAY v_path LOOP
    UPDATE public.deals SET
      status = v_step,
      -- The two CHECKs that keep the money view honest have to be satisfied on
      -- the way past, not worked around.
      assigned_buyer_id = CASE WHEN v_step IN ('assigned', 'closed')
                               THEN 'bb550000-0000-4000-8000-000000000001'
                               ELSE assigned_buyer_id END,
      actual_close_date = CASE WHEN v_step = 'closed' THEN now()::date
                               ELSE actual_close_date END,
      actual_assignment_fee = CASE WHEN v_step = 'closed' THEN 12000
                                   ELSE actual_assignment_fee END
     WHERE id = v_deal;
  END LOOP;
  RAISE NOTICE 'PASS: the full re-dispo / extension / close route is legal';
END $$;

SELECT status, actual_assignment_fee, actual_close_date IS NOT NULL AS has_close_date
FROM deals WHERE id = 'dd550000-0000-4000-8000-000000000002';

\echo '-- A closed deal does not quietly reopen. The money view has counted it.'
DO $$
BEGIN
  UPDATE deals SET status = 'dispo' WHERE id = 'dd550000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: a closed deal went back out to dispo';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: closed -> dispo is refused';
END $$;

DO $$
BEGIN
  UPDATE deals SET status = 'dead' WHERE id = 'dd550000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: a closed deal was retired out of the money view';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: closed -> dead is refused, unlike every live status';
END $$;

\echo '-- ...but a premature "closed" tap can be undone, in one narrow step.'
UPDATE deals SET status = 'assigned' WHERE id = 'dd550000-0000-4000-8000-000000000002';
SELECT status AS after_undoing_the_close FROM deals WHERE id = 'dd550000-0000-4000-8000-000000000002';

\echo '-- The two terminations, and the fact that both can come back.'
DO $$
BEGIN
  UPDATE deals SET status = 'under_contract' WHERE id = 'dd550000-0000-4000-8000-000000000001';
  UPDATE deals SET status = 'terminated_inspection' WHERE id = 'dd550000-0000-4000-8000-000000000001';
  UPDATE deals SET status = 'under_contract' WHERE id = 'dd550000-0000-4000-8000-000000000001';
  UPDATE deals SET status = 'seller_terminated' WHERE id = 'dd550000-0000-4000-8000-000000000001';
  UPDATE deals SET status = 'dispo' WHERE id = 'dd550000-0000-4000-8000-000000000001';
  RAISE NOTICE 'PASS: both terminations are reversible';
END $$;

\echo '-- Every live status can reach dead, so the guard never traps anyone.'
SELECT count(*) FILTER (WHERE NOT deal_status_can_transition(s, 'dead')) AS live_statuses_that_cannot_die
FROM unnest(ARRAY['draft','under_contract','dispo','buyer_selected','assigned',
                  'extension_pending','buyer_fell_through','seller_terminated',
                  'terminated_inspection']) AS s;

\echo '-- And a status that is not a status is still refused by the CHECK.'
DO $$
BEGIN
  UPDATE deals SET status = 'sold_ish' WHERE id = 'dd550000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: an invented status was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: the status vocabulary is closed';
END $$;

\echo '=== 7. deal_events is append-only, and not merely ungranted ==='
\echo '-- The service role bypasses RLS and holds table privileges, and the'
\echo '-- setup at the top of this file granted ALL to authenticated. A trigger'
\echo '-- is the only version of this rule that survives either.'
-- Grouped rather than ordered by created_at: the whole route above ran inside
-- one transaction, so every event carries the same now() and an ORDER BY on it
-- is decided by whatever order the heap hands back. A suite that passes on
-- planner luck is worse than no suite.
SELECT summary, count(*) AS times
FROM deal_events
WHERE deal_id = 'dd550000-0000-4000-8000-000000000002' AND type = 'status_changed'
GROUP BY summary ORDER BY summary;

DO $$
BEGIN
  UPDATE deal_events SET summary = 'never happened'
   WHERE deal_id = 'dd550000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: a deal event was rewritten';
EXCEPTION WHEN restrict_violation THEN
  RAISE NOTICE 'PASS: UPDATE on deal_events is refused by trigger';
END $$;

DO $$
BEGIN
  DELETE FROM deal_events WHERE deal_id = 'dd550000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: a deal event was deleted';
EXCEPTION WHEN restrict_violation THEN
  RAISE NOTICE 'PASS: DELETE on deal_events is refused by trigger';
END $$;

\echo '-- Status changes log themselves, so no caller can forget. The whole'
\echo '-- re-dispo route above is in the bus without anyone writing an event.'
SELECT count(*) AS status_events_written
FROM deal_events
WHERE deal_id = 'dd550000-0000-4000-8000-000000000002' AND type = 'status_changed';

\echo '=== 8. the two dates that cost real money mind themselves ==='
\echo '-- A milestone somebody has to remember to create is a milestone that is'
\echo '-- missing from the deal where it mattered.'
UPDATE deals SET
  executed_date       = now()::date,
  emd_amount          = 2500,
  emd_due_date        = now()::date + 3,
  inspection_end_date = now()::date + 10,
  closing_date        = now()::date + 30
WHERE id = 'dd550000-0000-4000-8000-000000000001';

SELECT kind, label, auto_managed,
       (due_at::date - now()::date) AS days_out,
       reminder_offsets_hours,
       -- 168h before the due instant: the first rung of the ladder.
       (due_at - next_reminder_at) = interval '168 hours' AS first_rung_is_t_minus_7d
FROM deal_milestones
WHERE deal_id = 'dd550000-0000-4000-8000-000000000001'
ORDER BY due_at;

\echo '-- The deadline is 5pm, not midnight. A ladder anchored to midnight'
\echo '-- fires every rung a day early, and an always-early reminder is one'
\echo '-- people learn to ignore.'
SELECT DISTINCT to_char(due_at, 'HH24:MI') AS milestone_time_of_day
FROM deal_milestones WHERE deal_id = 'dd550000-0000-4000-8000-000000000001';

\echo '-- An extension re-arms the whole ladder. Three fresh warnings, not'
\echo '-- silence because the T-7 rung was marked sent against the old date.'
UPDATE deal_milestones SET reminders_sent_hours = '{168,72}'
 WHERE deal_id = 'dd550000-0000-4000-8000-000000000001' AND kind = 'closing';
SELECT reminders_sent_hours AS before_extension,
       (due_at - next_reminder_at) = interval '24 hours' AS next_rung_is_t_minus_24h
FROM deal_milestones
WHERE deal_id = 'dd550000-0000-4000-8000-000000000001' AND kind = 'closing';

UPDATE deals SET closing_date = now()::date + 51, extension_count = extension_count + 1
 WHERE id = 'dd550000-0000-4000-8000-000000000001';

SELECT reminders_sent_hours AS after_extension,
       (due_at::date - now()::date) AS days_out,
       (due_at - next_reminder_at) = interval '168 hours' AS ladder_rearmed
FROM deal_milestones
WHERE deal_id = 'dd550000-0000-4000-8000-000000000001' AND kind = 'closing';

\echo '-- Clearing a date removes the auto milestone rather than leaving a'
\echo '-- reminder pointing at a deadline that no longer exists.'
UPDATE deals SET inspection_end_date = NULL WHERE id = 'dd550000-0000-4000-8000-000000000001';
SELECT count(*) AS inspection_milestones_left
FROM deal_milestones
WHERE deal_id = 'dd550000-0000-4000-8000-000000000001' AND kind = 'inspection_end';

\echo '-- A ladder rung already in the past comes back in the past, so the'
\echo '-- worker sends it immediately instead of skipping a late-entered deal.'
SELECT deal_milestone_next_reminder(now() + interval '2 days', '{168,72,24}', '{}')
         < now() AS overdue_rung_fires_now,
       deal_milestone_next_reminder(now() + interval '2 days', '{168,72,24}', '{168,72,24}')
         IS NULL AS nothing_left_to_send;

\echo '=== 9. buyer_deal_interest: the dispo funnel, and one winner ==='
INSERT INTO buyer_deal_interest (team_id, deal_id, buyer_id, status, match_score, match_reasons, notified_at)
SELECT '70551e00-0000-4000-8000-000000000001',
       'dd550000-0000-4000-8000-000000000001',
       m.buyer_id, 'notified', m.score, m.reasons, now()
FROM match_buyers_for_deal('dd550000-0000-4000-8000-000000000001') m;

SELECT count(*) AS buyers_notified,
       count(*) FILTER (WHERE match_score IS NOT NULL) AS with_a_recorded_score,
       count(*) FILTER (WHERE cardinality(match_reasons) > 0) AS with_a_recorded_reason
FROM buyer_deal_interest WHERE deal_id = 'dd550000-0000-4000-8000-000000000001';

\echo '-- The same buyer cannot be put on the same deal twice; that is two'
\echo '-- texts about one house, which reads as spam to a carrier.'
DO $$
BEGIN
  INSERT INTO buyer_deal_interest (team_id, deal_id, buyer_id)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'dd550000-0000-4000-8000-000000000001',
          'bb550000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'FAIL: a buyer was notified twice about one deal';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: one interest row per buyer per deal';
END $$;

UPDATE buyer_deal_interest SET status = 'selected'
 WHERE deal_id = 'dd550000-0000-4000-8000-000000000001'
   AND buyer_id = 'bb550000-0000-4000-8000-000000000001';

DO $$
BEGIN
  UPDATE buyer_deal_interest SET status = 'selected'
   WHERE deal_id = 'dd550000-0000-4000-8000-000000000001'
     AND buyer_id = 'bb550000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: two buyers were selected on one deal';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: one selected buyer per deal';
END $$;

\echo '-- The whole ladder is available, including the two that hurt.'
DO $$
BEGIN
  UPDATE buyer_deal_interest SET status = 'maybe_later'
   WHERE deal_id = 'dd550000-0000-4000-8000-000000000001'
     AND buyer_id = 'bb550000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: an invented interest status was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: the interest ladder is closed';
END $$;

UPDATE buyer_deal_interest SET status = 'reneged', responded_at = now()
 WHERE deal_id = 'dd550000-0000-4000-8000-000000000001'
   AND buyer_id = 'bb550000-0000-4000-8000-000000000002';
SELECT status, count(*) FROM buyer_deal_interest
WHERE deal_id = 'dd550000-0000-4000-8000-000000000001'
GROUP BY status ORDER BY status;

\echo '=== 10. deal_documents: a path, not a URL, and one row per file ==='
\echo '-- The bucket is private and the link is signed at read time. Storing a'
\echo '-- URL here would be storing a credential that outlives its reader.'
INSERT INTO deal_documents (team_id, deal_id, kind, storage_path, file_name, mime_type)
VALUES ('70551e00-0000-4000-8000-000000000001',
        'dd550000-0000-4000-8000-000000000001', 'purchase_agreement',
        'deals/dd550000-0000-4000-8000-000000000001/purchase-agreement.pdf',
        'purchase-agreement.pdf', 'application/pdf');

SELECT kind, bucket, file_name FROM deal_documents
WHERE deal_id = 'dd550000-0000-4000-8000-000000000001';

\echo '-- The same file uploaded twice by two people is one document.'
DO $$
BEGIN
  INSERT INTO deal_documents (team_id, deal_id, kind, storage_path)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'dd550000-0000-4000-8000-000000000001', 'purchase_agreement',
          'deals/dd550000-0000-4000-8000-000000000001/purchase-agreement.pdf');
  RAISE EXCEPTION 'FAIL: the same storage path was attached twice';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: one row per file per deal';
END $$;

DO $$
BEGIN
  INSERT INTO deal_documents (team_id, deal_id, kind, storage_path)
  VALUES ('70551e00-0000-4000-8000-000000000001',
          'dd550000-0000-4000-8000-000000000001', 'napkin_sketch', 'x/y.pdf');
  RAISE EXCEPTION 'FAIL: an invented document kind was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: the document vocabulary is closed';
END $$;

\echo '=== 11. RLS: another team sees none of it ==='
\echo '-- Six new tables, six chances to leak the buyers list, which IS the'
\echo '-- business, and a contract price, which belongs to somebody else.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT
  (SELECT count(*) FROM deals)               AS deals_visible,
  (SELECT count(*) FROM buyers)              AS buyers_visible,
  (SELECT count(*) FROM buyer_deal_interest) AS interest_visible,
  (SELECT count(*) FROM deal_events)         AS events_visible,
  (SELECT count(*) FROM deal_documents)      AS documents_visible,
  (SELECT count(*) FROM deal_milestones)     AS milestones_visible;
COMMIT;

\echo '-- The matcher is SECURITY INVOKER, so it inherits that answer rather'
\echo '-- than handing another team a ranked list of Tossie''s buyers.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT count(*) AS matches_for_a_rival
FROM match_buyers_for_deal('dd550000-0000-4000-8000-000000000001');
COMMIT;

\echo '-- ...and cannot write into another team either.'
DO $$
BEGIN
  SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO buyers (team_id, name, phone)
    VALUES ('70551e00-0000-4000-8000-000000000001', 'Planted Buyer', '(912) 555-0698');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: outsider inserted a buyer into another team';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS: WITH CHECK rejected the cross-team insert';
  END;
END $$;

\echo '=== 12. every new table has RLS on ==='
SELECT c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('deals','buyers','buyer_deal_interest','deal_events',
                    'deal_documents','deal_milestones')
ORDER BY c.relname;

\echo '=== 13. the public anon key holds nothing here ==='
\echo '-- This key is in the browser bundle. The buyers list is the asset;'
\echo '-- expect false on every column and zero policies naming anon.'
SELECT
  has_table_privilege('anon', 'public.buyers',              'SELECT') AS anon_buyers_select,
  has_table_privilege('anon', 'public.buyers',              'INSERT') AS anon_buyers_insert,
  has_table_privilege('anon', 'public.deals',               'SELECT') AS anon_deals_select,
  has_table_privilege('anon', 'public.deals',               'UPDATE') AS anon_deals_update,
  has_table_privilege('anon', 'public.buyer_deal_interest', 'SELECT') AS anon_interest_select,
  has_table_privilege('anon', 'public.deal_events',         'SELECT') AS anon_events_select,
  has_table_privilege('anon', 'public.deal_events',         'DELETE') AS anon_events_delete,
  has_table_privilege('anon', 'public.deal_documents',      'SELECT') AS anon_documents_select,
  has_table_privilege('anon', 'public.deal_milestones',     'SELECT') AS anon_milestones_select;

SELECT
  has_function_privilege('anon', 'public.match_buyers_for_deal(uuid)',        'EXECUTE') AS anon_can_match,
  has_function_privilege('anon', 'public.buyer_is_textable(public.buyers)',   'EXECUTE') AS anon_can_check_textable,
  has_function_privilege('anon', 'public.record_buyer_consent(uuid,text,text)','EXECUTE') AS anon_can_grant_consent,
  has_function_privilege('anon', 'public.deal_status_can_transition(text,text)','EXECUTE') AS anon_can_read_map,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('deals','buyers','buyer_deal_interest','deal_events',
                        'deal_documents','deal_milestones')
      AND 'anon' = ANY(roles)) AS policies_naming_anon;

\echo '-- The dispo blast runs on the service role and calls the matcher, which'
\echo '-- is SECURITY INVOKER: without these it fails at send time.'
SELECT
  has_function_privilege('service_role', 'public.match_buyers_for_deal(uuid)',      'EXECUTE') AS worker_can_match,
  has_function_privilege('service_role', 'public.buyer_is_textable(public.buyers)', 'EXECUTE') AS worker_can_check_textable,
  has_function_privilege('service_role', 'public.is_opted_out(uuid, text)',         'EXECUTE') AS worker_can_check_opt_out;

\echo '=== 14. the volatility claims in the migration, asserted ==='
\echo '-- s = stable. buyer_is_textable reads telephony_opt_outs, so IMMUTABLE'
\echo '-- would let a cached plan outlive a STOP message. Same trap as'
\echo '-- lead_is_dialable, and the same reason it cannot be indexed.'
SELECT p.proname, p.provolatile, p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('buyer_is_textable', 'match_buyers_for_deal',
                    'deal_status_can_transition', 'text_array_contains_ci',
                    'deal_milestone_next_reminder')
ORDER BY p.proname;

SELECT count(*) AS indexes_referencing_buyer_is_textable
FROM pg_indexes
WHERE schemaname = 'public' AND indexdef LIKE '%buyer_is_textable%';

\echo '=== 15. the deal board is published to realtime ==='
\echo '-- A buyer tapping "interested" that needs a page refresh to appear is a'
\echo '-- buyer called back an hour after the second one said yes.'
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('deals', 'buyer_deal_interest')
ORDER BY tablename;
