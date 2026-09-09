// DOJ — U.S. Department of Justice press releases (Open Data API, public domain, no key).
//
// Watches the five south-west border U.S. Attorney's Offices for prosecutions involving cartel members,
// smugglers, trafficking organizations, weapons pipelines, money laundering, human smuggling, tunnels and
// violent organizations. The API has no server-side component filter, so each sweep pulls the newest
// national pages (50 per page, the API ignores larger page sizes) and filters client-side; a persistent
// store makes the watch continuous across sweeps and a first run back-fills several pages.
//
//   status: live | partial | empty | stale | error

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { htmlToText } from '../utils/article.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/doj');
export const API_URL = 'https://www.justice.gov/api/v1/press_releases.json';
export const PIPELINE_VERSION = 'doj/1.0.0';
export const CLASSIFIER_VERSION = 'doj-rules/1';

const PAGE_SIZE = 50;
const PAGES_PER_SWEEP = clampInt(process.env.DOJ_PAGES_PER_SWEEP, 1, 10, 2);
const BACKFILL_PAGES = clampInt(process.env.DOJ_BACKFILL_PAGES, 1, 40, 8);
const RETENTION_DAYS = 120;
const RECENT_LIMIT = 60;
const PAGE_DELAY_MS = 750;
const MAX_TEXT_CHARS = 20_000;

// USAO component names as published by the API (`component[].name`). Seats are the districts'
// principal courthouses, used only as a map anchor when a release names no more specific place.
export const DISTRICTS = [
  { code: 'CASD', component: 'USAO - California, Southern', name: 'Southern District of California', seat: 'San Diego, CA', lat: 32.7157, lon: -117.1611, state: 'CA' },
  { code: 'AZ', component: 'USAO - Arizona', name: 'District of Arizona', seat: 'Phoenix, AZ', lat: 33.4484, lon: -112.074, state: 'AZ' },
  { code: 'NM', component: 'USAO - New Mexico', name: 'District of New Mexico', seat: 'Albuquerque, NM', lat: 35.0844, lon: -106.6504, state: 'NM' },
  { code: 'TXWD', component: 'USAO - Texas, Western', name: 'Western District of Texas', seat: 'San Antonio, TX', lat: 29.4241, lon: -98.4936, state: 'TX' },
  { code: 'TXSD', component: 'USAO - Texas, Southern', name: 'Southern District of Texas', seat: 'Houston, TX', lat: 29.7604, lon: -95.3698, state: 'TX' },
];
const DISTRICT_BY_COMPONENT = new Map(DISTRICTS.map(d => [d.component, d]));

