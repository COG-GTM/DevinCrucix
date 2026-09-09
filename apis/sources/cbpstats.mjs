// CBP Enforcement Statistics — official CSV downloads published by U.S. Customs and
// Border Protection (public domain, U.S. Government work).
//
//   Encounters by Area of Responsibility (sector / field office) and month:
//     discovery page  https://www.cbp.gov/document/stats/nationwide-encounters
//     file pattern    /sites/default/files/<YYYY-MM>/nationwide-encounters-fy23-fy26-<mon>-aor.csv
//   Drug seizures by AOR, drug type and month:
//     discovery page  https://www.cbp.gov/document/stats/nationwide-drug-seizures
//     file pattern    /sites/default/files/<YYYY-MM>/nationwide-drugs-fy23-fy26-<mon>.csv
//
// The exact file names change every month (the month suffix moves), so each sweep first reads
// the official document page and picks the newest CSV link, falling back to the last verified
// URL if the page is unreachable. Downloads are conditional (ETag / Last-Modified) and cached on
// disk so a CBP outage degrades to "stale" rather than blanking the panel. Everything is fetched
// with the declared crawler User-Agent and checked against robots.txt (the CSV directory is
// allowed for `User-agent: *`; only /sites/default/files/assets/documents/ is disallowed).
//
// cbp.gov's edge WAF returns 403 to curl-style clients but 200 to Node's native fetch with the
// same UA, so this module must run on Node fetch (undici) — do not swap in a curl subprocess.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRobots, CRAWLER_UA } from '../utils/robots.mjs';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/cbp');
export const PIPELINE_VERSION = 'cbpstats/1.0.0';

const ORIGIN = 'https://www.cbp.gov';
const FETCH_TIMEOUT_MS = 20_000;
const SERIES_MONTHS = 13; // latest month plus the same month a year earlier

// Verified 2026-09-06 (HTTP 200 via Node fetch). Used only when the discovery page cannot be read.
export const DATASETS = {
  encounters: {
    id: 'encounters',
    title: 'Encounters by Area of Responsibility',
    discoveryPage: `${ORIGIN}/document/stats/nationwide-encounters`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/nationwide-encounters-fy\d{2}-fy\d{2}-[a-z]{3}-aor[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv`,
    expectedHeader: ['Fiscal Year', 'Month Grouping', 'Month (abbv)', 'Component', 'Land Border Region', 'Area of Responsibility', 'AOR (Abbv)', 'Demographic', 'Citizenship', 'Title of Authority', 'Encounter Type', 'Encounter Count'],
    cacheFile: 'encounters-aor.csv',
  },
  drugs: {
    id: 'drugs',
    title: 'Drug Seizures by Area of Responsibility',
    discoveryPage: `${ORIGIN}/document/stats/nationwide-drug-seizures`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/nationwide-drugs-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/nationwide-drugs-fy23-fy26-jul.csv`,
    expectedHeader: ['FY', 'Month (abbv)', 'Component', 'Region', 'Land Filter', 'Area of Responsibility', 'Drug Type', 'Count of Event', 'Sum Qty (lbs)'],
    cacheFile: 'drugs.csv',
  },
};

// Southwest border AORs as CBP spells them, mapped to the Border Watch gazetteer sector names
// so encounters can be drawn next to the news coverage for the same sector.
export const SW_SECTORS = [
  { aor: 'San Diego Sector', abbv: 'SDC', sector: 'San Diego', lat: 32.72, lon: -117.16 },
  { aor: 'El Centro Sector', abbv: 'ELC', sector: 'El Centro', lat: 32.79, lon: -115.56 },
  { aor: 'Yuma Sector', abbv: 'YUM', sector: 'Yuma', lat: 32.69, lon: -114.63 },
  { aor: 'Tucson Sector', abbv: 'TCA', sector: 'Tucson', lat: 32.22, lon: -110.97 },
  { aor: 'El Paso Sector', abbv: 'EPT', sector: 'El Paso', lat: 31.76, lon: -106.49 },
  { aor: 'Big Bend Sector', abbv: 'BBT', sector: 'Big Bend', lat: 30.36, lon: -103.66 },
  { aor: 'Del Rio Sector', abbv: 'DRT', sector: 'Del Rio', lat: 29.36, lon: -100.9 },
  { aor: 'Laredo Sector', abbv: 'LRT', sector: 'Laredo', lat: 27.51, lon: -99.51 },
  { aor: 'Rio Grande Valley Sector', abbv: 'RGV', sector: 'Rio Grande Valley', lat: 26.2, lon: -98.23 },
];
const SW_FIELD_OFFICES = ['San Diego Field Office', 'Tucson Field Office', 'El Paso Field Office', 'Laredo Field Office'];

const MONTHS = ['OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP'];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// RFC 4180 parser: quoted fields, doubled quotes, embedded commas/newlines, BOM, CRLF.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map(h => h.trim());
  const records = [];
  for (const r of rows.slice(1)) {
    if (r.length !== header.length) continue;
    const o = {};
    header.forEach((h, i) => { o[h] = r[i].trim(); });
    records.push(o);
  }
  return { header, records };
}

