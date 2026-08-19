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
// So: ask Twilio. Three actions, deliberately only three.
//
//   sync       READ-ONLY against Twilio. Lists the account's IncomingPhoneNumbers
//              and upserts them into phone_numbers, keyed on e164. Touches
//              nothing in the Twilio account.
//   configure  WRITES to the Twilio account. Points one number's VoiceUrl and
//              SmsUrl at this project's webhooks.
//   release    DESTROYS a number on the Twilio account. Irreversible. Read the
//              block above the handler before touching it.
//
// There is no search, no buy and no subaccount provisioning. Tossie owns one
// Twilio account and pays its own bill; numbers are bought by a person in the
// console. reoperative's version of this file is 916 lines because it resells
// telephony to other people's teams — its release path decrements a Stripe
// subscription item and juggles bundle allowances, none of which has a job
// here. What was worth porting is one HTTP call and the 404 handling.
//
// WHY THE ACTIONS ARE SEPARATE, and why 'sync' must never quietly do
// 'configure's work: sync is safe to run at any time, from anywhere, by anyone
// who is curious — it only reads. configure rewrites live routing on the
// customer's own Twilio account, and pointing a number's VoiceUrl at the wrong
// place means the next seller who calls hears nothing. Folding it into sync
// would make the safe button the dangerous one, and the first person to find
// out would be a caller. It stays an explicit, per-number, separately-labelled
// action, and the UI says out loud that it changes settings in Twilio.
//
// The three actions sit on a ladder of consequence — sync reads, configure
// changes something recoverable, release cannot be undone at all — and each one
// asks for more before it acts. release is the only one that demands the
// operator type the number out.
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
//           { action: 'release',   number_id: '<phone_numbers.id>',
//                                  confirm_e164: '+1912…', reason?: 'why' }
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
//   confirmation_mismatch     release: confirm_e164 is not this number
//   number_is_primary         release: designate a new primary first
//   last_live_number          release: this is the only line left
//   release_not_recorded      release: Twilio released it, the database did not
//                             record it — the one state that needs a human
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
      .select('id, e164, friendly_name, twilio_sid, voice_enabled, sms_enabled, a2p_status, is_primary, released_at')
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

      // ── A row this team released ──────────────────────────────────────────
      // Twilio returned a number we have on file as released. That is not
      // supposed to be possible — a released number left the account — so the
      // only honest reading is that somebody bought it back, which does happen
      // because a released number goes into a pool anyone can buy from.
      //
      // Not revived automatically. e164 is UNIQUE globally, so this row is also
      // the reason a re-bought number cannot simply be re-added, and quietly
      // clearing released_at would turn a number the app has told everyone is
      // gone back into a live sending line with nobody having decided that.
      // Named loudly instead, which is what the operator needs to act on.
      if (existing.released_at) {
        results.push({
          id: existing.id,
          e164,
          friendly_name: friendlyName,
          twilio_sid: n.sid,
          capabilities: caps,
          result: 'released',
          message:
            'This number is recorded as released, but the Twilio account returned it — so the account owns it again. Nothing was changed here. Someone has to decide whether it goes back into service.',
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
    //
    // Numbers released THROUGH this app are excluded: they are absent from
    // Twilio by design and already say so on their own row. Listing them here
    // would put a permanent unexplained warning on every future sync, and a
    // warning that is always on is a warning nobody reads when it means
    // something.
    const seen = new Set(twilioNumbers.map((n) => n.phone_number));
    const orphans = (existingRows ?? [])
      .filter((r) => !seen.has(r.e164) && !r.released_at)
      .map((r) => r.e164);

    const counts = {
      added: results.filter((r) => r.result === 'added').length,
      updated: results.filter((r) => r.result === 'updated').length,
      unchanged: results.filter((r) => r.result === 'unchanged').length,
      released: results.filter((r) => r.result === 'released').length,
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

  // ══════════════════════════════════════════════════════════════════════════
  // release — DESTROYS the number on the Twilio account. Cannot be undone.
  // ══════════════════════════════════════════════════════════════════════════
  // Twilio's DELETE on IncomingPhoneNumbers hands the number back to the pool
  // it was bought from. Billing stops, which is the point, and everything else
  // about it is loss: the number can be bought by anybody the same afternoon,
  // and from then on every call and text a seller sends to it reaches a
  // stranger who has no idea who Tossie is. There is no repurchase button and
  // no guarantee the number is still there an hour later. Nothing else in this
  // build is irreversible in that way.
  //
  // So the guardrails are sized to that rather than to the effort of the click:
  //
  //   confirm_e164 must match exactly. Typing the number IS the confirmation.
  //     A yes/no dialog measures nothing except whether a button was pressed,
  //     and the failure mode here is someone aiming for the row above.
  //   not the primary. The primary is the number the business presents; silently
  //     moving that badge would change which number sellers see replies from,
  //     mid-conversation, with nobody having chosen the new one. Designating a
  //     new primary first is a decision, and it is the operator's to make.
  //   not the last live number. A team with zero live numbers cannot call or
  //     text at all — every send path refuses — and an operator who meant to do
  //     that is rare enough that asking is cheaper than the outage.
  //   already released is a no-op, not an error. Two clicks, a double-submit or
  //     a retried request should converge on released rather than produce a
  //     scary failure for a state that is exactly what was wanted.
  if (action === 'release') {
    const numberId = typeof payload.number_id === 'string' ? payload.number_id : '';
    const confirmE164 = typeof payload.confirm_e164 === 'string' ? payload.confirm_e164.trim() : '';
    // Capped rather than validated. The column is unbounded text, and the point
    // of the field is a sentence somebody reads back in six months — 500
    // characters is far past that and short of anything a paste accident would
    // put in a table nobody ever cleans up.
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim().slice(0, 500)
      : null;

    if (!numberId) {
      return refuse(cors, 400, 'bad_request', 'number_id is required — release acts on one number at a time.');
    }
    if (!confirmE164) {
      return refuse(cors, 400, 'bad_request',
        'confirm_e164 is required. Releasing a number is permanent, so the number has to be typed out rather than agreed to.');
    }

    const { data: row, error: rowErr } = await admin
      .from('phone_numbers')
      .select('id, e164, twilio_sid, is_primary, released_at')
      .eq('id', numberId)
      .eq('team_id', teamId)
      .maybeSingle();
    if (rowErr) {
      console.error('[twilio-numbers] number read failed:', rowErr.message);
      return refuse(cors, 503, 'number_not_found',
        'That number could not be read, so nothing was released. Try again shortly.');
    }
    if (!row) return refuse(cors, 404, 'number_not_found', 'That number is not on this team.');

    // ── Already released ──────────────────────────────────────────────────
    // Answered before the confirmation check on purpose. The number is gone;
    // making the operator type it correctly to be told nothing needs doing is
    // ceremony with nothing behind it.
    if (row.released_at) {
      return jsonResponse({
        ok: true,
        action: 'release',
        number_id: row.id,
        e164: row.e164,
        already_released: true,
        released_at: row.released_at,
        twilio_status: null,
        message: `${row.e164} was already released on ${row.released_at}. Nothing was sent to Twilio.`,
      }, cors, 200);
    }

    // ── The confirmation ──────────────────────────────────────────────────
    // Byte-exact against the stored E.164 rather than compared through
    // phone_key(). Loosening it to "same last ten digits" would accept a
    // different spelling of the number, and the whole job of this field is to
    // prove the operator is looking at the number they think they are.
    if (confirmE164 !== row.e164) {
      return refuse(cors, 400, 'confirmation_mismatch',
        `That does not match. To release this number, type it exactly as it is stored: ${row.e164}`,
        { expected_e164: row.e164 });
    }

    if (row.is_primary) {
      return refuse(cors, 409, 'number_is_primary',
        `${row.e164} is this team's primary number. Make another number primary first — reassigning it automatically would change which number sellers see replies from, and that is not a side effect a release should have.`);
    }

    // Counted rather than inferred from what the page happened to be showing.
    // The browser's list can be minutes stale, and the question being asked is
    // "will this leave the business unable to contact anyone", which only the
    // database can answer.
    const { count: liveCount, error: countErr } = await admin
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .is('released_at', null);
    if (countErr) {
      console.error('[twilio-numbers] live number count failed:', countErr.message);
      return refuse(cors, 503, 'not_configured',
        'The number of live lines could not be checked, so nothing was released. Try again shortly.');
    }
    // Read-then-act, so two releases fired at the same instant could both see
    // two live numbers and both proceed. Not defended against with a lock: this
    // is one operator on one account, the guard exists to catch a mistake
    // rather than an attack, and a transaction spanning an irreversible Twilio
    // call would be the worse trade — it would hold a database lock across a
    // network round trip that cannot be rolled back anyway.
    if ((liveCount ?? 0) <= 1) {
      return refuse(cors, 409, 'last_live_number',
        `${row.e164} is the only live number on this team. Releasing it would leave nothing to call or text from — every send and every dial would refuse. Buy a replacement in the Twilio console and sync it first.`);
    }

    if (!row.twilio_sid) {
      // The SID is the only handle Twilio's API takes, so without it there is
      // no way to actually release anything — and marking the row released
      // anyway would produce the exact lie this action exists to avoid: a
      // number that reads as gone here while it still bills and still rings.
      return refuse(cors, 400, 'number_missing_sid',
        `${row.e164} has no Twilio SID on file, so Twilio cannot be told to release it. Run "Sync from Twilio" first — that is where the SID comes from. Nothing was changed.`);
    }

    // ── ORDER OF OPERATIONS: TWILIO FIRST, DATABASE SECOND ────────────────
    // This order is the whole design and it is not interchangeable.
    //
    // Marking the row released first and calling Twilio after leaves, on any
    // failure in between, a number that is invisible to the app — hidden from
    // the send path, hidden from the dialer, filed under "Released" on the
    // settings page — while it is still on the account, still billing every
    // month, and still ringing. Nobody is watching that line. A seller calls it
    // and gets nothing; the bill keeps arriving; the app confidently says the
    // number is gone. That state can persist for months because there is no
    // symptom anybody looks at.
    //
    // Twilio first inverts the failure: if the database write fails after
    // Twilio has released, the number is genuinely gone and the row still says
    // live. That is wrong too — but it is wrong in the direction that shows up
    // immediately (the next send from it errors) and it is recoverable by
    // hand, and the response below says so explicitly rather than reporting
    // success. One of these two is a silent money leak; the other is a loud
    // inconsistency. Choose loud.
    let twilioStatus = 0;
    let twilioBody: Record<string, unknown> = {};
    try {
      const resp = await fetch(
        `${TWILIO_ROOT}/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${row.twilio_sid}.json`,
        { method: 'DELETE', headers: { Authorization: twilioAuth(accountSid, authToken) } },
      );
      twilioStatus = resp.status;
      // Twilio answers a successful DELETE with 204 and no body, so this is
      // read as text and only parsed when there is something to parse —
      // resp.json() on an empty body throws, and throwing here would report a
      // release that actually happened as a failure.
      const text = await resp.text();
      if (text) {
        try { twilioBody = JSON.parse(text); } catch { twilioBody = { message: text }; }
      }
    } catch (err) {
      console.error('[twilio-numbers] Twilio release failed:', (err as Error)?.message);
      return refuse(cors, 502, 'twilio_unreachable',
        `Twilio did not answer, so ${row.e164} is still recorded as live here. The release may or may not have gone through — check the number in the Twilio console before trying again, because trying again on a number that was already released is harmless but assuming it failed is not.`);
    }

    // 404 means Twilio has no such number, which for a DELETE is the outcome we
    // asked for arriving by a different route — released in the console, or a
    // retry of a request that already succeeded. Converging to released beats
    // deadlocking: refusing here would leave a row nothing can ever clear,
    // permanently pinned live for a number the account does not own.
    const releasedAtTwilio = twilioStatus === 204 || twilioStatus === 404 ||
      (twilioStatus >= 200 && twilioStatus < 300);
    if (!releasedAtTwilio) {
      const detail = typeof twilioBody.message === 'string'
        ? twilioBody.message
        : 'Twilio refused the release.';
      return refuse(cors, 502, 'twilio_error',
        `${detail} ${row.e164} is unchanged — it is still on the account and still billing.`,
        { twilio_status: twilioStatus, twilio_code: twilioBody.code ?? null });
    }

    // ── Now, and only now, the database ───────────────────────────────────
    // A soft delete. The row stays forever because sms_messages.phone_number_id
    // is ON DELETE SET NULL — see 20260819120000_number_release.sql. released_at
    // is what takes it out of every operational path.
    const { data: marked, error: markErr } = await admin
      .from('phone_numbers')
      .update({
        released_at: new Date().toISOString(),
        released_by: user.id,
        release_reason: reason,
      })
      .eq('id', row.id)
      .eq('team_id', teamId)
      .select('id, e164, released_at');

    if (markErr || !marked?.length) {
      // The loud half of the failure mode described above. Reported as an error
      // with the SID in it, because the fix is a human editing one row and they
      // need to know which — and because reporting this as success would leave
      // the app offering to release a number that no longer exists.
      console.error('[twilio-numbers] released at Twilio but not recorded:',
        row.e164, markErr?.message ?? 'no rows updated');
      return refuse(cors, 500, 'release_not_recorded',
        `${row.e164} WAS released at Twilio and is gone from the account, but this app failed to record it, so it still shows as live here. Do not try again — there is nothing left to release. The row needs marking released by hand.`,
        { number_id: row.id, twilio_sid: row.twilio_sid, twilio_status: twilioStatus });
    }

    // telephony_settings.default_number_id is ON DELETE SET NULL, and nothing
    // was deleted — so a default pointing at this number would survive the
    // release and resolve, on every send, to a row the released_at filter then
    // rejects. Cleared to NULL rather than repointed: "no default number" makes
    // the send path refuse out loud, where quietly promoting some other number
    // would text a seller from a line they have never seen. Reported, because a
    // setting that changed itself needs saying.
    const { data: clearedDefault } = await admin
      .from('telephony_settings')
      .update({ default_number_id: null })
      .eq('team_id', teamId)
      .eq('default_number_id', row.id)
      .select('team_id');
    const defaultWasCleared = Boolean(clearedDefault?.length);

    return jsonResponse({
      ok: true,
      action: 'release',
      number_id: row.id,
      e164: row.e164,
      twilio_sid: row.twilio_sid,
      already_released: false,
      released_at: marked[0].released_at,
      release_reason: reason,
      // Stated rather than implied. 404 and 204 both end as released, and the
      // difference between "we released it" and "it was already gone" is worth
      // showing to whoever is reading the result.
      twilio_status: twilioStatus,
      twilio_already_gone: twilioStatus === 404,
      default_number_cleared: defaultWasCleared,
      live_numbers_remaining: Math.max((liveCount ?? 1) - 1, 0),
      message: twilioStatus === 404
        ? `${row.e164} was already gone from the Twilio account, so it is now recorded as released here too. Its messages and calls are kept.`
        : `${row.e164} has been released back to Twilio's pool. Billing for it stops. It cannot be recovered, and its messages and calls are kept.`,
    }, cors, 200);
  }

  return refuse(cors, 400, 'bad_request',
    `Unknown action "${action}". This function does three things: "sync" (read Twilio, update the app), "configure" (point one number's webhooks at this app) and "release" (permanently give a number back to Twilio).`);
});
