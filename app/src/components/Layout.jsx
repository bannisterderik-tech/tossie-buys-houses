import { supabase } from '../supabase.js';
import { useRoute } from '../router.js';

const NAV = [
  { to: '/today', label: 'Today' },
  { to: '/', label: 'Leads' },
  { to: '/board', label: 'Board' },
];

// Phases 2-5. Listed but inert, so the shape of the finished console is visible
// from day one and adding each is a one-line change here.
const SOON = ['Dialer', 'Messages', 'SDR', 'Deals', 'Buyers'];

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
            <span
              key={label}
              style={{ padding: '9px 11px', fontSize: '0.92rem', color: '#5c6f8e', fontWeight: 600 }}
              title="Not built yet"
            >
              {label}
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
