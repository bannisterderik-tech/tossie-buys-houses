/** Shared display helpers. */

export const STATUSES = [
  'new', 'attempting', 'contacted', 'qualified', 'appointment_set',
  'offer_made', 'under_contract', 'closed', 'nurture', 'dead',
];

export const TEMPERATURES = ['hot', 'warm', 'cold', 'dead'];

/** 'appointment_set' -> 'Appointment set' */
export const titleize = (s) =>
  !s ? '' : s.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());

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
