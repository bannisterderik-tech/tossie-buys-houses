import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { formatPhone, timeAgo } from '../lib/format.js';

/**
 * The pipeline board.
 *
 * Native HTML5 drag and drop rather than a library. reoperative pulls in three
 * @dnd-kit packages for this; the board has one interaction — pick up a card,
 * drop it on a column — and the platform already does that. Every move goes
 * through move_lead_to_stage, so the card and its activity row are written in
 * one transaction and the timeline never disagrees with the board.
 */
export default function BoardPage() {
  const [stages, setStages] = useState([]);
  const [byStage, setByStage] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);

  const load = useCallback(async () => {
    const { data: pipeline, error: pErr } = await supabase
      .from('pipelines').select('id').eq('is_default', true).limit(1).single();
    if (pErr) { setErr(pErr.message); setLoading(false); return; }

    const [{ data: st, error: sErr }, { data: mem, error: mErr }] = await Promise.all([
      supabase.from('pipeline_stages').select('*').eq('pipeline_id', pipeline.id).order('position'),
      supabase
        .from('lead_pipeline_memberships')
        .select('stage_id, leads!inner(id, name, address, city, phone, phone_mobile, temperature, created_at, trashed)')
        .eq('pipeline_id', pipeline.id),
    ]);
    if (sErr || mErr) { setErr((sErr || mErr).message); setLoading(false); return; }

    const grouped = {};
    for (const row of mem ?? []) {
      if (row.leads?.trashed) continue;
      (grouped[row.stage_id] ??= []).push(row.leads);
    }
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    setStages(st ?? []);
    setByStage(grouped);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function drop(stageId) {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (!card || card.fromStage === stageId) return;

    // Move it locally first so the card does not snap back while the round trip
    // happens — then reconcile against what the database actually did.
    setByStage((prev) => {
      const next = { ...prev };
      next[card.fromStage] = (next[card.fromStage] ?? []).filter((l) => l.id !== card.lead.id);
      next[stageId] = [card.lead, ...(next[stageId] ?? [])];
      return next;
    });

    const { error } = await supabase.rpc('move_lead_to_stage', {
      p_lead_id: card.lead.id,
      p_stage_id: stageId,
    });
    if (error) setErr(error.message);
    load();
  }

  if (loading) return <div className="empty">Loading board…</div>;

  return (
    <>
      <header>
        <h1>Board</h1>
        <span className="count">drag a card to move it</span>
      </header>
      {err && <div className="err">{err}</div>}

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
                  {cards.length === 0 && <p className="colempty">Empty</p>}
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
  );
}
