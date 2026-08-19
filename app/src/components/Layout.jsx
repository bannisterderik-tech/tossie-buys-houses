import { supabase } from '../supabase.js';
import { useRoute } from '../router.js';

const NAV = [
  { to: '/today', label: 'Today' },
  { to: '/', label: 'Leads' },
  { to: '/dialer', label: 'Dialer' },
  { to: '/messages', label: 'Messages' },
  { to: '/board', label: 'Board' },
  { to: '/settings/phone', label: 'Phone settings' },
];

// Phase 5. Still inert, and labelled so — an item that looks like a link and
// does nothing reads as a bug, which is exactly how the previous placeholders
// came across.
const SOON = ['Deals', 'Buyers'];

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
