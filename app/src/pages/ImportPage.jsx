import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { TEAM_ID } from '../lib/team.js';
import { parseCsv, normalizeHeader } from '../lib/csv.js';
import './ImportPage.css';

/**
 * CSV import — the lists Tossie had before this system existed, plus whatever
 * a list vendor sells next month.
 *
 * THE CONSENT RULE IS THE POINT OF THIS PAGE. Everything imported here is COLD:
 * `tcpa_opt_in` stays false, `source` is 'cold_list', `temperature` is 'cold'.
 * Nobody on a purchased list agreed to anything, so BUILD_PLAN §5 and
 * lead_is_dialable() both say the same thing — a cold-list lead is not
 * contactable until it has been skip-traced AND DNC-scrubbed. An import that
 * quietly marked five thousand rows contactable would be the single most
 * expensive bug in this product at $500-$1,500 per contact, so the page says so
 * in the loudest element on it and there is no checkbox anywhere that changes
 * it. Consent for one of these leads gets recorded, with its provenance, when
 * somebody actually obtains it — record_lead_consent() on the lead detail
 * panel, one at a time.
 *
 * The import runs on the signed-in operator's session, so RLS applies. That is
 * correct and deliberate: this is a person doing a thing, not a server job, and
 * it means the import cannot write outside their own team even if the team_id
 * below were wrong.
 */

// ── the columns an operator can map onto ────────────────────────────────────
// Deliberately not every column on `leads`. This is the set a purchased list
// or an old CRM export actually carries; offering forty options makes the one
// that matters harder to find. `kind` drives coercion — a list that writes
// "$185,000" and "Y" has to become an integer and a boolean somewhere, and
// doing it at map time means the preview shows what will really be stored.
const LEAD_FIELDS = [
  { key: 'address',          label: 'Property address',    group: 'Property', kind: 'text' },
  { key: 'city',             label: 'City',                group: 'Property', kind: 'text' },
  { key: 'state',            label: 'State',               group: 'Property', kind: 'state' },
  { key: 'zip',              label: 'ZIP',                 group: 'Property', kind: 'zip' },
  { key: 'county',           label: 'County',              group: 'Property', kind: 'text' },
  { key: 'property_type',    label: 'Property type',       group: 'Property', kind: 'text' },
  { key: 'beds',             label: 'Beds',                group: 'Property', kind: 'num' },
  { key: 'baths',            label: 'Baths',               group: 'Property', kind: 'num' },
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
];

const FIELD_BY_KEY = Object.fromEntries(LEAD_FIELDS.map((f) => [f.key, f]));
const GROUPS = [...new Set(LEAD_FIELDS.map((f) => f.group))];

// Header names seen in the wild, normalized. The first match wins, so a file
// with both "Owner Name" and "Name" gets them onto different columns.
const HEADER_HINTS = {
  address: ['propertyaddress', 'address', 'situsaddress', 'streetaddress', 'street', 'address1', 'addressline1', 'propertystreet'],
  city: ['propertycity', 'city', 'situscity', 'town'],
  state: ['propertystate', 'state', 'situsstate', 'st'],
  zip: ['propertyzip', 'zip', 'zipcode', 'postalcode', 'situszip'],
  county: ['county', 'propertycounty', 'parish'],
  property_type: ['propertytype', 'landuse', 'hometype'],
  beds: ['beds', 'bedrooms', 'bedroomcount', 'br'],
  baths: ['baths', 'bathrooms', 'bathroomcount', 'ba'],
  sqft: ['sqft', 'squarefeet', 'buildingsqft', 'livingarea', 'livingsqft'],
  year_built: ['yearbuilt', 'built', 'yrbuilt', 'effectiveyearbuilt'],

  name: ['contactname', 'name', 'fullname', 'leadname', 'sellername'],
  phone: ['phone', 'phone1', 'primaryphone', 'phonenumber', 'telephone'],
  phone_mobile: ['mobile', 'mobilephone', 'cell', 'cellphone', 'phonemobile', 'wireless'],
  phone_landline: ['landline', 'homephone', 'phonelandline', 'phone2'],
  email: ['email', 'email1', 'emailaddress', 'primaryemail'],
  email_secondary: ['email2', 'secondaryemail', 'altemail'],

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

  motivation: ['motivation', 'reason', 'reasonforselling', 'situation', 'leadtype', 'listtype'],
  asking_price: ['askingprice', 'asking', 'listprice', 'price'],
  arv_estimate: ['arv', 'arvestimate', 'aftrepairvalue', 'estimatedvalue', 'avm', 'marketvalue'],
  repair_estimate: ['repairs', 'repairestimate', 'estimatedrepairs', 'rehab'],
  mortgage_balance: ['mortgagebalance', 'loanbalance', 'openloans', 'mortgageamount'],
  notes: ['notes', 'comments', 'remarks', 'description'],
};

