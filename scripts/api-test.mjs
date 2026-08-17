#!/usr/bin/env node
/**
 * Tests for POST /api/lead, run with no env vars set — the same degraded mode
 * the endpoint is in until Supabase is connected. Nothing here touches the
 * network.
 *
 *   node scripts/api-test.mjs
 */
import assert from 'node:assert/strict';
import handler, { splitAddress } from '../api/lead.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Minimal stand-in for the Vercel req/res pair. */
function call(body, headers = {}, method = 'POST') {
  const req = { method, body, headers: { 'user-agent': 'test', ...headers } };
  const out = {};
  const res = {
    setHeader() {},
    status(code) { out.code = code; return res; },
    json(payload) { out.body = payload; return res; },
  };
  return handler(req, res).then(() => out);
}

// ── address parsing ─────────────────────────────────────────────────────────
test('splits a fully typed address', () => {
  assert.deepEqual(splitAddress('14 Oak St, Savannah, GA 31401', null),
    { address: '14 Oak St', city: 'Savannah', state: 'GA', zip: '31401' });
});

test('splits without a zip', () => {
  assert.deepEqual(splitAddress('14 Oak St, Savannah, GA', null),
    { address: '14 Oak St', city: 'Savannah', state: 'GA', zip: null });
});

test('drops a zip+4 down to the 5-digit zip', () => {
  assert.equal(splitAddress('14 Oak St, Savannah, GA 31401-1234', null).zip, '31401');
});

test('falls back to the page city when the seller typed a bare street', () => {
  assert.deepEqual(splitAddress('14 Oak St', 'Savannah, GA'),
    { address: '14 Oak St', city: 'Savannah', state: 'GA', zip: null });
});

test('keeps the street intact when there is no market either', () => {
  assert.deepEqual(splitAddress('14 Oak St', null),
    { address: '14 Oak St', city: null, state: null, zip: null });
});

test('uppercases a lowercased state', () => {
  assert.equal(splitAddress('9 Pine Ave, Bluffton, sc 29910', null).state, 'SC');
});

// ── request handling ────────────────────────────────────────────────────────
const valid = {
  address: '14 Oak St, Savannah, GA 31401',
  name: 'Jane Seller',
  phone: '(912) 555-0134',
  email: 'jane@example.com',
  situation: 'inherited-house',
  market: 'Savannah, GA',
  page_path: '/sell-my-house-fast/savannah-ga/',
};

test('accepts a valid lead', async () => {
  const r = await call(valid);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('rejects a non-POST', async () => {
  const r = await call(valid, {}, 'GET');
  assert.equal(r.code, 405);
});

test('rejects each missing required field', async () => {
  for (const f of ['address', 'name', 'phone', 'email']) {
    const r = await call({ ...valid, [f]: '' });
    assert.equal(r.code, 400, `${f} should be required`);
    assert.equal(r.body.field, f);
  }
});

test('rejects a malformed email', async () => {
  assert.equal((await call({ ...valid, email: 'jane@' })).body.error, 'bad_email');
});

test('rejects a phone with fewer than 10 digits', async () => {
  assert.equal((await call({ ...valid, phone: '912-555' })).body.error, 'bad_phone');
});

test('swallows a honeypot submission with a 200 so bots learn nothing', async () => {
  const r = await call({ ...valid, company: 'Acme Spam Co' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('accepts a JSON string body', async () => {
  assert.equal((await call(JSON.stringify(valid))).code, 200);
});

test('rejects an unparseable body', async () => {
  assert.equal((await call('{not json')).body.error, 'bad_json');
});

// ── the consent record ──────────────────────────────────────────────────────
// The lead object is built inside the handler, so assert on what it logs in
// degraded mode — that log line is the lead until Supabase is connected.
test('records express written consent with text, version, IP and timestamp', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await call(valid, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
  } finally {
    console.log = orig;
  }

  const line = lines.find((l) => l.startsWith('LEAD (no store configured)'));
  assert.ok(line, 'expected the degraded-mode log line');
  const lead = JSON.parse(line.slice(line.indexOf('{')));

  assert.equal(lead.tcpa_opt_in, true);
  assert.equal(lead.consent_sms, true);
  assert.equal(lead.consent_email, true);
  assert.match(lead.tcpa_disclosure_text, /consent to receive calls, texts, and emails/);
  assert.match(lead.tcpa_disclosure_text, /Tossie Buys Houses/);
  assert.ok(lead.tcpa_disclosure_version, 'disclosure version must be stamped');
  assert.equal(lead.tcpa_disclosure_ip, '203.0.113.9', 'takes the client IP, not the proxy');
  assert.ok(Date.parse(lead.tcpa_opt_in_at), 'opt-in timestamp must be a real date');

  assert.equal(lead.source, 'website');
  assert.equal(lead.status, 'new');
  assert.equal(lead.city, 'Savannah');
  assert.equal(lead.state, 'GA');
  assert.equal(lead.motivation, 'inherited-house');
  assert.deepEqual(lead.tags, ['inherited-house']);
});

test('leaves the consent IP null when the header is junk', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await call(valid, { 'x-forwarded-for': 'not-an-ip' });
  } finally {
    console.log = orig;
  }
  const line = lines.find((l) => l.startsWith('LEAD (no store configured)'));
  assert.equal(JSON.parse(line.slice(line.indexOf('{'))).tcpa_disclosure_ip, null);
});

// ── run ─────────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
