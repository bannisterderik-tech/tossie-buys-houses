import { useState } from 'react';
import { trash, countLabel } from '../lib/trash.js';
import { useCan } from '../lib/capabilities.jsx';

/**
 * The "N selected — Delete" strip above a list.
 *
 * Confirms in place and says where the rows go, for the same reason the single
 * delete does: the number here can be three hundred, and a bare "Are you sure?"
 * is not enough information to answer.
 */
export default function BulkBar({ table, sel, onDone, onError, onText, textBlocked, extra }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { can } = useCan();

  if (sel.count === 0) return null;

  const mayDelete = can(`${table}.delete`);
  const mayText   = can('messages.send');

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
          {onText && mayText && (
            textBlocked
              // Disabled with the reason attached rather than hidden. A button
              // that vanishes at 251 rows reads as a bug; one that says why
              // reads as a limit.
              ? <span className="sub" title={textBlocked}>{textBlocked}</span>
              : <button className="btn" onClick={() => onText(sel.ids)}>Text selected</button>
          )}
          {extra}
          {mayDelete && (
            <button className="btn ghost danger" onClick={() => setConfirming(true)}>Delete</button>
          )}
          <button className="btn ghost" onClick={sel.clear}>Clear</button>
        </>
      )}
    </div>
  );
}