const TRUE_WORDS = new Set(['y', 'yes', 'true', 't', '1', 'x', 'owner', 'owneroccupied']);
const FALSE_WORDS = new Set(['n', 'no', 'false', 'f', '0', '']);

/** Last 10 digits — must agree with public.phone_key(), which is the join key. */
const phoneKey = (v) => {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.slice(-10) || null;
};

/**
 * Coerce one cell for one target column.
 *
 * Returns undefined when there is nothing usable, so the caller can leave the
 * column out of the insert entirely rather than writing an empty string — '' in
 * `phone` would satisfy leads_has_contact while being just as unreachable as
 * NULL, which is the worst of both.
 */
function coerce(kind, raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return undefined;

  switch (kind) {
    case 'int': {
      // "$185,000" and "185000.00" are both integers to us.
      const n = Number(v.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? Math.round(n) : undefined;
    }
    case 'num': {
      const n = Number(v.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : undefined;
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
    default:
      return v;
  }
}

/** Best guess at which lead column a header means. Never guesses twice. */
function guessMapping(headers) {
  const taken = new Set();
  return headers.map((h) => {
    const n = normalizeHeader(h);
    for (const [key, hints] of Object.entries(HEADER_HINTS)) {
      if (taken.has(key)) continue;
      if (hints.includes(n)) { taken.add(key); return key; }
    }
    return '';
  });
}

/** Build the row that will actually be inserted. */
function buildLead(row, mapping, headers) {
  const lead = {};
  const raw = {};

  headers.forEach((h, i) => {
    const value = row[i] ?? '';
    if (value !== '') raw[h] = value;

    const key = mapping[i];
    if (!key) return;
    const coerced = coerce(FIELD_BY_KEY[key].kind, value);
    if (coerced !== undefined && lead[key] === undefined) lead[key] = coerced;
  });

  return {
    ...lead,
    team_id: TEAM_ID,
    // The three fields that make this a cold lead, set here rather than
    // anywhere a UI control could reach them. See the note at the top.
    source: 'cold_list',
    temperature: 'cold',
    status: 'new',
    tcpa_opt_in: false,
    consent_sms: false,
    consent_email: false,
    // Unmapped columns are not thrown away. A list's odd column is usually the
    // one worth having six months later, and re-importing to get it back means
    // re-deduping a file nobody kept.
    raw_payload: raw,
  };
}

export default function ImportPage() {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null);     // { delimiter, headers, rows }
  const [mapping, setMapping] = useState([]);
  const [parseErr, setParseErr] = useState(null);
  const [dragging, setDragging] = useState(false);

  const [existingKeys, setExistingKeys] = useState(null); // Set | null while loading
  const [existingCapped, setExistingCapped] = useState(false);
  // Bumped whenever the dedupe set has to be rebuilt — after a partial import,
  // and when starting over. Without it, clearing the set to null would leave
  // the page saying "checking…" with nothing left to do the checking.
  const [keysNonce, setKeysNonce] = useState(0);

  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [importErr, setImportErr] = useState(null);
  const [progress, setProgress] = useState(0);

  const fileInput = useRef(null);

  // ── existing leads, for the dedupe ────────────────────────────────────────
  // Pulled once, up front, so the preview can say how many rows are already in
  // the database BEFORE anything is written. Paged because PostgREST caps a
  // response and a silent 1,000-row ceiling would report every list as
  // duplicate-free.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const keys = new Set();
      const PAGE = 1000;
      const MAX_PAGES = 25;
      let capped = false;

      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error } = await supabase
          .from('leads')
          .select('phone, phone_mobile')
          .range(page * PAGE, page * PAGE + PAGE - 1);

        if (error) { setImportErr(error.message); break; }
        for (const l of data ?? []) {
          const a = phoneKey(l.phone);
          const b = phoneKey(l.phone_mobile);
          if (a) keys.add(a);
          if (b) keys.add(b);
        }
        if ((data?.length ?? 0) < PAGE) break;
        if (page === MAX_PAGES - 1) capped = true;
      }

      if (cancelled) return;
      setExistingKeys(keys);
      setExistingCapped(capped);
    })();

    return () => { cancelled = true; };
  }, [keysNonce]);

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
        setMapping(guessMapping(result.headers));
      } catch (e) {
        setParsed(null);
        setParseErr(e.message || 'Could not read that file as a CSV.');
      }
    };
    // Read as UTF-8. A list exported as Windows-1252 will show mojibake in the
    // preview, which is visible before the import rather than after it — the
    // reason the preview shows values rather than a row count.
    reader.readAsText(file, 'utf-8');
  }, []);

  // ── analysis ──────────────────────────────────────────────────────────────
  // Every row classified before anything is written, because "how many of these
  // are already in the system" is a question that has to be answerable while
  // there is still time to change the mapping.
  const analysis = useMemo(() => {
    if (!parsed) return null;

    const seenInFile = new Set();
    const importable = [];
    const skipped = [];

    parsed.rows.forEach((row, index) => {
      const lead = buildLead(row, mapping, parsed.headers);
      const key = phoneKey(lead.phone) || phoneKey(lead.phone_mobile);
      const hasContact = Boolean(lead.phone || lead.phone_mobile || lead.email);

      let reason = null;
      if (!hasContact) reason = 'no_contact';
      else if (key && seenInFile.has(key)) reason = 'dup_file';
      else if (key && existingKeys?.has(key)) reason = 'dup_existing';

      if (key) seenInFile.add(key);
      if (reason) skipped.push({ index, lead, reason, row });
      else importable.push(lead);
    });

    return {
      importable,
      skipped,
      counts: {
        no_contact: skipped.filter((s) => s.reason === 'no_contact').length,
        dup_file: skipped.filter((s) => s.reason === 'dup_file').length,
        dup_existing: skipped.filter((s) => s.reason === 'dup_existing').length,
      },
    };
  }, [parsed, mapping, existingKeys]);

  const mappedKeys = useMemo(() => new Set(mapping.filter(Boolean)), [mapping]);
  const hasContactColumn = ['phone', 'phone_mobile', 'email'].some((k) => mappedKeys.has(k));

  function setColumn(index, key) {
    setMapping((prev) => {
      const next = [...prev];
      // One lead column per file column. Picking a target that is already in
      // use moves it, rather than writing two values into one field and letting
      // whichever comes last win invisibly.
      if (key) next.forEach((v, i) => { if (v === key && i !== index) next[i] = ''; });
      next[index] = key;
      return next;
    });
  }

  // ── the import ────────────────────────────────────────────────────────────
  async function runImport() {
    if (!analysis || analysis.importable.length === 0) return;
    setBusy(true);
    setImportErr(null);
    setProgress(0);

    const rows = analysis.importable;
    const BATCH = 200;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await supabase.from('leads').insert(chunk);

      if (error) {
        // Stop rather than skipping ahead. Everything already inserted stays,
        // and re-running the same file is safe: the dedupe reloads from the
        // database, so the rows that landed are skipped as duplicates on the
        // second pass. Ploughing on would hide a mapping mistake behind a
        // success count.
        setImportErr(
          `Stopped after ${inserted} leads — ${error.message}. ` +
            'Nothing already imported was lost; fix the mapping and run the same file again, ' +
            'and the rows that landed will be skipped as duplicates.',
        );
        setBusy(false);
        // Reload the dedupe set: some of these rows are now in the database, so
        // the counts on screen are stale the moment the first batch landed.
        setExistingKeys(null);
        setKeysNonce((n) => n + 1);
        return;
      }

      inserted += chunk.length;
      setProgress(Math.round((inserted / rows.length) * 100));
    }

    setBusy(false);
    setDone({ inserted, skipped: analysis.skipped.length });
  }

  function reset() {
    setParsed(null);
    setMapping([]);
    setFileName('');
    setDone(null);
    setImportErr(null);
    setAcknowledged(false);
    setExistingKeys(null);
    setKeysNonce((n) => n + 1);
    if (fileInput.current) fileInput.current.value = '';
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <>
      <header>
        <h1>Import a list</h1>
        {parsed && <span className="count">{fileName} · {parsed.rows.length} rows</span>}
      </header>

      <div className="imp-warn">
        <h2>Everything imported here is a cold lead. Do not call it yet.</h2>
        <p>
          Nobody on a purchased or inherited list agreed to hear from Tossie, so every row
          lands with <code>tcpa_opt_in = false</code>, <code>source = cold_list</code> and
          a cold temperature. There is no option on this page to change that.
        </p>
        <p>
          These leads stay out of the dialer until they have been <strong>skip-traced</strong> and
          <strong> DNC-scrubbed</strong> — that is <code>lead_is_dialable()</code> in the database,
          not a setting. Calling an unscrubbed list costs $500–$1,500 per contact, and the
          litigator scrub is the part that matters most: serial TCPA plaintiffs seed their
          numbers onto exactly the absentee and pre-foreclosure lists this page is for.
        </p>
      </div>

      {importErr && <div className="err">{importErr}</div>}
      {parseErr && <div className="err">{parseErr}</div>}

      {done ? (
        <div className="card">
          <h2>Imported</h2>
          <div className="body">
            <div className="imp-tally">
              <div className="imp-tile good"><b>{done.inserted}</b><span>leads imported</span></div>
              <div className="imp-tile"><b>{done.skipped}</b><span>rows skipped</span></div>
            </div>
            <p className="imp-note">
              They are on the board in the first stage, cold, and not dialable. Skip trace and
              scrub them before anyone picks up a phone.
            </p>
            <div className="imp-actions">
              <button className="btn" type="button" onClick={() => navigate('/leads')}>See the leads</button>
              <button className="btn ghost" type="button" onClick={reset}>Import another file</button>
            </div>
          </div>
        </div>
      ) : !parsed ? (
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
      ) : (
        <>
          <div className="imp-steps">
            <span><b>1.</b> File read</span>
            <span><b>2.</b> Map the columns</span>
            <span><b>3.</b> Check the preview</span>
            <span><b>4.</b> Import</span>
          </div>

          <div className="card">
            <h2>Map the columns</h2>
            <div className="body">
              <p className="imp-note" style={{ marginTop: 0 }}>
                Anything left unmapped is still kept, in the lead&rsquo;s raw payload — so an odd
                column is recoverable later without re-importing the file.
              </p>
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
                          {GROUPS.map((g) => (
                            <optgroup key={g} label={g}>
                              {LEAD_FIELDS.filter((f) => f.group === g).map((f) => (
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

          <div className="card">
            <h2>What will be imported</h2>
            <div className="body">
              {existingKeys === null ? (
                <p className="imp-note">Checking these against the leads already in the system…</p>
              ) : (
                <>
                  <div className="imp-tally">
                    <div className="imp-tile good">
                      <b>{analysis.importable.length}</b><span>will be imported</span>
                    </div>
                    <div className="imp-tile warn">
                      <b>{analysis.skipped.length}</b><span>will be skipped</span>
                    </div>
                    <div className="imp-tile">
                      <b>{analysis.counts.dup_existing + analysis.counts.dup_file}</b>
                      <span>duplicates</span>
                    </div>
                  </div>

                  {analysis.skipped.length > 0 && (
                    <ul className="imp-reasons">
                      {analysis.counts.no_contact > 0 && (
                        <li>
                          <b>{analysis.counts.no_contact}</b>
                          <span>
                            no phone and no email. A lead has to be reachable somehow — the
                            database refuses these outright.
                          </span>
                        </li>
                      )}
                      {analysis.counts.dup_existing > 0 && (
                        <li>
                          <b>{analysis.counts.dup_existing}</b>
                          <span>already in the system on the same phone number.</span>
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

                  {!hasContactColumn && (
                    <div className="err" style={{ marginTop: 14 }}>
                      No column is mapped to a phone or an email, so every row will be skipped.
                      Map one above.
                    </div>
                  )}

                  {existingCapped && (
                    <p className="imp-note" style={{ marginTop: 12 }}>
                      Duplicate checking read the 25,000 most recent leads. Beyond that a
                      duplicate may still slip through — the phone number is what to search on
                      afterwards.
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
                        {LEAD_FIELDS.filter((f) => mappedKeys.has(f.key)).map((f) => (
                          <th key={f.key}>{f.label}</th>
                        ))}
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.slice(0, 8).map((row, i) => {
                        const lead = buildLead(row, mapping, parsed.headers);
                        const skip = analysis?.skipped.find((s) => s.index === i);
                        return (
                          <tr key={i} className={skip ? 'imp-skipped' : ''}>
                            <td>{i + 1}</td>
                            {LEAD_FIELDS.filter((f) => mappedKeys.has(f.key)).map((f) => {
                              const v = lead[f.key];
                              return (
                                <td key={f.key} className={v === undefined ? 'imp-null' : ''}>
                                  {v === undefined ? '—' : String(v)}
                                </td>
                              );
                            })}
                            <td>
                              {!skip ? (
                                <span className="badge cold">Cold lead</span>
                              ) : skip.reason === 'no_contact' ? (
                                <span className="badge stop">No contact</span>
                              ) : (
                                <span className="badge">Duplicate</span>
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
            <span>
              <strong>I understand these leads are not contactable yet.</strong>
              <small>
                They import cold, with no consent recorded, and stay out of the dialer until they
                have been skip-traced and DNC-scrubbed.
              </small>
            </span>
          </label>

          <div className="imp-actions">
            <button
              className="btn"
              type="button"
              disabled={busy || !acknowledged || !analysis || analysis.importable.length === 0 || existingKeys === null}
              onClick={runImport}
            >
              {busy
                ? `Importing… ${progress}%`
                : `Import ${analysis?.importable.length ?? 0} leads as cold`}
            </button>
            <button className="btn ghost" type="button" disabled={busy} onClick={reset}>
              Start over
            </button>
          </div>
        </>
      )}
    </>
  );
}
