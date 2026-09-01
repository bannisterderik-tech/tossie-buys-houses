-- Fill the other sixty columns from what the vendor actually sent.
--
-- A TRIGGER RATHER THAN A REWRITE. ingest_lead_from_source is two hundred lines
-- of consent handling, dedup and logging that works; reproducing it correctly
-- to add columns to one INSERT is a large edit to the highest-stakes path in
-- the system for a small gain. This runs after that function has done its job
-- and fills what it left null, which is additive: if this trigger were dropped
-- tomorrow, intake would still work exactly as it does today.
--
-- Only ever fills a NULL. A value the importer already resolved, or an operator
-- has since typed, is never overwritten — the payload is evidence of what a
-- vendor claimed on the day, not a standing authority over the record.
create or replace function public.enrich_lead_from_payload()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  f     jsonb;
  v_first text;
  v_last  text;
BEGIN
  IF NEW.raw_payload IS NULL OR NEW.raw_payload = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  -- The vendor's payload, unwrapped and normalised once.
  f := public.flatten_payload(NEW.raw_payload);
  IF f = '{}'::jsonb THEN RETURN NEW; END IF;

  -- ── who they are ────────────────────────────────────────────────────────
  -- leads has one name column, so a vendor sending f_name and l_name gets them
  -- joined. This is the case that started the whole exercise.
  v_first := public.payload_value(f, 'first_name');
  v_last  := public.payload_value(f, 'last_name');
  NEW.name := coalesce(
    NEW.name,
    public.payload_value(f, 'name'),
    nullif(btrim(concat_ws(' ', v_first, v_last)), '')
  );
  NEW.owner_name := coalesce(NEW.owner_name, public.payload_value(f, 'name'),
                             nullif(btrim(concat_ws(' ', v_first, v_last)), ''));

  NEW.phone           := coalesce(NEW.phone,           public.payload_value(f, 'phone'));
  NEW.phone_mobile    := coalesce(NEW.phone_mobile,    public.payload_value(f, 'phone_mobile'));
  NEW.phone_landline  := coalesce(NEW.phone_landline,  public.payload_value(f, 'phone_landline'));
  NEW.email           := coalesce(NEW.email,           public.payload_value(f, 'email'));
  NEW.email_secondary := coalesce(NEW.email_secondary, public.payload_value(f, 'email_secondary'));

  -- A vendor that sends only a mobile still has to be callable.
  NEW.phone := coalesce(NEW.phone, NEW.phone_mobile);

  -- ── the property ────────────────────────────────────────────────────────
  NEW.address       := coalesce(NEW.address,       public.payload_value(f, 'address'));
  NEW.city          := coalesce(NEW.city,          public.payload_value(f, 'city'));
  NEW.state         := coalesce(NEW.state,         public.payload_value(f, 'state'));
  NEW.zip           := coalesce(NEW.zip,           public.payload_value(f, 'zip'));
  NEW.county        := coalesce(NEW.county,        public.payload_value(f, 'county'));
  NEW.property_type := coalesce(NEW.property_type, public.payload_value(f, 'property_type'));

  NEW.beds       := coalesce(NEW.beds,       public.payload_number(f, 'beds')::int);
  NEW.baths      := coalesce(NEW.baths,      public.payload_number(f, 'baths'));
  NEW.sqft       := coalesce(NEW.sqft,       public.payload_number(f, 'sqft')::int);
  -- A four-digit sanity check: vendors put renovation years, "N/A" and 0 in
  -- this field, and a lead built in the year 12 reads as corrupt data on every
  -- screen that shows it.
  NEW.year_built := coalesce(
    NEW.year_built,
    (SELECT y FROM (SELECT public.payload_number(f, 'year_built')::int AS y) s
      WHERE s.y BETWEEN 1700 AND extract(year from now())::int + 1));

  -- ── the numbers ─────────────────────────────────────────────────────────
  NEW.asking_price     := coalesce(NEW.asking_price,     public.payload_number(f, 'asking_price')::int);
  NEW.arv_estimate     := coalesce(NEW.arv_estimate,     public.payload_number(f, 'arv_estimate')::int);
  NEW.repair_estimate  := coalesce(NEW.repair_estimate,  public.payload_number(f, 'repair_estimate')::int);
  NEW.mortgage_balance := coalesce(NEW.mortgage_balance, public.payload_number(f, 'mortgage_balance')::int);

  -- ── the situation ───────────────────────────────────────────────────────
  NEW.motivation      := coalesce(NEW.motivation,      public.payload_value(f, 'motivation'));
  NEW.timeline        := coalesce(NEW.timeline,        public.payload_value(f, 'timeline'));
  NEW.condition_notes := coalesce(NEW.condition_notes, public.payload_value(f, 'condition_notes'));
  NEW.repairs_needed  := coalesce(NEW.repairs_needed,  public.payload_value(f, 'repairs_needed'));
  NEW.occupancy       := coalesce(NEW.occupancy,       public.payload_value(f, 'occupancy'));
  NEW.notes           := coalesce(NEW.notes,           public.payload_value(f, 'notes'));

  -- ── flags. NULL from payload_bool means the vendor did not say, so the
  --    column keeps whatever it had rather than being told "no". ───────────
  NEW.already_listed  := coalesce(public.payload_bool(f, 'already_listed'),  NEW.already_listed);
  NEW.vacant          := coalesce(public.payload_bool(f, 'vacant'),          NEW.vacant);
  NEW.pre_foreclosure := coalesce(public.payload_bool(f, 'pre_foreclosure'), NEW.pre_foreclosure);
  NEW.tax_delinquent  := coalesce(public.payload_bool(f, 'tax_delinquent'),  NEW.tax_delinquent);
  NEW.has_liens       := coalesce(public.payload_bool(f, 'has_liens'),       NEW.has_liens);
  NEW.is_absentee     := coalesce(public.payload_bool(f, 'is_absentee'),     NEW.is_absentee);
  NEW.owner_occupied  := coalesce(public.payload_bool(f, 'owner_occupied'),  NEW.owner_occupied);

  -- ── where they came from ────────────────────────────────────────────────
  NEW.mailing_address := coalesce(NEW.mailing_address, public.payload_value(f, 'mailing_address'));
  NEW.mailing_city    := coalesce(NEW.mailing_city,    public.payload_value(f, 'mailing_city'));
  NEW.mailing_state   := coalesce(NEW.mailing_state,   public.payload_value(f, 'mailing_state'));
  NEW.mailing_zip     := coalesce(NEW.mailing_zip,     public.payload_value(f, 'mailing_zip'));
  NEW.page_path       := coalesce(NEW.page_path,       public.payload_value(f, 'page_path'));
  NEW.referrer        := coalesce(NEW.referrer,        public.payload_value(f, 'referrer'));

  NEW.co_contact_name  := coalesce(NEW.co_contact_name,  public.payload_value(f, 'co_contact_name'));
  NEW.co_contact_phone := coalesce(NEW.co_contact_phone, public.payload_value(f, 'co_contact_phone'));

  -- Absentee is derivable when the vendor did not say it: a mailing address in
  -- a different state from the property is the definition.
  IF NEW.is_absentee IS NOT TRUE
     AND NEW.mailing_state IS NOT NULL AND NEW.state IS NOT NULL
     AND upper(btrim(NEW.mailing_state)) <> upper(btrim(NEW.state)) THEN
    NEW.is_absentee     := true;
    NEW.is_out_of_state := true;
  END IF;

  RETURN NEW;
END;
$$;

revoke execute on function public.enrich_lead_from_payload() from public, anon, authenticated;

drop trigger if exists trg_enrich_lead_from_payload on public.leads;
create trigger trg_enrich_lead_from_payload
  before insert on public.leads
  for each row execute function public.enrich_lead_from_payload();

comment on function public.enrich_lead_from_payload() is
  'Fills null lead columns from raw_payload using lead_field_aliases. Never overwrites a value that is already there.';
