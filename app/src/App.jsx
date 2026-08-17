import { useEffect, useState } from 'react';
import { supabase, isConfigured } from './supabase.js';
import { useRoute, useLinkInterceptor, matchLeadId } from './router.js';
import AuthPage from './components/AuthPage.jsx';
import Layout from './components/Layout.jsx';
import LeadsPage from './pages/LeadsPage.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import BoardPage from './pages/BoardPage.jsx';
import NewLeadPage from './pages/NewLeadPage.jsx';
import TodayPage from './pages/TodayPage.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!isConfigured);
  const path = useRoute();
  useLinkInterceptor();

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!isConfigured) return <SetupNotice />;
  if (!ready) return null;
  if (!session) return <AuthPage />;

  const leadId = matchLeadId(path);

  return (
    <Layout session={session}>
      {/* /leads/new is checked before the :id route so "new" is never read as
          a lead id — matchLeadId only accepts a UUID, but the order documents
          the intent for whoever adds the next route. */}
      {path === '/leads/new' ? <NewLeadPage />
        : leadId ? <LeadDetail id={leadId} />
        : path === '/today' ? <TodayPage />
        : path === '/board' ? <BoardPage />
        : path === '/' ? <LeadsPage />
        : <NotFound path={path} />}
    </Layout>
  );
}

function NotFound({ path }) {
  return (
    <div className="empty">
      <strong>Nothing at {path}</strong>
      <a href="/app">Back to leads</a>
    </div>
  );
}

/**
 * Only reachable if someone explicitly sets VITE_SUPABASE_URL to an empty
 * string, since supabase.js falls back to the project's public config. Kept as
 * a real message rather than a blank screen for that case.
 */
function SetupNotice() {
  return (
    <div className="setup">
      <div className="card">
        <h2>Not connected</h2>
        <div className="body">
          <p style={{ marginBottom: 0 }}>
            This build has no Supabase URL or anon key. Unset{' '}
            <code style={{ display: 'inline', padding: '1px 5px' }}>VITE_SUPABASE_URL</code>{' '}
            to fall back to the project defaults, or set both to point at another project.
          </p>
        </div>
      </div>
    </div>
  );
}
