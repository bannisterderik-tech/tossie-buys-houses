#!/usr/bin/env node
/**
 * Tossie Buys Houses — static site generator
 * Pages are ASSEMBLED FROM FACTS in data/*.json. No page contains generated prose.
 * Every claim traces to: tossiebuyshouses.com (live), the GA/SC license registry,
 * or the cited state statute / court source in data/states.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CSS } from './css.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

const BIZ = read('business.json');
const STATES = read('states.json');
const CITYSRC = read('cities.json');
const SITUATIONS = read('situations.json');
const GUIDES = read('guides.json');

const ORIGIN = process.env.SITE_ORIGIN || 'https://tossiebuyshouses.com';
const NOINDEX = process.env.NOINDEX === '1';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';

/* ------------------------------------------------------------------ utils */
const hash = (s) => parseInt(crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 8), 16);
const pick = (arr, key) => arr[hash(key) % arr.length];
const slugify = (s) => s.toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const uniq = (a) => [...new Set(a)];
/** Keep titles inside Google's display width: append the brand only when it fits. */
const mkTitle = (main, brand = BIZ.name, max = 62) => (`${main} | ${brand}`.length <= max ? `${main} | ${brand}` : main.length <= max ? main : main.slice(0, main.lastIndexOf(' ', max - 1)));
/** Trim a description to ~155 chars on a word boundary. */
const mkDesc = (s, max = 155) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length <= max ? s : s.slice(0, s.lastIndexOf(' ', max - 1)).replace(/[,.;:]$/, '') + '…'; };

/* ---------------------------------------------------------- build indexes */
const stateBy = Object.fromEntries(STATES.map((s) => [s.code, s]));
const CITIES = [];
for (const [code, rows] of Object.entries(CITYSRC)) {
  if (code.startsWith('_')) continue;
  const st = stateBy[code];
  for (const [name, county, tier, anchor] of rows) {
    CITIES.push({
      name, county, tier, anchor,
      stateCode: code,
      state: st.name,
      stateSlug: st.slug,
      slug: slugify(name),
      countySlug: slugify(county),
      url: `/sell-my-house-fast/${st.slug}/${slugify(name)}/`,
    });
  }
}
const cityByState = (code) => CITIES.filter((c) => c.stateCode === code);
const COUNTIES = [];
for (const st of STATES) {
  for (const cs of uniq(cityByState(st.code).map((c) => c.county))) {
    COUNTIES.push({
      name: cs, slug: slugify(cs), stateCode: st.code, state: st.name, stateSlug: st.slug,
      cities: cityByState(st.code).filter((c) => c.county === cs),
      url: `/counties/${st.slug}/${slugify(cs)}/`,
    });
  }
}
const T1CITIES = CITIES.filter((c) => c.tier === 1);
const T1SITS = SITUATIONS.filter((s) => s.tier === 1);
const sitAllowed = (sit, code) => !sit.states || sit.states.includes(code);

/* --------------------------------------------------------- token resolver */
function ctx(city) {
  const st = stateBy[city.stateCode];
  const closingPro = st.closingType === 'attorney' ? `a ${st.name} closing attorney` : 'a title company';
  return {
    city: city.name,
    county: city.county,
    state: st.name,
    stateCode: st.code,
    closingPro,
    closingProCap: closingPro.charAt(0).toUpperCase() + closingPro.slice(1),
    foreclosureType: st.foreclosure.type.toLowerCase(),
    foreclosureSummary: st.foreclosure.summary,
    foreclosureSpeed: st.foreclosure.speed,
    redemptionFact: st.foreclosure.redemption,
    deadlineNote: st.foreclosure.deadlineNote,
    taxSaleSummary: st.taxSale.summary,
    taxSaleRedemption: st.taxSale.redemption,
  };
}
const fill = (tpl, c) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in c ? c[k] : m));

/* ------------------------------------------------------------- components */
const tel = BIZ.phoneE164;
const PHONE = BIZ.phoneDisplay;

function head({ title, desc, canonical, ogImage, jsonld }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}${canonical}">
${NOINDEX ? '<meta name="robots" content="noindex,nofollow">' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'}
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(BIZ.name)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ORIGIN}${canonical}"><meta property="og:image" content="${ORIGIN}${ogImage || '/assets/img/og-default.jpg'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/img/favicon.png">
<link rel="preconnect" href="${SUPABASE_URL || ORIGIN}">
<style>${CSS(BIZ.brand)}</style>
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head><body>`;
}

function header(navState) {
  const links = STATES.map((s) => `<a href="/sell-my-house-fast/${s.slug}/">${s.name}</a>`).join('');
  return `<div class="topbar"><div class="wrap">
<span>Cash offer in as little as 24 hours &middot; Close in ${BIZ.promise.closeRangeDays}</span>
<span class="lic">GA RE LIC ${BIZ.licenses[0].number} &middot; SC RE LIC ${BIZ.licenses[1].number}</span>
<a href="tel:${tel}">Call or text ${PHONE}</a></div></div>
<header class="site"><div class="wrap">
<a class="logo" href="/"><img src="${BIZ.logo}" alt="${esc(BIZ.logoAlt)} logo" width="42" height="52" fetchpriority="high"><span>${esc(BIZ.name)}</span></a>
<button class="navtoggle" aria-label="Menu" aria-expanded="false" onclick="var n=document.querySelector('nav.main');n.classList.toggle('open');this.setAttribute('aria-expanded',n.classList.contains('open'))">&#9776;</button>
<nav class="main">
<a href="/how-it-works/">How It Works</a>
<a href="/situations/">Situations</a>
<a href="/locations/">Where We Buy</a>
<a href="/guides/">Guides</a>
<a href="/about/">About</a>
<a class="btn" href="/#offer">Get My Cash Offer</a>
</nav></div></header>`;
}

function crumbs(trail) {
  return `<div class="crumbs"><div class="wrap">${trail
    .map((t, i) => (i === trail.length - 1 ? `<span aria-current="page">${esc(t.name)}</span>` : `<a href="${t.url}">${esc(t.name)}</a>`))
    .join('<span>&rsaquo;</span>')}</div></div>`;
}

function form(id, heading, sub, cityName) {
  return `<div class="formcard" id="${id}">
<h2>${esc(heading)}</h2><p class="fine">${esc(sub)}</p>
<form class="leadform" novalidate>
<input type="hidden" name="page_path" value="">
<input type="hidden" name="market" value="${esc(cityName || '')}">
<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Company<input name="company" tabindex="-1" autocomplete="off"></label></div>
<div class="field"><label for="${id}-a">Property address *</label><input id="${id}-a" name="address" required autocomplete="street-address" placeholder="123 Main St, city, state"></div>
<div class="row2">
<div class="field"><label for="${id}-n">Your name *</label><input id="${id}-n" name="name" required autocomplete="name"></div>
<div class="field"><label for="${id}-p">Phone *</label><input id="${id}-p" name="phone" type="tel" required autocomplete="tel"></div>
</div>
<div class="field"><label for="${id}-e">Email *</label><input id="${id}-e" name="email" type="email" required autocomplete="email"></div>
<div class="field"><label for="${id}-s">What's going on with the property?</label><select id="${id}-s" name="situation">
<option value="">Select one (optional)</option>
${SITUATIONS.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('')}
<option value="other">Something else</option></select></div>
<button class="btn btn-lg" type="submit">Get My Cash Offer</button>
<div class="formstatus" role="status" aria-live="polite"></div>
<p class="consent">By submitting, you agree to our <a href="/terms/">Terms</a> and <a href="/privacy/">Privacy Policy</a> and consent to receive calls, texts, and emails from ${esc(BIZ.name)} about your property. Message frequency varies. Reply STOP to opt out. Consent is not a condition of any purchase.</p>
</form>
<p class="formnote">No obligation &middot; No fees &middot; We never list your house publicly</p>
</div>`;
}

function trustbar() {
  return `<div class="trustbar"><div class="wrap">
<div class="t"><b>24 hrs</b><span>To a written cash offer</span></div>
<div class="t"><b>7&ndash;28 days</b><span>Typical closing window</span></div>
<div class="t"><b>$0</b><span>Commissions, fees, or repairs</span></div>
<div class="t"><b>GA + SC</b><span>Licensed real estate agent</span></div>
</div></div>`;
}

function ctaband(h, p) {
  return `<section class="ctaband"><div class="wrap narrow"><h2>${esc(h)}</h2><p>${esc(p)}</p>
<div class="herocta"><a class="btn btn-lg" style="width:auto" href="/#offer">Get My Cash Offer</a>
<a class="phonebig" href="tel:${tel}"><small>Or call / text</small>${PHONE}</a></div></div></section>`;
}

function faqBlock(faqs) {
  if (!faqs.length) return '';
  return `<section class="wash"><div class="wrap narrow"><div class="sechead"><div class="kicker">Straight answers</div><h2>Frequently asked questions</h2></div>
<div class="faq">${faqs
    .map((f) => `<details><summary>${esc(f.q)}</summary><div class="a"><p>${esc(f.a)}</p></div></details>`)
    .join('')}</div></div></section>`;
}

function linkCloud(title, items, cls = 'links') {
  if (!items.length) return '';
  return `<h3>${esc(title)}</h3><div class="${cls}">${items.map((i) => `<a href="${i.url}">${esc(i.name)}</a>`).join('')}</div>`;
}

function footer() {
  const st = STATES.map((s) => `<a href="/sell-my-house-fast/${s.slug}/">${s.name}</a>`).join('');
  const sit = SITUATIONS.slice(0, 8).map((s) => `<a href="/situations/${s.slug}/">${s.name}</a>`).join('');
  return `<footer class="site"><div class="wrap">
<div class="footgrid">
<div><h4>${esc(BIZ.name)}</h4>
<p style="color:#c9d6e8">We buy houses for cash across the Southeast. Any condition, any situation, no fees.</p>
<p><a href="tel:${tel}" style="color:#fff;font-weight:800;font-size:1.15rem">${PHONE}</a>
<a href="mailto:${BIZ.email}">${BIZ.email}</a></p>
<p style="font-size:.85rem;opacity:.8">${esc(BIZ.legalName)}<br>${esc(BIZ.hq.locality)}, ${BIZ.hq.region}</p></div>
<div><h4>Where we buy</h4>${st}<a href="/locations/">All locations</a></div>
<div><h4>Situations</h4>${sit}<a href="/situations/">All situations</a></div>
<div><h4>Company</h4><a href="/how-it-works/">How it works</a><a href="/cash-offer-vs-listing/">Cash offer vs. listing</a><a href="/about/">About Tossie</a><a href="/guides/">Guides</a><a href="/faq/">FAQ</a><a href="/contact/">Contact</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></div>
</div>
<div class="footbot">&copy; ${new Date().getFullYear()} ${esc(BIZ.legalName)} dba ${esc(BIZ.name)}. Georgia Real Estate License #${BIZ.licenses[0].number} &middot; South Carolina Real Estate License #${BIZ.licenses[1].number}.
<p class="disc">${esc(BIZ.name)} buys residential property as a principal for its own account. We are not acting as your real estate agent or broker in these transactions and we do not represent you. Nothing on this site is legal, tax, or financial advice. Foreclosure, probate, and tax-sale timelines summarized here are general information about state law and change over time; confirm your own situation with a licensed attorney in your state. Offers vary by property condition, location, and title status.</p></div>
</div></footer>
<div class="mobilebar"><a class="btn btn-navy" href="tel:${tel}">Call ${PHONE}</a><a class="btn" href="#offer">Cash Offer</a></div>
<script>
document.querySelectorAll('.leadform').forEach(function(f){
  var pp=f.querySelector('[name=page_path]'); if(pp) pp.value=location.pathname;
  f.addEventListener('submit',async function(e){
    e.preventDefault();
    var st=f.parentElement.querySelector('.formstatus'), btn=f.querySelector('button[type=submit]');
    var d=Object.fromEntries(new FormData(f).entries());
    if(!d.address||!d.name||!d.phone||!d.email){st.className='formstatus err';st.textContent='Please fill in address, name, phone, and email.';return;}
    btn.disabled=true; btn.textContent='Sending…';
    try{
      var r=await fetch('/api/lead',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
      if(!r.ok) throw new Error('bad status');
      st.className='formstatus ok';
      st.textContent='Got it. Tossie or someone on the team will reach out shortly. Need it faster? Call ${PHONE}.';
      f.reset();
    }catch(err){
      st.className='formstatus err';
      st.innerHTML='Something went wrong sending that. Please call or text <a href="tel:${tel}">${PHONE}</a> and we\\'ll take it from there.';
      btn.disabled=false; btn.textContent='Get My Cash Offer';
    }
  });
});
</script></body></html>`;
}

/* ------------------------------------------------------------- json-ld */
function orgLD() {
  return {
    '@context': 'https://schema.org',
    '@type': ['RealEstateAgent', 'LocalBusiness'],
    '@id': `${ORIGIN}/#business`,
    name: BIZ.name,
    legalName: BIZ.legalName,
    url: `${ORIGIN}/`,
    telephone: BIZ.phoneE164,
    email: BIZ.email,
    logo: `${ORIGIN}${BIZ.logo}`,
    image: `${ORIGIN}${BIZ.logo}`,
    priceRange: '$$',
    founder: { '@type': 'Person', name: BIZ.owner, jobTitle: BIZ.ownerTitle },
    address: { '@type': 'PostalAddress', addressLocality: BIZ.hq.locality, addressRegion: BIZ.hq.region, addressCountry: 'US' },
    areaServed: STATES.map((s) => ({ '@type': 'State', name: s.name })),
    identifier: BIZ.licenses.map((l) => ({ '@type': 'PropertyValue', name: l.label, value: l.number })),
    sameAs: Object.values(BIZ.social),
    knowsAbout: SITUATIONS.map((s) => s.name),
  };
}
const crumbLD = (trail) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: `${ORIGIN}${t.url}` })),
});
const faqLD = (faqs) => ({
  '@context': 'https://schema.org', '@type': 'FAQPage',
  mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});
