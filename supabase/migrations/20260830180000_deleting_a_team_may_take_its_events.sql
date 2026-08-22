-- Deleting a team was impossible. Third time this trigger has bitten.
--
-- deal_events is append-only through a FOR EACH STATEMENT trigger that refuses
-- UPDATE and DELETE outright. deal_events.team_id cascades from teams, so
-- removing a team makes Postgres issue a DELETE against deal_events and the
-- trigger aborts the whole thing -- for a team with no events at all, as it
-- happens, because a statement trigger fires on the statement rather than on
-- matched rows.
--
-- The first two instances of this (actor_id, deal_id) were fixed by dropping
-- the foreign key, because there the cascade was a SET NULL that would have
-- rewritten history. This one is different and the same fix would be wrong: a
-- deleted tenant's events SHOULD go with it. Keeping an orphaned audit trail
-- for an account that no longer exists is not integrity, it is retaining a
-- former customer's records with nothing left to attach them to.
--
-- So: an escape hatch rather than a dropped key, modelled on the one Supabase
-- Storage uses for exactly this problem (storage.allow_delete_query). The guard
-- honours a session setting; only a BEFORE DELETE trigger on teams sets it, and
-- `set_config(..., true)` scopes it to the transaction, so it cannot leak into
-- the next statement on a pooled connection.
--
-- Everything else stays refused. A hand-typed DELETE against deal_events is
-- rejected exactly as before -- verified, not assumed.
create or replace function public.deal_events_are_immutable()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  -- Set only by teams_release_their_events(), for the length of one
  -- transaction, while a whole tenant is being removed.
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('app.deleting_team', true), 'false') = 'true' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'deal_events is append-only; % is not permitted on it', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct an event by appending a new one that supersedes it.';
END;
$$;

create or replace function public.teams_release_their_events()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  -- Transaction-scoped. If the delete rolls back, so does this.
  PERFORM set_config('app.deleting_team', 'true', true);
  RETURN OLD;
END;
$$;

revoke execute on function public.teams_release_their_events() from public, anon, authenticated;

drop trigger if exists trg_team_delete_releases_events on public.teams;
create trigger trg_team_delete_releases_events
  before delete on public.teams
  for each row execute function public.teams_release_their_events();

comment on function public.deal_events_are_immutable() is
  'Append-only guard. The single exception is a cascade from a team being deleted, flagged by app.deleting_team for one transaction.';
