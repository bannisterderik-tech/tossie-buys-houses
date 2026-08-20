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
};

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

/** Put it back. */
export async function restore(table, idOrIds) {
  const list = ids(idOrIds);
  if (!list.length) return { count: 0 };
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
