import { supabase } from '../supabase.js';

/**
 * Delete, in one place.
 *
 * Four objects can be deleted — leads, buyers, deals, prospects — and every one
 * of them uses the same two columns and the same two-step shape: the delete
 * button trashes, the Trash screen restores or purges. Centralised because the
 * dangerous half is the purge, and there should be exactly one copy of it to
 * review rather than four that drift.
 */

/** The objects that support trash, and what to call them on screen. */
export const TRASHABLE = {
  leads:     { label: 'lead',     plural: 'leads',     titleCol: 'address', route: '/leads' },
  buyers:    { label: 'buyer',    plural: 'buyers',    titleCol: 'name',    route: '/buyers' },
  deals:     { label: 'deal',     plural: 'deals',     titleCol: 'address', route: '/deals' },
  prospects: { label: 'prospect', plural: 'prospects', titleCol: 'address', route: '/prospects' },
  prospect_lists:      { label: 'prospect list', plural: 'prospect lists', titleCol: 'name', route: '/prospects' },
  broadcast_campaigns: { label: 'campaign',      plural: 'campaigns',      titleCol: 'name', route: '/campaigns' },
};

/**
 * Objects the database will refuse to destroy, and why.
 *
 * A campaign whose audience was materialised is protected by
 * broadcast_campaign_no_delete_after_materialise: broadcast_recipients is the
 * record of who was texted and who was suppressed, which is what a carrier asks
 * for. Offering a "Delete forever" that always errors would be worse than not
 * offering it, so the Trash screen asks this first and says so instead.
 */
export function purgeBlockedReason(table, row) {
  if (table === 'broadcast_campaigns' && row.materialised_at) {
    return 'Kept permanently — this campaign was sent, and its recipient list is the send record.';
  }
  return null;
}

const ids = (idOrIds) => (Array.isArray(idOrIds) ? idOrIds : [idOrIds]);

/** Soft delete. Reversible, and the only thing the delete buttons ever call. */
export async function trash(table, idOrIds) {
  const list = ids(idOrIds);
  if (!list.length) return { count: 0 };
  // trashed_at is stamped by the stamp_trashed_at trigger, not here, so a row
  // trashed by any other path still sorts correctly in the Trash screen.
  const { error } = await supabase.from(table).update({ trashed: true }).in('id', list);
  if (error) throw new Error(error.message);
  return { count: list.length };
}

/** Put it back. A list brings its prospects with it. */
export async function restore(table, idOrIds) {
  const list = ids(idOrIds);
  if (!list.length) return { count: 0 };

  if (table === 'prospect_lists') {
    // Same RPC as the delete, so the pair stays symmetrical: it restores
    // exactly the prospects that went down with this list and leaves alone any
    // that were deleted individually.
    for (const id of list) {
      const { error } = await supabase.rpc('set_prospect_list_trashed', {
        p_list_id: id, p_trashed: false,
      });
      if (error) throw new Error(error.message);
    }
    return { count: list.length };
  }

  const { error } = await supabase.from(table).update({ trashed: false }).in('id', list);
  if (error) throw new Error(error.message);
  return { count: list.length };
}

/**
 * Permanent. There is no undo past this point.
 *
 * Safe with respect to compliance by schema design rather than by care here:
 * telephony_opt_outs has no foreign key to leads at all, so a seller who
 * replied STOP stays suppressed even after their lead row is gone and the
 * number is re-imported next month. sms_messages, call_log, dnc_restore_log and
 * deals are all ON DELETE SET NULL, so message history, the DNC audit trail and
 * live contracts outlive the record. What does go is what should: notes,
 * activity, tasks, pipeline placement, SDR conversations.
 */
export async function purge(table, idOrIds) {
  const list = ids(idOrIds);
  if (!list.length) return { count: 0 };
  const { error } = await supabase.from(table).delete().in('id', list);
  if (error) throw new Error(error.message);
  return { count: list.length };
}

/** "3 leads" / "1 buyer" — so callers stop hand-rolling plurals. */
export function countLabel(table, n) {
  const t = TRASHABLE[table];
  if (!t) return `${n} record${n === 1 ? '' : 's'}`;
  return `${n} ${n === 1 ? t.label : t.plural}`;
}
