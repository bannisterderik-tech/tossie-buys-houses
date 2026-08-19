-- ============================================================================
-- Phase 1.5 — inbound lead intake from third-party sources.
-- ============================================================================
-- BUILD_PLAN §3 Phase 1.5 lists four ways a lead arrives. This migration is for
-- the one nobody else can authenticate: portals, PPC vendors and partner sites
-- that POST a lead to a URL. They cannot present a Supabase JWT, so the edge
-- function that receives them (supabase/functions/lead-intake) is deployed with
-- verify_jwt off, and this table is what authenticates the caller instead.
--
-- THE SECRET IS NEVER STORED. `secret_hash` holds a bcrypt digest, so a dump of
-- this table hands an attacker nothing they can post with. That matters more
-- here than in most places: the secret is the *only* thing between the open
-- internet and INSERTs into `leads`, and a poisoned CRM is worse than an empty
-- one — an operator who stops trusting the lead list stops working it.
--
-- CONSENT IS THE HARD PART, and it is enforced here rather than in the edge
-- function on purpose. A lead bought from a third party has not agreed to hear
-- from Tossie; the vendor's opt-in, if it exists at all, was given to the
-- vendor. `default_consent` ships FALSE, and even a source trusted to collect
-- consent only produces `tcpa_opt_in = true` when the payload carries the
-- evidence — the disclosure text and when it was agreed to. A boolean in a
-- vendor's JSON is not evidence, and treating it as one costs $500-$1,500 per
-- contact (§5).
--
-- SEARCH PATH: 'extensions' is in the list because crypt()/gen_salt() live
-- there on Supabase (the platform pre-installs pgcrypto into that schema, which
-- makes foundation's CREATE EXTENSION a no-op) and in `public` on the plain
-- Postgres scripts/db-test.sh spins up. Naming both is what makes one file work
-- against both, and getting it wrong fails at call time, not at migrate time.
-- ============================================================================

-- ── lead_sources ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_sources (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id  uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  name     text NOT NULL,
  -- What the vendor puts in the URL. Unique globally, not per team: it is the
  -- lookup key on an unauthenticated request, so two teams owning the same slug
  -- would make "which team does this lead belong to" a coin toss.
  slug     text NOT NULL UNIQUE,

  -- bcrypt, per-row salt. NULL means "no secret set yet", which authorizes
  -- nothing — a source is inert until somebody calls set_lead_source_secret().
  -- Fail-closed is the only safe default for a column whose absence would
  -- otherwise read as "no password required".
  --
  -- bcrypt rather than a plain digest even though these secrets are machine-
  -- generated and long: the per-row salt means a leaked table cannot be
  -- attacked in bulk, and it stays safe when somebody inevitably sets one by
  -- hand. The ~10ms cost is bounded by rate_limit_per_min below.
  secret_hash   text,
  secret_set_at timestamptz,

  active   boolean NOT NULL DEFAULT true,

  -- A hint about the envelope the vendor posts, not a parser selector. The edge
  -- function unwraps either shape on its own; this is here so the operator can
  -- record what a source *should* look like and notice when it changes.
  format   text NOT NULL DEFAULT 'flat',

  -- FALSE, and it stays false unless somebody can say exactly how this source
  -- collects consent and what disclosure it shows. See the header.
  default_consent boolean NOT NULL DEFAULT false,

  -- Per source, because vendors differ by two orders of magnitude: a partner
  -- site posts a handful a day, a PPC vendor bursts. The ceiling exists so that
  -- a leaked secret — or a vendor's runaway retry loop — cannot fill the CRM
  -- overnight before anybody notices.
  rate_limit_per_min integer NOT NULL DEFAULT 60,

  created_at       timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz,
  received_count   bigint NOT NULL DEFAULT 0,

  CONSTRAINT lead_sources_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  CONSTRAINT lead_sources_format_check CHECK (format IN ('flat', 'wrapped')),
  CONSTRAINT lead_sources_rate_limit_check CHECK (rate_limit_per_min BETWEEN 1 AND 6000)
);

COMMENT ON COLUMN public.lead_sources.secret_hash IS
  'bcrypt digest of the shared secret. The plaintext is shown once, when set_lead_source_secret() is called, and is not recoverable from here.';
COMMENT ON COLUMN public.lead_sources.default_consent IS
  'Whether this source genuinely collects TCPA consent. FALSE by default. Even TRUE only permits opt-in when the payload carries the disclosure and the timestamp — see ingest_lead_from_source().';

-- ── lead_intake_log ─────────────────────────────────────────────────────────
-- Every receipt, accepted or not. The rejections are the interesting half: a
-- run of `rejected_auth` against a live slug is a leaked-secret alarm, and
-- there is nowhere else it would ever show up.
CREATE TABLE IF NOT EXISTS public.lead_intake_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Both nullable: a request quoting a slug that matches nothing has no source
  -- and no team, and that request is exactly the one worth keeping.
  team_id   uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  source_id uuid REFERENCES public.lead_sources(id) ON DELETE SET NULL,

  -- As presented by the caller, so an unknown slug is still greppable.
  slug      text NOT NULL,
  outcome   text NOT NULL,
  lead_id   uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  consent_granted boolean NOT NULL DEFAULT false,
  message   text,
  remote_ip inet,

  -- Only ever written for a receipt that authenticated. An unauthenticated
  -- caller must not be able to store arbitrary JSON in our database by failing
  -- to log in — that turns an audit trail into free storage for whoever finds
  -- the URL.
  payload   jsonb NOT NULL DEFAULT '{}'::jsonb,

  received_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lead_intake_log_outcome_check CHECK (outcome IN (
    'accepted', 'updated',
    'rejected_unknown_source', 'rejected_inactive', 'rejected_auth',
    'rejected_payload', 'rate_limited'
  ))
);

