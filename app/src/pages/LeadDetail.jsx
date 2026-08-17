import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import InlineField from '../components/InlineField.jsx';
import DispositionBar from '../components/DispositionBar.jsx';
import {
  STATUSES, TEMPERATURES, OCCUPANCY,
  titleize, formatPhone, fullAddress, fullDate, timeAgo,
} from '../lib/format.js';

const money = (v) => `$${Number(v).toLocaleString()}`;

export default function LeadDetail({ id }) {
  const [lead, setLead] = useState(null);
  const [activity, setActivity] = useState([]);
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
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
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const patch = useCallback(async (fields) => {
    setErr(null);
    setLead((prev) => ({ ...prev, ...fields }));   // optimistic
    const { error } = await supabase.from('leads').update(fields).eq('id', id);
    if (error) setErr(error.message);
    load();                                        // truth, plus any activity the triggers wrote
  }, [id, load]);

  // Numbers arrive from inputs as strings; the columns are integers.
  const patchNumber = (field) => (v) =>
    patch({ [field]: v === null ? null : Number(String(v).replace(/[^\d.-]/g, '')) || null });

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
  const dialable =
    !lead.is_dnc && !lead.is_litigator && !lead.phone_invalid && Boolean(phone) &&
    ((lead.source === 'website' && lead.tcpa_opt_in) || (lead.skip_traced && lead.dnc_scrubbed));

  return (
    <>
      <header>
        <h1>{lead.address || lead.name || 'Lead'}</h1>
        <span className="count">{fullAddress(lead)}</span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <button className="btn ghost" onClick={() => navigate('/')}>← All leads</button>
        {phone && dialable && (
          <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>Call {formatPhone(phone)}</a>
        )}
        {phone && !dialable && (
          <span className="badge stop" style={{ alignSelf: 'center' }}>
            Do not call — {lead.is_dnc ? 'on DNC' : lead.is_litigator ? 'known litigator'
              : lead.phone_invalid ? 'wrong number' : 'not scrubbed'}
          </span>
        )}
        <select value={lead.status} onChange={(e) => patch({ status: e.target.value })}>
          {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={lead.temperature} onChange={(e) => patch({ temperature: e.target.value })}>
          {TEMPERATURES.map((t) => <option key={t} value={t}>{titleize(t)}</option>)}
        </select>
      </div>

      <div className="card">
        <h2>Log a call</h2>
        <div className="body">
          <DispositionBar leadId={id} onDone={load} />
        </div>
      </div>

      <div className="detail">
        <div>
          <div className="card">
            <h2>Seller</h2>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Name"   value={lead.name}  onSave={(v) => patch({ name: v })} />
                <InlineField label="Phone"  value={lead.phone} onSave={(v) => patch({ phone: v })} format={formatPhone} />
                <InlineField label="Email"  value={lead.email} onSave={(v) => patch({ email: v })} type="email" />
                <InlineField label="Second contact" value={lead.co_contact_name} onSave={(v) => patch({ co_contact_name: v })} placeholder="spouse, sibling, executor…" />
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Qualifying</h2>
            <p className="cardnote">
              The answers that decide whether this is a deal. Click any value to edit.
            </p>
            <div className="body">
              <dl className="facts editable">
                <InlineField label="Motivation" value={lead.motivation} onSave={(v) => patch({ motivation: v })} placeholder="why are they selling?" />
                <InlineField label="Timeline"   value={lead.timeline}   onSave={(v) => patch({ timeline: v })} placeholder="how fast do they need out?" />
                <InlineField label="Occupancy"  value={lead.occupancy}  onSave={(v) => patch({ occupancy: v })} options={OCCUPANCY} />
                <InlineField label="Condition"  value={lead.condition_notes} onSave={(v) => patch({ condition_notes: v })} type="textarea" placeholder="roof, HVAC, foundation, what they volunteered" />
                <InlineField label="Asking"     value={lead.asking_price}  onSave={patchNumber('asking_price')}  format={money} placeholder="what do they want?" />
                <InlineField label="ARV est."   value={lead.arv_estimate}  onSave={patchNumber('arv_estimate')}  format={money} />
                <InlineField label="Repairs est." value={lead.repair_estimate} onSave={patchNumber('repair_estimate')} format={money} />
                <InlineField label="Mortgage"   value={lead.mortgage_balance} onSave={patchNumber('mortgage_balance')} format={money} />
              </dl>

              <div className="flags">
                <Flag label="Already listed with an agent" on={lead.already_listed}
                      onChange={(v) => patch({ already_listed: v })} />
                <Flag label="Under contract with someone else" on={lead.under_contract_elsewhere}
                      onChange={(v) => patch({ under_contract_elsewhere: v })} />
                <Flag label="Liens or back taxes" on={lead.has_liens}
                      onChange={(v) => patch({ has_liens: v })} />
              </div>
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
                  {/* Mirrors lead_is_dialable(). The database is the enforcement
                      point; this is only the readout. */}
                  {dialable ? <span className="badge ok">Yes</span> : (
                    <span className="badge stop">
                      {lead.is_dnc ? 'On DNC'
                        : lead.is_litigator ? 'Litigator'
                        : lead.phone_invalid ? 'Wrong number'
                        : !phone ? 'No number'
                        : 'Not scrubbed'}
                    </span>
                  )}
                </dd>
                <dt>Attempts</dt><dd>{lead.call_attempts}</dd>
                <dt>Last contact</dt><dd>{lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : 'never'}</dd>
                <dt>Next follow-up</dt><dd>{lead.next_follow_up_at ? fullDate(lead.next_follow_up_at) : '—'}</dd>
                <dt>TCPA opt-in</dt><dd>{lead.tcpa_opt_in ? fullDate(lead.tcpa_opt_in_at) : 'No'}</dd>
                <dt>Consent</dt>
                <dd>{[lead.consent_sms && 'SMS', lead.consent_email && 'Email'].filter(Boolean).join(' · ') || 'None'}</dd>
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

function Flag({ label, on, onChange }) {
  return (
    <label className="flag">
      <input type="checkbox" checked={Boolean(on)} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
