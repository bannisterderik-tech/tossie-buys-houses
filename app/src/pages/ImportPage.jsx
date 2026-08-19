import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { TEAM_ID } from '../lib/team.js';
import { parseCsv, normalizeHeader } from '../lib/csv.js';
import './ImportPage.css';

/**
 * CSV import — the lists Tossie had before this system existed, plus whatever a
 * list vendor sells next month.
 *
 * THE FIRST QUESTION THIS PAGE ASKS IS THE WHOLE DESIGN. An earlier version of
 * it hardcoded every imported row as a cold lead and put a banner on the page
 * asserting it. That was wrong in both directions at once:
 *
 *   - It could not record a consent that genuinely exists. Tossie has lists out
 *     of his previous CRM where the seller did opt in, and refusing to record
 *     that is the same failure as lead_is_dialable's old `source = 'website'`
 *     rule — a rail that pushes people off the rails, because an operator who
 *     cannot record a real consent inside the system records it in his head.
 *   - It called a purchased list a "lead" and relied on a warning banner to
 *     make the difference. A banner is not a rail either.
 *
 * So the page asks what kind of list this is, and the two answers write to
 * different tables (BUILD_PLAN Part II §10):
 *
 *   COLD LIST  -> public.prospects. No consent basis, because nobody on a
 *                 bought list agreed to anything. The table has no consent
 *                 columns at all, so there is nothing here to set wrongly and
 *                 no send path that can find one. Not callable until skip
 *                 traced AND DNC/litigator scrubbed (prospect_is_callable);
 *                 never textable, structurally, because every send path
 *                 resolves a LEAD (§12).
 *   OPTED-IN   -> public.leads with tcpa_opt_in true. That is an assertion
 *                 about other people's agreement, so it costs the operator a
 *                 statement of provenance: where the list came from and how
 *                 consent was obtained. Both are written onto every row.
 *
 * A prospect becomes a lead one conversation at a time, through
 * convert_prospect_to_lead(). There is no bulk path from this page into the
 * consented half of the system, and adding one would defeat the model.
 *
 * The import runs on the signed-in operator's session, so RLS applies. That is
 * correct and deliberate: this is a person doing a thing, not a server job, and
 * it means the import cannot write outside their own team even if the team_id
 * below were wrong. It is also the reason a consent record made here has a name
 * attached to it.
 */

// The disclosure version record_lead_consent() and convert_prospect_to_lead()
// both stamp. Same string, because a lead consented through an import and a
// lead consented on a phone call are answering the same question and should not
// look like two different regimes six months from now.
const DISCLOSURE_VERSION = 'v1-2026-08';

// ── the columns an operator can map onto ────────────────────────────────────
// Two catalogues, because the two destinations are genuinely different objects.
// Neither is every column on its table: this is the set a purchased list or an
// old CRM export actually carries, and offering forty options makes the one
// that matters harder to find. `kind` drives coercion — a list that writes
// "$185,000", "Y" and "3/4/2019" has to become an integer, a boolean and a date
// somewhere, and doing it at map time means the preview shows what will really
// be stored.

// What the narrow numeric columns can physically hold. A value outside the
// range is dropped rather than clamped or sent — see coerce(). These are the
// declared precisions in the migrations: equity_pct numeric(5,2), years_owned
// numeric(4,1), leads.beds/baths numeric(4,1). If a column's precision changes,
// this changes with it.
const EQUITY_PCT = [-999.99, 999.99];
const YEARS_OWNED = [-999.9, 999.9];
const ROOM_COUNT = [-999.9, 999.9];

// Every integer column on both tables is int4. A larger value does not
// round-trip, it aborts the insert.
const INT4_MAX = 2147483647;

const PROSPECT_FIELDS = [
  { key: 'address',          label: 'Property address',    group: 'Property', kind: 'text' },
  { key: 'city',             label: 'City',                group: 'Property', kind: 'text' },
  { key: 'state',            label: 'State',               group: 'Property', kind: 'state' },
  { key: 'zip',              label: 'ZIP',                 group: 'Property', kind: 'zip' },
  { key: 'county',           label: 'County',              group: 'Property', kind: 'text' },
  { key: 'property_type',    label: 'Property type',       group: 'Property', kind: 'text' },
  { key: 'year_built',       label: 'Year built',          group: 'Property', kind: 'int' },
  { key: 'assessed_value',   label: 'Assessed value',      group: 'Property', kind: 'int' },
  { key: 'estimated_value',  label: 'Estimated value',     group: 'Property', kind: 'int' },
  { key: 'equity_pct',       label: 'Equity %',            group: 'Property', kind: 'num', range: EQUITY_PCT },
  { key: 'mortgage_balance', label: 'Mortgage balance',    group: 'Property', kind: 'int' },
  { key: 'last_sale_date',   label: 'Last sale date',      group: 'Property', kind: 'date' },
  { key: 'last_sale_price',  label: 'Last sale price',     group: 'Property', kind: 'int' },
  { key: 'years_owned',      label: 'Years owned',         group: 'Property', kind: 'num', range: YEARS_OWNED },

  { key: 'owner_name',       label: 'Owner name',          group: 'Owner',    kind: 'text' },
  { key: 'owner_type',       label: 'Owner type',          group: 'Owner',    kind: 'text' },
  { key: 'owner_occupied',   label: 'Owner occupied',      group: 'Owner',    kind: 'bool' },
  { key: 'mailing_address',  label: 'Mailing address',     group: 'Owner',    kind: 'text' },
  { key: 'mailing_city',     label: 'Mailing city',        group: 'Owner',    kind: 'text' },
  { key: 'mailing_state',    label: 'Mailing state',       group: 'Owner',    kind: 'state' },
  { key: 'mailing_zip',      label: 'Mailing ZIP',         group: 'Owner',    kind: 'zip' },

  { key: 'is_absentee',      label: 'Absentee',            group: 'Distress', kind: 'bool' },
  { key: 'is_out_of_state',  label: 'Out of state owner',  group: 'Distress', kind: 'bool' },
  { key: 'pre_foreclosure',  label: 'Pre-foreclosure',     group: 'Distress', kind: 'bool' },
  { key: 'tax_delinquent',   label: 'Tax delinquent',      group: 'Distress', kind: 'bool' },
  { key: 'vacant',           label: 'Vacant',              group: 'Distress', kind: 'bool' },
  { key: 'bankruptcy',       label: 'Bankruptcy',          group: 'Distress', kind: 'bool' },
  { key: 'liens',            label: 'Liens',               group: 'Distress', kind: 'bool' },

  // Some vendors sell the list already traced. The numbers are stored, and the
  // row is still not callable: prospect_is_callable wants skip_traced AND
  // dnc_scrubbed, and this page sets neither. A number arriving in a CSV is not
  // evidence that anyone checked it against the DNC and litigator files.
  { key: 'phone_mobile',     label: 'Mobile phone',        group: 'From the vendor', kind: 'text' },
  { key: 'phone_landline',   label: 'Landline',            group: 'From the vendor', kind: 'text' },
  { key: 'phone_voip',       label: 'VOIP',                group: 'From the vendor', kind: 'text' },
  { key: 'email_primary',    label: 'Email',               group: 'From the vendor', kind: 'text' },
  { key: 'email_secondary',  label: 'Second email',        group: 'From the vendor', kind: 'text' },
  // The vendor's own row id, which is what makes a re-pull of the same filters
  // land on the same rows instead of doubling the list. There is a partial
  // unique index on (list_id, vendor_id) waiting for it.
  { key: 'vendor_id',        label: 'Vendor row ID / APN', group: 'From the vendor', kind: 'text' },
];

