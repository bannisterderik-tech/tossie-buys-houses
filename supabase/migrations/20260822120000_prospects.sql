-- ============================================================================
-- Part II §10 — prospects are not leads.
-- ============================================================================
-- The import page was built on a wrong assumption: that a row on a purchased
-- list is a lead with a warning banner on it. It is not. A lead is someone with
-- a consent basis or a live conversation. A prospect is a name and an address
-- somebody sold us, and nobody on that list has agreed to hear from Tossie.
--
-- Modelling both as `leads` meant every send path, every SDR query and every
-- broadcast audience had to remember to exclude the cold half — and "remember
-- to exclude" is not a rail, it is a hope. So they are different tables, and
-- the separation does the remembering:
--
--   * `prospects` has no consent columns, so no send path can find one.
--   * The SDR reads `leads`. It cannot see this table at all.
--   * Nothing here is textable, structurally rather than by policy (§12).
--
-- The table itself ports nearly verbatim from reoperative's `cold_call_leads`
-- (20260505080000_baseline.sql:3753), which is already wholesaler-shaped:
-- distress flags, skip-trace output split by line type, and the call-status
-- ladder. What is stripped is `cost_cents` / `retail_cents` — reoperative
-- resold list data to its tenants and had to carry the markup. Tossie buys his
-- own lists, so the only honest number is what he paid, and that belongs on an
-- expense line, not on every row.
--
-- The conversion at the bottom is the point of the whole file.
-- ============================================================================

