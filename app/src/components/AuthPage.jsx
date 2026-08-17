import { useState } from 'react';
import { supabase } from '../supabase.js';

/**
 * Email + password sign-in.
 *
 * No public sign-up link: the handle_new_user trigger puts every new auth user
 * straight onto Tossie's team, so account creation is a deliberate act done
 * from the Supabase dashboard, not something a stranger can do by finding /app.
 */
export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={onSubmit}>
        <h1>{__BIZ__.name}</h1>
        <p className="fine">Operator console</p>

        {err && <div className="err">{err}</div>}

        <label htmlFor="email">Email</label>
        <input
          id="email" type="email" value={email} autoComplete="username" required
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password" type="password" value={password} autoComplete="current-password" required
          onChange={(e) => setPassword(e.target.value)}
        />

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
