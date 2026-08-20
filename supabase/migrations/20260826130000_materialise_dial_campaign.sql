/**
 * Freeze a calling list from its filter.
 *
 * Runs once. A second call is refused rather than quietly rebuilding, because
 * the members carry per-row call progress: re-materialising would either wipe
 * "called 38 of 80" or silently merge two different filters into one list, and
 * neither is something an operator could untangle afterwards.
 *
 * Everyone the filter matched goes in, callable or not, with the reason frozen
 * on the row -- the same discipline materialise_campaign uses. A list that
 * silently drops the 12 leads with no consent looks like a list of 68 when it
 * was a list of 80, and the 12 are exactly the rows somebody needs to see to
 * know what work the list is short of.
 */
create or replace function public.materialise_dial_campaign(p_campaign_id uuid)
returns table(total integer, callable integer, skipped integer)
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  c            public.dial_campaigns;
  v_statuses   text[];
  v_temps      text[];
  v_sources    text[];
  v_cities     text[];
  v_only_ok    boolean;
  v_min_score  integer;
  v_total      integer := 0;
  v_skipped    integer := 0;
BEGIN
  SELECT * INTO c FROM public.dial_campaigns WHERE id = p_campaign_id;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'No such dial campaign' USING ERRCODE = 'no_data_found';
  END IF;
  IF c.materialised_at IS NOT NULL THEN
    RAISE EXCEPTION 'This list was already built; create a new one instead.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  v_statuses  := coalesce(array(select jsonb_array_elements_text(c.filter->'statuses')),     '{}');
  v_temps     := coalesce(array(select jsonb_array_elements_text(c.filter->'temperatures')), '{}');
  v_sources   := coalesce(array(select jsonb_array_elements_text(c.filter->'sources')),      '{}');
  v_cities    := coalesce(array(select jsonb_array_elements_text(c.filter->'cities')),       '{}');
  v_only_ok   := coalesce((c.filter->>'only_callable')::boolean, false);
  v_min_score := coalesce((c.filter->>'min_score')::integer, 0);

  IF c.kind = 'sellers' THEN
    INSERT INTO public.dial_campaign_members
      (team_id, campaign_id, lead_id, position, skip_reason)
    SELECT c.team_id, c.id, l.id,
           row_number() over (
             -- Overdue follow-ups first, then newest. The same order the
             -- untargeted queue uses, so a campaign does not reshuffle the
             -- operator's sense of what is urgent.
             order by (l.next_follow_up_at is null), l.next_follow_up_at, l.created_at desc
           ),
           public.lead_skip_reason(l.*)
      FROM public.leads l
     WHERE l.team_id = c.team_id
       AND NOT l.trashed
       AND (cardinality(v_statuses) = 0 OR l.status      = ANY(v_statuses))
       AND (cardinality(v_temps)    = 0 OR l.temperature = ANY(v_temps))
       AND (cardinality(v_sources)  = 0 OR l.source      = ANY(v_sources))
       AND (cardinality(v_cities)   = 0 OR lower(coalesce(l.city,'')) = ANY(
             array(select lower(x) from unnest(v_cities) x)))
       AND (NOT v_only_ok OR public.lead_skip_reason(l.*) IS NULL);
  ELSE
    INSERT INTO public.dial_campaign_members
      (team_id, campaign_id, buyer_id, position, match_score, match_reasons, skip_reason)
    SELECT c.team_id, c.id, b.id,
           row_number() over (order by m.score desc, b.name),
           m.score, m.reasons,
           public.buyer_call_skip_reason(b.*)
      FROM public.match_buyers_for_deal(c.deal_id) m
      JOIN public.buyers b ON b.id = m.buyer_id
     WHERE m.score >= v_min_score
       AND (NOT v_only_ok OR public.buyer_call_skip_reason(b.*) IS NULL);
  END IF;

  SELECT count(*), count(*) FILTER (WHERE skip_reason IS NOT NULL)
    INTO v_total, v_skipped
    FROM public.dial_campaign_members WHERE campaign_id = c.id;

  -- Rows that cannot be called start life skipped, so the queue never offers
  -- them and the progress counter is honest about what is actually workable.
  UPDATE public.dial_campaign_members
     SET status = 'skipped'
   WHERE campaign_id = c.id AND skip_reason IS NOT NULL;

  UPDATE public.dial_campaigns
     SET materialised_at = now(),
         total_count     = v_total,
         skipped_count   = v_skipped,
         callable_count  = v_total - v_skipped
   WHERE id = c.id;

  total := v_total; callable := v_total - v_skipped; skipped := v_skipped;
  RETURN NEXT;
END;
$$;

revoke all on function public.materialise_dial_campaign(uuid) from anon;
grant execute on function public.materialise_dial_campaign(uuid) to authenticated;
