-- ============================================================================
-- Phase 0 hardening — function exposure and realtime.
-- ============================================================================
-- Both of these were found by running the build against a real Supabase rather
-- than the local test harness, which is why they are a third migration instead
-- of edits to the first two.
--
-- 1. Postgres grants EXECUTE on every new function to PUBLIC, and Supabase
--    publishes public-schema functions as REST endpoints. That left five
--    SECURITY DEFINER functions callable at /rest/v1/rpc/<name> — including
--    three trigger functions nothing outside a trigger should ever call.
--    `get_advisors` flagged all ten combinations.
--
-- 2. Realtime is opt-in per table. The leads list subscribes to changes so a
--    lead submitted on the website appears without a refresh; without the
--    publication that subscription connects, succeeds, and delivers nothing —
--    a silent failure with no error to notice.
-- ============================================================================

-- ── trigger functions: callable by nobody ───────────────────────────────────
-- These run as the table owner when a trigger fires, which does not consult
-- EXECUTE grants, so revoking costs nothing and closes the endpoint.
REVOKE ALL ON FUNCTION public.handle_new_user()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_lead_status_change()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_new_lead_on_pipeline() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_updated_at()           FROM PUBLIC, anon, authenticated;

-- ── RLS helpers: signed-in users only ───────────────────────────────────────
-- Postgres evaluates RLS policy expressions as the querying role, so
-- `authenticated` MUST keep EXECUTE on anything a policy calls — revoking it
-- would make every policy error instead of merely denying. Both functions
-- return only facts about the caller's own membership, so the grant is safe,
-- and it is the one advisor warning left standing on purpose.
-- `anon` never satisfies a policy in the first place and keeps nothing.
REVOKE ALL ON FUNCTION public.get_my_team_id()        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_team_owner(uuid)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_team_id()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_team_owner(uuid)  TO authenticated;

-- ── pure helpers: readable by signed-in users ───────────────────────────────
REVOKE ALL ON FUNCTION public.phone_key(text)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lead_is_dialable(public.leads) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phone_key(text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.lead_is_dialable(public.leads) TO authenticated;

-- ── realtime ────────────────────────────────────────────────────────────────
-- Guarded so re-running is a no-op; ALTER PUBLICATION ADD errors on duplicates.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['leads', 'lead_activity']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
