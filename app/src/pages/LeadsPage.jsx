import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { STATUSES, TEMPERATURES, titleize, formatPhone, fullAddress, timeAgo } from '../lib/format.js';

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [temp, setTemp] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('trashed', false)
        .order('created_at', { ascending: false })
        .limit(500);

      if (cancelled) return;
      if (error) setErr(error.message);
      else setLeads(data ?? []);
      setLoading(false);
    }

    load();

    // A lead arriving from the website form should appear without a refresh —
    // that is the whole point of the exit test for this phase.
    const channel = supabase
      .channel('leads-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, load)
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (status && l.status !== status) return false;
      if (temp && l.temperature !== temp) return false;
      if (!needle) return true;
      return [l.name, l.address, l.city, l.zip, l.phone, l.email, l.owner_name]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(needle));
    });
  }, [leads, q, status, temp]);

  if (loading) return <div className="empty">Loading leads…</div>;

  return (
    <>
      <header>
        <h1>Leads</h1>
        <span className="count">
          {shown.length === leads.length
            ? `${leads.length} total`
            : `${shown.length} of ${leads.length}`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <input
          placeholder="Search address, name, phone, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{titleize(s)}</option>)}
        </select>
        <select value={temp} onChange={(e) => setTemp(e.target.value)}>
          <option value="">Any temperature</option>
          {TEMPERATURES.map((t) => <option key={t} value={t}>{titleize(t)}</option>)}
        </select>
      </div>

      <div className="card">
        {shown.length === 0 ? (
          <div className="empty">
            <strong>{leads.length ? 'Nothing matches those filters' : 'No leads yet'}</strong>
            {leads.length === 0 && 'Submit the form on tossiebuyshouses.com and it will land here.'}
          </div>
        ) : (
          <table className="leads">
            <thead>
              <tr>
                <th>Property</th>
                <th>Seller</th>
                <th className="hide-sm">Source</th>
                <th>Status</th>
                <th className="hide-sm">Temp</th>
                <th className="hide-sm">Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => navigate(`/leads/${l.id}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <span className="addr">{l.address || '—'}</span>
                    <span className="sub">{fullAddress(l).replace(`${l.address} · `, '') || '—'}</span>
                  </td>
                  <td>
                    {l.name || l.owner_name || '—'}
                    <span className="sub">{formatPhone(l.phone || l.phone_mobile)}</span>
                  </td>
                  <td className="hide-sm"><span className="badge">{titleize(l.source)}</span></td>
                  <td><span className="badge">{titleize(l.status)}</span></td>
                  <td className="hide-sm"><span className={`badge ${l.temperature}`}>{titleize(l.temperature)}</span></td>
                  <td className="hide-sm sub">{timeAgo(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
