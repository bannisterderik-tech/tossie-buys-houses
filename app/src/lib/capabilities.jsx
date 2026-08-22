import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';

/**
 * What this person is allowed to do.
 *
 * Read from the same role_capabilities table the RLS policies consult, so the
 * UI and the database cannot disagree about what a VA may do. That direction
 * matters: this module hides buttons, it does not enforce anything. Every
 * capability here is also checked in a policy, because a signed-in browser
 * holds a PostgREST token and a hidden button is not a permission.
 *
 * Loaded once per session. Roles and per-person overrides change when an owner
 * changes them, which is rare and already requires the affected person to
 * reload to see the difference — polling for it would be a request per minute
 * forever to catch an event that happens twice a year.
 */
const Ctx = createContext({ role: null, caps: new Set(), ready: false });

export const ROLES = [
  { key: 'owner',        label: 'Owner',        blurb: 'Everything, including who is on the team.' },
  { key: 'admin',        label: 'Admin',        blurb: 'Everything except changing the team.' },
  { key: 'acquisitions', label: 'Acquisitions', blurb: 'Sellers end to end — leads, prospects, dialing, deals up to contract. Reads the buyers list but cannot edit it.' },
  { key: 'dispositions', label: 'Dispositions', blurb: 'The buyer side — buyers, deals, and the blast. Reads leads for context.' },
  { key: 'va',           label: 'VA',           blurb: 'Works the queue: dials, logs, updates records. Cannot delete anything, blast anyone, or change settings.' },
];

export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

export function CapabilitiesProvider({ children }) {
  const [state, setState] = useState({ role: null, caps: new Set(), ready: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: role }, { data: rows }, { data: mine }] = await Promise.all([
        supabase.rpc('my_role'),
        supabase.from('role_capabilities').select('role, capability'),
        // Per-person exceptions. RLS scopes this to the team and the row set is
        // tiny, so it is filtered client-side to the signed-in user below —
        // seeing that a colleague has an override is not a secret, and the
        // Team page renders exactly that.
        supabase.from('user_capabilities').select('user_id, capability, granted'),
      ]);
      if (cancelled) return;

      const { data: who } = await supabase.auth.getUser();
      const me = who?.user?.id ?? null;

      const caps = new Set(
        (rows ?? []).filter((r) => r.role === role).map((r) => r.capability),
      );
      // Applied after the role, in the same order has_capability() applies
      // them, so a hidden button and a refused request agree. A revoke has to
      // be honoured here too — otherwise the UI offers an action the database
      // then rejects, which reads as the app being broken rather than as the
      // permission it actually is.
      for (const o of mine ?? []) {
        if (o.user_id !== me) continue;
        if (o.granted) caps.add(o.capability);
        else caps.delete(o.capability);
      }
      setState({ role: role ?? null, caps, ready: true });
    })();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo(() => ({
    ...state,
    // Owner is never listed in role_capabilities — the database short-circuits
    // it in has_capability(), and this mirrors that rather than duplicating the
    // list, so the two cannot drift.
    can: (cap) => state.role === 'owner' || state.caps.has(cap),
  }), [state]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCan() {
  return useContext(Ctx);
}

/** Render children only when the capability is held. */
export function Can({ cap, children, otherwise = null }) {
  const { can, ready } = useCan();
  // Render nothing until known. Flashing a delete button and withdrawing it is
  // worse than a beat of nothing.
  if (!ready) return null;
  return can(cap) ? children : otherwise;
}
