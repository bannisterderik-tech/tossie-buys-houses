import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import InlineField from '../components/InlineField.jsx';
import DeleteButton from '../components/DeleteButton.jsx';
import PhotoGallery from '../components/PhotoGallery.jsx';
import ContractPanel from '../components/ContractPanel.jsx';
import { navigate } from '../router.js';
import {
  DEAL_STATUSES, OCCUPANCY, dealStatusLabel,
  clockTone, countdownLabel, dateOnly, daysUntil,
  formatPhone, fullDate, timeAgo, titleize,
} from '../lib/format.js';

/**
 * One deal, from signed contract to collected fee.
 *
 * The lead detail is where an operator types what a seller said; this is where
 * they type what a contract says, and the difference matters: nearly every
 * field here is eventually read back off a piece of paper, so it is inline
 * edit-on-click for the same reason — one click per fact, saved on blur, no
 * form to open and no Save button to forget.
 *
 * Two things on this page are not free-form edits, and both for the same
 * reason. Status moves through a control that asks the database which moves are
 * legal, because deals_enforce_transition will refuse an illegal one and
 * deals_assigned_needs_buyer / deals_closed_needs_close_date will refuse a
 * legal one that arrives without its companion facts. And the three dates that
 * drive reminders are edited here but their milestones are not: the
 * deals_sync_milestones trigger creates, moves and deletes those, and a
 * hand-edited copy would be the one the worker did not read.
 */

const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString()}`);
const signedMoney = (v) =>
  v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(Number(v)).toLocaleString()}`;

/**
 * Inputs hand back strings; every money column here is an integer.
 *
 * Written out rather than `Number(...) || null` because that idiom turns a
 * typed zero into "not recorded", and zero is a real answer to more than one
 * field on this page: an assignment that collected nothing, a wholetail with no
 * fee, a waived EMD. The money view then excludes those deals from the average
 * fee instead of letting them drag it down, which reports a better number than
 * the one that happened.
 */
