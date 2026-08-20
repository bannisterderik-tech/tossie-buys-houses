import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import {
  formatPhone, fullAddress, titleize, timeAgo,
  clockTone, countdownLabel, daysUntil, dateOnly,
} from '../lib/format.js';
import { money } from '../lib/buyers.js';
import { useCan } from '../lib/capabilities.jsx';

/**
 * What to do today, in the order it costs money to ignore.
 *
 * It used to show one thing: leads whose follow-up had come due. That is the
 * right centre of the page and it is not enough to open a business on, for two
 * reasons found by actually looking at the data.
 *
 * First, a contract deadline is worth more than a callback and nothing was
 * watching one. deal_milestones has held the inspection and closing dates since
 * the deals shipped, format.js has a whole escalation ladder for them, and no
 * code anywhere read either — eight live contracts, ~$2.9M, and the only place
 * the dates appeared was on a deal page somebody had to think to open. They are
 * now the first thing on this screen.
 *
 * Second, a brand-new install has no follow-ups by definition, so the page that
 * is supposed to start the day read "Nothing due" over 347 leads nobody had
 * ever called. Never-contacted leads are now the backstop section: not urgent,
 * always something.
 *
 * These are on-screen prompts, not push. Nothing here emails or texts anybody —
 * an outbound alert would either need SMTP that is not configured or would put
 * internal traffic on the 10DLC campaign registered for seller messaging. Worth
 * knowing if you were expecting your phone to buzz.
 */
export default function TodayPage() {
  const { can } = useCan();
  const [due, setDue] = useState([]);
  const [clocks, setClocks] = useState([]);
  const [cold, setCold] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const [d, m, c] = await Promise.all([
      supabase.from('due_leads').select('*').order('next_follow_up_at', { ascending: true }),

      // Terminal deals carry no live milestones — sync_deal_milestones deletes
      // the outstanding ones when a deal dies — so an inner join to a
      // non-trashed deal is all the filtering this needs.
      supabase
        .from('deal_milestones')
        .select('id, kind, label, due_at, deals!inner(id, address, city, state, status, contract_price, trashed)')
        .is('completed_at', null)
        .eq('deals.trashed', false)
        .order('due_at', { ascending: true })
        .limit(25),

      // The backstop. Never called, never scheduled, still alive — ordered
      // newest first because a lead that arrived this morning is the most
      // likely conversation of the day.
      supabase
        .from('leads')
        .select('id, name, address, city, state, zip, phone, phone_mobile, status, created_at, dialable:lead_is_dialable')
        .eq('trashed', false)
        .eq('call_attempts', 0)
        .is('next_follow_up_at', null)
        .not('status', 'in', '("dead","closed")')
        .order('created_at', { ascending: false })
        .limit(15),
    ]);

    const failure = d.error || m.error || c.error;
    setErr(failure ? failure.message : null);
    setDue(d.data ?? []);
    setClocks(m.data ?? []);
    setCold(c.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="empty">Loading…</div>;

  const callable = due.filter((l) => l.dialable);
  const blocked = due.filter((l) => !l.dialable);
  const late = clocks.filter((m) => daysUntil(m.due_at) < 0).length;

  const headline = [
    clocks.length > 0 && `${clocks.length} deadline${clocks.length === 1 ? '' : 's'}`,
    late > 0 && `${late} overdue`,
    due.length > 0 && `${due.length} follow-up${due.length === 1 ? '' : 's'} due`,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <header>
        <h1>Today</h1>
        <span className="count">{headline || 'nothing scheduled'}</span>
      </header>

      {err && <div className="err">{err}</div>}

      {can('deals.view') && clocks.length > 0 && (
        <div className="card">
          <h2>Contract deadlines · {clocks.length}</h2>
          <p className="cardnote">
            Inspection and closing dates on live contracts. These are the dates that cost
            real money when they pass — an inspection period that lapses is earnest money
            that stopped being refundable.
          </p>
          <div className="body">
            <table className="leads">
              <tbody>
                {clocks.map((m) => {
                  const days = daysUntil(m.due_at);
                  const tone = clockTone(days, m.kind === 'inspection_end' ? 'inspection' : 'closing');
                  return (
                    <tr key={m.id} onClick={() => navigate(`/deals/${m.deals.id}`)} style={{ cursor: 'pointer' }}>
                      <td>
                        <span className="addr">{m.deals.address}</span>
                        <span className="sub">
                          {[[m.deals.city, m.deals.state].filter(Boolean).join(', '),
                            m.deals.contract_price ? money(m.deals.contract_price) : null,
                            titleize(m.deals.status)].filter(Boolean).join(' · ')}
                        </span>
                      </td>
                      <td>{m.label}</td>
                      <td className="hide-sm sub">{dateOnly(m.due_at)}</td>
                      <td>
                        <span className={`badge ${tone === 'past' ? 'stop' : tone === 'alarm' ? 'stop' : tone === 'warn' ? 'warm' : 'ok'}`}>
                          {countdownLabel(days)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {due.length > 0 && (
        <>
          <Group title="Ready to call" leads={callable} empty="Nothing callable is due." />
          {blocked.length > 0 && (
            <Group
              title="Due, but not callable yet"
              leads={blocked}
              note="These need a skip trace and DNC scrub before the dialer will take them, or they have been marked do-not-call."
            />
          )}
        </>
      )}

      {due.length === 0 && clocks.length === 0 && (
        <div className="card">
          <div className="empty">
            <strong>Nothing scheduled</strong>
            No contract deadlines and no follow-ups due. Set a follow-up on a lead and it
            will appear here when its time comes.
          </div>
        </div>
      )}

      {cold.length > 0 && (
        <Group
          title="Never contacted"
          leads={cold}
          note="Nobody has called these and no follow-up is set. Not urgent — just the pile to work through when the scheduled work is done."
          dateKey="created_at"
        />
      )}
    </>
  );
}

function Group({ title, leads, empty, note, dateKey = 'next_follow_up_at' }) {
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
                  {dateKey === 'created_at'
                    ? `added ${timeAgo(l.created_at)}`
                    : `due ${timeAgo(l.next_follow_up_at)}`}
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