export function headerMatches(header, expected) {
  return header.length === expected.length && expected.every((h, i) => header[i] === h);
}

// ---------------------------------------------------------------------------
// Fiscal-year calendar. CBP's FY starts 1 October: "2026 (FYTD)" + "OCT" is calendar 2025-10.
// ---------------------------------------------------------------------------

export function fiscalYear(s) {
  const m = /^(\d{4})/.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

export function periodOf(fyText, monthAbbv) {
  const fy = fiscalYear(fyText);
  const mi = MONTHS.indexOf(String(monthAbbv || '').toUpperCase());
  if (fy === null || mi < 0) return null;
  const calMonth = ((mi + 9) % 12) + 1; // OCT -> 10 … SEP -> 9
  const calYear = mi < 3 ? fy - 1 : fy;
  return `${calYear}-${String(calMonth).padStart(2, '0')}`;
}

function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function pctChange(cur, prev) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function lastN(sortedPeriods, n) { return sortedPeriods.slice(Math.max(0, sortedPeriods.length - n)); }

// ---------------------------------------------------------------------------
// Aggregation — Southwest land border only.
// ---------------------------------------------------------------------------

export function summarizeEncounters(records) {
  const sw = records.filter(r => r['Land Border Region'] === 'Southwest Land Border');
  const periods = new Set();
  const total = new Map(); // period -> { total, usbp, ofo }
  const bySector = new Map(); // aor -> Map(period -> count)
  const latestBuckets = { demographic: new Map(), encounterType: new Map(), citizenship: new Map(), authority: new Map() };

  for (const r of sw) {
    const p = periodOf(r['Fiscal Year'], r['Month (abbv)']);
    if (!p) continue;
    const n = num(r['Encounter Count']);
    periods.add(p);
    const t = total.get(p) || { total: 0, usbp: 0, ofo: 0 };
    t.total += n;
    if (r.Component === 'U.S. Border Patrol') t.usbp += n; else t.ofo += n;
    total.set(p, t);
    const aor = r['Area of Responsibility'];
    if (!bySector.has(aor)) bySector.set(aor, new Map());
    const s = bySector.get(aor);
    s.set(p, (s.get(p) || 0) + n);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2] || null;
  const yoy = sorted.find(p => p === shiftPeriod(latest, -12)) || null;
  const series = lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), ...total.get(p) }));

  for (const r of sw) {
    if (periodOf(r['Fiscal Year'], r['Month (abbv)']) !== latest) continue;
    const n = num(r['Encounter Count']);
    bump(latestBuckets.demographic, r.Demographic, n);
    bump(latestBuckets.encounterType, r['Encounter Type'], n);
    bump(latestBuckets.citizenship, r.Citizenship, n);
    bump(latestBuckets.authority, r['Title of Authority'], n);
  }

  const sectors = SW_SECTORS.map(def => {
    const s = bySector.get(def.aor) || new Map();
    const cur = s.get(latest) || 0;
    return {
      ...def,
      latest: cur,
      previous: prev ? (s.get(prev) || 0) : null,
      momPct: prev ? pctChange(cur, s.get(prev) || 0) : null,
      yoyPct: yoy ? pctChange(cur, s.get(yoy) || 0) : null,
      series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, count: s.get(p) || 0 })),
    };
  }).sort((a, b) => b.latest - a.latest);
  const fieldOffices = SW_FIELD_OFFICES.map(aor => ({ aor, latest: bySector.get(aor)?.get(latest) || 0 })).sort((a, b) => b.latest - a.latest);

  const cur = total.get(latest);
  return {
    region: 'Southwest Land Border',
    rows: sw.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: {
      period: latest, label: periodLabel(latest), ...cur,
      momPct: prev ? pctChange(cur.total, total.get(prev).total) : null,
      yoyPct: yoy ? pctChange(cur.total, total.get(yoy).total) : null,
    },
    series,
    sectors,
    fieldOffices,
    demographic: top(latestBuckets.demographic),
    encounterType: top(latestBuckets.encounterType),
    authority: top(latestBuckets.authority),
    citizenship: top(latestBuckets.citizenship, 10),
  };
}

