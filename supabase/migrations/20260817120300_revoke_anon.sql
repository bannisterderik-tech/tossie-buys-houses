-- ============================================================================
-- Defense in depth on the public anon key.
-- ============================================================================
-- Every table already has RLS on and no policy names `anon`, so anon reads
-- zero rows today. But Supabase grants anon table-level SELECT/INSERT/UPDATE/
-- DELETE by default, which means the *only* thing standing between the public
-- browser key and seller PII is that no policy has been written for anon.
-- One future `FOR ALL TO public` policy — an easy thing to type by accident —
-- and the grant becomes the difference between a leak and a denial.
--
-- Nothing anon does needs the public schema: sign-in hits the auth schema, and
-- website lead capture goes through api/lead.js on the service role.
-- ============================================================================

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM anon;

-- And for anything a later migration creates.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES  FROM anon;
