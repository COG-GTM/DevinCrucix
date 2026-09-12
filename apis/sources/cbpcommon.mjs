// Shared machinery for the CBP Public Data Portal adapters (cbpstats, cbpseizures, cbpforce,
// cbpcustody). Every CBP source follows the same pipeline:
//
//   discovery page → newest file link → robots.txt check → conditional download (ETag /
//   Last-Modified) → on-disk cache → exact layout validation → normalized fiscal-month series
//
// so a CBP outage degrades to "stale" (cached copy still summarized) instead of blanking a panel,
// and a changed CSV layout is refused rather than guessed at. Everything is fetched with the
// declared crawler User-Agent through Node's native fetch: cbp.gov's edge WAF returns 403 to
// curl-style clients but 200 to Node fetch with the same UA — do not swap in a curl subprocess.
//
// Terms of use (https://www.cbp.gov/newsroom/stats/cbp-public-data-portal/terms-and-conditions):
// data are U.S. Government works in the public domain; figures are extracted from live systems and
// may be revised until a full fiscal-year file is published; products must carry the CBP
// non-endorsement notice below and cite the access date.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRobots, CRAWLER_UA } from '../utils/robots.mjs';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/cbp');

export const ORIGIN = 'https://www.cbp.gov';
export const PORTAL_URL = `${ORIGIN}/newsroom/stats/cbp-public-data-portal`;
export const TERMS_URL = `${PORTAL_URL}/terms-and-conditions`;
export const FETCH_TIMEOUT_MS = 20_000;
export const SERIES_MONTHS = 13; // latest month plus the same month a year earlier

// Exact wording required by the portal terms and conditions.
export const CBP_NOTICE = 'This product uses U.S. Customs and Border Protection data, but is not endorsed by CBP.';
export const ATTRIBUTION = `U.S. Customs and Border Protection, CBP Public Data Portal (public domain). ${CBP_NOTICE} Monthly figures are subject to revision by CBP.`;

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
export const SW_FIELD_OFFICES = ['San Diego Field Office', 'Tucson Field Office', 'El Paso Field Office', 'Laredo Field Office'];

export const MONTHS = ['OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP'];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

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
// Fiscal calendar + small numeric helpers
// ---------------------------------------------------------------------------

