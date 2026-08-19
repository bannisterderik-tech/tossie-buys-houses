-- ============================================================================
-- Phase 5b — the dispo blast: campaigns, materialised audiences, send ledger.
-- ============================================================================
-- BUILD_PLAN §4 calls reoperative's broadcast engine "genuinely hard machinery
-- that already works", and it is right: idempotency keys, retry with
-- next_retry_at, processing_claim_id claim locking, a per-recipient status
-- ladder, skip reasons and cost tracking are all here, ported. What is NOT
-- ported is the multi-tenant billing that wrapped it — price book, markup,
-- bundle balance, usage events. Tossie pays his own Twilio bill; metering it to
-- resell it is dead weight. Same cut as 20260818120000. See §0 and §6.
--
-- ── THE ONE IDEA THIS FILE EXISTS FOR ───────────────────────────────────────
--
-- A campaign MATERIALISES its audience into broadcast_recipients, with a skip
-- decision recorded per recipient, BEFORE anything sends. Every suppressed
-- number gets a row — status 'skipped', an explicit skip_reason — rather than
-- being quietly filtered out of a SELECT.
--
-- This is not tidiness. A campaign that reports "sent to 40" when the audience
-- was 200, with no record of why the other 160 were dropped, is unauditable.
-- And the audit is the entire point of the feature:
--
--   * Tossie's A2P 10DLC campaign is registered Low Volume Mixed. Carriers
--     police whether the traffic matches the registered use case, and the
--     question they ask is "who did you send to, and how did you pick them".
--     "200 buyers matched, 12 were in the box, 6 had opted out, here are the
--     rows" is an answer. "40 messages went out" is not.
--   * TCPA damages are $500-$1,500 per message. If someone claims they were
--     texted after a STOP, the defence is a row saying we looked, we saw the
--     opt-out, and we did not send. A filtered-out recipient leaves no such row
--     and the absence of evidence looks identical to the absence of a check.
--   * It is also how the operator finds out the list is rotting. 160 skips for
--     'no_consent' is a business problem you can only see if it is written
--     down.
--
-- Nothing in this file sends anything. Sending happens in the broadcast-send
-- worker, which calls the twilio-send-sms edge function once per recipient —
-- the single choke point holding the opt-out, DNC, litigator, calling-window,
-- A2P and kill-switch gates. Nothing else may POST to Twilio.
--
-- ── WHY THE CALLING WINDOW IS NOT EVALUATED HERE ────────────────────────────
-- 'outside_calling_window' is in the skip vocabulary but no query in this file
-- ever produces it. Two reasons, both deliberate:
--   1. It is a moving target. A window decision made when the audience was
--      frozen is a lie by the time the worker drains the queue, and the answer
--      it gives is the one that matters (8am-9pm in the CALLED PARTY's local
--      time, resolved from area code).
--   2. That resolution lives in _shared/calling-window.ts, and re-implementing
--      it in SQL would give Tossie two calling-window rails that can drift. The
--      twilio-send-sms header says exactly why that is the failure mode to
--      avoid. So the worker writes this reason when the send path refuses with
--      `outside_texting_window`, and the recipient goes back to pending with a
--      next_retry_at set to the window opening.
-- ============================================================================

-- ── skip reasons, per subject ───────────────────────────────────────────────
-- Two functions rather than one because a buyer and a lead are suppressed for
-- different reasons, and collapsing them would mean a NULL-riddled union that
-- nobody can read. Each one returns NULL when the subject is sendable, and the
-- test suite asserts the equivalence that makes them safe:
--
--   buyer_skip_reason(b) IS NULL  ==  buyer_is_textable(b)
--   lead_skip_reason(l)  IS NULL  ==  lead_is_dialable(l)
--
-- That assertion is the whole safety argument. These functions explain a
-- decision; they do not get to make a different one. If someone later relaxes
-- a gate here and not in the gate function, the suite fails rather than the
-- blast quietly texting somebody it should not have.
--
-- STABLE, not IMMUTABLE, for the same reason every function in this schema
-- that reads telephony_opt_outs is: an IMMUTABLE lie gets folded into a cached
-- plan that outlives the STOP message. Not usable in an index expression.
CREATE OR REPLACE FUNCTION public.buyer_skip_reason(b public.buyers)
RETURNS text
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  -- Order is not cosmetic. When a buyer is suppressed for more than one
  -- reason, the recorded one should be the compliance-relevant one, because
  -- that is the row somebody reads back in a dispute. 'opted_out' therefore
  -- outranks 'no_consent': both mean we did not send, but only one of them is
  -- a person who told us to stop.
  SELECT CASE
    WHEN b.status <> 'active'  THEN 'buyer_inactive'
    WHEN b.phone IS NULL       THEN 'no_phone'
    WHEN public.is_opted_out(b.team_id, b.phone)
      OR public.is_opted_out(b.team_id, b.phone_secondary) THEN 'opted_out'
    WHEN NOT (b.consent_sms AND b.tcpa_opt_in) THEN 'no_consent'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.buyer_skip_reason IS
  'Why this buyer would not be texted, or NULL if they would be. Explains buyer_is_textable rather than reimplementing it — the suite asserts the two agree on every row.';

