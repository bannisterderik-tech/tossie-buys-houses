import { useMemo, useState } from 'react';
import { trash, countLabel } from '../lib/trash.js';

/**
 * Bulk delete for deals, which is not quite the same gesture as bulk delete for
 * leads.
 *
 * A lead is a name on a list. A deal is a signed contract with a closing date
 * and somebody's earnest money against it, and the ones most likely to be
 * swept up by a careless select-all are the live ones at the left of the board.
 * So this bar refuses to say "8 deals" and leave it there: when the selection
 * contains anything still in play it names how many and what they are worth,
 * because "delete 8" and "delete 8, three of them live, $2.9M under contract"
 * are different decisions and only one of them is on screen otherwise.
 *
 * Deleting is still only a trash — the contract, its milestones, documents and
 * events all come back on restore.
 */
const TERMINAL = new Set(['closed', 'dead', 'seller_terminated', 'terminated_inspection']);

export default function DealsBulkBar({ deals, sel, onDone, onError }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const live = useMemo(() => {
    const picked = new Set(sel.ids);
    const rows = deals.filter((d) => picked.has(d.id) && !TERMINAL.has(d.status));
    return {
      count: rows.length,
      value: rows.reduce((sum, d) => sum + (d.contract_price || 0), 0),
    };
  }, [deals, sel.ids]);

  if (sel.count === 0) return null;

  async function go() {
    setBusy(true);
    try {
      await trash('deals', sel.ids);
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
      <span>{countLabel('deals', sel.count)} selected</span>
      {confirming ? (
        <span className="confirmdelete">
          <span>
            Delete {countLabel('deals', sel.count)}?
            {live.count > 0 && (
              <>
                {' '}
                <strong>
                  {live.count} {live.count === 1 ? 'is' : 'are'} still live
                  {live.value > 0 && `, $${live.value.toLocaleString()} under contract`}.
                </strong>
              </>
            )}
            {' '}They move to Trash — you can put them back.
          </span>
          <button className="btn danger" disabled={busy} onClick={go}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <>
          {live.count > 0 && (
            <span className="sub">
              {live.count} live
              {live.value > 0 && ` · $${live.value.toLocaleString()} under contract`}
            </span>
          )}
          <button className="btn ghost danger" onClick={() => setConfirming(true)}>Delete</button>
          <button className="btn ghost" onClick={sel.clear}>Clear</button>
        </>
      )}
    </div>
  );
}
