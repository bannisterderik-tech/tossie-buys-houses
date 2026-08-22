/**
 * Coastal GA Property Solutions' purchase agreement, as a template.
 *
 * The wording is transcribed from the company's own Word template and is not
 * mine to improve. Everything that is not a blank on that form is fixed text
 * here, character for character, including the clauses that read oddly — a
 * purchase agreement is a document somebody may have to stand behind in front
 * of a closing attorney, and quietly rewording it because a sentence is clumsy
 * is the one change nobody would notice until it mattered.
 *
 * Two deliberate exceptions, both flagged to the operator rather than slipped
 * in: the DBA is left off entirely (the buyer is the LLC), and "athis writing"
 * in the standing Other Agreements text is set as "at this writing". Both are
 * editable, and the second is a plain typo in the source.
 *
 * The output is HTML rather than a PDF because the document has to stay
 * editable after it is generated. The browser's own print-to-PDF turns it into
 * a file at the end, which also means the text stays selectable and searchable
 * in the result — a rasterised PDF of a contract is worse than the HTML it
 * came from.
 */

/** The company, as it should appear as Buyer. No DBA, by instruction. */
export const BUYER_ENTITY = 'Coastal GA Property Solutions, LLC';

/** The standing disclosure that closes the form. */
export const PRINCIPAL_NOTICE =
  '*Tossie Griner of Coastal Ga Property Solutions is acting as Principal and is '
  + 'a licensed Realtor in the State of Georgia (Ga RE LIC 167853)';

export const DEFAULT_OTHER_AGREEMENTS =
  '1. All appliances on site at this writing remain as part of the sale\n'
  + '2. Buyer and Seller may extend the Closing Date Unilaterally for up to 8 business '
  + 'days upon written/fax/text/email/Addendum notice to all parties';

/**
 * Every blank on the form, with the defaults that are true of every offer this
 * company writes. Anything left empty renders as a ruled blank line rather than
 * as nothing, so a contract printed with a gap looks like a form waiting to be
 * completed instead of a finished document missing a term.
 */
export function defaultFields(lead = {}) {
  // "1408 East Duffy Street, Savannah, GA 31401" — comma after the street, and
  // a space before the ZIP. This is the address as it will be read out at a
  // closing table, so it gets postal punctuation rather than the app's usual
  // display join.
  const cityState = [lead.city, lead.state].filter(Boolean).join(', ');
  const addr = [
    [lead.address, cityState].filter(Boolean).join(', '),
    lead.zip,
  ].filter(Boolean).join(' ');

  return {
    agreement_date: today(),
    seller_name: lead.owner_name || lead.name || '',
    buyer_name: BUYER_ENTITY,
    subject_property: addr,
    legal_description: '',
    purchase_price: '',
    acceptance_deadline: '',
    closing_date: '',
    title_company: '',
    // Which of the two lockbox options on the form is ticked.
    access_method: 'seller_places_lockbox',
    emd_amount: '300.00',
    other_agreements: DEFAULT_OTHER_AGREEMENTS,
    governing_state: stateName(lead.state) || 'Georgia',
  };
}

/**
 * 'GA' -> 'Georgia'. A governing-law clause naming "the STATE OF: GA" is not
 * wrong so much as unserious, and this is the one field on the form that is
 * quoting a jurisdiction rather than an address. Only the states this company
 * actually buys in; anything else passes through untouched and is editable.
 */
