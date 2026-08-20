import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import { formatPhone, timeAgo, fullDate, titleize } from '../lib/format.js';
import { money } from '../lib/buyers.js';
import { MAX_BODY, explainRefusal } from '../lib/sms-refusals.js';

/**
 * Bulk SMS campaigns.
 *
 * The order of the flow is the whole design: pick an audience, see exactly who
 * will and will not receive it and why, compose, send, watch. The preview is
 * not a courtesy step. A blast that quietly drops 160 of 200 recipients reports
 * "sent 40" and nobody can say whether that is a healthy list, a broken
 * consent import, or a number that carriers have started filtering — and by the
 * time anyone asks, the answer is unrecoverable.
 *
 * So this page never shows a survivor count on its own. `total_recipients`
 * counts every materialised row including the suppressed ones, and it is always
 * the denominator; the skips are broken out by reason and every one of them can
 * be opened and read name by name. That ledger is also the A2P segmentation
 * evidence: "180 buyers on the list, 12 in the box for this property, 4
 * suppressed and here is each reason" is a sentence a carrier reviewing a Low
 * Volume Mixed campaign will accept. "We texted 40 people" is not.
 *
 * Three things this page is deliberately not:
 *   - It is not the enforcement point. materialise_campaign() decides every
 *     skip in SQL against buyer_skip_reason()/lead_skip_reason(), which are the
 *     same predicates the send path uses, and twilio-send-sms re-checks all of
 *     it again per message with the service role. What this page shows is what
 *     the database already decided.
 *   - It never talks to Twilio. Sending is one call to the broadcast-send edge
 *     function, which claims recipients and hands each one to twilio-send-sms —
 *     the single choke point holding opt-out, DNC, litigator, calling-window,
 *     A2P and both kill switches. Any other path to Twilio is a rail bypassed.
 *   - It has no "text everyone" control, for any audience. See LEADS_WARNING.
 */

/**
 * Tossie's A2P 10DLC campaign is registered "Low Volume Mixed" with a use-case
 * description about appointment reminders and confirmations.
 *
 * Carriers police whether traffic matches the registered use case. A mismatch
 * does not get a warning: the campaign is suspended and the brand blocked,
 * which takes down the dialer's texting and the SDR with it. That is why this
 * sits on screen permanently rather than in a help page — the person about to
 * make the mistake is the person who never opens the help page.
 */
const AUDIENCES = [
  {
    kind: 'deal_match',
    title: 'Buy-box matched buyers',
    sub: 'The dispo blast',
    blurb:
      'One property, sent only to the buyers whose stated buy box it actually fits. This is the highest-value path and the most defensible one: the recipients are business contacts who asked to hear about deals, and the match score on every row is the record of how the audience was segmented.',
  },
  {
    kind: 'buyers',
    title: 'Buyers list',
    sub: 'A note to the list',
    blurb:
      'A meetup, a policy change, a note about the kind of deals coming up. Still only buyers who gave SMS consent — the ones who did not are listed as suppressed rather than silently dropped.',
  },
  {
    kind: 'leads',
    title: 'Hand-picked sellers',
    sub: 'Read the warning first',
    blurb:
      'A short list of specific sellers you owe a follow-up. Named one at a time, capped at 250, and not usable without acknowledging what it is.',
  },
];

const LEADS_WARNING =
  'Bulk SMS to a seller list does not match a "Low Volume Mixed" campaign registered for appointment reminders and confirmations. Carriers compare real traffic against that registration; a mismatch suspends the campaign and blocks the brand, which takes SMS away from the dialer and the SDR at the same time. BUILD_PLAN §4 says never blast the full list — that is how a 10DLC number gets carrier-flagged and how people stop reading the ones that do arrive. This audience exists for a dozen sellers who already opted in and are expecting to hear from you, named individually. It is not a way to reach the CRM.';

/**
 * The skip vocabulary from broadcast_recipients_skip_reason_check, one entry
 * per value, with the sentence an operator needs rather than the enum.
 *
 * `tone` splits them into the two kinds that call for different reactions:
 * 'stop' is somebody's legal position and there is nothing to fix, 'warn' is
 * unfinished work on our side that a person could go and do, 'quiet' is a
 * correct decision that cost nothing. Colouring an unfinished consent import
 * the same red as a STOP trains people to ignore both.
 *
 * These strings are a contract with the migration. A reason added there and not
 * here still renders — see `skipMeta` — but it renders as its raw enum, so grep
 * both files together when the vocabulary changes.
 *
 * Not the same vocabulary as lib/buyers.js `textingBlock`, and deliberately not
 * merged with it. That one answers "why can I not text this buyer, and what do
 * I go and do about it" from buyer_skip_reason's four values. This one answers
 * "why did this campaign not reach this row" from broadcast_recipients'
 * eleven — including four that only exist inside a send (not_in_buy_box,
 * outside_calling_window, send_refused, lead_trashed) and are not a property of
 * the contact at all. Sharing a map between the two would mean one screen
 * offering a fix for a state the other cannot produce.
 */
const SKIP_REASONS = {
  opted_out: {
    label: 'Replied STOP',
    tone: 'stop',
    why: 'This number texted STOP. Nothing was sent and nothing in this app can clear it — only a START from the same number, handled by the inbound webhook, does. Texting it anyway is a per-message TCPA violation.',
  },
  dnc: {
    label: 'On do-not-call',
    tone: 'stop',
    why: 'Flagged do-not-contact on the lead. Clear the flag on the lead itself if that is wrong; it is not clearable from here on purpose.',
  },
  litigator: {
    label: 'Known TCPA litigator',
    tone: 'stop',
    why: 'Flagged as a known TCPA litigator by the scrub. Do not contact by any channel.',
  },
  no_consent: {
    label: 'No consent on file',
    tone: 'warn',
    why: 'A buyer needs consent_sms and tcpa_opt_in with provenance; a lead needs either an opt-in or to have been skip traced and DNC scrubbed. Record what they actually agreed to on their own record — this is the reason worth chasing, because it is usually a list that was imported without its consent evidence.',
  },
  buyer_inactive: {
    label: 'Buyer paused or blacklisted',
    tone: 'quiet',
    why: 'buyers.status is not "active". Somebody set that deliberately; reactivate the buyer if it is stale.',
  },
  lead_trashed: {
    label: 'Lead is trashed',
    tone: 'quiet',
    why: 'The lead was trashed. Untrash it if it belongs in this send.',
  },
  buyer_trashed: {
    label: 'Buyer is deleted',
    tone: 'quiet',
    why: 'The buyer was deleted. Restore it from Trash if it belongs in this send — buyer_skip_reason enforces this in the database, so a deleted buyer cannot be blasted even by a campaign built before the deletion.',
  },
  no_phone: {
    label: 'No number on file',
    tone: 'warn',
    why: 'There is no phone number to text. The row is kept so the audience count stays honest — a contact who silently vanishes from every send is how "why is our list not reaching people" becomes unanswerable.',
  },
  phone_invalid: {
    label: 'Number flagged wrong',
    tone: 'warn',
    why: 'The number on file was marked invalid, usually after a wrong-number disposition. Skip trace it again.',
  },
  not_in_buy_box: {
    label: 'Outside the buy box',
    tone: 'quiet',
    why: 'This buyer is textable but the property does not fit what they said they buy — wrong county, wrong price, too much rehab, spread under their minimum. This is the campaign working: sending it anyway is how a buyers list learns to ignore you.',
  },
  outside_calling_window: {
    label: 'Outside their calling hours',
    tone: 'warn',
    why: 'twilio-send-sms refused at send time: it was not 8am–9pm in that number’s own local time, resolved from its area code. Run the campaign again inside their window.',
  },
  send_refused: {
    label: 'Refused at send time',
    tone: 'warn',
    why: 'twilio-send-sms refused this one specifically. The reason it gave is on the row.',
  },
};

/**
 * The `{{token}}` vocabulary, spelled exactly as broadcast-send's `dealValues`
 * and its per-row name pass spell it.
 *
 * This is a contract with supabase/functions/broadcast-send/index.ts and a typo
 * here is a 400 at send time, not a silent hole in a message — the function
 * pre-flights the body and refuses `unknown_placeholder` before it claims a
 * single recipient. Grep both files together before renaming one.
 *
 * The set is closed there and mirrored closed here on purpose. An open
 * substitution — "fill anything that looks like a column" — is how a body ends
 * up quoting a number the buyer was never meant to see. Note what is absent:
 * `{{spread}}` is buyer_spread, which already has Tossie's assignment fee taken
 * out of it, and there is deliberately no token for the wholesaler's own
 * margin. `contract_price` is not offered either.
 */
const DEAL_TOKENS = [
  'address', 'city', 'state', 'zip', 'county', 'property_type',
  'rehab_level', 'occupancy', 'beds', 'baths', 'sqft', 'year_built',
  'price', 'arv', 'repairs', 'spread',
];

