/**
 * Shared vocabulary for the buyers list.
 *
 * Exists for the same reason lib/sms-refusals.js does: the sentence that says
 * why somebody cannot be texted is read on two screens — the list and the buyer
 * page — and has to say the same thing on both. Two copies is how one screen
 * ends up calling a blacklisted buyer blastable while the other does not, and
 * the one that is wrong is always the one somebody acts on.
 *
 * Nothing here decides anything. buyer_skip_reason() in the database is the
 * decision; these functions put its answer into words.
 */
import { parseDateOnly } from './format.js';

/**
 * paused is temporary — out of money, out of appetite, back next quarter.
 * blacklisted is permanent. Both are held out of every match and every blast,
 * and keeping them apart is what lets you un-pause the first group without
 * resurrecting the second.
 */
export const BUYER_STATUSES = ['active', 'paused', 'blacklisted'];

/**
 * An ordered scale, not a set. match_buyers_for_deal() reads it as one — a
 * buyer who tolerates `heavy` also gets shown `light` — so the order of this
 * array is load-bearing for anyone who renders it as a slider or a range.
 */
export const REHAB_TOLERANCE = ['light', 'medium', 'heavy', 'full_gut'];

export const FUNDING = ['cash', 'hard_money', 'financed'];

/**
 * How a cash buyer actually agrees to be texted, in the operator's words.
 *
 * Presets rather than a free-text box for the same reason the seller-side list
 * is: "how was this obtained" is the question a plaintiff's attorney asks
 * first, and record_buyer_consent() refuses a blank answer. Free text is still
 * available underneath, at the cost of one extra choice, which is the right way
 * round.
 */
export const BUYER_CONSENT_SOURCES = [
  'Asked to be added to the buyers list',
  'Signed buyer agreement',
  'Met in person — REIA, auction, meetup',
  'Replied to one of our texts',
  'Called or emailed us asking for deals',
];

/** buyer_skip_reason() values, in words an operator can act on. */
const SKIP_WORDS = {
  buyer_inactive: 'Not active',
  no_phone: 'No phone number',
  opted_out: 'Texted STOP',
  no_consent: 'No SMS consent',
};

/**
 * What each block actually takes to fix, which is different in kind for each
 * one — and for the STOP, deliberately not fixable here at all. See the note on
 * the compliance card in BuyerDetail.
 */
const SKIP_FIX = {
  buyer_inactive:
    'Set the status back to active at the top of this page. Paused and blacklisted buyers are '
    + 'held out of every buy-box match and every dispo blast.',
  no_phone: 'Add a mobile number on the contact card.',
  opted_out:
    'One of their numbers is in telephony_opt_outs — they texted STOP, or somebody recorded a '
    + 'stop on their behalf. Nothing on this page lifts that, on purpose. If they want deals '
    + 'again, call them and clear the opt-out from the number itself.',
  no_consent:
    'Record how they agreed to be texted, below. Buyers are businesses, but the TCPA has no B2B '
    + 'carve-out and these are cell numbers.',
};

/**
 * Why this buyer would not be texted, or null if they would be.
 *
 * `skip_reason` is public.buyer_skip_reason read off the row as a computed
 * column — never re-derived here. LeadDetail learnt that lesson the expensive
 * way: its hand-rolled copy of the dialability rule had no idea
 * telephony_opt_outs existed and cheerfully showed a live Call button next to a
 * seller who had texted STOP. Any rule with two implementations has one that is
 * stale, and here it would be the one on screen.
 *
 * If the column did not arrive at all, this reports "cannot tell" rather than
 * "fine". Failing towards not-textable is the only safe direction: a false
 * "blastable" is a message somebody did not consent to.
 */
export function textingBlock(buyer) {
  if (!buyer || !('skip_reason' in buyer)) {
    return {
      reason: 'unknown',
      words: 'Cannot tell',
      fix: 'buyer_skip_reason did not load with this row, so nothing here can vouch for whether '
        + 'they may be texted. Reload the page.',
    };
  }
  if (buyer.skip_reason == null) return null;

  const reason = buyer.skip_reason;
  return {
    reason,
    // 'Not active' is true but useless when the operator is looking at one
    // buyer: paused and blacklisted are different decisions with different
    // futures, and the row already knows which.
    words: reason === 'buyer_inactive' ? titleCase(buyer.status) : (SKIP_WORDS[reason] || reason),
    fix: SKIP_FIX[reason] || null,
  };
}

