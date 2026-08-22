import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import DeleteButton from '../components/DeleteButton.jsx';
import FollowUpField from '../components/FollowUpField.jsx';
import InlineField from '../components/InlineField.jsx';
import PropertyLinks from '../components/PropertyLinks.jsx';
import PhotoGallery from '../components/PhotoGallery.jsx';
import ContractPanel from '../components/ContractPanel.jsx';
import DispositionBar from '../components/DispositionBar.jsx';
import { DeliveryChip, DeliveryFailure } from '../components/DeliveryState.jsx';
import { SoftphoneControl, SoftphoneNotice, useSoftphone } from '../components/Softphone.jsx';
import { callingWindow } from '../lib/calling-window.js';
import { MAX_BODY, deliveryState, explainRefusal, refusalFrom } from '../lib/sms-refusals.js';
import { TEAM_ID } from '../lib/team.js';
import {
  STATUSES, TEMPERATURES, OCCUPANCY,
  titleize, formatPhone, fullAddress, fullDate, timeAgo,
} from '../lib/format.js';
import './lead-comms.css';
import './delivery-status.css';

const money = (v) => `$${Number(v).toLocaleString()}`;

/**
 * Mirrors public.phone_key(): the last ten digits, never the formatted number.
 *
 * telephony_opt_outs stores keys, not numbers, because Twilio posts
 * +19125550134 and the seller typed (912) 555-0134. Matching on anything else
 * here would show "no opt-out on file" for a lead who is in fact suppressed —
 * the one direction this page must never be wrong in.
 */
function phoneKey(v) {
  return String(v ?? '').replace(/\D/g, '').slice(-10) || null;
}

/**
 * telephony_opt_outs.source in words. Not titleize(): the stored values are
 * storage, and "Sms stop" on the one line an operator reads before overriding a
 * suppression is the wrong register for what that line has to convey.
 */
const OPT_OUT_SOURCE = {
  sms_stop:  'a STOP text',
  manual:    'a manual entry',
  verbal:    'a verbal request',
  dnc_scrub: 'a DNC scrub',
};
const optOutSource = (s) => OPT_OUT_SOURCE[s] || s || 'an unrecorded source';

/**
 * How consent was obtained, in the operator's words rather than the schema's.
 *
 * These four are the ways a wholesaler actually gets it, and they are presets
 * rather than a free-text box because "how" is the field a plaintiff's attorney
 * reads first, and "yes" typed into a box is not an answer. Free text is still
 * available underneath — a real conversation will eventually not fit any of
 * these — but it costs one extra choice, which is the right way round.
 */
const CONSENT_SOURCES = [
  'Inbound call — they called us and agreed',
  'Signed agreement',
  'In person',
  'Replied to our text',
];

/**
 * The four things somebody does on a lead, in the order they do them.
 *
 * Not four groupings of data — four jobs. "Talk" is everything you need while
 * the phone is ringing; "Property" is the house itself; "Offer" is the
 * paperwork; "Record" is what has to be true and provable afterwards.
 */
const TABS = [
  { key: 'talk', label: 'Talk' },
  { key: 'property', label: 'Property' },
  { key: 'offer', label: 'Offer' },
  { key: 'record', label: 'Record' },
];

