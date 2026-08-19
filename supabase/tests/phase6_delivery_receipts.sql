\set ON_ERROR_STOP on
\pset pager off

-- ============================================================================
-- Delivery receipts — the MessageStatus branch of twilio-webhook
-- ============================================================================
-- Every outbound text used to sit at 'queued' forever: twilio-send-sms wrote
-- the row and got a SID back, and no endpoint in this project handled Twilio's
-- MessageStatus callbacks, so nothing ever moved it. The operator could not
-- tell a delivered text from one a carrier silently dropped, which for a
-- wholesaler is the difference between following up on a seller and writing
-- them off.
--
-- WHAT THIS SUITE IS, AND WHAT IT IS NOT. The branch itself is TypeScript, and
-- this repo has no harness that runs an edge function — db-test.sh applies the
-- migrations to a scratch Postgres and runs SQL. So this suite does what
-- phase2_telephony §4 does for the idempotency claim: it issues THE SAME
-- statements the function issues and asserts the database answers them the way
-- the function assumes.
--
-- That is worth more than it sounds, because the function was deliberately
-- written so that its guard IS a WHERE clause rather than an if-statement:
--
--   terminal receipt      UPDATE … WHERE twilio_sid = $1 AND direction='outbound'
--   'sent' (rank 1)       …the same, AND status IN ('queued','sent')
--   'queued' (rank 0)     …the same, AND status IN ('queued')
--
-- One atomic UPDATE, no read-then-decide, so the predicate below is the whole
-- rule and not a paraphrase of it. Two receipts arriving at once would both
-- pass a read-then-write check and the loser would be the one that stuck; here
-- the second one is refused by the row itself.
--
-- What this CANNOT prove, said plainly rather than implied: that the function
-- picks the right branch in the first place. The discriminator (MessageStatus
-- present and not 'received', and no Body key at all) is TypeScript reading a
-- form body, and nothing here exercises it. §5 asserts the consequence that
-- matters most — that a receipt cannot touch an inbound row even if it somehow
-- reached the update — but the branch choice itself is checked by reading the
-- code and by the unsigned-probe/deploy checks, not by this file.
-- ============================================================================

