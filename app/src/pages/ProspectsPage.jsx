import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import useBulkSelect from '../lib/useBulkSelect.js';
import BulkBar from '../components/BulkBar.jsx';
import { useCan } from '../lib/capabilities.jsx';
import { formatPhone, timeAgo, titleize } from '../lib/format.js';
import './prospects.css';

/**
 * The cold-list working surface.
 *
 * A prospect is a row on a list Tossie bought. Nobody has agreed to hear from
 * us, so this screen is not a smaller Leads page — it is a different object with
 * a different set of things you are allowed to do to it, and the two rules it
 * exists to hold are:
 *
 *   1. A prospect may be CALLED only after skip trace AND the DNC + litigator
 *      scrub. Everything above the table is about which of those has happened,
 *      because a list that has been paid for but not traced is not a work queue
 *      and showing its rows as if it were is how an operator spends a morning
 *      opening records with no phone number on them.
 *   2. A prospect may NEVER be TEXTED. Not a policy this page enforces — there
 *      is no prospect_is_textable(), no send path that accepts a prospect id,
 *      and no consent column on the table to hold the answer. The line saying
 *      so is here so nobody goes looking for the button and concludes it was
 *      an oversight.
 *
 * There is no bulk convert and there must never be one. Conversion writes a
 * consent record, a consent record needs a person who can say where it came
 * from, and that person can only say it about a conversation they had. It lives
 * on the detail page, one prospect at a time, behind a form that asks how.
 */

/**
 * One read, capped, and the cap is reported on screen.
 *
 * Cold lists run to thousands of rows, so unlike the buyers list this window is
 * genuinely a window. The filters below run server-side precisely so the cap is
 * spent on rows the operator asked for rather than on the front of the table.
 */
const PAGE_LIMIT = 500;

/**
 * The distress data is the whole reason a wholesaler buys a list, so it is a
 * filter and not a column of ticks nobody can search.
 *
 * `urgent` only drives colour. Pre-foreclosure and tax delinquency are the two
 * that put a clock on the seller's decision, which is what makes them the rows
 * worth dialing first — the rest describe a situation, these describe a deadline.
 */
export const DISTRESS_FLAGS = [
  { key: 'pre_foreclosure', label: 'Pre-foreclosure', urgent: true },
  { key: 'tax_delinquent',  label: 'Tax delinquent',  urgent: true },
  { key: 'vacant',          label: 'Vacant' },
  { key: 'is_absentee',     label: 'Absentee' },
  { key: 'is_out_of_state', label: 'Out of state' },
  { key: 'bankruptcy',      label: 'Bankruptcy' },
  { key: 'liens',           label: 'Liens' },
];

/**
 * The call_status CHECK constraint's list, spelled the way an operator says it.
 *
 * Not run through titleize(): 'Hot lead' and 'Left voicemail' happen to survive
 * it, but 'not_called' becomes 'Not called' when what this column means on an
 * untouched list is 'Never dialed', and the difference is whether the operator
 * reads the default as a state or as an outcome.
 */
export const CALL_STATUSES = [
  { key: 'not_called',      label: 'Never dialed' },
  { key: 'no_answer',       label: 'No answer' },
  { key: 'left_voicemail',  label: 'Left voicemail' },
  { key: 'called',          label: 'Reached them' },
  { key: 'callback',        label: 'Callback booked' },
  { key: 'appointment_set', label: 'Appointment set' },
  { key: 'hot_lead',        label: 'Hot' },
  { key: 'not_interested',  label: 'Not interested' },
  { key: 'wrong_number',    label: 'Wrong number' },
];

const CALL_STATUS_LABEL = Object.fromEntries(CALL_STATUSES.map((s) => [s.key, s.label]));
export const callStatusLabel = (s) => CALL_STATUS_LABEL[s] || titleize(s);

/**
 * Mirrors public.phone_key(): the last ten digits, never the formatted number.
 *
 * Same reasoning as the copy on LeadDetail — telephony_opt_outs stores keys
 * because Twilio posts +19125550134 and the homeowner said (912) 555-0134.
 * Matching on anything else shows "no opt-out on file" for somebody who is in
 * fact suppressed, which is the one direction these pages must never be wrong in.
 */
