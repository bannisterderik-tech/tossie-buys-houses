import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import DeleteButton from '../components/DeleteButton.jsx';
import InlineField from '../components/InlineField.jsx';
import { titleize, formatPhone, fullDate, timeAgo, dateOnly } from '../lib/format.js';
import { callingWindow } from '../lib/calling-window.js';
import {
  BUYER_STATUSES, BUYER_CONSENT_SOURCES, REHAB_TOLERANCE, FUNDING,
  geography, money, pofStatus, textingBlock,
} from '../lib/buyers.js';
// The consent panel's styles live with the lead page's compliance card, because
// that is where the pattern started. Imported explicitly rather than left to
// chance: LeadDetail also imports it, so today the rules are in the bundle
// either way, and the day somebody code-splits the routes this page would
// otherwise silently lose its styling.
import './lead-comms.css';

/**
 * One buyer: the buy box, the proof of funds, the track record, and every deal
 * they have ever been shown.
 *
 * The buy box is the whole point of the page. match_buyers_for_deal() reads
 * these columns and nothing else, so a buy box typed accurately here is the
 * difference between a ranked list of four people who want this exact house and
 * a blast to everybody — and a blast to everybody is how Tossie's Low Volume
 * Mixed A2P campaign gets suspended and how buyers learn to ignore the texts.
 *
 * Everything is editable in place, the way the lead page is, because a buy box
 * is corrected mid-conversation ("no, I stopped doing full guts last year") and
 * a form with an Edit button costs three clicks to record one fact.
 *
 * There is no delete. Status covers the real cases — `paused` for a buyer who
 * is out of money this quarter, `blacklisted` for one you will not sell to
 * again — and deleting the row cascades buyer_deal_interest, which is the
 * record of who was texted about what and why they were on the list. That
 * record is the evidence the audience was segmented, and it should outlive the
 * relationship.
 */
