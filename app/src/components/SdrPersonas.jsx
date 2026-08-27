import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEAM_ID } from '../lib/team.js';
import { useCan } from '../lib/capabilities.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * Personas, and the feedback that shapes them.
 *
 * A probate lead and a website enquiry should not be opened the same way, and
 * one global "personality" setting could not say so. A persona carries the
 * voice plus two blocks of the operator's own words — extra rules, and how to
 * open — which are appended to the prompt after the hard rules and cannot
 * override them. A persona that said "you may quote a range" would still be
 * refused by the price filter on the way out.
 *
 * On the third block: this is prompt refinement, not model training. Nothing
 * here changes any weights, and calling it training would set the wrong
 * expectation about how it behaves. A thumbs-down with a note is evidence;
 * pressing Apply appends that note, dated, to the persona's standing guidance,
 * and that text is what the next message actually reads. The whole chain stays
 * visible and editable — which matters, because a wrong correction makes the
 * SDR worse and you need to be able to find it and delete the line.
 */
const TONES = [
  { key: 'balanced',   label: 'Balanced',   blurb: 'Straightforward and warm. The default.' },
  { key: 'supportive', label: 'Supportive', blurb: 'Patient, low-pressure. For people in a hard spot.' },
  { key: 'aggressive', label: 'Direct',     blurb: 'Assumptive, asks for the appointment early.' },
];

