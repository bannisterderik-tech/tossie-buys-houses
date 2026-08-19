/**
 * A small, correct CSV reader.
 *
 * Written rather than installed because the alternative is a dependency in the
 * browser bundle for four hundred lines of state machine, and because the naive
 * version — `line.split(',')` — corrupts exactly the column that matters most.
 * A cold list is mostly addresses, and an address is the field most likely to
 * arrive quoted with a comma in it:
 *
 *     "1234 Peachtree St NE, Apt 12B",Atlanta,GA,30309
 *
 * Split on commas and that row becomes five fields, the address is truncated at
 * "1234 Peachtree St NE", and the mapping silently shifts one column left for
 * the rest of the row. Nothing errors. The operator gets a list of leads whose
 * city column contains "Apt 12B" and whose phone column contains a ZIP.
 *
 * What this handles, all of it seen in real vendor exports:
 *   - quoted fields containing the delimiter
 *   - quoted fields containing newlines (a notes column with a paragraph in it)
 *   - doubled quotes as the escape ("" -> ")
 *   - CRLF, LF and bare CR line endings, mixed in one file
 *   - a UTF-8 BOM, which Excel writes and which otherwise becomes part of the
 *     first header name — so the first column never matches its alias
 *   - leading whitespace before an opening quote (` "a, b"`), which is not RFC
 *     4180 but is what several exporters emit
 *   - ragged rows: short ones are padded, long ones keep their extras
 *   - semicolon, tab and pipe delimited files, which is what a European export
 *     or a copy-paste out of a spreadsheet actually is
 */

const DELIMITERS = [',', ';', '\t', '|'];

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Guess the delimiter from the header line.
 *
 * Counted outside quotes only: a comma-delimited file whose first header is
 * `"Address, Full"` would otherwise still be read as comma-delimited by luck
 * rather than by measurement, and a semicolon file with one quoted comma would
 * be read as comma-delimited and produce one enormous column.
 */
export function detectDelimiter(text) {
  const src = stripBom(text);
  const counts = Object.fromEntries(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      if (inQuotes && src[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (c === '\n' || c === '\r')) break;
    if (!inQuotes && c in counts) counts[c]++;
  }

  // Comma wins ties, because a file with no delimiter at all in its header is
  // a single-column file and comma is the honest thing to call it.
  let best = ',';
  for (const d of DELIMITERS) if (counts[d] > counts[best]) best = d;
  return counts[best] > 0 ? best : ',';
}

/**
 * Parse into `{ delimiter, headers, rows }`, rows aligned to the header count.
 *
 * Rows where every cell is empty are dropped. Exports routinely end with one,
 * and a blank row would otherwise be counted, previewed and skipped as a lead
 * with no contact details — noise in exactly the number the operator is trying
 * to read.
 */
export function parseCsv(text, delimiter) {
  const src = stripBom(text);
  const d = delimiter || detectDelimiter(src);

  const raw = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // this row has content, even if the last cell is empty

  const endField = () => { row.push(field); field = ''; started = true; };
  const endRow = () => { endField(); raw.push(row); row = []; started = false; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        // "" is an escaped quote; a lone " closes the field.
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }

    // A quote opens a quoted field only at the start of one. `abc"def` is a
    // literal quote in the middle of a value, which is what Excel writes when a
    // seller typed 6" of water in the basement.
    if (c === '"' && field.trim() === '') { field = ''; inQuotes = true; continue; }

    if (c === d) { endField(); continue; }

    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
      continue;
    }

    field += c;
    started = true;
  }

  // Whatever is left when the file ends without a trailing newline.
  if (field !== '' || started || row.length > 0) endRow();

  const kept = raw.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (kept.length === 0) return { delimiter: d, headers: [], rows: [] };

  const headers = kept[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = kept.slice(1).map((r) => {
    // Pad short rows so every row is indexable by header position, and keep
    // long ones intact — an extra column is a vendor adding a field, and the
    // value is still worth carrying into raw_payload.
    const out = r.slice(0, Math.max(r.length, headers.length));
    while (out.length < headers.length) out.push('');
    return out;
  });

  return { delimiter: d, headers, rows };
}

/** 'Property Address' / 'property_address' / 'propertyAddress' -> one key. */
export const normalizeHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
