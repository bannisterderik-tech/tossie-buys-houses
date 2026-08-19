-- ============================================================================
-- Phase 5 — the wholesaler deal system: deals, buyers, dispo, dates, events.
-- ============================================================================
-- BUILD_PLAN §4. Everything before this migration is about acquiring a seller;
-- this is about what happens after one signs, which is where a wholesaler
-- actually gets paid and where the two things that cost real money live:
-- a missed inspection deadline and a missed closing date.
--
-- Three ideas shape the whole file.
--
-- 1. THE FALLBACK PATHS ARE THE JOB. A seller backing out, a buyer reneging and
--    the deal going back out to the list, an extension, a termination inside
--    the inspection period — those are a normal month, not exceptions. A status
--    model where any of them is a dead end forces the operator to lie to the
--    database (mark it closed, mark it dead, start a second row) and then the
--    money view is wrong forever. So transitions are explicit and reversible,
--    enforced by a trigger, and the only genuinely terminal state is `closed`.
--
-- 2. THE BUYERS LIST IS THE ASSET, AND IT IS ALSO A TCPA SURFACE. Cash buyers
--    are businesses, and business-to-business texting to a mobile number is
--    still covered by the TCPA — "it's a business contact" is not a defence.
--    So buyers carry the same consent shape as leads and the same opt-out
--    check, and there is a single function, buyer_is_textable(), that the
--    matcher and the dispo blast both go through. See BUILD_PLAN §5.
--
-- 3. AN UNRANKED LIST IS A LIST NOBODY TRUSTS. match_buyers_for_deal() scores
--    and explains every match, and refuses to return buyers who never agreed to
--    be texted. That refusal is not politeness: Tossie's A2P 10DLC campaign is
--    registered Low Volume Mixed, and the defensible traffic under it is
--    messages to buyers who asked to hear about deals. A blast to an
--    unsegmented list is how the campaign gets suspended.
--
-- Every outbound message still goes through the twilio-send-sms edge function.
-- Nothing in this file sends anything; it decides who is eligible to be sent to.
-- ============================================================================

-- ── a small case-insensitive array helper ───────────────────────────────────
-- Buy boxes are typed by a human: 'Chatham', 'chatham ', 'CHATHAM'. Matching
-- them with `@>` would silently drop a buyer whose county happens to be
-- capitalised differently from the deal's, and the failure mode is invisible —
-- the buyer just never appears on a list. Normalising at write time was the
-- alternative and it is worse: it destroys what the operator typed, and the
-- first import from a spreadsheet puts it back.
CREATE OR REPLACE FUNCTION public.text_array_contains_ci(p_haystack text[], p_needle text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT p_needle IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_haystack, '{}'::text[])) AS v
     WHERE lower(btrim(v)) = lower(btrim(p_needle))
  );
$$;

COMMENT ON FUNCTION public.text_array_contains_ci IS
  'Case- and whitespace-insensitive membership test for the buy-box arrays. NULL needle is false, not NULL, so it cannot swallow an AND chain.';

