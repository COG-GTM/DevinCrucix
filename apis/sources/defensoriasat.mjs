// Defensoría del Pueblo — Sistema de Alertas Tempranas (SAT). The alert index at
// alertastempranas.defensoria.gov.co is a server-rendered table (alert number, type, places,
// key-threat summary, issue date, interactive ficha, PDF). CRUCIX polls the first pages of that
// index — the full alert text stays in the Defensoría PDF, which is linked, never fetched.
// Municipalities are geocoded through the Colombia GeoNames gazetteer (exact name only) and
// armed-group names in the summary are tagged from config/co-groups.json.

import { safeFetch } from '../utils/fetch.mjs';
import { stripTags, decodeEntities } from '../utils/rss.mjs';
import { cleanText, httpUrl } from './iranwarlive.mjs';
import { geocodeMunicipio } from '../../lib/countrygeo.mjs';
import { findGroups, loadGroups } from '../../lib/narco/groups.mjs';
import { PROFILES } from '../../lib/cjng/profiles.mjs';

export const SOURCE = 'DefensoriaSAT';
export const SITE = 'https://alertastempranas.defensoria.gov.co/';
export const INDEX_PAGES = 2;        // 20 alerts per page; two pages cover the current year and the tail of the last
export const MAX_ALERTS = 40;
export const MAX_PLACES = 8;         // municipalities geocoded per alert
const THEME_MAX = 320;
const CACHE_TTL_MS = 12 * 3600 * 1000;
const STALE_AFTER_D = 120;           // the Defensoría issues ~2 alerts a month; four months without one means the index stopped updating
const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)', Accept: 'text/html' };

export const TYPES = Object.freeze({ estructural: 'structural', inminencia: 'imminence' });
export const DISCLAIMER = [
  'Alert number, type, places, key-threat summary and issue date as listed on the Defensoría SAT index; the alert itself is the linked PDF.',
  'Municipality points are gazetteer lookups of the listed names (department-level when a municipality is not in the gazetteer) — the alert covers the whole listed territory, not a point.',
  'Armed-group tags are name matches in the Defensoría summary (config/co-groups.json), not an attribution by CRUCIX.',
];

const text = (html) => cleanText(decodeEntities(stripTags(String(html ?? '')).replace(/\s+/g, ' ').trim()), 2000);
const dmy = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return null; const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return Number.isFinite(Date.parse(iso)) ? iso : null; };

// "Belén de Umbría, Mistrató, Pueblo Rico (Risaralda); Taraira (Vaupés)" → [{ department, municipalities }]
const splitMunis = (s) => s.split(/\s*,\s*|\s+y\s+|\s+e\s+(?=[IiYy])/).map(x => x.trim()).filter(Boolean);

export function parsePlaces(s) {
  const out = [];
  for (const part of String(s || '').split(';')) {
    const m = part.trim().match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (!m) { if (part.trim()) out.push({ department: null, municipalities: splitMunis(part) }); continue; }
    out.push({ department: m[2].trim(), municipalities: splitMunis(m[1]) });
  }
  return out;
}

function geocode(places) {
  const pts = [];
  for (const p of places) {
    for (const muni of p.municipalities) {
      if (pts.length >= MAX_PLACES) return pts;
      const g = geocodeMunicipio('co', p.department, muni);
      if (g) pts.push({ name: muni, department: g.department || p.department, iso: g.iso, lat: g.lat, lon: g.lon, precision: g.precision });
    }
  }
  return pts;
}

let _groups = null;
const groupIndex = () => (_groups ||= loadGroups(PROFILES.co.groupsFile));
export function tagGroups(theme, idx = groupIndex()) {
  const f = findGroups(theme, idx);
  return [...f.cartels, ...f.factions].filter(g => !g.implied).slice(0, 5).map(g => ({ id: g.id, short: g.short }));
}

