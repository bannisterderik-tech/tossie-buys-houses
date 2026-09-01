-- The spellings vendors actually use.
--
-- Gathered from the shapes these platforms post rather than invented: a
-- speed-to-lead tool sends `f_name`, a PPC vendor sends `firstName`, a county
-- scrape sends `OwnerFirstName`, and all three mean the same box on a form.
-- Normalised to lowercase alphanumerics before comparison, so every casing and
-- punctuation variant of one spelling is a single row.
--
-- Priority is only consulted when a payload carries two spellings for the same
-- column. Lower wins. `phone` beats `mobile` because a vendor sending both
-- means the mobile is the second number, not a correction of the first.
insert into public.lead_field_aliases (column_name, alias, priority) values
  -- ── who they are ────────────────────────────────────────────────────────
  ('name',        'name', 10), ('name', 'fullname', 20), ('name', 'contactname', 30),
  ('name',        'sellername', 40), ('name', 'leadname', 50), ('name', 'customername', 60),
  ('name',        'ownername', 70), ('name', 'propertyownername', 80),
  ('first_name',  'firstname', 10), ('first_name', 'fname', 20), ('first_name', 'fnam', 30),
  ('first_name',  'givenname', 40), ('first_name', 'ownerfirstname', 50),
  ('first_name',  'sellerfirstname', 60), ('first_name', 'contactfirstname', 70),
  ('last_name',   'lastname', 10), ('last_name', 'lname', 20), ('last_name', 'surname', 30),
  ('last_name',   'familyname', 40), ('last_name', 'ownerlastname', 50),
  ('last_name',   'sellerlastname', 60), ('last_name', 'contactlastname', 70),

  -- ── how to reach them ───────────────────────────────────────────────────
  ('phone',        'phone', 10), ('phone', 'phonenumber', 20), ('phone', 'primaryphone', 30),
  ('phone',        'telephone', 40), ('phone', 'tel', 50), ('phone', 'contactphone', 60),
  ('phone',        'homephone', 70), ('phone', 'phone1', 80), ('phone', 'bestphone', 90),
  ('phone_mobile', 'mobile', 10), ('phone_mobile', 'mobilephone', 20), ('phone_mobile', 'cell', 30),
  ('phone_mobile', 'cellphone', 40), ('phone_mobile', 'cellular', 50), ('phone_mobile', 'phonemobile', 60),
  ('phone_mobile', 'phone2', 70), ('phone_mobile', 'secondaryphone', 80),
  ('phone_landline','landline', 10), ('phone_landline', 'homephone2', 20), ('phone_landline', 'phonelandline', 30),
  ('email',         'email', 10), ('email', 'emailaddress', 20), ('email', 'primaryemail', 30),
  ('email',         'contactemail', 40), ('email', 'email1', 50), ('email', 'owneremail', 60),
  ('email_secondary','email2', 10), ('email_secondary', 'secondaryemail', 20), ('email_secondary', 'altemail', 30),

  -- ── the property ────────────────────────────────────────────────────────
  ('address', 'address', 10), ('address', 'propertyaddress', 20), ('address', 'streetaddress', 30),
  ('address', 'street', 40), ('address', 'address1', 50), ('address', 'addressline1', 60),
  ('address', 'siteaddress', 70), ('address', 'subjectproperty', 80), ('address', 'propertystreet', 90),
  ('address', 'fulladdress', 100), ('address', 'propertyaddressfull', 110),
  ('city',   'city', 10), ('city', 'propertycity', 20), ('city', 'town', 30), ('city', 'sitecity', 40),
  ('state',  'state', 10), ('state', 'propertystate', 20), ('state', 'statecode', 30),
  ('state',  'st', 40), ('state', 'province', 50), ('state', 'sitestate', 60),
  ('zip',    'zip', 10), ('zip', 'zipcode', 20), ('zip', 'postalcode', 30), ('zip', 'postcode', 40),
  ('zip',    'propertyzip', 50), ('zip', 'sitezip', 60),
  ('county', 'county', 10), ('county', 'propertycounty', 20), ('county', 'parish', 30),
  ('property_type', 'propertytype', 10), ('property_type', 'hometype', 20),
  ('property_type', 'type', 30), ('property_type', 'housetype', 40), ('property_type', 'structuretype', 50),
  ('beds',       'beds', 10), ('beds', 'bedrooms', 20), ('beds', 'numbedrooms', 30),
  ('beds',       'bedroomcount', 40), ('beds', 'br', 50), ('beds', 'noofbedrooms', 60),
  ('baths',      'baths', 10), ('baths', 'bathrooms', 20), ('baths', 'numbathrooms', 30),
  ('baths',      'bathroomcount', 40), ('baths', 'ba', 50), ('baths', 'noofbathrooms', 60),
  ('sqft',       'sqft', 10), ('sqft', 'squarefeet', 20), ('sqft', 'squarefootage', 30),
  ('sqft',       'livingarea', 40), ('sqft', 'buildingsize', 50), ('sqft', 'size', 60),
  ('year_built', 'yearbuilt', 10), ('year_built', 'builtyear', 20), ('year_built', 'yrbuilt', 30),
  ('year_built', 'constructionyear', 40),

  -- ── the numbers ─────────────────────────────────────────────────────────
  ('asking_price',     'askingprice', 10), ('asking_price', 'price', 20), ('asking_price', 'listprice', 30),
  ('asking_price',     'expectedprice', 40), ('asking_price', 'desiredprice', 50),
  ('asking_price',     'howmuchdoyouwant', 60), ('asking_price', 'sellingprice', 70),
  ('arv_estimate',     'arv', 10), ('arv_estimate', 'afterrepairvalue', 20), ('arv_estimate', 'estimatedvalue', 30),
  ('arv_estimate',     'marketvalue', 40), ('arv_estimate', 'zestimate', 50), ('arv_estimate', 'avm', 60),
  ('repair_estimate',  'repairestimate', 10), ('repair_estimate', 'repaircost', 20),
  ('repair_estimate',  'estimatedrepairs', 30), ('repair_estimate', 'rehabcost', 40),
  ('mortgage_balance', 'mortgagebalance', 10), ('mortgage_balance', 'loanbalance', 20),
  ('mortgage_balance', 'amountowed', 30), ('mortgage_balance', 'owed', 40), ('mortgage_balance', 'payoff', 50),

  -- ── the situation, which is what the call is actually about ─────────────
  ('motivation',     'motivation', 10), ('motivation', 'reasonforselling', 20), ('motivation', 'reason', 30),
  ('motivation',     'situation', 40), ('motivation', 'sellingreason', 50), ('motivation', 'whyselling', 60),
  ('timeline',       'timeline', 10), ('timeline', 'timeframe', 20), ('timeline', 'howsoon', 30),
  ('timeline',       'whentosell', 40), ('timeline', 'sellby', 50), ('timeline', 'urgency', 60),
  ('condition_notes','condition', 10), ('condition_notes', 'propertycondition', 20),
  ('condition_notes','housecondition', 30), ('condition_notes', 'conditionnotes', 40),
  ('repairs_needed', 'repairsneeded', 10), ('repairs_needed', 'repairs', 20), ('repairs_needed', 'neededrepairs', 30),
  ('occupancy',      'occupancy', 10), ('occupancy', 'occupied', 20), ('occupancy', 'occupancystatus', 30),
  ('occupancy',      'whoisliving', 40), ('occupancy', 'tenantoccupied', 50),
  ('notes',          'notes', 10), ('notes', 'comments', 20), ('notes', 'message', 30),
  ('notes',          'additionalinfo', 40), ('notes', 'details', 50), ('notes', 'description', 60),
  ('notes',          'anythingelse', 70), ('notes', 'question', 80),

  -- ── flags a wholesaler filters on ───────────────────────────────────────
  ('already_listed',  'alreadylisted', 10), ('already_listed', 'listedwithagent', 20),
  ('already_listed',  'islisted', 30), ('already_listed', 'onmarket', 40),
  ('vacant',          'vacant', 10), ('vacant', 'isvacant', 20), ('vacant', 'vacantproperty', 30),
  ('pre_foreclosure', 'preforeclosure', 10), ('pre_foreclosure', 'foreclosure', 20),
  ('pre_foreclosure', 'inforeclosure', 30), ('pre_foreclosure', 'noticeofdefault', 40),
  ('tax_delinquent',  'taxdelinquent', 10), ('tax_delinquent', 'delinquenttaxes', 20), ('tax_delinquent', 'taxesowed', 30),
  ('has_liens',       'liens', 10), ('has_liens', 'hasliens', 20), ('has_liens', 'judgments', 30),
  ('is_absentee',     'absentee', 10), ('is_absentee', 'isabsentee', 20), ('is_absentee', 'absenteeowner', 30),
  ('owner_occupied',  'owneroccupied', 10), ('owner_occupied', 'isowneroccupied', 20),

  -- ── where they came from ────────────────────────────────────────────────
  ('mailing_address', 'mailingaddress', 10), ('mailing_address', 'ownermailingaddress', 20),
  ('mailing_address', 'ownermailingaddresscompletewithunit', 30), ('mailing_address', 'mailingstreet', 40),
  ('mailing_city',    'mailingcity', 10), ('mailing_city', 'ownermailingcity', 20),
  ('mailing_state',   'mailingstate', 10), ('mailing_state', 'ownermailingstate', 20),
  ('mailing_zip',     'mailingzip', 10), ('mailing_zip', 'ownermailingzip', 20),
  ('page_path',       'pagepath', 10), ('page_path', 'page', 20), ('page_path', 'landingpage', 30),
  ('page_path',       'sourceurl', 40), ('page_path', 'formurl', 50),
  ('referrer',        'referrer', 10), ('referrer', 'referer', 20), ('referrer', 'httpreferrer', 30),
  ('referrer',        'utmsource', 40), ('referrer', 'trafficsource', 50),

  -- ── the second person on the deed, which decides whether a deal closes ──
  ('co_contact_name',  'cocontactname', 10), ('co_contact_name', 'spousename', 20),
  ('co_contact_name',  'secondowner', 30), ('co_contact_name', 'coowner', 40),
  ('co_contact_phone', 'cocontactphone', 10), ('co_contact_phone', 'spousephone', 20)
on conflict (column_name, alias) do update set priority = excluded.priority;
