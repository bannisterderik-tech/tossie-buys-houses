-- Handing the business to somebody else.
--
-- The trap here is that ownership is stored in TWO places and only one of them
-- is obvious. my_role() reads:
--
--   COALESCE(
--     (SELECT role FROM team_members WHERE user_id = auth.uid() ...),
--     (SELECT 'owner' FROM teams WHERE created_by = auth.uid())   <-- this
--   )
--
-- The second branch exists so the person who created the team is the owner
-- before any team_members row is written. It also means that flipping
-- team_members.role alone would produce two owners -- the new one by their row,
-- the old one by the fallback -- and that demoting the old owner in
-- team_members would silently do nothing at all, because the fallback fires
-- exactly when the row says something other than 'owner'.
--
-- So a transfer has to move teams.created_by as well. That column stops being
-- "who typed the signup form" and becomes "who owns this", which is what every
-- read of it already assumed.

-- One owner per team, enforced rather than trusted. Without this the two-place
-- problem above can be recreated by hand with a plain UPDATE.
create unique index if not exists team_members_one_owner_idx
  on public.team_members (team_id) where role = 'owner';

/**
 * Make somebody else the owner, and stop being the owner yourself.
 *
 * Both halves in one transaction because a half-finished transfer is either an
 * account with two owners or an account with none, and the second one is not
 * recoverable from the UI -- there would be nobody left who can run this.
 *
 * The outgoing owner becomes an admin rather than being removed. They are
 * almost always still working the business the day after they hand over the
 * account, and dropping them to VA or deleting the row would take away the
 * leads they are in the middle of.
 */
create or replace function public.transfer_team_ownership(p_new_owner_id uuid)
returns table(new_owner_email text, previous_owner_email text, previous_owner_role text)
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  v_team  uuid := public.get_my_team_id();
  v_me    uuid := auth.uid();
  v_role  text;
BEGIN
  IF public.my_role() <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can hand over ownership'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_new_owner_id = v_me THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Must already be on the roster. A team_members row only exists once that
  -- person has actually signed in, so this also rules out handing the account
  -- to an address that has been invited but never used its magic link --
  -- which would leave nobody able to sign in as owner.
  SELECT tm.role INTO v_role
    FROM public.team_members tm
   WHERE tm.user_id = p_new_owner_id AND tm.team_id = v_team;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That person is not on the team yet. They have to sign in once before they can be made owner.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Demote first. team_members_one_owner_idx is a plain unique index and is
  -- checked per row as the statement runs, so promoting first would collide
  -- with the sitting owner.
  UPDATE public.team_members
     SET role = 'admin'
   WHERE user_id = v_me AND team_id = v_team;

  UPDATE public.team_members
     SET role = 'owner'
   WHERE user_id = p_new_owner_id AND team_id = v_team;

  -- The half that is easy to forget and impossible to notice: without this the
  -- outgoing owner keeps every owner power through my_role()'s fallback, and
  -- the UI would show them as an admin while the database still said owner.
  UPDATE public.teams
     SET created_by = p_new_owner_id
   WHERE id = v_team;

  RETURN QUERY
    SELECT (SELECT email FROM public.profiles WHERE id = p_new_owner_id),
           (SELECT email FROM public.profiles WHERE id = v_me),
           'admin';
END;
$$;

revoke execute on function public.transfer_team_ownership(uuid) from public, anon;
grant  execute on function public.transfer_team_ownership(uuid) to authenticated;

comment on function public.transfer_team_ownership(uuid) is
  'Moves ownership in both places it is stored — team_members.role and teams.created_by — and demotes the outgoing owner to admin. Owner only.';