const serviceLD = (name, desc, area) => ({
  '@context': 'https://schema.org', '@type': 'Service',
  name, description: desc, serviceType: 'Cash home buying',
  provider: { '@id': `${ORIGIN}/#business` },
  areaServed: area,
  offers: { '@type': 'Offer', priceCurrency: 'USD', description: 'No-obligation written cash offer, no commissions or fees' },
});

/* ---------------------------------------------------------------- writer */
const PAGES = [];
function emit(url, html, priority = 0.7) {
  const dir = path.join(OUT, url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  PAGES.push({ url, priority, hash: crypto.createHash('md5').update(html).digest('hex') });
}

/* ================================================================= PAGES */

/* ---- variant pools: each entry independently true, none interchangeable */
const HERO_ANGLE = [
  (c) => `No repairs, no cleaning, no agent commission. We buy ${c.city} houses in the condition they're in right now.`,
  (c) => `A written offer in 24 hours, a closing date you pick, and no fee taken out of your side.`,
  (c) => `We're the buyer, not a middleman shopping your address around. One number, one closing.`,
  (c) => `Any condition, any situation. Tenants still in it, roof gone, taxes behind, we'll still make an offer.`,
  (c) => `You won't list it, stage it, or let strangers walk through it. We look once and give you a number.`,
  (c) => `Nothing gets fixed before closing. Not the roof, not the HVAC, not the smell.`,
  (c) => `Back ${c.county} County taxes, liens, and payoffs come out of proceeds. You bring nothing to the table.`,
  (c) => `If listing with an agent nets you more, we'll say so. That's the whole pitch.`,
  (c) => `No appraisal, no inspection contingency, no lender deciding whether your house qualifies.`,
  (c) => `Leave what you don't want, including the furniture. Take the keys off the ring and go.`,
];
const WHY_LOCAL = [
  (c, st) => `${st.closingFact}`,
  (c, st) => `Closings in ${c.county} County are recorded at the county courthouse, and ${st.closingType === 'attorney' ? `${st.name} requires an attorney to run them` : `a title company handles them in ${st.name}`}.`,
  (c, st) => `${st.name} uses ${st.foreclosure.type.toLowerCase()} foreclosure, which changes how much time a ${c.city} owner behind on payments actually has.`,
  (c, st) => `Delinquent taxes in ${c.county} County follow ${st.name}'s tax sale process, which runs on a different clock than a mortgage foreclosure.`,
  (c, st) => `Because ${st.name} is ${st.closingType === 'attorney' ? 'an attorney closing state' : 'a title company state'}, the closing calendar in ${c.county} County is set by ${st.closingType === 'attorney' ? "the attorney's availability" : 'the title company'} more than by us.`,
  (c, st) => `Everything recorded against a ${c.city} property sits in the ${c.county} County records, and that search is what sets the real floor on how fast we can close.`,
  (c, st) => `${st.foreclosure.redemption}`,
  (c, st) => `Prorated ${c.county} County property taxes are settled on the closing statement, so you only pay for the part of the year you owned it.`,
];
const COUNTY_OPEN = [
  (co, st, big) => `We buy across all of ${co.name} County, not just ${big}. Small towns and unincorporated addresses count.`,
  (co, st, big) => `${big} is the address most people search, but ${co.name} County deeds all record in the same place and we buy county-wide.`,
  (co, st, big) => `Anywhere in ${co.name} County works, including properties outside city limits that agents tend to skip.`,
  (co, st, big) => `Rural, in-town, or unincorporated ${co.name} County, the process and the fee structure are the same.`,
  (co, st, big) => `If your property sits in ${co.name} County, ${st.name} law governs the timeline and we can make an offer on it.`,
  (co, st, big) => `${co.name} County covers more than ${big}, and the further out a property sits the harder it usually is to list conventionally.`,
];
const MARKET_NOTE = [
  (c) => `Financed offers are where ${c.city} sales die. The appraisal comes in under contract, or the lender flags a roof, and two months of waiting resets to zero.`,
  (c) => `The houses that sell fastest in ${c.city} are the ones that need nothing. Everything else sits, gets a price cut, and sits again.`,
  (c) => `Most sellers we talk to in ${c.city} have already tried listing it. The call usually comes after the second buyer walked.`,
  (c) => `Insurance is the quiet problem across ${c.county} County. A buyer who cannot get a policy on an older roof cannot close, no matter how much they want the house.`,
  (c) => `Carrying an empty ${c.city} house runs into real money once you add taxes, a vacant-property policy, utilities, and someone to cut the grass.`,
  (c) => `Out-of-state owners are a large share of what we buy around ${c.city}, usually a house inherited or a rental that stopped being worth the trouble.`,
  (c) => `A ${c.city} listing that needs work draws investor offers anyway. The difference is you pay a commission on those and wait months for them.`,
  (c) => `Deferred maintenance compounds in this climate. What a ${c.city} owner puts off in spring is a bigger number by the following spring.`,
];
const STOCK_NOTE = [
  (c) => `A lot of what we buy around ${c.city} needs a roof, an HVAC system, or both.`,
  (c) => `Most of the ${c.city} houses we look at have had a repair deferred long enough that it turned into two.`,
  (c) => `Water damage is the single most common thing we find in ${c.county} County that the owner didn't know about.`,
  (c) => `Humidity does the damage here. Left unconditioned, a closed-up ${c.city} house grows mold in weeks.`,
  (c) => `Insurance premiums have moved faster than incomes across ${c.county} County, and that's pushed more owners to sell than any mortgage rate has.`,
  (c) => `We see a lot of ${c.city} properties where the owner lives somewhere else and has for years.`,
];

function directAnswer(city) {
  const st = stateBy[city.stateCode];
  const lic = st.licensed ? ` ${BIZ.owner} holds ${st.name} real estate license #${st.licenseNumber}.` : '';
  return `<div class="answer"><strong>Sell your house fast in ${esc(city.name)}, ${city.stateCode}.</strong> ${esc(BIZ.name)} buys houses for cash in ${esc(city.name)} and across ${esc(city.county)} County in any condition, with no commissions, no fees, and no repairs. You get a no-obligation written offer in as little as 24 hours and pick a closing date, typically ${BIZ.promise.closeRangeDays} out.${esc(lic)} Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(BIZ.hq.locality)}, ${BIZ.hq.region} &middot; ${esc(st.closingFact)}</span></div>`;
}

const PROCESS = [
  ['Tell us about the house', 'Address, condition, and what is going on. Two minutes on the form or one call. We do not need you to clean it, photograph it, or know what it is worth.'],
  ['We look at it and run numbers', 'We check recent sales near you, estimate repairs, and build the offer from those figures. If we walk the property, one person comes out. There is no open house and no sign in the yard.'],
  ['You get a written offer', 'Usually within 24 hours. It is no-obligation. We will show you how we got to the number so you can compare it against listing with an agent.'],
  ['You pick the closing date', `Typically ${BIZ.promise.closeRangeDays}. Faster if you need it, later if you are not ready. Liens, back taxes, and payoffs come out of proceeds. You pay no commission and no closing costs.`],
];

function processSection() {
  return `<section><div class="wrap"><div class="sechead center"><div class="kicker">How it works</div><h2>Four steps, no surprises</h2></div>
<div class="grid g4">${PROCESS.map((p, i) => `<div class="step"><div class="stepnum">${i + 1}</div><h3>${esc(p[0])}</h3><p>${esc(p[1])}</p></div>`).join('')}</div></div></section>`;
}

function processCompact() {
  return `<section><div class="wrap"><div class="sechead center"><div class="kicker">How it works</div><h2>Four steps</h2></div>
<div class="grid g4">${PROCESS.map((p, i) => `<div class="step"><div class="stepnum">${i + 1}</div><h3>${esc(p[0])}</h3></div>`).join('')}</div>
<p style="margin-top:22px;text-align:center"><a class="btn btn-ghost" href="/how-it-works/">See exactly what happens at each step</a></p></div></section>`;
}

function comparisonCompact(cityName) {
  return `<section class="wash"><div class="wrap narrow"><div class="sechead"><div class="kicker">An honest comparison</div><h2>Should you sell to us, or list it${cityName ? ` in ${esc(cityName)}` : ''}?</h2></div>
<p>We're not going to tell you a cash offer always wins. If the house shows well and you can wait 60 to 90 days, a listing usually nets more even after the 5&ndash;6% commission. Where we win is when the house needs work a lender won't approve, when it's costing you money every month, or when you have a date you have to hit.</p>
<p>What comes off a listing that doesn't come off ours: commission, seller closing costs, repair credits after inspection, and the carrying costs while it sits. Compare the net, not the asking price.</p>
<p><a class="btn btn-ghost" href="/cash-offer-vs-listing/">See the full side-by-side comparison</a></p>
</div></section>`;
}

function comparison(cityName) {
  return `<section class="wash"><div class="wrap"><div class="sechead"><div class="kicker">An honest comparison</div><h2>Cash offer vs. listing with an agent${cityName ? ` in ${esc(cityName)}` : ''}</h2>
<p>We are not going to tell you a cash offer always wins. It does not. If your house is in good shape and you can wait, a listing usually nets more. Here is the real comparison so you can decide.</p></div>
<div class="tablescroll"><table class="cmp"><thead><tr><th></th><th class="hi">Cash offer from us</th><th>Listing with an agent</th></tr></thead><tbody>
<tr><td>Offer price</td><td class="hi">Below full retail. We price in repairs and our margin.</td><td>Full market value, if it appraises and the buyer performs.</td></tr>
<tr><td>Agent commission</td><td class="hi">$0</td><td>Typically 5&ndash;6% of the sale price, split between sides</td></tr>
<tr><td>Closing costs</td><td class="hi">We cover them</td><td>Seller commonly pays 1&ndash;3%</td></tr>
<tr><td>Repairs before closing</td><td class="hi">None. We buy as-is.</td><td>Often required by the buyer's lender or negotiated after inspection</td></tr>
<tr><td>Showings</td><td class="hi">None</td><td>Ongoing, on the buyer's schedule</td></tr>
<tr><td>Time to close</td><td class="hi">${BIZ.promise.closeRangeDays}</td><td>Commonly 30&ndash;60+ days after you get an accepted offer</td></tr>
<tr><td>Risk of falling through</td><td class="hi">No financing contingency, no appraisal</td><td>Financed deals fail on appraisal, inspection, or loan denial</td></tr>
<tr><td>Carrying costs while waiting</td><td class="hi">Weeks of taxes, insurance, utilities</td><td>Months of the same, plus maintaining a showable house</td></tr>
</tbody></table></div>
<p style="margin-top:20px;font-size:.95rem;color:${BIZ.brand.muted}"><strong>The honest version:</strong> compare the net, not the headline. A $250,000 listing minus 6% commission, 2% closing costs, $12,000 in requested repairs, and four months of carrying costs is not $250,000. Sometimes it still beats our number. When it does, we will tell you.</p>
</div></section>`;
}

/* -------------------------------------------------------------- home page */
function buildHome() {
  const trail = [{ name: 'Home', url: '/' }];
  const faqs = [
    { q: 'How fast can you buy my house?', a: `We give a written no-obligation offer in as little as 24 hours, and we can close in ${BIZ.promise.closeRangeDays} depending on title and your timing. If you need it faster than that, say so on the first call and we will tell you honestly whether it is possible.` },
    { q: 'Do I pay any fees or commissions?', a: 'No. There is no commission, no listing fee, and no closing cost charged to you. What we offer is what the settlement statement starts from, before any existing mortgage, liens, or back taxes get paid off.' },
    { q: 'What kind of houses do you buy?', a: 'Single-family houses, small multifamily, and land in any condition. Vacant, occupied, tenant-filled, fire damaged, foundation problems, hoarder conditions, code violations, behind on taxes. Condition is a price input, not a disqualifier.' },
    { q: 'How do you decide what to offer?', a: 'We estimate what the house is worth repaired in your neighborhood, subtract the repair cost, subtract holding and closing costs, and subtract our margin. We show you those four numbers rather than just handing you a figure.' },
    { q: 'Are you the actual buyer?', a: `Yes. ${BIZ.legalName} buys for its own account. We are not collecting your information to shop it to a list of investors.` },
    { q: 'Where do you buy houses?', a: `We buy across ${STATES.map((s) => s.name).join(', ')}. ${BIZ.owner} is a licensed real estate agent in Georgia (#${BIZ.licenses[0].number}) and South Carolina (#${BIZ.licenses[1].number}), and we buy as a principal in the other states.` },
  ];
  const html = head({
    title: `We Buy Houses for Cash in the Southeast | ${BIZ.name}`,
    desc: mkDesc(`Sell your house fast for cash across GA, SC, FL, AL, NC and TN. Any condition, no repairs, no commissions. Offer in 24 hours, close in ${BIZ.promise.closeRangeDays}.`),
    canonical: '/',
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), { '@context': 'https://schema.org', '@type': 'WebSite', url: `${ORIGIN}/`, name: BIZ.name, publisher: { '@id': `${ORIGIN}/#business` } }],
  }) + header() + `
<div class="hero" style="--hero:url('/assets/img/hero-southeast.jpg')"><div class="wrap">
<div><div class="eyebrow">Cash offer in as little as 24 hours</div>
<h1>We buy houses for cash across the Southeast</h1>
<p class="sub">Any condition. Any situation. No repairs, no cleaning, no agent commission, and no fee taken out of your side.</p>
<ul class="herolist">
<li>Written, no-obligation offer &mdash; usually within 24 hours</li>
<li>Close in ${BIZ.promise.closeRangeDays}, on the date you choose</li>
<li>We cover closing costs. Back taxes and liens come out of proceeds.</li>
<li>Licensed GA agent #${BIZ.licenses[0].number} &middot; SC agent #${BIZ.licenses[1].number}</li>
</ul>
<div class="herocta"><a class="btn" href="#offer">Get My Cash Offer</a><a class="phonebig" href="tel:${tel}"><small>Or call / text</small>${PHONE}</a></div></div>
${form('offer', 'Get your cash offer', 'Takes about two minutes. No obligation, and we never list your house publicly.')}
</div></div>` + trustbar() + `
<section><div class="wrap narrow">${directAnswer({ name: 'the Southeast', stateCode: 'GA', county: 'Chatham' }).replace('Sell your house fast in the Southeast, GA.', 'Sell your house fast in the Southeast.').replace(' and across Chatham County', '')}</div></section>
<section><div class="wrap"><div class="sechead center"><div class="kicker">Why people call us</div><h2>The situation matters more than the house</h2>
<p>Nobody sells a house to a cash buyer because the house is the problem. They sell because of what is happening around it. Here is what we handle most.</p></div>
<div class="grid g3">${SITUATIONS.slice(0, 9).map((s) => `<a class="card" href="/situations/${s.slug}/" style="display:block;color:inherit;text-decoration:none"><h3>${esc(s.name)}</h3><p>${esc(String(s.lede).replace(/\{city\}/g, 'your city').replace(/\{county\}/g, 'your').replace(/\{state\}/g, 'your state').replace(/\{stateCode\}/g, ''))}</p><span class="more">See how it works &rarr;</span></a>`).join('')}</div>
<p style="margin-top:24px"><a class="btn btn-ghost" href="/situations/">All ${SITUATIONS.length} situations we buy in</a></p></div></section>
` + processSection() + comparison() + `
<section><div class="wrap"><div class="sechead"><div class="kicker">Where we buy</div><h2>${CITIES.length} cities across six states</h2>
<p>We started in coastal Georgia and the process is the same everywhere we go: one offer, one closing date, no fees. State law is not the same everywhere, though, so each state page covers how foreclosure, tax sales, and closings actually work there.</p></div>
<div class="grid g3">${STATES.map((s) => `<a class="card" href="/sell-my-house-fast/${s.slug}/" style="display:block;color:inherit;text-decoration:none"><h3>${esc(s.name)}</h3><p>${cityByState(s.code).length} cities &middot; ${uniq(cityByState(s.code).map((c) => c.county)).length} counties</p><p style="font-size:.9rem">${esc(s.foreclosure.type)} foreclosure. ${esc(s.closingType === 'attorney' ? 'Attorney closing state.' : 'Title company closings.')}</p><span class="more">See ${esc(s.name)} &rarr;</span></a>`).join('')}</div></div></section>
` + faqBlock(faqs) + ctaband('Find out what your house is worth to us', 'No obligation, no fee, and no pressure. If listing with an agent is the better move for you, we will say so.') + footer();
  emit('/', html, 1.0);
}