export default function LeadDetail({ id }) {
  const [tab, setTab] = useState('talk');
  const [assetCounts, setAssetCounts] = useState({ photos: 0, contracts: 0 });
  const [lead, setLead] = useState(null);
  const [activity, setActivity] = useState([]);
  const [notes, setNotes] = useState([]);
  const [optOuts, setOptOuts] = useState([]);
  const [restores, setRestores] = useState([]);
  const [messages, setMessages] = useState([]);
  const [calls, setCalls] = useState([]);
  // The three things that decide whether texting is possible at all, none of
  // which live on the lead. Read once per mount like MessagesPage does: buying a
  // number or clearing A2P is a once-a-quarter event, and the send path refuses
  // regardless of what this page believes.
  const [settings, setSettings] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [teamKill, setTeamKill] = useState(false);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  /**
   * Just the thread and the call history.
   *
   * Separate from load() because realtime fires on every row: a seller's reply,
   * every status callback on an outbound message, and the read receipts this
   * page writes itself. Re-reading the lead, its notes, its activity and the
   * telephony settings on each of those would be a dozen round trips to learn
   * that one message changed from 'sent' to 'delivered'.
   */
  const loadComms = useCallback(async () => {
    const [m, c] = await Promise.all([
      // Oldest first, the way every phone shows a conversation. The composer is
      // directly beneath the newest message rather than the oldest.
      supabase.from('sms_messages').select('*').eq('lead_id', id).order('created_at', { ascending: true }),
      supabase.from('call_log').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
    ]);

    // A failed read must not render as an empty thread. "Nobody has texted this
    // seller" and "we could not ask" look identical on screen and only one of
    // them is safe to act on, so whatever is already there stays there.
    const failed = m.error || c.error;
    if (failed) {
      setErr(`Could not load the conversation (${failed.message}). What is shown below may be out of date.`);
      return;
    }
    setMessages(m.data ?? []);
    setCalls(c.data ?? []);
  }, [id]);

  const load = useCallback(async () => {
    const [l, a, n, r, s, p, t] = await Promise.all([
      // `dialable:lead_is_dialable` is the database function as a computed
      // column, the same way the dialer queue reads it. This page used to
      // re-derive the rule in JavaScript, and by the time telephony landed that
      // copy was already wrong: it had no idea telephony_opt_outs existed, so a
      // seller who had texted STOP still showed "Dialable: Yes" next to a live
      // Call button. Any rule with two implementations has one that is stale.
      supabase.from('leads').select('*, dialable:lead_is_dialable').eq('id', id).single(),
      supabase.from('lead_activity').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      supabase.from('lead_notes').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      // Every suppression an operator has lifted on this lead. Loaded whether
      // or not the lead is currently blocked, because the point of it is to be
      // visible long after the thing it records stopped having any effect.
      supabase.from('dnc_restore_log').select('*').eq('lead_id', id).order('restored_at', { ascending: false }),
      supabase.from('telephony_settings').select('*').maybeSingle(),
      // Live numbers only. This feeds the composer's "why is the box dead"
      // line, which exists to describe the number twilio-send-sms will actually
      // pick — and that function filters released numbers out, so a released one
      // here would name a number the send would then refuse.
      supabase.from('phone_numbers').select('*')
        .is('released_at', null).order('is_primary', { ascending: false }),
      supabase.from('teams').select('sms_send_disabled').eq('id', TEAM_ID).maybeSingle(),
    ]);
    if (l.error) setErr(l.error.message);

    // Opt-outs are keyed by number rather than by lead, so this one cannot join
    // the batch above — there is nothing to ask for until the lead row says
    // which numbers to ask about. Scoped to those keys rather than pulling the
    // team's whole suppression list into the browser to filter it here.
    const keys = [...new Set([phoneKey(l.data?.phone), phoneKey(l.data?.phone_mobile)].filter(Boolean))];
    const o = keys.length
      ? await supabase.from('telephony_opt_outs').select('*').in('phone_key', keys)
      : { data: [] };

    setLead(l.data ?? null);
    setActivity(a.data ?? []);
    setNotes(n.data ?? []);
    setRestores(r.data ?? []);
    setOptOuts(o.data ?? []);
    // Surfaced rather than shrugged off. A failed read here silently produces
    // the reassuring answer — no kill switch, no paused sending — and the
    // composer would then either invite a message the server refuses or blame
    // the wrong rail. The send path still enforces everything, so the cost is a
    // wasted round trip and not a wrong text; the operator should still know the
    // sentence under the composer is guessing.
    const telephonyFailed = [s.error, p.error, t.error].find(Boolean);
    if (telephonyFailed) {
      setErr(`Could not read the telephony settings (${telephonyFailed.message}), so the reason given for texting being on or off may be wrong. The send path still enforces every rail.`);
    }
    setSettings(s.data ?? null);
    setNumbers(p.data ?? []);
    setTeamKill(Boolean(t.data?.sms_send_disabled));
    setLoading(false);
  }, [id]);

  useEffect(() => { setLoading(true); load(); loadComms(); }, [load, loadComms]);

  /**
   * Just the numbers for the tab badges. head:true asks PostgREST for the
   * count and no rows, so this stays cheap on a lead carrying thirty photos —
   * the gallery and the contract panel each load their own content when their
   * tab is opened. Re-run on tab change so adding a photo updates the badge
   * without a page reload.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ph, ct] = await Promise.all([
        supabase.from('property_photos').select('id', { count: 'exact', head: true }).eq('lead_id', id),
        supabase.from('contracts').select('id', { count: 'exact', head: true }).eq('lead_id', id),
      ]);
      if (cancelled) return;
      setAssetCounts({ photos: ph.count ?? 0, contracts: ct.count ?? 0 });
    })();
    return () => { cancelled = true; };
  }, [id, tab]);

  /**
   * The seller's reply, on screen while the operator is looking at the lead.
   *
   * The inbound webhook writes on the service role, so nothing else in this
   * browser would ever hear about it — the thread would sit there looking
   * finished. Filtered to this lead rather than the whole table because the
   * operator has one lead open and the inbox page already subscribes to
   * everything.
   *
   * The cleanup is not tidiness. Without removeChannel every lead opened in a
   * session leaves a live socket subscription behind, and by the twentieth lead
   * of the morning one inbound message is delivering twenty callbacks into
   * components that no longer exist.
   */
  useEffect(() => {
    const timer = { id: null };
    // Realtime fires once per row, and a single send produces several: the
    // queued insert, the Twilio SID update, then each delivery receipt. One
    // trailing read lands the same state as five.
    const bounce = () => {
      clearTimeout(timer.id);
      timer.id = setTimeout(loadComms, 250);
    };

    const channel = supabase
      .channel(`lead-sms-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sms_messages', filter: `lead_id=eq.${id}` },
        bounce,
      )
      .subscribe();

    return () => {
      clearTimeout(timer.id);
      supabase.removeChannel(channel);
    };
  }, [id, loadComms]);

  /**
   * Opening the lead is the read receipt, the same as opening the thread in the
   * inbox — otherwise an operator who works entirely from lead pages leaves the
   * inbox permanently bold and stops trusting the count.
   *
   * `marked` is a ref rather than a re-read of `messages`, because the failure
   * without it is a loop: if the UPDATE is refused, the rows come back unread,
   * the effect runs again on the same ids, and the page hammers the API for as
   * long as it is open.
   */
  const marked = useRef(new Set());
  useEffect(() => { marked.current = new Set(); }, [id]);
  useEffect(() => {
    const ids = messages
      .filter((m) => m.direction === 'inbound' && !m.read_at && !marked.current.has(m.id))
      .map((m) => m.id);
    if (ids.length === 0) return;

    for (const one of ids) marked.current.add(one);
    supabase.from('sms_messages').update({ read_at: new Date().toISOString() }).in('id', ids)
      .then(({ error }) => { if (error) setErr(error.message); });
  }, [messages]);

  const patch = useCallback(async (fields) => {
    setErr(null);
    setLead((prev) => ({ ...prev, ...fields }));   // optimistic
    const { error } = await supabase.from('leads').update(fields).eq('id', id);
    if (error) setErr(error.message);
    load();                                        // truth, plus any activity the triggers wrote
  }, [id, load]);

  // Numbers arrive from inputs as strings; the columns are integers.
  const patchNumber = (field) => (v) =>
    patch({ [field]: v === null ? null : Number(String(v).replace(/[^\d.-]/g, '')) || null });

  async function addNote(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const { error } = await supabase.from('lead_notes').insert({
      lead_id: id,
      team_id: lead.team_id,
      body,
      author_id: (await supabase.auth.getUser()).data.user?.id ?? null,
    });
    if (error) setErr(error.message);
    load();
  }

  if (loading) return <div className="empty">Loading…</div>;
  if (!lead) return <div className="empty"><strong>Lead not found</strong><a href="/app">Back to leads</a></div>;

  // Mobile first, matching lead_is_dialable()'s COALESCE(phone_mobile, phone).
  // Reading them the other way round meant the button dialed the landline on a
  // lead whose skip trace had found a verified mobile.
  const phone = lead.phone_mobile || lead.phone;
  // `=== true` because an undefined column must not read as dialable. If the
  // computed column ever stops arriving, this page refuses to offer a call
  // rather than offering one it cannot justify.
  const dialable = lead.dialable === true;
  // The same window the dialer enforces. This page is one click from every
  // blocked lead in the dialer ("Open the full lead"), so leaving the check off
  // here made that block cosmetic — the operator just clicked through to a live
  // Call button at 2am. `now` is not on a timer here because the detail page is
  // read and acted on, not left open as a queue; the dialer owns that case.
  const win = callingWindow(lead);
  const blocked = blockedWhy(lead, optOuts);

  /**
   * The number twilio-send-sms will pick, resolved the same way and in the same
   * order it resolves it: pinned default, then primary, then whatever exists. A
   * different order here would name one number in the composer and send from
   * another.
   */
  const sender =
    numbers.find((n) => n.id === settings?.default_number_id) ||
    numbers.find((n) => n.is_primary) ||
    numbers[0] || null;

  /**
   * The texting window, which is not quite the calling window.
   *
   * twilio-send-sms holds a number whose timezone could not be resolved to
   * 11am–9pm Eastern rather than 8am–9pm, because the area-code table covers
   * ~70 of NANP's 350+ codes and Eastern is the earliest US zone — so an
   * unresolved guess is wrong in the dangerous direction every time. Mirrored
   * here so the composer is not live for three hours in which every send is
   * refused, which reads as a broken button rather than as a rail.
   */
  const textOpensAt = win.guessed ? 11 : 8;
  const textingAllowed = win.hour !== null && win.hour >= textOpensAt && win.hour < 21;

  /**
   * Why the composer is dead, in the order twilio-send-sms refuses in, so the
   * sentence on screen is the one the server would have sent back.
   *
   * None of this is enforcement — the function re-checks every rail with the
   * service role and its refusal is what actually stops a message. This only
   * saves the operator typing something that was never going to leave.
   */
  // The one blocked state with a fix on this page rather than somewhere else.
  const consentGap = !consentVetoed(lead, optOuts) && noConsentBasis(lead);

  const textBlocked =
    !phone ? 'This lead has no phone number on file.'
      : teamKill ? 'SMS is switched off for the team by the owner kill switch.'
      : settings?.sms_send_paused ? 'SMS sending is paused in telephony settings.'
      : !dialable ? `Not contactable — ${blocked}.${consentGap ? ' If the seller agreed to be contacted, record that on the compliance card below and this opens.' : ''}`
      : !sender ? 'No number is connected to this team yet.'
      : !sender.sms_enabled ? `${formatPhone(sender.e164)} is voice-only until A2P 10DLC is approved and SMS is switched on for it.`
      : sender.a2p_status !== 'approved' ? `A2P 10DLC registration is ${(sender.a2p_status || 'not_started').replace(/_/g, ' ')}. Carriers reject unregistered traffic.`
      : !textingAllowed ? (win.hour === null
        ? 'The local time for this number could not be read, so texting is held rather than guessed at.'
        : `It is ${win.localTime} there. Texting is only permitted ${textOpensAt}am–9pm in the seller's own local time${win.guessed ? ', and their zone could not be resolved — so the tighter Eastern window applies' : ''}.`)
      : null;

  /**
   * What is behind each tab, so an empty one is visible without opening it.
   * Photos and contracts load inside their own components, so those two are
   * counted from the rows this page already has rather than lifted up — the
   * badge is worth a stale beat, not a second query.
   */
  const counts = {
    talk: messages.length + calls.length,
    property: assetCounts.photos,
    offer: assetCounts.contracts,
    record: activity.length,
  };

  return (
    <>
      <header>
        <h1>{lead.address || lead.name || 'Lead'}</h1>
        <span className="count">{fullAddress(lead)}</span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <button className="btn ghost" onClick={() => navigate('/')}>← All leads</button>
        <select value={lead.status} onChange={(e) => patch({ status: e.target.value })}>
          {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={lead.temperature} onChange={(e) => patch({ temperature: e.target.value })}>
          {TEMPERATURES.map((t) => <option key={t} value={t}>{titleize(t)}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <DeleteButton table="leads" id={lead.id} name={lead.address || lead.name} onDeleted={() => navigate('/')} />
      </div>

      {/* ── the tab bar ───────────────────────────────────────────────────
          Eleven cards in one column meant the compliance record and the
          timeline sat four screens below the phone number, so nobody read
          them and everybody scrolled past the offer to reach the notes.

          Grouped by what the operator is doing rather than by what the data
          is, which is why Qualifying sits under Talk and not under Property:
          those answers are filled in while somebody is on the phone, not
          while they are looking at the house. Counts on the tab so the
          absence of a photo or a contract is visible without opening it. */}
      <nav className="leadtabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'on' : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {counts[t.key] > 0 && <span className="tabcount">{counts[t.key]}</span>}
          </button>
        ))}
      </nav>

      {tab === 'talk' && (
        <>
          <CallCard
            leadId={id}
            phone={phone}
            dialable={dialable}
            blocked={blocked}
            win={win}
            lead={lead}
            onDone={load}
          />

          <div className="comms">
            {/* Keyed by lead, and this is the one place it is not a nicety. Going
                from one seller to the next re-uses this component (App.jsx renders
                LeadDetail without a key), so a half-typed message would follow the
                operator into the next thread and Send would text a stranger — the
                one mistake on this page no server-side rail can catch, because that
                send is perfectly legitimate, just to the wrong person. */}
            <MessageThread
              key={id}
              leadId={id}
              to={phone}
              messages={messages}
              cannotSend={textBlocked}
              sender={sender}
              onSent={loadComms}
            />
            <CallHistory calls={calls} />
          </div>

          <div className="detail">
            <div>
          <div className="card">
            <h2>Qualifying</h2>
            <p className="cardnote">
              The answers that decide whether this is a deal. Click any value to edit.
            </p>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Motivation" value={lead.motivation} onSave={(v) => patch({ motivation: v })} placeholder="why are they selling?" />
                <InlineField label="Timeline"   value={lead.timeline}   onSave={(v) => patch({ timeline: v })} placeholder="how fast do they need out?" />
                <InlineField label="Occupancy"  value={lead.occupancy}  onSave={(v) => patch({ occupancy: v })} options={OCCUPANCY} />
                <InlineField label="Condition"  value={lead.condition_notes} onSave={(v) => patch({ condition_notes: v })} type="textarea" placeholder="roof, HVAC, foundation, what they volunteered" />
                <InlineField label="Asking"     value={lead.asking_price}  onSave={patchNumber('asking_price')}  format={money} placeholder="what do they want?" />
                <InlineField label="ARV est."   value={lead.arv_estimate}  onSave={patchNumber('arv_estimate')}  format={money} />
                <InlineField label="Repairs est." value={lead.repair_estimate} onSave={patchNumber('repair_estimate')} format={money} />
                <InlineField label="Mortgage"   value={lead.mortgage_balance} onSave={patchNumber('mortgage_balance')} format={money} />
              </dl>

              <div className="flags">
                <Flag label="Already listed with an agent" on={lead.already_listed}
                      onChange={(v) => patch({ already_listed: v })} />
                <Flag label="Under contract with someone else" on={lead.under_contract_elsewhere}
                      onChange={(v) => patch({ under_contract_elsewhere: v })} />
                <Flag label="Liens or back taxes" on={lead.has_liens}
                      onChange={(v) => patch({ has_liens: v })} />
              </div>
            </div>
          </div>

            </div>
            <div>
          <div className="card">
            <h2>Notes</h2>
            <div className="body">
              <form onSubmit={addNote}>
                <textarea
                  className="note"
                  placeholder="What did the seller say?"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div style={{ marginTop: 9 }}>
                  <button className="btn" type="submit" disabled={!draft.trim()}>Add note</button>
                </div>
              </form>

              {notes.length > 0 && (
                <ul className="timeline" style={{ marginTop: 16 }}>
                  {notes.map((n) => (
                    <li key={n.id}>
                      {n.body}
                      <span className="when">{fullDate(n.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
            </div>
          </div>
        </>
      )}

      {tab === 'property' && (
        <div className="detail">
          <div>
          {/* The property, above the seller, because it is what the page is
              titled with and what every number on the qualifying card is about.

              Until this card existed the address was read-only on the one screen
              where the operator learns what it actually is. A lead arrives from a
              form with "123 main" and no city, or with the street misheard off a
              call, and there was nowhere to fix it — so the corrected address
              lived in a note, the board and the header kept showing the wrong
              one, and the research links below would have opened the wrong
              house. Editing here also means the links re-derive on save, which is
              the whole reason they sit inside this card and not in a rail of
              their own. */}
          <div className="card">
            <h2>Property</h2>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Address" value={lead.address} onSave={(v) => patch({ address: v })} placeholder="street address" />
                <InlineField label="City"    value={lead.city}    onSave={(v) => patch({ city: v })} />
                <InlineField label="State"   value={lead.state}   onSave={(v) => patch({ state: v })} placeholder="GA" />
                <InlineField label="ZIP"     value={lead.zip}     onSave={(v) => patch({ zip: v })} />
                {/* County is here rather than left to the import because it is
                    the field the assessor lookup below is built from, and it is
                    also what match_buyers_for_deal() scores a buyer's territory
                    against — so a lead whose county nobody ever filled in is one
                    the dispo side matches worse. */}
                <InlineField label="County"  value={lead.county}  onSave={(v) => patch({ county: v })} placeholder="Chatham" />
              </dl>

              <PropertyLinks place={lead} />
            </div>
          </div>

          {/* Directly under the property, because that is what they are of.
              A lead's photos are the condition evidence an operator gathers
              before there is a contract, and they carry into the deal on their

          <PhotoGallery subject="lead" subjectId={id} teamId={lead.team_id} />
          </div>
        </div>
      )}

      {tab === 'offer' && (
        <div className="detail">
          <div>
          {/* Under the photos, above the seller: writing the offer is what
              happens after you have looked at the house, and the terms on it
              come from the qualifying card further down rather than from
              anything typed twice. */}
          <ContractPanel subject="lead" subjectId={id} teamId={lead.team_id} lead={lead} />
          </div>
        </div>
      )}

      {tab === 'record' && (
        <div className="detail">
          <div>
          <div className="card">
            <h2>Seller</h2>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Name"   value={lead.name}  onSave={(v) => patch({ name: v })} />
                <InlineField label="Phone"  value={lead.phone} onSave={(v) => patch({ phone: v })} format={formatPhone} />
                <InlineField label="Email"  value={lead.email} onSave={(v) => patch({ email: v })} type="email" />
                <InlineField label="Second contact" value={lead.co_contact_name} onSave={(v) => patch({ co_contact_name: v })} placeholder="spouse, sibling, executor…" />
              </dl>
            </div>
          </div>


          <div className="card">
            <h2>Compliance</h2>
            <div className="body">
              <dl className="facts">
                <dt>Dialable</dt>
                <dd>
                  {/* The value is lead_is_dialable() itself, read off the row.
                      blockedWhy() only names the answer — it does not decide
                      it, which is why its vague last case is acceptable. */}
                  {dialable
                    ? <span className="badge ok">Yes</span>
                    : <span className="badge stop">{blocked}</span>}
                </dd>
                <dt>Local time there</dt>
                <dd>
                  {win.localTime || 'unknown'}
                  {win.guessed && ' (guessed — no area code or state resolved)'}
                </dd>
                <dt>Attempts</dt><dd>{lead.call_attempts}</dd>
                <dt>Last contact</dt><dd>{lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : 'never'}</dd>
                <FollowUpField
                  value={lead.next_follow_up_at}
                  onSave={(v) => patch({ next_follow_up_at: v })}
                />
                <dt>TCPA opt-in</dt><dd>{lead.tcpa_opt_in ? fullDate(lead.tcpa_opt_in_at) : 'No'}</dd>
                <dt>Consent</dt>
                <dd>{[lead.consent_sms && 'SMS', lead.consent_email && 'Email'].filter(Boolean).join(' · ') || 'None'}</dd>
                <dt>Skip traced</dt><dd>{lead.skip_traced ? fullDate(lead.skip_traced_at) : 'No'}</dd>
                <dt>DNC scrubbed</dt><dd>{lead.dnc_scrubbed ? fullDate(lead.dnc_scrubbed_at) : 'No'}</dd>
              </dl>

              {lead.tcpa_disclosure_text && (
                <details style={{ marginTop: 14, fontSize: '0.83rem', color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    Disclosure shown ({lead.tcpa_disclosure_version})
                  </summary>
                  <p style={{ marginTop: 8 }}>{lead.tcpa_disclosure_text}</p>
                </details>
              )}

              {/* Recording what a seller agreed to, which is ordinary work and
                  the only thing on this card that is. It sits above the two
                  repair controls, not among them: those undo something that was
                  written by mistake or by somebody else's decision, this writes
                  down a fact. Its own gating is what keeps the distinction
                  honest — a lead with a STOP on file is never offered it. */}
              <ConsentControl
                leadId={id}
                lead={lead}
                vetoed={consentVetoed(lead, optOuts)}
                onDone={load}
              />

              {/* The two corrections, and they are deliberately not siblings in
                  weight. Clearing the flag is data repair; clearing an opt-out
                  is a decision about somebody who told us to stop. Anything
                  that presented them as two options in one list would be
                  inviting the operator to treat them as interchangeable. */}
              {lead.is_dnc && <ClearFlagAction leadId={id} hasOptOut={optOuts.length > 0} onDone={load} />}

              {optOuts.map((o) => (
                <ClearOptOutAction key={o.id} leadId={id} optOut={o} lead={lead} onDone={load} />
              ))}

              {restores.length > 0 && <RestoreHistory rows={restores} />}
            </div>
          </div>

          </div>
          <div>
          <div className="card">
            <h2>Capture</h2>
            <div className="body">
              <dl className="facts">
                <dt>Source</dt><dd>{titleize(lead.source)}</dd>
                <dt>Page</dt><dd style={{ wordBreak: 'break-all' }}>{lead.page_path || '—'}</dd>
                <dt>Created</dt><dd>{fullDate(lead.created_at)}</dd>
              </dl>
            </div>
          </div>


          <div className="card">
            <h2>Timeline</h2>
            <div className="body">
              {activity.length === 0 ? (
                <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.88rem' }}>Nothing yet.</p>
              ) : (
                <ul className="timeline">
                  {activity.map((a) => (
                    <li key={a.id}>
                      {a.summary || titleize(a.type)}
                      <span className="when">{timeAgo(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          </div>
        </div>
      )}

    </>
  );
}

/**
 * Why lead_is_dialable() said no, in the order the reasons matter: the ones that
 * are somebody's legal position first, then the ones that are unfinished work.
 *
 * This decides nothing — the database already did, and `dialable` is its answer
 * verbatim. It only names the answer, which is why the vague fallback at the end
 * is acceptable and a re-derivation of the rule would not be.
 *
 * It used to end at "Suppressed" for anything involving an opt-out, because the
 * page did not read telephony_opt_outs and genuinely could not tell a STOP apart
 * from an unmet consent basis. It reads them now — a page that offers to clear
 * an opt-out has to be able to say one is there — so the STOP is named.
 */
function blockedWhy(lead, optOuts = []) {
  if (lead.is_dnc) return 'On DNC';
  if (lead.is_litigator) return 'Known litigator';
  if (lead.phone_invalid) return 'Wrong number';
  if (!lead.phone_mobile && !lead.phone) return 'No number';
  if (optOuts.length > 0) return 'Texted STOP';
  if (lead.trashed) return 'Trashed';
  if (noConsentBasis(lead)) {
    // Two ways to satisfy it and a lead may take either, so this names the
    // shorter road rather than the first one that happens to be false. A lead
    // already traced needs only the scrub; one with neither needs somebody to
    // record what the seller actually agreed to, which is the control on the
    // compliance card and not a piece of vendor work.
    if (lead.skip_traced && !lead.dnc_scrubbed) return 'Not DNC scrubbed';
    return 'No consent basis';
  }
  return 'Suppressed';
}

/**
 * Neither half of lead_is_dialable()'s consent test holds.
 *
 * This is the one piece of that function's logic the page has to be able to ask
 * about on its own, because it decides whether to OFFER the fix — and the
 * database answers "dialable: false" without saying which of six reasons it was.
 * It mirrors 20260821120000_consent_basis_fix.sql exactly:
 *
 *   inbound  — tcpa_opt_in, however consent arrived
 *   outbound — a cold-list lead that has been skip traced AND DNC scrubbed
 *
 * It deliberately does not look at `source`. That was the old rule, and it was
 * wrong: a seller who agreed on the phone could never be contacted because the
 * column happened to say 'manual'.
 */
function noConsentBasis(lead) {
  return !lead.tcpa_opt_in && !(lead.skip_traced && lead.dnc_scrubbed);
}

/**
 * Whether something OTHER than the missing consent is stopping this lead.
 *
 * Recording consent must never look like a way through a STOP. A
 * telephony_opt_outs row, a DNC flag, a litigator hit or a wrong number is a
 * different case with its own control on this card, and adding a consent record
 * on top of one of them would change nothing except to leave a note claiming the
 * seller agreed to be contacted — written after they asked us to stop.
 */
function consentVetoed(lead, optOuts = []) {
  return Boolean(
    lead.is_dnc || lead.is_litigator || lead.phone_invalid || lead.trashed
    || optOuts.length > 0
    || (!lead.phone && !lead.phone_mobile),
  );
}

function Flag({ label, on, onChange }) {
  return (
    <label className="flag">
      <input type="checkbox" checked={Boolean(on)} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ── calling ─────────────────────────────────────────────────────────────── */

/**
 * Call, then say what happened, in one place and in that order.
 *
 * It is the first thing under the heading and the largest control on the page
 * because it is what the operator opened the lead to do. It used to be a
 * medium-sized button in the toolbar between "All leads" and two dropdowns,
 * which is the same visual weight as changing the temperature.
 *
 * The disposition bar is the second half of the same action, not a separate
 * card further down: Twilio's webhooks record that a call happened and how long
 * it lasted, but nothing outside the operator's head knows what was SAID, so
 * the outcome is only on the record if they tap it here when they hang up.
 * Putting it anywhere else is what produces a lead with nine attempts and no
 * idea what was said on any of them.
 *
 * Call goes through the same softphone the dialer uses, so it goes through
 * `twilio-voice`'s `dial` action, which re-checks lead_is_dialable() and the
 * called party's 8am–9pm window with the service role at the moment of the
 * dial. The two checks below are unchanged and still worth having — dialability
 * is `lead_is_dialable()` read off the row, never re-derived, and the window is
 * the same callingWindow() the dialer greys its button with — but they are now
 * a pre-filter rather than the only rail a call passes through.
 */
function CallCard({ leadId, lead, phone, dialable, blocked, win, onDone }) {
  const callable = Boolean(phone) && dialable && win.allowed;
  const sp = useSoftphone();

  return (
    <div className="card oncall">
      <h2>Call</h2>
      <div className="body">
        <div className="callbar">
          {/* Nothing is written from here, on purpose. The attempt is counted by
              log_disposition below when the outcome is tapped, and the call_log
              row is written by `dial` before Twilio is called — never by a
              browser, which only knows what it asked for. */}
          <SoftphoneControl
            sp={sp}
            leadId={leadId}
            number={phone}
            blocked={callable ? null
              : !phone ? 'No number on file'
              : !dialable ? `Do not call — ${blocked}`
              : 'Outside calling hours'}
          />
          <span className="num">
            {[
              phone ? formatPhone(phone) : null,
              win.localTime ? `${win.localTime} there` : null,
              `${lead.call_attempts} attempt${lead.call_attempts === 1 ? '' : 's'}`,
              lead.last_contacted_at ? `last contact ${timeAgo(lead.last_contacted_at)}` : 'never contacted',
            ].filter(Boolean).join(' · ')}
          </span>
        </div>

        {/* First, above the standing conditions: a refusal that just happened
            outranks one the operator has already read. */}
        <SoftphoneNotice sp={sp} />

        {phone && !dialable && (
          <div className="notice">
            <strong>Not dialable: {blocked}.</strong>
            The database refuses this lead on every contact path regardless of what this page shows.
            The controls that can change that, where there are any, are on the compliance card below.
          </div>
        )}

        {phone && dialable && !win.allowed && (
          <div className="notice">
            <strong>
              {win.reason === 'unknown_timezone'
                ? 'Cannot work out what time it is for this number.'
                : `It is ${win.localTime} for this number — ${win.reason === 'before_8am' ? 'before 8am' : 'after 9pm'}.`}
            </strong>
            TCPA allows calls only between 8am and 9pm in the called party&rsquo;s local time, and the
            damages are $500–$1,500 per call. This one waits.
          </div>
        )}

        {callable && win.guessed && (
          <div className="notice">
            <strong>Time zone is a guess.</strong>
            Neither the area code nor a state on this lead resolved, so {win.localTime} is Eastern by
            default. Check before dialing near the edges of the window.
          </div>
        )}

        {/* Keyed by lead because App.jsx renders <LeadDetail id={…}> without a
            key: clicking through to another seller re-uses this component, and
            an un-keyed bar would carry the last one's note and follow-up time
            into the next disposition. */}
        <DispositionBar key={leadId} leadId={leadId} onDone={onDone} />
      </div>
    </div>
  );
}

/* ── the thread ──────────────────────────────────────────────────────────── */

/**
 * This lead's texts, and a box to answer them with.
 *
 * The same conversation is on the inbox page, and it stays there — that page is
 * for triaging forty threads. This one is for working one seller, and until it
 * existed the only way to answer a homeowner was to leave their record, find
 * them in a list, and hope the right thread was still selected.
 *
 * It sends through twilio-send-sms and nowhere else. The browser cannot talk to
 * Twilio (the auth token is an edge secret, and a VITE_ variable would publish
 * it to every visitor of the marketing site), and more to the point every
 * compliance rail lives inside that function. What is disabled here is a
 * courtesy; the refusal is what actually stops a message.
 */
function MessageThread({ leadId, to, messages, cannotSend, sender, onSent }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [warning, setWarning] = useState(null);
  const scroller = useRef(null);

  // Newest at the bottom, the way every phone shows it — including when a reply
  // arrives over realtime while the operator is reading.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending || cannotSend) return;

    setSending(true);
    setRefusal(null);
    setWarning(null);

    // The function owns the rails, the Twilio call and the sms_messages row.
    // The browser hands it the three facts it cannot infer, spelled the way
    // supabase/functions/twilio-send-sms reads them.
    const { data, error } = await supabase.functions.invoke('twilio-send-sms', {
      body: { lead_id: leadId, to, body },
    });

    if (error) {
      setRefusal(await explainRefusal(error));
    } else if (data?.ok === false || data?.sent === false) {
      // Belt and braces: every refusal today is a non-2xx, so this branch is
      // unreachable. It exists because the failure it guards against — a
      // refusal answered with 200, read as success, draft cleared — looks
      // exactly like a message that was sent.
      setRefusal(refusalFrom(data, 'The send was refused and the server gave no reason.'));
    } else {
      setDraft('');
      // The text is already at Twilio and cannot be un-sent, but its row still
      // says "queued" with no SID. Say so, because the natural reaction to a
      // message that never leaves "queued" is to send it again.
      if (data?.warning) setWarning(`${data.warning} It did go out — do not send it again.`);
    }

    setSending(false);
    onSent?.();
  }

  return (
    <div className="card msgcard">
      <h2>
        <span>Messages · {messages.length}</span>
        {to && <span className="to">{formatPhone(to)}</span>}
      </h2>

      <div className="msgthread" ref={scroller}>
        {messages.length === 0 ? (
          <p className="none">Nothing yet. A text sent here starts the thread; inbound replies land in it.</p>
        ) : messages.map((m) => <Message key={m.id} m={m} />)}
      </div>

      <form className="msgcomposer" onSubmit={send}>
        {warning && (
          <div className="msgwhy">
            <strong>Sent, but not fully recorded.</strong> {warning}
          </div>
        )}

        {/* The specific reason, never "failed". Which one it is decides whether
            the operator retries in an hour, fixes the lead, or must never text
            this number again — and those three have very different price tags. */}
        {refusal && (
          <div className="err">
            <strong>Not sent.</strong> {refusal.text}
            {refusal.reason && <span className="code"> ({refusal.reason})</span>}
          </div>
        )}

        {cannotSend && (
          <div className="msgwhy">
            <strong>Texting is not available on this lead.</strong>
            {cannotSend}
          </div>
        )}

        <textarea
          className="note"
          placeholder={cannotSend ? 'Sending is blocked — see above.' : 'Write to the seller…'}
          value={draft}
          maxLength={MAX_BODY}
          disabled={Boolean(cannotSend)}
          onChange={(e) => setDraft(e.target.value)}
        />

        <div className="msgfoot">
          <span className="count">
            {draft.length}/{MAX_BODY}
            {sender ? ` · from ${formatPhone(sender.e164)}` : ''}
          </span>
          <button className="btn" type="submit" disabled={Boolean(cannotSend) || sending || !draft.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * One message.
 *
 * Inbound sits left and neutral, outbound right and navy — the arrangement
 * every phone uses, so which side of the conversation a sentence came from is
 * read rather than worked out.
 *
 * A failed or undelivered outbound message stops looking like a sent one
 * entirely. That is the whole point of this component: a text that failed but
 * renders as navy on the right is a text the operator believes the seller has,
 * so they stop chasing and the lead goes quiet for a reason nobody ever finds.
 * The Twilio error code goes on screen with it, translated, because that code
 * is the difference between "resend it", "call them instead" and "every text
 * from this number is being blocked".
 *
 * The words come from deliveryState() rather than from here, because the inbox
 * renders the same states from the same rows and two vocabularies is one that
 * drifts.
 */
function Message({ m }) {
  const inbound = m.direction === 'inbound';
  const d = deliveryState(m);
  const failed = !!d?.failed;

  return (
    <div className={`msg ${inbound ? 'in' : 'out'}${failed ? ' dead' : ''}`}>
      <div className="text">
        {m.body}
        <DeliveryFailure message={m} />
      </div>
      <div className="meta">
        {fullDate(m.sent_at || m.created_at)}
        {d && <> · <DeliveryChip message={m} /></>}
        {/* On a failure the code is already spelled out inside the bubble;
            repeating it in the metadata line is noise. On anything else — a
            'sent' that carried a code — this is the only place it can appear. */}
        {!failed && d?.code ? <> · <span className="deliv-code">Twilio {d.code}</span></> : null}
      </div>
    </div>
  );
}

/* ── what happened on the phone ──────────────────────────────────────────── */

/**
 * A recording, fetched rather than linked.
 *
 * The obvious version of this was `<audio src={c.recording_url} />` and it
 * could never have worked: recording_url points at api.twilio.com, which
 * answers 401 without HTTP Basic auth on the account credentials — checked
 * against the live API, not assumed. A media element cannot be told to send an
 * Authorization header, so there is no arrangement of props that fixes it.
 *
 * The call-recording function holds the Twilio credentials, checks the call
 * belongs to the caller's team through call_log's own RLS, and streams the
 * audio back. That arrives here as a blob, and an object URL off the blob is
 * something <audio> can play.
 *
 * Loaded on click rather than on render. A lead with a dozen calls would
 * otherwise pull a dozen recordings nobody asked to hear, and each one is a
 * paid Twilio media request.
 */
function Recording({ callId }) {
  const [src, setSrc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Object URLs hold the blob in memory until they are revoked, and this
  // component unmounts every time the operator moves to the next lead.
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  async function play() {
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.functions.invoke('call-recording', {
      body: { call_id: callId },
    });
    setBusy(false);
    if (error) {
      // The function answers with JSON on every refusal, and that sentence is
      // more use than "FunctionsHttpError".
      let msg = error.message;
      try {
        const body = await error.context?.json?.();
        if (body?.error) msg = body.error;
      } catch { /* keep the generic one */ }
      setErr(msg);
      return;
    }
    setSrc(URL.createObjectURL(data));
  }

  if (err) return <span className="fine" style={{ color: '#a11b0f' }}>{err}</span>;
  if (src) return <audio controls autoPlay src={src} />;
  return (
    <button className="linkbtn" disabled={busy} onClick={play}>
      {busy ? 'Loading recording…' : '▸ Play recording'}
    </button>
  );
}

/** '95' -> '1m 35s'. Null durations are a call that never connected. */
function duration(secs) {
  if (secs === null || secs === undefined) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/**
 * The calls, beside the texts rather than on a page of their own.
 *
 * "What happened with this seller" was three places — the timeline for
 * dispositions, the inbox for texts, and nowhere at all for calls. One of those
 * three is the reason an operator re-asks a homeowner a question they already
 * answered, which is the fastest way to sound like the fourth wholesaler to
 * call them this week.
 */
function CallHistory({ calls }) {
  return (
    <div className="card">
      <h2>Calls · {calls.length}</h2>
      {calls.length === 0 ? (
        <div className="body">
          <p className="fine" style={{ margin: 0 }}>
            Nothing recorded. Calls placed with the softphone above appear here — the row is
            written by <code>twilio-voice</code> before Twilio is called and filled in from its
            webhooks afterwards. A call dialed on the desk phone, or through the labelled
            fallback when the softphone cannot start, never reaches this list; for those the
            dispositions above are the only record.
          </p>
        </div>
      ) : (
        calls.map((c) => (
          <div className="callrow" key={c.id}>
            <div className="line">
              <span className="dir">{c.direction === 'inbound' ? 'Inbound' : 'Outbound'}</span>
              {c.status && <span className="badge">{titleize(c.status)}</span>}
              {duration(c.duration_seconds) && <span>{duration(c.duration_seconds)}</span>}
            </div>
            <span className="sub">
              {[
                fullDate(c.started_at || c.created_at),
                c.answered_by ? `answered by ${c.answered_by.replace(/_/g, ' ')}` : null,
                c.disposition ? titleize(c.disposition) : null,
              ].filter(Boolean).join(' · ')}
            </span>
            {c.recording_url && <Recording callId={c.id} />}
          </div>
        ))
      )}
    </div>
  );
}

/* ── recording what the seller agreed to ─────────────────────────────────── */

/**
 * The control that was missing, and the reason texting was impossible.
 *
 * lead_is_dialable() needs a consent basis: either tcpa_opt_in, however consent
 * arrived, or a cold-list lead that has been skip traced AND DNC scrubbed. There
 * was no way to write the first one after a lead existed — the New Lead form had
 * a checkbox and this page had nothing — so a seller who agreed on a call was
 * permanently uncontactable, and the operator's only remaining options were to
 * work around the app or to drop the lead.
 *
 * Three things it is not:
 *
 *   - It is not a way around a STOP. `vetoed` hides it whenever anything else is
 *     blocking the lead — an opt-out, the DNC flag, a litigator hit, a wrong
 *     number. Those are different cases with their own controls on this card,
 *     and stacking a consent record on top of one would only leave a note
 *     claiming the seller agreed, written after they asked us to stop.
 *   - It is not a checkbox. record_lead_consent() rejects an empty source
 *     because "how was this obtained" is the question that gets asked later, and
 *     a bare boolean is not an answer to it.
 *   - It is not reversible by deletion. Withdrawing consent stops us going
 *     forward; it does not unmake the record that consent was once given, and
 *     the RPC deliberately leaves the disclosure fields alone.
 */
function ConsentControl({ leadId, lead, vetoed, onDone }) {
  if (lead.tcpa_opt_in === true) return <WithdrawConsent leadId={leadId} lead={lead} onDone={onDone} />;
  if (vetoed || !noConsentBasis(lead)) return null;
  return <RecordConsent leadId={leadId} onDone={onDone} />;
}

function RecordConsent({ leadId, onDone }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const resolved = (source === '__other' ? other : source).trim();

  function reset() {
    setOpen(false);
    setSource('');
    setOther('');
    setNote('');
    setErr(null);
  }

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('record_lead_consent', {
      p_lead_id: leadId,
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
        <div>
          <button className="btn ghost" onClick={() => setOpen(true)}>Record consent…</button>
        </div>
        <span className="fine">
          There is no consent basis on this lead, which is why it cannot be called or texted. If the
          seller agreed to be contacted, record how — it goes on the record with your name.
        </span>
      </div>
    );
  }

  return (
    <div className="consentpanel">
      <strong>Record consent to contact this seller</strong>
      {/* Said before the field rather than under the button. An operator who is
          about to assert something on Tossie's behalf should know it is an
          assertion while they are deciding, not after they have made it. */}
      <p className="fine">
        <strong>This is a legal record.</strong> It is written with your name, timestamped, and shown
        in this lead&rsquo;s timeline. It is the document that answers &ldquo;who said we could
        contact them&rdquo; if that is ever asked, so record it only if the seller actually agreed.
      </p>
      <p className="fine">
        It lifts nothing. A STOP, a do-not-call flag or a litigator hit is a separate matter with its
        own control, and this would not be offered while one of them stood.
      </p>

      <label className="consentfield">
        How was it obtained? Required — the RPC refuses an empty source.
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Choose…</option>
          {CONSENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="__other">Something else — type it</option>
        </select>
      </label>

      {source === '__other' && (
        <label className="consentfield">
          In your own words
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="asked us to text him at the open house on the 12th"
            autoComplete="off"
            autoFocus
          />
        </label>
      )}

      <label className="consentfield">
        Anything worth adding? Optional, kept with it.
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="said to use the mobile after 5"
          autoComplete="off"
        />
      </label>

      {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

      <div className="confirmbtns">
        <button className="btn" onClick={run} disabled={!resolved || busy}>
          {busy ? 'Recording…' : 'Record consent in my name'}
        </button>
        <button className="btn ghost" onClick={reset} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Deliberately lighter than granting it.
 *
 * Granting asserts a fact about a conversation that has to hold up later;
 * withdrawing only stops us contacting somebody. Stopping must never be the
 * harder of the two to do — so it is a link, one optional field, and no
 * ceremony. The reason is optional because a seller saying "take me off your
 * list" should not be held up by a form.
 */
function WithdrawConsent({ leadId, lead, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('withdraw_lead_consent', {
      p_lead_id: leadId,
      p_reason: reason.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setOpen(false);
    setReason('');
    onDone?.();
  }

  return (
    <div className="consentheld">
      <span className="held">
        Consent on file{lead.tcpa_opt_in_at ? ` since ${fullDate(lead.tcpa_opt_in_at)}` : ''}
        {lead.tcpa_disclosure_source ? ` — ${lead.tcpa_disclosure_source}` : ''}.
      </span>

      {!open ? (
        <div>
          <button className="linkbtn" onClick={() => setOpen(true)}>Withdraw consent…</button>
        </div>
      ) : (
        <>
          <span className="fine">
            Calling and texting stop unless this lead has been skip traced and DNC scrubbed. What was
            shown and when it was agreed to stays on the record — withdrawing consent going forward
            does not unmake the fact that it was given.
          </span>
          <label className="consentfield">
            Why? Optional.
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="asked us to stop texting on the call"
              autoComplete="off"
              autoFocus
            />
          </label>

          {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

          <div className="confirmbtns">
            <button className="btn ghost" onClick={run} disabled={busy}>
              {busy ? 'Withdrawing…' : 'Withdraw consent'}
            </button>
            <button
              className="btn ghost"
              onClick={() => { setOpen(false); setReason(''); setErr(null); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── (A) the internal flag ───────────────────────────────────────────────── */

/**
 * Undoing a mis-tap, and shaped like it.
 *
 * leads.is_dnc is Tossie's own flag. It gets set by log_disposition
 * ('do_not_call') and by a wrong-number disposition, both of which are one tap
 * on a bar of eleven chips — so the realistic way a lead ends up here is that
 * the operator was aiming at the row above. When that is what happened, nobody
 * ever asked not to be called and there is nothing legally loaded about putting
 * it back.
 *
 * So this is a quiet link with one required field. The reason is required
 * because the flag is also set by real requests — a seller who said "don't call
 * me again" on the phone — and the difference between those two cases lives
 * nowhere except in the sentence the operator types. clear_lead_dnc refuses a
 * blank one; this disables the button so the refusal is not the first the
 * operator hears of it.
 */
function ClearFlagAction({ leadId, hasOptOut, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('clear_lead_dnc', {
      p_lead_id: leadId,
      p_reason: reason.trim(),
    });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    setOpen(false);
    setReason('');
    onDone?.();
  }

  if (!open) {
    return (
      <div className="repairbar">
        <button className="linkbtn" onClick={() => setOpen(true)}>Remove the do-not-call flag…</button>
        <span className="fine">
          Tossie&rsquo;s own flag, usually set by a disposition. Removing it is ordinary data repair.
        </span>
      </div>
    );
  }

  return (
    <div className="repairpanel">
      <strong>Remove the do-not-call flag?</strong>
      <p className="fine">
        This flag is set by a <em>Do not call</em> or wrong-number disposition. It is not a record of
        anything the seller sent us. If they did ask to be left alone, that is an opt-out and lives
        separately — this does not touch it.
      </p>
      {hasOptOut && (
        <p className="fine">
          <strong>There is also an opt-out on this lead.</strong> Removing this flag will not lift it,
          and the lead stays undialable until that is dealt with on its own.
        </p>
      )}
      {/* The disposition that set the flag also set the status to Dead and
          cleared the follow-up. Neither is rewound — what the status was
          beforehand is not recorded anywhere — so the lead comes back dialable
          but does not come back into the queue. Said here rather than left to
          be discovered, because the operator is one control away from fixing it
          and would otherwise conclude the removal did not work. */}
      <p className="fine">
        The status the disposition set is not undone with it. Set the status and the next follow-up
        above if this lead should go back into the queue.
      </p>

      <label className="repairfield">
        Why is it being removed? Kept on the lead.
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="mis-tapped the disposition bar on the row above"
          autoComplete="off"
        />
      </label>

      {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

      <div className="confirmbtns">
        <button className="btn" onClick={run} disabled={!reason.trim() || busy}>
          {busy ? 'Removing…' : 'Remove the flag'}
        </button>
        <button
          className="btn ghost"
          onClick={() => { setOpen(false); setReason(''); setErr(null); }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── (B) the opt-out the person asked for ────────────────────────────────── */

/**
 * The most legally loaded write in the product, and it does not get to look
 * like the control above it.
 *
 * A telephony_opt_outs row usually means this person texted STOP. Under the
 * TCPA the consumer is the party who revokes their own opt-out, by texting
 * START — an operator clearing it is making a decision on Tossie's behalf, not
 * fixing a typo. There are two defensible reasons to do it (the STOP came from
 * a number misattributed to this lead, or the person has since asked to be
 * contacted again, which is itself consent) and this panel says so, because an
 * operator who has one of those reasons should not have to guess whether the
 * app will let them.
 *
 * Four things separate it from ClearFlagAction, and every one costs a moment:
 *
 * 1. IT IS ALREADY LOUD WHEN CLOSED. The flag control is a grey link. This one
 *    states the fact — this person texted STOP, on this date — before anybody
 *    has clicked anything, because the operator needs to know that whether or
 *    not they intend to do something about it.
 * 2. IT SAYS WHO IS ACCOUNTABLE. Not "this is recorded" in the passive: the
 *    operator's name and their sentence go into dnc_restore_log and onto the
 *    lead timeline, and they read that here before they type.
 * 3. TYPE THE NUMBER. A reason box measures intent to write something. Typing
 *    the ten digits aims a few seconds of attention at the fact that decides
 *    whether this is the misattribution case — which number this actually is.
 * 4. THE SUPPRESSION IS ALL THAT LIFTS. Consent is not restored, and the panel
 *    says that too, so nobody comes away believing this re-opened the SMS
 *    channel by itself.
 */
function ClearOptOutAction({ leadId, optOut, lead, onDone }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Which of the lead's numbers this suppression is on. The stored value is a
  // phone_key, so it is matched rather than compared: the lead holds
  // "(912) 555-0134" and the opt-out holds "9125550134".
  const onNumber = [lead.phone_mobile, lead.phone]
    .filter(Boolean)
    .find((n) => phoneKey(n) === optOut.phone_key) || optOut.phone_key;

  // Compared on digits rather than byte-for-byte, unlike the release confirm on
  // the phone settings page: what is stored here IS the digits, so demanding a
  // particular punctuation would be testing typing rather than attention.
  const confirmed = phoneKey(typed) === optOut.phone_key;

  // sms_stop is the one that means the person themselves sent it. The others
  // were entered by us — a scrub hit, a note taken on a call — and the panel
  // says which, because "somebody told us to stop" and "a vendor's list said
  // so" are not the same thing to be overriding.
  const fromThePerson = optOut.source === 'sms_stop';

  async function run() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('clear_phone_opt_out', {
      p_lead_id: leadId,
      p_number: optOut.phone_key,
      p_reason: reason.trim(),
    });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    setOpen(false);
    setTyped('');
    setReason('');
    onDone?.();
  }

  return (
    <div className="stoprepair">
      <strong>
        {fromThePerson
          ? `This person texted STOP from ${formatPhone(onNumber)}`
          : `${formatPhone(onNumber)} is on the suppression list`}
      </strong>
      <p className="fine">
        {fromThePerson
          ? 'Recorded by the inbound webhook when the message arrived on '
          : `Added by ${optOutSource(optOut.source)} on `}
        {fullDate(optOut.opted_out_at)}.
        {optOut.note ? ` “${optOut.note}”` : ''} Nothing may be sent or dialed to this number while
        it stands, and that is the right outcome unless one of two things is true.
      </p>

      {!open ? (
        <button className="btn danger sm" onClick={() => setOpen(true)}>
          Clear this opt-out…
        </button>
      ) : (
        <>
          <ul className="consequences">
            <li>
              Texting and dialing this number become <strong>possible again</strong> — the
              suppression that is stopping them is deleted.
            </li>
            <li>
              Normally the person lifts their own opt-out by texting <strong>START</strong>. Doing it
              for them is defensible in two cases: the STOP came from a number that is not
              theirs, or they have since asked to be contacted again.
            </li>
            <li>
              <strong>You are the one accountable for it.</strong> Your name, the date and the
              sentence you type below are written to the restore log and onto this lead&rsquo;s
              timeline, and stay there.
            </li>
            <li>
              SMS consent is <strong>not</strong> restored. Lifting a suppression is not the same as
              the seller agreeing to be contacted, and this does not claim it is.
            </li>
          </ul>

          <label className="repairfield stop">
            Type <code>{optOut.phone_key}</code> to confirm which number this is
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={optOut.phone_key}
              autoComplete="off"
              spellCheck="false"
              inputMode="numeric"
            />
          </label>

          <label className="repairfield stop">
            Why is this being cleared? Recorded with your name.
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="seller called in on the 14th and asked us to keep in touch"
              autoComplete="off"
            />
          </label>

          {err && <div className="err" style={{ marginTop: 11 }}>{err}</div>}

          <div className="confirmbtns">
            <button className="btn danger" onClick={run} disabled={!confirmed || !reason.trim() || busy}>
              {busy ? 'Clearing…' : 'Clear the opt-out in my name'}
            </button>
            <button
              className="btn ghost"
              onClick={() => { setOpen(false); setTyped(''); setReason(''); setErr(null); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── what was lifted, and when ───────────────────────────────────────────── */

/**
 * Shown for as long as the lead exists, whether or not anything is currently
 * blocking it.
 *
 * A cleared STOP that leaves no visible mark is a thing that quietly happened
 * once: the lead looks ordinary afterwards, and the next person to work it has
 * no way to know that the number in front of them was suppressed until somebody
 * decided otherwise. That is the fact most worth knowing before dialing.
 *
 * Who did it is not repeated here — dnc_restore_log stores restored_by as a
 * uuid with no join to profiles through PostgREST, and the timeline entry above
 * already carries the name in its own sentence. This is the compact index; the
 * timeline is the account.
 */
function RestoreHistory({ rows }) {
  return (
    <div className="restorelog">
      <strong>Suppressions lifted on this lead</strong>
      <ul className="timeline">
        {rows.map((r) => (
          <li key={r.id}>
            {r.kind === 'opt_out'
              ? <>Opt-out cleared on {formatPhone(r.phone_key)}{r.prior_source ? ` (was ${optOutSource(r.prior_source)})` : ''}</>
              : <>Do-not-call flag removed</>}
            <span className="why">{r.reason}</span>
            <span className="when">{fullDate(r.restored_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
