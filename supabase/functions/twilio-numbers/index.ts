// supabase/functions/twilio-numbers/index.ts
// ============================================================================
// The bridge between the Twilio account and public.phone_numbers.
// ============================================================================
// Before this existed, a number got into the app by somebody reading it off the
// Twilio console and typing it into a form. Two of the three columns that
// matter are things you cannot type from memory — the number's SID and its
// carrier capabilities — and the one you can type, the E.164, is the join key
// for every inbound webhook. A single transposed digit produces a row that
// looks right, reads back right, and matches nothing Twilio ever posts.
//
// So: ask Twilio. Two actions, deliberately only two.
//
//   sync       READ-ONLY against Twilio. Lists the account's IncomingPhoneNumbers
//              and upserts them into phone_numbers, keyed on e164. Touches
//              nothing in the Twilio account.
//   configure  WRITES to the Twilio account. Points one number's VoiceUrl and
//              SmsUrl at this project's webhooks.
//
// There is no search, no buy, no release and no subaccount provisioning. Tossie
// owns one Twilio account and pays its own bill; numbers are bought by a person
// in the console. reoperative's version of this file is 916 lines because it
// resells telephony to other people's teams. None of that machinery has a job
// here, and every line of it would be a line nobody maintains.
//
// WHY THE TWO ACTIONS ARE SEPARATE, and why 'sync' must never quietly do
// 'configure's work: sync is safe to run at any time, from anywhere, by anyone
// who is curious — it only reads. configure rewrites live routing on the
// customer's own Twilio account, and pointing a number's VoiceUrl at the wrong
// place means the next seller who calls hears nothing. Folding it into sync
// would make the safe button the dangerous one, and the first person to find
// out would be a caller. It stays an explicit, per-number, separately-labelled
// action, and the UI says out loud that it changes settings in Twilio.
//
// SMS IS NEVER ENABLED BY A SYNC. capabilities.sms coming back true means the
// carrier can carry a text on that line. It does not mean Tossie is permitted
// to send one: A2P 10DLC brand and campaign approval is what gates
// application-to-person messaging, and sending from an unregistered number gets
// the traffic filtered and can cost the campaign its registration outright. A
// new row is therefore always sms_enabled=false / a2p_status='not_started',
// and an existing row's sms_enabled and a2p_status are never written at all —
// see the upsert below for why that matters in the other direction too.
//
// Auth: verify_jwt is on, and the JWT is verified again here against the auth
// server rather than trusted from the header. The team comes from the caller's
// profile, never from the request body — there is no team_id to forge. The
// database writes then run on the service role, which bypasses RLS, so every
// query below carries its own .eq('team_id', …).
//
// Request:  { action: 'sync' }
//           { action: 'configure', number_id: '<phone_numbers.id>' }
//
// Refusal reasons, all machine-readable, all paired with a sentence the UI can
// show verbatim:
//   method_not_allowed        not a POST
//   not_configured            the Supabase environment is incomplete
//   bad_request               unparseable body, unknown action, missing number_id
//   not_authenticated         missing or invalid JWT
//   no_team                   signed in but not on a team
//   twilio_not_configured     names the exact missing secret — see below
//   twilio_error              Twilio answered and refused
//   twilio_unreachable        Twilio did not answer
//   twilio_pagination_failed  a page after the first failed, so the list is partial
//   number_not_found          number_id is not a row on this team
//   number_missing_sid        the row has no twilio_sid; run a sync first
//
// Edge secrets (Supabase → Edge Functions → Secrets):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
// Both are named individually in the failure message rather than collapsed into
// "Twilio is not configured". Earlier in this project a generic version of that
// message cost somebody a long hunt through the wrong half of the system: the
// error told them Twilio was broken when in fact one of two secrets was simply
// never pasted in.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders, jsonResponse } from '../_shared/cors.ts';

// Twilio's maximum PageSize on this resource. Asking for the largest allowed
// page is not a micro-optimisation: every extra round trip is another chance
// for the partial-import failure that the pagination loop below exists to
// prevent.
const PAGE_SIZE = 100;

// A hard stop on the pagination loop. A malformed or looping next_page_uri
// would otherwise spin until the function times out, and the operator would
// see a hang with no explanation. 50 pages is 5,000 numbers — orders of
// magnitude past anything Tossie will own, so hitting it means something is
// wrong rather than that the account is large.
const MAX_PAGES = 50;