/* -------------------------------------------------------- state hub page */
function buildState(st) {
  const cities = cityByState(st.code);
  const counties = COUNTIES.filter((c) => c.stateCode === st.code);
  const trail = [{ name: 'Home', url: '/' }, { name: `Sell My House Fast in ${st.name}`, url: `/sell-my-house-fast/${st.slug}/` }];
  const faqs = [
    { q: `How fast can I sell my house for cash in ${st.name}?`, a: `We give a written offer in as little as 24 hours and close in ${BIZ.promise.closeRangeDays}. ${st.closingFact}` },
    { q: `Is ${st.name} a judicial or non-judicial foreclosure state?`, a: `${st.foreclosure.type}. ${st.foreclosure.summary} ${st.foreclosure.speed}` },
    { q: `Do I have a right of redemption after a foreclosure sale in ${st.name}?`, a: st.foreclosure.redemption },
    { q: `What happens if I do not pay property taxes in ${st.name}?`, a: `${st.taxSale.summary} ${st.taxSale.redemption}` },
    { q: `Do I need an attorney to close in ${st.name}?`, a: st.closingFact },
    { q: `Are you licensed in ${st.name}?`, a: st.licensed ? `Yes. ${BIZ.owner} holds ${st.name} real estate license #${st.licenseNumber}. Note that when we buy your house we are acting as the buyer for our own account, not as your agent.` : `${BIZ.owner} is a licensed real estate agent in Georgia and South Carolina. In ${st.name} we buy as a principal for our own account, which does not require a real estate license. We are not acting as your agent in either case.` },
  ];
  const answer = `<div class="answer"><strong>Sell your house fast in ${esc(st.name)}.</strong> ${esc(BIZ.name)} buys houses for cash in ${cities.length} ${esc(st.name)} cities across ${counties.length} counties, in any condition, with no commissions or fees. Written no-obligation offer in as little as 24 hours, closing in ${BIZ.promise.closeRangeDays}. ${esc(st.name)} uses <strong>${esc(st.foreclosure.type.toLowerCase())}</strong> foreclosure and ${esc(st.closingType === 'attorney' ? 'requires an attorney at closing' : 'uses title companies for closings')}. Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)}${st.licensed ? ` &middot; ${esc(st.name)} RE License #${st.licenseNumber}` : ''}</span></div>`;

  const html = head({
    title: mkTitle(`Sell My House Fast in ${st.name} — Cash Offer, No Fees`),
    desc: mkDesc(`We buy houses for cash across ${st.name} — ${cities.length} cities, ${counties.length} counties. Any condition, no repairs, no commissions. Offer in 24 hours.`),
    canonical: `/sell-my-house-fast/${st.slug}/`,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`Cash home buying in ${st.name}`, `We buy houses for cash throughout ${st.name} in any condition.`, { '@type': 'State', name: st.name })],
  }) + header() + crumbs(trail) + `
<section><div class="wrap"><div class="narrow"><h1>Sell your house fast in ${esc(st.name)}</h1>${answer}</div>
<div class="grid g2" style="align-items:start;margin-top:12px">
<div class="prose">
<h2>How foreclosure actually works in ${esc(st.name)}</h2>
<p>${esc(st.foreclosure.summary)} ${esc(st.foreclosure.speed)}</p>
<div class="callout warn"><p><strong>Right of redemption:</strong> ${esc(st.foreclosure.redemption)}</p><p style="margin-top:.7em">${esc(st.foreclosure.deadlineNote)}</p></div>
<h2>Delinquent property taxes in ${esc(st.name)}</h2>
<p>${esc(st.taxSale.summary)} ${esc(st.taxSale.redemption)}</p>
<h2>Closing in ${esc(st.name)}</h2>
<p>${esc(st.closingFact)} That matters for timing: ${esc(st.closingType === 'attorney' ? 'the attorney runs the title search and the disbursement, so scheduling follows their calendar' : 'the title company runs the search and the disbursement, which usually means a slightly more flexible closing calendar')}.</p>
<div class="srcs">Sources: ${st.sources.map((s) => `<a href="${s.url}" rel="nofollow noopener" target="_blank">${esc(s.label)}</a>`).join(' &middot; ')}. This is general information about ${esc(st.name)} law, not legal advice.</div>
</div>
${form(`offer-${st.slug}`, `Cash offer on your ${st.name} house`, 'Two minutes, no obligation. We buy in any condition.')}
</div></div></section>
` + trustbar() + processSection() + `
<section class="wash"><div class="wrap"><div class="sechead"><div class="kicker">${esc(st.name)} coverage</div><h2>Cities we buy houses in</h2></div>
<div class="colcloud">${cities.map((c) => `<a href="${c.url}">Sell my house fast in ${esc(c.name)}, ${c.stateCode}</a>`).join('')}</div>
<h3 style="margin-top:36px">Counties</h3><div class="links">${counties.map((c) => `<a href="${c.url}">${esc(c.name)} County</a>`).join('')}</div>
</div></section>
<section><div class="wrap"><div class="sechead"><h2>Situations we buy in across ${esc(st.name)}</h2></div>
<div class="links">${SITUATIONS.filter((s) => sitAllowed(s, st.code)).map((s) => `<a href="/situations/${s.slug}/">${esc(s.name)}</a>`).join('')}</div></div></section>
` + comparison() + faqBlock(faqs) + ctaband(`Get a cash offer on your ${st.name} house`, 'Written offer, no obligation, no fee. Any condition and any situation.') + footer();
  emit(`/sell-my-house-fast/${st.slug}/`, html, 0.9);
}

