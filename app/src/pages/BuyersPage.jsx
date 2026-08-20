import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import useBulkSelect from '../lib/useBulkSelect.js';
import BulkBar from '../components/BulkBar.jsx';
import { stashSelection } from '../lib/campaignHandoff.js';
import { TEAM_ID } from '../lib/team.js';
import { titleize, formatPhone, dateOnly } from '../lib/format.js';
import {
  BUYER_STATUSES, BUYER_CONSENT_SOURCES,
  buyBoxLine, geography, textingBlock,
} from '../lib/buyers.js';

/**
 * The cash buyers list — the asset.
 *
 * A wholesaler with a good buyers list can move anything, and this page is the
 * list. It exists to answer two questions and is laid out for both:
 *
 *   "Who do I call first about this house?" — the buy box and the track record,
 *   reneges especially. A buyer who has closed six and reneged three has tied up
 *   three contracts past their inspection window; a list that shows only the six
 *   is the list that hands him the seventh.
 *
 *   "Who can I actually text?" — every row carries buyer_skip_reason. Consent is
 *   not a detail-page footnote here, because the dispo blast is a bulk send
 *   under an A2P campaign registered Low Volume Mixed, and the audience being
 *   segmented is the thing that keeps that campaign alive.
 */
/**
 * One read, no paging. A wholesaler's buyers list is hundreds, not hundreds of
 * thousands, and every filter and sort on this page runs in the browser over
 * the whole set — which is only honest while the whole set is actually here.
 * Hitting this ceiling is therefore reported on screen rather than absorbed.
 */
const PAGE_LIMIT = 1000;

