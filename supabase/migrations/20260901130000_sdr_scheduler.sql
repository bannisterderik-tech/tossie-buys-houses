-- The SDR had no clock.
--
-- ai-sdr has carried check_grace and run_drip since it shipped, both marked
-- "cron only", and nothing has ever called them -- there was no scheduler on
-- this project at all. So the SDR could hold a conversation a seller started
-- but could never start one itself, and the drip intervals in sdr_settings
-- (24/48/96/168h) described follow-ups that were never going to be sent. One
-- conversation has been sitting with next_action_at in the past since
-- 2026-08-20 with nothing to pick it up.
--
-- This is the clock. Two jobs:
--
--   check_grace  every minute. A lead is enrolled, the grace window passes
--                without a human claiming it, and the SDR speaks. This is the
--                job that sends the FIRST message -- the one that makes
--                enrolling a lead mean anything.
--   run_drip     every fifteen minutes. Follow-ups on the interval ladder.
--                Nothing is due more often than daily, so a quarter-hour of
--                latency costs nothing and cuts the invocation count by 15x.
--
-- ── ON THE CREDENTIAL ────────────────────────────────────────────────────
-- ai-sdr gates both actions on `bearer === SERVICE_ROLE_KEY`, so the caller
-- has to present the service key. That key is NOT written into the cron job
-- body, where it would sit in cron.job in plain text for anyone with database
-- access to read. It is read from Vault at call time instead.
--
-- Which means these jobs are inert until somebody puts the key there. That is
-- deliberate: arming automated outbound SMS to homeowners should be an act,
-- not a side effect of running a migration. The function logs a warning and
-- returns rather than raising, so an unarmed schedule is quiet in the logs
-- instead of failing loudly every sixty seconds.
create extension if not exists pg_cron;
create extension if not exists pg_net;

/**
 * One tick. Posts an action to ai-sdr with the service credential from Vault.
 *
 * SECURITY DEFINER because vault.decrypted_secrets is not readable by the role
 * pg_cron runs jobs as, and EXECUTE is revoked from every application role --
 * this is reachable from the scheduler and from nowhere else. A signed-in user
 * who could call it would be able to trigger a fleet-wide outbound sweep on
 * somebody else's schedule, which is exactly what ai-sdr's own `cron_only`
 * check exists to prevent.
 */
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
    -- Unarmed. A warning once a minute is noise; this is the one place it is
    -- worth it, because the alternative is an SDR that silently never runs and
    -- nobody can tell why.
    RAISE WARNING 'sdr_cron_tick(%): no sdr_cron_service_key in Vault — the AI SDR is not armed', p_action;
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

-- Idempotent: unschedule by name first so re-running this migration does not
-- stack duplicate jobs, which is how a sweep ends up running twice a minute.
select cron.unschedule('sdr-check-grace') where exists (select 1 from cron.job where jobname = 'sdr-check-grace');
select cron.unschedule('sdr-run-drip')    where exists (select 1 from cron.job where jobname = 'sdr-run-drip');

select cron.schedule('sdr-check-grace', '* * * * *',    $cron$select public.sdr_cron_tick('check_grace')$cron$);
select cron.schedule('sdr-run-drip',    '*/15 * * * *', $cron$select public.sdr_cron_tick('run_drip')$cron$);

comment on function public.sdr_cron_tick(text) is
  'Scheduler entry point for the AI SDR. Reads the service credential from Vault (secret name: sdr_cron_service_key); inert and warns if it is absent.';
