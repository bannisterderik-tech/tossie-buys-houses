import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { formatPhone, fullAddress, titleize, timeAgo } from '../lib/format.js';

/**
 * What is due right now.
 *
 * This is the page the day starts on. It reads the due_leads view, which is the
 * same lead_is_dialable() the dialer will use to build its call list in Phase 2
 * — so a lead that shows "call" here is a lead the dialer will accept, and one
 * marked not-dialable is telling you the compliance work is not done yet
 * rather than quietly disappearing.
 */
export default function TodayPage() {
  const [due, setDue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  async function load() {
    const { data, error } = await supabase
      .from('due_leads')
      .select('*')
      .order('next_follow_up_at', { ascending: true });
    if (error) setErr(error.message);
    else setDue(data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="empty">Loading…</div>;

  const callable = due.filter((l) => l.dialable);
  const blocked = due.filter((l) => !l.dialable);

  return (
    <>
      <header>
        <h1>Today</h1>
        <span className="count">
          {due.length === 0 ? 'nothing due' : `${due.length} due · ${callable.length} callable`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {due.length === 0 ? (
        <div className="card">
          <div className="empty">
            <strong>Nothing due</strong>
            Follow-ups appear here when their time arrives. Disposition a call to schedule one.
          </div>
        </div>
      ) : (
        <>
          <Group
            title="Ready to call"
            leads={callable}
            empty="Nothing callable is due."
          />
          {blocked.length > 0 && (
            <Group
              title="Due, but not callable yet"
              leads={blocked}
              note="These need a skip trace and DNC scrub before the dialer will take them, or they have been marked do-not-call."
            />
          )}
        </>
      )}
    </>
  );
}

function Group({ title, leads, empty, note }) {
  return (
    <div className="card">
      <h2>{title} {leads.length > 0 && `· ${leads.length}`}</h2>
      {note && <p className="cardnote">{note}</p>}
      {leads.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <table className="leads">
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} onClick={() => navigate(`/leads/${l.id}`)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="addr">{l.address || l.name || 'Untitled'}</span>
                  <span className="sub">{fullAddress(l).replace(`${l.address} · `, '')}</span>
                </td>
                <td>
                  {l.name || '—'}
                  <span className="sub">{formatPhone(l.phone || l.phone_mobile)}</span>
                </td>
                <td className="hide-sm"><span className="badge">{titleize(l.status)}</span></td>
                <td className="hide-sm sub">
                  due {timeAgo(l.next_follow_up_at)}
                  {l.call_attempts > 0 && <><br />{l.call_attempts} attempt{l.call_attempts === 1 ? '' : 's'}</>}
                </td>
                <td>
                  {l.dialable && (l.phone || l.phone_mobile) ? (
                    <a
                      className="btn"
                      href={`tel:${(l.phone || l.phone_mobile).replace(/[^\d+]/g, '')}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Call
                    </a>
                  ) : (
                    <span className="badge stop">
                      {l.is_dnc ? 'DNC' : l.phone_invalid ? 'Bad number' : 'Not scrubbed'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
