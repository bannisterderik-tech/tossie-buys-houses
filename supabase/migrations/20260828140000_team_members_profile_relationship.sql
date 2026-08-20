-- "Could not find a relationship between 'team_members' and 'profiles'".
--
-- team_members.user_id points at auth.users, and so does profiles.id — but
-- PostgREST can only embed across a foreign key it can actually see, and there
-- was none between these two. So the Team roster asked for
-- `team_members.select('*, profiles(...)')`, got a schema-cache error, and
-- rendered "0 people" over a team that has one. The failure was silent in the
-- sense that mattered: an empty roster looks like an empty team.
--
-- The relationship is real — every team member has exactly one profile, checked
-- before adding this — so the fix is to declare it rather than to work around
-- it by fetching both tables and joining in the browser.
--
-- CASCADE matches the existing user_id -> auth.users rule: profiles is itself
-- ON DELETE CASCADE from auth.users, so deleting an account already took the
-- profile, and the membership should go with it rather than dangle.
alter table public.team_members
  drop constraint if exists team_members_user_id_profile_fkey;

alter table public.team_members
  add constraint team_members_user_id_profile_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;