-- Supabase grants these by default; a plain Postgres does not. Same caveat as
-- every other suite: this hands `authenticated` the DELETE on sms_messages the
-- migration withholds, so nothing below asserts that grant.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO allowed_signups (email) VALUES ('tossie@tossiebuyshouses.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'tossie@tossiebuyshouses.com',
        '{"full_name":"Tossie Griner"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO leads (id, team_id, name, phone, address, city, state, source, tcpa_opt_in, tcpa_opt_in_at)
VALUES ('eeeeeeee-0000-4000-8000-000000000001',
        '70551e00-0000-4000-8000-000000000001', 'Receipt Test Seller', '9125553100',
        '31 Receipt Row', 'Savannah', 'GA', 'website', true, now())
ON CONFLICT (id) DO NOTHING;

-- Three outbound messages, exactly as twilio-send-sms leaves them: the row is
-- written before Twilio is called, then the claim token is replaced by the real
-- SID and the status by whatever Twilio said at accept time. 'queued' is where
-- every one of them has been stranded until now.
INSERT INTO sms_messages (team_id, lead_id, direction, from_e164, to_e164, body, status, twilio_sid, sent_at)
VALUES
  ('70551e00-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001',
   'outbound', '+19125550100', '+19125553100', 'Are you still looking to sell?',
   'queued', 'SMreceipt00000000000000000000001', now()),
  ('70551e00-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001',
   'outbound', '+19125550100', '+19125553100', 'Following up on the house.',
   'queued', 'SMreceipt00000000000000000000002', now()),
  ('70551e00-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001',
   'outbound', '+19125550100', '+19125553100', 'Last note from us.',
   'sent', 'SMreceipt00000000000000000000003', now());

-- And one thing the seller actually said. It exists so §5 can prove a receipt
-- cannot rewrite it.
INSERT INTO sms_messages (team_id, lead_id, direction, from_e164, to_e164, body, status, twilio_sid)
VALUES ('70551e00-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001',
        'inbound', '+19125553100', '+19125550100', 'Maybe. What are you offering?',
        'received', 'SMreceipt00000000000000000000009');


\echo '=== 1. a delivered receipt sets the status AND delivered_at ==='
\echo '-- delivered is rank 2, so the UPDATE carries no status filter: nothing'
\echo '-- outranks a terminal receipt. delivered_at rides only on this one'
\echo '-- transition, because it is a fact about that transition and not a'
\echo '-- general "we touched the row" timestamp.'
DO $$
DECLARE n integer;
BEGIN
  UPDATE sms_messages
     SET status = 'delivered', delivered_at = now()
   WHERE twilio_sid = 'SMreceipt00000000000000000000001'
     AND direction = 'outbound';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a delivered receipt matched % rows, expected 1', n;
  END IF;
END $$;

SELECT status,
       delivered_at IS NOT NULL AS delivered_at_set
FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000001';

DO $$
DECLARE r record;
BEGIN
  SELECT status, delivered_at INTO r
    FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000001';
  IF r.status <> 'delivered' THEN
    RAISE EXCEPTION 'FAIL: status is % after a delivered receipt', r.status;
  END IF;
  IF r.delivered_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: delivered_at was not stamped, so nothing on the row says when it landed';
  END IF;
  RAISE NOTICE 'PASS: delivered receipt recorded, with the moment it arrived';
END $$;


\echo '=== 2. a late "sent" does NOT walk back a "delivered" ==='
\echo '-- Twilio fires a callback per transition and retries any it does not get'
\echo '-- a 2xx for, so receipts arrive late, twice and out of order as a matter'
\echo '-- of course. Without the rank filter the last one to land wins, and a'
\echo '-- message the seller demonstrably received reads as still in flight.'
DO $$
DECLARE n integer; before timestamptz; after timestamptz; s text;
BEGIN
  SELECT delivered_at INTO before
    FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000001';

  -- Exactly the statement the function issues for a rank-1 receipt.
  UPDATE sms_messages
     SET status = 'sent'
   WHERE twilio_sid = 'SMreceipt00000000000000000000001'
     AND direction = 'outbound'
     AND status IN ('queued', 'sent');
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: an out-of-order "sent" updated % rows over a delivered message', n;
  END IF;

  SELECT status, delivered_at INTO s, after
    FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000001';
  IF s <> 'delivered' THEN
    RAISE EXCEPTION 'FAIL: status regressed to % after a late "sent"', s;
  END IF;
  IF after IS DISTINCT FROM before THEN
    RAISE EXCEPTION 'FAIL: delivered_at was rewritten by a receipt that changed nothing else';
  END IF;
  RAISE NOTICE 'PASS: a late "sent" is refused by the row; delivered stays delivered';
END $$;

\echo '-- The lower rung of the same rule: "sending" maps to queued (the CHECK'
\echo '-- constraint has no "sending"), and queued must not overwrite sent'
\echo '-- either — a message already gone would read as still waiting.'
DO $$
DECLARE n integer; s text;
BEGIN
  UPDATE sms_messages
     SET status = 'queued'
   WHERE twilio_sid = 'SMreceipt00000000000000000000003'
     AND direction = 'outbound'
     AND status IN ('queued');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a late "sending" reopened % already-sent messages', n;
  END IF;

  SELECT status INTO s FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000003';
  IF s <> 'sent' THEN
    RAISE EXCEPTION 'FAIL: status is % after a late "sending"', s;
  END IF;
  RAISE NOTICE 'PASS: a late "sending" cannot reopen a sent message';
END $$;

\echo '-- And the mapping is not optional: the raw Twilio word is not a status'
\echo '-- this schema accepts, which is why mapTwilioStatus exists in both the'
\echo '-- send path and the webhook.'
DO $$
BEGIN
  UPDATE sms_messages SET status = 'sending'
   WHERE twilio_sid = 'SMreceipt00000000000000000000003';
  RAISE EXCEPTION 'FAIL: "sending" was accepted as a status';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: an unmapped Twilio status is rejected, not stored';
END $$;


\echo '=== 3. a failure receipt keeps the Twilio code ==='
\echo '-- The code is the whole difference between "call them instead" (30003,'
\echo '-- 30005, 30006) and "every text from this number is being blocked"'
\echo '-- (30007, 30034). Undelivered without it is just a shrug.'
UPDATE sms_messages
   SET status = 'undelivered', error_code = '30007'
 WHERE twilio_sid = 'SMreceipt00000000000000000000002'
   AND direction = 'outbound';

SELECT status, error_code, delivered_at IS NULL AS no_delivered_at
FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000002';

DO $$
DECLARE r record; n integer;
BEGIN
  SELECT status, error_code, delivered_at INTO r
    FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000002';
  IF r.status <> 'undelivered' OR r.error_code <> '30007' THEN
    RAISE EXCEPTION 'FAIL: undelivered/30007 was not recorded (got %/%)', r.status, r.error_code;
  END IF;
  IF r.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: delivered_at was stamped on a message that was never delivered';
  END IF;

  -- undelivered is terminal too, so a subsequent 'sent' is refused the same way
  -- a delivered one is. A failed text that quietly turns back into a sent one is
  -- a follow-up that never happens.
  UPDATE sms_messages
     SET status = 'sent'
   WHERE twilio_sid = 'SMreceipt00000000000000000000002'
     AND direction = 'outbound'
     AND status IN ('queued', 'sent');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a late "sent" revived an undelivered message';
  END IF;
  RAISE NOTICE 'PASS: undelivered keeps its code and is terminal';
END $$;


\echo '=== 4. a receipt for a SID we have no row for is a no-op, not an error ==='
\echo '-- Twilio retries any non-2xx until it gives up, so erroring here buys an'
\echo '-- indefinite retry loop for a message that will never appear — one sent'
\echo '-- from the Twilio console, or one whose row predates this handler. The'
\echo '-- function logs it and answers 200; at the database it is zero rows.'
DO $$
DECLARE n integer; total_before integer; total_after integer;
BEGIN
  SELECT count(*) INTO total_before FROM sms_messages;

  UPDATE sms_messages
     SET status = 'delivered', delivered_at = now()
   WHERE twilio_sid = 'SMreceipt0000000000000000000ffff'
     AND direction = 'outbound';
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a receipt for an unknown SID touched % rows', n;
  END IF;

  SELECT count(*) INTO total_after FROM sms_messages;
  IF total_after <> total_before THEN
    RAISE EXCEPTION 'FAIL: an unknown SID created a row (% -> %)', total_before, total_after;
  END IF;
  RAISE NOTICE 'PASS: an unknown SID updates nothing and invents nothing';
END $$;


\echo '=== 5. a status callback never becomes an inbound message ==='
\echo '-- The expensive failure. A receipt carries our number as From and the'
\echo '-- seller as To, so a receipt filed as inbound is a message the seller'
\echo '-- never sent, on their thread, in the record of what was said to a'
\echo '-- homeowner. Two things stop it: the branch returns before From/To are'
\echo '-- ever resolved (TypeScript, not assertable here), and every receipt'
\echo '-- UPDATE carries direction = outbound — which is.'
DO $$
DECLARE n integer; s text; inbound_count integer;
BEGIN
  -- The seller's own message, reached by its own SID, with the delivered
  -- receipt's statement. The direction filter is the only thing between this
  -- and 'received' being overwritten — and a Messaging Service configured with
  -- an account-wide status callback is exactly how a receipt learns an inbound
  -- SID.
  UPDATE sms_messages
     SET status = 'delivered', delivered_at = now()
   WHERE twilio_sid = 'SMreceipt00000000000000000000009'
     AND direction = 'outbound';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a receipt updated % inbound rows', n;
  END IF;

  SELECT status INTO s FROM sms_messages WHERE twilio_sid = 'SMreceipt00000000000000000000009';
  IF s <> 'received' THEN
    RAISE EXCEPTION 'FAIL: the seller''s own message now reads %', s;
  END IF;

  -- One inbound row on this lead, and it is the one the fixture wrote. Four
  -- receipts have been applied above; not one of them added a message.
  SELECT count(*) INTO inbound_count
    FROM sms_messages
   WHERE lead_id = 'eeeeeeee-0000-4000-8000-000000000001' AND direction = 'inbound';
  IF inbound_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: % inbound rows on the lead, expected the 1 the seller sent', inbound_count;
  END IF;
  RAISE NOTICE 'PASS: receipts changed no inbound row and created none';
END $$;

\echo '-- Belt to that: were a receipt ever mishandled as an inbound message, it'
\echo '-- would try to insert the outbound row''s own SID — and twilio_sid is'
\echo '-- UNIQUE, so the insert is rejected rather than doubling the thread. That'
\echo '-- is why the discriminator degrades safely: the worst case is that'
\echo '-- statuses stop updating, which is visible on every thread.'
DO $$
BEGIN
  INSERT INTO sms_messages (team_id, lead_id, direction, from_e164, to_e164, body, status, twilio_sid)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001',
          'inbound', '+19125550100', '+19125553100', '', 'received',
          'SMreceipt00000000000000000000001');
  RAISE EXCEPTION 'FAIL: a receipt could be stored as a second message under one SID';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: twilio_sid UNIQUE absorbs a misrouted receipt';
END $$;


\echo '=== 6. the thread an operator reads, after all of the above ==='
\echo '-- delivered / undelivered+30007 / sent / received. Not one of them still'
\echo '-- says queued, which is the entire point of the branch.'
SELECT direction, status, error_code, delivered_at IS NOT NULL AS landed
FROM sms_messages
WHERE lead_id = 'eeeeeeee-0000-4000-8000-000000000001'
ORDER BY twilio_sid;