// "2026 (FYTD)" / "2023" -> fiscal year number
export function fiscalYear(s) {
  const m = /^(\d{4})/.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

// Fiscal year + CBP month abbreviation -> calendar "YYYY-MM" (FY starts in October).
export function periodOf(fyText, monthAbbv) {
  const fy = fiscalYear(fyText);
  const mi = MONTHS.indexOf(String(monthAbbv || '').toUpperCase());
  if (fy === null || mi < 0) return null;
  const calMonth = ((mi + 9) % 12) + 1;
  const calYear = mi < 3 ? fy - 1 : fy;
  return `${calYear}-${String(calMonth).padStart(2, '0')}`;
}

export function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function shiftPeriod(period, months) {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function num(v) {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function pctChange(cur, prev) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export const round1 = x => Math.round(x * 10) / 10;
export function lastN(sortedPeriods, n) { return sortedPeriods.slice(Math.max(0, sortedPeriods.length - n)); }
export function bump(map, key, n) { map.set(key, (map.get(key) || 0) + n); }
export function top(map, limit = Infinity) {
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}
export function titleCase(s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }

// Sorted period list -> { latest, prev, yoy } anchors used by every monthly summary.
export function anchors(sortedPeriods) {
  const latest = sortedPeriods[sortedPeriods.length - 1];
  return {
    latest,
    prev: sortedPeriods[sortedPeriods.length - 2] || null,
    yoy: sortedPeriods.find(p => p === shiftPeriod(latest, -12)) || null,
  };
}

// ---------------------------------------------------------------------------
// Discovery + conditional download + on-disk cache
// ---------------------------------------------------------------------------

export async function timedFetch(fetchImpl, url, headers, timeoutMs = FETCH_TIMEOUT_MS) {
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
    const res = await timedFetch(fetchImpl, dataset.discoveryPage, { Accept: 'text/html' });
    if (!res.ok) return { url: null, reason: `discovery page HTTP ${res.status}` };
    const url = discoverCsvUrl(await res.text(), dataset);
    return url ? { url, reason: null } : { url: null, reason: 'no CSV link on discovery page' };
  } catch (e) {
    return { url: null, reason: /abort/i.test(e?.name || e?.message) ? 'discovery page timed out' : 'discovery page unreachable' };
  }
}

export function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }

// Load one dataset. Two kinds:
//   CSV  (default)  discoveryPage + linkPattern + fallbackUrl + expectedHeader → { meta, records }
//   HTML (kind:'html')  fixed pageUrl, validated by dataset.validate(text) → { meta, text }
// meta.status: ok | not_modified | stale | error
export async function loadDataset(dataset, { fetchImpl, dataDir, state, now }) {
  const cachePath = join(dataDir, dataset.cacheFile);
  const prev = state[dataset.id] || {};
  const notes = [];
  const isHtml = dataset.kind === 'html';
  let url = dataset.pageUrl;
  let discoveredOk = false;
  if (!isHtml) {
    const discovered = await discover(dataset, fetchImpl);
    url = discovered.url || prev.url || dataset.fallbackUrl;
    discoveredOk = Boolean(discovered.url);
    if (!discovered.url) notes.push(`${discovered.reason}; using ${prev.url ? 'last known' : 'fallback'} URL`);
  }

  const robots = await checkRobots(url, { fetch: fetchImpl });
  const meta = {
    id: dataset.id, title: dataset.title, kind: isHtml ? 'html' : 'csv', url, discoveryPage: dataset.discoveryPage || dataset.pageUrl, discovered: discoveredOk,
    header: prev.header || null, etag: prev.etag || null, lastModified: prev.lastModified || null, fetchedAt: prev.fetchedAt || null, bytes: prev.bytes || null,
    status: 'error', httpStatus: null, reason: null, notes,
  };
  let text = null;

  if (!robots.allowed) {
    meta.reason = 'robots-disallowed';
  } else {
    const headers = { Accept: isHtml ? 'text/html' : 'text/csv,*/*;q=0.5' };
    if (url === prev.url && prev.etag) headers['If-None-Match'] = prev.etag;
    if (url === prev.url && prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
    try {
      const res = await timedFetch(fetchImpl, url, headers);
      meta.httpStatus = res.status;
      if (res.status === 304 && existsSync(cachePath)) {
        meta.status = 'not_modified';
      } else if (res.ok) {
        const body = await res.text();
        let header = null;
        let problem = null;
        if (isHtml) {
          problem = dataset.validate ? dataset.validate(body) : null;
        } else {
          header = csvRecords(body).header;
          if (!headerMatches(header, dataset.expectedHeader)) problem = `unexpected header: ${header.join(',').slice(0, 160)}`;
        }
        if (problem) {
          meta.reason = problem;
          notes.push(isHtml ? 'CBP changed the page layout; parser not applied' : 'CBP changed the CSV layout; parser not applied');
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
  if (isHtml) return { meta, text, records: [] };
  const parsed = text ? csvRecords(text) : { header: [], records: [] };
  if (text && !meta.header) meta.header = parsed.header;
  return { meta, text, records: parsed.records };
}

// Load every dataset of one source, persist the conditional-download state, and roll the
// per-dataset statuses up into the source status (live | partial | stale | error).
export async function loadDatasets(datasets, opts = {}) {
  const fetchImpl = opts.fetch || safeOutboundFetch;
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const now = opts.now || Date.now();
  const persist = opts.persist !== false;
  const statePath = join(dataDir, opts.stateFile || 'state.json');
  const state = readJson(statePath, {});

  const loaded = [];
  for (const ds of datasets) loaded.push(await loadDataset(ds, { fetchImpl, dataDir, state, now }));

  for (const d of loaded) {
    if (d.meta.status === 'ok' || d.meta.status === 'not_modified') {
      state[d.meta.id] = { url: d.meta.url, etag: d.meta.etag, lastModified: d.meta.lastModified, fetchedAt: d.meta.fetchedAt, header: d.meta.header, bytes: d.meta.bytes };
    }
  }
  if (persist) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch { /* read-only FS: cache is best-effort */ }
  }

  const metas = loaded.map(d => ({ ...d.meta, rows: d.records.length }));
  return { loaded, metas, status: rollupStatus(metas), now };
}

export function rollupStatus(metas) {
  const fresh = metas.filter(d => d.status === 'ok' || d.status === 'not_modified').length;
  const served = metas.filter(d => ['ok', 'not_modified', 'stale'].includes(d.status)).length;
  if (served === 0) return 'error';
  if (fresh === metas.length) return 'live';
  if (fresh > 0) return 'partial';
  return 'stale';
}

export function errorSummary(metas) {
  return metas.filter(d => d.status === 'error').map(d => `${d.id}: ${d.reason || 'unavailable'}`).join('; ') || null;
}

// ---------------------------------------------------------------------------
// HTML tables (custody / enforcement-statistics pages have no CSV)
// ---------------------------------------------------------------------------

export function stripTags(s) {
  return String(s || '')
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;|&rsquo;|&#8217;/g, '\u2019').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// Every <h2>..<h5> heading and <table> in document order, so a table can be located by the heading
// that precedes it (CBP tables carry no captions or ids).
export function htmlSections(html) {
  const out = [];
  const body = String(html || '');
  const start = body.indexOf('<main');
  const main = start >= 0 ? body.slice(start) : body;
  for (const m of main.matchAll(/<(h[2-5])[^>]*>([\s\S]*?)<\/\1>|<table[\s\S]*?<\/table>/gi)) {
    if (m[1]) out.push({ type: 'heading', level: Number(m[1][1]), text: stripTags(m[2]) });
    else out.push({ type: 'table', rows: tableRows(m[0]) });
  }
  return out;
}

export function tableRows(tableHtml) {
  const rows = [];
  for (const r of String(tableHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => stripTags(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// Tables that directly follow a heading matching `re` (regex tested against the heading text),
// up to the next heading. CBP tables carry no captions or ids, so the heading is the only anchor.
export function tablesAfterHeading(sections, re) {
  const out = [];
  let armed = false;
  for (const s of sections) {
    if (s.type === 'heading') { if (armed && out.length) break; armed = re.test(s.text); }
    else if (armed) out.push(s.rows);
  }
  return out;
}
export function tableAfterHeading(sections, re) { return tablesAfterHeading(sections, re)[0] || null; }
