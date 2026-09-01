/** Shared display helpers. */

export const STATUSES = [
  'new', 'attempting', 'contacted', 'qualified', 'appointment_set',
  'offer_made', 'under_contract', 'closed', 'nurture', 'dead',
];

export const TEMPERATURES = ['hot', 'warm', 'cold', 'dead'];

/**
 * Call outcomes. Order is the order they appear on the lead, which is roughly
 * how often they get tapped — no-answer and voicemail are most of a cold day.
 *
 * `tone` only drives colour. The status each one implies and the follow-up it
 * schedules live in log_disposition() in the database, deliberately: they are
 * the same whether the tap came from here, the dialer, or the SDR later.
 */
export const DISPOSITIONS = [
  { key: 'no_answer',          label: 'No answer',        tone: 'neutral' },
  { key: 'left_voicemail',     label: 'Left voicemail',   tone: 'neutral' },
  { key: 'callback_requested', label: 'Callback',         tone: 'neutral' },
  { key: 'spoke_interested',   label: 'Interested',       tone: 'good' },
  { key: 'appointment_set',    label: 'Appointment set',  tone: 'good' },
  { key: 'offer_made',         label: 'Offer made',       tone: 'good' },
  { key: 'under_contract',     label: 'Under contract',   tone: 'good' },
  { key: 'nurture',            label: 'Not yet',          tone: 'neutral' },
  { key: 'not_interested',     label: 'Not interested',   tone: 'bad' },
  { key: 'wrong_number',       label: 'Wrong number',     tone: 'bad' },
  { key: 'do_not_call',        label: 'Do not call',      tone: 'bad' },
];

export const OCCUPANCY = ['owner', 'tenant', 'vacant', 'unknown'];

/** 'appointment_set' -> 'Appointment set' */
export const titleize = (s) =>
  !s ? '' : s.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Where a lead came from, in the words somebody would use for it.
 *
 * `source` is a category and only a handful of values wide — 'vendor',
 * 'cold_list', 'website'. `source_detail` is the specific one: which vendor,
 * which bought list. Rendering only the category is why every lead arriving
 * over a webhook read as "Vendor" on the list, whether it came from
 * PropertyLeads or Speed to Lead, and that is precisely the distinction
 * somebody is scanning the column for.
 *
 * The detail wins when there is one. It is stored as the source's slug, so the
 * hyphens are unpicked the same way titleize unpicks underscores — and the
 * small words are lowered afterwards, because "Speed To Lead" is not what
 * anybody calls it.
 *
 * Nothing is invented: a lead with no detail still shows its category, which
 * is all that was ever known about it.
 */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

export function sourceLabel(lead) {
  const detail = String(lead?.source_detail ?? '').trim();
  if (!detail) return titleize(lead?.source);

  // Only a slug gets unpicked. Anything carrying a space or a capital was typed
  // by a person — a bought list called "Georgia(0-500)", a vendor who spells
  // itself PropertyLeads.com — and turning its hyphens into spaces would be the
  // app rewriting somebody's own label.
  if (/[A-Z\s]/.test(detail)) return detail;

  return detail
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      // A word that already carries capitals is a name somebody typed —
      // "PropertyLeads.com" — and re-casing it would be the app deciding it
      // knows better than the person who entered it.
      if (/[A-Z]/.test(w)) return w;
      if (i > 0 && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/** '9125550134' -> '(912) 555-0134'; anything else passes through. */
export function formatPhone(v) {
  if (!v) return '';
  const d = v.replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length !== 10) return v;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

export function fullAddress(lead) {
  const tail = [lead.city, lead.state].filter(Boolean).join(', ');
  return [lead.address, tail, lead.zip].filter(Boolean).join(' · ');
}

/** "3h ago" / "5d ago" — an operator cares about age, not calendar dates. */
export function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const fullDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

/* ── deals ─────────────────────────────────────────────────────────────────
   Shared by the deals board and the deal detail. Both pages count down to the
   same two dates and both label the same eleven statuses; a second copy of
   either would be a copy that drifts, and the direction it drifts in is a
   board that says four days when the reminder ladder says three.            */

/**
 * The deal lifecycle vocabulary, in the order it is worked.
 *
 * This is the CHECK constraint's list, not the transition map. Which moves are
 * legal from where lives in deal_status_can_transition() and is enforced by a
 * trigger, so the detail page asks the database rather than reading a matrix
 * from here — a lifecycle with two implementations has one that is wrong.
 */
export const DEAL_STATUSES = [
  'draft', 'under_contract', 'dispo', 'buyer_selected', 'assigned',
  'extension_pending', 'buyer_fell_through', 'seller_terminated',
  'terminated_inspection', 'closed', 'dead',
];

/**
 * Spelled out rather than run through titleize(), because these are column
 * headings an operator reads a hundred times a day: 'Terminated inspection'
 * is not what happened, 'Terminated in inspection' is.
 */
export const DEAL_STATUS_LABEL = {
  draft: 'Draft',
  under_contract: 'Under contract',
  dispo: 'Dispo',
  buyer_selected: 'Buyer selected',
  assigned: 'Assigned',
  extension_pending: 'Extension pending',
  buyer_fell_through: 'Buyer fell through',
  seller_terminated: 'Seller terminated',
  terminated_inspection: 'Terminated in inspection',
  closed: 'Closed',
  dead: 'Dead',
};

export const dealStatusLabel = (s) => DEAL_STATUS_LABEL[s] || titleize(s);

/**
 * A `date` column as local midnight.
 *
 * new Date('2026-09-01') is parsed as UTC midnight, which renders as August 31
 * everywhere in the United States. On a screen whose entire job is to say
 * "3 days left", that off-by-one is not cosmetic — it is the bug.
 */
export function parseDateOnly(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** A date column, short and unambiguous. '2026-09-01' -> 'Sep 1, 2026'. */
export const dateOnly = (v) => {
  const d = parseDateOnly(v);
  return d ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
};

/**
 * Whole calendar days from today to a date column. 0 is today, negative is past.
 *
 * Both ends are floored to local midnight so "tomorrow" reads as 1 all day
 * rather than decaying to 0 by the afternoon. Math.round rather than floor
 * because the gap between two local midnights is 23 or 25 hours across a DST
 * boundary, and twice a year a floor would quietly lose a day.
 */
export function daysUntil(v) {
  const then = parseDateOnly(v);
  if (then === null) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((then.getTime() - today.getTime()) / 86400000);
}

/**
 * How loud a countdown should be.
 *
 * Closing warns at seven days because that is the first rung of the
 * deal_milestones reminder ladder ({168,72,24} hours) — the board turning
 * amber and the reminder firing should be the same moment, or the operator
 * learns to believe neither.
 *
 * Inspection is tighter on purpose. The remedy for a closing date that is
 * coming up short is an extension the seller can sign next week; the remedy
 * for an inspection period about to expire is walking away today, and after it
 * expires there is no remedy at all.
 */
export const DEAL_CLOCKS = {
  closing: { warn: 7, alarm: 3 },
  inspection: { warn: 5, alarm: 2 },
};

export function clockTone(days, kind = 'closing') {
  if (days == null) return 'none';
  const t = DEAL_CLOCKS[kind] || DEAL_CLOCKS.closing;
  if (days < 0) return 'past';
  if (days <= t.alarm) return 'alarm';
  if (days <= t.warn) return 'warn';
  return 'ok';
}

/** A countdown in the words someone would say out loud. */
export function countdownLabel(days) {
  if (days == null) return '—';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return '1 day ago';
  return days > 0 ? `${days} days` : `${-days} days ago`;
}
