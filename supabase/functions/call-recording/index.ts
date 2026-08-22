// supabase/functions/call-recording/index.ts
// ============================================================================
// Play back a call recording.
// ============================================================================
// Recordings live at api.twilio.com and are protected by HTTP Basic auth on the
// account credentials. That is the right default -- these are recordings of
// conversations with homeowners, and a publicly fetchable URL to one is a
// recording of somebody's kitchen-table conversation on the open internet.
//
// It also means the obvious thing does not work. call_log.recording_url is a
// Twilio API URL, and <audio src={recording_url}> gets a 401 -- verified, not
// assumed. There is no header a media element can be told to send, so the app
// cannot fetch it directly no matter how it is authenticated to Supabase.
//
// So this function stands in the middle: it authenticates the *operator*
// against their own Supabase session, checks the recording belongs to a call on
// their team, then fetches from Twilio with the account credentials and streams
// the audio back. The Twilio credentials never leave the server, and the
// browser never sees a URL that would work without a session.
//
// Deliberately a separate function rather than another branch in twilio-voice.
// That file is the Twilio webhook surface -- it validates X-Twilio-Signature on
// almost every path -- and this is the opposite: a browser endpoint that
// validates a user JWT and must never accept an unsigned webhook. Keeping the
// two apart means neither one's auth check can be reached by the other's
// callers.
//
// ENV
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';

/**
 * Only recordings on our own account, and only the recordings path.
 *
 * call_log.recording_url is written from a Twilio webhook, so it is not user
 * input in the ordinary sense -- but it is a URL this function is about to
 * fetch with the account credentials attached, which makes it exactly the kind
 * of value worth checking rather than trusting. A row edited to point at
 * somebody else's endpoint would otherwise have our Basic auth header posted
 * to it.
 */
function isOurRecording(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.hostname !== 'api.twilio.com') return false;
  return u.pathname.startsWith(`/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/`);
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, cors, 405);

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return jsonResponse({ error: 'twilio is not configured' }, cors, 503);
  }

  // ── who is asking ────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return jsonResponse({ error: 'not signed in' }, cors, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return jsonResponse({ error: 'not signed in' }, cors, 401);

  let body: { call_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'expected JSON' }, cors, 400);
  }
  const callId = String(body.call_id || '').trim();
  if (!callId) return jsonResponse({ error: 'call_id is required' }, cors, 400);

  // ── is it theirs ─────────────────────────────────────────────────────────
  // Read through the USER's client, not the service role: call_log's own RLS
  // policy is then what decides whether this person may hear this call, rather
  // than a team check written a second time here and able to drift from it.
  const { data: row, error: rowErr } = await userClient
    .from('call_log')
    .select('id, recording_url')
    .eq('id', callId)
    .maybeSingle();

  if (rowErr) return jsonResponse({ error: rowErr.message }, cors, 500);
  // Not found and not permitted are the same answer on purpose: telling a
  // caller that a call id exists but belongs to another team is itself a leak.
  if (!row) return jsonResponse({ error: 'no such recording' }, cors, 404);
  if (!row.recording_url) return jsonResponse({ error: 'that call was not recorded' }, cors, 404);

  if (!isOurRecording(row.recording_url)) {
    console.error('[call-recording] refused a non-Twilio recording_url on call', callId);
    return jsonResponse({ error: 'that recording is not on this account' }, cors, 400);
  }

  // ── fetch it with the account credentials and hand back the audio ────────
  // .mp3 rather than the bare resource URL: the bare one returns the recording
  // metadata as JSON, which an <audio> element cannot play.
  const mediaUrl = row.recording_url.endsWith('.mp3')
    ? row.recording_url
    : `${row.recording_url}.mp3`;

  const upstream = await fetch(mediaUrl, {
    headers: { Authorization: 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`) },
  });

  if (!upstream.ok) {
    console.error('[call-recording] twilio returned', upstream.status, 'for call', callId);
    // 404 from Twilio is the ordinary case once a recording has aged out of
    // retention, and it deserves a sentence rather than a status code.
    return jsonResponse({
      error: upstream.status === 404
        ? 'Twilio no longer has this recording.'
        : `Twilio returned ${upstream.status}`,
    }, cors, 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
      // Never cached by a shared cache. The response is audio of a private
      // conversation and its URL carries no credential of its own.
      'Cache-Control': 'private, no-store',
    },
  });
});
