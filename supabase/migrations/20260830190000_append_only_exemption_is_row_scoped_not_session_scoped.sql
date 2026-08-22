-- Replacing the escape hatch I added one migration ago, which was wrong in a
-- way its own test caught.
--
-- That version set a session flag in a BEFORE DELETE trigger on teams and let
-- deal_events accept any DELETE while the flag was set. set_config(..., true)
-- scopes to the transaction, and the transaction does not end when the cascade
-- does -- so every later statement in the same transaction could also delete
-- deal_events. The test deleted a throwaway tenant and then, in the same
-- transaction, successfully deleted the real team's audit trail. It happened to
-- destroy nothing because the table was empty, which is luck, not a defence.
--
-- The exemption should be a property of the ROW, not of the session: an event
-- may be deleted exactly when the team it belongs to no longer exists. During a
-- cascade that is true, because the parent row is gone by the time the
-- referential action runs. For a hand-typed DELETE it is false, because the
-- team is still sitting there. Nothing has to be flagged, nothing has to be
-- unset, and there is no window.
--
-- Shape: UPDATE and TRUNCATE stay statement-level and absolute. DELETE becomes
-- row-level so each row can be judged. A zero-row DELETE now touches nothing
-- rather than raising, which also removes the original foot-gun that made
-- deal_events.deal_id and .actor_id undeletable in the first place.

drop trigger if exists trg_team_delete_releases_events on public.teams;
drop function if exists public.teams_release_their_events();

create or replace function public.deal_events_are_immutable()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  RAISE EXCEPTION 'deal_events is append-only; % is not permitted on it', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct an event by appending a new one that supersedes it.';
END;
$$;

/**
 * One event may go only when the team it belonged to is already gone.
 *
 * Checked per row and against live state rather than against a flag, so there
 * is nothing to set, nothing to clear, and no way for the permission to outlive
 * the statement that earned it.
 */
create or replace function public.deal_event_delete_only_with_its_team()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.teams t WHERE t.id = OLD.team_id) THEN
    RAISE EXCEPTION 'deal_events is append-only; DELETE is not permitted on it'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Correct an event by appending a new one that supersedes it.';
  END IF;
  RETURN OLD;
END;
$$;

revoke execute on function public.deal_event_delete_only_with_its_team() from public, anon, authenticated;

-- Rebuild the guards: statement-level for UPDATE/TRUNCATE, row-level for DELETE.
drop trigger if exists deal_events_immutable        on public.deal_events;
drop trigger if exists trg_deal_events_immutable    on public.deal_events;
drop trigger if exists trg_deal_events_no_update    on public.deal_events;
drop trigger if exists trg_deal_events_no_delete    on public.deal_events;
drop trigger if exists trg_deal_events_no_truncate  on public.deal_events;

create trigger trg_deal_events_no_update
  before update on public.deal_events
  for each statement execute function public.deal_events_are_immutable();

create trigger trg_deal_events_no_truncate
  before truncate on public.deal_events
  for each statement execute function public.deal_events_are_immutable();

create trigger trg_deal_events_no_delete
  before delete on public.deal_events
  for each row execute function public.deal_event_delete_only_with_its_team();

comment on function public.deal_event_delete_only_with_its_team() is
  'Append-only guard for DELETE. Permits a row only when its team no longer exists, which is true during a tenant cascade and false for any hand-typed delete.';
