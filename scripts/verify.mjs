#!/usr/bin/env node
/** Local audit: duplicates, thin pages, broken links, schema, AI-copy tells, orphans. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
// When built for a Pages project URL, hrefs carry a base prefix that page paths don't.
const BASE = (process.env.BASE_PATH || '').replace(/\/$/, '');
const unbase = (h) => (BASE && h.startsWith(BASE + '/') ? h.slice(BASE.length) : BASE && h === BASE ? '/' : h);
const BAN = fs.readFileSync(path.join(ROOT, 'scripts', 'ban_list.txt'), 'utf8')
  .split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'index.html') files.push(p);
  }
})(SITE);

const urlOf = (f) => '/' + path.relative(SITE, f).replace(/index\.html$/, '').replace(/\\/g, '/');
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

const problems = { blocker: [], major: [], minor: [] };
const add = (sev, msg) => problems[sev].push(msg);

const titles = new Map(), descs = new Map(), answers = new Map();
const allUrls = new Set(files.map(urlOf));
const inbound = new Map([...allUrls].map((u) => [u, 0]));
let totalWords = 0;

for (const f of files) {
  const url = urlOf(f);
  const html = fs.readFileSync(f, 'utf8');
  const text = strip(html);
  const words = text.trim().split(/\s+/).length;
  totalWords += words;

  // --- title / desc / canonical
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';
  if (!title) add('blocker', `${url}: missing <title>`);
  if (!desc) add('blocker', `${url}: missing meta description`);
  if (!canon.endsWith(url)) add('major', `${url}: canonical mismatch -> ${canon}`);
  if (BASE && !html.includes(`href="${BASE}/`)) add('blocker', `${url}: BASE_PATH set but links are not prefixed`);
  if (title.length > 65) add('minor', `${url}: title ${title.length} chars (>65)`);
  if (desc.length > 165) add('minor', `${url}: description ${desc.length} chars (>165)`);
  (titles.get(title) || titles.set(title, []).get(title)).push(url);
  (descs.get(desc) || descs.set(desc, []).get(desc)).push(url);

  // --- direct answer block uniqueness (the AEO quote target)
  const ans = (html.match(/<div class="answer">([\s\S]*?)<\/div>/) || [])[1];
  if (!ans && !/\/(privacy|terms)\//.test(url)) add('major', `${url}: no direct-answer block`);
  if (ans) {
    const key = strip(ans).slice(0, 220);
    (answers.get(key) || answers.set(key, []).get(key)).push(url);
  }

  // --- thin content
  if (words < 380 && !/\/(privacy|terms)\//.test(url)) add('major', `${url}: thin — ${words} words`);

  // --- schema validity
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!blocks.length) add('blocker', `${url}: no JSON-LD`);
  for (const [, raw] of blocks) {
    try { JSON.parse(raw); } catch (e) { add('blocker', `${url}: invalid JSON-LD — ${e.message}`); }
  }

  // --- images need alt
  for (const [, tag] of [...html.matchAll(/(<img [^>]*>)/g)]) {
    if (!/\balt=/.test(tag)) add('major', `${url}: <img> without alt`);
  }

  // --- unresolved template tokens
  const tok = text.match(/\{[a-zA-Z]+\}/g);
  if (tok) add('blocker', `${url}: unresolved token(s) ${[...new Set(tok)].join(', ')}`);
  if (/\bundefined\b|\bNaN\b|\bnull\b/.test(text)) add('blocker', `${url}: leaked undefined/NaN/null into copy`);

  // --- AI-copy ban list
  const low = text.toLowerCase();
  for (const p of BAN) if (low.includes(p)) add('major', `${url}: banned phrase "${p}"`);

  // --- concrete-number density (>=1 per 100 words)
  const nums = (text.match(/\b\d+\b/g) || []).length;
  if (words > 300 && nums / (words / 100) < 1) add('minor', `${url}: only ${nums} numbers in ${words} words`);

  // --- internal links
  for (const [, href] of [...html.matchAll(/href="(\/[^"#?]*)"/g)]) {
    const raw = unbase(href);
    const h = raw.endsWith('/') || /\.[a-z]+$/.test(raw) ? raw : raw + '/';
    if (/\.(xml|txt|png|jpg|jpeg|webp|svg|ico|css|js)$/.test(h)) continue;
    if (h.startsWith('/api/')) continue;
    // /app is the operator console — a separate Vite build that lands in
    // site/app during the Vercel build, after this audit has already run. It
    // is verified against the live deployment by scripts/probe-deploy.sh.
    if (h === '/app/' || h.startsWith('/app/')) continue;
    if (!allUrls.has(h)) add('blocker', `${url}: broken internal link -> ${href}`);
    else if (h !== url) inbound.set(h, (inbound.get(h) || 0) + 1);
  }
}

for (const [t, us] of titles) if (us.length > 1) add('blocker', `duplicate title (${us.length}x) "${t.slice(0, 70)}" — ${us.slice(0, 3).join(', ')}`);
for (const [d, us] of descs) if (us.length > 1) add('major', `duplicate description (${us.length}x) — ${us.slice(0, 3).join(', ')}`);
for (const [, us] of answers) if (us.length > 1) add('major', `duplicate direct-answer block (${us.length}x) — ${us.slice(0, 3).join(', ')}`);
for (const [u, n] of inbound) if (n === 0 && u !== '/') add('major', `orphan (0 inbound links): ${u}`);

// sitemap parity
const sm = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
const smUrls = new Set([...sm.matchAll(/<loc>https?:\/\/[^/<]+([^<]*)<\/loc>/g)].map((m) => unbase(m[1])));
for (const u of allUrls) if (!smUrls.has(u)) add('major', `not in sitemap: ${u}`);
for (const u of smUrls) if (!allUrls.has(u)) add('blocker', `sitemap lists missing page: ${u}`);

const roll = (a) => { const m = new Map(); for (const s of a) { const k = s.replace(/^\/[^:]*: /, '').replace(/"[^"]*"/, '"…"').slice(0, 60); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((x, y) => y[1] - x[1]); };

console.log(`\n${files.length} pages · ${Math.round(totalWords / files.length)} avg words · ${(totalWords / 1000).toFixed(0)}k words total\n`);
for (const sev of ['blocker', 'major', 'minor']) {
  const list = problems[sev];
  console.log(`${sev.toUpperCase()}: ${list.length}`);
  for (const [k, n] of roll(list).slice(0, 14)) console.log(`   ${String(n).padStart(4)}x  ${k}`);
  if (list.length) console.log(`   e.g. ${list[0]}`);
  console.log('');
}
process.exit(problems.blocker.length ? 1 : 0);
