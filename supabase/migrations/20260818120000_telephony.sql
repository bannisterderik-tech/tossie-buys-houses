-- ============================================================================
-- Phase 2/3 — telephony: numbers, SMS, calls, opt-outs.
-- ============================================================================
-- This is the schema the dialer (Phase 2) and two-way SMS (Phase 3) both sit
-- on. It lands as one migration because the compliance rails are shared: an
-- SMS STOP has to stop the dialer, and the dialer's DNC check has to see what
-- the SMS webhook wrote. Splitting them would mean shipping a dialer that can
-- legally call someone who already texted STOP.
--
-- What is deliberately NOT here, from reoperative's telephony schema:
-- per-team Twilio subaccounts, wholesale/retail cost columns, price book,
-- bundle balances and usage metering. Tossie pays its own Twilio bill; all of
-- that machinery exists to resell telephony and is dead weight here.
-- See docs/BUILD_PLAN.md §0 and §6.
--
-- SECRETS: no Twilio account SID, auth token or API key appears in this file
-- or in any table it creates. They live in Supabase edge function secrets. The
-- only Twilio identifiers stored are per-resource SIDs (number, message, call),
-- which are opaque handles and useless without the token.
-- ============================================================================

-- ── phone_numbers ───────────────────────────────────────────────────────────
-- The numbers Tossie owns. One row per number bought in Twilio.
CREATE TABLE IF NOT EXISTS public.phone_numbers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- E.164 as Twilio stores it (+19125550134). Unique globally rather than per
  -- team: a Twilio number belongs to exactly one account at a time, so two
  -- teams claiming the same number is always a data error, never a valid state.
  e164          text NOT NULL UNIQUE,
  friendly_name text,
  twilio_sid    text,

  -- A number bought while A2P registration is pending is voice-only. That is
  -- not a UI preference — texting from an unregistered number gets traffic
  -- filtered by the carriers and can cost the campaign its approval. Defaults
  -- reflect that: voice on, SMS off until someone turns it on deliberately.
  voice_enabled boolean NOT NULL DEFAULT true,
  sms_enabled   boolean NOT NULL DEFAULT false,

  is_primary    boolean NOT NULL DEFAULT false,

  -- Mirrors the Twilio A2P 10DLC campaign state so the app can say "SMS is
  -- still pending" instead of failing sends with a carrier error nobody reads.
  a2p_status    text NOT NULL DEFAULT 'not_started',

  -- Where an unanswered inbound call goes. Per number, because a marketing
  -- number and the office number do not have to ring the same phone.
  forward_to_e164 text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT phone_numbers_a2p_status_check CHECK (a2p_status IN (
    'not_started', 'pending', 'approved', 'rejected'
  ))
);

-- Exactly one primary per team. Without this, "which number do we send from"
-- resolves by whichever row the planner returned first — a silent way to text
-- a seller from a number they have never seen.
CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_one_primary_idx
  ON public.phone_numbers(team_id) WHERE is_primary;

-- Inbound webhooks arrive with To=+1912...; we resolve which of our numbers was
-- reached. Keyed on phone_key rather than on e164 so a number typed into the
-- app with formatting still matches what Twilio posts. Same rule everywhere.
CREATE INDEX IF NOT EXISTS phone_numbers_key_idx
  ON public.phone_numbers(public.phone_key(e164));

COMMENT ON COLUMN public.phone_numbers.a2p_status IS
  'Twilio A2P 10DLC campaign state for this number. sms_enabled should not be true unless this is approved.';

-- ── sms_messages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Nullable on purpose. An inbound text can arrive from a number that matches
  -- no lead — a wrong number, a carrier notice, someone forwarded the ad to a
  -- friend. Dropping those on the floor would lose the one message that says
  -- STOP, so the row is stored unattached and matched later if a lead appears.
  lead_id         uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,

  direction       text NOT NULL,
  from_e164       text NOT NULL,
  to_e164         text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',

  -- The dedup key. UNIQUE permits many NULLs, which is what makes it work: an
  -- outbound row is written before Twilio has issued a SID, then updated with
  -- it. A redelivered webhook — Twilio retries on any non-2xx — collides here
  -- and the insert is rejected instead of doubling the thread.
  twilio_sid      text UNIQUE,

  error_code      text,
  num_segments    integer,

  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sms_messages_direction_check CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT sms_messages_status_check CHECK (status IN (
    'queued', 'sent', 'delivered', 'failed', 'received', 'undelivered'
  ))
);