REVOKE ALL ON FUNCTION public.text_array_contains_ci(text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.text_array_contains_ci(text[], text) TO authenticated, service_role;

-- ── buyers ──────────────────────────────────────────────────────────────────
-- The cash buyers list. Contact, entity, proof of funds, buy box, track record.
CREATE TABLE IF NOT EXISTS public.buyers (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Contact + entity. The person you text is rarely the name on the deed, and
  -- the assignment agreement needs the entity, so both are kept.
  name            text NOT NULL,
  entity_name     text,
  email           text,
  phone           text,
  phone_secondary text,

  -- Proof of funds. A buyer without current POF is not a buyer, they are a
  -- tyre-kicker who will tie up a contract for nine days. The date matters more
  -- than the file: a bank letter from last year proves nothing.
  proof_of_funds_url    text,
  proof_of_funds_date   date,
  proof_of_funds_amount integer,

  -- ── the buy box ───────────────────────────────────────────────────────────
  -- Empty array means "no restriction", NOT "matches nothing". That default is
  -- deliberate: a buyer added in thirty seconds during a phone call has an
  -- empty box and should still show up on lists, because the alternative is
  -- that the operator skips adding them at all.
  counties        text[] NOT NULL DEFAULT '{}',
  zips            text[] NOT NULL DEFAULT '{}',
  property_types  text[] NOT NULL DEFAULT '{}',
  price_min       integer,
  price_max       integer,
  beds_min        numeric(4,1),

  -- The margin this buyer needs on top of what they pay us. Compared against
  -- deals.buyer_spread, not against our spread — see the note on that column.
  min_spread      integer,

  rehab_tolerance text,
  funding         text,
  typical_close_days integer,

  -- Occupied/tenanted is the single most common reason a buyer walks after
  -- saying yes, so it is a column rather than a line in the notes.
  takes_occupied  boolean NOT NULL DEFAULT false,

  notes           text,

  -- ── track record ──────────────────────────────────────────────────────────
  -- deals_reneged is the load-bearing one. A buyer who has closed six and
  -- reneged three is not a better buyer than one who has closed two and
  -- reneged none, and a list sorted by volume would say he is. The matcher
  -- penalises it heavily and says so out loud in the reasons.
  deals_closed      integer NOT NULL DEFAULT 0,
  deals_reneged     integer NOT NULL DEFAULT 0,
  avg_close_days    numeric(6,2),
  last_purchase_date date,
  rating            integer,

  -- ── consent ───────────────────────────────────────────────────────────────
  -- Same shape as leads, on purpose, so there is one mental model for "may we
  -- contact this person" across the whole system. The temptation to skip this
  -- for buyers is strong and wrong: these are cell numbers, the TCPA does not
  -- carve out B2B, and a dispo blast is exactly the kind of bulk marketing
  -- traffic that gets read back to you in a demand letter.
  consent_sms     boolean NOT NULL DEFAULT false,
  consent_email   boolean NOT NULL DEFAULT false,
  tcpa_opt_in     boolean NOT NULL DEFAULT false,
  tcpa_opt_in_at  timestamptz,
  tcpa_disclosure_text    text,
  tcpa_disclosure_version text,
  tcpa_disclosure_source  text,

  -- 'paused' is a buyer who is temporarily out of money or out of appetite —
  -- they come back. 'blacklisted' is one you will not sell to again. Both are
  -- excluded from matching; keeping them apart is what lets you unpause the
  -- first group without resurrecting the second.
  status text NOT NULL DEFAULT 'active',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT buyers_status_check CHECK (status IN ('active', 'paused', 'blacklisted')),
  CONSTRAINT buyers_rehab_tolerance_check CHECK (rehab_tolerance IS NULL OR rehab_tolerance IN (
    'light', 'medium', 'heavy', 'full_gut'
  )),
  CONSTRAINT buyers_funding_check CHECK (funding IS NULL OR funding IN (
    'cash', 'hard_money', 'financed'
  )),
  CONSTRAINT buyers_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT buyers_price_range_check CHECK (
    price_min IS NULL OR price_max IS NULL OR price_min <= price_max
  ),
  -- A buyer has to be reachable somehow, same rule as leads_has_contact.
  CONSTRAINT buyers_has_contact CHECK (phone IS NOT NULL OR email IS NOT NULL),

  -- Identical to leads_opt_in_needs_provenance (20260821120000) and for the
  -- identical reason: the bare boolean is not evidence, and "when did they
  -- agree" is the first question anyone asks. record_buyer_consent() below is
  -- what keeps this from being a trap for the UI.
  CONSTRAINT buyers_opt_in_needs_provenance CHECK (
    NOT tcpa_opt_in OR tcpa_opt_in_at IS NOT NULL
  )
);

-- One buyer per number per team. Two rows for the same phone means the dispo
-- blast texts that buyer twice, which reads as spam to a carrier and as
-- carelessness to the buyer. phone_key() so a number typed with dashes on one
-- row and parentheses on another still collides.
CREATE UNIQUE INDEX IF NOT EXISTS buyers_team_phone_key_idx
  ON public.buyers(team_id, public.phone_key(phone)) WHERE phone IS NOT NULL;

-- The inbound side: an opt-out webhook has a number and needs the buyer.
CREATE INDEX IF NOT EXISTS buyers_phone_key_idx
  ON public.buyers(public.phone_key(phone)) WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS buyers_team_status_idx ON public.buyers(team_id, status);

-- The buy-box filters in match_buyers_for_deal are array containment scans.
-- GIN on the three arrays keeps that from being a full table scan once the
-- list is a few thousand buyers long.
CREATE INDEX IF NOT EXISTS buyers_counties_idx       ON public.buyers USING gin(counties);
CREATE INDEX IF NOT EXISTS buyers_zips_idx           ON public.buyers USING gin(zips);
CREATE INDEX IF NOT EXISTS buyers_property_types_idx ON public.buyers USING gin(property_types);

COMMENT ON TABLE public.buyers IS
  'Cash buyers. The buy box drives match_buyers_for_deal; the consent columns decide whether a matched buyer may actually be texted.';
COMMENT ON COLUMN public.buyers.deals_reneged IS
  'Times this buyer backed out after being selected. Not a vanity metric — it is how you decide who gets the first call, and the matcher subtracts heavily for it.';
COMMENT ON COLUMN public.buyers.counties IS
  'Empty means no geographic restriction, not "matches nothing". Compared case-insensitively via text_array_contains_ci.';

DROP TRIGGER IF EXISTS buyers_touch ON public.buyers;
CREATE TRIGGER buyers_touch BEFORE UPDATE ON public.buyers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── may we text this buyer ──────────────────────────────────────────────────
-- The buyers-side twin of lead_is_dialable, and STABLE for the same reason:
-- it reads telephony_opt_outs, so claiming IMMUTABLE would let the planner fold
-- it into a cached plan that no STOP message can invalidate. It therefore
-- cannot appear in an index expression, which is fine — nothing indexes it.
--
-- Both numbers are checked. A buyer who texts STOP from his cell has opted out;
-- blasting his office line because the STOP arrived elsewhere is the same
-- mistake as doing it to a seller, and costs the same $500-$1,500 per message.
CREATE OR REPLACE FUNCTION public.buyer_is_textable(b public.buyers)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT b.status = 'active'
     AND b.phone IS NOT NULL
     -- Both, not either. consent_sms is the channel switch an operator flips;
     -- tcpa_opt_in is the assertion that the buyer actually agreed, and the
     -- provenance CHECK is what makes that assertion mean something.
     AND b.consent_sms
     AND b.tcpa_opt_in
     AND NOT public.is_opted_out(b.team_id, b.phone)
     AND NOT public.is_opted_out(b.team_id, b.phone_secondary);
$$;

COMMENT ON FUNCTION public.buyer_is_textable IS
  'Single source of truth for "may we text this buyer". The dispo blast and match_buyers_for_deal both go through it. STABLE because it reads telephony_opt_outs — not usable in an index expression.';

REVOKE ALL ON FUNCTION public.buyer_is_textable(public.buyers) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_is_textable(public.buyers) TO authenticated, service_role;

-- is_opted_out (20260818120000) was granted to `authenticated` only. The dispo
-- blast runs as an edge function on the service role and calls it through the
-- two functions above, which are SECURITY INVOKER — so without this grant the
-- blast fails on a permission error at exactly the moment it is about to send.
-- Failing closed is the right direction, but failing closed with a confusing
-- error every single time is not a design, it is a bug waiting to be worked
-- around.
GRANT EXECUTE ON FUNCTION public.is_opted_out(uuid, text) TO service_role;

-- ── recording a buyer's consent ─────────────────────────────────────────────
-- Exists for the same reason record_lead_consent does: a CHECK constraint the
-- UI cannot legally satisfy just pushes people out of the system, and then the
-- consent record lives in somebody's inbox instead of the database.
--
-- SECURITY INVOKER — RLS on the UPDATE is the team check. There is no audit
-- table here on purpose: the disclosure columns on the row ARE the record, and
-- a buyer's consent is not the kind of thing that gets revoked and re-granted
-- in a loop the way a seller's suppression does.
CREATE OR REPLACE FUNCTION public.record_buyer_consent(
  p_buyer_id uuid,
  p_source   text,
  p_note     text DEFAULT NULL
)
RETURNS public.buyers
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_buyer public.buyers;
BEGIN
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RAISE EXCEPTION 'A consent source is required — how was consent obtained?'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.buyers SET
    tcpa_opt_in             = true,
    tcpa_opt_in_at          = COALESCE(tcpa_opt_in_at, now()),
    tcpa_disclosure_source  = btrim(p_source),
    tcpa_disclosure_version = COALESCE(tcpa_disclosure_version, 'v1-2026-08'),
    tcpa_disclosure_text    = COALESCE(
      tcpa_disclosure_text,
      'Buyer agreed to receive deal notifications by text. Source: ' || btrim(p_source)
        || COALESCE(' — ' || nullif(btrim(p_note), ''), '')
    ),
    consent_sms   = true,
    consent_email = true
  WHERE id = p_buyer_id
  RETURNING * INTO v_buyer;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_buyer;
END;
$$;

REVOKE ALL ON FUNCTION public.record_buyer_consent(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_buyer_consent(uuid, text, text) TO authenticated;

-- ── the deal status model ───────────────────────────────────────────────────
-- Read the transition map before adding a status. The shape is: every state has
-- a way out, `dead` is always reachable, and `closed` is the only state that is
-- nearly terminal.
--
-- Why a map at all, rather than a bare CHECK on the column: a CHECK stops
-- `status = 'banana'` but happily allows `closed -> dispo`, which silently
-- un-collects a fee that the money view has already counted. The map is the
-- part that makes the money view trustworthy.
--
-- Why it is generous rather than strict: a transition guard that traps an
-- operator is the same failure as a compliance rail that pushes people off the
-- rails (20260819130000). Anything genuinely routine is allowed, including the
-- ones that feel like going backwards — a seller who terminated and then rang
-- back a week later is a Tuesday.
--
-- `closed -> assigned` is the single escape hatch, and it is narrow on purpose:
-- it exists so a premature "closed" tap can be undone, and it deliberately does
-- not go straight to dispo or dead, so undoing a close is a visible two-step.
CREATE OR REPLACE FUNCTION public.deal_status_can_transition(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT CASE
    WHEN p_from IS NULL OR p_to IS NULL THEN false
    WHEN p_from = p_to THEN true
    -- Checked before the blanket `-> dead` rule below, so a closed deal cannot
    -- be quietly retired out of the money view either.
    WHEN p_from = 'closed' THEN p_to = 'assigned'
    -- Any live deal can be abandoned. Nothing is served by making someone pick
    -- a plausible-sounding intermediate status for a deal that just evaporated.
    WHEN p_to = 'dead' THEN true
    ELSE p_to = ANY (CASE p_from
      -- Not executed yet. Either it gets signed or it never existed.
      WHEN 'draft' THEN ARRAY['under_contract']

      -- Signed. Normally you start marketing; sometimes you inspect first and
      -- walk, and sometimes the seller changes their mind before you list it.
      WHEN 'under_contract' THEN ARRAY[
        'dispo', 'buyer_selected', 'assigned', 'extension_pending',
        'terminated_inspection', 'seller_terminated']

      -- Out to the buyers list.
      WHEN 'dispo' THEN ARRAY[
        'buyer_selected', 'under_contract', 'extension_pending',
        'terminated_inspection', 'seller_terminated']

      -- A buyer said yes and is papering the assignment. They can still vanish,
      -- and back to dispo is the whole point of tracking it this way.
      WHEN 'buyer_selected' THEN ARRAY[
        'assigned', 'dispo', 'buyer_fell_through', 'extension_pending',
        'terminated_inspection', 'seller_terminated']

      -- Assignment signed, waiting on the table.
      WHEN 'assigned' THEN ARRAY[
        'closed', 'buyer_fell_through', 'extension_pending', 'seller_terminated']

      -- Waiting on a signed extension addendum. A real operational state: the
      -- closing date on the row is no longer the date anyone believes, and
      -- marketing on it would be marketing a date you do not have.
      WHEN 'extension_pending' THEN ARRAY[
        'under_contract', 'dispo', 'buyer_selected', 'assigned',
        'terminated_inspection', 'seller_terminated']

      -- The buyer walked. Re-dispo is the default; occasionally the calendar
      -- has run out and you go straight to an extension or a termination.
      WHEN 'buyer_fell_through' THEN ARRAY[
        'dispo', 'buyer_selected', 'extension_pending',
        'terminated_inspection', 'seller_terminated']

      -- Both terminations can come back. Sellers reconsider, and a property you
      -- walked from at $180k is sometimes a property you want at $150k.
      WHEN 'seller_terminated'     THEN ARRAY['under_contract', 'dispo']
      WHEN 'terminated_inspection' THEN ARRAY['under_contract', 'dispo']

      WHEN 'dead' THEN ARRAY['under_contract', 'dispo']
      ELSE ARRAY[]::text[]
    END)
  END;
$$;

COMMENT ON FUNCTION public.deal_status_can_transition IS
  'The deal lifecycle as a transition map. Fallback paths (seller backs out, buyer reneges and you re-dispo, extension, terminate in inspection) are first-class and reversible. closed is terminal except for a single narrow undo to assigned.';

REVOKE ALL ON FUNCTION public.deal_status_can_transition(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deal_status_can_transition(text, text) TO authenticated, service_role;

-- ── deals ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deals (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- The seller. SET NULL rather than CASCADE: deleting a lead must not delete
  -- the record of a property that went under contract and the fee it earned.
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,

  -- ── property ──────────────────────────────────────────────────────────────
  -- Copied onto the deal rather than read through lead_id, because the lead is
  -- a person and the deal is a house. The same seller can bring three houses,
  -- and a lead row edited a year later must not rewrite what was contracted.
  address    text NOT NULL,
  city       text,
  state      text,
  zip        text,
  county     text,
  parcel_id  text,
  property_type text,
  beds       numeric(4,1),
  baths      numeric(4,1),
  sqft       integer,
  year_built integer,

  -- How much work it needs, on the same scale buyers state their tolerance on,
  -- so the two are directly comparable instead of being matched by adjective.
  rehab_level text,
  occupancy   text,

  -- ── the numbers ───────────────────────────────────────────────────────────
  -- Whole dollars. Cents in a wholesale deal are a rounding artefact and
  -- numeric money columns invite formatting bugs on every screen.
  contract_price         integer,
  arv_estimate           integer,
  repair_estimate        integer,
  target_assignment_fee  integer,
  max_allowable_offer    integer,

  -- What the end buyer actually pays, and what is left for them after repairs.
  -- Generated, not typed, because these are the two numbers a buyer checks and
  -- an operator maintaining them by hand will eventually publish a stale one.
  --
  -- The distinction that matters: buyer_spread subtracts OUR fee. The
  -- wholesaler's spread (ARV - repairs - contract price) is a bigger, friendlier
  -- number, and matching a buyer's min_spread against it would promise them a
  -- margin that includes money going into Tossie's pocket. They notice once.
  buyer_price  integer GENERATED ALWAYS AS
    (contract_price + target_assignment_fee) STORED,
  buyer_spread integer GENERATED ALWAYS AS
    (arv_estimate - repair_estimate - contract_price - target_assignment_fee) STORED,

  -- ── the contract ──────────────────────────────────────────────────────────
  executed_date        date,
  emd_amount           integer,
  emd_due_date         date,
  emd_status           text NOT NULL DEFAULT 'not_due',
  inspection_end_date  date,
  closing_date         date,
  -- Count rather than a boolean. Three extensions on one deal is a fact worth
  -- being able to see, and it is usually the tell that it is never closing.
  extension_count      integer NOT NULL DEFAULT 0,
  title_company        text,
  closing_attorney     text,

  exit_strategy text NOT NULL DEFAULT 'assign',
  status        text NOT NULL DEFAULT 'draft',

  -- ── the outcome ───────────────────────────────────────────────────────────
  assigned_buyer_id     uuid REFERENCES public.buyers(id) ON DELETE SET NULL,
  actual_assignment_fee integer,
  actual_close_date     date,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deals_status_check CHECK (status IN (
    'draft', 'under_contract', 'dispo', 'buyer_selected', 'assigned',
    'extension_pending', 'buyer_fell_through', 'seller_terminated',
    'terminated_inspection', 'closed', 'dead'
  )),
  CONSTRAINT deals_exit_strategy_check CHECK (exit_strategy IN (
    'assign', 'double_close', 'novation', 'wholetail'
  )),
  CONSTRAINT deals_emd_status_check CHECK (emd_status IN (
    'not_due', 'due', 'sent', 'received', 'released', 'forfeited', 'waived'
  )),
  CONSTRAINT deals_rehab_level_check CHECK (rehab_level IS NULL OR rehab_level IN (
    'light', 'medium', 'heavy', 'full_gut'
  )),
  CONSTRAINT deals_occupancy_check CHECK (occupancy IS NULL OR occupancy IN (
    'owner', 'tenant', 'vacant', 'unknown'
  )),
  CONSTRAINT deals_extension_count_check CHECK (extension_count >= 0),

  -- These two are what keep the money view honest. A deal marked assigned with
  -- no buyer, or closed with no close date, is a row that inflates the pipeline
  -- and can never be reconciled against a settlement statement.
  CONSTRAINT deals_assigned_needs_buyer CHECK (
    status NOT IN ('assigned', 'closed') OR assigned_buyer_id IS NOT NULL
  ),
  CONSTRAINT deals_closed_needs_close_date CHECK (
    status <> 'closed' OR actual_close_date IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS deals_team_status_idx  ON public.deals(team_id, status);
CREATE INDEX IF NOT EXISTS deals_lead_idx         ON public.deals(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_buyer_idx        ON public.deals(assigned_buyer_id) WHERE assigned_buyer_id IS NOT NULL;

-- The two dashboard queries from BUILD_PLAN §4: what is closing soon, and what
-- has already closed. Partial on the live statuses because a board that has to
-- scan four years of closed deals to draw this week is a board nobody opens.
CREATE INDEX IF NOT EXISTS deals_closing_idx
  ON public.deals(team_id, closing_date)
  WHERE status NOT IN ('closed', 'dead') AND closing_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_closed_month_idx
  ON public.deals(team_id, actual_close_date DESC)
  WHERE status = 'closed';

COMMENT ON COLUMN public.deals.buyer_spread IS
  'ARV minus repairs minus what the end buyer pays us (contract price + our fee). This is the number buyers.min_spread is matched against — the wholesaler''s own spread is a different, larger number and quoting it to a buyer is how you lose one.';
COMMENT ON COLUMN public.deals.status IS
  'See deal_status_can_transition() for the legal moves. Fallback paths are first-class; closed is effectively terminal.';

DROP TRIGGER IF EXISTS deals_touch ON public.deals;
CREATE TRIGGER deals_touch BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── deal_events ─────────────────────────────────────────────────────────────
-- The immutable event bus, ported from reoperative. Every state change, every
-- buyer action, every document. It is the answer to "what happened on this
-- deal", asked by an operator on a Tuesday and by an attorney a year later.
CREATE TABLE IF NOT EXISTS public.deal_events (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- SET NULL, like dnc_restore_log.lead_id: the deal can go, the record that
  -- these things happened cannot. CASCADE here would mean deleting one row
  -- erases the entire history of a contract on someone's house.
  deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL,

  -- Free text rather than a CHECK. This bus will carry event types invented by
  -- code written months from now, and a rejected insert here loses the event
  -- rather than the vocabulary — the opposite of what an audit log is for.
  type       text NOT NULL,
  actor_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'system',
  summary    text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deal_events_actor_kind_check CHECK (actor_kind IN ('user', 'system', 'ai', 'buyer'))
);

CREATE INDEX IF NOT EXISTS deal_events_deal_idx
  ON public.deal_events(deal_id, created_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_events_team_created_idx
  ON public.deal_events(team_id, created_at DESC);

-- Append-only, enforced by a trigger rather than by grants alone.
--
-- Withholding UPDATE and DELETE from `authenticated` is the first lock and it
-- is done below. It is not sufficient: the service role bypasses RLS and holds
-- broad table privileges, so every edge function is one typo away from
-- rewriting history, and the test harness hands out GRANT ALL as part of its
-- setup. A trigger fires for the service role, for the table owner, and for
-- anyone a future migration grants too much to. That is the difference between
-- a log that is append-only and one that is merely inconvenient to edit.
CREATE OR REPLACE FUNCTION public.deal_events_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RAISE EXCEPTION 'deal_events is append-only; % is not permitted on it', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct an event by appending a new one that supersedes it.';
END;
$$;

DROP TRIGGER IF EXISTS deal_events_append_only ON public.deal_events;
CREATE TRIGGER deal_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.deal_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.deal_events_are_immutable();

COMMENT ON TABLE public.deal_events IS
  'Immutable event bus for deals. UPDATE, DELETE and TRUNCATE are refused by trigger, not merely ungranted, because the service role bypasses RLS and holds table privileges.';

-- Status changes write themselves into the bus, in a trigger rather than in the
-- callers, exactly like log_lead_status_change — so the edge functions, the RPC
-- and a hand-typed UPDATE in the SQL editor all land in the same history.
CREATE OR REPLACE FUNCTION public.log_deal_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.deal_events (team_id, deal_id, actor_id, actor_kind, type, summary, payload)
    VALUES (
      NEW.team_id, NEW.id, auth.uid(),
      -- The SDR and the cron workers run on the service role with no auth.uid().
      -- Logging those as a person was a real bug in move_lead_to_stage; same
      -- expression here so the two agree.
      CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END,
      'status_changed',
      OLD.status || ' -> ' || NEW.status,
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_log_status ON public.deals;
CREATE TRIGGER deals_log_status AFTER UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.log_deal_status_change();

-- The transition guard. BEFORE UPDATE OF status so an update that does not
-- touch status costs nothing.
CREATE OR REPLACE FUNCTION public.enforce_deal_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT public.deal_status_can_transition(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'A deal cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation',
            HINT = 'See public.deal_status_can_transition for the legal moves. Every live status can reach dead.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_enforce_transition ON public.deals;
CREATE TRIGGER deals_enforce_transition BEFORE UPDATE OF status ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_deal_status_transition();

-- ── buyer_deal_interest ─────────────────────────────────────────────────────
-- One row per buyer per deal, and the reason the dispo funnel is measurable at
-- all: blasted -> viewed -> interested -> offered -> assigned.
CREATE TABLE IF NOT EXISTS public.buyer_deal_interest (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES public.buyers(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'notified',

  offer_amount integer,
  offer_date   date,
  notes        text,

  -- The score this buyer had when the blast went out. Kept rather than
  -- recomputed because the buy box, the deal numbers and the track record all
  -- move, and the question later is "why was this person on the list", which
  -- only the score at the time can answer. It is also the evidence that the
  -- audience was segmented rather than "everyone" — the thing a carrier asks
  -- about when an A2P campaign gets reviewed. See BUILD_PLAN §5.
  match_score   integer,
  match_reasons text[] NOT NULL DEFAULT '{}',

  notified_at  timestamptz,
  viewed_at    timestamptz,
  responded_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT buyer_deal_interest_status_check CHECK (status IN (
    'notified', 'viewed', 'interested', 'walked', 'offered',
    'selected', 'passed', 'reneged'
  )),
  -- A buyer is on a deal once. Two rows means two texts about the same house.
  CONSTRAINT buyer_deal_interest_unique UNIQUE (deal_id, buyer_id)
);

-- One selected buyer per deal. Without this, two rows can both say `selected`
-- and nothing in the schema says which assignment agreement is the real one.
CREATE UNIQUE INDEX IF NOT EXISTS buyer_deal_interest_one_selected_idx
  ON public.buyer_deal_interest(deal_id) WHERE status = 'selected';

CREATE INDEX IF NOT EXISTS buyer_deal_interest_deal_idx
  ON public.buyer_deal_interest(deal_id, status);
CREATE INDEX IF NOT EXISTS buyer_deal_interest_buyer_idx
  ON public.buyer_deal_interest(buyer_id, created_at DESC);

COMMENT ON COLUMN public.buyer_deal_interest.match_reasons IS
  'The explanation match_buyers_for_deal gave at blast time, frozen. Answers "why did this buyer get this text" months later, when the buy box has changed.';

DROP TRIGGER IF EXISTS buyer_deal_interest_touch ON public.buyer_deal_interest;
CREATE TRIGGER buyer_deal_interest_touch BEFORE UPDATE ON public.buyer_deal_interest
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── deal_documents ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deal_documents (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,

  kind text NOT NULL,

  -- Path inside a private Storage bucket, never a public URL. A signed URL is
  -- minted at read time and expires; storing one here would be storing a
  -- credential that outlives whoever it was minted for.
  bucket        text NOT NULL DEFAULT 'deal-documents',
  storage_path  text NOT NULL,
  file_name     text,
  mime_type     text,
  size_bytes    bigint,

  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deal_documents_kind_check CHECK (kind IN (
    'purchase_agreement', 'assignment_agreement', 'addendum', 'emd_receipt',
    'proof_of_funds', 'settlement_statement', 'inspection_report',
    'title_commitment', 'photo', 'comps', 'other'
  )),
  -- The same file uploaded twice by two people is one document, not two.
  CONSTRAINT deal_documents_path_unique UNIQUE (deal_id, storage_path)
);

CREATE INDEX IF NOT EXISTS deal_documents_deal_idx
  ON public.deal_documents(deal_id, created_at DESC);

-- ── deal_milestones ─────────────────────────────────────────────────────────
-- BUILD_PLAN calls contract-milestones.ts the highest-value port on the list,
-- and it is: wholesalers lose deals and earnest money to dates that passed
-- while everyone was busy. Inspection expiry and closing are the two that cost
-- real money, and they are auto-created from the deal below.
CREATE TABLE IF NOT EXISTS public.deal_milestones (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,

  kind  text NOT NULL,
  label text,

  due_at timestamptz NOT NULL,

  -- The escalating ladder from BUILD_PLAN §4: a week out, three days out, the
  -- day before. Per-row rather than a global setting so a deal with a
  -- seven-day inspection can carry a tighter ladder than one with thirty.
  reminder_offsets_hours integer[] NOT NULL DEFAULT '{168,72,24}',

  -- Which rungs have already fired. This is the idempotency key for the cron
  -- worker: a retried run finds the offset already listed and sends nothing,
  -- rather than pinging Tossie three times about the same deadline.
  reminders_sent_hours integer[] NOT NULL DEFAULT '{}',

  -- Maintained by trigger from the three columns above so the worker's query is
  -- a single indexed range scan instead of an unnest per row.
  next_reminder_at timestamptz,

  completed_at timestamptz,
  -- true for the rows sync_deal_milestones owns. An operator's hand-added
  -- milestone must survive the next edit to the deal's dates; an auto one must
  -- follow it.
  auto_managed boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deal_milestones_kind_check CHECK (kind IN (
    'emd_due', 'inspection_end', 'closing', 'extension_deadline',
    'title_clear', 'assignment_due', 'other'
  ))
);

-- One auto-managed row per kind per deal; hand-added ones can repeat.
CREATE UNIQUE INDEX IF NOT EXISTS deal_milestones_auto_kind_idx
  ON public.deal_milestones(deal_id, kind) WHERE auto_managed;

-- The worker's only query: what is due to be reminded about, soonest first.
CREATE INDEX IF NOT EXISTS deal_milestones_due_idx
  ON public.deal_milestones(next_reminder_at)
  WHERE completed_at IS NULL AND next_reminder_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS deal_milestones_deal_idx
  ON public.deal_milestones(deal_id, due_at);

-- STABLE, not IMMUTABLE, and this one is easy to get wrong: subtracting an
-- interval from a timestamptz depends on the session time zone across a DST
-- boundary, so "24 hours before closing" is not a fixed function of its
-- arguments. Marking it IMMUTABLE would let it be folded into an index that is
-- an hour wrong twice a year — on the reminder that fires the day before a
-- closing.
CREATE OR REPLACE FUNCTION public.deal_milestone_next_reminder(
  p_due     timestamptz,
  p_offsets integer[],
  p_sent    integer[]
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  -- min() over the rungs that have not fired. A rung whose time is already past
  -- (a deal entered three days before closing) comes back in the past, which is
  -- correct: the worker picks it up on its next pass and sends it immediately,
  -- rather than skipping a warning because it was configured late.
  SELECT min(p_due - make_interval(hours => o))
  FROM unnest(COALESCE(p_offsets, '{}'::integer[])) AS o
  WHERE NOT (o = ANY (COALESCE(p_sent, '{}'::integer[])));
$$;

REVOKE ALL ON FUNCTION public.deal_milestone_next_reminder(timestamptz, integer[], integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deal_milestone_next_reminder(timestamptz, integer[], integer[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.touch_milestone_next_reminder()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- In a trigger rather than in the writers, so the cron worker, the app and
  -- sync_deal_milestones cannot disagree about when the next ping is due.
  NEW.next_reminder_at := public.deal_milestone_next_reminder(
    NEW.due_at, NEW.reminder_offsets_hours, NEW.reminders_sent_hours);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_milestones_next_reminder ON public.deal_milestones;
CREATE TRIGGER deal_milestones_next_reminder
  BEFORE INSERT OR UPDATE ON public.deal_milestones
  FOR EACH ROW EXECUTE FUNCTION public.touch_milestone_next_reminder();

DROP TRIGGER IF EXISTS deal_milestones_touch ON public.deal_milestones;
CREATE TRIGGER deal_milestones_touch BEFORE UPDATE ON public.deal_milestones
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── the three dates that matter, kept in sync automatically ─────────────────
-- A milestone an operator has to remember to create is a milestone that does
-- not exist on the deal where it was needed. So the EMD due date, the
-- inspection end and the closing date generate their own rows.
--
-- SECURITY DEFINER for the same reason log_lead_status_change is: it writes on
-- behalf of whoever touched the deal, including the service role, and should
-- not depend on the caller's grants on deal_milestones.
CREATE OR REPLACE FUNCTION public.sync_deal_milestones()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('emd_due',        NEW.emd_due_date,        'Earnest money due'),
      ('inspection_end', NEW.inspection_end_date, 'Inspection period ends'),
      ('closing',        NEW.closing_date,        'Closing')
    ) AS v(kind, on_date, label)
  LOOP
    IF r.on_date IS NULL THEN
      -- The date was cleared. Drop the auto row unless somebody already ticked
      -- it off — a completed milestone is a record of something that happened.
      DELETE FROM public.deal_milestones m
       WHERE m.deal_id = NEW.id AND m.kind = r.kind
         AND m.auto_managed AND m.completed_at IS NULL;
      CONTINUE;
    END IF;

    INSERT INTO public.deal_milestones (team_id, deal_id, kind, label, due_at, auto_managed)
    VALUES (
      NEW.team_id, NEW.id, r.kind, r.label,
      -- 17:00 on the date, not midnight. A contract deadline written as "the
      -- 12th" expires at the end of the 12th; a ladder anchored to midnight
      -- fires every rung a full day early, and a reminder that is always early
      -- is a reminder people learn to ignore.
      r.on_date::timestamp + interval '17 hours',
      true
    )
    ON CONFLICT (deal_id, kind) WHERE auto_managed DO UPDATE
      SET due_at = EXCLUDED.due_at,
          label  = EXCLUDED.label,
          -- Moving the date re-arms the whole ladder. An extension that pushes
          -- closing out three weeks must produce three fresh warnings, not
          -- silence because the T-7 rung is already marked sent.
          reminders_sent_hours = CASE
            WHEN deal_milestones.due_at IS DISTINCT FROM EXCLUDED.due_at
              THEN '{}'::integer[]
            ELSE deal_milestones.reminders_sent_hours
          END
      WHERE deal_milestones.completed_at IS NULL;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_sync_milestones ON public.deals;
CREATE TRIGGER deals_sync_milestones
  AFTER INSERT OR UPDATE OF emd_due_date, inspection_end_date, closing_date
  ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.sync_deal_milestones();

-- ── the buy-box matcher ─────────────────────────────────────────────────────
-- Deal in, ranked and explained buyer list out. This is the layer that keeps a
-- dispo blast from being a blast: BUILD_PLAN §4 is explicit that the full list
-- is never texted, and §5 is explicit about why — Tossie's A2P campaign is
-- registered Low Volume Mixed, and untargeted bulk traffic is what gets a
-- campaign suspended and a brand blocked.
--
-- STABLE and SECURITY INVOKER: the deal read, the buyer read and the opt-out
-- read are all scoped by RLS to the caller's team. There is nothing here a
-- caller could not do with three queries of their own, so nothing here needs
-- DEFINER's ambient authority.
--
-- WHO IS NEVER RETURNED, regardless of how well their box fits:
--   * status <> 'active'          — paused or blacklisted
--   * no SMS consent / no opt-in  — they never agreed to be texted
--   * in telephony_opt_outs       — they texted STOP, on either number
-- That is buyer_is_textable(), and it is a filter rather than a score penalty
-- on purpose: a scored list invites someone to send to the bottom of it.
--
-- The hard filters below are the buy box itself. An unset field on the buyer
-- means "no preference" and never excludes; an unknown field on the DEAL also
-- never excludes, because missing data is not a mismatch and the operator who
-- has not typed the square footage yet still needs a list.
--
-- The one deliberate exception is geography: a buyer who named counties or zips
-- and a deal with neither on file produce no match. Blasting a buy box you
-- cannot evaluate is the exact behaviour this function exists to prevent, and
-- the fix is to finish the address.
CREATE OR REPLACE FUNCTION public.match_buyers_for_deal(p_deal_id uuid)
RETURNS TABLE (buyer_id uuid, score int, reasons text[])
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH d AS (
    SELECT id, team_id, county, zip, property_type, beds, occupancy,
           rehab_level, buyer_price, buyer_spread, closing_date
      FROM public.deals
     WHERE id = p_deal_id
  ),
  -- Rehab tolerance is an ordered scale, so it has to be compared as one:
  -- a buyer who takes 'heavy' also takes 'light'. Matching the strings for
  -- equality would hide every deal from the buyers most able to take it.
  rehab_rank AS (
    SELECT * FROM (VALUES
      ('light', 1), ('medium', 2), ('heavy', 3), ('full_gut', 4)
    ) AS v(level, n)
  ),
  fit AS (
    SELECT
      b.id,
      -- Which geographic rung matched, so the score and the reason agree.
      public.text_array_contains_ci(b.zips, d.zip)         AS zip_hit,
      public.text_array_contains_ci(b.counties, d.county)  AS county_hit,
      (cardinality(b.counties) = 0 AND cardinality(b.zips) = 0) AS anywhere,
      (b.price_min IS NOT NULL OR b.price_max IS NOT NULL)      AS priced,
      b.price_min, b.price_max, b.min_spread, b.funding,
      b.rehab_tolerance, b.takes_occupied, b.typical_close_days,
      b.deals_closed, b.deals_reneged, b.rating, b.last_purchase_date,
      d.county, d.zip, d.buyer_price, d.buyer_spread, d.occupancy, d.closing_date
    FROM public.buyers b
    CROSS JOIN d
    WHERE b.team_id = d.team_id
      -- The compliance filter. Not a penalty, a gate.
      AND public.buyer_is_textable(b.*)

      -- Geography.
      AND (
        (cardinality(b.counties) = 0 AND cardinality(b.zips) = 0)
        OR public.text_array_contains_ci(b.counties, d.county)
        OR public.text_array_contains_ci(b.zips, d.zip)
      )

      -- Price. Compared against what the END BUYER pays, not the contract
      -- price: a buyer whose ceiling is $200k does not want a $195k contract
      -- with a $15k fee on it, and showing it to him wastes the one text.
      AND (b.price_min IS NULL OR d.buyer_price IS NULL OR d.buyer_price >= b.price_min)
      AND (b.price_max IS NULL OR d.buyer_price IS NULL OR d.buyer_price <= b.price_max)

      -- Property type and size.
      AND (cardinality(b.property_types) = 0
           OR public.text_array_contains_ci(b.property_types, d.property_type))
      AND (b.beds_min IS NULL OR d.beds IS NULL OR d.beds >= b.beds_min)

      -- Spread, on the buyer's side of the fee. Unknown spread does not
      -- exclude — it costs the bonus points below and earns a reason line
      -- saying the numbers are incomplete.
      AND (b.min_spread IS NULL OR d.buyer_spread IS NULL OR d.buyer_spread >= b.min_spread)

      -- Condition.
      AND (b.rehab_tolerance IS NULL OR d.rehab_level IS NULL
           OR (SELECT n FROM rehab_rank WHERE level = d.rehab_level)
              <= (SELECT n FROM rehab_rank WHERE level = b.rehab_tolerance))

      -- Occupancy. The commonest reason a buyer walks after saying yes.
      AND (b.takes_occupied OR d.occupancy IS NULL
           OR d.occupancy NOT IN ('owner', 'tenant'))
  )
  SELECT
    f.id,
    -- 40 for clearing every hard filter — being genuinely inside someone's box
    -- is most of what matters. The rest separates the buyer who will actually
    -- close from the one who fits on paper.
    GREATEST(0, LEAST(100,
        40
      + CASE WHEN f.zip_hit THEN 12 WHEN f.county_hit THEN 8 ELSE 0 END
      + CASE WHEN f.priced AND f.buyer_price IS NOT NULL THEN 8 ELSE 0 END
      + CASE
          WHEN f.min_spread IS NULL OR f.buyer_spread IS NULL THEN 0
          -- A deal that only just clears their minimum is a deal they will
          -- negotiate on. One that clears it comfortably is one they take.
          WHEN f.buyer_spread >= (f.min_spread * 5) / 4 THEN 12
          ELSE 6
        END
      + LEAST(f.deals_closed, 5) * 3
      + CASE
          WHEN f.last_purchase_date IS NULL THEN 0
          WHEN f.last_purchase_date > (now()::date - 90)  THEN 8
          WHEN f.last_purchase_date > (now()::date - 180) THEN 4
          ELSE 0
        END
      + CASE WHEN f.typical_close_days IS NOT NULL
              AND (f.closing_date IS NULL
                   OR f.typical_close_days <= (f.closing_date - now()::date))
             THEN 5 ELSE 0 END
      + COALESCE(f.rating, 0) * 2
      -- The penalty that reorders the list. Twelve points a piece, capped at
      -- three, is enough to drop a serial reneger below a quiet buyer with a
      -- clean record — which is the ranking Tossie would make by hand.
      - LEAST(f.deals_reneged, 3) * 12
    ))::int AS score,
    array_remove(ARRAY[
      CASE WHEN f.zip_hit    THEN 'Buys in ' || f.zip END,
      CASE WHEN f.county_hit AND NOT f.zip_hit THEN 'Buys in ' || f.county END,
      CASE WHEN f.anywhere   THEN 'No geographic restriction on file' END,
      CASE WHEN f.priced AND f.buyer_price IS NOT NULL THEN
        'Buyer price ' || to_char(f.buyer_price, 'FM$999,999,990')
          || ' fits their '
          || COALESCE(to_char(f.price_min, 'FM$999,999,990'), 'any')
          || '-' || COALESCE(to_char(f.price_max, 'FM$999,999,990'), 'any')
          || ' box' END,
      CASE WHEN f.min_spread IS NOT NULL AND f.buyer_spread IS NOT NULL THEN
        'Spread ' || to_char(f.buyer_spread, 'FM$999,999,990')
          || ' clears their ' || to_char(f.min_spread, 'FM$999,999,990')
          || ' minimum' END,
      CASE WHEN f.buyer_spread IS NULL THEN
        'Spread unknown - ARV or repair estimate missing' END,
      CASE WHEN f.deals_closed > 0 THEN
        'Closed ' || f.deals_closed || ' with us' END,
      -- Shouted, because a ranked list is only useful if the reason someone
      -- sits low on it is legible without opening the record.
      CASE WHEN f.deals_reneged > 0 THEN
        'RENEGED on ' || f.deals_reneged END,
      CASE WHEN f.last_purchase_date IS NOT NULL THEN
        'Last bought ' || (now()::date - f.last_purchase_date) || ' days ago' END,
      CASE WHEN f.typical_close_days IS NOT NULL THEN
        'Closes in about ' || f.typical_close_days || ' days' END,
      CASE WHEN f.funding IS NOT NULL THEN 'Funds with ' || f.funding END,
      CASE WHEN f.takes_occupied AND f.occupancy IN ('owner', 'tenant') THEN
        'Takes occupied property' END,
      CASE WHEN f.rehab_tolerance IS NOT NULL THEN
        'Takes ' || f.rehab_tolerance || ' rehab' END
    ], NULL) AS reasons
  FROM fit f
  -- Ordinal rather than the alias: `score` is also the name of an OUT
  -- parameter, and a bare `score` here would be ambiguous.
  ORDER BY 2 DESC, f.deals_reneged, f.deals_closed DESC;
$$;

COMMENT ON FUNCTION public.match_buyers_for_deal IS
  'Ranked, explained buyer list for one deal. Never returns a buyer who is inactive, has no SMS consent, or has opted out — that is a gate, not a score. Feed its output to the dispo blast; never blast the whole list.';

REVOKE ALL ON FUNCTION public.match_buyers_for_deal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_buyers_for_deal(uuid) TO authenticated, service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.buyers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_deal_interest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_milestones     ENABLE ROW LEVEL SECURITY;

-- Same policy shape as every other team-scoped table in this schema. Each of
-- these carries its own team_id rather than inheriting through deal_id, so the
-- policy is a column comparison and not a subquery on every row.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['buyers', 'deals', 'deal_events',
                           'buyer_deal_interest', 'deal_documents',
                           'deal_milestones']
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
-- The anon key ships in the browser bundle. RLS already denies it and
-- 20260817120300 set default privileges to revoke; this is the second lock,
-- because what leaks here is seller addresses, contract prices and a list of
-- every cash buyer Tossie has — the last of which is the business.
REVOKE ALL ON public.buyers              FROM PUBLIC, anon;
REVOKE ALL ON public.deals               FROM PUBLIC, anon;
REVOKE ALL ON public.deal_events         FROM PUBLIC, anon;
REVOKE ALL ON public.buyer_deal_interest FROM PUBLIC, anon;
REVOKE ALL ON public.deal_documents      FROM PUBLIC, anon;
REVOKE ALL ON public.deal_milestones     FROM PUBLIC, anon;

-- Operator-managed records.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyers          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_documents  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_milestones TO authenticated;

-- No DELETE on deals. A deal is a contract on somebody's house with an event
-- history hanging off it, and `status = 'dead'` says the same thing without
-- taking the history with it. The transition map makes dead reachable from
-- everywhere precisely so this restriction never traps anyone.
GRANT SELECT, INSERT, UPDATE ON public.deals TO authenticated;

-- No DELETE on interest either: it is the record of which buyers were texted
-- about which property, which is the evidence that the audience was segmented
-- if the A2P campaign is ever reviewed.
GRANT SELECT, INSERT, UPDATE ON public.buyer_deal_interest TO authenticated;

-- Append-only. The trigger above refuses UPDATE and DELETE from any role;
-- withholding the grants means the browser client cannot even try.
GRANT SELECT, INSERT ON public.deal_events TO authenticated;

-- ── realtime ────────────────────────────────────────────────────────────────
-- The pipeline board and the interest feed both have to move while somebody is
-- watching them — a buyer tapping "I'm interested" that needs a refresh to
-- appear is a buyer who gets called back an hour late, by which time the second
-- buyer on the list has said yes. Guarded exactly like 20260817120200: ALTER
-- PUBLICATION ADD errors on a duplicate and would make a re-run fail.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['deals', 'buyer_deal_interest']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