REVOKE ALL ON FUNCTION public.buyer_skip_reason(public.buyers) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_skip_reason(public.buyers) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lead_skip_reason(l public.leads)
RETURNS text
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  -- Mirrors lead_is_dialable clause for clause, in the order a human would
  -- want to read: the flags that mean "never contact this person" first, the
  -- ones that mean "not yet" last.
  SELECT CASE
    WHEN l.trashed        THEN 'lead_trashed'
    WHEN l.is_dnc         THEN 'dnc'
    WHEN l.is_litigator   THEN 'litigator'
    WHEN COALESCE(l.phone_mobile, l.phone) IS NULL THEN 'no_phone'
    WHEN l.phone_invalid  THEN 'phone_invalid'
    -- Both numbers, not just the one we would text. A STOP from the landline
    -- on file suppresses the mobile too; lead_is_dialable says the same.
    WHEN public.is_opted_out(l.team_id, l.phone)
      OR public.is_opted_out(l.team_id, l.phone_mobile) THEN 'opted_out'
    WHEN NOT (l.tcpa_opt_in OR (l.skip_traced AND l.dnc_scrubbed)) THEN 'no_consent'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.lead_skip_reason IS
  'Why this lead would not be texted, or NULL if they would be. Explains lead_is_dialable rather than reimplementing it — the suite asserts the two agree on every row.';

REVOKE ALL ON FUNCTION public.lead_skip_reason(public.leads) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_skip_reason(public.leads) TO authenticated, service_role;

-- ── retry backoff ───────────────────────────────────────────────────────────
-- A function rather than a constant in the worker so the schema and the worker
-- cannot disagree about when a failed recipient becomes eligible again — the
-- claim query's `next_retry_at <= now()` predicate is on this side of the
-- wire, so the scheduling rule belongs here too.
--
-- Exponential from one minute, capped at an hour. The cap exists because the
-- failures this retries are transient Twilio 5xx and rate limits, which clear
-- in minutes; anything still failing after four attempts is a bad number or a
-- carrier block and needs a human, not a longer sleep.
CREATE OR REPLACE FUNCTION public.broadcast_next_retry(p_attempts integer)
RETURNS interval
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT LEAST(
    (interval '1 minute') * power(5, GREATEST(COALESCE(p_attempts, 0), 0)),
    interval '1 hour'
  );
$$;

COMMENT ON FUNCTION public.broadcast_next_retry IS
  'Backoff before the next send attempt: 1m, 5m, 25m, then capped at 1h. Lives here because the claim query filters on next_retry_at, so the worker and the schema have to agree.';

