import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { STATUSES, TEMPERATURES, titleize, formatPhone, fullAddress, timeAgo, sourceLabel } from '../lib/format.js';
import useBulkSelect from '../lib/useBulkSelect.js';
import BulkBar from '../components/BulkBar.jsx';
import { stashSelection } from '../lib/campaignHandoff.js';
import SdrEnrollAction from '../components/SdrEnrollAction.jsx';

/**
 * Leads — one page, two views.
 *
 * These used to be two nav items reading the same rows, which meant the filters
 * only existed on one of them: the board had no search at all. That is fine at
 * twelve leads and useless at three hundred and forty-seven, where "Dead" alone
 * is a column of 224 cards nobody can find anything in. Merging them means the
 * search box and the status/temperature filters narrow *both* views, and the
 * toggle only changes how the same filtered set is drawn.
 *
 * Drag and drop is native HTML5 rather than a library. reoperative pulls in
 * three @dnd-kit packages for this; the board has one interaction — pick up a
 * card, drop it on a column — and the platform already does that. Every move
 * goes through move_lead_to_stage so the card and its activity row are written
 * in one transaction and the timeline never disagrees with the board.
 */
const VIEW_KEY = 'tossie.leads.view';

/**
 * Mirrors LEADS_CAP in CampaignsPage, which mirrors what materialise_campaign
 * enforces. Checked here so the operator finds out before they change screens,
 * not after composing a message.
 */
const LEADS_CAP = 250;

