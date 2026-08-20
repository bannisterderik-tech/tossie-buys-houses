-- handle_new_user() still assigned the old 'member' role, which the new role
-- CHECK rejects -- so the moment roles shipped, every invited teammate would
-- have failed to sign up at all, with the error surfacing from an auth trigger
-- rather than anywhere anybody would think to look.
--
-- The replacement is not 'member' renamed. A new person now lands on 'va', the
-- least privileged role: they can work leads and prospects and dial, and they
-- cannot delete anything, blast anyone, or touch phone settings until the owner
-- promotes them on the Team screen.
alter table public.team_members alter column role set default 'va';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $function$
DECLARE
  v_team uuid := '70551e00-0000-4000-8000-000000000001';
  v_first boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.team_members WHERE team_id = v_team) INTO v_first;

  INSERT INTO public.profiles (id, team_id, email, full_name, app_role)
  VALUES (NEW.id, v_team, NEW.email,
          COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email),
          CASE WHEN v_first THEN 'admin' ELSE 'member' END)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (v_team, NEW.id, CASE WHEN v_first THEN 'owner' ELSE 'va' END)
  ON CONFLICT (team_id, user_id) DO NOTHING;

  IF v_first THEN
    UPDATE public.teams SET created_by = NEW.id WHERE id = v_team AND created_by IS NULL;
  END IF;

  RETURN NEW;
END;
$function$;

update public.team_members set role = 'va' where role = 'member';