export function phoneKey(v) {
  return String(v ?? '').replace(/\D/g, '').slice(-10) || null;
}

/**
 * Why this prospect cannot be dialed, in words, or null when it can be.
 *
 * The database is the authority on the answer and this function never argues
 * with it: `p.callable` is public.prospect_is_callable() read off the row as a
 * computed column, exactly the way LeadDetail reads lead_is_dialable, and a
 * true from it ends the question. What the ladder below adds is *which* rail is
 * holding, because "not callable" is four different problems with four
 * different next actions — buy a trace, run the scrub, delete the row, or leave
 * it alone forever.
 *
 * Ordered by expense, not by how the function is written. The litigator hit
 * comes before the DNC flag because a serial TCPA plaintiff is the one that
 * costs $1,500 a call and they seed their numbers onto exactly the absentee and
 * pre-foreclosure lists this page is full of.
 *
 * `optOuts` is only ever populated on the detail page, which loads the
 * suppression rows for this prospect's numbers. The list page passes nothing
 * and loses no accuracy by it: prospect_is_callable() already consulted
 * telephony_opt_outs server-side, so `callable` is false either way — the
 * detail page just gets to name the number that caused it.
 *
 * A missing `callable` — a row that arrived without the computed column at all
 * — lands on the not-callable side, the same discipline BuyersPage's
 * textingBlock() uses. "We could not check" and "we checked and it is fine"
 * must never render identically when one of them is a call nobody vetted.
 */
export function callBlock(p, optOuts = []) {
  if (!p) return 'No prospect';
  if (p.callable === true) return null;

  if (p.converted_at) return 'Already a lead — work it there';
  if (!(p.phone_mobile || p.phone_landline || p.phone_voip)) return 'No number on file';
  // A number the owner handed over takes the other branch of
  // prospect_is_callable and needs neither of these. Reporting "not skip
  // traced" for such a row would name a step that is not the blocker and send
  // the operator off to run a trace that would change nothing.
  if (!p.phone_from_owner) {
    if (!p.skip_traced) return 'Not skip traced';
    if (!p.dnc_scrubbed) return 'Not DNC scrubbed';
  }
  if (p.is_litigator) return 'Known TCPA litigator';
  if (p.is_dnc) return 'On the do-not-call list';

  const hit = optOuts.find((o) => [p.phone_mobile, p.phone_landline, p.phone_voip]
    .some((n) => n && phoneKey(n) === o.phone_key));
  if (hit) return 'Asked us to stop';

  if (p.callable === false) return 'A number on this row is suppressed';
  return 'Cannot tell — the callable check did not load';
}