export default function LeadsPage({ initialView = 'list' }) {
  const [view, setView] = useState(() => {
    // The deep link wins on arrival, otherwise honour whatever they last chose.
    if (initialView === 'board') return 'board';
    try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
  });

  const [leads, setLeads] = useState([]);
  const [stages, setStages] = useState([]);
  const [stageByLead, setStageByLead] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [temp, setTemp] = useState('');
  const [source, setSource] = useState('');
  // Textable, not "has a phone". The database computes lead_is_dialable off the
  // consent basis and the suppression list, and picking an SMS audience by any
  // looser test just fills the campaign preview with suppressed rows.
  const [textable, setTextable] = useState('');
  const [onSdr, setOnSdr] = useState('');

  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);


  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
  }, [view]);

  const load = useCallback(async () => {
    const { data: pipeline } = await supabase
      .from('pipelines').select('id').eq('is_default', true).limit(1).maybeSingle();

    const [{ data: rows, error: lErr }, stageRes, memRes] = await Promise.all([
      supabase
        .from('leads')
        // dialable:lead_is_dialable is the database function as a computed
        // column — the same one the dialer and the send path consult. The
        // "textable" filter must not re-derive that rule in JavaScript: half of
        // it reads telephony_opt_outs and is not expressible here at all.
        .select('*, dialable:lead_is_dialable')
        .eq('trashed', false)
        .order('created_at', { ascending: false })
        // 500 was already tight after one CRM import. This is the whole book of
        // business, not a page of it — the filters below do the narrowing.
        .limit(5000),
      pipeline
        ? supabase.from('pipeline_stages').select('*').eq('pipeline_id', pipeline.id).order('position')
        : Promise.resolve({ data: [] }),
      pipeline
        ? supabase.from('lead_pipeline_memberships').select('lead_id, stage_id').eq('pipeline_id', pipeline.id)
        : Promise.resolve({ data: [] }),
    ]);

    if (lErr) { setErr(lErr.message); setLoading(false); return; }

    const map = {};
    for (const m of memRes.data ?? []) map[m.lead_id] = m.stage_id;

    setLeads(rows ?? []);
    setStages(stageRes.data ?? []);
    setStageByLead(map);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // A lead arriving from the website form should appear without a refresh —
    // that is the whole point of the exit test for this phase. Stage moves made
    // on another device need to land here too, or two people dragging the same
    // board quietly overwrite each other.
    const channel = supabase
      .channel('leads-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_pipeline_memberships' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (status && l.status !== status) return false;
      if (temp && l.temperature !== temp) return false;
      if (source && l.source !== source) return false;
      if (textable === 'yes' && !l.dialable) return false;
      if (textable === 'no' && l.dialable) return false;
      // Enrolment was invisible on every screen in the app, which is why
      // putting leads on the SDR read as doing nothing at all.
      if (onSdr === 'yes' && !l.sdr_enabled) return false;
      if (onSdr === 'no' && l.sdr_enabled) return false;
      if (!needle) return true;
      return [l.name, l.address, l.city, l.zip, l.phone, l.phone_mobile, l.email, l.owner_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [leads, q, status, temp, source, textable, onSdr]);

  // Read off the rows rather than hardcoded: sources arrive from imports and
  // webhooks, so any fixed list goes stale the first time a new vendor is added.
  const sources = useMemo(
    () => [...new Set(leads.map((l) => l.source).filter(Boolean))].sort(),
    [leads],
  );

  const byStage = useMemo(() => {
    const grouped = {};
    for (const l of shown) {
      const sid = stageByLead[l.id];
      if (!sid) continue;
      (grouped[sid] ??= []).push(l);
    }
    return grouped;
  }, [shown, stageByLead]);

  // Leads that exist but sit on no stage would silently vanish in board view.
  // Better to say so than to let someone count the columns and come up short.
  const unplaced = useMemo(
    () => shown.filter((l) => !stageByLead[l.id]).length,
    [shown, stageByLead],
  );

  async function drop(stageId) {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (!card || card.fromStage === stageId) return;

    // Move it locally first so the card does not snap back while the round trip
    // happens — then reconcile against what the database actually did.
    setStageByLead((prev) => ({ ...prev, [card.lead.id]: stageId }));

    const { error } = await supabase.rpc('move_lead_to_stage', {
      p_lead_id: card.lead.id,
      p_stage_id: stageId,
    });
    if (error) setErr(error.message);
    load();
  }

  const sel = useBulkSelect(shown);

  const filtered = shown.length !== leads.length;

  if (loading) return <div className="empty">Loading leads…</div>;

  return (
    <>
      <header>
        <h1>Leads</h1>
        <span className="count">
          {filtered ? `${shown.length} of ${leads.length}` : `${leads.length} total`}
          {view === 'board' && ' · drag a card to move it'}
        </span>
        <div className="spacer" style={{ flex: 1 }} />
        <div className="viewtoggle" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            type="button"
            aria-pressed={view === 'board'}
            onClick={() => setView('board')}
          >
            Board
          </button>
        </div>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <input
          placeholder="Search address, name, phone, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={temp} onChange={(e) => setTemp(e.target.value)}>
          <option value="">Any temperature</option>
          {TEMPERATURES.map((t) => <option key={t} value={t}>{titleize(t)}</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Any source</option>
          {sources.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={onSdr} onChange={(e) => setOnSdr(e.target.value)}>
          <option value="">On the SDR or not</option>
          <option value="yes">On the AI SDR</option>
          <option value="no">Not on the SDR</option>
        </select>
        <select value={textable} onChange={(e) => setTextable(e.target.value)}>
          <option value="">Textable or not</option>
          <option value="yes">Textable now</option>
          <option value="no">Not textable</option>
        </select>
      </div>

      {view === 'board'
        ? (
          <>
            {unplaced > 0 && (
              <p className="sub" style={{ marginTop: -6, marginBottom: 12 }}>
                {unplaced} matching {unplaced === 1 ? 'lead is' : 'leads are'} not on the
                pipeline and {unplaced === 1 ? 'does' : 'do'} not appear below. They are in list view.
              </p>
            )}
            <div className="board">
              {stages.map((s) => {
                const cards = byStage[s.id] ?? [];
                return (
                  <div key={s.id} className="boardcol">
                    <div
                      className={`card ${over === s.id ? 'dropping' : ''}`}
                      style={{ borderTop: `3px solid ${s.color || 'var(--line)'}` }}
                      onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
                      onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
                      onDrop={() => drop(s.id)}
                    >
                      <h2 style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{s.name}</span>
                        <span>{cards.length}</span>
                      </h2>
                      <div className="body boardcards">
                        {cards.length === 0 && (
                          <p className="colempty">{filtered ? 'No matches' : 'Empty'}</p>
                        )}
                        {cards.map((l) => (
                          <div
                            key={l.id}
                            className={`boardcard ${dragging?.lead.id === l.id ? 'lifted' : ''}`}
                            draggable
                            onDragStart={() => setDragging({ lead: l, fromStage: s.id })}
                            onDragEnd={() => { setDragging(null); setOver(null); }}
                            onClick={() => navigate(`/leads/${l.id}`)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && navigate(`/leads/${l.id}`)}
                          >
                            <strong>{l.address || l.name || 'Untitled'}</strong>
                            <span className="sub">
                              {[l.city, formatPhone(l.phone || l.phone_mobile)].filter(Boolean).join(' · ')}
                            </span>
                            <span className="cardfoot">
                              <span className={`badge ${l.temperature}`}>{l.temperature}</span>
                              <span className="sub">{timeAgo(l.created_at)}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )
        : (
          <div className="card">
            <BulkBar
              table="leads"
              sel={sel}
              onDone={load}
              onError={setErr}
              onText={(ids) => { stashSelection('leads', ids); navigate('/campaigns'); }}
              extra={<SdrEnrollAction sel={sel} onDone={load} onError={setErr} />}
              textBlocked={sel.count > LEADS_CAP
                ? `Too many to text — ${sel.count} selected, ${LEADS_CAP} is the cap on a seller audience`
                : null}
            />
            {shown.length === 0 ? (
              <div className="empty">
                <strong>{leads.length ? 'Nothing matches those filters' : 'No leads yet'}</strong>
                {leads.length === 0 && 'Submit the form on tossiebuyshouses.com and it will land here.'}
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
                    <th>Seller</th>
                    <th className="hide-sm">Source</th>
                    <th>Status</th>
                    <th className="hide-sm">Temp</th>
                    <th className="hide-sm">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => (
                    <tr
                      key={l.id}
                      onClick={() => navigate(`/leads/${l.id}`)}
                      style={{ cursor: 'pointer' }}
                      className={sel.isSelected(l.id) ? 'picked' : undefined}
                    >
                      {/* stopPropagation, or ticking the box opens the lead */}
                      <td className="pick" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${l.address || l.name || 'lead'}`}
                          checked={sel.isSelected(l.id)}
                          onChange={(e) => sel.toggle(l.id, e.target.checked)}
                        />
                      </td>
                      <td>
                        <span className="addr">{l.address || '—'}</span>
                        <span className="sub">{fullAddress(l).replace(`${l.address} · `, '') || '—'}</span>
                      </td>
                      <td>
                        {l.name || l.owner_name || '—'}
                        <span className="sub">{formatPhone(l.phone || l.phone_mobile)}</span>
                      </td>
                      <td className="hide-sm"><span className="badge">{sourceLabel(l)}</span></td>
                      <td>
                        <span className="badge">{titleize(l.status)}</span>
                        {l.sdr_enabled && (
                          <>
                            {' '}
                            <span className="badge ok" title="The AI SDR is working this lead">SDR</span>
                          </>
                        )}
                      </td>
                      <td className="hide-sm"><span className={`badge ${l.temperature}`}>{titleize(l.temperature)}</span></td>
                      <td className="hide-sm sub">{timeAgo(l.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
    </>
  );
}
