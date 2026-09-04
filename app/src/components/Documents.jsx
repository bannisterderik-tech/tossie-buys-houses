import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { useCan } from '../lib/capabilities.jsx';
import { timeAgo, titleize } from '../lib/format.js';

/**
 * Files about a property, on the lead or on the deal.
 *
 * One component for both, because they are the same documents. A probate
 * letter arrives weeks before a contract does; attaching it to a deal that does
 * not exist yet is impossible, and holding it in email until one does is how it
 * gets lost. Uploaded to a lead it follows that lead into its deal on its own,
 * the same way photos and contracts already do.
 *
 * The bucket is private and nothing here stores a URL. Every open mints a
 * signed link good for a minute — a stored signed URL is a credential that
 * outlives whoever it was minted for, and these are people's death
 * certificates and payoff statements.
 */

const BUCKET = 'deal-documents';

/** Ordered by when they turn up, not alphabetically. */
const KINDS = [
  'seller_disclosure', 'probate_paperwork', 'death_certificate', 'payoff_statement',
  'tax_notice', 'code_violation', 'lien_notice', 'lease_agreement',
  'insurance_claim', 'id_document', 'comps', 'inspection_report',
  'purchase_agreement', 'assignment_agreement', 'addendum', 'emd_receipt',
  'proof_of_funds', 'title_commitment', 'settlement_statement', 'other',
];

const prettyBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export default function Documents({ subject, subjectId, teamId }) {
  const { can } = useCan();
  const editable = can('leads.edit') || can('deals.edit');
  const column = subject === 'deal' ? 'deal_id' : 'lead_id';

  const [docs, setDocs] = useState([]);
  const [kind, setKind] = useState('seller_disclosure');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const input = useRef(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_documents').select('*')
      .eq(column, subjectId)
      .order('created_at', { ascending: false });
    if (error) setErr(error.message);
    setDocs(data ?? []);
    setLoading(false);
  }, [column, subjectId]);

  useEffect(() => { load(); }, [load]);

  async function upload(e) {
    const files = Array.from(e.target.files ?? []);
    // Cleared immediately so the same file can be picked again after a failure;
    // otherwise onChange never fires twice and the button looks dead.
    e.target.value = '';
    if (!files.length) return;

    setBusy(true);
    setErr(null);
    const { data: who } = await supabase.auth.getUser();
    const failures = [];

    for (const file of files) {
      // Team first in the key so the storage policy can scope on it without a
      // join — the same convention every other object in this project uses.
      const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80);
      const path = `${teamId}/${subject}/${subjectId}/${Date.now()}-${safe}`;

      const { error: upErr } = await supabase.storage.from(BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (upErr) { failures.push(`${file.name}: ${hint(upErr)}`); continue; }

      const { error } = await supabase.from('deal_documents').insert({
        team_id: teamId,
        [column]: subjectId,
        kind,
        bucket: BUCKET,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type || null,
        size_bytes: file.size,
        uploaded_by: who?.user?.id ?? null,
      });
      if (error) {
        // The row is the record. A file with no row is invisible to every
        // screen and to RLS, so it goes back out rather than sitting in the
        // bucket findable by nothing and billable forever.
        await supabase.storage.from(BUCKET).remove([path]);
        failures.push(`${file.name}: ${error.message}`);
      }
    }

    setBusy(false);
    if (failures.length) setErr(failures.join(' · '));
    await load();
  }

  async function open(doc) {
    const { data, error } = await supabase.storage
      .from(doc.bucket).createSignedUrl(doc.storage_path, 60);
    if (error) { setErr(hint(error)); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function remove(doc) {
    if (!window.confirm(`Remove ${doc.file_name || 'this file'}? It is deleted too.`)) return;
    const { error } = await supabase.from('deal_documents').delete().eq('id', doc.id);
    if (error) { setErr(error.message); return; }
    await supabase.storage.from(doc.bucket).remove([doc.storage_path]);
    await load();
  }

  if (loading) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Files {docs.length > 0 && `· ${docs.length}`}</h2>
      <p className="cardnote">
        Disclosures, probate paperwork, payoff letters, tax notices — anything the seller sends
        over. Stored privately; links are minted when you open one and expire in a minute.
        {subject === 'lead' && ' These follow the property onto the deal when a contract is signed.'}
      </p>
      <div className="body">
        {err && <div className="err">{err}</div>}

        {editable && (
          <div className="uploadbar">
            <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
              {KINDS.map((k) => <option key={k} value={k}>{titleize(k)}</option>)}
            </select>
            <button className="btn ghost" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Uploading…' : 'Choose files'}
            </button>
            <input ref={input} type="file" multiple hidden onChange={upload} />
          </div>
        )}

        {docs.length === 0 ? (
          <p className="colempty">Nothing uploaded yet.</p>
        ) : (
          <ul className="docs">
            {docs.map((d) => (
              <li key={d.id}>
                <button className="linkbtn name" onClick={() => open(d)}>
                  <strong>{d.file_name || d.storage_path.split('/').pop()}</strong>
                </button>
                <span className="sub">
                  <span className="badge">{titleize(d.kind)}</span>
                  {' '}{prettyBytes(d.size_bytes)} · {timeAgo(d.created_at)}
                  {subject === 'lead' && d.deal_id && ' · also on the deal'}
                </span>
                {editable && (
                  <button className="linkbtn danger" onClick={() => remove(d)}>remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Storage errors arrive as one line that does not say which half of the setup
 * is missing, and the two halves fail identically from the operator's side.
 */
function hint(error) {
  const msg = error?.message || 'Upload failed';
  if (/mime|content type|not supported|invalid_mime/i.test(msg)) {
    return `Storage refused that file type (${msg}). The "${BUCKET}" bucket has an allowed_mime_types list; clearing it accepts anything, and who may upload is already decided by the storage policies.`;
  }
  if (/bucket/i.test(msg) && /not found|does not exist/i.test(msg)) {
    return `The "${BUCKET}" bucket does not exist. It must be created PRIVATE — these are disclosures and death certificates.`;
  }
  if (/row-level security|policy|not authorized|Unauthorized/i.test(msg)) {
    return `Storage refused this (${msg}). The bucket needs policies on storage.objects scoped to this team — the object key starts with the team id for exactly that.`;
  }
  return msg;
}
