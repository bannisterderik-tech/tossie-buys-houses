import { deliveryState } from '../lib/sms-refusals.js';

/**
 * What became of an outbound text, rendered the same way everywhere it appears.
 *
 * There are two composers — the lead detail thread and the inbox — and before
 * this they each spelled the delivery state out by hand. Both printed the raw
 * `status` string, which meant 'undelivered' (the carrier threw it away, the
 * seller has nothing) sat on screen in the same grey as 'queued' (it is fine,
 * give it a second). One of those needs the operator to do something and the
 * other does not, and a screen that cannot tell them apart is a screen that
 * quietly loses deals: the follow-up never happens because the text looks sent.
 *
 * The words and the tone come from lib/sms-refusals.js — same file as the send
 * refusals, because "did it go out" and "did it arrive" are one question asked
 * a second apart. This file is only the shape of it.
 *
 * Nothing here is the enforcement of anything. It is the readout.
 */

/**
 * The state chip: QUEUED / SENT / DELIVERED / UNDELIVERED / FAILED.
 *
 * Renders nothing for inbound. An inbound message has no delivery state worth
 * showing — it is here, which is the whole story — and a chip on it would put
 * the seller's own words behind a status the seller has no part in.
 */
export function DeliveryChip({ message }) {
  const d = deliveryState(message);
  if (!d) return null;
  return <span className={`deliv ${d.tone}`}>{d.label}</span>;
}

/**
 * Why a text is dead, printed inside the bubble under the text it is about.
 *
 * Three lines, in the order an operator needs them:
 *
 *   the headline   the seller does not have this message, and whether it died
 *                  before or after it left us.
 *   the code       Twilio's number, verbatim and monospaced, because it is the
 *                  thing that gets searched for and pasted into a support
 *                  thread. Never hidden behind the translation.
 *   what to do     the translation, when there is one.
 *
 * Plus the badge, which is the point of the whole component. 30007 (carrier
 * spam filter) and 30034 (number not on an A2P campaign) are not facts about
 * this seller — they are facts about our messaging setup, and they are hitting
 * every text sent from that number. An operator who reads them as "this lead is
 * unreachable" will work down an entire list drawing that conclusion one seller
 * at a time while the actual problem goes unnoticed. The badge is the only
 * thing standing between those two readings.
 */
export function DeliveryFailure({ message }) {
  const d = deliveryState(message);
  if (!d?.failed) return null;

  return (
    <span className="delivwhy">
      {d.headline}
      {d.code && <span className="code"> · Twilio {d.code}</span>}
      {d.codeText && <span className="what">{d.codeText}</span>}
      {d.setupProblem && <span className="setup">Our setup, not this seller</span>}
    </span>
  );
}
