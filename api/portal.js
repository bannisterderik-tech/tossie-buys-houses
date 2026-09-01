/**
 * The seller's own page. GET renders it, POST takes what they typed.
 *
 *   GET  /api/portal?t={token}            the form
 *   POST /api/portal?t={token}&do=save    answers
 *   POST /api/portal?t={token}&do=photo   one image
 *
 * WHY THIS HOLDS THE KEY INSTEAD OF OPENING THE DATABASE.
 *
 * The obvious build is a public RLS policy on lead_portals keyed on the token,
 * so the browser can talk to PostgREST directly. That policy has to be exactly
 * right forever, against a table that joins to leads, and the cost of getting
 * it slightly wrong is somebody enumerating tokens and reading sellers' names
 * and addresses.
 *
 * So `anon` has no grant on lead_portals at all and no policy to probe. This
 * route holds the service key, checks the token itself, and returns only the
 * handful of fields a seller should see about their own property. There is no
 * public database surface to get wrong.
 *
 * The page is served from here rather than as a static file because it needs
 * the token resolved before it renders — a seller opening a dead link should
 * be told so, not shown an empty form that fails on submit.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fvkxdhuwfjnsvkjjordm.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const BUSINESS = 'Tossie Buys Houses';
const BUCKET = 'property-photos';

/** Photos come off a phone camera. Anything past this is not a photo. */
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_PHOTOS = 25;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** The body as bytes, exactly as sent, with a hard ceiling. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      // Stop reading rather than buffer a hostile upload to completion.
      if (total > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function db() {
  if (!SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * The token, the portal, and the lead — or a reason it cannot be used.
 * One place, so every entry point refuses identically.
 */
async function resolve(admin, token) {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return { error: 'That link is not valid.' };

  const { data: p } = await admin
    .from('lead_portals')
    .select('*, leads(id, name, address, city, state, zip, beds, baths, asking_price, timeline, occupancy)')
    .eq('token', token)
    .maybeSingle();

  if (!p) return { error: 'That link is not valid.' };
  if (p.revoked_at) return { error: 'That link has been turned off. Reply to our text and we will send a new one.' };
  if (new Date(p.expires_at) < new Date()) {
    return { error: 'That link has expired. Reply to our text and we will send a new one.' };
  }
  return { portal: p, lead: p.leads };
}

export default async function handler(req, res) {
  const admin = db();
  if (!admin) {
    console.error('[portal] SUPABASE_SERVICE_KEY is not set');
    return res.status(503).send(shell('We cannot open this right now', '<p>Please try again shortly.</p>'));
  }

  const token = String(req.query.t || '').trim().toLowerCase();
  const action = String(req.query.do || '').trim();

  const r = await resolve(admin, token);
  if (r.error) {
    if (req.method === 'POST') return res.status(404).json({ error: r.error });
    return res.status(404).send(shell('Link not available', `<p>${esc(r.error)}</p>`));
  }
  const { portal, lead } = r;

  // ── the form ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!portal.first_opened_at) {
      await admin.from('lead_portals')
        .update({ first_opened_at: new Date().toISOString() }).eq('id', portal.id);
    }
    return res.status(200).send(formPage(portal, lead));
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ── a photo ───────────────────────────────────────────────────────────────
  if (action === 'photo') {
    if (portal.photo_count >= MAX_PHOTOS) {
      return res.status(429).json({ error: `That is already ${MAX_PHOTOS} photos, which is plenty.` });
    }
    const ct = String(req.headers['content-type'] || '');
    if (!/^image\/(jpeg|png|webp|heic|heif)/i.test(ct)) {
      return res.status(415).json({ error: 'That file is not an image.' });
    }
    let buf;
    try {
      buf = await readRaw(req, MAX_PHOTO_BYTES);
    } catch {
      return res.status(413).json({ error: 'That photo is too large. Most phones let you send a smaller one.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file was empty.' });

    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp'
      : /heic|heif/.test(ct) ? 'heic' : 'jpg';
    const id = crypto.randomUUID();
    // Same key convention as every other object in this bucket: the team id
    // first, so the storage policies scope on it without a join.
    const path = `${portal.team_id}/lead/${portal.lead_id}/${id}.${ext}`;

    const { error: upErr } = await admin.storage.from(BUCKET)
      .upload(path, buf, { contentType: ct.split(';')[0] });
    if (upErr) {
      console.error('[portal] upload failed:', upErr.message);
      return res.status(502).json({ error: 'That photo did not save. Please try again.' });
    }

    const { error: rowErr } = await admin.from('property_photos').insert({
      id,
      team_id: portal.team_id,
      lead_id: portal.lead_id,
      bucket: BUCKET,
      storage_path: path,
      file_name: `seller-upload.${ext}`,
      mime_type: ct.split(';')[0],
      size_bytes: buf.length,
      caption: 'Sent by the seller',
    });
    if (rowErr) {
      // The row is the record; a file with no row is invisible to every screen.
      await admin.storage.from(BUCKET).remove([path]);
      console.error('[portal] photo row failed:', rowErr.message);
      return res.status(500).json({ error: 'That photo did not save. Please try again.' });
    }

    await admin.from('lead_portals')
      .update({ photo_count: portal.photo_count + 1 }).eq('id', portal.id);

    return res.status(200).json({ ok: true, count: portal.photo_count + 1 });
  }

  // ── the answers ───────────────────────────────────────────────────────────
  if (action === 'save') {
    let body = {};
    try {
      const raw = await readRaw(req, 64 * 1024);
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return res.status(400).json({ error: 'That did not send. Please try again.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

    // Only the fields this form asks for, each capped. A public endpoint that
    // stores whatever it is handed is a public endpoint somebody fills with
    // whatever they like.
    const FIELDS = ['asking_price', 'mortgage_balance', 'timeline', 'motivation',
      'condition_notes', 'repairs_needed', 'occupancy', 'beds', 'baths',
      'already_listed', 'anything_else'];
    const answers = {};
    for (const k of FIELDS) {
      if (body[k] === undefined || body[k] === null) continue;
      answers[k] = typeof body[k] === 'boolean' ? body[k] : String(body[k]).slice(0, 2000);
    }

    const { error } = await admin.from('lead_portals').update({
      answers: { ...(portal.answers || {}), ...answers },
      submitted_at: new Date().toISOString(),
    }).eq('id', portal.id);
    if (error) {
      console.error('[portal] save failed:', error.message);
      return res.status(500).json({ error: 'That did not save. Please try again.' });
    }

    const { error: mergeErr } = await admin.rpc('apply_portal_answers', { p_portal_id: portal.id });
    if (mergeErr) {
      // Their answers are stored either way; the merge is what the operator
      // sees on the lead. Worth logging, not worth telling the seller.
      console.error('[portal] merge failed:', mergeErr.message);
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown action' });
}

/* ── the page ─────────────────────────────────────────────────────────────
   Written out rather than built, because it has to load fast on a phone with
   one bar of signal and it has no business pulling a framework to render nine
   inputs. */

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · ${esc(BUSINESS)}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#f4f6f9;color:#1c1c28;
 font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:22px 16px 60px}
h1{font-size:1.4rem;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:#6a6a6a;font-size:.95rem;margin:0 0 22px}
.card{background:#fff;border:1px solid #e1e1e1;border-radius:12px;padding:18px;margin-bottom:14px}
label{display:block;font-weight:700;font-size:.9rem;margin:0 0 6px}
.hint{display:block;font-weight:400;color:#6a6a6a;font-size:.83rem;margin-top:2px}
input,select,textarea{width:100%;padding:11px 12px;border:1.5px solid #dde3ec;border-radius:9px;
 font:inherit;font-size:16px;background:#fff;color:#1c1c28}
input:focus,select:focus,textarea:focus{outline:0;border-color:#1a4485;box-shadow:0 0 0 3px rgba(26,68,133,.13)}
.field+.field{margin-top:16px}
.row{display:flex;gap:10px}.row>.field{flex:1;margin-top:0}
button{font:inherit}
.btn{background:#eb6a56;color:#fff;border:0;border-radius:10px;padding:14px 18px;
 font-weight:700;font-size:1rem;width:100%;cursor:pointer;min-height:52px}
.btn:disabled{opacity:.55}
.ghost{background:#fff;color:#1a4485;border:1.5px solid #dde3ec}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin-top:12px}
.shot{aspect-ratio:1;border-radius:8px;overflow:hidden;border:1px solid #e1e1e1;background:#eef1f6}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
.ok{background:#e6f4ea;border:1px solid #b7e0c4;color:#0b6b34;padding:12px 14px;border-radius:9px}
.err{background:#fdecea;border:1px solid #f5c4bd;color:#a11b0f;padding:12px 14px;border-radius:9px;margin-bottom:14px}
.foot{color:#6a6a6a;font-size:.82rem;text-align:center;margin-top:18px}
</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

function formPage(portal, lead) {
  const a = portal.answers || {};
  const where = [lead?.address, lead?.city].filter(Boolean).join(', ') || 'your property';
  const val = (k, fallback = '') => esc(a[k] ?? fallback ?? '');

  return shell('About your property', `
<h1>A few things about ${esc(where)}</h1>
<p class="sub">${esc(BUSINESS)} — this takes about two minutes. Nothing here commits you to anything.</p>

<div id="msg"></div>

<form id="f">
  <div class="card">
    <div class="field">
      <label>What would you want for it?
        <span class="hint">A rough number is fine. We make our offer in writing after we have seen it.</span></label>
      <input name="asking_price" inputmode="decimal" placeholder="e.g. 185,000" value="${val('asking_price', lead?.asking_price)}">
    </div>
    <div class="field">
      <label>Anything still owed on it?
        <span class="hint">Mortgage, liens, back taxes. Leave blank if none.</span></label>
      <input name="mortgage_balance" inputmode="decimal" placeholder="e.g. 94,000" value="${val('mortgage_balance')}">
    </div>
    <div class="field">
      <label>How soon would you want to close?</label>
      <input name="timeline" placeholder="e.g. 30 days, no rush, before summer" value="${val('timeline', lead?.timeline)}">
    </div>
    <div class="field">
      <label>What is making you think about selling?</label>
      <textarea name="motivation" rows="3" placeholder="Inherited it, moving, tired of tenants…">${val('motivation')}</textarea>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <div class="field"><label>Bedrooms</label>
        <input name="beds" inputmode="decimal" value="${val('beds', lead?.beds)}"></div>
      <div class="field"><label>Bathrooms</label>
        <input name="baths" inputmode="decimal" value="${val('baths', lead?.baths)}"></div>
    </div>
    <div class="field">
      <label>Who is living there?</label>
      <select name="occupancy">
        <option value="">Choose one</option>
        <option value="owner">I live there</option>
        <option value="tenant">A tenant</option>
        <option value="vacant">Nobody, it is empty</option>
      </select>
    </div>
    <div class="field">
      <label>What needs work?
        <span class="hint">Be honest — it does not put us off, and it saves a second conversation.</span></label>
      <textarea name="condition_notes" rows="3" placeholder="Roof, kitchen, HVAC…">${val('condition_notes')}</textarea>
    </div>
    <div class="field">
      <label>Is it listed with an agent right now?</label>
      <select name="already_listed">
        <option value="">Choose one</option>
        <option value="false">No</option>
        <option value="true">Yes</option>
      </select>
    </div>
  </div>

  <div class="card">
    <label>Photos of the house
      <span class="hint">The single most useful thing you can send. Outside, kitchen, bathrooms, and anything that needs work. They upload as you pick them.</span></label>
    <input id="pick" type="file" accept="image/*" multiple style="margin-top:10px">
    <div class="shots" id="shots"></div>
    <p class="hint" id="pcount">${portal.photo_count} sent so far</p>
  </div>

  <div class="card">
    <div class="field">
      <label>Anything else we should know?</label>
      <textarea name="anything_else" rows="3">${val('anything_else')}</textarea>
    </div>
  </div>

  <button class="btn" id="go">Send this to ${esc(BUSINESS)}</button>
  <p class="foot">We do not share your details with anyone.</p>
</form>

<script>
(function(){
  var T = ${JSON.stringify(portal.token)};
  var f = document.getElementById('f'), msg = document.getElementById('msg');
  var pick = document.getElementById('pick'), shots = document.getElementById('shots');
  var pcount = document.getElementById('pcount'), go = document.getElementById('go');
  var sent = ${Number(portal.photo_count) || 0};

  // Restore the two selects, which cannot carry a value attribute the way the
  // text inputs do.
  var saved = ${JSON.stringify({ occupancy: a.occupancy || '', already_listed: a.already_listed === undefined ? '' : String(a.already_listed) })};
  for (var k in saved) { if (saved[k] && f[k]) f[k].value = saved[k]; }

  function say(t, bad){ msg.innerHTML = '<div class="'+(bad?'err':'ok')+'">'+t+'</div>'; window.scrollTo(0,0); }

  pick.addEventListener('change', async function(){
    var files = Array.prototype.slice.call(pick.files || []);
    pick.value = '';
    for (var i=0;i<files.length;i++){
      var file = files[i];
      var cell = document.createElement('div');
      cell.className = 'shot';
      var img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      cell.appendChild(img); shots.appendChild(cell);
      try {
        var r = await fetch('/api/portal?t='+T+'&do=photo', {
          method:'POST', headers:{'Content-Type': file.type || 'image/jpeg'}, body: file });
        var j = await r.json();
        if (!r.ok) { cell.style.opacity = .35; say(j.error || 'One photo did not save.', true); }
        else { sent = j.count; pcount.textContent = sent + ' sent so far'; }
      } catch (e) { cell.style.opacity = .35; say('One photo did not save.', true); }
    }
  });

  f.addEventListener('submit', async function(e){
    e.preventDefault();
    go.disabled = true; go.textContent = 'Sending…';
    var data = {};
    Array.prototype.forEach.call(f.elements, function(el){
      if (!el.name) return;
      if (el.name === 'already_listed') { if (el.value !== '') data[el.name] = el.value === 'true'; return; }
      if (el.value !== '') data[el.name] = el.value;
    });
    try {
      var r = await fetch('/api/portal?t='+T+'&do=save', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || 'That did not send.');
      f.style.display = 'none';
      say('Thank you — that is everything we needed. Someone will be in touch shortly.');
    } catch (err) {
      go.disabled = false; go.textContent = 'Send this to ${esc(BUSINESS)}';
      say(err.message || 'That did not send. Please try again.', true);
    }
  });
})();
</script>`);
}

// bodyParser OFF, deliberately. With it on, Vercel decides how to interpret a
// body from its Content-Type, and a JPEG coerced to a UTF-8 string is a
// corrupted JPEG that still uploads and still renders as a broken tile. Reading
// the raw stream is the only way to be certain the bytes that arrive are the
// bytes that get stored; JSON is parsed by hand below, which costs one line.
export const config = { api: { bodyParser: false } };
