-- A deleted buyer must not receive a dispo blast.
--
-- buyer_skip_reason is what broadcast-send actually consults, so filtering
-- trashed rows out of the buyers *page* only hid them from the operator while
-- leaving them squarely in the audience. Leads already had lead_trashed as a
-- skip reason; this is the same rule for the other side of the deal.
--
-- Placed alongside buyer_inactive rather than below opted_out, matching the
-- existing precedent: a record the operator has deleted is a more fundamental
-- reason not to send than the state of its consent flags, and the opt-out fact
-- itself is never lost -- it lives in telephony_opt_outs, keyed on phone_key,
-- with no foreign key to buyers at all.
create or replace function public.buyer_skip_reason(b buyers)
returns text
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  -- Order is not cosmetic. When a buyer is suppressed for more than one
  -- reason, the recorded one should be the compliance-relevant one, because
  -- that is the row somebody reads back in a dispute. 'opted_out' therefore
  -- outranks 'no_consent': both mean we did not send, but only one of them is
  -- a person who told us to stop.
  SELECT CASE
    WHEN b.trashed             THEN 'buyer_trashed'
    WHEN b.status <> 'active'  THEN 'buyer_inactive'
    WHEN b.phone IS NULL       THEN 'no_phone'
    WHEN public.is_opted_out(b.team_id, b.phone)
      OR public.is_opted_out(b.team_id, b.phone_secondary) THEN 'opted_out'
    WHEN NOT (b.consent_sms AND b.tcpa_opt_in) THEN 'no_consent'
    ELSE NULL
  END;
$function$;
