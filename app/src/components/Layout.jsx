import { supabase } from '../supabase.js';
import { useRoute } from '../router.js';

const NAV = [
  { to: '/today', label: 'Today' },
  { to: '/', label: 'Leads' },
  // Its own item, next to Leads and never inside it. A prospect has no consent
  // basis and cannot be texted at all, so the two are different objects with
  // different permissions — one nav entry covering both would be the first step
  // towards one screen covering both.
  { to: '/prospects', label: 'Prospects' },
  { to: '/dialer', label: 'Dialer' },
  { to: '/messages', label: 'Messages' },
  { to: '/sdr', label: 'AI SDR' },
  { to: '/buyers', label: 'Buyers' },
  { to: '/deals', label: 'Deals' },
  { to: '/campaigns', label: 'Campaigns' },
  { to: '/import', label: 'Import' },
  { to: '/trash', label: 'Trash' },
  { to: '/settings/phone', label: 'Phone settings' },
];

// Kept for the next placeholder. An item that looks like a link and does
// nothing reads as a bug, which is exactly how the previous ones came across.
const SOON = [];

export default function Layout({ session, children }) {
  const path = useRoute();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={__BIZ__.logo} alt="" />
          <span>Tossie</span>
        </div>

        <nav>
          {NAV.map((n) => (
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