REVOKE ALL ON FUNCTION public.broadcast_next_retry(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_next_retry(integer) TO authenticated, service_role;

-- ── broadcast_campaigns ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.broadcast_campaigns (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  name text NOT NULL,

  -- The audience is DECLARED, not implied by a filter blob. Three kinds, and
  -- the kind is the first thing the UI has to show, because it is the answer
  -- to "who is this going to" — the question a carrier asks and the question a
  -- tired operator at 9pm does not ask himself.
  --
  --   'deal_match'  the dispo blast. Candidates are every buyer on the team;
  --                 match_buyers_for_deal decides which are in the box. This is
  --                 the defensible workflow: business contacts who asked to
  --                 hear about deals, segmented by a buy box.
  --   'buyers'      a general note to the buyers list — a meetup, a policy
  --                 change. Still only buyers who opted in.
  --   'leads'       hand-picked sellers, explicit ids only. See the CHECK.
  audience_kind text NOT NULL,

  -- Shape depends on audience_kind, and materialise_campaign is the only thing
  -- that reads it:
  --   deal_match  { min_score?: int }
  --   buyers      { buyer_ids?: uuid[], counties?: text[], min_rating?: int }
  --   leads       { lead_ids: uuid[] }        <- required, see below
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The property being dispo'd. SET NULL rather than CASCADE: if a deal row is
  -- ever removed the record that these people were texted must survive it,
  -- because that record is the TCPA and A2P evidence.
  deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL,

  -- The message template. Substitution ({{address}}, {{buyer_price}}, ...)
  -- happens in the worker, right before it hands the rendered body to
  -- twilio-send-sms. Stored raw so the audit shows what was authored.
  body text NOT NULL,

  -- SMS only today. The column exists because email dispo is the obvious next
  -- channel and a CHECK is cheaper to widen than a table is to reshape; the
  -- single-value constraint keeps anyone from writing 'email' and expecting it
  -- to do something.
  channel text NOT NULL DEFAULT 'sms',

  status text NOT NULL DEFAULT 'draft',

  -- When the audience was frozen. NULL means nothing has been decided yet and
  -- the campaign is still fully editable; non-NULL locks the audience and the
  -- body (see broadcast_campaigns_freeze below).
  materialised_at timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,

  -- Counts, maintained by trigger from the recipient rows rather than
  -- incremented by the worker. A hand-maintained counter drifts the first time
  -- a send crashes between the Twilio call and the UPDATE, and a drifted
  -- counter is exactly the "sent to 40" number this file exists to make
  -- trustworthy. total_recipients is every materialised row INCLUDING the
  -- skipped ones — that is the denominator that makes the skips visible.
  total_recipients integer NOT NULL DEFAULT 0,
  skipped_count    integer NOT NULL DEFAULT 0,
  pending_count    integer NOT NULL DEFAULT 0,
  queued_count     integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  delivered_count  integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,

  -- Cost tracking, kept; billing, cut. This is "what did this blast cost us at
  -- Twilio's price", summed from the recipient rows when the status callbacks
  -- land. There is no markup column and no wallet, because there is nobody to
  -- bill — a dispo blast that costs $3.40 is a number the operator wants to
  -- see next to "6 buyers replied", not an invoice line.
  actual_cost_cents integer NOT NULL DEFAULT 0,

  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT broadcast_campaigns_audience_kind_check CHECK (audience_kind IN (
    'buyers', 'leads', 'deal_match'
  )),
  CONSTRAINT broadcast_campaigns_channel_check CHECK (channel IN ('sms')),
  CONSTRAINT broadcast_campaigns_status_check CHECK (status IN (
    'draft', 'sending', 'paused', 'sent', 'failed'
  )),

  -- A dispo blast without a property is a blast about nothing.
  CONSTRAINT broadcast_campaigns_deal_match_needs_deal CHECK (
    audience_kind <> 'deal_match' OR deal_id IS NOT NULL
  ),

  -- THE RAIL THAT MATTERS MOST IN THIS TABLE.
  --
  -- Bulk SMS to a cold seller list is not defensible under a Low Volume Mixed
  -- campaign registered for appointment reminders and confirmations, and it is
  -- the single fastest way to lose the number and the brand. So there is
  -- deliberately no filter syntax that can select "all leads": a leads campaign
  -- must name its recipients, one uuid at a time, and materialise_campaign caps
  -- how many. Picking 200 sellers by hand is possible; it is also slow enough
  -- that somebody notices what they are doing, which is the point.
  --
  -- COALESCE, not a bare comparison: a filter with no 'lead_ids' key at all
  -- makes `->` return SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL =
  -- 'array'` is NULL — which a CHECK constraint treats as satisfied. The one
  -- shape this rail exists to reject is exactly the one that would have slipped
  -- through it.
  CONSTRAINT broadcast_campaigns_leads_need_explicit_ids CHECK (
    audience_kind <> 'leads'
    OR COALESCE(jsonb_typeof(audience_filter -> 'lead_ids') = 'array', false)
  ),

  -- Every message in a bulk send carries its own way out. Carriers look for
  -- this, and a buyer who cannot find the exit reports the number as spam,
  -- which costs more than the buyer did. Checking for the literal word is
  -- crude and deliberately so — a regex that tries to understand the sentence
  -- would pass "we will never STOP finding deals".
  CONSTRAINT broadcast_campaigns_body_has_opt_out CHECK (
    btrim(body) <> '' AND length(body) <= 1600 AND body ILIKE '%stop%'
  ),

  -- Referenced by the composite FK on broadcast_recipients below.
  CONSTRAINT broadcast_campaigns_id_team_unique UNIQUE (id, team_id)
);

CREATE INDEX IF NOT EXISTS broadcast_campaigns_team_created_idx
  ON public.broadcast_campaigns(team_id, created_at DESC);

-- The worker's scan: which campaigns still have work. Partial, because a
-- finished campaign never needs looking at again and there will be far more of
-- those than live ones.
CREATE INDEX IF NOT EXISTS broadcast_campaigns_live_idx
  ON public.broadcast_campaigns(team_id, status)
  WHERE status IN ('sending', 'paused');

CREATE INDEX IF NOT EXISTS broadcast_campaigns_deal_idx
  ON public.broadcast_campaigns(deal_id) WHERE deal_id IS NOT NULL;

COMMENT ON TABLE public.broadcast_campaigns IS
  'One bulk SMS send. The audience is declared by kind and frozen into broadcast_recipients before anything is sent; the counts here are derived from those rows, never incremented by hand.';

COMMENT ON COLUMN public.broadcast_campaigns.total_recipients IS
  'Every materialised row, skipped ones included. It is the denominator that makes "sent 12" honest.';

-- ── broadcast_recipients ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.broadcast_recipients (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  campaign_id uuid NOT NULL REFERENCES public.broadcast_campaigns(id) ON DELETE CASCADE,

  -- The subject. Both nullable, and at most one set — never both.
  --
  -- Nullable on purpose even though every row starts with one: buyers are
  -- deletable, and the record that this number was in this audience and was or
  -- was not texted has to survive the buyer being removed. phone_e164 below is
  -- the durable identity of the row; the FKs are convenience joins. This is
  -- why the constraint is `<= 1` and not `= 1` — an ON DELETE SET NULL fires
  -- an UPDATE on this row, and a `= 1` check would abort the buyer's deletion
  -- instead of preserving the audit.
  buyer_id uuid REFERENCES public.buyers(id) ON DELETE SET NULL,
  lead_id  uuid REFERENCES public.leads(id)  ON DELETE SET NULL,

  -- The number as materialise_campaign found it. Stored rather than joined so a
  -- deleted buyer still leaves a number in the ledger.
  --
  -- Nullable ONLY for the one skip reason that means there was no number to
  -- record. Dropping those rows instead would be the exact failure this file
  -- exists to prevent in miniature: an audience of 200 reporting 187, with the
  -- 13 contacts nobody can text invisible — and "why is our buyers list not
  -- reaching people" unanswerable. See the CHECK below.
  phone_e164 text,

  status      text NOT NULL DEFAULT 'pending',
  skip_reason text,

  -- Why this buyer was in the audience, frozen. Copied onto
  -- buyer_deal_interest when the message actually goes out — before it goes
  -- out there is nothing to be interested in yet, and writing 'notified'
  -- before the send would be a lie the dispo funnel then reports as a stat.
  match_score   integer,
  match_reasons text[] NOT NULL DEFAULT '{}',

  -- Passed to twilio-send-sms, which dedupes on it. Generated here rather than
  -- by the worker so a worker that crashes after Twilio accepted the message
  -- and before it wrote the SID retries with the SAME key and gets the
  -- original message back instead of texting the buyer twice.
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),

  twilio_sid text,
  error      text,
  cost_cents integer,

  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_retry_at   timestamptz,

  -- Claim locking. Two workers draining the same campaign is not hypothetical
  -- — a cron overlapping a manual "send now" is the normal way it happens, and
  -- the cost of the race is a buyer texted twice about the same house.
  -- claim_broadcast_recipients takes these under FOR UPDATE SKIP LOCKED;
  -- reap_stale_broadcast_claims clears them when a worker dies holding one.
  processing_claim_id   uuid,
  processing_started_at timestamptz,

  sent_at      timestamptz,
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT broadcast_recipients_status_check CHECK (status IN (
    'pending', 'skipped', 'queued', 'sent', 'delivered', 'failed'
  )),

  -- A closed vocabulary, because "why didn't this send" answered in free text
  -- cannot be counted, and the count is what tells the operator the list is
  -- rotting. 'outside_calling_window' and 'send_refused' are written by the
  -- worker at send time; everything else by materialise_campaign.
  CONSTRAINT broadcast_recipients_skip_reason_check CHECK (
    skip_reason IS NULL OR skip_reason IN (
      'no_phone', 'phone_invalid', 'no_consent', 'opted_out', 'dnc',
      'litigator', 'buyer_inactive', 'lead_trashed', 'not_in_buy_box',
      'outside_calling_window', 'send_refused'
    )
  ),

  -- Skipped means skipped FOR a reason. The two halves matter equally: a
  -- skipped row without a reason is the unauditable state this file exists to
  -- prevent, and a reason on a row that did send would make the skip counts
  -- lie in the other direction.
  CONSTRAINT broadcast_recipients_skip_needs_reason CHECK (
    (status = 'skipped') = (skip_reason IS NOT NULL)
  ),

  CONSTRAINT broadcast_recipients_one_subject CHECK (
    num_nonnulls(buyer_id, lead_id) <= 1
  ),

  -- A row without a number is only ever the record of a contact who had none.
  -- Anything else with a NULL here would be a message the ledger claims to have
  -- sent somewhere it cannot name.
  CONSTRAINT broadcast_recipients_needs_phone_unless_thats_the_reason CHECK (
    phone_e164 IS NOT NULL OR skip_reason = 'no_phone'
  ),

  CONSTRAINT broadcast_recipients_attempts_check CHECK (attempts >= 0),

  -- Belt and braces on tenancy. RLS already stops a signed-in user crossing
  -- teams, but the worker runs on the service role, which bypasses RLS
  -- entirely; this composite FK means even a buggy worker cannot file a
  -- recipient under one team and its campaign under another.
  CONSTRAINT broadcast_recipients_campaign_team_fk
    FOREIGN KEY (campaign_id, team_id)
    REFERENCES public.broadcast_campaigns(id, team_id) ON DELETE CASCADE
);

-- ONE NUMBER, ONE MESSAGE, PER CAMPAIGN.
--
-- Keyed on phone_key() rather than on the raw column. A literal
-- UNIQUE (campaign_id, phone_e164) is satisfied by '+19125550601' sitting next
-- to '(912) 555-0601' — two rows, two texts, one annoyed buyer who now knows
-- Tossie's CRM is duplicated. The same number reaching the audience twice (a
-- buyer who is also a lead, one buyer entered twice years apart) is a data
-- reality, not an edge case, so the constraint has to survive formatting.
--
-- Not partial on status: a skipped row occupies the slot too, which is what
-- makes the fail-closed dedup in materialise_campaign work. See the DISTINCT
-- ON there.
--
-- phone_key(NULL) is NULL and a unique index permits many NULLs, which is
-- exactly right: the 'no_phone' rows are all distinct contacts and must not
-- collapse into one another.
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_recipients_campaign_phone_idx
  ON public.broadcast_recipients(campaign_id, public.phone_key(phone_e164));

-- ONE SUBJECT, ONE ROW, PER CAMPAIGN — the other half of the same rule.
--
-- The phone index cannot cover a contact with no number, because phone_key
-- returns NULL there and a unique index treats every NULL as distinct. That is
-- deliberately what lets the 'no_phone' rows coexist, and it is also a hole:
-- without these two, re-materialising a draft would add a second row for every
-- contact who has no number, and the audience would grow a little each time
-- somebody clicked the button twice.
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_recipients_campaign_buyer_idx
  ON public.broadcast_recipients(campaign_id, buyer_id) WHERE buyer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_recipients_campaign_lead_idx
  ON public.broadcast_recipients(campaign_id, lead_id) WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS broadcast_recipients_campaign_status_idx
  ON public.broadcast_recipients(campaign_id, status);

-- The claim query. Partial on the only status a worker ever claims, so the
-- index stays the size of the outstanding work rather than the size of the
-- history.
CREATE INDEX IF NOT EXISTS broadcast_recipients_claimable_idx
  ON public.broadcast_recipients(campaign_id, next_retry_at)
  WHERE status = 'pending';

-- The reaper's scan.
CREATE INDEX IF NOT EXISTS broadcast_recipients_stale_claim_idx
  ON public.broadcast_recipients(processing_started_at)
  WHERE processing_claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS broadcast_recipients_buyer_idx
  ON public.broadcast_recipients(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS broadcast_recipients_lead_idx
  ON public.broadcast_recipients(lead_id) WHERE lead_id IS NOT NULL;

COMMENT ON TABLE public.broadcast_recipients IS
  'The send ledger: one row per distinct number in a campaign audience, INCLUDING every suppressed one. A recipient that never gets a row is a decision nobody can audit.';

COMMENT ON COLUMN public.broadcast_recipients.skip_reason IS
  'Why nothing was sent to this number. Closed vocabulary so it can be counted. materialise_campaign writes the durable reasons; the worker writes outside_calling_window and send_refused.';

COMMENT ON COLUMN public.broadcast_recipients.idempotency_key IS
  'Handed to twilio-send-sms. Stable across retries on purpose: a worker that dies after Twilio accepted the message replays the same key and gets the original back rather than sending twice.';

-- ── touch triggers ──────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS broadcast_campaigns_touch ON public.broadcast_campaigns;
CREATE TRIGGER broadcast_campaigns_touch BEFORE UPDATE ON public.broadcast_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS broadcast_recipients_touch ON public.broadcast_recipients;
CREATE TRIGGER broadcast_recipients_touch BEFORE UPDATE ON public.broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── freezing a materialised campaign ────────────────────────────────────────
-- Once the audience is frozen and the skip decisions are on record, the body,
-- the audience and the deal are locked.
--
-- Without this the audit is theatre: materialise a tightly matched buyer list,
-- collect a clean set of skip rows, then swap `body` for something the A2P
-- campaign was never registered for — and the evidence trail now vouches for a
-- message it never saw. Making a second campaign costs nothing; editing this
-- one costs the ability to prove anything.
CREATE OR REPLACE FUNCTION public.broadcast_campaign_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF OLD.materialised_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.body            IS DISTINCT FROM OLD.body
  OR NEW.audience_kind   IS DISTINCT FROM OLD.audience_kind
  OR NEW.audience_filter IS DISTINCT FROM OLD.audience_filter
  OR NEW.deal_id         IS DISTINCT FROM OLD.deal_id
  OR NEW.channel         IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION
      'Campaign % already has a materialised audience; its body and audience are frozen. Create a new campaign instead.',
      OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_campaigns_freeze ON public.broadcast_campaigns;
CREATE TRIGGER broadcast_campaigns_freeze BEFORE UPDATE ON public.broadcast_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_campaign_freeze();

-- Same argument for deletion: a campaign that has sent, or has even decided who
-- it would send to, is evidence. A draft nobody materialised is just clutter
-- and deleting it is fine.
CREATE OR REPLACE FUNCTION public.broadcast_campaign_no_delete_after_materialise()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF OLD.materialised_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Campaign % has a materialised audience and cannot be deleted — those rows are the record of who was and was not texted.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_campaigns_no_delete ON public.broadcast_campaigns;
CREATE TRIGGER broadcast_campaigns_no_delete BEFORE DELETE ON public.broadcast_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_campaign_no_delete_after_materialise();

-- ── counts, derived ─────────────────────────────────────────────────────────
-- Row-level and a full recount, not an incremental delta. A delta is faster and
-- wrong the first time a status moves in a way nobody anticipated; a recount of
-- a few hundred rows is microseconds and is right by construction. Audiences
-- here are hundreds, capped in the low thousands — simplicity wins.
CREATE OR REPLACE FUNCTION public.broadcast_recount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_campaign uuid := COALESCE(NEW.campaign_id, OLD.campaign_id);
BEGIN
  UPDATE public.broadcast_campaigns c
     SET total_recipients  = s.total,
         skipped_count     = s.skipped,
         pending_count     = s.pending,
         queued_count      = s.queued,
         sent_count        = s.sent,
         delivered_count   = s.delivered,
         failed_count      = s.failed,
         actual_cost_cents = s.cost
    FROM (
      SELECT count(*)::int                                             AS total,
             count(*) FILTER (WHERE status = 'skipped')::int           AS skipped,
             count(*) FILTER (WHERE status = 'pending')::int           AS pending,
             count(*) FILTER (WHERE status = 'queued')::int            AS queued,
             -- 'delivered' is downstream of 'sent': a message that reached the
             -- handset was also sent, and a sent_count that drops when the
             -- delivery receipt arrives is the kind of number people stop
             -- trusting after seeing it once.
             count(*) FILTER (WHERE status IN ('sent', 'delivered'))::int AS sent,
             count(*) FILTER (WHERE status = 'delivered')::int         AS delivered,
             count(*) FILTER (WHERE status = 'failed')::int            AS failed,
             COALESCE(sum(cost_cents), 0)::int                         AS cost
        FROM public.broadcast_recipients
       WHERE campaign_id = v_campaign
    ) s
   WHERE c.id = v_campaign;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_recipients_recount ON public.broadcast_recipients;
CREATE TRIGGER broadcast_recipients_recount
  AFTER INSERT OR DELETE OR UPDATE OF status, cost_cents ON public.broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_recount();

-- ── a sent dispo message becomes buyer_deal_interest ────────────────────────
-- The dispo funnel (blasted → interested → offered → assigned) can only be
-- measured if "blasted" is written down at the moment it becomes true. Doing it
-- here rather than in the worker means the worker cannot forget, and means a
-- worker that crashes between the Twilio call and its own bookkeeping still
-- leaves the funnel correct.
--
-- Never downgrades. A buyer who already replied 'interested' and then gets the
-- second blast about the same house must not be walked back to 'notified' —
-- that would erase the most valuable state in the table. Only notified_at, the
-- score and the reasons are refreshed.
CREATE OR REPLACE FUNCTION public.broadcast_record_interest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_deal uuid;
BEGIN
  IF NEW.buyer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT deal_id INTO v_deal
    FROM public.broadcast_campaigns
   WHERE id = NEW.campaign_id;

  IF v_deal IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.buyer_deal_interest (
    team_id, deal_id, buyer_id, status, match_score, match_reasons, notified_at
  ) VALUES (
    NEW.team_id, v_deal, NEW.buyer_id, 'notified',
    NEW.match_score, NEW.match_reasons, COALESCE(NEW.sent_at, now())
  )
  ON CONFLICT (deal_id, buyer_id) DO UPDATE
    SET notified_at   = COALESCE(NEW.sent_at, now()),
        match_score   = COALESCE(EXCLUDED.match_score, buyer_deal_interest.match_score),
        match_reasons = CASE WHEN EXCLUDED.match_reasons = '{}'::text[]
                             THEN buyer_deal_interest.match_reasons
                             ELSE EXCLUDED.match_reasons END;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_recipients_interest ON public.broadcast_recipients;
CREATE TRIGGER broadcast_recipients_interest
  AFTER UPDATE OF status ON public.broadcast_recipients
  FOR EACH ROW
  WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent')
  EXECUTE FUNCTION public.broadcast_record_interest();

-- ── a dispo blast is a deal event ───────────────────────────────────────────
-- deal_events is the immutable history of a deal (BUILD_PLAN §4). "We texted 12
-- buyers on the 20th" belongs in it for the same reason a status change does:
-- six weeks later the question is why this buyer and not that one, and the
-- answer has to be somewhere that cannot be edited.
CREATE OR REPLACE FUNCTION public.broadcast_log_deal_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.deal_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.deal_events (
    team_id, deal_id, type, actor_id, actor_kind, summary, payload
  ) VALUES (
    NEW.team_id, NEW.deal_id, 'dispo_blast_started',
    NEW.created_by,
    -- 'user' only when we know which one. A cron-started send is not a person
    -- and labelling it as one makes the history lie about who decided.
    CASE WHEN NEW.created_by IS NULL THEN 'system' ELSE 'user' END,
    format('Dispo blast "%s" started: %s to send, %s suppressed',
           NEW.name, NEW.pending_count, NEW.skipped_count),
    jsonb_build_object(
      'campaign_id',      NEW.id,
      'audience_kind',    NEW.audience_kind,
      'total_recipients', NEW.total_recipients,
      'pending',          NEW.pending_count,
      'skipped',          NEW.skipped_count
    )
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_campaigns_log_start ON public.broadcast_campaigns;
CREATE TRIGGER broadcast_campaigns_log_start
  AFTER UPDATE OF status ON public.broadcast_campaigns
  FOR EACH ROW
  WHEN (NEW.status = 'sending' AND OLD.status IS DISTINCT FROM 'sending')
  EXECUTE FUNCTION public.broadcast_log_deal_event();

-- ── materialise_campaign ────────────────────────────────────────────────────
-- Expands the declared audience into broadcast_recipients with a skip decision
-- per recipient. NEVER SENDS ANYTHING. Read the header of this file for why the
-- suppressed rows are written rather than filtered away.
--
-- SECURITY INVOKER: RLS is the team check on every table it touches, and
-- match_buyers_for_deal is SECURITY INVOKER too, so an operator materialising a
-- campaign sees exactly the buyers they could see by hand. There is nothing
-- here a caller cannot legitimately do, which is the test for whether DEFINER
-- is warranted; it is not.
--
-- Additive and re-runnable while the campaign is a draft: ON CONFLICT DO
-- NOTHING tops up a partially materialised audience rather than duplicating it,
-- and never revises a decision already recorded. Once the campaign leaves
-- draft the audience is closed — a campaign whose audience grows mid-send is a
-- campaign nobody can report on.
CREATE OR REPLACE FUNCTION public.materialise_campaign(p_campaign_id uuid)
RETURNS TABLE (total integer, pending integer, skipped integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_camp      public.broadcast_campaigns;
  v_deal      public.deals;
  v_min_score integer;
  v_lead_ids  uuid[];
  v_buyer_ids uuid[];
  v_counties  text[];
  v_min_rating integer;
BEGIN
  SELECT * INTO v_camp FROM public.broadcast_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    -- Also the answer when the campaign belongs to another team: RLS makes it
    -- invisible, and "not found" is the right thing to say about a row the
    -- caller is not allowed to know exists.
    RAISE EXCEPTION 'Campaign % not found.', p_campaign_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_camp.status <> 'draft' THEN
    RAISE EXCEPTION
      'Campaign % is "%", not draft. Its audience was already decided; create a new campaign.',
      p_campaign_id, v_camp.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- ── deal_match ────────────────────────────────────────────────────────────
  IF v_camp.audience_kind = 'deal_match' THEN
    SELECT * INTO v_deal FROM public.deals WHERE id = v_camp.deal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Campaign % points at a deal that no longer exists.', p_campaign_id
        USING ERRCODE = 'no_data_found';
    END IF;
    IF v_deal.status IN ('closed', 'dead') THEN
      RAISE EXCEPTION
        'Deal % is "%". Texting a buyers list about a property that is gone is how a list stops getting read.',
        v_deal.id, v_deal.status
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    v_min_score := COALESCE((v_camp.audience_filter ->> 'min_score')::integer, 0);

    -- THE CANDIDATE SET IS EVERY BUYER ON THE TEAM, not just the matched ones.
    --
    -- match_buyers_for_deal already gates out anyone who is not textable, which
    -- is right for a ranked list and wrong for an audit: a buyer who opted out
    -- would simply not appear, and the campaign would report a smaller audience
    -- with no record that the opt-out was ever consulted. So the pool is the
    -- whole list, the matcher decides who is in the box, and everyone else gets
    -- a row saying why not — 'opted_out' where it applies, 'not_in_buy_box'
    -- where the box is simply the wrong shape.
    --
    -- That also produces the segmentation evidence directly: "180 buyers on the
    -- list, 12 in the box for this property" is the sentence that answers a
    -- carrier reviewing a Low Volume Mixed campaign.
    --
    -- Suppression outranks 'not_in_buy_box' when both are true. Both mean no
    -- message went out, but only one of them is a compliance fact, and the
    -- compliance fact is the one that has to be legible in the ledger.
    INSERT INTO public.broadcast_recipients (
      team_id, campaign_id, buyer_id, phone_e164, status, skip_reason,
      match_score, match_reasons
    )
    -- Deduped by number when there is one and by identity when there is not:
    -- DISTINCT ON treats NULLs as equal, so keying on the number alone would
    -- collapse every 'no_phone' buyer into a single row and hide the rest.
    SELECT DISTINCT ON (COALESCE(public.phone_key(cand.phone), cand.id::text))
           cand.team_id, p_campaign_id, cand.id, cand.phone,
           CASE WHEN cand.reason IS NULL THEN 'pending' ELSE 'skipped' END,
           cand.reason,
           cand.score, COALESCE(cand.reasons, '{}'::text[])
      FROM (
        SELECT b.id, b.team_id, b.phone,
               m.score, m.reasons,
               COALESCE(
                 public.buyer_skip_reason(b.*),
                 CASE WHEN m.buyer_id IS NULL OR m.score < v_min_score
                      THEN 'not_in_buy_box' END
               ) AS reason
          FROM public.buyers b
          LEFT JOIN public.match_buyers_for_deal(v_camp.deal_id) m
                 ON m.buyer_id = b.id
         WHERE b.team_id = v_camp.team_id
      ) cand
     -- Fail-closed dedup. When one number reaches the audience twice and the
     -- two rows disagree, the SUPPRESSED decision wins: `reason IS NULL` sorts
     -- false-first, so a skip beats a send. Getting this backwards would mean a
     -- duplicate row could launder an opt-out into a delivery.
     ORDER BY COALESCE(public.phone_key(cand.phone), cand.id::text),
              (cand.reason IS NULL), cand.score DESC NULLS LAST
    -- No inference target: the audience is deduped by number AND by subject,
    -- and ON CONFLICT can only name one index. Bare DO NOTHING catches both, so
    -- a re-run of a draft tops up rather than growing the list a row at a time.
    ON CONFLICT DO NOTHING;

  -- ── buyers ────────────────────────────────────────────────────────────────
  ELSIF v_camp.audience_kind = 'buyers' THEN
    v_buyer_ids := CASE
      WHEN jsonb_typeof(v_camp.audience_filter -> 'buyer_ids') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(v_camp.audience_filter -> 'buyer_ids')::uuid)
    END;
    v_counties := CASE
      WHEN jsonb_typeof(v_camp.audience_filter -> 'counties') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(v_camp.audience_filter -> 'counties'))
    END;
    v_min_rating := (v_camp.audience_filter ->> 'min_rating')::integer;

    INSERT INTO public.broadcast_recipients (
      team_id, campaign_id, buyer_id, phone_e164, status, skip_reason
    )
    SELECT DISTINCT ON (COALESCE(public.phone_key(cand.phone), cand.id::text))
           cand.team_id, p_campaign_id, cand.id, cand.phone,
           CASE WHEN cand.reason IS NULL THEN 'pending' ELSE 'skipped' END,
           cand.reason
      FROM (
        SELECT b.id, b.team_id, b.phone, public.buyer_skip_reason(b.*) AS reason
          FROM public.buyers b
         WHERE b.team_id = v_camp.team_id
           AND (v_buyer_ids IS NULL OR b.id = ANY(v_buyer_ids))
           -- An unset filter is no restriction, the same rule the buy box
           -- follows. A county filter that matched nothing when left blank
           -- would produce empty campaigns that look like a send problem.
           AND (v_counties IS NULL OR EXISTS (
                 SELECT 1 FROM unnest(v_counties) c
                  WHERE public.text_array_contains_ci(b.counties, c)))
           AND (v_min_rating IS NULL OR COALESCE(b.rating, 0) >= v_min_rating)
      ) cand
     ORDER BY COALESCE(public.phone_key(cand.phone), cand.id::text),
              (cand.reason IS NULL)
    -- No inference target: the audience is deduped by number AND by subject,
    -- and ON CONFLICT can only name one index. Bare DO NOTHING catches both, so
    -- a re-run of a draft tops up rather than growing the list a row at a time.
    ON CONFLICT DO NOTHING;

  -- ── leads ─────────────────────────────────────────────────────────────────
  ELSE
    v_lead_ids := ARRAY(
      SELECT jsonb_array_elements_text(v_camp.audience_filter -> 'lead_ids')::uuid
    );

    IF array_length(v_lead_ids, 1) IS NULL THEN
      RAISE EXCEPTION 'A leads campaign must name its recipients; lead_ids is empty.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The cap. Tossie's A2P campaign is registered Low Volume Mixed with a
    -- description about appointment reminders and confirmations; bulk SMS to a
    -- seller list does not match that registration and gets campaigns suspended
    -- and brands blocked. The `leads` audience exists for hand-picked sellers
    -- who already opted in — a dozen people you owe a follow-up — and 250 is
    -- far past any legitimate use of it while still being a wall somebody hits
    -- before a carrier does.
    IF array_length(v_lead_ids, 1) > 250 THEN
      RAISE EXCEPTION
        'A leads campaign is capped at 250 hand-picked recipients (% given). Bulk SMS to a seller list is not defensible under this A2P campaign — see docs/BUILD_PLAN.md §5.',
        array_length(v_lead_ids, 1)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.broadcast_recipients (
      team_id, campaign_id, lead_id, phone_e164, status, skip_reason
    )
    SELECT DISTINCT ON (COALESCE(public.phone_key(cand.phone), cand.id::text))
           cand.team_id, p_campaign_id, cand.id, cand.phone,
           CASE WHEN cand.reason IS NULL THEN 'pending' ELSE 'skipped' END,
           cand.reason
      FROM (
        SELECT l.id, l.team_id,
               COALESCE(l.phone_mobile, l.phone) AS phone,
               public.lead_skip_reason(l.*)      AS reason
          FROM public.leads l
         WHERE l.team_id = v_camp.team_id
           AND l.id = ANY(v_lead_ids)
      ) cand
     ORDER BY COALESCE(public.phone_key(cand.phone), cand.id::text),
              (cand.reason IS NULL)
    -- No inference target: the audience is deduped by number AND by subject,
    -- and ON CONFLICT can only name one index. Bare DO NOTHING catches both, so
    -- a re-run of a draft tops up rather than growing the list a row at a time.
    ON CONFLICT DO NOTHING;
  END IF;

  -- The stamp that closes the audience. Set last, so a failure anywhere above
  -- leaves the campaign editable rather than frozen around a half-built list.
  UPDATE public.broadcast_campaigns
     SET materialised_at = now()
   WHERE id = p_campaign_id;

  RETURN QUERY
  SELECT count(*)::integer,
         count(*) FILTER (WHERE r.status = 'pending')::integer,
         count(*) FILTER (WHERE r.status = 'skipped')::integer
    FROM public.broadcast_recipients r
   WHERE r.campaign_id = p_campaign_id;
END;
$$;

COMMENT ON FUNCTION public.materialise_campaign IS
  'Freezes a draft campaign''s audience into broadcast_recipients with a per-recipient skip decision. Writes a row for every suppressed number rather than filtering it out — that ledger is the TCPA and A2P evidence. Sends nothing.';

REVOKE ALL ON FUNCTION public.materialise_campaign(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.materialise_campaign(uuid) TO authenticated, service_role;

-- ── claim locking ───────────────────────────────────────────────────────────
-- Ported from reoperative's claim_broadcast_recipients. FOR UPDATE SKIP LOCKED
-- picks rows nobody else is holding; the claim id is then written so a worker
-- that loses its transaction (crash, timeout, redeploy mid-drain) leaves a
-- visible marker rather than a row that looks free and gets sent twice.
--
-- SECURITY INVOKER, unlike the original. The worker runs on the service role,
-- which bypasses RLS anyway, so DEFINER would buy nothing except the ability
-- for a signed-in user to claim another team's rows.
--
-- The five-minute grace on processing_started_at is the same number
-- reoperative uses and is chosen to be comfortably longer than the slowest
-- realistic twilio-send-sms round trip. Shorter and a slow send gets claimed
-- twice; that is the direction that costs a duplicate text.
CREATE OR REPLACE FUNCTION public.claim_broadcast_recipients(
  p_campaign_id uuid,
  p_limit       integer DEFAULT 200
)
RETURNS TABLE (recipient_id uuid, claim_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_claim uuid := gen_random_uuid();
BEGIN
  RETURN QUERY
  WITH winners AS (
    SELECT r.id
      FROM public.broadcast_recipients r
     WHERE r.campaign_id = p_campaign_id
       AND r.status = 'pending'
       AND (r.next_retry_at IS NULL OR r.next_retry_at <= now())
       AND (r.processing_claim_id IS NULL
            OR r.processing_started_at < now() - interval '5 minutes')
     ORDER BY r.created_at
     LIMIT GREATEST(COALESCE(p_limit, 200), 1)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.broadcast_recipients r
     SET processing_claim_id   = v_claim,
         processing_started_at = now()
    FROM winners w
   WHERE r.id = w.id
   RETURNING r.id, v_claim;
END;
$$;

COMMENT ON FUNCTION public.claim_broadcast_recipients IS
  'Atomically hands a worker a batch of sendable recipients under FOR UPDATE SKIP LOCKED. Two workers on one campaign is normal (cron overlapping a manual send); the cost of the race is a buyer texted twice.';

REVOKE ALL ON FUNCTION public.claim_broadcast_recipients(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_broadcast_recipients(uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.release_broadcast_claim(
  p_recipient_id uuid,
  p_claim        uuid
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  -- The claim id in the WHERE is load-bearing: without it a worker whose claim
  -- already expired and was re-taken by a second worker would clear the SECOND
  -- worker's lock on its way out, and the row would be sent a third time.
  UPDATE public.broadcast_recipients
     SET processing_claim_id = NULL, processing_started_at = NULL
   WHERE id = p_recipient_id AND processing_claim_id = p_claim;
$$;

REVOKE ALL ON FUNCTION public.release_broadcast_claim(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_broadcast_claim(uuid, uuid) TO authenticated, service_role;

-- Ten minutes, not five: the reaper must never free a claim the claim query
-- would still consider live, or the two would fight over the same row.
CREATE OR REPLACE FUNCTION public.reap_stale_broadcast_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE v_cleared integer := 0;
BEGIN
  UPDATE public.broadcast_recipients
     SET processing_claim_id = NULL, processing_started_at = NULL
   WHERE processing_claim_id IS NOT NULL
     AND processing_started_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  RETURN v_cleared;
END;
$$;

COMMENT ON FUNCTION public.reap_stale_broadcast_claims IS
  'Frees claims held by workers that died. The 10-minute window is deliberately longer than the 5-minute one in claim_broadcast_recipients so the reaper and the claimer can never contend for the same row.';

REVOKE ALL ON FUNCTION public.reap_stale_broadcast_claims() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reap_stale_broadcast_claims() TO authenticated, service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.broadcast_campaigns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['broadcast_campaigns', 'broadcast_recipients']
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
-- The anon key ships in the browser bundle. What leaks here is the buyers list
-- crossed with every message Tossie has sent it — worse than either alone.
REVOKE ALL ON public.broadcast_campaigns  FROM PUBLIC, anon;
REVOKE ALL ON public.broadcast_recipients FROM PUBLIC, anon;

-- DELETE is granted but the BEFORE DELETE trigger refuses once the audience has
-- been materialised. Draft clutter is deletable; evidence is not.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcast_campaigns TO authenticated;

-- No DELETE on recipients at all. This table IS the record of who was and was
-- not texted; a row that can be removed is a row that proves nothing. The only
-- way recipients disappear is the cascade from deleting an unmaterialised
-- campaign, which by definition has none.
GRANT SELECT, INSERT, UPDATE ON public.broadcast_recipients TO authenticated;

-- ── realtime ────────────────────────────────────────────────────────────────
-- A blast in flight is the one screen an operator watches without touching, and
-- a progress bar that needs a refresh is a progress bar nobody believes.
-- Guarded like 20260817120200: ALTER PUBLICATION ADD errors on a duplicate.
DO $do$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['broadcast_campaigns', 'broadcast_recipients']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $do$;
