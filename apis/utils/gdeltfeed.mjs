// GDELT 2.0 raw export feed client.
// data.gdeltproject.org publishes a new events (.export.CSV.zip) and GKG
// (.gkg.csv.zip) file every 15 minutes as static zip files. Unlike the
// DOC/GEO search APIs (1 request / 5 s, shared-IP hosts get 429'd), the
// static files have no query rate limit. Files are cached in memory by
// their 15-minute timestamp so each sweep only downloads what is new.

import { inflateRawSync, constants as Z } from 'node:zlib';

const FEED_BASE = 'https://data.gdeltproject.org/gdeltv2';
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';
const STEP_MS = 15 * 60 * 1000;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;

// Event export column indexes (GDELT 2.0 Event Database codebook)
export const EV = {
  ID: 0, DAY: 1, ACTOR1_NAME: 6, ACTOR1_COUNTRY: 7, ACTOR2_NAME: 16, ACTOR2_COUNTRY: 17,
  EVENT_CODE: 26, EVENT_ROOT: 28, QUAD_CLASS: 29, GOLDSTEIN: 30, NUM_MENTIONS: 31,
  AVG_TONE: 34, GEO_TYPE: 51, GEO_NAME: 52, GEO_COUNTRY: 53, GEO_LAT: 56, GEO_LON: 57,
  DATE_ADDED: 59, SOURCE_URL: 60,
};

// GKG column indexes (GDELT 2.0 GKG codebook)
export const GKG = {
  ID: 0, DATE: 1, SOURCE_NAME: 3, DOC_ID: 4, THEMES: 7, V2_THEMES: 8, V2_LOCATIONS: 10,
  TONE: 15, EXTRAS: 26,
};

export const CAMEO_ROOT = {
  '01': 'Public statement', '02': 'Appeal', '03': 'Intent to cooperate', '04': 'Consultation',
  '05': 'Diplomatic cooperation', '06': 'Material cooperation', '07': 'Aid provided', '08': 'Yield',
  '09': 'Investigation', '10': 'Demand', '11': 'Disapproval', '12': 'Rejection', '13': 'Threat',
  '14': 'Protest', '15': 'Force posture', '16': 'Reduced relations', '17': 'Coercion',
  '18': 'Assault', '19': 'Fighting', '20': 'Mass violence',
};

// ─── zip handling ────────────────────────────────────────────────────────
// GDELT zips contain a single deflated file; read the local header and inflate.
export function unzipSingle(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a zip archive');
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const end = compSize > 0 ? start + compSize : buf.length;
  const payload = buf.subarray(start, Math.min(end, buf.length));
  if (method === 0) return payload.toString('utf8');
  if (method !== 8) throw new Error(`Unsupported zip method ${method}`);
  return inflateRawSync(payload, { finishFlush: Z.Z_SYNC_FLUSH }).toString('utf8');
}

// ─── file naming ─────────────────────────────────────────────────────────
export function stampFromDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

export function dateFromStamp(stamp) {
  const s = String(stamp);
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14) || 0));
}

// Timestamps of the last `count` 15-minute files ending at `latestStamp` (newest first)
export function recentStamps(latestStamp, count) {
  const latest = dateFromStamp(latestStamp).getTime();
  const out = [];
  for (let i = 0; i < count; i++) out.push(stampFromDate(new Date(latest - i * STEP_MS)));
  return out;
}

