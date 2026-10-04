// Colombia official crime counts from datos.gov.co (Socrata SODA, key-free): Policía Nacional
// SIEDCO monthly incident tables. Aggregates server-side (SoQL) so CRUCIX only ever holds bounded
// summaries — Bogotá monthly theft trend, latest-month departmental choropleth, top municipios and
// Bogotá category breakdowns (theft modality, arrests, drug / weapon seizures, threats).
// Figures are reports (denuncias) per municipio and publish with roughly a one-month lag; nothing
// here is locality / barrio level.

import { safeFetch } from '../utils/fetch.mjs';
import { countryConfig } from '../../lib/countryconfig.mjs';

export const SOURCE = 'ColombiaOpenData';
export const BASE = 'https://www.datos.gov.co/resource/';
export const ATTRIBUTION = 'Policía Nacional de Colombia (SIEDCO) via datos.gov.co';
export const LICENSE = 'Datos Abiertos Colombia — open government data';
export const FOCUS = { code5: '11001', code8: '11001000', name: 'Bogotá D.C.', deptCode: '11' };

export const DATASETS = {
  theft: { id: '4rxi-8m8d', name: 'Hurto a personas', dateKind: 'calendar' },
  modalities: { id: '9vha-vh9n', name: 'Hurto por modalidades (vehículos, comercio, residencias…)', dateKind: 'text', group: 'tipo_de_hurto' },
  arrests: { id: '3jdh-nmwu', name: 'Capturas', dateKind: 'text', group: 'descripcion_conducta_captura' },
  drugs: { id: 'kk69-w2jj', name: 'Incautación de estupefacientes', dateKind: 'text', group: 'clase_bien', unit: 'units as reported (g)' },
  weapons: { id: '2iz5-9bbz', name: 'Incautación de armas de fuego', dateKind: 'text', group: 'clase_bien' },
  threats: { id: 'meew-mguv', name: 'Amenazas', dateKind: 'text', group: 'armas_medios' },
};

export const DISCLAIMER = [
  'Official Policía Nacional counts (reports per municipio) published on datos.gov.co; roughly one month of lag.',
  'Counts are not locality / barrio level; Bogotá figures cover the whole Distrito Capital.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)', Accept: 'application/json' };
const CACHE_TTL_MS = 6 * 3600 * 1000;
const STALE_AFTER_H = 7 * 24;
export const MONTHS_BACK = 14;
export const MAX_ROWS = 40;
const LABEL_MAX = 80;

const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const str = (v, max = LABEL_MAX) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };

export function monthKey(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function prevMonth(ym) {
  const m = String(ym ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  let y = Number(m[1]), mo = Number(m[2]) - 1;
  if (mo < 1) { mo = 12; y -= 1; }
  return `${y}-${String(mo).padStart(2, '0')}`;
}

function monthStart(ym) { return `${ym}-01T00:00:00.000`; }
function nextMonthStart(ym) {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  let y = Number(m[1]), mo = Number(m[2]) + 1;
  if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, '0')}-01T00:00:00.000`;
}

// Text-dated datasets store dd/mm/yyyy strings, so a month is selected with a LIKE pattern.
function likeMonth(ym) { const m = ym.match(/^(\d{4})-(\d{2})$/); return `%/${m[2]}/${m[1]}`; }

// Strip the penal-code article prefix ("ARTÍCULO 239. HURTO MOTOCICLETAS" → "HURTO MOTOCICLETAS").
export function cleanLabel(raw) {
  const s = str(raw);
  const m = s.match(/^ART[IÍ]CULO\s+\d+[A-Z]?\.?\s*(.*)$/i);
  return { label: str(m ? m[1] : s) || 'NO REPORTADO', article: m ? s.match(/\d+[A-Z]?/)[0] : null };
}

export function parseMonthly(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const month = monthKey(r?.m);
    if (!month) continue;
    out.push({ month, n: Math.round(num(r.n)) });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  return out.slice(-MONTHS_BACK);
}

export function parseDept(rows, admCodes = {}) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = str(r?.cod_depto, 4);
    if (!/^\d{2}$/.test(code)) continue;
    out.push({ code, iso: admCodes[code] || null, name: str(r.departamento, 60), n: Math.round(num(r.n)) });
  }
  out.sort((a, b) => b.n - a.n);
  return out.slice(0, MAX_ROWS);
}

export function parseMunicipios(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = str(r?.cod_muni, 6);
    if (!/^\d{5}$/.test(code)) continue;
    out.push({ code, name: str(r.municipio, 60), dept: str(r.departamento, 60), n: Math.round(num(r.n)) });
  }
  out.sort((a, b) => b.n - a.n);
  return out.slice(0, 12);
}

export function parseCategory(rows, groupField) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const { label, article } = cleanLabel(r?.[groupField]);
    const n = num(r?.n);
    if (!(n > 0)) continue;
    out.push({ label, article, n: Math.round(n * 100) / 100 });
  }
  out.sort((a, b) => b.n - a.n);
  const total = Math.round(out.reduce((s, x) => s + x.n, 0) * 100) / 100;
  return { rows: out.slice(0, 12), total, distinct: out.length };
}

function soql(id, params) {
  const qs = Object.entries(params).map(([k, v]) => `$${k}=${encodeURIComponent(v)}`).join('&');
  return `${BASE}${id}.json?${qs}`;
}

async function getRows(url) {
  const r = await safeFetch(url, { timeout: 25000, retries: 1, headers: HEADERS });
  if (r?.error) throw new Error(r.error);
  if (!Array.isArray(r)) throw new Error(r?.message ? `SODA: ${str(r.message, 160)}` : 'unexpected SODA body');
  return r;
}

export function trendStats(monthly) {
  if (!monthly.length) return null;
  const latest = monthly[monthly.length - 1];
  const prev = monthly.find(m => m.month === prevMonth(latest.month)) || null;
  const yoyKey = `${Number(latest.month.slice(0, 4)) - 1}-${latest.month.slice(5)}`;
  const yoy = monthly.find(m => m.month === yoyKey) || null;
  const pct = (a, b) => (b && b.n > 0 ? Math.round(((a.n - b.n) / b.n) * 1000) / 10 : null);
  return { month: latest.month, n: latest.n, prevMonth: prev?.month || null, prevN: prev?.n ?? null, momPct: pct(latest, prev), yoyMonth: yoy?.month || null, yoyN: yoy?.n ?? null, yoyPct: pct(latest, yoy) };
}

export function buildResult(parts, now = new Date().toISOString()) {
  const { monthly = [], dept = [], municipios = [], categories = {}, datasets = [], admCodes = {} } = parts;
  const theftMonth = monthly.length ? monthly[monthly.length - 1].month : null;
  const catMonths = Object.values(categories).map(c => c?.month).filter(Boolean).sort();
  const okCount = datasets.filter(d => d.status === 'live').length;
  let status;
  if (okCount === datasets.length && datasets.length) status = 'live';
  else if (monthly.length || okCount > 0) status = 'limited';
  else status = 'unavailable';
  const problems = datasets.filter(d => d.status !== 'live').map(d => `${d.name}: ${d.error || d.status}`);
  return {
    source: SOURCE,
    timestamp: now,
    fetchedAt: now,
    status,
    error: status === 'unavailable' ? (problems[0] || 'datos.gov.co unreachable') : null,
    attribution: ATTRIBUTION,
    license: LICENSE,
    portal: 'https://www.datos.gov.co/',
    asOf: { theftMonth, bogotaMonth: catMonths.length ? catMonths[catMonths.length - 1] : null },
    bogota: {
      code: FOCUS.code5,
      name: FOCUS.name,
      theftMonthly: monthly,
      theftLatest: trendStats(monthly),
      categories,
    },
    national: {
      month: theftMonth,
      byDept: dept.map(d => ({ ...d, iso: d.iso || admCodes[d.code] || null })),
      total: dept.reduce((s, d) => s + d.n, 0),
      topMunicipios: municipios,
    },
    datasets,
    problems,
    disclaimer: DISCLAIMER,
  };
}

async function fetchCategory(key, ds, months) {
  for (const ym of months) {
    const rows = await getRows(soql(ds.id, {
      select: `${ds.group},sum(cantidad::number) as n`,
      where: `codigo_dane='${FOCUS.code8}' AND fecha_hecho like '${likeMonth(ym)}'`,
      group: ds.group,
      order: 'n DESC',
      limit: '40',
    }));
    if (rows.length) return { month: ym, ...parseCategory(rows, ds.group), unit: ds.unit || 'count', dataset: ds.id, name: ds.name };
  }
  return { month: null, rows: [], total: 0, distinct: 0, unit: ds.unit || 'count', dataset: ds.id, name: ds.name };
}

let _cache = null;
let _cacheTs = 0;

export async function fetchColombiaOpenData(admCodes = {}) {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const datasets = [];
  const mark = (key, extra) => datasets.push({ key, id: DATASETS[key].id, name: DATASETS[key].name, url: `https://www.datos.gov.co/d/${DATASETS[key].id}`, ...extra });

  let monthly = [], dept = [], municipios = [];
  const since = new Date(now); since.setUTCMonth(since.getUTCMonth() - (MONTHS_BACK + 1)); since.setUTCDate(1);
  try {
    monthly = parseMonthly(await getRows(soql(DATASETS.theft.id, {
      select: 'date_trunc_ym(fecha_hecho) as m,sum(cantidad) as n',
      where: `cod_muni='${FOCUS.code5}' AND fecha_hecho >= '${since.toISOString().slice(0, 10)}T00:00:00.000'`,
      group: 'm', order: 'm',
    })));
    if (!monthly.length) throw new Error('no Bogotá rows returned');
    const ym = monthly[monthly.length - 1].month;
    const win = `fecha_hecho >= '${monthStart(ym)}' AND fecha_hecho < '${nextMonthStart(ym)}'`;
    const [deptRows, muniRows] = await Promise.all([
      getRows(soql(DATASETS.theft.id, { select: 'cod_depto,departamento,sum(cantidad) as n', where: win, group: 'cod_depto,departamento', order: 'n DESC' })),
      getRows(soql(DATASETS.theft.id, { select: 'cod_muni,municipio,departamento,sum(cantidad) as n', where: win, group: 'cod_muni,municipio,departamento', order: 'n DESC', limit: '12' })),
    ]);
    dept = parseDept(deptRows, admCodes);
    municipios = parseMunicipios(muniRows);
    mark('theft', { status: 'live', month: ym, rows: monthly.length, error: null });
  } catch (err) {
    console.log(`[${SOURCE}] theft: ${err.message}`);
    mark('theft', { status: 'unavailable', month: null, rows: 0, error: str(err.message, 160) });
  }

  // Category tables lag the theft table by a month or so: try the theft month, then the two before it.
  const base = monthly.length ? monthly[monthly.length - 1].month : monthKey(new Date(now).toISOString());
  const months = [base, prevMonth(base), prevMonth(prevMonth(base))].filter(Boolean);
  const categories = {};
  for (const key of ['modalities', 'arrests', 'drugs', 'weapons', 'threats']) {
    try {
      const c = await fetchCategory(key, DATASETS[key], months);
      categories[key] = c;
      mark(key, { status: c.rows.length ? 'live' : 'empty', month: c.month, rows: c.rows.length, error: c.rows.length ? null : `no Bogotá rows for ${months.join(' / ')}` });
    } catch (err) {
      console.log(`[${SOURCE}] ${key}: ${err.message}`);
      categories[key] = { month: null, rows: [], total: 0, distinct: 0, unit: DATASETS[key].unit || 'count', dataset: DATASETS[key].id, name: DATASETS[key].name };
      mark(key, { status: 'unavailable', month: null, rows: 0, error: str(err.message, 160) });
    }
  }

  const result = buildResult({ monthly, dept, municipios, categories, datasets, admCodes });
  if (result.status === 'unavailable' && _cache) {
    const ageH = (now - _cacheTs) / 3600000;
    return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): datos.gov.co unreachable` };
  }
  if (result.status !== 'unavailable') { _cache = result; _cacheTs = now; }
  return result;
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }

export async function briefing() {
  return fetchColombiaOpenData(countryConfig('co').admCodes || {});
}

export default briefing;