/* -------------------------------------------------------------- city page */
function buildCitySmall(city) {
  const st = stateBy[city.stateCode];
  const c = ctx(city);
  const county = COUNTIES.find((x) => x.stateCode === city.stateCode && x.name === city.county);
  const nearby = county.cities.filter((x) => x.slug !== city.slug).slice(0, 8);
  const big = county.cities.find((x) => x.tier === 1) || county.cities.find((x) => x.tier === 2);
  const trail = [{ name: 'Home', url: '/' }, { name: st.name, url: `/sell-my-house-fast/${st.slug}/` }, { name: city.name, url: city.url }];
  const pool = [
    { q: `Do you really buy houses in ${city.name}?`, a: `Yes. ${city.name} is in ${city.county} County, ${st.name}, and we buy county-wide including unincorporated addresses. Small towns are often easier for us than for an agent, because the retail buyer pool out here is thin and financed deals fall through.` },
    { q: `What does it cost me to sell my ${city.name} house?`, a: `Nothing. No commission, no listing fee, no closing costs charged to you. Your mortgage payoff, any liens, and back ${city.county} County taxes come out of the proceeds, and the rest is yours.` },
    { q: `Does the house need to be in good shape?`, a: `No. We buy in any condition, including houses that have sat empty for years. Take what you want out of it and leave the rest where it is.` },
    { q: `How fast can you close on a ${city.name} property?`, a: `${BIZ.promise.closeRangeDays} once title is clear, and as little as 7 days if you need it. ${st.closingFact}` },
    { q: `I'm behind on taxes. Can I still sell?`, a: `Yes. ${st.taxSale.summary} Delinquent ${city.county} County taxes are a lien, and liens get paid at closing from proceeds. You do not need cash up front.` },
    { q: `Do you buy land and mobile homes around ${city.name}?`, a: `We buy single-family houses, small multifamily, and land. Tell us what you have and we will tell you honestly whether it is something we can price.` },
  ];
  const k = hash(city.slug + city.stateCode) % pool.length;
  const faqs = Array.from({ length: 4 }, (_, i) => pool[(k + i) % pool.length]);
  const html = head({
    title: mkTitle(`Sell My House Fast in ${city.name}, ${city.stateCode} — Cash Offer`),
    desc: mkDesc(`We buy houses for cash in ${city.name}, ${city.stateCode} and throughout ${city.county} County — any condition, no repairs, no fees. Offer in 24 hours, close in ${BIZ.promise.closeRangeDays}.`),
    canonical: city.url,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`Cash home buying in ${city.name}, ${city.stateCode}`, `We buy houses for cash in ${city.name}, ${city.stateCode}, in any condition.`, [{ '@type': 'City', name: city.name, containedInPlace: { '@type': 'AdministrativeArea', name: `${city.county} County, ${st.name}` } }])],
  }) + header() + crumbs(trail) + `
<section><div class="wrap"><div class="grid g2" style="align-items:start">
<div class="narrow prose"><h1>Sell your house fast in ${esc(city.name)}, ${city.stateCode}</h1>
<div class="answer"><strong>Sell your house fast in ${esc(city.name)}, ${city.stateCode}.</strong> ${esc(BIZ.name)} buys houses for cash in ${esc(city.name)} and throughout ${esc(city.county)} County in any condition, with no commissions, no fees, and no repairs. Written no-obligation offer in as little as 24 hours, closing in ${BIZ.promise.closeRangeDays}. ${esc(st.closingFact)} Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(city.county)} County, ${esc(st.name)}${st.licensed ? ` &middot; ${esc(st.name)} RE License #${st.licenseNumber}` : ''}</span></div>
<p>${esc(pick(COUNTY_OPEN, city.slug + 'co')(county, st, big ? big.name : city.name))} ${esc(pick(STOCK_NOTE, city.slug + 'stock')(c))}</p>
<p>Smaller ${esc(st.name)} markets are where conventional sales stall most often. The financed buyer pool is thin, appraisals come in short of the contract, and a deal that took two months to find dies over a roof. We are paying cash, so none of that applies${big && big.name !== city.name ? `, and we are already working in ${esc(big.name)} and the rest of ${esc(city.county)} County` : ''}.</p>
<div class="callout"><p><strong>${esc(st.name)}, in one line:</strong> ${esc(st.foreclosure.type)} foreclosure. ${esc(st.foreclosure.redemption)}</p>
<p style="margin-top:.6em"><a href="/sell-my-house-fast/${st.slug}/">Full ${esc(st.name)} timelines and tax sale rules &rarr;</a></p></div>
</div>
${form('offer', `Cash offer on your ${city.name} house`, 'Two minutes, no obligation, any condition.', `${city.name}, ${city.stateCode}`)}
</div></div></section>
` + trustbar() + faqBlock(faqs) + `
<section class="wash"><div class="wrap">
${linkCloud(`Also buying in ${county.name} County`, nearby.map((n) => ({ name: `${n.name}, ${n.stateCode}`, url: n.url })))}
<h3 style="margin-top:28px">Situations we buy in</h3>
<div class="links">${SITUATIONS.filter((x) => sitAllowed(x, st.code)).slice(0, 10).map((x) => `<a href="/situations/${x.slug}/${st.slug}/">${esc(x.name)} in ${esc(st.name)}</a>`).join('')}</div>
<p style="margin-top:18px"><a href="${county.url}">All of ${esc(county.name)} County &rarr;</a> &middot; <a href="/sell-my-house-fast/${st.slug}/">All ${esc(st.name)} cities &rarr;</a></p>
</div></section>
` + ctaband(`Get a cash offer on your ${city.name} house`, 'No obligation, no fee, no repairs. Any condition.') + footer();
  emit(city.url, html, 0.6);
}

function buildCity(city) {
  if (city.tier === 3) return buildCitySmall(city);
  const st = stateBy[city.stateCode];
  const c = ctx(city);
  const county = COUNTIES.find((x) => x.stateCode === city.stateCode && x.name === city.county);
  const nearby = county.cities.filter((x) => x.slug !== city.slug).slice(0, 8);
  const sits = SITUATIONS.filter((s) => sitAllowed(s, st.code));
  const mySits = city.tier === 1 ? T1SITS.filter((s) => sitAllowed(s, st.code)) : [];
  const trail = [
    { name: 'Home', url: '/' },
    { name: st.name, url: `/sell-my-house-fast/${st.slug}/` },
    { name: city.name, url: city.url },
  ];
  const faqPool = [
    { q: `How fast can you buy my house in ${city.name}?`, a: `A written no-obligation offer in as little as 24 hours, and closing in ${BIZ.promise.closeRangeDays} once title is clear. ${st.closingFact}` },
    { q: `Do you buy houses in ${city.name} that need repairs?`, a: `Yes, in any condition. Roof, foundation, plumbing, fire damage, mold, hoarder conditions. We price the repairs into the offer and do the work after closing. You fix nothing.` },
    { q: `What fees do I pay selling my ${city.name} house to you?`, a: `None. No commission, no listing fee, no closing costs charged to you. Existing mortgage payoffs, liens, and back ${city.county} County taxes come out of the proceeds, and whatever is left is yours.` },
    { q: `I'm behind on payments. How long do I have in ${st.name}?`, a: `${st.foreclosure.summary} ${st.foreclosure.redemption}` },
    { q: `Can I sell a ${city.name} house with back property taxes?`, a: `Yes. ${st.taxSale.summary} Delinquent taxes are a lien and get paid at closing out of proceeds, so you do not need cash up front to clear them.` },
    { q: `Do you actually buy in ${city.name}, or just collect leads?`, a: `${BIZ.legalName} buys for its own account. ${st.licensed ? `${BIZ.owner} holds ${st.name} real estate license #${st.licenseNumber}.` : `${BIZ.owner} is a licensed agent in Georgia and South Carolina; in ${st.name} we buy as a principal.`} We are the buyer, not a lead broker.` },
    { q: `Will you buy a ${city.name} house with tenants in it?`, a: `Yes, including tenants who have stopped paying. The lease transfers with the property and we become the landlord at closing. No eviction first, and no showings for your tenant to sit through.` },
    { q: `Who handles the closing in ${city.county} County?`, a: `${st.closingFact} The deed is recorded with ${city.county} County. In practice that calendar is usually what sets the closing date, not us.` },
    { q: `Do I have to clean out the house?`, a: `No. Take what matters to you and leave the rest, furniture included. We handle removal after closing, and we do not photograph the inside or hold showings.` },
    { q: `How do you decide what to offer on a ${city.name} house?`, a: `Four numbers: what the house is worth repaired in your neighborhood, the repair cost, holding and closing costs, and our margin. We walk you through all four so you can check the math instead of taking a figure on faith.` },
    { q: `Can I sell if I inherited a house in ${city.name}?`, a: `Yes, once the estate has a court-appointed executor or administrator with authority to sign the deed. We can make the offer before that appointment issues and hold it while probate catches up.` },
    { q: `What if the utilities are off?`, a: `Not a problem. We do not need power or water to make an offer or to close on a ${city.name} property. A financed buyer's appraiser generally does, which is one more reason those deals stall.` },
  ];
  const faqStart = hash(city.slug + city.stateCode + 'faq') % faqPool.length;
  const faqStride = 5 + (hash(city.slug + 'stride') % 3) * 2; // 5, 7 or 9 — all coprime with 12
  const faqs = Array.from({ length: 6 }, (_, i) => faqPool[(faqStart + i * faqStride) % faqPool.length]);
  const angle = pick(HERO_ANGLE, city.slug + city.stateCode)(c);
  const local = pick(WHY_LOCAL, city.slug + 'x')(c, st);

  const html = head({
    title: mkTitle(`Sell My House Fast in ${city.name}, ${city.stateCode} — Cash Offer`),
    desc: mkDesc(`We buy houses for cash in ${city.name}, ${city.stateCode} and ${city.county} County. Any condition, no repairs, no fees. Offer in 24 hours, close in ${BIZ.promise.closeRangeDays}.`),
    canonical: city.url,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`Cash home buying in ${city.name}, ${city.stateCode}`, `We buy houses for cash in ${city.name}, ${city.stateCode} in any condition, with no fees or commissions.`, [{ '@type': 'City', name: city.name, containedInPlace: { '@type': 'AdministrativeArea', name: `${city.county} County, ${st.name}` } }])],
  }) + header() + crumbs(trail) + `
<div class="hero" style="--hero:url('/assets/img/hero-${st.slug}.jpg')"><div class="wrap">
<div><div class="eyebrow">${esc(city.county)} County &middot; ${esc(st.name)}</div>
<h1>Sell your house fast in ${esc(city.name)}, ${city.stateCode}</h1>
<p class="sub">${esc(angle)}</p>
<ul class="herolist">
<li>Written offer in as little as 24 hours</li>
<li>Close in ${BIZ.promise.closeRangeDays}, your date</li>
<li>Back ${esc(city.county)} County taxes and liens paid from proceeds</li>
<li>${st.licensed ? `${esc(st.name)} RE License #${st.licenseNumber}` : `Buying as principal in ${esc(st.name)}`}</li>
</ul>
<div class="herocta"><a class="btn" href="#offer">Get My Cash Offer</a><a class="phonebig" href="tel:${tel}"><small>Or call / text</small>${PHONE}</a></div></div>
${form(`offer`, `Cash offer on your ${city.name} house`, 'Two minutes. No obligation, and we never list your house publicly.', `${city.name}, ${city.stateCode}`)}
</div></div>` + trustbar() + `
<section><div class="wrap"><div class="narrow">${directAnswer(city)}
<div class="prose">
<h2>What selling in ${esc(city.name)} actually involves</h2>
<p>${esc(local)}${city.anchor ? ` ${esc(city.name)} is known for ${esc(city.anchor)}, and that shapes the kind of houses we see here.` : ''} ${esc(pick(STOCK_NOTE, city.slug + 'stock')(c))}</p>
<p>${esc(pick(MARKET_NOTE, city.slug + city.county + 'm')(c))}</p>
<p>Selling to us skips the parts that cost you time and money: no listing, no showings, no appraisal, no inspection contingency, and no repair negotiation after an inspector writes his report. We are paying cash, so there is no lender deciding whether your house qualifies.</p>
<div class="callout"><p><strong>${esc(st.name)} foreclosure, in one paragraph:</strong> ${esc(st.foreclosure.summary)} ${esc(st.foreclosure.redemption)}</p>
<p style="margin-top:.7em"><a href="/sell-my-house-fast/${st.slug}/"><strong>Full ${esc(st.name)} timeline and tax sale rules &rarr;</strong></a></p></div>
</div></div></div></section>
` + (mySits.length ? `<section class="wash"><div class="wrap"><div class="sechead"><div class="kicker">Why ${esc(city.name)} owners call</div><h2>${esc(pick(["The situations we solve most","What brings people to us","Why owners here sell for cash","The problems behind most sales"], city.slug + "h2"))} in ${esc(city.name)}</h2></div>
<div class="grid g3">${mySits.map((s) => `<a class="card" href="${city.url}${s.slug}/" style="display:block;color:inherit;text-decoration:none"><h3>${esc(fill(s.name, c))}</h3><p>${esc(fill(s.lede, c))}</p><span class="more">${esc(s.name)} in ${esc(city.name)} &rarr;</span></a>`).join('')}</div></div></section>` : `<section class="wash"><div class="wrap"><div class="sechead"><h2>Situations we buy in around ${esc(city.name)}</h2></div>
<div class="links">${sits.map((s) => `<a href="/situations/${s.slug}/">${esc(s.name)}</a>`).join('')}</div></div></section>`)
    + processSection() + comparison(city.name) + faqBlock(faqs) + `
