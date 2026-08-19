import './property-links.css';

/**
 * One address, opened in the handful of places a wholesaler checks before
 * deciding what a house is worth.
 *
 * The sequence is the same on every deal — look at the street, look at the map,
 * look at the two portals with comps on them, look at what the county says the
 * place is and who owns it — and doing it by hand is five tab-opens and five
 * retypings of the address. The retyping is where the wrong house comes from:
 * one transposed digit on a street number and the operator is underwriting the
 * neighbour's roof.
 *
 * Every link opens in its own tab, deliberately. These get read against each
 * other — a portal's estimate against the assessed value against what the roof
 * actually looks like — so reusing one tab, or navigating the operator off the
 * record they are working, defeats the point of having them.
 *
 * WHAT IS NOT HERE, AND WHY THIS IS SHORTER THAN IT COULD BE.
 *
 * Every URL below is a public SEARCH form. Not one of them is a constructed
 * link to a listing page, because a listing URL on any of these sites needs
 * that site's own property id and there is no way to derive one from an
 * address. A guessed id is a 404, and a 404 in the middle of underwriting is
 * worse than a link that was never offered — it costs the operator the click
 * plus the time spent working out whether the house is missing or the app is.
 * So where a site has no search URL that can be built from an address, the link
 * goes through a site-scoped web search instead and says so on its face rather
 * than pretending to be direct.
 *
 * The seller's NAME and PHONE never go into any of these URLs, only the
 * property address. A parcel address is a public record and searching one is
 * ordinary diligence; handing a third-party search engine "Doris Whitfield,
 * (912) 555-0134" alongside it is building a profile of a homeowner who has not
 * agreed to anything, in a query string, on somebody else's server.
 *
 * Takes a row rather than four props so a prospect works unchanged — prospects
 * carry the same address/city/state/zip/county column names as leads, and this
 * component has no business knowing which of the two it is looking at.
 */
export default function PropertyLinks({ place, label = 'Look it up' }) {
  const street = clean(place?.address);

  // Without a street address none of these resolve to a property: a portal
  // search for "Savannah, GA" is a list of the whole city, and a map pin on a
  // city centroid is worse than nothing because it looks like an answer.
  // The modifier is `noaddr` and not `empty`: styles.css owns a global `.empty`
  // (46px of padding, centred text, for a whole page with nothing on it) and
  // this element would have picked it up — property-links.css loads after
  // styles.css and neither selector out-specifies the other, so a two-line note
  // would have rendered as if it were an empty screen.
  if (!street) {
    return (
      <div className="proplinks noaddr">
        <span className="cap">{label}</span>
        <p className="why">
          No street address on this record yet, so there is nothing to look up. Add one and these
          open.
        </p>
      </div>
    );
  }

  const links = buildLinks(place);

  return (
    <div className="proplinks">
      <span className="cap">{label}</span>
      <div className="row">
        {links.map((l) => (
          <a
            key={l.key}
            className="proplink"
            href={l.href}
            target="_blank"
            /* noreferrer as well as noopener: without it the destination gets
               the app's URL, which carries the lead's uuid in its path. */
            rel="noopener noreferrer"
          >
            {l.label}
            {l.via && <span className="via">via search</span>}
          </a>
        ))}
      </div>
      <p className="why">
        Each opens in its own tab. Anything marked <em>via search</em> has no address-search URL that
        can be built reliably, so it goes through a web search rather than a guessed link that would
        404 — one more click, and it lands somewhere real.
      </p>
    </div>
  );
}