// Watch categories. A release is kept when at least one matches its title/teaser/body/topics.
export const CATEGORIES = [
  { id: 'cartel', label: 'Cartel members', re: /\bcartel|\bc[aá]rtel|\bcjng\b|jalisco new generation|sinaloa|\bzetas\b|beltr[aá]n[- ]leyva|la l[ií]nea|\bcdn\b|cartel del noreste|gulf cartel|la familia michoacana|foreign terrorist organization|\bfto\b|\bsdgt\b/i },
  { id: 'smugglers', label: 'Smugglers', re: /(?:drug|narcotic|alien|human|migrant|cash|currency|weapon|firearm|border|mexic|tunnel|fentanyl|meth|cocaine|marijuana|cartel)\w*[^.]{0,100}\bsmuggl|\bsmuggl\w*[^.]{0,100}\b(?:drug|narcotic|alien|human|migrant|cash|currency|weapon|firearm|border|mexic|tunnel|fentanyl|meth|cocaine|marijuana|cartel)/i },
  { id: 'trafficking_org', label: 'Trafficking organizations', re: /trafficking organi[sz]ation|\bdto\b|drug[- ]trafficking|distribution (?:conspiracy|network|ring|cell|organization)|conspiracy to (?:distribute|import|possess with intent)|\bfentanyl|\bmethamphetamine|\bcocaine|\bheroin|narcotics/i },
  { id: 'weapons', label: 'Weapons pipelines', re: /firearms? trafficking|weapons? trafficking|arms trafficking|straw purchas|gun[- ]?running|(?:export|smuggl)\w* (?:of )?(?:firearms|weapons|ammunition|guns|rifles)|(?:firearms|weapons|rifles|guns|ammunition)[^.]{0,80}\b(?:mexico|cartel|smuggl|export)|\bgrenades?\b|weapons pipeline|\bmachine ?guns?\b[^.]{0,60}\b(?:traffick|smuggl|export|mexico)/i },
  { id: 'money_laundering', label: 'Money laundering', re: /money[- ]laundering|\blaunder|bulk[- ]cash|\bstructuring\b|unlicensed money|\bhawala\b|casas? de cambio|financial (?:transactions|conspiracy)|\bBSA\b|bank secrecy act/i },
  { id: 'human_smuggling', label: 'Human smuggling', re: /alien smuggling|human smuggling|smuggling of (?:aliens|migrants|noncitizens|undocumented)|transport(?:ing|ed)? (?:of )?(?:illegal |undocumented )?(?:aliens|noncitizens|migrants)|harbor(?:ing|ed) (?:illegal |undocumented )?(?:aliens|noncitizens)|stash house|\bmigrants?\b|\bnoncitizens?\b|bringing in (?:and harboring )?(?:certain )?aliens|panga|tractor[- ]trailer|human trafficking/i },
  { id: 'tunnel', label: 'Tunnels', re: /\btunnel/i },
  { id: 'violent_org', label: 'Violent organizations', re: /\bracketeering|\brico\b|violent (?:gang|organization|criminal organization|street gang)|gang (?:member|leader|associate)|\bms-?13\b|barrio azteca|\baztecas?\b|mexican mafia|tango blast|texas syndicate|\bsure[nñ]os?\b|\bmexicles\b|artistas asesinos|\bhit ?man|\bsicario|(?:kidnapp|murder|homicide|torture|hostage)\w*[^.]{0,120}\b(?:cartel|gang|organization|conspiracy|members|enterprise|ransom)|(?:cartel|gang|organization|conspiracy|enterprise)[^.]{0,120}\b(?:kidnapp|murder|homicide|torture|hostage)/i },
];

// Quoted passages are official boilerplate ("…foreign terrorist organizations…", "…violent offenders…") and are
// not evidence about the case; they are stripped before classification.
const QUOTE_RE = /["\u201C][^"\u201C\u201D]{20,1200}["\u201D]/g;
export function factText(text) { return String(text || '').replace(QUOTE_RE, ' '); }
export const CATEGORY_IDS = CATEGORIES.map(c => c.id);
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
const sha256 = s => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
function readJson(file, dflt) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt; } catch { return dflt; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function classifyRelease(text) {
  const s = factText(text);
  return CATEGORIES.filter(c => c.re.test(s)).map(c => c.id);
}

export function districtOf(components) {
  for (const c of components || []) {
    const d = DISTRICT_BY_COMPONENT.get(String(c?.name || '').trim());
    if (d) return d;
  }
  return null;
}

function epochToIso(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString();
  const m = /datetime="([^"]+)"/.exec(String(v || ''));
  if (m) { const t = new Date(m[1]).getTime(); if (Number.isFinite(t)) return new Date(t).toISOString(); }
  const t = new Date(String(v || '')).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Dateline: "SAN ANTONIO – ..." / "El Paso, Texas – ..." at the top of the body.
const DATELINE_RE = /^\s*([A-Z][A-Za-z.'\u00C0-\u017F-]*(?:\s+[A-Z][A-Za-z.'\u00C0-\u017F-]*){0,3})(?:,\s*([A-Za-z. ]{2,30}))?\s*[\u2014\u2013-]{1,2}\s/;
export function datelineOf(text) {
  const m = DATELINE_RE.exec(String(text || '').slice(0, 200));
  if (!m) return null;
  const city = m[1].replace(/\s+/g, ' ').trim();
  if (city.length < 3 || city.length > 40 || /^(?:The|A|An|On|In|At|Today|Yesterday)$/i.test(city)) return null;
  return { city: city.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase()), state: m[2] ? m[2].trim() : null };
}

