-- Third time a placeholder delimiter has survived a paste in this project, so
-- the fix belongs in the reader rather than in the next set of instructions.
--
-- The service key arrived as <eyJ…> — the real 219-character JWT wrapped in
-- the angle brackets from the command it was pasted into. 221 characters, two
-- dots, no whitespace, and rejected by a validator that was right about the
-- shape and unhelpful about it. The value was correct; the packaging was not.
--
-- So the credential is now normalised on the way out of Vault: angle brackets,
-- quotes, backticks and surrounding whitespace are stripped before the shape
-- is checked and before it is sent. Those characters cannot legitimately
-- appear in a JWT, so removing them can only ever fix a paste and can never
-- corrupt a good key.
--
-- The shape check stays. This widens what counts as a correct paste; it does
-- not stop refusing something that is not a key at all.
create or replace function public.sdr_credential()
returns text
language sql
stable
security definer
set search_path to 'vault', 'pg_catalog'
as $$
  SELECT btrim(decrypted_secret, E'<>''"` \t\r\n')
    FROM vault.decrypted_secrets
   WHERE name = 'sdr_cron_service_key'
   LIMIT 1;
$$;

revoke execute on function public.sdr_credential() from public, anon, authenticated;

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
  ELSIF v_key !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    armed := false;
    reason := format(
      'The stored credential is %s characters and is not a JWT — it looks like the placeholder text rather than the service role key.',
      v_len);
  ELSIF jobs < 2 THEN
    armed := false;
    reason := 'The credential is in place but the schedule is not running.';
  ELSIF last_status IS NOT NULL AND last_status >= 400 THEN
    -- A well-formed key the function still rejects: rotated, revoked, or from
    -- another project. Shape cannot catch that; only the answer can.
    armed := false;
    reason := format(
      'The credential looks right but the SDR rejected the last call with %s. It may be from another project, or have been rotated.',
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
