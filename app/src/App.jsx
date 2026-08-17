import { useEffect, useState } from 'react';
import { supabase, isConfigured } from './supabase.js';
import { useRoute, useLinkInterceptor, matchLeadId } from './router.js';
import AuthPage from './components/AuthPage.jsx';
import Layout from './components/Layout.jsx';
import LeadsPage from './pages/LeadsPage.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import BoardPage from './pages/BoardPage.jsx';

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
      {leadId ? <LeadDetail id={leadId} />
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
 * Shown when the build has no Supabase credentials — which is the state of
 * every build until Tossie's project is connected. Better than a blank screen
 * or a console error nobody sees.
 */
function SetupNotice() {
  return (
    <div className="setup">
      <div className="card">
        <h2>Not connected yet</h2>
        <div className="body">
          <p>This build has no Supabase credentials, so there is nothing to sign in to.</p>
          <p>Set both in Vercel → Project → Settings → Environment Variables, then redeploy:</p>
          <code>{'VITE_SUPABASE_URL=https://<ref>.supabase.co\nVITE_SUPABASE_ANON_KEY=<anon key>'}</code>
          <p style={{ color: 'var(--muted)', fontSize: '0.86rem', marginBottom: 0 }}>
            The anon key is safe in the browser bundle — every query is scoped by
            row-level security. The service_role key must never be set with a
            <code style={{ display: 'inline', padding: '1px 5px', margin: '0 3px' }}>VITE_</code>
            prefix, because that would publish it.
          </p>
        </div>
      </div>
    </div>
  );
}
