import { useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { TEAM_ID } from '../lib/team.js';

/**
 * Add a lead by hand — a driving-for-dollars address, a referral, someone who
 * called the number on a sign.
 *
 * Consent is the one thing this form will not assume. A lead typed in here has
 * not agreed to anything, so tcpa_opt_in stays false and lead_is_dialable()
 * keeps it out of the dial queue until it is skip-traced and scrubbed. The
 * checkbox exists for the case where the seller called *us* and said so.
 */
export default function NewLeadPage() {
  const [f, setF] = useState({
    address: '', city: '', state: 'GA', zip: '',
    name: '', phone: '', email: '',
    motivation: '', notes: '',
    source: 'manual',
    inbound_consent: false,
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) =>
    setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setErr(null);

    if (!f.phone.trim() && !f.email.trim()) {
      setErr('A lead needs a phone or an email — otherwise there is no way to work it.');
      return;
    }

    setBusy(true);
    const { data, error } = await supabase
      .from('leads')
      .insert({
        team_id: TEAM_ID,
        address: f.address.trim() || null,
        city: f.city.trim() || null,
        state: f.state.trim() || null,
        zip: f.zip.trim() || null,
        name: f.name.trim() || null,
        phone: f.phone.trim() || null,
        email: f.email.trim() || null,
        motivation: f.motivation.trim() || null,
        notes: f.notes.trim() || null,
        source: f.source,
        // Only an inbound caller who said so gets consent. Everything else is
        // an outbound lead and has to earn its way into the dial queue.
        tcpa_opt_in: f.inbound_consent,
        tcpa_opt_in_at: f.inbound_consent ? new Date().toISOString() : null,
        tcpa_disclosure_source: f.inbound_consent ? 'verbal, inbound call' : null,
        consent_sms: f.inbound_consent,
        consent_email: f.inbound_consent,
      })
      .select('id')
      .single();
    setBusy(false);

    if (error) { setErr(error.message); return; }
    navigate(`/leads/${data.id}`);
  }

  return (
    <>
      <header><h1>New lead</h1></header>

      <form onSubmit={submit} style={{ maxWidth: 640 }}>
        {err && <div className="err">{err}</div>}

        <div className="card">
          <h2>Property</h2>
          <div className="body">
            <div className="fields">
              <label className="wide">Address
                <input value={f.address} onChange={set('address')} autoFocus placeholder="123 Main St" />
              </label>
              <label>City<input value={f.city} onChange={set('city')} /></label>
              <label>State<input value={f.state} onChange={set('state')} maxLength={2} /></label>
              <label>ZIP<input value={f.zip} onChange={set('zip')} /></label>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Seller</h2>
          <div className="body">
            <div className="fields">
              <label className="wide">Name<input value={f.name} onChange={set('name')} /></label>
              <label>Phone<input value={f.phone} onChange={set('phone')} type="tel" /></label>
              <label>Email<input value={f.email} onChange={set('email')} type="email" /></label>
              <label className="wide">Why are they selling?
                <input value={f.motivation} onChange={set('motivation')} placeholder="inherited, tired landlord, relocating…" />
              </label>
              <label className="wide">Notes
                <textarea value={f.notes} onChange={set('notes')} rows={3} />
              </label>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Source and consent</h2>
          <div className="body">
            <div className="fields">
              <label className="wide">Where did this come from?
                <select value={f.source} onChange={set('source')}>
                  <option value="manual">Typed in by hand</option>
                  <option value="driving_for_dollars">Driving for dollars</option>
                  <option value="referral">Referral</option>
                  <option value="inbound_call">They called us</option>
                  <option value="sign_call">Sign or bandit call</option>
                  <option value="cold_list">Cold list</option>
                </select>
              </label>
            </div>

            <label className="check">
              <input type="checkbox" checked={f.inbound_consent} onChange={set('inbound_consent')} />
              <span>
                <strong>They contacted us and agreed to be called and texted.</strong>
                <small>
                  Leave this unchecked for anything you found rather than anything that
                  found you. Unchecked leads stay out of the dial queue until they are
                  skip-traced and DNC-scrubbed — which is the rule that keeps a
                  $500-per-call mistake from happening.
                </small>
              </span>
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 9 }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Add lead'}
          </button>
          <button className="btn ghost" type="button" onClick={() => navigate('/')}>Cancel</button>
        </div>
      </form>
    </>
  );
}