const LEAD_FIELDS = [
  { key: 'address',          label: 'Property address',    group: 'Property', kind: 'text' },
  { key: 'city',             label: 'City',                group: 'Property', kind: 'text' },
  { key: 'state',            label: 'State',               group: 'Property', kind: 'state' },
  { key: 'zip',              label: 'ZIP',                 group: 'Property', kind: 'zip' },
  { key: 'county',           label: 'County',              group: 'Property', kind: 'text' },
  { key: 'property_type',    label: 'Property type',       group: 'Property', kind: 'text' },
  { key: 'beds',             label: 'Beds',                group: 'Property', kind: 'num', range: ROOM_COUNT },
  { key: 'baths',            label: 'Baths',               group: 'Property', kind: 'num', range: ROOM_COUNT },
  { key: 'sqft',             label: 'Square feet',         group: 'Property', kind: 'int' },
  { key: 'year_built',       label: 'Year built',          group: 'Property', kind: 'int' },

  { key: 'name',             label: 'Contact name',        group: 'Contact',  kind: 'text' },
  { key: 'phone',            label: 'Phone',               group: 'Contact',  kind: 'text' },
  { key: 'phone_mobile',     label: 'Mobile phone',        group: 'Contact',  kind: 'text' },
  { key: 'phone_landline',   label: 'Landline',            group: 'Contact',  kind: 'text' },
  { key: 'email',            label: 'Email',               group: 'Contact',  kind: 'text' },
  { key: 'email_secondary',  label: 'Second email',        group: 'Contact',  kind: 'text' },

  { key: 'owner_name',       label: 'Owner name',          group: 'Owner',    kind: 'text' },
  { key: 'owner_occupied',   label: 'Owner occupied',      group: 'Owner',    kind: 'bool' },
  { key: 'mailing_address',  label: 'Mailing address',     group: 'Owner',    kind: 'text' },
  { key: 'mailing_city',     label: 'Mailing city',        group: 'Owner',    kind: 'text' },
  { key: 'mailing_state',    label: 'Mailing state',       group: 'Owner',    kind: 'state' },
  { key: 'mailing_zip',      label: 'Mailing ZIP',         group: 'Owner',    kind: 'zip' },

  { key: 'is_absentee',      label: 'Absentee',            group: 'Distress', kind: 'bool' },
  { key: 'is_out_of_state',  label: 'Out of state owner',  group: 'Distress', kind: 'bool' },
  { key: 'pre_foreclosure',  label: 'Pre-foreclosure',     group: 'Distress', kind: 'bool' },
  { key: 'tax_delinquent',   label: 'Tax delinquent',      group: 'Distress', kind: 'bool' },
  { key: 'vacant',           label: 'Vacant',              group: 'Distress', kind: 'bool' },

  { key: 'motivation',       label: 'Motivation / reason', group: 'Deal',     kind: 'text' },
  { key: 'asking_price',     label: 'Asking price',        group: 'Deal',     kind: 'int' },
  { key: 'arv_estimate',     label: 'ARV estimate',        group: 'Deal',     kind: 'int' },
  { key: 'repair_estimate',  label: 'Repair estimate',     group: 'Deal',     kind: 'int' },
  { key: 'mortgage_balance', label: 'Mortgage balance',    group: 'Deal',     kind: 'int' },
  { key: 'notes',            label: 'Notes',               group: 'Deal',     kind: 'text' },

  // The single most valuable column on an opted-in export, and the one an
  // operator would never think to look for. Mapped, it becomes the real
  // tcpa_opt_in_at; unmapped, the import date and an attestation stand in its
  // place — which is weaker, and the page says so rather than hiding it.
  { key: 'consent_at',       label: 'Consent date',        group: 'Consent',  kind: 'ts' },
];

// Header names seen in the wild, normalized. The first match wins, so a file
// with both "Owner Name" and "Name" gets them onto different columns.
const SHARED_HINTS = {
  address: ['propertyaddress', 'address', 'situsaddress', 'streetaddress', 'street', 'address1', 'addressline1', 'propertystreet'],
  city: ['propertycity', 'city', 'situscity', 'town'],
  state: ['propertystate', 'state', 'situsstate', 'st'],
  zip: ['propertyzip', 'zip', 'zipcode', 'postalcode', 'situszip'],
  county: ['county', 'propertycounty', 'parish'],
  property_type: ['propertytype', 'landuse', 'hometype'],
  year_built: ['yearbuilt', 'built', 'yrbuilt', 'effectiveyearbuilt'],

  owner_name: ['ownername', 'owner', 'owner1', 'ownerfullname', 'taxpayername'],
  owner_occupied: ['owneroccupied', 'owneroccupancy', 'ownerocc'],
  mailing_address: ['mailingaddress', 'mailaddress', 'ownermailingaddress', 'mailingstreet'],
  mailing_city: ['mailingcity', 'mailcity', 'ownermailingcity'],
  mailing_state: ['mailingstate', 'mailstate', 'ownermailingstate'],
  mailing_zip: ['mailingzip', 'mailzip', 'ownermailingzip', 'mailingpostalcode'],

  is_absentee: ['absentee', 'isabsentee', 'absenteeowner'],
  is_out_of_state: ['outofstate', 'isoutofstate', 'outofstateowner'],
  pre_foreclosure: ['preforeclosure', 'foreclosure', 'ispreforeclosure', 'nod'],
  tax_delinquent: ['taxdelinquent', 'delinquenttaxes', 'taxlien', 'istaxdelinquent'],
  vacant: ['vacant', 'isvacant', 'vacancy'],

  mortgage_balance: ['mortgagebalance', 'loanbalance', 'openloans', 'mortgageamount'],
};

// Kept separate from LEAD_HINTS rather than merged into one map, because the
// same header means different columns depending on where the row is going:
// "Estimated Value" is a prospect's estimated_value and a lead's arv_estimate.
// One map with both would resolve by whichever key happened to be listed first.
const PROSPECT_HINTS = {
  ...SHARED_HINTS,
  owner_type: ['ownertype', 'entitytype', 'ownershiptype'],
  assessed_value: ['assessedvalue', 'taxassessedvalue', 'assessed', 'taxvalue'],
  estimated_value: ['estimatedvalue', 'avm', 'marketvalue', 'estvalue', 'estimatedmarketvalue'],
  equity_pct: ['equity', 'equitypercent', 'equitypct', 'percentequity'],
  last_sale_date: ['lastsaledate', 'saledate', 'lastsold', 'lastsolddate', 'transferdate'],
  last_sale_price: ['lastsaleprice', 'saleprice', 'lastsoldprice', 'transferamount'],
  years_owned: ['yearsowned', 'ownershiplength', 'lengthofownership', 'yearsofownership'],
  bankruptcy: ['bankruptcy', 'isbankruptcy', 'bk'],
  liens: ['liens', 'haslien', 'lien', 'judgment', 'judgments'],
  phone_mobile: ['mobile', 'mobilephone', 'cell', 'cellphone', 'phonemobile', 'wireless', 'phone1', 'phone'],
  phone_landline: ['landline', 'homephone', 'phonelandline', 'phone2'],
  phone_voip: ['voip', 'phonevoip', 'phone3'],
  email_primary: ['email', 'email1', 'emailaddress', 'primaryemail'],
  email_secondary: ['email2', 'secondaryemail', 'altemail'],
  vendor_id: ['vendorid', 'recordid', 'propertyid', 'parcelid', 'parcelnumber', 'apn', 'uniqueid', 'id'],
};