/** Filled per recipient, so they resolve for every audience, deal or not. */
const CONTACT_TOKENS = ['first_name', 'name'];

const ALL_TOKENS = [...DEAL_TOKENS, ...CONTACT_TOKENS];

/** Mirrors broadcast-send's TOKEN regex, so the composer counts what it counts. */
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

const tokensIn = (body) =>
  [...new Set([...body.matchAll(TOKEN_RE)].map((m) => m[1].toLowerCase()))];

/**
 * What each deal token will actually resolve to, character for character as
 * broadcast-send's dealValues() resolves it.
 *
 * These four helpers mirror that file's money/decimal/count/plain rather than
 * reusing lib/buyers.js `money`, and the difference is not pedantry. The two
 * things that go wrong when the parsers diverge are both one-directional and
 * both expensive:
 *
 *   - `Number()` where the sender uses `parseFloat`/`parseInt`. Number(null) is
 *     0, parseFloat('null') is NaN — so a deal with no beds gave the composer
 *     "0" for {{beds}}, enabled the chip, and passed tokenProblems(). The sender
 *     then refuses the WHOLE campaign with unresolved_placeholder, after the
 *     audience is frozen and after broadcast_campaigns_no_delete has made the
 *     campaign undeletable. A composer that permits what the sender refuses is
 *     the one failure this pre-flight exists to prevent.
 *   - `toLocaleString()` with no locale follows the browser, so a machine set to
 *     de-DE previewed "$184.500" and sent "$184,500". The price is the entire
 *     content of a dispo text.
 *
 * Grep this against supabase/functions/broadcast-send/index.ts when either
 * moves.
 */
function tokenValues(deal) {
  if (!deal) return {};
  // parseFloat, not Number: see above.
  const dec = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    if (!Number.isFinite(n)) return null;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  const int = (v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const dollars = (v) => { const n = int(v); return n === null ? null : `$${n.toLocaleString('en-US')}`; };
  const counted = (v) => { const n = int(v); return n === null ? null : n.toLocaleString('en-US'); };
  const plain = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
  return {
    address: plain(deal.address),
    city: plain(deal.city),
    state: plain(deal.state),
    zip: plain(deal.zip),
    county: plain(deal.county),
    property_type: plain(deal.property_type),
    rehab_level: plain(deal.rehab_level),
    occupancy: plain(deal.occupancy),
    beds: dec(deal.beds),
    baths: dec(deal.baths),
    sqft: counted(deal.sqft),
    year_built: deal.year_built ? String(deal.year_built) : null,
    price: dollars(deal.buyer_price),
    arv: dollars(deal.arv_estimate),
    repairs: dollars(deal.repair_estimate),
    spread: dollars(deal.buyer_spread),
  };
}

/**
 * The body as one recipient will actually see it.
 *
 * Needed for the segment count, which is otherwise a lie in the cheap
 * direction: `{{first_name}}` is fifteen characters in the template and six
 * once it is Marcus, so counting the template overstates the bill — and
 * `{{spread}}` is eight characters that become nine, which understates it.
 * Across two hundred buyers either error is real money and real carrier
 * exposure.
 *
 * The braces make it worse in a way that is easy to miss: `{` and `}` are
 * GSM-7 EXTENDED characters costing two septets each, so `{{name}}` is eight
 * characters but twelve septets. A template can therefore count as two
 * segments and render as one, which is the wrong answer in the direction that
 * makes somebody shorten a message that was already fine.
 *
 * `worstName` is the longest name in the audience rather than a made-up one,
 * so the count is the worst case for THIS send: the one recipient who tips a
 * two-segment message into three is the one this is trying to surface.
 */
function renderPreview(body, deal, worstName) {
  const values = tokenValues(deal);
  const first = (worstName || '').trim().split(/\s+/)[0] || '';
  return body.replace(TOKEN_RE, (_m, raw) => {
    const key = raw.toLowerCase();
    if (key === 'name') return worstName || '';
    if (key === 'first_name') return first;
    return values[key] ?? '';
  });
}

/** An unknown reason still renders, in its own words, rather than disappearing. */
function skipMeta(reason) {
  return (
    SKIP_REASONS[reason] || {
      label: titleize(reason || 'unknown'),
      tone: 'warn',
      why: 'This reason is not one this page knows about. It came from the database, so it is real — check broadcast_recipients_skip_reason_check.',
    }
  );
}

/** The order skips are read in: legal position first, then work, then correct decisions. */
const SKIP_ORDER = [
  'opted_out', 'dnc', 'litigator',
  'no_consent', 'no_phone', 'phone_invalid', 'outside_calling_window', 'send_refused',
  'buyer_inactive', 'lead_trashed', 'buyer_trashed', 'not_in_buy_box',
];

/** A reason this page has not been taught about sorts last rather than first. */
const skipRank = (reason) => {
  const i = SKIP_ORDER.indexOf(reason);
  return i < 0 ? SKIP_ORDER.length : i;
};

/**
 * The GSM-7 alphabet, and segment counting on top of it.
 *
 * This is a knowing second copy of the pair in MessagesPage — the same
 * constants and the same arithmetic. It is duplicated rather than shared
 * because this file was scoped to itself, and it is called out here rather than
 * left to be discovered: if a third composer ever appears, all three move to
 * lib/format.js instead of a third copy being made.
 *
 * It matters more here than it does in the inbox. One curly apostrophe pasted
 * from Notes pushes the whole body into UCS-2, where a segment is 70 characters
 * instead of 160 — so a 150-character message becomes three segments, and
 * across 180 buyers that is 540 billable messages instead of 180, at three
 * times the carrier-filtering exposure on a 10DLC number.
 */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\f^{}\\[~\]|€]*$/;
const GSM7_DOUBLE = /[\f^{}\\[~\]|€]/g;