<section><div class="wrap">
${linkCloud(`Also buying in ${county.name} County`, nearby.map((n) => ({ name: `${n.name}, ${n.stateCode}`, url: n.url })))}
<p style="margin-top:18px"><a href="${county.url}">All of ${esc(county.name)} County &rarr;</a> &nbsp;&middot;&nbsp; <a href="/sell-my-house-fast/${st.slug}/">All ${esc(st.name)} cities &rarr;</a></p>
</div></section>
` + ctaband(`Get a cash offer on your ${city.name} house`, `No obligation, no fee, no repairs. If listing with an agent nets you more, we will tell you.`) + footer();
  emit(city.url, html, city.tier === 1 ? 0.9 : 0.7);
}


/* ------------------------------------------------ situation x state page */
function buildSituationState(sit, st) {
  const url = `/situations/${sit.slug}/${st.slug}/`;
  const cities = cityByState(st.code);
  const cc = { city: `your ${st.name} city`, county: 'your', state: st.name, stateCode: st.code,
    closingPro: st.closingType === 'attorney' ? `a ${st.name} closing attorney` : 'a title company',
    closingProCap: st.closingType === 'attorney' ? `A ${st.name} closing attorney` : 'A title company',
    foreclosureType: st.foreclosure.type.toLowerCase(), foreclosureSummary: st.foreclosure.summary,
    foreclosureSpeed: st.foreclosure.speed, redemptionFact: st.foreclosure.redemption,
    deadlineNote: st.foreclosure.deadlineNote, taxSaleSummary: st.taxSale.summary, taxSaleRedemption: st.taxSale.redemption };
  const trail = [{ name: 'Home', url: '/' }, { name: 'Situations', url: '/situations/' },
    { name: sit.name, url: `/situations/${sit.slug}/` }, { name: st.name, url }];
  const faqs = [
    ...sit.faqs.slice(0, 3).map((f) => ({ q: fill(f.q, cc).replace(/ in your \w+ city/g, ` in ${st.name}`).replace(/your County/g, 'your county'), a: fill(f.a, cc).replace(/ in your \w+ city/g, ` in ${st.name}`).replace(/your County/g, 'your county') })),
    { q: `Does ${st.name} law change how this works?`, a: `${st.foreclosure.summary} ${st.foreclosure.redemption} ${st.closingFact}` },
    { q: `What is the redemption period in ${st.name}?`, a: `${st.foreclosure.redemption} Separately, ${st.taxSale.redemption.charAt(0).toLowerCase()}${st.taxSale.redemption.slice(1)}` },
    { q: `Who handles the closing in ${st.name}?`, a: `${st.closingFact} That scheduling constraint is usually what sets the closing date, more than the buyer's timeline.` },
  ];
  const html = head({
    title: mkTitle(`${sit.name} in ${st.name} — Sell As-Is for Cash`),
    desc: mkDesc(`${sit.name} in ${st.name}? ${st.name} uses ${st.foreclosure.type.toLowerCase()} foreclosure and ${st.closingType === 'attorney' ? 'requires an attorney at closing' : 'closes through title companies'}. We buy as-is for cash, no repairs or fees.`),
    canonical: url,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`${sit.name} cash home buying in ${st.name}`, fill(sit.lede, cc), { '@type': 'State', name: st.name })],
  }) + header() + crumbs(trail) + `
<section><div class="wrap"><div class="grid g2" style="align-items:start">
<div class="narrow prose"><h1>${esc(sit.name)} in ${esc(st.name)}</h1>
<div class="answer"><strong>${esc(sit.name)} in ${esc(st.name)}?</strong> ${esc(BIZ.name)} buys ${esc(st.name)} houses from owners who ${esc(sit.verb)}, as-is and for cash, with no commissions, fees, or repairs. ${esc(st.name)} uses <strong>${esc(st.foreclosure.type.toLowerCase())}</strong> foreclosure and ${esc(st.closingType === 'attorney' ? 'requires a licensed attorney at closing' : 'closes through title companies')}. Written no-obligation offer in as little as 24 hours, closing in ${BIZ.promise.closeRangeDays}. Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)}${st.licensed ? ` &middot; ${esc(st.name)} RE License #${st.licenseNumber}` : ` &middot; buying as principal in ${esc(st.name)}`}</span></div>
<h2>What is actually happening</h2><p>${esc(fill(sit.mechanics, cc))}</p><p>${esc(fill(sit.cost, cc))}</p>
<h2>What ${esc(st.name)} law adds to it</h2>
<p>${esc(st.foreclosure.summary)} ${esc(st.foreclosure.speed)}</p>
<div class="callout warn"><p><strong>Redemption:</strong> ${esc(st.foreclosure.redemption)}</p><p style="margin-top:.7em">${esc(st.foreclosure.deadlineNote)}</p></div>
<p>${esc(st.taxSale.summary)} ${esc(st.taxSale.redemption)}</p>
<p>${esc(st.closingFact)}</p>
<h2>Why owners in this position sell for cash</h2><p>${esc(fill(sit.whyCash, cc))}</p>
<div class="callout"><p><strong>Worth knowing:</strong> ${esc(fill(sit.watchOut, cc))}</p></div>
<div class="srcs">Sources: ${st.sources.map((x) => `<a href="${x.url}" rel="nofollow noopener" target="_blank">${esc(x.label)}</a>`).join(' &middot; ')}. General information about ${esc(st.name)} law, not legal advice.</div>
</div>
${form('offer', `${sit.name} in ${st.name}?`, 'Tell us what is going on. Two minutes, no obligation.', st.name)}
</div></div></section>
` + trustbar() + processCompact() + faqBlock(faqs) + `
<section class="wash"><div class="wrap"><h3>${esc(sit.name)} by city in ${esc(st.name)}</h3>
<div class="colcloud">${cities.map((x) => `<a href="${x.tier === 1 && sit.tier === 1 ? `${x.url}${sit.slug}/` : x.url}">${esc(x.name)}, ${x.stateCode}</a>`).join('')}</div>
<h3 style="margin-top:32px">${esc(sit.name)} in other states</h3>
<div class="links">${STATES.filter((o) => o.code !== st.code && sitAllowed(sit, o.code)).map((o) => `<a href="/situations/${sit.slug}/${o.slug}/">${esc(o.name)}</a>`).join('')}</div>
<p style="margin-top:18px"><a href="/situations/${sit.slug}/">${esc(sit.name)} overview &rarr;</a> &middot; <a href="/sell-my-house-fast/${st.slug}/">Selling in ${esc(st.name)} &rarr;</a></p>
</div></section>
` + ctaband(`${sit.name} in ${st.name}? Get a number.`, 'Written cash offer, no obligation, no fee, no repairs.') + footer();
  emit(url, html, 0.8);
}

/* ------------------------------------------------- situation x city page */
function buildSituationCity(city, sit) {
  const st = stateBy[city.stateCode];
  const c = ctx(city);
  const url = `${city.url}${sit.slug}/`;
  const county = COUNTIES.find((x) => x.stateCode === city.stateCode && x.name === city.county);
  const nearby = county.cities.filter((x) => x.slug !== city.slug).slice(0, 6);
  const trail = [
    { name: 'Home', url: '/' }, { name: st.name, url: `/sell-my-house-fast/${st.slug}/` },
    { name: city.name, url: city.url }, { name: sit.name, url },
  ];
  // city-keyed FAQ slice, so no two cities carry the same set
  const pool = sit.faqs.map((f) => ({ q: fill(f.q, c), a: fill(f.a, c) }));
  const st0 = hash(city.slug + sit.slug) % pool.length;
  const faqs = Array.from({ length: Math.min(3, pool.length) }, (_, i) => pool[(st0 + i) % pool.length]);
  const h1 = fill(sit.h1, c);

  const html = head({
    title: mkTitle(h1),
    desc: mkDesc(`${sit.name} in ${city.name}, ${city.stateCode}? We buy ${city.county} County houses as-is for cash — no repairs, no cleanout, no fees. Offer in 24 hours, close in ${BIZ.promise.closeRangeDays}.`),
    canonical: url,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`${sit.name} cash home buying in ${city.name}, ${city.stateCode}`, `${sit.name} in ${city.name}, ${city.stateCode}. We buy as-is for cash.`, [{ '@type': 'City', name: city.name }])],
  }) + header() + crumbs(trail) + `
<div class="hero" style="--hero:url('/assets/img/hero-${st.slug}.jpg')"><div class="wrap">
<div><div class="eyebrow">${esc(sit.name)} &middot; ${esc(city.county)} County</div>
<h1>${esc(h1)}</h1>
<p class="sub">${esc(pick(HERO_ANGLE, city.slug + sit.slug)(c))}</p>
<ul class="herolist"><li>We buy as-is &mdash; you fix nothing</li><li>Written offer in as little as 24 hours</li><li>Close in ${BIZ.promise.closeRangeDays}, your date</li><li>No commissions, no fees, no closing costs to you</li></ul>
<div class="herocta"><a class="btn" href="#offer">Get My Cash Offer</a><a class="phonebig" href="tel:${tel}"><small>Or call / text</small>${PHONE}</a></div></div>
${form('offer', `Cash offer &mdash; ${city.name}`, 'Tell us what is going on. Two minutes, no obligation.', `${city.name}, ${city.stateCode}`)}
</div></div>` + trustbar() + `
<section><div class="wrap"><div class="narrow">
<div class="answer"><strong>${esc(h1)}.</strong> ${esc(BIZ.name)} buys houses in ${esc(city.name)} and across ${esc(city.county)} County from owners who ${esc(sit.verb)} &mdash; as-is, any condition, no commissions, no fees, no repairs and no cleanout. Written no-obligation offer in as little as 24 hours, closing in ${BIZ.promise.closeRangeDays} on a date you pick. ${esc(st.closingFact)} Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(city.county)} County, ${esc(st.name)}${st.licensed ? ` &middot; ${esc(st.name)} RE License #${st.licenseNumber}` : ''}</span></div>
<div class="prose">
<p>${esc(pick(WHY_LOCAL, city.slug + sit.slug + 'w')(c, st))} ${esc(pick(STOCK_NOTE, city.slug + sit.slug + 's')(c))}</p>
<div class="callout"><p><strong>How ${esc(st.name)} law applies:</strong> ${esc(st.foreclosure.summary)}</p>
<p style="margin-top:.7em"><a href="/situations/${sit.slug}/${st.slug}/"><strong>${esc(sit.name)} in ${esc(st.name)} &mdash; the full rules, timelines and redemption periods &rarr;</strong></a></p></div>
<h2>Selling this kind of property around ${esc(city.name)}</h2>
<p>${esc(fill(sit.whyCash, c))}</p>
<p>We buy across ${esc(city.county)} County, not just ${esc(city.name)}${nearby.length ? `, including ${nearby.map((n) => n.name).join(', ')}` : ''}. Back ${esc(city.county)} County taxes, liens, and mortgage payoffs are settled from the closing proceeds, so nothing has to be paid up front.</p>
<div class="callout warn"><p><strong>Worth knowing:</strong> ${esc(fill(sit.watchOut, c))}</p></div>
</div></div></div></section>
` + faqBlock(faqs) + `
<section class="wash"><div class="wrap">
<h3>Other situations we buy in around ${esc(city.name)}</h3>
<div class="links">${SITUATIONS.filter((x) => x.slug !== sit.slug && sitAllowed(x, st.code)).map((x) => (x.tier === 1 && city.tier === 1 ? `<a href="${city.url}${x.slug}/">${esc(x.name)} in ${esc(city.name)}</a>` : `<a href="/situations/${x.slug}/${st.slug}/">${esc(x.name)} in ${esc(st.name)}</a>`)).join('')}</div>
${linkCloud(`${sit.name} nearby in ${county.name} County`, nearby.map((n) => ({ name: `${n.name}, ${n.stateCode}`, url: n.tier === 1 && sit.tier === 1 ? `${n.url}${sit.slug}/` : n.url })))}
<p style="margin-top:18px"><a href="${city.url}">Everything about selling in ${esc(city.name)} &rarr;</a> &middot; <a href="/situations/${sit.slug}/${st.slug}/">${esc(sit.name)} across ${esc(st.name)} &rarr;</a></p>
</div></section>
` + ctaband(`${sit.name} in ${city.name}? Get a number today.`, 'No obligation and no fee. We will show you how we got to the offer.') + footer();
  emit(url, html, 0.8);
}

/* ---------------------------------------------------- situation hub page */
function buildSituationHub(sit) {
  const states = STATES.filter((s) => sitAllowed(sit, s.code));
  const cities = T1CITIES.filter((c) => sitAllowed(sit, c.stateCode));
  const gc = { city: 'your city', county: 'your', state: 'your state', stateCode: '', closingPro: 'a closing attorney or title company', closingProCap: 'A closing attorney or title company', foreclosureType: 'its own foreclosure process', foreclosureSummary: '', foreclosureSpeed: '', redemptionFact: '', deadlineNote: '', taxSaleSummary: '', taxSaleRedemption: '' };
  const trail = [{ name: 'Home', url: '/' }, { name: 'Situations', url: '/situations/' }, { name: sit.name, url: `/situations/${sit.slug}/` }];
  const faqs = sit.faqs.map((f) => ({ q: fill(f.q, gc).replace(/ in your city/g, '').replace(/ in your state/g, ''), a: fill(f.a, gc).replace(/ in your city/g, '').replace(/ in your state/g, '') }));
  const html = head({
    title: mkTitle(`${sit.name} — Sell the House As-Is for Cash`),
    desc: mkDesc(`${fill(sit.lede, gc)} We buy as-is for cash across GA, SC, FL, AL, NC and TN — no repairs, no fees, offer in 24 hours.`),
    canonical: `/situations/${sit.slug}/`,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`${sit.name} cash home buying`, fill(sit.lede, gc), states.map((s) => ({ '@type': 'State', name: s.name })))],
  }) + header() + crumbs(trail) + `
