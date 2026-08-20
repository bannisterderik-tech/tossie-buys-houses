-- Roles: acquisitions, dispositions, VAs -- and gates that actually hold.
--
-- The rail is RLS, not the sidebar. Hiding a nav item stops an honest mistake;
-- it does nothing about a VA who opens the console, and this app hands every
-- signed-in browser a PostgREST endpoint over the same tables. So capability
-- checks go into the policies, and the UI reads the same capability list purely
-- so it does not offer buttons the database is about to refuse.
--
-- Capabilities are a TABLE, not a CASE statement, for one practical reason:
-- Tossie will want to move something between roles ("let the VA add buyers")
-- and that should be one row, applied instantly to both the API and the UI, not
-- a migration and a deploy.
alter table public.team_members drop constraint if exists team_members_role_check;
alter table public.team_members add constraint team_members_role_check
  check (role in ('owner','admin','acquisitions','dispositions','va'));

create table if not exists public.role_capabilities (
  role       text not null,
  capability text not null,
  primary key (role, capability)
);
alter table public.role_capabilities enable row level security;

drop policy if exists role_capabilities_read on public.role_capabilities;
create policy role_capabilities_read on public.role_capabilities
  for select to authenticated using (true);

create or replace function public.my_role()
returns text language sql stable security definer
set search_path to 'public', 'pg_catalog'
as $$
  SELECT COALESCE(
    (SELECT tm.role FROM public.team_members tm
      WHERE tm.user_id = auth.uid() AND tm.team_id = public.get_my_team_id()),
    (SELECT 'owner' FROM public.teams t
      WHERE t.id = public.get_my_team_id() AND t.created_by = auth.uid())
  );
$$;

/**
 * Owner short-circuits to true and is never listed in role_capabilities. A
 * capability someone forgets to seed then costs an acquisitions manager a
 * button; the same omission for the owner would lock the account holder out of
 * their own data, and there is no support desk here to undo that.
 */
create or replace function public.has_capability(cap text)
returns boolean language sql stable security definer
set search_path to 'public', 'pg_catalog'
as $$
  SELECT public.my_role() = 'owner'
      OR EXISTS (SELECT 1 FROM public.role_capabilities rc
                  WHERE rc.role = public.my_role() AND rc.capability = cap);
$$;

revoke execute on function public.my_role()            from public, anon;
revoke execute on function public.has_capability(text) from public, anon;
grant  execute on function public.my_role()            to authenticated;
grant  execute on function public.has_capability(text) to authenticated;

-- Nobody but owner and admin can DELETE anything. A VA mis-clicking through a
-- bulk delete is the most expensive mistake available on these screens.
delete from public.role_capabilities;
insert into public.role_capabilities (role, capability) values
  ('admin','leads.view'),      ('admin','leads.edit'),      ('admin','leads.delete'),
  ('admin','prospects.view'),  ('admin','prospects.edit'),  ('admin','prospects.delete'),
  ('admin','buyers.view'),     ('admin','buyers.edit'),     ('admin','buyers.delete'),
  ('admin','deals.view'),      ('admin','deals.edit'),      ('admin','deals.delete'),
  ('admin','campaigns.view'),  ('admin','campaigns.send'),
  ('admin','dialer.use'),      ('admin','messages.send'),   ('admin','sdr.manage'),
  ('admin','settings.phone'),  ('admin','import.run'),

  ('acquisitions','leads.view'),     ('acquisitions','leads.edit'),
  ('acquisitions','prospects.view'), ('acquisitions','prospects.edit'),
  ('acquisitions','deals.view'),     ('acquisitions','deals.edit'),
  ('acquisitions','buyers.view'),    ('acquisitions','campaigns.view'),
  ('acquisitions','dialer.use'),     ('acquisitions','messages.send'),
  ('acquisitions','import.run'),

  ('dispositions','buyers.view'),   ('dispositions','buyers.edit'),
  ('dispositions','deals.view'),    ('dispositions','deals.edit'),
  ('dispositions','leads.view'),
  ('dispositions','campaigns.view'),('dispositions','campaigns.send'),
  ('dispositions','dialer.use'),    ('dispositions','messages.send'),

  ('va','leads.view'),     ('va','leads.edit'),
  ('va','prospects.view'), ('va','prospects.edit'),
  ('va','buyers.view'),    ('va','deals.view'),
  ('va','dialer.use'),     ('va','messages.send'),
  ('va','import.run');

comment on table public.role_capabilities is
  'Role -> capability. Owner is omitted deliberately: has_capability() short-circuits for owner.';
