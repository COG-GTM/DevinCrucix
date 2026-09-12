// Taiwan Coast Guard Administration (海巡署) press releases → grey-zone incident records.
//
// CGA publishes a plain RSS 2.0 feed of every press release (drownings, rescues, smuggling, awards…).
// Only the subset describing PRC actors — China Coast Guard (海警) hulls, official/research vessels,
// mainland fishing boats in restricted waters, or CGA rebuttals of CCG "patrol" claims — is kept.
// Each record carries the original Chinese title, the CGA link, and whatever structured detail
// the text states: CCG hull numbers, vessel count, area, entry/exit times, photo.
//
// Geometry is an *area centroid* (Kinmen, Matsu, Dongsha…), never a vessel position: the text says
// "restricted waters off Kinmen", not where the hull was. Anything a record does not state is null
// and the record is flagged partial rather than filled in.
//
// License: Taiwan Open Government Data License v1.0 (attribution required). Feed is fetched at most
// every 30 minutes with an identified User-Agent.

import { safeFetch } from '../utils/fetch.mjs';
import { parseFeed } from '../utils/rss.mjs';
import { cleanText, httpUrl, toIso } from './iranwarlive.mjs';

export const SOURCE = 'TaiwanCGA';
export const PROVIDER = 'Coast Guard Administration, Ocean Affairs Council, R.O.C. (Taiwan)';
export const FEED_URL = 'https://www.cga.gov.tw/GipOpen/wSite/rss?ctNode=650&mp=999';
export const SITE_URL = 'https://www.cga.gov.tw/GipOpen/wSite/mp?mp=999';
export const LICENSE_URL = 'https://data.gov.tw/license';

