\set ON_ERROR_STOP on
\pset pager off

-- Supabase grants these by default; a plain Postgres does not.
--
-- SAME CAVEAT AS phase2_telephony and phase4_sdr: this blanket grant hands
-- `authenticated` privileges 20260821130000 deliberately withheld — INSERT,
-- UPDATE and DELETE on lead_intake_log. Nothing below asserts those, because
-- the assertion would pass alone and fail after any earlier suite ran the same
-- line against the same database. Function privileges ARE assertable (no suite
-- grants ROUTINES), and §9 checks the two that matter.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO allowed_signups (email) VALUES ('tossie@tossiebuyshouses.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'tossie@tossiebuyshouses.com',
        '{"full_name":"Tossie Griner"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Two sources, because the interesting difference between them is one boolean.
-- `portal-untrusted` is what almost every purchased source actually is.
INSERT INTO lead_sources (id, team_id, name, slug, default_consent, rate_limit_per_min)
VALUES
  ('e0000000-0000-4000-8000-000000000001', '70551e00-0000-4000-8000-000000000001',
   'Untrusted Portal', 'portal-untrusted', false, 60),
  ('e0000000-0000-4000-8000-000000000002', '70551e00-0000-4000-8000-000000000001',
   'Consenting PPC Vendor', 'ppc-consenting', true, 60),
  ('e0000000-0000-4000-8000-000000000003', '70551e00-0000-4000-8000-000000000001',
   'Throttled Vendor', 'vendor-throttled', false, 2)
ON CONFLICT (id) DO NOTHING;

\echo '=== 1. default_consent ships FALSE ==='
\echo '-- A source is assumed NOT to have collected consent until somebody can'
\echo '-- say how it does. Getting this default backwards is the expensive bug.'
SELECT slug, default_consent, active, format, received_count
FROM lead_sources WHERE slug IN ('portal-untrusted', 'ppc-consenting') ORDER BY slug;

\echo '=== 2. a source with no secret authorizes nobody ==='
\echo '-- Half-configured must mean closed, not open. This is the window between'
\echo '-- creating a source and finishing the setup.'
SELECT allowed, reason FROM authorize_lead_intake('portal-untrusted', 'anything-at-all');

\echo '=== 3. the secret is stored as a hash, never as itself ==='
SELECT set_lead_source_secret('portal-untrusted', 'sekrit-portal-000000000000000000') IS NOT NULL AS secret_set \gset
SELECT set_lead_source_secret('ppc-consenting',   'sekrit-ppc-0000000000000000000000') IS NOT NULL AS ppc_set \gset
SELECT set_lead_source_secret('vendor-throttled', 'sekrit-throttle-00000000000000000') IS NOT NULL AS thr_set \gset

SELECT secret_hash <> 'sekrit-portal-000000000000000000' AS not_stored_in_the_clear,
       secret_hash LIKE '$2%'                            AS is_bcrypt,
       secret_hash NOT LIKE '%sekrit%'                    AS no_plaintext_anywhere,
       secret_set_at IS NOT NULL                          AS rotation_is_dated
FROM lead_sources WHERE slug = 'portal-untrusted';

\echo '-- ...and a secret too short to be one is refused outright.'
DO $$
BEGIN
  PERFORM set_lead_source_secret('portal-untrusted', 'hunter2');
  RAISE EXCEPTION 'FAIL: a 7-character secret was accepted for a public endpoint';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'PASS: short secrets are refused';
END $$;

\echo '=== 4. wrong secret, right secret, unknown slug ==='
SELECT allowed, reason FROM authorize_lead_intake('portal-untrusted', 'not-the-secret');
SELECT allowed, reason FROM authorize_lead_intake('portal-untrusted', 'sekrit-portal-000000000000000000');
SELECT allowed, reason FROM authorize_lead_intake('no-such-vendor',  'sekrit-portal-000000000000000000');

\echo '-- Every one of those is on the log, which is the only place a run of'
\echo '-- failed auths against a live slug would ever be visible.'
SELECT slug, outcome, count(*) FROM lead_intake_log
WHERE slug IN ('portal-untrusted', 'no-such-vendor') AND outcome LIKE 'rejected%'
GROUP BY slug, outcome ORDER BY slug, outcome;

\echo '=== 5. an inactive source is refused, and only AFTER the secret check ==='
\echo '-- Answering "inactive" to a caller without the secret would turn this'
\echo '-- endpoint into a slug enumerator: guess names, keep the ones that do'
\echo '-- not say "unauthorized".'
UPDATE lead_sources SET active = false WHERE slug = 'portal-untrusted';
SELECT reason AS with_the_right_secret FROM authorize_lead_intake('portal-untrusted', 'sekrit-portal-000000000000000000');
SELECT reason AS with_the_wrong_secret FROM authorize_lead_intake('portal-untrusted', 'nope');
UPDATE lead_sources SET active = true WHERE slug = 'portal-untrusted';

\echo '=== 6. rate limit per source ==='
\echo '-- Limit of 2/min on this one. The third call is refused, and the refusal'
\echo '-- is logged once rather than once per attempt — a flood we are rejecting'
\echo '-- must not fill the table we are rejecting it into.'
SELECT allowed FROM authorize_lead_intake('vendor-throttled', 'wrong-1');
SELECT allowed FROM authorize_lead_intake('vendor-throttled', 'wrong-2');
SELECT allowed, reason FROM authorize_lead_intake('vendor-throttled', 'sekrit-throttle-00000000000000000');
SELECT allowed, reason FROM authorize_lead_intake('vendor-throttled', 'sekrit-throttle-00000000000000000');
SELECT count(*) AS rate_limited_rows_written FROM lead_intake_log
WHERE slug = 'vendor-throttled' AND outcome = 'rate_limited';

\echo '=== 7. an untrusted source CANNOT grant consent, however loudly it claims ==='
\echo '-- This is the assertion the whole migration exists for. The vendor sends'
\echo '-- consent:true with a full disclosure and a timestamp, and the lead still'
\echo '-- lands cold, because THIS SOURCE was never marked as collecting it.'
SELECT lead_id AS cold_lead_id, action, consent_granted
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000001',
  '{"name":"Cold Vendor Seller","phone":"(912) 555-7001","address":"7 Vendor Way","city":"Savannah","state":"GA"}'::jsonb,
  '{"name":"Cold Vendor Seller","phone":"(912) 555-7001","consent":true,"whatever_else":"kept"}'::jsonb,
  '{"claimed":true,"text":"By submitting you agree to be contacted","at":"2026-08-19T10:00:00Z","ip":"203.0.113.9"}'::jsonb,
  '198.51.100.7'::inet
) \gset