-- The thread in the lead detail panel: every message for one lead, newest last.
CREATE INDEX IF NOT EXISTS sms_messages_lead_idx
  ON public.sms_messages(lead_id, created_at) WHERE lead_id IS NOT NULL;

-- Inbound matching. The webhook has a From and needs the lead; the two
-- expression indexes below are the same lookup from either side of a thread —
-- from_e164 identifies the counterparty on inbound rows, to_e164 on outbound —
-- and a thread keyed by number (rather than by lead_id) needs both to avoid a
-- sequential scan on every unattached message.
CREATE INDEX IF NOT EXISTS sms_messages_from_key_idx
  ON public.sms_messages(public.phone_key(from_e164));
CREATE INDEX IF NOT EXISTS sms_messages_to_key_idx
  ON public.sms_messages(public.phone_key(to_e164));

-- The inbox: everything, newest first, plus the unread count.
CREATE INDEX IF NOT EXISTS sms_messages_team_created_idx
  ON public.sms_messages(team_id, created_at DESC);

COMMENT ON TABLE public.sms_messages IS
  'Every SMS in or out. Append-only in practice: authenticated has no DELETE grant, because a thread is the evidence of what was said to a homeowner.';

-- ── telephony_opt_outs ──────────────────────────────────────────────────────
-- The suppression list. This is the single most legally load-bearing table in
-- the build: $500-$1,500 statutory damages per message or call to a number
-- that is on it. See docs/BUILD_PLAN.md §5.
CREATE TABLE IF NOT EXISTS public.telephony_opt_outs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Stored already reduced to phone_key() form — last 10 digits. Storing the
  -- raw number instead would mean every read had to remember to normalise, and
  -- the one read that forgot would be the one that placed the call.
  phone_key    text NOT NULL,

  source       text NOT NULL,
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  note         text,

  CONSTRAINT telephony_opt_outs_source_check CHECK (source IN (
    'sms_stop', 'manual', 'verbal', 'dnc_scrub'
  )),
  -- Idempotency for the inbound webhook: a seller who texts STOP three times,
  -- or a Twilio retry, upserts one row instead of three.
  CONSTRAINT telephony_opt_outs_team_key_unique UNIQUE (team_id, phone_key)
);

-- The unique constraint's index leads with team_id, so it cannot serve a probe
-- by number alone — which is exactly what the dialer and the send gate do.
CREATE INDEX IF NOT EXISTS telephony_opt_outs_key_idx
  ON public.telephony_opt_outs(phone_key);

COMMENT ON COLUMN public.telephony_opt_outs.phone_key IS
  'Output of public.phone_key() — last 10 digits. Never the formatted number.';

-- ── call_log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  lead_id          uuid REFERENCES public.leads(id) ON DELETE SET NULL,

  direction        text NOT NULL,
  from_e164        text,
  to_e164          text,

  -- Same dedup role as sms_messages.twilio_sid: Twilio posts several status
  -- callbacks per call and retries the ones that error.
  twilio_call_sid  text UNIQUE,

  status           text,

  -- Twilio AMD verdict: human, machine_start, machine_end_beep, fax, unknown.
  -- Free text rather than a CHECK because Twilio has added values before and a
  -- rejected insert here would lose the call record over a vocabulary change.
  answered_by      text,

  duration_seconds integer,
  recording_url    text,
  disposition      text,

  started_at       timestamptz,
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT call_log_direction_check CHECK (direction IN ('inbound', 'outbound'))
);

-- from_e164 is nullable because a call placed through a Twilio verified-caller
-- flow can report no From; reoperative hit this and had to relax the column
-- after the fact (call_log_allow_null_from_number). Cheaper to start relaxed.