function segments(s) {
  if (s.length === 0) return 0;
  if (!GSM7.test(s)) return s.length <= 70 ? 1 : Math.ceil(s.length / 67);
  const septets = s.length + (s.match(GSM7_DOUBLE)?.length ?? 0);
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

const buyerName = (b) => (b ? b.name || b.entity_name || 'Unnamed buyer' : null);
const leadName = (l) => (l ? l.name || l.address || 'Unnamed lead' : null);

/** The cap materialise_campaign enforces for `leads`, mirrored so the UI stops first. */
const LEADS_CAP = 250;

/**
 * Mirrors public.phone_key() exactly: the last ten digits, NULL when empty.
 * NULLIF and not a length test — a short number still keys to itself in SQL,
 * and a preview that grouped differently to the ledger would be worse than one
 * that grouped a seven-digit typo oddly.
 */
const phoneKey = (v) => (v || '').replace(/\D/g, '').slice(-10) || null;

/**
 * One number, one message — deduped the way materialise_campaign does it, and
 * fail-closed the same way.
 *
 * Two buyers sharing a number (a partner and their LLC is the common one) are
 * one text, not two, and when the two rows disagree about whether to send, the
 * suppressed decision wins. Getting that backwards would let a duplicate row
 * launder an opt-out into a delivery.
 *
 * Without this the preview would count a number twice and then report a
 * different total than the ledger built from the identical rule — which is the
 * one thing this screen cannot afford, because the whole reason to trust the
 * preview is that it is the same arithmetic.
 */
function dedupe(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = phoneKey(r.phone) ?? `id:${r.id}`;
    const held = by.get(key);
    if (!held) { by.set(key, r); continue; }

    const heldSkipped = Boolean(held.skip_reason);
    const rSkipped = Boolean(r.skip_reason);
    if (rSkipped !== heldSkipped) {
      if (rSkipped) by.set(key, r);
      continue;
    }
    // DISTINCT ON's third sort key, `score DESC NULLS LAST`. Only reachable
    // when two buyers share a number and agree on the decision, but the score
    // it settles is what gets frozen into match_score — the evidence of why
    // this number was in this audience. The preview has to name the same one.
    if ((r.score ?? -1) > (held.score ?? -1)) by.set(key, r);
  }
  return [...by.values()];
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [building, setBuilding] = useState(false);
  const [userId, setUserId] = useState(null);
  const [sendState, setSendState] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const reloadTimer = useRef(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('broadcast_campaigns')
      .select('*, deals(id, address, city, state, status)')
      .eq('trashed', false)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) setErr(error.message);
    else setCampaigns(data ?? []);
    setLoading(false);
  }, []);

  /**
   * The recount trigger fires once per recipient row, so a 180-buyer blast
   * rewrites the campaign's counts 180 times in a couple of seconds. One
   * trailing reload lands the same state at 1/180th the traffic.
   */
  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(load, 400);
  }, [load]);

  useEffect(() => {
    load();
    supabase.auth.getUser().then(({ data }) => setUserId(data?.user?.id ?? null));

    // Whether SMS can leave the building at all. Read once per mount rather
    // than subscribed to: A2P clearing or a kill switch flipping is a
    // once-a-quarter event, and the send path refuses regardless of what this
    // banner believes.
    Promise.all([
      supabase.from('telephony_settings').select('*').maybeSingle(),
      supabase.from('phone_numbers').select('*').is('released_at', null)
        .order('is_primary', { ascending: false }),
      supabase.from('teams').select('sms_send_disabled').eq('id', TEAM_ID).maybeSingle(),
    ]).then(([s, n, t]) => {
      const failed = [s.error, n.error, t.error].find(Boolean);
      if (failed) {
        setErr(`Could not read the telephony settings (${failed.message}), so the banner below may be wrong. The send path still enforces every rail.`);
      }
      setSendState({
        settings: s.data ?? null,
        numbers: n.data ?? [],
        teamKill: Boolean(t.data?.sms_send_disabled),
      });
    });

    // A campaign moves through its status ladder from the worker, not from
    // this tab. Without this, "sending" never becomes "sent" on screen and the
    // natural reaction is to send it again.
    const channel = supabase
      .channel('broadcast-campaigns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'broadcast_campaigns' }, reload)
      .subscribe();

    return () => {
      clearTimeout(reloadTimer.current);
      supabase.removeChannel(channel);
    };
  }, [load, reload]);

  const open = campaigns.find((c) => c.id === openId) ?? null;

  if (loading) return <div className="empty">Loading campaigns…</div>;

  return (
    <>
      <header>
        <h1>Campaigns</h1>
        <span className="count">
          {campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      <A2PBanner />
      {sendState && <SendingStateBanner {...sendState} />}

      {building ? (
        <Builder
          userId={userId}
          onCancel={() => setBuilding(false)}
          onBuilt={(id) => { setBuilding(false); setOpenId(id); load(); }}
        />
      ) : open ? (
        <CampaignDetail
          campaign={open}
          onBack={() => setOpenId(null)}
          onChanged={load}
        />
      ) : (
        <CampaignList
          campaigns={campaigns}
          onOpen={setOpenId}
          onNew={() => setBuilding(true)}
          onDeleted={load}
        />
      )}
    </>
  );
}

/**
 * The registration, stated plainly and permanently.
 *
 * It is not dismissible. The cost of reading it a hundred times is a hundred
 * seconds; the cost of not reading it once is the brand.
 */
function A2PBanner() {
  return (
    <div className="banner a2pnote">
      <strong>This account texts under a “Low Volume Mixed” A2P 10DLC registration.</strong>
      Its registered use case is appointment reminders and confirmations. Carriers compare
      real traffic against that description — traffic that does not match gets the campaign
      suspended and the brand blocked, which takes SMS away from the dialer and the SDR too.
      Buyers who asked to hear about deals are the audience this registration supports.
      Cold seller lists are not.
    </div>
  );
}

/**
 * Whether a blast can leave at all, in the order a refusal would happen. Same
 * questions the inbox asks, answered for a different action — a blast also
 * needs the number to be SMS-enabled and A2P-approved, and finding that out
 * after materialising 180 recipients is a wasted step.
 */
function SendingStateBanner({ teamKill, settings, numbers }) {
  const sender =
    numbers.find((n) => n.id === settings?.default_number_id) ||
    numbers.find((n) => n.is_primary) ||
    numbers[0] || null;

  if (teamKill) {
    return (
      <div className="banner stop">
        <strong>SMS is off.</strong> The owner kill switch (teams.sms_send_disabled) is on.
        Campaigns can still be built and previewed; every message is refused until an owner turns it off.
      </div>
    );
  }
  if (settings?.sms_send_paused) {
    return (
      <div className="banner warn">
        <strong>Sending is paused.</strong> telephony_settings.sms_send_paused is on.
        A campaign started now would skip every recipient at send time.
      </div>
    );
  }
  if (!sender) {
    return (
      <div className="banner warn">
        <strong>No number connected.</strong> Add a Twilio number in phone settings before sending a campaign.
      </div>
    );
  }
  if (!sender.sms_enabled) {
    return (
      <div className="banner warn">
        <strong>Texting is off on {formatPhone(sender.e164)} — this is expected.</strong>{' '}
        A2P 10DLC registration is <em>{(sender.a2p_status || 'not_started').replace(/_/g, ' ')}</em>.
        Build and preview campaigns now; nothing will send until the campaign is approved
        and SMS is switched on for the number.
      </div>
    );
  }
  if (sender.a2p_status !== 'approved') {
    return (
      <div className="banner warn">
        <strong>SMS is on but A2P is {(sender.a2p_status || 'not_started').replace(/_/g, ' ')}.</strong>{' '}
        Expect carrier filtering and 30007/30008 errors on a bulk send until the campaign is approved.
      </div>
    );
  }
  return null;
}

/* ── the list ─────────────────────────────────────────────────────────────── */

function CampaignList({ campaigns, onOpen, onNew, onDeleted }) {
  return (
    <div className="card">
      <h2>Campaigns</h2>
      <div className="cardnote campaignsbar">
        <span>
          Every campaign keeps its full audience, suppressed recipients included. Nothing here is deleted
          once it has been built.
        </span>
        <button className="btn" type="button" onClick={onNew}>New campaign</button>
      </div>

      {campaigns.length === 0 ? (
        <div className="empty">
          <strong>No campaigns yet</strong>
          The usual first one is a dispo blast: pick a deal, see which buyers it fits, send it to those.
        </div>
      ) : (
        <table className="leads campaigntbl">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Audience</th>
              <th>Status</th>
              <th>Reached</th>
              <th>Suppressed</th>
              <th className="hide-sm">Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="addr">{c.name}</span>
                  <span className="sub">{c.body.slice(0, 70)}{c.body.length > 70 ? '…' : ''}</span>
                </td>
                <td>
                  {AUDIENCES.find((a) => a.kind === c.audience_kind)?.title || titleize(c.audience_kind)}
                  {c.deals && <span className="sub">{c.deals.address}</span>}
                </td>
                <td><StatusBadge status={c.status} /></td>
                {/* Always a fraction. A bare "12" is the number this page exists
                    to stop anybody from reading on its own. */}
                <td>
                  {c.materialised_at
                    ? <>{c.sent_count} / {c.total_recipients}</>
                    : <span className="sub">not built</span>}
                </td>
                <td>
                  {c.skipped_count > 0
                    ? <span className="badge stop">{c.skipped_count}</span>
                    : <span className="sub">—</span>}
                </td>
                <td className="hide-sm sub">{timeAgo(c.created_at)}</td>
                {/* stopPropagation, or deleting opens the campaign underneath */}
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                  <CampaignDelete campaign={c} onDeleted={onDeleted} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Delete one campaign.
 *
 * Trash rather than DELETE, always — and for a *sent* campaign that is not a
 * preference, it is the only option the database will allow.
 * broadcast_campaign_no_delete_after_materialise refuses to drop any campaign
 * whose audience was built, because broadcast_recipients is the record of who
 * was texted and who was suppressed and why, and that record is the exact thing
 * a carrier asks to see when it reviews a Low Volume Mixed campaign. So the
 * send history survives being tidied off this screen; only the row's visibility
 * changes. A never-built draft has no such record, and Trash will destroy that
 * one on request.
 */
function CampaignDelete({ campaign, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function go() {
    setBusy(true);
    const { error } = await supabase
      .from('broadcast_campaigns').update({ trashed: true }).eq('id', campaign.id);
    if (error) { setErr(error.message); setBusy(false); setConfirming(false); return; }
    setConfirming(false);
    setBusy(false);
    onDeleted?.();
  }

  if (err) return <span className="err inline">{err}</span>;

  if (!confirming) {
    return (
      <button className="btn ghost danger" onClick={() => setConfirming(true)}>Delete</button>
    );
  }

  return (
    <span className="confirmdelete">
      <span>
        {campaign.materialised_at
          ? 'Hide it? The send record is kept either way — it cannot be destroyed.'
          : 'Delete this draft? It moves to Trash.'}
      </span>
      <button className="btn danger" disabled={busy} onClick={go}>
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}

function StatusBadge({ status }) {
  const tone =
    status === 'sent' ? 'ok'
      : status === 'failed' ? 'stop'
      : status === 'sending' ? 'warm'
      : status === 'paused' ? 'cold'
      : '';
  return <span className={`badge ${tone}`}>{titleize(status)}</span>;
}

/* ── building one ─────────────────────────────────────────────────────────── */

/**
 * Audience first, message second, and the audience preview is live the whole
 * time the message is being written.
 *
 * That order is deliberate. Composing first and picking recipients afterwards
 * is how a message written for one audience goes to another, and it is also how
 * somebody ends up looking for the audience that fits a message they have
 * already fallen in love with.
 */
function Builder({ userId, onCancel, onBuilt }) {
  const [kind, setKind] = useState('deal_match');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // deal_match
  const [deals, setDeals] = useState([]);
  const [dealId, setDealId] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [matches, setMatches] = useState(null);   // null = not fetched yet

  // buyers
  const [buyers, setBuyers] = useState([]);
  const [counties, setCounties] = useState('');
  const [minRating, setMinRating] = useState('');
  const [pickedBuyers, setPickedBuyers] = useState([]);
  const [buyerCount, setBuyerCount] = useState(0);

  // leads
  const [leadsAck, setLeadsAck] = useState(false);
  const [pickedLeads, setPickedLeads] = useState([]);

  useEffect(() => {
    /**
     * Live deals only. materialise_campaign refuses a closed or dead deal, and
     * offering one here would mean building a whole audience to be told no —
     * but more to the point, texting a buyers list about a property that is
     * already gone is how a list stops getting read.
     */
    supabase.from('deals')
      .select('id, address, city, state, zip, county, status, beds, baths, sqft, rehab_level, occupancy, contract_price, arv_estimate, repair_estimate, target_assignment_fee, buyer_price, buyer_spread')
      .not('status', 'in', '(closed,dead)')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => { if (error) setErr(error.message); else setDeals(data ?? []); });

    /**
     * `skip_reason:buyer_skip_reason` is the database function read as a
     * computed column, the same trick LeadDetail uses for lead_is_dialable.
     * The preview must never re-derive who is textable — the whole value of
     * this screen is that it shows the decision the send will actually make.
     *
     * The exact count comes back alongside the capped page because the cap is
     * a client-side one and materialise_campaign has none: past 2000 buyers the
     * preview would quietly describe a smaller audience than the one that gets
     * frozen, which is the "you thought it was 200, it was 240" failure this
     * screen exists to make impossible. Better to say the preview is short than
     * to be short and silent about it.
     */
    supabase.from('buyers')
      .select('id, name, entity_name, phone, status, rating, counties, consent_sms, tcpa_opt_in, skip_reason:buyer_skip_reason', { count: 'exact' })
      .eq('trashed', false)
      .order('name')
      .limit(2000)
      .then(({ data, error, count }) => {
        if (error) { setErr(error.message); return; }
        setBuyers(data ?? []);
        setBuyerCount(count ?? (data?.length ?? 0));
      });
  }, []);

  const deal = deals.find((d) => d.id === dealId) ?? null;

  // The ranked list for the chosen deal, straight from match_buyers_for_deal —
  // the same function materialise_campaign calls, so the preview and the ledger
  // cannot disagree about who is in the box.
  useEffect(() => {
    if (kind !== 'deal_match' || !dealId) { setMatches(null); return; }
    let live = true;
    supabase.rpc('match_buyers_for_deal', { p_deal_id: dealId }).then(({ data, error }) => {
      if (!live) return;
      if (error) { setErr(error.message); setMatches([]); }
      else setMatches(data ?? []);
    });
    return () => { live = false; };
  }, [kind, dealId]);

  /**
   * The preview: every candidate, with the decision the database would make.
   *
   * Built the same way materialise_campaign builds it — the candidate pool is
   * the whole list and suppression outranks not-in-buy-box — so what is on
   * screen before anything is created is what will be frozen after.
   */
  const preview = useMemo(() => {
    if (kind === 'deal_match') {
      if (!dealId || matches === null) return null;
      const byId = new Map(matches.map((m) => [m.buyer_id, m]));
      return dedupe(buyers.map((b) => {
        const m = byId.get(b.id);
        const inBox = m && m.score >= (Number(minScore) || 0);
        return {
          id: b.id,
          who: buyerName(b),
          phone: b.phone,
          // Compliance reasons outrank the buy box: both mean nothing was
          // sent, but only one of them is a fact somebody may have to read
          // back in a dispute.
          skip_reason: b.skip_reason || (inBox ? null : 'not_in_buy_box'),
          score: m?.score ?? null,
          reasons: m?.reasons ?? [],
        };
      }));
    }

    if (kind === 'buyers') {
      const wanted = counties.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
      const floor = minRating === '' ? null : Number(minRating);
      return dedupe(buyers
        .filter((b) => (pickedBuyers.length === 0 || pickedBuyers.includes(b.id)))
        // btrim on both sides, because text_array_contains_ci does: a buy box
        // imported with a stray leading space matches in SQL, and a preview
        // that dropped that buyer would name a smaller audience than the
        // ledger it promises to be identical to.
        .filter((b) => wanted.length === 0
          || (b.counties ?? []).some((c) => wanted.includes(String(c).trim().toLowerCase())))
        // COALESCE(rating, 0) — mirrors materialise_campaign, where an unrated
        // buyer is treated as rating 0 rather than as unfiltered.
        .filter((b) => floor === null || (b.rating ?? 0) >= floor)
        .map((b) => ({ id: b.id, who: buyerName(b), phone: b.phone, skip_reason: b.skip_reason, score: null, reasons: [] })));
    }

    // COALESCE(phone_mobile, phone) — the number lead_skip_reason and
    // materialise_campaign both settle on, so the preview names the one that
    // would actually be texted rather than whichever is on screen.
    return dedupe(pickedLeads.map((l) => ({
      id: l.id,
      who: leadName(l),
      phone: l.phone_mobile || l.phone,
      skip_reason: l.skip_reason,
      score: null,
      reasons: [],
    })));
  }, [kind, dealId, matches, minScore, buyers, counties, minRating, pickedBuyers, pickedLeads]);

  const willSend = preview ? preview.filter((r) => !r.skip_reason).length : 0;
  const total = preview ? preview.length : 0;

  const hasStop = /stop/i.test(body);
  const tokenErrs = tokenProblems(body, kind, deal);

  // Counted on the rendered worst case, not the template. See renderPreview.
  const worstName = (preview ?? []).reduce(
    (long, r) => ((r.who || '').length > long.length ? r.who : long), '',
  );
  const rendered = renderPreview(body, deal, worstName);
  const segs = segments(rendered);
  const templated = tokensIn(body).length > 0;

  /**
   * The CHECK caps the TEMPLATE at 1600; broadcast-send measures the RENDERED
   * text against the same 1600, which is Twilio's hard ceiling on one body.
   * "{{address}}" is eleven characters that become forty, so a template that
   * saves cleanly can render long — and the sender answers that with
   * `body_too_long`, a 400 that refuses every recipient.
   *
   * That failure is unrecoverable from this UI, which is why it is checked
   * here rather than left to the server: by the time the sender sees the body
   * the audience has been materialised, and broadcast_campaigns_no_delete
   * refuses to delete a materialised campaign. The operator would be left with
   * a frozen campaign that can never send and can never be cleared.
   */
  const renderedTooLong = rendered.length > MAX_BODY;

  const bodyOk =
    body.trim().length > 0 && body.length <= MAX_BODY && hasStop && !renderedTooLong
    && tokenErrs.unknown.length === 0 && tokenErrs.empty.length === 0;

  const audienceOk =
    kind === 'deal_match' ? Boolean(dealId)
      : kind === 'buyers' ? total > 0
      : leadsAck && pickedLeads.length > 0 && pickedLeads.length <= LEADS_CAP;

  const ready = Boolean(name.trim()) && bodyOk && audienceOk && !busy;

  function audienceFilter() {
    if (kind === 'deal_match') return { min_score: Number(minScore) || 0 };
    if (kind === 'leads') return { lead_ids: pickedLeads.map((l) => l.id) };

    const f = {};
    if (pickedBuyers.length > 0) f.buyer_ids = pickedBuyers;
    const c = counties.split(',').map((s) => s.trim()).filter(Boolean);
    if (c.length > 0) f.counties = c;
    if (minRating !== '') f.min_rating = Number(minRating);
    return f;
  }

  /**
   * Create the draft, then freeze its audience.
   *
   * Two calls rather than one because they fail differently and the difference
   * matters to whoever is reading the message: the insert fails on a CHECK the
   * composer should have caught, and materialise fails on the state of the
   * world — a deal that closed while this screen was open. Either way this
   * function is all-or-nothing, so a failure leaves the operator exactly where
   * they were rather than partway into something.
   */
  async function build() {
    if (!ready) return;
    setBusy(true);
    setErr(null);

    const { data: created, error: insErr } = await supabase
      .from('broadcast_campaigns')
      .insert({
        team_id: TEAM_ID,
        name: name.trim(),
        audience_kind: kind,
        audience_filter: audienceFilter(),
        deal_id: kind === 'deal_match' ? dealId : null,
        body,
        created_by: userId,
      })
      .select('id')
      .single();

    if (insErr) {
      setErr(insertError(insErr));
      setBusy(false);
      return;
    }

    const { error: matErr } = await supabase.rpc('materialise_campaign', {
      p_campaign_id: created.id,
    });

    if (matErr) {
      /**
       * Undo the insert and stay put.
       *
       * Navigating to the half-made campaign would unmount this component and
       * take the sentence explaining what went wrong with it, and leaving the
       * row behind means every failed attempt deposits another empty draft
       * that somebody has to recognise as debris later. The DELETE is normally
       * safe precisely because materialise failed: broadcast_campaigns_no_delete
       * only refuses campaigns that reached materialised_at, and
       * materialise_campaign sets that stamp last.
       *
       * Normally. `matErr` also covers a dropped connection on a call that
       * SUCCEEDED server-side, and then the stamp is set, the trigger refuses
       * the delete, and a fully materialised campaign is sitting one click away
       * from a blast. Asserting "nothing was saved" without reading the delete
       * back is the silent failure this whole page exists to prevent, so the
       * sentence is only printed when it is true.
       */
      const { error: undoErr } = await supabase
        .from('broadcast_campaigns').delete().eq('id', created.id);
      setErr(undoErr
        ? `${materialiseError(matErr)} Nothing was sent, but the campaign row could not be removed (${undoErr.message}) — which means it may already have an audience. Open “${name.trim()}” in the list and check it before building another.`
        : `${materialiseError(matErr)} Nothing was sent and nothing was saved.`);
      setBusy(false);
      return;
    }

    setBusy(false);
    onBuilt(created.id);
  }

  return (
    <>
      <div className="card">
        <h2>Who is this going to</h2>
        <div className="body">
          <div className="audiencepick">
            {AUDIENCES.map((a) => (
              <label key={a.kind} className={`audiencecard${kind === a.kind ? ' on' : ''}`}>
                <span className="ahead">
                  {/* The radio stays visible rather than being hidden behind
                      the card. A styled card with no control in it is one
                      nobody can tab to, and this is the choice on the page
                      most worth being able to see the state of. */}
                  <input
                    type="radio"
                    name="audience"
                    checked={kind === a.kind}
                    onChange={() => setKind(a.kind)}
                  />
                  <strong>{a.title}</strong>
                  <em>{a.sub}</em>
                </span>
                <span className="fine">{a.blurb}</span>
              </label>
            ))}
          </div>

          {kind === 'deal_match' && (
            <DealMatchPicker
              deals={deals}
              dealId={dealId}
              setDealId={setDealId}
              minScore={minScore}
              setMinScore={setMinScore}
              matchCount={matches?.length ?? null}
            />
          )}

          {kind === 'buyers' && (
            <BuyersPicker
              buyers={buyers}
              counties={counties}
              setCounties={setCounties}
              minRating={minRating}
              setMinRating={setMinRating}
              picked={pickedBuyers}
              setPicked={setPickedBuyers}
            />
          )}

          {kind === 'leads' && (
            <LeadsPicker
              ack={leadsAck}
              setAck={setLeadsAck}
              picked={pickedLeads}
              setPicked={setPickedLeads}
            />
          )}
        </div>
      </div>

      {preview && (
        <div className="card">
          <h2>Preview — {willSend} of {total} will receive it</h2>
          <p className="cardnote">
            This is the decision the database will make, read from the same functions the send path uses.
            Nothing has been created yet and nothing has been sent.
          </p>
          <div className="body">
            {/* Only ever fires past 2000 buyers, and then it fires loudly: the
                one promise this card makes is that its arithmetic is the
                ledger's, and a truncated candidate pool breaks exactly that. */}
            {kind !== 'leads' && buyerCount > buyers.length && (
              <div className="notice">
                <strong>
                  This preview read {buyers.length} of your {buyerCount} buyers.
                </strong>
                Building the audience considers all {buyerCount}, so the frozen ledger will be larger
                than the numbers below. Narrow by county or rating, or read the ledger on the next
                screen as the real count.
              </div>
            )}
            <Ledger total={total} sending={willSend} rows={preview} segs={segs} />
          </div>
        </div>
      )}

      <div className="card">
        <h2>The message</h2>
        <div className="body">
          <div className="fields">
            <label className="wide">
              Campaign name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={deal ? `Dispo — ${deal.address}` : 'What this send is, for the record'}
              />
            </label>
          </div>

          <TokenPalette deal={deal} onInsert={(t) => setBody((b) => (b ? `${b} ${t}` : t))} />

          <textarea
            className="note composerbody"
            placeholder="Write it once. Every recipient gets this, with the tokens filled in."
            value={body}
            maxLength={MAX_BODY}
            onChange={(e) => setBody(e.target.value)}
          />

          <div className="composerfoot">
            <span className="count">
              {body.length}/{MAX_BODY} · {segs} segment{segs === 1 ? '' : 's'} each
              {willSend > 0 && ` · ${segs * willSend} billable message${segs * willSend === 1 ? '' : 's'}`}
              {templated && ' · counted on the longest name in this audience'}
            </span>
          </div>

          {/* What one buyer actually receives. Shown whenever the body is a
              template, because the tokens are exactly where a message goes
              wrong in a way nobody sees until it has gone to everybody. */}
          {templated && rendered.trim() && (
            <blockquote className="sentbody rendered">{rendered}</blockquote>
          )}

          {/* The CHECK is in the database and will reject the insert; catching
              it here is the difference between a sentence and a constraint
              name. Carriers look for the opt-out, and a buyer who cannot find
              the exit reports the number as spam — which costs more than the
              buyer did. */}
          {body.trim().length > 0 && !hasStop && (
            <div className="notice">
              <strong>Every bulk message has to carry its own way out.</strong>
              The body must contain the word “stop” — the usual ending is
              “Reply STOP to opt out.” The database refuses to store it otherwise.
            </div>
          )}

          {tokenErrs.unknown.length > 0 && (
            <div className="notice">
              <strong>
                {tokenErrs.unknown.map((t) => `{{${t}}}`).join(', ')}{' '}
                {tokenErrs.unknown.length === 1 ? 'is not a token' : 'are not tokens'} the sender knows.
              </strong>
              It would refuse the whole send rather than text anyone a sentence with a hole in it.
              Use one of the chips above, or write the value out.
            </div>
          )}

          {renderedTooLong && (
            <div className="notice">
              <strong>
                With the tokens filled in this is {rendered.length} characters, and {MAX_BODY} is the limit.
              </strong>
              The stored template is short enough, but the message that actually goes out is not — the
              sender measures the rendered text and would refuse every recipient. Shorten it now: once the
              audience is built the body is frozen and the campaign cannot be deleted.
            </div>
          )}

          {tokenErrs.empty.length > 0 && (
            <div className="notice">
              <strong>{tokenErrs.empty.map((t) => `{{${t}}}`).join(', ')} would come out blank.</strong>
              {kind === 'deal_match'
                ? ' That field is empty on this property. Fill it in on the deal, or reword the message — the sender refuses rather than sending a gap.'
                : ' Property tokens only resolve on a dispo blast, which is the only audience with a deal attached. Reword the message or switch the audience.'}
            </div>
          )}

          {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}

          <div className="confirmbtns" style={{ marginTop: 14 }}>
            <button className="btn" type="button" disabled={!ready} onClick={build}>
              {busy ? 'Building the audience…' : `Build the audience${willSend ? ` (${willSend} of ${total})` : ''}`}
            </button>
            <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
          </div>
          <p className="fine">
            Building freezes the audience and the message into a ledger you can read row by row.
            It still sends nothing — sending is a separate, deliberate step on the next screen.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * The insert failures worth a sentence. Everything else falls through to
 * Postgres, which is verbose but at least true.
 */
function insertError(e) {
  const m = e.message || '';
  if (m.includes('broadcast_campaigns_body_has_opt_out')) {
    return 'The message was refused: it must be non-empty, at most 1600 characters, and contain the word “stop”.';
  }
  if (m.includes('broadcast_campaigns_leads_need_explicit_ids')) {
    return 'A seller campaign has to name its recipients individually. There is deliberately no way to express “all leads”.';
  }
  if (m.includes('broadcast_campaigns_deal_match_needs_deal')) {
    return 'A dispo blast needs a property. Pick the deal first.';
  }
  return `The campaign could not be saved: ${m}`;
}

/** materialise_campaign raises with SQLSTATEs chosen to be told apart. */
function materialiseError(e) {
  if (e.code === '55000') {
    // Either the campaign is past draft, or the deal it points at is gone.
    // Both are "the world moved"; the server's own sentence says which.
    return e.message;
  }
  if (e.code === '02000') {
    return 'That campaign or its deal is no longer visible. Reload the page.';
  }
  if (e.code === '22023') {
    return e.message;
  }
  return `The audience could not be built: ${e.message}`;
}

/* ── audience pickers ─────────────────────────────────────────────────────── */

function DealMatchPicker({ deals, dealId, setDealId, minScore, setMinScore, matchCount }) {
  const deal = deals.find((d) => d.id === dealId) ?? null;

  return (
    <div className="pickerblock">
      <div className="fields">
        <label className="wide">
          Property
          <select value={dealId} onChange={(e) => setDealId(e.target.value)}>
            <option value="">Pick a deal…</option>
            {deals.map((d) => (
              <option key={d.id} value={d.id}>
                {d.address}{d.city ? `, ${d.city}` : ''} — {titleize(d.status)}
                {d.buyer_price ? ` · ${money(d.buyer_price)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Minimum match score
          <input
            type="number" min="0" max="100"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
          />
        </label>
      </div>

      {deals.length === 0 && (
        <p className="fine">
          No live deals. A dispo blast needs a property that is not closed or dead —
          the matcher has nothing to compare a buy box against otherwise.
        </p>
      )}

      {deal && (
        <p className="fine">
          {matchCount === null
            ? 'Matching…'
            : <>match_buyers_for_deal returns <strong>{matchCount}</strong> buyer{matchCount === 1 ? '' : 's'} for this
              property. Raising the minimum score narrows that; it never widens it, and it can never
              reach a buyer the consent gate excluded.</>}
        </p>
      )}
    </div>
  );
}

/**
 * Filters, then optionally names.
 *
 * The filters are the ones materialise_campaign understands, so an unset filter
 * means no restriction rather than "matches nothing" — a county box left blank
 * that quietly matched nobody would produce an empty campaign that looks like a
 * send failure.
 *
 * Checking individual buyers switches the campaign from "everyone the filters
 * describe" to "these exact people", written into audience_filter.buyer_ids.
 * Both are honest; the second is what somebody wants when a deal has three
 * obvious buyers.
 */
function BuyersPicker({ buyers, counties, setCounties, minRating, setMinRating, picked, setPicked }) {
  const toggle = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="pickerblock">
      <div className="fields">
        <label>
          Counties <span className="fine">comma separated, blank for all</span>
          <input value={counties} onChange={(e) => setCounties(e.target.value)} placeholder="Chatham, Effingham" />
        </label>
        <label>
          Minimum rating
          <select value={minRating} onChange={(e) => setMinRating(e.target.value)}>
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} and up</option>)}
          </select>
        </label>
      </div>

      <p className="fine">
        {picked.length > 0
          ? `Sending to ${picked.length} named buyer${picked.length === 1 ? '' : 's'}. Untick them all to go back to the filters above.`
          : 'Tick individual buyers to narrow the send to exactly those people instead of everyone the filters describe.'}
      </p>

      <div className="picklist">
        {buyers.map((b) => (
          <label key={b.id} className={`pickrow${picked.includes(b.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={picked.includes(b.id)} onChange={() => toggle(b.id)} />
            <span className="who">
              {buyerName(b)}
              {b.entity_name && b.name && <span className="sub"> · {b.entity_name}</span>}
            </span>
            <span className="sub">{formatPhone(b.phone) || 'no number'}</span>
            {b.skip_reason
              ? <span className={`badge ${skipMeta(b.skip_reason).tone === 'stop' ? 'stop' : 'cold'}`}>{skipMeta(b.skip_reason).label}</span>
              : <span className="badge ok">Textable</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Sellers, one at a time, behind a wall.
 *
 * There is no "select all", no "everyone in this stage", and no filter that
 * returns a set — search returns matches and each one is ticked by hand. That
 * is not friction for its own sake: picking 200 sellers individually is slow
 * enough that a person notices what they are doing, which is the only control
 * that actually works against the two-click blast.
 */
function LeadsPicker({ ack, setAck, picked, setPicked }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setResults([]); return; }

    // Commas and parens are PostgREST's own `or=` syntax; a seller called
    // "Smith, Jr." would otherwise turn one filter into two malformed ones.
    const safe = needle.replace(/[,()%*]/g, ' ').trim();
    if (!safe) { setResults([]); return; }

    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      supabase.from('leads')
        .select('id, name, address, city, state, phone, phone_mobile, status, skip_reason:lead_skip_reason')
        .or(`name.ilike.%${safe}%,address.ilike.%${safe}%,city.ilike.%${safe}%`)
        .eq('trashed', false)
        .order('updated_at', { ascending: false })
        .limit(40)
        .then(({ data }) => {
          if (!live) return;
          setResults(data ?? []);
          setSearching(false);
        });
    }, 250);

    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const pick = (l) => setPicked((p) => (p.some((x) => x.id === l.id) ? p : [...p, l]));
  const drop = (id) => setPicked((p) => p.filter((x) => x.id !== id));

  return (
    <div className="pickerblock">
      <div className="stoprepair">
        <strong>Read this before using this audience.</strong>
        <p className="fine">{LEADS_WARNING}</p>
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            <strong>I have read the above.</strong>
            <small>
              These sellers are expecting to hear from me, and this is not a cold list.
            </small>
          </span>
        </label>
      </div>

      {ack && (
        <>
          <div className="toolbar" style={{ marginTop: 14 }}>
            <input
              placeholder="Search a seller by name, address or city…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className="picklist">
            {q.trim().length < 2 ? (
              <p className="fine" style={{ padding: '10px 12px' }}>
                Type at least two characters. There is no browse-all here on purpose.
              </p>
            ) : searching ? (
              <p className="fine" style={{ padding: '10px 12px' }}>Searching…</p>
            ) : results.length === 0 ? (
              <p className="fine" style={{ padding: '10px 12px' }}>Nothing matches.</p>
            ) : (
              results.map((l) => {
                const on = picked.some((x) => x.id === l.id);
                return (
                  <label key={l.id} className={`pickrow${on ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && picked.length >= LEADS_CAP}
                      onChange={() => (on ? drop(l.id) : pick(l))}
                    />
                    <span className="who">
                      {leadName(l)}
                      {l.address && l.name && <span className="sub"> · {l.address}</span>}
                    </span>
                    <span className="sub">{formatPhone(l.phone_mobile || l.phone) || 'no number'}</span>
                    {l.skip_reason
                      ? <span className={`badge ${skipMeta(l.skip_reason).tone === 'stop' ? 'stop' : 'cold'}`}>{skipMeta(l.skip_reason).label}</span>
                      : <span className="badge ok">Textable</span>}
                  </label>
                );
              })
            )}
          </div>

          <p className="fine">
            {picked.length} picked of a {LEADS_CAP} maximum.
            {picked.length >= LEADS_CAP && ' That is the cap the database enforces; it is far past any legitimate use of this audience.'}
          </p>

          {picked.length > 0 && (
            <div className="pickedchips">
              {picked.map((l) => (
                <button key={l.id} type="button" className="chip" onClick={() => drop(l.id)}>
                  {leadName(l)} ✕
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The tokens, each showing the value it will resolve to.
 *
 * A token whose value is empty on this deal is offered greyed rather than
 * hidden. broadcast-send refuses the whole send with `unresolved_placeholder`
 * if the body uses one, and "why can I not find the sqft chip" is a worse
 * question than "sqft is blank on this deal, go and fill it in".
 */
function TokenPalette({ deal, onInsert }) {
  const values = tokenValues(deal);

  return (
    <div className="dealfacts">
      <span className="fine">
        Tap to insert. The sender fills these in per message — the stored body keeps the tokens,
        which is what makes the record show what was authored rather than one rendered copy of it.
      </span>

      <div className="dispo-btns">
        {CONTACT_TOKENS.map((t) => (
          <button key={t} type="button" className="chip good" onClick={() => onInsert(`{{${t}}}`)}>
            {`{{${t}}}`}
          </button>
        ))}
        {deal && DEAL_TOKENS.map((t) => (
          <button
            key={t}
            type="button"
            className="chip"
            disabled={!values[t]}
            title={values[t] || `Blank on this deal — using it would stop the send`}
            onClick={() => onInsert(`{{${t}}}`)}
          >
            {`{{${t}}}`}
            {values[t] && <span className="tokenval">{values[t]}</span>}
          </button>
        ))}
      </div>

      {/* The number a wholesaler most has to keep straight is which of the two
          spreads he is quoting. buyer_spread already has Tossie's assignment
          fee taken out of it; the bigger, friendlier figure (ARV − repairs −
          contract price) includes money going to us, and a buyer who is quoted
          that notices exactly once. There is no token for it, here or in the
          sender. */}
      {deal && (
        <p className="fine">
          <code>{'{{spread}}'}</code> is what is actually left for the buyer — the assignment fee is
          already out of it. There is deliberately no token for our own margin.
        </p>
      )}
    </div>
  );
}

/**
 * The composer's half of broadcast-send's pre-flight.
 *
 * The function refuses the whole send on an unknown or empty token before it
 * claims a recipient, which is the right place for the decision — but the right
 * place to find out is while the sentence is still being written, not behind a
 * confirm dialog. This never permits anything the server would refuse; it only
 * says the same thing earlier.
 */
function tokenProblems(body, kind, deal) {
  const used = tokensIn(body);
  const values = tokenValues(deal);

  return {
    unknown: used.filter((t) => !ALL_TOKENS.includes(t)),
    // Deal tokens on a campaign with no deal have nothing to fill them from at
    // all — that is `unresolved_placeholder` with the "no deal attached" arm.
    empty: used.filter((t) => DEAL_TOKENS.includes(t) && (kind !== 'deal_match' || !values[t])),
  };
}

/* ── the ledger ───────────────────────────────────────────────────────────── */

/**
 * Counts, then the suppressed rows grouped by reason and openable.
 *
 * Used by both the pre-build preview and the built campaign, because they are
 * the same object at two moments and showing them differently would invite the
 * belief that one of them is the real one.
 *
 * `stats` is off on a built campaign, where the card already carries the live
 * counts. Two stat blocks a centimetre apart is bad enough; the second one said
 * "Will receive it: 40" in the future tense next to "Failed: 4" in the past,
 * computed as total − skipped, which counts the failures as future deliveries.
 * On a page whose whole argument is that the denominator must be honest, that
 * was the one number on it that was not.
 */
function Ledger({ total, sending, rows, segs, stats = true }) {
  const [openReason, setOpenReason] = useState(null);

  const groups = useMemo(() => {
    const by = new Map();
    for (const r of rows) {
      if (!r.skip_reason) continue;
      if (!by.has(r.skip_reason)) by.set(r.skip_reason, []);
      by.get(r.skip_reason).push(r);
    }
    return [...by.entries()].sort((a, b) => skipRank(a[0]) - skipRank(b[0]));
  }, [rows]);

  const skipped = total - sending;

  return (
    <>
      {stats && (
        <div className="ledgerstats">
          <div className="lstat">
            <span className="k">On the list</span>
            <span className="v">{total}</span>
          </div>
          <div className="lstat good">
            <span className="k">Will receive it</span>
            <span className="v">{sending}</span>
          </div>
          <div className={`lstat${skipped > 0 ? ' bad' : ''}`}>
            <span className="k">Suppressed</span>
            <span className="v">{skipped}</span>
          </div>
          {segs > 0 && (
            <div className="lstat">
              <span className="k">Billable messages</span>
              <span className="v">{segs * sending}</span>
            </div>
          )}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="fine">
          Nobody was suppressed. Every contact on this list has a number, consent on file, and no STOP against them.
        </p>
      ) : (
        <ul className="skipgroups">
          {groups.map(([reason, list]) => {
            const meta = skipMeta(reason);
            const open = openReason === reason;
            return (
              <li key={reason} className={`skipgroup ${meta.tone}`}>
                <button
                  type="button"
                  className="skiphead"
                  onClick={() => setOpenReason(open ? null : reason)}
                >
                  <span className="n">{list.length}</span>
                  <span className="lbl">{meta.label}</span>
                  <span className="fine">{open ? 'Hide' : 'Show who'}</span>
                </button>
                <p className="fine why">{meta.why}</p>
                {open && (
                  <ul className="skipwho">
                    {list.map((r) => (
                      <li key={r.id}>
                        <span>{r.who || 'Unnamed'}</span>
                        <span className="sub">{formatPhone(r.phone) || 'no number'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ── one campaign ─────────────────────────────────────────────────────────── */

function CampaignDetail({ campaign: c, onBack, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const reloadTimer = useRef(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('broadcast_recipients')
      .select('*, buyers(id, name, entity_name), leads(id, name, address)')
      .eq('campaign_id', c.id)
      .order('created_at')
      .limit(5000);

    if (error) setErr(error.message);
    else setRows(data ?? []);
    setLoading(false);
  }, [c.id]);

  useEffect(() => {
    load();
    const reload = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 400);
    };

    // Per-recipient status is the thing the operator stays on this screen to
    // watch. The worker writes it on the service role, so this subscription is
    // the only thing that turns those writes into movement on screen.
    const channel = supabase
      .channel(`broadcast-recipients-${c.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'broadcast_recipients',
        filter: `campaign_id=eq.${c.id}`,
      }, reload)
      .subscribe();

    return () => {
      clearTimeout(reloadTimer.current);
      supabase.removeChannel(channel);
    };
  }, [c.id, load]);

  const ledgerRows = useMemo(() => rows.map((r) => ({
    id: r.id,
    who: buyerName(r.buyers) || leadName(r.leads) || 'Removed contact',
    phone: r.phone_e164,
    skip_reason: r.skip_reason,
  })), [rows]);

  const segs = segments(c.body);
  const pending = c.pending_count;

  /**
   * One call to broadcast-send, which is the only path to Twilio: it claims a
   * bounded batch of recipients and hands each rendered body to
   * twilio-send-sms, where every rail lives.
   *
   * This page deliberately does NOT flip the campaign to 'sending' itself. The
   * function owns that transition, guarded by `confirm` and by its own
   * `.eq('status','draft')`, and that transition is what fires
   * broadcast_campaigns_log_start and writes dispo_blast_started onto the deal.
   * Doing it here first would walk straight past the confirm rail and give two
   * racing tabs two start events for one blast.
   *
   * `confirm` is passed only from a draft, which is the only state that needs
   * it — the function answers a draft without it by returning the ledger and
   * sending nothing, which is its preview and is not what this button means.
   */
  async function drain({ confirm = false } = {}) {
    const { data, error } = await supabase.functions.invoke('broadcast-send', {
      body: { campaign_id: c.id, ...(confirm ? { confirm: true } : {}) },
    });

    if (error) {
      const r = await explainRefusal(error);
      setErr(r.text);
      return null;
    }
    return data ?? null;
  }

  /**
   * One batch per invocation, by design on the sender's side: a run that tried
   * to finish a 400-buyer campaign in one call gets killed by the platform
   * partway through. So the button drains repeatedly until the sender stops
   * saying `more_pending`.
   *
   * The ceiling is a stop, not a schedule. Deferred rows count as pending — a
   * buyer whose calling window is shut comes back with a future retry time —
   * so an uncapped loop against an evening blast would spin until the tab was
   * closed. When it stops early it says so, and Continue picks it back up.
   */
  async function run({ confirm }) {
    setBusy(true);
    setErr(null);
    setNote(null);

    /**
     * Every outcome the sender reports, not just `sent`.
     *
     * Reporting the sent count alone is the failure mode this page was built
     * against, one screen further in: a run that hands two of forty to Twilio
     * because thirty-eight buyers texted STOP between preview and send is not
     * "2 handed to Twilio" — the other thirty-eight are the number somebody has
     * to see. And "0 handed to Twilio. Delivery receipts land on the rows below"
     * is a sentence promising receipts for messages that do not exist.
     */
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let rounds = 0;
    let more = false;

    for (; rounds < 12; rounds += 1) {
      const res = await drain({ confirm: confirm && rounds === 0 });
      if (!res) { setBusy(false); onChanged(); return; }
      sent += res.sent ?? 0;
      skipped += res.skipped ?? 0;
      failed += res.failed ?? 0;
      more = Boolean(res.more_pending);
      onChanged();
      if (!more) break;
    }

    // Each clause only appears when it happened, so the sentence stays short on
    // the ordinary run and grows exactly when there is something to read.
    const also = [
      skipped > 0 && `${skipped} were dropped at send time and are listed below with the reason`,
      failed > 0 && `${failed} failed`,
    ].filter(Boolean).join(', ');

    setNote([
      sent === 0
        ? 'Nothing was handed to Twilio on this run.'
        : `${sent} handed to Twilio. Delivery receipts land on the rows below over the next few minutes.`,
      also && `${also.charAt(0).toUpperCase()}${also.slice(1)}.`,
      more
        ? 'More are still waiting — the sender works one batch at a time. Press Continue to keep going, or leave it for a scheduled run.'
        : null,
    ].filter(Boolean).join(' '));

    setConfirming(false);
    setBusy(false);
    onChanged();
  }

  async function pause() {
    setBusy(true);
    setErr(null);
    setNote(null);
    const { error } = await supabase.from('broadcast_campaigns')
      .update({ status: 'paused' }).eq('id', c.id);
    if (error) setErr(error.message);
    setBusy(false);
    onChanged();
  }

  /**
   * Un-pausing is two deliberate steps in one press: the status has to move
   * back before the sender will touch it — it refuses a paused campaign with
   * `campaign_paused` on purpose — and then somebody has to ask it to work.
   * Setting the status alone would leave the campaign sitting at 'sending' with
   * nothing moving, which reads as a broken send rather than a button that did
   * half its job.
   */
  async function resume() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('broadcast_campaigns')
      .update({ status: 'sending' }).eq('id', c.id);
    if (error) { setErr(error.message); setBusy(false); onChanged(); return; }
    await run({ confirm: false });
  }

  /** Only an unmaterialised draft can go; the trigger refuses anything else. */
  async function discard() {
    setBusy(true);
    const { error } = await supabase.from('broadcast_campaigns').delete().eq('id', c.id);
    if (error) setErr(`This campaign cannot be deleted: ${error.message}`);
    else { onBack(); onChanged(); }
    setBusy(false);
  }

  return (
    <>
      <div className="card">
        <h2 className="detailhead">
          <span>{c.name}</span>
          <button type="button" className="linkbtn" onClick={onBack}>All campaigns</button>
        </h2>

        <div className="body">
          <div className="campaignmeta">
            <StatusBadge status={c.status} />
            <span className="fine">
              {AUDIENCES.find((a) => a.kind === c.audience_kind)?.title || titleize(c.audience_kind)}
              {c.deals && ` · ${c.deals.address}`}
              {' · created '}{fullDate(c.created_at)}
              {c.started_at && ` · started ${fullDate(c.started_at)}`}
              {c.completed_at && ` · finished ${fullDate(c.completed_at)}`}
            </span>
          </div>

          <blockquote className="sentbody">{c.body}</blockquote>
          <p className="fine">
            {/* The template, not one rendered copy of it. This is the audit
                record: what was authored is the thing with the tokens still in
                it, and it is frozen — the freeze trigger refuses an edit to the
                body now that the audience exists. */}
            {segs} segment{segs === 1 ? '' : 's'}
            {tokensIn(c.body).length > 0
              ? ' before the tokens are filled in, so the billed count is a little higher. '
              : ' each. '}
            This is what was authored, frozen with the audience and no longer editable.
          </p>

          {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}
          {note && <div className="banner" style={{ marginTop: 12 }}>{note}</div>}

          {!c.materialised_at ? (
            <div className="notice" style={{ marginTop: 12 }}>
              <strong>This draft has no audience yet.</strong>
              Its recipients were never frozen, so there is nothing to send and nothing to inspect.
              Delete it and build it again.
              <div className="confirmbtns" style={{ marginTop: 11 }}>
                <button className="btn ghost" type="button" disabled={busy} onClick={discard}>Delete draft</button>
              </div>
            </div>
          ) : c.status === 'draft' ? (
            confirming ? (
              <div className="confirm">
                <strong>Send to {pending} recipient{pending === 1 ? '' : 's'}?</strong>
                <p>
                  {pending} of {c.total_recipients} on this list will receive it; {c.skipped_count} are
                  suppressed and stay suppressed. That is {segs * pending} billable message
                  {segs * pending === 1 ? '' : 's'}. Messages cannot be recalled once the worker has them,
                  and every one of them goes through twilio-send-sms, which re-checks every rail per message.
                </p>
                <div className="confirmbtns">
                  <button className="btn" type="button" disabled={busy} onClick={() => run({ confirm: true })}>
                    {busy ? 'Sending…' : `Yes, send to ${pending}`}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="confirmbtns" style={{ marginTop: 14 }}>
                <button
                  className="btn"
                  type="button"
                  disabled={pending === 0}
                  onClick={() => setConfirming(true)}
                >
                  {pending === 0 ? 'Nobody on this list can be texted' : `Send to ${pending}`}
                </button>
              </div>
            )
          ) : c.status === 'sending' ? (
            <div className="confirmbtns" style={{ marginTop: 14 }}>
              {/* Continue, not Send: the sender works one bounded batch per
                  call, so a large or partly-deferred campaign genuinely has
                  more to do and the operator needs a way to say "keep going"
                  that is not a second blast. */}
              <button className="btn" type="button" disabled={busy || pending === 0} onClick={() => run({ confirm: false })}>
                {busy ? 'Sending…' : 'Continue sending'}
              </button>
              <button className="btn ghost" type="button" disabled={busy} onClick={pause}>
                Pause
              </button>
              <span className="fine" style={{ alignSelf: 'center' }}>
                {pending === 0
                  ? 'Nothing left waiting. Delivery receipts are still landing.'
                  : `${pending} still waiting — some may be held until their calling window opens.`}
                {' '}Pausing stops the sender claiming more; anything already at Twilio is gone.
              </span>
            </div>
          ) : c.status === 'paused' ? (
            <div className="confirmbtns" style={{ marginTop: 14 }}>
              <button className="btn" type="button" disabled={busy} onClick={resume}>
                {busy ? 'Resuming…' : 'Resume'}
              </button>
              <span className="fine" style={{ alignSelf: 'center' }}>
                Paused with {pending} unsent. Something stopped this — check the failed rows below before resuming.
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h2>Audience — {c.sent_count} of {c.total_recipients} reached</h2>
        <p className="cardnote">
          Every contact considered for this send is here, suppressed ones included. The suppressed rows
          are the record that the audience was segmented rather than blasted, which is what a carrier
          reviewing this campaign asks for.
        </p>
        <div className="body">
          <div className="ledgerstats">
            <div className="lstat"><span className="k">On the list</span><span className="v">{c.total_recipients}</span></div>
            <div className="lstat"><span className="k">Waiting</span><span className="v">{c.pending_count}</span></div>
            <div className="lstat good"><span className="k">Sent</span><span className="v">{c.sent_count}</span></div>
            <div className="lstat good"><span className="k">Delivered</span><span className="v">{c.delivered_count}</span></div>
            <div className={`lstat${c.failed_count > 0 ? ' bad' : ''}`}><span className="k">Failed</span><span className="v">{c.failed_count}</span></div>
            <div className={`lstat${c.skipped_count > 0 ? ' bad' : ''}`}><span className="k">Suppressed</span><span className="v">{c.skipped_count}</span></div>
            {c.actual_cost_cents > 0 && (
              <div className="lstat"><span className="k">Cost</span><span className="v">${(c.actual_cost_cents / 100).toFixed(2)}</span></div>
            )}
          </div>

          {loading ? <p className="fine">Loading the ledger…</p> : (
            <>
              <Ledger total={c.total_recipients} sending={c.total_recipients - c.skipped_count} rows={ledgerRows} segs={0} stats={false} />
              <RecipientTable rows={rows} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Every row, by name, with what happened to it.
 *
 * Sorted so the rows that need a person come first: failures, then still
 * waiting, then suppressed, then the ones that worked. A table sorted by
 * insertion order buries the four failures in the middle of a hundred and
 * eighty successes, and those four are the only rows anybody is looking for.
 */
const STATUS_RANK = { failed: 0, pending: 1, queued: 2, skipped: 3, sent: 4, delivered: 5 };

function RecipientTable({ rows }) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)),
    [rows],
  );

  if (rows.length === 0) return <p className="fine">No recipients on this campaign.</p>;

  return (
    <div className="rcptwrap">
      <table className="leads rcpt">
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Number</th>
            <th>Status</th>
            <th>Why / when</th>
            <th className="hide-sm">Match</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const meta = r.skip_reason ? skipMeta(r.skip_reason) : null;
            return (
              <tr key={r.id}>
                <td>
                  <span className="addr">
                    {buyerName(r.buyers) || leadName(r.leads) || 'Removed contact'}
                  </span>
                  {/* The FK is ON DELETE SET NULL so the ledger outlives the
                      contact. A row whose subject is gone is still evidence a
                      number was or was not texted. */}
                  {!r.buyers && !r.leads && <span className="sub">deleted since this campaign</span>}
                </td>
                <td className="sub">{formatPhone(r.phone_e164) || '—'}</td>
                <td>
                  <span className={`badge ${
                    r.status === 'delivered' || r.status === 'sent' ? 'ok'
                      : r.status === 'failed' ? 'stop'
                      : r.status === 'skipped' ? 'cold'
                      : ''}`}
                  >
                    {titleize(r.status)}
                  </span>
                </td>
                <td className="sub">
                  {meta && <div>{meta.label}</div>}
                  {r.error && <div className="rcpterr">{r.error}</div>}
                  {r.delivered_at ? timeAgo(r.delivered_at)
                    : r.sent_at ? timeAgo(r.sent_at)
                    : r.next_retry_at ? `retry ${timeAgo(r.next_retry_at)}`
                    : ''}
                  {r.attempts > 1 && ` · ${r.attempts} attempts`}
                </td>
                <td className="hide-sm sub">
                  {r.match_score !== null && r.match_score !== undefined && (
                    <div><strong>{r.match_score}</strong></div>
                  )}
                  {/* Frozen at build time, not recomputed. It is the evidence
                      of why this buyer was in this audience on this day. */}
                  {(r.match_reasons ?? []).join(', ')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
