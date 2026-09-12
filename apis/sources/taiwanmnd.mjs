// Taiwan MND daily "PLA activities in the waters and airspace around Taiwan" bulletin
// (official count of PLA aircraft sorties, ADIZ entries, PLAN ships, official ships, balloons)
// cross-checked against Skyfaring's PLA Tracker CSV, a CC BY 4.0 daily mirror of the same bulletins.
//
// Both sources are counts, not tracks. Nothing here says where an aircraft or ship was — the
// only geometry is the ADIZ sector badge, which is a label on a sector, not a position.
//
// MND: Taiwan Open Government Data License v1.0 (attribution required). Its robots.txt disallows
// generic crawling, so the adapter identifies itself, fetches the list page at most hourly, and
// fetches an article only when the newest list entry changes (≈2 article GETs per day).

import { safeFetch } from '../utils/fetch.mjs';
import { decodeEntities, stripTags } from '../utils/rss.mjs';
import { parseCsvRows, toIso } from './iranwarlive.mjs';

export const SOURCE = 'TaiwanMND';
export const PROVIDER = 'Ministry of National Defense, R.O.C. (Taiwan)';
export const MND_ORIGIN = 'https://www.mnd.gov.tw';
export const MND_EN_LIST_URL = `${MND_ORIGIN}/en/news/PlaactList`;
export const MND_ZH_LIST_URL = `${MND_ORIGIN}/news/plaactlist`;
export const MND_LICENSE_URL = 'https://data.gov.tw/license';
export const SKYFARING_CSV_URL = 'https://pla-tracker.skyfaring.net/data/records.csv';
export const SKYFARING_SITE_URL = 'https://pla-tracker.skyfaring.net/en/about';
export const SKYFARING_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

export const DISCLAIMER = [
  'MND counts are the R.O.C. Ministry of National Defense\u2019s own tally for a 06:00\u201306:00 (UTC+8) window; they are counts, not positions.',
  'ADIZ sector badges mark the sector MND named, not a track. No aircraft or ship in this panel has a known location.',
  'Skyfaring\u2019s CSV mirrors the same bulletins and is used only to cross-check the day\u2019s numbers and build the 30-day trend. Its derived intensity index is not shown.',
  'A day missing from either source is left blank \u2014 never interpolated.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard; ~2 fetches/day)' };
const CACHE_TTL_MS = 30 * 60 * 1000;
const LIST_RECHECK_MS = 60 * 60 * 1000;
const MND_TIMEOUT_MS = 60 * 1000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const TREND_DAYS = 30;
export const FRESH_AFTER_H = 30;   // bulletin for "today" appears ~09:00 UTC+8; older than 30 h means a day was missed
export const STALE_AFTER_H = 54;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

// Sector vocabulary MND uses in the English bulletin. Badge anchors are label positions in the
// R.O.C. ADIZ (roughly matching MND's own published sketch), not aircraft positions.
export const ADIZ_SECTORS = {
  north: { key: 'north', label: 'Northern', lat: 26.6, lon: 121.6, patterns: /north(?:ern)?/i },
  central: { key: 'central', label: 'Central', lat: 24.7, lon: 119.4, patterns: /centr(?:al)?/i },
  southwest: { key: 'southwest', label: 'Southwestern', lat: 21.9, lon: 118.3, patterns: /south-?west(?:ern)?/i },
  east: { key: 'east', label: 'Eastern', lat: 23.2, lon: 123.2, patterns: /(?<!south-?)\beast(?:ern)?/i },
  southeast: { key: 'southeast', label: 'Southeastern', lat: 21.6, lon: 122.3, patterns: /south-?east(?:ern)?/i },
};