const titleCase = (s) => (!s ? '' : s.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase()));

/** $184,500 — full precision, for a page where the number is the point. */
export const money = (v) =>
  v == null || v === '' ? '' : `$${Number(v).toLocaleString()}`;

/** $185k — for a table cell, where four digits of precision is four too many. */
export function compactMoney(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}m`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n.toLocaleString()}`;
}

/**
 * An unset bound is "no limit", not zero — the buy-box columns are nullable and
 * an empty one means the buyer never said. Rendering a missing price_max as
 * "$0" would read as a buyer who buys nothing.
 */
export function priceRange(buyer) {
  const lo = buyer.price_min, hi = buyer.price_max;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return `${compactMoney(lo)}–${compactMoney(hi)}`;
  return lo != null ? `${compactMoney(lo)}+` : `up to ${compactMoney(hi)}`;
}

/**
 * Where they buy, or null for "no geographic restriction".
 *
 * The null case is the one that matters. An empty counties/zips array means the
 * buyer named no restriction and matches everywhere — it does not mean they
 * match nothing — and a UI that renders it as a blank cell teaches the operator
 * the opposite of the truth. Callers turn a null into the word "anywhere".
 */
export function geography(buyer, limit = 3) {
  const parts = [...(buyer.counties || []), ...(buyer.zips || [])];
  if (parts.length === 0) return null;
  const head = parts.slice(0, limit).join(', ');
  return parts.length > limit ? `${head} +${parts.length - limit}` : head;
}

/** The buy box on one line, for the list. Empty facts are dropped, not padded. */
export function buyBoxLine(buyer) {
  return [
    priceRange(buyer),
    buyer.rehab_tolerance ? `${buyer.rehab_tolerance.replace('_', ' ')} rehab` : null,
    buyer.funding ? buyer.funding.replace('_', ' ') : null,
    buyer.beds_min != null ? `${buyer.beds_min}+ bd` : null,
    buyer.takes_occupied ? 'takes occupied' : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Proof of funds, aged.
 *
 * The file matters less than the date. A bank letter from last year proves the
 * buyer had money last year, and the buyer who ties up a contract for nine days
 * and then cannot close is nearly always the one whose POF nobody looked at the
 * date on. Six months is the line most title companies and sellers' agents draw,
 * so it is the line drawn here.
 */
export function pofStatus(buyer) {
  if (!buyer.proof_of_funds_date && !buyer.proof_of_funds_url) {
    return { tone: 'stop', words: 'No proof of funds on file' };
  }
  if (!buyer.proof_of_funds_date) {
    return { tone: 'warn', words: 'A file is on file but no date — undated POF proves nothing' };
  }
  // parseDateOnly, because new Date('2026-09-01') is UTC midnight and reads as
  // the previous day everywhere in the US. It costs nothing here and it means
  // this file never becomes the second place that gets date arithmetic wrong.
  const dated = parseDateOnly(buyer.proof_of_funds_date);
  if (!dated) return { tone: 'warn', words: 'The proof-of-funds date could not be read' };
  const days = Math.floor((Date.now() - dated.getTime()) / 86400000);
  const months = Math.round(days / 30);
  // A date in the future is a typo — a letter dated next year, or 2027 for
  // 2026 — and it has to be caught before the age tests, because a negative age
  // sails through every "older than" comparison below and comes out the far end
  // as "verified this month". The one thing this function exists to prevent is
  // an unverified buyer reading as verified.
  if (days < 0) {
    return { tone: 'warn', words: `The proof-of-funds date is in the future (${buyer.proof_of_funds_date}) — check it` };
  }
  if (days > 365) return { tone: 'stop', words: `POF is ${months} months old — ask for a fresh one` };
  if (days > 180) return { tone: 'warn', words: `POF is ${months} months old` };
  return { tone: 'ok', words: `POF verified ${days <= 31 ? 'this month' : `${months} months ago`}` };
}
