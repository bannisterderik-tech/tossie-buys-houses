import { Device } from '@twilio/voice-sdk';
import { supabase } from '../supabase.js';

/**
 * The browser softphone: one Twilio Device for the whole app.
 *
 * WHY THIS EXISTS AT ALL, in one paragraph, because it is the point of the file.
 * `tel:` hands the number to the operating system, so a call placed that way
 * never touches our infrastructure — no call_log row, no recording, and, worst,
 * no server-side re-check of `lead_is_dialable()` or the 8am–9pm called-party
 * window. Texting has always had that choke point (`twilio-send-sms`); calling
 * did not, so the greyed-out button on the dialer was the entire rail and an
 * operator could walk around it by picking up their desk phone. Every leg
 * started here goes out through `twilio-voice`'s `dial` action, which asks both
 * questions again with the service role at the moment the number is dialed.
 *
 * WHY A MODULE SINGLETON RATHER THAN A DEVICE PER MOUNT. A Device holds an open
 * signalling WebSocket and a live microphone track. Two pages can show a call
 * control (the dialer and the lead), StrictMode double-invokes effects in dev,
 * and the SPA router unmounts a page on every navigation — so a Device created
 * per mount means two Devices registered on the same identity, both of which
 * ring on an inbound call and only one of which anybody can answer. One
 * instance, reference-counted by the components that need it, is the fix.
 *
 * WHY release() DOES NOT ALWAYS DESTROY. The dialer page carries an "Open the
 * full lead" link. Destroying the Device the instant the last component
 * unmounts would drop a live seller call because somebody clicked it. So a
 * release that lands on zero while a call is up defers the destroy until that
 * call ends; the next page to mount picks the call straight back up, controls
 * and all.
 *
 * WHAT THIS DELIBERATELY DOES NOT KNOW: whether the seller picked up. Only
 * Twilio can say that, and it says it to `twilio-voice`'s status callback, which
 * writes call_log. The operator has the answer in their ear a second before any
 * webhook could tell us, so the UI states what it can actually observe — the
 * operator's own leg is up and the seller's leg was created — and the timer
 * counts from the second question, the same instant call_log.started_at records.
 */

/* ── failures the operator has to be able to read ─────────────────────────── */

/**
 * The softphone could not START. These, and only these, justify falling back to
 * `tel:`, because nothing was asked of the server and nothing was refused — the
 * phone simply is not available in this browser, on this machine, or with the
 * secrets currently deployed. A labelled downgrade is honest there.
 *
 * A DIAL that the server refuses is the opposite case and lives in DIAL_REFUSALS
 * below. Falling back to `tel:` on one of those would convert the compliance
 * rail into a speed bump, which is the single worst outcome available here.
 *
 * Same shape as lib/sms-refusals.js REFUSALS: a reason key, one plain sentence
 * that says what happened and what to do about it, no error codes on screen.
 * `not_configured` has no entry on purpose; see failureFor() below.
 */
export const STARTUP_FAILURES = {
  unsupported:
    'This browser cannot place calls. The softphone needs WebRTC and this browser does not offer it. Chrome, Edge or Firefox will work; calls can still be placed from a desk phone in the meantime.',
  insecure_origin:
    'The page is not on a secure origin, so the browser refuses to hand out a microphone at all. Open the app over https and the softphone works.',
  mic_policy_blocked:
    'The page itself is blocking the microphone, so no browser setting can turn it on. Its Permissions-Policy header has to allow microphone=(self) — this is a deployment fix, not something to change on this machine.',
  mic_denied:
    'The microphone is blocked for this site, and a call nobody can speak on is not a call. Allow the microphone from the icon in the browser’s address bar, then reload this page.',
  no_mic:
    'No microphone is connected to this machine, so there is nothing to talk into. Plug in a headset and reload the page.',
  mic_busy:
    'The microphone could not be opened — usually another app is already holding it. Close whatever else is using it and reload the page.',
  not_authenticated:
    'Your session has expired, so the calling token could not be requested. Reload the page and sign in again.',
  no_team:
    'Your account is not on a team, so the calling token was refused. Nothing on this page can fix that.',
  token_failed:
    'The calling token could not be fetched, so the softphone never started. This is usually the network or the edge function being down rather than anything about this lead.',
  registration_failed:
    'The token was issued but Twilio would not register this browser, so no call can be placed through it. Reload the page; if it repeats, the Voice SDK secrets or the TwiML app need checking.',
  account_mismatch:
    'The Twilio API Key was created in a different Twilio account than the Account SID, so Twilio rejects every token this app signs. Create a Standard API Key inside the account that owns the phone numbers, set TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET from it, and redeploy twilio-voice.',
  device_error:
    'Twilio reported a problem with this browser’s connection to it and the softphone is not usable. Reload the page.',
};

