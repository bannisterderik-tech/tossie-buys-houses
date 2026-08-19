// ============================================================================
// Resolve a US/NANP number to the CALLED PARTY's timezone.
// ============================================================================
// Ported from reoperative's _shared/phone-timezone.ts. TCPA's window is
// measured in the called party's local time, and the only thing we reliably
// know about a cold lead is their number — so the area code is the primary
// signal and the lead's state is the fallback.
//
// The maps are deliberately written one-entry-per-line rather than generated,
// because the failure mode of a wrong entry is calling someone at 6am and the
// only defence against that is a human being able to read the table.
//
// No I/O and no Date.now(): every function takes the instant as an argument so
// the dialer, the SDR and a test can all ask the same question about a fixed
// point in time.
// ============================================================================

export const DEFAULT_TZ = 'America/New_York';

// Not exhaustive — NANP has 350+ US codes. This covers the high-traffic ones in
// every continental zone plus AK/HI; anything missing falls through to state,
// then to Eastern. Eastern as the default is the conservative choice for a
// business whose footprint is the Southeast: guessing Eastern makes the window
// close earlier in real terms for a lead further west, never later.
const AREA_CODE_TZ: Record<string, string> = {
  // Eastern
  '201': 'America/New_York', '202': 'America/New_York', '203': 'America/New_York',
  '207': 'America/New_York', '212': 'America/New_York', '215': 'America/New_York',
  '216': 'America/New_York', '229': 'America/New_York', '239': 'America/New_York',
  '301': 'America/New_York', '302': 'America/New_York', '305': 'America/New_York',
  '315': 'America/New_York', '321': 'America/New_York', '347': 'America/New_York',
  '352': 'America/New_York', '386': 'America/New_York', '401': 'America/New_York',
  '404': 'America/New_York', '407': 'America/New_York', '410': 'America/New_York',
  '412': 'America/New_York', '413': 'America/New_York', '443': 'America/New_York',
  '470': 'America/New_York', '478': 'America/New_York', '516': 'America/New_York',
  '518': 'America/New_York', '561': 'America/New_York', '585': 'America/New_York',
  '603': 'America/New_York', '607': 'America/New_York', '610': 'America/New_York',
  '614': 'America/New_York', '617': 'America/New_York', '646': 'America/New_York',
  '678': 'America/New_York', '703': 'America/New_York', '704': 'America/New_York',
  '706': 'America/New_York', '716': 'America/New_York', '717': 'America/New_York',
  '718': 'America/New_York', '724': 'America/New_York', '727': 'America/New_York',
  '732': 'America/New_York', '754': 'America/New_York', '757': 'America/New_York',
  '762': 'America/New_York', '770': 'America/New_York', '772': 'America/New_York',
  '786': 'America/New_York', '802': 'America/New_York', '803': 'America/New_York',
  '804': 'America/New_York', '813': 'America/New_York', '828': 'America/New_York',
  '843': 'America/New_York', '845': 'America/New_York', '848': 'America/New_York',
  '854': 'America/New_York', '856': 'America/New_York', '860': 'America/New_York',
  '862': 'America/New_York', '864': 'America/New_York', '904': 'America/New_York',
  '908': 'America/New_York', '910': 'America/New_York', '912': 'America/New_York',
  '914': 'America/New_York', '917': 'America/New_York', '919': 'America/New_York',
  '929': 'America/New_York', '941': 'America/New_York', '954': 'America/New_York',
  '973': 'America/New_York', '980': 'America/New_York', '984': 'America/New_York',

  // Central
  '205': 'America/Chicago', '210': 'America/Chicago', '214': 'America/Chicago',
  '217': 'America/Chicago', '218': 'America/Chicago', '224': 'America/Chicago',
  '225': 'America/Chicago', '251': 'America/Chicago', '254': 'America/Chicago',
  '256': 'America/Chicago', '281': 'America/Chicago', '309': 'America/Chicago',
  '312': 'America/Chicago', '314': 'America/Chicago', '316': 'America/Chicago',
  '318': 'America/Chicago', '319': 'America/Chicago', '320': 'America/Chicago',
  '331': 'America/Chicago', '334': 'America/Chicago', '337': 'America/Chicago',
  '361': 'America/Chicago', '402': 'America/Chicago', '405': 'America/Chicago',
  '409': 'America/Chicago', '414': 'America/Chicago', '430': 'America/Chicago',
  '432': 'America/Chicago', '469': 'America/Chicago', '479': 'America/Chicago',
  '501': 'America/Chicago', '504': 'America/Chicago', '512': 'America/Chicago',
  '515': 'America/Chicago', '563': 'America/Chicago', '601': 'America/Chicago',
  '608': 'America/Chicago', '612': 'America/Chicago', '615': 'America/Chicago',
  '618': 'America/Chicago', '630': 'America/Chicago', '636': 'America/Chicago',
  '651': 'America/Chicago', '662': 'America/Chicago', '682': 'America/Chicago',
  '708': 'America/Chicago', '713': 'America/Chicago', '731': 'America/Chicago',
  '737': 'America/Chicago', '763': 'America/Chicago', '769': 'America/Chicago',
  '773': 'America/Chicago', '785': 'America/Chicago', '816': 'America/Chicago',
  '830': 'America/Chicago', '832': 'America/Chicago', '847': 'America/Chicago',
  '901': 'America/Chicago', '913': 'America/Chicago', '918': 'America/Chicago',
  '920': 'America/Chicago', '931': 'America/Chicago', '936': 'America/Chicago',
  '940': 'America/Chicago', '952': 'America/Chicago', '956': 'America/Chicago',
  '972': 'America/Chicago',

  // 850 straddles the Florida panhandle line: Tallahassee is Eastern,
  // Pensacola is Central. Central is the safe half to be wrong about — it
  // over-blocks Tallahassee until 9am, where Eastern would have let a text go
  // to a Pensacola seller at 7:30 their time. Florida is one of the six states
  // this business works, so this code is not hypothetical traffic.
  '850': 'America/Chicago',

  // Mountain
  '208': 'America/Denver', '303': 'America/Denver', '307': 'America/Denver',
  '385': 'America/Denver', '406': 'America/Denver', '435': 'America/Denver',
  '505': 'America/Denver', '575': 'America/Denver', '719': 'America/Denver',
  '720': 'America/Denver', '801': 'America/Denver', '970': 'America/Denver',
  // El Paso. Texas is otherwise Central and this sat in that block, which read
  // 7:05am in El Paso as 8:05 and opened the window an hour early every day.
  '915': 'America/Denver',

  // Arizona does not observe DST, so it needs its own zone rather than Denver.
  '480': 'America/Phoenix', '520': 'America/Phoenix', '602': 'America/Phoenix',
  '623': 'America/Phoenix', '928': 'America/Phoenix',

  // Pacific
  '206': 'America/Los_Angeles', '209': 'America/Los_Angeles', '213': 'America/Los_Angeles',
  '253': 'America/Los_Angeles', '310': 'America/Los_Angeles', '323': 'America/Los_Angeles',
  '341': 'America/Los_Angeles', '360': 'America/Los_Angeles', '408': 'America/Los_Angeles',
  '415': 'America/Los_Angeles', '425': 'America/Los_Angeles', '442': 'America/Los_Angeles',
  '503': 'America/Los_Angeles', '509': 'America/Los_Angeles', '510': 'America/Los_Angeles',
  '530': 'America/Los_Angeles', '541': 'America/Los_Angeles', '559': 'America/Los_Angeles',
  '562': 'America/Los_Angeles', '619': 'America/Los_Angeles', '626': 'America/Los_Angeles',
  '650': 'America/Los_Angeles', '657': 'America/Los_Angeles', '661': 'America/Los_Angeles',
  '669': 'America/Los_Angeles', '702': 'America/Los_Angeles', '707': 'America/Los_Angeles',
  '714': 'America/Los_Angeles', '725': 'America/Los_Angeles', '760': 'America/Los_Angeles',
  '775': 'America/Los_Angeles', '805': 'America/Los_Angeles', '818': 'America/Los_Angeles',
  '858': 'America/Los_Angeles', '909': 'America/Los_Angeles', '916': 'America/Los_Angeles',
  '925': 'America/Los_Angeles', '949': 'America/Los_Angeles', '951': 'America/Los_Angeles',
  '971': 'America/Los_Angeles',

  '907': 'America/Anchorage',
  '808': 'Pacific/Honolulu',
};

