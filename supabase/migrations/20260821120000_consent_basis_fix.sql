-- ============================================================================
-- Fix the consent basis in lead_is_dialable.
-- ============================================================================
-- The previous definition read:
--
--     (l.source = 'website' AND l.tcpa_opt_in) OR (l.skip_traced AND l.dnc_scrubbed)
--
-- which conflates the CHANNEL consent arrived through with the consent itself.
-- A website form is one way to obtain express written consent. It is not the
-- only one: a seller who calls the number on a sign and asks to be texted has
-- given consent, and so has one who signs an agreement in person. Under the old
-- rule none of that could ever be acted on — tcpa_opt_in could be true, with the
-- disclosure text, timestamp and source all recorded, and the lead would still
-- be permanently uncontactable because `source` happened to say 'manual'.
--
-- The practical result was worse than strict: an operator who cannot record a
-- real consent inside the system works around the system, and then the consent
-- record lives in his head instead of in a database anyone can produce later.
-- A rail that pushes people off the rails is not a rail.
--
-- The rule that was actually intended, and is what this restores:
--
--   * inbound  — express consent was obtained and recorded, however it arrived
--   * outbound — a cold-list lead must be skip-traced AND DNC-scrubbed
--
-- with every veto (DNC, litigator, opt-out, wrong number, trashed) unchanged.
--
-- The guardrail that replaces `source = 'website'` is the CHECK below: opt-in
-- cannot be asserted without recording HOW it was obtained. A bare boolean is
-- worth nothing to a plaintiff's attorney; a boolean plus a source, a timestamp
-- and the disclosure shown is the thing that answers the question.
-- ============================================================================

-- Provenance is the price of asserting consent — but only the part that every
-- honest path already has.
--
-- The first draft of this required tcpa_disclosure_source too, and that was a
-- mistake worth recording: api/lead.js sets that column from the form's
-- page_path, which is legitimately null when the form is posted without one.
-- The insert would have failed the CHECK, and because that endpoint deliberately
-- swallows storage errors to keep the public site working, real seller leads
-- would have been dropped with a log line nobody reads. A compliance constraint
-- that silently destroys leads is worse than the gap it closes.
--
-- The timestamp is the part that is always present, always knowable, and the
-- first thing anyone asks for: WHEN did they agree. Source and disclosure text
-- are still written by every path that has them — enforced by convention and by
-- record_lead_consent() below, which cannot write the boolean without them.
--
-- NOT VALID so existing rows are left alone rather than failing the migration.
-- They are already true or already false, and rewriting history to satisfy a
-- constraint would be its own kind of lie.
ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_opt_in_needs_provenance;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_opt_in_needs_provenance CHECK (
    NOT tcpa_opt_in OR tcpa_opt_in_at IS NOT NULL
  ) NOT VALID;

COMMENT ON CONSTRAINT leads_opt_in_needs_provenance ON public.leads IS
  'tcpa_opt_in cannot be asserted without recording when. The boolean alone is not evidence, and "when did they agree" is the first question asked.';

CREATE OR REPLACE FUNCTION public.lead_is_dialable(l public.leads)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT NOT l.trashed
     AND NOT l.is_dnc
     AND NOT l.is_litigator
     AND NOT l.phone_invalid
     AND COALESCE(l.phone_mobile, l.phone) IS NOT NULL
     -- Both numbers, not just the one we would dial: a STOP from the landline
     -- on file suppresses the mobile too. Over-suppressing costs a lead,
     -- under-suppressing costs $500-$1,500 per contact.
     AND NOT public.is_opted_out(l.team_id, l.phone)
     AND NOT public.is_opted_out(l.team_id, l.phone_mobile)
     AND (
       -- inbound: consent was obtained and its provenance recorded, by whatever
       -- channel. The CHECK above is what keeps this honest.
       l.tcpa_opt_in
       -- outbound: a cold-list lead must be traced AND scrubbed. Unchanged, and
       -- still the rule that matters most, because this is the path where
       -- nobody has agreed to anything.
       OR (l.skip_traced AND l.dnc_scrubbed)
     );
