import { useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import { navigate } from '../router.js';
import { formatPhone, titleize } from '../lib/format.js';

/**
 * One buyer, one deal, one call.
 *
 * Different from the seller card on purpose. A seller call ends in a
 * disposition about the seller; a dispo call ends in a fact about *this deal* —
 * whether this buyer wants it — and that fact belongs in buyer_deal_interest,
 * which is what the deal's dispo funnel counts and what the Deals board reads.
 * Logging it as a note on the buyer would leave the funnel showing zero
 * interest on a deal that had six conversations.
 *
 * There is no calling-window gate here. The 8am–9pm rule is the TCPA rule for
 * calling consumers at home; these are business contacts being called about a
 * property, on numbers they gave for that purpose. twilio-voice is still the
 * rail for whether the call may be placed at all.
 */
const OUTCOMES = [
  { status: 'interested', label: 'Interested',   tone: 'ok',   hint: 'Wants it or wants more' },
  { status: 'offered',    label: 'Made an offer', tone: 'ok',  hint: 'Named a number' },
  { status: 'passed',     label: 'Passed',       tone: 'stop', hint: 'Not for them' },
  { status: 'viewed',     label: 'No answer',    tone: '',     hint: 'Left a message or missed them' },
];

export default function BuyerOnDeck({ member, buyer, deal, at, of, onSkip, onLogged }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState(null);

  const number = buyer.phone || buyer.phone_secondary;

  async function log(outcome) {
    setBusy(outcome.status);
    setErr(null);

    const row = {
      team_id: TEAM_ID,
      deal_id: deal.id,
      buyer_id: buyer.id,
      status: outcome.status,
      notes: note.trim() || null,
      match_score: member.match_score,
      match_reasons: member.match_reasons ?? [],
      responded_at: new Date().toISOString(),
    };
    if (outcome.status === 'offered') {
      const n = Number(String(amount).replace(/[^\d.]/g, ''));
      if (n > 0) { row.offer_amount = Math.round(n); row.offer_date = new Date().toISOString().slice(0, 10); }
    }

    // One row per (deal, buyer) — the table has a unique constraint, and a
    // second call about the same property should update where they got to
    // rather than start a parallel history.
    const { error } = await supabase
      .from('buyer_deal_interest')
      .upsert(row, { onConflict: 'deal_id,buyer_id' });

    if (error) { setErr(error.message); setBusy(null); return; }

    await supabase
      .from('dial_campaign_members')
      .update({ status: 'called', called_at: new Date().toISOString(), outcome: outcome.status })
      .eq('id', member.id);

    setBusy(null);
    setNote('');
    setAmount('');
    onLogged();
  }

  return (
    <div className="card oncall">
      <h2>On deck · {at + 1} of {of}</h2>
      <div className="body">
        <div className="oncall-head">
          <div>
            <h3 style={{ margin: 0 }}>
              <a href={`/app/buyers/${buyer.id}`} onClick={(e) => { e.preventDefault(); navigate(`/buyers/${buyer.id}`); }}>
                {buyer.name}
              </a>
            </h3>
            <p className="sub" style={{ margin: '3px 0 0' }}>
              {[buyer.entity_name, formatPhone(number)].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            {member.match_score != null && (
              <span className="badge ok">Buy-box {member.match_score}</span>
            )}
          </div>
        </div>

        <div className="notice" style={{ marginTop: 10 }}>
          <strong>Pitching {deal.address}</strong>
          {[[deal.city, deal.state].filter(Boolean).join(', '),
            deal.contract_price ? `contract $${deal.contract_price.toLocaleString()}` : null,
            deal.beds && deal.baths ? `${deal.beds}/${deal.baths}` : null,
            deal.sqft ? `${deal.sqft.toLocaleString()} sqft` : null,
          ].filter(Boolean).join(' · ')}
        </div>

        {member.match_reasons?.length > 0 && (
          <p className="sub" style={{ marginTop: 8 }}>
            Why them: {member.match_reasons.join(' · ')}
          </p>
        )}

        {err && <div className="err">{err}</div>}

        <div className="toolbar" style={{ marginTop: 12 }}>
          {number
            ? <a className="btn" href={`tel:${number.replace(/[^\d+]/g, '')}`}>Call {formatPhone(number)}</a>
            : <span className="badge stop">No number on file</span>}
          <button className="btn ghost" onClick={onSkip}>Skip</button>
        </div>

        <label className="consentfield" style={{ marginTop: 12 }}>
          What did they say? <span className="fine">optional, goes on the deal</span>
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Wants photos, can close in 10 days…" />
        </label>

        <label className="consentfield">
          If they made an offer <span className="fine">optional</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$62,000" />
        </label>

        <div className="dispobar">
          {OUTCOMES.map((o) => (
            <button
              key={o.status}
              className={`btn ghost ${o.tone}`}
              disabled={busy !== null}
              title={o.hint}
              onClick={() => log(o)}
            >
              {busy === o.status ? 'Saving…' : o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
