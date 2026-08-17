-- ============================================================================
-- Phase 1 — the CRM write paths.
-- ============================================================================
-- Two operations the operator performs dozens of times a day. Both touch more
-- than one table, so both live in the database as single transactions rather
-- than as a sequence of client calls that can half-apply when a tab is closed
-- mid-save.
--
-- Both are SECURITY INVOKER on purpose. The caller already has FOR ALL policies
-- on every table these touch, so RLS does the team scoping. A SECURITY DEFINER
-- function here would bypass RLS and force us to hand-write the team check that
-- RLS already gets right — more code, and the first place a bug would hide.
-- ============================================================================

-- ── wrong numbers ───────────────────────────────────────────────────────────
-- The first draft of log_disposition nulled phone and phone_mobile on a
-- wrong_number outcome. Two things wrong with that, both caught by the test
-- suite before this reached the live database:
--
--   1. leads_has_contact requires phone OR email OR phone_mobile. Cold-list
--      leads routinely have no email, so nulling both phones violated the
--      constraint and the disposition failed outright — on one of the most
--      common cold-call outcomes there is.
--   2. Destroying the number is wrong regardless. It is the record of what was
--      actually dialed, and a skip trace that returned a stranger's number is
--      worth knowing about when judging the vendor.
--
-- So flag it instead, and let lead_is_dialable() do what it already does.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS phone_invalid boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.leads.phone_invalid IS
  'The number on file reaches someone other than the owner. Keeps the number for the record while removing the lead from every dial queue.';

CREATE OR REPLACE FUNCTION public.lead_is_dialable(l public.leads)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT NOT l.trashed
     AND NOT l.is_dnc
     AND NOT l.is_litigator
     AND NOT l.phone_invalid
     AND COALESCE(l.phone_mobile, l.phone) IS NOT NULL
     AND (
       -- inbound: the seller contacted us and accepted the disclosure
       (l.source = 'website' AND l.tcpa_opt_in)
       -- outbound: cold list, must be traced and scrubbed
       OR (l.skip_traced AND l.dnc_scrubbed)
     );
$$;

REVOKE ALL ON FUNCTION public.lead_is_dialable(public.leads) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_is_dialable(public.leads) TO authenticated;

-- ── disposition ─────────────────────────────────────────────────────────────
-- What happened on the call, in one tap. Each outcome carries the status it
-- implies and how long to wait before the next attempt, so the operator picks
-- one thing instead of filling in three fields and remembering the convention.
--
-- The default follow-up gaps are deliberately short at the top of the ladder:
-- a no-answer is worth another try tomorrow, a voicemail in two days, and
-- someone who asked for a callback gets exactly when they asked for.

CREATE OR REPLACE FUNCTION public.log_disposition(
  p_lead_id      uuid,
  p_outcome      text,
  p_note         text        DEFAULT NULL,
  p_follow_up_at timestamptz DEFAULT NULL
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_lead      public.leads;
  v_status    text;
  v_default_gap interval;
  v_follow_up timestamptz;
BEGIN
  -- RLS on this SELECT is the team check. A lead on another team simply is not
  -- found, and the caller cannot tell the difference between that and a typo.
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  CASE p_outcome
    WHEN 'no_answer'          THEN v_status := 'attempting';      v_default_gap := interval '1 day';
    WHEN 'left_voicemail'     THEN v_status := 'attempting';      v_default_gap := interval '2 days';
    WHEN 'callback_requested' THEN v_status := 'contacted';       v_default_gap := interval '1 day';
    WHEN 'spoke_interested'   THEN v_status := 'qualified';       v_default_gap := interval '2 days';
    WHEN 'appointment_set'    THEN v_status := 'appointment_set'; v_default_gap := NULL;
    WHEN 'offer_made'         THEN v_status := 'offer_made';      v_default_gap := interval '2 days';
    WHEN 'under_contract'     THEN v_status := 'under_contract';  v_default_gap := NULL;
    WHEN 'not_interested'     THEN v_status := 'dead';            v_default_gap := NULL;
    WHEN 'wrong_number'       THEN v_status := 'attempting';      v_default_gap := NULL;
    WHEN 'nurture'            THEN v_status := 'nurture';         v_default_gap := interval '30 days';
    WHEN 'do_not_call'        THEN v_status := 'dead';            v_default_gap := NULL;
    ELSE RAISE EXCEPTION 'Unknown disposition: %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END CASE;

  -- An explicit follow-up always wins; otherwise fall back to the ladder.
  v_follow_up := COALESCE(
    p_follow_up_at,
    CASE WHEN v_default_gap IS NULL THEN NULL ELSE now() + v_default_gap END
  );

  UPDATE public.leads SET
    status            = v_status,
    last_contacted_at = now(),
    first_contact_at  = COALESCE(first_contact_at, now()),
    call_attempts     = call_attempts + 1,
    next_follow_up_at = v_follow_up,
    -- A spoken "don't call me again" is a DNC request and carries the same
    -- weight as an SMS STOP. Setting this makes lead_is_dialable() false, so
    -- the dialer drops the number without anyone having to remember to.
    is_dnc            = CASE WHEN p_outcome = 'do_not_call' THEN true ELSE is_dnc END,
    consent_sms       = CASE WHEN p_outcome = 'do_not_call' THEN false ELSE consent_sms END,
    -- A wrong number reaches a stranger, so the lead leaves every dial queue —
    -- but the property is still real and the number is still the record of
    -- what was dialed, so flag rather than delete.
    phone_invalid     = CASE WHEN p_outcome = 'wrong_number' THEN true ELSE phone_invalid END
  WHERE id = p_lead_id
  RETURNING * INTO v_lead;

  -- The status trigger already logs a status_changed row when the status moved.
  -- This is the richer record: which outcome, what was said, what happens next.
  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_lead.team_id, p_lead_id, auth.uid(), 'user', 'disposition',
    initcap(replace(p_outcome, '_', ' '))
      || CASE WHEN p_note IS NULL OR p_note = '' THEN '' ELSE ' - ' || p_note END,
    jsonb_build_object('outcome', p_outcome, 'note', p_note, 'follow_up_at', v_follow_up)
  );

  RETURN v_lead;
