import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { STATUSES, TEMPERATURES, titleize, formatPhone, fullAddress, fullDate, timeAgo } from '../lib/format.js';

export default function LeadDetail({ id }) {
  const [lead, setLead] = useState(null);
  const [activity, setActivity] = useState([]);
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [l, a, n] = await Promise.all([
      supabase.from('leads').select('*').eq('id', id).single(),
      supabase.from('lead_activity').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      supabase.from('lead_notes').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
    ]);
    if (l.error) setErr(l.error.message);
    setLead(l.data ?? null);
    setActivity(a.data ?? []);
    setNotes(n.data ?? []);
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); /* eslint-disable-line */ }, [id]);

  async function patch(fields) {
    setErr(null);
    // Optimistic: the operator changing a dropdown should see it move now. The
    // reload below is what makes it true, including the activity row the
    // status trigger writes.
    setLead((prev) => ({ ...prev, ...fields }));
    const { error } = await supabase.from('leads').update(fields).eq('id', id);
    if (error) setErr(error.message);
    load();
  }

  async function addNote(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const { error } = await supabase.from('lead_notes').insert({
      lead_id: id,
      team_id: lead.team_id,
      body,
      author_id: (await supabase.auth.getUser()).data.user?.id ?? null,
    });
    if (error) setErr(error.message);
    load();
  }

  if (loading) return <div className="empty">Loading…</div>;
  if (!lead) return <div className="empty"><strong>Lead not found</strong><a href="/app">Back to leads</a></div>;

  const phone = lead.phone || lead.phone_mobile;

  return (
    <>
      <header>
        <h1>{lead.address || lead.name || 'Lead'}</h1>
        <span className="count">{fullAddress(lead)}</span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <button className="btn ghost" onClick={() => navigate('/')}>← All leads</button>
        {phone && <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>Call {formatPhone(phone)}</a>}
        <select value={lead.status} onChange={(e) => patch({ status: e.target.value })}>
          {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={lead.temperature} onChange={(e) => patch({ temperature: e.target.value })}>
          {TEMPERATURES.map((t) => <option key={t} value={t}>{titleize(t)}</option>)}
        </select>
      </div>

      <div className="detail">
        <div>
          <div className="card">
            <h2>Seller</h2>
            <div className="body">
              <dl className="facts">
                <dt>Name</dt><dd>{lead.name || lead.owner_name || '—'}</dd>
                <dt>Phone</dt><dd>{formatPhone(phone) || '—'}</dd>
                <dt>Email</dt><dd>{lead.email || '—'}</dd>
                <dt>Motivation</dt><dd>{titleize(lead.motivation) || '—'}</dd>
                <dt>Timeline</dt><dd>{lead.timeline || '—'}</dd>
                <dt>Occupancy</dt><dd>{titleize(lead.occupancy) || '—'}</dd>
                <dt>Asking</dt><dd>{lead.asking_price ? `$${lead.asking_price.toLocaleString()}` : '—'}</dd>
                <dt>Condition</dt><dd>{lead.condition_notes || '—'}</dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Notes</h2>
            <div className="body">
              <form onSubmit={addNote}>
                <textarea
                  className="note"
                  placeholder="What did the seller say?"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div style={{ marginTop: 9 }}>
                  <button className="btn" type="submit" disabled={!draft.trim()}>Add note</button>
                </div>
              </form>

              {notes.length > 0 && (
                <ul className="timeline" style={{ marginTop: 16 }}>
                  {notes.map((n) => (
                    <li key={n.id}>
                      {n.body}
                      <span className="when">{fullDate(n.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Compliance</h2>
            <div className="body">
              <dl className="facts">
                <dt>Dialable</dt>
                <dd>
                  {/* Mirrors lead_is_dialable() in the schema. The database is the
                      enforcement point; this is only the readout. */}
                  {lead.is_dnc || lead.is_litigator ? (
                    <span className="badge stop">{lead.is_litigator ? 'Litigator' : 'On DNC'}</span>
                  ) : (lead.source === 'website' && lead.tcpa_opt_in) || (lead.skip_traced && lead.dnc_scrubbed) ? (
                    <span className="badge ok">Yes</span>
                  ) : (
                    <span className="badge stop">Not scrubbed</span>
                  )}
                </dd>
                <dt>TCPA opt-in</dt>
                <dd>{lead.tcpa_opt_in ? fullDate(lead.tcpa_opt_in_at) : 'No'}</dd>
                <dt>Consent</dt>
                <dd>
                  {[lead.consent_sms && 'SMS', lead.consent_email && 'Email'].filter(Boolean).join(' · ') || 'None'}
                </dd>
                <dt>Skip traced</dt><dd>{lead.skip_traced ? fullDate(lead.skip_traced_at) : 'No'}</dd>
                <dt>DNC scrubbed</dt><dd>{lead.dnc_scrubbed ? fullDate(lead.dnc_scrubbed_at) : 'No'}</dd>
              </dl>

              {lead.tcpa_disclosure_text && (
                <details style={{ marginTop: 14, fontSize: '0.83rem', color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    Disclosure shown ({lead.tcpa_disclosure_version})
                  </summary>
                  <p style={{ marginTop: 8 }}>{lead.tcpa_disclosure_text}</p>
                </details>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Capture</h2>
            <div className="body">
              <dl className="facts">
                <dt>Source</dt><dd>{titleize(lead.source)}</dd>
                <dt>Page</dt><dd style={{ wordBreak: 'break-all' }}>{lead.page_path || '—'}</dd>
                <dt>Created</dt><dd>{fullDate(lead.created_at)}</dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Timeline</h2>
            <div className="body">
              {activity.length === 0 ? (
                <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.88rem' }}>Nothing yet.</p>
              ) : (
                <ul className="timeline">
                  {activity.map((a) => (
                    <li key={a.id}>
                      {a.summary || titleize(a.type)}
                      <span className="when">{timeAgo(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
