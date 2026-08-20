import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import DeleteButton from '../components/DeleteButton.jsx';
import PropertyLinks from '../components/PropertyLinks.jsx';
import { callingWindow } from '../lib/calling-window.js';
import { dateOnly, formatPhone, fullDate, timeAgo, titleize } from '../lib/format.js';
import {
  CALL_STATUSES, DISTRESS_FLAGS, callBlock, callStatusLabel, phoneKey,
} from './ProspectsPage.jsx';
import './prospects.css';

/**
 * One prospect: a house, an owner, whatever a vendor claimed about them, and
 * the one action that turns them into a person we are allowed to keep talking
 * to.
 *
 * The page is built around the conversion because that is the only thing on it
 * that changes what the business may legally do. Everything above and below is
 * in service of it: the property and distress data is what you open the call
 * with, the numbers split by line type are how you reach them, and the outcome
 * bar is how the attempt gets recorded — but the conversion is the door between
 * a bought row and a seller with a consent record, and it only opens after a
 * human has spoken to them.
 *
 * Two things that are absent on purpose and should stay absent:
 *
 *   - Nothing here texts. There is no prospect_is_textable(), no send path that
 *     takes a prospect id, and no consent column on the table for one to check.
 *   - Nothing here converts in bulk, because this page is the only place
 *     conversion happens and it holds exactly one prospect.
 *
 * Comment style note: `raw_data` is rendered verbatim rather than parsed into
 * fields. It is whatever the vendor sent, it differs per vendor, and a page that
 * pretends to understand it would be inventing meaning for somebody else's
 * columns.
 */

/**
 * How consent was obtained, in the operator's words.
 *
 * Deliberately not the same list LeadDetail offers. That page includes
 * "Replied to our text", which cannot have happened here — a prospect has never
 * been texted, so offering it would be offering a lie as a preset. What is left
 * is the four ways a cold call actually produces consent, plus free text
 * underneath for the conversation that fits none of them.
 */
const CONSENT_SOURCES = [
  'Cold call — they agreed on the phone',
  'Cold call — they asked us to follow up',
  'They called us back',
  'In person at the property',
  'Signed agreement',
];

/**
 * The outcome ladder, in roughly the order a cold day produces them.
 *
 * These write call_status directly rather than going through log_disposition():
 * that function takes a lead, writes lead_activity and moves a pipeline stage,
 * and a prospect has none of those. What a prospect has is a call_status column
 * with a CHECK constraint, and these are its values.
 *
 * 'hot_lead' and 'appointment_set' are the two that mean a real conversation
 * happened, which is exactly when the conversion panel above becomes the next
 * thing to do — so they read green and nothing else does.
 */
const OUTCOMES = [
  { key: 'no_answer',       label: 'No answer' },
  { key: 'left_voicemail',  label: 'Left voicemail' },
  { key: 'called',          label: 'Reached them' },
  { key: 'callback',        label: 'Callback booked' },
  { key: 'appointment_set', label: 'Appointment set', tone: 'good' },
  { key: 'hot_lead',        label: 'Hot', tone: 'good' },
  { key: 'not_interested',  label: 'Not interested', tone: 'bad' },
  { key: 'wrong_number',    label: 'Wrong number', tone: 'bad' },
];