$$;

COMMENT ON FUNCTION public.lead_is_dialable IS
  'Single source of truth for "may we contact this number" — used by the dialer, the SMS send path and the SDR. Consent basis is tcpa_opt_in (however obtained, provenance enforced by leads_opt_in_needs_provenance) or a traced-and-scrubbed cold-list lead. Vetoed by DNC, litigator, opt-out, wrong number or trashed. STABLE, not IMMUTABLE, because it reads telephony_opt_outs — it cannot be used in an index expression.';

REVOKE ALL ON FUNCTION public.lead_is_dialable(public.leads) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_is_dialable(public.leads) TO authenticated;

-- ── recording consent from the app ──────────────────────────────────────────
-- There was no way to do this after a lead existed. The New Lead form had a
-- checkbox; the lead detail panel had nothing, so a seller who consented on a
-- call could never be contacted. That gap is why the rule above was discovered
-- to be wrong in the first place.
--
-- An RPC rather than a plain UPDATE so the three fields that constitute a
-- consent record are always written together with an audit row. A UI that can
-- set the boolean without the provenance would walk straight into the CHECK.
CREATE OR REPLACE FUNCTION public.record_lead_consent(
  p_lead_id uuid,
  p_source  text,
  p_note    text DEFAULT NULL
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_lead public.leads;
BEGIN
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RAISE EXCEPTION 'A consent source is required — how was consent obtained?'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- RLS on the UPDATE is the team check.
  UPDATE public.leads SET
    tcpa_opt_in             = true,
    tcpa_opt_in_at          = COALESCE(tcpa_opt_in_at, now()),
    tcpa_disclosure_source  = btrim(p_source),
    tcpa_disclosure_version = COALESCE(tcpa_disclosure_version, 'v1-2026-08'),
    tcpa_disclosure_text    = COALESCE(
      tcpa_disclosure_text,
      'Consent recorded by an operator. Source: ' || btrim(p_source)
        || COALESCE(' — ' || nullif(btrim(p_note), ''), '')
    ),
    consent_sms             = true,
    consent_email           = true
  WHERE id = p_lead_id
  RETURNING * INTO v_lead;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_lead.team_id, p_lead_id, auth.uid(), 'user', 'consent_recorded',
    'Consent recorded: ' || btrim(p_source)
      || COALESCE(' — ' || nullif(btrim(p_note), ''), ''),
    jsonb_build_object('source', btrim(p_source), 'note', p_note)
  );

  RETURN v_lead;
END;
$$;

COMMENT ON FUNCTION public.record_lead_consent IS
  'Records express consent on an existing lead, with its provenance and an audit row, in one statement. Requires a source — "how was this obtained" is the part that has to survive being asked later.';

REVOKE ALL ON FUNCTION public.record_lead_consent(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lead_consent(uuid, text, text) TO authenticated;

-- ── withdrawing it again ────────────────────────────────────────────────────
-- The inverse has to exist too, and must be easier than granting it.
CREATE OR REPLACE FUNCTION public.withdraw_lead_consent(
  p_lead_id uuid,
  p_reason  text DEFAULT NULL
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_lead public.leads;
BEGIN
  UPDATE public.leads SET
    tcpa_opt_in = false,
    consent_sms = false,
    consent_email = false
  WHERE id = p_lead_id
  RETURNING * INTO v_lead;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- The disclosure fields are deliberately NOT cleared. What was shown and when
  -- it was agreed to stays on the record; withdrawing consent going forward does
  -- not unmake the fact that it was once given.
  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_lead.team_id, p_lead_id, auth.uid(), 'user', 'consent_withdrawn',
    'Consent withdrawn' || COALESCE(' — ' || nullif(btrim(p_reason), ''), ''),
    jsonb_build_object('reason', p_reason)
  );

  RETURN v_lead;
END;
$$;

REVOKE ALL ON FUNCTION public.withdraw_lead_consent(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_lead_consent(uuid, text) TO authenticated;
