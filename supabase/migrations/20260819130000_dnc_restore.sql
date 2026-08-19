-- ============================================================================
-- Taking a lead back OFF do-not-call — and why that is two operations, not one.
-- ============================================================================
-- Until now there was no way back from a suppression. That is its own problem:
-- an operator who cannot correct a misclick works around the system instead,
-- and the workaround for "this lead is wrongly on DNC" is a sticky note and a
-- phone dialed outside the app, where no rail reaches it at all.
--
-- But the two things that suppress a lead are NOT the same thing, and the whole
-- design here exists to keep them apart:
--
--   (A) leads.is_dnc — an internal flag. log_disposition('do_not_call') sets
--       it, and so does a wrong-number tap on the row above the one intended.
--       When it was a misclick, NOBODY ever asked not to be called. Clearing it
--       is ordinary data repair.
--
--   (B) telephony_opt_outs — written when the person themselves texted STOP.
--       Removing that row re-enables texting and dialing someone who explicitly
--       opted out. Under the TCPA the consumer is the party who revokes their
--       own opt-out, by texting START. An operator clearing it is a liability
--       decision taken on Tossie's behalf, not a data fix.
--
-- (B) has real legitimate cases — the STOP came from a number misattributed to
-- this lead, or the person has since called in and asked to be contacted again,
-- which is itself consent — so it must be possible. It must never be EASY in
-- the way (A) is. Hence two RPCs rather than one with a flag: clearing a
-- misclick cannot silently un-suppress a real STOP, because the code path that
-- would do it is not the one the operator called.
--
-- CONSENT IS NOT RESTORED BY EITHER RPC. leads.consent_sms is left exactly as
-- log_disposition left it. Lifting a suppression says "we are no longer
-- refusing to contact this person"; consent says "this person agreed to be
-- contacted." Re-granting the second on an operator's say-so is the part that
-- would actually create exposure, and it is the part neither of these does.
-- If consent genuinely came back, it came back through an act of the seller's
-- and belongs on the lead with its own timestamp — not as a side effect here.
--
-- 20260818120000 says there is no path from the operator UI to un-suppressing a
-- number, because `authenticated` holds no DELETE on telephony_opt_outs. That
-- grant does not change. These functions are SECURITY DEFINER precisely so the
-- grant can stay shut: the only way through it is a call that leaves a signed,
-- reasoned audit row behind. See docs/BUILD_PLAN.md §5.
-- ============================================================================

-- ── the audit trail ─────────────────────────────────────────────────────────
-- The question that gets asked months later, usually by somebody's lawyer, is
-- "who un-suppressed this number, when, and why". It has to be answerable from
-- the database rather than from memory, so the answer is a row rather than a
-- column on the thing that changed — leads.is_dnc going back to false records
-- no reason, no author and no second occurrence.
CREATE TABLE IF NOT EXISTS public.dnc_restore_log (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Nullable and ON DELETE SET NULL: the lead can be deleted, the record that
  -- someone lifted a suppression cannot. CASCADE here would let deleting a lead
  -- erase the evidence of the one write on it that most needs evidence.
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,

  -- Stored in phone_key() form for the same reason telephony_opt_outs is: this
  -- row has to be findable by the number Twilio posts, months after whatever
  -- formatting the operator typed has been forgotten. Null is allowed only for
  -- 'lead_flag', where a lead can genuinely have no number on file.
  phone_key text,

  kind   text NOT NULL,
  reason text NOT NULL,

  -- ON DELETE SET NULL, matching phone_numbers.released_by: losing which
  -- operator did it is survivable, losing the record that it happened is not.
  restored_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  restored_at timestamptz NOT NULL DEFAULT now(),

  -- Copied off the telephony_opt_outs row before it is deleted, because after
  -- the delete there is nothing left to say whether this was a seller's STOP or
  -- a bulk dnc_scrub hit — and those are not the same decision to have made.
  prior_source       text,
  prior_opted_out_at timestamptz,

  CONSTRAINT dnc_restore_log_kind_check CHECK (kind IN ('lead_flag', 'opt_out')),
  -- A blank reason makes the whole table useless: it would prove only that
  -- somebody clicked. Checked here as well as in the RPCs so no future writer
  -- can skip it.
  CONSTRAINT dnc_restore_log_reason_check CHECK (btrim(reason) <> ''),
  -- An opt_out restoration is always about a specific number; a row that
  -- cannot say which number was un-suppressed answers nothing.
  CONSTRAINT dnc_restore_log_optout_needs_key
    CHECK (kind <> 'opt_out' OR phone_key IS NOT NULL)
);

