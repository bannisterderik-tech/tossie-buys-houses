import { useEffect, useState } from 'react';
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
  const [menu, setMenu] = useState(false);

  /**
   * The sheet closes when you arrive somewhere.
   *
   * Without this it stays open over the page it just navigated to, because
   * the router swaps the view without unmounting the shell — so the operator
   * taps "Leads", the leads page renders underneath, and the screen still
   * shows the menu. Keyed on the path rather than on the click so it also
   * covers the back button and any link inside the sheet that is added later.
   */
  useEffect(() => { setMenu(false); }, [path]);

  /**
   * Escape closes it too. The sheet covers the whole screen below the bar, so
   * on a tablet with a keyboard there is otherwise no way out but the button
   * that opened it.
   */
  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  return (
    <div className="shell">
      {/* Phone only — display:none above the breakpoint. The desktop sidebar
          keeps its own brand and its own New lead button, so nothing here is
          a second copy of anything visible at the same time. */}
      <div className="navbar">
        <span className="brand">
          <img src={__BIZ__.logo} alt="" />
          <span>Tossie</span>
        </span>
        <a href="/app/leads/new" className="btn">+ Lead</a>
        <button
          className="menubtn"
          aria-expanded={menu}
          aria-controls="mainnav"
          onClick={() => setMenu((v) => !v)}
        >
          {menu ? 'Close' : 'Menu'}
        </button>
      </div>

      <aside id="mainnav" className={`sidebar${menu ? ' open' : ''}`}>
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
