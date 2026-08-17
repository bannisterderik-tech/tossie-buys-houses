-- ============================================================================
-- Magic-link sign-in, closed to everyone but a named list.
-- ============================================================================
-- Magic link means there is no password anywhere in this system: not in the
-- database, not in a password manager, not in a screenshot of a setup doc. The
-- credential is a single-use link sent to an address we already trust.
--
-- The tradeoff is that magic link wants `shouldCreateUser: true` to be usable —
-- otherwise someone has to hand-create every user in the dashboard before they
-- can ever sign in. With that flag on, anybody who finds /app and types an
-- email would get an account, land on Tossie's team via handle_new_user(), and
-- see every seller's phone number.
--
-- So the allow-list is what makes `shouldCreateUser: true` safe. It is enforced
-- by a trigger on auth.users, which means it holds no matter how the signup was
-- attempted — the app, curl against the auth API, or a future SDK call that
-- forgets to check.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.allowed_signups (
  email      text PRIMARY KEY,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allowed_signups_email_is_lower CHECK (email = lower(email))
);

COMMENT ON TABLE public.allowed_signups IS
  'Who may create an account. Enforced by a trigger on auth.users, so it cannot be bypassed by calling the auth API directly. Add a row before onboarding someone.';

ALTER TABLE public.allowed_signups ENABLE ROW LEVEL SECURITY;

-- Owner-only, and never readable by anon: this list is a list of the people
-- worth phishing.
DROP POLICY IF EXISTS allowed_signups_owner_all ON public.allowed_signups;
CREATE POLICY allowed_signups_owner_all ON public.allowed_signups
  FOR ALL TO authenticated
  USING (public.is_team_owner('70551e00-0000-4000-8000-000000000001'))
  WITH CHECK (public.is_team_owner('70551e00-0000-4000-8000-000000000001'));

REVOKE ALL ON public.allowed_signups FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.allowed_signups TO authenticated;

-- ── the gate ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_signup_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.allowed_signups WHERE email = lower(NEW.email)
  ) THEN
    RAISE EXCEPTION 'Address % is not authorized for this workspace', NEW.email
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_signup_allowlist() FROM PUBLIC, anon, authenticated;

-- BEFORE, so a rejected signup never creates the auth row at all. It has to run
-- before on_auth_user_created, which is AFTER and would otherwise have already
-- put the stranger on the team.
DROP TRIGGER IF EXISTS on_auth_user_allowlist ON auth.users;
CREATE TRIGGER on_auth_user_allowlist
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_signup_allowlist();

-- ── seed ────────────────────────────────────────────────────────────────────
-- Tossie's business address and Derik's, because those are the two known to be
-- real today. Anyone else is added by an owner from inside the app.
INSERT INTO public.allowed_signups (email, note) VALUES
  ('info@tossiebuyshouses.com', 'Tossie — business address from data/business.json'),
  ('bannisterderik@gmail.com',  'Derik — build access')
ON CONFLICT (email) DO NOTHING;