export function parseIndex(html, site = SITE) {
  const src = String(html ?? '');
  const alerts = [];
  const pageM = src.match(/P[áa]gina\s+(\d+)\s+de\s+(\d+)/i);
  for (const row of src.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (!/\/Alerta\/Details\//.test(row[1])) continue;
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1]);
    if (cells.length < 5) continue;
    const id = text(cells[0]);
    const idM = id.match(/^(\d{3})-(\d{2})$/);
    if (!idM) continue;
    const typeTxt = text(cells[1]).toLowerCase();
    const places = parsePlaces(text(cells[2]));
    const ficha = (row[1].match(/href="?(\/Alerta\/Details\/\d+)"?/i) || [])[1];
    const pdf = (row[1].match(/href="?(https?:\/\/[^\s">]+\.pdf)"?/i) || [])[1];
    const theme = cleanText(text(cells[3]), THEME_MAX);
    alerts.push({
      id, year: 2000 + Number(idM[2]), seq: Number(idM[1]),
      type: TYPES[typeTxt] || (typeTxt ? cleanText(typeTxt, 20) : 'unknown'),
      date: dmy(text(cells[4])),
      departments: [...new Set(places.map(p => p.department).filter(Boolean))].slice(0, 6),
      municipalities: places.flatMap(p => p.municipalities).slice(0, 12),
      placesText: cleanText(text(cells[2]), 200),
      theme,
      groups: tagGroups(theme),
      points: geocode(places),
      fichaUrl: ficha ? httpUrl(new URL(ficha, site).href) : null,
      pdfUrl: pdf ? httpUrl(pdf.replace(/\\/g, '/')) : null,
      infographic: !/Sin infograf/i.test(row[1]) && /link-icon-ficha|Infograf/i.test(row[1]) && !/no cuenta con infograf/i.test(row[1]),
      followUp: /En construcci[oó]n/i.test(cells[8] || '') ? null : cleanText(text(cells[8] || ''), 80) || null,
    });
  }
  return { alerts, page: pageM ? Number(pageM[1]) : null, pages: pageM ? Number(pageM[2]) : null };
}

export function buildResult({ alerts = [], pages = null, pagesFetched = 0, errors = [] }, now = new Date().toISOString()) {
  const seen = new Set();
  const list = alerts.filter(a => (seen.has(a.id) ? false : seen.add(a.id))).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.year - a.year || b.seq - a.seq).slice(0, MAX_ALERTS);
  const latest = list[0] || null;
  const latestAgeD = latest?.date ? (Date.parse(now) - Date.parse(latest.date)) / 86400000 : null;
  const thisYear = Number(now.slice(0, 4));
  const ytd = list.filter(a => a.year === thisYear);
  const byType = {};
  for (const a of ytd) byType[a.type] = (byType[a.type] || 0) + 1;
  const byDept = {};
  for (const a of ytd) for (const d of a.departments) byDept[d] = (byDept[d] || 0) + 1;
  const byGroup = {};
  for (const a of ytd) for (const g of a.groups) byGroup[g.short] = (byGroup[g.short] || 0) + 1;
  let status;
  if (!list.length) status = 'unavailable';
  else if (latestAgeD !== null && latestAgeD > STALE_AFTER_D) status = 'stale';
  else if (errors.length) status = 'limited';
  else status = 'live';
  return {
    source: SOURCE, timestamp: now, fetchedAt: now, status,
    error: status === 'unavailable' ? (errors[0] || 'SAT index unreachable') : (errors[0] || null),
    site: SITE, pagesFetched, pagesTotal: pages,
    alerts: list,
    latest: latest ? { id: latest.id, date: latest.date, type: latest.type, placesText: latest.placesText } : null,
    latestAgeD: latestAgeD === null ? null : +latestAgeD.toFixed(1),
    ytd: { year: thisYear, alerts: ytd.length, byType, departments: Object.keys(byDept).length, topDepartments: Object.entries(byDept).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })), groups: Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([short, n]) => ({ short, n })) },
    problems: errors, disclaimer: DISCLAIMER,
  };
}

let _cache = null, _cacheTs = 0;

export async function fetchSat({ pages = INDEX_PAGES } = {}) {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const errors = [];
  const alerts = [];
  let pagesTotal = null, fetched = 0;
  for (let p = 1; p <= pages; p++) {
    try {
      const r = await safeFetch(p === 1 ? SITE : `${SITE}?page=${p}`, { timeout: 20000, headers: HEADERS });
      if (r?.error) throw new Error(r.error);
      const html = typeof r?.rawText === 'string' ? r.rawText : '';
      if (!html) throw new Error('empty body');
      const parsed = parseIndex(html);
      if (!parsed.alerts.length) throw new Error('no alert rows parsed');
      alerts.push(...parsed.alerts);
      pagesTotal = parsed.pages ?? pagesTotal;
      fetched++;
      if (parsed.pages && p >= parsed.pages) break;
    } catch (err) {
      console.log(`[DefensoriaSAT] page ${p}: ${err.message}`);
      errors.push(`page ${p}: ${String(err.message).slice(0, 160)}`);
    }
  }
  const result = buildResult({ alerts, pages: pagesTotal, pagesFetched: fetched, errors });
  if (result.status === 'unavailable' && _cache) {
    const ageH = (now - _cacheTs) / 3600000;
    return { ..._cache, stale: true, status: 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): SAT index unreachable` };
  }
  if (result.status !== 'unavailable') { _cache = result; _cacheTs = now; }
  return result;
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }
export async function briefing() { return fetchSat(); }
export default briefing;
