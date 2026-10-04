// Indepaz (Instituto de Estudios para el Desarrollo y la Paz) — Observatorio de DDHH y
// conflictividades. Two living posts on indepaz.org.co carry the running tallies Colombian
// coverage cites: massacres since 2020 (one table per year: date, department, municipality,
// victims) and social leaders / peace-agreement signatories killed (one table per year with the
// victim's name). CRUCIX reads both through the public WordPress REST API and keeps only bounded
// structured values: massacre rows (date, place, victim count) for the current year, per-year
// totals, and for killed leaders COUNTS ONLY — by month, department and social sector. Names are
// read to find the column and are never stored, indexed or shown.

import { safeFetch } from '../utils/fetch.mjs';
import { stripTags, decodeEntities } from '../utils/rss.mjs';
import { cleanText, httpUrl, toIso } from './iranwarlive.mjs';
import { geocodeMunicipio } from '../../lib/countrygeo.mjs';
import { fold } from '../../lib/countryconfig.mjs';

export const SOURCE = 'Indepaz';
export const SITE = 'https://indepaz.org.co/';
const API = 'https://indepaz.org.co/wp-json/wp/v2/posts';
const FIELDS = '_fields=id,date_gmt,modified_gmt,link,title,content';
export const MASACRES_URL = `${API}?search=${encodeURIComponent('masacres en colombia durante')}&per_page=5&${FIELDS}`;
export const LIDERES_URL = `${API}?search=${encodeURIComponent('lideres sociales defensores firmantes asesinados')}&per_page=5&${FIELDS}`;
export const MAX_ROWS = 160;         // current-year massacre rows kept (Indepaz counted 89 by early September 2026)
const MAX_BYTES = 1.5 * 1024 * 1024;
const CACHE_TTL_MS = 12 * 3600 * 1000;
const STALE_AFTER_D = 60;            // Indepaz updates the massacre list within days of an event
const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };

export const DISCLAIMER = [
  'Counts are Indepaz\u2019s own, re-tallied by CRUCIX from the tables in its running posts; the post is linked and remains the record. Indepaz defines a massacre as the intentional, simultaneous killing of three or more defenceless people by the same author.',
  'Killed social leaders and peace-agreement signatories are shown as counts by month, department and sector only. Names are never stored or displayed.',
  'Points are gazetteer lookups of the listed municipality (department centroid when the municipality is not matched).',
];

const MONTHS_ES = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06', julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };
const clean = (s) => decodeEntities(stripTags(String(s ?? ''))).replace(/\s+/g, ' ').trim();
const int = (s) => { const n = Number(String(s ?? '').replace(/[^\d]/g, '')); return Number.isFinite(n) && String(s ?? '').trim() !== '' ? n : null; };
// Indepaz tables carry the odd typo ("19/07/2924"); dates outside 2000-2099 are dropped rather than kept as a phantom year.
const dmy = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; const y = m[3].length === 2 ? `20${m[3]}` : m[3]; if (!/^20\d\d$/.test(y)) return null; const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return Number.isFinite(Date.parse(iso)) ? iso : null; };
const esDate = (s) => { const m = String(s || '').toLowerCase().match(/(\d{1,2}) de ([a-záéíóú]+) de (\d{4})/); return m && MONTHS_ES[m[2]] ? `${m[3]}-${MONTHS_ES[m[2]]}-${m[1].padStart(2, '0')}` : null; };
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// Every <table> in a post body with its header cells, data rows (cell text only) and the last
// ~200 characters of text that precede it (Indepaz puts the year headline right above each table).
export function parseTables(html) {
  const src = String(html ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const out = [];
  let last = 0;
  for (const m of src.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const before = clean(src.slice(last, m.index));
    last = m.index + m[0].length;
    const rows = [...m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => clean(c[1])));
    const hi = rows.findIndex(r => r.some(c => /fecha/i.test(c)));
    if (hi < 0) continue;
    out.push({ pre: before.slice(-200), headers: rows[hi].map(h => fold(h)), rows: rows.slice(hi + 1).filter(r => r.length >= 3 && r.some(Boolean)) });
  }
  return out;
}

