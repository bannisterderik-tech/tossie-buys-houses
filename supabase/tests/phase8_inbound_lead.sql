\set ON_ERROR_STOP on
\pset pager off

-- ============================================================================
-- An unmatched inbound text creates a lead (twilio-webhook step 4).
-- ============================================================================
-- The webhook's own logic is covered by the deno suites next to it —
-- supabase/functions/twilio-webhook/{keywords,inbound-lead}_test.ts — which
-- assert the keyword guard and the exact shape of the consent record without a
-- database. What THIS suite pins is the half those cannot reach: whether the
-- database accepts that row, what it does with it afterwards, and which vetoes
-- still apply to a lead that arrived this way.
--
-- The rows below are written the way the service role writes them, because that
-- is what the webhook is. RLS is not the subject here; the consent basis is.
--
-- Every claim is a DO block that raises on failure, not a SELECT to be
-- eyeballed — db-test.sh compares nothing, so a printed row only fails a suite
-- if somebody happens to read it.
-- ============================================================================

-- Same caveat as every other suite: Supabase grants these by default, a plain
-- Postgres does not, so nothing below asserts an `authenticated` table
-- privilege — it would pass alone and fail after any earlier suite ran the
-- same line against the same database.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- Reserved 555 fictional block on Savannah's 912, as everywhere else here.
--   +19125557301  a stranger who texted in
--   +19125557302  a stranger who had told us STOP long before texting in
--   +19125557399  one of ours

\echo '=== 1. the row the webhook writes is accepted, and it is dialable ==='
\echo '-- Field for field what buildInboundLead() produces. If a future migration'
\echo '-- tightens a constraint this row no longer satisfies, the webhook starts'
\echo '-- dropping sellers into the unattached pile and only a log line nobody'
\echo '-- reads says so. This is that alarm.'
INSERT INTO leads (
  id, team_id, phone,
  source, source_detail, status,
  first_contact_at, next_follow_up_at,
  tcpa_opt_in, tcpa_opt_in_at,
  tcpa_disclosure_source, tcpa_disclosure_version, tcpa_disclosure_text,
  consent_sms,
  raw_payload
) VALUES (
  'f8000000-0000-4000-8000-000000000101',
  '70551e00-0000-4000-8000-000000000001',
  '+19125557301',
  'inbound_sms', 'Texted +19125557399', 'new',
  now(), now(),
  true, now(),
  'Inbound text from +19125557301 to +19125557399 on 2026-08-19T15:04:05.000Z (Twilio SM00000000000000000000000000000001)',
  'v1-2026-08',
  'Seller initiated contact by text message. No disclosure was presented — there was no prior contact to present one in. The consent basis is their own inbound message, received 2026-08-19T15:04:05.000Z: "Saw your sign on Bull St, what would you pay"',
  true,
  jsonb_build_object('inbound_sms', jsonb_build_object(
    'twilio_sid',  'SM00000000000000000000000000000001',
    'from',        '+19125557301',
    'to',          '+19125557399',
    'received_at', '2026-08-19T15:04:05.000Z',
    'body',        'Saw your sign on Bull St, what would you pay',
    'num_media',   0,
    'media_urls',  '[]'::jsonb
  ))
);

SELECT source, source_detail, status, consent_sms, consent_email,
       skip_traced, dnc_scrubbed, is_dnc, is_litigator,
       lead_is_dialable(l.*) AS dialable
FROM leads l WHERE id = 'f8000000-0000-4000-8000-000000000101';

DO $$
DECLARE v public.leads;
BEGIN
  SELECT * INTO v FROM public.leads WHERE id = 'f8000000-0000-4000-8000-000000000101';

  -- Dialable on the INBOUND branch of lead_is_dialable: consent was obtained
  -- and its provenance recorded. No skip trace, no DNC scrub — those are the
  -- outbound branch, for people who never agreed to anything.
  IF NOT public.lead_is_dialable(v) THEN
    RAISE EXCEPTION 'FAIL: a seller who texted us first is not dialable';
  END IF;
  RAISE NOTICE 'PASS: consent obtained by inbound text is a dialable basis';

  -- ...and the lead is otherwise honestly cold. Nothing about the consent may
  -- imply a scrub that never ran; that is the outbound rail and it is not ours
  -- to satisfy.
  IF v.skip_traced OR v.dnc_scrubbed OR v.is_dnc OR v.is_litigator THEN
    RAISE EXCEPTION 'FAIL: an inbound lead claims compliance work that never happened';
  END IF;
  RAISE NOTICE 'PASS: no scrub is asserted on the strength of a text message';

  -- They texted. They said nothing about email, and we do not have an address
  -- for them. Carrying one channel's consent into another is the small
  -- over-claim that makes the whole record look invented.
  IF NOT v.consent_sms OR v.consent_email THEN
    RAISE EXCEPTION 'FAIL: consent channels are wrong (sms=%, email=%)', v.consent_sms, v.consent_email;
  END IF;
  RAISE NOTICE 'PASS: SMS consent did not become email consent';