export default function BuyersPage() {
  const [buyers, setBuyers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  // Defaults to active rather than all. Paused and blacklisted buyers are held
  // out of every match and every blast, so listing them by default puts people
  // you decided not to sell to at the top of the page you pick buyers from.
  // The count line says the view is filtered, so nobody thinks the list shrank.
  const [status, setStatus] = useState('active');
  const [county, setCounty] = useState('');
  // City, because that is how this list is actually organised: of the 70 buyers
  // imported from the previous CRM, 49 carry target cities and 6 carry a
  // county. Filtering by county alone hides most of the book.
  const [city, setCity] = useState('');
  const [minRating, setMinRating] = useState('');
  const [texting, setTexting] = useState('');
  const [sort, setSort] = useState('track');
  const [adding, setAdding] = useState(false);
  // Whether the read hit its own ceiling. A list that silently stops at a
  // round number is the same failure as a blast that silently drops 40 of 200
  // recipients: every count on the page is then a count of a subset, and
  // nothing says so.
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // skip_reason is public.buyer_skip_reason as a computed column, the same
      // way LeadDetail reads lead_is_dialable. The rule stays in one place: the
      // database. Re-deriving "may we text this" in JavaScript would mean this
      // page has no idea telephony_opt_outs exists until the day it matters.
      const { data, error } = await supabase
        .from('buyers')
        .select('*, skip_reason:buyer_skip_reason')
        .eq('trashed', false)
        .order('name')
        .limit(PAGE_LIMIT);

      if (cancelled) return;
      if (error) setErr(error.message);
      else {
        setBuyers(data ?? []);
        setTruncated((data ?? []).length >= PAGE_LIMIT);
      }
      setLoading(false);
    }

    load();

    // Catches consent recorded in another tab, a buyer edited on their own page,
    // an import landing — anything that writes the buyers row itself.
    //
    // It does NOT catch a STOP. A STOP lands in telephony_opt_outs and never
    // touches this table, so skip_reason changes underneath a row that emits no
    // event and the badge stays green until something else reloads the page.
    // That is tolerable only because nothing on this screen sends: the audience
    // is re-derived at materialise time and twilio-send-sms re-checks the
    // opt-out at the moment it sends. Do not add a send button here on the
    // strength of a badge this feed cannot keep current.
    const channel = supabase
      .channel('buyers-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'buyers' }, load)
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  /**
   * Every county anybody named, for the filter.
   *
   * Deduped case-insensitively because the buy-box arrays are typed by hand and
   * matched with text_array_contains_ci — 'Chatham' and 'chatham' are one place
   * to the matcher, so offering them as two filter options would be this page
   * inventing a distinction the database does not make.
   */
  const cities = useMemo(() => {
    const seen = new Map();
    for (const b of buyers) {
      for (const c of b.cities || []) {
        const key = c.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, c.trim());
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [buyers]);

  const counties = useMemo(() => {
    const seen = new Map();
    for (const b of buyers) {
      for (const c of b.counties || []) {
        const key = c.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, c.trim());
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [buyers]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const wantCounty = county.trim().toLowerCase();
    const wantCity = city.trim().toLowerCase();
    const wantRating = minRating === '' ? null : Number(minRating);

    const rows = buyers.filter((b) => {
      if (status && b.status !== status) return false;
      // textingBlock(), not `b.skip_reason == null`. The two disagree in exactly
      // one case and it is the dangerous one: a row that arrived without the
      // computed column at all reads as null under `==`, so a bare comparison
      // puts a buyer nobody can vouch for into a list the operator asked for by
      // the name "textable now" and then hands to a blast. textingBlock() calls
      // that case "cannot tell" and it lands here on the not-textable side,
      // which is where the row badge already puts it.
      if (texting === 'yes' && textingBlock(b) !== null) return false;
      if (texting === 'no' && textingBlock(b) === null) return false;
      if (wantCounty && !(b.counties || []).some((c) => c.trim().toLowerCase() === wantCounty)) return false;
      if (wantCity && !(b.cities || []).some((c) => c.trim().toLowerCase() === wantCity)) return false;
      // An unrated buyer fails a minimum rather than passing it. "3 and up"
      // asked for buyers you have vouched for, and a blank rating is the
      // absence of that judgement, not a passing one.
      if (wantRating !== null && !(b.rating >= wantRating)) return false;
      if (!needle) return true;
      return [b.name, b.entity_name, b.email, b.phone, b.phone_secondary, b.notes,
        ...(b.counties || []), ...(b.cities || []), ...(b.zips || []), ...(b.property_types || [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });

    // Sorted copy — Array.sort mutates, and mutating the state array here would
    // reorder `buyers` behind the memo and make the next render disagree with
    // this one.
    return [...rows].sort(COMPARATORS[sort] || COMPARATORS.name);
  }, [buyers, q, status, county, city, minRating, texting, sort]);

  // Counted over what is on screen, not over the whole list. The number is read
  // as "how big is the audience I am looking at", and answering it about a set
  // the operator cannot see would overstate every filtered view. Through
  // textingBlock() for the same reason the filter is: this number gets quoted
  // as an audience size, and the one direction it must never be wrong in is up.
  const textable = shown.filter((b) => textingBlock(b) === null).length;

  const sel = useBulkSelect(shown);

  if (loading) return <div className="empty">Loading buyers…</div>;

  return (
    <>
      <header>
        <h1>Buyers</h1>
        <span className="count">
          {shown.length === buyers.length ? `${buyers.length} total` : `${shown.length} of ${buyers.length}`}
          {shown.length > 0 && ` · ${textable} textable`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {truncated && (
        <div className="err">
          Showing the first {PAGE_LIMIT} buyers by name. There are more, and every count and filter
          on this page describes only the ones that loaded — do not read the textable number as the
          size of your list.
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Search name, entity, phone, county, zip, notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          {BUYER_STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        {counties.length > 0 && (
          <select value={county} onChange={(e) => setCounty(e.target.value)}>
            <option value="">Any county</option>
            {counties.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {cities.length > 0 && (
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="">Any city</option>
            {cities.map((c) => <option key={c} value={c}>{titleize(c)}</option>)}
          </select>
        )}
        <select value={minRating} onChange={(e) => setMinRating(e.target.value)}>
          <option value="">Any rating</option>
          {[5, 4, 3, 2].map((r) => <option key={r} value={r}>{r} stars and up</option>)}
        </select>
        <select value={texting} onChange={(e) => setTexting(e.target.value)}>
          <option value="">Textable or not</option>
          <option value="yes">Textable now</option>
          <option value="no">Not textable</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {Object.entries(SORT_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <button className="btn" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add buyer'}
        </button>
      </div>

      {adding && <AddBuyer onCancel={() => setAdding(false)} />}

      <div className="card">
        {/* No onDone: the buyers realtime channel above reloads on any UPDATE
            to the table, and a trash is exactly that. */}
        <BulkBar
          table="buyers"
          sel={sel}
          onError={setErr}
          onText={(ids) => { stashSelection('buyers', ids); navigate('/campaigns'); }}
        />
        {shown.length === 0 ? (
          <div className="empty">
            <strong>{buyers.length ? 'Nothing matches those filters' : 'No buyers yet'}</strong>
            {buyers.length === 0
              && 'Add the ones you already know. Name plus a phone number is enough to start — the buy box can be filled in on the next call.'}
          </div>
        ) : (
          <table className="leads">
            <thead>
              <tr>
                <th className="pick">
                  <input
                    type="checkbox"
                    aria-label={sel.allSelected ? 'Deselect all' : 'Select all'}
                    checked={sel.allSelected}
                    onChange={(e) => sel.toggleAll(e.target.checked)}
                  />
                </th>
                <th>Buyer</th>
                <th>Buy box</th>
                <th>Track record</th>
                <th className="hide-sm">Last bought</th>
                <th>Texting</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => <BuyerRow key={b.id} buyer={b} sel={sel} />)}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * Sort orders, and the default is not alphabetical on purpose.
 *
 * Finding one named buyer is what the search box is for. What the list is for
 * is deciding who hears about the next deal first, and that ordering is: most
 * closings, then fewest reneges as the tie-break — the same order
 * match_buyers_for_deal() breaks ties in, so the two screens rank the same
 * people the same way.
 */
const SORT_LABELS = {
  track: 'Best track record',
  reneged: 'Most reneges first',
  recent: 'Recently bought',
  name: 'Name',
};

const COMPARATORS = {
  track: (a, b) => (b.deals_closed - a.deals_closed)
    || (a.deals_reneged - b.deals_reneged)
    || a.name.localeCompare(b.name),
  reneged: (a, b) => (b.deals_reneged - a.deals_reneged) || a.name.localeCompare(b.name),
  // Nulls last: a buyer who has never bought is not the most recent buyer.
  recent: (a, b) => cmpDateDesc(a.last_purchase_date, b.last_purchase_date)
    || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};

function cmpDateDesc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(b) - new Date(a);
}

function BuyerRow({ buyer, sel }) {
  const block = textingBlock(buyer);
  const where = geography(buyer);
  const box = buyBoxLine(buyer);

  return (
    <tr
      onClick={() => navigate(`/buyers/${buyer.id}`)}
      style={{ cursor: 'pointer' }}
      className={sel.isSelected(buyer.id) ? 'picked' : undefined}
    >
      {/* stopPropagation, or ticking the box opens the buyer */}
      <td className="pick" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${buyer.name}`}
          checked={sel.isSelected(buyer.id)}
          onChange={(e) => sel.toggle(buyer.id, e.target.checked)}
        />
      </td>
      <td>
        <span className="addr">{buyer.name}</span>
        <span className="sub">
          {[buyer.entity_name, formatPhone(buyer.phone) || buyer.email].filter(Boolean).join(' · ') || '—'}
        </span>
      </td>
      <td>
        {/* No geography means no restriction — the schema is explicit that an
            empty array matches everywhere. A blank cell here would teach the
            operator the opposite, and they would stop putting new buyers on
            lists that in fact include them. */}
        <span className="buybox">{where || <span className="anyw">Anywhere</span>}</span>
        <span className="sub">{box || 'No limits set'}</span>
      </td>
      <td>
        <span className="record">
          <span className="n">{buyer.deals_closed}</span> closed
          {/* Reneges are the number this page exists to surface. Red, on the
              row, not folded into a score — the operator has to see it while
              they are deciding who to call. */}
          {buyer.deals_reneged > 0 && (
            <span className="badge stop">{buyer.deals_reneged} reneged</span>
          )}
        </span>
        <span className="sub">
          {buyer.avg_close_days != null ? `${Math.round(buyer.avg_close_days)}d avg close` : 'no close history'}
          {buyer.rating != null ? ` · ${buyer.rating}/5` : ''}
        </span>
      </td>
      {/* dateOnly, not timeAgo: last_purchase_date is a `date`, and new Date()
          reads a bare date as UTC midnight — which is the previous evening
          everywhere in the US, so "bought today" renders as "20h ago". */}
      <td className="hide-sm sub">
        {buyer.last_purchase_date ? dateOnly(buyer.last_purchase_date) : 'never'}
      </td>
      <td>
        {block
          ? <span className="badge stop">{block.words}</span>
          : <span className="badge ok">Textable</span>}
      </td>
    </tr>
  );
}

/**
 * Adding a buyer, in the thirty seconds you actually have.
 *
 * This is filled in while the buyer is still on the phone, so it asks for four
 * things and nothing else — the buy box is worth more when it is typed after a
 * real conversation than when it is guessed at to get past a form. The database
 * agrees: every buy-box column is nullable and every array defaults to empty,
 * which means "no restriction", so a buyer added in a hurry still appears on
 * lists rather than silently matching nothing.
 *
 * Consent is optional here and it is the one field that is not just data entry.
 * If they said "text me deals" it goes on the record now, with how they said it,
 * through record_buyer_consent() — the same RPC the buyer page uses. If they did
 * not, the buyer is on the list and simply is not blastable, which is the honest
 * state and is visible on their row from the moment they exist.
 */
function AddBuyer({ onCancel }) {
  const [f, setF] = useState({ name: '', entity_name: '', phone: '', email: '' });
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const clean = (v) => (v.trim() === '' ? null : v.trim());
  // Mirrors the buyers_has_contact CHECK. Better to grey the button than to let
  // the operator type a whole row and be handed a constraint name.
  const reachable = f.phone.trim() !== '' || f.email.trim() !== '';
  const ready = f.name.trim() !== '' && reachable;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);

    const { data, error } = await supabase
      .from('buyers')
      .insert({
        team_id: TEAM_ID,
        name: f.name.trim(),
        entity_name: clean(f.entity_name),
        phone: clean(f.phone),
        email: clean(f.email),
      })
      .select('id')
      .single();

    if (error) {
      setBusy(false);
      // buyers_team_phone_key_idx. The raw message names an index, which tells
      // the operator nothing about the fact that this buyer is already on the
      // list under a different spelling of their name.
      setErr(/buyers_team_phone_key_idx/.test(error.message)
        ? 'Someone on the list already has that number. Search for it — this buyer is probably already here under another name.'
        : error.message);
      return;
    }

    if (source.trim()) {
      const { error: consentErr } = await supabase.rpc('record_buyer_consent', {
        p_buyer_id: data.id,
        p_source: source.trim(),
      });
      // The buyer exists either way, so this is a warning and not a rollback.
      // Rolling back a good contact record because the consent write failed
      // would lose the more valuable of the two.
      if (consentErr) {
        setBusy(false);
        setErr(`Buyer saved, but the consent record failed: ${consentErr.message}. Record it on their page.`);
        return;
      }
    }

    navigate(`/buyers/${data.id}`);
  }

  return (
    <div className="card">
      <h2>New buyer</h2>
      <p className="cardnote">
        Name and one way to reach them is enough. The buy box is worth more typed after a real
        conversation than guessed at now, and an empty buy box means no restriction — they still
        show up on every match.
      </p>
      <div className="body">
        <form onSubmit={submit}>
          <div className="fields">
            <label>Name<input value={f.name} onChange={set('name')} autoFocus autoComplete="off" /></label>
            <label>Entity<input value={f.entity_name} onChange={set('entity_name')} placeholder="Blue Door Capital LLC" autoComplete="off" /></label>
            <label>Phone<input value={f.phone} onChange={set('phone')} type="tel" autoComplete="off" /></label>
            <label>Email<input value={f.email} onChange={set('email')} type="email" autoComplete="off" /></label>
            <label className="wide">
              Did they agree to be texted about deals? Optional — and it is the difference between a
              contact and a buyer you can blast.
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Not yet — add them without SMS consent</option>
                {BUYER_CONSENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>

          {!reachable && f.name.trim() !== '' && (
            <p className="fine">A buyer needs a phone number or an email — the database refuses a row with neither.</p>
          )}
          {err && <div className="err" style={{ marginTop: 13 }}>{err}</div>}

          <div className="confirmbtns" style={{ marginTop: 15 }}>
            <button className="btn" type="submit" disabled={!ready || busy}>
              {busy ? 'Saving…' : 'Add buyer'}
            </button>
            <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