SELECT tcpa_opt_in, tcpa_opt_in_at IS NULL AS no_opt_in_timestamp,
       consent_sms, consent_email, temperature, source, source_detail
FROM leads WHERE id = :'cold_lead_id';

\echo '-- ...and being cold, it is not dialable until traced and scrubbed (§5).'
SELECT lead_is_dialable(l.*) AS dialable FROM leads l WHERE id = :'cold_lead_id';

\echo '-- The refusal is on the record, on the timeline and on the intake log,'
\echo '-- because "this vendor keeps claiming consent it does not have" is a'
\echo '-- thing somebody needs to be able to notice.'
SELECT type, summary FROM lead_activity
WHERE lead_id = :'cold_lead_id' AND type = 'lead_intake';
SELECT outcome, consent_granted, message FROM lead_intake_log
WHERE lead_id = :'cold_lead_id';

\echo '=== 8. a trusted source WITH evidence does grant consent ==='
SELECT lead_id AS warm_lead_id, action, consent_granted
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000002',
  '{"name":"Consented Seller","phone":"912-555-7002","email":"seller@example.com","address":"8 Optin Rd","city":"Savannah","state":"GA"}'::jsonb,
  '{"name":"Consented Seller","phone":"912-555-7002"}'::jsonb,
  '{"claimed":true,"text":"I agree to receive calls and texts about my property","at":"2026-08-18T14:30:00Z","ip":"203.0.113.44","version":"vendor-v3"}'::jsonb,
  '198.51.100.7'::inet
) \gset

\echo '-- tcpa_opt_in_at is NOT NULL, which is what leads_opt_in_needs_provenance'
\echo '-- (20260821120000) requires. Without it this insert would have failed.'
SELECT tcpa_opt_in, tcpa_opt_in_at IS NOT NULL AS has_timestamp,
       tcpa_disclosure_text IS NOT NULL AS has_disclosure,
       tcpa_disclosure_source, tcpa_disclosure_version, tcpa_disclosure_ip,
       temperature
FROM leads WHERE id = :'warm_lead_id';

