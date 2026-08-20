-- A number an operator types in by hand, and the question that decides whether
-- it may be dialed.
--
-- Until now the only way a prospect got a phone number was a skip trace, and
-- prospect_is_callable insisted on `skip_traced AND dnc_scrubbed` before
-- anything could be dialed. That is right for a number a data vendor found. It
-- is wrong for a number the owner themselves handed over -- somebody who calls
-- the sign in their own yard has made an inquiry, and calling them back is not
-- cold outreach. Refusing to dial that number is not caution, it is the product
-- being unable to describe what happened.
--
-- So the rule gains a second branch, and it is deliberately the SAME shape
-- lead_is_dialable has carried since the leads table shipped:
--
--     tcpa_opt_in OR (skip_traced AND dnc_scrubbed)
--
-- One rail, two ways onto it, on both tables. What does NOT change: a DNC hit,
-- a litigator hit, or a recorded opt-out still veto everything. An internal
-- "stop calling me" outranks any inquiry, and it always will.
alter table public.prospects
  add column if not exists phone_from_owner boolean not null default false,
  add column if not exists phone_source     text,
  add column if not exists phone_source_at  timestamptz,
  add column if not exists phone_source_by  uuid;

comment on column public.prospects.phone_from_owner is
  'True only when the owner supplied the number themselves. Lets prospect_is_callable pass without a skip trace, exactly as tcpa_opt_in does for a lead.';
comment on column public.prospects.phone_source is
  'How a hand-entered number was obtained, in the operator''s words. Required whenever phone_from_owner is true.';

-- "They gave it to us" is a claim about a conversation, and a claim with no
-- author is not evidence. The boolean cannot be set without saying how.
alter table public.prospects
  drop constraint if exists prospects_owner_phone_needs_provenance;
alter table public.prospects
  add constraint prospects_owner_phone_needs_provenance
  check (not phone_from_owner or nullif(btrim(coalesce(phone_source, '')), '') is not null);

create or replace function public.prospect_is_callable(p prospects)
returns boolean
language sql
stable
set search_path to 'public', 'pg_catalog'
as $$
  SELECT p.converted_at IS NULL
     AND COALESCE(p.phone_mobile, p.phone_landline, p.phone_voip) IS NOT NULL
     AND NOT p.is_dnc
     AND NOT p.is_litigator
     -- Every number on the row, not just the one we would dial: a STOP or a
     -- "never call here again" recorded against the landline suppresses the
     -- mobile too. is_opted_out() returns false for a NULL number, so a row
     -- with one number on file is not vetoed by the two it does not have.
     AND NOT public.is_opted_out(p.team_id, p.phone_mobile)
     AND NOT public.is_opted_out(p.team_id, p.phone_landline)
     AND NOT public.is_opted_out(p.team_id, p.phone_voip)
     AND (
       -- The owner handed it over. No vendor touched this number and there is
       -- nothing for a trace to add.
       p.phone_from_owner
       -- Or the cold path, unchanged. Both halves: tracing without scrubbing
       -- produces a number nobody checked against the DNC and litigator files,
       -- which is the expensive half.
       OR (p.skip_traced AND p.dnc_scrubbed)
     );
$$;

/**
 * Write one number onto a prospect, with the provenance that makes it dialable
 * or leaves it cold.
 *
 * An RPC rather than a plain UPDATE because the two facts have to move
 * together. A number typed in with no note of where it came from is the thing
 * that gets a business sued: six months later nobody can say whether the seller
 * offered it or whether somebody found it on a people-search site, and the
 * difference between those is the entire defence.
 *
 * Passing a null number clears that line -- and clears the provenance with it
 * when nothing hand-entered is left, so a row cannot keep claiming an owner
 * gave us a number that is no longer on it.
 */
create or replace function public.set_prospect_phone(
  p_prospect_id uuid,
  p_kind        text,
  p_number      text,
  p_source      text default null,
  p_from_owner  boolean default false
) returns public.prospects
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  v_num    text := nullif(btrim(coalesce(p_number, '')), '');
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_row    public.prospects;
  v_digits int;
BEGIN
  IF p_kind NOT IN ('mobile', 'landline', 'voip') THEN
    RAISE EXCEPTION 'Line must be mobile, landline or voip'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_num IS NOT NULL THEN
    -- Ten digits is the NANP, eleven with the country code. Anything shorter is
    -- a typo, and a typo that reaches the dialer is a call to a stranger.
    v_digits := length(regexp_replace(v_num, '[^0-9]', '', 'g'));
    IF v_digits < 10 OR v_digits > 15 THEN
      RAISE EXCEPTION 'That does not look like a phone number — % digits', v_digits
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Say where this number came from. It decides whether it can be dialed before a scrub.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  UPDATE public.prospects SET
    phone_mobile   = CASE WHEN p_kind = 'mobile'   THEN v_num ELSE phone_mobile   END,
    phone_landline = CASE WHEN p_kind = 'landline' THEN v_num ELSE phone_landline END,
    phone_voip     = CASE WHEN p_kind = 'voip'     THEN v_num ELSE phone_voip     END,
    phone_source    = CASE WHEN v_num IS NULL THEN phone_source    ELSE v_source END,
    phone_source_at = CASE WHEN v_num IS NULL THEN phone_source_at ELSE now()    END,
    phone_source_by = CASE WHEN v_num IS NULL THEN phone_source_by ELSE auth.uid() END,
    -- Once true it stays true while any number remains: the owner gave us a way
    -- to reach them, and adding their landline afterwards does not undo that.
    phone_from_owner = CASE WHEN v_num IS NULL THEN phone_from_owner
                            ELSE phone_from_owner OR coalesce(p_from_owner, false) END
  WHERE id = p_prospect_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prospect not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Nothing hand-entered is left. Drop the claim rather than let it outlive the
  -- number it was about.
  IF coalesce(v_row.phone_mobile, v_row.phone_landline, v_row.phone_voip) IS NULL THEN
    UPDATE public.prospects SET
      phone_from_owner = false,
      phone_source = NULL, phone_source_at = NULL, phone_source_by = NULL
    WHERE id = p_prospect_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

revoke execute on function public.set_prospect_phone(uuid, text, text, text, boolean) from public, anon;
grant  execute on function public.set_prospect_phone(uuid, text, text, text, boolean) to authenticated;