-- The two reads this table has: the history on one lead's detail panel, and
-- "has this number ever been un-suppressed", which is asked from the number
-- when the lead it belonged to is no longer the one in front of you.
CREATE INDEX IF NOT EXISTS dnc_restore_log_lead_idx
  ON public.dnc_restore_log(lead_id, restored_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dnc_restore_log_key_idx
  ON public.dnc_restore_log(phone_key, restored_at DESC) WHERE phone_key IS NOT NULL;

COMMENT ON TABLE public.dnc_restore_log IS
  'Append-only record of every suppression an operator lifted: which kind, which number, why, and who. Written only by clear_lead_dnc and clear_phone_opt_out. authenticated gets SELECT and INSERT and nothing else — an audit trail that can be edited is not one.';
COMMENT ON COLUMN public.dnc_restore_log.kind IS
  'lead_flag = leads.is_dnc, an internal flag nobody asked for. opt_out = a telephony_opt_outs row, which usually means the person texted STOP. The two are not equally reversible and the UI must not present them as if they were.';
COMMENT ON COLUMN public.dnc_restore_log.prior_source IS
  'telephony_opt_outs.source as it stood before the delete: sms_stop, manual, verbal or dnc_scrub. After the delete there is no other copy.';

-- ── (A) the internal flag ───────────────────────────────────────────────────
-- Ordinary data repair, and shaped like it: one call, one reason, done.
--
-- SECURITY DEFINER for consistency with its sibling below rather than because
-- this one needs it — leads is a table `authenticated` can already UPDATE. What
-- it buys is that the flag cannot be cleared without an audit row, because the
-- alternative (a bare UPDATE from the browser) is still possible and this
-- function is what the UI calls instead. That is a convention, not a guarantee;
-- making it a guarantee would mean a trigger on leads.is_dnc, which is not
-- worth it while every writer is in this repo.
--
-- SECURITY DEFINER bypasses RLS, so the team is checked by hand. Every read and
-- write below is scoped to v_team explicitly; there is no statement here that
-- would find a row on another team.
CREATE OR REPLACE FUNCTION public.clear_lead_dnc(
  p_lead_id uuid,
  p_reason  text
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_team   uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_lead   public.leads;
BEGIN
  v_team := public.get_my_team_id();
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'No team for this caller' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reason is required to clear the do-not-call flag'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_lead FROM public.leads
   WHERE id = p_lead_id AND team_id = v_team
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Already clear: return the lead and write nothing. A double-tap must not
  -- leave two audit rows each claiming a restoration, and an audit row saying a
  -- flag was cleared when it was already false is a false record — the one
  -- thing this table cannot afford to contain.
  IF NOT v_lead.is_dnc THEN
    RETURN v_lead;
  END IF;

  -- is_dnc and nothing else. log_disposition('do_not_call') also set status to
  -- 'dead' and consent_sms to false, and neither is rewound here: what the
  -- status was before the mis-tap is not recorded anywhere this function could
  -- read, so restoring it would mean guessing. The operator sets the status
  -- themselves, which is a field on the page they are already looking at.
  UPDATE public.leads SET is_dnc = false
   WHERE id = p_lead_id
   RETURNING * INTO v_lead;

  -- NOT touching telephony_opt_outs is the point of this function existing
  -- separately. If the seller also texted STOP, this call leaves them
  -- suppressed and lead_is_dialable() stays false — correctly.
  INSERT INTO public.dnc_restore_log (
    team_id, lead_id, phone_key, kind, reason, restored_by
  ) VALUES (
    v_team, p_lead_id,
    public.phone_key(COALESCE(v_lead.phone_mobile, v_lead.phone)),
    'lead_flag', v_reason, auth.uid()
  );

  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_team, p_lead_id, auth.uid(), 'user', 'dnc_restored',
    'Do-not-call flag removed - ' || v_reason,
    jsonb_build_object('kind', 'lead_flag', 'reason', v_reason)
  );

  RETURN v_lead;
END;
$$;

COMMENT ON FUNCTION public.clear_lead_dnc IS
  'Clears leads.is_dnc and records why. Deliberately does NOT remove a telephony_opt_outs row: this is the misclick fix, and a misclick fix that could un-suppress a real STOP would be the most expensive convenience in the product. Does not restore consent_sms.';

-- ── (B) the opt-out the person asked for ────────────────────────────────────
-- SECURITY DEFINER because it must DELETE from telephony_opt_outs, and
-- `authenticated` deliberately has no DELETE grant there (20260818120000). That
-- withheld grant is the reason this function is written the way it is: it is
-- the single, named, audited hole in an otherwise closed door, rather than the
-- door being opened.
--
-- Same explicit team check, and for a sharper reason than in clear_lead_dnc:
-- RLS is the ONLY thing scoping telephony_opt_outs, this function does not run
-- under it, and phone_key is not unique across teams. Without `team_id =
-- v_team` on the DELETE, one caller could lift another team's suppression by
-- guessing a phone number.
CREATE OR REPLACE FUNCTION public.clear_phone_opt_out(
  p_lead_id uuid,
  p_number  text,
  p_reason  text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_team    uuid;
  v_reason  text := btrim(COALESCE(p_reason, ''));
  v_key     text := public.phone_key(p_number);
  v_lead    public.leads;
  v_actor   text;
  v_source  text;
  v_at      timestamptz;
  v_removed integer;
BEGIN
  v_team := public.get_my_team_id();
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'No team for this caller' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reason is required to clear an SMS opt-out'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'No usable phone number' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_lead FROM public.leads
   WHERE id = p_lead_id AND team_id = v_team;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- The number has to be one of this lead's own. Not paranoia about the UI —
  -- it is what keeps the audit row's lead_id honest. A call that cleared an
  -- arbitrary key while naming a lead would file the decision under a seller
  -- who had nothing to do with it, and that row is the thing anyone reads
  -- afterwards to find out what happened.
  IF v_key IS DISTINCT FROM public.phone_key(v_lead.phone)
     AND v_key IS DISTINCT FROM public.phone_key(v_lead.phone_mobile) THEN
    RAISE EXCEPTION 'That number is not on this lead'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- DELETE ... RETURNING rather than SELECT-then-DELETE: the prior source and
  -- timestamp are captured by the same statement that removes them, so there is
  -- no window in which a concurrent write changes the row between being read
  -- for the audit and being deleted.
  DELETE FROM public.telephony_opt_outs
   WHERE team_id = v_team AND phone_key = v_key
   RETURNING source, opted_out_at INTO v_source, v_at;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- Nothing was suppressed, so nothing was un-suppressed. Same reasoning as the
  -- no-op in clear_lead_dnc: an audit row here would describe an event that did
  -- not happen.
  IF v_removed = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.dnc_restore_log (
    team_id, lead_id, phone_key, kind, reason, restored_by,
    prior_source, prior_opted_out_at
  ) VALUES (
    v_team, p_lead_id, v_key, 'opt_out', v_reason, auth.uid(), v_source, v_at
  );

  -- The name goes in the summary text, not just in actor_id. The timeline is
  -- read as prose by whoever opens the lead next, and "a STOP was cleared" with
  -- a uuid attached reads as something the system did on its own. It was not:
  -- a person decided this, and the line should say so out loud.
  SELECT COALESCE(NULLIF(btrim(full_name), ''), email, 'an operator')
    INTO v_actor
    FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.lead_activity (team_id, lead_id, actor_id, actor_kind, type, summary, payload)
  VALUES (
    v_team, p_lead_id, auth.uid(), 'user', 'opt_out_cleared',
    'SMS opt-out cleared on ' || v_key || ' by ' || COALESCE(v_actor, 'an operator')
      || ' (was ' || COALESCE(v_source, 'unknown') || ') - ' || v_reason,
    jsonb_build_object(
      'kind', 'opt_out', 'phone_key', v_key, 'reason', v_reason,
      'prior_source', v_source, 'prior_opted_out_at', v_at
    )
  );

  RETURN v_removed;
END;
$$;

COMMENT ON FUNCTION public.clear_phone_opt_out IS
  'Removes a telephony_opt_outs row for one of a lead''s numbers, capturing what it said into dnc_restore_log first, and returns how many rows went. This re-enables contacting someone who opted out — the only two defensible reasons are a misattributed STOP or the person asking to be contacted again. Does not restore consent_sms.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.dnc_restore_log ENABLE ROW LEVEL SECURITY;

-- Same shape as every other team-scoped table. FOR ALL looks broader than the
-- table is meant to be, and it is not: append-only is enforced by the grants
-- below, exactly as it is for sms_messages and call_log. A policy cannot
-- withhold a privilege the role does not hold.
DROP POLICY IF EXISTS dnc_restore_log_team_all ON public.dnc_restore_log;
CREATE POLICY dnc_restore_log_team_all ON public.dnc_restore_log
  FOR ALL TO authenticated
  USING (team_id = public.get_my_team_id())
  WITH CHECK (team_id = public.get_my_team_id());

-- ── grants ──────────────────────────────────────────────────────────────────
-- 20260817120300 set default privileges so anon inherits nothing on new tables.
-- Stated again anyway, as every table since has: the anon key ships in the
-- browser bundle, and this table names phone numbers and the operator who
-- un-suppressed them.
REVOKE ALL ON public.dnc_restore_log FROM PUBLIC, anon;

-- SELECT and INSERT only. No UPDATE, no DELETE — a reason that can be rewritten
-- afterwards is not a reason, it is a draft. INSERT is granted rather than
-- withheld so the app can be read back honestly: the RPCs write these rows as
-- the definer regardless, but a future path that needs to file a restoration
-- should be able to without another SECURITY DEFINER function.
GRANT SELECT, INSERT ON public.dnc_restore_log TO authenticated;

REVOKE ALL ON FUNCTION public.clear_lead_dnc(uuid, text)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_phone_opt_out(uuid, text, text)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_lead_dnc(uuid, text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_phone_opt_out(uuid, text, text) TO authenticated;