function text(html) {
  return stripTags(decodeEntities(String(html ?? ''))).replace(/\s+/g, ' ').trim();
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isoDate(y, m0, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m0) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, m0, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m0 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// <base href="/en/"> on the article pages; hrefs like "File/59160" resolve against it.
export function baseHref(html) {
  const m = String(html ?? '').match(/<base\s+href=["']([^"']+)["']/i);
  return m ? m[1] : '/';
}

export function resolveMndUrl(href, html) {
  try {
    const u = new URL(String(href ?? '').trim(), new URL(baseHref(html), MND_ORIGIN));
    return u.origin === MND_ORIGIN ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------- list pages ----------

// English list: <a href="/en/News/PLAAct/87739" class="news_list"><div class="date">2026.09.11</div><h2>PLA activities …</h2></a>
export function parseEnList(html) {
  const out = [];
  const re = /<a\s+href="([^"]*\/News\/PLAAct\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const inner = m[3];
    const d = inner.match(/(\d{4})\.(\d{2})\.(\d{2})/);
    const date = d ? isoDate(+d[1], +d[2] - 1, +d[3]) : null;
    const title = text((inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
    if (!date) continue;
    out.push({ id: m[2], url: resolveMndUrl(m[1], html), date, title: title.slice(0, 120) });
    if (out.length >= 40) break;
  }
  return out;
}

// Chinese list: dates are ROC-era "115.09.11"; hrefs are relative ("news/plaact/87738") against <base href="/">
export function parseZhList(html) {
  const out = [];
  const re = /<a\s+href="([^"]*news\/plaact\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const inner = m[3];
    const d = inner.match(/class="date[^"]*"[^>]*>\s*(\d{2,3})[./](\d{1,2})[./](\d{1,2})/);
    const date = d ? isoDate(+d[1] + 1911, +d[2] - 1, +d[3]) : null;
    if (!date) continue;
    const title = text((inner.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/(?:div|h2)>/i) || [])[1]);
    out.push({ id: m[2], url: resolveMndUrl(m[1], html), date, title: title.slice(0, 120) });
    if (out.length >= 40) break;
  }
  return out;
}

// ---------- English article ----------

function countOf(src, re) {
  const m = src.match(re);
  return m ? Number(m[1]) : null;
}

export function parseSectors(phrase) {
  const found = [];
  const s = String(phrase ?? '');
  for (const sec of Object.values(ADIZ_SECTORS)) {
    if (sec.patterns.test(s) && !found.includes(sec.key)) found.push(sec.key);
  }
  // "southwestern" also matches the /south-?west/ pattern only; "eastern" alone must not be swallowed by "southeastern"
  return found;
}

