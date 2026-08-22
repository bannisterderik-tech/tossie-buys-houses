import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { useCan } from '../lib/capabilities.jsx';
import { timeAgo, titleize } from '../lib/format.js';
import {
  BUYER_ENTITY, defaultFields, longDate, money, renderContract,
} from '../lib/contract-psa.js';
import './contract.css';

/**
 * Write an offer on this property.
 *
 * The terms are collected in a modal and the document is produced from them,
 * because the alternative — the way it works today — is retyping the address,
 * the seller's name and the price into a Word file that already sits on the
 * lead. That retyping is not just slow; it is where a transposed digit gets
 * into a binding document, and the lead is the only place the correct value is
 * known to be correct.
 *
 * After Generate the rendered text is editable. Every deal has one clause
 * somebody negotiated, and a generator that cannot be argued with is one that
 * gets abandoned the first time a seller asks for a fourteen-day close. Editing
 * sets body_edited, so regenerating can warn before it discards that work
 * rather than silently reverting it.
 *
 * Printing is the browser's own, deliberately. It produces a real PDF with
 * selectable text, needs no library in the bundle, and — unlike a rasterised
 * export — leaves a document a closing attorney can search.
 */
export default function ContractPanel({ subject, subjectId, teamId, lead }) {
  const { can } = useCan();
  const editable = can('leads.edit') || can('deals.edit');
  const column = subject === 'deal' ? 'deal_id' : 'lead_id';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('contracts').select('*')
      .eq(column, subjectId)
      .order('created_at', { ascending: false });
    if (error) setErr(error.message);
    setRows(data ?? []);
    setLoading(false);
  }, [column, subjectId]);

  useEffect(() => { load(); }, [load]);

  async function remove(row) {
    if (!window.confirm('Delete this contract? The generated document goes with it.')) return;
    const { error } = await supabase.from('contracts').delete().eq('id', row.id);
    if (error) { setErr(error.message); return; }
    setOpenId(null);
    await load();
  }

  if (loading) return null;
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="card">
      <h2 className="galleryhead">
        <span>Contracts {rows.length > 0 && `· ${rows.length}`}</span>
        {editable && (
          <button className="btn ghost" onClick={() => setComposing(true)}>New offer</button>
        )}
      </h2>
      <p className="cardnote">
        Coastal GA Property Solutions&rsquo; own purchase agreement, filled in from this record.
        Everything except the blanks is the company&rsquo;s standing wording and is reproduced as
        written — check it against the signed copy before it goes to a seller.
      </p>

      <div className="body">
        {err && <div className="err">{err}</div>}

        {rows.length === 0 ? (
          <p className="colempty">No offer written yet.</p>
        ) : (
          <ul className="docs">
            {rows.map((r) => (
              <li key={r.id}>
                <button className="linkbtn name" onClick={() => setOpenId(r.id)}>
                  <strong>{r.title || 'Purchase agreement'}</strong>
                </button>
                <span className="sub">
                  <span className={`badge ${r.status === 'signed' ? 'ok' : r.status === 'void' ? 'stop' : ''}`}>
                    {titleize(r.status)}
                  </span>
                  {r.fields?.purchase_price ? ` ${money(r.fields.purchase_price)}` : ''}
                  {r.fields?.closing_date ? ` · closes ${longDate(r.fields.closing_date)}` : ''}
                  {' · '}{timeAgo(r.created_at)}
                  {r.body_edited && ' · edited by hand'}
                </span>
                {editable && (
                  <button className="linkbtn danger" onClick={() => remove(r)}>delete</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {composing && (
        <OfferModal
          lead={lead}
          teamId={teamId}
          column={column}
          subjectId={subjectId}
          onClose={() => setComposing(false)}
          onSaved={async (id) => { setComposing(false); await load(); setOpenId(id); }}
        />
      )}

      {open && (
        <ContractViewer
          row={open}
          editable={editable}
          onClose={() => setOpenId(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

/* ── the terms ───────────────────────────────────────────────────────────── */

const FIELDS = [
  { key: 'seller_name', label: 'Seller', hint: 'exactly as it should appear on the deed' },
  { key: 'buyer_name', label: 'Buyer' },
  { key: 'subject_property', label: 'Subject property', wide: true },
  { key: 'legal_description', label: 'Legal description', wide: true,
    hint: 'from the deed or the county record — leave blank and the contract prints a ruled line' },
  { key: 'purchase_price', label: 'Purchase price', money: true },
  { key: 'emd_amount', label: 'Earnest money', money: true },
  { key: 'agreement_date', label: 'Agreement date', type: 'date' },
  { key: 'acceptance_deadline', label: 'Offer expires', type: 'date',
    hint: 'unsigned by this date and the contract is void' },
  { key: 'closing_date', label: 'Closing on or before', type: 'date' },
  { key: 'title_company', label: 'Title company', wide: true },
  { key: 'governing_state', label: 'Governing law — state of' },
];

function OfferModal({ lead, teamId, column, subjectId, onClose, onSaved }) {
  const [f, setF] = useState(() => defaultFields(lead ?? {}));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  // Escape closes, because a full-screen overlay with only a Cancel button is
  // a trap on a keyboard.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function generate() {
    setBusy(true);
    setErr(null);
    const { data: who } = await supabase.auth.getUser();
    const body = renderContract(f, { logo: typeof __BIZ__ !== 'undefined' ? __BIZ__.logo : null });

    const { data, error } = await supabase.from('contracts').insert({
      team_id: teamId,
      [column]: subjectId,
      template_key: 'psa_v1',
      title: f.subject_property
        ? `Purchase agreement — ${f.subject_property}`
        : 'Purchase agreement',
      fields: f,
      body,
      created_by: who?.user?.id ?? null,
    }).select('id').single();

    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onSaved(data.id);
  }

  return (
    <div className="modalwrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New offer</h2>
        <div className="modalbody">
          {err && <div className="err">{err}</div>}

          <p className="fine" style={{ marginTop: 0 }}>
            Prefilled from this lead. The buyer is <strong>{BUYER_ENTITY}</strong> — the trading name
            is deliberately left off the contract.
          </p>

          <div className="fields">
            {FIELDS.map((x) => (
              <label key={x.key} className={x.wide ? 'wide' : undefined}>
                <span>
                  {x.label}
                  {x.hint && <em> {x.hint}</em>}
                </span>
                <input
                  type={x.type || 'text'}
                  inputMode={x.money ? 'decimal' : undefined}
                  value={f[x.key] ?? ''}
                  onChange={set(x.key)}
                  placeholder={x.money ? '0.00' : undefined}
                />
              </label>
            ))}
          </div>

          <fieldset className="accessopts">
            <legend>Pictures &amp; access</legend>
            <label className="check">
              <input
                type="radio"
                name="access"
                checked={f.access_method === 'seller_places_lockbox'}
                onChange={() => setF((p) => ({ ...p, access_method: 'seller_places_lockbox' }))}
              />
              <span><strong>Seller puts a key in a lockbox</strong>
                <small>on the front door of the subject property</small></span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="access"
                checked={f.access_method === 'buyer_places_lockbox'}
                onChange={() => setF((p) => ({ ...p, access_method: 'buyer_places_lockbox' }))}
              />
              <span><strong>Seller hands the key to us</strong>
                <small>and we place the lockbox</small></span>
            </label>
          </fieldset>

          <label className="consentfield">
            Other agreements <span className="fine">one per line; prints in the box on the form</span>
            <textarea rows={4} value={f.other_agreements} onChange={set('other_agreements')} />
          </label>
        </div>

        <div className="modalfoot">
          <button className="btn" disabled={busy} onClick={generate}>
            {busy ? 'Generating…' : 'Generate contract'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ── read it, change it, print it ────────────────────────────────────────── */

const STATUSES = ['draft', 'sent', 'signed', 'void'];

function ContractViewer({ row, editable, onClose, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !editing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  async function save() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('contracts')
      .update({ body: ref.current?.innerHTML ?? row.body, body_edited: true })
      .eq('id', row.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setEditing(false);
    await onSaved();
  }

  async function setStatus(status) {
    const { error } = await supabase.from('contracts').update({ status }).eq('id', row.id);
    if (error) { setErr(error.message); return; }
    await onSaved();
  }

  async function regenerate() {
    if (row.body_edited && !window.confirm(
      'This contract has been edited by hand. Regenerating rebuilds it from the '
      + 'terms and those edits will be lost. Continue?'
    )) return;
    setBusy(true);
    const body = renderContract(row.fields ?? {}, {
      logo: typeof __BIZ__ !== 'undefined' ? __BIZ__.logo : null,
    });
    const { error } = await supabase.from('contracts')
      .update({ body, body_edited: false }).eq('id', row.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onSaved();
  }

  return (
    <div className="modalwrap contractwrap" onClick={() => !editing && onClose()}>
      <div className="modal contractmodal" onClick={(e) => e.stopPropagation()}>
        <div className="contractbar">
          <strong>{row.title || 'Purchase agreement'}</strong>
          {editable && (
            <select value={row.status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
            </select>
          )}
          <span className="spacer" />
          {editable && !editing && (
            <>
              <button className="btn ghost" onClick={() => setEditing(true)}>Edit text</button>
              <button className="btn ghost" disabled={busy} onClick={regenerate}>Regenerate</button>
            </>
          )}
          {editing && (
            <>
              <button className="btn" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          )}
          <button className="btn" onClick={() => window.print()}>Print / Save PDF</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        {err && <div className="err" style={{ margin: '0 14px' }}>{err}</div>}
        {editing && (
          <p className="fine editnote">
            Editing the document itself. The terms above it stay as they were — this changes the
            words on the page, which is what a negotiated clause needs.
          </p>
        )}

        <div className="paper">
          <div
            ref={ref}
            className="printable"
            contentEditable={editing}
            suppressContentEditableWarning
            dangerouslySetInnerHTML={{ __html: row.body || '' }}
          />
        </div>
      </div>
    </div>
  );
}