// Fallback when the area code is unknown — a mobile number keeps its area code
// when its owner moves, so this is genuinely the weaker signal of the two.
// Multi-zone states get their most populous zone; coarse is acceptable here
// because it only runs when the better signal is missing.
const STATE_TZ: Record<string, string> = {
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

/** The 3-digit NANP area code, or null when the input is not a US number. */
export function areaCodeFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length === 10) return digits.slice(0, 3);
  // Extension cruft and other junk: strip a country code and take the first
  // three only if what remains is still long enough to be a real number.
  if (digits.length > 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length >= 10) return digits.slice(0, 3);
  return null;
}

export function resolveTimezone(
  opts: { areaCode?: string | null; state?: string | null },
): { tz: string; resolved: boolean } {
  const ac = String(opts.areaCode || '').replace(/\D/g, '');
  if (ac && AREA_CODE_TZ[ac]) return { tz: AREA_CODE_TZ[ac], resolved: true };
  const st = String(opts.state || '').trim().toUpperCase();
  if (st && STATE_TZ[st]) return { tz: STATE_TZ[st], resolved: true };
  // `resolved: false` is the signal that the answer is a guess. Callers that
  // care (the calling window does) can say so in their reason string instead of
  // presenting a default as a fact.
  return { tz: DEFAULT_TZ, resolved: false };
}

/**
 * Hour 0-23 in `tz` at instant `now`, or null when Intl could not say.
 *
 * Null, not a UTC fallback. UTC runs four to five hours ahead of every zone in
 * the table above, so falling back to it maps 3am and 4am in the US onto 8am
 * and 9am — the error path would have said "yes, send" at exactly the hours the
 * window exists to forbid, and it would have said it silently. A send path must
 * not crash on a bad zone string, but the way to not crash is to return "I do
 * not know" and let the caller refuse, not to invent an hour.
 */
export function localHourInTz(tz: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const raw = parts.find((p) => p.type === 'hour')?.value;
    const h = raw === undefined ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(h)) return null;
    // Some ICU builds emit 24 for midnight under hour12:false.
    return h === 24 ? 0 : h;
  } catch {
    return null;
  }
}
