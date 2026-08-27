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
    const ids = sel.ids;
    const { data, error } = await supabase.rpc('set_sdr_enrollment', {
      p_lead_ids: ids,
      p_enabled: enabled,
      p_persona_id: enabled && personaId ? personaId : null,
    });
    if (error) { setBusy(false); onError?.(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;

    /**
     * Setting the flag is not the same as starting the conversation.
     *
     * This was the whole reason enrolling appeared to do nothing.
     * set_sdr_enrollment writes sdr_enabled and stops; the thing that gives the
     * SDR something to work is an sdr_conversations row, and only
     * initial_outreach creates one. Without this call a lead sat enrolled
     * forever with no conversation, so the grace sweep had nothing to find and
     * no first message was ever sent.
     *
     * It starts the grace clock rather than sending. The send happens when the
     * grace window passes without a human claiming the lead, which is the
     * behaviour sdr_settings.grace_period_seconds describes and the reason an
     * operator gets those seconds to take it themselves.
     *
     * Sequential rather than Promise.all: this is real outbound being armed,
     * and firing forty concurrent invocations at the function to save a second
     * is the wrong trade. Failures are counted, not thrown — a lead whose
     * conversation could not be opened is still correctly enrolled, and the
     * sweep will not pick it up, so the count is worth reporting.
     */
    let started = 0;
    let failed = 0;
    if (enabled && (row?.enrolled ?? 0) > 0) {
      for (const leadId of ids) {
        const { data: out, error: outErr } = await supabase.functions.invoke('ai-sdr', {
          body: { action: 'initial_outreach', lead_id: leadId },
        });
        if (outErr) failed += 1;
        else if (out?.skipped) failed += 0;   // already had a conversation
        else started += 1;
      }
    }

    setBusy(false);
    setResult(row ? { ...row, started, failed } : null);

    await onDone?.();

    // Stay open when there is something to report. The panel used to close and
    // clear on success without a word, which is indistinguishable from having
    // done nothing at all.
    if (!enabled) {
      sel.clear();
      setOpen(false);
      setResult(null);
    }
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
      {result && (
        <span className="sub">
          <strong>{result.enrolled} added</strong>
          {result.started > 0 && ` · ${result.started} conversation${result.started === 1 ? '' : 's'} opened`}
          {result.failed > 0 && ` · ${result.failed} could not be started`}
          {result.skipped > 0 && ` · ${result.skipped} skipped — ${result.skipped_reason}`}
          {result.enrolled > 0 && (
            <> — the first message goes out once the grace window passes.</>
          )}
          {' '}
          <button className="linkbtn" onClick={() => { sel.clear(); setOpen(false); setResult(null); }}>
            done
          </button>
        </span>
      )}
    </span>
  );
}