/** The last resort: something failed and neither we nor the server named it. */
const UNNAMED_FAILURE =
  'The softphone could not start and nothing came back to say why. Reload the page; if it happens again, the twilio-voice function’s logs will have the reason.';

/**
 * The server said no, or the leg failed on the way out. NONE of these fall back
 * to `tel:`.
 *
 * Keys are the `code` values `twilio-voice` puts on a refusal, spelled the way
 * that function spells them — a contract exactly like the one lib/sms-refusals.js
 * keeps with twilio-send-sms, and a typo here is invisible because an unknown
 * code falls through to the server's own sentence. Grep both files together
 * before renaming one.
 *
 * The server's message carries the specifics (which hour, which timezone), so
 * these are the second half of the sentence, not a replacement for it.
 */
export const DIAL_REFUSALS = {
  not_dialable:
    'Nothing was dialed. lead_is_dialable() refused the number at dial time, which it re-checks with the service role no matter what this page believed when the queue was built — usually a STOP or a DNC flag that landed since. Fix the lead, not the call.',
  outside_calling_window:
    'Nothing was dialed. The calling window is checked again here, at the moment of the dial, because that is the check a court would look for. This one waits.',
  no_lead:
    'Nothing was dialed: no lead on this team matches that number, so there is no skip trace, scrub or opt-in behind it. Only leads can be dialed from here.',
  voice_not_configured:
    'Nothing was dialed: the voice function is missing a Twilio secret. That is a deploy step, not something this page can fix.',
  voice_misconfigured:
    'Nothing was dialed: the voice function’s Twilio secrets are set but malformed.',
};

/** Twilio's own code for "the API Key is not from this account". */
const ACCESS_TOKEN_SIGNATURE_FAILED = 31202;

/**
 * supabase-js raises FunctionsHttpError for any non-2xx and never reads the
 * body, so the reason is sitting unread on the Response. Same lift as
 * lib/sms-refusals.js explainRefusal(); duplicated rather than shared because
 * the two functions answer with different key names and merging them would mean
 * one map that has to know about both.
 */
async function readServerError(error) {
  let payload = null;
  try { payload = await error?.context?.json?.(); } catch { /* not JSON */ }
  return {
    status: error?.context?.status ?? null,
    // twilio-voice answers `{ error, code }`; the SMS path answers
    // `{ message, reason }`. Read both so a future convergence needs no edit.
    code: payload?.code || payload?.reason || null,
    message: payload?.error || payload?.message || null,
  };
}

/** One refusal payload, one on-screen sentence. */
function refusalSentence(code, serverMessage, fallback) {
  const known = code ? DIAL_REFUSALS[code] : null;
  return [serverMessage, known].filter(Boolean).join(' ') || fallback;
}

/* ── the store ────────────────────────────────────────────────────────────── */

/**
 * `status` is what the operator's own leg is doing, never what the seller's is.
 *
 *   idle        no Device; nobody has asked for one
 *   starting    fetching a token, opening the mic, registering
 *   ready       registered and quiet
 *   connecting  the operator's leg is being established (mic + WebRTC)
 *   dialing     operator is in the room and the server accepted the dial;
 *               the seller's phone is ringing
 *   ending      hang-up requested, waiting for Twilio to close the leg
 *   unavailable startup failed — `failure` says why, and tel: is legitimate
 */