function toNumber(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const BUCKET = 'deal-documents';

const EXIT_STRATEGIES = ['assign', 'double_close', 'novation', 'wholetail'];
const EMD_STATUSES = ['not_due', 'due', 'sent', 'received', 'released', 'forfeited', 'waived'];
const REHAB_LEVELS = ['light', 'medium', 'heavy', 'full_gut'];

/**
 * Offered as a list rather than typed free-form because match_buyers_for_deal()
 * compares this string against every buyer's property_types array. The match is
 * case-insensitive, not fuzzy — 'sfh' typed here does not match 'single_family'
 * in a buy box, and the failure is silent: the buyer simply never appears.
 */
const PROPERTY_TYPES = [
  'single_family', 'multi_family', 'condo', 'townhouse', 'manufactured', 'land', 'commercial',
];

const DOC_KINDS = [
  'purchase_agreement', 'assignment_agreement', 'addendum', 'emd_receipt',
  'proof_of_funds', 'settlement_statement', 'inspection_report',
  'title_commitment', 'photo', 'comps', 'other',
];

const MILESTONE_LABEL = {
  emd_due: 'Earnest money due',
  inspection_end: 'Inspection period ends',
  closing: 'Closing',
  extension_deadline: 'Extension deadline',
  title_clear: 'Title clear',
  assignment_due: 'Assignment due',
  other: 'Milestone',
};

/** The buyer_deal_interest ladder, and how loudly each rung should read. */
const INTEREST_TONE = {
  notified: '', viewed: '', interested: 'ok', offered: 'ok', selected: 'ok',
  walked: 'stop', passed: 'stop', reneged: 'stop',
};

export default function DealDetail({ id }) {
  const [deal, setDeal] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [docs, setDocs] = useState([]);
  const [events, setEvents] = useState([]);
  const [interest, setInterest] = useState([]);
  const [buyers, setBuyers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const [d, ms, dc, ev, bi, bs] = await Promise.all([
      // The seller and the assigned buyer come back embedded rather than as two
      // more round trips. Each is a single foreign key out of deals, so
      // PostgREST resolves the relationship without being told which one.
      supabase
        .from('deals')
        .select(`*,
          lead:leads(id, name, phone, phone_mobile, email, address, city, state, status, temperature, trashed),
          assigned_buyer:buyers(id, name, entity_name, phone, email, status, deals_closed, deals_reneged, typical_close_days)`)
        .eq('id', id)
        .single(),
      supabase.from('deal_milestones').select('*').eq('deal_id', id).order('due_at'),
      supabase.from('deal_documents').select('*').eq('deal_id', id).order('created_at', { ascending: false }),
      // Append-only and unbounded — a deal that ran nine months carries every
      // status change, blast and document. Newest first, capped, because the
      // top of the list is the part anyone reads.
      supabase.from('deal_events').select('*').eq('deal_id', id)
        .order('created_at', { ascending: false }).limit(200),
      supabase.from('buyer_deal_interest')
        // No phone: this panel is a record of who was contacted, not a place to
        // contact them from, and a buyer's number in a payload nothing renders
        // is contact PII in the browser for no reason.
        .select('*, buyer:buyers(id, name, entity_name)')
        .eq('deal_id', id)
        .order('match_score', { ascending: false, nullsFirst: false }),
      // Only active buyers can be assigned. A paused or blacklisted buyer in
      // this dropdown is an assignment that gets written and then argued about.
      supabase.from('buyers').select('id, name, entity_name').eq('status', 'active').order('name'),
    ]);

    if (d.error) { setErr(d.error.message); setLoading(false); return; }
    setDeal(d.data ?? null);
    setMilestones(ms.data ?? []);
    setDocs(dc.data ?? []);
    setEvents(ev.data ?? []);
    setInterest(bi.data ?? []);
    setBuyers(bs.data ?? []);

    // Named rather than swallowed: an empty documents list and a documents list
    // that failed to load look identical, and only one of them means it is safe
    // to go to closing without a title commitment on file.
    const soft = [ms.error, dc.error, ev.error, bi.error, bs.error].find(Boolean);
    setErr(soft ? `Part of this deal could not be loaded (${soft.message}). What is shown may be incomplete.` : null);
    setLoading(false);
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const patch = useCallback(async (fields) => {
    setErr(null);
    setDeal((prev) => ({ ...prev, ...fields }));      // optimistic
    const { error } = await supabase.from('deals').update(fields).eq('id', id);
    // Always re-read. buyer_price and buyer_spread are GENERATED, the milestone
    // trigger rewrites deal_milestones off the dates, and the status trigger
    // writes an event — none of which the optimistic patch above knows about.
    //
    // Awaited, and the failure reported AFTER it, because load() ends by
    // clearing err. Reporting first meant a rejected edit — a check_violation,
    // an RLS denial — flashed an error the reload wiped a moment later, while
    // the reload also reverted the optimistic value. The operator saw the field
    // snap back to its old value with nothing on screen saying why, which is
    // indistinguishable from a mis-click and is how a contract price silently
    // stays wrong.
    await load();
    if (error) setErr(error.message);
  }, [id, load]);

  const patchNumber = (field) => (v) => patch({ [field]: toNumber(v) });

  // extension_count is NOT NULL. Clearing the field means zero, not null.
  const patchCount = (field) => (v) =>
    patch({ [field]: v === null ? 0 : Math.max(0, Math.trunc(Number(String(v).replace(/[^\d]/g, '')) || 0)) });

  if (loading) return <div className="empty">Loading deal…</div>;
  // The error bar lives inside the loaded layout below, so without this a
  // network failure or an RLS denial rendered as a confident "Deal not found" —
  // the one reading that tells an operator to stop looking for a deal that is
  // in fact still there.
  if (!deal) {
    return (
      <div className="empty">
        <strong>{err ? 'This deal could not be loaded' : 'Deal not found'}</strong>
        {err && <p className="fine">{err}</p>}
        <a href="/app/deals">Back to deals</a>
      </div>
    );
  }

  return (
    <>
      <DealHead deal={deal} />

      {err && <div className="err">{err}</div>}

      <div className="detail">
        <div>
          <Numbers deal={deal} patch={patch} patchNumber={patchNumber} />
          <Dates deal={deal} milestones={milestones} patch={patch} patchNumber={patchNumber}
                 patchCount={patchCount} onDone={load} onErr={setErr} />
          <Property deal={deal} patch={patch} patchNumber={patchNumber} />
          {/* Above the documents on purpose: a buyer asks what the house looks
              like long before anybody asks for the settlement statement. Any
              photos gathered while this was a lead are already in here — the
              trigger on deals stamped them when this record was created. */}
          <PhotoGallery subject="deal" subjectId={deal.id} teamId={deal.team_id} />
          <ContractPanel subject="deal" subjectId={deal.id} teamId={deal.team_id} lead={deal.lead} />
          <Documents deal={deal} docs={docs} onDone={load} onErr={setErr} />
          <Events events={events} />
        </div>

        <div>
          <StatusMove deal={deal} buyers={buyers} onDone={load} onErr={setErr} />
          <Seller deal={deal} onDone={load} onErr={setErr} />
          <Buyer deal={deal} buyers={buyers} patch={patch} patchNumber={patchNumber} />
          <Interest rows={interest} />
        </div>
      </div>
    </>
  );
}

/* ── the header ─────────────────────────────────────────────────────────────
   The address, the status, and the two clocks, at the top, at size. Everything
   below this is detail; these three are why the page was opened.            */
function DealHead({ deal }) {
  const insp = daysUntil(deal.inspection_end_date);
  const close = daysUntil(deal.closing_date);
  const settled = deal.status === 'closed' || deal.status === 'dead';

  return (
    <header className="dealhead">
      <div>
        <h1>{deal.address}</h1>
        <p className="sub">
          {/* The seller's name first, on every screen about them. A deal page
              titled only by its street makes you open the lead to find out who
              you are about to ring. */}
          {deal.lead?.name && <><strong>{deal.lead.name}</strong>{' · '}</>}
          {[[deal.city, deal.state].filter(Boolean).join(', '), deal.zip].filter(Boolean).join(' ')}
          {deal.county ? ` · ${deal.county} County` : ''}
          {' · '}<a href="/app/deals">All deals</a>
        </p>
        <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
          <DeleteButton
            table="deals"
            id={deal.id}
            name={deal.address}
            onDeleted={() => navigate('/deals')}
          />
        </div>
      </div>

      <div className="dealclocks">
        <span className="badge">{dealStatusLabel(deal.status)}</span>
        {!settled && (
          <>
            <BigClock
              k="Inspection ends"
              date={deal.inspection_end_date}
              days={insp}
              // Same judgement as the board: an inspection deadline is only an
              // emergency while there is nobody to assign to, because that is
              // what makes the earnest money stop being refundable.
              tone={insp == null ? 'none' : insp < 0 ? 'gone'
                : (deal.assigned_buyer_id || deal.status === 'buyer_selected') ? 'ok'
                : clockTone(insp, 'inspection')}
              past="closed — deposit is hard"
            />
            <BigClock k="Closing" date={deal.closing_date} days={close} tone={clockTone(close, 'closing')} />
          </>
        )}
        {deal.status === 'closed' && (
          <span className="bigclock ok">
            <span className="k">Closed</span>
            <span className="v">{dateOnly(deal.actual_close_date) || '—'}</span>
            <span className="d">{money(deal.actual_assignment_fee)} collected</span>
          </span>
        )}
      </div>
    </header>
  );
}

function BigClock({ k, date, days, tone, past }) {
  return (
    <span className={`bigclock ${tone}`}>
      <span className="k">{k}</span>
      <span className="v">{days == null ? 'not set' : days < 0 && past ? past : countdownLabel(days)}</span>
      <span className="d">{dateOnly(date) || 'no date on the contract'}</span>
    </span>
  );
}

/* ── the numbers ─────────────────────────────────────────────────────────── */

/**
 * The five typed numbers, and the two the database derives from them.
 *
 * buyer_price and buyer_spread are GENERATED columns, shown here and never
 * written. The distinction the panel underneath exists to make: buyer_spread
 * subtracts our assignment fee. The wholesaler's own spread is a bigger,
 * friendlier number, and quoting that one to a buyer promises them a margin
 * that includes money going into Tossie's pocket. They notice once.
 */
function Numbers({ deal, patch, patchNumber }) {
  const thin = deal.buyer_spread != null && deal.buyer_spread <= 0;
  const overMao =
    deal.max_allowable_offer != null && deal.contract_price != null
      ? deal.contract_price - deal.max_allowable_offer
      : null;

  return (
    <div className="card">
      <h2>The numbers</h2>
      <p className="cardnote">Whole dollars. Click any value to edit.</p>
      <div className="body">
        <dl className="facts editable">
          <InlineField label="Contract price" value={deal.contract_price} onSave={patchNumber('contract_price')} format={money} placeholder="what we pay the seller" />
          <InlineField label="ARV estimate" value={deal.arv_estimate} onSave={patchNumber('arv_estimate')} format={money} />
          <InlineField label="Repairs estimate" value={deal.repair_estimate} onSave={patchNumber('repair_estimate')} format={money} />
          <InlineField label="Our fee" value={deal.target_assignment_fee} onSave={patchNumber('target_assignment_fee')} format={money} placeholder="target assignment fee" />
          <InlineField label="Max offer" value={deal.max_allowable_offer} onSave={patchNumber('max_allowable_offer')} format={money} placeholder="MAO — the most this is worth to us" />
          <InlineField label="Exit" value={deal.exit_strategy} onSave={(v) => patch({ exit_strategy: v || 'assign' })} options={EXIT_STRATEGIES} />
        </dl>

        <div className="derived">
          <div className="drow">
            <span className="k">Buyer pays</span>
            <span className="v">{money(deal.buyer_price)}</span>
            <span className="w">contract price + our fee</span>
          </div>
          <div className={`drow ${thin ? 'bad' : ''}`}>
            <span className="k">Buyer's spread</span>
            <span className="v">{signedMoney(deal.buyer_spread)}</span>
            <span className="w">ARV − repairs − what the buyer pays. This is the number matched against a buy box, and the number a buyer checks.</span>
          </div>
          {overMao != null && (
            <div className={`drow ${overMao > 0 ? 'bad' : ''}`}>
              <span className="k">{overMao > 0 ? 'Over max offer' : 'Under max offer'}</span>
              <span className="v">{signedMoney(Math.abs(overMao))}</span>
              <span className="w">contract price against the most this was worth to us</span>
            </div>
          )}
        </div>

        {thin && (
          <div className="notice" style={{ marginTop: 12 }}>
            <strong>No buyer takes this at this fee.</strong>
            At the current ARV and repair estimates the end buyer has nothing left. Either the fee comes
            down, the contract price comes down, or the repair estimate is wrong.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── the contract ───────────────────────────────────────────────────────── */

function Dates({ deal, milestones, patch, patchNumber, patchCount, onDone, onErr }) {
  return (
    <div className="card">
      <h2>The contract</h2>
      <p className="cardnote">
        Earnest money, inspection and closing carry a reminder ladder — a week out, three days out, the day
        before. Change a date here and the ladder re-arms itself from the new one.
      </p>
      <div className="body">
        <dl className="facts editable">
          <InlineField label="Executed" value={deal.executed_date} onSave={(v) => patch({ executed_date: v })} type="date" format={dateOnly} />
          <InlineField label="EMD amount" value={deal.emd_amount} onSave={patchNumber('emd_amount')} format={money} />
          <InlineField label="EMD due" value={deal.emd_due_date} onSave={(v) => patch({ emd_due_date: v })} type="date" format={dateOnly} />
          <InlineField label="EMD status" value={deal.emd_status} onSave={(v) => patch({ emd_status: v || 'not_due' })} options={EMD_STATUSES} />
          <InlineField label="Inspection ends" value={deal.inspection_end_date} onSave={(v) => patch({ inspection_end_date: v })} type="date" format={dateOnly} />
          <InlineField label="Closing" value={deal.closing_date} onSave={(v) => patch({ closing_date: v })} type="date" format={dateOnly} />
          <InlineField label="Extensions" value={deal.extension_count} onSave={patchCount('extension_count')} type="number" />
          <InlineField label="Title company" value={deal.title_company} onSave={(v) => patch({ title_company: v })} />
          <InlineField label="Closing attorney" value={deal.closing_attorney} onSave={(v) => patch({ closing_attorney: v })} />
        </dl>

        <Milestones rows={milestones} onDone={onDone} onErr={onErr} />
      </div>
    </div>
  );
}

/**
 * A milestone due_at is a timestamp at 5pm local, not a date column, so it
 * cannot go through daysUntil(). Floored to its own local date first, or a
 * deadline five hours from now reads as zero-point-something days.
 */
function milestoneDays(iso) {
  const at = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const then = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  return Math.round((then.getTime() - today.getTime()) / 86400000);
}

function Milestones({ rows, onDone, onErr }) {
  const [busy, setBusy] = useState(null);

  async function toggle(m) {
    setBusy(m.id);
    const { error } = await supabase
      .from('deal_milestones')
      .update({ completed_at: m.completed_at ? null : new Date().toISOString() })
      .eq('id', m.id);
    setBusy(null);
    if (error) { onErr(error.message); return; }
    onDone();
  }

  if (rows.length === 0) {
    return <p className="colempty" style={{ marginTop: 14 }}>No dates on this contract yet.</p>;
  }

  return (
    <ul className="mstones">
      {rows.map((m) => {
        const days = milestoneDays(m.due_at);
        const done = Boolean(m.completed_at);
        // Inspection is the tighter ladder for the same reason it is on the
        // board: a closing date can be extended, an expired inspection period
        // cannot be un-expired.
        const tone = done ? 'done' : clockTone(days, m.kind === 'inspection_end' ? 'inspection' : 'closing');
        return (
          <li key={m.id} className={tone}>
            <span className="mk">
              {m.label || MILESTONE_LABEL[m.kind] || titleize(m.kind)}
              {m.auto_managed && <em title="Kept in step with the date above by the database">auto</em>}
            </span>
            <span className="mwhen">{fullDate(m.due_at)}</span>
            <span className="mdays">{done ? 'done' : countdownLabel(days)}</span>
            <button className="linkbtn" disabled={busy === m.id} onClick={() => toggle(m)}>
              {done ? 'reopen' : 'mark done'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ── the property ───────────────────────────────────────────────────────── */

/**
 * Copied onto the deal rather than read through the lead: the lead is a person
 * and the deal is a house. The same seller can bring three properties, and a
 * lead row edited a year from now must not rewrite what was contracted.
 */
function Property({ deal, patch, patchNumber }) {
  return (
    <div className="card">
      <h2>The property</h2>
      <div className="body">
        <dl className="facts editable">
          {/* address is NOT NULL, so an empty save is dropped rather than sent.
              The alternative is a not-null violation in the error bar for what
              was almost certainly a mis-click into the field and out again. */}
          <InlineField label="Address" value={deal.address} onSave={(v) => v && patch({ address: v })} />
          <InlineField label="City" value={deal.city} onSave={(v) => patch({ city: v })} />
          <InlineField label="State" value={deal.state} onSave={(v) => patch({ state: v })} />
          <InlineField label="ZIP" value={deal.zip} onSave={(v) => patch({ zip: v })} />
          <InlineField label="County" value={deal.county} onSave={(v) => patch({ county: v })} placeholder="buy boxes are written in counties" />
          <InlineField label="Parcel" value={deal.parcel_id} onSave={(v) => patch({ parcel_id: v })} />
          <InlineField label="Type" value={deal.property_type} onSave={(v) => patch({ property_type: v })} options={PROPERTY_TYPES} />
          <InlineField label="Beds" value={deal.beds} onSave={patchNumber('beds')} type="number" />
          <InlineField label="Baths" value={deal.baths} onSave={patchNumber('baths')} type="number" />
          <InlineField label="Sq ft" value={deal.sqft} onSave={patchNumber('sqft')} type="number" />
          <InlineField label="Year built" value={deal.year_built} onSave={patchNumber('year_built')} type="number" />
          <InlineField label="Rehab" value={deal.rehab_level} onSave={(v) => patch({ rehab_level: v })} options={REHAB_LEVELS} />
          <InlineField label="Occupancy" value={deal.occupancy} onSave={(v) => patch({ occupancy: v })} options={OCCUPANCY} />
        </dl>
        <p className="fine" style={{ marginTop: 12 }}>
          County, ZIP, type, rehab level and occupancy are what the buy-box matcher filters on. A blank one
          never excludes a buyer — except geography, where a buyer who named counties or ZIPs cannot be
          matched to a property that names neither.
        </p>
      </div>
    </div>
  );
}

/* ── moving the status ──────────────────────────────────────────────────── */

/**
 * The status control, built from the database's own transition map.
 *
 * deal_status_can_transition() is IMMUTABLE and the matrix is enforced by
 * deals_enforce_transition, so asking it is the only way to offer moves that
 * will actually be accepted. Typing the matrix out here instead would give
 * Tossie two lifecycle maps, and the one in the browser would be the stale one
 * — offering a move that then fails with a raw check_violation.
 *
 * The cost is ten small parallel RPCs, paid once per mount and again only when
 * the status actually changes. A single call answering "from here, where?"
 * would be one round trip, but it would be a new SQL function whose only
 * consumer is this dropdown.
 *
 * The extra inputs are not politeness either. deals_assigned_needs_buyer and
 * deals_closed_needs_close_date are CHECK constraints on the row, so the buyer
 * and the close date have to be in the same UPDATE as the status — collecting
 * them afterwards means an UPDATE that is rejected outright.
 */
function StatusMove({ deal, buyers, onDone, onErr }) {
  const [allowed, setAllowed] = useState(null);
  const [target, setTarget] = useState('');
  const [buyerId, setBuyerId] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false);
  const from = deal.status;

  useEffect(() => {
    let cancelled = false;
    setTarget('');
    Promise.all(
      DEAL_STATUSES.filter((s) => s !== from).map(async (to) => {
        const { data, error } = await supabase.rpc('deal_status_can_transition', { p_from: from, p_to: to });
        // A failed check drops the option rather than offering it. An offer the
        // trigger then refuses is worse than a move the operator has to reload
        // for.
        return !error && data === true ? to : null;
      }),
    ).then((rows) => { if (!cancelled) setAllowed(rows.filter(Boolean)); });
    return () => { cancelled = true; };
  }, [from]);

  const needsBuyer = (target === 'assigned' || target === 'closed') && !deal.assigned_buyer_id;
  const needsDate = target === 'closed' && !deal.actual_close_date;
  const ready = target && (!needsBuyer || buyerId) && (!needsDate || closeDate);

  function pick(next) {
    setTarget(next);
    // Sensible starting points, so the common case is one dropdown and one
    // button. Both are still editable — a deal that closed last Thursday is
    // routine, and so is a fee that came in short after a repair credit.
    setCloseDate(next === 'closed' ? new Date().toISOString().slice(0, 10) : '');
    setFee(next === 'closed' && deal.target_assignment_fee != null ? String(deal.target_assignment_fee) : '');
    setBuyerId('');
  }

  async function move() {
    if (!ready || busy) return;
    setBusy(true);
    const fields = { status: target };
    if (needsBuyer) fields.assigned_buyer_id = buyerId;
    if (needsDate) fields.actual_close_date = closeDate;
    // Same reason as toNumber's: a fee of 0 is what an assignment that collected
    // nothing looks like, and it must be recorded as 0 rather than as blank.
    if (target === 'closed' && fee.trim() !== '') {
      fields.actual_assignment_fee = toNumber(fee);
    }
    const { error } = await supabase.from('deals').update(fields).eq('id', deal.id);
    setBusy(false);
    if (error) { onErr(error.message); return; }
    onDone();
  }

  return (
    <div className="card">
      <h2>Status</h2>
      <div className="body statusmove">
        <p className="now"><span className="badge">{dealStatusLabel(from)}</span></p>

        {allowed === null && <p className="colempty">Checking which moves are legal…</p>}
        {allowed?.length === 0 && (
          <p className="fine">Nothing moves from here. A closed deal only reopens to assigned.</p>
        )}

        {allowed?.length > 0 && (
          <>
            <select value={target} onChange={(e) => pick(e.target.value)}>
              <option value="">Move to…</option>
              {allowed.map((s) => <option key={s} value={s}>{dealStatusLabel(s)}</option>)}
            </select>

            {needsBuyer && (
              <label className="movefield">
                Assigned buyer
                <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>
                  <option value="">Pick a buyer…</option>
                  {buyers.map((b) => (
                    <option key={b.id} value={b.id}>{b.entity_name || b.name}</option>
                  ))}
                </select>
                <small>Required — a deal cannot be assigned or closed without one.</small>
              </label>
            )}

            {needsDate && (
              <label className="movefield">
                Actual close date
                <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
                <small>Required. This is the date the money view reports against.</small>
              </label>
            )}

            {target === 'closed' && (
              <label className="movefield">
                Fee actually collected
                <input inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="what landed" />
                <small>What was hoped for is already recorded. This is what arrived.</small>
              </label>
            )}

            <button className="btn" disabled={!ready || busy} onClick={move}>
              {busy ? 'Moving…' : `Move to ${target ? dealStatusLabel(target) : '…'}`}
            </button>
            <p className="fine">Every move is written to the timeline below by the database, not by this page.</p>
          </>
        )}
      </div>
    </div>
  );
}

/* ── the seller ─────────────────────────────────────────────────────────── */

function Seller({ deal, onDone, onErr }) {
  const lead = deal.lead;

  return (
    <div className="card">
      <h2>Seller</h2>
      <div className="body">
        {lead ? (
          <>
            <dl className="facts">
              <dt>Name</dt><dd><a href={`/app/leads/${lead.id}`}>{lead.name || 'Unnamed lead'}</a></dd>
              <dt>Phone</dt><dd>{formatPhone(lead.phone_mobile || lead.phone) || '—'}</dd>
              <dt>Email</dt><dd style={{ wordBreak: 'break-all' }}>{lead.email || '—'}</dd>
              <dt>Lead status</dt><dd><span className="badge">{titleize(lead.status)}</span></dd>
            </dl>
            {lead.address && lead.address !== deal.address && (
              <p className="fine" style={{ marginTop: 10 }}>
                The lead's address is <strong>{lead.address}</strong>, which is not this property. Normal if
                the same seller brought more than one — worth a second look if not.
              </p>
            )}
          </>
        ) : (
          <AttachSeller dealId={deal.id} onDone={onDone} onErr={onErr} />
        )}
      </div>
    </div>
  );
}

/**
 * Links an existing lead to the deal rather than retyping the seller onto it.
 *
 * The lead carries the consent record, the opt-out state and the call history;
 * a deal with a hand-typed seller name has none of that, and the first time
 * anyone texts that seller they will do it from a row nobody checked.
 */
function AttachSeller({ dealId, onDone, onErr }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);

  async function search(e) {
    e.preventDefault();
    // PostgREST's .or() takes a comma-separated filter string, so a comma,
    // parenthesis or percent typed into the box is grammar, not text — it
    // produces a parse error or a wildcard nobody asked for.
    const needle = q.trim().replace(/[,()%*]/g, ' ').trim();
    if (!needle) return;
    setBusy(true);
    const { data, error } = await supabase
      .from('leads')
      .select('id, name, address, city, phone, phone_mobile')
      .eq('trashed', false)
      .or(`address.ilike.%${needle}%,name.ilike.%${needle}%`)
      .limit(8);
    setBusy(false);
    if (error) { onErr(error.message); return; }
    setHits(data ?? []);
  }

  async function attach(leadId) {
    const { error } = await supabase.from('deals').update({ lead_id: leadId }).eq('id', dealId);
    if (error) { onErr(error.message); return; }
    onDone();
  }

  return (
    <>
      <p className="fine" style={{ marginTop: 0 }}>
        No seller linked. Attach the lead so the consent record and the call history follow the deal.
      </p>
      <form onSubmit={search} className="newdeal">
        <input placeholder="Search leads by address or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn ghost" type="submit" disabled={busy}>{busy ? '…' : 'Find'}</button>
      </form>
      {hits.length > 0 && (
        <ul className="hits">
          {hits.map((l) => (
            <li key={l.id}>
              <button className="linkbtn" onClick={() => attach(l.id)}>
                <strong>{l.address || l.name || 'Untitled'}</strong>
                <span className="sub">
                  {[l.name, l.city, formatPhone(l.phone_mobile || l.phone)].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ── the buyer ──────────────────────────────────────────────────────────── */

function Buyer({ deal, buyers, patch, patchNumber }) {
  const b = deal.assigned_buyer;

  return (
    <div className="card">
      <h2>Assigned buyer</h2>
      <div className="body">
        {b ? (
          <dl className="facts editable">
            <dt>Buyer</dt><dd>{b.entity_name || b.name}</dd>
            <dt>Contact</dt><dd>{formatPhone(b.phone) || b.email || '—'}</dd>
            <dt>Track record</dt>
            <dd>
              {b.deals_closed} closed
              {b.deals_reneged > 0 && <span className="badge stop" style={{ marginLeft: 6 }}>{b.deals_reneged} reneged</span>}
            </dd>
            <InlineField label="Fee collected" value={deal.actual_assignment_fee} onSave={patchNumber('actual_assignment_fee')} format={money} placeholder="once it lands" />
            <InlineField label="Closed on" value={deal.actual_close_date} onSave={(v) => patch({ actual_close_date: v })} type="date" format={dateOnly} />
          </dl>
        ) : (
          <>
            <p className="fine" style={{ marginTop: 0 }}>
              Nobody assigned yet. Picking a buyer here records the choice; moving the status to assigned
              is what makes it official.
            </p>
            <select
              value=""
              onChange={(e) => e.target.value && patch({ assigned_buyer_id: e.target.value })}
            >
              <option value="">Assign a buyer…</option>
              {buyers.map((x) => <option key={x.id} value={x.id}>{x.entity_name || x.name}</option>)}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Who has been put in front of this deal and what came back.
 *
 * match_score and match_reasons are frozen onto the row at blast time. They are
 * shown rather than recomputed because their job is evidence: if the A2P
 * campaign is ever reviewed, this is the record that the audience was segmented
 * to a buy box and not sprayed at the whole list.
 */
function Interest({ rows }) {
  if (rows.length === 0) return null;

  return (
    <div className="card">
      <h2>Buyers on this deal · {rows.length}</h2>
      <div className="body">
        <ul className="interest">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="who">
                {r.buyer ? (r.buyer.entity_name || r.buyer.name) : 'Buyer removed'}
                <span className={`badge ${INTEREST_TONE[r.status] || ''}`}>{titleize(r.status)}</span>
              </span>
              <span className="sub">
                {r.match_score != null && `match ${r.match_score}`}
                {r.offer_amount != null && ` · offered ${money(r.offer_amount)}`}
                {r.notified_at && ` · notified ${timeAgo(r.notified_at)}`}
              </span>
              {r.match_reasons?.length > 0 && (
                <span className="why">{r.match_reasons.join(' · ')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── documents ──────────────────────────────────────────────────────────── */

const prettyBytes = (n) =>
  n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/**
 * The private-bucket message, in words someone can act on.
 *
 * The bucket is not created by a migration — Storage buckets live in the
 * Supabase project, not in supabase/migrations — so the first upload on a fresh
 * project fails with a bare "Bucket not found" that reads like a broken button.
 */
function storageHint(error) {
  const msg = error?.message || 'Upload failed';
  if (/bucket/i.test(msg) && /not found|does not exist/i.test(msg)) {
    return `The "${BUCKET}" storage bucket does not exist yet. Create it in the Supabase dashboard as a PRIVATE bucket — these are purchase agreements and settlement statements, and a public bucket puts them behind a guessable URL.`;
  }
  // The second half of the same setup, and the half that is easy to get
  // dangerously wrong. storage.objects has RLS on with no policies until
  // someone writes them, so a correctly-created private bucket still refuses
  // every upload — and the obvious cure, a policy of `true`, is the one that
  // makes every contract on the project readable by any signed-in user.
  // The one an operator actually hits. A bucket with an allowed_mime_types list
  // refuses on the type the BROWSER reported, and a .docx dragged out of some
  // apps arrives as an empty string or application/octet-stream — so a real
  // purchase agreement gets refused and Supabase says so in a sentence about
  // MIME types, which reads like a fault in the app rather than a setting.
  if (/mime|content type|not supported|invalid_mime/i.test(msg)) {
    return `Storage refused that file type (${msg}). The "${BUCKET}" bucket has an allowed_mime_types list, and browsers report some Word files as octet-stream. Clearing that list — set allowed_mime_types to null — accepts anything; who may upload is already controlled by the storage policies and deals.edit, so the list was not buying much.`;
  }

  if (/row-level security|policy|not authorized|Unauthorized/i.test(msg)) {
    return `Storage refused this (${msg}). The "${BUCKET}" bucket needs policies on storage.objects for the authenticated role, scoped to this team — the object key starts with the team id for exactly that, so match on the first path segment. Do not write a policy of USING (true): that makes every purchase agreement on the project readable by anyone who can sign in.`;
  }
  return msg;
}

function Documents({ deal, docs, onDone, onErr }) {
  const [kind, setKind] = useState('purchase_agreement');
  const [busy, setBusy] = useState(false);

  async function upload(e) {
    const file = e.target.files?.[0];
    // Cleared immediately so the same file can be re-picked after a failure —
    // otherwise onChange never fires again and the button looks dead.
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    // Team first in the path so a Storage policy can be written against it
    // later without rewriting every existing object's key.
    const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80);
    const path = `${deal.team_id}/${deal.id}/${Date.now()}-${safe}`;

    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file);
    if (upErr) { setBusy(false); onErr(storageHint(upErr)); return; }

    const { data: who } = await supabase.auth.getUser();
    const { error } = await supabase.from('deal_documents').insert({
      team_id: deal.team_id,
      deal_id: deal.id,
      kind,
      bucket: BUCKET,
      storage_path: path,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: who?.user?.id ?? null,
    });

    if (error) {
      // The row is the record. A file with no row is invisible to every screen
      // and to RLS, so it goes back out rather than sitting in the bucket
      // findable by nothing and billable forever.
      await supabase.storage.from(BUCKET).remove([path]);
      setBusy(false);
      onErr(error.message);
      return;
    }

    // BUILD_PLAN §4: every document is an event. deal_events is append-only, so
    // this is a record that cannot later be tidied up by anyone.
    //
    // The failure is reported rather than dropped: the file and its row are both
    // in place at this point, so this is not a failed upload, it is an upload
    // that left no trace in the record an attorney reads a year later.
    const { error: evErr } = await supabase.from('deal_events').insert({
      team_id: deal.team_id,
      deal_id: deal.id,
      type: 'document_uploaded',
      actor_id: who?.user?.id ?? null,
      actor_kind: 'user',
      summary: `${titleize(kind)} uploaded — ${file.name}`,
      payload: { kind, file_name: file.name, storage_path: path },
    });
    setBusy(false);
    // Reported after the reload, not before: onDone() is the page's load(),
    // which ends by clearing the error bar.
    await onDone();
    if (evErr) onErr(`Uploaded, but the timeline entry was not written (${evErr.message}).`);
  }

  async function open(doc) {
    // Minted at click and good for a minute. deal_documents deliberately stores
    // a path and not a URL: a stored signed URL is a credential that outlives
    // whoever it was minted for.
    const { data, error } = await supabase.storage.from(doc.bucket).createSignedUrl(doc.storage_path, 60);
    if (error) { onErr(storageHint(error)); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function remove(doc) {
    if (!window.confirm(`Remove ${doc.file_name || 'this document'}? The file is deleted too.`)) return;
    // Row first. If the object delete fails afterwards the worst case is an
    // orphaned file; doing it the other way round leaves a row pointing at
    // nothing, which every screen renders as a document that exists.
    const { error } = await supabase.from('deal_documents').delete().eq('id', doc.id);
    if (error) { onErr(error.message); return; }
    await supabase.storage.from(doc.bucket).remove([doc.storage_path]);

    // The deletion is the part of a document's life worth an audit entry.
    // deal_documents is the only table on this page authenticated can DELETE
    // from, so without this the timeline records that a purchase agreement was
    // uploaded and nothing at all about it disappearing. deal_events refuses
    // UPDATE and DELETE for every role, so this record outlives the file.
    const { data: who } = await supabase.auth.getUser();
    const { error: evErr } = await supabase.from('deal_events').insert({
      team_id: doc.team_id,
      deal_id: doc.deal_id,
      type: 'document_removed',
      actor_id: who?.user?.id ?? null,
      actor_kind: 'user',
      summary: `${titleize(doc.kind)} removed — ${doc.file_name || doc.storage_path}`,
      payload: { kind: doc.kind, file_name: doc.file_name, storage_path: doc.storage_path },
    });

    await onDone();
    if (evErr) onErr(`Removed, but the timeline entry was not written (${evErr.message}).`);
  }

  return (
    <div className="card">
      <h2>Documents · {docs.length}</h2>
      <p className="cardnote">Stored privately. Links are minted when you open one and expire in a minute.</p>
      <div className="body">
        <div className="uploadbar">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {DOC_KINDS.map((k) => <option key={k} value={k}>{titleize(k)}</option>)}
          </select>
          <label className="btn ghost">
            {busy ? 'Uploading…' : 'Choose file'}
            <input type="file" hidden disabled={busy} onChange={upload} />
          </label>
        </div>

        {docs.length === 0 ? (
          <p className="colempty">Nothing uploaded yet.</p>
        ) : (
          <ul className="docs">
            {docs.map((d) => (
              <li key={d.id}>
                <button className="linkbtn name" onClick={() => open(d)}>
                  <strong>{d.file_name || d.storage_path.split('/').pop()}</strong>
                </button>
                <span className="sub">
                  <span className="badge">{titleize(d.kind)}</span>
                  {' '}{prettyBytes(d.size_bytes)} · {timeAgo(d.created_at)}
                </span>
                <button className="linkbtn danger" onClick={() => remove(d)}>remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── the timeline ───────────────────────────────────────────────────────── */

/**
 * deal_events, as written. Nothing here is editable and nothing here is
 * summarised away — the table refuses UPDATE, DELETE and TRUNCATE for every
 * role including service_role, and a page that paraphrased it would be the
 * softer copy someone quoted instead.
 */
function Events({ events }) {
  return (
    <div className="card">
      <h2>Timeline</h2>
      <div className="body">
        {events.length === 0 ? (
          <p className="colempty">Nothing yet.</p>
        ) : (
          <ul className="timeline">
            {events.map((e) => (
              <li key={e.id}>
                {e.summary || titleize(e.type)}
                {e.actor_kind !== 'user' && <span className="badge" style={{ marginLeft: 7 }}>{e.actor_kind}</span>}
                <span className="when">{fullDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
