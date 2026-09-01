import { useState } from 'react';
import { supabase } from '../supabase.js';
import { useCan } from '../lib/capabilities.jsx';

/**
 * The link a seller fills in themselves.
 *
 * Five questions over five texts loses somebody on the third. One link asks
 * them all at once, on a screen, and gets photos — which no text thread ever
 * reliably will.
 *
 * The token is minted on demand rather than when the lead is created, because
 * most leads never need one, and a link that exists is a link that can leak.
 * Asking twice returns the same one: a seller sent it Tuesday and again
 * Thursday should land on the half-finished form they already started.
 */
export default function PortalLink({ leadId }) {
  const { can } = useCan();
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  if (!can('leads.edit')) return null;

  async function make() {
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.rpc('lead_portal_token', { p_lead_id: leadId });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setUrl(`${window.location.origin}/api/portal?t=${data}`);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Seller&rsquo;s own form</h2>
      <p className="cardnote">
        A page where the seller fills in the numbers and adds photos of the house. Their answers
        overwrite ours when the two disagree — they live there.
      </p>
      <div className="body">
        {err && <div className="err">{err}</div>}
        {!url ? (
          <button className="btn ghost" disabled={busy} onClick={make}>
            {busy ? 'Making the link…' : 'Get the link'}
          </button>
        ) : (
          <>
            <div className="srcfield">
              <span className="k">Send this</span>
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
              <button className="btn ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="fine" style={{ marginTop: 8 }}>
              Good for 90 days. Asking again gives the same link, so anything they have already
              typed is still there.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
