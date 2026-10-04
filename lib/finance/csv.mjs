// Streaming RFC 4180 CSV reader for the ICIJ Offshore Leaks bulk files (hundreds of MB; fields may be
// quoted, contain commas, doubled quotes and embedded newlines). Yields one array of strings per row and
// never holds more than one chunk in memory.
import { createReadStream } from 'fs';

export async function* csvRows(file, { highWaterMark = 1 << 20 } = {}) {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark });
  let row = [], field = '', quoted = false, afterQuote = false, sawCR = false, first = true;
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (first) { first = false; if (c === '\uFEFF') continue; }
      if (quoted) {
        if (c === '"') { quoted = false; afterQuote = true; }
        else field += c;
        continue;
      }
      if (afterQuote && c === '"') { field += '"'; quoted = true; afterQuote = false; continue; }
      afterQuote = false;
      if (c === '"') { quoted = true; continue; }
      if (c === ',') { row.push(field); field = ''; sawCR = false; continue; }
      if (c === '\r') { sawCR = true; continue; }
      if (c === '\n') { row.push(field); field = ''; sawCR = false; yield row; row = []; continue; }
      if (sawCR) { row.push(field); field = ''; sawCR = false; yield row; row = []; }
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); yield row; }
}

/** Yields plain objects keyed by the header row. */
export async function* csvObjects(file, opts) {
  let header = null;
  for await (const row of csvRows(file, opts)) {
    if (!header) { header = row.map(h => h.trim()); continue; }
    if (row.length === 1 && row[0] === '') continue;
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = row[i] ?? '';
    yield o;
  }
}
