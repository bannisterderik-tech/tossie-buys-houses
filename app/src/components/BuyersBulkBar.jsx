import { useState } from 'react';
import { supabase } from '../supabase.js';
import { trash, countLabel } from '../lib/trash.js';
import { BUYER_CONSENT_SOURCES } from '../lib/buyers.js';
import { useCan } from '../lib/capabilities.jsx';

/**
 * Bulk actions for buyers: text, record consent, delete.
 *
 * Consent in bulk is the one that needs care. It goes through
 * record_buyer_consent, one call per buyer, exactly as the single-buyer panel
 * does — so every row ends up with the same shape of record and the same
 * timestamp discipline, and there is no second write path to audit. The RPC
 * refuses a blank source, and this refuses to call it without one for the same
 * reason: "who said we could text them" has to have an answer per row, and
 * "someone ticked 60 boxes" is not one.
 *
 * The source is asked for once and applied to the whole selection, which is
 * honest when the answer really is the same for all of them — an imported list
 * of established buyers — and is why the note field exists to say so. If the
 * basis differs per buyer, that is what the per-buyer panel is for.
 *
 * It lifts nothing. A STOP on a buyer's number lives in telephony_opt_outs and
 * outranks consent in buyer_skip_reason, so a buyer who opted out stays
 * suppressed no matter what this writes.
 */
export default function BuyersBulkBar({ sel, onDone, onError, onText }) {
  const [mode, setMode] = useState(null);       // null | 'consent' | 'delete'
  const [source, setSource] = useState('');
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const { can } = useCan();

  if (sel.count === 0) return null;

  const resolved = (source === '__other' ? other : source).trim();

  function reset() {
    setMode(null); setSource(''); setOther(''); setNote(''); setProgress(null);
  }

  async function recordConsent() {
    if (!resolved) return;
    setBusy(true);
    const ids = sel.ids;
    let done = 0;
    for (const id of ids) {
      const { error } = await supabase.rpc('record_buyer_consent', {
        p_buyer_id: id,
        p_source: resolved,
        p_note: note.trim() || null,
      });
      if (error) {
        // Stop at the first failure and say how far it got. Carrying on would
        // leave a partially consented selection nobody can identify afterwards.
        onError?.(`${error.message} — ${done} of ${ids.length} recorded before this stopped.`);
        setBusy(false);
        setProgress(null);
        await onDone?.();
        return;
      }
      done += 1;
      setProgress(done);
    }
    setBusy(false);
    sel.clear();
    reset();
    await onDone?.();
  }

  async function doDelete() {
    setBusy(true);
    try {
      await trash('buyers', sel.ids);
      sel.clear();
      reset();
      await onDone?.();
    } catch (e) {
      onError?.(e.message);
    }
    setBusy(false);
  }

  if (mode === 'consent') {
    return (
      <div className="bulkbar consentbulk">
        <strong>Record SMS consent for {countLabel('buyers', sel.count)}</strong>
        <p className="fine">
          This is a legal record. It is timestamped per buyer and it is what answers
          &ldquo;who said we could text them&rdquo; if a carrier reviews a campaign or a demand
          letter arrives. Record it only if they actually asked.
        </p>
        <label className="consentfield">
          How was it obtained?
          <select value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}>
            <option value="">Choose…</option>
            {BUYER_CONSENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="__other">Something else — type it</option>
          </select>
        </label>
        {source === '__other' && (
          <label className="consentfield">
            In your own words
            <input value={other} onChange={(e) => setOther(e.target.value)} disabled={busy}
                   placeholder="How these buyers agreed" />
          </label>
        )}
        <label className="consentfield">
          Note <span className="fine">optional, goes on every record in this batch</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        </label>
        <div className="followup-exact">
          <button className="btn" disabled={!resolved || busy} onClick={recordConsent}>
            {busy ? `Recording… ${progress ?? 0}/${sel.count}` : `Record for ${sel.count}`}
          </button>
          <button className="btn ghost" disabled={busy} onClick={reset}>Cancel</button>
        </div>
      </div>
    );
  }

  if (mode === 'delete') {
    return (
      <div className="bulkbar">
        <span className="confirmdelete">
          <span>Delete {countLabel('buyers', sel.count)}? They move to Trash — you can put them back.</span>
          <button className="btn danger" disabled={busy} onClick={doDelete}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={reset}>Cancel</button>
        </span>
      </div>
    );
  }

  return (
    <div className="bulkbar">
      <span>{countLabel('buyers', sel.count)} selected</span>
      {can('messages.send') && (
        <button className="btn" onClick={() => onText(sel.ids)}>Text selected</button>
      )}
      {can('buyers.edit') && (
        <button className="btn ghost" onClick={() => setMode('consent')}>Record consent…</button>
      )}
      {can('buyers.delete') && (
        <button className="btn ghost danger" onClick={() => setMode('delete')}>Delete</button>
      )}
      <button className="btn ghost" onClick={sel.clear}>Clear</button>
    </div>
  );
}
