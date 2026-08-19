// supabase/functions/twilio-webhook/keywords_test.ts
// ============================================================================
//   deno test supabase/functions/
// ============================================================================
// Assertions come from test-assert.ts — see the note there for why this suite
// takes no dependency at all, not even node:assert.
//
// What is being defended here is one sentence: a STOP never creates a lead, and
// an ordinary seller message always does. Everything below is a way of getting
// that wrong.
// ============================================================================

import { equal } from './test-assert.ts';
import { classify, opensALead } from './keywords.ts';

// ── the classifier ──────────────────────────────────────────────────────────

Deno.test('classify: the carrier stop words, in every casing a phone produces', () => {
  for (const w of ['STOP', 'stop', 'Stop', 'StOp']) {
    equal(classify(w), 'stop', `${w} must suppress`);
  }
  for (const w of ['STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']) {
    equal(classify(w), 'stop', `${w} must suppress`);
  }
});

Deno.test('classify: punctuation and whitespace do not smuggle a STOP past the guard', () => {
  // A phone keyboard capitalises and autocorrects. "Stop." and " STOP! " are
  // the same instruction, and treating them as ordinary messages would both
  // fail to suppress and open a lead on someone who just said no.
  for (const w of ['  STOP  ', 'Stop.', 'STOP!', '"stop"', '...stop...', 'stop?']) {
    equal(classify(w), 'stop', `${JSON.stringify(w)} must suppress`);
  }
});

Deno.test('classify: HELP and START are their own outcomes, not stop and not null', () => {
  equal(classify('HELP'), 'help');
  equal(classify('info'), 'help');
  equal(classify('START'), 'start');
  equal(classify('unstop'), 'start');
});

Deno.test('classify: YES is a seller agreeing, never an opt-in keyword', () => {
  // The single most common word in a seller conversation. Reading it as "resume
  // texting a number that opted out" gets the direction of consent backwards.
  equal(classify('YES'), null);
  equal(classify('yes'), null);
});

Deno.test('classify: a keyword inside a sentence is a sentence', () => {
  // "stop by tomorrow at 3" is a hot seller confirming an appointment. Matching
  // it would suppress the best lead of the week AND deny them a CRM record.
  for (const s of [
    'stop by tomorrow at 3',
    'Can you stop calling my work number and use my cell',
    'end of the month works for closing',
    'I want to cancel my listing with the agent',
    'quit lowballing me',
    'Help me understand the offer',
  ]) {
    equal(classify(s), null, `${JSON.stringify(s)} is a person talking`);
  }
});

Deno.test('classify: an empty body is an ordinary message, not a keyword', () => {
  // A photo-only MMS. It must not classify as anything, because a keyword would
  // suppress a seller who sent a picture of their roof.
  equal(classify(''), null);
  equal(classify('   '), null);
});

// ── the guard on lead creation ──────────────────────────────────────────────

Deno.test('opensALead: an unknown number sending a real message opens a lead', () => {
  equal(opensALead(classify('is your offer still good on the house on Bull St'), null), true);
  // Including the photo-only MMS, which is still someone reaching out.
  equal(opensALead(classify(''), null), true);
});

Deno.test('opensALead: a STOP from a stranger never opens a lead', () => {
  // The whole point. Someone texting STOP to a number they were never on is
  // telling us they do not want to hear from us; opening a record on them —
  // stamped with a consent basis, no less — is how a complaint becomes a claim.
  for (const w of ['STOP', 'stop.', ' UNSUBSCRIBE ', 'quit', 'CANCEL', 'End', 'stopall']) {
    equal(opensALead(classify(w), null), false, `${JSON.stringify(w)} must not create a lead`);
  }
});

Deno.test('opensALead: HELP and START from a stranger never open a lead either', () => {
  // Neither is a person asking about their house. HELP is a carrier-mandated
  // question about who we are; START is someone un-suppressing themselves, and
  // if they are un-suppressing there was already a record somewhere.
  for (const w of ['HELP', 'info', 'START', 'UNSTOP']) {
    equal(opensALead(classify(w), null), false, `${JSON.stringify(w)} must not create a lead`);
  }
});

Deno.test('opensALead: a number we already know never gets a second lead', () => {
  // Two lead rows on one seller means the thread splits and half the
  // conversation goes missing from whichever one the operator opens.
  equal(opensALead(null, '5f8e3a10-0000-4000-8000-00000000abcd'), false);
  equal(opensALead(classify('call me back'), '5f8e3a10-0000-4000-8000-00000000abcd'), false);
});
