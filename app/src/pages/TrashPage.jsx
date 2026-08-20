import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { restore, purge, TRASHABLE, countLabel, purgeBlockedReason } from '../lib/trash.js';
import { formatPhone, timeAgo } from '../lib/format.js';

/**
 * Trash — the other half of every delete button.
 *
 * A delete that cannot be undone makes people hesitate to tidy up, so the list
 * fills with junk and stops being trustworthy. This screen is what lets the
 * delete buttons be one click.
 *
 * Purging is offered but kept deliberately awkward: it names what it will
 * destroy, it needs a second click, and it never batches across object types.
 */
const TABLES = ['leads', 'buyers', 'deals', 'prospects', 'prospect_lists', 'broadcast_campaigns'];

const SELECT = {
  leads:     'id, name, address, city, phone, phone_mobile, status, trashed_at',
  buyers:    'id, name, entity_name, phone, email, status, trashed_at',
  deals:     'id, address, city, status, contract_price, trashed_at',
  prospects: 'id, owner_name, address, city, trashed_at',
  prospect_lists: 'id, name, source_vendor, total_count, trashed_at',
  // materialised_at decides whether this one can ever be destroyed.
  broadcast_campaigns: 'id, name, status, sent_count, total_recipients, materialised_at, trashed_at',
};

export default function TrashPage() {
  const [rows, setRows] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [purging, setPurging] = useState(null); // `${table}:${id}` or `${table}:*`

  const load = useCallback(async () => {
    const results = await Promise.all(
      TABLES.map((t) =>
        supabase.from(t).select(SELECT[t]).eq('trashed', true).order('trashed_at', { ascending: false }),
      ),
    );
    const next = {};
    for (let i = 0; i < TABLES.length; i++) {
      if (results[i].error) { setErr(results[i].error.message); }
      next[TABLES[i]] = results[i].data ?? [];
    }
    setRows(next);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(fn, table, ids) {
    setBusy(true);
    setErr(null);
    try {
      await fn(table, ids);
      setPurging(null);
      await load();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }

  if (loading) return <div className="empty">Loading trash…</div>;

  const total = TABLES.reduce((n, t) => n + (rows[t]?.length ?? 0), 0);

  return (
    <>
      <header>
        <h1>Trash</h1>
        <span className="count">
          {total === 0 ? 'empty' : `${total} deleted record${total === 1 ? '' : 's'}`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {total === 0 && (
        <div className="card">
          <div className="empty">
            <strong>Nothing deleted</strong>
            Anything you delete lands here so you can put it back.
          </div>
        </div>
      )}

      {TABLES.map((table) => {
        const list = rows[table] ?? [];
        if (!list.length) return null;
        const meta = TRASHABLE[table];
        const purgeAllKey = `${table}:*`;
        const destroyable = list.filter((r) => !purgeBlockedReason(table, r));

        return (
          <div className="card" key={table} style={{ marginBottom: 16 }}>
            <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{countLabel(table, list.length)}</span>
              {destroyable.length === 0 ? null : purging === purgeAllKey ? (
                <span className="confirmdelete">
                  <span>
                    Permanently destroy {countLabel(table, destroyable.length)}? This cannot be undone.
                    {destroyable.length !== list.length
                      && ` ${list.length - destroyable.length} kept — they hold a send record.`}
                  </span>
                  <button className="btn danger" disabled={busy}
                          onClick={() => act(purge, table, destroyable.map((r) => r.id))}>
                    Destroy
                  </button>
                  <button className="btn ghost" disabled={busy} onClick={() => setPurging(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="btn ghost danger" onClick={() => setPurging(purgeAllKey)}>
                  Empty {meta.plural}
                </button>
              )}
            </h2>

            <div className="body">
              <table className="leads">
                <tbody>
                  {list.map((r) => {
                    const key = `${table}:${r.id}`;
                    const blocked = purgeBlockedReason(table, r);
                    return (
                      <tr key={r.id}>
                        <td>
                          <span className="addr">{describe(table, r)}</span>
                          <span className="sub">{subtitle(table, r)}</span>
                        </td>
                        <td className="hide-sm sub">
                          {r.trashed_at ? `deleted ${timeAgo(r.trashed_at)}` : 'deleted'}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {blocked ? (
                            <>
                              <button className="btn ghost" disabled={busy}
                                      onClick={() => act(restore, table, r.id)}>
                                Restore
                              </button>
                              {' '}
                              <span className="sub" title={blocked}>kept permanently</span>
                            </>
                          ) : purging === key ? (
                            <span className="confirmdelete">
                              <span>Destroy permanently?</span>
                              <button className="btn danger" disabled={busy}
                                      onClick={() => act(purge, table, r.id)}>
                                Destroy
                              </button>
                              <button className="btn ghost" disabled={busy} onClick={() => setPurging(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <>
                              <button className="btn ghost" disabled={busy}
                                      onClick={() => act(restore, table, r.id)}>
                                Restore
                              </button>
                              {' '}
                              <button className="btn ghost danger" disabled={busy}
                                      onClick={() => setPurging(key)}>
                                Delete forever
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {total > 0 && (
        <p className="sub" style={{ maxWidth: '60ch' }}>
          Deleting forever removes the record, its notes and its activity. It does
          <strong> not </strong>
          remove opt-outs, message history, call logs or contracts — anyone who replied
          STOP stays suppressed even if their record is destroyed and the number comes
          back on a future list.
        </p>
      )}
    </>
  );
}

function describe(table, r) {
  if (table === 'prospect_lists' || table === 'broadcast_campaigns') return r.name || 'Untitled';
  if (table === 'buyers') return r.name || r.entity_name || 'Unnamed buyer';
  if (table === 'prospects') return r.address || r.owner_name || 'Untitled prospect';
  return r.address || r.name || 'Untitled';
}

function subtitle(table, r) {
  const bits = [];
  if (table === 'leads') bits.push(r.name, r.city, formatPhone(r.phone || r.phone_mobile), r.status);
  if (table === 'buyers') bits.push(r.entity_name, formatPhone(r.phone), r.email);
  if (table === 'deals') bits.push(r.city, r.status, r.contract_price ? `$${r.contract_price.toLocaleString()}` : null);
  if (table === 'prospects') bits.push(r.owner_name, r.city);
  if (table === 'prospect_lists') {
    bits.push(r.source_vendor,
      r.total_count ? `${r.total_count.toLocaleString()} prospects — restored with the list` : null);
  }
  if (table === 'broadcast_campaigns') {
    bits.push(r.status,
      r.materialised_at ? `${r.sent_count ?? 0} of ${r.total_recipients ?? 0} sent` : 'never built');
  }
  return bits.filter(Boolean).join(' · ') || '—';
}