let state = {
  status: 'idle',
  failure: null,      // { reason, text } — could not START. tel: fallback is honest.
  refusal: null,      // { code, text }   — a dial was refused. tel: fallback is NOT.
  muted: false,
  startedAt: null,    // ms epoch the seller's leg was created
  leadId: null,
  callSid: null,
  // A token refresh that failed. The Device is still live on the old token for
  // a few more seconds, so this is a warning rather than a failure — but an
  // operator an hour into a call list deserves to know the clock is running out
  // before the leg dies mid-sentence.
  tokenStale: false,
  // An inbound call ringing this browser. Nothing routes here today (see
  // acceptIncoming below), so this stays false until inbound routing grows a
  // <Client> branch.
  incomingFrom: null,
};

const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** useSyncExternalStore needs a stable snapshot, which the frozen-ish object above is. */
export function getState() {
  return state;
}

/* ── device lifecycle ─────────────────────────────────────────────────────── */

let device = null;
let activeCall = null;
let refs = 0;
/** Set when the last component released while a call was still up. */
let destroyWhenIdle = false;
/** Guards against two mounts racing two start() calls into two Devices. */
let starting = null;
/**
 * Bumped by every stop(). start() captures it and checks it again after each
 * await, because a component can unmount while a token is still in flight —
 * StrictMode's mount/unmount/mount does exactly that in development. Without
 * this, stop() finds no Device to destroy (it has not been built yet), start()
 * then finishes and registers one, and nothing is left holding a reference to
 * it: a Device with an open socket and a live microphone that nobody can reach.
 */
let generation = 0;

class StartupError extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
    // The server's own words, when there were any. failureFor() puts them in
    // front of ours rather than instead of them.
    this.detail = detail || null;
  }
}

/**
 * Ask twilio-voice for a Voice SDK access token.
 *
 * The contract is the deployed one and is not negotiable from here:
 * POST { action: 'token' } → 200 { token, identity }, or a non-2xx carrying
 * { error, code, missing } where `error` already names the exact unset secret.
 */
async function fetchToken() {
  const { data, error } = await supabase.functions.invoke('twilio-voice', {
    body: { action: 'token' },
  });

  if (error) {
    const detail = await readServerError(error);
    if (detail.status === 401) throw new StartupError('not_authenticated');
    if (detail.status === 403) throw new StartupError('no_team');
    // The whole reason the endpoint bothers to name TWILIO_API_KEY_SID rather
    // than saying "not configured" is so that name reaches a human. Passing the
    // server's sentence through untouched is what makes that worth having done.
    if (detail.code === 'voice_not_configured' || detail.code === 'voice_misconfigured') {
      throw new StartupError('not_configured', detail.message);
    }
    throw new StartupError('token_failed', detail.message || null);
  }

  if (!data?.token) throw new StartupError('token_failed');
  return data.token;
}

/**
 * Open the microphone once, before any call, and let go of it again.
 *
 * Twilio would surface the same errors on the first `connect()`, but that is one
 * dial too late: the operator has already committed to a lead, and "permission
 * denied" arriving where a ringing phone should be reads as a broken app. Asking
 * up front turns three distinct outcomes — blocked, absent, held by something
 * else — into three sentences the operator can act on before they need one.
 *
 * The tracks are stopped immediately. Leaving them open lights the browser's
 * recording indicator for an entire shift, which is both alarming and a fair
 * description of what a permanently open mic is.
 */