export const DISCLAIMER = [
  'Records are CGA press releases about PRC actors, machine-filtered from the full CGA feed; titles are the original Chinese.',
  'Markers sit on an area centroid (Kinmen, Matsu, Dongsha\u2026), not on a vessel. No track data exists in the source.',
  'Hull numbers, counts and times are only shown when the release states them; missing detail leaves the record PARTIAL.',
  'English gloss lines are rule-based summaries of extracted fields, not translations of the release.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_XML_BYTES = 6 * 1024 * 1024;
export const MAX_RECORDS = 60;
export const FRESH_AFTER_H = 24 * 10;   // CCG Kinmen intrusions run ~weekly; 10 days without one is unusual, not broken
export const STALE_AFTER_H = 24 * 45;

// Area centroids (approximate island/atoll centers). Radii are honest "somewhere in these waters" bounds.
export const AREAS = [
  { key: 'kinmen', zh: '金門', en: 'Kinmen', lat: 24.44, lon: 118.35, radiusKm: 25, re: /金門|金馬澎/ },
  { key: 'matsu', zh: '馬祖', en: 'Matsu', lat: 26.16, lon: 119.95, radiusKm: 30, re: /馬祖|連江|東引|莒光/ },
  { key: 'wuqiu', zh: '烏坵', en: 'Wuqiu', lat: 24.99, lon: 119.45, radiusKm: 20, re: /烏坵/ },
  { key: 'dongsha', zh: '東沙', en: 'Dongsha (Pratas)', lat: 20.70, lon: 116.73, radiusKm: 40, re: /東沙/ },
  { key: 'taiping', zh: '太平島', en: 'Taiping (Itu Aba)', lat: 10.38, lon: 114.37, radiusKm: 40, re: /太平島|南沙/ },
  { key: 'penghu', zh: '澎湖', en: 'Penghu', lat: 23.57, lon: 119.58, radiusKm: 40, re: /澎湖/ },
  { key: 'pengjia', zh: '彭佳嶼', en: 'Pengjia Islet', lat: 25.63, lon: 122.07, radiusKm: 30, re: /彭佳嶼/ },
  { key: 'diaoyutai', zh: '釣魚台', en: 'Diaoyutai / Senkaku', lat: 25.75, lon: 123.47, radiusKm: 40, re: /釣魚台|釣魚臺/ },
  { key: 'liuqiu', zh: '小琉球', en: 'Liuqiu (Lambai)', lat: 22.34, lon: 120.37, radiusKm: 30, re: /小琉球|琉球嶼/ },
  { key: 'green', zh: '綠島', en: 'Green Island', lat: 22.66, lon: 121.49, radiusKm: 30, re: /綠島|蘭嶼/ },
  { key: 'east', zh: '臺灣以東', en: 'East of Taiwan', lat: 23.4, lon: 122.6, radiusKm: 120, re: /臺灣(?:島)?以東|台灣(?:島)?以東|臺灣東部海域|東部海域|花蓮|臺東|台東|宜蘭/ },
  { key: 'north', zh: '臺灣北部', en: 'North of Taiwan', lat: 25.6, lon: 121.6, radiusKm: 80, re: /北部海域|基隆|新北|淡水/ },
  { key: 'southwest', zh: '臺灣西南', en: 'Southwest Taiwan', lat: 22.3, lon: 119.9, radiusKm: 80, re: /西南海域|高雄|屏東|鵝鑾鼻|臺灣海峽南口|台灣海峽南口/ },
  { key: 'strait', zh: '臺灣海峽', en: 'Taiwan Strait', lat: 24.4, lon: 119.6, radiusKm: 120, re: /臺灣海峽|台灣海峽|海峽中線|新竹|苗栗|臺中|台中|彰化|雲林|嘉義|臺南|台南/ },
];

const TITLE_ENTITY = /海警|中國|中共|大陸|陸船|陸籍|公務船|科研船|調查船|海事局|解放軍|共軍|共艦|灰帶|灰色地帶|越界|認知作戰/;
const ACTION = /侵擾|襲擾|騷擾|驅離|越界|闖|灰色地帶|灰帶|限制水域|禁止水域|鄰接區|執法巡查|常態化|巡查|監控|澄清|駁斥|偵搜|抽砂|海上民兵|交通管制|軍演|演習|封鎖|臨檢|登檢|扣押/;
const EXCLUDE_TITLE = /產製品|參訪|訪團|旅客|走私|毒品|菸品|偷渡|溺|失聯|搜救|救援|海龜|鯨|淨灘|表揚|模範|招募|徵才|節/;

export function classify(title, body) {
  const t = String(title ?? '');
  const all = t + ' ' + String(body ?? '');
  if (/海警/.test(t)) return /澄清|駁斥|聲稱|表示/.test(t) ? 'ccg-claim-rebuttal' : 'ccg-intrusion';
  if (/科研船|調查船|向陽紅|同濟/.test(all)) return 'research-vessel';
  if (/公務船|海事局|海巡\d{3,4}/.test(t)) return 'prc-official-vessel';
  if (/共艦|解放軍|共軍|軍演|演習/.test(t)) return 'pla-related';
  if (/越界|陸船|陸籍|抽砂/.test(t)) return 'mainland-vessel-incursion';
  if (/灰帶|灰色地帶|認知作戰/.test(all)) return 'grey-zone-statement';
  return 'other';
}

export const KIND_LABEL = {
  'ccg-intrusion': 'CCG intrusion',
  'ccg-claim-rebuttal': 'CCG patrol claim / CGA rebuttal',
  'research-vessel': 'PRC research vessel',
  'prc-official-vessel': 'PRC official vessel',
  'pla-related': 'PLA-related',
  'mainland-vessel-incursion': 'Mainland vessel incursion',
  'grey-zone-statement': 'Grey-zone statement',
  other: 'Other PRC-related',
};

export function isGreyZone(item) {
  const title = String(item?.title ?? '');
  const body = String(item?.description ?? '');
  if (!TITLE_ENTITY.test(title)) return false;
  if (EXCLUDE_TITLE.test(title) && !/海警|公務船|科研船/.test(title)) return false;
  return ACTION.test(title) || ACTION.test(body);
}

export function extractHulls(text) {
  const s = String(text ?? '');
  const hulls = new Set();
  let m;
  const quoted = /「(\d{4,5})」/g;
  while ((m = quoted.exec(s)) !== null) hulls.add(m[1]);
  const bare = /海警(?:船|局)?\s*[「]?(\d{4,5})[」]?/g;
  while ((m = bare.exec(s)) !== null) hulls.add(m[1]);
  const named = /(\d{4,5})\s*[「（(]([^」）)]{1,8}艦)[」）)]/g;
  while ((m = named.exec(s)) !== null) hulls.add(m[1]);
  return [...hulls].slice(0, 12);
}

