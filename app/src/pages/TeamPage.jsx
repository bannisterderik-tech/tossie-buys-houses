import { Fragment, useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { ROLES, ROLE_LABEL, useCan } from '../lib/capabilities.jsx';
import { timeAgo, titleize } from '../lib/format.js';

/**
 * Capabilities, grouped the way somebody thinks about them rather than the way
 * they sort alphabetically. The list itself comes from the database — this only
 * decides the order and the heading a capability appears under, so a capability
 * added later still shows up, just at the bottom under its own prefix.
 */
const CAP_GROUPS = [
  { key: 'leads', label: 'Leads' },
  { key: 'prospects', label: 'Prospects' },
  { key: 'buyers', label: 'Buyers' },
  { key: 'deals', label: 'Deals' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'messages', label: 'Messages' },
  { key: 'dialer', label: 'Dialer' },
  { key: 'sdr', label: 'AI SDR' },
  { key: 'import', label: 'Import' },
  { key: 'settings', label: 'Settings' },
];

/** 'leads.delete' -> 'Delete'. The group heading already says which noun. */
const capVerb = (cap) => titleize(cap.split('.')[1] ?? cap);

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
  const [roleCaps, setRoleCaps] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [openMember, setOpenMember] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');

  const manage = can('team.manage');

  const load = useCallback(async () => {
    const [m, a, rc, uc] = await Promise.all([
      supabase.from('team_members').select('*, profiles(id, email, full_name)').order('created_at'),
      supabase.from('allowed_signups').select('*').order('created_at'),
      // The same two tables has_capability() consults, so what this screen
      // shows and what the database enforces cannot disagree.
      supabase.from('role_capabilities').select('role, capability'),
      supabase.from('user_capabilities').select('*'),
    ]);
    if (m.error) setErr(m.error.message);
    setMembers(m.data ?? []);
    // A silent failure here is fine and expected for non-owners: the allowlist
    // is owner-only, and the section is not rendered for them anyway.
    setInvites(a.data ?? []);
    setRoleCaps(rc.data ?? []);
    setOverrides(uc.data ?? []);
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

  /**
   * Hand the account over.
   *
   * Confirmed in the browser as well as guarded in the database, because this
   * is the one action on the page that takes something away from the person
   * doing it — and the RPC cannot ask "are you sure", it can only refuse or
   * comply. Ownership moves in two places (team_members.role and
   * teams.created_by) and the outgoing owner lands on admin, so the wording
   * says exactly that rather than "you will lose access", which is not true.
   */
  async function makeOwner(m) {
    const who = m.profiles?.email || 'this person';
    if (!window.confirm(
      `Make ${who} the owner of this team?\n\n`
      + `They get everything, including who is on the team and what each person may do.\n`
      + `You become an Admin — you keep every day-to-day permission, but you will not be `
      + `able to change roles, invite people, or take ownership back yourself. `
      + `Only ${who} can hand it back.`
    )) return;

    setBusy(m.user_id);
    const { error } = await supabase.rpc('transfer_team_ownership', { p_new_owner_id: m.user_id });
    if (error) setErr(error.message);
    await load();
    setBusy(null);
  }

  /** null clears the override and hands the decision back to the role. */
  async function setCap(userId, capability, granted) {
    setBusy(`${userId}:${capability}`);
    const { error } = await supabase.rpc('set_user_capability', {
      p_user_id: userId, p_capability: capability, p_granted: granted, p_note: null,
    });
    if (error) setErr(error.message);
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
                const mine = overrides.filter((o) => o.user_id === m.user_id);
                const open = openMember === m.user_id;
                return (
                  <Fragment key={m.user_id}>
                    <tr>
                      <td>
                        <span className="addr">{m.profiles?.full_name || m.profiles?.email || 'Unknown'}</span>
                        <span className="sub">
                          {[m.profiles?.email, `joined ${timeAgo(m.created_at)}`].filter(Boolean).join(' · ')}
                        </span>
                        {mine.length > 0 && (
                          <span className="sub">
                            <span className="badge warm">
                              {mine.filter((o) => o.granted).length} added
                              {' · '}
                              {mine.filter((o) => !o.granted).length} blocked
                            </span>
                            {' '}beyond the role
                          </span>
                        )}
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
                        {manage && !isOwner && (
                          <>
                            {' '}
                            <button
                              className="linkbtn"
                              onClick={() => setOpenMember(open ? null : m.user_id)}
                            >
                              {open ? 'done' : 'permissions'}
                            </button>
                            {' '}
                            <button
                              className="linkbtn"
                              disabled={busy === m.user_id}
                              onClick={() => makeOwner(m)}
                            >
                              make owner
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={2}>
                          <MemberPermissions
                            member={m}
                            roleCaps={roleCaps}
                            overrides={mine}
                            busy={busy}
                            onSet={setCap}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

/**
 * One person's exceptions, capability by capability.
 *
 * Three states per row and not a checkbox, because "the role decides" is a
 * genuinely different answer from "no" and collapsing them loses the thing
 * that makes this safe to use. A checkbox left unticked would silently pin a
 * permission to off — so promoting that person to Admin later would not give
 * them the Admin permissions, and nothing on screen would say why.
 *
 *   Role default  no row. Change the role and this follows.
 *   Allowed       granted, whatever the role says.
 *   Blocked       refused, whatever the role says.
 *
 * The role's own answer is printed next to each control so an override is a
 * visible departure from something rather than a setting in a vacuum.
 */
function MemberPermissions({ member, roleCaps, overrides, busy, onSet }) {
  const all = [...new Set(roleCaps.map((r) => r.capability))];
  const roleHas = new Set(
    roleCaps.filter((r) => r.role === member.role).map((r) => r.capability),
  );
  const byCap = new Map(overrides.map((o) => [o.capability, o.granted]));

  // Grouped by the prefix, in CAP_GROUPS order, with anything unrecognised
  // falling in at the end under its own name rather than vanishing.
  const groups = [];
  const seen = new Set();
  for (const g of CAP_GROUPS) {
    const caps = all.filter((c) => c.split('.')[0] === g.key).sort();
    caps.forEach((c) => seen.add(c));
    if (caps.length) groups.push({ label: g.label, caps });
  }
  const rest = all.filter((c) => !seen.has(c)).sort();
  if (rest.length) groups.push({ label: 'Other', caps: rest });

  return (
    <div className="permpanel">
      <p className="fine">
        Exceptions for <strong>{member.profiles?.email || 'this person'}</strong>, on top of
        what <strong>{ROLE_LABEL[member.role] ?? member.role}</strong> already allows. These are
        enforced by the database — has_capability() reads this table before it reads the role,
        so a block here holds even against a request that never touches this screen.
      </p>

      {groups.map((g) => (
        <div key={g.label} className="permgroup">
          <h3>{g.label}</h3>
          {g.caps.map((cap) => {
            const fromRole = roleHas.has(cap);
            const override = byCap.has(cap) ? byCap.get(cap) : null;
            const effective = override === null ? fromRole : override;
            const key = `${member.user_id}:${cap}`;
            return (
              <div className="permrow" key={cap}>
                <span className="permname">
                  {capVerb(cap)}
                  <span className="fine">
                    {fromRole ? 'the role allows this' : 'the role does not allow this'}
                  </span>
                </span>
                <span className={`badge ${effective ? 'ok' : 'stop'}`}>
                  {effective ? 'Can' : 'Cannot'}
                </span>
                <select
                  value={override === null ? '' : override ? 'yes' : 'no'}
                  disabled={busy === key}
                  onChange={(e) => onSet(
                    member.user_id,
                    cap,
                    e.target.value === '' ? null : e.target.value === 'yes',
                  )}
                >
                  <option value="">Role default</option>
                  <option value="yes">Allowed</option>
                  <option value="no">Blocked</option>
                </select>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