END $$;

\echo '=== 2. the opt-in cannot be asserted without saying when ==='
\echo '-- leads_opt_in_needs_provenance (20260821120000). The builder always sets'
\echo '-- tcpa_opt_in_at; this is what happens if it ever stops, and the point is'
\echo '-- that it fails at the insert rather than storing a bare boolean that is'
\echo '-- worth nothing to anyone who asks the question later.'
DO $$
BEGIN
  INSERT INTO public.leads (team_id, phone, source, tcpa_opt_in)
  VALUES ('70551e00-0000-4000-8000-000000000001', '+19125557303', 'inbound_sms', true);
  RAISE EXCEPTION 'FAIL: opt-in was asserted with no timestamp';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: tcpa_opt_in without tcpa_opt_in_at is refused';
END $$;

\echo '=== 3. the message is attached to the lead it created ==='
\echo '-- The whole complaint this change answers was a seller message sitting'
\echo '-- with lead_id NULL where nobody would ever work it.'
INSERT INTO sms_messages (
  team_id, lead_id, direction, from_e164, to_e164, body, status, twilio_sid, num_segments
) VALUES (
  '70551e00-0000-4000-8000-000000000001',
  'f8000000-0000-4000-8000-000000000101',
  'inbound', '+19125557301', '+19125557399',
  'Saw your sign on Bull St, what would you pay', 'received',
  'SM00000000000000000000000000000001', 1
);

DO $$
DECLARE v_unattached int; v_attached int;
BEGIN
  SELECT count(*) INTO v_unattached FROM public.sms_messages
   WHERE from_e164 = '+19125557301' AND direction = 'inbound' AND lead_id IS NULL;
  IF v_unattached <> 0 THEN
    RAISE EXCEPTION 'FAIL: % inbound message(s) from this seller are still unattached', v_unattached;
  END IF;

  -- ai-sdr refuses to open a conversation without one of these on record
  -- (continue_conversation -> no_inbound_on_record), so this is also the thing
  -- that lets the SDR answer somebody who texted in cold.
  SELECT count(*) INTO v_attached FROM public.sms_messages
   WHERE lead_id = 'f8000000-0000-4000-8000-000000000101' AND direction = 'inbound';
  IF v_attached <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected 1 inbound message on the lead, found %', v_attached;
  END IF;
  RAISE NOTICE 'PASS: the message that created the lead is filed against it';
END $$;

\echo '=== 4. somebody actually works it ==='
\echo '-- due_leads is keyed on next_follow_up_at, so a lead created without one'
\echo '-- exists and is worked by nobody — which was the bug, not the fix. A'
\echo '-- stranger holding their phone right now is the most time-sensitive thing'
\echo '-- this endpoint receives.'
DO $$
DECLARE v_due int; v_status text;
BEGIN
  SELECT count(*) INTO v_due FROM public.due_leads
   WHERE id = 'f8000000-0000-4000-8000-000000000101' AND dialable;
  IF v_due <> 1 THEN
    RAISE EXCEPTION 'FAIL: the inbound lead is not on the Today page';
  END IF;
  RAISE NOTICE 'PASS: it comes due immediately and reads as callable';

  -- 'new', not 'contacted'. convert_prospect_to_lead uses contacted because a
  -- human had just finished a conversation; here there has been no
  -- conversation at all, and contacted would hide the lead in the worked pile.
  SELECT status INTO v_status FROM public.leads
   WHERE id = 'f8000000-0000-4000-8000-000000000101';
  IF v_status <> 'new' THEN
    RAISE EXCEPTION 'FAIL: expected status new, got %', v_status;
  END IF;
  RAISE NOTICE 'PASS: it lands in the untouched pile';
END $$;

\echo '=== 5. the timeline says where the lead and the consent came from ==='
\echo '-- Two rows, and they are only useful together: lead_created from the'
\echo '-- insert trigger names the source, and consent_recorded is the same type'
\echo '-- record_lead_consent() writes, so the panel reads the same whether'
\echo '-- consent arrived through an operator or through a seller phone.'
INSERT INTO lead_activity (team_id, lead_id, actor_kind, type, summary, payload)
VALUES (
  '70551e00-0000-4000-8000-000000000001',
  'f8000000-0000-4000-8000-000000000101',
  'system', 'consent_recorded',
  'Consent recorded: the seller texted us first',
  jsonb_build_object('source', 'inbound_sms',
                     'twilio_sid', 'SM00000000000000000000000000000001',
                     'from', '+19125557301', 'to', '+19125557399')
);

SELECT type, summary FROM lead_activity
WHERE lead_id = 'f8000000-0000-4000-8000-000000000101'
  AND type IN ('lead_created', 'consent_recorded')
ORDER BY type;