END;
$$;

COMMENT ON FUNCTION public.log_disposition IS
  'Records a call outcome: sets status, schedules the follow-up, bumps the attempt count and logs activity in one transaction. do_not_call sets is_dnc, which is what actually stops the dialer.';

-- ── board moves ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.move_lead_to_stage(
  p_lead_id  uuid,
  p_stage_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_team      uuid;
  v_pipeline  uuid;
  v_stage     text;
  v_from      text;
BEGIN
  SELECT team_id INTO v_team FROM public.leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.pipeline_id, s.name INTO v_pipeline, v_stage
  FROM public.pipeline_stages s WHERE s.id = p_stage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.name INTO v_from
  FROM public.lead_pipeline_memberships m
  JOIN public.pipeline_stages s ON s.id = m.stage_id
  WHERE m.lead_id = p_lead_id AND m.pipeline_id = v_pipeline;

  IF v_from IS NOT DISTINCT FROM v_stage THEN
    RETURN;  -- dropped back where it started
  END IF;

  INSERT INTO public.lead_pipeline_memberships (lead_id, pipeline_id, stage_id)
  VALUES (p_lead_id, v_pipeline, p_stage_id)
  ON CONFLICT (lead_id, pipeline_id) DO UPDATE SET stage_id = EXCLUDED.stage_id;

  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_team, p_lead_id, auth.uid(), 'user', 'stage_changed',
    COALESCE(v_from, 'Unfiled') || ' -> ' || v_stage,
    jsonb_build_object('from', v_from, 'to', v_stage)
  );
END;
$$;

COMMENT ON FUNCTION public.move_lead_to_stage IS
  'Moves a board card and logs it. Upsert rather than insert, because a lead is on a pipeline exactly once.';

-- ── grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.log_disposition(uuid, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.move_lead_to_stage(uuid, uuid)                 FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_disposition(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_lead_to_stage(uuid, uuid)                 TO authenticated;

-- ── the follow-up queue ─────────────────────────────────────────────────────
-- What is due, oldest first. This is the query behind the Today view and,
-- later, the seed of the dialer's call list — so it filters on the same
-- lead_is_dialable() the dialer will, rather than inventing a second rule.
CREATE OR REPLACE VIEW public.due_leads
WITH (security_invoker = true)
AS
SELECT l.*, public.lead_is_dialable(l.*) AS dialable
FROM public.leads l
WHERE NOT l.trashed
  AND l.status NOT IN ('dead', 'closed')
  AND l.next_follow_up_at IS NOT NULL
  AND l.next_follow_up_at <= now();

COMMENT ON VIEW public.due_leads IS
  'Follow-ups that have come due. security_invoker so the underlying RLS on leads still applies — a view is otherwise evaluated as its owner and would leak every team.';

REVOKE ALL ON public.due_leads FROM PUBLIC, anon;
GRANT SELECT ON public.due_leads TO authenticated;
