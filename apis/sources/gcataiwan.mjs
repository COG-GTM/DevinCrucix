// Global Conflict Awareness — Taiwan conflict feed (https://globalconflictawareness.com/?conflict=taiwan).
//
// GCA republishes a keyword-filtered news aggregate as JSON (CC BY-NC, no key). Its Taiwan feed is
// noisy: in a 200-record live sample the top item was a FIFA story and ~80% of records were pinned to
// the Taiwan country centroid rather than a place. So this adapter (1) re-filters for Taiwan-security
// relevance with word-bounded terms, (2) flags centroid-pinned coordinates as country-level, never as
// an incident location, and (3) presents the result as an observational OSINT strip with the required
// attribution and a link back to GCA's own map. Nothing here is authoritative.
//
// Live schema (differs from the docs): id, title, summary, source, url, pubDate, ts, side,
// locationName, lat, lng, country, conflict.

import { safeFetch } from '../utils/fetch.mjs';
import { cleanText, httpUrl, toIso } from './iranwarlive.mjs';

export const SOURCE = 'GCATaiwan';
export const PROVIDER = 'Global Conflict Awareness';
export const FEED_URL = 'https://taiwan-proxy.osint-monitor.workers.dev/events';
export const SITE_URL = 'https://globalconflictawareness.com/?conflict=taiwan';
export const DOCS_URL = 'https://globalconflictawareness.com/llms.txt';
export const LICENSE = 'CC BY-NC 4.0';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by-nc/4.0/';
export const ATTRIBUTION = 'Source: Global Conflict Awareness (globalconflictawareness.com) \u2014 OSINT aggregation';