const col = (headers, re) => headers.findIndex(h => re.test(h));
const yearOf = (rows, di) => { const c = {}; for (const r of rows) { const y = (dmy(r[di]) || '').slice(0, 4); if (y) c[y] = (c[y] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null; };

// Massacres post → per-year totals (Indepaz's own headline where stated, else the table count) plus
// the current year's rows (date, department, municipality, victims, point).
export function parseMasacres(post) {
  const html = post?.content?.rendered ?? '';
  const text = clean(html);
  const stated = {};
  for (const m of text.matchAll(/(\d{1,3})\s+masacres\s+en\s+el\s+(\d{4})\s*,?\s*con\s+(\d{1,4})\s+v[ií]ctimas(?:\s*[–\-—]\s*corte\s+al\s+(\d{1,2} de [a-záéíóú]+ de \d{4}))?/gi)) {
    stated[m[2]] = { massacres: Number(m[1]), victims: Number(m[3]), asOf: esDate(m[4]) };
  }
  const byYear = new Map();
  for (const t of parseTables(html)) {
    const di = col(t.headers, /fecha/), de = col(t.headers, /departamento/), mu = col(t.headers, /municipio/), vi = col(t.headers, /v[ií]ctimas/);
    if (di < 0 || de < 0 || mu < 0 || vi < 0) continue;
    const yr = (t.pre.match(/(?:en el|durante el)\s+(\d{4})/i) || [])[1] || yearOf(t.rows, di);
    if (!yr) continue;
    const rows = t.rows.map(r => ({ date: dmy(r[di]), department: cleanText(r[de], 40), municipality: cleanText(r[mu], 60), victims: int(r[vi]) })).filter(r => r.date && r.department && r.victims !== null);
    const cur = byYear.get(yr) || new Map();
    for (const r of rows) cur.set(`${r.date}|${fold(r.department)}|${fold(r.municipality)}|${r.victims}`, r); // the same list is sometimes published twice (two page blocks)
    byYear.set(yr, cur);
  }
  const years = [...new Set([...byYear.keys(), ...Object.keys(stated)])].sort().reverse().map(y => {
    const rows = [...(byYear.get(y)?.values() || [])];
    const tallied = { massacres: rows.length, victims: rows.reduce((s, r) => s + (r.victims || 0), 0) };
    const st = stated[y];
    return { year: Number(y), massacres: st?.massacres ?? tallied.massacres, victims: st?.victims ?? tallied.victims, asOf: st?.asOf || null, tallied, rows: rows.length };
  });
  const latestYear = years[0]?.year || null;
  const rows = latestYear ? [...byYear.get(String(latestYear))?.values() || []] : [];
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const current = rows.slice(0, MAX_ROWS).map(r => {
    const g = geocodeMunicipio('co', r.department, r.municipality);
    return { ...r, lat: g?.lat ?? null, lon: g?.lon ?? null, iso: g?.iso ?? null, precision: g?.precision ?? null };
  });
  const byDept = {};
  for (const r of rows) byDept[r.department] = (byDept[r.department] || 0) + 1;
  const byMonth = {};
  for (const r of rows) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) + 1;
  return {
    post: { title: cleanText(post?.title?.rendered, 160), url: httpUrl(post?.link), published: toIso(post?.date_gmt ? `${post.date_gmt}Z` : null), modified: toIso(post?.modified_gmt ? `${post.modified_gmt}Z` : null) },
    years, latestYear,
    latestDate: rows[0]?.date || null,
    asOf: years[0]?.asOf || rows[0]?.date || null,
    rows: current,
    byDepartment: Object.entries(byDept).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n })),
    byMonth: Object.entries(byMonth).sort().map(([month, n]) => ({ month, n })),
  };
}

