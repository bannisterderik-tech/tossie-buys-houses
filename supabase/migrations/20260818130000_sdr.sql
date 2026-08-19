-- ============================================================================
-- Phase 4 — the AI SDR: config, conversation state, and the send ledger.
-- ============================================================================
-- The SDR is the only thing in this system that can talk to a homeowner without
-- a human in the loop, so the schema is shaped around three questions:
--
--   1. WHO decided to send this?      -> sdr_sends, one row per outbound turn
--   2. WHAT was said, in what order?  -> sdr_conversations.messages
--   3. COULD it have been sent?       -> sdr_settings + teams.sdr_auto_send_approved
--
-- The draft/auto gate itself lives in the edge function, at one choke point
-- every path funnels through. It is NOT duplicated here on purpose: two copies
-- of a rule that decides whether to text a stranger is two places for it to
-- drift. What the database contributes is the second half of the gate —
-- teams.sdr_auto_send_approved (20260817120000), whose UPDATE is owner-only by
-- RLS — so a member flipping sdr_settings.default_mode to 'auto' still cannot
-- put an unreviewed message on the wire.
--
-- Ported from reoperative's sdr_conversations + lock RPCs. The step machine is
-- rewritten: reoperative qualifies retail buyers and sellers for an agent
-- (intent -> area_property -> financial), Tossie qualifies motivated sellers
-- for a cash offer. See docs/BUILD_PLAN.md §3 Phase 4.
-- ============================================================================

-- ── team configuration ──────────────────────────────────────────────────────
-- One row, same shape as telephony_settings: the app reads settings instead of
-- branching on "no row yet" in a dozen places.
CREATE TABLE IF NOT EXISTS public.sdr_settings (
  team_id uuid PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Ships off. Turning the SDR on is a decision someone makes deliberately
  -- after reading drafts, not a default that arrives with a migration.
  enabled boolean NOT NULL DEFAULT false,

  -- Draft by default, always. Half of the auto-send gate; the other half is
  -- teams.sdr_auto_send_approved.
  default_mode text NOT NULL DEFAULT 'draft',
  personality  text NOT NULL DEFAULT 'balanced',

  -- How long a brand-new lead is held before the SDR speaks, so a human who is
  -- watching can claim it first. Two minutes is reoperative's default and it
  -- is the right order of magnitude: long enough to grab a hot inbound lead,
  -- short enough that the seller does not notice the pause.
  grace_period_seconds integer NOT NULL DEFAULT 120,

  -- Score at which the conversation stops being the AI's and becomes Tossie's.
  handoff_score integer NOT NULL DEFAULT 70,

  -- Follow-ups on a lead that went quiet, and the gaps between them in hours.
  max_drips integer NOT NULL DEFAULT 5,
  drip_intervals_hours integer[] NOT NULL DEFAULT '{24,48,96,168}',

  -- Channel gate. Email is off until a sending subdomain is authenticated
  -- (BUILD_PLAN §2) — an SDR that quietly starts cold-emailing from an
  -- unauthenticated domain costs the main domain its deliverability.
  sms_channel_enabled   boolean NOT NULL DEFAULT true,
  email_channel_enabled boolean NOT NULL DEFAULT false,

  -- No quiet-hours columns here on purpose. The 8am-9pm window belongs to the
  -- send path (twilio-send-sms, via _shared/calling-window.ts) and it is
  -- enforced there for every outbound text regardless of origin. A second copy
  -- of the window in a settings table that nothing reads would be a number an
  -- operator could change while believing it had an effect.

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sdr_settings_mode_check CHECK (default_mode IN ('draft', 'auto')),
  CONSTRAINT sdr_settings_personality_check CHECK (personality IN (
    'aggressive', 'balanced', 'supportive'
  )),
  CONSTRAINT sdr_settings_grace_check   CHECK (grace_period_seconds BETWEEN 0 AND 86400),
  CONSTRAINT sdr_settings_handoff_check CHECK (handoff_score BETWEEN 0 AND 100),
  CONSTRAINT sdr_settings_drips_check   CHECK (max_drips BETWEEN 0 AND 20)
);

