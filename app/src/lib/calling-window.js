/**
 * Is it 8am–9pm where the phone is ringing?
 *
 * TCPA's federal floor forbids telemarketing calls outside 8:00am–9:00pm in the
 * CALLED PARTY's local time, and a wholesaler dialing a purchased list is
 * squarely telemarketing. The called party's zone comes from their area code,
 * because that is the only piece of location the phone number itself carries.
 *
 * READ THIS BEFORE TRUSTING IT. `_shared/calling-window.ts` is the enforcing
 * copy, but today it is imported by exactly one caller — `twilio-send-sms`. No
 * voice edge function exists yet, and Call on the dialer is a `tel:` link the
 * browser hands to the operating system. So for CALLS this file is not the
 * advisory half of a pair, it is the only rail there is, and it greys out a
 * button an operator can still work around by dialing from their phone.
 *
 * That is a known gap, not a design: it closes when the voice function lands
 * and the window is checked again at dial time, where a cron job, a webhook or
 * a redialed number can also see it. Until then, treat every entry in the table
 * below as load-bearing, and prefer over-blocking to under-blocking whenever an
 * area code straddles a zone boundary.
 *
 * The tables MUST stay in step with `_shared/phone-timezone.ts`. Two rails that
 * disagree about what time it is where the phone is ringing is worse than one,
 * because the disagreement is invisible until somebody is sued over it.
 *
 * Ported from realtygrind `_shared/phone-timezone.ts` + `_shared/calling-window.ts`.
 */

const START_HOUR = 8;
const END_HOUR = 21;

/** Nothing resolved: Eastern is where Tossie's six-state footprint lives. */
export const DEFAULT_TZ = 'America/New_York';

/**
 * NANP area code → zone, written one line per zone instead of one row per code
 * so the whole table can be eyeballed for a mistake. Not exhaustive — NANP has
 * 350+ US codes — but it is the same set `_shared/phone-timezone.ts` carries,
 * and the two are meant to be diffed whenever either changes.
 *
 * Every code in Tossie's own six states (GA SC FL AL NC TN) is here on purpose.
 * Those are the numbers the dialer actually dials, and a missing code does NOT
 * fall through harmlessly: it falls through to the lead's state, and on an
 * absentee owner the state on file is the owner's MAILING state, which is the
 * whole reason they are on the list. A Savannah 912 number owned by someone
 * with a California mailing address resolved westward, which put a live Call
 * button on a lead at 9:30pm Savannah time.
 */
const ZONE_AREA_CODES = {
  'America/New_York':
    '201 202 203 207 212 215 216 229 239 301 302 305 315 321 347 352 386 401 404 407 410 412 413 443 ' +
    '470 478 516 518 561 585 603 607 610 614 617 646 678 703 704 706 716 717 718 724 727 732 754 757 ' +
    '762 770 772 786 802 803 804 813 828 843 845 848 854 856 860 862 864 904 908 910 912 914 917 919 ' +
    '929 941 954 973 980 984',
  'America/Chicago':
    '205 210 214 217 218 224 225 251 254 256 281 309 312 314 316 318 319 320 331 334 337 361 402 405 ' +
    '409 414 430 432 469 479 501 504 512 515 563 601 608 612 615 618 630 636 651 662 682 708 713 731 ' +
    '737 763 769 773 785 816 830 832 847 850 901 913 918 920 931 936 940 952 956 972',
  // 850 straddles: Tallahassee is Eastern, Pensacola is Central. Listed Central
  // because the two answers differ by an hour and only one of them is safe to
  // be wrong about — Central over-blocks Tallahassee until 9am, Eastern would
  // have offered a Pensacola seller a call at 7:30 their time.
  //
  // 915 is El Paso, which is MOUNTAIN despite being in Texas. It sat in this
  // list as Central and that is a straight fail-open: 7:05am in El Paso read as
  // 8:05 and the window said yes.
  'America/Denver':
    '208 303 307 385 406 435 505 575 719 720 801 915 970',
  // Arizona does not observe DST. Intl handles that for us as long as the zone
  // is Phoenix and not Denver — which is the entire reason it is listed apart.
  'America/Phoenix':
    '480 520 602 623 928',
  'America/Los_Angeles':
    '206 209 213 253 310 323 341 360 408 415 425 442 503 509 510 530 541 559 562 619 626 650 657 661 ' +
    '669 702 707 714 725 760 775 805 818 858 909 916 925 949 951 971',
  'America/Anchorage': '907',
  'Pacific/Honolulu': '808',
};