DO $$
DECLARE v_created int; v_consent int;
BEGIN
  SELECT count(*) INTO v_created FROM public.lead_activity
   WHERE lead_id = 'f8000000-0000-4000-8000-000000000101' AND type = 'lead_created'
     AND summary LIKE '%inbound_sms%';
  IF v_created <> 1 THEN
    RAISE EXCEPTION 'FAIL: the timeline does not say the lead came from an inbound text';
  END IF;

  SELECT count(*) INTO v_consent FROM public.lead_activity
   WHERE lead_id = 'f8000000-0000-4000-8000-000000000101' AND type = 'consent_recorded'
     AND payload ->> 'twilio_sid' IS NOT NULL;
  IF v_consent <> 1 THEN
    RAISE EXCEPTION 'FAIL: the consent event is missing or carries no message SID';
  END IF;
  RAISE NOTICE 'PASS: the timeline carries both facts, with the SID that proves the second';
END $$;

\echo '=== 6. a prior STOP still wins ==='
\echo '-- Someone who told us to stop, and months later texts the number anyway.'
\echo '-- The lead is created — they initiated contact and the record should'
\echo '-- exist — but the opt-out is a veto in one place, telephony_opt_outs, and'
\echo '-- it goes on refusing. Same discipline as a litigator prospect that'
\echo '-- converts: the record exists, the rail still says no.'
INSERT INTO telephony_opt_outs (team_id, phone_key, source, note)
VALUES ('70551e00-0000-4000-8000-000000000001', phone_key('+19125557302'),
        'sms_stop', 'Replied "STOP" to +19125557399')
ON CONFLICT (team_id, phone_key) DO NOTHING;

INSERT INTO leads (
  id, team_id, phone, source, source_detail, status,
  first_contact_at, next_follow_up_at,
  tcpa_opt_in, tcpa_opt_in_at,
  tcpa_disclosure_source, tcpa_disclosure_version, tcpa_disclosure_text, consent_sms
) VALUES (
  'f8000000-0000-4000-8000-000000000102',
  '70551e00-0000-4000-8000-000000000001',
  '+19125557302',
  'inbound_sms', 'Texted +19125557399', 'new',
  now(), now(),
  true, now(),
  'Inbound text from +19125557302 to +19125557399 on 2026-08-19T15:10:00.000Z',
  'v1-2026-08',
  'Seller initiated contact by text message. No disclosure was presented.',
  true
);

DO $$
DECLARE v public.leads;
BEGIN
  SELECT * INTO v FROM public.leads WHERE id = 'f8000000-0000-4000-8000-000000000102';
  IF v.id IS NULL THEN
    -- Refusing to create it would lose the evidence that they reached out,
    -- which is exactly what an operator needs in order to decide whether to
    -- ask them to text START.
    RAISE EXCEPTION 'FAIL: no record was kept of a suppressed person reaching out';
  END IF;
  IF public.lead_is_dialable(v) THEN
    RAISE EXCEPTION 'FAIL: a prior opt-out was overridden by a later inbound text';
  END IF;
  RAISE NOTICE 'PASS: the lead exists and the opt-out still vetoes it';
END $$;

\echo '=== 7. every consent door stamps the same disclosure version ==='
\echo '-- record_lead_consent(), convert_prospect_to_lead() and the webhook all'
\echo '-- write v1-2026-08, so "which disclosure regime was this lead captured'
\echo '-- under" is one question with one answer rather than three.'
-- Compared door to door rather than table-wide: earlier suites store consent
-- that arrived from a vendor with a version string of the vendor's choosing,
-- and asserting one value across all of public.leads would be asserting
-- something about their data instead of about ours.
DO $$
DECLARE v_webhook text; v_rpc text; v_probe uuid;
BEGIN
  SELECT tcpa_disclosure_version INTO v_webhook FROM public.leads
   WHERE id = 'f8000000-0000-4000-8000-000000000101';

  INSERT INTO public.leads (team_id, phone, source)
  VALUES ('70551e00-0000-4000-8000-000000000001', '+19125557304', 'manual')
  RETURNING id INTO v_probe;

  SELECT tcpa_disclosure_version
    INTO v_rpc
    FROM public.record_lead_consent(v_probe, 'verbal, on a call');

  IF v_webhook IS DISTINCT FROM v_rpc THEN
    RAISE EXCEPTION 'FAIL: the webhook stamps % and record_lead_consent stamps %', v_webhook, v_rpc;
  END IF;
  RAISE NOTICE 'PASS: both doors stamp %', v_webhook;
END $$;

\echo '=== 8. inbound_sms is a source, not a special case ==='
\echo '-- leads.source is free text with no enum to extend, which is why nothing'
\echo '-- had to be migrated for this. Asserted so that if somebody ever adds a'
\echo '-- CHECK to that column, this suite is where they find out the webhook'
\echo '-- writes a value they did not list.'
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT source = 'inbound_sms' AND source_detail LIKE 'Texted %' INTO v_ok
    FROM public.leads WHERE id = 'f8000000-0000-4000-8000-000000000101';
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL: the source no longer records that this was an inbound text';
  END IF;
  RAISE NOTICE 'PASS: source inbound_sms, detail naming the number they texted';
END $$;
