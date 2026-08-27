-- The scheduler was armed with the placeholder from the instructions.
--
-- The Vault secret came back 21 characters long, which is exactly the length
-- of the literal string YOUR_SERVICE_ROLE_KEY, and every tick since has been
-- getting 401 UNAUTHORIZED_INVALID_JWT_FORMAT from the function. Nothing sent,
-- nothing broke — but it would have gone on failing once a minute forever,
-- filling net._http_response with 401s, and the only symptom visible from the
-- app would have been an SDR that quietly never spoke.
--
-- That is the same failure the "no secret at all" branch below already guards
-- against, and it deserves the same treatment: say what is wrong, in words,
-- once per tick, and do not send a request that cannot succeed.
--
-- A service role key is a JWT — three base64url segments separated by dots,
-- a couple of hundred characters. The check is deliberately shape-only. It
-- cannot tell a valid key from an expired one (only the function can), but it
-- catches every version of "that is not a key", which is the mistake people
-- actually make.
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

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'sdr_cron_service_key'
   LIMIT 1;

  IF v_key IS NULL OR btrim(v_key) = '' THEN
    RAISE WARNING 'sdr_cron_tick(%): no sdr_cron_service_key in Vault — the AI SDR is not armed', p_action;
    RETURN;
  END IF;

  -- Shape, not validity. Catches the placeholder, a truncated paste, the anon
  -- key by mistake, and anything else that is not a JWT at all.
  IF v_key !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    RAISE WARNING
      'sdr_cron_tick(%): sdr_cron_service_key is not a JWT (% chars) — it looks like a placeholder rather than the service role key. The AI SDR is NOT armed.',
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

/**
 * Is the SDR actually armed, and if not, why not.
 *
 * Readable from the app so the answer is on a screen instead of in a log
 * nobody opens. It returns the SHAPE of the credential and never the
 * credential: length and whether it parses as a JWT, which is everything
 * needed to diagnose this and nothing that could leak the key.
 */
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

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'sdr_cron_service_key' LIMIT 1;
  v_len := coalesce(length(v_key), 0);

  SELECT count(*)::int INTO jobs FROM cron.job WHERE jobname IN ('sdr-check-grace','sdr-run-drip') AND active;

  SELECT r.status_code, r.created INTO last_status, last_checked
    FROM net._http_response r ORDER BY r.created DESC LIMIT 1;

  IF v_key IS NULL OR btrim(coalesce(v_key,'')) = '' THEN
    armed := false;
    reason := 'No credential in Vault. The scheduler runs but every tick returns without calling the SDR.';
  ELSIF v_key !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    armed := false;
    reason := format(
      'The stored credential is %s characters and is not a JWT — it looks like the placeholder text rather than the service role key.',
      v_len);
  ELSIF jobs < 2 THEN
    armed := false;
    reason := 'The credential is in place but the schedule is not running.';
  ELSE
    armed := true;
    reason := 'Armed. Enrolled leads get their first message once the grace window passes.';
  END IF;

  RETURN NEXT;
END;
$$;

revoke execute on function public.sdr_scheduler_status() from public, anon;
grant  execute on function public.sdr_scheduler_status() to authenticated;
