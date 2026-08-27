-- Enrolling a lead on the SDR left no evidence anywhere.
--
-- The function worked -- proved by calling it: five leads in, enrolled=5,
-- skipped=0. But nothing on any screen said so afterwards. sdr_enabled appears
-- zero times in the leads list and zero times on the lead detail, the bulk
-- panel closes and clears the selection without a word on success, and this
-- RPC wrote no activity row. So the operator selected leads, pressed Add,
-- watched everything vanish, and had no way to tell the difference between
-- "enrolled" and "silently did nothing".
--
-- The database half of the fix is this: enrolling or removing a lead is a
-- decision about whether a robot may text a homeowner, and that belongs on the
-- lead's timeline next to every other decision somebody made about them.
--
-- One row per lead rather than one per batch, because the timeline is read per
-- lead -- a single "enrolled 40 leads" row would appear on none of them.
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
  v_touched uuid[];
  v_persona text;
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
    WITH moved AS (
      UPDATE public.leads l
         SET sdr_enabled = true,
             sdr_persona_id = COALESCE(p_persona_id, l.sdr_persona_id,
               (SELECT id FROM public.sdr_personas
                 WHERE team_id = v_team AND is_default AND active LIMIT 1))
       WHERE l.id = ANY(p_lead_ids)
         AND l.team_id = v_team
         AND NOT l.trashed
         AND public.lead_is_dialable(l.*)
      RETURNING l.id
    )
    SELECT array_agg(id) INTO v_touched FROM moved;

    v_ok := coalesce(array_length(v_touched, 1), 0);
    v_skipped := coalesce(array_length(p_lead_ids, 1), 0) - v_ok;
  ELSE
    -- Removing never refuses. Whatever state a lead is in, taking it off the
    -- SDR must always work -- that is the stop button.
    WITH moved AS (
      UPDATE public.leads
         SET sdr_enabled = false
       WHERE id = ANY(p_lead_ids) AND team_id = v_team
      RETURNING id
    )
    SELECT array_agg(id) INTO v_touched FROM moved;

    v_ok := coalesce(array_length(v_touched, 1), 0);
    v_skipped := 0;
  END IF;

  SELECT name INTO v_persona FROM public.sdr_personas
   WHERE id = COALESCE(p_persona_id,
     (SELECT id FROM public.sdr_personas WHERE team_id = v_team AND is_default AND active LIMIT 1));

  -- The trace. Written per lead so it lands on the timeline somebody reads.
  IF v_ok > 0 THEN
    INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
    SELECT v_team, id, auth.uid(), 'user',
           CASE WHEN p_enabled THEN 'sdr_enrolled' ELSE 'sdr_removed' END,
           CASE WHEN p_enabled
                THEN 'Put on the AI SDR' || COALESCE(' — ' || v_persona, '')
                ELSE 'Taken off the AI SDR' END,
           jsonb_build_object('persona_id', p_persona_id, 'batch_size', v_ok)
      FROM unnest(v_touched) AS id;
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

revoke execute on function public.set_sdr_enrollment(uuid[], boolean, uuid) from public, anon;
grant  execute on function public.set_sdr_enrollment(uuid[], boolean, uuid) to authenticated;
