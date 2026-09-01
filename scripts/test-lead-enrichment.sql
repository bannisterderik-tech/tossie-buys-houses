-- Run this AFTER the three migrations. It creates a throwaway source, posts a
-- deliberately messy payload through the same path a vendor would, checks every
-- field landed, then removes everything it made.
--
-- Nothing here texts anybody: the conversation is created in 'pending' with its
-- grace window in the future, and the block deletes it before that expires.
create temp table t(step text, got text, expect text);

do $$
declare
  team uuid := '70551e00-0000-4000-8000-000000000001';
  sid  uuid;
  lid  uuid;
  raw  jsonb;
  l    public.leads;
  n    int;
begin
  insert into public.lead_sources (team_id, name, slug, consent_basis, auto_sdr, rate_limit_per_min)
  values (team, 'ZZ Test Vendor', 'zz-test-vendor',
          'Seller submitted our web form and ticked the SMS consent box.', true, 60)
  returning id into sid;
  perform public.set_lead_source_secret('zz-test-vendor', 'zz-test-secret-at-least-24-chars-long');

  -- Every awkward shape at once: nested envelope, split name, money with
  -- symbols, yes/no words, a mailing state that differs from the property.
  raw := $j${
    "data": {
      "F_Name": "Doris",
      "Last Name": "Whitfield",
      "Cell Phone": "(912) 555-0134",
      "Email Address": "doris@example.test",
      "propertyAddress": "1408 East Duffy Street",
      "City": "Savannah",
      "ST": "GA",
      "Zip Code": "31401",
      "Bedrooms": "3",
      "bathrooms": "2.5",
      "Square Footage": "1,420",
      "yearBuilt": "1948",
      "Asking Price": "$185,000",
      "amount owed": "94000.00",
      "Reason For Selling": "Inherited it and cannot keep up with the taxes",
      "How Soon": "60 days",
      "Property Condition": "Roof leaks, needs a full kitchen",
      "occupied": "tenant occupied",
      "already listed": "no",
      "vacant": "N",
      "in foreclosure": "yes",
      "Owner Mailing State": "SC",
      "Anything Else": "Please text, do not call before 10am"
    }
  }$j$::jsonb;

  insert into public.leads (team_id, source, source_detail, status, temperature, raw_payload)
  values (team, 'vendor', 'zz-test-vendor', 'new', 'cold', raw)
  returning id into lid;

  select * into l from public.leads where id = lid;

  -- ── the fields ──────────────────────────────────────────────────────────
  insert into t values ('name composed from F_Name + Last Name', coalesce(l.name,'(null)'), 'Doris Whitfield');
  insert into t values ('mobile mapped from "Cell Phone"', coalesce(l.phone_mobile,'(null)'), '(912) 555-0134');
  insert into t values ('phone backfilled from mobile', coalesce(l.phone,'(null)'), '(912) 555-0134');
  insert into t values ('email', coalesce(l.email,'(null)'), 'doris@example.test');
  insert into t values ('address', coalesce(l.address,'(null)'), '1408 East Duffy Street');
  insert into t values ('state from "ST"', coalesce(l.state,'(null)'), 'GA');
  insert into t values ('beds', coalesce(l.beds::text,'(null)'), '3');
  insert into t values ('baths keeps the half', coalesce(l.baths::text,'(null)'), '2.5');
  insert into t values ('sqft strips the comma', coalesce(l.sqft::text,'(null)'), '1420');
  insert into t values ('year_built', coalesce(l.year_built::text,'(null)'), '1948');
  insert into t values ('asking_price strips $ and comma', coalesce(l.asking_price::text,'(null)'), '185000');
  insert into t values ('mortgage_balance', coalesce(l.mortgage_balance::text,'(null)'), '94000');
  insert into t values ('motivation', coalesce(left(l.motivation,9),'(null)'), 'Inherited');
  insert into t values ('timeline', coalesce(l.timeline,'(null)'), '60 days');
  insert into t values ('condition_notes', coalesce(left(l.condition_notes,10),'(null)'), 'Roof leaks');
  insert into t values ('occupancy normalised to the CHECK', coalesce(l.occupancy,'(null)'), 'tenant');
  insert into t values ('vacant derived from occupancy', coalesce(l.vacant::text,'(null)'), 'false');
  insert into t values ('notes', coalesce(left(l.notes,12),'(null)'), 'Please text');
  insert into t values ('"no" -> false', coalesce(l.already_listed::text,'(null)'), 'false');
  insert into t values ('"N" -> false', coalesce(l.vacant::text,'(null)'), 'false');
  insert into t values ('"yes" -> true', coalesce(l.pre_foreclosure::text,'(null)'), 'true');
  insert into t values ('absentee derived from SC vs GA', coalesce(l.is_absentee::text,'(null)'), 'true');

  -- ── consent ─────────────────────────────────────────────────────────────
  insert into t values ('CONSENT GRANTED from source basis', l.tcpa_opt_in::text, 'true');
  insert into t values ('disclosure records the basis', coalesce(left(l.tcpa_disclosure_text,15),'(null)'), 'Seller submitte');
  insert into t values ('textable', l.consent_sms::text, 'true');
  insert into t values ('DIALABLE IMMEDIATELY', public.lead_is_dialable(l)::text, 'true');
  insert into t values ('warmed off cold', l.temperature, 'warm');

  -- ── the SDR ─────────────────────────────────────────────────────────────
  insert into t values ('enrolled on arrival', l.sdr_enabled::text, 'true');
  select count(*) into n from public.sdr_conversations where lead_id = lid and active and step = 'pending';
  insert into t values ('CONVERSATION OPENED', n::text, '1');
  select count(*) into n from public.sdr_conversations where lead_id = lid and grace_until > now();
  insert into t values ('still inside the grace window (nothing sent)', n::text, '1');
  select count(*) into n from public.lead_activity where lead_id = lid and type in ('consent_recorded','sdr_enrolled');
  insert into t values ('both decisions on the timeline', n::text, '2');

  -- ── a hostile payload must not cost us the lead ─────────────────────────
  -- This is the bug the first run found: an occupancy string outside the CHECK
  -- constraint rejected the whole INSERT, so the lead never arrived at all.
  insert into public.leads (team_id, source, source_detail, status, temperature, raw_payload)
  values (team, 'vendor', 'zz-test-vendor', 'new', 'cold', $j${
    "first_name": "Awkward", "last_name": "Payload", "phone": "9125550188",
    "occupied": "it is complicated, my brother stays there sometimes",
    "Bedrooms": "four", "Year Built": "N/A", "Asking Price": "make me an offer",
    "square footage": "", "vacant": "maybe"
  }$j$::jsonb)
  returning id into lid;
  select * into l from public.leads where id = lid;
  insert into t values ('LEAD STILL ARRIVES on an awkward payload', coalesce(l.name,'(null)'), 'Awkward Payload');
  insert into t values ('unparseable occupancy -> null, not a violation', coalesce(l.occupancy,'(null)'), '(null)');
  insert into t values ('"four" is not a number -> null', coalesce(l.beds::text,'(null)'), '(null)');
  insert into t values ('"N/A" year -> null', coalesce(l.year_built::text,'(null)'), '(null)');
  insert into t values ('"make me an offer" -> null', coalesce(l.asking_price::text,'(null)'), '(null)');
  insert into t values ('empty string -> null', coalesce(l.sqft::text,'(null)'), '(null)');
  insert into t values ('"maybe" is not yes or no', coalesce(l.vacant::text,'(null)'), '(null)');

  -- ── a source with neither setting stays cold ────────────────────────────
  update public.lead_sources set consent_basis = null, auto_sdr = false where id = sid;
  insert into public.leads (team_id, source, source_detail, status, temperature, raw_payload)
  values (team, 'vendor', 'zz-test-vendor', 'new', 'cold',
          '{"first_name":"Cold","last_name":"Lead","phone":"9125550199"}'::jsonb)
  returning id into lid;
  select * into l from public.leads where id = lid;
  insert into t values ('unconfigured source: still enriched', coalesce(l.name,'(null)'), 'Cold Lead');
  insert into t values ('unconfigured source: NOT consented', l.tcpa_opt_in::text, 'false');
  insert into t values ('unconfigured source: NOT enrolled', l.sdr_enabled::text, 'false');

  -- ── teardown ────────────────────────────────────────────────────────────
  delete from public.sdr_conversations where lead_id in (select id from public.leads where source_detail='zz-test-vendor');
  delete from public.lead_activity     where lead_id in (select id from public.leads where source_detail='zz-test-vendor');
  delete from public.leads             where source_detail = 'zz-test-vendor';
  delete from public.lead_sources      where id = sid;
  insert into t select 'cleaned up', count(*)::text, '0' from public.lead_sources where slug='zz-test-vendor';
end $$;

select step, got, expect, case when got = expect then 'PASS' else 'FAIL' end as result from t;