export default function BuyerDetail({ id }) {
  const [buyer, setBuyer] = useState(null);
  const [interest, setInterest] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // Which buyer the state on screen belongs to. Routing from one buyer to
  // another keeps this component mounted and only swaps the prop, so without
  // this the previous buyer's row — including their compliance card and their
  // Call button — renders under the new buyer's URL until the fetch lands, and
  // a slow first response can overwrite a fast second one for good.
  const shownFor = useRef(null);

  const load = useCallback(async () => {
    const [b, i] = await Promise.all([
      // skip_reason is public.buyer_skip_reason, read off the row rather than
      // re-derived. See the note in lib/buyers.js — the one direction this page
      // must never be wrong in is claiming somebody is textable.
      supabase.from('buyers').select('*, skip_reason:buyer_skip_reason').eq('id', id).single(),
      supabase
        .from('buyer_deal_interest')
        .select('*, deal:deals(id, address, city, state, status, buyer_price, assigned_buyer_id, actual_close_date)')
        .eq('buyer_id', id)
        .order('created_at', { ascending: false }),
    ]);

    if (shownFor.current !== id) return;   // the route moved on while we waited

    if (b.error) setErr(b.error.message);
    else setBuyer(b.data);
    // A failed read of the deal history must not render as "never been shown a
    // deal". Whatever was there stays there and says so.
    if (i.error) setErr(`Could not load this buyer's deal history (${i.error.message}).`);
    else setInterest(i.data ?? []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    shownFor.current = id;
    setBuyer(null);
    setInterest([]);
    setErr(null);
    setLoading(true);
    load();
  }, [id, load]);

  const patch = useCallback(async (fields) => {
    setErr(null);
    setBuyer((prev) => {
      const next = { ...prev, ...fields };          // optimistic
      // …except for the computed column, which is dropped rather than carried
      // forward. buyer_skip_reason was computed from the row as it was, and the
      // fields edited on this page include every input it reads — status, both
      // numbers, consent_sms. Keeping the old answer means that for as long as
      // the write is in flight the compliance card asserts "Textable: Yes"
      // about a row that is no longer the row it was told about, and offers the
      // consent controls on the strength of it. textingBlock() reads a missing
      // skip_reason as "cannot tell" and hides them, which is the only safe
      // direction to be wrong in for that second.
      delete next.skip_reason;
      return next;
    });
    const { error } = await supabase.from('buyers').update(fields).eq('id', id);
    if (error) setErr(explainWrite(error.message));
    await load();                                   // truth, whichever way it went
  }, [id, load]);

  // Inputs hand back strings; these columns are integers and numerics.
  const patchNumber = (field) => (v) =>
    patch({ [field]: v === null ? null : Number(String(v).replace(/[^\d.-]/g, '')) || null });

  /**
   * Same idea, for the three NOT NULL counters.
   *
   * patchNumber's `|| null` turns a typed 0 into null, which is right for
   * price_min (unset means no limit) and a NOT NULL violation for deals_closed.
   * Clearing a count means zero, not unknown.
   */
  const patchCount = (field) => (v) => {
    const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
    patch({ [field]: Number.isFinite(n) && n >= 0 ? Math.round(n) : 0 });
  };

  /**
   * The three text[] buy-box columns, edited as a comma-separated line.
   *
   * Cleared field means an empty array, never null: the columns are NOT NULL,
   * and an empty array is the "no restriction" value the matcher expects.
   */
  const patchList = (field) => (v) =>
    patch({ [field]: String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean) });

  if (loading) return <div className="empty">Loading…</div>;
  if (!buyer) {
    return (
      <div className="empty">
        <strong>Buyer not found</strong>
        <a href="/app/buyers">Back to buyers</a>
      </div>
    );
  }

  const block = textingBlock(buyer);
  const pof = pofStatus(buyer);

  return (
    <>
      <header>
        <h1>{buyer.name}</h1>
        <span className="count">
          {[buyer.entity_name, geography(buyer, 4) || 'buys anywhere'].filter(Boolean).join(' · ')}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <button className="btn ghost" onClick={() => navigate('/buyers')}>← All buyers</button>
        <select value={buyer.status} onChange={(e) => patch({ status: e.target.value })}>
          {BUYER_STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <CallButton buyer={buyer} block={block} />
        <span style={{ flex: 1 }} />
        <DeleteButton table="buyers" id={buyer.id} name={buyer.name} />
      </div>

      {/* Above the fold and before anything else, because it changes what the
          rest of the page is for. A buyer who cannot be texted is still worth
          calling — the buy box below is still the reason to call them — but the
          operator has to know which of the two they are looking at before they
          start planning a blast around this person. */}
      <TextingCard buyer={buyer} block={block} onDone={load} onPatch={patch} />

      <div className="detail">
        <div>
          <div className="card">
            <h2>Buy box</h2>
            <p className="cardnote">
              What match_buyers_for_deal reads, and the only thing it reads. An empty field is
              &ldquo;no restriction&rdquo;, not &ldquo;matches nothing&rdquo; — leave anything blank
              that they never actually said.
            </p>
            <div className="body">
              <dl className="facts editable">
                <InlineField
                  label="Counties" value={(buyer.counties || []).join(', ')}
                  onSave={patchList('counties')} placeholder="anywhere — comma separated"
                />
                <InlineField
                  label="Zips" value={(buyer.zips || []).join(', ')}
                  onSave={patchList('zips')} placeholder="any zip"
                />
                <InlineField
                  label="Property types" value={(buyer.property_types || []).join(', ')}
                  onSave={patchList('property_types')} placeholder="single family, duplex…"
                />
                <InlineField label="Price min" value={buyer.price_min} onSave={patchNumber('price_min')} format={money} placeholder="no floor" />
                <InlineField label="Price max" value={buyer.price_max} onSave={patchNumber('price_max')} format={money} placeholder="no ceiling" />
                <InlineField label="Beds min" value={buyer.beds_min} onSave={patchNumber('beds_min')} placeholder="any" />
                {/* Compared against deals.buyer_spread — ARV less repairs less
                    what they pay us — and never against our own spread. Quoting
                    a buyer a margin that includes Tossie's assignment fee is how
                    you lose the buyer on the second deal. */}
                <InlineField label="Min spread" value={buyer.min_spread} onSave={patchNumber('min_spread')} format={money} placeholder="none stated" />
                <InlineField label="Rehab up to" value={buyer.rehab_tolerance} onSave={(v) => patch({ rehab_tolerance: v })} options={REHAB_TOLERANCE} placeholder="any condition" />
                <InlineField label="Funding" value={buyer.funding} onSave={(v) => patch({ funding: v })} options={FUNDING} placeholder="unknown" />
                <InlineField label="Closes in" value={buyer.typical_close_days} onSave={patchNumber('typical_close_days')} format={(v) => `${v} days`} placeholder="unknown" />
              </dl>

              <div className="flags">
                {/* A column rather than a line in the notes because it is the
                    single most common reason a buyer walks after saying yes,
                    and because the matcher excludes owner- and tenant-occupied
                    deals for anyone who has not said yes to it. */}
                <label className="flag">
                  <input
                    type="checkbox"
                    checked={Boolean(buyer.takes_occupied)}
                    onChange={(e) => patch({ takes_occupied: e.target.checked })}
                  />
                  Will take an occupied or tenanted property
                </label>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Contact</h2>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Name" value={buyer.name} onSave={(v) => patch({ name: v })} />
                <InlineField label="Entity" value={buyer.entity_name} onSave={(v) => patch({ entity_name: v })} placeholder="the name on the assignment" />
                <InlineField label="Phone" value={buyer.phone} onSave={(v) => patch({ phone: v })} format={formatPhone} />
                <InlineField label="Second number" value={buyer.phone_secondary} onSave={(v) => patch({ phone_secondary: v })} format={formatPhone} placeholder="office, partner…" />
                <InlineField label="Email" value={buyer.email} onSave={(v) => patch({ email: v })} type="email" />
                <dt>Added</dt><dd className="fine">{fullDate(buyer.created_at)}</dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Proof of funds</h2>
            <p className="cardnote">
              The date matters more than the file. A bank letter from last year proves they had money
              last year, and an unverified buyer is the one who ties up a contract for nine days and
              then cannot close.
            </p>
            <div className="body">
              <div className={`pofstate ${pof.tone}`}>{pof.words}</div>
              <dl className="facts editable">
                <InlineField label="Amount" value={buyer.proof_of_funds_amount} onSave={patchNumber('proof_of_funds_amount')} format={money} placeholder="how much did it show?" />
                <InlineField label="Dated" value={buyer.proof_of_funds_date} onSave={(v) => patch({ proof_of_funds_date: v })} type="date" />
                <InlineField label="Link" value={buyer.proof_of_funds_url} onSave={(v) => patch({ proof_of_funds_url: v })} type="url" placeholder="where the letter lives" />
              </dl>
              {buyer.proof_of_funds_url && (
                <p className="fine" style={{ marginTop: 10 }}>
                  <a href={buyer.proof_of_funds_url} target="_blank" rel="noreferrer noopener">Open the proof of funds ↗</a>
                </p>
              )}
            </div>
          </div>

          <DealHistory rows={interest} buyerId={id} />

          <div className="card">
            <h2>Notes</h2>
            <p className="cardnote">
              Everything the buy-box fields cannot hold: who they use for money, what they walked on
              and why, who actually answers the phone.
            </p>
            <div className="body">
              <dl className="facts editable">
                <InlineField
                  label="Notes" value={buyer.notes} onSave={(v) => patch({ notes: v })}
                  type="textarea" placeholder="click to write"
                />
              </dl>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Track record</h2>
            <p className="cardnote">
              Kept by hand for now — nothing writes these yet. They are worth keeping accurate
              anyway: match_buyers_for_deal scores every one of them, and reneges cost more points
              than closings earn.
            </p>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Closed" value={buyer.deals_closed} onSave={patchCount('deals_closed')} />
                <InlineField label="Reneged" value={buyer.deals_reneged} onSave={patchCount('deals_reneged')} />
                <InlineField label="Avg close" value={buyer.avg_close_days} onSave={patchNumber('avg_close_days')} format={(v) => `${Math.round(Number(v))} days`} placeholder="unknown" />
                <InlineField label="Last bought" value={buyer.last_purchase_date} onSave={(v) => patch({ last_purchase_date: v })} type="date" />
                <InlineField label="Rating" value={buyer.rating} onSave={patchNumber('rating')} options={['1', '2', '3', '4', '5']} format={(v) => `${v} of 5`} placeholder="unrated" />
              </dl>

              {buyer.deals_reneged > 0 && (
                <p className="fine" style={{ marginTop: 12 }}>
                  {/* Said out loud on the page rather than left as a number to
                      interpret. A buyer who has closed six and reneged three is
                      not a better buyer than one who has closed two and reneged
                      none, and volume is the metric that says he is. */}
                  <strong>Backed out {buyer.deals_reneged} {buyer.deals_reneged === 1 ? 'time' : 'times'} after being
                  selected.</strong>{' '}
                  That is contract time somebody else could have had. Weigh it against the closings
                  before this one gets the first call.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Known constraint violations, in words.
 *
 * Inline editing means the operator is one keystroke from a write, so the error
 * lands mid-thought. "violates check constraint buyers_price_range_check" names
 * a thing they cannot see and does not say which of the two fields to change.
 */
function explainWrite(message) {
  if (/buyers_price_range_check/.test(message)) return 'The price floor has to be at or below the ceiling.';
  if (/buyers_has_contact/.test(message)) return 'A buyer needs a phone number or an email — that would leave neither.';
  if (/buyers_rating_check/.test(message)) return 'Rating runs 1 to 5.';
  if (/buyers_rehab_tolerance_check/.test(message)) return `Rehab tolerance has to be one of: ${REHAB_TOLERANCE.join(', ')}.`;
  if (/buyers_funding_check/.test(message)) return `Funding has to be one of: ${FUNDING.join(', ')}.`;
  if (/buyers_team_phone_key_idx/.test(message)) return 'Another buyer on the list already has that number. Two rows for one buyer means the dispo blast texts them twice.';
  if (/buyers_opt_in_needs_provenance/.test(message)) return 'Consent cannot be set by hand — use "Record consent" so the source and the date go on the record with it.';
  // Reachable from an inline field, which turns an emptied box into NULL: the
  // three NOT NULL columns an operator can actually clear are name and the two
  // counters, and patchCount already floors those at zero.
  if (/null value in column "name"/.test(message)) return 'A buyer needs a name. Type something, even if it is only what you have.';
  return message;
}

/* ── may we call this buyer ──────────────────────────────────────────────── */

/**
 * Call, gated on the two things that gate it on the lead page.
 *
 * `tel:` hands the call to the operating system and the browser never hears
 * what happened, so this link is the last rail there is — there is no voice
 * edge function to re-check anything at dial time. See the header of
 * lib/calling-window.js, which says so at length.
 *
 * It blocks on exactly two grounds, and the shortness of that list is the
 * point:
 *
 *   A STOP on either number. telephony_opt_outs is Tossie's one suppression
 *   registry, and lead_is_dialable() already treats a STOP as suppressing the
 *   dialer and not just the texts. Offering a buyer who asked us to stop a
 *   one-tap call because "the STOP was only about SMS" is a distinction this
 *   codebase does not make anywhere else, and not one worth defending to the
 *   FCC.
 *
 *   Outside 8am–9pm where the phone is ringing. A dispo call is an offer to
 *   sell property; it is a solicitation, and the damages are per call.
 *
 * It deliberately does NOT block on `no_consent` or on a paused or blacklisted
 * status. A buyer with no SMS consent is precisely the buyer you pick up the
 * phone to — that call is how consent gets obtained — and the card below
 * already says a buyer who cannot be texted is still worth calling. Blocking
 * the only remaining way to reach them would be over-blocking that costs deals
 * and buys no compliance.
 *
 * The buyer's zone is resolved from the area code alone. Buyers carry no state
 * column, which is honest: unlike a seller there is no mailing address on file
 * to disagree with the number.
 */
function CallButton({ buyer, block }) {
  if (!buyer.phone) return null;

  const win = callingWindow({ phone: buyer.phone });
  // 'unknown' is skip_reason not having loaded, or having been dropped while a
  // write is in flight. It is not a STOP and must not be labelled as one, but
  // it is equally not a licence to dial: we cannot currently tell whether one
  // of their numbers carries a stop, and the only safe reading of "cannot tell"
  // is no.
  const reason = block ? block.reason : null;
  const shut = reason === 'opted_out' ? 'stop'
    : reason === 'unknown' ? 'unknown'
    : !win.allowed ? 'window'
    : null;

  if (shut) {
    return (
      <span
        className="btn ghost stopped"
        aria-disabled="true"
        title={
          shut === 'stop'
            ? 'One of their numbers is in telephony_opt_outs. Nothing on this page lifts that.'
            : shut === 'unknown'
              ? 'buyer_skip_reason has not loaded for this row, so nothing here can vouch that they have not asked us to stop.'
              : win.reason === 'unknown_timezone'
                ? 'Cannot work out what time it is for this number, so this stays shut.'
                : `It is ${win.localTime} for this number — TCPA allows 8am to 9pm in their local time.`
        }
      >
        {shut === 'stop' ? 'Do not call — STOP on file'
          : shut === 'unknown' ? 'Checking…'
          : 'Outside calling hours'}
      </span>
    );
  }

  // Formatting stripped, the same way the lead page does it: a tel: URI with
  // parentheses and spaces in it is at the mercy of whatever the OS makes of
  // it, and what it makes of it is sometimes the wrong number.
  return (
    <a className="btn ghost" href={`tel:${buyer.phone.replace(/[^\d+]/g, '')}`}>
      Call {formatPhone(buyer.phone)}
      {win.guessed && <span className="fine"> · zone guessed</span>}
    </a>
  );
}

/* ── may we text this buyer ──────────────────────────────────────────────── */

/**
 * The compliance readout, same shape as the one on the lead page and for the
 * same reason: the operator needs the answer and the reason in one place,
 * before they plan anything around this person.
 *
 * What is different from the seller side is the argument, and it is worth
 * writing down because it is the one people push back on. Cash buyers are
 * businesses, and "it's a business contact" is not a TCPA defence — these are
 * cell numbers, a dispo blast is bulk marketing, and the statutory damages are
 * per text. On top of that Tossie's A2P 10DLC campaign is registered Low Volume
 * Mixed: the defensible traffic under it is messages to buyers who asked to
 * hear about deals, and the evidence that they asked is exactly what this card
 * records.
 */
function TextingCard({ buyer, block, onDone, onPatch }) {
  return (
    <div className="card">
      <h2>Texting</h2>
      <div className="body">
        <dl className="facts">
          <dt>Textable</dt>
          <dd>
            {/* buyer_skip_reason() decided this; the card only reads it out. */}
            {block ? <span className="badge stop">{block.words}</span> : <span className="badge ok">Yes</span>}
          </dd>
          <dt>Consent</dt>
          <dd>{[buyer.consent_sms && 'SMS', buyer.consent_email && 'Email'].filter(Boolean).join(' · ') || 'None'}</dd>
          <dt>TCPA opt-in</dt>
          <dd>{buyer.tcpa_opt_in ? fullDate(buyer.tcpa_opt_in_at) : 'No'}</dd>
          <dt>How</dt>
          <dd>{buyer.tcpa_disclosure_source || '—'}</dd>
        </dl>

        {block && block.fix && (
          <div className={`banner ${block.reason === 'opted_out' ? 'stop' : 'warn'}`} style={{ marginTop: 14 }}>
            <strong>Not blastable: {block.words.toLowerCase()}.</strong>
            {block.fix}
          </div>
        )}

        {!block && (
          <p className="fine" style={{ marginTop: 12 }}>
            They will appear in buy-box matches and can be included in a dispo blast. Every send
            still goes through twilio-send-sms, which re-checks the opt-out, the calling window and
            the A2P state at the moment it sends.
          </p>
        )}

        {buyer.tcpa_disclosure_text && (
          <details style={{ marginTop: 14, fontSize: '0.83rem', color: 'var(--muted)' }}>
            <summary style={{ cursor: 'pointer' }}>
              What is on the record ({buyer.tcpa_disclosure_version || 'unversioned'})
            </summary>
            <p style={{ marginTop: 8 }}>{buyer.tcpa_disclosure_text}</p>
          </details>
        )}

        <ConsentControl buyer={buyer} block={block} onDone={onDone} onPatch={onPatch} />
      </div>
    </div>
  );
}

/**
 * Which control to offer, and this is the part that has to be right.
 *
 * Recording consent is never offered on top of an opt-out. A buyer with a STOP
 * on file asked us to stop; a consent record written after that is not evidence
 * of anything except that somebody clicked past a suppression. The seller page
 * calls the same idea `vetoed` and hides the control the same way — the fix for
 * a STOP is a phone call, not a button.
 *
 * A blacklisted or paused buyer is not offered it either. That state is a
 * decision Tossie made, and the way to undo a decision is to undo the decision,
 * at the top of the page, where it says what it is.
 */
function ConsentControl({ buyer, block, onDone, onPatch }) {
  const vetoed = block && (block.reason === 'opted_out' || block.reason === 'buyer_inactive' || block.reason === 'unknown');
  if (vetoed) return null;
  if (buyer.consent_sms && buyer.tcpa_opt_in) return <StopTexting buyer={buyer} onPatch={onPatch} />;
  return <RecordConsent buyerId={buyer.id} onDone={onDone} />;
}

function RecordConsent({ buyerId, onDone }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const resolved = (source === '__other' ? other : source).trim();

  function reset() {
    setOpen(false); setSource(''); setOther(''); setNote(''); setErr(null);
  }

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('record_buyer_consent', {
      p_buyer_id: buyerId,
      p_source: resolved,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    reset();
    onDone?.();
  }

  if (!open) {
    return (
      <div className="consentbar">
        <div><button className="btn ghost" onClick={() => setOpen(true)}>Record consent…</button></div>
        <span className="fine">
          There is no SMS consent on this buyer, so they are held out of every blast. If they asked
          to hear about deals, record how — it goes on the record with the date.
        </span>
      </div>
    );
  }

  return (
    <div className="consentpanel">
      <strong>Record consent to text this buyer</strong>
      <p className="fine">
        <strong>This is a legal record.</strong> It is timestamped and it is what answers &ldquo;who
        said we could text them&rdquo; if a carrier reviews the campaign or a demand letter arrives.
        Record it only if they actually asked.
      </p>
      <p className="fine">
        It lifts nothing. A STOP on either of their numbers is a separate matter and this would not
        be offered while one stood.
      </p>

      <label className="consentfield">
        How was it obtained? Required — the RPC refuses a blank source.
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Choose…</option>
          {BUYER_CONSENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="__other">Something else — type it</option>
        </select>
      </label>

      {source === '__other' && (
        <label className="consentfield">
          In your own words
          <input
            value={other} onChange={(e) => setOther(e.target.value)}
            placeholder="asked at the Thursday meetup to be added to the list"
            autoComplete="off" autoFocus
          />
        </label>
      )}

      <label className="consentfield">
        Anything worth adding? Optional, kept with it.
        <input
          value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="only wants Chatham and only under 200k"
          autoComplete="off"
        />
      </label>

      {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

      <div className="confirmbtns">
        <button className="btn" onClick={run} disabled={!resolved || busy}>
          {busy ? 'Recording…' : 'Record consent'}
        </button>
        <button className="btn ghost" onClick={reset} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Deliberately lighter than granting it.
 *
 * A buyer saying "stop sending me these" must never be harder to act on than a
 * buyer saying "add me" — so this is a link, no confirmation, no reason field.
 *
 * It clears consent_sms and leaves tcpa_opt_in and the disclosure columns
 * alone. That is not laziness: stopping applies going forward, and deleting the
 * record that they once agreed would destroy the only evidence for every text
 * already sent. buyer_is_textable() requires both flags, so clearing the one is
 * enough to suppress them everywhere.
 */
function StopTexting({ buyer, onPatch }) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="consentheld">
      <span className="held">
        Consent on file{buyer.tcpa_opt_in_at ? ` since ${fullDate(buyer.tcpa_opt_in_at)}` : ''}
        {buyer.tcpa_disclosure_source ? ` — ${buyer.tcpa_disclosure_source}` : ''}.
      </span>
      <div>
        <button
          className="linkbtn"
          disabled={busy}
          onClick={async () => { setBusy(true); await onPatch({ consent_sms: false }); setBusy(false); }}
        >
          {busy ? 'Stopping…' : 'Stop texting this buyer'}
        </button>
      </div>
      <span className="fine">
        Takes them out of every blast immediately. What they agreed to and when stays on the record —
        stopping going forward does not unmake the fact that they asked.
      </span>
    </div>
  );
}

/* ── every deal this buyer has been shown ────────────────────────────────── */

/** Only three of these are good news, and the badge should not pretend otherwise. */
const INTEREST_TONE = {
  interested: 'ok',
  offered: 'ok',
  selected: 'ok',
  walked: 'stop',
  passed: 'dead',
  reneged: 'stop',
};

/**
 * The relationship, in order.
 *
 * This is also where a renege stops being an abstract counter: the row says
 * which house, for how much, and when they backed out of it. Sorted newest
 * first because the last thing that happened is what the operator is deciding
 * against.
 */
function DealHistory({ rows, buyerId }) {
  return (
    <div className="card">
      <h2>Deals</h2>
      <div className="body">
        {rows.length === 0 ? (
          <p className="fine" style={{ margin: 0 }}>
            This buyer has not been shown a deal yet. They will appear on a dispo blast when a deal
            fits their buy box and they are textable.
          </p>
        ) : (
          <ul className="dealhist">
            {rows.map((r) => {
              const d = r.deal;
              const won = d && d.assigned_buyer_id === buyerId;
              return (
                <li key={r.id}>
                  <div className="line">
                    <span className={`badge ${INTEREST_TONE[r.status] || ''}`}>{titleize(r.status)}</span>
                    <span className="what">
                      {d
                        ? <a href={`/app/deals/${d.id}`}>{d.address}</a>
                        : <em>deal deleted</em>}
                      {d && (d.city || d.state) && <span className="where"> {[d.city, d.state].filter(Boolean).join(', ')}</span>}
                    </span>
                    <span className="spacer" />
                    {won && <span className="badge ok">Assigned to them</span>}
                    <span className="sub">{timeAgo(r.responded_at || r.viewed_at || r.notified_at || r.created_at)}</span>
                  </div>

                  <div className="sub">
                    {[
                      r.offer_amount != null ? `Offered ${money(r.offer_amount)}${r.offer_date ? ` on ${dateOnly(r.offer_date)}` : ''}` : null,
                      d && d.buyer_price != null ? `Asked ${money(d.buyer_price)}` : null,
                      d && d.actual_close_date ? `Closed ${dateOnly(d.actual_close_date)}` : null,
                    ].filter(Boolean).join(' · ')}
                  </div>

                  {r.notes && <div className="sub">{r.notes}</div>}

                  {/* The score and the reasons as they were when the text went
                      out, not as they would be now. The buy box, the deal
                      numbers and the track record all move; this is the only
                      thing that can answer "why was this person on that list"
                      months later, and it is the segmentation evidence if the
                      A2P campaign is ever reviewed. */}
                  {(r.match_score != null || (r.match_reasons || []).length > 0) && (
                    <details className="matchwhy">
                      <summary>
                        Matched at {r.match_score ?? '—'}/100 when this went out
                      </summary>
                      <ul>
                        {(r.match_reasons || []).map((why, n) => <li key={n}>{why}</li>)}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
