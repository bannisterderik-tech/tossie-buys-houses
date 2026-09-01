-- Enrichment must never be the reason a lead is lost.
--
-- The test caught this before a vendor did. leads.occupancy carries a CHECK
-- constraint — 'owner', 'tenant', 'vacant', 'unknown' — and the enrich trigger
-- wrote whatever the vendor sent straight into it. A payload saying
-- "tenant occupied" did not merely fail to map that one field: it violated the
-- constraint and the ENTIRE INSERT was rejected. The lead never arrived.
--
-- Two fixes, and the second matters more than the first.
--
-- 1. occupancy is normalised onto the four values the column allows.
--
-- 2. The whole trigger body is wrapped so that no error inside it can abort the
--    insert. Enrichment is a convenience; ingestion is not. A lead that lands
--    with three fields unfilled is a lead somebody can still call. A lead
--    rejected because a vendor typed something unexpected is gone, and the only
--    trace is a rejected_payload row nobody is watching.
--
--    That is the general form of the bug, not just this instance of it: any
--    CHECK added to leads later, any vendor sending a string where a number is
--    expected, would otherwise have the same effect.

/** Vendor occupancy language onto the four values the column permits. */
create or replace function public.normalise_occupancy(v text)
returns text
language sql
immutable
as $$
  SELECT CASE
    WHEN v IS NULL OR btrim(v) = '' THEN NULL
    -- Tenant first: "tenant occupied" also contains "occupied", so an owner
    -- test on a bare "occupied" match would claim these.
    WHEN lower(v) ~ '\y(tenant|tenants|renter|renters|rented|renting|leased|lease)\y' THEN 'tenant'
    -- Word boundaries throughout. A loose 'nobody' turned "something nobody
    -- expected" into a vacant house, and a loose 'empty' claimed "emptying the
    -- garage" — both caught by running the classifier over awkward sentences
    -- rather than tidy ones.
    WHEN lower(v) ~ '(\y(vacant|unoccupied|abandoned)\y|\yempty\y|\yno\s?(one|body)\s+(is\s+)?liv)' THEN 'vacant'
    WHEN lower(v) ~ '(\y(owner|self|seller|homestead)\y|\yi\s+live\y|\ywe\s+live\y|primary residence)' THEN 'owner'
    WHEN lower(v) ~ '(\y(unknown|unsure)\y|\ynot sure\y|\yn/?a\y)' THEN 'unknown'
    -- Said something we cannot classify. NULL rather than 'unknown': the raw
    -- words are still in raw_payload, and inventing a category from a sentence
    -- nobody parsed is worse than leaving the field open.
    ELSE NULL
  END;
$$;

revoke execute on function public.normalise_occupancy(text) from public, anon;
grant execute on function public.normalise_occupancy(text) to authenticated, service_role;

create or replace function public.enrich_lead_from_payload()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  f jsonb;
  v_first text;
  v_last  text;
