import { useMemo, useState } from 'react';

/**
 * Checkbox selection for a filtered list.
 *
 * The rule that matters is that everything acts on `visible` only. Select
 * forty rows, then type in the search box, and the forty are still in the Set —
 * so a bulk delete that reads the raw Set would destroy rows the operator can
 * no longer see, and the confirm text would name a number that does not match
 * anything on screen. Intersecting with what is rendered is the whole point of
 * putting this in one place.
 */
export default function useBulkSelect(visible, keyOf = (r) => r.id) {
  const [selected, setSelected] = useState(() => new Set());

  const visibleIds = useMemo(() => new Set(visible.map(keyOf)), [visible, keyOf]);

  const ids = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );

  const allSelected = visible.length > 0 && ids.length === visible.length;

  return {
    /** ids that are both selected and currently on screen */
    ids,
    count: ids.length,
    allSelected,
    isSelected: (id) => selected.has(id),
    toggle(id, on) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) next.add(id); else next.delete(id);
        return next;
      });
    },
    toggleAll(on) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of visible) { if (on) next.add(keyOf(r)); else next.delete(keyOf(r)); }
        return next;
      });
    },
    clear: () => setSelected(new Set()),
  };
}