\echo '=== 9. a trusted source WITHOUT evidence does not ==='
\echo '-- consent:true and nothing to back it. A boolean in a vendor payload is'
\echo '-- not evidence, and this is the branch that says so.'
SELECT lead_id AS bare_claim_id, consent_granted
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000002',
  '{"name":"Bare Claim","phone":"912-555-7003"}'::jsonb,
  '{"name":"Bare Claim","phone":"912-555-7003","tcpa_consent":"yes"}'::jsonb,
  '{"claimed":true}'::jsonb, NULL
) \gset
SELECT tcpa_opt_in, temperature FROM leads WHERE id = :'bare_claim_id';
SELECT message FROM lead_intake_log WHERE lead_id = :'bare_claim_id';

\echo '-- A timestamp dated next month is a fabricated field, not evidence.'
SELECT consent_granted AS future_dated_consent_granted
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000002',
  '{"name":"Time Traveller","phone":"912-555-7004"}'::jsonb,
  '{}'::jsonb,
  ('{"claimed":true,"text":"agreed","at":"' || (now() + interval '30 days')::text || '"}')::jsonb,
  NULL
);

\echo '-- ...and an unparseable one is missing evidence, not a reason to drop a'
\echo '-- lead. It lands cold, which is the safe side of the decision.'
SELECT consent_granted AS garbage_timestamp_consent_granted
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000002',
  '{"name":"Bad Clock","phone":"912-555-7005"}'::jsonb,
  '{}'::jsonb,
  '{"claimed":"yes please","text":"agreed","at":"last tuesday"}'::jsonb,
  NULL
);

\echo '=== 10. a re-post updates rather than duplicating ==='
\echo '-- Vendors retry. The same lead arriving twice must be one row, keyed on'
\echo '-- phone_key so "(912) 555-7001" and "+19125557001" are the same seller.'
SELECT lead_id AS repost_id, action AS repost_action
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000001',
  '{"name":"Cold Vendor Seller","phone":"+19125557001","email":"filled-in-later@example.com","zip":"31401"}'::jsonb,
  '{"phone":"+19125557001","email":"filled-in-later@example.com","new_field":"vendor changed format"}'::jsonb,
  '{}'::jsonb, NULL
) \gset
SELECT :'repost_id' = :'cold_lead_id' AS same_lead, :'repost_action' AS action;
SELECT count(*) AS rows_for_that_number FROM leads
WHERE team_id = '70551e00-0000-4000-8000-000000000001' AND phone_key(phone) = '9125557001';

\echo '-- Gaps get filled; nothing already there is overwritten.'
SELECT name, phone, email, zip FROM leads WHERE id = :'cold_lead_id';

\echo '-- Both payloads are kept in full. When a vendor changes format without'
\echo '-- telling anyone, this is the only place the answer survives.'
SELECT jsonb_array_length(raw_payload -> 'lead_intake') AS receipts_kept,
       raw_payload -> 'lead_intake' -> 1 -> 'payload' ->> 'new_field' AS second_payload_survived
FROM leads WHERE id = :'cold_lead_id';

\echo '=== 11. a re-post can never withdraw or restate a recorded consent ==='
\echo '-- The operator recorded consent by hand on this lead. A vendor re-post'
\echo '-- must not be able to undo it, and must not get to replace the'
\echo '-- provenance with its own version of the story either.'
BEGIN;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT tcpa_disclosure_source AS operator_recorded
FROM record_lead_consent(:'cold_lead_id', 'verbal, seller called us back');
COMMIT;

SELECT consent_granted AS vendor_claim_honoured
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000001',
  '{"phone":"+19125557001"}'::jsonb, '{}'::jsonb,
  '{"claimed":true,"text":"vendor language","at":"2026-08-19T10:00:00Z"}'::jsonb, NULL
);
SELECT tcpa_opt_in, tcpa_disclosure_source FROM leads WHERE id = :'cold_lead_id';

\echo '=== 12. no phone and no email is refused, not crashed ==='
\echo '-- leads_has_contact would reject this anyway. Catching it here means the'
\echo '-- vendor is told which field is missing instead of a constraint name,'
\echo '-- and the attempt still lands on the log.'
SELECT lead_id IS NULL AS nothing_written, action, message
FROM ingest_lead_from_source(
  'e0000000-0000-4000-8000-000000000001',
  '{"address":"9 Nowhere St","city":"Savannah"}'::jsonb,
  '{"address":"9 Nowhere St"}'::jsonb, '{}'::jsonb, NULL
);
SELECT outcome, message FROM lead_intake_log
WHERE slug = 'portal-untrusted' AND outcome = 'rejected_payload';

