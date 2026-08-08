/**
 * POST /api/lead — receives a seller lead and stores it.
 *
 * NOTHING IS WIRED UNTIL YOU SET THE ENV VARS. With none set, the route
 * validates and logs the lead and returns 200, so the site works before the
 * accounts are connected.
 *
 * Env vars (set in Vercel → Project → Settings → Environment Variables):
 *   SUPABASE_URL          https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key — SERVER ONLY, never expose to the browser
 *   SUPABASE_TABLE        defaults to "tossie_leads"
 *   ALERT_EMAIL_TO        where the new-lead alert goes
 *   ALERT_EMAIL_FROM      verified sender on your email provider
 *   RESEND_API_KEY        optional; if absent no email is attempted
 */

const REQUIRED = ['address', 'name', 'phone', 'email'];
const MAXLEN = { address: 300, name: 120, phone: 40, email: 200, situation: 60, market: 120, page_path: 300 };

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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

  const lead = {
    address: clean(body.address, MAXLEN.address),
    name: clean(body.name, MAXLEN.name),
    phone: clean(body.phone, MAXLEN.phone),
    email: clean(body.email, MAXLEN.email),
    situation: clean(body.situation, MAXLEN.situation) || null,
    market: clean(body.market, MAXLEN.market) || null,
    page_path: clean(body.page_path, MAXLEN.page_path) || null,
    referrer: clean(req.headers.referer, 300) || null,
    user_agent: clean(req.headers['user-agent'], 300) || null,
  };

  for (const f of REQUIRED) if (!lead[f]) return res.status(400).json({ error: 'missing_field', field: f });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) return res.status(400).json({ error: 'bad_email' });
  if ((lead.phone.match(/\d/g) || []).length < 10) return res.status(400).json({ error: 'bad_phone' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_TABLE = 'tossie_leads' } = process.env;

  // --- store -------------------------------------------------------------
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(lead),
      });
      if (!r.ok) console.error('supabase insert failed', r.status, await r.text());
    } catch (e) {
      console.error('supabase insert threw', e);
    }
  } else {
    console.log('LEAD (no store configured)', JSON.stringify(lead));
  }

  // --- alert -------------------------------------------------------------
  const { RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM } = process.env;
  if (RESEND_API_KEY && ALERT_EMAIL_TO && ALERT_EMAIL_FROM) {
    const rows = [
      ['Address', lead.address], ['Name', lead.name], ['Phone', lead.phone],
      ['Email', lead.email], ['Situation', lead.situation || '—'],
      ['Market', lead.market || '—'], ['Page', lead.page_path || '—'],
    ];
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: ALERT_EMAIL_FROM,
          to: ALERT_EMAIL_TO.split(',').map((s) => s.trim()),
          subject: `New seller lead — ${lead.market || lead.address}`,
          html: `<h2>New lead from tossiebuyshouses.com</h2><table cellpadding="6" style="border-collapse:collapse;font-family:system-ui,sans-serif">${
            rows.map(([k, v]) => `<tr><td style="border:1px solid #ddd"><b>${k}</b></td><td style="border:1px solid #ddd">${String(v).replace(/</g, '&lt;')}</td></tr>`).join('')
          }</table><p><a href="tel:${lead.phone.replace(/[^\d+]/g, '')}">Call ${lead.phone}</a></p>`,
        }),
      });
    } catch (e) {
      console.error('alert email failed', e);
    }
  }

  return res.status(200).json({ ok: true });
}