const LEAD_HINTS = {
  ...SHARED_HINTS,
  beds: ['beds', 'bedrooms', 'bedroomcount', 'br'],
  baths: ['baths', 'bathrooms', 'bathroomcount', 'ba'],
  sqft: ['sqft', 'squarefeet', 'buildingsqft', 'livingarea', 'livingsqft'],
  name: ['contactname', 'name', 'fullname', 'leadname', 'sellername'],
  phone: ['phone', 'phone1', 'primaryphone', 'phonenumber', 'telephone'],
  phone_mobile: ['mobile', 'mobilephone', 'cell', 'cellphone', 'phonemobile', 'wireless'],
  phone_landline: ['landline', 'homephone', 'phonelandline', 'phone2'],
  email: ['email', 'email1', 'emailaddress', 'primaryemail'],
  email_secondary: ['email2', 'secondaryemail', 'altemail'],
  motivation: ['motivation', 'reason', 'reasonforselling', 'situation', 'leadtype', 'listtype'],
  asking_price: ['askingprice', 'asking', 'listprice', 'price'],
  arv_estimate: ['arv', 'arvestimate', 'aftrepairvalue', 'estimatedvalue', 'avm', 'marketvalue'],
  repair_estimate: ['repairs', 'repairestimate', 'estimatedrepairs', 'rehab'],
  notes: ['notes', 'comments', 'remarks', 'description'],
  // 'createddate' and 'datecreated' are deliberately NOT here. On most CRM
  // exports they are near enough the day the seller signed up, and near enough
  // is exactly the wrong standard for the timestamp on a consent record. An
  // operator who knows that column is the opt-in date can map it by hand, and
  // then it is a decision somebody made rather than a guess this page made.
  consent_at: ['consentdate', 'consentat', 'optindate', 'optinat', 'tcpaoptinat', 'dateoptedin', 'optedinat', 'signupdate', 'datesubmitted', 'submittedat'],
};

const TRUE_WORDS = new Set(['y', 'yes', 'true', 't', '1', 'x', 'owner', 'owneroccupied']);
const FALSE_WORDS = new Set(['n', 'no', 'false', 'f', '0', '']);

/** Last 10 digits — must agree with public.phone_key(), which is the join key. */
const phoneKey = (v) => {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.slice(-10) || null;
};

// Street words that two exports of the same county will spell differently.
// Only the common ones: this normalisation exists to catch "123 Main Street"
// against "123 MAIN ST", not to be a mailing-address validator.
const STREET_WORDS = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln',
  boulevard: 'blvd', court: 'ct', circle: 'cir', place: 'pl', terrace: 'ter',
  parkway: 'pkwy', highway: 'hwy', trail: 'trl', square: 'sq',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  apartment: 'apt', suite: 'ste', unit: 'unit',
};

/**
 * A rough key for "this is the same property".
 *
 * Used ONLY for rows that carry no phone number, which on a county-records or
 * driving-for-dollars list is most of them. Without it the preview tells an
 * operator that a file he has already imported twice contains no duplicates,
 * and every duplicate is a second call to the same homeowner from a system that
 * believes it has never spoken to them.
 *
 * It is a heuristic and it is scoped like one. It never merges anything, it
 * only skips a row, and the skip is counted and shown before the import runs.
 * The ZIP is part of the key because "100 Main St" exists in every county in
 * Georgia and matching on the street alone would suppress real prospects.
 */
function addressKey(address, zip) {
  const words = String(address || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w);
  if (words.length === 0) return null;
  const z = String(zip || '').match(/\d{5}/)?.[0] ?? '';
  return `${words.join(' ')}|${z}`;
}

/**
 * 'YYYY-MM-DD' out of whatever the file wrote, or undefined.
 *
 * Built from the string rather than from a Date wherever possible: `new
 * Date('2019-03-04')` is midnight UTC, and formatting that back through a
 * local-time getter in a US timezone returns the 3rd. A last-sale date that
 * moves a day every time it is read is a small lie that is very hard to see.
 */