// ─── network ─────────────────────────────────────────────────────────────
async function fetchBuffer(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ZIP_BYTES) throw new Error(`Payload too large (${len} bytes)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) throw new Error(`Payload too large (${buf.length} bytes)`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// lastupdate.txt: "<size> <md5> http://.../YYYYMMDDHHMMSS.export.CSV.zip" (+ mentions, gkg lines)
export async function latestStamp({ timeout = 15000 } = {}) {
  const buf = await fetchBuffer(`${FEED_BASE}/lastupdate.txt`, timeout);
  const m = buf.toString('utf8').match(/\/(\d{14})\.export\.CSV\.zip/);
  if (!m) throw new Error('lastupdate.txt: no export file listed');
  return m[1];
}

const cache = { export: new Map(), gkg: new Map() };
const inflight = new Map();

function prune(map, keep) {
  const keepSet = new Set(keep);
  for (const k of map.keys()) if (!keepSet.has(k)) map.delete(k);
}

async function fetchFile(kind, stamp, timeout) {
  const url = kind === 'gkg'
    ? `${FEED_BASE}/${stamp}.gkg.csv.zip`
    : `${FEED_BASE}/${stamp}.export.CSV.zip`;
  const buf = await fetchBuffer(url, timeout);
  return unzipSingle(buf);
}

// Download (or reuse) the last `count` files of `kind`, returning
// { rows: string[][], stamps: string[], fetched, cached, failed: [{stamp,error}] }
export async function loadRecent(kind, { latest, count = 4, timeout = 20000, concurrency = 4 } = {}) {
  const store = cache[kind];
  if (!store) throw new Error(`Unknown feed kind ${kind}`);
  const stamps = recentStamps(latest, count);
  prune(store, stamps);

  const missing = stamps.filter(s => !store.has(s));
  const failed = [];
  let fetched = 0;
  const queue = [...missing];
  const worker = async () => {
    while (queue.length) {
      const stamp = queue.shift();
      const key = `${kind}:${stamp}`;
      try {
        let p = inflight.get(key);
        if (!p) {
          p = fetchFile(kind, stamp, timeout).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        const text = await p;
        store.set(stamp, parseTsv(text));
        fetched++;
      } catch (e) {
        failed.push({ stamp, error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));

  const rows = [];
  for (const s of stamps) {
    const r = store.get(s);
    if (r) for (const row of r) rows.push(row);
  }
  return { rows, stamps, fetched, cached: missing.length ? stamps.length - missing.length : stamps.length, failed };
}

export function parseTsv(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    rows.push(line.split('\t'));
  }
  return rows;
}

// ─── row shaping ─────────────────────────────────────────────────────────
export function compactEvent(r) {
  const lat = parseFloat(r[EV.GEO_LAT]);
  const lon = parseFloat(r[EV.GEO_LON]);
  return {
    id: r[EV.ID],
    stamp: r[EV.DATE_ADDED],
    actor1: r[EV.ACTOR1_NAME] || '',
    actor2: r[EV.ACTOR2_NAME] || '',
    code: r[EV.EVENT_CODE] || '',
    root: r[EV.EVENT_ROOT] || '',
    quad: Number(r[EV.QUAD_CLASS]) || 0,
    goldstein: parseFloat(r[EV.GOLDSTEIN]) || 0,
    mentions: Number(r[EV.NUM_MENTIONS]) || 0,
    tone: parseFloat(r[EV.AVG_TONE]) || 0,
    place: r[EV.GEO_NAME] || '',
    country: r[EV.GEO_COUNTRY] || '',
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    url: r[EV.SOURCE_URL] || '',
  };
}

const TITLE_RE = /<PAGE_TITLE>([^<]*)<\/PAGE_TITLE>/;

export function compactGkg(r) {
  const title = (r[GKG.EXTRAS] || '').match(TITLE_RE)?.[1]?.trim() || '';
  if (!title) return null;
  const themes = (r[GKG.V2_THEMES] || '').split(';').map(t => t.split(',')[0]).filter(Boolean);
  const tone = parseFloat((r[GKG.TONE] || '').split(',')[0]);
  const firstLoc = (r[GKG.V2_LOCATIONS] || '').split(';')[0]?.split('#') || [];
  return {
    title: decodeEntities(title).slice(0, 200),
    url: r[GKG.DOC_ID] || '',
    domain: r[GKG.SOURCE_NAME] || '',
    date: stampToIso(r[GKG.DATE] || ''),
    tone: Number.isFinite(tone) ? tone : 0,
    themes: Array.from(new Set(themes)).slice(0, 25),
    country: firstLoc[2] || '',
    place: firstLoc[1] || '',
  };
}

export function stampToIso(stamp) {
  if (!/^\d{14}$/.test(stamp)) return '';
  const d = dateFromStamp(stamp);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

export function eventHeadline(ev) {
  const what = CAMEO_ROOT[ev.root] || 'Event';
  const who = [ev.actor1, ev.actor2].filter(Boolean).join(' → ');
  const where = ev.place ? ` @ ${ev.place}` : '';
  return `${what}${who ? `: ${who}` : ''}${where}`;
}

export function resetCacheForTests() {
  cache.export.clear();
  cache.gkg.clear();
  inflight.clear();
}
