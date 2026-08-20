import { supabase } from '../supabase.js';
import { useRoute } from '../router.js';
import { useCan } from '../lib/capabilities.jsx';

/**
 * Each item names the capability that makes it useful.
 *
 * Hiding is a courtesy, not a control -- every one of these is also enforced in
 * an RLS policy. What it buys is an operator who is not offered a screen that
 * would load empty and read as broken.
 */
const NAV = [
  { to: '/today', label: 'Today', cap: 'leads.view' },
  { to: '/', label: 'Leads', cap: 'leads.view' },
  // Its own item, next to Leads and never inside it. A prospect has no consent
  // basis and cannot be texted at all, so the two are different objects with
  // different permissions — one nav entry covering both would be the first step
  // towards one screen covering both.
  { to: '/prospects', label: 'Prospects', cap: 'prospects.view' },
  { to: '/dialer', label: 'Dialer', cap: 'dialer.use' },
  { to: '/messages', label: 'Messages', cap: 'messages.send' },
  { to: '/sdr', label: 'AI SDR', cap: 'sdr.manage' },
  { to: '/buyers', label: 'Buyers', cap: 'buyers.view' },
  { to: '/deals', label: 'Deals', cap: 'deals.view' },
  { to: '/campaigns', label: 'Campaigns', cap: 'campaigns.view' },
  { to: '/import', label: 'Import', cap: 'import.run' },
  { to: '/trash', label: 'Trash', cap: 'leads.delete' },
  { to: '/team', label: 'Team' },
  { to: '/settings/phone', label: 'Phone settings', cap: 'settings.phone' },
];

// Kept for the next placeholder. An item that looks like a link and does
// nothing reads as a bug, which is exactly how the previous ones came across.
const SOON = [];

export default function Layout({ session, children }) {
  const path = useRoute();
  const { can, ready } = useCan();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={__BIZ__.logo} alt="" />
          <span>Tossie</span>
        </div>

        <nav>
          {NAV.filter((n) => !n.cap || !ready || can(n.cap)).map((n) => (
            <a
              key={n.to}
              href={`/app${n.to === '/' ? '' : n.to}`}
              aria-current={path === n.to ? 'page' : undefined}
            >
              {n.label}
            </a>
          ))}
          {SOON.map((label) => (
            <span key={label} className="navsoon" title="Not built yet">
              {label}
              <em>soon</em>
            </span>
          ))}
        </nav>

        <a href="/app/leads/new" className="btn newlead">+ New lead</a>

        <div className="spacer" />

        <div className="me">
          {session.user.email}
          <br />
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
