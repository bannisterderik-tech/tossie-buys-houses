-- Restoring a list must put back exactly the prospects that went down with it.
--
-- The first cut keyed that on trashed_at, reasoning that now() is transaction
-- scoped so the list and its prospects would share a timestamp no individual
-- deletion could collide with. The test disproved it immediately: any prospect
-- deleted by hand *in the same transaction* gets the identical stamp and is
-- silently resurrected. In production those are usually separate requests, so
-- this would have looked correct for months and then quietly un-deleted a row
-- somebody meant to keep deleted.
--
-- An explicit marker says what is actually true -- "this was trashed as part of
-- its list" -- instead of inferring it from clock coincidence.
alter table public.prospects
  add column if not exists trashed_with_list boolean not null default false;

/**
 * Trash or restore a list together with its prospects.
 *
 * Deleting a list has to take its prospects out of view too, or the Prospects
 * tab keeps showing three thousand rows belonging to a list that is gone.
 */
create or replace function public.set_prospect_list_trashed(
  p_list_id uuid,
  p_trashed boolean
) returns integer
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  v_team    uuid;
  v_touched integer := 0;
BEGIN
  -- security invoker + RLS means a caller only ever sees their own team's list,
  -- so a missing row is either a wrong id or another team's. Same message for
  -- both on purpose: it should not confirm that an id exists elsewhere.
  SELECT team_id INTO v_team FROM public.prospect_lists WHERE id = p_list_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'No such prospect list' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_trashed THEN
    UPDATE public.prospect_lists SET trashed = true WHERE id = p_list_id;

    -- Only rows that were still live. One already deleted on its own is not
    -- this operation's to claim, and must not be restored by it later.
    UPDATE public.prospects
       SET trashed = true, trashed_with_list = true
     WHERE list_id = p_list_id AND NOT trashed;
    GET DIAGNOSTICS v_touched = ROW_COUNT;
  ELSE
    UPDATE public.prospects
       SET trashed = false, trashed_with_list = false
     WHERE list_id = p_list_id AND trashed AND trashed_with_list;
    GET DIAGNOSTICS v_touched = ROW_COUNT;

    UPDATE public.prospect_lists SET trashed = false WHERE id = p_list_id;
  END IF;

  RETURN v_touched;
END;
$$;

revoke all on function public.set_prospect_list_trashed(uuid, boolean) from anon;
grant execute on function public.set_prospect_list_trashed(uuid, boolean) to authenticated;

-- Restoring a prospect on its own must drop the claim too, or a later list
-- restore would try to own a row that is already back.
create or replace function public.stamp_trashed_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.trashed AND NOT COALESCE(OLD.trashed, false) THEN
    NEW.trashed_at := now();
  ELSIF NOT NEW.trashed THEN
    NEW.trashed_at := NULL;
    IF TG_TABLE_NAME = 'prospects' THEN
      NEW.trashed_with_list := false;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

revoke all on function public.stamp_trashed_at() from anon, authenticated;

comment on column public.prospects.trashed_with_list is
  'True when this row was trashed as part of its list, so restoring the list puts back exactly these and no others.';