async function probeMicrophone() {
  // Undefined on an insecure origin, which is a materially different problem
  // from a missing microphone and has a completely different fix.
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new StartupError(window.isSecureContext === false ? 'insecure_origin' : 'unsupported');
  }
  // Ask the page's own Permissions-Policy BEFORE prompting.
  //
  // A `Permissions-Policy: microphone=()` header forbids the microphone to every
  // origin including this one, and getUserMedia then rejects with the very same
  // NotAllowedError the browser uses when a person clicks Block. The two need
  // completely different fixes and only one of them is possible for the
  // operator: when the header is the cause there is no address-bar icon to
  // click, because the site is what is refusing. Telling someone to change a
  // browser setting that cannot help is worse than saying nothing.
  //
  // This app shipped exactly that header for months before it became a phone.
  const policy = document.featurePolicy || document.permissionsPolicy;
  if (policy && typeof policy.allowsFeature === 'function' && !policy.allowsFeature('microphone')) {
    throw new StartupError('mic_policy_blocked');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new StartupError('mic_denied');
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') throw new StartupError('no_mic');
    throw new StartupError('mic_busy');
  }
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Conference names travel in a query string and land inside an XML element, so
 * twilio-voice reduces them to [A-Za-z0-9_-] and 64 characters. Anything that
 * survives that filter round-trips unchanged, which is why this alphabet.
 *
 * Uniqueness matters more than it looks: two operators (or one operator and a
 * stale leg) landing in the same room would bridge two sellers to each other.
 */
function newConferenceName() {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `sp${Date.now().toString(36)}${rand.slice(0, 16)}`;
}

/**
 * The phone is gone and here is why. Destroys the Device rather than leaving a
 * dead one in place: a Device that is registered but unusable would make retry()
 * a no-op, which is how "Try again" becomes a button that does nothing.
 */
function fail(reason, text) {
  if (device) {
    try { device.destroy(); } catch { /* already gone */ }
    device = null;
  }
  activeCall = null;
  setState({ status: 'unavailable', failure: failureFor(reason, text), startedAt: null, leadId: null });
}

function wireDevice(d) {
  // Route inbound audio to a real output device on register.
  //
  // Two separate hazards here, and the second is far worse than the first.
  //
  // (1) Twilio's auto-pick is occasionally wrong — it selects an output that is
  //     not plugged in, and the call has inbound audio going nowhere. Setting it
  //     explicitly fixes that.
  //
  // (2) speakerDevices.set() returns a Promise that REJECTS ASYNCHRONOUSLY when
  //     the device id is not in availableOutputDevices. A try/catch does not
  //     catch it. reoperative shipped exactly that bug, and the consequence was
  //     not a stray console warning: in the rejected state, subsequent
  //     device.connect() calls silently failed to reach Twilio, so calls stopped
  //     connecting AND stopped writing call_log rows, with nothing on screen to
  //     say so. A dialer that quietly stops dialing is the worst failure this
  //     file can have.
  //
  // So: preflight against availableOutputDevices, and .catch() the promise even
  // though some SDK builds return undefined synchronously.
  d.on('registered', () => {
    if (device !== d) return;
    try {
      const outputs = d.audio?.availableOutputDevices;
      const setSpeaker = d.audio?.speakerDevices?.set;
      if (typeof setSpeaker !== 'function' || !outputs || outputs.size === 0) return;

      const ids = Array.from(outputs.keys?.() || []);
      const target = ids.includes('default') ? 'default' : (ids[0] || null);
      if (!target) return;

      const result = d.audio.speakerDevices.set(target);
      if (result && typeof result.catch === 'function') {
        result.catch((e) => {
          console.warn('[softphone] speakerDevices.set rejected (non-fatal):', e?.message || e);
        });
      }
    } catch (e) {
      console.warn('[softphone] could not set the output device (non-fatal):', e?.message || e);
    }
  });

  d.on('error', (err) => {
    if (device !== d) return;
    // 31202 is AccessTokenSignatureValidationFailed, and the raw code is worse
    // than useless here: it reads as a signing bug, so people go and re-check
    // the signing code, which is correct. It means the API Key belongs to a
    // different Twilio account than the Account SID, and nothing on the server
    // can detect that — the token it signs is well-formed. Say the sentence.
    if (err?.code === ACCESS_TOKEN_SIGNATURE_FAILED) {
      fail('account_mismatch');
      return;
    }
    // A device-level error while a call is up is about the call; one while idle
    // is about the device. Only the second kind takes the phone away.
    if (activeCall) {
      setState({ refusal: { code: 'device_error', text: refusalSentence(null, err?.message, STARTUP_FAILURES.device_error) } });
      return;
    }
    fail('device_error');
  });

  // Tokens live an hour. An operator working a call list for a shift will cross
  // that boundary mid-session, and a Device on an expired token stops being able
  // to place calls without ever saying so. Twilio fires this ten seconds out.
  d.on('tokenWillExpire', async () => {
    try {
      const token = await fetchToken();
      // The Device may have been destroyed while the token was in flight;
      // updateToken on a destroyed Device throws.
      if (device !== d) return;
      d.updateToken(token);
      setState({ tokenStale: false });
    } catch {
      // Not a failure: the old token is still good for a few seconds and the
      // call in progress is unaffected. Say so rather than tearing down a live
      // conversation over a refresh that may well succeed on the next attempt.
      if (device === d) setState({ tokenStale: true });
    }
  });

  // Nothing routes an inbound call to the browser today — twilio-voice's inbound
  // branch dials `forward_to_e164` and never a <Client>. The grant allows it and
  // the handler exists so that the day inbound routing changes, an unhandled
  // 'incoming' does not leave a call ringing invisibly in a tab.
  d.on('incoming', (call) => {
    if (activeCall) { call.reject(); return; }
    activeCall = call;
    wireCall(call);
    setState({ incomingFrom: call.parameters?.From || 'an unknown number' });
  });
}

