-- Permissions for one person, on top of what their role says.
--
-- Roles cover the ordinary cases and will keep doing the work: a VA is a VA. But
-- a real team always has one exception -- the VA who is trusted to run the
-- import, the acquisitions person who also handles the buyer blast while
-- somebody is away -- and the only way to express that today is to promote them
-- to a role that grants six other things you did not mean to give.
--
-- So an override is per person, per capability, and can go in either direction:
--
--   granted = true   this person may, whatever their role says
--   granted = false  this person may not, whatever their role says
--   no row           the role decides, exactly as before
--
-- A revoke matters as much as a grant. Taking messages.send off one VA who
-- keeps texting sellers at 9pm should not require inventing a role for them.
create table if not exists public.user_capabilities (
  team_id    uuid not null references public.teams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  capability text not null,
  granted    boolean not null,
  -- Why, in the operator's words. An override with no reason is one nobody
  -- dares remove two years later because they cannot tell if it is load
  -- bearing.
  note       text,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, capability)
);

create index if not exists user_capabilities_team_idx
  on public.user_capabilities (team_id, user_id);

alter table public.user_capabilities enable row level security;

-- Readable by the whole team so the Team page can show who has what, and so a
-- person can see their own exceptions. Writable by the owner alone -- the same
-- bar as changing a role, because these do the same thing one capability at a
-- time. team.manage is deliberately not in role_capabilities, so it resolves
-- only through the owner short-circuit in has_capability().
drop policy if exists user_capabilities_read  on public.user_capabilities;
drop policy if exists user_capabilities_write on public.user_capabilities;
create policy user_capabilities_read on public.user_capabilities for select
  using (team_id = public.get_my_team_id());
create policy user_capabilities_write on public.user_capabilities for all
  using (team_id = public.get_my_team_id() and public.has_capability('team.manage'))
  with check (team_id = public.get_my_team_id() and public.has_capability('team.manage'));

/**
 * has_capability, now with the override consulted before the role.
 *
 * Every RLS policy in the database calls this, so the shape matters more than
 * the feature. Three rules, in this order and for these reasons:
 *
 *   1. The owner short-circuit stays FIRST and stays absolute. If a revoke
 *      could apply to an owner, one bad click would lock the only person who
 *      can undo it out of the screen that undoes it.
 *
 *   2. The override wins over the role when a row exists -- in both
 *      directions. COALESCE on the boolean rather than two EXISTS checks, so
 *      `granted = false` is a real answer and not indistinguishable from
 *      "no row".
 *
 *   3. No row falls through to exactly the previous behaviour. Nobody's access
 *      changes until somebody deliberately writes an override.
 *
 * Still SECURITY DEFINER, so it reads user_capabilities past that table's own
 * RLS -- which is required, because policies call this while evaluating the
 * very reads it would otherwise need permission for.
 */
create or replace function public.has_capability(cap text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  SELECT CASE
    WHEN public.my_role() = 'owner' THEN true
    ELSE COALESCE(
      (SELECT uc.granted
         FROM public.user_capabilities uc
        WHERE uc.user_id = auth.uid()
          AND uc.capability = cap
          AND uc.team_id = public.get_my_team_id()),
      EXISTS (
        SELECT 1 FROM public.role_capabilities rc
         WHERE rc.role = public.my_role() AND rc.capability = cap
      )
    )
  END;
$$;

/**
 * Set or clear one person's override.
 *
 * p_granted null clears it, which is different from setting it false: cleared
 * means "the role decides again", false means "not this person, ever". The UI
 * offers three states for the same reason.
 */
create or replace function public.set_user_capability(
  p_user_id    uuid,
  p_capability text,
  p_granted    boolean default null,
  p_note       text default null
) returns void
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  v_team uuid := public.get_my_team_id();
BEGIN
  IF NOT public.has_capability('team.manage') THEN
    RAISE EXCEPTION 'Only the owner can change what somebody is allowed to do'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Guessing a capability name silently writes an override that can never
  -- match anything, which reads on screen as "granted" and does nothing.
  IF NOT EXISTS (SELECT 1 FROM public.role_capabilities WHERE capability = p_capability)
     AND p_capability <> 'team.manage' THEN
    RAISE EXCEPTION 'No such capability: %', p_capability
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
     WHERE user_id = p_user_id AND team_id = v_team
  ) THEN
    RAISE EXCEPTION 'That person is not on this team'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The owner's permissions are not editable, because has_capability
  -- short-circuits them anyway. Writing a row that has no effect would show an
  -- override on screen that the database ignores.
  IF (SELECT role FROM public.team_members WHERE user_id = p_user_id AND team_id = v_team) = 'owner' THEN
    RAISE EXCEPTION 'The owner already has everything — there is nothing to override'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_granted IS NULL THEN
    DELETE FROM public.user_capabilities
     WHERE user_id = p_user_id AND capability = p_capability;
    RETURN;
  END IF;

  INSERT INTO public.user_capabilities (team_id, user_id, capability, granted, note, created_by)
  VALUES (v_team, p_user_id, p_capability, p_granted, nullif(btrim(coalesce(p_note,'')), ''), auth.uid())
  ON CONFLICT (user_id, capability) DO UPDATE
    SET granted = excluded.granted,
        note    = excluded.note,
        created_by = excluded.created_by,
        created_at = now();
END;
$$;

revoke execute on function public.set_user_capability(uuid, text, boolean, text) from public, anon;
grant  execute on function public.set_user_capability(uuid, text, boolean, text) to authenticated;

comment on table public.user_capabilities is
  'Per-person exceptions to role_capabilities. granted=true adds, granted=false removes, no row means the role decides. Never applies to an owner.';