export function summarizeDrugs(records) {
  const sw = records.filter(r => r.Region === 'Southwest Border');
  const periods = new Set();
  const byType = new Map(); // drug -> Map(period -> { events, lbs })
  const totals = new Map(); // period -> { events, lbs }
  const byAor = new Map(); // aor -> { events, lbs } for latest month (filled after)

  for (const r of sw) {
    const p = periodOf(r.FY, r['Month (abbv)']);
    if (!p) continue;
    periods.add(p);
    const ev = num(r['Count of Event']);
    const lbs = num(r['Sum Qty (lbs)']);
    const t = totals.get(p) || { events: 0, lbs: 0 };
    t.events += ev; t.lbs += lbs; totals.set(p, t);
    const type = r['Drug Type'];
    if (!byType.has(type)) byType.set(type, new Map());
    const m = byType.get(type);
    const c = m.get(p) || { events: 0, lbs: 0 };
    c.events += ev; c.lbs += lbs; m.set(p, c);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2] || null;
  const yoy = sorted.find(p => p === shiftPeriod(latest, -12)) || null;

  for (const r of sw) {
    if (periodOf(r.FY, r['Month (abbv)']) !== latest) continue;
    const aor = titleCase(r['Area of Responsibility']);
    const c = byAor.get(aor) || { aor, events: 0, lbs: 0 };
    c.events += num(r['Count of Event']); c.lbs += num(r['Sum Qty (lbs)']);
    byAor.set(aor, c);
  }

  const round = x => Math.round(x * 10) / 10;
  const drugs = [...byType.entries()].map(([type, m]) => {
    const cur = m.get(latest) || { events: 0, lbs: 0 };
    const pv = prev ? (m.get(prev) || { events: 0, lbs: 0 }) : null;
    const yy = yoy ? (m.get(yoy) || { events: 0, lbs: 0 }) : null;
    return {
      type,
      latest: { events: cur.events, lbs: round(cur.lbs) },
      momLbsPct: pv ? pctChange(cur.lbs, pv.lbs) : null,
      yoyLbsPct: yy ? pctChange(cur.lbs, yy.lbs) : null,
      series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, lbs: round(m.get(p)?.lbs || 0), events: m.get(p)?.events || 0 })),
    };
  }).sort((a, b) => b.latest.lbs - a.latest.lbs);

  const cur = totals.get(latest);
  return {
    region: 'Southwest Border',
    rows: sw.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: { period: latest, label: periodLabel(latest), events: cur.events, lbs: round(cur.lbs), momLbsPct: prev ? pctChange(cur.lbs, totals.get(prev).lbs) : null, yoyLbsPct: yoy ? pctChange(cur.lbs, totals.get(yoy).lbs) : null },
    series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), events: totals.get(p).events, lbs: round(totals.get(p).lbs) })),
    drugs,
    byAor: [...byAor.values()].map(a => ({ ...a, lbs: round(a.lbs) })).sort((a, b) => b.lbs - a.lbs),
  };
}

function bump(map, key, n) { map.set(key, (map.get(key) || 0) + n); }
function top(map, limit = Infinity) {
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}
function titleCase(s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }
export function shiftPeriod(period, months) {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Discovery + conditional download + on-disk cache
// ---------------------------------------------------------------------------

async function timedFetch(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers: { 'User-Agent': CRAWLER_UA, ...headers }, signal: controller.signal, redirect: 'follow' });
  } finally { clearTimeout(timer); }
}

// Newest CSV link on the official document page (by the /files/YYYY-MM/ directory, then by
// position — CBP lists the current release first).
export function discoverCsvUrl(html, dataset) {
  const found = [];
  for (const m of String(html || '').matchAll(dataset.linkPattern)) found.push({ path: m[0], dir: m[1], pos: m.index });
  if (!found.length) return null;
  found.sort((a, b) => b.dir.localeCompare(a.dir) || a.pos - b.pos);
  return ORIGIN + found[0].path;
}

async function discover(dataset, fetchImpl) {
  const robots = await checkRobots(dataset.discoveryPage, { fetch: fetchImpl });
  if (!robots.allowed) return { url: null, reason: 'discovery page robots-disallowed' };
  try {
    const res = await timedFetch(fetchImpl, dataset.discoveryPage, { Accept: 'text/html' }, FETCH_TIMEOUT_MS);
    if (!res.ok) return { url: null, reason: `discovery page HTTP ${res.status}` };
    const url = discoverCsvUrl(await res.text(), dataset);
    return url ? { url, reason: null } : { url: null, reason: 'no CSV link on discovery page' };
  } catch (e) {
    return { url: null, reason: /abort/i.test(e?.name || e?.message) ? 'discovery page timed out' : 'discovery page unreachable' };
  }
}

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }

