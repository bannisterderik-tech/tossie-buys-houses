import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { useCan } from '../lib/capabilities.jsx';

/**
 * Put selected leads on the AI SDR, or take them off.
 *
 * Enrolment is opt-in and that is the whole point of this control existing.
 * Before it, ai-sdr tested `sdr_enabled === false` against a nullable column —
 * so every lead that had never been touched read as eligible, and turning the
 * team switch on would have started texting a list nobody chose. The column is
 * now NOT NULL DEFAULT false and this is the only thing that flips it.
 *
 * The RPC refuses leads with no consent basis and says how many it refused,
 * which is reported rather than swallowed: enrolling a lead the SDR will then
 * decline every time is worse than not enrolling it, because the operator
 * believes it is being worked.
 *
 * Removal is deliberately unconditional. Whatever state a lead is in, taking it
 * off the SDR has to work — that is the stop button.
 */
export default function SdrEnrollAction({ sel, onDone, onError }) {
  const { can } = useCan();
  const [open, setOpen] = useState(false);
  const [personas, setPersonas] = useState([]);
  const [personaId, setPersonaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    supabase.from('sdr_personas').select('id, name, is_default').eq('active', true)
      .order('is_default', { ascending: false }).order('name')
      .then(({ data }) => {
        setPersonas(data ?? []);
        setPersonaId((data ?? []).find((p) => p.is_default)?.id ?? '');
      });
  }, [open]);

  if (!can('sdr.manage')) return null;

  async function run(enabled) {
    setBusy(true);
    setResult(null);
    const { data, error } = await supabase.rpc('set_sdr_enrollment', {
      p_lead_ids: sel.ids,
      p_enabled: enabled,
      p_persona_id: enabled && personaId ? personaId : null,
    });
    setBusy(false);
    if (error) { onError?.(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    setResult(row ?? null);
    if (!enabled || !row?.skipped) {
      sel.clear();
      setOpen(false);
      setResult(null);
    }
    await onDone?.();
  }

  if (!open) {
    return <button className="btn ghost" onClick={() => setOpen(true)}>AI SDR…</button>;
  }

  return (
    <span className="confirmdelete">
      <select value={personaId} disabled={busy} onChange={(e) => setPersonaId(e.target.value)}>
        {personas.length === 0 && <option value="">No scripts yet</option>}
        {personas.map((p) => (
          <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (default)' : ''}</option>
        ))}
      </select>
      <button className="btn" disabled={busy} onClick={() => run(true)}>
        {busy ? 'Working…' : `Add ${sel.count}`}
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => run(false)}>Remove</button>
      <button className="btn ghost" disabled={busy} onClick={() => { setOpen(false); setResult(null); }}>
        Cancel
      </button>
      {result?.skipped > 0 && (
        <span className="sub">
          {result.enrolled} added, {result.skipped} skipped — {result.skipped_reason}
        </span>
      )}
    </span>
  );
}