export function extractVesselCount(text, hulls = []) {
  const s = String(text ?? '');
  const m = s.match(/等\s*(\d{1,2})\s*艘/) || s.match(/(\d{1,2})\s*艘\s*(?:中國)?(?:海警船|海警|公務船|船舶|陸船|漁船|船)/) || s.match(/(\d{1,2})\s*艘/);
  const n = m ? Number(m[1]) : null;
  if (n !== null && n > 0 && n < 100) return n;
  return hulls.length || null;
}

// "9時許" / "11時13分" → "HH:MM" (UTC+8 local clock as printed)
function clock(h, mi) {
  const hh = Number(h);
  if (!Number.isFinite(hh) || hh > 24) return null;
  const mm = mi === undefined || mi === '' ? 0 : Number(mi);
  return `${String(hh).padStart(2, '0')}:${String(Number.isFinite(mm) ? mm : 0).padStart(2, '0')}`;
}

export function extractTimes(text) {
  const s = String(text ?? '');
  let entry = null, exit = null;
  const re = /(\d{1,2})\s*時\s*(\d{1,2})?\s*分?\s*許?[^。；\n]{0,40}?(航入|進入|侵入|偵獲|發現|集結|航近|航出|離開|駛離|全數航出|驅離出)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = clock(m[1], m[2]);
    if (!t) continue;
    if (/航出|離開|駛離|驅離出/.test(m[3])) { if (!exit) exit = t; }
    else if (!entry) entry = t;
  }
  return { entryTime: entry, exitTime: exit };
}

export function extractArea(text) {
  const s = String(text ?? '');
  // Title first (headline names the theatre), then body.
  for (const a of AREAS) if (a.re.test(s)) return a;
  return null;
}

