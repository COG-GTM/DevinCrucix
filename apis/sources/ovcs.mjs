// Observatorio Venezolano de Conflictividad Social (OVCS): monthly protest tallies parsed from the
// public WordPress REST copy of its "Conflictividad social en Venezuela en <mes> de <año>" reports
// (bounded numbers only — total protests, daily average, year-on-year change, DESCA share,
// repressed protests), plus the SIGCO 2017 protest-deaths Google My Maps layer mirrored as
// HISTORICAL points with names withheld (date + coordinates only).

import { safeFetch } from '../utils/fetch.mjs';
import { stripTags } from '../utils/rss.mjs';
import { cleanText, httpUrl, toIso, toCoord } from './iranwarlive.mjs';

export const SOURCE = 'OVCS';
export const SITE = 'https://www.observatoriodeconflictos.org.ve/';
export const REPORTS_URL = 'https://www.observatoriodeconflictos.org.ve/wp-json/wp/v2/posts?search=Conflictividad%20social%20en%20Venezuela&per_page=10&_fields=id,date_gmt,link,title,content';
export const SIGCO_KML_URL = 'https://www.google.com/maps/d/kml?mid=1DMMP3SLmOw1nwK_CyRaseG0Ayfs&forcekml=1';
export const SIGCO_PAGE = 'https://www.observatoriodeconflictos.org.ve/sigco';
export const DISCLAIMER = [
  'Monthly figures are OVCS counts as published in its own reports; CRUCIX extracts the headline numbers and links the report.',
  'The 2017 SIGCO layer is historical (protest deaths documented by OVCS); victim names are not stored or shown.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };
const CACHE_TTL_MS = 6 * 3600 * 1000;
const KML_TTL_MS = 24 * 3600 * 1000;
const STALE_AFTER_D = 75; // a monthly report older than ~2.5 months means the series has gone quiet
const MAX_KML_BYTES = 4 * 1024 * 1024;
export const MAX_MONTHS = 12;

const MONTHS_ES = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06', julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };

const int = (s) => { const n = Number(String(s ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

export function reportPeriod(title) {
  const t = stripTags(title).toLowerCase();
  const m = t.match(/conflictividad social en venezuela (?:en|durante) (?:el mes de )?([a-záéíóú]+) de (\d{4})/);
  if (m && MONTHS_ES[m[1]]) return { kind: 'month', month: `${m[2]}-${MONTHS_ES[m[1]]}` };
  const p = t.match(/conflictividad social en venezuela (?:en|durante) (?:el )?(?:(?:primer|segundo|tercer|cuarto) )?(?:semestre|trimestre)[^\d]*(\d{4})/) || t.match(/conflictividad social en venezuela (?:en|durante) (?:el año )?(\d{4})$/);
  if (p) return { kind: 'period', label: cleanText(title, 120), year: p[1] };
  return null;
}

// Pulls the headline numbers out of a report body, sentence by sentence so a figure is only taken
// from the sentence that states it. Every field is optional; null means "not stated".
const WORD_NUM = { una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const COUNT_RE = /(?:document[oó]|documentaron|registr[oó]|registraron|contabiliz[oó]|contabilizaron)\s+([\d.]+)\s+(?:protestas|manifestaciones|acciones)/i;
const sentences = (html) => stripTags(html).replace(/\s+/g, ' ').split(/\.\s+(?=[A-ZÁÉÍÓÚ¿¡"“(])/);
const firstNum = (s, re) => { const m = s.match(re); return m ? int(m[1]) : null; };
const pctIn = (s) => { const m = s.match(/(\d{1,3}(?:[.,]\d)?)\s*%/); return m ? int(m[1]) : null; };

const SHARE_NUM = /([\d.]+)\s+(?:protestas|manifestaciones|acciones|estuvieron|fueron)/gi;
function rightsShare(sents, re) {
  const s = sents.find(x => re.test(x) && /(?:protestas|manifestaciones)/i.test(x) && /%/.test(x));
  if (!s) return { n: null, pct: null };
  const kw = s.search(re);
  let before = null, after = null;
  for (const m of s.matchAll(SHARE_NUM)) {
    if (m.index < kw) before = m[1];
    else if (after === null && /protestas|manifestaciones|acciones/i.test(m[0])) after = m[1];
  }
  return { n: int(before ?? after), pct: pctIn(s) };
}

export function parseReportNumbers(html) {
  const sents = sentences(html);
  const totalIdx = sents.findIndex(s => COUNT_RE.test(s));
  const totalS = totalIdx >= 0 ? sents[totalIdx] : '';
  const nextS = totalIdx >= 0 ? sents[totalIdx + 1] || '' : '';
  const perDayS = /diari/i.test(totalS) ? totalS : nextS;
  const yoyS = [totalS, nextS, sents[totalIdx + 2] || ''].find(s => /(aumento|incremento|disminuci[oó]n|reducci[oó]n|descenso)\s+de(?:l)?\s+[\d.,]+\s*%/i.test(s)) || '';
  const yoy = yoyS.match(/(aumento|incremento|disminuci[oó]n|reducci[oó]n|descenso)\s+de(?:l)?\s+([\d.,]+)\s*%/i);
  const yoyBase = yoyS.match(/cuando se (?:registraron|documentaron)\s+([\d.]+)/i);
  const desca = rightsShare(sents, /\bDESCA\b|Derechos Econ[oó]micos/i);
  const dcp = rightsShare(sents, /\bDCP\b|Derechos Civiles y Pol[ií]ticos/i);
  const repS = sents.find(s => /reprimid/i.test(s) && /(?:protestas|manifestaciones)/i.test(s)) || '';
  const rep = repS.match(/reprimid\w*\s+([\d.]+|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:protestas|manifestaciones)/i) || repS.match(/([\d.]+)\s+(?:protestas|manifestaciones)\s+(?:fueron\s+)?reprimid/i);
  const yoyPct = yoy ? int(yoy[2]) : null;
  return {
    protests: totalIdx >= 0 ? firstNum(totalS, COUNT_RE) : null,
    perDay: firstNum(perDayS, /([\d.]+)\s+(?:manifestaciones|protestas|acciones)?\s*diarias/i),
    yoyPct: yoyPct === null ? null : (/disminu|reducc|descenso/i.test(yoy[1]) ? -yoyPct : yoyPct),
    yoyBase: yoyBase ? int(yoyBase[1]) : null,
    desca: desca.n,
    descaPct: desca.pct,
    dcp: dcp.n,
    dcpPct: dcp.pct,
    repressed: rep ? (WORD_NUM[rep[1].toLowerCase()] ?? int(rep[1])) : null,
  };
}

export function parseReports(posts) {
  const monthly = [], periods = [];
  for (const p of Array.isArray(posts) ? posts : []) {
    const period = reportPeriod(p?.title?.rendered ?? '');
    if (!period) continue;
    const base = { title: cleanText(p?.title?.rendered, 120), url: httpUrl(p?.link), published: toIso(p?.date_gmt ? `${p.date_gmt}Z` : p?.date) };
    if (!base.url) continue;
    if (period.kind === 'month') {
      const nums = parseReportNumbers(p?.content?.rendered ?? '');
      if (nums.protests === null) continue;
      monthly.push({ month: period.month, ...base, ...nums });
    } else {
      periods.push({ ...base, year: period.year });
    }
  }
  const seen = new Set();
  const dedup = monthly.sort((a, b) => b.month.localeCompare(a.month)).filter(m => (seen.has(m.month) ? false : seen.add(m.month)));
  return { monthly: dedup.slice(0, MAX_MONTHS), periods: periods.slice(0, 6) };
}

// SIGCO KML: placemark names read "Nombre Apellido (edad) dd.mm.yy" — only the date is kept.
export function parseSigco(xml) {
  const text = String(xml ?? '');
  const docName = cleanText((text.match(/<Document>\s*<name>([\s\S]*?)<\/name>/i) || [])[1], 120) || 'SIGCO';
  const yearM = docName.match(/\b(20\d\d)\b/);
  const points = [];
  const re = /<Placemark(?:\s[^>]*)?>([\s\S]*?)<\/Placemark>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[1];
    const name = stripTags((block.match(/<name>([\s\S]*?)<\/name>/i) || [])[1] || '');
    const coords = (block.match(/<coordinates>([\s\S]*?)<\/coordinates>/i) || [])[1] || '';
    const [lonS, latS] = coords.trim().split(/\s+/)[0]?.split(',') || [];
    const lon = toCoord(lonS, 180), lat = toCoord(latS, 90);
    if (lon === null || lat === null) continue;
    const d = name.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    let date = null;
    if (d) {
      const yy = d[3].length === 2 ? `20${d[3]}` : d[3];
      const iso = `${yy}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
      date = Number.isFinite(Date.parse(iso)) ? iso : null;
    }
    const age = name.match(/\((\d{1,3})\)/);
    points.push({ lat, lon, date, age: age ? Number(age[1]) : null });
  }
  return { title: docName, year: yearM ? Number(yearM[1]) : null, count: points.length, points: points.slice(0, 400), url: SIGCO_PAGE, kml: SIGCO_KML_URL, kind: 'historical', note: 'Victim names withheld — date, age and location only.' };
}

export function buildResult({ reports, historical, errors = [] }, now = new Date().toISOString()) {
  const monthly = reports?.monthly || [];
  const latest = monthly[0] || null;
  const latestAgeD = latest?.published ? (Date.parse(now) - Date.parse(latest.published)) / 86400000 : null;
  let status;
  if (latest && latestAgeD !== null && latestAgeD > STALE_AFTER_D) status = 'stale';
  else if (latest) status = historical ? 'live' : 'limited';
  else if (historical) status = 'limited';
  else status = 'unavailable';
  return {
    source: SOURCE,
    timestamp: now,
    fetchedAt: now,
    status,
    error: status === 'unavailable' ? (errors[0] || 'OVCS unreachable') : (errors[0] || null),
    site: SITE,
    monthly,
    latest,
    latestAgeD: latestAgeD === null ? null : +latestAgeD.toFixed(1),
    periods: reports?.periods || [],
    historical: historical || null,
    problems: errors,
    disclaimer: DISCLAIMER,
  };
}

let _cache = null, _cacheTs = 0, _kml = null, _kmlTs = 0;

export async function fetchOvcs() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const errors = [];
  let reports = null, historical = null;
  try {
    const r = await safeFetch(REPORTS_URL, { timeout: 20000, headers: { ...HEADERS, Accept: 'application/json' } });
    if (r?.error) throw new Error(r.error);
    if (!Array.isArray(r)) throw new Error('unexpected WordPress REST body');
    reports = parseReports(r);
    if (!reports.monthly.length) errors.push('reports: no monthly report parsed');
  } catch (err) {
    console.log(`[OVCS] reports: ${err.message}`);
    errors.push(`reports: ${String(err.message).slice(0, 160)}`);
  }
  try {
    if (_kml && now - _kmlTs < KML_TTL_MS) historical = _kml;
    else {
      const r = await safeFetch(SIGCO_KML_URL, { timeout: 25000, headers: { ...HEADERS, Accept: 'application/vnd.google-earth.kml+xml, application/xml, */*' } });
      if (r?.error) throw new Error(r.error);
      const xml = typeof r?.rawText === 'string' ? r.rawText : '';
      if (!xml || xml.length > MAX_KML_BYTES) throw new Error(xml ? 'KML too large' : 'empty KML');
      historical = parseSigco(xml);
      if (!historical.count) throw new Error('no placemarks');
      _kml = historical; _kmlTs = now;
    }
  } catch (err) {
    console.log(`[OVCS] SIGCO: ${err.message}`);
    errors.push(`SIGCO: ${String(err.message).slice(0, 160)}`);
    historical = _kml;
  }
  const result = buildResult({ reports, historical, errors });
  if (result.status === 'unavailable' && _cache) {
    const ageH = (now - _cacheTs) / 3600000;
    return { ..._cache, stale: true, status: 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): OVCS unreachable` };
  }
  if (result.status !== 'unavailable') { _cache = result; _cacheTs = now; }
  return result;
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; _kml = null; _kmlTs = 0; }

export async function briefing() { return fetchOvcs(); }
export default briefing;