BEGIN
  IF NEW.raw_payload IS NULL OR NEW.raw_payload = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  BEGIN
    f := public.flatten_payload(NEW.raw_payload);
    IF f = '{}'::jsonb THEN RETURN NEW; END IF;

    v_first := public.payload_value(f, 'first_name');
    v_last  := public.payload_value(f, 'last_name');
    NEW.name := coalesce(NEW.name, public.payload_value(f, 'name'),
                         nullif(btrim(concat_ws(' ', v_first, v_last)), ''));
    NEW.owner_name := coalesce(NEW.owner_name, public.payload_value(f, 'name'),
                         nullif(btrim(concat_ws(' ', v_first, v_last)), ''));

    NEW.phone           := coalesce(NEW.phone,           public.payload_value(f, 'phone'));
    NEW.phone_mobile    := coalesce(NEW.phone_mobile,    public.payload_value(f, 'phone_mobile'));
    NEW.phone_landline  := coalesce(NEW.phone_landline,  public.payload_value(f, 'phone_landline'));
    NEW.email           := coalesce(NEW.email,           public.payload_value(f, 'email'));
    NEW.email_secondary := coalesce(NEW.email_secondary, public.payload_value(f, 'email_secondary'));
    NEW.phone           := coalesce(NEW.phone, NEW.phone_mobile);

    NEW.address       := coalesce(NEW.address,       public.payload_value(f, 'address'));
    NEW.city          := coalesce(NEW.city,          public.payload_value(f, 'city'));
    NEW.state         := coalesce(NEW.state,         public.payload_value(f, 'state'));
    NEW.zip           := coalesce(NEW.zip,           public.payload_value(f, 'zip'));
    NEW.county        := coalesce(NEW.county,        public.payload_value(f, 'county'));
    NEW.property_type := coalesce(NEW.property_type, public.payload_value(f, 'property_type'));

    -- beds is numeric(4,1), not an integer. The ::int cast this used to carry
    -- would have quietly turned a 3.5-bedroom house into a 3-bedroom one —
    -- found because the test expected '3' and the column returned '3.0'.
    NEW.beds  := coalesce(NEW.beds,  public.payload_number(f, 'beds'));
    NEW.baths := coalesce(NEW.baths, public.payload_number(f, 'baths'));
    NEW.sqft  := coalesce(NEW.sqft,  public.payload_number(f, 'sqft')::int);
    NEW.year_built := coalesce(NEW.year_built,
      (SELECT y FROM (SELECT public.payload_number(f, 'year_built')::int AS y) s
        WHERE s.y BETWEEN 1700 AND extract(year from now())::int + 1));

    NEW.asking_price     := coalesce(NEW.asking_price,     public.payload_number(f, 'asking_price')::int);
    NEW.arv_estimate     := coalesce(NEW.arv_estimate,     public.payload_number(f, 'arv_estimate')::int);
    NEW.repair_estimate  := coalesce(NEW.repair_estimate,  public.payload_number(f, 'repair_estimate')::int);
    NEW.mortgage_balance := coalesce(NEW.mortgage_balance, public.payload_number(f, 'mortgage_balance')::int);

    NEW.motivation      := coalesce(NEW.motivation,      public.payload_value(f, 'motivation'));
    NEW.timeline        := coalesce(NEW.timeline,        public.payload_value(f, 'timeline'));
    NEW.condition_notes := coalesce(NEW.condition_notes, public.payload_value(f, 'condition_notes'));
    NEW.repairs_needed  := coalesce(NEW.repairs_needed,  public.payload_value(f, 'repairs_needed'));
    NEW.notes           := coalesce(NEW.notes,           public.payload_value(f, 'notes'));

    -- Constrained column: normalised, never passed through raw.
    NEW.occupancy := coalesce(NEW.occupancy,
                              public.normalise_occupancy(public.payload_value(f, 'occupancy')));

    NEW.already_listed  := coalesce(public.payload_bool(f, 'already_listed'),  NEW.already_listed);
    NEW.vacant          := coalesce(public.payload_bool(f, 'vacant'),          NEW.vacant);
    NEW.pre_foreclosure := coalesce(public.payload_bool(f, 'pre_foreclosure'), NEW.pre_foreclosure);
    NEW.tax_delinquent  := coalesce(public.payload_bool(f, 'tax_delinquent'),  NEW.tax_delinquent);
    NEW.has_liens       := coalesce(public.payload_bool(f, 'has_liens'),       NEW.has_liens);
    NEW.is_absentee     := coalesce(public.payload_bool(f, 'is_absentee'),     NEW.is_absentee);
    NEW.owner_occupied  := coalesce(public.payload_bool(f, 'owner_occupied'),  NEW.owner_occupied);

    -- A tenant in the house is also the answer to "is it vacant".
    IF NEW.occupancy = 'vacant' AND NEW.vacant IS NULL THEN NEW.vacant := true; END IF;
    IF NEW.occupancy IN ('owner','tenant') AND NEW.vacant IS NULL THEN NEW.vacant := false; END IF;

    NEW.mailing_address := coalesce(NEW.mailing_address, public.payload_value(f, 'mailing_address'));
    NEW.mailing_city    := coalesce(NEW.mailing_city,    public.payload_value(f, 'mailing_city'));
    NEW.mailing_state   := coalesce(NEW.mailing_state,   public.payload_value(f, 'mailing_state'));
    NEW.mailing_zip     := coalesce(NEW.mailing_zip,     public.payload_value(f, 'mailing_zip'));
    NEW.page_path       := coalesce(NEW.page_path,       public.payload_value(f, 'page_path'));
    NEW.referrer        := coalesce(NEW.referrer,        public.payload_value(f, 'referrer'));
    NEW.co_contact_name  := coalesce(NEW.co_contact_name,  public.payload_value(f, 'co_contact_name'));
    NEW.co_contact_phone := coalesce(NEW.co_contact_phone, public.payload_value(f, 'co_contact_phone'));

    IF NEW.is_absentee IS NOT TRUE
       AND NEW.mailing_state IS NOT NULL AND NEW.state IS NOT NULL
       AND upper(btrim(NEW.mailing_state)) <> upper(btrim(NEW.state)) THEN
      NEW.is_absentee := true;
      NEW.is_out_of_state := true;
    END IF;

  EXCEPTION WHEN others THEN
    -- Whatever went wrong, the lead still arrives. Logged so a silent
    -- degradation is findable, and NEW keeps whatever was set before the error.
    RAISE WARNING 'enrich_lead_from_payload skipped for a lead: % (%)', SQLERRM, SQLSTATE;
  END;

  RETURN NEW;
END;
$$;

revoke execute on function public.enrich_lead_from_payload() from public, anon, authenticated;

drop trigger if exists trg_enrich_lead_from_payload on public.leads;
create trigger trg_enrich_lead_from_payload
  before insert on public.leads
  for each row execute function public.enrich_lead_from_payload();

comment on function public.enrich_lead_from_payload() is
  'Fills null lead columns from raw_payload. Never overwrites, and never rejects a lead: any error is warned and skipped.';
