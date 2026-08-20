/**
 * Carrying a selection from a list screen into the campaign builder.
 *
 * The alternative was a "text these" button that composes and sends from the
 * Leads or Buyers page, and that is the wrong shape. Everything that makes a
 * send defensible lives in the builder: the audience preview that shows who is
 * suppressed and why, the 250 cap the database enforces on a seller audience,
 * and the acknowledgement gate on LEADS_WARNING. A second send path would need
 * its own copy of all of it, and the copy is what drifts.
 *
 * So the list screens do one thing — hand over a set of ids — and the builder
 * stays the only place a message is written. In particular the handoff does NOT
 * pre-tick the acknowledgement: arriving with 40 sellers selected still means
 * reading what a seller blast does to a Low Volume Mixed registration and
 * ticking the box yourself.
 *
 * sessionStorage rather than a router param because the ids can run to a few
 * hundred and a URL is the wrong place for a list of people. Read-once, so a
 * refresh of /campaigns does not silently rebuild an audience the operator
 * already abandoned.
 */
const KEY = 'tossie.campaign.handoff';

/** @param kind 'leads' | 'buyers'  @param ids string[] */
export function stashSelection(kind, ids) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ kind, ids, at: Date.now() }));
  } catch {
    /* private mode — the builder simply opens empty, which is safe */
  }
}

/** Returns {kind, ids} once, then forgets it. */
export function takeSelection() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.ids) || !v.ids.length) return null;
    // A selection left over from this morning is not the one they meant.
    if (Date.now() - (v.at ?? 0) > 5 * 60 * 1000) return null;
    return { kind: v.kind, ids: v.ids };
  } catch {
    return null;
  }
}