DROP TRIGGER IF EXISTS sdr_settings_touch ON public.sdr_settings;
CREATE TRIGGER sdr_settings_touch BEFORE UPDATE ON public.sdr_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── conversations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sdr_conversations (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,

  -- The wholesaler qualification ladder. Every step is a question Tossie would
  -- ask on a live call, in the order he would ask it: why are you selling,
  -- when, what shape is it in, who is in it, what is owed, what number do you
  -- have in mind, who else has to sign, when can I come see it.
  --
  -- price_expectation is where the seller names a number. The SDR never does —
  -- see the guardrail in supabase/functions/ai-sdr/index.ts.
  step text NOT NULL DEFAULT 'pending',

  -- Resolved at creation and re-resolved every turn by the edge function. Kept
  -- on the row so the approval queue can show what WOULD have happened.
  mode    text NOT NULL DEFAULT 'draft',
  channel text NOT NULL DEFAULT 'sms',

  -- The seller's answers, keyed by step. jsonb rather than columns because the
  -- answers are the AI's reading of free text and belong next to the transcript
  -- until a human or a tool call promotes them onto leads.
  qualification_data jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The transcript as the model saw it: [{role, content, at, channel}]. This is
  -- the AI's working copy; sms_messages remains the record of what actually
  -- crossed the wire, and the two are reconciled by the send ledger below.
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Draft awaiting a human. The hash is what makes approval honest: the
  -- operator approves the exact words they read, and a draft regenerated in
  -- between fails the check instead of being sent unseen.
  pending_draft      text,
  pending_draft_at   timestamptz,
  pending_draft_hash text,

  -- Grace period and human claim.
  grace_until timestamptz,
  claimed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at  timestamptz,

  handoff_reason text,
  handed_off_at  timestamptz,
  handed_off_to  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  last_ai_message_at  timestamptz,
  last_lead_reply_at  timestamptz,

  drip_count integer NOT NULL DEFAULT 0,
  -- One column for "when should a worker look at this again", whether that is
  -- the grace period expiring, a drip coming due, or a send deferred out of
  -- quiet hours. Three columns for three reasons to wake up would be three
  -- queries and three ways to leave a conversation stranded.
  next_action_at timestamptz,

  score  integer,
  active boolean NOT NULL DEFAULT true,

  -- Worker lock. A conversation is claimed for the duration of one turn so two
  -- cron runners cannot both answer the same seller.
  processing_claim_id   uuid,
  processing_started_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sdr_conversations_step_check CHECK (step IN (
    'pending', 'greeting', 'motivation', 'timeline', 'condition', 'occupancy',
    'liens', 'price_expectation', 'decision_makers', 'appointment',
    'completed', 'handed_off', 'paused'
  )),
  CONSTRAINT sdr_conversations_mode_check    CHECK (mode IN ('draft', 'auto')),
  CONSTRAINT sdr_conversations_channel_check CHECK (channel IN ('sms', 'email')),
  CONSTRAINT sdr_conversations_score_check   CHECK (score IS NULL OR score BETWEEN 0 AND 100)
);

-- One live conversation per lead. Without this a lead that arrives twice (web
-- form plus a list import) gets two SDRs texting the same person in parallel.
CREATE UNIQUE INDEX IF NOT EXISTS sdr_conversations_one_active_idx
  ON public.sdr_conversations(lead_id) WHERE active;

CREATE INDEX IF NOT EXISTS sdr_conversations_due_idx
  ON public.sdr_conversations(next_action_at)
  WHERE active AND next_action_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS sdr_conversations_team_active_idx
  ON public.sdr_conversations(team_id, active);

-- The approval queue: every draft waiting on a human, newest first.
CREATE INDEX IF NOT EXISTS sdr_conversations_drafts_idx
  ON public.sdr_conversations(team_id, pending_draft_at DESC)
  WHERE pending_draft IS NOT NULL;

CREATE INDEX IF NOT EXISTS sdr_conversations_claim_idx
  ON public.sdr_conversations(processing_started_at)
  WHERE processing_claim_id IS NOT NULL;

