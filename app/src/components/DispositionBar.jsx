import { useState } from 'react';
import { supabase } from '../supabase.js';
import { DISPOSITIONS } from '../lib/format.js';

/**
 * What happened on the call, in one tap.
 *
 * Every button calls the same log_disposition RPC, which sets the status,
 * schedules the follow-up, counts the attempt and logs activity in one
 * transaction. Nothing about the mapping lives here — if the follow-up ladder
 * changes it changes in the database, and the dialer and SDR pick it up too.
 */
export default function DispositionBar({ leadId, onDone }) {
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  async function log(outcome) {
    setBusy(outcome);
    setErr(null);
    const { error } = await supabase.rpc('log_disposition', {
      p_lead_id: leadId,
      p_outcome: outcome,
      p_note: note.trim() || null,
      p_follow_up_at: when ? new Date(when).toISOString() : null,
    });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    setNote('');
    setWhen('');
    onDone?.();
  }

  const confirmed = (key) =>
    key !== 'do_not_call' ||
    // Irreversible in practice: it sets is_dnc, which removes the lead from
    // every future dial and text. Worth one confirm.
    window.confirm('Mark do-not-call? This removes the lead from all calling and texting, permanently.');

  return (
    <div className="dispo">
      {err && <div className="err">{err}</div>}

      <div className="dispo-btns">
        {DISPOSITIONS.map((d) => (
          <button
            key={d.key}
            className={`chip ${d.tone}`}
            disabled={busy !== null}
            onClick={() => confirmed(d.key) && log(d.key)}
          >
            {busy === d.key ? '…' : d.label}
          </button>
        ))}
      </div>

      <div className="dispo-extra">
        <input
          placeholder="What did they say? (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <label>
          Follow up
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            title="Leave blank to use the default gap for the outcome"
          />
        </label>
      </div>
    </div>
  );
}