function wireCall(call) {
  const finish = () => {
    if (activeCall !== call) return;
    activeCall = null;
    setState({
      status: 'ready', muted: false, startedAt: null, callSid: null, leadId: null, incomingFrom: null,
    });
    // The deferred teardown from a release() that landed on zero mid-call.
    if (destroyWhenIdle && refs === 0) stop();
  };
  call.on('disconnect', finish);
  call.on('cancel', finish);
  call.on('reject', finish);
  call.on('error', (err) => {
    setState({ refusal: { code: 'call_error', text: refusalSentence(null, err?.message, 'The call leg failed and Twilio gave no reason. Nothing about the lead changed; try again.') } });
    finish();
  });
}

/**
 * One failure, one on-screen sentence.
 *
 * The server's own words come FIRST and are never replaced, only followed by
 * ours — same discipline as lib/sms-refusals.js refusalFrom(), and the reason
 * `not_configured` deliberately has no entry in the map above: for that case the
 * server's sentence already names the exact unset secret, and it reaches the
 * screen alone and verbatim rather than paraphrased into something that goes
 * stale the next time that function's wording changes.
 */
function failureFor(reason, detail) {
  const mapped = STARTUP_FAILURES[reason] || null;
  return { reason, text: [detail, mapped].filter(Boolean).join(' ') || UNNAMED_FAILURE };
}

/**
 * Build the Device. Idempotent, and safe to call from two mounting components at
 * once — the second gets the first one's promise rather than a second Device.
 */
