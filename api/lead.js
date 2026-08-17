/**
 * POST /api/lead — receives a seller lead from the marketing site and writes it
 * into the operator platform.
 *
 * Degrades safely: with no env vars set it validates and logs the lead and
 * returns 200, so the public site keeps working before the accounts are wired.
 *
 * Env vars (Vercel → Project → Settings → Environment Variables):
 *   SUPABASE_URL          https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key — SERVER ONLY, never expose to the browser
 *   TOSSIE_TEAM_ID        defaults to the seeded team in 20260817120000_foundation.sql
 *   ALERT_EMAIL_TO        where the new-lead alert goes
 *   ALERT_EMAIL_FROM      verified sender on the sending domain
 *   RESEND_API_KEY        optional; if absent no email is attempted
 */

import { CONSENT_VERSION, consentText } from '../lib/consent.js';

const BUSINESS_NAME = 'Tossie Buys Houses';
const TEAM_ID = process.env.TOSSIE_TEAM_ID || '70551e00-0000-4000-8000-000000000001';

const REQUIRED = ['address', 'name', 'phone', 'email'];
const MAXLEN = { address: 300, name: 120, phone: 40, email: 200, situation: 60, market: 120, page_path: 300 };

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The form posts a free-typed address line. Pull city/state/zip off the end
 * when the seller typed them; leave them null when they didn't. `market` (the
 * page's city) is the fallback — it is where the lead was captured, which is
 * almost always where the property is.
 */
export function splitAddress(line, market) {
  const out = { address: line, city: null, state: null, zip: null };
  const m = line.match(/^(.*?),\s*([^,]+?),?\s*([A-Za-z]{2})\s*(\d{5})?(?:-\d{4})?\s*$/);
  if (m) {
    out.address = m[1].trim();
    out.city = m[2].trim();
    out.state = m[3].toUpperCase();
    out.zip = m[4] || null;
  } else if (market) {
    // "Savannah, GA" from the page the form sat on.
    const mm = market.match(/^(.*?),\s*([A-Za-z]{2})$/);
    if (mm) { out.city = mm[1].trim(); out.state = mm[2].toUpperCase(); }
    else out.city = market;
  }
  return out;
}

/** First public address in X-Forwarded-For, for the consent record. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff || '').split(',')[0].trim();
  return /^[0-9a-fA-F.:]+$/.test(first) && first ? first : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_body' });

  // Honeypot: real users never fill this. Return 200 so bots don't learn.
  if (clean(body.company, 100)) return res.status(200).json({ ok: true });

  const raw = {
    address: clean(body.address, MAXLEN.address),
    name: clean(body.name, MAXLEN.name),
    phone: clean(body.phone, MAXLEN.phone),
    email: clean(body.email, MAXLEN.email),
    situation: clean(body.situation, MAXLEN.situation) || null,
    market: clean(body.market, MAXLEN.market) || null,
    page_path: clean(body.page_path, MAXLEN.page_path) || null,
  };

  for (const f of REQUIRED) if (!raw[f]) return res.status(400).json({ error: 'missing_field', field: f });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.email)) return res.status(400).json({ error: 'bad_email' });
  if ((raw.phone.match(/\d/g) || []).length < 10) return res.status(400).json({ error: 'bad_phone' });

  const parts = splitAddress(raw.address, raw.market);
  const now = new Date().toISOString();

  const lead = {
    team_id: TEAM_ID,
    name: raw.name,
    phone: raw.phone,
    email: raw.email,

    address: parts.address,
    city: parts.city,
    state: parts.state,
    zip: parts.zip,

    // The dropdown is the seller's own words about why they're selling. It is
    // the single most useful field on an inbound lead, so it lands in
    // motivation and as a tag rather than being buried in raw_payload.
    motivation: raw.situation,
    tags: raw.situation ? [raw.situation] : [],

    source: 'website',
    source_detail: raw.page_path,
    temperature: 'warm',
    status: 'new',

    // Consent. The seller submitted a form carrying the disclosure, so this is
    // express written consent — recorded with the exact text, the version, the
    // IP and the timestamp, because that record is the entire defense.
    tcpa_opt_in: true,
    tcpa_opt_in_at: now,
    tcpa_disclosure_text: consentText(BUSINESS_NAME),
    tcpa_disclosure_version: CONSENT_VERSION,
    tcpa_disclosure_source: raw.page_path,
    tcpa_disclosure_ip: clientIp(req),
    consent_sms: true,
    consent_email: true,

    page_path: raw.page_path,
    referrer: clean(req.headers.referer, 300) || null,
    user_agent: clean(req.headers['user-agent'], 300) || null,
    raw_payload: raw,
  };

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  let leadId = null;

  // --- store -------------------------------------------------------------
  // Never fails the request. A seller who filled out the form gets a success
  // page even if the database is having a bad day; the alert email below is
  // the backstop that means the lead is not lost.
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(lead),
      });
      if (r.ok) {
        const [row] = await r.json();
        leadId = row?.id ?? null;
      } else {
        console.error('lead insert failed', r.status, await r.text());
      }
    } catch (e) {
      console.error('lead insert threw', e);
    }

    // Board placement happens in a database trigger, not here — see
    // place_new_lead_on_pipeline in 20260817120100_leads.sql. Every path that
    // creates a lead (this form, CSV import, the SDR) gets it for free.
  } else {
    console.log('LEAD (no store configured)', JSON.stringify(lead));
  }

  // --- alert -------------------------------------------------------------
  const { RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM } = process.env;
  if (RESEND_API_KEY && ALERT_EMAIL_TO && ALERT_EMAIL_FROM) {
    const esc = (v) => String(v ?? '—').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const rows = [
      ['Address', [parts.address, parts.city, parts.state, parts.zip].filter(Boolean).join(', ')],
      ['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email],
      ['Situation', lead.motivation], ['Captured on', lead.page_path],
    ];
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: ALERT_EMAIL_FROM,
          to: ALERT_EMAIL_TO.split(',').map((s) => s.trim()),
          subject: `New seller lead — ${parts.city || parts.address}`,
          html:
            `<h2>New lead from tossiebuyshouses.com</h2>` +
            `<table cellpadding="6" style="border-collapse:collapse;font-family:system-ui,sans-serif">${
              rows.map(([k, v]) => `<tr><td style="border:1px solid #ddd"><b>${k}</b></td><td style="border:1px solid #ddd">${esc(v)}</td></tr>`).join('')
            }</table>` +
            `<p><a href="tel:${lead.phone.replace(/[^\d+]/g, '')}">Call ${esc(lead.phone)}</a></p>` +
            (leadId ? `<p><a href="https://tossiebuyshouses.com/app/leads/${leadId}">Open in the app</a></p>` : ''),
        }),
      });
    } catch (e) {
      console.error('alert email failed', e);
    }
  }

  return res.status(200).json({ ok: true });
}
