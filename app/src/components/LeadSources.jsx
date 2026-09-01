import { useCallback, useEffect, useState } from 'react';
import { supabase, SUPABASE_URL } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import { useCan } from '../lib/capabilities.jsx';
import { timeAgo, fullDate } from '../lib/format.js';
import './lead-sources.css';

/**
 * Webhook sources — the CRM's own front door for leads from somewhere else.
 *
 * A speed-to-lead platform, a PPC vendor or a partner site is handed one URL
 * and one header, and posts a lead the moment it has one. No Zapier in the
 * middle: every hop between the form and this database is a place a lead can
 * be delayed, reshaped or silently dropped, and in this business the delay is
 * the thing that loses the deal.
 *
 * Everything underneath this screen already existed — lead_sources, the bcrypt
 * secret, the rate limiter, lead_intake_log, and the lead-intake function
 * deployed with JWT verification off so a vendor that cannot present a Supabase
 * token still gets through. The only missing piece was somewhere to create a
 * source and read back the two values a vendor needs, which is what this is.
 *
 * ON THE SECRET. It is generated in the browser, sent once to be hashed, and
 * shown once. Nothing stores the plaintext — set_lead_source_secret() keeps a
 * bcrypt digest and the comment on that column says plainly that the original
 * is not recoverable. So the copy button matters: leaving this screen without
 * copying it means rotating it, which means updating the vendor too.
 */