// "6 a.m. Sep. 10 (Thu.) to 6 a.m. Sep. 11 (Fri.) (UTC+8)" → { start, end } as ISO (UTC+8 → UTC)
export function parseWindow(dateLine, publishedDate) {
  const s = String(dateLine ?? '');
  const re = /(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\s+([A-Za-z]{3,5})\.?\s+(\d{1,2})/gi;
  const parts = [];
  let m;
  while ((m = re.exec(s)) !== null && parts.length < 2) {
    let h = Number(m[1]) % 12;
    if (/^p/i.test(m[2])) h += 12;
    const mon = MONTHS[m[3].toLowerCase()];
    if (mon === undefined) continue;
    parts.push({ h, mon, day: Number(m[4]) });
  }
  if (parts.length < 2 || !publishedDate) return { start: null, end: null };
  const pubY = Number(publishedDate.slice(0, 4));
  // The bulletin is published on the window's end day. Start year steps back across New Year.
  const endY = pubY;
  const startY = parts[0].mon > parts[1].mon ? pubY - 1 : pubY;
  const mk = (y, p) => {
    const t = Date.UTC(y, p.mon, p.day, p.h - 8, 0, 0);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  return { start: mk(startY, parts[0]), end: mk(endY, parts[1]) };
}

export function parseEnArticle(html, meta = {}) {
  const src = String(html ?? '');
  const body = text(src);
  const problems = [];
  const pubMatch = body.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  const publishedDate = meta.date || (pubMatch ? isoDate(+pubMatch[1], +pubMatch[2] - 1, +pubMatch[3]) : null);

  const dateLine = (body.match(/1\s*\.\s*Date\s*:?\s*(.*?)(?=2\s*\.\s*PLA|$)/i) || [])[1] || '';
  const actLine = (body.match(/2\s*\.\s*PLA activit(?:y|ies)\s*:?\s*(.*?)(?=\s*(?:3\s*\.|Keywords?|Share|Issuing|$))/i) || [])[1] || body;
  const window = parseWindow(dateLine, publishedDate);
  if (!window.end) problems.push('reporting window not parsed');

  let aircraft = countOf(actLine, /(\d+)\s+sorties?\s+of\s+PLA\s+aircraft/i);
  if (aircraft === null && /no\s+PLA\s+aircraft/i.test(actLine)) aircraft = 0;
  let planShips = countOf(actLine, /(\d+)\s+PLAN\s+(?:ship|vessel|warship)s?/i);
  if (planShips === null && /no\s+PLAN\s+(?:ship|vessel)/i.test(actLine)) planShips = 0;
  let officialShips = countOf(actLine, /(\d+)\s+official\s+(?:ship|vessel)s?/i);
  if (officialShips === null && /no\s+official\s+(?:ship|vessel)/i.test(actLine)) officialShips = 0;
  const balloons = countOf(actLine, /(\d+)\s+(?:PRC\s+|PLA\s+)?balloons?/i);

  let adizEntries = null;
  let sectors = [];
  const adiz = actLine.match(/(\d+)\s+(?:out\s+of\s+(\d+)\s+)?sorties?\s+(?:entered|crossed\s+into|flew\s+into)\s+(?:Taiwan[\u2019']s\s+)?(.*?)\s*ADIZ/i);
  if (adiz) {
    adizEntries = Number(adiz[1]);
    sectors = parseSectors(adiz[3]);
    if (adiz[2] && aircraft !== null && Number(adiz[2]) !== aircraft) problems.push(`ADIZ phrase total ${adiz[2]} differs from sortie count ${aircraft}`);
  } else if (aircraft === 0) {
    adizEntries = 0;
  } else if (/entered\s+Taiwan[\u2019']s?\s+ADIZ/i.test(actLine) && aircraft !== null) {
    // "All 4 sorties entered Taiwan's ADIZ" style
    adizEntries = aircraft;
  }
  if (aircraft === null) problems.push('aircraft sortie count not parsed');
  if (planShips === null) problems.push('PLAN ship count not parsed');

  return {
    publishedDate,
    articleUrl: meta.url || null,
    articleId: meta.id || null,
    windowStart: window.start,
    windowEnd: window.end,
    aircraft,
    adizEntries,
    sectors,
    planShips,
    officialShips,
    balloons,
    activityText: text(actLine).slice(0, 400),
    problems,
  };
}

// ---------- Chinese article (map + cross-check numbers) ----------

// The Chinese bulletin carries the download box with the sketch map ("…活動示意圖", JPG).
export function parseZhArticle(html, meta = {}) {
  const src = String(html ?? '');
  const body = text(src);
  const files = [];
  const chunks = src.split(/<div class="downloaditems">/i).slice(1, 9);
  for (const chunk of chunks) {
    const block = chunk.split(/<div class="downloaditems">|<\/div>\s*<\/div>\s*<\/div>/i)[0];
    const href = (block.match(/<a\s+href="([^"]*File\/\d+)"/i) || [])[1];
    const label = text((block.match(/download-text[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    const alt = decodeEntities((block.match(/alt="([^"]*)"/g) || []).join(' '));
    if (!href) continue;
    files.push({ url: resolveMndUrl(href, src), label: label.slice(0, 80), isMap: /示意圖/.test(label + alt), isImage: /JPG|JPEG|PNG/i.test(alt) });
  }
  const map = files.find(f => f.isMap && f.url) || null;
  const rocDate = body.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日（星期.）0?600時止/) || body.match(/至\s*(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  const publishedDate = meta.date || (rocDate ? isoDate(+rocDate[1] + 1911, +rocDate[2] - 1, +rocDate[3]) : null);
  const aircraft = countOf(body, /共機\s*(\d+)\s*架次/);
  const adizEntries = countOf(body, /進入[^）]*?空域共\s*(\d+)\s*架次/) ?? countOf(body, /逾越中線[^）]*?(\d+)\s*架次/);
  const planShips = countOf(body, /共艦\s*(\d+)\s*艘/);
  const officialShips = countOf(body, /公務船\s*(\d+)\s*艘/);
  const balloons = countOf(body, /(?:空飄)?氣球\s*(\d+)\s*枚/);
  return {
    publishedDate,
    articleUrl: meta.url || null,
    articleId: meta.id || null,
    mapUrl: map?.url || null,
    mapLabel: map?.label || null,
    files: files.filter(f => f.url).map(f => ({ url: f.url, label: f.label })),
    aircraft, adizEntries, planShips, officialShips, balloons,
  };
}

// ---------- Skyfaring CSV ----------

// Live header: date,aircraft_total,median_line_cross,cross_rate,aircraft_type,ships_total,activity_start,activity_end,special_event
export function parseSkyfaringCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (!rows.length) return { rows: [], problems: ['empty CSV'] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const iDate = col('date'), iAir = col('aircraft_total'), iCross = col('median_line_cross'), iShips = col('ships_total');
  const iType = col('aircraft_type'), iRate = col('cross_rate'), iEvent = col('special_event');
  const problems = [];
  if (iDate < 0 || iAir < 0) return { rows: [], problems: ['CSV header lacks date/aircraft_total'] };
  if (iCross < 0) problems.push('CSV header lacks median_line_cross');
  if (iShips < 0) problems.push('CSV header lacks ships_total');
  const byDate = new Map();
  for (const r of rows.slice(1)) {
    const date = String(r[iDate] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const n = i => {
      if (i < 0) return null;
      const v = String(r[i] ?? '').trim();
      if (v === '') return null;
      const x = Number(v);
      return Number.isFinite(x) && x >= 0 && x < 10000 ? x : null;
    };
    const rec = byDate.get(date) || { date, aircraft: null, medianLineCross: null, ships: null, crossRate: null, types: [], note: '' };
    // Some days have one row per aircraft_type (Manned / UAV); totals are summed, the median-line count too.
    // median_line_cross is sorties that crossed the Strait median line — a subset of ADIZ entries, not the same number.
    const air = n(iAir), cross = n(iCross), ships = n(iShips);
    if (air !== null) rec.aircraft = (rec.aircraft ?? 0) + air;
    if (cross !== null) rec.medianLineCross = (rec.medianLineCross ?? 0) + cross;
    if (ships !== null) rec.ships = rec.ships === null ? ships : Math.max(rec.ships, ships);
    const rate = n(iRate);
    if (rate !== null) rec.crossRate = rate;
    const ty = iType >= 0 ? String(r[iType] ?? '').trim().slice(0, 20) : '';
    if (ty && !rec.types.includes(ty)) rec.types.push(ty);
    const ev = iEvent >= 0 ? String(r[iEvent] ?? '').trim().slice(0, 120) : '';
    if (ev && !rec.note) rec.note = ev;
    byDate.set(date, rec);
  }
  const out = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { rows: out, problems };
}

export function buildTrend(skyRows, days = TREND_DAYS, now = Date.now()) {
  const end = new Date(now);
  const out = [];
  const byDate = new Map((skyRows || []).map(r => [r.date, r]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const r = byDate.get(key);
    out.push(r ? { date: key, aircraft: r.aircraft, medianLineCross: r.medianLineCross, ships: r.ships } : { date: key, aircraft: null, medianLineCross: null, ships: null });
  }
  return out;
}

// Compare the same day's numbers (aircraft, ships). Skyfaring's median_line_cross is not MND's ADIZ-entry
// count, so it is not compared. Missing on one side is "unconfirmed", not a disagreement.
export function crossCheck(mnd, skyRow) {
  if (!mnd || !mnd.publishedDate) return { state: 'none', detail: 'no MND bulletin' };
  if (!skyRow) return { state: 'unconfirmed', detail: `Skyfaring has no row for ${mnd.publishedDate} yet` };
  const diffs = [];
  const cmp = (label, a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return;
    if (Number(a) !== Number(b)) diffs.push(`${label} MND ${a} vs Skyfaring ${b}`);
  };
  cmp('aircraft', mnd.aircraft, skyRow.aircraft);
  if (mnd.planShips !== null && mnd.planShips !== undefined && skyRow.ships !== null && skyRow.ships !== undefined) {
    // Skyfaring's ships_total may fold official ships in with PLAN hulls; accept either reading.
    const total = mnd.planShips + (mnd.officialShips || 0);
    if (Number(skyRow.ships) !== mnd.planShips && Number(skyRow.ships) !== total) diffs.push(`ships MND ${mnd.planShips}+${mnd.officialShips || 0} vs Skyfaring ${skyRow.ships}`);
  }
  return diffs.length ? { state: 'disagree', detail: diffs.join('; ') } : { state: 'agree', detail: `Skyfaring row ${skyRow.date} matches` };
}

// ---------- assembly ----------

export function buildResult({ enList, en, zh, sky, fetchedAt = new Date().toISOString(), errors = {} }) {
  const problems = [];
  const parts = {};
  parts.mndList = enList?.length ? 'ok' : 'error';
  parts.mndEn = en && !errors.mndEn ? 'ok' : 'error';
  parts.mndZh = zh && !errors.mndZh ? 'ok' : 'error';
  parts.skyfaring = sky?.rows?.length ? 'ok' : 'error';
  for (const [k, v] of Object.entries(errors)) if (v) problems.push(`${k}: ${String(v).slice(0, 140)}`);
  if (en?.problems?.length) problems.push(...en.problems.map(p => `MND EN: ${p}`));
  if (sky?.problems?.length) problems.push(...sky.problems.map(p => `Skyfaring: ${p}`));

  const skyRows = sky?.rows || [];
  const today = skyRows.length ? skyRows[skyRows.length - 1] : null;
  const skyForDay = en?.publishedDate ? skyRows.find(r => r.date === en.publishedDate) || null : null;
  const check = crossCheck(en, skyForDay);
  if (check.state === 'disagree') problems.push(`cross-check: ${check.detail}`);

  // Pair EN/ZH by date, never by id.
  let zhPaired = null;
  if (zh && en && zh.publishedDate && zh.publishedDate === en.publishedDate) zhPaired = zh;
  else if (zh && en && zh.publishedDate && zh.publishedDate !== en.publishedDate) problems.push(`Chinese bulletin is for ${zh.publishedDate}, English for ${en.publishedDate}; map not paired`);
  if (zhPaired) {
    const cmp = (label, a, b) => { if (a !== null && b !== null && a !== undefined && b !== undefined && a !== b) problems.push(`EN/ZH mismatch ${label}: ${a} vs ${b}`); };
    cmp('aircraft', en.aircraft, zhPaired.aircraft);
    cmp('PLAN ships', en.planShips, zhPaired.planShips);
    cmp('official ships', en.officialShips, zhPaired.officialShips);
  }

  const bulletin = en ? {
    ...en,
    mapUrl: zhPaired?.mapUrl || null,
    zhArticleUrl: zhPaired?.articleUrl || null,
    zhAircraft: zhPaired?.aircraft ?? null,
    zhAdizEntries: zhPaired?.adizEntries ?? null,
    crossCheck: check,
  } : null;

  const bulletinAgeH = bulletin?.publishedDate ? (Date.parse(fetchedAt) - Date.parse(bulletin.publishedDate + 'T01:00:00Z')) / 3600000 : null;
  const trend = buildTrend(skyRows, TREND_DAYS, Date.parse(fetchedAt));
  const have = trend.filter(t => t.aircraft !== null);
  const sum = k => have.reduce((s, t) => s + (t[k] || 0), 0);
  const stats = {
    daysWithData: have.length,
    aircraft30d: sum('aircraft'),
    medianCross30d: sum('medianLineCross'),
    avgAircraft: have.length ? +(sum('aircraft') / have.length).toFixed(1) : null,
    maxAircraft: have.length ? Math.max(...have.map(t => t.aircraft)) : null,
    maxAircraftDate: have.length ? have.reduce((a, b) => (b.aircraft > a.aircraft ? b : a)).date : null,
    avgShips: have.filter(t => t.ships !== null).length ? +(have.reduce((s, t) => s + (t.ships || 0), 0) / have.filter(t => t.ships !== null).length).toFixed(1) : null,
  };

  let status;
  if (!bulletin && !skyRows.length) status = 'unavailable';
  else if (!bulletin) status = 'limited';               // Skyfaring only — MND unreachable
  else if (!skyRows.length) status = 'limited';         // MND only — no cross-check/trend
  else if (check.state === 'disagree') status = 'limited';
  else if (bulletinAgeH !== null && bulletinAgeH > STALE_AFTER_H) status = 'stale';
  else status = 'live';
  if (bulletin && bulletinAgeH !== null && bulletinAgeH > FRESH_AFTER_H && status === 'live') {
    problems.push(`latest MND bulletin is ${bulletinAgeH.toFixed(0)} h old`);
    status = 'limited';
  }

  return {
    source: SOURCE,
    timestamp: fetchedAt,
    fetchedAt,
    status,
    error: status === 'unavailable' ? (problems[0] || 'MND and Skyfaring both unreachable') : null,
    provider: PROVIDER,
    siteUrl: MND_EN_LIST_URL,
    licenseUrl: MND_LICENSE_URL,
    skyfaring: { siteUrl: SKYFARING_SITE_URL, csvUrl: SKYFARING_CSV_URL, licenseUrl: SKYFARING_LICENSE_URL, latestDate: today?.date || null, rows: skyRows.length },
    parts,
    problems: problems.slice(0, 12),
    bulletin,
    bulletinAgeH: bulletinAgeH === null ? null : +bulletinAgeH.toFixed(1),
    recentBulletins: (enList || []).slice(0, 7).map(e => ({ date: e.date, url: e.url, id: e.id })),
    trend,
    stats,
    sectors: Object.values(ADIZ_SECTORS).map(s => ({ key: s.key, label: s.label, lat: s.lat, lon: s.lon, named: Boolean(bulletin?.sectors?.includes(s.key)) })),
    disclaimer: DISCLAIMER,
  };
}

// ---------- network ----------

let _cache = null;
let _cacheTs = 0;
let _mnd = { listCheckedAt: 0, enList: [], en: null, zh: null, errors: {} };

async function fetchHtml(url) {
  const r = await safeFetch(url, { timeout: MND_TIMEOUT_MS, retries: 0, headers: { ...HEADERS, Accept: 'text/html' } });
  if (r?.error) throw new Error(r.error);
  const html = typeof r?.rawText === 'string' ? r.rawText : '';
  if (!html) throw new Error('empty HTML body');
  if (html.length > MAX_HTML_BYTES) throw new Error('HTML body too large');
  return html;
}

async function refreshMnd(now) {
  if (now - _mnd.listCheckedAt < LIST_RECHECK_MS) return _mnd;
  const errors = {};
  let enList = _mnd.enList;
  try {
    enList = parseEnList(await fetchHtml(MND_EN_LIST_URL));
    if (!enList.length) errors.mndList = 'English list page parsed to zero entries';
  } catch (e) { errors.mndList = e.message; }
  const newest = enList[0];
  let en = _mnd.en, zh = _mnd.zh;
  if (newest && newest.url && newest.id !== _mnd.en?.articleId) {
    try { en = parseEnArticle(await fetchHtml(newest.url), newest); } catch (e) { errors.mndEn = e.message; }
    try {
      const zhList = parseZhList(await fetchHtml(MND_ZH_LIST_URL));
      const zhEntry = zhList.find(z => z.date === newest.date && z.url);
      if (zhEntry) zh = parseZhArticle(await fetchHtml(zhEntry.url), zhEntry);
      else errors.mndZh = `no Chinese bulletin dated ${newest.date} in list`;
    } catch (e) { errors.mndZh = e.message; }
  }
  _mnd = { listCheckedAt: now, enList, en, zh, errors };
  return _mnd;
}

async function fetchSkyfaring() {
  const r = await safeFetch(SKYFARING_CSV_URL, { timeout: 20000, headers: { ...HEADERS, Accept: 'text/csv, text/plain, */*' } });
  if (r?.error) throw new Error(r.error);
  const csv = typeof r?.rawText === 'string' ? r.rawText : '';
  if (!csv) throw new Error('empty CSV body');
  if (csv.length > MAX_CSV_BYTES) throw new Error('CSV too large');
  return parseSkyfaringCsv(csv);
}

function staleCopy() {
  const ageH = (Date.now() - _cacheTs) / 3600000;
  return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : (_cache.status === 'live' ? 'limited' : _cache.status), cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
}

export async function fetchTaiwanMnd() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  try {
    const [mnd, skyRes] = await Promise.all([
      refreshMnd(now),
      fetchSkyfaring().then(v => ({ ok: v })).catch(e => ({ err: e.message })),
    ]);
    const errors = { ...mnd.errors };
    if (skyRes.err) errors.skyfaring = skyRes.err;
    const result = buildResult({ enList: mnd.enList, en: mnd.en, zh: mnd.zh, sky: skyRes.ok || null, errors });
    if (result.status === 'unavailable') {
      console.log(`[TaiwanMND] ${result.error}`);
      return _cache ? staleCopy() : result;
    }
    _cache = result;
    _cacheTs = now;
    return result;
  } catch (err) {
    console.log(`[TaiwanMND] fetch error: ${err.message}`);
    return _cache ? staleCopy() : buildResult({ enList: [], en: null, zh: null, sky: null, errors: { fetch: err.message } });
  }
}

export function _resetCacheForTests() {
  _cache = null; _cacheTs = 0;
  _mnd = { listCheckedAt: 0, enList: [], en: null, zh: null, errors: {} };
}

export async function briefing() {
  return fetchTaiwanMnd();
}

export default briefing;