-- The call history on the lead detail panel.
CREATE INDEX IF NOT EXISTS call_log_lead_idx
  ON public.call_log(lead_id, created_at DESC) WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS call_log_team_created_idx
  ON public.call_log(team_id, created_at DESC);

-- ── telephony_settings ──────────────────────────────────────────────────────
-- One row per team. team_id is the primary key, so a second row is impossible
-- and every read is a point lookup with no "which settings row" question.
CREATE TABLE IF NOT EXISTS public.telephony_settings (
  team_id           uuid PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,
  default_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  forward_to_e164   text,

  -- Off by default. FL is a two-party-consent state and is in the site's
  -- six-state footprint, so recording is a decision someone makes on purpose
  -- with the disclosure written, not a default that happens to be on.
  recording_enabled boolean NOT NULL DEFAULT false,
  voicemail_url     text,

  -- The operational pause, distinct from teams.sms_send_disabled. That one is
  -- the owner-only hard kill (RLS restricts the UPDATE); this one is the
  -- "stop sending while we sort out a carrier problem" switch any operator can
  -- flip. The send path has to honour both.
  sms_send_paused   boolean NOT NULL DEFAULT false,

  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── triggers ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS phone_numbers_touch ON public.phone_numbers;
CREATE TRIGGER phone_numbers_touch BEFORE UPDATE ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS telephony_settings_touch ON public.telephony_settings;
CREATE TRIGGER telephony_settings_touch BEFORE UPDATE ON public.telephony_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── the suppression check ───────────────────────────────────────────────────
-- STABLE, not IMMUTABLE: it reads a table, and a function that reads a table
-- and claims IMMUTABLE will be constant-folded by the planner and cached in a
-- plan that outlives the STOP message. That is not a performance nit here —
-- it is a stale cache deciding to call someone who opted out.
--
-- SECURITY INVOKER so RLS scopes the read. p_team is still taken explicitly
-- because the edge functions run on the service role, which bypasses RLS and
-- would otherwise see every team's opt-outs at once.
CREATE OR REPLACE FUNCTION public.is_opted_out(p_team uuid, p_number text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.telephony_opt_outs o
    WHERE o.team_id = p_team
      AND o.phone_key = public.phone_key(p_number)
  );
$$;

COMMENT ON FUNCTION public.is_opted_out IS
  'True when this number has opted out for this team. Accepts any format — E.164, formatted, bare digits — because it reduces the argument with phone_key() first. Check before every outbound SMS and every dial.';

REVOKE ALL ON FUNCTION public.is_opted_out(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_opted_out(uuid, text) TO authenticated;

-- ── lead_is_dialable now honours the opt-out list ───────────────────────────
-- READ THIS BEFORE CHANGING IT.
--
-- The previous definition (20260817130000_crm_write_paths.sql) was IMMUTABLE.
-- It cannot stay IMMUTABLE now, because it reads telephony_opt_outs, and
-- IMMUTABLE is a promise to the planner that the result depends only on the
-- arguments. Lying about that lets the planner fold the call into a cached
-- plan or an index entry that no STOP message will ever invalidate.
--
-- The cost of dropping to STABLE is that the function can no longer appear in
-- an index expression. I checked before changing it:
--
--   SELECT indexdef FROM pg_indexes WHERE indexdef LIKE '%lead_is_dialable%';
--
-- returns nothing — no index has ever been built on it. Its only dependants
-- are the due_leads view (which CREATE OR REPLACE handles) and the test suite.
-- So nothing is being silently broken here. If a future migration wants a
-- partial index on dialability, it cannot use this function; it has to inline
-- the boolean columns and accept that the opt-out half is checked at query
-- time. The phase2_telephony suite asserts both facts — volatility is 's', and
-- zero indexes reference the function — so this stays true or the tests fail.
--
-- Both numbers are checked, not just the one we would dial. A seller who texts
-- STOP from the landline on file has opted out; dialing the mobile because the
-- STOP arrived on a different line is the exact fact pattern that gets a
-- wholesaler sued. Over-suppressing costs a lead, under-suppressing costs
-- $500-$1,500 per call.
CREATE OR REPLACE FUNCTION public.lead_is_dialable(l public.leads)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT NOT l.trashed
     AND NOT l.is_dnc
     AND NOT l.is_litigator
     AND NOT l.phone_invalid
     AND COALESCE(l.phone_mobile, l.phone) IS NOT NULL
     -- phone_key(NULL) is NULL, so a lead with only one number on file gets
     -- false from the other check rather than a NULL that would swallow the
     -- whole AND chain.
     AND NOT public.is_opted_out(l.team_id, l.phone)
     AND NOT public.is_opted_out(l.team_id, l.phone_mobile)
     AND (
       -- inbound: the seller contacted us and accepted the disclosure
       (l.source = 'website' AND l.tcpa_opt_in)
       -- outbound: cold list, must be traced and scrubbed
       OR (l.skip_traced AND l.dnc_scrubbed)
     );
$$;

COMMENT ON FUNCTION public.lead_is_dialable IS
  'Single source of truth for "may we call this number". Now also false when either number on the lead is in telephony_opt_outs. STABLE, not IMMUTABLE, because it reads that table — it can no longer be used in an index expression.';

REVOKE ALL ON FUNCTION public.lead_is_dialable(public.leads) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_is_dialable(public.leads) TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.phone_numbers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telephony_opt_outs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telephony_settings  ENABLE ROW LEVEL SECURITY;

-- Same policy shape as every other team-scoped table. Edge functions run on
-- the service role, which bypasses RLS — that is how the Twilio webhook writes
-- an inbound message for a team nobody is signed in as.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['phone_numbers', 'sms_messages', 'telephony_opt_outs',
                           'call_log', 'telephony_settings']
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
-- The anon key ships in the browser bundle. RLS already denies it; revoking
-- the table grants is the second lock, and 20260817120300 set default
-- privileges so it applies to these tables too — this is belt and braces
-- because getting it wrong exposes seller phone numbers and message bodies.
REVOKE ALL ON public.phone_numbers      FROM PUBLIC, anon;
REVOKE ALL ON public.sms_messages       FROM PUBLIC, anon;
REVOKE ALL ON public.telephony_opt_outs FROM PUBLIC, anon;
REVOKE ALL ON public.call_log           FROM PUBLIC, anon;
REVOKE ALL ON public.telephony_settings FROM PUBLIC, anon;

-- Numbers and settings are operator-managed, so full CRUD.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_numbers      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telephony_settings TO authenticated;

-- Logs get no DELETE. A message thread and a call record are what we would
-- produce if someone claims we contacted them after they said stop, and a UI
-- that can quietly erase them is worth less than one that cannot.
GRANT SELECT, INSERT, UPDATE ON public.sms_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.call_log     TO authenticated;

-- Opt-outs get no DELETE either, and this one is deliberate rather than tidy:
-- deleting a row here re-enables calling someone who said STOP. The only thing
-- that should remove an opt-out is the person themselves texting START, which
-- arrives at the webhook and runs on the service role. There is no path from
-- the operator UI to un-suppressing a number.
GRANT SELECT, INSERT, UPDATE ON public.telephony_opt_outs TO authenticated;

-- ── seed ────────────────────────────────────────────────────────────────────
-- The one team's settings row. Created empty so the app reads settings rather
-- than branching on "no row yet" everywhere; numbers get attached once Twilio
-- provisioning happens. No number, SID or credential is invented here.
INSERT INTO public.telephony_settings (team_id)
VALUES ('70551e00-0000-4000-8000-000000000001')
ON CONFLICT (team_id) DO NOTHING;

-- ── realtime ────────────────────────────────────────────────────────────────
-- The thread has to update while the operator is looking at it; a reply that
-- needs a refresh to appear is a reply that gets answered ten minutes late.
-- Guarded exactly like 20260817120200 — ALTER PUBLICATION ADD errors on a
-- duplicate, which would make re-running this migration fail.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['sms_messages']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
