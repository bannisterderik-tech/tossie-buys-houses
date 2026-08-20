/**
 * Enrol or remove leads from the SDR, in bulk.
 *
 * A function rather than a plain UPDATE for one reason: enrolling a lead the
 * SDR then refuses is worse than refusing to enrol it, because the operator
 * believes it is being worked and it is silently not. So this returns what it
 * actually did and what it skipped, and the caller shows both.
 *
 * A lead with no consent basis is skipped. lead_is_dialable() is the same
 * check twilio-send-sms applies at send time, so enrolling past it would just
 * queue up refusals -- and each refusal is a turn the model was paid to write.
 */
create or replace function public.set_sdr_enrollment(
  p_lead_ids   uuid[],
  p_enabled    boolean,
  p_persona_id uuid default null
) returns table(enrolled integer, skipped integer, skipped_reason text)
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  v_team    uuid := public.get_my_team_id();
  v_ok      integer := 0;
  v_skipped integer := 0;
BEGIN
  IF NOT public.has_capability('sdr.manage') THEN
    RAISE EXCEPTION 'You do not have permission to change AI SDR enrolment'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_persona_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sdr_personas WHERE id = p_persona_id AND team_id = v_team
  ) THEN
    RAISE EXCEPTION 'No such SDR persona' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_enabled THEN
    UPDATE public.leads l
       SET sdr_enabled = true,
           sdr_persona_id = COALESCE(p_persona_id, l.sdr_persona_id,
             (SELECT id FROM public.sdr_personas
               WHERE team_id = v_team AND is_default AND active LIMIT 1))
     WHERE l.id = ANY(p_lead_ids)
       AND l.team_id = v_team
       AND NOT l.trashed
       AND public.lead_is_dialable(l.*);
    GET DIAGNOSTICS v_ok = ROW_COUNT;
    v_skipped := coalesce(array_length(p_lead_ids, 1), 0) - v_ok;
  ELSE
    -- Removing never refuses. Whatever state a lead is in, taking it off the
    -- SDR must always work -- that is the stop button.
    UPDATE public.leads
       SET sdr_enabled = false
     WHERE id = ANY(p_lead_ids) AND team_id = v_team;
    GET DIAGNOSTICS v_ok = ROW_COUNT;
    v_skipped := 0;
  END IF;

  enrolled := v_ok;
  skipped  := v_skipped;
  skipped_reason := CASE
    WHEN v_skipped > 0 AND p_enabled
      THEN 'No consent basis on file, or already deleted. The SDR would have been refused at send time anyway.'
    ELSE NULL END;
  RETURN NEXT;
END;
$$;

/**
 * Fold a piece of feedback into the persona's standing guidance.
 *
 * Appended with the date rather than replacing, because the value of this list
 * is that somebody can read it back and see why each line is there. It is also
 * the reason it is a plain text column an owner can edit: the wrong correction
 * makes the SDR worse, and a correction nobody can find is one nobody can undo.
 */
create or replace function public.apply_sdr_feedback(p_feedback_id uuid)
returns text
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  f        public.sdr_message_feedback;
  v_target uuid;
  v_line   text;
  v_out    text;
BEGIN
  IF NOT public.has_capability('sdr.manage') THEN
    RAISE EXCEPTION 'You do not have permission to change the AI SDR'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO f FROM public.sdr_message_feedback WHERE id = p_feedback_id;
  IF f.id IS NULL THEN
    RAISE EXCEPTION 'No such feedback' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(btrim(f.note), '') = '' THEN
    RAISE EXCEPTION 'That feedback has no note, so there is nothing to teach. Add what was wrong with it first.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_target := COALESCE(f.persona_id,
    (SELECT id FROM public.sdr_personas WHERE team_id = f.team_id AND is_default AND active LIMIT 1));
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'There is no persona to apply this to' USING ERRCODE = 'no_data_found';
  END IF;

  v_line := '- ' || to_char(now(), 'YYYY-MM-DD') || ': ' || btrim(f.note);

  UPDATE public.sdr_personas
     SET learned_guidance = btrim(coalesce(learned_guidance || E'\n', '') || v_line)
   WHERE id = v_target
  RETURNING learned_guidance INTO v_out;

  UPDATE public.sdr_message_feedback SET applied = true WHERE id = p_feedback_id;
  RETURN v_out;
END;
$$;

revoke execute on function public.set_sdr_enrollment(uuid[], boolean, uuid) from public, anon;
revoke execute on function public.apply_sdr_feedback(uuid)                  from public, anon;
grant  execute on function public.set_sdr_enrollment(uuid[], boolean, uuid) to authenticated;
grant  execute on function public.apply_sdr_feedback(uuid)                  to authenticated;
