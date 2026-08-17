-- Minimal stand-in for the pieces of Supabase's auth schema the migrations
-- touch, so the DDL can be applied against a plain Postgres for verification.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Supabase resolves this from the request JWT. Here it reads a session GUC so
-- tests can impersonate a user with: SET LOCAL request.jwt.claim.sub = '<uuid>';
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;

-- Supabase grants these; without them any SECURITY INVOKER function that calls
-- auth.uid() fails with "permission denied for schema auth" — which is a gap in
-- this stub, not in the migration under test.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;

-- Supabase ships this publication; realtime subscriptions read from it. The
-- hardening migration adds tables to it, so it has to exist here too or that
-- migration would be silently untested.
CREATE PUBLICATION supabase_realtime;
