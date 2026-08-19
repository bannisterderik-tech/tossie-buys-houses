import { useEffect, useState, useSyncExternalStore } from 'react';
import * as phone from '../lib/softphone.js';
import { formatPhone } from '../lib/format.js';
import './softphone.css';

/**
 * The call control, and the sentences that explain it when it will not work.
 *
 * Two exports rather than one component, because the two halves belong in
 * different places on both pages that use them: the control goes where the Call
 * button already was (a flex row that also holds Skip, or the lead's callbar),
 * and the sentences go in the stack of notices underneath, next to the
 * calling-window and dialability blocks they sit alongside. One component would
 * have forced one of the two into the wrong column.
 *
 * Both halves read the same store, so they cannot disagree about what the phone
 * is doing.
 */

/**
 * Hold the shared Device open for as long as this component is mounted.
 *
 * The release() on unmount is the important line. A Device holds a signalling
 * WebSocket and a microphone; unmounting without releasing leaks both and lets
 * the next mount register a second Device on the same identity. See the header
 * of lib/softphone.js for why release does not always destroy immediately.
 */
export function useSoftphone() {
  useEffect(() => {
    phone.acquire();
    return () => phone.release();
  }, []);

  return useSyncExternalStore(phone.subscribe, phone.getState);
}

/** True while this lead is the one on the phone. */
function busyWith(sp, leadId) {
  return sp.leadId === leadId && ['connecting', 'dialing', 'ending'].includes(sp.status);
}

/** '00:00' — the only honest thing to count is the seller leg's own age. */
function elapsed(startedAt, now) {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

/* ── the button, and what it becomes mid-call ─────────────────────────────── */

/**
 * @param sp       the store, from useSoftphone()
 * @param blocked  the PAGE's own reason not to offer a call at all — not
 *                 dialable, outside the window, still checking. When this is
 *                 set nothing else is rendered, because none of the softphone's
 *                 own states are worth reading past a compliance block.
 */
export function SoftphoneControl({ sp, leadId, number, blocked }) {
  // A one-second tick, and only while a call is up. A timer that runs on an idle
  // dialer page re-renders the whole queue once a second for nothing.
  const [now, setNow] = useState(() => Date.now());
  const running = busyWith(sp, leadId) && sp.startedAt;
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (blocked) {
    return <span className="btn big stopped" aria-disabled="true">{blocked}</span>;
  }

  if (busyWith(sp, leadId)) {
    return (
      <div className="sp-live">
        <span className="sp-state">
          {sp.status === 'ending' ? 'Hanging up…'
            : sp.status === 'connecting' ? 'Opening your line…'
            : `Ringing ${formatPhone(number)}`}
          {sp.startedAt ? <b>{elapsed(sp.startedAt, now)}</b> : null}
        </span>
        <button
          className={`btn ghost sp-mute${sp.muted ? ' on' : ''}`}
          onClick={() => phone.setMuted(!sp.muted)}
          disabled={sp.status !== 'dialing'}
        >
          {sp.muted ? 'Unmute' : 'Mute'}
        </button>
        <button className="btn danger" onClick={phone.hangUp}>Hang up</button>
      </div>
    );
  }

  // Busy on a different lead. Offering a second Call would disconnect the first
  // one out from under whoever is talking on it.
  if (['connecting', 'dialing', 'ending'].includes(sp.status)) {
    return <span className="btn big stopped" aria-disabled="true">Already on a call</span>;
  }

  if (sp.status === 'idle' || sp.status === 'starting') {
    return <span className="btn big stopped" aria-disabled="true">Starting the phone…</span>;
  }

  // The softphone could not START. tel: is a real way to place the call today,
  // so it stays — but LABELLED, never as a silent downgrade, because a call
  // placed this way skips the server-side gate that is the whole point of the
  // softphone. The sentence naming the reason is in SoftphoneNotice below.
  if (sp.status === 'unavailable') {
    return (
      <span className="sp-fallback">
        <a className="btn big ghost" href={`tel:${String(number || '').replace(/[^\d+]/g, '')}`}>
          Dial {formatPhone(number)} on this device
        </a>
        <em>Softphone unavailable — this call is not logged or recorded.</em>
      </span>
    );
  }

  return (
    <button className="btn big" onClick={() => phone.call(leadId)}>
      Call {formatPhone(number)}
    </button>
  );
}

/* ── the sentences ───────────────────────────────────────────────────────── */

/**
 * Every failure state as a plain sentence, in the order they matter: what the
 * server refused first, then what stopped the phone from starting.
 *
 * The refusal is styled as an error and the startup failure as a notice on
 * purpose. A refusal means a call did NOT go out and must not be worked around;
 * a startup failure means the phone is missing and there is a labelled way
 * round it. Colouring them the same would flatten that difference.
 */
export function SoftphoneNotice({ sp }) {
  return (
    <>
      {sp.incomingFrom && (
        <div className="notice sp-note">
          <strong>{formatPhone(sp.incomingFrom)} is calling this browser.</strong>
          <span className="sp-actions">
            <button className="btn" onClick={phone.acceptIncoming}>Answer</button>
            <button className="btn ghost" onClick={phone.rejectIncoming}>Decline</button>
          </span>
        </div>
      )}

      {sp.refusal && (
        <div className="err sp-refusal">
          <strong>The call was refused at dial time.</strong>
          {sp.refusal.text}
          {/* No tel: link here, deliberately. The server said no; handing the
              operator a way to place the same call outside the system would
              turn a compliance rail into a speed bump. */}
          <button className="btn ghost" onClick={phone.dismissRefusal}>Dismiss</button>
        </div>
      )}

      {sp.status === 'unavailable' && sp.failure && (
        <div className="notice sp-note">
          <strong>The browser softphone could not start.</strong>
          {sp.failure.text}
          {' '}Until it does, Call falls back to handing the number to this device&rsquo;s own dialer.
          A call placed that way is not logged, not recorded, and the server never sees it — so it
          cannot re-check the calling window or lead_is_dialable(), and the checks on this page are
          the only ones that call gets.
          <button className="btn ghost" onClick={phone.retry}>Try again</button>
        </div>
      )}

      {sp.tokenStale && (
        <div className="notice sp-note">
          <strong>The calling token could not be refreshed.</strong>
          Any call in progress is unaffected, but the next one may fail until this page is reloaded.
        </div>
      )}
    </>
  );
}