const AREA_CODE_TZ = {};
for (const [tz, codes] of Object.entries(ZONE_AREA_CODES)) {
  for (const code of codes.split(' ')) AREA_CODE_TZ[code] = tz;
}

/**
 * State → zone, used only when the area code did not resolve. Multi-zone states
 * get their most-populous zone: a coarse answer on a fallback path is fine,
 * a crash on a lead with a weird number is not.
 */
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix',
  AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York',
  LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver',
  NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago',
  TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
};

/** '+1 (912) 555-0134' -> '912'. Null when there is no plausible NANP number. */
export function areaCodeFromPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  // Drop the country code, including on numbers carrying extension digits —
  // otherwise the area code read off the front would be '191'.
  if (digits.length > 10 && digits[0] === '1') digits = digits.slice(1);
  return digits.length >= 10 ? digits.slice(0, 3) : null;
}

/**
 * `{ tz, resolved }` — same shape as `_shared/phone-timezone.ts` returns, so
 * the two rails can be diffed line for line. `resolved: false` means the zone
 * below is DEFAULT_TZ because nothing on the lead answered the question, which
 * is a materially weaker answer than the same string arrived at from an area
 * code, and callers are expected to say so rather than present it as a fact.
 */
export function resolveTimezone({ areaCode, state }) {
  const code = String(areaCode ?? '').replace(/\D/g, '');
  if (AREA_CODE_TZ[code]) return { tz: AREA_CODE_TZ[code], resolved: true };
  const st = String(state ?? '').trim().toUpperCase();
  if (STATE_TZ[st]) return { tz: STATE_TZ[st], resolved: true };
  return { tz: DEFAULT_TZ, resolved: false };
}

/**
 * Hour 0–23 in `tz` at `now`, or null when Intl could not tell us.
 *
 * Null rather than a fallback hour, because the obvious fallback — UTC — is
 * four to five hours ahead of every zone in the table, so 3am in Georgia would
 * come back as 8am and the window would open. A compliance check whose error
 * path says yes is worse than no check at all, since it says yes precisely at
 * the hours it is illegal to call. The caller blocks on null.
 */
function localHourInTz(tz, now) {
  try {
    // 'en-US' rather than the operator's locale: a locale with non-Latin digits
    // formats the hour as e.g. '٠٨', which Number() reads as NaN. The answer
    // must not depend on the browser's language setting.
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
      .formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (!Number.isFinite(hour)) return null;
    return hour === 24 ? 0 : hour;   // some runtimes emit 24 for midnight
  } catch {
    return null;
  }
}

/** '7:12 AM EDT' — the number that makes the block believable to the operator. */
function localTimeInTz(tz, now) {
  try {
    return now.toLocaleTimeString(undefined, {
      timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return '';
  }
}

/**
 * The answer for one lead, at one instant.
 *
 * `now` is a parameter rather than Date.now() so the page can re-evaluate on a
 * timer — a queue left open at 8:59pm has to stop offering Call at 9:00, not
 * when somebody happens to reload.
 *
 * Falls back to the MAILING state before the property state: most of a
 * wholesaler's list is absentee owners, where the house is in Georgia and the
 * owner answering the phone is in California.
 */
export function callingWindow(lead, now = new Date()) {
  const phone = lead?.phone_mobile || lead?.phone || null;
  const areaCode = areaCodeFromPhone(phone);
  const state = lead?.mailing_state || lead?.state || null;
  const { tz, resolved } = resolveTimezone({ areaCode, state });
  const hour = localHourInTz(tz, now);

  // hour === null means Intl could not answer. Block. See localHourInTz.
  const allowed = hour !== null && hour >= START_HOUR && hour < END_HOUR;

  return {
    allowed,
    hour,
    tz,
    localTime: localTimeInTz(tz, now),
    // The zone is DEFAULT_TZ because nothing on the lead resolved, not because
    // anything said Eastern. Worth saying out loud on the page: "allowed" on a
    // guess is the weakest answer this function gives.
    guessed: !resolved,
    reason: allowed ? 'ok'
      : hour === null ? 'unknown_timezone'
      : hour < START_HOUR ? 'before_8am'
      : 'after_9pm',
  };
}