export function extractPhoto(rawDescription) {
  const m = String(rawDescription ?? '').match(/https?:\/\/[^\s<>"']+\.(?:jpe?g|png|gif)/i);
  return m ? httpUrl(m[0]) : null;
}

export function toRecord(item) {
  const title = cleanText(item.title, 160);
  const body = cleanText(item.description, 1200);
  const kind = classify(title, body);
  const hulls = extractHulls(body);
  const vesselCount = extractVesselCount(body, hulls);
  const area = extractArea(title) || extractArea(body);
  const { entryTime, exitTime } = extractTimes(body);
  const published = toIso(item.published);
  const photoUrl = extractPhoto(item.rawDescription || item.description);
  const url = httpUrl(item.link);

  const problems = [];
  if (!area) problems.push('area not stated');
  if (kind === 'ccg-intrusion' && !hulls.length) problems.push('CCG hull numbers not stated');
  if (kind === 'ccg-intrusion' && !entryTime) problems.push('entry time not stated');
  if (!published) problems.push('no publication time');

  const gloss = [
    KIND_LABEL[kind] || 'PRC-related',
    area ? `off ${area.en}` : null,
    vesselCount ? `${vesselCount} vessel${vesselCount === 1 ? '' : 's'}` : null,
    hulls.length ? `CCG ${hulls.join(', ')}` : null,
    entryTime ? `in ${entryTime}${exitTime ? ` → out ${exitTime}` : ''} (UTC+8)` : null,
  ].filter(Boolean).join(' · ');

  return {
    id: (url && (url.match(/xItem=(\d+)/) || [])[1]) || (published ? `${published}-${title.slice(0, 20)}` : title.slice(0, 40)),
    title,
    url,
    published,
    kind,
    kindLabel: KIND_LABEL[kind] || KIND_LABEL.other,
    hulls,
    vesselCount,
    area: area ? { key: area.key, en: area.en, zh: area.zh, lat: area.lat, lon: area.lon, radiusKm: area.radiusKm } : null,
    entryTime,
    exitTime,
    photoUrl,
    excerpt: body.slice(0, 280),
    gloss,
    partial: problems.length > 0,
    problems,
  };
}

export function buildResult(items, fetchedAt = new Date().toISOString()) {
  const kept = (items || []).filter(isGreyZone).map(toRecord)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, MAX_RECORDS);
  const latest = kept.find(r => r.published)?.published || null;
  const ageH = latest ? (Date.parse(fetchedAt) - Date.parse(latest)) / 3600000 : null;
  const now = Date.parse(fetchedAt);
  const within = h => kept.filter(r => r.published && now - Date.parse(r.published) <= h * 3600000);
  const last30 = within(24 * 30);
  const byArea = {};
  for (const r of last30) if (r.area) byArea[r.area.key] = (byArea[r.area.key] || 0) + 1;
  const hullSet = new Set();
  for (const r of last30) for (const h of r.hulls) hullSet.add(h);
  const problems = [];
  if (!(items || []).length) problems.push('feed parsed to zero items');
  else if (!kept.length) problems.push(`no PRC-actor releases among ${items.length} feed items`);
  const partialCount = kept.filter(r => r.partial).length;
  if (partialCount) problems.push(`${partialCount} of ${kept.length} records missing stated detail`);

  let status;
  if (!(items || []).length) status = 'unavailable';
  else if (!kept.length) status = 'empty';
  else if (ageH !== null && ageH > STALE_AFTER_H) status = 'stale';
  else if (ageH !== null && ageH > FRESH_AFTER_H) status = 'limited';
  else status = 'live';

  return {
    source: SOURCE,
    timestamp: fetchedAt,
    fetchedAt,
    status,
    error: status === 'unavailable' ? (problems[0] || 'feed unavailable') : null,
    provider: PROVIDER,
    siteUrl: SITE_URL,
    feedUrl: FEED_URL,
    licenseUrl: LICENSE_URL,
    feedItems: (items || []).length,
    records: kept,
    latestPublished: latest,
    latestAgeH: ageH === null ? null : +ageH.toFixed(1),
    stats: {
      total: kept.length,
      last7d: within(24 * 7).length,
      last30d: last30.length,
      ccgIntrusions30d: last30.filter(r => r.kind === 'ccg-intrusion').length,
      distinctHulls30d: hullSet.size,
      byArea,
      byKind: kept.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + 1; return acc; }, {}),
    },
    problems: problems.slice(0, 8),
    disclaimer: DISCLAIMER,
  };
}

let _cache = null;
let _cacheTs = 0;

function staleCopy() {
  const ageH = (Date.now() - _cacheTs) / 3600000;
  return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
}

export async function fetchTaiwanCga() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  try {
    const r = await safeFetch(FEED_URL, { timeout: 30000, headers: { ...HEADERS, Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (r?.error) throw new Error(r.error);
    const xml = typeof r?.rawText === 'string' ? r.rawText : '';
    if (!xml) throw new Error('empty feed body');
    if (xml.length > MAX_XML_BYTES) throw new Error('feed body too large');
    const items = parseFeed(xml);
    const result = buildResult(items);
    if (result.status === 'unavailable') {
      console.log(`[TaiwanCGA] ${result.error}`);
      return _cache ? staleCopy() : result;
    }
    _cache = result;
    _cacheTs = now;
    return result;
  } catch (err) {
    console.log(`[TaiwanCGA] fetch error: ${err.message}`);
    if (_cache) return staleCopy();
    return { ...buildResult([]), error: err.message };
  }
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }

export async function briefing() {
  return fetchTaiwanCga();
}

export default briefing;