export default function SdrPersonas() {
  const { can } = useCan();
  const manage = can('sdr.manage');
  const [personas, setPersonas] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [p, f] = await Promise.all([
      supabase.from('sdr_personas').select('*').order('is_default', { ascending: false }).order('name'),
      supabase
        .from('sdr_message_feedback')
        .select('*, leads(id, address, name)')
        .eq('applied', false)
        .order('created_at', { ascending: false })
        .limit(30),
    ]);
    if (p.error) setErr(p.error.message);
    setPersonas(p.data ?? []);
    setFeedback(f.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(id, fields) {
    setBusy(id);
    const { error } = await supabase.from('sdr_personas').update(fields).eq('id', id);
    if (error) setErr(error.message);
    setBusy(null);
    setEditing(null);
    await load();
  }

  async function create() {
    setBusy('new');
    const { error } = await supabase.from('sdr_personas').insert({
      team_id: TEAM_ID,
      name: 'New persona',
      description: 'What kind of lead is this for?',
      personality: 'balanced',
    });
    if (error) setErr(error.message);
    setBusy(null);
    await load();
  }

  async function applyFeedback(id) {
    setBusy(id);
    const { error } = await supabase.rpc('apply_sdr_feedback', { p_feedback_id: id });
    if (error) setErr(error.message);
    setBusy(null);
    await load();
  }

  async function dismiss(id) {
    setBusy(id);
    // Marked applied rather than deleted: the rating is still the record that
    // somebody read this message and judged it, which is worth keeping even
    // when the note was not worth teaching.
    const { error } = await supabase.from('sdr_message_feedback').update({ applied: true }).eq('id', id);
    if (error) setErr(error.message);
    setBusy(null);
    await load();
  }

  if (loading) return null;

  return (
    <>
      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Scripts · {personas.length}</span>
          {manage && (
            <button className="btn ghost" disabled={busy === 'new'} onClick={create}>New script</button>
          )}
        </h2>
        <div className="body">
          {err && <div className="err">{err}</div>}
          <p className="cardnote">
            One script per kind of lead. Everything here is added <strong>after</strong> the
            hard rules — never naming a price, never claiming to be a human being, never giving
            legal advice — so a script cannot loosen them. It can only change the voice, add
            rules of its own, and say how to open.
          </p>

          {personas.map((p) => (
            <div key={p.id} className="pickerblock" style={{ marginBottom: 12 }}>
              {editing === p.id ? (
                <PersonaForm
                  persona={p}
                  busy={busy === p.id}
                  onCancel={() => setEditing(null)}
                  onSave={(fields) => save(p.id, fields)}
                />
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                    <strong>
                      {p.name}
                      {p.is_default && <span className="badge ok" style={{ marginLeft: 8 }}>default</span>}
                      {!p.active && <span className="badge stop" style={{ marginLeft: 8 }}>off</span>}
                    </strong>
                    {manage && (
                      <button className="btn ghost" onClick={() => setEditing(p.id)}>Edit</button>
                    )}
                  </div>
                  <p className="fine" style={{ margin: '4px 0 0' }}>
                    {[p.description, TONES.find((t) => t.key === p.personality)?.label]
                      .filter(Boolean).join(' · ')}
                  </p>
                  {p.learned_guidance && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="fine" style={{ cursor: 'pointer' }}>
                        {p.learned_guidance.split('\n').filter(Boolean).length} correction(s) learned
                      </summary>
                      <pre className="fine" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
                        {p.learned_guidance}
                      </pre>
                    </details>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Feedback waiting · {feedback.length}</h2>
        <div className="body">
          <p className="cardnote">
            Rate what the SDR sends and it gets better at this list specifically. A thumbs-down
            <strong> with a note </strong> can be applied to a script, which appends the note to
            its standing guidance — dated, visible, and deletable if it turns out to be wrong.
            No model weights change; this edits the instructions.
          </p>

          {feedback.length === 0 ? (
            <div className="empty">
              <strong>Nothing waiting</strong>
              Thumbs-up and thumbs-down on any message the SDR wrote will collect here.
            </div>
          ) : (
            <table className="leads">
              <tbody>
                {feedback.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <span className="addr">
                        <span className={`badge ${f.rating === 'up' ? 'ok' : 'stop'}`}>
                          {f.rating === 'up' ? 'Good' : 'Bad'}
                        </span>
                        {' '}
                        {f.leads?.address || f.leads?.name || 'Lead'}
                      </span>
                      <span className="sub">&ldquo;{f.body.slice(0, 120)}{f.body.length > 120 ? '…' : ''}&rdquo;</span>
                      {f.note && <span className="sub"><strong>Note:</strong> {f.note}</span>}
                      <span className="sub">{timeAgo(f.created_at)}</span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {manage && (
                        <>
                          {f.note
                            ? (
                              <button className="btn ghost" disabled={busy === f.id}
                                      onClick={() => applyFeedback(f.id)}>
                                Teach this
                              </button>
                            )
                            : <span className="sub" title="A rating with no note has nothing to teach">no note</span>}
                          {' '}
                          <button className="btn ghost" disabled={busy === f.id} onClick={() => dismiss(f.id)}>
                            Dismiss
                          </button>
                        </>
                      )}
                    </td>
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

function PersonaForm({ persona, busy, onCancel, onSave }) {
  const [f, setF] = useState({
    name: persona.name ?? '',
    description: persona.description ?? '',
    personality: persona.personality ?? 'balanced',
    custom_rules: persona.custom_rules ?? '',
    opener_guidance: persona.opener_guidance ?? '',
    learned_guidance: persona.learned_guidance ?? '',
    active: persona.active,
  });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <>
      <div className="fields">
        <label>
          Name
          <input value={f.name} onChange={set('name')} placeholder="Probate / inherited" />
        </label>
        <label>
          What kind of lead is this for?
          <input value={f.description} onChange={set('description')}
                 placeholder="Inherited property, often several heirs" />
        </label>
        <label>
          Voice
          <select value={f.personality} onChange={set('personality')}>
            {TONES.map((t) => <option key={t.key} value={t.key}>{t.label} — {t.blurb}</option>)}
          </select>
        </label>
      </div>

      <label className="consentfield">
        Extra rules <span className="fine">plain sentences; added after the hard rules, cannot override them</span>
        <textarea rows={4} value={f.custom_rules} onChange={set('custom_rules')}
                  placeholder={'Never assume they want to sell — an inherited house is often a decision nobody has made yet.\nAsk early whether anyone else is on the deed.'} />
      </label>

      <label className="consentfield">
        How to open <span className="fine">the single highest-leverage sentence in the script</span>
        <textarea rows={3} value={f.opener_guidance} onChange={set('opener_guidance')}
                  placeholder="Lead with condolences only if the record says the owner died. Otherwise open on the property, not the person." />
      </label>

      <label className="consentfield">
        Learned corrections <span className="fine">grown from feedback; edit or clear freely</span>
        <textarea rows={4} value={f.learned_guidance} onChange={set('learned_guidance')} />
      </label>

      <label className="check">
        <input type="checkbox" checked={f.active}
               onChange={(e) => setF((p) => ({ ...p, active: e.target.checked }))} />
        <span>
          <strong>Active.</strong>
          <small>Turned off, leads on this script fall back to the default one.</small>
        </span>
      </label>

      <div className="followup-exact" style={{ marginTop: 10 }}>
        <button className="btn" disabled={busy || !f.name.trim()} onClick={() => onSave(f)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