function parseDate(raw) {
  const v = String(raw).trim();

  const ymd = (y, m, d) => {
    const yy = Number(y); const mm = Number(m); const dd = Number(d);
    if (!(yy >= 1800 && yy <= 2100) || !(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return undefined;
    // The day-of-month bound above is not enough: "2/30/2019" passes it and
    // Postgres rejects the date outright, which fails the whole 200-row batch.
    // Round-tripping through UTC is the cheapest calendar the browser has, and
    // it knows about February and about leap years.
    const probe = new Date(Date.UTC(yy, mm - 1, dd));
    if (probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) return undefined;
    return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };

  const iso = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return ymd(iso[1], iso[2], iso[3]);

  // Month first. These are US county records and US CRM exports; a European
  // day-first file would be read wrong, which is why the preview shows the
  // parsed value rather than the raw one.
  const us = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (us) {
    let y = Number(us[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return ymd(y, us[1], us[2]);
  }

  // Last resort: "Mar 4, 2019" and friends. Routed back through ymd() rather
  // than sliced out of toISOString(), because Date.parse('45000') — a column of
  // Excel serial numbers mapped onto a date by accident — is the year 45000,
  // and toISOString() renders that as '+045000-01-01'. Sliced to ten characters
  // that is '+045000-01', which Postgres rejects, which fails the whole
  // 200-row batch on a column nobody meant to map.
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  const parsed = new Date(t);
  return ymd(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

/**
 * An ISO timestamp, or undefined. Used for the consent date and nothing else.
 *
 * A cell with no time of day in it becomes midnight UTC rather than midnight
 * local: the file said which day somebody agreed, not which minute, and
 * inventing an hour to make the column look complete is the wrong direction to
 * be wrong in on a consent record.
 */
function parseStamp(raw) {
  const v = String(raw).trim();
  let iso;

  if (/\d:\d/.test(v)) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) iso = new Date(t).toISOString();
  }
  if (!iso) {
    const d = parseDate(v);
    if (d) iso = `${d}T00:00:00Z`;
  }
  if (!iso) return undefined;

  // A consent date in the future is a misread column, not a fact — a European
  // date order, a two-digit year, a spreadsheet serial number. Refusing it
  // sends the row down the attested path, where a human has already said the
  // consent is real, instead of storing a date that discredits the whole batch
  // the first time somebody reads it. A day of slack for clock and timezone.
  return Date.parse(iso) > Date.now() + 86400000 ? undefined : iso;
}

/**
 * A number out of a cell, or undefined.
 *
 * The digit test is the whole point of the helper. `Number('')` is 0, so
 * stripping the non-numerics out of "N/A", "unknown", "none" or an em-dash —
 * all of which real exports write into an empty money column — leaves the empty
 * string and yields zero. Zero is not missing data, it is a claim: a mortgage
 * balance of $0 reads as a house owned outright, which is the single strongest
 * signal on the list and decides who Tossie calls first. Same discipline as the
 * bool case below, where a word we do not recognise is not a yes.
 */
function parseNumber(v) {
  const cleaned = v.replace(/[^0-9.-]/g, '');
  if (!/\d/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Coerce one cell for one target column.
 *
 * Returns undefined when there is nothing usable, so the caller can leave the
 * column out of the insert entirely rather than writing an empty string — '' in
 * `phone` would satisfy leads_has_contact while being just as unreachable as
 * NULL, which is the worst of both.
 */
function coerce(field, raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return undefined;

  switch (field.kind) {
    case 'int': {
      // "$185,000" and "185000.00" are both integers to us.
      const n = parseNumber(v);
      if (n === undefined) return undefined;
      const r = Math.round(n);
      // Past int4 the insert does not round-trip, it fails — and it fails the
      // whole 200-row batch, on a column somebody mis-mapped.
      return Math.abs(r) > INT4_MAX ? undefined : r;
    }
    case 'num': {
      const n = parseNumber(v);
      if (n === undefined) return undefined;
      // Dropped, not clamped, when it will not fit the column. A vendor
      // "Equity" column holding dollars rather than percent is the case this
      // catches: numeric(5,2) rejects 185000 and takes the entire batch down
      // with it. Dropping shows a dash in the preview, which is the mis-mapping
      // made visible before the import; clamping would store 999.99% equity as
      // a fact and the targeting would believe it.
      const [lo, hi] = field.range ?? [];
      if (lo !== undefined && (n < lo || n > hi)) return undefined;
      return n;
    }
    case 'bool': {
      const w = v.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (TRUE_WORDS.has(w)) return true;
      if (FALSE_WORDS.has(w)) return false;
      // A word we do not recognise is not a yes. These columns feed the dialer's
      // targeting, and a mystery string read as "pre-foreclosure: true" is a
      // wrong call to somebody who is not in foreclosure.
      return undefined;
    }
    case 'state': {
      const s = v.toUpperCase().replace(/[^A-Z]/g, '');
      return s.length === 2 ? s : undefined;
    }
    case 'zip': {
      const m = v.match(/\d{5}/);
      return m ? m[0] : undefined;
    }
    case 'date':
      return parseDate(v);
    case 'ts':
      return parseStamp(v);
    default:
      return v;
  }
}

/** Best guess at which column a header means. Never guesses twice. */
function guessMapping(headers, hints, fieldKeys) {
  const taken = new Set();
  return headers.map((h) => {
    const n = normalizeHeader(h);
    for (const [key, aliases] of Object.entries(hints)) {
      if (!fieldKeys.has(key) || taken.has(key)) continue;
      if (aliases.includes(n)) { taken.add(key); return key; }
    }
    return '';
  });
}

/**
 * Pull one file row through the mapping.
 *
 * `raw` is every non-empty cell under its original header, mapped or not. A
 * list's odd column is usually the one worth having six months later, and
 * re-importing to get it back means re-deduping a file nobody kept.
 */
function mapValues(row, headers, mapping, fieldByKey) {
  const out = {};
  const raw = {};

  headers.forEach((h, i) => {
    const value = row[i] ?? '';
    if (value !== '') raw[h] = value;

    const key = mapping[i];
    if (!key || !fieldByKey[key]) return;
    const coerced = coerce(fieldByKey[key], value);
    if (coerced !== undefined && out[key] === undefined) out[key] = coerced;
  });

  return { out, raw };
}

/**
 * The disclosure text stored on every lead an opted-in import creates.
 *
 * Two versions, because there are two genuinely different claims being made and
 * writing one sentence for both would make the weaker one look like the
 * stronger one. This string is what gets read out if anyone ever asks where
 * consent came from, so it says which of the two this row is.
 */
function disclosureText({ origin, how, consentHeader }, dated, stampDate) {
  const head = `Imported from a consented list on ${stampDate}. List: ${origin}. Consent obtained: ${how}.`;
  return dated
    ? `${head} The consent date on this record came from the source file's "${consentHeader}" column.`
    : `${head} The source file carried no consent date for this row, so the timestamp recorded is the import date and the basis is the importing operator's attestation.`;
}

// How consent was obtained, in the operator's words rather than the schema's.
// Presets rather than a free-text box for the same reason LeadDetail's consent
// control uses them: "how" is the field a plaintiff's attorney reads first, and
// "yes" typed into a box is not an answer. Free text is still there, one extra
// choice away, because a real list will eventually not fit any of these.
const CONSENT_SOURCES = [
  'Website or landing-page form with a TCPA disclosure',
  'Signed agreement',
  'Inbound call — they called us and agreed',
  'Replied to our text and asked us to follow up',
  'In person — event, open house or door knock',
];

const PAGE = 1000;
const MAX_PAGES = 25;

/**
 * Read a whole table's dedupe columns, paged.
 *
 * Paged because PostgREST caps a response, and a silent 1,000-row ceiling would
 * report every list as duplicate-free — the failure mode where the page is
 * confidently wrong rather than visibly broken. `capped` is surfaced instead of
 * swallowed for the same reason.
 *
 * The ORDER BY is not decoration. A range request against an unordered query
 * gets whatever order the planner felt like, and it is free to differ between
 * the requests that make up one paged read — so rows land on two pages or on
 * none, and the ones that land on none are exactly the duplicates this page
 * exists to catch. A missed duplicate is a second cold call to a homeowner from
 * a system that believes it has never spoken to them. `id` is the tiebreaker
 * because created_at is not unique: every row of a 200-row batch insert shares
 * one now(), so ordering on it alone is still not a total order. Descending, so
 * that a capped read really is the most recent rows, as the UI claims.
 */
async function readKeys(table, columns, take) {
  let capped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (error) return { capped, error };
    for (const r of data ?? []) take(r);
    if ((data?.length ?? 0) < PAGE) return { capped: false, error: null };
    if (page === MAX_PAGES - 1) capped = true;
  }
  return { capped, error: null };
}

export default function ImportPage() {
  // null until the operator answers the question the page exists to ask. There
  // is no default value here on purpose: a preselected destination is an answer
  // the page gave itself.
  const [kind, setKind] = useState(null);

  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null);     // { delimiter, headers, rows }
  const [mapping, setMapping] = useState([]);
  const [parseErr, setParseErr] = useState(null);
  const [dragging, setDragging] = useState(false);

  // Fixed when the file is read rather than when the import runs, so the
  // disclosure text shown in the preview is exactly the text that gets stored,
  // and so every row of one import shares one timestamp — which makes the batch
  // findable later with a single query if it ever has to be unwound.
  const [importStamp, setImportStamp] = useState(null);

  // Where a cold import lands. `listChoice` is 'new' or an existing list id;
  // appending is the case the (list_id, vendor_id) unique index was built for,
  // and without it that index could never fire.
  const [lists, setLists] = useState([]);
  const [listChoice, setListChoice] = useState('new');
  const [listName, setListName] = useState('');
  const [listVendor, setListVendor] = useState('');

  // The provenance an opted-in import costs. Both required — see the panel.
  const [origin, setOrigin] = useState('');
  const [howPreset, setHowPreset] = useState('');
  const [howOther, setHowOther] = useState('');

  const [keys, setKeys] = useState(null);          // null while loading
  const [keysErr, setKeysErr] = useState(null);
  const [capped, setCapped] = useState({ leads: false, prospects: false });
  // Bumped whenever the dedupe sets have to be rebuilt — after a partial
  // import, and when starting over. Without it, clearing them to null would
  // leave the page saying "checking…" with nothing left to do the checking.
  const [keysNonce, setKeysNonce] = useState(0);

  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [importErr, setImportErr] = useState(null);
  const [progress, setProgress] = useState(0);

  const fileInput = useRef(null);

  const isCold = kind === 'cold';
  const fields = isCold ? PROSPECT_FIELDS : LEAD_FIELDS;
  const fieldByKey = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.key, f])),
    [fields],
  );
  const groups = useMemo(() => [...new Set(fields.map((f) => f.group))], [fields]);
  const how = (howPreset === '__other' ? howOther : howPreset).trim();

  // ── what is already in the system ─────────────────────────────────────────
  // BOTH tables, always, whichever destination was chosen. A row that has been
  // worked as a lead must not come back in as a fresh cold prospect — the
  // prospect would carry none of the conversation, and the dial queue would
  // offer up somebody the SDR is already talking to.
  useEffect(() => {
    let cancelled = false;
    setKeysErr(null);

    (async () => {
      const leadPhones = new Set();
      const leadAddresses = new Set();
      const prospectPhones = new Set();
      const prospectAddresses = new Set();
      const prospectVendor = new Set();

      const [l, p] = await Promise.all([
        readKeys('leads', 'phone, phone_mobile, phone_landline, address, zip', (r) => {
          for (const v of [r.phone, r.phone_mobile, r.phone_landline]) {
            const k = phoneKey(v);
            if (k) leadPhones.add(k);
          }
          const a = addressKey(r.address, r.zip);
          if (a) leadAddresses.add(a);
        }),
        readKeys('prospects', 'list_id, vendor_id, phone_mobile, phone_landline, phone_voip, address, zip', (r) => {
          for (const v of [r.phone_mobile, r.phone_landline, r.phone_voip]) {
            const k = phoneKey(v);
            if (k) prospectPhones.add(k);
          }
          const a = addressKey(r.address, r.zip);
          if (a) prospectAddresses.add(a);
          // Scoped to the list: the same vendor id in two different lists is
          // two different purchases of the same record, and only a collision
          // inside one list violates the unique index.
          if (r.vendor_id) prospectVendor.add(`${r.list_id}:${r.vendor_id}`);
        }),
      ]);

      if (cancelled) return;

      // A half-read set is worse than none. It would report a real duplicate as
      // importable, and the whole value of this screen is that the number it
      // shows before the import is the number that is true. So the failure
      // stops the import instead of quietly shrinking the duplicate count.
      const failed = l.error || p.error;
      if (failed) { setKeysErr(failed.message); setKeys(null); return; }

      setKeys({ leadPhones, leadAddresses, prospectPhones, prospectAddresses, prospectVendor });
      setCapped({ leads: l.capped, prospects: p.capped });
    })();

    return () => { cancelled = true; };
  }, [keysNonce]);

  // The lists a cold import can be appended to. Read on the same nonce so a
  // list created by the previous import appears without a reload.
  useEffect(() => {
    if (!isCold) return undefined;
    let cancelled = false;

    supabase
      .from('prospect_lists')
      .select('id, name, source_vendor, total_count')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled || error) return;
        setLists(data ?? []);
      });

    return () => { cancelled = true; };
  }, [isCold, keysNonce]);

  // ── reading the file ──────────────────────────────────────────────────────
  const readFile = useCallback((file) => {
    if (!file) return;
    setParseErr(null);
    setDone(null);
    setImportErr(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onerror = () => setParseErr('Could not read that file.');
    reader.onload = () => {
      try {
        const result = parseCsv(String(reader.result || ''));
        if (result.headers.length === 0) {
          setParsed(null);
          setParseErr('That file has no rows in it.');
          return;
        }
        setParsed(result);
        setMapping(guessMapping(
          result.headers,
          isCold ? PROSPECT_HINTS : LEAD_HINTS,
          new Set((isCold ? PROSPECT_FIELDS : LEAD_FIELDS).map((f) => f.key)),
        ));
        setImportStamp(new Date().toISOString());
        // The file name is the closest thing to a list name anybody has typed,
        // and it is nearly always right after the extension comes off.
        setListName((prev) => prev || file.name.replace(/\.[^.]+$/, ''));
      } catch (e) {
        setParsed(null);
        setParseErr(e.message || 'Could not read that file as a CSV.');
      }
    };
    // Read as UTF-8. A list exported as Windows-1252 will show mojibake in the
    // preview, which is visible before the import rather than after it — the
    // reason the preview shows values rather than a row count.
    reader.readAsText(file, 'utf-8');
  }, [isCold]);

  // ── analysis ──────────────────────────────────────────────────────────────
  // Every row classified before anything is written, because "how many of these
  // are already in the system" is a question that has to be answerable while
  // there is still time to change the mapping.
  //
  // Deliberately free of the provenance fields: they are typed a character at a
  // time and re-classifying five thousand rows on every keystroke would make
  // the one screen with a legal assertion on it feel broken. The consent
  // columns are composed at import time instead, out of the same values the
  // panel above renders.
  const analysis = useMemo(() => {
    if (!parsed) return null;

    const targetList = listChoice === 'new' ? null : listChoice;
    const seenPhones = new Set();
    const seenAddresses = new Set();
    const seenVendor = new Set();

    const importable = [];
    const skipped = [];
    let alsoProspect = 0;
    let attested = 0;

    parsed.rows.forEach((row, index) => {
      const { out, raw } = mapValues(row, parsed.headers, mapping, fieldByKey);

      const rowPhones = (isCold
        ? [out.phone_mobile, out.phone_landline, out.phone_voip]
        : [out.phone, out.phone_mobile, out.phone_landline]
      ).map(phoneKey).filter(Boolean);

      const addrKey = addressKey(out.address, out.zip);
      const vendorKey = isCold && out.vendor_id ? `${targetList ?? 'new'}:${out.vendor_id}` : null;

      // The two tables disagree about what a usable row is, and both are right.
      // A lead has to be reachable (leads_has_contact); a prospect only has to
      // identify a property or an owner (prospects_identifies_something),
      // because the phone number is what the skip trace is for.
      const usable = isCold
        ? Boolean(out.address || out.owner_name)
        : Boolean(out.phone || out.phone_mobile || out.email);

      const hitLead = rowPhones.some((k) => keys?.leadPhones.has(k))
        || (rowPhones.length === 0 && addrKey ? keys?.leadAddresses.has(addrKey) : false);
      const hitProspect = rowPhones.some((k) => keys?.prospectPhones.has(k))
        || (vendorKey ? keys?.prospectVendor.has(vendorKey) : false)
        || (rowPhones.length === 0 && addrKey ? keys?.prospectAddresses.has(addrKey) : false);

      const dupInFile = rowPhones.some((k) => seenPhones.has(k))
        || (vendorKey ? seenVendor.has(vendorKey) : false)
        || (rowPhones.length === 0 && addrKey ? seenAddresses.has(addrKey) : false);

      let reason = null;
      if (!usable) reason = isCold ? 'no_identity' : 'no_contact';
      else if (dupInFile) reason = 'dup_file';
      else if (hitLead) reason = 'dup_lead';
      // A cold row that already exists as a prospect is the same object twice.
      // An opted-in row that matches a prospect is NOT: the lead does not exist
      // yet, and dropping it would throw away the consent this import is here
      // to record — the exact failure the old page had. It imports, and the
      // overlap is counted and reported so the prospect rows can be dealt with.
      else if (isCold && hitProspect) reason = 'dup_prospect';

      for (const k of rowPhones) seenPhones.add(k);
      if (vendorKey) seenVendor.add(vendorKey);
      if (addrKey) seenAddresses.add(addrKey);

      if (reason) { skipped.push({ index, reason }); return; }

      if (!isCold) {
        if (hitProspect) alsoProspect += 1;
        if (!out.consent_at) attested += 1;
      }
      importable.push({ index, out, raw, dated: !isCold && Boolean(out.consent_at) });
    });

    const count = (r) => skipped.filter((s) => s.reason === r).length;

    return {
      importable,
      skipped,
      alsoProspect,
      attested,
      counts: {
        no_identity: count('no_identity'),
        no_contact: count('no_contact'),
        dup_file: count('dup_file'),
        dup_lead: count('dup_lead'),
        dup_prospect: count('dup_prospect'),
      },
    };
  }, [parsed, mapping, keys, isCold, fieldByKey, listChoice]);

  const mappedKeys = useMemo(() => new Set(mapping.filter(Boolean)), [mapping]);
  const hasUsableColumn = isCold
    ? ['address', 'owner_name'].some((k) => mappedKeys.has(k))
    : ['phone', 'phone_mobile', 'email'].some((k) => mappedKeys.has(k));
  const consentHeader = !isCold
    ? parsed?.headers[mapping.findIndex((m) => m === 'consent_at')] ?? null
    : null;

  function setColumn(index, key) {
    setMapping((prev) => {
      const next = [...prev];
      // One target column per file column. Picking a target that is already in
      // use moves it, rather than writing two values into one field and letting
      // whichever comes last win invisibly.
      if (key) next.forEach((v, i) => { if (v === key && i !== index) next[i] = ''; });
      next[index] = key;
      return next;
    });
  }

  const provenanceReady = isCold
    ? (listChoice !== 'new' || listName.trim().length > 0)
    : (origin.trim().length > 0 && how.length > 0);

  const canImport = Boolean(
    !busy && acknowledged && provenanceReady && keys
      && analysis && analysis.importable.length > 0,
  );

  // ── the import ────────────────────────────────────────────────────────────
  async function runImport() {
    if (!canImport) return;
    setBusy(true);
    setImportErr(null);
    setProgress(0);

    const stampDate = importStamp.slice(0, 10);
    let listId = listChoice === 'new' ? null : listChoice;
    let created = null;

    // The list row first, because prospects.list_id is NOT NULL and because the
    // list is the record of what was bought — from whom, under which filters —
    // which is the only way to decide later whether that vendor is worth buying
    // from again.
    if (isCold && !listId) {
      const { data: who } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('prospect_lists')
        .insert({
          team_id: TEAM_ID,
          name: listName.trim(),
          source_vendor: listVendor.trim() || null,
          description: `Imported from ${fileName} on ${stampDate}.`,
          created_by: who?.user?.id ?? null,
        })
        .select('id, name, source_vendor, total_count')
        .single();

      if (error) {
        setImportErr(`Could not create the list — ${error.message}. Nothing was imported.`);
        setBusy(false);
        return;
      }
      created = data;
      listId = data.id;
    }

    const rows = analysis.importable.map(({ out, raw, dated }) => {
      if (isCold) {
        return {
          ...out,
          team_id: TEAM_ID,
          list_id: listId,
          raw_data: raw,
        };
      }

      const { consent_at: consentAt, ...lead } = out;
      return {
        ...lead,
        team_id: TEAM_ID,
        // Not 'cold_list' — that source means something specific to
        // convert_prospect_to_lead and to anyone reading a lead six months from
        // now, and this is its opposite. source_detail carries the operator's
        // own words about where the list came from.
        source: 'imported_list',
        source_detail: origin.trim(),
        // Warm, not cold: somebody who opted in is further along than a name on
        // a bought list. Status stays 'new' because nobody in THIS system has
        // spoken to them, and 'contacted' would claim a conversation that has
        // no record anywhere.
        temperature: 'warm',
        status: 'new',
        tcpa_opt_in: true,
        // Never null. leads_opt_in_needs_provenance rejects the boolean without
        // it, and rightly: "when did they agree" is the first question anyone
        // asks. When the file did not say, the honest answer is the import date
        // plus an attestation, and the disclosure text says exactly that.
        tcpa_opt_in_at: consentAt ?? importStamp,
        tcpa_disclosure_source: how,
        tcpa_disclosure_version: DISCLOSURE_VERSION,
        tcpa_disclosure_text: disclosureText(
          { origin: origin.trim(), how, consentHeader },
          dated,
          stampDate,
        ),
        consent_sms: true,
        consent_email: true,
        raw_payload: raw,
      };
    });

    const table = isCold ? 'prospects' : 'leads';
    const BATCH = 200;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await supabase.from(table).insert(chunk);

      if (error) {
        // Stop rather than skipping ahead. Everything already inserted stays,
        // and re-running the same file is safe: the dedupe reloads from the
        // database, so the rows that landed are skipped as duplicates on the
        // second pass. Ploughing on would hide a mapping mistake behind a
        // success count.
        if (isCold && listId) await supabase.rpc('refresh_prospect_list_counts', { p_list_id: listId });
        setImportErr(
          `Stopped after ${inserted} rows — ${error.message}. ` +
            'Nothing already imported was lost; fix the mapping and run the same file again, ' +
            'and the rows that landed will be skipped as duplicates.'
            + (created ? ` They are on “${created.name}”, which is now selected below so a second run adds to it rather than creating a second list of the same purchase.` : ''),
        );
        setBusy(false);
        // Point the form at the list that now exists. Without this a retry
        // builds a second list for one purchase, and the counters on both then
        // describe half of it each.
        if (created) {
          setLists((prev) => [created, ...prev]);
          setListChoice(created.id);
        }
        // Reload the dedupe sets: some of these rows are now in the database,
        // so the counts on screen went stale the moment the first batch landed.
        setKeys(null);
        setKeysNonce((n) => n + 1);
        return;
      }

      inserted += chunk.length;
      setProgress(Math.round((inserted / rows.length) * 100));
    }

    // The counters are what the lists screen shows, and they are recomputed
    // rather than incremented, so this is the one call that has to happen after
    // an import rather than during it.
    if (isCold && listId) await supabase.rpc('refresh_prospect_list_counts', { p_list_id: listId });

    setBusy(false);
    setDone({
      inserted,
      skipped: analysis.skipped.length,
      attested: analysis.attested,
      alsoProspect: analysis.alsoProspect,
      listName: listChoice === 'new' ? listName.trim() : lists.find((l) => l.id === listId)?.name,
    });
  }

  /** Back to the first question, because the answer to it decides everything else. */
  function reset() {
    setKind(null);
    setParsed(null);
    setMapping([]);
    setFileName('');
    setImportStamp(null);
    setDone(null);
    setImportErr(null);
    setParseErr(null);
    setAcknowledged(false);
    setListChoice('new');
    setListName('');
    setListVendor('');
    setOrigin('');
    setHowPreset('');
    setHowOther('');
    setKeys(null);
    setKeysNonce((n) => n + 1);
    if (fileInput.current) fileInput.current.value = '';
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (!kind) {
    return (
      <>
        <header><h1>Import a list</h1></header>

        <p className="imp-lede">
          Two kinds of list come through this page and they are not the same object. Answer this
          first — everything else on the page depends on it, and it cannot be changed afterwards
          without starting over.
        </p>

        <div className="imp-kind">
          {/* Buttons rather than clickable cards, so the keyboard reaches them
              the way it reaches everything else. Which is also why the bullets
              below are spans: a <ul> inside a <button> is not phrasing content
              and browsers are entitled to do something surprising with it. */}
          <button type="button" className="imp-kindcard" onClick={() => setKind('cold')}>
            <span className="imp-kindtag">Default — pick this if you are not certain</span>
            <strong>A cold list</strong>
            <span className="imp-kindsub">
              Bought from a vendor, scraped, pulled from county records, driving for dollars.
            </span>
            <span className="imp-kindlist">
              <span>Imports as <b>prospects</b>, not leads.</span>
              <span>No consent is recorded, because none exists.</span>
              <span>Not callable until skip-traced <em>and</em> DNC/litigator scrubbed.</span>
              <span>Can never be texted — prospects have no path to the SMS sender at all.</span>
            </span>
          </button>

          <button type="button" className="imp-kindcard" onClick={() => setKind('optin')}>
            <span className="imp-kindtag alt">Only when they actually agreed</span>
            <strong>A list of people who opted in</strong>
            <span className="imp-kindsub">
              Your previous CRM, past inbound sellers, sign-ups from a form you ran.
            </span>
            <span className="imp-kindlist">
              <span>Imports as <b>leads</b> with consent recorded.</span>
              <span>You will have to say where the list came from and how consent was obtained.</span>
              <span>If the file has a consent date, map it — it is better evidence than today&rsquo;s.</span>
              <span>Callable and textable straight away, which is why the question is asked this way round.</span>
            </span>
          </button>
        </div>

        <p className="imp-lede">
          Not sure? Import it as a cold list. A prospect can become a lead the moment somebody has a
          conversation with them and records how consent was obtained. A lead cannot be un-consented.
        </p>
      </>
    );
  }

  return (
    <>
      <header>
        <h1>Import a {isCold ? 'cold list' : 'consented list'}</h1>
        {parsed && <span className="count">{fileName} · {parsed.rows.length} rows</span>}
      </header>

      {isCold ? (
        <div className="imp-warn">
          <h2>These import as prospects. Nobody on this list agreed to anything.</h2>
          <p>
            A prospect is a name and an address somebody sold us. It lands in <code>prospects</code>,
            which has no consent columns at all — so there is nothing on this page that could mark
            one consented, and no send path in the system that can find one.
          </p>
          <p>
            They stay out of the dial queue until they have been <strong>skip-traced</strong> and
            <strong> DNC + litigator scrubbed</strong> — that is <code>prospect_is_callable()</code> in
            the database, not a setting. The litigator scrub is the part that matters most: serial TCPA
            plaintiffs seed their numbers onto exactly the absentee and pre-foreclosure lists this page
            is for, at $500–$1,500 per call.
          </p>
          <p>
            <strong>They cannot be texted, ever.</strong> Not a policy — Tossie&rsquo;s A2P campaign is
            registered for appointment reminders, cold SMS does not match that registration, and every
            outbound text resolves a lead. When one of these people has a real conversation, convert
            them on their own row and record how they agreed. That is the only door.
          </p>
        </div>
      ) : (
        <div className="imp-attest">
          <h2>This import asserts that these people agreed to be contacted.</h2>
          <p>
            Every row lands with <code>tcpa_opt_in = true</code>, which makes it callable and textable
            immediately. That is the right thing to do when the consent is real — refusing to record a
            consent that exists just moves the record into somebody&rsquo;s head.
          </p>
          <p>
            It is also an assertion made on Tossie&rsquo;s behalf, in his name, about other people. So it
            costs a provenance: where this list came from and how consent was obtained, written onto
            every row it creates. Fill those in below and read what they will say.
          </p>
        </div>
      )}

      {importErr && <div className="err">{importErr}</div>}
      {parseErr && <div className="err">{parseErr}</div>}

      {done ? (
        <div className="card">
          <h2>Imported</h2>
          <div className="body">
            <div className="imp-tally">
              <div className="imp-tile good">
                <b>{done.inserted}</b>
                <span>{isCold ? 'prospects imported' : 'leads imported'}</span>
              </div>
              <div className="imp-tile"><b>{done.skipped}</b><span>rows skipped</span></div>
            </div>

            {isCold ? (
              <p className="imp-note">
                They are on the list <strong>{done.listName}</strong>, not callable and not textable.
                Skip trace and scrub them before anyone picks up a phone.
              </p>
            ) : (
              <>
                <p className="imp-note">
                  They are in the leads list, consented, with the provenance you gave recorded on every
                  one of them. Each lead&rsquo;s detail panel shows what was written.
                </p>
                {done.attested > 0 && (
                  <p className="imp-note">
                    <strong>{done.attested}</strong> of them carry your attestation and today&rsquo;s date
                    rather than a consent date out of the file. If the original system can still export
                    that date, it is worth going back for.
                  </p>
                )}
                {done.alsoProspect > 0 && (
                  <p className="imp-note">
                    <strong>{done.alsoProspect}</strong> matched a prospect already on a cold list. Those
                    prospect rows were left alone, so the same person can be reached from two places —
                    worth finding and converting or archiving them.
                  </p>
                )}
              </>
            )}

            <div className="imp-actions">
              {!isCold && (
                <button className="btn" type="button" onClick={() => navigate('/leads')}>See the leads</button>
              )}
              <button className="btn ghost" type="button" onClick={reset}>Import another file</button>
            </div>
          </div>
        </div>
      ) : !parsed ? (
        <>
          <div
            className={`imp-drop${dragging ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              readFile(e.dataTransfer.files?.[0]);
            }}
          >
            <strong>Drop a CSV here</strong>
            <p>Comma, semicolon, tab or pipe separated. Quoted addresses are handled.</p>
            <button className="btn" type="button" onClick={() => fileInput.current?.click()}>Choose a file</button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </div>
          <div className="imp-actions">
            <button className="btn ghost" type="button" onClick={reset}>
              This is not a {isCold ? 'cold list' : 'consented list'} — go back
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="imp-steps">
            <span><b>1.</b> File read</span>
            <span><b>2.</b> Map the columns</span>
            <span><b>3.</b> {isCold ? 'Name the list' : 'State the provenance'}</span>
            <span><b>4.</b> Check the preview</span>
            <span><b>5.</b> Import</span>
          </div>

          <div className="card">
            <h2>Map the columns</h2>
            <div className="body">
              <p className="imp-note" style={{ marginTop: 0 }}>
                Anything left unmapped is still kept, in the row&rsquo;s raw payload — so an odd column
                is recoverable later without re-importing the file.
              </p>
              {isCold && (
                <p className="imp-note">
                  If the vendor sold this list already skip-traced, map the numbers: they are stored and
                  they are still not a scrub. The row stays uncallable until a real trace and a real DNC
                  and litigator check have run against it.
                </p>
              )}
              <table className="imp-map">
                <thead>
                  <tr>
                    <th>Column in the file</th>
                    <th className="imp-sample">First value</th>
                    <th>Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.headers.map((h, i) => (
                    <tr key={`${h}-${i}`}>
                      <td className="imp-head">{h}</td>
                      <td className="imp-sample">{parsed.rows[0]?.[i] || '—'}</td>
                      <td>
                        <select
                          className={mapping[i] ? '' : 'imp-unmapped'}
                          value={mapping[i] || ''}
                          onChange={(e) => setColumn(i, e.target.value)}
                        >
                          <option value="">— keep in raw payload only —</option>
                          {groups.map((g) => (
                            <optgroup key={g} label={g}>
                              {fields.filter((f) => f.group === g).map((f) => (
                                <option key={f.key} value={f.key}>{f.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {isCold ? (
            <div className="card">
              <h2>Which list is this?</h2>
              <div className="body">
                <div className="fields">
                  <label className="wide">
                    List
                    <select value={listChoice} onChange={(e) => setListChoice(e.target.value)}>
                      <option value="new">Create a new list</option>
                      {lists.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}{l.source_vendor ? ` · ${l.source_vendor}` : ''} · {l.total_count} rows
                        </option>
                      ))}
                    </select>
                  </label>

                  {listChoice === 'new' ? (
                    <>
                      <label className="wide">
                        Name it
                        <input
                          value={listName}
                          onChange={(e) => setListName(e.target.value)}
                          placeholder="Chatham absentee 60%+ equity"
                          autoComplete="off"
                        />
                      </label>
                      <label className="wide">
                        Who did it come from? Optional.
                        <input
                          value={listVendor}
                          onChange={(e) => setListVendor(e.target.value)}
                          placeholder="the vendor, the county site, a wholesaler you traded with"
                          autoComplete="off"
                        />
                      </label>
                    </>
                  ) : (
                    <p className="imp-note" style={{ gridColumn: '1 / -1', margin: 0 }}>
                      Adding to a list that already exists. Rows that carry the vendor&rsquo;s own row ID
                      are matched against what is already on it, so a re-pull of the same filters lands
                      on the same rows instead of doubling them.
                    </p>
                  )}
                </div>

                <p className="imp-note">
                  The list outlives the rows on it. It is the record of what was bought, from whom, how
                  much of it could be traced and how much of it ever answered — which is the only way to
                  decide whether that vendor is worth buying from twice.
                </p>
              </div>
            </div>
          ) : (
            <div className="card">
              <h2>Where did this consent come from?</h2>
              <div className="body">
                <p className="imp-note" style={{ marginTop: 0 }}>
                  Both of these are written onto every lead this import creates, and both are read back
                  out if anyone ever asks. Say what is true rather than what sounds tidy.
                </p>

                <div className="fields">
                  <label className="wide">
                    Where did the list come from? Required.
                    <input
                      value={origin}
                      onChange={(e) => setOrigin(e.target.value)}
                      placeholder="Podio CRM export — seller leads captured 2022–2025"
                      autoComplete="off"
                    />
                  </label>

                  <label className="wide">
                    How was consent obtained? Required.
                    <select value={howPreset} onChange={(e) => setHowPreset(e.target.value)}>
                      <option value="">Choose…</option>
                      {CONSENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                      <option value="__other">Something else — type it</option>
                    </select>
                  </label>

                  {howPreset === '__other' && (
                    <label className="wide">
                      In your own words
                      <input
                        value={howOther}
                        onChange={(e) => setHowOther(e.target.value)}
                        placeholder="they filled in the form on the old site, which carried the disclosure"
                        autoComplete="off"
                      />
                    </label>
                  )}
                </div>

                {/* Shown rather than described. An operator asserting something
                    on Tossie's behalf should be able to read the sentence he is
                    signing before he signs it, not after. */}
                {provenanceReady && (
                  <>
                    <p className="imp-note" style={{ marginTop: 14 }}>
                      This is what gets stored on each lead:
                    </p>
                    {consentHeader && (
                      <blockquote className="imp-quote">
                        {disclosureText({ origin: origin.trim(), how, consentHeader }, true, importStamp.slice(0, 10))}
                      </blockquote>
                    )}
                    {(!consentHeader || (analysis?.attested ?? 0) > 0) && (
                      <blockquote className="imp-quote weak">
                        {disclosureText({ origin: origin.trim(), how, consentHeader }, false, importStamp.slice(0, 10))}
                      </blockquote>
                    )}
                  </>
                )}

                {!consentHeader && (
                  <p className="imp-note">
                    No column is mapped to a consent date. If the file has one — the day they signed up,
                    the day the form was submitted — map it above. A date out of the source system is
                    real evidence; today&rsquo;s date plus your word is the fallback, and it is the
                    version that gets picked apart.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <h2>What will be imported</h2>
            <div className="body">
              {keys === null ? (
                keysErr ? (
                  <>
                    <div className="err">
                      Could not read the existing leads and prospects to check for duplicates —{' '}
                      {keysErr}. The import is held until that succeeds: without it this page would
                      report a file full of people already in the system as brand new.
                    </div>
                    <button className="btn ghost" type="button" onClick={() => setKeysNonce((n) => n + 1)}>
                      Try again
                    </button>
                  </>
                ) : (
                  <p className="imp-note">Checking these against the leads and prospects already in the system…</p>
                )
              ) : (
                <>
                  <div className="imp-tally">
                    <div className="imp-tile good">
                      <b>{analysis.importable.length}</b>
                      <span>{isCold ? 'will become prospects' : 'will become consented leads'}</span>
                    </div>
                    <div className="imp-tile warn">
                      <b>{analysis.skipped.length}</b><span>will be skipped</span>
                    </div>
                    <div className="imp-tile">
                      <b>
                        {analysis.counts.dup_file + analysis.counts.dup_lead + analysis.counts.dup_prospect}
                      </b>
                      <span>duplicates</span>
                    </div>
                    {!isCold && (
                      <div className="imp-tile warn">
                        <b>{analysis.attested}</b><span>on your attestation only</span>
                      </div>
                    )}
                  </div>

                  {analysis.skipped.length > 0 && (
                    <ul className="imp-reasons">
                      {analysis.counts.no_identity > 0 && (
                        <li>
                          <b>{analysis.counts.no_identity}</b>
                          <span>
                            no address and no owner name. A row that identifies neither a property nor a
                            person is an export artefact — the database refuses these outright.
                          </span>
                        </li>
                      )}
                      {analysis.counts.no_contact > 0 && (
                        <li>
                          <b>{analysis.counts.no_contact}</b>
                          <span>
                            no phone and no email. A lead has to be reachable somehow — the database
                            refuses these outright.
                          </span>
                        </li>
                      )}
                      {analysis.counts.dup_lead > 0 && (
                        <li>
                          <b>{analysis.counts.dup_lead}</b>
                          <span>
                            already in the system as leads — someone has worked these. Re-importing them
                            {isCold ? ' as cold prospects would put people the SDR may be talking to back in a dial queue with none of the history.' : ' would create a second copy with a second consent record.'}
                          </span>
                        </li>
                      )}
                      {analysis.counts.dup_prospect > 0 && (
                        <li>
                          <b>{analysis.counts.dup_prospect}</b>
                          <span>already on a prospect list, by phone, address or the vendor&rsquo;s row ID.</span>
                        </li>
                      )}
                      {analysis.counts.dup_file > 0 && (
                        <li>
                          <b>{analysis.counts.dup_file}</b>
                          <span>repeated inside this file. The first one is imported.</span>
                        </li>
                      )}
                    </ul>
                  )}

                  {!isCold && analysis.attested > 0 && (
                    <div className="imp-flag">
                      <strong>
                        {analysis.attested} of these rows carry no consent date in the file.
                      </strong>
                      <p>
                        What gets recorded for them is your attestation and the date of this import —{' '}
                        {importStamp.slice(0, 10)}. That is a real record and it is a weaker one: it says
                        when the list was imported, not when the seller agreed. If the system this came
                        out of can still produce the original dates, that is worth an hour.
                      </p>
                    </div>
                  )}

                  {!isCold && analysis.alsoProspect > 0 && (
                    <div className="imp-flag">
                      <strong>
                        {analysis.alsoProspect} of these are also sitting on a cold list as prospects.
                      </strong>
                      <p>
                        They still import — the consent is the more valuable record and dropping it is
                        the mistake this page was rebuilt to stop making. Their prospect rows are left
                        exactly as they are, which means the same person can be reached from two places
                        until somebody tidies them up.
                      </p>
                    </div>
                  )}

                  {!hasUsableColumn && (
                    <div className="err" style={{ marginTop: 14 }}>
                      {isCold
                        ? 'No column is mapped to an address or an owner name, so every row will be skipped. Map one above.'
                        : 'No column is mapped to a phone or an email, so every row will be skipped. Map one above.'}
                    </div>
                  )}

                  {(capped.leads || capped.prospects) && (
                    <p className="imp-note" style={{ marginTop: 12 }}>
                      Duplicate checking read the {(MAX_PAGES * PAGE).toLocaleString()} most recent
                      {capped.leads && capped.prospects ? ' leads and prospects' : capped.leads ? ' leads' : ' prospects'}.
                      Beyond that a duplicate may still slip through — the phone number is what to search
                      on afterwards.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Preview — the first rows exactly as they will be stored</h2>
            <div className="body">
              {mappedKeys.size === 0 ? (
                <p className="imp-note">Map a column above to see what will be imported.</p>
              ) : (
                <div className="imp-scroll">
                  <table className="imp-preview">
                    <thead>
                      <tr>
                        <th>#</th>
                        {fields.filter((f) => mappedKeys.has(f.key)).map((f) => (
                          <th key={f.key}>{f.label}</th>
                        ))}
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.slice(0, 8).map((row, i) => {
                        const { out } = mapValues(row, parsed.headers, mapping, fieldByKey);
                        const skip = analysis?.skipped.find((s) => s.index === i);
                        return (
                          <tr key={i} className={skip ? 'imp-skipped' : ''}>
                            <td>{i + 1}</td>
                            {fields.filter((f) => mappedKeys.has(f.key)).map((f) => {
                              const v = out[f.key];
                              return (
                                <td key={f.key} className={v === undefined ? 'imp-null' : ''}>
                                  {v === undefined ? '—' : String(v)}
                                </td>
                              );
                            })}
                            <td>
                              {skip ? (
                                <span className={`badge${skip.reason === 'no_identity' || skip.reason === 'no_contact' ? ' stop' : ''}`}>
                                  {skip.reason === 'no_identity' ? 'Identifies nobody'
                                    : skip.reason === 'no_contact' ? 'No contact'
                                    : 'Duplicate'}
                                </span>
                              ) : isCold ? (
                                <span className="badge cold">Prospect</span>
                              ) : out.consent_at ? (
                                <span className="badge ok">Lead · consent dated</span>
                              ) : (
                                <span className="badge warm">Lead · attested</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {busy && (
            <div className="imp-bar"><div style={{ width: `${progress}%` }} /></div>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            {isCold ? (
              <span>
                <strong>I understand these are prospects, not leads.</strong>
                <small>
                  No consent is recorded because none exists. They stay out of the dialer until they
                  have been skip-traced and DNC + litigator scrubbed, and they can never be texted.
                </small>
              </span>
            ) : (
              <span>
                <strong>
                  I attest that the people on this list agreed to be contacted, and that what I have
                  written above is where the list came from and how they agreed.
                </strong>
                <small>
                  This is recorded on every lead it creates, in Tossie&rsquo;s name, with my account
                  attached to it. {analysis && analysis.attested > 0
                    ? `${analysis.attested} of these rows will carry my word and the date ${importStamp.slice(0, 10)} in place of a consent date from the file.`
                    : 'Every row carries a consent date out of the file.'}
                </small>
              </span>
            )}
          </label>

          <div className="imp-actions">
            <button className="btn" type="button" disabled={!canImport} onClick={runImport}>
              {busy
                ? `Importing… ${progress}%`
                : isCold
                  ? `Import ${analysis?.importable.length ?? 0} prospects`
                  : `Import ${analysis?.importable.length ?? 0} leads as consented`}
            </button>
            <button className="btn ghost" type="button" disabled={busy} onClick={reset}>
              Start over
            </button>
          </div>

          {!provenanceReady && (
            <p className="imp-note" style={{ marginTop: 10 }}>
              {isCold
                ? 'Name the list before importing — an unnamed list is a purchase nobody can account for later.'
                : 'Both provenance fields are required. A consent record with no answer to “where from” and “how” is not evidence of anything.'}
            </p>
          )}
        </>
      )}
    </>
  );
}
