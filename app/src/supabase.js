import { createClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client. Anon key only — every read and write goes through
 * RLS, which scopes it to the caller's team. The service_role key never
 * appears in this bundle; it lives in api/lead.js on the server side.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;
