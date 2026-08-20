import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import { STATUSES, TEMPERATURES, titleize, timeAgo } from '../lib/format.js';

/**
 * Saved calling lists, and the form that builds one.
 *
 * A campaign is a filter run once and frozen. The filter is stored next to the
 * members so the list is auditable — "what did 'Savannah pre-foreclosures' mean
 * in August" has an answer — but it never re-runs, because a list that changes
 * length while you work it makes its own progress counter meaningless.
 *
 * Everyone the filter matched is kept, callable or not, with the reason on the
 * row. A list that silently dropped the twelve leads with no consent would look
 * like a list of 68 when it was a list of 80, and those twelve are exactly the
 * rows that tell you what compliance work the list is short of.
 */
export default function DialCampaigns({ onOpen, activeId }) {
  const [rows, setRows] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([
      supabase
        .from('dial_campaigns')
        .select('*, deals(address, city, state)')
        .eq('trashed', false)
        .order('created_at', { ascending: false })
        .limit(50),
      // Only live deals: a buyer call list exists to pitch a property, and
      // pitching one that closed or died is the call nobody wants to make.
      supabase
        .from('deals')
        .select('id, address, city, state, status, contract_price')
        .eq('trashed', false)
        .not('status', 'in', '("closed","dead","seller_terminated","terminated_inspection")')
        .order('created_at', { ascending: false }),
    ]);
    if (c.error) setErr(c.error.message);
    setRows(c.data ?? []);
    setDeals(d.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(id) {
    const { error } = await supabase.from('dial_campaigns').update({ trashed: true }).eq('id', id);
    if (error) setErr(error.message);
    else load();
  }

  if (loading) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Calling lists</span>
        {!building && (
          <button className="btn" onClick={() => setBuilding(true)}>New list</button>
        )}
      </h2>

      <div className="body">
        {err && <div className="err">{err}</div>}

        {building && (
          <Builder
            deals={deals}
            onCancel={() => setBuilding(false)}
            onBuilt={(id) => { setBuilding(false); load(); onOpen(id); }}
            onError={setErr}
          />
        )}

        {rows.length === 0 && !building && (
          <p className="cardnote">
            No saved lists. The dialer falls back to everything due plus everything never
            scheduled, which is the right default — a list is for when the session has a
            subject: one city, one status, or the buyers who fit one deal.
          </p>
        )}

        {rows.length > 0 && (
          <table className="leads">
            <tbody>
              {rows.map((c) => {
                const worked = c.total_count - c.skipped_count;
                return (
                  <tr key={c.id} className={c.id === activeId ? 'picked' : undefined}>
                    <td>
                      <span className="addr">{c.name}</span>
                      <span className="sub">
                        {[
                          c.kind === 'buyers' ? 'Buyers' : 'Sellers',
                          c.kind === 'buyers' && c.deals ? `for ${c.deals.address}` : null,
                          `${worked} to call`,
                          c.skipped_count > 0 ? `${c.skipped_count} blocked` : null,
                          `built ${timeAgo(c.created_at)}`,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost" onClick={() => onOpen(c.id)}>
                        {c.id === activeId ? 'Working' : 'Work this list'}
                      </button>
                      {' '}
                      <button className="btn ghost danger" onClick={() => remove(c.id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Builder({ deals, onCancel, onBuilt, onError }) {
  const [kind, setKind] = useState('sellers');
  const [name, setName] = useState('');
  const [statuses, setStatuses] = useState([]);
  const [temps, setTemps] = useState([]);
  const [cities, setCities] = useState('');
  const [onlyCallable, setOnlyCallable] = useState(true);
  const [dealId, setDealId] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const toggle = (set, v) =>
    set((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  const filter = useMemo(() => {
    if (kind === 'buyers') return { min_score: Number(minScore) || 0, only_callable: onlyCallable };
    const f = { only_callable: onlyCallable };
    if (statuses.length) f.statuses = statuses;
    if (temps.length) f.temperatures = temps;
    const c = cities.split(',').map((s) => s.trim()).filter(Boolean);
    if (c.length) f.cities = c;
    return f;
  }, [kind, statuses, temps, cities, onlyCallable, minScore]);

  const ready = name.trim() && (kind === 'sellers' || dealId) && !busy;

  /**
   * Count before committing.
   *
   * Same filter, run as a read. Building a list is cheap to undo but the point
   * of the preview is the other number: how many of the matches are actually
   * callable. A list of 300 that is 40 callable is a scrub problem, and finding
   * that out before naming and saving it is the difference between fixing the
   * data and working a queue that keeps ending early.
   */
  async function runPreview() {
    setBusy(true);
    if (kind === 'buyers') {
      const { data, error } = await supabase.rpc('match_buyers_for_deal', { p_deal_id: dealId });
      if (error) { onError(error.message); setBusy(false); return; }
      const matched = (data ?? []).filter((m) => m.score >= (Number(minScore) || 0));
      const ids = matched.map((m) => m.buyer_id);
      const { data: bs } = await supabase
        .from('buyers').select('id, call_block:buyer_call_skip_reason').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      const blocked = (bs ?? []).filter((b) => b.call_block).length;
      setPreview({ total: matched.length, blocked });
    } else {
      let q = supabase.from('leads')
        .select('id, block:lead_skip_reason', { count: 'exact' })
        .eq('trashed', false);
      if (statuses.length) q = q.in('status', statuses);
      if (temps.length) q = q.in('temperature', temps);
      const cl = cities.split(',').map((s) => s.trim()).filter(Boolean);
      if (cl.length) q = q.in('city', cl);
      const { data, error } = await q.limit(5000);
      if (error) { onError(error.message); setBusy(false); return; }
      const blocked = (data ?? []).filter((l) => l.block).length;
      setPreview({ total: (data ?? []).length, blocked });
    }
    setBusy(false);
  }

  async function build() {
    if (!ready) return;
    setBusy(true);
    const { data: created, error } = await supabase
      .from('dial_campaigns')
      .insert({
        team_id: TEAM_ID,
        name: name.trim(),
        kind,
        deal_id: kind === 'buyers' ? dealId : null,
        filter,
      })
      .select('id')
      .single();
    if (error) { onError(error.message); setBusy(false); return; }

    const { error: mErr } = await supabase.rpc('materialise_dial_campaign', {
      p_campaign_id: created.id,
    });
    if (mErr) {
      // Undo, so a failed build does not leave an empty list behind for
      // somebody to recognise as debris later.
      await supabase.from('dial_campaigns').delete().eq('id', created.id);
      onError(`${mErr.message} Nothing was saved.`);
      setBusy(false);
      return;
    }
    setBusy(false);
    onBuilt(created.id);
  }

  return (
    <div className="pickerblock">
      <div className="fields">
        <label>
          What are you calling?
          <select value={kind} onChange={(e) => { setKind(e.target.value); setPreview(null); }}>
            <option value="sellers">Sellers — leads</option>
            <option value="buyers">Buyers — pitch one deal</option>
          </select>
        </label>
        <label>
          List name
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder={kind === 'buyers' ? 'Dispo calls — Hendricks Ln' : 'Savannah attempting'} />
        </label>
      </div>

      {kind === 'buyers' ? (
        <div className="fields">
          <label>
            Which deal
            <select value={dealId} onChange={(e) => { setDealId(e.target.value); setPreview(null); }}>
              <option value="">Choose a live deal…</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.address}{d.city ? ` · ${d.city}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Minimum buy-box score
            <select value={minScore} onChange={(e) => { setMinScore(e.target.value); setPreview(null); }}>
              <option value={0}>Any match</option>
              <option value={40}>40+</option>
              <option value={60}>60+ — a real fit</option>
              <option value={80}>80+ — the obvious calls</option>
            </select>
          </label>
        </div>
      ) : (
        <>
          <div className="fields">
            <label>
              Cities <span className="fine">comma separated, blank for all</span>
              <input value={cities} onChange={(e) => { setCities(e.target.value); setPreview(null); }}
                     placeholder="Savannah, Brunswick" />
            </label>
          </div>
          <fieldset className="chipset">
            <legend>Status <span className="fine">none selected means any</span></legend>
            {STATUSES.map((s) => (
              <label key={s} className={`chip${statuses.includes(s) ? ' on' : ''}`}>
                <input type="checkbox" checked={statuses.includes(s)}
                       onChange={() => { toggle(setStatuses, s); setPreview(null); }} />
                {titleize(s)}
              </label>
            ))}
          </fieldset>
          <fieldset className="chipset">
            <legend>Temperature</legend>
            {TEMPERATURES.map((t) => (
              <label key={t} className={`chip${temps.includes(t) ? ' on' : ''}`}>
                <input type="checkbox" checked={temps.includes(t)}
                       onChange={() => { toggle(setTemps, t); setPreview(null); }} />
                {titleize(t)}
              </label>
            ))}
          </fieldset>
        </>
      )}

      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={onlyCallable}
               onChange={(e) => { setOnlyCallable(e.target.checked); setPreview(null); }} />
        <span>
          <strong>Only include people we can actually call.</strong>
          <small>
            Off, the blocked ones are still added and shown with the reason — useful when the
            point of the list is to find out what needs scrubbing.
          </small>
        </span>
      </label>

      {preview && (
        <p className="cardnote" style={{ marginTop: 10 }}>
          <strong>{preview.total} match{preview.total === 1 ? '' : 'es'}</strong>
          {preview.blocked > 0
            ? ` — ${preview.blocked} of them cannot be called right now${onlyCallable ? ', and will be left out' : ' and will be listed as blocked'}.`
            : ' — all callable.'}
        </p>
      )}

      <div className="followup-exact" style={{ marginTop: 12 }}>
        <button className="btn ghost" disabled={busy || (kind === 'buyers' && !dealId)} onClick={runPreview}>
          {busy ? 'Counting…' : 'Count first'}
        </button>
        <button className="btn" disabled={!ready} onClick={build}>
          {busy ? 'Building…' : 'Build list'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