async function loadDataset(dataset, { fetchImpl, dataDir, state, now }) {
  const cachePath = join(dataDir, dataset.cacheFile);
  const prev = state[dataset.id] || {};
  const notes = [];
  const discovered = await discover(dataset, fetchImpl);
  const url = discovered.url || prev.url || dataset.fallbackUrl;
  if (!discovered.url) notes.push(`${discovered.reason}; using ${prev.url ? 'last known' : 'fallback'} URL`);

  const robots = await checkRobots(url, { fetch: fetchImpl });
  const meta = { id: dataset.id, title: dataset.title, url, discoveryPage: dataset.discoveryPage, discovered: Boolean(discovered.url), header: prev.header || null, etag: prev.etag || null, lastModified: prev.lastModified || null, fetchedAt: prev.fetchedAt || null, bytes: prev.bytes || null, status: 'error', httpStatus: null, reason: null, notes };
  let text = null;

  if (!robots.allowed) {
    meta.reason = 'robots-disallowed';
  } else {
    const headers = { Accept: 'text/csv,*/*;q=0.5' };
    if (url === prev.url && prev.etag) headers['If-None-Match'] = prev.etag;
    if (url === prev.url && prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
    try {
      const res = await timedFetch(fetchImpl, url, headers, FETCH_TIMEOUT_MS);
      meta.httpStatus = res.status;
      if (res.status === 304 && existsSync(cachePath)) {
        meta.status = 'not_modified';
      } else if (res.ok) {
        const body = await res.text();
        const { header } = csvRecords(body);
        if (!headerMatches(header, dataset.expectedHeader)) {
          meta.reason = `unexpected header: ${header.join(',').slice(0, 160)}`;
          notes.push('CBP changed the CSV layout; parser not applied');
        } else {
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(cachePath, body);
          text = body;
          Object.assign(meta, { status: 'ok', header, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetchedAt: new Date(now).toISOString(), bytes: body.length });
        }
      } else {
        meta.reason = `HTTP ${res.status}`;
      }
    } catch (e) {
      meta.reason = /abort/i.test(e?.name || e?.message) ? 'timed out' : 'unreachable';
    }
  }

  if (!text && existsSync(cachePath)) {
    text = readFileSync(cachePath, 'utf8');
    if (meta.status !== 'not_modified') { meta.status = 'stale'; notes.push(`serving cached copy from ${meta.fetchedAt || 'earlier sweep'}`); }
  }
  const parsed = text ? csvRecords(text) : { header: [], records: [] };
  if (text && !meta.header) meta.header = parsed.header;
  return { meta, records: parsed.records };
}

// ---------------------------------------------------------------------------
// Briefing entry point
// ---------------------------------------------------------------------------

export async function briefing(opts = {}) {
  const fetchImpl = opts.fetch || safeOutboundFetch;
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const now = opts.now || Date.now();
  const persist = opts.persist !== false;
  const statePath = join(dataDir, 'state.json');
  const state = readJson(statePath, {});

  const enc = await loadDataset(DATASETS.encounters, { fetchImpl, dataDir, state, now });
  const drg = await loadDataset(DATASETS.drugs, { fetchImpl, dataDir, state, now });

  for (const d of [enc, drg]) {
    if (d.meta.status === 'ok' || d.meta.status === 'not_modified') {
      state[d.meta.id] = { url: d.meta.url, etag: d.meta.etag, lastModified: d.meta.lastModified, fetchedAt: d.meta.fetchedAt, header: d.meta.header, bytes: d.meta.bytes };
    }
  }
  if (persist) { try { mkdirSync(dataDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch { /* read-only FS: cache is best-effort */ } }

  const encounters = enc.records.length ? summarizeEncounters(enc.records) : null;
  const drugs = drg.records.length ? summarizeDrugs(drg.records) : null;
  const datasets = [enc.meta, drg.meta].map(m => ({ ...m, rows: m.id === 'encounters' ? enc.records.length : drg.records.length }));

  const fresh = datasets.filter(d => d.status === 'ok' || d.status === 'not_modified').length;
  const served = datasets.filter(d => ['ok', 'not_modified', 'stale'].includes(d.status)).length;
  let status;
  if (served === 0) status = 'error';
  else if (fresh === datasets.length) status = 'live';
  else if (fresh > 0) status = 'partial';
  else status = 'stale';

  const out = {
    source: 'CBPStats',
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: 'U.S. Customs and Border Protection, CBP Enforcement Statistics (public domain). Monthly figures are subject to revision by CBP.',
    datasets,
    encounters,
    drugs,
  };
  if (status === 'error') out.error = datasets.map(d => `${d.id}: ${d.reason || d.status}`).join('; ');
  return out;
}

// CLI: node apis/sources/cbpstats.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  briefing().then(r => console.log(JSON.stringify(r, null, 2)));
}
