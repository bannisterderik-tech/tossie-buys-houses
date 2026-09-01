-- A webhook lead is consented and gets worked immediately.
--
-- TWO SETTINGS PER SOURCE, because they are two different claims.
--
--   consent_basis   Why this vendor's leads are consented, in the operator's
--                   own words. Not a boolean. ingest_lead_from_source already
--                   refuses to grant opt-in on a bare claim — it wants
--                   disclosure text and a timestamp, and it is right to. Most
--                   vendors post neither. So the operator states the basis
--                   once, and it is recorded onto every lead from that source
--                   as the disclosure. That is evidence somebody signed their
--                   name to, which is the thing a bare `true` is not.
--
--   auto_sdr        Whether a lead from here starts a conversation on arrival.
--                   Off by default: a source posting a hundred a day should be
--                   a deliberate decision, not a side effect of being created.
--
-- The grace window still applies. The SDR does not speak the instant a lead
-- lands; it waits out sdr_settings.grace_period_seconds so a human can claim it
-- first. Speed to lead is the point, but so is not texting somebody two seconds
-- after they hit submit, which reads as a robot and is exactly what it is.
alter table public.lead_sources
  add column if not exists consent_basis text,
  add column if not exists auto_sdr      boolean not null default false;

comment on column public.lead_sources.consent_basis is
  'Why leads from this source are consented, in the operator''s words. Recorded onto each lead as tcpa_disclosure_text. Empty means leads arrive cold.';
comment on column public.lead_sources.auto_sdr is
  'Start an SDR conversation the moment a lead arrives from this source.';

/**
 * Grant consent and open the conversation, for leads that arrived over a
 * webhook from a source configured for both.
 *
 * AFTER INSERT rather than BEFORE, because it needs the lead's id to write the
 * conversation, and because nothing here changes the lead row that the enrich
 * trigger already shaped.
 *
 * Deliberately narrow: source = 'vendor' only. A lead typed in by hand, or
 * imported from a CSV, does not acquire consent because some other source is
 * configured to.
 */
create or replace function public.apply_source_policy_to_lead()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  v_src     public.lead_sources;
  v_settings public.sdr_settings;
  v_persona uuid;
  v_grace   int;
BEGIN
  IF NEW.source IS DISTINCT FROM 'vendor' OR NEW.source_detail IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_src FROM public.lead_sources
   WHERE slug = NEW.source_detail AND team_id = NEW.team_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- ── consent ─────────────────────────────────────────────────────────────
  -- Only when the operator has written a basis, and only when the lead did not
  -- already carry real per-payload evidence — that is better than a standing
  -- statement and must not be overwritten by one.
  IF nullif(btrim(coalesce(v_src.consent_basis, '')), '') IS NOT NULL
     AND NOT NEW.tcpa_opt_in THEN
    UPDATE public.leads SET
      tcpa_opt_in             = true,
      tcpa_opt_in_at          = coalesce(tcpa_opt_in_at, now()),
      tcpa_disclosure_text    = coalesce(tcpa_disclosure_text, v_src.consent_basis),
      tcpa_disclosure_source  = coalesce(tcpa_disclosure_source, v_src.name),
      tcpa_disclosure_version = coalesce(tcpa_disclosure_version, 'source-basis-v1'),
      consent_sms             = true,
      consent_email           = true,
      -- Somebody who just filled in a form is not a cold lead.
      temperature             = CASE WHEN temperature = 'cold' THEN 'warm' ELSE temperature END
    WHERE id = NEW.id;

    INSERT INTO public.lead_activity (team_id, lead_id, actor_kind, type, summary, payload)
    VALUES (NEW.team_id, NEW.id, 'system', 'consent_recorded',
            'Consent recorded from ' || v_src.name || ' — ' || v_src.consent_basis,
            jsonb_build_object('source_slug', v_src.slug, 'basis', 'source_level'));
  END IF;

  -- ── the SDR ─────────────────────────────────────────────────────────────
  IF NOT v_src.auto_sdr THEN RETURN NULL; END IF;

  SELECT * INTO v_settings FROM public.sdr_settings WHERE team_id = NEW.team_id;
  IF NOT FOUND OR NOT v_settings.enabled THEN RETURN NULL; END IF;

  SELECT id INTO v_persona FROM public.sdr_personas
   WHERE team_id = NEW.team_id AND is_default AND active LIMIT 1;

  UPDATE public.leads
     SET sdr_enabled = true,
         sdr_persona_id = coalesce(sdr_persona_id, v_persona)
   WHERE id = NEW.id;

  -- The conversation is what check_grace looks for. Without this row a lead is
  -- enrolled and nothing ever picks it up, which is the exact bug that made
  -- enrolling appear to do nothing.
  v_grace := coalesce(v_settings.grace_period_seconds, 120);

  INSERT INTO public.sdr_conversations (team_id, lead_id, step, mode, grace_until, next_action_at)
  SELECT NEW.team_id, NEW.id, 'pending',
         coalesce(v_settings.default_mode, 'draft'),
         now() + make_interval(secs => v_grace),
         now() + make_interval(secs => v_grace)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.sdr_conversations c WHERE c.lead_id = NEW.id AND c.active
  );

  INSERT INTO public.lead_activity (team_id, lead_id, actor_kind, type, summary, payload)
  VALUES (NEW.team_id, NEW.id, 'system', 'sdr_enrolled',
          'Put on the AI SDR on arrival — first message in ' || v_grace || 's unless somebody claims it',
          jsonb_build_object('source_slug', v_src.slug, 'grace_seconds', v_grace));

  RETURN NULL;
END;
$$;

revoke execute on function public.apply_source_policy_to_lead() from public, anon, authenticated;

drop trigger if exists trg_apply_source_policy on public.leads;
create trigger trg_apply_source_policy
  after insert on public.leads
  for each row execute function public.apply_source_policy_to_lead();

comment on function public.apply_source_policy_to_lead() is
  'Applies a webhook source''s consent basis and auto-SDR setting to a lead that just arrived from it.';