export const DISCLAIMER = [
  'Observational strip: GCA aggregates third-party headlines by keyword. CRUCIX re-filters them for Taiwan-security relevance; items are headlines, not verified events.',
  'Most GCA coordinates are a country centroid, not a place. Those are shown as country-level and never plotted as an incident.',
  ATTRIBUTION,
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDS = 40;
export const STALE_AFTER_H = 36;

// Known centroids GCA falls back to when it cannot place a story.
const CENTROIDS = [
  { name: 'Taiwan', lat: 23.6978, lon: 120.9605 },
  { name: 'China', lat: 35.8617, lon: 104.1954 },
  { name: 'Japan', lat: 36.2048, lon: 138.2529 },
  { name: 'Philippines', lat: 12.8797, lon: 121.774 },
  { name: 'United States', lat: 37.0902, lon: -95.7129 },
];
const COUNTRY_NAMES = /^(taiwan|china|japan|philippines|united states|usa|south korea|korea|russia|india|australia|vietnam|indonesia|malaysia|singapore)$/i;

// Acronyms are case-sensitive on purpose: "plan" must not match PLAN.
const ACRONYMS = /\bPLA\b|\bPLAN\b|\bPLAAF\b|\bADIZ\b|\bCCG\b|\bTECRO\b|\bAIT\b|\bMND\b/;
const STRONG = /Taiwan Strait|Taiwan-facing|median line|Kinmen|Matsu|Penghu|Pratas|Dongsha|Eastern Theat(?:er|re) Command|China Coast Guard|\bCCG\b|blockade of Taiwan|blockade Taiwan|invad(?:e|ing) Taiwan|invasion of Taiwan|Taiwan invasion|Taiwan contingency|Han Kuang|Joint Sword|Strait Thunder|Taiwan['\u2019]s (?:defen[cs]e|military|navy|air force|armed forces|MND|ministry of national defen[cs]e)|Lai Ching-te|(?:Taiwan|China|Beijing|cross-strait)[^.]{0,80}reunification|reunification[^.]{0,80}(?:Taiwan|China|Beijing)|unification with Taiwan|Taiwan Relations Act|Six Assurances|one[- ]China/i;
const TAIWAN = /Taiwan|Taipei|cross-strait|Kinmen|Matsu|Penghu/i;
const SECURITY = /militar|defen[cs]e|missile|drill|exercise|warship|destroyer|frigate|carrier|sortie|fighter|bomber|\bnavy\b|naval|\barmy\b|troops|marines|spy|espionage|infiltrat|cognitive warfare|gr[ae]y[- ]zone|coast guard|sovereignty|amphibious|invasion|blockade|deterren|arms sale|weapons|howitzer|artillery|radar|submarine|drone|UAV|airspace|incursion|intrusion|patrol|war\b|conflict|security|intelligence|sanction|Pentagon|INDOPACOM|Seventh Fleet|7th Fleet|Japan Self-Defen[cs]e|JSDF|Yonaguni|Miyako|Bashi|Luzon Strait/i;
const NOISE = /\bFIFA\b|football|soccer|basketball|\bNBA\b|tennis|Olympic|badminton|baseball|wedding|marry|marriage|\bIPO\b|shares slide|stock market|earnings|philanthropy|biomedicine|solar plan|census|home ownership|dual citizenship|carbon credit|five-year plan|5-year plan|bank account|car industry|joint venture|air show|trade fair|West Bank|Ireland|Irish|Germany|\bAfD\b|typhoon|ferry|flights cancel/i;

export function isRelevant(rec) {
  const text = `${rec?.title || ''} ${rec?.summary || ''}`;
  if (NOISE.test(rec?.title || '')) return STRONG.test(text);
  if (ACRONYMS.test(text)) return true;
  if (STRONG.test(text)) return true;
  return TAIWAN.test(text) && SECURITY.test(text);
}

export function locationPrecision(rec) {
  const lat = Number(rec?.lat), lon = Number(rec?.lng ?? rec?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { precision: 'none', lat: null, lon: null };
  const name = String(rec?.locationName || '').trim();
  const nearCentroid = CENTROIDS.some(c => Math.abs(c.lat - lat) < 0.05 && Math.abs(c.lon - lon) < 0.05);
  if (nearCentroid || COUNTRY_NAMES.test(name)) return { precision: 'country', lat, lon };
  if (/strait|sea\b|waters|ocean|channel/i.test(name)) return { precision: 'region', lat, lon };
  return { precision: 'named', lat, lon };
}

export function toRecord(rec) {
  const loc = locationPrecision(rec);
  const published = toIso(rec?.pubDate) || toIso(rec?.date) || (Number.isFinite(Number(rec?.ts)) ? new Date(Number(rec.ts) > 1e12 ? Number(rec.ts) : Number(rec.ts) * 1000).toISOString() : null);
  const side = String(rec?.side || 'unknown').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) || 'unknown';
  return {
    id: cleanText(rec?.id, 40) || null,
    title: cleanText(rec?.title, 160),
    summary: cleanText(rec?.summary, 220),
    source: cleanText(rec?.source, 40),
    url: httpUrl(rec?.url),
    published,
    side: ['china', 'taiwan', 'unknown'].includes(side) ? side : 'unknown',
    locationName: cleanText(rec?.locationName, 60) || null,
    lat: loc.lat,
    lon: loc.lon,
    locationPrecision: loc.precision,
  };
}

export function buildResult(raw, fetchedAt = new Date().toISOString()) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : Array.isArray(raw?.items) ? raw.items : [];
  const seen = new Set();
  const kept = [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object' || !isRelevant(rec)) continue;
    const r = toRecord(rec);
    if (!r.title) continue;
    const key = r.url || r.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(r);
  }
  kept.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  const records = kept.slice(0, MAX_RECORDS);
  const latest = records.find(r => r.published)?.published || null;
  const ageH = latest ? (Date.parse(fetchedAt) - Date.parse(latest)) / 3600000 : null;
  const bySource = {};
  for (const r of records) if (r.source) bySource[r.source] = (bySource[r.source] || 0) + 1;
  const problems = [];
  if (!list.length) problems.push('feed returned zero records');
  else if (!records.length) problems.push(`none of ${list.length} GCA records passed the Taiwan-security filter`);
  else problems.push(`${list.length - kept.length} of ${list.length} GCA records dropped as off-topic`);
  const named = records.filter(r => r.locationPrecision === 'named' || r.locationPrecision === 'region').length;

  let status;
  if (!list.length) status = 'unavailable';
  else if (!records.length) status = 'empty';
  else if (ageH !== null && ageH > STALE_AFTER_H) status = 'stale';
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
    docsUrl: DOCS_URL,
    license: LICENSE,
    licenseUrl: LICENSE_URL,
    attribution: ATTRIBUTION,
    feedRecords: list.length,
    keptRecords: kept.length,
    records,
    latestPublished: latest,
    latestAgeH: ageH === null ? null : +ageH.toFixed(1),
    stats: {
      shown: records.length,
      placed: named,
      countryLevel: records.length - named,
      bySide: records.reduce((acc, r) => { acc[r.side] = (acc[r.side] || 0) + 1; return acc; }, {}),
      bySource,
    },
    problems: problems.slice(0, 6),
    disclaimer: DISCLAIMER,
  };
}

let _cache = null;
let _cacheTs = 0;

function staleCopy() {
  const ageH = (Date.now() - _cacheTs) / 3600000;
  return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
}

export async function fetchGcaTaiwan() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  try {
    const r = await safeFetch(FEED_URL, { timeout: 20000, headers: { ...HEADERS, Accept: 'application/json' } });
    if (r?.error) throw new Error(r.error);
    if (typeof r?.rawText === 'string') {
      if (r.rawText.length > MAX_JSON_BYTES) throw new Error('feed body too large');
      throw new Error('feed body was not JSON');
    }
    const result = buildResult(r);
    if (result.status === 'unavailable') {
      console.log(`[GCATaiwan] ${result.error}`);
      return _cache ? staleCopy() : result;
    }
    _cache = result;
    _cacheTs = now;
    return result;
  } catch (err) {
    console.log(`[GCATaiwan] fetch error: ${err.message}`);
    if (_cache) return staleCopy();
    return { ...buildResult([]), error: err.message };
  }
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }

export async function briefing() {
  return fetchGcaTaiwan();
}

export default briefing;