DROP TRIGGER IF EXISTS sdr_conversations_touch ON public.sdr_conversations;
CREATE TRIGGER sdr_conversations_touch BEFORE UPDATE ON public.sdr_conversations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── the send ledger ─────────────────────────────────────────────────────────
-- Claim-first: a row is inserted BEFORE the message leaves, and the UNIQUE
-- idem_key turns a retried cron run or a redelivered webhook into a no-op
-- instead of a second text to the same homeowner. Fail closed — if the claim
-- cannot be written, nothing is sent.
--
-- It is also the answer to "why did the AI say that": one row per autonomous
-- or approved send, with who approved it and what was blocked and why.
CREATE TABLE IF NOT EXISTS public.sdr_sends (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.sdr_conversations(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,

  -- Derived from the conversation and its turn number, so the same turn can
  -- only ever claim once no matter how many workers try.
  idem_key text NOT NULL,

  channel text NOT NULL DEFAULT 'sms',
  -- 'auto' means no human read it before it went. That distinction is the
  -- whole point of the draft-by-default design, so it is a stored column and
  -- not something inferred from approved_by being null.
  origin  text NOT NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Hash rather than the body: the body already lives in sms_messages and in
  -- the transcript, and this row exists to prove which body, not to hold a
  -- third copy that can drift.
  body_hash text NOT NULL,

  status text NOT NULL DEFAULT 'claimed',
  block_reason text,
  sms_message_id uuid REFERENCES public.sms_messages(id) ON DELETE SET NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  CONSTRAINT sdr_sends_idem_unique  UNIQUE (idem_key),
  CONSTRAINT sdr_sends_channel_check CHECK (channel IN ('sms', 'email')),
  CONSTRAINT sdr_sends_origin_check  CHECK (origin IN ('auto', 'approved')),
  CONSTRAINT sdr_sends_status_check  CHECK (status IN ('claimed', 'sent', 'failed', 'blocked'))
);

CREATE INDEX IF NOT EXISTS sdr_sends_team_created_idx
  ON public.sdr_sends(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sdr_sends_conversation_idx
  ON public.sdr_sends(conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

-- ── per-lead SDR overrides ──────────────────────────────────────────────────
-- All nullable, and NULL means "inherit the team setting". A three-valued
-- column is worth the awkwardness here: a boolean defaulting to false would
-- make every existing lead opted out forever, and defaulting to true would
-- enrol every lead in the database the moment the SDR is switched on.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS sdr_enabled boolean,
  ADD COLUMN IF NOT EXISTS sdr_mode    text,
  ADD COLUMN IF NOT EXISTS sdr_step    text,
  ADD COLUMN IF NOT EXISTS sdr_score   integer;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_sdr_mode_check'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_sdr_mode_check
      CHECK (sdr_mode IS NULL OR sdr_mode IN ('draft', 'auto'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_sdr_score_check'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_sdr_score_check
      CHECK (sdr_score IS NULL OR sdr_score BETWEEN 0 AND 100);
  END IF;
END $do$;

COMMENT ON COLUMN public.leads.sdr_enabled IS
  'NULL inherits sdr_settings.enabled. FALSE takes this one lead off the SDR without touching the team switch.';
COMMENT ON COLUMN public.leads.sdr_mode IS
  'NULL inherits sdr_settings.default_mode. Setting it to auto still requires teams.sdr_auto_send_approved.';

-- ── conversation locking ────────────────────────────────────────────────────
-- Compare-and-swap on the row rather than pg_try_advisory_lock, because an
-- advisory lock is tied to a session and Supabase's poolers recycle sessions
-- underneath us — the lock would be released while the turn was still running.
--
-- All three are SECURITY INVOKER: the workers that call them run on the service
-- role, which bypasses RLS anyway, so a DEFINER function would only be adding
-- an ambient-authority endpoint for nothing. EXECUTE is granted to service_role
-- alone; there is no reason for a browser to take a worker lock.
CREATE OR REPLACE FUNCTION public.try_sdr_conversation_lock(p_conv_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE v_claim uuid := gen_random_uuid();
BEGIN
  UPDATE public.sdr_conversations
     SET processing_claim_id   = v_claim,
         processing_started_at = now()
   WHERE id = p_conv_id
     -- Five minutes is longer than any turn should take, including a slow
     -- model call and a Twilio round trip. Past that the previous worker is
     -- assumed dead rather than slow, because the alternative is a
     -- conversation nobody can ever pick up again.
     AND (processing_claim_id IS NULL
          OR processing_started_at < now() - interval '5 minutes');

  IF NOT FOUND THEN
    RETURN NULL;  -- someone else holds it; the caller skips this conversation
  END IF;
  RETURN v_claim;
END;
$$;

COMMENT ON FUNCTION public.try_sdr_conversation_lock IS
  'Claims a conversation for one SDR turn. Returns the claim id, or NULL when another worker holds it. Prevents two workers double-replying to one seller.';

CREATE OR REPLACE FUNCTION public.release_sdr_conversation_lock(p_conv_id uuid, p_claim uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  -- Matching on the claim id matters: a worker whose lock already expired and
  -- was taken by someone else must not release the new holder's lock.
  UPDATE public.sdr_conversations
     SET processing_claim_id = NULL, processing_started_at = NULL
   WHERE id = p_conv_id AND processing_claim_id = p_claim;
$$;

CREATE OR REPLACE FUNCTION public.reap_stale_sdr_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE cleared integer := 0;
BEGIN
  -- Ten minutes, not five: try_sdr_conversation_lock will already steal a
  -- five-minute-old lock on its own. This is the backstop for conversations
  -- nothing is currently scanning, so it waits until the claim is
  -- unambiguously abandoned.
  UPDATE public.sdr_conversations
     SET processing_claim_id = NULL, processing_started_at = NULL
   WHERE processing_claim_id IS NOT NULL
     AND processing_started_at < now() - interval '10 minutes';
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END;
$$;

REVOKE ALL ON FUNCTION public.try_sdr_conversation_lock(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_sdr_conversation_lock(uuid, uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reap_stale_sdr_claims()                    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_sdr_conversation_lock(uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sdr_conversation_lock(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_stale_sdr_claims()                   TO service_role;

-- ── stage moves are not always a person ─────────────────────────────────────
-- move_lead_to_stage (20260817130000) hardcoded actor_kind 'user'. The SDR
-- moves cards too, and it runs on the service role where auth.uid() is NULL —
-- so every AI move was logging as if a human had dragged it. Same expression
-- the status trigger already uses, so the two agree.
CREATE OR REPLACE FUNCTION public.move_lead_to_stage(
  p_lead_id  uuid,
  p_stage_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_team      uuid;
  v_pipeline  uuid;
  v_stage     text;
  v_from      text;
BEGIN
  SELECT team_id INTO v_team FROM public.leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.pipeline_id, s.name INTO v_pipeline, v_stage
  FROM public.pipeline_stages s WHERE s.id = p_stage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.name INTO v_from
  FROM public.lead_pipeline_memberships m
  JOIN public.pipeline_stages s ON s.id = m.stage_id
  WHERE m.lead_id = p_lead_id AND m.pipeline_id = v_pipeline;

  IF v_from IS NOT DISTINCT FROM v_stage THEN
    RETURN;  -- dropped back where it started
  END IF;

  INSERT INTO public.lead_pipeline_memberships (lead_id, pipeline_id, stage_id)
  VALUES (p_lead_id, v_pipeline, p_stage_id)
  ON CONFLICT (lead_id, pipeline_id) DO UPDATE SET stage_id = EXCLUDED.stage_id;

  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_team, p_lead_id, auth.uid(),
    CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END,
    'stage_changed',
    COALESCE(v_from, 'Unfiled') || ' -> ' || v_stage,
    jsonb_build_object('from', v_from, 'to', v_stage)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.move_lead_to_stage(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_lead_to_stage(uuid, uuid) TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.sdr_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sdr_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sdr_sends         ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sdr_settings', 'sdr_conversations', 'sdr_sends']
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

-- ── grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON public.sdr_settings      FROM PUBLIC, anon;
REVOKE ALL ON public.sdr_conversations FROM PUBLIC, anon;
REVOKE ALL ON public.sdr_sends         FROM PUBLIC, anon;

-- Settings are operator-managed. Note what this does NOT grant: turning on
-- full auto still needs teams.sdr_auto_send_approved, which only the owner can
-- update, so a member setting default_mode='auto' here changes nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sdr_settings TO authenticated;

-- Conversations: the operator approves, edits, discards and claims drafts, all
-- of which are updates. No DELETE — the transcript is the record of what an
-- automated system said to a homeowner, and a UI that can erase it is worth
-- less than one that cannot.
GRANT SELECT, INSERT, UPDATE ON public.sdr_conversations TO authenticated;

-- The ledger is written by the edge function on the service role and read by
-- the app. SELECT only, so nothing in a browser can forge or alter the record
-- of who authorised a send.
GRANT SELECT ON public.sdr_sends TO authenticated;

-- ── seed ────────────────────────────────────────────────────────────────────
-- Disabled, draft mode, no channel that is not already live. Nothing here
-- starts talking to anyone on its own.
INSERT INTO public.sdr_settings (team_id)
VALUES ('70551e00-0000-4000-8000-000000000001')
ON CONFLICT (team_id) DO NOTHING;

-- ── realtime ────────────────────────────────────────────────────────────────
-- The approval queue has to fill in while the operator is looking at it; a
-- draft that needs a refresh to appear is a seller who waits an extra ten
-- minutes. Guarded exactly like 20260817120200 — ALTER PUBLICATION ADD errors
-- on a duplicate, which would make re-running this migration fail.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['sdr_conversations']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
