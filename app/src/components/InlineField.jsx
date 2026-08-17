import { useEffect, useRef, useState } from 'react';

/**
 * A field that looks like text until you click it.
 *
 * The lead detail is where the operator types everything they learn on a call,
 * usually while still on the call. A form with an Edit button and a Save button
 * costs three clicks per fact; this costs one, saves on blur, and gets out of
 * the way. Escape abandons the edit.
 */
export default function InlineField({ label, value, onSave, type = 'text', options, placeholder, format }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);

  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select?.(); } }, [editing]);

  async function commit() {
    setEditing(false);
    const next = draft === '' ? null : draft;
    if (next === (value ?? null)) return;       // nothing actually changed
    setSaving(true);
    await onSave(next);
    setSaving(false);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && type !== 'textarea') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); }
  }

  if (!editing) {
    const shown = value == null || value === ''
      ? null
      : (format ? format(value) : String(value));
    return (
      <>
        <dt>{label}</dt>
        <dd>
          <button
            type="button"
            className="inline-edit"
            onClick={() => setEditing(true)}
            title="Click to edit"
          >
            {shown ?? <span className="ph">{placeholder || '—'}</span>}
            {saving && <span className="saving"> saving…</span>}
          </button>
        </dd>
      </>
    );
  }

  const common = {
    ref,
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown,
    className: 'inline-input',
  };

  return (
    <>
      <dt>{label}</dt>
      <dd>
        {options ? (
          <select {...common}>
            <option value="">—</option>
            {options.map((o) => (
              <option key={o} value={o}>{o.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase())}</option>
            ))}
          </select>
        ) : type === 'textarea' ? (
          <textarea {...common} rows={3} />
        ) : (
          <input {...common} type={type} />
        )}
      </dd>
    </>
  );
}
