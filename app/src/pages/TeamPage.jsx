import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { ROLES, ROLE_LABEL, useCan } from '../lib/capabilities.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * Who is on the team and what they can do.
 *
 * Two separate lists on purpose, because they are two separate states and
 * conflating them is how "I invited them and nothing happened" starts:
 *
 *   allowed_signups is the door. An address on it can request a magic link;
 *   an address not on it is refused by a trigger on auth.users before any
 *   account exists.
 *
 *   team_members is the desk. It only appears once that person has actually
 *   signed in for the first time, because the row is created by
 *   handle_new_user() against a real auth account.
 *
 * So inviting someone shows them under "Invited" until they click the link,
 * then they move to the roster as a VA — the least privileged role — and stay
 * there until somebody deliberately promotes them.
 */
export default function TeamPage() {
  const { role: myRole, can } = useCan();
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');

  const manage = can('team.manage');

  const load = useCallback(async () => {
    const [m, a] = await Promise.all([
      supabase.from('team_members').select('*, profiles(id, email, full_name)').order('created_at'),
      supabase.from('allowed_signups').select('*').order('created_at'),
    ]);
    if (m.error) setErr(m.error.message);
    setMembers(m.data ?? []);
    // A silent failure here is fine and expected for non-owners: the allowlist
    // is owner-only, and the section is not rendered for them anyway.
    setInvites(a.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setRole(userId, role) {
    setBusy(userId);
    const { error } = await supabase.from('team_members').update({ role }).eq('user_id', userId);
    if (error) setErr(error.message);
    await load();
    setBusy(null);
  }

  async function invite(e) {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!addr) return;
    setBusy('invite');
    const { error } = await supabase
      .from('allowed_signups')
      .insert({ email: addr, note: note.trim() || null });
    if (error) setErr(error.message);
    else { setEmail(''); setNote(''); }
    await load();
    setBusy(null);
  }

  async function revoke(addr) {
    setBusy(addr);
    const { error } = await supabase.from('allowed_signups').delete().eq('email', addr);
    if (error) setErr(error.message);
    await load();
    setBusy(null);
  }

  if (loading) return <div className="empty">Loading the team…</div>;

  const signedUp = new Set(members.map((m) => m.profiles?.email).filter(Boolean));

  return (
    <>
      <header>
        <h1>Team</h1>
        <span className="count">
          {members.length} {members.length === 1 ? 'person' : 'people'}
          {!manage && ` · you are ${ROLE_LABEL[myRole] ?? myRole}`}
        </span>
      </header>

      {err && <div className="err">{err}</div>}

      {!manage && (
        <div className="notice">
          <strong>You can see who is on the team but not change it.</strong>
          Ask the owner to adjust roles.
        </div>
      )}

      <div className="card">
        <h2>Roster</h2>
        <div className="body">
          <table className="leads">
            <tbody>
              {members.map((m) => {
                const isOwner = m.role === 'owner';
                return (
                  <tr key={m.user_id}>
                    <td>
                      <span className="addr">{m.profiles?.full_name || m.profiles?.email || 'Unknown'}</span>
                      <span className="sub">
                        {[m.profiles?.email, `joined ${timeAgo(m.created_at)}`].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {manage && !isOwner ? (
                        <select
                          value={m.role}
                          disabled={busy === m.user_id}
                          onChange={(e) => setRole(m.user_id, e.target.value)}
                        >
                          {ROLES.filter((r) => r.key !== 'owner').map((r) => (
                            <option key={r.key} value={r.key}>{r.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="badge">{ROLE_LABEL[m.role] ?? m.role}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {manage && members.length > 0 && (
            <p className="sub" style={{ marginTop: 10 }}>
              The owner cannot be changed here — that is the account the team belongs to.
            </p>
          )}
          {members.length === 0 && (
            <div className="empty">
              <strong>Nobody has signed in yet</strong>
              Allow an address below; they appear here as a VA the first time they use their
              magic link.
            </div>
          )}
        </div>
      </div>

      {manage && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Invited</h2>
          <div className="body">
            <p className="cardnote">
              Sign-in is by magic link and only these addresses may request one. Adding an
              address does not create an account — the person appears on the roster as a
              <strong> VA </strong> the first time they sign in, and you promote them from there.
            </p>

            <form onSubmit={invite} className="teamform">
              <label>
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                       placeholder="name@example.com" required />
              </label>
              <label>
                <span>Who is it <em>optional</em></span>
                <input value={note} onChange={(e) => setNote(e.target.value)}
                       placeholder="Al — acquisitions" />
              </label>
              <button className="btn" disabled={busy === 'invite'}>
                {busy === 'invite' ? 'Adding…' : 'Allow this address'}
              </button>
            </form>

            <table className="leads" style={{ marginTop: 12 }}>
              <tbody>
                {invites.map((a) => (
                  <tr key={a.email}>
                    <td>
                      <span className="addr">{a.email}</span>
                      <span className="sub">
                        {[a.note, signedUp.has(a.email) ? 'signed in' : 'not signed in yet']
                          .filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost danger" disabled={busy === a.email}
                              onClick={() => revoke(a.email)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub" style={{ marginTop: 10, maxWidth: '62ch' }}>
              Removing an address stops future sign-ins. It does not end a session already
              open, and it does not delete the person&rsquo;s account — to fully offboard
              somebody, remove the address and delete their user in Supabase Auth.
            </p>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>What each role can do</h2>
        <div className="body">
          <div className="rolegrid">
            {ROLES.map((r) => (
              <div className="rolecard" key={r.key}>
                <strong>{r.label}</strong>
                <p>{r.blurb}</p>
              </div>
            ))}
          </div>
          <p className="sub" style={{ marginTop: 10, maxWidth: '62ch' }}>
            These are enforced by the database, not by the menu. A role without a capability
            is refused by the API even if somebody reaches the endpoint directly.
          </p>
        </div>
      </div>
    </>
  );
}
