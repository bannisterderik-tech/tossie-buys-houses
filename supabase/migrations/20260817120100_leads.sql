-- ============================================================================
-- Phase 0 — the leads table and the pipeline it moves through.
-- ============================================================================
-- Reoperative's central lead object is `lead_watch_events`: a retail-agent
-- shaped table carrying buyer preapproval, MLS, CMA and Follow Up Boss sync
-- columns. None of that applies to a wholesaler, so this is a clean table
-- under a clean name.
--
-- PORTING NOTE: ported edge functions reference `lead_watch_events`. The
-- rename is a mechanical find/replace at port time:
--   lead_watch_events -> leads
--   lead_name/lead_phone/lead_email -> name/phone/email
-- Doing it once here beats living with the old name for years.
-- ============================================================================

-- ── leads ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leads (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id   uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Seller
  name            text,
  phone           text,
  email           text,
  email_secondary text,
  co_contact_name         text,
  co_contact_phone        text,
  co_contact_relationship text,

  -- Subject property
  address   text,
  city      text,
  state     text,
  zip       text,
  county    text,
  property_type text,
  beds      numeric(4,1),
  baths     numeric(4,1),
  sqft      integer,
  year_built integer,

  -- Owner record (populated from lists / skip trace, may differ from contact)
  owner_name      text,
  owner_type      text,
  owner_occupied  boolean,
  mailing_address text,
  mailing_city    text,
  mailing_state   text,
  mailing_zip     text,

  -- The wholesaler's qualifying facts. Free text where a seller's words matter
  -- more than a taxonomy; enumerated where the pipeline needs to filter.
  motivation        text,
  timeline          text,
  condition_notes   text,
  repairs_needed    text,
  occupancy         text,
  asking_price      integer,
  arv_estimate      integer,
  repair_estimate   integer,
  mortgage_balance  integer,
  has_liens         boolean,
  already_listed    boolean,
  under_contract_elsewhere boolean,

  -- Distress signals (from list data; see cold_call_leads in Phase 1.5)
  is_absentee     boolean NOT NULL DEFAULT false,
  is_out_of_state boolean NOT NULL DEFAULT false,
  pre_foreclosure boolean NOT NULL DEFAULT false,
  tax_delinquent  boolean NOT NULL DEFAULT false,
  vacant          boolean NOT NULL DEFAULT false,

  -- Routing / triage
  source        text NOT NULL DEFAULT 'website',
  source_detail text,
  temperature   text NOT NULL DEFAULT 'warm',
  status        text NOT NULL DEFAULT 'new',
  assigned_to   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  notes         text,

  -- Contact history
  first_contact_at  timestamptz,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  call_attempts     integer NOT NULL DEFAULT 0,

  -- Skip trace (Phase 1.5 populates these; the dialer reads them)
  skip_traced       boolean NOT NULL DEFAULT false,
  skip_traced_at    timestamptz,
  skip_trace_confidence integer,
  phone_mobile      text,
  phone_landline    text,
  phone_voip        text,
  phone_line_type   text,
  phone_sms_eligible boolean,

  -- Compliance. dnc_scrubbed is separate from skip_traced on purpose: a lead
  -- can be traced and still not be scrubbed, and only the scrubbed ones are
  -- dialable. See docs/BUILD_PLAN.md §5.
  consent_sms       boolean NOT NULL DEFAULT false,
  consent_email     boolean NOT NULL DEFAULT false,
  tcpa_opt_in       boolean NOT NULL DEFAULT false,
  tcpa_opt_in_at    timestamptz,
  tcpa_disclosure_text    text,
  tcpa_disclosure_version text,
  tcpa_disclosure_source  text,
  tcpa_disclosure_ip      inet,
  dnc_scrubbed      boolean NOT NULL DEFAULT false,
  dnc_scrubbed_at   timestamptz,
  is_dnc            boolean NOT NULL DEFAULT false,
  is_litigator      boolean NOT NULL DEFAULT false,

  -- Capture provenance (website form)
  page_path  text,
  referrer   text,
  user_agent text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  trashed    boolean NOT NULL DEFAULT false,
  trashed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leads_temperature_check CHECK (temperature IN ('hot', 'warm', 'cold', 'dead')),
  CONSTRAINT leads_status_check CHECK (status IN (
    'new', 'attempting', 'contacted', 'qualified', 'appointment_set',
    'offer_made', 'under_contract', 'closed', 'nurture', 'dead'
  )),
  CONSTRAINT leads_occupancy_check CHECK (occupancy IS NULL OR occupancy IN (
    'owner', 'tenant', 'vacant', 'unknown'
  )),
  -- A lead has to be reachable somehow.
  CONSTRAINT leads_has_contact CHECK (
    phone IS NOT NULL OR email IS NOT NULL OR phone_mobile IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS leads_team_created_idx  ON public.leads(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_team_status_idx   ON public.leads(team_id, status) WHERE NOT trashed;
CREATE INDEX IF NOT EXISTS leads_assigned_idx      ON public.leads(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_follow_up_idx     ON public.leads(next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_tags_idx          ON public.leads USING gin(tags);

-- Phone lookup for inbound calls and inbound SMS.
--
-- Twilio hands the webhook E.164 (+19125550134); the seller typed
-- "(912) 555-0134" into the website form. Stripping non-digits is not enough —
-- those differ by the country code. Key on the last 10 digits so both forms
-- collide. US/CA only, which is the entire footprint.
CREATE OR REPLACE FUNCTION public.phone_key(v text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT NULLIF(right(regexp_replace(COALESCE(v, ''), '\D', '', 'g'), 10), '');
$$;

COMMENT ON FUNCTION public.phone_key IS
  'Last 10 digits of a US/CA number. The join key between Twilio webhooks and stored leads — always match on this, never on the raw column.';

CREATE INDEX IF NOT EXISTS leads_phone_key_idx
  ON public.leads(public.phone_key(phone)) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_phone_mobile_key_idx
  ON public.leads(public.phone_key(phone_mobile)) WHERE phone_mobile IS NOT NULL;

-- ── dialability ─────────────────────────────────────────────────────────────
-- The plan's Phase 1.5 rule, expressed once in the database so the dialer's
-- queue builder cannot forget it. Website leads that opted in are dialable
-- immediately; list leads are not dialable until traced AND scrubbed clean.
CREATE OR REPLACE FUNCTION public.lead_is_dialable(l public.leads)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT NOT l.trashed
     AND NOT l.is_dnc
     AND NOT l.is_litigator
     AND COALESCE(l.phone_mobile, l.phone) IS NOT NULL
     AND (
       -- inbound: the seller contacted us and accepted the disclosure
       (l.source = 'website' AND l.tcpa_opt_in)
       -- outbound: cold list, must be traced and scrubbed
       OR (l.skip_traced AND l.dnc_scrubbed)
     );
$$;

COMMENT ON FUNCTION public.lead_is_dialable IS
  'Single source of truth for "may we call this number". The dialer queue builder must filter on this, not on UI state. TCPA damages are $500-$1,500 per call.';

-- ── pipelines ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pipelines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pipeline_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    integer NOT NULL,
  color       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_position_unique UNIQUE (pipeline_id, position)
);

CREATE TABLE IF NOT EXISTS public.lead_pipeline_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  stage_id    uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_pipeline_unique UNIQUE (lead_id, pipeline_id)
);

CREATE INDEX IF NOT EXISTS lead_pipeline_stage_idx ON public.lead_pipeline_memberships(stage_id);

-- ── notes, tasks, activity ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  lead_id    uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_notes_lead_idx ON public.lead_notes(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lead_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due_at      timestamptz,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_tasks_open_idx
  ON public.lead_tasks(team_id, due_at) WHERE completed_at IS NULL;

-- Append-only. Everything that happens to a lead lands here, and the detail
-- panel's timeline is one query against it.
CREATE TABLE IF NOT EXISTS public.lead_activity (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  lead_id    uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'system',
  type       text NOT NULL,
  summary    text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_activity_actor_kind_check CHECK (actor_kind IN ('user', 'system', 'ai'))
);

CREATE INDEX IF NOT EXISTS lead_activity_lead_idx ON public.lead_activity(lead_id, created_at DESC);

-- ── triggers ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS leads_touch ON public.leads;
CREATE TRIGGER leads_touch BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Status changes write themselves into the timeline. No caller can forget.
CREATE OR REPLACE FUNCTION public.log_lead_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
    VALUES (
      NEW.team_id, NEW.id, auth.uid(),
      CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END,
      'status_changed',
      OLD.status || ' -> ' || NEW.status,
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_log_status ON public.leads;
CREATE TRIGGER leads_log_status AFTER UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.log_lead_status_change();

-- Every new lead lands on the default pipeline's first stage. In the trigger
-- rather than in the callers, so the website form, CSV import, the SDR and
-- anything built later all get board placement without remembering to ask.
CREATE OR REPLACE FUNCTION public.place_new_lead_on_pipeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_pipeline uuid;
  v_stage    uuid;
BEGIN
  SELECT id INTO v_pipeline FROM public.pipelines
   WHERE team_id = NEW.team_id AND is_default LIMIT 1;

  IF v_pipeline IS NULL THEN
    RETURN NEW;  -- no default pipeline configured; nothing to place onto
  END IF;

  SELECT id INTO v_stage FROM public.pipeline_stages
   WHERE pipeline_id = v_pipeline ORDER BY position LIMIT 1;

  INSERT INTO public.lead_pipeline_memberships (lead_id, pipeline_id, stage_id)
  VALUES (NEW.id, v_pipeline, v_stage)
  ON CONFLICT (lead_id, pipeline_id) DO NOTHING;

  INSERT INTO public.lead_activity (team_id, lead_id, actor_kind, type, summary, payload)
  VALUES (NEW.team_id, NEW.id, 'system', 'lead_created',
          'Lead created from ' || NEW.source,
          jsonb_build_object('source', NEW.source, 'page_path', NEW.page_path));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_place_on_pipeline ON public.leads;
CREATE TRIGGER leads_place_on_pipeline AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.place_new_lead_on_pipeline();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- One policy shape, applied to every team-scoped table. The service role
-- bypasses RLS entirely, which is how api/lead.js inserts website leads.
ALTER TABLE public.leads                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_pipeline_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_notes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_tasks                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_activity             ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads', 'pipelines', 'lead_notes', 'lead_tasks', 'lead_activity']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_team_all ON public.%I', t, t);
    EXECUTE format($p$
      CREATE POLICY %I_team_all ON public.%I
        FOR ALL TO authenticated
        USING (team_id = public.get_my_team_id())
        WITH CHECK (team_id = public.get_my_team_id())
    $p$, t, t);
  END LOOP;
END $do$;

-- These two have no team_id of their own; they inherit through the parent.
DROP POLICY IF EXISTS pipeline_stages_team_all ON public.pipeline_stages;
CREATE POLICY pipeline_stages_team_all ON public.pipeline_stages
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pipelines p
                 WHERE p.id = pipeline_id AND p.team_id = public.get_my_team_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pipelines p
                      WHERE p.id = pipeline_id AND p.team_id = public.get_my_team_id()));

DROP POLICY IF EXISTS lead_pipeline_memberships_team_all ON public.lead_pipeline_memberships;
CREATE POLICY lead_pipeline_memberships_team_all ON public.lead_pipeline_memberships
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads l
                 WHERE l.id = lead_id AND l.team_id = public.get_my_team_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.leads l
                      WHERE l.id = lead_id AND l.team_id = public.get_my_team_id()));

-- ── seed the default pipeline ───────────────────────────────────────────────
INSERT INTO public.pipelines (id, team_id, name, is_default)
VALUES (
  '70551e00-0000-4000-8000-000000000010',
  '70551e00-0000-4000-8000-000000000001',
  'Acquisitions',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pipeline_stages (pipeline_id, name, position, color)
VALUES
  ('70551e00-0000-4000-8000-000000000010', 'New',             1, '#6a6a6a'),
  ('70551e00-0000-4000-8000-000000000010', 'Attempting',      2, '#1a4485'),
  ('70551e00-0000-4000-8000-000000000010', 'Contacted',       3, '#1a4485'),
  ('70551e00-0000-4000-8000-000000000010', 'Qualified',       4, '#f0b429'),
  ('70551e00-0000-4000-8000-000000000010', 'Appointment Set', 5, '#f0b429'),
  ('70551e00-0000-4000-8000-000000000010', 'Offer Made',      6, '#eb6a56'),
  ('70551e00-0000-4000-8000-000000000010', 'Under Contract',  7, '#0f9d58'),
  ('70551e00-0000-4000-8000-000000000010', 'Nurture',         8, '#6a6a6a'),
  ('70551e00-0000-4000-8000-000000000010', 'Dead',            9, '#b0b0b0')
ON CONFLICT (pipeline_id, position) DO NOTHING;