<div class="hero" style="--hero:url('/assets/img/hero-southeast.jpg')"><div class="wrap">
<div><div class="eyebrow">${esc(sit.name)}</div>
<h1>${esc(sit.name)}? We buy the house as-is.</h1>
<p class="sub">${esc(fill(sit.lede, gc))}</p>
<ul class="herolist"><li>No repairs, no cleanout, no showings</li><li>Written offer in as little as 24 hours</li><li>Close in ${BIZ.promise.closeRangeDays}</li><li>Buying across ${states.map((s) => s.code).join(', ')}</li></ul>
<div class="herocta"><a class="btn" href="#offer">Get My Cash Offer</a><a class="phonebig" href="tel:${tel}"><small>Or call / text</small>${PHONE}</a></div></div>
${form('offer', 'Get your cash offer', 'Tell us what is going on. Two minutes, no obligation.')}
</div></div>` + trustbar() + `
<section><div class="wrap"><div class="narrow">
<div class="answer"><strong>${esc(sit.name)}?</strong> ${esc(BIZ.name)} buys houses from owners who ${esc(sit.verb)} across ${states.map((x) => x.name).join(', ')} &mdash; as-is, in any condition, with no commissions, fees, or repairs. ${esc(fill(sit.whyCash, gc).split('. ')[0])}. Written no-obligation offer in as little as 24 hours, closing in ${BIZ.promise.closeRangeDays} on a date you choose. Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(BIZ.hq.locality)}, ${BIZ.hq.region} &middot; GA RE #${BIZ.licenses[0].number} &middot; SC RE #${BIZ.licenses[1].number}</span></div>
<div class="prose">
<h2>What is actually happening</h2><p>${esc(fill(sit.mechanics, gc))}</p><p>${esc(fill(sit.cost, gc))}</p>
<h2>Why a cash sale fits this situation</h2><p>${esc(fill(sit.whyCash, gc))}</p>
<div class="callout warn"><p><strong>Worth knowing:</strong> ${esc(fill(sit.watchOut, gc))}</p></div>
<h2>The rules are not the same in every state</h2>
<p>Foreclosure, tax sales, and closings work differently in each state we buy in, and that changes how much time you actually have. Pick your state for the specifics.</p>
<div class="links" style="margin-bottom:1.2em">${states.map((s) => `<a href="/sell-my-house-fast/${s.slug}/">${esc(s.name)}: ${esc(s.foreclosure.type)}</a>`).join('')}</div>
</div></div></div></section>
` + processSection() + comparison() + faqBlock(faqs) + `
<section><div class="wrap"><div class="sechead"><h2>${esc(sit.name)} by city</h2></div>
<div class="colcloud">${cities.map((c) => `<a href="${sit.tier === 1 ? `${c.url}${sit.slug}/` : c.url}">${esc(sit.name)} &mdash; ${esc(c.name)}, ${c.stateCode}</a>`).join('')}</div>
<h3 style="margin-top:34px">Other situations</h3><div class="links">${SITUATIONS.filter((s) => s.slug !== sit.slug).map((s) => `<a href="/situations/${s.slug}/">${esc(s.name)}</a>`).join('')}</div>
</div></section>
` + ctaband('Get a cash offer on the property', 'No obligation, no fee, no repairs, no cleanout.') + footer();
  emit(`/situations/${sit.slug}/`, html, 0.85);
}

/* ------------------------------------------------------- county hub page */
function buildCounty(co) {
  const st = stateBy[co.stateCode];
  const trail = [{ name: 'Home', url: '/' }, { name: st.name, url: `/sell-my-house-fast/${st.slug}/` }, { name: `${co.name} County`, url: co.url }];
  const faqs = [
    { q: `Do you buy houses anywhere in ${co.name} County?`, a: `Yes, anywhere in ${co.name} County, ${st.name}. We currently have dedicated pages for ${co.cities.map((c) => c.name).join(', ')}, and we buy in the unincorporated parts of the county too.` },
    { q: `Who handles closing in ${co.name} County?`, a: `${st.closingFact} Deeds are recorded with the ${co.name} County clerk or register of deeds.` },
    { q: `Can I sell a ${co.name} County house with delinquent taxes?`, a: `Yes. ${st.taxSale.summary} ${st.taxSale.redemption} At closing the delinquent balance is paid from proceeds, so you need no cash up front.` },
    { q: `How does foreclosure work in ${co.name} County?`, a: `${co.name} County follows ${st.name} law: ${st.foreclosure.summary} ${st.foreclosure.redemption}` },
  ];
  const html = head({
    title: mkTitle(`We Buy Houses in ${co.name} County, ${co.stateCode} — Cash Offer`),
    desc: mkDesc(`Cash home buyer covering all of ${co.name} County, ${st.name} — ${co.cities.map((c) => c.name).slice(0, 4).join(', ')} and more. No repairs, no fees, offer in 24 hours.`),
    canonical: co.url,
    jsonld: [orgLD(), crumbLD(trail), faqLD(faqs), serviceLD(`Cash home buying in ${co.name} County, ${co.stateCode}`, `We buy houses for cash throughout ${co.name} County, ${st.name}.`, [{ '@type': 'AdministrativeArea', name: `${co.name} County, ${st.name}` }])],
  }) + header() + crumbs(trail) + `
<section><div class="wrap"><div class="narrow"><h1>We buy houses in ${esc(co.name)} County, ${co.stateCode}</h1>
<div class="answer"><strong>Sell your house fast in ${esc(co.name)} County, ${co.stateCode}.</strong> ${esc(BIZ.name)} buys houses for cash throughout ${esc(co.name)} County in any condition, with no commissions, fees, or repairs. Written no-obligation offer in as little as 24 hours, closing in ${BIZ.promise.closeRangeDays}. ${esc(st.closingFact)} Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)}${st.licensed ? ` &middot; ${esc(st.name)} RE License #${st.licenseNumber}` : ''}</span></div></div>
<div class="grid g2" style="align-items:start">
<div class="prose"><p>${esc(pick(COUNTY_OPEN, co.slug + co.stateCode)(co, st, (co.cities.find((x) => x.tier === 1) || co.cities[0]).name))}</p>
<h2>Cities and towns we cover</h2>
<div class="links" style="margin-bottom:1.5em">${co.cities.map((c) => `<a href="${c.url}">${esc(c.name)}</a>`).join('')}</div>
<h2>What ${esc(st.name)} law means for ${esc(co.name)} County owners</h2>
<p>${esc(st.foreclosure.summary)} ${esc(st.foreclosure.speed)}</p>
<div class="callout warn"><p>${esc(st.foreclosure.redemption)}</p></div>
<p>${esc(st.taxSale.summary)} ${esc(st.taxSale.redemption)}</p>
<p><a href="/sell-my-house-fast/${st.slug}/"><strong>Full ${esc(st.name)} guide &rarr;</strong></a></p></div>
${form('offer', `Cash offer in ${co.name} County`, 'Two minutes, no obligation, any condition.', `${co.name} County, ${co.stateCode}`)}
</div></div></section>
` + trustbar() + processCompact() + faqBlock(faqs) + ctaband(`Selling in ${co.name} County?`, 'Get a written cash offer with no obligation and no fee.') + footer();
  emit(co.url, html, 0.65);
}

/* ------------------------------------------------------------ index pages */
function buildIndex(url, title, desc, h1, intro, sections, priority = 0.8, answer = '') {
  const trail = [{ name: 'Home', url: '/' }, { name: h1, url }];
  const html = head({ title: mkTitle(title.split(' | ')[0]), desc: mkDesc(desc), canonical: url, jsonld: [orgLD(), crumbLD(trail)] }) + header() + crumbs(trail) + `
<section><div class="wrap"><div class="sechead"><h1>${esc(h1)}</h1><p>${intro}</p></div>
<div class="narrow"><div class="answer">${answer}<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(BIZ.hq.locality)}, ${BIZ.hq.region} &middot; GA RE #${BIZ.licenses[0].number} &middot; SC RE #${BIZ.licenses[1].number} &middot; ${PHONE}</span></div></div>
${sections}</div></section>
` + trustbar() + ctaband('Ready for a number on your house?', 'Written offer in as little as 24 hours. No obligation, no fee.') + footer();
  emit(url, html, priority);
}

/* ------------------------------------------------------------ guide pages */
function buildGuide(g) {
  const trail = [{ name: 'Home', url: '/' }, { name: 'Guides', url: '/guides/' }, { name: g.title, url: `/guides/${g.slug}/` }];
  const st = g.stateCode ? stateBy[g.stateCode] : null;
  const faqs = g.faqs || [];
  const body = g.sections.map((s) => `<h2>${esc(s.h)}</h2>${(s.p || []).map((p) => `<p>${p}</p>`).join('')}${s.list ? `<ul>${s.list.map((li) => `<li>${li}</li>`).join('')}</ul>` : ''}${s.callout ? `<div class="callout ${s.warn ? 'warn' : ''}"><p>${s.callout}</p></div>` : ''}`).join('');
  const html = head({
    title: mkTitle(g.title),
    desc: mkDesc(g.desc),
    canonical: `/guides/${g.slug}/`,
    jsonld: [orgLD(), crumbLD(trail), ...(faqs.length ? [faqLD(faqs)] : []), {
      '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.desc,
      author: { '@type': 'Person', name: BIZ.owner }, publisher: { '@id': `${ORIGIN}/#business` },
      mainEntityOfPage: `${ORIGIN}/guides/${g.slug}/`,
    }],
  }) + header() + crumbs(trail) + `
<section><div class="wrap"><div class="grid g2" style="align-items:start">
<div class="narrow prose"><h1>${esc(g.title)}</h1>
<div class="answer">${g.answer}<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(BIZ.hq.locality)}, ${BIZ.hq.region} &middot; ${PHONE}</span></div>
${body}
${st ? `<div class="srcs">Sources: ${st.sources.map((s) => `<a href="${s.url}" rel="nofollow noopener" target="_blank">${esc(s.label)}</a>`).join(' &middot; ')}. General information about ${esc(st.name)} law, not legal advice.</div>` : '<div class="srcs">General information, not legal, tax, or financial advice. Confirm your situation with a licensed professional in your state.</div>'}
</div>
${form('offer', 'Get your cash offer', 'Any condition, any situation. Two minutes.')}
</div></div></section>
` + trustbar() + faqBlock(faqs) + `
<section class="wash"><div class="wrap"><h3>Related guides</h3><div class="links">${GUIDES.filter((x) => x.slug !== g.slug).slice(0, 12).map((x) => `<a href="/guides/${x.slug}/">${esc(x.title)}</a>`).join('')}</div></div></section>
` + ctaband('Want a real number instead of an estimate?', 'Written cash offer, no obligation, no fee.') + footer();
  emit(`/guides/${g.slug}/`, html, 0.7);
}