-- ── prospect_lists ──────────────────────────────────────────────────────────
-- One row per list bought or pulled. The list survives being worked because it
-- is the record of what was purchased: which vendor, which filters, how many
-- were traceable, how many ever answered. Without that, deciding whether to buy
-- from that vendor again is a feeling rather than a number.
CREATE TABLE IF NOT EXISTS public.prospect_lists (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  name        text NOT NULL,
  description text,

  -- Free text, not an enum. List vendors get acquired, renamed and replaced
  -- faster than a migration can keep up, and a CHECK constraint that blocks
  -- recording where a list actually came from would just get worked around by
  -- typing the wrong one.
  source_vendor text,

  status  text NOT NULL DEFAULT 'active',

  -- Whatever the vendor's list builder was asked for — county, equity band,
  -- absentee, pre-foreclosure. Kept verbatim so a list that pulls well can be
  -- pulled again without reconstructing the query from memory.
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Denormalised counters. The lists screen shows a dozen rows at once and five
  -- COUNT(*)s per row is a silly amount of work for a number that changes a few
  -- times a day. They are RECOMPUTED by refresh_prospect_list_counts() rather
  -- than incremented: increments drift the first time an import half-fails, and
  -- a drifted compliance counter ("scrubbed: 4,812 of 4,812") is worse than no
  -- counter, because somebody will believe it.
  total_count       integer NOT NULL DEFAULT 0,
  skip_traced_count integer NOT NULL DEFAULT 0,
  scrubbed_count    integer NOT NULL DEFAULT 0,
  called_count      integer NOT NULL DEFAULT 0,
  converted_count   integer NOT NULL DEFAULT 0,

  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_lists_status_check CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS prospect_lists_team_created_idx
  ON public.prospect_lists(team_id, created_at DESC);

COMMENT ON TABLE public.prospect_lists IS
  'A purchased or scraped list. Kept after it is worked because it is the record of what was bought, from whom, and how it performed.';

-- ── prospects ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prospects (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  list_id uuid NOT NULL REFERENCES public.prospect_lists(id) ON DELETE CASCADE,

  -- Property ────────────────────────────────────────────────────────────────
  address       text,
  city          text,
  state         text,
  zip           text,
  county        text,
  property_type text,
  year_built    integer,

  assessed_value   integer,
  estimated_value  integer,
  equity_pct       numeric(5,2),
  mortgage_balance integer,
  last_sale_date   date,
  last_sale_price  integer,
  years_owned      numeric(4,1),

  -- Owner ───────────────────────────────────────────────────────────────────
  -- Note there is no `name`/`phone` contact block here the way `leads` has one.
  -- On a cold list there is no contact, only an owner of record; the phone
  -- numbers below arrive later from the skip trace and belong to whoever the
  -- provider thinks that owner is. The distinction stops mattering the moment
  -- somebody actually answers — which is exactly when this becomes a lead.
  owner_name     text,
  owner_type     text,
  owner_occupied boolean,
  mailing_address text,
  mailing_city    text,
  mailing_state   text,
  mailing_zip     text,

  -- Distress ────────────────────────────────────────────────────────────────
  -- Why the row is on the list at all. These drive who gets called first, and
  -- they are also why the litigator scrub below matters more here than
  -- anywhere else: serial TCPA plaintiffs seed their numbers onto exactly the
  -- absentee and pre-foreclosure lists a wholesaler buys (§11).
  is_absentee     boolean NOT NULL DEFAULT false,
  is_out_of_state boolean NOT NULL DEFAULT false,
  pre_foreclosure boolean NOT NULL DEFAULT false,
  tax_delinquent  boolean NOT NULL DEFAULT false,
  vacant          boolean NOT NULL DEFAULT false,
  bankruptcy      boolean NOT NULL DEFAULT false,
  liens           boolean NOT NULL DEFAULT false,

  -- Skip trace ──────────────────────────────────────────────────────────────
  -- Split by line type because the type decides what may be done with the
  -- number. Ported from reoperative, where the split already existed.
  skip_traced           boolean NOT NULL DEFAULT false,
  skip_traced_at        timestamptz,
  skip_trace_provider   text,
  skip_trace_confidence integer,
  phone_mobile   text,
  phone_landline text,
  phone_voip     text,
  email_primary   text,
  email_secondary text,

  -- Scrub ───────────────────────────────────────────────────────────────────
  -- Separate from skip_traced on purpose, exactly as on `leads`: a number can
  -- be traced and not scrubbed, and only the scrubbed ones may be dialled.
  --
  -- READ THIS BEFORE ADDING A COLUMN HERE. There is deliberately no
  -- `opted_in_sms` / `consent_*` / `tcpa_*` column on this table, and
  -- reoperative's version had them. They are gone because a consent column on a
  -- cold list is an invitation: somebody sets it in bulk during an import, and
  -- now 5,000 people who never agreed to anything look consented to every send
  -- path in the system. Consent is created one conversation at a time by
  -- convert_prospect_to_lead() below, and it lives on the lead it creates.
  dnc_scrubbed    boolean NOT NULL DEFAULT false,
  dnc_scrubbed_at timestamptz,
  is_dnc          boolean NOT NULL DEFAULT false,
  is_litigator    boolean NOT NULL DEFAULT false,

  -- Call state ──────────────────────────────────────────────────────────────
  call_status   text NOT NULL DEFAULT 'not_called',
  last_called_at timestamptz,
  call_attempts integer NOT NULL DEFAULT 0,
  call_notes    text,
  callback_at   timestamptz,

  -- Conversion ──────────────────────────────────────────────────────────────
  -- ON DELETE SET NULL, which is why converted_at and not converted_lead_id is
  -- the authoritative "this was converted" fact: deleting the lead must not
  -- quietly return the prospect to the dial queue as though the conversation
  -- never happened.
  converted_lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  converted_at      timestamptz,

  -- Everything the vendor sent, unedited. Column mappings are guesses about
  -- someone else's CSV and they are wrong sooner or later; this is where the
  -- answer survives.
  raw_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  vendor_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospects_call_status_check CHECK (call_status IN (
    'not_called', 'called', 'callback', 'not_interested', 'wrong_number',
    'no_answer', 'left_voicemail', 'appointment_set', 'hot_lead'
  )),
  CONSTRAINT prospects_skip_trace_confidence_check CHECK (
    skip_trace_confidence IS NULL OR skip_trace_confidence BETWEEN 0 AND 100
  ),
  -- A row that names neither a property nor an owner is an import artefact, not
  -- a prospect. Cheap to catch here; expensive to find later in a dial queue.
  CONSTRAINT prospects_identifies_something CHECK (
    address IS NOT NULL OR owner_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS prospects_team_created_idx
  ON public.prospects(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prospects_list_status_idx
  ON public.prospects(list_id, call_status);
CREATE INDEX IF NOT EXISTS prospects_list_skip_idx
  ON public.prospects(list_id, skip_traced);
CREATE INDEX IF NOT EXISTS prospects_callback_idx
  ON public.prospects(team_id, callback_at) WHERE callback_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_converted_idx
  ON public.prospects(converted_lead_id) WHERE converted_lead_id IS NOT NULL;

-- Inbound calls. Somebody who was called yesterday and rings the number back
-- today has to be findable, and Twilio hands the webhook E.164 while the vendor
-- CSV said "(912) 555-0134" — phone_key() is what makes those the same number.
CREATE INDEX IF NOT EXISTS prospects_phone_mobile_key_idx
  ON public.prospects(public.phone_key(phone_mobile)) WHERE phone_mobile IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_phone_landline_key_idx
  ON public.prospects(public.phone_key(phone_landline)) WHERE phone_landline IS NOT NULL;

-- Vendors hand back the same record on a re-pull of the same filters. Without
-- this, refreshing a list doubles it, and the second copy is a second call to
-- the same homeowner from a system that thinks it has never spoken to them.
CREATE UNIQUE INDEX IF NOT EXISTS prospects_list_vendor_id_key
  ON public.prospects(list_id, vendor_id) WHERE vendor_id IS NOT NULL;

COMMENT ON TABLE public.prospects IS
  'A row on a purchased or scraped cold list. No consent basis exists here and none can be recorded — see convert_prospect_to_lead(). May be called only once skip-traced and scrubbed; may never be texted.';

COMMENT ON COLUMN public.prospects.converted_at IS
  'The durable record that this prospect became a lead. Authoritative over converted_lead_id, which goes NULL if the lead is deleted.';

DROP TRIGGER IF EXISTS prospect_lists_touch ON public.prospect_lists;
CREATE TRIGGER prospect_lists_touch BEFORE UPDATE ON public.prospect_lists
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS prospects_touch ON public.prospects;
CREATE TRIGGER prospects_touch BEFORE UPDATE ON public.prospects
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── may we call this one ────────────────────────────────────────────────────
-- The reason prospects get their own table at all. `lead_is_dialable` answers
-- the same question for leads and has an inbound-consent branch; this one has
-- no such branch, because on a cold list nobody has consented to anything. The
-- only route to a dial is: traced, scrubbed, clean, not already converted.
--
-- What is NOT here, and deliberately:
--
--   * No textability. There is no prospect_is_textable() and there must not be
--     one. Tossie's A2P campaign is Low Volume Mixed, registered for
--     appointment reminders; cold SMS does not match that registration, and
--     carriers suspend campaigns whose traffic does not match (§12). Beyond the
--     registration, texting someone who never gave consent is the single
--     highest-exposure act in this business at $500-$1,500 per message. Every
--     send path goes through twilio-send-sms, which resolves a LEAD — there is
--     no code path from this table to the messaging API, and that is the point.
--
--   * No calling window. 8am-9pm in the called party's local time is enforced
--     server-side at dial time (_shared/calling-window.ts) because the answer
--     changes every minute. Folding it in here would make a STABLE function
--     that lies inside a transaction and reads as a durable property of the row
--     when it is nothing of the sort.
--
-- STABLE, not IMMUTABLE, for the same reason lead_is_dialable is (see the note
-- in 20260818120000): it reads telephony_opt_outs, so it cannot appear in an
-- index expression. A queue builder filters on it at query time.
CREATE OR REPLACE FUNCTION public.prospect_is_callable(p public.prospects)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT p.converted_at IS NULL
     AND COALESCE(p.phone_mobile, p.phone_landline, p.phone_voip) IS NOT NULL
     -- Both halves. Tracing without scrubbing produces a number nobody checked
     -- against the DNC and litigator files, which is the expensive half.
     AND p.skip_traced
     AND p.dnc_scrubbed
     AND NOT p.is_dnc
     AND NOT p.is_litigator
     -- Every number on the row, not just the one we would dial: a STOP or a
     -- "never call here again" recorded against the landline suppresses the
     -- mobile too. is_opted_out() returns false for a NULL number, so a row
     -- with one number on file is not vetoed by the two it does not have.
     AND NOT public.is_opted_out(p.team_id, p.phone_mobile)
     AND NOT public.is_opted_out(p.team_id, p.phone_landline)
     AND NOT public.is_opted_out(p.team_id, p.phone_voip);
$$;

COMMENT ON FUNCTION public.prospect_is_callable IS
  'Single source of truth for "may we dial this prospect". No consent branch, because a cold list has no consent. There is deliberately no prospect_is_textable — prospects cannot be texted at all. STABLE, so unusable in an index.';

REVOKE ALL ON FUNCTION public.prospect_is_callable(public.prospects) FROM PUBLIC, anon;
-- service_role as well as authenticated: the skip-trace and dialer edge
-- functions build queues on the service role, and this is the filter they must
-- build them with.
GRANT EXECUTE ON FUNCTION public.prospect_is_callable(public.prospects)
  TO authenticated, service_role;

-- ── list counters ───────────────────────────────────────────────────────────
-- Recompute from the rows rather than trusting a running total. Called after an
-- import, after a skip-trace batch, and by the conversion below. One aggregate
-- pass over a single list, which is cheap at the frequency these change; a
-- trigger per row would instead charge that cost 5,000 times during an import
-- to produce the same five numbers.
CREATE OR REPLACE FUNCTION public.refresh_prospect_list_counts(p_list_id uuid)
RETURNS public.prospect_lists
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_list public.prospect_lists;
BEGIN
  -- RLS on both statements is the team check; a list in another team is simply
  -- not visible and the UPDATE finds nothing.
  UPDATE public.prospect_lists l SET
    total_count       = c.total,
    skip_traced_count = c.traced,
    scrubbed_count    = c.scrubbed,
    called_count      = c.called,
    converted_count   = c.converted
  FROM (
    SELECT
      count(*)                                          AS total,
      count(*) FILTER (WHERE p.skip_traced)             AS traced,
      count(*) FILTER (WHERE p.dnc_scrubbed)            AS scrubbed,
      count(*) FILTER (WHERE p.call_attempts > 0)       AS called,
      count(*) FILTER (WHERE p.converted_at IS NOT NULL) AS converted
    FROM public.prospects p
    WHERE p.list_id = p_list_id
  ) c
  WHERE l.id = p_list_id
  RETURNING l.* INTO v_list;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prospect list not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_list;
END;
$$;

COMMENT ON FUNCTION public.refresh_prospect_list_counts IS
  'Recomputes a list''s counters from its rows. Call after an import or a skip-trace batch. Recomputed rather than incremented so a half-failed import cannot leave a compliance counter overstating the scrub.';

REVOKE ALL ON FUNCTION public.refresh_prospect_list_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_prospect_list_counts(uuid)
  TO authenticated, service_role;

-- ── the conversion ──────────────────────────────────────────────────────────
-- The most important function in this migration, and the only door between the
-- two tables.
--
-- It takes a consent source and refuses to run without one, for the same reason
-- record_lead_consent() does: what is being created here is a consent record,
-- and a consent record with no answer to "how did you obtain this" is not
-- evidence of anything. That requirement is also what keeps this from becoming
-- a bulk action — a person has to be able to say where consent came from, and a
-- person can only say that about a conversation they had.
--
-- SECURITY INVOKER, granted to `authenticated` and NOT to service_role. A
-- service-role grant would be precisely the backdoor this model exists to
-- close: a background job that turns a purchased list into consented leads
-- while nobody is looking.
--
-- The prospect is marked, never deleted. The list is the record of what was
-- bought and worked, and a converted row removed from it silently overstates
-- how well that vendor's data performed.
CREATE OR REPLACE FUNCTION public.convert_prospect_to_lead(
  p_prospect_id   uuid,
  p_consent_source text,
  p_consent_note   text DEFAULT NULL
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_prospect  public.prospects;
  v_list_name text;
  v_lead      public.leads;
  v_source    text := btrim(COALESCE(p_consent_source, ''));
  v_note      text := nullif(btrim(COALESCE(p_consent_note, '')), '');
  v_phone     text;
BEGIN
  IF v_source = '' THEN
    RAISE EXCEPTION 'A consent source is required — how was consent obtained?'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- FOR UPDATE so two operators clicking convert on the same prospect at the
  -- same moment produce one lead rather than two. RLS scopes the read.
  SELECT * INTO v_prospect FROM public.prospects
   WHERE id = p_prospect_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prospect not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent. Converting twice is a double-click or a retried request, not a
  -- request for a second lead with a second consent record on the same person.
  IF v_prospect.converted_lead_id IS NOT NULL THEN
    SELECT * INTO v_lead FROM public.leads WHERE id = v_prospect.converted_lead_id;
    IF FOUND THEN
      RETURN v_lead;
    END IF;
    -- Falls through when the lead was deleted afterwards: converted_lead_id has
    -- been NULLed by the FK, converted_at has not, and a fresh conversation
    -- deserves a fresh lead. The consent recorded below is this call's, not the
    -- deleted one's.
  END IF;

  SELECT name INTO v_list_name FROM public.prospect_lists WHERE id = v_prospect.list_id;

  v_phone := COALESCE(v_prospect.phone_mobile, v_prospect.phone_landline, v_prospect.phone_voip);

  -- leads_has_contact would reject this anyway; catching it here says which
  -- field is missing instead of surfacing a constraint name to an operator who
  -- just got off the phone with someone.
  IF v_phone IS NULL AND v_prospect.email_primary IS NULL THEN
    RAISE EXCEPTION 'This prospect has no phone and no email — skip trace it before converting'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.leads (
    team_id, name, phone, email, email_secondary,
    address, city, state, zip, county, property_type, year_built,
    owner_name, owner_type, owner_occupied,
    mailing_address, mailing_city, mailing_state, mailing_zip,
    mortgage_balance, has_liens,
    is_absentee, is_out_of_state, pre_foreclosure, tax_delinquent, vacant,
    source, source_detail, status, notes,
    first_contact_at, last_contacted_at, call_attempts,
    skip_traced, skip_traced_at, skip_trace_confidence,
    phone_mobile, phone_landline, phone_voip,
    dnc_scrubbed, dnc_scrubbed_at, is_dnc, is_litigator,
    tcpa_opt_in, tcpa_opt_in_at, tcpa_disclosure_source,
    tcpa_disclosure_version, tcpa_disclosure_text,
    consent_sms, consent_email,
    raw_payload
  ) VALUES (
    v_prospect.team_id,
    v_prospect.owner_name,
    v_phone,
    v_prospect.email_primary,
    v_prospect.email_secondary,
    v_prospect.address, v_prospect.city, v_prospect.state, v_prospect.zip,
    v_prospect.county, v_prospect.property_type, v_prospect.year_built,
    v_prospect.owner_name, v_prospect.owner_type, v_prospect.owner_occupied,
    v_prospect.mailing_address, v_prospect.mailing_city,
    v_prospect.mailing_state, v_prospect.mailing_zip,
    v_prospect.mortgage_balance, v_prospect.liens,
    v_prospect.is_absentee, v_prospect.is_out_of_state,
    v_prospect.pre_foreclosure, v_prospect.tax_delinquent, v_prospect.vacant,
    'cold_list',
    -- Which list, in words, on the lead itself. Six months later "where did
    -- this seller come from" is answered without a join through a table the
    -- operator has forgotten exists.
    v_list_name,
    -- Somebody just had a real conversation with this person. 'new' would put
    -- them back in the untouched pile.
    'contacted',
    v_prospect.call_notes,
    COALESCE(v_prospect.last_called_at, now()),
    COALESCE(v_prospect.last_called_at, now()),
    v_prospect.call_attempts,
    v_prospect.skip_traced, v_prospect.skip_traced_at, v_prospect.skip_trace_confidence,
    v_prospect.phone_mobile, v_prospect.phone_landline, v_prospect.phone_voip,
    v_prospect.dnc_scrubbed, v_prospect.dnc_scrubbed_at,
    -- The scrub flags come across as they are. A litigator hit does not stop a
    -- conversion — the conversation already happened and the record of it
    -- should exist — but it travels with the lead, where lead_is_dialable will
    -- go on refusing to dial. The veto belongs on one rail, not two.
    v_prospect.is_dnc, v_prospect.is_litigator,
    -- The same provenance shape record_lead_consent() writes. tcpa_opt_in_at is
    -- not optional: leads_opt_in_needs_provenance (20260821120000) rejects the
    -- boolean without it, because "when did they agree" is the first question
    -- anyone asks.
    true, now(), v_source, 'v1-2026-08',
    'Consent recorded by an operator during a cold-list call. Source: ' || v_source
      || COALESCE(' — ' || v_note, ''),
    true, true,
    jsonb_build_object(
      'prospect', jsonb_build_object(
        'prospect_id', v_prospect.id,
        'list_id',     v_prospect.list_id,
        'vendor_id',   v_prospect.vendor_id,
        'raw_data',    v_prospect.raw_data
      )
    )
  )
  RETURNING * INTO v_lead;

  UPDATE public.prospects SET
    converted_lead_id = v_lead.id,
    converted_at      = now()
  WHERE id = p_prospect_id;

  -- Two facts on the timeline, in one row, because they are only useful
  -- together: this person came off a bought list, AND here is how consent to
  -- contact them was obtained. Either one alone invites the wrong conclusion.
  INSERT INTO public.lead_activity (
    team_id, lead_id, actor_id, actor_kind, type, summary, payload
  ) VALUES (
    v_lead.team_id, v_lead.id, auth.uid(), 'user', 'converted_from_prospect',
    'Converted from cold list — consent: ' || v_source || COALESCE(' — ' || v_note, ''),
    jsonb_build_object(
      'prospect_id',    v_prospect.id,
      'list_id',        v_prospect.list_id,
      'vendor_id',      v_prospect.vendor_id,
      'consent_source', v_source,
      'consent_note',   v_note,
      'call_attempts',  v_prospect.call_attempts
    )
  );

  -- Keeps converted_count honest without a trigger on every row of the table.
  PERFORM public.refresh_prospect_list_counts(v_prospect.list_id);

  RETURN v_lead;
END;
$$;

COMMENT ON FUNCTION public.convert_prospect_to_lead IS
  'Turns one prospect into one lead, recording how consent was obtained. Requires a consent source, is idempotent, and marks the prospect converted rather than deleting it. Granted to authenticated only — never to service_role, because bulk conversion is exactly what this model prevents.';

REVOKE ALL ON FUNCTION public.convert_prospect_to_lead(uuid, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.convert_prospect_to_lead(uuid, text, text) TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.prospect_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospects      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prospect_lists_team_all ON public.prospect_lists;
CREATE POLICY prospect_lists_team_all ON public.prospect_lists
  FOR ALL TO authenticated
  USING (team_id = public.get_my_team_id())
  WITH CHECK (team_id = public.get_my_team_id());

DROP POLICY IF EXISTS prospects_team_all ON public.prospects;
CREATE POLICY prospects_team_all ON public.prospects
  FOR ALL TO authenticated
  USING (team_id = public.get_my_team_id())
  WITH CHECK (team_id = public.get_my_team_id());

-- ── grants ──────────────────────────────────────────────────────────────────
-- Same shape as every other table: anon keeps nothing, belt and braces over the
-- default privileges revoked in 20260817120300. What leaks here is the home
-- address, phone number and financial position of several thousand homeowners
-- who have never heard of Tossie.
REVOKE ALL ON public.prospect_lists FROM PUBLIC, anon;
REVOKE ALL ON public.prospects      FROM PUBLIC, anon;

-- DELETE is granted on both. A list imported against the wrong column mapping
-- is garbage, and the honest remedy is to throw it away and import it again —
-- there is no consent record here to destroy, which is the whole difference
-- between this table and `leads`.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prospect_lists TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prospects      TO authenticated;

-- ── realtime ────────────────────────────────────────────────────────────────
-- Lists only, never the rows. A skip-trace batch touches thousands of prospects
-- in a few minutes; publishing that table would push a message per row at a
-- browser showing a single progress number. The counters live on the list, so
-- the list is what has to move. Guarded exactly like 20260817120200 — ALTER
-- PUBLICATION ADD errors on a duplicate and would make a re-run fail.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['prospect_lists']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
