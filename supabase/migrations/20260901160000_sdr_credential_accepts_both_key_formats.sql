-- This project is on Supabase's new API key system: get_publishable_keys
-- returns both a legacy `anon` JWT and an `sb_publishable_…` key. Which means
-- there are two possible shapes for a secret credential, and the validator I
-- wrote only recognised one of them.
--
-- The legacy service_role JWT is now in Vault and is provably the right key for
-- the right project — role=service_role, ref=fvkxdhuwfjnsvkjjordm, expiring
-- 2036 — and ai-sdr still answers {"error":"unauthorized"}. That function
-- authenticates by exact string comparison against its own
-- SUPABASE_SERVICE_ROLE_KEY, so the only thing that failure can mean is that
-- the value the platform injects is not this JWT. On a new-key project that is
-- the `sb_secret_…` key.
--
-- So the shape check now accepts either form. It still refuses a placeholder,
-- a truncated paste, or anything that is neither -- the point of the check was
-- never the format, it was catching text that is not a credential at all.
create or replace function public.sdr_credential_looks_valid(v text)
returns boolean
language sql
immutable
as $$
  SELECT v IS NOT NULL AND (
    -- legacy: a JWT, three base64url segments
    v ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    -- current: sb_secret_… (and sb_publishable_… so a wrong-key paste is
    -- reported by the function's own answer rather than silently refused here)
    OR v ~ '^sb_(secret|publishable)_[A-Za-z0-9_-]{10,}$'
  );
$$;

create or replace function public.sdr_cron_tick(p_action text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'vault', 'pg_catalog'
as $$
DECLARE
  v_key text;
  v_url text := 'https://fvkxdhuwfjnsvkjjordm.supabase.co/functions/v1/ai-sdr';
BEGIN
  IF p_action NOT IN ('check_grace', 'run_drip') THEN
    RAISE EXCEPTION 'sdr_cron_tick refuses %', p_action USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_key := public.sdr_credential();

  IF v_key IS NULL OR btrim(v_key) = '' THEN
    RAISE WARNING 'sdr_cron_tick(%): no sdr_cron_service_key in Vault — the AI SDR is not armed', p_action;
    RETURN;
  END IF;

  IF NOT public.sdr_credential_looks_valid(v_key) THEN
    RAISE WARNING
      'sdr_cron_tick(%): sdr_cron_service_key is neither a JWT nor an sb_secret_ key (% chars) — the AI SDR is NOT armed.',
      p_action, length(v_key);
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object('action', p_action),
    timeout_milliseconds := 25000
  );
END;
$$;

revoke execute on function public.sdr_cron_tick(text) from public, anon, authenticated;

create or replace function public.sdr_scheduler_status()
returns table(armed boolean, reason text, jobs int, last_status int, last_checked timestamptz)
language plpgsql
security definer
set search_path to 'public', 'extensions', 'vault', 'cron', 'net', 'pg_catalog'
as $$
DECLARE
  v_key text;
  v_len int;
BEGIN
  IF NOT public.has_capability('sdr.manage') THEN
    RAISE EXCEPTION 'You do not have permission to read the AI SDR schedule'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_key := public.sdr_credential();
  v_len := coalesce(length(v_key), 0);

  SELECT count(*)::int INTO jobs FROM cron.job WHERE jobname IN ('sdr-check-grace','sdr-run-drip') AND active;

  SELECT r.status_code, r.created INTO last_status, last_checked
    FROM net._http_response r ORDER BY r.created DESC LIMIT 1;

  IF v_key IS NULL OR btrim(coalesce(v_key,'')) = '' THEN
    armed := false;
    reason := 'No credential in Vault. The scheduler runs but every tick returns without calling the SDR.';
  ELSIF NOT public.sdr_credential_looks_valid(v_key) THEN
    armed := false;
    reason := format(
      'The stored credential is %s characters and is neither a JWT nor an sb_secret_ key — it looks like placeholder text.',
      v_len);
  ELSIF jobs < 2 THEN
    armed := false;
    reason := 'The credential is in place but the schedule is not running.';
  ELSIF last_status IS NOT NULL AND last_status >= 400 THEN
    armed := false;
    reason := format(
      'The credential is well formed but the SDR rejected the last call with %s. This project uses Supabase''s new API keys, so the one the function expects is the Secret key (sb_secret_…) from Project Settings → API Keys, not the legacy service_role JWT.',
      last_status);
  ELSE
    armed := true;
    reason := 'Armed. Enrolled leads get their first message once the grace window passes.';
  END IF;

  RETURN NEXT;
END;
$$;

revoke execute on function public.sdr_scheduler_status() from public, anon;
grant  execute on function public.sdr_scheduler_status() to authenticated;