// Leaders post → counts only. A table with a sector column is social leaders; one without is
// peace-agreement signatories (also recognisable from the heading right above it).
export function parseLideres(post) {
  const html = post?.content?.rendered ?? '';
  const years = new Map();
  for (const t of parseTables(html)) {
    const di = col(t.headers, /fecha/), de = col(t.headers, /departamento/), mu = col(t.headers, /municipio/), se = col(t.headers, /sector/);
    const nameCol = col(t.headers, /nombre/);
    if (di < 0 || de < 0 || nameCol < 0) continue;
    const yr = (t.pre.match(/asesinad[oa]s\s+en\s+(\d{4})/i) || [])[1] || yearOf(t.rows, di);
    if (!yr) continue;
    const kind = /firmantes/i.test(t.pre.slice(-120)) || se < 0 ? 'signatories' : 'leaders';
    const y = years.get(yr) || { year: Number(yr), leaders: 0, signatories: 0, byMonth: {}, byDepartment: {}, bySector: {}, latestDate: null };
    for (const r of t.rows) {
      const d = dmy(r[di]);
      if (!d) continue;
      y[kind]++;
      if (kind !== 'leaders') continue;
      const mo = d.slice(0, 7), dep = cleanText(r[de], 40), sec = se >= 0 ? titleCase(cleanText(r[se], 32)) : null;
      y.byMonth[mo] = (y.byMonth[mo] || 0) + 1;
      if (dep) y.byDepartment[dep] = (y.byDepartment[dep] || 0) + 1;
      if (sec) y.bySector[sec] = (y.bySector[sec] || 0) + 1;
      if (!y.latestDate || d > y.latestDate) y.latestDate = d;
      void mu;
    }
    years.set(yr, y);
  }
  const list = [...years.values()].sort((a, b) => b.year - a.year).map(y => ({
    year: y.year, leaders: y.leaders, signatories: y.signatories, latestDate: y.latestDate,
    byMonth: Object.entries(y.byMonth).sort().map(([month, n]) => ({ month, n })),
    byDepartment: Object.entries(y.byDepartment).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n })),
    bySector: Object.entries(y.bySector).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
  }));
  return {
    post: { title: cleanText(post?.title?.rendered, 160), url: httpUrl(post?.link), published: toIso(post?.date_gmt ? `${post.date_gmt}Z` : null), modified: toIso(post?.modified_gmt ? `${post.modified_gmt}Z` : null) },
    years: list, current: list[0] || null,
    note: 'Counts only — Indepaz publishes names; CRUCIX does not store or show them.',
  };
}

export function pickPost(posts, re) {
  const list = (Array.isArray(posts) ? posts : []).filter(p => re.test(clean(p?.title?.rendered ?? '')) && /<table/i.test(p?.content?.rendered ?? ''));
  list.sort((a, b) => (b.content?.rendered?.split('<table').length || 0) - (a.content?.rendered?.split('<table').length || 0));
  return list[0] || null;
}

export function buildResult({ masacres, lideres, errors = [] }, now = new Date().toISOString()) {
  const latest = masacres?.asOf || masacres?.latestDate || null;
  const ageD = latest ? (Date.parse(now) - Date.parse(latest)) / 86400000 : null;
  let status;
  if (!masacres && !lideres) status = 'unavailable';
  else if (ageD !== null && ageD > STALE_AFTER_D) status = 'stale';
  else if (!masacres || !lideres || errors.length) status = 'limited';
  else status = 'live';
  return {
    source: SOURCE, timestamp: now, fetchedAt: now, status,
    error: status === 'unavailable' ? (errors[0] || 'Indepaz unreachable') : (errors[0] || null),
    site: SITE, masacres: masacres || null, lideres: lideres || null,
    latestAgeD: ageD === null ? null : +ageD.toFixed(1),
    problems: errors, disclaimer: DISCLAIMER,
  };
}

async function getPosts(url) {
  const r = await safeFetch(url, { timeout: 20000, headers: HEADERS, maxBytes: MAX_BYTES });
  if (r?.error) throw new Error(r.error);
  if (!Array.isArray(r)) throw new Error('unexpected WP REST response');
  return r;
}

let _cache = null, _cacheTs = 0;

export async function fetchIndepaz() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const errors = [];
  let masacres = null, lideres = null;
  try {
    const p = pickPost(await getPosts(MASACRES_URL), /masacres en colombia/i);
    if (!p) throw new Error('massacres post not found');
    masacres = parseMasacres(p);
    if (!masacres.years.length) throw new Error('no massacre tables parsed');
  } catch (err) { console.log(`[Indepaz] masacres: ${err.message}`); errors.push(`masacres: ${String(err.message).slice(0, 160)}`); masacres = null; }
  try {
    const p = pickPost(await getPosts(LIDERES_URL), /l[ií]deres sociales/i);
    if (!p) throw new Error('leaders post not found');
    lideres = parseLideres(p);
    if (!lideres.years.length) throw new Error('no leader tables parsed');
  } catch (err) { console.log(`[Indepaz] lideres: ${err.message}`); errors.push(`lideres: ${String(err.message).slice(0, 160)}`); lideres = null; }
  const result = buildResult({ masacres, lideres, errors });
  if (result.status === 'unavailable' && _cache) {
    const ageH = (now - _cacheTs) / 3600000;
    return { ..._cache, stale: true, status: 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): Indepaz unreachable` };
  }
  if (result.status !== 'unavailable') { _cache = result; _cacheTs = now; }
  return result;
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }
export async function briefing() { return fetchIndepaz(); }
export default briefing;