export default function ProspectsPage() {
  const [lists, setLists] = useState([]);
  // Tracked separately from `loading`, which is about the rows. Without it, the
  // rows finishing first renders "No cold lists yet" over a team that has six
  // of them, and the operator's next move is to import a list they already own.
  const [listsReady, setListsReady] = useState(false);
  // And separately from `err`, which the rows share and clear on their next
  // success. A failed list read leaves `lists` empty, so folding it into `err`
  // produced the same wrong screen 220ms later: the message wiped by the rows
  // loading fine, and "No cold lists yet" standing over six lists that are
  // simply unread. An empty answer and an unanswered question are not the same.
  const [listsErr, setListsErr] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [truncated, setTruncated] = useState(false);

  const [listId, setListId] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [callable, setCallable] = useState('');
  const [flags, setFlags] = useState([]);

  /**
   * The lists and their counters.
   *
   * Separate from the rows because the two change on completely different
   * clocks: the counters move when a skip-trace batch finishes or somebody
   * converts, and the rows move when the operator types in the search box.
   */
  const loadLists = useCallback(async () => {
    const { data, error } = await supabase
      .from('prospect_lists')
      .select('*')
      .eq('trashed', false)
      .order('created_at', { ascending: false });
    setListsReady(true);
    if (error) { setListsErr(`Could not load the cold lists (${error.message}).`); return; }
    setListsErr(null);
    setLists(data ?? []);
  }, []);

  useEffect(() => {
    loadLists();

    /**
     * prospect_lists is published to supabase_realtime and prospects is not,
     * and that asymmetry is deliberate in the migration: a skip-trace batch
     * writing five thousand rows would push five thousand messages at a browser
     * that only wants to watch one number change. So the counters arrive live
     * and the rows do not. When a trace lands, the ladder above the table moves
     * on its own; the table itself is one Refresh away, which is the right cost
     * for the rarer of the two.
     */
    const channel = supabase
      .channel('prospect-lists-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prospect_lists' }, loadLists)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadLists]);

  const loadRows = useCallback(async () => {
    setLoading(true);

    // `callable:prospect_is_callable` is the database function as a computed
    // column. Never re-derived here — a rule with two implementations has one
    // that is stale, and the stale one on this page would be the copy that has
    // not heard of telephony_opt_outs.
    let query = supabase
      .from('prospects')
      .select('*, callable:prospect_is_callable')
      .eq('trashed', false)
      .order('created_at', { ascending: false })
      .limit(PAGE_LIMIT);

    if (listId) query = query.eq('list_id', listId);
    if (status) query = query.eq('call_status', status);
    // Flags are ANDed, which is what an operator means by ticking two of them:
    // "vacant AND out of state" is a tighter, better list than either alone, and
    // it is the combination that makes a cold call worth placing.
    for (const f of flags) query = query.eq(f, true);

    /**
     * Search runs server-side rather than over the loaded window, because the
     * window is 500 rows of a list that may hold five thousand — a client-side
     * search would confidently report "no such address" about a row it never
     * fetched.
     *
     * The needle is stripped of the characters PostgREST's or() syntax uses as
     * structure. An operator searching for a house types "412 Bull" and never
     * "412,Bull(", so nothing real is lost, and the alternative is a filter
     * string that parses as something other than what was typed.
     */
    const needle = q.trim().replace(/[,()."':*\\]/g, ' ').trim();
    if (needle) {
      query = query.or(
        ['address', 'city', 'zip', 'county', 'owner_name', 'vendor_id',
          'phone_mobile', 'phone_landline', 'phone_voip']
          .map((c) => `${c}.ilike.%${needle}%`)
          .join(','),
      );
    }

    const { data, error } = await query;
    if (error) {
      // The rows already on screen stay there. An empty table and a table that
      // failed to load look identical, and only one of them means this list has
      // nothing left to work.
      setErr(`Could not load prospects (${error.message}). What is shown below may be out of date.`);
      setLoading(false);
      return;
    }
    setErr(null);
    setRows(data ?? []);
    setTruncated((data ?? []).length >= PAGE_LIMIT);
    setLoading(false);
  }, [listId, status, flags, q]);

  // Debounced because this fires on every keystroke in the search box and each
  // run is a round trip against a table with thousands of rows in it.
  useEffect(() => {
    const t = setTimeout(loadRows, 220);
    return () => clearTimeout(t);
  }, [loadRows]);

  const list = useMemo(() => lists.find((l) => l.id === listId) || null, [lists, listId]);

  /**
   * The counters, either for the chosen list or summed across all of them.
   *
   * Read off prospect_lists rather than counted from `rows`, because `rows` is
   * a filtered 500-row window and these numbers are being used to decide
   * whether a list is workable at all. refresh_prospect_list_counts() is what
   * keeps them true; if they ever look wrong, that is the function to call.
   */
  const counts = useMemo(() => {
    const src = list ? [list] : lists;
    const sum = (k) => src.reduce((n, l) => n + (l[k] || 0), 0);
    return {
      total: sum('total_count'),
      traced: sum('skip_traced_count'),
      scrubbed: sum('scrubbed_count'),
      called: sum('called_count'),
      converted: sum('converted_count'),
    };
  }, [list, lists]);

  const shown = useMemo(() => {
    if (!callable) return rows;
    // callBlock(), not `row.callable === true`. They differ on a row that came
    // back without the computed column, and a bare comparison would put an
    // unvetted prospect into a queue the operator asked for by the name
    // "callable now" and then dial it.
    return rows.filter((p) => (callBlock(p) === null) === (callable === 'yes'));
  }, [rows, callable]);

  const callableInView = useMemo(() => rows.filter((p) => callBlock(p) === null).length, [rows]);

  const sel = useBulkSelect(shown);

  const toggleFlag = (key) =>
    setFlags((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));

  return (
    <>
      <header>
        <h1>Prospects</h1>
        <span className="count">
          {list ? list.name : `${lists.length} list${lists.length === 1 ? '' : 's'}`}
          {counts.total > 0 && ` · ${counts.total.toLocaleString()} rows`}
        </span>
      </header>

      {listsErr && <div className="err">{listsErr}</div>}
      {err && <div className="err">{err}</div>}

      {/* The sentence that has to survive every redesign of this page. It is a
          statement of what the system is, not a warning about what to avoid:
          there is nothing here to click that would text anybody, because no
          such path exists to click. */}
      <div className="pr-cold">
        <strong>Nobody on this page has agreed to hear from us.</strong>{' '}
        A prospect can be <strong>called</strong>, once it has been skip traced and scrubbed against
        the DNC and litigator files. A prospect can never be texted — there is no send path in the
        product that accepts one, and Tossie&rsquo;s A2P campaign is registered for appointment
        reminders, which cold outreach is not. Texting starts when someone becomes a lead, and that
        happens one conversation at a time.
      </div>

      {listsReady && !listsErr && lists.length === 0 ? (
        <div className="card">
          <div className="empty">
            <strong>No cold lists yet</strong>
            A purchased or scraped list lands here, not in Leads. Bring one in from{' '}
            <a href="/app/import">Import</a>.
          </div>
        </div>
      ) : (
        <>
          <ListBar
            lists={lists}
            listId={listId}
            onPick={setListId}
            onDeleted={() => { setListId(''); loadLists(); loadRows(); }}
            onError={setErr}
          />
          <ScrubLadder
            counts={counts}
            callableInView={callableInView}
            windowed={truncated || rows.length < counts.total}
          />
          <NextAction list={list} lists={lists} counts={counts} onRan={loadRows} />

          <div className="toolbar">
            <input
              placeholder="Search address, owner, city, zip, county, vendor id, number…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any call status</option>
              {CALL_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <select value={callable} onChange={(e) => setCallable(e.target.value)}>
              <option value="">Callable or not</option>
              <option value="yes">Callable now</option>
              <option value="no">Not callable yet</option>
            </select>
            <button className="btn ghost" onClick={loadRows} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          <div className="pr-flagbar">
            <span className="pr-lbl">Distress</span>
            {DISTRESS_FLAGS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`pr-flagchip${flags.includes(f.key) ? ' on' : ''}`}
                onClick={() => toggleFlag(f.key)}
              >
                {f.label}
              </button>
            ))}
            {flags.length > 0 && (
              <button type="button" className="linkbtn" onClick={() => setFlags([])}>Clear</button>
            )}
          </div>

          {truncated && (
            <div className="err">
              Showing the newest {PAGE_LIMIT} rows that match. There are more, and every number on
              this screen taken from the table below — including &ldquo;callable in view&rdquo; —
              describes only the rows that loaded. Narrow with a list, a status or a distress flag
              rather than reading these as totals.
            </div>
          )}

          <div className="card">
            <BulkBar table="prospects" sel={sel} onDone={loadRows} onError={setErr} />
            {loading && rows.length === 0 ? (
              <div className="empty">Loading prospects…</div>
            ) : shown.length === 0 ? (
              <div className="empty">
                <strong>{rows.length ? 'Nothing matches those filters' : 'No prospects on this list'}</strong>
                {rows.length > 0 && callable === 'yes'
                  && 'Nothing here is dialable yet. That is a skip-trace and scrub problem, not a filter problem.'}
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
                    <th>Property</th>
                    <th>Owner</th>
                    <th>Best number</th>
                    <th className="hide-sm">Calls</th>
                    <th>Dialable</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => <ProspectRow key={p.id} p={p} sel={sel} />)}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

/* ── the lists ───────────────────────────────────────────────────────────── */

/**
 * Lists as chips rather than a dropdown, because each one carries the number
 * that decides whether to open it — how many of its rows survived the scrub.
 * A dropdown hides exactly that, and the operator picks by name and finds out
 * afterwards.
 */
function ListBar({ lists, listId, onPick, onDeleted, onError }) {
  const { can } = useCan();
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  if (lists.length === 0) return null;

  /**
   * Deleting a list takes its prospects with it.
   *
   * Through the RPC rather than a plain update, because the two have to move
   * together and come back together: prospects.list_id is ON DELETE CASCADE, so
   * a list that is gone from the chips while its three thousand rows still fill
   * the table below is the worst of both. set_prospect_list_trashed marks
   * exactly the rows it trashed so restoring the list restores those and not a
   * prospect somebody deleted by hand last week.
   */
  async function del(list) {
    setBusy(true);
    const { error } = await supabase.rpc('set_prospect_list_trashed', {
      p_list_id: list.id,
      p_trashed: true,
    });
    if (error) onError?.(error.message);
    else onDeleted?.();
    setBusy(false);
    setConfirming(null);
  }

  const target = lists.find((l) => l.id === confirming);

  return (
    <div className="pr-listbar">
      <button
        type="button"
        className={`pr-listchip${listId === '' ? ' on' : ''}`}
        onClick={() => onPick('')}
      >
        <b>Every list</b>
        <span>{lists.length} list{lists.length === 1 ? '' : 's'}</span>
      </button>
      {lists.map((l) => (
        <button
          key={l.id}
          type="button"
          className={`pr-listchip${listId === l.id ? ' on' : ''}`}
          onClick={() => onPick(l.id)}
        >
          <b>{l.name}</b>
          <span>
            {[
              `${(l.total_count || 0).toLocaleString()} rows`,
              // The scrub is the fact worth putting on the chip. "3,000 rows"
              // reads as three thousand calls; "0 scrubbed" is what it actually is.
              l.total_count ? `${(l.scrubbed_count || 0).toLocaleString()} scrubbed` : null,
              l.status === 'archived' ? 'archived' : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </button>
      ))}

      {/* Deleting the *selected* list only. A delete control on every chip is a
          row of destructive buttons you brush past while picking a list. */}
      {listId && target && can('prospects.delete') && (
        confirming === listId ? (
          <span className="confirmdelete" style={{ marginLeft: 8 }}>
            <span>
              Delete <strong>{target.name}</strong> and its
              {' '}{(target.total_count || 0).toLocaleString()} prospects? Both move to Trash together.
            </span>
            <button className="btn danger" disabled={busy} onClick={() => del(target)}>
              {busy ? 'Deleting…' : 'Delete list'}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          </span>
        ) : (
          <button
            type="button"
            className="btn ghost danger"
            style={{ marginLeft: 8, alignSelf: 'center' }}
            onClick={() => setConfirming(listId)}
          >
            Delete list
          </button>
        )
      )}
    </div>
  );
}

/**
 * Bought → traced → scrubbed → callable → called → converted.
 *
 * The pipeline in the order it happens, above the rows, because the question
 * this page is opened with is "can I work this today" and the rows cannot
 * answer it — a screen of addresses looks identical whether or not a single one
 * of them has a phone number attached.
 *
 * Callable is the only tile counted from the loaded rows rather than from the
 * list counters, because prospect_is_callable() consults telephony_opt_outs per
 * row and there is no counter for it. When the window is short of the whole
 * list the tile says so instead of quietly reporting a subset as a total.
 */
function ScrubLadder({ counts, callableInView, windowed }) {
  const pct = (n) => (counts.total ? Math.round((n / counts.total) * 100) : 0);
  const tracedPct = pct(counts.traced);
  const scrubbedPct = pct(counts.scrubbed);

  return (
    <div className="pr-ladder">
      <div className="pr-step">
        <b>{counts.total.toLocaleString()}</b>
        <span>bought</span>
      </div>
      <div className={`pr-step${counts.total && counts.traced >= counts.total ? ' done' : counts.traced === 0 ? ' waiting' : ''}`}>
        <b>{counts.traced.toLocaleString()}</b>
        <span>skip traced · {tracedPct}%</span>
        <div className={`pr-bar${tracedPct < 100 ? ' warn' : ''}`}><div style={{ width: `${tracedPct}%` }} /></div>
      </div>
      <div className={`pr-step${counts.total && counts.scrubbed >= counts.total ? ' done' : counts.scrubbed === 0 ? ' waiting' : ''}`}>
        <b>{counts.scrubbed.toLocaleString()}</b>
        <span>DNC + litigator scrubbed · {scrubbedPct}%</span>
        <div className={`pr-bar${scrubbedPct < 100 ? ' warn' : ''}`}><div style={{ width: `${scrubbedPct}%` }} /></div>
      </div>
      <div className="pr-step hero">
        <b>{callableInView.toLocaleString()}</b>
        <span>{windowed ? 'dialable in view' : 'dialable now'}</span>
      </div>
      <div className="pr-step">
        <b>{counts.called.toLocaleString()}</b>
        <span>dialed at least once</span>
      </div>
      <div className="pr-step">
        <b>{counts.converted.toLocaleString()}</b>
        <span>became leads</span>
      </div>
    </div>
  );
}

/**
 * What has to happen next, and the control that does it.
 *
 * This block is the answer to the question the page is opened with. It appears
 * only while something is unready, and it disappears the moment the list is
 * fully traced and scrubbed — a permanent banner is a banner nobody reads.
 */
function NextAction({ list, lists, counts, onRan }) {
  if (counts.total === 0) {
    if (lists.length === 0) return null;
    return (
      <div className="pr-next">
        <h2>{list ? `${list.name} is empty` : 'No rows on any list'}</h2>
        <p>
          The list exists but nothing has been imported into it. Cold data comes in through{' '}
          <a href="/app/import">Import</a>, which is also where an opted-in list from a previous CRM
          goes in as leads instead of prospects.
        </p>
      </div>
    );
  }

  const untraced = Math.max(counts.total - counts.traced, 0);
  const unscrubbed = Math.max(counts.total - counts.scrubbed, 0);
  if (untraced === 0 && unscrubbed === 0) return null;

  // Nothing at all has been scrubbed: not "partly ready", simply not workable.
  const blocked = counts.scrubbed === 0;

  return (
    <div className={`pr-next${blocked ? ' blocked' : ''}`}>
      <h2>
        {blocked
          ? `${list ? list.name : 'This data'} cannot be dialed yet`
          : `${(untraced || unscrubbed).toLocaleString()} rows are not ready to dial`}
      </h2>
      {untraced > 0 && (
        <p>
          <strong>{untraced.toLocaleString()}</strong> {untraced === 1 ? 'row has' : 'rows have'} no
          phone number yet. Skip tracing is what puts one there, at roughly four cents a row.
        </p>
      )}
      {unscrubbed > 0 && (
        <p>
          <strong>{unscrubbed.toLocaleString()}</strong>{' '}
          {unscrubbed === 1 ? 'row has' : 'rows have'} not been scrubbed against the DNC and
          litigator files. The litigator half is the one that matters most: serial TCPA plaintiffs
          seed their numbers onto exactly the absentee and pre-foreclosure lists this data comes
          from, and two-tenths of a cent to not call one of them is the cheapest insurance in the
          business.
        </p>
      )}
      {list
        /* Keyed on the list id so switching lists REMOUNTS the runner rather
           than reconciling it. Without the key its `dry` state survives the
           switch: the operator reads "at least $4.10" from list A, clicks the
           next chip, and the button still showing $4.10 now invokes with list
           B's id. On a five-thousand-row list that is a $200 click on a price
           quoted for a different batch of data. */
        ? <TraceRunner key={list.id} list={list} onRan={onRan} />
        : (
          <p>
            <strong>Pick a list above to trace it.</strong> The tracer works one list at a time,
            because what it spends and what it finds are facts about a particular batch of data from
            a particular vendor, and a run that straddled three lists could not be read back as
            either.
          </p>
        )}
    </div>
  );
}

/**
 * Trace and scrub, in two steps, and the first one spends nothing.
 *
 * The edge function's default is a dry run and this control keeps that shape
 * rather than flattening it into one button, for the same reason broadcast-send
 * makes a draft campaign refuse without `confirm`: the expensive action should
 * be the one you asked for. The price is real money at roughly four cents a row,
 * so on a five-thousand-row list the difference between the two clicks is $200.
 *
 * The whole run is not one invocation. `SKIP_TRACE_BATCH` and a wall-clock
 * budget cap each call, and the function says `more_pending` when it stopped
 * because of them rather than because the work ran out. That is surfaced as a
 * button rather than looped automatically — an automatic loop would keep
 * spending after the operator walked away, which is exactly the thing a dry run
 * exists to prevent.
 */
function TraceRunner({ list, onRan }) {
  const [dry, setDry] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  async function invoke(confirm) {
    setBusy(confirm ? 'run' : 'dry');
    setErr(null);
    const { data, error } = await supabase.functions.invoke('skip-trace', {
      body: confirm ? { list_id: list.id, confirm: true } : { list_id: list.id },
    });

    if (error) {
      // A non-2xx from an edge function arrives as a FunctionsHttpError whose
      // body is on `context`. The function refuses with a named reason and a
      // sentence written for this screen — throwing that away and showing
      // "Edge Function returned a non-2xx status code" would hide the one part
      // of the response that says what to do about it.
      let said = error.message;
      try {
        const body = await error.context?.json?.();
        if (body?.message) said = body.reason ? `${body.message} (${body.reason})` : body.message;
      } catch { /* the body was not JSON; the generic message is all there is */ }
      setBusy(null);
      setErr(said);
      return;
    }

    setBusy(null);
    if (data?.dry_run) { setDry(data); setResult(null); return; }
    setResult(data);
    setDry(null);
    // The list counters come back over realtime on their own; the rows do not,
    // because prospects is deliberately not published. Numbers on this page are
    // what just changed, so the table is re-read rather than left stale.
    onRan?.();
  }

  // Mirrors the function's own credential rule rather than "every key it named".
  // TRACERFY is only consulted when something still has to be traced, so a list
  // that arrived carrying numbers and needs nothing but a scrub must not be held
  // back by a tracer key it will never call — that is over-blocking in the one
  // direction that keeps a list unscrubbed. BatchData is required either way:
  // it is the DNC and litigator half, and treating a missing key there as "skip
  // the scrub" is the exact failure the function refuses on.
  const missing = dry
    ? Object.entries(dry.providers_configured || {})
      // `=== 0`, not falsy: an absent would_trace means the response did not
      // answer the question, and the answer this page guesses in that case has
      // to be the one that holds rather than the one that runs.
      .filter(([k, ok]) => !ok && !(k === 'TRACERFY_API_KEY' && dry.would_trace === 0))
      .map(([k]) => k)
    : [];

  return (
    <>
      <div className="confirmbtns" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={() => invoke(false)} disabled={busy !== null}>
          {busy === 'dry' ? 'Checking…' : 'What would this cost?'}
        </button>
        {dry && dry.selected > 0 && missing.length === 0 && (
          <button className="btn" onClick={() => invoke(true)} disabled={busy !== null}>
            {busy === 'run' ? 'Running…' : `Trace and scrub — at least ${dry.estimated_cost_at_least}`}
          </button>
        )}
        {result?.more_pending && (
          <button className="btn" onClick={() => invoke(true)} disabled={busy !== null}>
            {busy === 'run' ? 'Running…' : 'Run the next batch'}
          </button>
        )}
      </div>

      {dry && (
        <p style={{ marginTop: 11 }}>
          {dry.message}
          {missing.length > 0 && (
            <>
              {' '}<strong>
                {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} not set in the edge
                function secrets, so nothing can run yet.
              </strong>
            </>
          )}
        </p>
      )}

      {result && (
        <p style={{ marginTop: 11 }}>
          {result.message || `${result.traced} traced, ${result.scrubbed} scrubbed.`}
          {' '}Found {result.phones_found} number{result.phones_found === 1 ? '' : 's'}
          {result.dnc_hits > 0 && `, ${result.dnc_hits} on the DNC list`}
          {/* Called out separately and always, even at zero. A litigator hit is
              the single most expensive thing this run can find, and an operator
              who never sees the line does not learn to look for it. */}
          {`, ${result.litigator_hits} litigator${result.litigator_hits === 1 ? '' : 's'}`}
          . Spent {result.estimated_cost}.
          {result.scrub_failed > 0 && (
            <> <strong>{result.scrub_failed} rows failed the scrub and stay undialable until this
              is run again.</strong></>
          )}
          {result.more_pending && ' There is more left than one batch can do.'}
        </p>
      )}

      {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}
    </>
  );
}

/* ── one row ─────────────────────────────────────────────────────────────── */

/**
 * The best number, and which line it is.
 *
 * Mobile first, matching the COALESCE order convert_prospect_to_lead() uses to
 * pick the number that lands on the lead — so the number shown here is the
 * number that follows the person into the CRM. A landline on a wholesaling list
 * is usually the house; a mobile is usually the human.
 */
function bestNumber(p) {
  if (p.phone_mobile) return { kind: 'mobile', number: p.phone_mobile };
  if (p.phone_landline) return { kind: 'landline', number: p.phone_landline };
  if (p.phone_voip) return { kind: 'VoIP', number: p.phone_voip };
  return null;
}

function distressTags(p) {
  return DISTRESS_FLAGS.filter((f) => p[f.key]);
}

function ProspectRow({ p, sel }) {
  const block = callBlock(p);
  const best = bestNumber(p);
  const tags = distressTags(p);

  return (
    <tr
      onClick={() => navigate(`/prospects/${p.id}`)}
      style={{ cursor: 'pointer' }}
      className={sel.isSelected(p.id) ? 'picked' : undefined}
    >
      {/* stopPropagation, or ticking the box opens the prospect */}
      <td className="pick" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${p.address || 'prospect'}`}
          checked={sel.isSelected(p.id)}
          onChange={(e) => sel.toggle(p.id, e.target.checked)}
        />
      </td>
      <td>
        <span className="addr">{p.address || 'No address on file'}</span>
        <span className="sub">
          {[[p.city, p.state].filter(Boolean).join(', '), p.zip, p.county && `${p.county} County`]
            .filter(Boolean).join(' · ') || '—'}
        </span>
        {tags.length > 0 && (
          <span className="pr-tags">
            {tags.map((t) => (
              <span key={t.key} className={`pr-tag${t.urgent ? ' urgent' : ''}`}>{t.label}</span>
            ))}
          </span>
        )}
      </td>
      <td>
        <span className="addr">{p.owner_name || '—'}</span>
        <span className="sub">
          {[
            p.owner_occupied === false ? 'Not owner-occupied' : p.owner_occupied === true ? 'Owner-occupied' : null,
            p.years_owned != null ? `owned ${p.years_owned} yr` : null,
            p.equity_pct != null ? `${p.equity_pct}% equity` : null,
          ].filter(Boolean).join(' · ') || '—'}
        </span>
      </td>
      <td>
        {best ? (
          <>
            <span className="addr pr-nowrap">{formatPhone(best.number)}</span>
            <span className="sub">
              {best.kind}
              {p.skip_trace_confidence != null && ` · ${p.skip_trace_confidence}% confidence`}
            </span>
          </>
        ) : (
          <span className="pr-dim">{p.skip_traced ? 'Traced, no number found' : 'Not traced'}</span>
        )}
      </td>
      <td className="hide-sm sub">
        {p.call_attempts > 0
          ? `${p.call_attempts} · ${callStatusLabel(p.call_status)}${p.last_called_at ? ` · ${timeAgo(p.last_called_at)}` : ''}`
          : 'never dialed'}
      </td>
      <td>
        {p.converted_at
          ? <span className="badge ok">Lead</span>
          : block
            ? <span className="badge stop">{block}</span>
            : <span className="badge ok">Dialable</span>}
      </td>
    </tr>
  );
}