/* ------------------------------------------------------------ core pages */
function buildCore() {
  // How it works
  buildIndex('/how-it-works/', `How Selling Your House for Cash Works | ${BIZ.name}`,
    `Our four-step process: tell us about the house, we run numbers, you get a written offer in 24 hours, you pick the closing date. No fees, no repairs.`,
    'How it works', `Four steps. No listing, no showings, no repairs, and no fee taken out of your side. Here is exactly what happens from the first call to the wire hitting your account.`,
    `<div class="grid g4" style="margin-bottom:40px">${PROCESS.map((p, i) => `<div class="step"><div class="stepnum">${i + 1}</div><h3>${esc(p[0])}</h3><p>${esc(p[1])}</p></div>`).join('')}</div>
<div class="narrow prose"><h2>How we build the offer</h2>
<p>There is no secret to it. Four numbers:</p>
<ul><li><strong>After-repair value.</strong> What the house sells for in your neighborhood once it is fixed up, based on recent comparable sales.</li>
<li><strong>Repair cost.</strong> What it takes to get it there. Roof, HVAC, systems, cosmetics.</li>
<li><strong>Holding and closing costs.</strong> Taxes, insurance, utilities, and closing on both ends while we own it.</li>
<li><strong>Our margin.</strong> We are a business. We do not pretend otherwise.</li></ul>
<p>Offer equals after-repair value, minus repairs, minus holding and closing, minus margin. We walk you through all four so you can check our math rather than take a number on faith.</p>
<h2>What you never pay</h2>
<ul><li>No agent commission, on either side</li><li>No listing or marketing fee</li><li>No closing costs charged to you</li><li>No repair credits or inspection renegotiation</li><li>No cleanout or junk removal cost</li></ul>
<h2>What comes out of proceeds</h2>
<p>Your existing mortgage payoff, any liens, delinquent property taxes, HOA balances, and prorated current-year taxes. These are debts attached to the property, and they get paid at closing whether you sell to us or to anyone else. Whatever is left after them is yours.</p>
<h2>When you should not sell to us</h2>
<p>If your house is in good condition, you can wait 60 to 90 days, and you can keep it showable, listing with a good local agent will usually net you more even after commission. We will tell you that on the call. We would rather be the right answer sometimes than the wrong answer always.</p></div>`,
    0.8,
    `<strong>Selling to ${esc(BIZ.name)} takes four steps.</strong> You tell us about the house, we run the numbers, you get a written no-obligation offer in as little as 24 hours, and you pick the closing date &mdash; typically ${BIZ.promise.closeRangeDays}. There is no commission, no listing fee, and no closing cost charged to you. The offer is built from four figures we show you: after-repair value, repair cost, holding and closing costs, and our margin.`);

  // Situations index
  buildIndex('/situations/', `Situations We Buy Houses In | ${BIZ.name}`,
    `Inherited, foreclosure, back taxes, divorce, tired landlord, fire damage, foundation problems, hoarder houses, code violations and more. We buy as-is for cash.`,
    'Situations we buy in', `People do not sell to a cash buyer because the house is the problem. They sell because of what is happening around it. These are the ${SITUATIONS.length} situations we handle most.`,
    `<div class="grid g3">${SITUATIONS.map((s) => `<a class="card" href="/situations/${s.slug}/" style="display:block;color:inherit;text-decoration:none"><h3>${esc(s.name)}</h3><p>${esc(String(s.lede).replace(/\{city\}/g, 'your city').replace(/\{county\}/g, 'your').replace(/\{state\}/g, 'your state').replace(/\{stateCode\}/g, '').replace(/ in your city/g, '').replace(/your County/g, 'your'))}</p><span class="more">Read more &rarr;</span></a>`).join('')}</div>`, 0.85,
    `<strong>${esc(BIZ.name)} buys houses in ${SITUATIONS.length} common situations</strong> &mdash; inherited and probate property, pre-foreclosure, delinquent property taxes, divorce, tired landlords with tenants in place, relocation, fire and storm damage, foundation problems, failing roofs, hoarder conditions, vacancy, code violations, and title or lien problems. Every one is bought as-is for cash, with no repairs, no cleanout, and no fees. Written offer in as little as 24 hours.`);

  // Locations index
  buildIndex('/locations/', `Where We Buy Houses | ${CITIES.length} Cities Across the Southeast | ${BIZ.name}`,
    `We buy houses for cash in ${CITIES.length} cities across Georgia, South Carolina, Florida, Alabama, North Carolina and Tennessee. Find your city.`,
    'Where we buy houses', `${CITIES.length} cities, ${COUNTIES.length} counties, six states. Foreclosure and tax-sale rules differ in every one of them, so each state page covers the law that applies to you.`,
    STATES.map((s) => `<div style="margin-bottom:38px"><h2><a href="/sell-my-house-fast/${s.slug}/">${esc(s.name)}</a></h2>
<p style="color:${BIZ.brand.muted};font-size:.95rem">${esc(s.foreclosure.type)} foreclosure &middot; ${esc(s.closingType === 'attorney' ? 'attorney closing state' : 'title company closings')} &middot; ${cityByState(s.code).length} cities</p>
<div class="colcloud">${cityByState(s.code).map((c) => `<a href="${c.url}">${esc(c.name)}, ${c.stateCode}</a>`).join('')}</div></div>`).join(''), 0.85,
    `<strong>${esc(BIZ.name)} buys houses for cash in ${CITIES.length} cities across ${COUNTIES.length} counties in six states:</strong> Georgia, South Carolina, Florida, Alabama, North Carolina, and Tennessee. Foreclosure procedure, redemption rights, tax-sale timelines, and whether an attorney is required at closing all differ by state, so each state page covers the law that actually applies to you. ${esc(BIZ.owner)} holds Georgia real estate license #${BIZ.licenses[0].number} and South Carolina license #${BIZ.licenses[1].number}.`);

  // Guides index
  buildIndex('/guides/', `Guides for Selling a House Fast in the Southeast | ${BIZ.name}`,
    `Straight guides on foreclosure timelines, probate, tax sales, closing costs, and what a cash offer really nets you across GA, SC, FL, AL, NC and TN.`,
    'Guides', 'Written for people who need an answer today, not a sales pitch. Each one cites the source it came from.',
    `<div class="grid g2">${GUIDES.map((g) => `<a class="card" href="/guides/${g.slug}/" style="display:block;color:inherit;text-decoration:none"><h3>${esc(g.title)}</h3><p>${esc(g.desc)}</p><span class="more">Read the guide &rarr;</span></a>`).join('')}</div>`, 0.8,
    `<strong>${GUIDES.length} guides on selling a house fast in the Southeast</strong>, covering the foreclosure timeline in each of the six states we buy in, probate and inherited property, delinquent property tax sales, liens and title defects, what cash buyers actually pay and how the offer is built, closing costs by state, and how to tell a real cash buyer from a wholesaler assigning your contract. Each guide cites its sources.`);

  // Canonical comparison page (the full table now lives here only)
  buildIndex('/cash-offer-vs-listing/', 'Cash Offer vs. Listing With an Agent',
    'A line-by-line comparison of selling to a cash buyer versus listing with a real estate agent: price, commission, closing costs, repairs, timeline, and risk.',
    'Cash offer vs. listing with an agent',
    'The comparison that matters is net proceeds, not asking price. Here is every line that differs.',
    comparison().replace('<section class="wash">', '<section style="padding-top:0">').replace('</section>', '</section>')
    + `<div class="narrow prose" style="margin-top:34px"><h2>Work your own numbers</h2>
<p>Take the price you would realistically list at. Subtract 6% commission. Subtract 2% seller closing costs. Subtract what an inspector is going to find. Subtract your mortgage payment, taxes, insurance, and utilities for every month it takes to sell and close.</p>
<p>Compare that to our offer. Sometimes listing still wins by a wide margin, and when it does you should list. Sometimes the gap is a few thousand dollars and four months of stress, which is a genuinely different decision.</p>
<h2>Where each one fits</h2>
<ul><li><strong>List it</strong> when the house shows well, you can wait 60 to 90 days, and you can keep it showable.</li>
<li><strong>Sell to us</strong> when the house needs work a lender will not approve, when it is costing you money every month, or when you have a date you have to hit.</li></ul>
<p><a href="/how-it-works/">How our process works &rarr;</a> &nbsp;&middot;&nbsp; <a href="/guides/what-cash-buyers-actually-pay/">How a cash offer is calculated &rarr;</a></p></div>`,
    0.8,
    `<strong>A cash offer trades price for certainty.</strong> Listing with an agent produces the highest gross price when the house is in good condition and you can wait &mdash; but 5&ndash;6% commission, 1&ndash;3% seller closing costs, post-inspection repair credits, and months of carrying costs all come off it. A cash sale from ${esc(BIZ.name)} carries no commission, no closing costs to you, and no repairs, and closes in ${BIZ.promise.closeRangeDays}. Compare net proceeds, not asking price.`);

  // About
  const aboutTrail = [{ name: 'Home', url: '/' }, { name: 'About', url: '/about/' }];
  emit('/about/', head({
    title: `About ${BIZ.name} | ${BIZ.owner}, Savannah GA`,
    desc: `${BIZ.name} is ${BIZ.legalName}, run by ${BIZ.owner} out of Savannah, Georgia. Licensed GA agent #${BIZ.licenses[0].number} and SC agent #${BIZ.licenses[1].number}.`,
    canonical: '/about/',
    jsonld: [orgLD(), crumbLD(aboutTrail), { '@context': 'https://schema.org', '@type': 'Person', name: BIZ.owner, jobTitle: BIZ.ownerTitle, worksFor: { '@id': `${ORIGIN}/#business` }, telephone: BIZ.phoneE164 }],
  }) + header() + crumbs(aboutTrail) + `
<section><div class="wrap"><div class="grid g2" style="align-items:start">
<div class="narrow prose"><h1>About ${esc(BIZ.name)}</h1>
<div class="answer"><strong>${esc(BIZ.name)}</strong> is the trade name of ${esc(BIZ.legalName)}, a house-buying company founded and run by ${esc(BIZ.owner)} out of ${esc(BIZ.hq.locality)}, Georgia. ${esc(BIZ.owner)} holds Georgia real estate license #${BIZ.licenses[0].number} and South Carolina real estate license #${BIZ.licenses[1].number}. We buy houses for cash in any condition across six Southeastern states. Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} &middot; ${esc(BIZ.hq.locality)}, ${BIZ.hq.region} &middot; ${BIZ.email}</span></div>
<h2>Who we are</h2>
<p>We started in coastal Georgia buying houses in Savannah, Brunswick, Kingsland, Statesboro, and Hinesville. That is still home. Over time the same problems kept showing up in the same forms across the Southeast: an inherited house nobody lives in, a rental that turned into a second job, a foreclosure date that arrived faster than anyone expected.</p>
<p>So we expanded. The process did not change: one offer, one closing date, no fee taken out of your side.</p>
<h2>What we are, and what we are not</h2>
<p>We are the buyer. ${esc(BIZ.legalName)} purchases property for its own account. We are not a lead generation company collecting your address to sell to a list of investors, and we are not a marketplace running your house through an auction of strangers.</p>
<p>We are also not your agent. ${esc(BIZ.owner)} is a licensed real estate agent in Georgia and South Carolina, and that license is disclosed on every page of this site because it should be. But when we buy your house, we are the buyer and we represent ourselves. You are welcome to have your own agent or attorney review anything we send you, and plenty of our sellers do.</p>
<h2>Licensing and disclosure</h2>
<ul><li>Georgia Real Estate License #${BIZ.licenses[0].number}</li>
<li>South Carolina Real Estate License #${BIZ.licenses[1].number}</li>
<li>In Florida, Alabama, North Carolina, and Tennessee we buy as a principal for our own account.</li></ul>
<h2>How to reach us</h2>
<p>Call or text <a href="tel:${tel}">${PHONE}</a>, or email <a href="mailto:${BIZ.email}">${BIZ.email}</a>. If you fill out a form, a person calls you back. There is no chatbot in between.</p>
</div>${form('offer', 'Get your cash offer', 'Two minutes. No obligation.')}
</div></div></section>` + trustbar() + ctaband('Talk to us before you decide anything', 'We will give you a real number and an honest read on whether selling to us makes sense.') + footer(), 0.7);

  // Contact
  const cTrail = [{ name: 'Home', url: '/' }, { name: 'Contact', url: '/contact/' }];
  emit('/contact/', head({
    title: `Contact ${BIZ.name} | Call or Text ${PHONE}`,
    desc: `Get a no-obligation cash offer on your house. Call or text ${PHONE}, email ${BIZ.email}, or fill out the form. We buy across GA, SC, FL, AL, NC and TN.`,
    canonical: '/contact/',
    jsonld: [orgLD(), crumbLD(cTrail), { '@context': 'https://schema.org', '@type': 'ContactPage', url: `${ORIGIN}/contact/` }],
  }) + header() + crumbs(cTrail) + `
<section><div class="wrap"><div class="grid g2" style="align-items:start">
<div class="narrow prose"><h1>Contact us</h1>
<div class="answer"><strong>Reach ${esc(BIZ.name)}</strong> by phone or text at ${PHONE}, by email at ${BIZ.email}, or through the form on this page. We respond to form submissions with a phone call, usually the same business day. There is no obligation and no fee. Serving Georgia, South Carolina, Florida, Alabama, North Carolina, and Tennessee.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; ${esc(BIZ.hq.locality)}, ${BIZ.hq.region} &middot; GA RE #${BIZ.licenses[0].number} &middot; SC RE #${BIZ.licenses[1].number}</span></div>
<h2>Fastest way to get a number</h2>
<p>Call or text <a href="tel:${tel}">${PHONE}</a>. Tell us the address and what is going on. That is genuinely all we need to start.</p>
<h2>What we will ask</h2>
<ul><li>The property address</li><li>Rough condition, including anything you know is broken</li><li>Whether anyone lives there, and whether they are a tenant</li><li>Whether there is a mortgage, liens, or back taxes</li><li>How fast you need to be out</li></ul>
<p>You do not need answers to all of them. We can look most of it up.</p>
<h2>What we will not do</h2>
<p>We will not sell your information, add you to a mailing list you did not ask for, or keep calling after you tell us no. Reply STOP to any text and it stops.</p>
</div>${form('offer', 'Get your cash offer', 'Two minutes. A person calls you back.')}
</div></div></section>` + trustbar() + footer(), 0.7);

  // FAQ hub
  const allFaq = [
    { q: 'How fast can you buy my house?', a: `A written no-obligation offer in as little as 24 hours, and closing in ${BIZ.promise.closeRangeDays} once title is clear. If you need faster, tell us on the first call and we will tell you honestly whether it can be done.` },
    { q: 'Do I pay any fees, commissions, or closing costs?', a: 'No. No commission, no listing fee, and no closing costs charged to you. Your mortgage payoff, liens, and back taxes come out of the proceeds because they are debts attached to the property, and whatever remains is yours.' },
    { q: 'How do you decide what to offer?', a: 'After-repair value in your neighborhood, minus repair cost, minus holding and closing costs, minus our margin. We walk you through all four numbers so you can check the math.' },
    { q: 'Will your offer be lower than listing with an agent?', a: 'Usually, on the headline number. What you avoid is 5 to 6 percent commission, 1 to 3 percent closing costs, repair credits after inspection, and months of carrying costs. Compare the net. Sometimes listing still wins, and when it does we say so.' },
    { q: 'Do I need to repair or clean anything?', a: 'No. Not the roof, not the plumbing, not the smell, not the belongings inside. Take what you want and leave the rest.' },
    { q: 'Do you buy houses with tenants in them?', a: 'Yes, including tenants who have stopped paying. The lease transfers with the property and we take over as landlord at closing. No eviction required first.' },
    { q: 'Can I sell if I am in foreclosure?', a: 'Yes, up until the sale is completed. Foreclosure timelines differ by state, and the state pages on this site cover each one. If your sale date is inside two weeks, call a foreclosure attorney the same day you call us.' },
    { q: 'Can I sell a house I inherited?', a: 'Yes, once the estate has a court-appointed executor or administrator with authority to sign the deed. We can make the offer before that appointment and hold it while probate catches up.' },
    { q: 'Are you a real buyer or a lead broker?', a: `${BIZ.legalName} buys for its own account. We are not collecting your address to shop to a list of investors.` },
    { q: 'Are you my real estate agent?', a: `No. ${BIZ.owner} holds a Georgia and a South Carolina real estate license, and we disclose that everywhere. But when we buy your house we are the buyer and we represent ourselves, not you. You are welcome to have your own agent or attorney review anything we send.` },
    { q: 'What kinds of property do you buy?', a: 'Single-family houses, small multifamily, and land. Vacant, occupied, fire damaged, foundation problems, hoarder conditions, code violations, behind on taxes. Condition changes the price, not whether we buy.' },
    { q: 'What states do you buy in?', a: `Georgia, South Carolina, Florida, Alabama, North Carolina, and Tennessee. ${CITIES.length} cities across ${COUNTIES.length} counties.` },
  ];
  const fTrail = [{ name: 'Home', url: '/' }, { name: 'FAQ', url: '/faq/' }];
  emit('/faq/', head({
    title: `Frequently Asked Questions | ${BIZ.name}`,
    desc: 'Straight answers about selling your house for cash: how fast, what it costs, how we price offers, tenants, foreclosure, probate, and what we will not do.',
    canonical: '/faq/', jsonld: [orgLD(), crumbLD(fTrail), faqLD(allFaq)],
  }) + header() + crumbs(fTrail) + `
<section><div class="wrap narrow"><h1>Frequently asked questions</h1>
<div class="answer"><strong>${esc(BIZ.name)}</strong> buys houses for cash in any condition across six Southeastern states, with no commissions, fees, or repairs. Written no-obligation offer in as little as 24 hours; closing in ${BIZ.promise.closeRangeDays} on a date you choose. Call or text ${PHONE}.
<span class="meta">${esc(BIZ.legalName)} dba ${esc(BIZ.name)} &middot; GA RE #${BIZ.licenses[0].number} &middot; SC RE #${BIZ.licenses[1].number}</span></div>
<div class="faq">${allFaq.map((f) => `<details><summary>${esc(f.q)}</summary><div class="a"><p>${esc(f.a)}</p></div></details>`).join('')}</div>
<p style="margin-top:26px">Still have a question? Call or text <a href="tel:${tel}">${PHONE}</a>.</p>
</div></section>` + trustbar() + ctaband('Get your no-obligation cash offer', 'Two minutes to ask. No fee either way.') + footer(), 0.75);

  // Legal
  for (const [url, title, bodyHtml] of [
    ['/privacy/', 'Privacy Policy', `<h2>What we collect</h2><p>When you submit a form on this site we collect the property address, your name, phone number, email address, the situation you selected, and the page you submitted from. We also collect standard server and analytics data such as IP address and referring page.</p>
<h2>How we use it</h2><p>To evaluate your property, contact you about an offer, and keep records of the transaction. We use it for nothing else.</p>
<h2>What we do not do</h2><p>We do not sell your personal information. We do not rent or trade it. We do not share it with other investors or lead buyers.</p>
<h2>Who we share it with</h2><p>Only service providers who help us operate: our database host, our email and SMS provider, and, if you proceed to a transaction, the closing attorney or title company handling your sale. Each is bound to use it only for that purpose.</p>
<h2>Calls and texts</h2><p>By submitting a form you consent to receive calls, texts, and emails from ${esc(BIZ.name)} about your property. Message and data rates may apply. Message frequency varies. Reply STOP to any text to opt out, or HELP for help. Consent is not a condition of any purchase.</p>
<h2>Your choices</h2><p>Email <a href="mailto:${BIZ.email}">${BIZ.email}</a> or call ${PHONE} to request a copy of your information, correct it, or have it deleted. We will act on the request within 30 days.</p>
<h2>Cookies</h2><p>This site uses only what is needed to serve pages and measure aggregate traffic. We do not run cross-site advertising trackers on it.</p>
<h2>Contact</h2><p>${esc(BIZ.legalName)} dba ${esc(BIZ.name)}, ${esc(BIZ.hq.locality)}, ${BIZ.hq.region}. ${PHONE} &middot; <a href="mailto:${BIZ.email}">${BIZ.email}</a>.</p>`],
    ['/terms/', 'Terms of Service', `<h2>Who we are</h2><p>This site is operated by ${esc(BIZ.legalName)}, doing business as ${esc(BIZ.name)}, of ${esc(BIZ.hq.locality)}, ${BIZ.hq.region}.</p>
<h2>We are a buyer, not your agent</h2><p>${esc(BIZ.owner)} holds Georgia real estate license #${BIZ.licenses[0].number} and South Carolina real estate license #${BIZ.licenses[1].number}. When we purchase property we act as a principal for our own account. We do not represent you, we owe you no agency duties, and you are encouraged to obtain your own legal, tax, or real estate representation.</p>
<h2>No offer is made by this website</h2><p>Nothing on this site constitutes an offer to purchase any property. Any offer we make is made in writing, is specific to a property, and is subject to inspection, title review, and the terms of a signed purchase agreement.</p>
<h2>Not legal, tax, or financial advice</h2><p>Pages on this site summarize general information about state foreclosure, probate, and tax-sale procedures. Laws change, county practice varies, and your facts are specific to you. Nothing here is legal, tax, or financial advice, and no attorney-client relationship is created. Consult a licensed attorney in your state.</p>
<h2>Accuracy</h2><p>We source the legal summaries on this site to the references cited on each page and update them when we become aware of a change. We do not warrant that every summary is current or complete for your situation.</p>
<h2>Communications</h2><p>By submitting a form you consent to be contacted by phone, text, and email about your property. Reply STOP to opt out of texts.</p>
<h2>Limitation of liability</h2><p>This site is provided as-is. To the extent permitted by law, ${esc(BIZ.legalName)} is not liable for any decision made in reliance on general information published here.</p>
<h2>Governing law</h2><p>These terms are governed by the laws of the State of Georgia.</p>
<h2>Contact</h2><p>${PHONE} &middot; <a href="mailto:${BIZ.email}">${BIZ.email}</a>.</p>`],
  ]) {
    const t = [{ name: 'Home', url: '/' }, { name: title, url }];
    emit(url, head({ title: `${title} | ${BIZ.name}`, desc: `${title} for ${BIZ.name} (${BIZ.legalName}).`, canonical: url, jsonld: [orgLD(), crumbLD(t)] })
      + header() + crumbs(t) + `<section><div class="wrap narrow prose"><h1>${esc(title)}</h1><p style="color:${BIZ.brand.muted}">Last updated ${new Date().toISOString().slice(0, 10)}.</p>${bodyHtml}</div></section>` + footer(), 0.2);
  }
}

