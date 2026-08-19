import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { TEAM_ID } from '../lib/team.js';
import {
  dealStatusLabel,
  clockTone, countdownLabel, dateOnly, daysUntil, parseDateOnly, titleize,
} from '../lib/format.js';

/**
 * The two screens a wholesaler actually looks at, per BUILD_PLAN §4.
 *
 * The board answers "what needs doing before it costs me money", and the only
 * reason it exists rather than the leads board covering it is the two clocks on
 * every card: days to closing and days left in the inspection period. Those are
 * the two dates that cost real money when missed, so they are the largest thing
 * on the card and they change colour before they change from a number into a
 * problem.
 *
 * The money view answers "what am I owed and when does it land". Both read the
 * same rows; neither writes anything except the one-field new-deal form, which
 * is here rather than on a route of its own because a deal starts as an address
 * and everything else is learned later, on the detail page, one click per fact.
 */

const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString()}`);
const money0 = (v) => `$${Math.round(Number(v) || 0).toLocaleString()}`;

/**
 * The columns, in the order the work flows.
 *
 * Eleven statuses is eleven columns and nobody scrolls eleven columns, so the
 * three where nothing needs doing sit behind a toggle. They are one click away
 * rather than gone because both terminations lead back to under_contract and
 * dispo in the transition map — a seller reconsidering is a normal month, not
 * an archive event.
 *
 * extension_pending and buyer_fell_through stay on the board permanently. They
 * are the two states where a deal is quietly rotting, which is exactly when it
 * must not be out of sight.
 */
const BOARD_COLUMNS = [
  'draft', 'under_contract', 'dispo', 'buyer_selected', 'assigned',
  'extension_pending', 'buyer_fell_through', 'closed',
];
const QUIET_COLUMNS = ['seller_terminated', 'terminated_inspection', 'dead'];

/**
 * Signed, not yet resolved. This is the set the fee pipeline is summed over.
 *
 * `draft` is excluded because nothing is signed — counting an unexecuted
 * contract as pipeline is how a wholesaler talks himself into a number he does
 * not have. `buyer_fell_through` is included because the contract with the
 * seller is still live and the fee is still gettable; that is the whole reason
 * it is a status rather than a dead end.
 */
const LIVE_STATUSES = [
  'under_contract', 'dispo', 'buyer_selected', 'assigned',
  'extension_pending', 'buyer_fell_through',
];

/**
 * How far down the dispo funnel a buyer_deal_interest row got.
 *
 * The table stores a current status, not a history, so "how many reached
 * interested" has to be read off the ladder. The off-ramps are ranked at the
 * stage they had to reach before taking them: `walked` and `passed` are buyers
 * who engaged and said no, and `reneged` is a buyer who was selected and then
 * backed out. Ranking those at zero would delete the worst outcomes from the
 * denominator and flatter every conversion rate on the page.
 */
const INTEREST_RANK = {
  notified: 0,
  viewed: 1,
  interested: 2, walked: 2, passed: 2,
  offered: 3,
  selected: 4, reneged: 4,
};

/**
 * Read caps, stated rather than inherited.
 *
 * The money view sums every row it was handed, so a cap that silently truncates
 * is a cap that reports a smaller pipeline than exists and gives no sign it did.
 * PostgREST also applies its own ceiling when a query names none, which would
 * make the trim invisible AND unowned. So both queries ask for an exact count
 * and the page says so when it hit the wall.
 */
const DEAL_CAP = 2000;
const INTEREST_CAP = 5000;

export default function DealsPage() {
  const [deals, setDeals] = useState([]);
  const [buyers, setBuyers] = useState([]);
  const [interest, setInterest] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('board');
  const [q, setQ] = useState('');
  const [showQuiet, setShowQuiet] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const [d, b, i] = await Promise.all([
      supabase.from('deals').select('*', { count: 'exact' })
        .order('created_at', { ascending: false }).limit(DEAL_CAP),
      // Only what a card and the buyer column need. The buyers page owns the
      // rest of that table.
      supabase.from('buyers').select('id, name, entity_name').limit(5000),
      // Two columns across every deal — this feeds the dispo funnel, and
      // pulling whole interest rows to count them would move a lot of notes
      // and match reasons into the browser to be thrown away.
      supabase.from('buyer_deal_interest').select('deal_id, status', { count: 'exact' })
        .limit(INTEREST_CAP),
    ]);

    if (d.error) { setErr(d.error.message); setLoading(false); return; }
    setDeals(d.data ?? []);
    setBuyers(b.data ?? []);
    setInterest(i.data ?? []);

    // A failed read on either of these produces a plausible-looking page — no
    // buyer names, an empty funnel — and both of those are also what a genuinely
    // quiet month looks like. Say which one it is.
    const notes = [];
    const soft = b.error || i.error;
    if (soft) notes.push(`Part of this page could not load (${soft.message}). Buyer names and the dispo funnel may be missing.`);
    // The money view sums what it was handed. A truncated read reports a
    // pipeline smaller than the real one, and every number on that screen is
    // one somebody plans around.
    if (d.count != null && d.count > (d.data?.length ?? 0)) {
      notes.push(`Showing the ${d.data.length} most recent of ${d.count} deals. The money view below covers only those.`);
    }
    if (i.count != null && i.count > (i.data?.length ?? 0)) {
      notes.push(`The dispo funnel covers ${i.data.length} of ${i.count} buyer records.`);
    }
    setErr(notes.length ? notes.join(' ') : null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // deals is published to realtime, and a status move made on a detail page in
  // another tab — or by the dispo blast trigger — should land here without a
  // refresh, because this board is left open all day.
  useEffect(() => {
    const channel = supabase
      .channel('deals-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const buyerName = useMemo(() => {
    const map = new Map();
    for (const b of buyers) map.set(b.id, b.entity_name || b.name);
    return map;
  }, [buyers]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return deals;
    return deals.filter((d) =>
      [d.address, d.city, d.state, d.zip, d.county, d.title_company, buyerName.get(d.assigned_buyer_id)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)));
  }, [deals, q, buyerName]);

  if (loading) return <div className="empty">Loading deals…</div>;

  const columns = showQuiet ? [...BOARD_COLUMNS, ...QUIET_COLUMNS] : BOARD_COLUMNS;

  return (
    <>
      <header>
        <h1>Deals</h1>
        <span className="count">
          {shown.length === deals.length ? `${deals.length} total` : `${shown.length} of ${deals.length}`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <div className="viewtabs">
          <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
          <button className={view === 'money' ? 'on' : ''} onClick={() => setView('money')}>Money</button>
        </div>
        {view === 'board' && (
          <>
            <input
              placeholder="Search address, city, county, buyer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="tickbox">
              <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} />
              Show terminated
            </label>
          </>
        )}
        <button className="btn" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ New deal'}
        </button>
      </div>

      {creating && <NewDeal onErr={setErr} />}

      {view === 'money' ? <Money deals={deals} interest={interest} />
        : deals.length === 0 ? (
          <div className="empty">
            <strong>No deals yet</strong>
            A deal starts the moment a seller signs. Add the address and fill the rest in as you learn it.
          </div>
        )
        : shown.length === 0 ? (
          <div className="empty">
            <strong>Nothing matches that</strong>
            {`Searching ${deals.length} deals by address, city, county, title company and buyer.`}
          </div>
        )
        : <Board deals={shown} columns={columns} buyerName={buyerName} />}
    </>
  );
}

/* ── the board ─────────────────────────────────────────────────────────────
   Read-only, deliberately. The leads board drags because a stage move is one
   UPDATE with no preconditions; a deal status move is not. deals_enforce_
   transition refuses illegal moves, deals_assigned_needs_buyer refuses
   `assigned` without a buyer, and deals_closed_needs_close_date refuses
   `closed` without a close date — so a drop onto the wrong column is either a
   check_violation the operator cannot act on, or a prompt for two more facts
   in the middle of a drag gesture. The move lives on the detail page, where
   those facts are collected and written in the same UPDATE as the status. */
function Board({ deals, columns, buyerName }) {
  const grouped = useMemo(() => {
    const g = {};
    for (const d of deals) (g[d.status] ??= []).push(d);
    for (const list of Object.values(g)) list.sort(byUrgency);
    return g;
  }, [deals]);

  return (
    <div className="board">
      {columns.map((status) => {
        const cards = grouped[status] ?? [];
        return (
          <div key={status} className="boardcol">
            <div className="card">
              <h2 style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{dealStatusLabel(status)}</span>
                <span>{cards.length}</span>
              </h2>
              <div className="body boardcards">
                {cards.length === 0 && <p className="colempty">Empty</p>}
                {cards.map((d) => <DealCard key={d.id} deal={d} buyerName={buyerName} />)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Soonest binding date first, whichever of the two it is.
 *
 * Sorting by created_at like the leads board would put the deal that closes on
 * Friday underneath three that closes next month, which defeats the point of
 * putting the clocks on the card at all. A deal with neither date sinks to the
 * bottom — it is also the one thing on this page nobody can be late for.
 */
function byUrgency(a, b) {
  const key = (d) => {
    const days = [daysUntil(d.inspection_end_date), daysUntil(d.closing_date)].filter((v) => v != null);
    return days.length ? Math.min(...days) : Infinity;
  };
  const ka = key(a);
  const kb = key(b);
  // Compared rather than subtracted: two dateless deals both key to Infinity and
  // Infinity - Infinity is NaN, which is not a valid comparator result. V8
  // currently treats it as 0, but the spec does not say so, and the failure mode
  // is a board whose column order is arbitrary — on the one screen whose whole
  // job is putting the soonest deadline at the top.
  return ka === kb ? 0 : ka < kb ? -1 : 1;
}

function DealCard({ deal, buyerName }) {
  const buyer = deal.assigned_buyer_id ? buyerName.get(deal.assigned_buyer_id) : null;
  const settled = deal.status === 'closed';

  return (
    <div
      className="boardcard dealcard"
      onClick={() => navigate(`/deals/${deal.id}`)}
      role="button"
      tabIndex={0}
      // Space as well as Enter: a div with role="button" gets no key handling
      // from the browser, and Space is what a keyboard user presses on one.
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        navigate(`/deals/${deal.id}`);
      }}
    >
      <strong>{deal.address}</strong>
      <span className="sub">
        {[[deal.city, deal.state].filter(Boolean).join(', '), deal.zip].filter(Boolean).join(' ') || '—'}
      </span>

      {settled
        ? (
          <div className="clocks">
            <span className="clock ok"><span className="k">Closed</span> {dateOnly(deal.actual_close_date) || '—'}</span>
          </div>
        )
        : <Clocks deal={deal} />}

      <div className="dealmoney">
        <span>{deal.buyer_price == null ? 'No price yet' : `${money(deal.buyer_price)} to buyer`}</span>
        <strong>{money(settled ? deal.actual_assignment_fee : deal.target_assignment_fee)}</strong>
      </div>

      <span className="cardfoot">
        {buyer
          ? <span className="badge ok">{buyer}</span>
          : <span className="badge">No buyer</span>}
        {deal.exit_strategy !== 'assign' && <span className="badge">{titleize(deal.exit_strategy)}</span>}
        {deal.extension_count > 0 && (
          <span className="badge warm" title="Extensions signed on this contract">
            +{deal.extension_count} ext
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The two clocks, and the one piece of judgement on this page.
 *
 * An inspection deadline is not "missed" the way a closing date is — it simply
 * expires, and what makes it expensive is expiring while there is still nobody
 * to assign to, because that is the moment the earnest money stops being
 * refundable. So it shouts on a deal with no buyer lined up and reads as a
 * plain date on one that has one. Once it is past, it stops being a countdown
 * at all and becomes a fact worth knowing: the deposit is hard now.
 */
function Clocks({ deal }) {
  const insp = daysUntil(deal.inspection_end_date);
  const close = daysUntil(deal.closing_date);
  const covered = Boolean(deal.assigned_buyer_id) || deal.status === 'buyer_selected';

  const inspTone = insp == null ? 'none'
    : insp < 0 ? 'gone'
    : covered ? 'ok'
    : clockTone(insp, 'inspection');

  return (
    <div className="clocks">
      {insp != null && (
        <span className={`clock ${inspTone}`} title={`Inspection period ends ${dateOnly(deal.inspection_end_date)}`}>
          <span className="k">Inspection</span> {insp < 0 ? 'closed' : countdownLabel(insp)}
        </span>
      )}
      {close != null
        ? (
          <span className={`clock ${clockTone(close, 'closing')}`} title={`Closing ${dateOnly(deal.closing_date)}`}>
            <span className="k">Closing</span> {countdownLabel(close)}
          </span>
        )
        : <span className="clock none"><span className="k">Closing</span> not set</span>}
    </div>
  );
}

/**
 * One field, because that is genuinely all a deal needs to exist.
 *
 * Everything else — the numbers, the dates, the seller, the buyer — is learned
 * over the following days and typed on the detail page one click at a time. A
 * twenty-field new-deal form would be filled in with guesses, and guesses in
 * contract_price and closing_date are worse than blanks: the money view sums
 * one of them and the reminder ladder fires on the other.
 */
function NewDeal({ onErr }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const addr = address.trim();
    if (!addr || busy) return;
    setBusy(true);
    const { data, error } = await supabase
      .from('deals')
      .insert({ team_id: TEAM_ID, address: addr })
      .select('id')
      .single();
    setBusy(false);
    if (error) { onErr(error.message); return; }
    navigate(`/deals/${data.id}`);
  }

  return (
    <div className="card">
      <h2>New deal</h2>
      <p className="cardnote">
        It starts at <strong>draft</strong> — not under contract until the seller has signed.
      </p>
      <div className="body">
        <form onSubmit={submit} className="newdeal">
          <input
            autoFocus
            placeholder="Property address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!address.trim() || busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ── the money view ─────────────────────────────────────────────────────── */

function Money({ deals, interest }) {
  const m = useMemo(() => summarise(deals, interest), [deals, interest]);

  return (
    <>
      <div className="tiles">
        <Tile
          k="Contracted fee pipeline"
          v={money0(m.pipeline)}
          n={`${m.liveCount} live deal${m.liveCount === 1 ? '' : 's'}${m.noFee ? ` · ${m.noFee} with no fee set` : ''}`}
        />
        <Tile
          k="Collected, last 12 months"
          v={money0(m.collected12)}
          n={`${m.closed12} closed`}
        />
        <Tile
          k="Average fee"
          v={m.avgFee == null ? '—' : money0(m.avgFee)}
          n={m.closedAll ? `across ${m.closedAll} closed deal${m.closedAll === 1 ? '' : 's'}` : 'nothing closed yet'}
        />
        <Tile
          k="Contract to close"
          v={m.avgDays == null ? '—' : `${Math.round(m.avgDays)} days`}
          n={m.avgDaysN ? `${m.avgDaysN} with both dates recorded` : 'needs an executed and a close date'}
        />
      </div>

      <div className="card">
        <h2>Expected closes</h2>
        <p className="cardnote">
          Live contracts by the closing date on the contract, at the target fee. Nothing here has been
          collected — it is what lands if every one of them closes on time.
        </p>
        <div className="body">
          {m.expected.length === 0
            ? <p className="colempty">No live contracts.</p>
            : <Bars rows={m.expected} />}
          {m.undated > 0 && (
            <p className="fine" style={{ marginTop: 12 }}>
              {m.undated} live deal{m.undated === 1 ? ' has' : 's have'} no closing date, worth {money0(m.undatedFee)}.
              A contract with no closing date on it is a contract nobody is counting down to.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Collected by month</h2>
        <p className="cardnote">Actual assignment fees on closed deals, by the date they actually closed.</p>
        <div className="body">
          {m.collected.length === 0
            ? <p className="colempty">Nothing closed yet.</p>
            : <Bars rows={m.collected} />}
        </div>
      </div>

      <div className="card">
        <h2>Dispo conversion</h2>
        <p className="cardnote">
          Every buyer ever put on a deal, and how far each got. A wide top and a narrow bottom means the
          buy-box match is too loose — which is also the shape that gets a 10DLC campaign flagged.
        </p>
        <div className="body">
          {m.funnel[0].n === 0
            ? <p className="colempty">No deal has gone out to the buyers list yet.</p>
            : (
              <ul className="funnel">
                {m.funnel.map((f) => (
                  <li key={f.k}>
                    <span className="fk">{f.k}</span>
                    <span className="fbar"><i style={{ width: `${m.funnel[0].n ? (f.n / m.funnel[0].n) * 100 : 0}%` }} /></span>
                    <span className="fn">{f.n}</span>
                    <span className="fp">{m.funnel[0].n ? `${Math.round((f.n / m.funnel[0].n) * 100)}%` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          <p className="fine" style={{ marginTop: 12 }}>
            {m.assignedDeals} deal{m.assignedDeals === 1 ? '' : 's'} reached assigned or closed.
          </p>
        </div>
      </div>
    </>
  );
}

function Tile({ k, v, n }) {
  return (
    <div className="tile">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      <span className="n">{n}</span>
    </div>
  );
}

function Bars({ rows }) {
  const max = Math.max(...rows.map((r) => r.total), 1);
  return (
    <ul className="moneyrows">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="mlabel">{r.label}</span>
          <span className="mbar"><i style={{ width: `${(r.total / max) * 100}%` }} /></span>
          <span className="mval">{money0(r.total)}</span>
          <span className="mn">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything the money view shows, computed once.
 *
 * Deliberately in the browser rather than in SQL views: this is one team's
 * deals, a few hundred rows at most, and a view would be a second place the
 * definition of "pipeline" lives. When it is thousands of rows, the answer is
 * one reporting function, not four.
 *
 * The fee rule: a live deal is worth its target fee, a closed deal is worth
 * what was actually collected. Falling back to the target on a closed deal
 * would quietly report the number that was hoped for as the number that
 * arrived, which is the one substitution a money screen must never make.
 */
function summarise(deals, interest) {
  const live = deals.filter((d) => LIVE_STATUSES.includes(d.status));
  const closed = deals.filter((d) => d.status === 'closed');

  const pipeline = live.reduce((s, d) => s + (d.target_assignment_fee || 0), 0);
  const noFee = live.filter((d) => d.target_assignment_fee == null).length;

  const byMonth = (rows, dateOf, feeOf) => {
    const buckets = new Map();
    for (const d of rows) {
      const when = parseDateOnly(dateOf(d));
      if (!when) continue;
      const key = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
      const b = buckets.get(key) || {
        key,
        label: when.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        total: 0,
        count: 0,
      };
      b.total += feeOf(d) || 0;
      b.count += 1;
      buckets.set(key, b);
    }
    return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  };

  const expected = byMonth(live, (d) => d.closing_date, (d) => d.target_assignment_fee);
  const undatedRows = live.filter((d) => !d.closing_date);

  const collectedRows = byMonth(closed, (d) => d.actual_close_date, (d) => d.actual_assignment_fee);
  // Twelve months of history is what fits on a screen and what an operator
  // compares against. Older closings still count in the average fee below.
  const collected = collectedRows.slice(-12);

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const recent = closed.filter((d) => {
    const when = parseDateOnly(d.actual_close_date);
    return when && when >= cutoff;
  });

  const withFee = closed.filter((d) => d.actual_assignment_fee != null);
  const spans = closed
    .map((d) => [parseDateOnly(d.executed_date), parseDateOnly(d.actual_close_date)])
    .filter(([a, b]) => a && b)
    .map(([a, b]) => Math.round((b.getTime() - a.getTime()) / 86400000));

  const reached = (rank) => interest.filter((r) => (INTEREST_RANK[r.status] ?? 0) >= rank).length;

  return {
    pipeline,
    liveCount: live.length,
    noFee,
    collected12: recent.reduce((s, d) => s + (d.actual_assignment_fee || 0), 0),
    closed12: recent.length,
    avgFee: withFee.length ? withFee.reduce((s, d) => s + d.actual_assignment_fee, 0) / withFee.length : null,
    closedAll: closed.length,
    avgDays: spans.length ? spans.reduce((s, v) => s + v, 0) / spans.length : null,
    avgDaysN: spans.length,
    expected,
    undated: undatedRows.length,
    undatedFee: undatedRows.reduce((s, d) => s + (d.target_assignment_fee || 0), 0),
    collected,
    funnel: [
      { k: 'Blasted', n: interest.length },
      { k: 'Interested', n: reached(2) },
      { k: 'Offered', n: reached(3) },
      { k: 'Selected', n: reached(4) },
    ],
    assignedDeals: deals.filter((d) => d.status === 'assigned' || d.status === 'closed').length,
  };
}
