import { useState } from 'react';
import { supabase } from '../supabase.js';

/**
 * Magic-link sign-in.
 *
 * No passwords anywhere: not in the database, not in a password manager, not in
 * a screenshot of a setup doc. The credential is a single-use link sent to an
 * address that is already on the allow-list.
 *
 * `shouldCreateUser` is left at its default (true) on purpose, so a new
 * operator signs themselves in the first time instead of waiting for someone to
 * hand-create them. What makes that safe is the allowed_signups trigger on
 * auth.users — see 20260817140000_magic_link_allowlist.sql. An address that is
 * not on the list never gets a row.
 */
export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/app` },
    });
    setBusy(false);

    // Deliberately vague on the success path. Saying "that address is not
    // authorized" would turn this form into a way to discover who works here,
    // and the allow-list is a list of people worth phishing. A rejected address
    // gets the same screen and no email.
    if (error && !/not authorized|Database error/i.test(error.message)) {
      setErr(error.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="authwrap">
        <div className="authcard">
          <h1>Check your email</h1>
          <p className="fine">
            If <strong>{email.trim()}</strong> has access, a sign-in link is on its way.
            It works once and expires in an hour.
          </p>
          <button className="btn ghost" onClick={() => { setSent(false); setEmail(''); }}>
            Use a different address
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={onSubmit}>
        <h1>{__BIZ__.name}</h1>
        <p className="fine">Operator console</p>

        {err && <div className="err">{err}</div>}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          autoComplete="email"
          autoFocus
          required
          placeholder="you@tossiebuyshouses.com"
          onChange={(e) => setEmail(e.target.value)}
        />

        <button className="btn" type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Email me a sign-in link'}
        </button>

        <p className="fine" style={{ marginTop: 16, marginBottom: 0 }}>
          No password to remember or lose. Access is limited to addresses the
          owner has added.
        </p>
      </form>
    </div>
  );
}
