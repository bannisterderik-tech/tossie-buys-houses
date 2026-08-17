import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { formatPhone, timeAgo } from '../lib/format.js';

/**
 * The pipeline board. Read-only for now — drag-to-move arrives with the lead
 * workspace in Phase 1, where the stage change also has to write an activity
 * row and reorder the dialer queue. A board that moves cards but does neither
 * would be a lie.
 */
export default function BoardPage() {
  const [stages, setStages] = useState([]);
  const [byStage, setByStage] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
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
    })();
  }, []);

  if (loading) return <div className="empty">Loading board…</div>;

  return (
    <>
      <header><h1>Board</h1></header>
      {err && <div className="err">{err}</div>}

      <div style={{ display: 'flex', gap: 13, overflowX: 'auto', paddingBottom: 14 }}>
        {stages.map((s) => {
          const cards = byStage[s.id] ?? [];
          return (
            <div key={s.id} style={{ flex: '0 0 250px', minWidth: 250 }}>
              <div className="card" style={{ borderTop: `3px solid ${s.color || 'var(--line)'}` }}>
                <h2 style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{s.name}</span>
                  <span>{cards.length}</span>
                </h2>
                <div className="body" style={{ padding: 10, display: 'grid', gap: 8 }}>
                  {cards.length === 0 && (
                    <p style={{ color: 'var(--muted)', fontSize: '0.83rem', margin: '6px 4px' }}>Empty</p>
                  )}
                  {cards.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => navigate(`/leads/${l.id}`)}
                      style={{
                        textAlign: 'left', background: 'var(--wash)', border: '1px solid var(--line)',
                        borderRadius: 8, padding: '9px 11px', cursor: 'pointer', width: '100%',
                      }}
                    >
                      <strong style={{ display: 'block', fontSize: '0.87rem' }}>
                        {l.address || l.name || 'Untitled'}
                      </strong>
                      <span className="sub" style={{ fontSize: '0.79rem', color: 'var(--muted)' }}>
                        {[l.city, formatPhone(l.phone || l.phone_mobile)].filter(Boolean).join(' · ')}
                      </span>
                      <span style={{ display: 'block', marginTop: 5 }}>
                        <span className={`badge ${l.temperature}`}>{l.temperature}</span>
                        <span className="sub" style={{ marginLeft: 6, fontSize: '0.75rem', color: 'var(--muted)' }}>
                          {timeAgo(l.created_at)}
                        </span>
                      </span>
                    </button>
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