-- Both lookups the rate limiter does, plus the "what has this vendor sent us"
-- query behind the source detail view.
CREATE INDEX IF NOT EXISTS lead_intake_log_source_idx
  ON public.lead_intake_log(source_id, received_at DESC);
CREATE INDEX IF NOT EXISTS lead_intake_log_slug_idx
  ON public.lead_intake_log(slug, received_at DESC);

-- ── small helpers ───────────────────────────────────────────────────────────
-- Vendors send '' as often as they send null, and '' would satisfy
-- leads_has_contact while being just as unreachable. One place to collapse the
-- two, rather than fourteen inline NULLIF(btrim(...)) calls that only have to
-- be typed wrong once.
CREATE OR REPLACE FUNCTION public.intake_field(j jsonb, k text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT NULLIF(btrim(COALESCE(j ->> k, '')), '');
$$;

-- The log keeps what the vendor sent so a surprising format can be diagnosed.
-- It does not keep a megabyte of it: the lead row already carries the full
-- payload under raw_payload, and this table gets a row per attempt including
-- the ones we refuse.
CREATE OR REPLACE FUNCTION public.intake_payload_for_log(p_raw jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT CASE
    WHEN p_raw IS NULL THEN '{}'::jsonb
    WHEN length(p_raw::text) > 20000
      THEN jsonb_build_object('truncated', true, 'bytes', length(p_raw::text))
    ELSE p_raw
  END;
$$;

-- ── setting the secret ──────────────────────────────────────────────────────
-- The only way a secret gets onto a source. SECURITY INVOKER, so RLS on the
-- UPDATE is the team check — the same reasoning as every RPC in
-- 20260817130000: a SECURITY DEFINER here would bypass RLS and force a
-- hand-written team check next to the one RLS already gets right.
--
-- The length floor is not decoration. This secret is the entire authentication
-- story for an endpoint with verify_jwt off, and the failure mode of a short
-- one is somebody guessing their way into the leads table.
CREATE OR REPLACE FUNCTION public.set_lead_source_secret(
  p_slug   text,
  p_secret text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_at timestamptz := now();
BEGIN
  IF p_secret IS NULL OR length(p_secret) < 24 THEN
    RAISE EXCEPTION 'A lead source secret must be at least 24 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.lead_sources
     SET secret_hash   = crypt(p_secret, gen_salt('bf', 10)),
         secret_set_at = v_at
   WHERE slug = lower(btrim(p_slug));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No lead source with slug %', p_slug USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_at;
END;
$$;

COMMENT ON FUNCTION public.set_lead_source_secret IS
  'Hashes and stores a source''s shared secret. The plaintext is never written anywhere — show it to the vendor once and it is gone.';

-- ── authorization + rate limit ──────────────────────────────────────────────
-- One call, because the two things it does have to happen together: an endpoint
-- that verifies the secret in one round trip and rate-limits in a second has a
-- window where neither has happened yet.
--
-- SECURITY DEFINER and service_role only. It is called by the edge function on
-- the service key; nothing signed in from a browser has any business asking
-- "is this the right secret for that slug", which is an oracle.
--
-- The OUT parameter is `source_format`, not `format`, because a PL/pgSQL
-- variable named after a built-in is a trap somebody trips over later.
CREATE OR REPLACE FUNCTION public.authorize_lead_intake(
  p_slug   text,
  p_secret text,
  p_ip     inet DEFAULT NULL
)
RETURNS TABLE (
  source_id       uuid,
  team_id         uuid,
  default_consent boolean,
  source_format   text,
  allowed         boolean,
  reason          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_slug   text := lower(btrim(COALESCE(p_slug, '')));
  v_src    public.lead_sources;
  v_recent integer;
  v_limit  integer;
BEGIN
  IF v_slug = '' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, false, NULL::text, false, 'no_slug'::text;
    RETURN;
  END IF;

  SELECT * INTO v_src FROM public.lead_sources WHERE slug = v_slug;

  -- Rate limiting happens BEFORE the secret check, and is keyed on the slug
  -- rather than on the source, so an unknown slug is limited too. Otherwise the
  -- cheapest attack on this endpoint is to spray nonexistent slugs: each one
  -- costs a log row, forever, and none of them ever trip a limit.
  --
  -- An unknown slug gets a deliberately tight ceiling. It is either a
  -- misconfigured vendor — who will call support, not retry sixty times a
  -- minute — or a probe.
  v_limit := COALESCE(v_src.rate_limit_per_min, 10);

  -- rate_limited rows are excluded from their own count. Including them would
  -- make the window ratchet: every rejection would push the count further above
  -- the ceiling, and a source would stay locked out long after its burst ended.
  SELECT count(*) INTO v_recent
  FROM public.lead_intake_log
  WHERE slug = v_slug
    AND received_at > now() - interval '1 minute'
    AND outcome <> 'rate_limited';

  IF v_recent >= v_limit THEN
    -- One rate_limited row per window per slug. The log exists to tell somebody
    -- a vendor is hammering us; a row per rejected request would let the flood
    -- we are refusing fill the table we are refusing it into.
    IF NOT EXISTS (
      SELECT 1 FROM public.lead_intake_log
      WHERE slug = v_slug AND outcome = 'rate_limited'
        AND received_at > now() - interval '1 minute'
    ) THEN
      INSERT INTO public.lead_intake_log (team_id, source_id, slug, outcome, message, remote_ip)
      VALUES (v_src.team_id, v_src.id, v_slug, 'rate_limited',
              v_recent || ' receipts in the last minute, limit ' || v_limit, p_ip);
    END IF;
    RETURN QUERY SELECT v_src.id, v_src.team_id, false, v_src.format, false, 'rate_limited'::text;
    RETURN;
  END IF;

  IF v_src.id IS NULL THEN
    INSERT INTO public.lead_intake_log (slug, outcome, message, remote_ip)
    VALUES (v_slug, 'rejected_unknown_source', 'No lead source with this slug', p_ip);
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, false, NULL::text, false, 'unknown_source'::text;
    RETURN;
  END IF;

  -- A source with no secret set authorizes nobody. This branch is what keeps a
  -- half-configured source from being an open endpoint for however long it
  -- takes somebody to come back and finish setting it up.
  IF v_src.secret_hash IS NULL
     OR p_secret IS NULL OR p_secret = ''
     OR v_src.secret_hash <> crypt(p_secret, v_src.secret_hash) THEN
    INSERT INTO public.lead_intake_log (team_id, source_id, slug, outcome, message, remote_ip)
    VALUES (v_src.team_id, v_src.id, v_slug, 'rejected_auth',
            CASE WHEN v_src.secret_hash IS NULL
                 THEN 'No secret configured for this source'
                 ELSE 'Bad or missing secret' END,
            p_ip);
    RETURN QUERY SELECT v_src.id, v_src.team_id, false, v_src.format, false, 'bad_secret'::text;
    RETURN;
  END IF;

  -- Deliberately AFTER the secret check, not before. A switched-off source that
  -- answered "inactive" to an unauthenticated caller would turn this endpoint
  -- into a slug enumerator: guess names, and the ones that come back with
  -- anything other than the generic refusal are real. Only a caller who already
  -- holds the secret learns that their source is paused — which is the one
  -- caller who needs to be told plainly, because otherwise they debug a
  -- credential problem they do not have.
  IF NOT v_src.active THEN
    INSERT INTO public.lead_intake_log (team_id, source_id, slug, outcome, message, remote_ip)
    VALUES (v_src.team_id, v_src.id, v_slug, 'rejected_inactive', 'Source is switched off', p_ip);
    RETURN QUERY SELECT v_src.id, v_src.team_id, false, v_src.format, false, 'inactive'::text;
    RETURN;
  END IF;

  -- Authorized. No log row here: the receipt is logged by
  -- ingest_lead_from_source() with what actually happened to the lead, and two
  -- rows per accepted post would make the rate-limit count double what it says.
  RETURN QUERY SELECT v_src.id, v_src.team_id, v_src.default_consent, v_src.format, true, 'ok'::text;
END;
$$;

COMMENT ON FUNCTION public.authorize_lead_intake IS
  'Authenticates a third-party lead post by slug + shared secret, rate-limits it, and logs every rejection. Service role only — from a browser this would be a secret-guessing oracle.';

-- ── the insert path ─────────────────────────────────────────────────────────
-- Dedup, consent and logging in one transaction. It lives in the database
-- rather than in the edge function for the same reason lead_is_dialable() does:
-- it is the rule, and a rule a caller can decline to apply is a convention. The
-- next intake path somebody builds gets it for free.
CREATE OR REPLACE FUNCTION public.ingest_lead_from_source(
  p_source_id uuid,
  p_lead      jsonb,
  p_raw       jsonb,
  p_consent   jsonb DEFAULT '{}'::jsonb,
  p_ip        inet  DEFAULT NULL
)
RETURNS TABLE (
  lead_id         uuid,
  action          text,
  consent_granted boolean,
  message         text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_src        public.lead_sources;
  v_key        text;
  v_email      text;
  v_lead_id    uuid;
  v_action     text;
  v_msg        text := NULL;
  v_receipt    jsonb;

  v_claimed    boolean := false;
  v_disclosure text;
  v_at         timestamptz;
  v_consent_ip inet;
  v_granted    boolean := false;
BEGIN
  SELECT * INTO v_src FROM public.lead_sources WHERE id = p_source_id;
  IF v_src.id IS NULL THEN
    RAISE EXCEPTION 'Unknown lead source' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── consent ──────────────────────────────────────────────────────────────
  -- Three gates, all of which have to open. The source must be one we have
  -- decided actually collects consent; this particular payload must claim it;
  -- and the payload must carry the evidence.
  --
  -- The timestamp is required because leads_opt_in_needs_provenance
  -- (20260821120000) refuses the row without it, and because "when did they
  -- agree" is the first question anyone asks. The disclosure text is required
  -- because it is the second. The IP is stored when present and NOT required:
  -- a vendor posting server-side about a form filled hours earlier legitimately
  -- may not have it, and throwing away otherwise-good evidence over a missing
  -- inet would push consent recording back out of the system — the exact
  -- failure 20260821120000 exists to undo. Its absence is noted on the receipt.
  --
  -- Every parse below is wrapped, because a vendor's malformed field is missing
  -- evidence, not a reason to drop a lead. Unparseable lands cold, which is the
  -- safe side of the decision.
  BEGIN
    v_claimed := COALESCE((p_consent ->> 'claimed')::boolean, false);
  EXCEPTION WHEN others THEN
    v_claimed := false;
  END;

  v_disclosure := public.intake_field(p_consent, 'text');

  BEGIN
    v_at := public.intake_field(p_consent, 'at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_at := NULL;
  END;

  BEGIN
    v_consent_ip := public.intake_field(p_consent, 'ip')::inet;
  EXCEPTION WHEN others THEN
    v_consent_ip := NULL;
  END;

  -- A consent timestamp in the future is not evidence of anything. A little
  -- slack for a vendor whose clock drifts; a day out is a fabricated field.
  IF v_at IS NOT NULL AND v_at > now() + interval '1 day' THEN
    v_at := NULL;
  END IF;

  v_granted := v_src.default_consent AND v_claimed
               AND v_disclosure IS NOT NULL AND v_at IS NOT NULL;

  IF v_claimed AND NOT v_granted THEN
    v_msg := CASE
      WHEN NOT v_src.default_consent
        THEN 'Source claimed consent but is not marked as collecting it — stored as cold'
      ELSE 'Source claimed consent without disclosure text and timestamp — stored as cold'
    END;
  ELSIF v_granted AND v_consent_ip IS NULL THEN
    v_msg := 'Consent recorded without an originating IP';
  END IF;

  -- ── dedup key ────────────────────────────────────────────────────────────
  v_key   := COALESCE(
    public.phone_key(public.intake_field(p_lead, 'phone')),
    public.phone_key(public.intake_field(p_lead, 'phone_mobile'))
  );
  v_email := lower(public.intake_field(p_lead, 'email'));

  -- leads_has_contact would refuse this row anyway. Refusing it here means the
  -- vendor gets a 400 naming the missing field instead of a constraint name,
  -- and the attempt still lands on the log where a pattern of them is visible.
  IF v_key IS NULL AND v_email IS NULL THEN
    INSERT INTO public.lead_intake_log (team_id, source_id, slug, outcome, message, remote_ip, payload)
    VALUES (v_src.team_id, v_src.id, v_src.slug, 'rejected_payload',
            'No phone and no email — nothing to work the lead with', p_ip,
            public.intake_payload_for_log(p_raw));
    RETURN QUERY SELECT NULL::uuid, 'rejected'::text, false, 'No phone and no email'::text;
    RETURN;
  END IF;

  -- Serialize find-then-insert. Two posts of the same lead arriving together —
  -- which is exactly what a vendor's retry looks like — would otherwise both
  -- find nothing and both insert. There is no unique index on phone_key to
  -- collide on, and adding one would change the rules for the website form and
  -- the CSV import too, which is not this migration's call to make.
  PERFORM pg_advisory_xact_lock(hashtext(v_src.team_id::text || ':' || COALESCE(v_key, v_email)));

  -- Phone first; email only when there is no phone at all. A shared household
  -- email is a much weaker identity claim than a phone number, and merging two
  -- sellers into one lead is worse than carrying a duplicate.
  SELECT id INTO v_lead_id
  FROM public.leads
  WHERE team_id = v_src.team_id
    AND NOT trashed
    AND v_key IS NOT NULL
    AND (public.phone_key(phone) = v_key OR public.phone_key(phone_mobile) = v_key)
  ORDER BY created_at
  LIMIT 1;

  IF v_lead_id IS NULL AND v_key IS NULL AND v_email IS NOT NULL THEN
    SELECT id INTO v_lead_id
    FROM public.leads
    WHERE team_id = v_src.team_id AND NOT trashed AND lower(email) = v_email
    ORDER BY created_at
    LIMIT 1;
  END IF;

  -- The whole vendor payload, appended rather than replaced. When a format
  -- surprises us the answer is in here, and on a re-post it is the second entry
  -- that shows what changed.
  v_receipt := jsonb_build_object(
    'source', v_src.slug,
    'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'payload', p_raw
  );

  IF v_lead_id IS NOT NULL THEN
    -- ── update ─────────────────────────────────────────────────────────────
    -- COALESCE(existing, incoming) everywhere: a re-post fills gaps and never
    -- overwrites. What an operator typed, or what a skip trace found, outranks
    -- whatever the vendor happens to be sending this week.
    UPDATE public.leads SET
      name          = COALESCE(name,          public.intake_field(p_lead, 'name')),
      phone         = COALESCE(phone,         public.intake_field(p_lead, 'phone')),
      phone_mobile  = COALESCE(phone_mobile,  public.intake_field(p_lead, 'phone_mobile')),
      email         = COALESCE(email,         public.intake_field(p_lead, 'email')),
      address       = COALESCE(address,       public.intake_field(p_lead, 'address')),
      city          = COALESCE(city,          public.intake_field(p_lead, 'city')),
      state         = COALESCE(state,         public.intake_field(p_lead, 'state')),
      zip           = COALESCE(zip,           public.intake_field(p_lead, 'zip')),
      county        = COALESCE(county,        public.intake_field(p_lead, 'county')),
      owner_name    = COALESCE(owner_name,    public.intake_field(p_lead, 'owner_name')),
      motivation    = COALESCE(motivation,    public.intake_field(p_lead, 'motivation')),
      notes         = COALESCE(notes,         public.intake_field(p_lead, 'notes')),
      property_type = COALESCE(property_type, public.intake_field(p_lead, 'property_type')),

      -- Consent ratchets one way, and only on evidence. A vendor re-post must
      -- not be able to withdraw a consent an operator recorded by hand, and
      -- must not be able to restate one either: the `AND NOT tcpa_opt_in`
      -- guards mean whoever recorded it first keeps the provenance, rather than
      -- having it silently replaced by a vendor's version of the story.
      tcpa_opt_in            = tcpa_opt_in OR v_granted,
      tcpa_opt_in_at         = CASE WHEN v_granted AND NOT tcpa_opt_in THEN v_at         ELSE tcpa_opt_in_at END,
      tcpa_disclosure_text   = CASE WHEN v_granted AND NOT tcpa_opt_in THEN v_disclosure ELSE tcpa_disclosure_text END,
      tcpa_disclosure_source = CASE WHEN v_granted AND NOT tcpa_opt_in THEN 'lead source: ' || v_src.slug ELSE tcpa_disclosure_source END,
      tcpa_disclosure_ip     = CASE WHEN v_granted AND NOT tcpa_opt_in THEN v_consent_ip ELSE tcpa_disclosure_ip END,
      consent_sms            = consent_sms   OR v_granted,
      consent_email          = consent_email OR v_granted,

      raw_payload = raw_payload || jsonb_build_object(
        'lead_intake',
        COALESCE(raw_payload -> 'lead_intake', '[]'::jsonb) || jsonb_build_array(v_receipt)
      )
    WHERE id = v_lead_id;

    v_action := 'updated';
  ELSE
    -- ── insert ─────────────────────────────────────────────────────────────
    INSERT INTO public.leads (
      team_id, name, phone, phone_mobile, email,
      address, city, state, zip, county,
      owner_name, motivation, notes, property_type,
      source, source_detail, temperature, status,
      tcpa_opt_in, tcpa_opt_in_at, tcpa_disclosure_text,
      tcpa_disclosure_version, tcpa_disclosure_source, tcpa_disclosure_ip,
      consent_sms, consent_email,
      raw_payload
    ) VALUES (
      v_src.team_id,
      public.intake_field(p_lead, 'name'),
      public.intake_field(p_lead, 'phone'),
      public.intake_field(p_lead, 'phone_mobile'),
      public.intake_field(p_lead, 'email'),
      public.intake_field(p_lead, 'address'),
      public.intake_field(p_lead, 'city'),
      public.intake_field(p_lead, 'state'),
      public.intake_field(p_lead, 'zip'),
      public.intake_field(p_lead, 'county'),
      public.intake_field(p_lead, 'owner_name'),
      public.intake_field(p_lead, 'motivation'),
      public.intake_field(p_lead, 'notes'),
      public.intake_field(p_lead, 'property_type'),
      'vendor',
      v_src.slug,
      -- Warm only when somebody actually agreed to hear from us. Everything
      -- else is a cold lead that has to be traced and scrubbed before it can be
      -- dialled, and the temperature is the first thing an operator reads.
      CASE WHEN v_granted THEN 'warm' ELSE 'cold' END,
      'new',
      v_granted,
      CASE WHEN v_granted THEN v_at END,
      CASE WHEN v_granted THEN v_disclosure END,
      CASE WHEN v_granted THEN public.intake_field(p_consent, 'version') END,
      CASE WHEN v_granted THEN 'lead source: ' || v_src.slug END,
      CASE WHEN v_granted THEN v_consent_ip END,
      v_granted,
      v_granted,
      jsonb_build_object('lead_intake', jsonb_build_array(v_receipt))
    )
    RETURNING id INTO v_lead_id;

    v_action := 'accepted';
  END IF;

  -- The lead_created row comes from place_new_lead_on_pipeline. This is the
  -- part that trigger cannot know: which vendor, and whether they claimed a
  -- consent we refused to honour. That last one is the line somebody reads when
  -- a source turns out to be reselling recycled leads.
  INSERT INTO public.lead_activity (team_id, lead_id, actor_kind, type, summary, payload)
  VALUES (
    v_src.team_id, v_lead_id, 'system', 'lead_intake',
    CASE WHEN v_action = 'updated' THEN 'Re-posted by ' ELSE 'Received from ' END
      || v_src.name
      || CASE WHEN v_granted THEN ' (consent recorded)' ELSE ' (cold — no consent)' END,
    jsonb_build_object(
      'source', v_src.slug, 'action', v_action,
      'consent_granted', v_granted, 'consent_claimed', v_claimed,
      'note', v_msg
    )
  );

  INSERT INTO public.lead_intake_log (
    team_id, source_id, slug, outcome, lead_id, consent_granted, message, remote_ip, payload
  ) VALUES (
    v_src.team_id, v_src.id, v_src.slug, v_action, v_lead_id, v_granted, v_msg, p_ip,
    public.intake_payload_for_log(p_raw)
  );

  UPDATE public.lead_sources
     SET last_received_at = now(), received_count = received_count + 1
   WHERE id = v_src.id;

  RETURN QUERY SELECT v_lead_id, v_action, v_granted, v_msg;
END;
$$;

COMMENT ON FUNCTION public.ingest_lead_from_source IS
  'Writes a third-party lead: dedups on phone_key, keeps the whole vendor payload, logs the receipt, and grants tcpa_opt_in only when the source is trusted AND the payload carries the disclosure and the timestamp. Service role only.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.lead_sources    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_intake_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_sources_team_all ON public.lead_sources;
CREATE POLICY lead_sources_team_all ON public.lead_sources
  FOR ALL TO authenticated
  USING (team_id = public.get_my_team_id())
  WITH CHECK (team_id = public.get_my_team_id());

DROP POLICY IF EXISTS lead_intake_log_team_all ON public.lead_intake_log;
CREATE POLICY lead_intake_log_team_all ON public.lead_intake_log
  FOR ALL TO authenticated
  USING (team_id = public.get_my_team_id())
  WITH CHECK (team_id = public.get_my_team_id());

-- ── grants ──────────────────────────────────────────────────────────────────
-- Same shape as every other table: anon keeps nothing, belt and braces over the
-- default privileges revoked in 20260817120300.
REVOKE ALL ON public.lead_sources    FROM PUBLIC, anon;
REVOKE ALL ON public.lead_intake_log FROM PUBLIC, anon;

-- Sources are operator-managed. `authenticated` can read secret_hash, which is
-- fine — it is a bcrypt digest, and the operator is the person who set it. What
-- nobody can read is the plaintext, because it does not exist anywhere.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_sources TO authenticated;

-- The log is a ledger the server writes and a human reads. No INSERT, so
-- nothing signed in from a browser can forge a receipt; no DELETE, for the same
-- reason sms_messages has none (20260818120000) — it is the record of what a
-- vendor sent and when, and it is the evidence if a lead's provenance is ever
-- questioned.
GRANT SELECT ON public.lead_intake_log TO authenticated;

REVOKE ALL ON FUNCTION public.authorize_lead_intake(text, text, inet)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_lead_from_source(uuid, jsonb, jsonb, jsonb, inet)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_lead_intake(text, text, inet)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_lead_from_source(uuid, jsonb, jsonb, jsonb, inet) TO service_role;

REVOKE ALL ON FUNCTION public.set_lead_source_secret(text, text)    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_lead_source_secret(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.intake_field(jsonb, text)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.intake_payload_for_log(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_field(jsonb, text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intake_payload_for_log(jsonb) TO service_role;

-- ── realtime ────────────────────────────────────────────────────────────────
-- Guarded exactly like 20260817120200 — ALTER PUBLICATION ADD errors on a
-- duplicate, which would make re-running this migration fail. `leads` is
-- already published, so a vendor lead appears in the list on its own; this is
-- for the intake log, which is the only place a *rejected* post is ever seen.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['lead_intake_log']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