// One release -> stored record (only for watched districts; returns null otherwise).
export function normalizeRelease(raw, collectedAt) {
  const district = districtOf(raw.component);
  if (!district) return null;
  const url = /^https:\/\/www\.justice\.gov\//.test(String(raw.url || '')) ? String(raw.url).slice(0, 400) : null;
  const uuid = String(raw.uuid || '').slice(0, 64);
  if (!uuid && !url) return null;
  const title = htmlToText(String(raw.title || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
  const teaser = htmlToText(String(raw.teaser || '')).replace(/\s+/g, ' ').trim().slice(0, 600);
  const body = htmlToText(String(raw.body || '')).trim().slice(0, MAX_TEXT_CHARS);
  const topics = (raw.topic || []).map(t => String(t?.name || '').slice(0, 80)).filter(Boolean).slice(0, 12);
  const components = (raw.component || []).map(c => String(c?.name || '').slice(0, 80)).filter(Boolean).slice(0, 8);
  const categories = classifyRelease(`${title}\n${teaser}\n${topics.join('\n')}\n${body}`);
  return {
    id: sha256(`doj|${uuid || url}`).slice(0, 16),
    uuid: uuid || null,
    url,
    title,
    teaser,
    body,
    bodyChars: body.length,
    publishedAt: epochToIso(raw.date) || epochToIso(raw.created) || null,
    changedAt: epochToIso(raw.changed) || null,
    collectedAt,
    district: { code: district.code, name: district.name, component: district.component },
    components,
    topics,
    categories,
    watched: categories.length > 0,
    dateline: datelineOf(body),
    number: raw.number ? String(raw.number).slice(0, 40) : null,
    contentHash: sha256(`${title}\n${body}`),
    pipelineVersion: PIPELINE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
  };
}

async function fetchPage(page, fetchImpl, timeoutMs = 20_000) {
  const url = `${API_URL}?pagesize=${PAGE_SIZE}&page=${page}&sort=date&direction=DESC`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'Crucix/1.0 (+public-data monitor)', Accept: 'application/json' } });
    if (!res.ok) return { ok: false, httpStatus: res.status, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const results = Array.isArray(json?.results) ? json.results : null;
    if (!results) return { ok: false, httpStatus: res.status, reason: 'unexpected payload' };
    return { ok: true, httpStatus: res.status, results, meta: json.metadata?.resultset || null };
  } catch (e) {
    return { ok: false, httpStatus: null, reason: /abort/i.test(e?.message || '') ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function pruneStore(store, now) {
  const cut = now - RETENTION_DAYS * 86_400_000;
  return store.filter(r => { const t = new Date(r.publishedAt || r.collectedAt).getTime(); return !Number.isFinite(t) || t >= cut; });
}

export function publicRecord(r) {
  return {
    id: r.id, uuid: r.uuid, url: r.url, title: r.title, teaser: r.teaser, publishedAt: r.publishedAt, collectedAt: r.collectedAt,
    district: r.district, components: r.components, topics: r.topics, categories: r.categories, dateline: r.dateline, number: r.number, bodyChars: r.bodyChars,
  };
}

export function summarize(store, now, days = 30) {
  const cut = now - days * 86_400_000;
  const recent = store.filter(r => r.watched && new Date(r.publishedAt || r.collectedAt).getTime() >= cut);
  const byDistrict = Object.fromEntries(DISTRICTS.map(d => [d.code, 0]));
  const byCategory = Object.fromEntries(CATEGORY_IDS.map(c => [c, 0]));
  for (const r of recent) {
    byDistrict[r.district.code]++;
    for (const c of r.categories) byCategory[c]++;
  }
  return { days, watched: recent.length, byDistrict, byCategory };
}

export async function briefing(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const now = opts.now || Date.now();
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const persist = opts.persist !== false;
  const pageDelayMs = opts.pageDelayMs ?? PAGE_DELAY_MS;
  const collectedAt = new Date(now).toISOString();

  let store = readJson(join(dataDir, 'releases.json'), []);
  if (!Array.isArray(store)) store = [];
  const state = readJson(join(dataDir, 'state.json'), {});
  const known = new Map(store.map(r => [r.id, r]));

  const pages = store.length ? (opts.pages ?? PAGES_PER_SWEEP) : (opts.backfillPages ?? BACKFILL_PAGES);
  const pageReports = [];
  let seen = 0, matchedDistrict = 0, added = 0, updated = 0, filteredOut = 0, apiCount = null;
  for (let p = 0; p < pages; p++) {
    if (p > 0) await sleep(pageDelayMs);
    const page = await fetchPage(p, fetchImpl);
    pageReports.push({ page: p, ok: page.ok, httpStatus: page.httpStatus, reason: page.reason || null, results: page.results?.length ?? 0 });
    if (!page.ok) break;
    if (page.meta?.count) apiCount = Number(page.meta.count) || null;
    let newOnPage = 0;
    for (const raw of page.results) {
      seen++;
      const rec = normalizeRelease(raw, collectedAt);
      if (!rec) continue;
      matchedDistrict++;
      if (!rec.watched) { filteredOut++; continue; }
      const prev = known.get(rec.id);
      if (!prev) { known.set(rec.id, rec); added++; newOnPage++; }
      else if (prev.contentHash !== rec.contentHash || prev.classifierVersion !== CLASSIFIER_VERSION) {
        known.set(rec.id, { ...rec, collectedAt: prev.collectedAt, updatedAt: collectedAt });
        updated++;
      }
    }
    // Once a whole page is already known the older pages are too (feed is date-sorted).
    if (store.length && newOnPage === 0 && page.results.length && p >= 1) break;
  }

  const okPages = pageReports.filter(r => r.ok).length;
  store = pruneStore([...known.values()], now);
  store.sort((a, b) => new Date(b.publishedAt || b.collectedAt) - new Date(a.publishedAt || a.collectedAt));

  let status = 'live';
  let error;
  if (okPages === 0) {
    status = store.length ? 'stale' : 'error';
    error = `DOJ API ${pageReports[0]?.reason || 'unavailable'}`;
  } else if (okPages < pageReports.length) {
    status = 'partial';
  } else if (!store.length) {
    status = 'empty';
  }
  const stateOut = { ...state, lastPolled: collectedAt, lastStatus: status, ...(okPages ? { lastChanged: collectedAt } : {}), apiCount };
  if (persist) {
    writeJson(join(dataDir, 'releases.json'), store);
    writeJson(join(dataDir, 'state.json'), stateOut);
  }

  return {
    source: 'DOJ',
    timestamp: collectedAt,
    status,
    ...(error ? { error } : {}),
    ...(status === 'stale' ? { stale: true, note: `DOJ API unreachable this sweep; showing ${store.length} stored releases` } : {}),
    pipelineVersion: PIPELINE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    api: { url: API_URL, pagesFetched: okPages, pagesRequested: pages, pageSize: PAGE_SIZE, releasesScanned: seen, nationalCount: apiCount, pages: pageReports },
    districts: DISTRICTS.map(d => ({ code: d.code, name: d.name, component: d.component, seat: d.seat, lat: d.lat, lon: d.lon })),
    categories: CATEGORIES.map(c => ({ id: c.id, label: c.label })),
    totalReleases: store.length,
    newThisSweep: added,
    updatedThisSweep: updated,
    districtHitsThisSweep: matchedDistrict,
    filteredOutThisSweep: filteredOut,
    summary: summarize(store, now, 30),
    releases: store.slice(0, RECENT_LIMIT).map(publicRecord),
    lastChanged: stateOut.lastChanged || state.lastChanged || null,
  };
}

// Full stored records (with body) for the narco event pipeline.
export function loadReleases({ dataDir = DEFAULT_DATA_DIR, days = 90, now = Date.now() } = {}) {
  const store = readJson(join(dataDir, 'releases.json'), []);
  const cut = now - days * 86_400_000;
  return (Array.isArray(store) ? store : []).filter(r => r.watched && new Date(r.publishedAt || r.collectedAt).getTime() >= cut);
}

export function queryReleases({ district = null, category = null, days = 30, limit = 100 } = {}, { dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  const out = loadReleases({ dataDir, days, now })
    .filter(r => (!district || r.district.code === district) && (!category || r.categories.includes(category)))
    .map(publicRecord);
  return { count: out.length, filters: { district, category, days }, releases: out.slice(0, limit) };
}