\echo '=== 13. the counters move ==='
SELECT slug, received_count, last_received_at IS NOT NULL AS has_a_last_receipt
FROM lead_sources WHERE slug IN ('portal-untrusted', 'ppc-consenting') ORDER BY slug;

\echo '=== 14. RLS: another team sees neither the sources nor the log ==='
INSERT INTO teams (id, name) VALUES ('99999999-0000-4000-8000-000000000003', 'Rival Intake')
ON CONFLICT (id) DO NOTHING;
INSERT INTO allowed_signups (email) VALUES ('rival-intake@example.com') ON CONFLICT (email) DO NOTHING;
INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-0000-4000-8000-000000000003', 'rival-intake@example.com')
ON CONFLICT (id) DO NOTHING;
UPDATE profiles SET team_id = '99999999-0000-4000-8000-000000000003'
 WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003';

BEGIN;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000003';
SET LOCAL ROLE authenticated;
SELECT count(*) AS sources_visible_to_rival FROM lead_sources;
SELECT count(*) AS receipts_visible_to_rival FROM lead_intake_log;
COMMIT;

\echo '=== 15. the intake RPCs are not reachable from a browser ==='
\echo '-- authorize_lead_intake answers "is this the right secret for that slug",'
\echo '-- which is an oracle. ingest_lead_from_source writes leads with consent'
\echo '-- fields set. Both belong to the edge function on the service role and'
\echo '-- to nothing else. set_lead_source_secret IS for the operator — it runs'
\echo '-- SECURITY INVOKER, so RLS is what scopes it to their own team.'
SELECT has_function_privilege('authenticated', 'public.authorize_lead_intake(text,text,inet)', 'EXECUTE') AS authed_can_authorize,
       has_function_privilege('anon',          'public.authorize_lead_intake(text,text,inet)', 'EXECUTE') AS anon_can_authorize,
       has_function_privilege('service_role',  'public.authorize_lead_intake(text,text,inet)', 'EXECUTE') AS worker_can_authorize;

SELECT has_function_privilege('authenticated', 'public.ingest_lead_from_source(uuid,jsonb,jsonb,jsonb,inet)', 'EXECUTE') AS authed_can_ingest,
       has_function_privilege('anon',          'public.ingest_lead_from_source(uuid,jsonb,jsonb,jsonb,inet)', 'EXECUTE') AS anon_can_ingest,
       has_function_privilege('service_role',  'public.ingest_lead_from_source(uuid,jsonb,jsonb,jsonb,inet)', 'EXECUTE') AS worker_can_ingest;

SELECT has_function_privilege('authenticated', 'public.set_lead_source_secret(text,text)', 'EXECUTE') AS operator_can_set_secret,
       has_function_privilege('anon',          'public.set_lead_source_secret(text,text)', 'EXECUTE') AS anon_can_set_secret;

\echo '=== 16. anon keeps nothing ==='
SELECT has_table_privilege('anon', 'public.lead_sources',    'SELECT') AS anon_reads_sources,
       has_table_privilege('anon', 'public.lead_sources',    'INSERT') AS anon_writes_sources,
       has_table_privilege('anon', 'public.lead_intake_log', 'SELECT') AS anon_reads_log;

\echo '=== 17. slugs are URL-shaped, because they go in a URL ==='
DO $$
BEGIN
  INSERT INTO lead_sources (team_id, name, slug)
  VALUES ('70551e00-0000-4000-8000-000000000001', 'Bad Slug', 'Not A Slug/../etc');
  RAISE EXCEPTION 'FAIL: a slug with spaces and path traversal was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: slugs are constrained to lowercase URL-safe characters';
END $$;

\echo '-- Globally unique, not per team: it is the lookup key on an'
\echo '-- unauthenticated request, so a collision makes "whose lead is this" a'
\echo '-- coin toss.'
DO $$
BEGIN
  INSERT INTO lead_sources (team_id, name, slug)
  VALUES ('99999999-0000-4000-8000-000000000003', 'Rival Portal', 'portal-untrusted');
  RAISE EXCEPTION 'FAIL: two teams were allowed to claim one slug';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: slugs are globally unique';
END $$;
