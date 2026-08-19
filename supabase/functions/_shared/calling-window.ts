// ============================================================================
// May we contact this person right now?
// ============================================================================
// TCPA's federal floor forbids telemarketing calls and texts outside
// 8:00am-9:00pm in the CALLED PARTY's local time. Damages are $500-$1,500 per
// call or text, so this is enforced at send time by every outbound path — not
// in the UI, where a cron job or a webhook would never see it.
//
// Deliberately answers rather than throws when the timezone can't be resolved:
// a send path that crashes on a malformed number is a worse outcome than one
// that assumes Eastern and says so in the reason.
// ============================================================================

import { areaCodeFromPhone, resolveTimezone, localHourInTz } from './phone-timezone.ts';

export interface WindowResult {
  allowed: boolean;
  /** Null when Intl could not resolve the zone at all — see localHourInTz. */
  localHour: number | null;
  tz: string;
  /**
   * Machine-readable: ok | before_open | after_close | unknown_timezone, plus
   * an `_unresolved_tz` suffix when the zone came from the default rather than
   * from anything the lead told us.
   */
  reason: string;
  /** When the window next opens, so a blocked send can be rescheduled. */
  nextOpen: Date;
}

const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 21;

export function isWithinContactWindow(
  target: { phone?: string | null; state?: string | null },
  now: Date,
  opts?: { startHour?: number; endHour?: number },
): WindowResult {
  const startHour = opts?.startHour ?? DEFAULT_START_HOUR;
  const endHour = opts?.endHour ?? DEFAULT_END_HOUR;

  const areaCode = areaCodeFromPhone(target?.phone);
  const { tz, resolved } = resolveTimezone({ areaCode, state: target?.state });
  const localHour = localHourInTz(tz, now);
  // Null means we do not know what time it is where this phone is. Refuse.
  // Retrying is safe and cheap; sending at 4am is neither.
  const allowed = localHour !== null && localHour >= startHour && localHour < endHour;

  let reason = localHour === null
    ? 'unknown_timezone'
    : allowed ? 'ok' : (localHour < startHour ? 'before_open' : 'after_close');
  if (!resolved) reason = `${reason}_unresolved_tz`;

  return {
    allowed,
    localHour,
    tz,
    reason,
    // With no hour there is no arithmetic to do, so hand back the start of the
    // next hour: the caller reschedules, asks again, and by then Intl has
    // either recovered or the send stays blocked. It never becomes a send.
    nextOpen: localHour === null
      ? new Date(now.getTime() + 3_600_000)
      : nextOpenAt(localHour, startHour, endHour, now),
  };
}

// Hours until the window reopens, computed from the difference between the
// called party's local hour and ours rather than from a zone offset — that way
// a DST boundary can only ever move the answer by an hour in the safe
// direction, and no offset arithmetic has to be right.
function nextOpenAt(localHour: number, startHour: number, endHour: number, now: Date): Date {
  if (localHour >= startHour && localHour < endHour) return now;
  const hoursUntil = localHour < startHour
    ? startHour - localHour
    : 24 - localHour + startHour;
  const next = new Date(now.getTime() + hoursUntil * 3_600_000);
  // Land a few minutes inside the window rather than exactly on the boundary,
  // so a worker that fires slightly early doesn't get blocked again.
  next.setUTCMinutes(next.getUTCMinutes() + 5);
  return next;
}