const TWILIO_ROOT = 'https://api.twilio.com';

/** Same refusal shape as twilio-send-sms, so the UI has one thing to read. */
function refuse(
  cors: Record<string, string>,
  status: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse({ ok: false, reason, message, ...extra }, cors, status);
}

/** Twilio's Basic auth header. The token exists only in this process's env. */
function twilioAuth(accountSid: string, authToken: string): string {
  return 'Basic ' + btoa(`${accountSid}:${authToken}`);
}

interface TwilioNumber {
  sid: string;
  phone_number: string;
  friendly_name: string | null;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean; fax?: boolean };
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return refuse(cors, 405, 'method_not_allowed', 'POST only.');

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return refuse(cors, 500, 'not_configured', 'The Supabase environment is incomplete on this function.');
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return refuse(cors, 400, 'bad_request', 'The request body must be JSON.');
  }
  const action = typeof payload.action === 'string' ? payload.action : '';

  // ── Who is asking ─────────────────────────────────────────────────────────
  // Verified by asking the auth server, not by decoding the token here. There
  // is no internal/service-role caller path in this function on purpose: both
  // actions are things a person decides to do, neither is ever run from cron,
  // and an extra way in is an extra thing to get wrong.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return refuse(cors, 401, 'not_authenticated', 'Sign in first.');

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: authErr } = await caller.auth.getUser();
  if (authErr || !user) {
    return refuse(cors, 401, 'not_authenticated', 'Your session has expired. Sign in again.');
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The team is resolved from the caller's own profile rather than read off the
  // request. Having a profile row with a team_id IS team membership in this
  // schema — there is no separate join table — so this is both the lookup and
  // the membership check.
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('team_id')
    .eq('id', user.id)
    .maybeSingle();
  if (profileErr) {
    console.error('[twilio-numbers] profile read failed:', profileErr.message);
    return refuse(cors, 503, 'no_team', 'Your team could not be read. Try again shortly.');
  }
  const teamId = profile?.team_id ?? null;
  if (!teamId) return refuse(cors, 403, 'no_team', 'Your account is not on a team yet.');

  // ── Twilio credentials ────────────────────────────────────────────────────
  // Named individually. See the header comment: "Twilio is not configured" is
  // the message that sends someone looking in the wrong place.
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
  const missing = [
    !accountSid ? 'TWILIO_ACCOUNT_SID' : null,
    !authToken ? 'TWILIO_AUTH_TOKEN' : null,
  ].filter(Boolean) as string[];
  if (missing.length) {
    return refuse(cors, 500, 'twilio_not_configured',
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set on this function. ` +
      'Set it in Supabase → Edge Functions → Secrets. Nothing else is wrong — no Twilio call was attempted.',
      { missing_secrets: missing });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // sync — read Twilio, write the database. Twilio is not modified.
  // ══════════════════════════════════════════════════════════════════════════
  if (action === 'sync') {
    // ── Fetch every page ────────────────────────────────────────────────────
    // Pagination is followed rather than assumed away. Twilio's default page is
    // 50; an account with 51 numbers would otherwise import 50 of them and
    // report complete success, and the number that silently did not arrive is
    // the one whose inbound calls quietly go unmatched. A partial import that
    // claims to be whole is worse than a failure, so a page that fails aborts
    // the whole sync rather than committing what it already has.
    const twilioNumbers: TwilioNumber[] = [];
    let nextPath: string | null =
      `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=${PAGE_SIZE}`;
    let pages = 0;

    while (nextPath) {
      if (++pages > MAX_PAGES) {
        return refuse(cors, 502, 'twilio_pagination_failed',
          `Twilio kept handing back more pages past ${MAX_PAGES}. Nothing was imported, because a partial import that reports success is worse than this error.`);
      }

      let page: Record<string, unknown>;
      let pageOk: boolean;
      try {
        const resp = await fetch(`${TWILIO_ROOT}${nextPath}`, {
          headers: { Authorization: twilioAuth(accountSid, authToken) },
        });
        page = await resp.json();
        pageOk = resp.ok;
      } catch (err) {
        console.error('[twilio-numbers] Twilio request failed:', (err as Error)?.message);
        return refuse(cors, 502, 'twilio_unreachable',
          'Twilio did not answer, so nothing was imported. Try again shortly.');
      }
      if (!pageOk) {
        const detail = typeof page.message === 'string' ? page.message : 'Twilio rejected the request.';
        return refuse(cors, 502, 'twilio_error', detail, {
          twilio_code: page.code ?? null,
          // A 401 here is almost always a stale auth token rather than a bug,
          // and saying so beats making somebody read Twilio's error catalogue.
          hint: page.code === 20003
            ? 'That usually means TWILIO_AUTH_TOKEN does not match TWILIO_ACCOUNT_SID.'
            : undefined,
        });
      }

      for (const n of (page.incoming_phone_numbers as TwilioNumber[] | undefined) ?? []) {
        if (n?.phone_number && n?.sid) twilioNumbers.push(n);
      }

      // next_page_uri is a path on api.twilio.com, and it is only followed as
      // one. Concatenating whatever Twilio returns onto a base URL would follow
      // an absolute URL to another host if the field ever contained one; a
      // leading-slash check keeps the credential-bearing request pinned to the
      // host we chose. `//host` is excluded because it is protocol-relative.
      const next = page.next_page_uri;
      nextPath = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
        ? next
        : null;
    }

    // ── What we already have ────────────────────────────────────────────────
    const { data: existingRows, error: existingErr } = await admin
      .from('phone_numbers')
      .select('id, e164, friendly_name, twilio_sid, voice_enabled, sms_enabled, a2p_status, is_primary')
      .eq('team_id', teamId);
    if (existingErr) {
      console.error('[twilio-numbers] existing numbers read failed:', existingErr.message);
      return refuse(cors, 503, 'not_configured',
        'The numbers already on file could not be read, so nothing was imported. Try again shortly.');
    }

    const byE164 = new Map((existingRows ?? []).map((r) => [r.e164, r]));
    // Tracked as a local flag rather than re-queried per number: the first
    // synced number claims primary only if the team has none, and once it does,
    // the second number in the same loop must not try to claim it as well.
    let hasPrimary = (existingRows ?? []).some((r) => r.is_primary);

    const results: Record<string, unknown>[] = [];

    for (const n of twilioNumbers) {
      // Twilio reports E.164 and phone_numbers.e164 stores E.164, so there is
      // nothing to normalise here — normalising would only be a chance to
      // change the value that every inbound webhook joins on.
      const e164 = n.phone_number;
      const caps = {
        voice: n.capabilities?.voice === true,
        sms: n.capabilities?.sms === true,
        mms: n.capabilities?.mms === true,
      };
      const friendlyName = n.friendly_name || null;
      const existing = byE164.get(e164);

      if (!existing) {
        // A number the team has never had on file. sms_enabled and a2p_status
        // are pinned to their safe values here rather than left to the column
        // defaults, so that the intent survives a future default change: a
        // number arrives voice-only regardless of what the carrier says it can
        // carry, and someone turns texting on deliberately once A2P clears.
        const wantPrimary = !hasPrimary;
        const insertRow = {
          team_id: teamId,
          e164,
          friendly_name: friendlyName,
          twilio_sid: n.sid,
          voice_enabled: caps.voice,
          sms_enabled: false,
          a2p_status: 'not_started',
          is_primary: wantPrimary,
        };

        let { data: inserted, error: insertErr } = await admin
          .from('phone_numbers').insert(insertRow).select('id').maybeSingle();

        // phone_numbers_one_primary_idx is a UNIQUE partial index on (team_id)
        // WHERE is_primary. Another tab syncing at the same moment can claim
        // primary between the read above and this insert, and the number itself
        // is still worth importing — so the claim is dropped and the import
        // retried rather than failing the whole sync over which row wears a
        // badge. 23505 is also what a duplicate e164 raises, hence reading the
        // constraint name rather than the code alone.
        let primaryLost = false;
        if (insertErr?.code === '23505' && /one_primary/.test(insertErr.message) && wantPrimary) {
          primaryLost = true;
          ({ data: inserted, error: insertErr } = await admin
            .from('phone_numbers').insert({ ...insertRow, is_primary: false })
            .select('id').maybeSingle());
        }

        if (insertErr) {
          // e164 is UNIQUE globally, not per team — a Twilio number belongs to
          // one account at a time, so a collision here means the row is on some
          // other team and this sync must not silently take it over.
          results.push({
            e164,
            friendly_name: friendlyName,
            twilio_sid: n.sid,
            capabilities: caps,
            result: 'failed',
            message: insertErr.code === '23505'
              ? 'This number is already recorded against a different team, so it was left alone.'
              : insertErr.message,
          });
          continue;
        }

        if (wantPrimary && !primaryLost) hasPrimary = true;
        results.push({
          id: (inserted as { id: string } | null)?.id ?? null,
          e164,
          friendly_name: friendlyName,
          twilio_sid: n.sid,
          capabilities: caps,
          result: 'added',
          is_primary: wantPrimary && !primaryLost,
          sms_enabled: false,
          a2p_status: 'not_started',
          // Said on every added row, because the one question this whole
          // feature invites is "Twilio says it does SMS, why is texting off".
          message: caps.sms
            ? 'Added. Texting stays off until A2P 10DLC is approved and someone turns it on — carrier capability is not permission.'
            : 'Added as a voice line. Twilio reports no SMS capability on this number.',
        });
        continue;
      }

      // ── An existing row ───────────────────────────────────────────────────
      // Only the three facts Twilio is authoritative about are written:
      // friendly_name, twilio_sid, voice_enabled.
      //
      // sms_enabled and a2p_status are DELIBERATELY NOT WRITTEN. Twilio's
      // IncomingPhoneNumbers resource knows nothing about A2P campaign state,
      // so there is no truth here to copy — and both directions of guessing are
      // damaging. Writing false would turn texting off under an operator who
      // enabled it after approval, silently, during a routine re-sync; writing
      // capabilities.sms would turn texting ON for a number the carriers never
      // cleared, which is the exact failure this table was built to prevent.
      // A re-sync must be a boring, repeatable, side-effect-free operation.
      const changes: Record<string, unknown> = {};
      if ((existing.friendly_name || null) !== friendlyName) changes.friendly_name = friendlyName;
      if (existing.twilio_sid !== n.sid) changes.twilio_sid = n.sid;
      if (existing.voice_enabled !== caps.voice) changes.voice_enabled = caps.voice;

      if (Object.keys(changes).length === 0) {
        // No write at all when nothing changed. phone_numbers has a BEFORE
        // UPDATE touch trigger, so a no-op update would still move updated_at
        // and make an idle re-sync look like somebody changed something.
        results.push({
          id: existing.id,
          e164,
          friendly_name: friendlyName,
          twilio_sid: n.sid,
          capabilities: caps,
          result: 'unchanged',
          is_primary: existing.is_primary,
          sms_enabled: existing.sms_enabled,
          a2p_status: existing.a2p_status,
        });
        continue;
      }

      const { data: updated, error: updateErr } = await admin
        .from('phone_numbers').update(changes).eq('id', existing.id).eq('team_id', teamId).select('id');

      results.push({
        id: existing.id,
        e164,
        friendly_name: friendlyName,
        twilio_sid: n.sid,
        capabilities: caps,
        is_primary: existing.is_primary,
        sms_enabled: existing.sms_enabled,
        a2p_status: existing.a2p_status,
        ...(updateErr
          ? { result: 'failed', message: updateErr.message }
          // PostgREST answers an UPDATE that matched no row with success and no
          // error. Reporting that as 'updated' would tell the operator a number
          // was corrected when it was not.
          : !updated?.length
          ? { result: 'failed', message: 'The row was not found, so nothing was changed.' }
          : { result: 'updated', changed: Object.keys(changes) }),
      });
    }

    // Rows on file that Twilio did not return. Not touched — deleting a number
    // out from under the sms_messages and call_log rows that reference it would
    // destroy the record of what was said to a homeowner — but named, because
    // the usual cause is a number that was released in the console, and until
    // somebody knows that, it just looks like a line that stopped working.
    const seen = new Set(twilioNumbers.map((n) => n.phone_number));
    const orphans = (existingRows ?? []).filter((r) => !seen.has(r.e164)).map((r) => r.e164);

    const counts = {
      added: results.filter((r) => r.result === 'added').length,
      updated: results.filter((r) => r.result === 'updated').length,
      unchanged: results.filter((r) => r.result === 'unchanged').length,
      failed: results.filter((r) => r.result === 'failed').length,
    };

    return jsonResponse({
      ok: true,
      action: 'sync',
      pages_fetched: pages,
      twilio_count: twilioNumbers.length,
      counts,
      numbers: results,
      not_in_twilio: orphans,
    }, cors, 200);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // configure — WRITES to the customer's Twilio account.
  // ══════════════════════════════════════════════════════════════════════════
  // One number, named explicitly, one action per click. This is never called as
  // part of a sync: see the header comment.
  if (action === 'configure') {
    const numberId = typeof payload.number_id === 'string' && payload.number_id
      ? payload.number_id
      : '';
    if (!numberId) {
      return refuse(cors, 400, 'bad_request', 'number_id is required — configure acts on one number at a time.');
    }

    const { data: row, error: rowErr } = await admin
      .from('phone_numbers')
      .select('id, e164, twilio_sid')
      .eq('id', numberId)
      .eq('team_id', teamId)
      .maybeSingle();
    if (rowErr) {
      console.error('[twilio-numbers] number read failed:', rowErr.message);
      return refuse(cors, 503, 'number_not_found',
        'That number could not be read, so nothing in Twilio was changed. Try again shortly.');
    }
    if (!row) return refuse(cors, 404, 'number_not_found', 'That number is not on this team.');
    if (!row.twilio_sid) {
      // The SID is the only handle Twilio's API takes for this resource, and it
      // is exactly the field a hand-typed row is missing. Sync fills it in.
      return refuse(cors, 400, 'number_missing_sid',
        `${row.e164} has no Twilio SID on file, so there is nothing to point at. Run "Sync from Twilio" first — that is where the SID comes from.`);
    }

    // The webhook URLs are built from this function's own SUPABASE_URL, not
    // from anything the caller sent. A configure that accepted a URL would be a
    // way to redirect a homeowner's call to somebody else's server.
    //
    // SmsUrl points at twilio-webhook, which handles INBOUND texts — receiving
    // is not application-to-person messaging, so it needs no A2P approval and
    // is safe to wire up while registration is still pending. It is also what
    // makes STOP work, which is the one message that must never be missed.
    const voiceUrl = `${supabaseUrl}/functions/v1/twilio-voice`;
    const smsUrl = `${supabaseUrl}/functions/v1/twilio-webhook`;

    const form = new URLSearchParams({
      VoiceUrl: voiceUrl,
      VoiceMethod: 'POST',
      SmsUrl: smsUrl,
      SmsMethod: 'POST',
    });

    let twilio: Record<string, unknown>;
    let twilioOk: boolean;
    try {
      const resp = await fetch(
        `${TWILIO_ROOT}/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${row.twilio_sid}.json`,
        {
          method: 'POST',
          headers: {
            Authorization: twilioAuth(accountSid, authToken),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );
      twilio = await resp.json();
      twilioOk = resp.ok;
    } catch (err) {
      console.error('[twilio-numbers] Twilio configure failed:', (err as Error)?.message);
      return refuse(cors, 502, 'twilio_unreachable',
        'Twilio did not answer. The change may or may not have applied — check the number in the Twilio console before trying again.');
    }

    if (!twilioOk) {
      const detail = typeof twilio.message === 'string' ? twilio.message : 'Twilio rejected the change.';
      return refuse(cors, 502, 'twilio_error', detail, { twilio_code: twilio.code ?? null });
    }

    // Read back from Twilio's response rather than echoing what we sent. The
    // whole point of this action is to be able to say what Twilio actually has;
    // echoing the request would report success for a value Twilio silently
    // normalised, truncated or ignored, which is indistinguishable from it
    // having worked until a call comes in.
    return jsonResponse({
      ok: true,
      action: 'configure',
      number_id: row.id,
      e164: typeof twilio.phone_number === 'string' ? twilio.phone_number : row.e164,
      twilio_sid: row.twilio_sid,
      voice_url: twilio.voice_url ?? null,
      voice_method: twilio.voice_method ?? null,
      sms_url: twilio.sms_url ?? null,
      sms_method: twilio.sms_method ?? null,
      // Stated rather than assumed by the caller: if Twilio came back with
      // something other than what was asked for, the UI should show the values
      // above, not a green tick.
      matches_requested: twilio.voice_url === voiceUrl && twilio.sms_url === smsUrl,
    }, cors, 200);
  }

  return refuse(cors, 400, 'bad_request',
    `Unknown action "${action}". This function does two things: "sync" (read Twilio, update the app) and "configure" (point one number's webhooks at this app).`);
});
