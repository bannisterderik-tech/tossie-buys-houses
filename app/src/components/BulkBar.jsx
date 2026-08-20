import { useState } from 'react';
import { trash, countLabel } from '../lib/trash.js';

/**
 * The "N selected — Delete" strip above a list.
 *
 * Confirms in place and says where the rows go, for the same reason the single
 * delete does: the number here can be three hundred, and a bare "Are you sure?"
 * is not enough information to answer.
 */
export default function BulkBar({ table, sel, onDone, onError }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (sel.count === 0) return null;

  async function go() {
    setBusy(true);
    try {
      await trash(table, sel.ids);
      sel.clear();
      setConfirming(false);
      await onDone?.();
    } catch (e) {
      onError?.(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="bulkbar">
      <span>{countLabel(table, sel.count)} selected</span>
      {confirming ? (
        <span className="confirmdelete">
          <span>Delete {countLabel(table, sel.count)}? They move to Trash — you can put them back.</span>
          <button className="btn danger" disabled={busy} onClick={go}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <>
          <button className="btn ghost danger" onClick={() => setConfirming(true)}>Delete</button>
          <button className="btn ghost" onClick={sel.clear}>Clear</button>
        </>
      )}
    </div>
  );
}
