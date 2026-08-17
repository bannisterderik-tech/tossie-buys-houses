import { createClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client.
 *
 * The URL and anon key below are checked into a public repo on purpose. The
 * anon key is not a secret — it is designed to be published, it is already
 * readable in the JS bundle any visitor can download, and it grants nothing on
 * its own. What protects the data is row-level security plus the revoked table
 * grants in 20260817120300_revoke_anon.sql, which together mean this key cannot
 * read a single lead. `scripts/probe-live.sh` proves that against the live API
 * on every run: twelve requests, all denied.
 *
 * Hard-coding them means a deploy works without anyone having to set an
 * environment variable first. Environment variables still win when present, so
 * pointing a build at a staging project stays a one-line change.
 *
 * The service_role key is the actual secret. It is never in this file, never
 * prefixed VITE_, and never reaches the browser — it lives only in api/lead.js
 * on the server.
 */
const FALLBACK_URL = 'https://fvkxdhuwfjnsvkjjordm.supabase.co';
const FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2a3hkaHV3Zmpuc3ZrampvcmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5OTM4MTUsImV4cCI6MjEwMjU2OTgxNX0.LZwclvx-8_59FoslU8P73az40XT_Lb1nsRkwMwS6ius';

const url = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The magic link comes back as #access_token=... in the URL fragment.
        detectSessionInUrl: true,
      },
    })
  : null;