const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString()}`);

/**
 * A timestamptz as the operator's own calendar date.
 *
 * Not dateOnly(), which exists for `date` columns and reads the leading
 * YYYY-MM-DD straight off the string. skip_traced_at and dnc_scrubbed_at are
 * timestamps, so a scrub recorded at 01:30 UTC would render as the next day
 * anywhere west of Greenwich — including every zone Tossie calls into. A
 * compliance date that is off by one is the kind of wrong nobody notices until
 * it is being read back to them.
 */
const tsDate = (iso) =>
  (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

/**
 * A scrub result, which has three states and not two.
 *
 * `is_dnc = false` on an unscrubbed row is a default, not an answer, and
 * rendering it as "No" is how a list gets dialed on the strength of a column
 * nobody has filled in. Unknown says unknown.
 */
function ScrubAnswer({ scrubbed, hit }) {
  if (hit) return <span className="badge stop">Yes</span>;
  return scrubbed ? <span className="badge ok">No</span> : <span className="pr-dim">Unknown</span>;
}

export default function ProspectDetail({ id }) {
  const [p, setP] = useState(null);
  const [optOuts, setOptOuts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  /**
   * The calling window has to close at 9pm, not when somebody happens to
   * reload. A minute is fine: the cost of being one minute late is the same
   * `tel:` link an operator could dial off their own phone anyway, and the cost
   * of a tighter timer is a re-render every second on a page nobody is watching.
   */
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    // `callable:prospect_is_callable` is the rule read off the row, the same as
    // the list page and the same as LeadDetail reads lead_is_dialable. The list
    // comes back embedded because its name is what convert_prospect_to_lead()
    // writes onto the lead as source_detail, and the operator should see the
    // words before they press the button that copies them.
    const { data, error } = await supabase
      .from('prospects')
      .select(`*, callable:prospect_is_callable,
        list:prospect_lists(id, name, source_vendor, status),
        lead:leads(id, name, status, address, city, state)`)
      .eq('id', id)
      .single();

    if (error) { setErr(error.message); setLoading(false); return; }

    // Opt-outs are keyed by number, not by prospect, so this cannot be part of
    // the read above — there is nothing to ask for until the row says which
    // numbers to ask about. prospect_is_callable() already consulted them
    // server-side; this second read exists only so the page can name WHICH
    // number is suppressed, which is the difference between "cannot call" and
    // "cannot call the mobile, the landline is fine".
    const keys = [...new Set(
      [data?.phone_mobile, data?.phone_landline, data?.phone_voip].map(phoneKey).filter(Boolean),
    )];
    const o = keys.length
      ? await supabase.from('telephony_opt_outs').select('*').in('phone_key', keys)
      : { data: [] };

    setP(data ?? null);
    setOptOuts(o.data ?? []);
    setErr(o.error ? `Could not read the opt-out list (${o.error.message}). The dialable answer below still comes from the database.` : null);
    setLoading(false);
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const block = useMemo(() => (p ? callBlock(p, optOuts) : null), [p, optOuts]);

  if (loading) return <div className="empty">Loading prospect…</div>;
  if (!p) {
    return (
      <div className="empty">
        <strong>{err || 'No such prospect'}</strong>
        <a href="/app/prospects">Back to prospects</a>
      </div>
    );
  }

  const tags = DISTRESS_FLAGS.filter((f) => p[f.key]);

  return (
    <>
      <div className="pr-head">
        <h1>{p.address || p.owner_name || 'Untitled prospect'}</h1>
        <span className="pr-sub">
          {[[p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(' ')}
          {p.list?.name && ` · ${p.list.name}`}
          {p.list?.source_vendor && ` · ${p.list.source_vendor}`}
        </span>
        <span className="pr-sub"><a href="/app/prospects">All prospects</a></span>
        <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
          <DeleteButton
            table="prospects"
            id={p.id}
            name={p.address || p.owner_name}
            onDeleted={() => navigate('/prospects')}
          />
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      {p.converted_at && <AlreadyConverted p={p} />}
      {/* Both, when the prospect was converted and the lead has since been
          deleted: converted_lead_id was NULLed by the FK, converted_at was not,
          and the migration deliberately allows a second conversion in exactly
          that case. Offering the panel again is what makes that reachable —
          otherwise the row is permanently stranded, marked converted with
          nothing to show for it. The RPC is idempotent, so on the ordinary
          converted row (where the lead is still there) this stays hidden and
          would only have returned the same lead anyway. */}
      {(!p.converted_at || !p.lead) && <ConvertPanel p={p} onDone={load} />}

      <div className="detail">
        <div>
          <CallCard p={p} block={block} optOuts={optOuts} tick={tick} onDone={load} />
          <CallLog p={p} onDone={load} />

          <div className="card">
            <h2>Property</h2>
            <div className="body">
              <dl className="facts">
                <dt>Address</dt>
                <dd>{p.address || '—'}</dd>
                <dt>City / state</dt>
                <dd>{[[p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(' ') || '—'}</dd>
                <dt>County</dt>
                <dd>{p.county || '—'}</dd>
                <dt>Type</dt>
                <dd>{p.property_type ? titleize(p.property_type) : '—'}</dd>
                <dt>Year built</dt>
                <dd>{p.year_built || '—'}</dd>
                <dt>Assessed</dt>
                <dd>{money(p.assessed_value)}</dd>
                <dt>Estimated</dt>
                <dd>{money(p.estimated_value)}</dd>
                <dt>Mortgage</dt>
                <dd>{money(p.mortgage_balance)}</dd>
                {/* Equity and years owned are the two numbers that predict
                    whether a cold call goes anywhere: nobody sells at a
                    discount out of equity they do not have. */}
                <dt>Equity</dt>
                <dd>{p.equity_pct != null ? `${p.equity_pct}%` : '—'}</dd>
                <dt>Owned</dt>
                <dd>{p.years_owned != null ? `${p.years_owned} years` : '—'}</dd>
                <dt>Last sale</dt>
                <dd>
                  {p.last_sale_date || p.last_sale_price
                    ? [p.last_sale_date && dateOnly(p.last_sale_date), p.last_sale_price && money(p.last_sale_price)]
                      .filter(Boolean).join(' · ')
                    : '—'}
                </dd>
              </dl>

              {/* The same six links the lead page carries, and for the same
                  reason: the first thing anyone does with a cold address is
                  look at the street, then the comps, then what the county says
                  it is. Doing that by hand is five tab-opens and five
                  retypings of the address, and the retyping is where the wrong
                  house comes from. PropertyLinks was written to take a row
                  rather than four props precisely so a prospect works
                  unchanged — prospects carry the same address/city/state/zip/
                  county column names as leads. It simply had never been
                  mounted here. */}
              <PropertyLinks place={p} />
            </div>
          </div>

          <div className="card">
            <h2>Owner</h2>
            <div className="body">
              <dl className="facts">
                <dt>Name</dt>
                <dd>{p.owner_name || '—'}</dd>
                <dt>Owner type</dt>
                <dd>{p.owner_type ? titleize(p.owner_type) : '—'}</dd>
                <dt>Occupied by</dt>
                <dd>{p.owner_occupied == null ? '—' : p.owner_occupied ? 'The owner' : 'Not the owner'}</dd>
                {/* The mailing address is the whole reason absentee lists work,
                    and it is also the address that decides what time it is where
                    the phone rings when the area code does not resolve. */}
                <dt>Mailing</dt>
                <dd>
                  {[p.mailing_address, [p.mailing_city, p.mailing_state].filter(Boolean).join(', '), p.mailing_zip]
                    .filter(Boolean).join(' · ') || '—'}
                </dd>
              </dl>

              <div className="pr-tags" style={{ marginTop: 14 }}>
                {tags.length === 0
                  ? <span className="fine">No distress flags on this row.</span>
                  : tags.map((t) => (
                    <span key={t.key} className={`pr-tag${t.urgent ? ' urgent' : ''}`}>{t.label}</span>
                  ))}
              </div>
            </div>
          </div>

          {Object.keys(p.raw_data || {}).length > 0 && (
            <div className="card">
              <h2>What the vendor sent</h2>
              <div className="body">
                <p className="fine" style={{ marginTop: 0 }}>
                  Every column of the source row, unparsed. It is kept because a list is also
                  evidence of what was bought, and because the fields a vendor invents this quarter
                  are the ones no importer knew to map.
                </p>
                <pre className="pr-raw">{JSON.stringify(p.raw_data, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>

        <div>
          <SkipTraceCard p={p} optOuts={optOuts} />
          <ScrubCard p={p} />

          <div className="card">
            <h2>Provenance</h2>
            <div className="body">
              <dl className="facts">
                <dt>List</dt>
                <dd>{p.list?.name || '—'}</dd>
                <dt>Vendor</dt>
                <dd>{p.list?.source_vendor || '—'}</dd>
                <dt>Vendor id</dt>
                <dd>{p.vendor_id || '—'}</dd>
                <dt>Imported</dt>
                <dd>{fullDate(p.created_at)}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── the conversion ──────────────────────────────────────────────────────── */

/**
 * The primary action, and the only door between the two tables.
 *
 * It sits at the top of the page rather than at the bottom of a sidebar because
 * it is what the operator came here to do once the call goes well, and because
 * what it writes is a consent record — the document that answers "who said we
 * could contact them" if that is ever asked. The warning is above the fields
 * rather than under the button for the same reason LeadDetail's is: somebody
 * about to assert something on Tossie's behalf should know it is an assertion
 * while they are deciding, not after.
 *
 * convert_prospect_to_lead() refuses an empty source, so the button stays
 * disabled until there is one. That is not this page being strict — it is the
 * database being the place the rule lives, and the form agreeing with it early
 * enough to be useful.
 *
 * It is deliberately offered even when the prospect is not currently dialable.
 * A litigator hit or a DNC flag travels across to the lead, where
 * lead_is_dialable() goes on refusing — but the conversation that produced the
 * consent already happened, and refusing to record it would lose the more
 * valuable of the two facts. The panel says as much when that is the case.
 */
function ConvertPanel({ p, onDone }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const resolved = (source === '__other' ? other : source).trim();
  // Mirrors the guard inside the RPC, which mirrors leads_has_contact. Better
  // to say which field is missing than to hand an operator who just got off the
  // phone a constraint name.
  const reachable = Boolean(p.phone_mobile || p.phone_landline || p.phone_voip || p.email_primary);

  function reset() {
    setOpen(false);
    setSource('');
    setOther('');
    setNote('');
    setErr(null);
  }

  async function run() {
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.rpc('convert_prospect_to_lead', {
      p_prospect_id: p.id,
      p_consent_source: resolved,
      p_consent_note: note.trim() || null,
    });
    if (error) {
      setBusy(false);
      setErr(error.message);
      return;
    }
    // RETURNS public.leads — a composite, which PostgREST hands back as an
    // object. Unwrapped defensively because a future RETURNS SETOF would arrive
    // as an array and silently navigate to /leads/undefined.
    const lead = Array.isArray(data) ? data[0] : data;
    if (lead?.id) { navigate(`/leads/${lead.id}`); return; }
    // The conversion succeeded — the prospect is marked and the lead exists —
    // so this is a navigation failure, not a write failure, and saying "it
    // failed" would invite a second conversion attempt.
    setBusy(false);
    reset();
    onDone?.();
  }

  if (!open) {
    return (
      <div className="card pr-convert">
        <h2>Convert to a lead</h2>
        <div className="body">
          <p style={{ marginTop: 0, fontSize: '0.9rem' }}>
            A prospect becomes a lead when a human has spoken to them and they have agreed to hear
            from us. That is the only way it happens — there is no bulk convert, because what gets
            written is a consent record and a consent record needs somebody who can say where it
            came from.
          </p>
          <div className="confirmbtns">
            <button className="btn" onClick={() => setOpen(true)} disabled={!reachable}>
              I spoke to them — convert…
            </button>
          </div>
          {!reachable && (
            <p className="fine" style={{ marginTop: 11 }}>
              This row has no phone number and no email, so there is nothing to carry across and the
              RPC will refuse it. Skip trace it first.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card pr-convert">
      <h2>Convert to a lead</h2>
      <div className="body">
        <div className="pr-legal">
          <strong>This creates a legal consent record.</strong> It is written with your name,
          timestamped to this moment, and shown in the new lead&rsquo;s timeline. It is the document
          that answers &ldquo;who said we could contact them&rdquo; if a regulator or a plaintiff&rsquo;s
          attorney ever asks, and TCPA damages run $500&ndash;$1,500 per contact. Record it only if
          this person actually agreed, on a call you actually had.
        </div>

        <label className="pr-field">
          How was consent obtained? Required — the database refuses an empty source.
          <select value={source} onChange={(e) => setSource(e.target.value)} autoFocus>
            <option value="">Choose…</option>
            {CONSENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="__other">Something else — type it</option>
          </select>
        </label>

        {source === '__other' && (
          <label className="pr-field">
            In your own words
            <input
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="said to call him back Thursday about the Bull Street house"
              autoComplete="off"
            />
          </label>
        )}

        <label className="pr-field">
          Anything worth keeping with it? Optional.
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="wants to be out before school starts"
            autoComplete="off"
          />
        </label>

        <p className="fine">
          The lead arrives as <strong>contacted</strong>, sourced <strong>cold_list</strong> from{' '}
          <strong>{p.list?.name || 'this list'}</strong>, carrying the property, owner, distress and
          skip-trace data on this page. The prospect row stays where it is, marked converted — the
          list is the record of what was bought and how it performed.
        </p>

        {(p.is_dnc || p.is_litigator) && (
          <div className="banner stop">
            <strong>
              {p.is_litigator ? 'This number belongs to a known TCPA litigator.' : 'This person is on the do-not-call list.'}
            </strong>
            The flag travels with them, so the lead will exist and still refuse to be called or
            texted. Convert only if the conversation genuinely happened and you want the record of
            it; do not convert to get around the block, because it does not.
          </div>
        )}

        {err && <div className="err" style={{ marginTop: 13 }}>{err}</div>}

        <div className="confirmbtns" style={{ marginTop: 15 }}>
          <button className="btn" onClick={run} disabled={!resolved || busy}>
            {busy ? 'Converting…' : 'Convert and record consent in my name'}
          </button>
          <button className="btn ghost" onClick={reset} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Already converted.
 *
 * The row is kept rather than deleted, so this page stays reachable forever —
 * and the useful thing it can say from here on is "the work moved, here is
 * where". Everything below it stays visible because the vendor data is still
 * the vendor data, and six months later somebody asking "where did this seller
 * come from" is asking about this row.
 */
function AlreadyConverted({ p }) {
  return (
    <div className="pr-converted">
      <strong>Converted {timeAgo(p.converted_at)} — this is a lead now.</strong>
      {p.lead?.id ? (
        <>
          Work them at <a href={`/app/leads/${p.lead.id}`}>{p.lead.name || p.lead.address || 'the lead'}</a>
          {p.lead.status && ` (${titleize(p.lead.status)})`}. Calling, texting and the SDR all live
          there — a prospect row has no consent basis of its own and never gains one.
        </>
      ) : (
        <>
          The lead it became has since been deleted. Converting again is allowed and creates a fresh
          lead with a fresh consent record — this row&rsquo;s, from the conversation you are having
          now, not the one that produced the deleted lead.
        </>
      )}
    </div>
  );
}

/* ── calling ─────────────────────────────────────────────────────────────── */

/**
 * The numbers, one per line type, each with its own answer.
 *
 * Split rather than reduced to a single "phone" because which one you dial is a
 * decision. A mobile is a person; a landline is a house that may be empty,
 * which on a vacant-property list is most of them; a VoIP number is the one a
 * skip trace is likeliest to have got wrong and the one a litigator is likeliest
 * to have seeded.
 *
 * The calling window is computed per number rather than once for the row,
 * because the three numbers can carry three area codes — an out-of-state owner
 * with a Georgia landline at the property is the ordinary case on this data, and
 * a single window for the row would be the wrong answer for two of them.
 *
 * `tel:` hands the call to the operating system, exactly as the lead page and
 * the dialer do. That means this window check is advisory-only in the sense
 * that an operator can dial from their own phone anyway — and load-bearing in
 * the sense that it is the only check there is until the voice function lands.
 * Prefer over-blocking.
 */
function CallCard({ p, block, optOuts, tick, onDone }) {
  const [editing, setEditing] = useState(null);
  const lines = [
    { kind: 'Mobile', key: 'mobile', number: p.phone_mobile },
    { kind: 'Landline', key: 'landline', number: p.phone_landline },
    { kind: 'VoIP', key: 'voip', number: p.phone_voip },
  ];
  const onFile = lines.filter((l) => l.number);
  const firstFree = lines.find((l) => !l.number)?.key ?? 'mobile';

  return (
    <div className="card">
      <h2>Call</h2>
      <div className="body">
        {onFile.length === 0 ? (
          <div className="empty" style={{ padding: '22px 10px' }}>
            <strong>{p.skip_traced ? 'Skip traced, no number found' : 'No number on this row yet'}</strong>
            {p.skip_traced
              ? 'The trace ran and came back empty. Converting would fail too — the RPC refuses a prospect with neither a phone nor an email. If you get a number another way, add it below.'
              : 'A purchased list carries an address and a name, not a phone number. A skip trace is how the whole list gets numbers at once — but if you already have this one, type it in.'}
          </div>
        ) : (
          <div className="pr-nums">
            {onFile.map((l) => (
              <NumberRow
                key={l.kind}
                p={p}
                line={l}
                block={block}
                optOuts={optOuts}
                tick={tick}
                onEdit={() => setEditing(l.key)}
              />
            ))}
          </div>
        )}

        {editing
          ? <PhoneEditor p={p} kind={editing} onDone={onDone} onClose={() => setEditing(null)} />
          : (
            <button className="btn ghost pr-addnum" onClick={() => setEditing(firstFree)}>
              {onFile.length === 0 ? 'Add a number' : 'Add or edit a number'}
            </button>
          )}

        {block && onFile.length > 0 && (
          <div className="notice" style={{ marginTop: 13 }}>
            <strong>Not dialable: {block}.</strong>
            prospect_is_callable() refuses this row, and it is the same function the queue reads.
            {p.phone_from_owner
              ? ' The owner gave us this number, so no scrub is required — something else on the row is the veto.'
              : ' A scrub, or a number the owner gave us themselves, are the two things that change it.'}
          </div>
        )}

        <p className="fine" style={{ marginTop: 13, marginBottom: 0 }}>
          These numbers are for <strong>calling only</strong>. Nothing in the product can text a
          prospect: there is no send path that accepts one, and the A2P campaign these messages would
          go out under is registered for appointment reminders. Texting begins after conversion.
        </p>

        {!p.converted_at && <OutcomeBar p={p} onDone={onDone} />}
      </div>
    </div>
  );
}

function NumberRow({ p, line, block, optOuts, tick, onEdit }) {
  // The number about to be dialed, not the row's best number: callingWindow()
  // resolves the zone from the area code it is handed, and handing it the
  // mobile while the operator dials the landline would answer a question nobody
  // asked. Mailing state first, property state second — the owner answering the
  // phone is the one the window is about, and on an absentee list they are not
  // where the house is.
  const win = callingWindow(
    { phone_mobile: line.number, mailing_state: p.mailing_state, state: p.state },
    new Date(tick),
  );
  const suppressed = optOuts.find((o) => o.phone_key === phoneKey(line.number)) || null;
  const dialable = block === null && win.allowed && !suppressed;

  return (
    <div className={`pr-num${suppressed ? ' blocked' : ''}`}>
      <span className="pr-kind">{line.kind}</span>
      <span className="pr-e164">{formatPhone(line.number)}</span>
      <span className="pr-when">
        {/* opted_out_at, not created_at — telephony_opt_outs has no created_at
            and the undefined read silently rendered "Opted out" with no date at
            all, which is the one label on this row that has to carry one. */}
        {suppressed
          ? `Opted out ${timeAgo(suppressed.opted_out_at)}`
          : win.localTime
            ? `${win.localTime} there${win.guessed ? ' (zone is a guess)' : ''}`
            : 'time zone unknown'}
      </span>
      <span className="pr-spacer" />
      {dialable ? (
        /* Nothing is written when this is clicked. The attempt is counted by the
           outcome bar when the operator says what happened, because the browser
           only knows a link was followed — not whether anyone picked up. */
        <a className="pr-callbtn" href={`tel:${line.number.replace(/[^\d+]/g, '')}`}>Call</a>
      ) : (
        <span className="pr-callbtn stopped" aria-disabled="true">
          {suppressed ? 'Opted out' : block ? 'Blocked' : win.reason === 'unknown_timezone' ? 'Unknown zone' : 'Outside hours'}
        </span>
      )}
      {onEdit && <button className="linkbtn pr-editnum" onClick={onEdit}>edit</button>}
    </div>
  );
}

/**
 * A number typed in by hand, and the one question that has to come with it.
 *
 * Where the number came from is not paperwork, it is the whole difference
 * between a callback and a cold call. Someone who rang the sign in their own
 * front yard has made an inquiry; calling them back is not telemarketing and
 * waiting on a skip trace to reach them would be absurd. A number found on a
 * people-search site is the opposite — nobody has checked it against the DNC or
 * the litigator files, and those files are exactly where the expensive mistakes
 * live.
 *
 * So the source is required, it is stored on the row, and it decides which of
 * the two branches of prospect_is_callable this prospect takes. The consequence
 * is shown live under the picker rather than discovered afterwards, because an
 * operator choosing between "they called us" and "found online" should know
 * what each one does before they choose, not after.
 *
 * The list is deliberately short and written in the words somebody would
 * actually use. A free-text box would collect "phone" and "from Sarah", which
 * answer nothing a year later.
 */
const PHONE_SOURCES = [
  { group: 'They gave it to us', owner: true, options: [
    'They called us',
    'They called the sign or the ad',
    'They gave it to us at the property',
    'On a letter or agreement they sent',
  ] },
  { group: 'We went and found it', owner: false, options: [
    'Public record or county file',
    'Found online',
    'A neighbour or relative gave it',
    'Another list we already own',
  ] },
];

const LINE_KINDS = [
  { key: 'mobile', label: 'Mobile' },
  { key: 'landline', label: 'Landline' },
  { key: 'voip', label: 'VoIP' },
];

function sourceIsFromOwner(source) {
  return PHONE_SOURCES.some((g) => g.owner && g.options.includes(source));
}

function PhoneEditor({ p, kind, onDone, onClose }) {
  const existing = { mobile: p.phone_mobile, landline: p.phone_landline, voip: p.phone_voip };
  const [line, setLine] = useState(kind);
  const [number, setNumber] = useState(existing[kind] ?? '');
  const [source, setSource] = useState(p.phone_source ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Switching line re-seeds the number so the field always shows what is
  // actually on that line — otherwise picking "Landline" while the mobile is
  // in the box would overwrite the landline with the mobile's digits.
  function pickLine(next) {
    setLine(next);
    setNumber(existing[next] ?? '');
  }

  const digits = number.replace(/\D/g, '').length;
  const fromOwner = sourceIsFromOwner(source);
  const canSave = digits >= 10 && digits <= 15 && source !== '';

  async function save() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('set_prospect_phone', {
      p_prospect_id: p.id,
      p_kind: line,
      p_number: number,
      p_source: source,
      p_from_owner: fromOwner,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onDone();
    onClose();
  }

  async function clear() {
    if (!window.confirm(`Remove the ${line} number from this prospect?`)) return;
    setBusy(true);
    setErr(null);
    // Null clears the line. The RPC drops the provenance too once nothing
    // hand-entered is left, so the row cannot go on claiming an owner gave us
    // a number it no longer has.
    const { error } = await supabase.rpc('set_prospect_phone', {
      p_prospect_id: p.id, p_kind: line, p_number: null, p_source: null, p_from_owner: false,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onDone();
    onClose();
  }

  return (
    <div className="pr-phoneform">
      {err && <div className="err">{err}</div>}

      <div className="pr-phonerow">
        <select value={line} disabled={busy} onChange={(e) => pickLine(e.target.value)}>
          {LINE_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}{existing[k.key] ? ' · has one' : ''}
            </option>
          ))}
        </select>
        <input
          className="pr-phoneinput"
          value={number}
          disabled={busy}
          inputMode="tel"
          placeholder="(912) 555-0134"
          onChange={(e) => setNumber(e.target.value)}
        />
      </div>

      <label className="pr-phonelabel">
        Where did this number come from?
        <select value={source} disabled={busy} onChange={(e) => setSource(e.target.value)}>
          <option value="">Choose one…</option>
          {PHONE_SOURCES.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      {source !== '' && (
        <p className={`pr-consequence${fromOwner ? ' ok' : ''}`}>
          {fromOwner ? (
            <>
              <strong>Callable straight away.</strong> They reached out, so this is a callback and
              not cold outreach — no skip trace needed. A DNC hit, a litigator hit, or a recorded
              &ldquo;stop calling me&rdquo; still block it.
            </>
          ) : (
            <>
              <strong>Still needs the DNC scrub.</strong> Nobody has checked this number against the
              do-not-call and litigator files, and serial TCPA plaintiffs seed their numbers onto
              lists like this one deliberately. It saves now and dials once the scrub runs.
            </>
          )}
        </p>
      )}

      <div className="pr-phoneactions">
        <button className="btn" disabled={!canSave || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save number'}
        </button>
        {existing[line] && (
          <button className="btn ghost danger" disabled={busy} onClick={clear}>Remove</button>
        )}
        <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        {number !== '' && digits < 10 && (
          <span className="fine">{digits} digits — a US number has ten.</span>
        )}
      </div>
    </div>
  );
}

/**
 * What happened, recorded in one tap.
 *
 * It writes call_status, bumps call_attempts and stamps last_called_at, then
 * refreshes the list counters so called_count stays true — that counter is
 * derived from call_attempts > 0 and nothing else maintains it.
 *
 * The attempt count is a read-modify-write, which would be a race if two people
 * were dialing the same prospect at the same instant. They are not: this is a
 * one-operator business and the row is open in front of the person tapping. The
 * honest fix is an RPC that increments in the database, and it belongs with the
 * power dialer, which is the thing that will actually place calls concurrently.
 */
function OutcomeBar({ p, onDone }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  async function log(key) {
    setBusy(key);
    setErr(null);
    const { error } = await supabase
      .from('prospects')
      .update({
        call_status: key,
        call_attempts: (p.call_attempts || 0) + 1,
        last_called_at: new Date().toISOString(),
      })
      .eq('id', p.id);

    if (error) { setBusy(null); setErr(error.message); return; }

    // Counter drift is worse than a slow tap: a scrub or called counter that
    // overstates is read as progress that did not happen. Reported rather than
    // swallowed, but not rolled back — the attempt is the more important fact.
    const { error: countErr } = await supabase.rpc('refresh_prospect_list_counts', {
      p_list_id: p.list_id,
    });
    setBusy(null);
    if (countErr) setErr(`Attempt recorded, but the list counters did not refresh (${countErr.message}).`);
    onDone?.();
  }

  return (
    <div style={{ marginTop: 15, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <p className="fine" style={{ marginTop: 0 }}>
        What happened? <code>tel:</code> hands the call to the operating system, so the browser never
        hears how it went — this is the only record there will be.
      </p>
      <div className="pr-outcomes">
        {OUTCOMES.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`pr-outcome${o.tone ? ` ${o.tone}` : ''}`}
            onClick={() => log(o.key)}
            disabled={busy !== null}
          >
            {busy === o.key ? 'Saving…' : o.label}
          </button>
        ))}
      </div>
      {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}
    </div>
  );
}

/**
 * The call history a prospect has, which is four columns and no timeline.
 *
 * Deliberately not a lead_activity feed: prospects have no activity table, and
 * giving them one would be building half a CRM around rows that have not
 * consented to be in one. What is here is what the schema holds — how many
 * times, when last, what came of it, and the operator's own notes, which travel
 * to the lead as its `notes` on conversion.
 */
function CallLog({ p, onDone }) {
  const [notes, setNotes] = useState(p.call_notes ?? '');
  const [callback, setCallback] = useState(toLocalInput(p.callback_at));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setNotes(p.call_notes ?? '');
    setCallback(toLocalInput(p.callback_at));
  }, [p.call_notes, p.callback_at]);

  const dirty = notes !== (p.call_notes ?? '') || callback !== toLocalInput(p.callback_at);

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    const { error } = await supabase
      .from('prospects')
      .update({
        call_notes: notes.trim() === '' ? null : notes,
        // datetime-local hands back a wall-clock string with no zone. new Date()
        // reads it in the browser's zone, which is the operator's, which is the
        // zone they typed it in — so this is the one conversion that is correct
        // by doing nothing clever.
        callback_at: callback ? new Date(callback).toISOString() : null,
      })
      .eq('id', p.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSaved(true);
    onDone?.();
  }

  return (
    <div className="card">
      <h2>Calls and notes</h2>
      <div className="body">
        <dl className="facts">
          <dt>Attempts</dt>
          <dd>{p.call_attempts || 0}</dd>
          <dt>Status</dt>
          <dd>
            {callStatusLabel(p.call_status)}
            {!CALL_STATUSES.some((s) => s.key === p.call_status) && ' (unrecognised)'}
          </dd>
          <dt>Last called</dt>
          <dd>{p.last_called_at ? `${fullDate(p.last_called_at)} · ${timeAgo(p.last_called_at)}` : 'never'}</dd>
        </dl>

        <label className="pr-field" style={{ marginTop: 15 }}>
          Callback
          <input
            type="datetime-local"
            value={callback}
            onChange={(e) => setCallback(e.target.value)}
          />
        </label>

        <label className="pr-field">
          Notes — these travel to the lead if this prospect converts
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {err && <div className="err" style={{ marginBottom: 11 }}>{err}</div>}

        <div className="confirmbtns">
          <button className="btn" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {saved && !dirty && <span className="fine">Saved.</span>}
        </div>
      </div>
    </div>
  );
}

/** An ISO timestamp as the local wall clock `datetime-local` expects. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── what the trace and the scrub found ──────────────────────────────────── */

function SkipTraceCard({ p, optOuts }) {
  const lines = [
    { kind: 'Mobile', number: p.phone_mobile },
    { kind: 'Landline', number: p.phone_landline },
    { kind: 'VoIP', number: p.phone_voip },
  ];

  return (
    <div className="card">
      <h2>Where the numbers came from</h2>
      <div className="body">
        {/* Hand-entered provenance sits above the trace, not inside it: a
            number an operator typed in did not come from a vendor, and filing
            it under "skip trace" would misattribute the one fact on this card
            that decides whether the row may be dialed without a scrub. */}
        {p.phone_source && (
          <div className={`pr-prov${p.phone_from_owner ? ' ok' : ''}`}>
            <span className="pr-kind">Added by hand</span>
            <strong>{p.phone_source}</strong>
            <span className="fine">
              {p.phone_source_at ? `${tsDate(p.phone_source_at)} · ${timeAgo(p.phone_source_at)}` : ''}
              {p.phone_from_owner
                ? ' — the owner gave it to us, so this row dials without a trace.'
                : ' — found rather than given, so it still waits on the scrub.'}
            </span>
          </div>
        )}

        {!p.skip_traced ? (
          <p className="fine" style={{ margin: p.phone_source ? '12px 0 0' : 0 }}>
            No skip trace has run. A bought list carries an address and a name; a trace is what adds
            numbers to the whole list at once.
          </p>
        ) : (
          <>
            <dl className="facts">
              <dt>Traced</dt>
              <dd>{p.skip_traced_at ? `${tsDate(p.skip_traced_at)} · ${timeAgo(p.skip_traced_at)}` : 'yes'}</dd>
              <dt>Provider</dt>
              <dd>{p.skip_trace_provider || '—'}</dd>
              {/* Confidence is the provider's own claim about its match, not a
                  claim about the person. Shown as a number and never used to
                  gate anything: a 40% match is still a real number to somebody. */}
              <dt>Confidence</dt>
              <dd>{p.skip_trace_confidence != null ? `${p.skip_trace_confidence}%` : '—'}</dd>
            </dl>

            <div className="pr-nums" style={{ marginTop: 13 }}>
              {lines.map((l) => {
                const off = l.number && optOuts.some((o) => o.phone_key === phoneKey(l.number));
                return (
                  <div key={l.kind} className={`pr-num${off ? ' blocked' : ''}`}>
                    <span className="pr-kind">{l.kind}</span>
                    <span className={l.number ? 'pr-e164' : 'pr-dim'}>
                      {l.number ? formatPhone(l.number) : 'none found'}
                    </span>
                    <span className="pr-spacer" />
                    {off && <span className="badge stop">Opted out</span>}
                  </div>
                );
              })}
            </div>

            <dl className="facts" style={{ marginTop: 13 }}>
              <dt>Email</dt>
              <dd>{p.email_primary || '—'}</dd>
              {p.email_secondary && (<><dt>Also</dt><dd>{p.email_secondary}</dd></>)}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The scrub, stated as two separate facts.
 *
 * "Scrubbed" and "clean" are different answers and collapsing them is how a
 * list gets dialed on the strength of a green tick that only meant the file was
 * checked. The litigator line is called out on its own because it is the
 * expensive one and because it is the one nobody thinks to look for.
 */
function ScrubCard({ p }) {
  return (
    <div className="card">
      <h2>DNC &amp; litigator scrub</h2>
      <div className="body">
        <dl className="facts">
          <dt>Scrubbed</dt>
          <dd>
            {p.dnc_scrubbed
              ? <span className="badge ok">Yes{p.dnc_scrubbed_at ? ` · ${tsDate(p.dnc_scrubbed_at)}` : ''}</span>
              : <span className="badge stop">Not yet</span>}
          </dd>
          <dt>On DNC</dt>
          <dd><ScrubAnswer scrubbed={p.dnc_scrubbed} hit={p.is_dnc} /></dd>
          <dt>Litigator</dt>
          <dd><ScrubAnswer scrubbed={p.dnc_scrubbed} hit={p.is_litigator} /></dd>
        </dl>

        {!p.dnc_scrubbed && (
          <p className="fine" style={{ marginBottom: 0 }}>
            Until the scrub runs, &ldquo;on DNC&rdquo; and &ldquo;litigator&rdquo; are unknown rather
            than no. Serial TCPA plaintiffs seed their numbers onto absentee and pre-foreclosure
            lists on purpose, and a call to one is worth $500&ndash;$1,500 to them.
          </p>
        )}
      </div>
    </div>
  );
}