/** Trimmed, or null. Blank-but-present columns are the common case from imports. */
function clean(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

/**
 * The address as a person would write it on an envelope.
 *
 * Deliberately not fullAddress() from lib/format.js. That one joins with ' · '
 * because it is a page header, and a middle dot inside a search query is a
 * character the far end has to decide what to do with — sometimes ignored,
 * sometimes not. This is the only place in the app where the address is being
 * handed to somebody else's parser, so it gets the punctuation that parser
 * expects rather than the punctuation that looks right on screen.
 *
 * State and ZIP are joined with a space and not a comma, which is the postal
 * form ("Savannah, GA 31401") and the form every address parser on the far end
 * was trained on. "GA, 31401" is the shape a two-field UI produces, not the
 * shape an address is written in, and a geocoder that reads the comma as a
 * component boundary sees a fourth component it has no slot for.
 */
function oneLine(place) {
  const city = clean(place?.city);
  const region = [clean(place?.state), clean(place?.zip)].filter(Boolean).join(' ');
  return [clean(place?.address), city, region].filter(Boolean).join(', ');
}

/** A web search, which is the only URL here that can never be wrong about a property. */
const websearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

function buildLinks(place) {
  const q = oneLine(place);
  const enc = encodeURIComponent(q);

  const links = [
    {
      key: 'streetview',
      label: 'Street View',
      /**
       * `layer=c` is the long-standing street-view layer on the classic maps
       * URL. Google's documented Maps URLs API has a proper pano action, but it
       * requires a lat/lng viewpoint or a pano id and we have neither — nothing
       * in this app geocodes, and adding a geocoder to open a link would be a
       * paid API call per lead view.
       *
       * The reason this is acceptable where a guessed listing URL is not: its
       * failure mode is the ordinary map for the same address. If the layer
       * parameter is ignored, or there is no imagery on that street, the
       * operator lands on the property on a map instead of standing in front of
       * it. That is a worse answer, not a dead page.
       */
      href: `https://www.google.com/maps?q=${enc}&layer=c`,
    },
    {
      key: 'maps',
      label: 'Google Maps',
      // The documented Maps URLs API search action. The one URL on this list
      // that is a published, versioned contract rather than an observed shape.
      href: `https://www.google.com/maps/search/?api=1&query=${enc}`,
    },
    {
      key: 'zillow',
      label: 'Zillow',
      // Zillow's search path is a slug rather than a query string. Building it
      // is safe because it IS the search — an address it cannot resolve gives
      // search results, not an error, so a partial or slightly wrong address
      // degrades into "here is what we found nearby".
      href: `https://www.zillow.com/homes/${zillowSlug(q)}_rb/`,
    },
    {
      key: 'redfin',
      label: 'Redfin',
      // Redfin's public URLs are id-based — /city/<id>/<ST>/<City>, and a
      // property page needs its internal listing id. Its address box is fed by
      // an autocomplete endpoint, not by a URL anyone can construct, so there is
      // no honest direct link to build here.
      via: true,
      href: websearch(`site:redfin.com ${q}`),
    },
    {
      key: 'realtor',
      label: 'Realtor.com',
      // Same problem, one step worse: realtor.com's detail slug bakes in its own
      // normalisation of the street name and the zip, and getting it wrong by a
      // hyphen is a 404 rather than a search page.
      via: true,
      href: websearch(`site:realtor.com ${q}`),
    },
  ];

  const assessor = assessorLink(place);
  if (assessor) links.push(assessor);

  return links;
}

/**
 * Zillow's slug: punctuation dropped, spaces to hyphens.
 *
 * encodeURIComponent runs last and is not decoration. Savannah has streets like
 * "Habersham & Bay" and units written "#2B"; those characters would otherwise
 * terminate the path or start a fragment, and the link would open Zillow's home
 * page while looking like it had worked.
 */
function zillowSlug(oneLineAddress) {
  const slug = oneLineAddress
    .replace(/[.,#]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return encodeURIComponent(slug);
}

/**
 * "Chatham County" -> "Chatham"; "Chatham" unchanged.
 *
 * Only a trailing word, and only that one word: Louisiana has parishes and
 * Alaska has boroughs, neither of which this touches, and a county genuinely
 * named for something ending in "county" does not exist in the NANP states
 * Tossie buys in. Kept local rather than added to lib/format.js because the
 * fix belongs to the query, not to how a county is displayed — DealDetail
 * appending " County" to a header is correct and must keep doing it.
 */
function dropCountySuffix(name) {
  return name.replace(/\s+county\s*$/i, '');
}

/**
 * The county's own record — assessed value, owner of record, last sale — which
 * is the only source on this list that is not somebody's estimate.
 *
 * It is a search and not a portal link, and that is the honest shape of it.
 * There is no national or even state-wide scheme to derive an assessor URL
 * from: every county runs its own site, several states are split between
 * vendors, and the vendor-hosted ones key off a per-county application id that
 * appears nowhere in an address. Hard-coding one URL per state would ship the
 * wrong county's portal for most addresses in that state and a dead link for
 * the rest, which is exactly the failure this component is written to avoid.
 *
 * The address is deliberately left OUT of the query. County parcel records are
 * mostly behind a form and not indexed per-parcel, so including the address
 * finds the portal less reliably than asking for the portal by name and letting
 * the operator type the address into the county's own search box.
 *
 * Omitted entirely when there is no county or city to name, rather than sending
 * the operator to a search for "GA tax assessor".
 */
function assessorLink(place) {
  const county = clean(place?.county);
  const state = clean(place?.state);
  const where = county || clean(place?.city);
  if (!where || !state) return null;

  // "County" is appended only to a county name; a city gets its own name and
  // lets the search engine work out which county it sits in, which it does
  // reliably and we cannot.
  //
  // Stripped first, because half the list vendors ship the column as "Chatham"
  // and half as "Chatham County" — nothing normalises it on the way in, and the
  // Deals and Prospects screens append the word the same way. Appending blind
  // searches for "Chatham County County GA", which is not a query that finds a
  // county's assessor.
  const subject = county ? `${dropCountySuffix(county)} County ${state}` : `${where} ${state}`;

  return {
    key: 'assessor',
    label: 'County assessor',
    via: true,
    href: websearch(`${subject} tax assessor property records search`),
  };
}
