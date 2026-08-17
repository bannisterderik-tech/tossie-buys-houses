-- ============================================================================
-- Phase 0 — foundation: tenancy, auth profiles, RLS helpers.
-- ============================================================================
-- Tossie is a single business, but the schema keeps reoperative's team_id
-- shape so ported code lands unmodified. Exactly one team row is seeded and
-- every profile joins it by default. See docs/BUILD_PLAN.md §8.
-- ============================================================================

-- The one team. Fixed UUID so seeds, fixtures and edge functions can hardcode
-- it without a lookup.
-- Tossie: 70551e00-0000-4000-8000-000000000001
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── updated_at helper ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── teams ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Owner-gated kill switches. These are deliberately on the team, not on a
  -- config blob, so RLS can restrict who flips them.
  sdr_auto_send_approved  boolean NOT NULL DEFAULT false,
  sms_send_disabled       boolean NOT NULL DEFAULT false,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.teams.sdr_auto_send_approved IS
  'Second half of the SDR auto-send gate. Auto-send requires resolved mode = auto AND this flag. UPDATE is owner-only by RLS.';
COMMENT ON COLUMN public.teams.sms_send_disabled IS
  'Kill switch. When true the send path refuses every outbound SMS regardless of caller.';

-- ── profiles (1:1 with auth.users) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  email       text,
  full_name   text,
  phone       text,
  app_role    text NOT NULL DEFAULT 'member',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_app_role_check CHECK (app_role IN ('admin', 'member'))
);

CREATE INDEX IF NOT EXISTS profiles_team_id_idx ON public.profiles(team_id);

-- ── team_members ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.team_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_members_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT team_members_team_user_unique UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_members_user_id_idx ON public.team_members(user_id);

-- ── RLS helpers ─────────────────────────────────────────────────────────────
-- Ported from reoperative, minus the agency `acting_as_team_id` impersonation
-- branch — there is no agency hierarchy here.

CREATE OR REPLACE FUNCTION public.get_my_team_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT p.team_id FROM public.profiles p WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_team_owner(check_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = check_team_id AND created_by = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.team_members
    WHERE team_id = check_team_id AND user_id = auth.uid() AND role = 'owner'
  );
$$;

-- ── new-user handling ───────────────────────────────────────────────────────
-- Every signup lands on the one team. When Tossie is multi-tenant this becomes
-- an invite lookup; today it is a constant.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_team uuid := '70551e00-0000-4000-8000-000000000001';
  v_first boolean;
BEGIN
  -- The first human to sign up owns the team.
  SELECT NOT EXISTS (SELECT 1 FROM public.team_members WHERE team_id = v_team)
    INTO v_first;

  INSERT INTO public.profiles (id, team_id, email, full_name, app_role)
  VALUES (
    NEW.id,
    v_team,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email),
    CASE WHEN v_first THEN 'admin' ELSE 'member' END
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (v_team, NEW.id, CASE WHEN v_first THEN 'owner' ELSE 'member' END)
  ON CONFLICT (team_id, user_id) DO NOTHING;

  IF v_first THEN
    UPDATE public.teams SET created_by = NEW.id
      WHERE id = v_team AND created_by IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── seed the one team ───────────────────────────────────────────────────────
INSERT INTO public.teams (id, name)
VALUES ('70551e00-0000-4000-8000-000000000001', 'Tossie Buys Houses')
ON CONFLICT (id) DO NOTHING;

-- ── triggers ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS teams_touch ON public.teams;
CREATE TRIGGER teams_touch BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS profiles_touch ON public.profiles;
CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.teams        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_select ON public.teams;
CREATE POLICY teams_select ON public.teams
  FOR SELECT TO authenticated
  USING (id = public.get_my_team_id());

-- Owner-only UPDATE. This is what makes sdr_auto_send_approved a real gate
-- rather than a checkbox any member can tick.
DROP POLICY IF EXISTS teams_update_owner ON public.teams;
CREATE POLICY teams_update_owner ON public.teams
  FOR UPDATE TO authenticated
  USING (public.is_team_owner(id))
  WITH CHECK (public.is_team_owner(id));

DROP POLICY IF EXISTS profiles_select_team ON public.profiles;
CREATE POLICY profiles_select_team ON public.profiles
  FOR SELECT TO authenticated
  USING (team_id = public.get_my_team_id());

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS team_members_select ON public.team_members;
CREATE POLICY team_members_select ON public.team_members
  FOR SELECT TO authenticated
  USING (team_id = public.get_my_team_id());