export default function LeadSources() {
  const { can } = useCan();
  const manage = can('import.run');

  const [sources, setSources] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  // slug -> plaintext, held in memory only, for exactly as long as this screen
  // is open. Never written anywhere.
  const [freshSecret, setFreshSecret] = useState(null);

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([
      supabase.from('lead_sources').select('*').order('created_at'),
      // The rejections are the half worth reading: a run of rejected_auth on a
      // live slug is the only place a leaked secret would ever show itself.
      supabase.from('lead_intake_log').select('*').order('created_at', { ascending: false }).limit(25),
    ]);
    if (s.error) setErr(s.error.message);
    setSources(s.data ?? []);
    setLog(l.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const endpoint = (slug) => `${SUPABASE_URL}/functions/v1/lead-intake/${slug}`;

  /** 32 bytes of CSPRNG as base64url — comfortably past the 24-char floor. */
  function newSecret() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function create(e) {
    e.preventDefault();
    const label = name.trim();
    if (!label) return;
    // The slug is what sits in the URL, so it is derived rather than typed:
    // lead_sources_slug_shape refuses anything else, and an operator should not
    // have to learn a regex to add a vendor.
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 63);
    if (slug.length < 2) { setErr('That name has too few letters or digits to make a URL from.'); return; }

    setBusy('new');
    setErr(null);
    const { error } = await supabase.from('lead_sources')
      .insert({ team_id: TEAM_ID, name: label, slug });
    if (error) {
      setBusy(null);
      setErr(error.code === '23505'
        ? `The slug "${slug}" is already taken — slugs are unique across every account, so pick a more specific name.`
        : error.message);
      return;
    }
    setName('');
    setCreating(false);
    setBusy(null);
    await load();
    // A source with no secret authorises nothing, so the useful next step is
    // taken automatically rather than left as a second thing to discover.
    await rotate(slug);
  }

  async function rotate(slug) {
    setBusy(slug);
    setErr(null);
    const secret = newSecret();
    const { error } = await supabase.rpc('set_lead_source_secret', {
      p_slug: slug, p_secret: secret,
    });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    setFreshSecret({ slug, secret });
    await load();
  }

  async function toggleActive(s) {
    setBusy(s.slug);
    const { error } = await supabase.from('lead_sources')
      .update({ active: !s.active }).eq('id', s.id);
    if (error) setErr(error.message);
    setBusy(null);
    await load();
  }

  if (loading) return null;

  return (
    <>
      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="galleryhead">
          <span>Webhook sources {sources.length > 0 && `· ${sources.length}`}</span>
          {manage && !creating && (
            <button className="btn ghost" onClick={() => setCreating(true)}>Add a source</button>
          )}
        </h2>
        <p className="cardnote">
          Give a lead platform this URL and this header and it can post a lead straight into the
          pipeline — no Zapier in between. Every hop between the form and here is somewhere a lead
          can be delayed or dropped, and the delay is what loses the deal.
        </p>

        <div className="body">
          {err && <div className="err">{err}</div>}

          {creating && (
            <form className="srcnew" onSubmit={create}>
              <label>
                <span>What is sending the leads?</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Speed to Lead"
                />
              </label>
              <button className="btn" disabled={busy === 'new'}>
                {busy === 'new' ? 'Creating…' : 'Create and generate a secret'}
              </button>
              <button type="button" className="btn ghost" onClick={() => { setCreating(false); setName(''); }}>
                Cancel
              </button>
            </form>
          )}

          {sources.length === 0 && !creating && (
            <div className="empty">
              <strong>No webhook sources yet</strong>
              Add one and you get a URL to paste into the sending platform.
            </div>
          )}

          {sources.map((s) => (
            <div key={s.id} className={`srcrow${s.active ? '' : ' off'}`}>
              <div className="srchead">
                <strong>{s.name}</strong>
                <span className={`badge ${s.active ? 'ok' : 'stop'}`}>{s.active ? 'Active' : 'Paused'}</span>
                {!s.secret_hash && <span className="badge stop">No secret — refuses everything</span>}
                <span className="spacer" />
                {manage && (
                  <>
                    <button className="linkbtn" disabled={busy === s.slug} onClick={() => rotate(s.slug)}>
                      {s.secret_hash ? 'new secret' : 'generate secret'}
                    </button>
                    {' '}
                    <button className="linkbtn" disabled={busy === s.slug} onClick={() => toggleActive(s)}>
                      {s.active ? 'pause' : 'resume'}
                    </button>
                  </>
                )}
              </div>

              <Field label="Webhook URL" value={endpoint(s.slug)} />
              <Field label="Header name" value="x-lead-secret" />

              {freshSecret?.slug === s.slug ? (
                <div className="srcsecret">
                  <strong>Header value — copy it now</strong>
                  <Field label="x-lead-secret" value={freshSecret.secret} mono />
                  <p className="fine">
                    Only a bcrypt hash is stored, so this cannot be shown again. Leave this screen
                    without copying it and the only way forward is generating another one and
                    updating the platform to match.
                  </p>
                  <button className="btn ghost" onClick={() => setFreshSecret(null)}>
                    I have copied it
                  </button>
                </div>
              ) : (
                <p className="fine srcmeta">
                  {s.secret_hash
                    ? `Secret set ${timeAgo(s.secret_set_at)}`
                    : 'No secret set — every post is refused until one is generated'}
                  {' · '}limit {s.rate_limit_per_min}/min
                  {' · '}{s.received_count} received
                  {s.last_received_at ? ` · last ${timeAgo(s.last_received_at)}` : ' · nothing yet'}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Recent posts · {log.length}</h2>
        <p className="cardnote">
          Every receipt, accepted or refused, newest first. This is where a misconfigured platform
          shows up — a wrong secret lands here as <code>rejected_auth</code> rather than as silence.
        </p>
        <div className="body">
          {log.length === 0 ? (
            <p className="colempty">Nothing has posted yet.</p>
          ) : (
            <table className="leads">
              <tbody>
                {log.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="addr">{r.slug}</span>
                      <span className="sub">{r.message || '—'}</span>
                    </td>
                    <td>
                      <span className={`badge ${r.outcome === 'accepted' ? 'ok' : 'stop'}`}>
                        {r.outcome.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="hide-sm sub">{fullDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

/** A value with a copy button, because both of these get pasted elsewhere. */
function Field({ label, value, mono }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the value is selectable either way.
      setCopied(false);
    }
  }

  return (
    <div className="srcfield">
      <span className="k">{label}</span>
      <input className={mono ? 'mono' : undefined} readOnly value={value} onFocus={(e) => e.target.select()} />
      <button className="btn ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