const STATE_NAMES = {
  GA: 'Georgia', SC: 'South Carolina', NC: 'North Carolina',
  FL: 'Florida', AL: 'Alabama', TN: 'Tennessee',
};
function stateName(v) {
  const s = String(v ?? '').trim();
  return STATE_NAMES[s.toUpperCase()] ?? s;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 2026-08-22 -> August 22, 2026. Anything unparseable is passed through. */
export function longDate(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) return String(v);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** 185000 -> $185,000.00. Text that is not a number is passed through. */
export function money(v) {
  const s = String(v ?? '').replace(/[^0-9.]/g, '');
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A filled value, or a ruled blank of the same height.
 *
 * The blank is the point: a generated contract with an empty closing date has
 * to read as unfinished on paper, not as a contract with no closing date.
 */
const slot = (v, { block = true } = {}) => {
  const t = String(v ?? '').trim();
  if (t) return `<span class="v">${esc(t)}</span>`;
  return block ? '<span class="blank"></span>' : '<span class="blank sm"></span>';
};

const tick = (on) => (on ? '☑' : '☐');

export function renderContract(f = {}, opts = {}) {
  const logo = opts.logo ? `<img class="mark" src="${esc(opts.logo)}" alt="">` : '';
  const lockboxSeller = f.access_method === 'seller_places_lockbox';

  const otherLines = String(f.other_agreements ?? '')
    .split('\n').filter((l) => l.trim())
    .map((l) => `<div>${esc(l)}</div>`).join('');

  return `
<article class="psa">
  <header class="psahead">
    ${logo}
    <h1>CONTRACT FOR THE PURCHASE &amp; SALE OF REAL ESTATE</h1>
  </header>

  <p><b>DATE:</b> On this day ${slot(longDate(f.agreement_date))}</p>

  <p><b>PARTIES</b>: This agreement is made between<br>
  <b>SELLER</b>: ${slot(f.seller_name)}<br>
  and<br>
  <b>BUYER:</b> ${slot(f.buyer_name)}</p>

  <p><b>Seller agrees to sell, and buyer agrees to purchase the subject property named herein.</b></p>

  <p><b>WITNESSETH:</b> That Seller, in consideration of the payments, covenants, agreements and
  conditions herein contained which on the part of the Buyer are to be made, done and performed,
  has this day sold, upon the conditions hereinafter recited, to the Buyer the real property legally
  described as:</p>

  <p><b>SUBJECT PROPERTY:</b> ${slot(f.subject_property)}</p>

  <p><b>LEGAL DESCRIPTION:</b> ${slot(f.legal_description)}</p>

  <p><b>PURCHASE PRICE:</b> ${slot(money(f.purchase_price))}</p>

  <p><b>PAYABLE:</b> <i><b>THIS IS AN ALL CASH TRANSACTION, PURCHASE PRICE IS NET TO SELLER,
  SUBJECT TO PRORATED TAXES</b></i></p>

  <p><b>EXPENSES:</b> <i><b>BUYER PAYS ALL CLOSING COSTS.</b></i></p>

  <p><b>ACCEPTANCE:</b> This document will become a binding contract when accepted by the Seller and
  signed by both Buyer and Seller. If it is not accepted and signed by the Seller prior to the
  <b>DATE OF:</b> ${slot(longDate(f.acceptance_deadline))} then this contract shall be rendered void.</p>

  <p><b>CLOSING:</b> Closing will take place on or before the <b>DATE OF:</b>
  ${slot(longDate(f.closing_date))} at the following named</p>

  <p><b>TITLE COMPANY:</b> ${slot(f.title_company)}</p>

  <p>Seller authorizes the assigned title company to perform all necessary due diligence and to clear
  any title or insurance issues.</p>

  <p><b>PICTURES &amp; ACCESS:</b> Seller agrees to provide immediate access to the buyer by providing<br>
  ${tick(lockboxSeller)} a key to the property in a lockbox to be placed on the front door of the
  subject property <b>-or-</b><br>
  ${tick(!lockboxSeller)} the seller agrees to provide the key to a representative of the buyer, and
  the buyer will place a lockbox.</p>

  <p>Seller explicitly agrees to allow the buyer unfettered access to the subject property to conduct
  their inspections, meet contractors to retain proposals for work, to send prospective end buyers to
  visit the property, and any other legal and necessary reason to access the property. Seller
  understands that if proper access is not immediately provided to the buyer then the closing date of
  this agreement will be automatically extended per the discretion of the buyer, determined by the
  delay the seller has caused in their due diligence process. Seller agrees to extend at any point
  which they cause an impediment to the closing process.</p>

  <p><b>INSPECTIONS</b>: This contract is contingent upon the Buyer's and Buyers' Partner inspection
  and approval of the property prior to transfer of title. Seller agrees to provide access to the
  Buyer's representatives prior to transfer of title for inspection for repairs.</p>

  <p><b>RE-NEGOTIATION BASED ON CONDITION:</b> In the event the buyer inspects the property and the
  condition of the property is not equivalent to the stated condition provided by the seller, then the
  seller understands major issues that are not fully disclosed to the buyer at the time of the offer
  and execution of this contract may require the seller to renegotiate this contract based on the
  undisclosed conditions that were withheld by the seller. In this event, the seller agrees to
  re-negotiate the purchase price of this contract, within reason, to accommodate for any extra work
  not accounted for in this original purchase price agreement. If the reasonable repairs are excessive
  and the purchase price does not exceed the seller's debt on the property after deductions for
  undisclosed conditions, then the buyer agrees to let the seller out of this contract, and render it
  null and void.</p>

  <p><b>ENCUMBRANCES:</b> In the event the property is in any way encumbered in such a manner as to
  delay the closing date above, or prevent the close of the sell, due to liens, judgements, or other
  legal instruments that encumber the property; the seller expressly agrees to cooperate fully with
  the buyer to clear any encumbrance, which may require providing documentary evidence to the title
  company to clear the issue, and/or payment in full of the amount of lien or judgment preventing the
  closure of the purchase. Seller understands it is their sole responsibility to rectify any
  encumbrances and these debts are owed by the seller and the buyer is in no way obligated to reduce
  the contract price commensurately.</p>

  <p><b>EMD:</b> Earnest money of $<span class="emd">${esc(f.emd_amount || '')}</span> will be
  deposited to title to create a legal and binding contract as required by law.</p>

  <p><b>RISK OF LOSS</b>: If subject property is damaged prior to transfer of title, Buyer has the
  option of accepting title to the property in "as is" condition at an adjusted purchase price or of
  canceling this contract.</p>

  <p><b>PRORATIONS:</b> Real property taxes will be prorated based on the current year's tax without
  allowance for discounts, including homestead or other exemptions. Rents will be current and be
  prorated as of the date title transfers.</p>

  <p><b>DEFECTS:</b> House being sold as-is, where-is. Seller warrants subject property to be free
  from hazardous substances and from violation of any zoning, environmental, building, health or other
  governmental codes or ordinances. Seller further warrants that there is no material or other known
  defects or facts regarding this property, which would adversely affect the value of said property.</p>

  <p><b>ASSIGNABLE CONTRACT:</b> The buyer shall have the right to assign, sell, transfer, market,
  pledge or otherwise convey any and all rights or interests which the buyer may have in the property
  in this Sales and Purchase Agreement.</p>

  <p><b>NO JUDGMENTS:</b> Seller warrants that there are no judgments threatening the equity in
  subject property, and that there is no bankruptcy pending or contemplated by any titleholder. Seller
  will not further encumber the property and an affidavit may be recorded at Buyer's expense putting
  the public on notice that the closing of this contract will extinguish liens and encumbrances
  hereafter recorded.</p>

  <p><b>POSSESSION:</b> Possession of the property and occupancy (tenants excluded), with all keys and
  garage door openers, will be delivered to the Buyer when title transfers. Leases and security
  deposits will transfer to the Buyer with title.</p>

  <p><b>OTHER AGREEMENTS:</b></p>
  <div class="otherbox">${otherLines || '<div>&nbsp;</div>'}</div>

  <p><b>GOVERNING LAW:</b> This contract is made under and shall be governed in accordance with the
  laws of the <b>STATE OF:</b> ${slot(f.governing_state)}</p>

  <p><b>TIME IS OF THE ESSENCE</b>: WITH THIS AGREEMENT EACH CONTINGENCY CONTAINED HEREIN SHALL BE
  SATISFIED ACCORDING TO ITS TERMS BY THE CLOSING DATE OR THIS CONTRACT EXTENDS FIVE BUSINESS DAYS TO
  PROVIDE TIME FOR SATISFACTION OF SAID CONTINGENCIES. EACH PARTY SHALL DILIGENTLY PURSUE THE
  COMPLETION OF THIS TRANSACTION. EACH WARRANTY HEREIN MADE SURVIVES THE CLOSING OF THIS
  TRANSACTION.</p>

  <div class="sigs">
    <div class="sig"><span class="line"></span><small>Seller</small></div>
    <div class="sig date"><span class="line"></span><small>Date</small></div>
    <div class="sig"><span class="line"></span><small>Buyer</small></div>
    <div class="sig date"><span class="line"></span><small>Date</small></div>

    <div class="sig wide"><span class="line"></span><small>Seller Phone</small></div>
    <div class="sig wide"><span class="line"></span><small>Buyer Phone</small></div>

    <div class="sig"><span class="line"></span><small>Seller</small></div>
    <div class="sig date"><span class="line"></span><small>Date</small></div>
    <div class="sig"><span class="line"></span><small>Buyer</small></div>
    <div class="sig date"><span class="line"></span><small>Date</small></div>
  </div>

  <p class="principal"><b>${esc(PRINCIPAL_NOTICE)}</b></p>
</article>`.trim();
}
