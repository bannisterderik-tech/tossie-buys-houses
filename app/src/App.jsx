import { useEffect, useState } from 'react';
import { supabase, isConfigured } from './supabase.js';
import { useRoute, useLinkInterceptor, matchLeadId, matchBuyerId, matchDealId, matchProspectId } from './router.js';
import AuthPage from './components/AuthPage.jsx';
import Layout from './components/Layout.jsx';
import LeadsPage from './pages/LeadsPage.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import NewLeadPage from './pages/NewLeadPage.jsx';
import TodayPage from './pages/TodayPage.jsx';
import ImportPage from './pages/ImportPage.jsx';
import DialerPage from './pages/DialerPage.jsx';
import MessagesPage from './pages/MessagesPage.jsx';
import SdrPage from './pages/SdrPage.jsx';
import PhoneSettingsPage from './pages/PhoneSettingsPage.jsx';
import BuyersPage from './pages/BuyersPage.jsx';
import BuyerDetail from './pages/BuyerDetail.jsx';
import DealsPage from './pages/DealsPage.jsx';
import DealDetail from './pages/DealDetail.jsx';
import CampaignsPage from './pages/CampaignsPage.jsx';
import ProspectsPage from './pages/ProspectsPage.jsx';
import ProspectDetail from './pages/ProspectDetail.jsx';
import TrashPage from './pages/TrashPage.jsx';
import TeamPage from './pages/TeamPage.jsx';
import { CapabilitiesProvider } from './lib/capabilities.jsx';

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
  const buyerId = matchBuyerId(path);
  const dealId = matchDealId(path);
  const prospectId = matchProspectId(path);

  return (
    <CapabilitiesProvider>
    <Layout session={session}>
      {/* /leads/new is checked before the :id route so "new" is never read as
          a lead id — matchLeadId only accepts a UUID, but the order documents
          the intent for whoever adds the next route. */}
      {path === '/leads/new' ? <NewLeadPage />
        : leadId ? <LeadDetail id={leadId} />
        : path === '/today' ? <TodayPage />
        : path === '/dialer' ? <DialerPage />
        : path === '/messages' ? <MessagesPage />
        // Routed because the webhook now dispatches to the SDR. In draft mode —
        // the mode this ships in — every reply the SDR writes waits in this
        // queue and reaches nobody until a human approves it, so an unrouted
        // page is not a missing screen, it is a seller who is never answered.
        : path === '/sdr' ? <SdrPage />
        // The buyers list is the asset a wholesaler actually owns, and it is
        // also the only audience Tossie's Low Volume Mixed A2P campaign can
        // defensibly be blasted to. Unrouted it is not a missing screen, it is
        // a dispo workflow with nowhere to record who agreed to be texted.
        : buyerId ? <BuyerDetail id={buyerId} />
        : path === '/buyers' ? <BuyersPage />
        // The board card navigates to /deals/:id, so leaving these unrouted is
        // not a missing screen — it is a board whose every card lands on "Nothing
        // at /deals/…". The two clocks on those cards are the inspection and
        // closing deadlines, which are the dates that cost real money when missed.
        : dealId ? <DealDetail id={dealId} />
        : path === '/deals' ? <DealsPage />
        // Unrouted, this page is worse than absent. The dispo blast is the only
        // bulk-SMS path that goes through broadcast-send, and broadcast-send is
        // the only thing that hands a campaign to twilio-send-sms. Without the
        // screen the audience ledger — the record of who was suppressed and why
        // — is a table nobody can read, which is the exact evidence a carrier
        // asks for when it reviews a Low Volume Mixed campaign.
        : path === '/campaigns' ? <CampaignsPage />
        // Import already writes cold lists into public.prospects, so unrouted
        // these are not a missing screen — they are rows that were bought, paid
        // for and stored with no way to look at them, and no way to reach the
        // one control that turns a cold call into a consent record. The detail
        // page is also the only place conversion happens, by design.
        : prospectId ? <ProspectDetail id={prospectId} />
        : path === '/prospects' ? <ProspectsPage />
        : path === '/import' ? <ImportPage />
        // The other half of every delete button. Unrouted, "it moves to Trash"
        // is a promise with nowhere to keep it.
        : path === '/trash' ? <TrashPage />
        : path === '/team' ? <TeamPage />
        // Leads and Board are one page with a view toggle. This stays as a deep
        // link so existing bookmarks land somewhere real; the key forces a
        // remount so arriving here actually selects the board, rather than
        // React reusing the instance and keeping the last-used view.
        : path === '/board' ? <LeadsPage key="board" initialView="board" />
        : path === '/settings/phone' ? <PhoneSettingsPage />
        : path === '/' ? <LeadsPage />
        : <NotFound path={path} />}
    </Layout>
    </CapabilitiesProvider>
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
