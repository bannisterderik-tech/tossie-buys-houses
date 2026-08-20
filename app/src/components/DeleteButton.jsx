import { useState } from 'react';
import { navigate } from '../router.js';
import { trash, TRASHABLE } from '../lib/trash.js';

/**
 * The delete control on a detail page.
 *
 * Confirms inline rather than with window.confirm, for one reason: the confirm
 * text has to say where the record goes. "OK / Cancel" on a browser dialog
 * teaches people that delete is scary and final, so they either never use it or
 * they stop reading it. Saying "it moves to Trash, you can put it back" is both
 * true here and the thing that makes the button safe to press.
 */
export default function DeleteButton({ table, id, name, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const meta = TRASHABLE[table];

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await trash(table, id);
      if (onDeleted) onDeleted();
      else navigate(meta.route);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <>
        <button className="btn ghost danger" onClick={() => setConfirming(true)}>
          Delete
        </button>
        {err && <span className="err inline">{err}</span>}
      </>
    );
  }

  return (
    <span className="confirmdelete">
      <span>
        Delete {name ? <strong>{name}</strong> : `this ${meta.label}`}? It moves to Trash — you can put it back.
      </span>
      <button className="btn danger" disabled={busy} onClick={go}>
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