/* ------------------------------------------------------------------ run */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

buildHome();
STATES.forEach(buildState);
CITIES.forEach(buildCity);
COUNTIES.forEach(buildCounty);
SITUATIONS.forEach(buildSituationHub);
for (const sit of SITUATIONS) for (const st of STATES) if (sitAllowed(sit, st.code)) buildSituationState(sit, st);
for (const city of T1CITIES) for (const sit of T1SITS) if (sitAllowed(sit, city.stateCode)) buildSituationCity(city, sit);
GUIDES.forEach(buildGuide);
buildCore();

/* ------------------------------------------------------ sitemap / robots */
const now = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  PAGES.map((p) => `<url><loc>${ORIGIN}${p.url}</loc><lastmod>${now}</lastmod><priority>${p.priority.toFixed(1)}</priority></url>`).join('\n') +
  `\n</urlset>\n`);

fs.writeFileSync(path.join(OUT, 'robots.txt'), NOINDEX
  ? `User-agent: *\nDisallow: /\n`
  : `User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: ChatGPT-User\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: Claude-Web\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /\n\nUser-agent: Applebot-Extended\nAllow: /\n\nUser-agent: CCBot\nAllow: /\n\nUser-agent: Bingbot\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);

fs.writeFileSync(path.join(OUT, 'llms.txt'),
`# ${BIZ.name} (${BIZ.legalName})

> Cash home buyer serving Georgia, South Carolina, Florida, Alabama, North Carolina, and Tennessee.
> Buys residential property in any condition as a principal, with no commissions, fees, or repairs
> required from the seller. Written no-obligation offer in as little as 24 hours; closing typically
> ${BIZ.promise.closeRangeDays}. Founded and run by ${BIZ.owner} of ${BIZ.hq.locality}, Georgia.

## Facts
- Legal entity: ${BIZ.legalName}, trading as ${BIZ.name}
- Founder / CEO: ${BIZ.owner}
- Phone: ${PHONE} (call or text)
- Email: ${BIZ.email}
- Based: ${BIZ.hq.locality}, ${BIZ.hq.region}
- Georgia Real Estate License: #${BIZ.licenses[0].number}
- South Carolina Real Estate License: #${BIZ.licenses[1].number}
- Buys as a principal (not as an agent) in FL, AL, NC, TN
- Coverage: ${CITIES.length} cities across ${COUNTIES.length} counties in 6 states
- Seller pays: no commission, no listing fee, no closing costs
- Buys occupied, tenant-occupied, vacant, fire damaged, and code-violation properties

## States and how the law differs
${STATES.map((s) => `- [${s.name}](${ORIGIN}/sell-my-house-fast/${s.slug}/): ${s.foreclosure.type} foreclosure. ${s.foreclosure.redemption} ${s.closingFact}`).join('\n')}

## Situations
${SITUATIONS.map((s) => `- [${s.name}](${ORIGIN}/situations/${s.slug}/)`).join('\n')}

## Guides
${GUIDES.map((g) => `- [${g.title}](${ORIGIN}/guides/${g.slug}/): ${g.desc}`).join('\n')}

## Core pages
- [How it works](${ORIGIN}/how-it-works/)
- [Where we buy](${ORIGIN}/locations/)
- [About ${BIZ.owner}](${ORIGIN}/about/)
- [FAQ](${ORIGIN}/faq/)
- [Contact](${ORIGIN}/contact/)

## Disclosure
${BIZ.name} buys property for its own account and does not act as the seller's real estate agent
or broker in these transactions. Legal summaries on the site are general information about state
law, sourced on each page, and are not legal advice.
`);

fs.writeFileSync(path.join(OUT, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n  Permissions-Policy: geolocation=(), microphone=(), camera=()\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`);

// copy static assets
const assetsSrc = path.join(ROOT, 'assets');
if (fs.existsSync(assetsSrc)) fs.cpSync(assetsSrc, path.join(OUT, 'assets'), { recursive: true });

console.log(`built ${PAGES.length} pages -> site/`);
console.log(`  ${STATES.length} states, ${CITIES.length} cities, ${COUNTIES.length} counties, ${SITUATIONS.length} situations, ${GUIDES.length} guides`);
console.log(`  situation x city: ${T1CITIES.length} tier-1 cities x ${T1SITS.length} tier-1 situations`);