function start() {
  if (device || starting) return starting || Promise.resolve();

  const gen = generation;

  starting = (async () => {
    setState({ status: 'starting', failure: null, refusal: null, tokenStale: false });
    try {
      // isSupported is Twilio's own WebRTC check and it is cheap, so it goes
      // first: no point asking for a microphone the SDK could not use anyway.
      if (!Device.isSupported) throw new StartupError('unsupported');
      await probeMicrophone();

      const token = await fetchToken();
      // Released while the token was in flight. Build nothing.
      if (gen !== generation) return;

      const d = new Device(token, {
        // PCMU FIRST, and this order is not a preference — it is a fix.
        // reoperative learned it in production: a WebRTC-to-PSTN bridge can
        // drop audio outright when Opus is negotiated and Twilio cannot
        // transcode in time, and the symptom is a connected call with silence
        // rather than an error anyone can see. PCMU is the lowest common
        // denominator every carrier bridge speaks. Quality is the wrong thing
        // to optimise against a seller who cannot hear you.
        codecPreferences: ['pcmu', 'opus'],
        // Pin the media edge. The default is 'roaming', which sometimes picks
        // a far or overloaded region; the media path then fails to negotiate
        // and the call answers, sits silent, and hangs up on its own. Ashburn
        // is US-East and is the right edge for a Savannah operator.
        edge: 'ashburn',
        // Twilio fires tokenWillExpire ten seconds out by default, which is not
        // enough room for a fetch to fail and be retried. Thirty seconds gives
        // the refresh handler a second chance before the line goes dead
        // mid-conversation.
        tokenRefreshMs: 30000,
        maxCallSignalingTimeoutMs: 10000,
        // Distinguishes signalling failures that otherwise arrive as one
        // undifferentiated error, which matters because our whole error story
        // is telling the operator which specific thing is wrong.
        enableImprovedSignalingErrorPrecision: true,
        // Warn before the tab is closed mid-call. The browser IS the phone here,
        // so a stray cmd-W hangs up on a seller with no undo.
        closeProtection: true,
        // Twilio's default is 'info', which puts a running commentary in the
        // console. 'error' keeps the console useful for our own logging.
        logLevel: 'error',
      });
      wireDevice(d);
      device = d;

      try {
        await d.register();
      } catch (e) {
        try { d.destroy(); } catch { /* already gone */ }
        if (device === d) device = null;
        if (e?.code === ACCESS_TOKEN_SIGNATURE_FAILED) throw new StartupError('account_mismatch');
        throw new StartupError('registration_failed', e?.message || null);
      }

      // Released during registration. Same reasoning as above, one await later.
      if (gen !== generation) {
        try { d.destroy(); } catch { /* already gone */ }
        if (device === d) device = null;
        return;
      }

      setState({ status: 'ready', failure: null });
    } catch (e) {
      if (gen !== generation) return;
      const reason = e instanceof StartupError ? e.reason : 'token_failed';
      const detail = e instanceof StartupError ? e.detail : e?.message;
      setState({ status: 'unavailable', failure: failureFor(reason, detail) });
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/**
 * Tear the Device down for real.
 *
 * destroy() is the whole point of this function: it closes the signalling
 * WebSocket and releases the microphone. A page that unmounts without it leaks
 * both, and the next mount registers a second Device on the same identity that
 * also rings.
 */
function stop() {
  generation += 1;
  destroyWhenIdle = false;
  activeCall = null;
  if (device) {
    try { device.destroy(); } catch { /* already gone */ }
    device = null;
  }
  setState({
    status: 'idle', failure: null, refusal: null, muted: false,
    startedAt: null, leadId: null, callSid: null, tokenStale: false, incomingFrom: null,
  });
}

/** A component wants a phone. Reference-counted; see the header. */
export function acquire() {
  refs += 1;
  destroyWhenIdle = false;
  start();
}

/** A component is going away. Destroys at zero — unless a call is still up. */
export function release() {
  refs = Math.max(0, refs - 1);
  if (refs > 0) return;
  if (activeCall) { destroyWhenIdle = true; return; }
  stop();
}

/** Try again after a startup failure, without a page reload. */
export function retry() {
  if (device || starting) return;
  stop();
  if (refs > 0) start();
}

/* ── placing a call ───────────────────────────────────────────────────────── */

/**
 * Ring a lead.
 *
 * Two legs, in this order, and the order is load-bearing:
 *
 *  1. The operator's own leg joins an empty conference. This opens the
 *     microphone, so a mic that is broken in a way the startup probe did not
 *     catch fails HERE — before a homeowner's phone has rung — instead of after.
 *  2. `twilio-voice`'s `dial` action creates the seller's leg into the same
 *     room. That is the only call this app can originate, and it re-runs
 *     lead_is_dialable() and the 8am–9pm called-party window with the service
 *     role before Twilio is touched.
 *
 * A refusal at step 2 disconnects step 1 and reports the server's reason. It
 * does NOT fall back to `tel:`, and neither does a network failure on that
 * request: on a refusal the answer was no, and on a network failure the answer
 * is unknown — and dialing anyway on an unknown answer is the same bet with
 * worse odds.
 */
export async function call(leadId) {
  if (!leadId) return;
  // `device &&` as well as the status, because a device-level error can take the
  // Device away a frame after the button rendered as live.
  if (!device || state.status !== 'ready') return;

  const conference = newConferenceName();
  setState({ status: 'connecting', refusal: null, leadId, callSid: null, startedAt: null, muted: false });

  let leg;
  try {
    // `To` is the parameter twilio-voice reads, and the `conference:` prefix is
    // how the operator's leg asks for a room. Both are that function's contract.
    leg = await device.connect({ params: { To: `conference:${conference}` } });
  } catch (e) {
    setState({
      status: 'ready',
      leadId: null,
      refusal: {
        code: 'leg_failed',
        text: refusalSentence(null, e?.message, 'Your own call leg could not be opened, so nothing was dialed. Check the microphone and try again.'),
      },
    });
    return;
  }

  activeCall = leg;
  wireCall(leg);
  // The leg can close between connect() resolving and the handlers above being
  // attached, in which case the 'disconnect' we are relying on has already been
  // and gone. Ask the leg directly rather than waiting for an event that will
  // never arrive.
  if (leg.status() === 'closed') {
    activeCall = null;
    setState({ status: 'ready', leadId: null });
    return;
  }

  try {
    const { data, error } = await supabase.functions.invoke('twilio-voice', {
      body: { action: 'dial', lead_id: leadId, conference },
    });
    if (error) throw error;

    // The operator can hang up while the dial request is in flight; landing the
    // "we are connected" state on a leg that is already gone strands the UI on a
    // call that does not exist.
    if (activeCall !== leg) return;
    setState({ status: 'dialing', callSid: data?.call_sid || null, startedAt: Date.now() });
  } catch (e) {
    const detail = await readServerError(e);
    // Hang up our own leg: leaving it in an empty conference bills for a leg
    // nobody is on and leaves the operator listening to hold music after a
    // refusal, which reads as "it is dialing".
    try { leg.disconnect(); } catch { /* already gone */ }
    // Reset the lifecycle here as well as in the 'disconnect' handler. Whichever
    // runs first writes the same fields, and relying on the event alone leaves
    // the UI stranded on "Opening your line…" if the leg was already dead.
    setState({
      status: 'ready',
      leadId: null,
      startedAt: null,
      callSid: null,
      refusal: {
        code: detail.code || 'dial_failed',
        text: refusalSentence(
          detail.code,
          detail.message,
          'The dial request failed and the server gave no reason, so whether the seller’s phone rang is genuinely unknown. Check the lead’s call history before trying again.',
        ),
      },
    });
  }
}

/** Hang up. endConferenceOnExit is true on this leg, so the seller drops too. */
export function hangUp() {
  if (!activeCall) return;
  setState({ status: 'ending' });
  try { activeCall.disconnect(); } catch { /* already gone */ }
}

export function setMuted(next) {
  if (!activeCall) return;
  activeCall.mute(next);
  setState({ muted: next });
}

export function acceptIncoming() {
  if (!activeCall || !state.incomingFrom) return;
  activeCall.accept();
  setState({ status: 'dialing', incomingFrom: null, startedAt: Date.now() });
}

export function rejectIncoming() {
  if (!activeCall) return;
  activeCall.reject();
}

/** Clear a refusal the operator has read, so the next lead starts clean. */
export function dismissRefusal() {
  if (state.refusal) setState({ refusal: null });
}
