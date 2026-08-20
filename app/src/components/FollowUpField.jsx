import { useState } from 'react';
import { fullDate } from '../lib/format.js';

/**
 * "Call them back Tuesday."
 *
 * next_follow_up_at was display-only everywhere: the Today page sorts on it,
 * the Dialer builds its queue from it, and public.due_leads is literally
 * defined as next_follow_up_at <= now() — but nothing in the app could ever
 * write it. Only the SDR booking an appointment and the inbound webhook set it,
 * so a human who wanted to be reminded to call someone back had no way to say
 * so, and the follow-up queue only ever filled itself.
 *
 * Presets rather than a date picker first, because the thing an operator
 * actually says at the end of a call is "a couple of days" — making them
 * compute Thursday's date is how the field stops getting used. The exact input
 * is there underneath for the ones that are a real appointment.
 *
 * Times are set to 9am local on the target day. Midnight would put every
 * callback at the top of the queue in the middle of the night and, worse, count
 * as due during the hours nobody may legally call.
 */
const PRESETS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
  { label: 'In 2 weeks', days: 14 },
];

/** A Date at 09:00 local, `days` from today. */
function inDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** ISO timestamp -> the `YYYY-MM-DDTHH:mm` local string datetime-local needs. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function FollowUpField({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function set(date) {
    setSaving(true);
    await onSave(date ? date.toISOString() : null);
    setSaving(false);
    setEditing(false);
  }

  const overdue = value && new Date(value) <= new Date();

  return (
    <>
      <dt>Next follow-up</dt>
      <dd>
        {!editing ? (
          <button
            type="button"
            className="inline-edit"
            onClick={() => setEditing(true)}
            title="Click to schedule"
          >
            {value
              ? <>{fullDate(value)}{overdue && <span className="badge stop" style={{ marginLeft: 6 }}>due</span>}</>
              : <span className="ph">Not scheduled</span>}
            {saving && <span className="saving"> saving…</span>}
          </button>
        ) : (
          <div className="followup">
            <div className="followup-presets">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className="btn ghost"
                        disabled={saving} onClick={() => set(inDays(p.days))}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="followup-exact">
              <input
                type="datetime-local"
                className="inline-input"
                defaultValue={toLocalInput(value)}
                disabled={saving}
                onChange={(e) => {
                  // An empty input is the operator clearing the date, not a
                  // half-typed one — datetime-local only emits on a complete value.
                  if (!e.target.value) return;
                  const d = new Date(e.target.value);
                  if (!Number.isNaN(d.getTime())) set(d);
                }}
              />
              {value && (
                <button type="button" className="btn ghost danger"
                        disabled={saving} onClick={() => set(null)}>
                  Clear
                </button>
              )}
              <button type="button" className="btn ghost"
                      disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </dd>
    </>
  );
}
