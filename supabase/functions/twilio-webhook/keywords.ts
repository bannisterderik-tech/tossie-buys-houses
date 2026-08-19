// supabase/functions/twilio-webhook/keywords.ts
// ============================================================================
// Is this whole message a carrier keyword, or is it a person talking?
// ============================================================================
// Lifted out of index.ts unchanged, and for one reason: this is now the guard
// that decides whether a stranger's text opens a lead. A message that classifies
// as a keyword gets suppression, a confirmation and no CRM record; a message
// that classifies as null gets a lead with a consent basis attached. Two
// outcomes that far apart should not rest on a function no test has ever
// called, so it lives here and keywords_test.ts exercises it.
// ============================================================================

// Whole-message keywords, matched exactly, case- and punctuation-insensitive.
//
// Deliberately NOT fuzzy: "stop by tomorrow at 3" is a hot seller confirming an
// appointment, and suppressing them would be worse than useless. A message that
// means stop without saying STOP is caught by a human reading the thread and
// adding a manual opt-out — which is what source 'manual' exists for.
export const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
export const HELP_WORDS = new Set(['HELP', 'INFO']);
// Twilio's standard opt-in list also includes YES. Excluded on purpose: "yes"
// is the most common reply in a seller conversation, and reading it as "resume
// texting a number that opted out" gets that exactly backwards. START and
// UNSTOP cannot mean anything else.
export const START_WORDS = new Set(['START', 'UNSTOP']);

export type Keyword = 'stop' | 'help' | 'start' | null;

/** Classify the whole message, or null if it is an ordinary reply. */
export function classify(body: string): Keyword {
  const word = (body || '').trim().toUpperCase().replace(/^\W+|\W+$/g, '');
  if (STOP_WORDS.has(word)) return 'stop';
  if (HELP_WORDS.has(word)) return 'help';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Whether this inbound message should open a lead — the guard on step 4 of the
 * write order in index.ts, as one expression that can be asserted on.
 *
 * `keyword === null` is the compliance-critical half. Someone texting STOP to a
 * number they were never on is telling you they do not want to hear from you;
 * answering that by opening a record on them, stamped with a consent basis, is
 * how a complaint becomes a claim. HELP and START are excluded for the same
 * reason — neither is a person asking about their house.
 *
 * `matchedLeadId === null` is the ordinary half: we already know this number,
 * and a second lead would split one seller's thread across two records.
 */
export function opensALead(keyword: Keyword, matchedLeadId: string | null): boolean {
  return keyword === null && matchedLeadId === null;
}
