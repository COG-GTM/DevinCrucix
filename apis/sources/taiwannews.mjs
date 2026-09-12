// Taiwan security headlines: Focus Taiwan (CNA English) + Taipei Times RSS, filtered to
// cross-strait / defense / PLA / coast-guard / grey-zone reporting. Headline + link + time only —
// article bodies are the publishers' copyright and are not stored or shown.

import { safeFetch } from '../utils/fetch.mjs';
import { parseFeed } from '../utils/rss.mjs';
import { cleanText, httpUrl, toIso } from './iranwarlive.mjs';

export const SOURCE = 'TaiwanNews';

export const FEEDS = [
  { key: 'focustaiwan', name: 'Focus Taiwan (CNA)', url: 'https://feeds.feedburner.com/rsscna/engnews/', siteUrl: 'https://focustaiwan.tw/', host: /focustaiwan\.tw|cna\.com\.tw|feedburner\.com|feedproxy\.google\.com/ },
  { key: 'taipeitimes', name: 'Taipei Times', url: 'https://www.taipeitimes.com/xml/index.rss', siteUrl: 'https://www.taipeitimes.com/', host: /taipeitimes\.com/ },
];

export const DISCLAIMER = [
  'Headlines and links only, filtered by keyword for Taiwan-security relevance; full text stays with the publisher.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_XML_BYTES = 3 * 1024 * 1024;
export const MAX_PER_FEED = 25;
export const STALE_AFTER_H = 48;

// Case-sensitive acronyms first so "plan"/"mind" never match PLAN/MND.
const ACRONYMS = /\bPLA\b|\bPLAN\b|\bPLAAF\b|\bADIZ\b|\bMND\b|\bCCG\b|\bNSB\b|\bNSC\b|\bAIT\b|\bTRA\b|\bCGA\b|\bMAC\b|\bMOFA\b/;
const TERMS = /air base|naval base|military base|cross-strait|Taiwan Strait|Beijing|Chinese (?:military|navy|coast guard|warship|aircraft|drone|balloon|pressure|threat|spy|espionage|infiltration|interference)|China(?:'s|\u2019s)? (?:military|navy|coast guard|warship|threat|pressure|drills?|exercises?|missiles?|blockade|invasion|interference)|\bmilitary\b|\bdefen[cs]e\b|\bmissiles?\b|\bwarships?\b|\bdrills?\b|live-fire|Han Kuang|coast guard|\bnavy\b|\bnaval\b|air force|\bsorties?\b|fighter jets?|\bespionage\b|\bspy\b|\bspying\b|infiltrat|cognitive warfare|gr[ae]y[- ]zone|Kinmen|Matsu|Penghu|Pengjia|Dongsha|Pratas|blockade|invasion|reservists?|conscript|arms sales?|sovereignty|reunification|unification|Lai Ching-te|Hsiao Bi-khim|Koo Li-hsiung|Wellington Koo|national security|Mainland Affairs Council|United Front|submarines?|Hai Kun|drone industry|autonomous surface vessel|Taiwan Relations Act|one[- ]China|Indo-Pacific|INDOPACOM|Seventh Fleet|7th Fleet|Pentagon|Japan Self-Defen[cs]e|Philippines? (?:navy|coast guard|military)|Scarborough|South China Sea/i;
const EXCLUDE = /\bshares?\b|\bstocks?\b|forex|\bdollar\b|central bank|rate hike|minimum wage|gasoline|baseball|basketball|football|soccer|tennis|badminton|Olympic|golf|rugby|temple culture|illustration festival|film festival|concert|recipe|weather|rain advisor|heavy rain|typhoon|heat|earthquake|iPhone|Micron|TSMC|semiconductor|smuggling heroin|drug smuggl|traffic accident|lottery|Taiwan headline news|ANALYTICAL ENGLISH|EDITORIAL CARTOON|\bTaiwan in Time\b|Houthis?|Donetsk|Kyiv|Ukraine|Russian drive|Malawi|Senegal|London|Brick Lane|N Korea fires|9\/11|Irish Open|Gotham FC|US Open|Philadelphia|Musk|ferry fire|Leopard cat|suicide|seedling|Internet access|sycophancy/i;

export function isSecurityHeadline(title) {
  const t = String(title ?? '');
  if (!t.trim()) return false;
  if (EXCLUDE.test(t) && !ACRONYMS.test(t)) return false;
  return ACRONYMS.test(t) || TERMS.test(t);
}

export function toHeadline(item, feed) {
  const url = httpUrl(item.link);
  return {
    title: cleanText(item.title, 160),
    url,
    published: toIso(item.published),
    feed: feed.key,
    outlet: feed.name,
    offSite: Boolean(url && !feed.host.test(url)),
  };
}

export function filterFeed(items, feed, fetchedAt = new Date().toISOString()) {
  const kept = (items || []).filter(i => isSecurityHeadline(i.title)).map(i => toHeadline(i, feed))
    .filter(h => h.title && h.url && !h.offSite)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, MAX_PER_FEED);
  const latest = kept.find(h => h.published)?.published || (items || []).map(i => toIso(i.published)).filter(Boolean).sort().pop() || null;
  const ageH = latest ? (Date.parse(fetchedAt) - Date.parse(latest)) / 3600000 : null;
  let status;
  if (!(items || []).length) status = 'unavailable';
  else if (!kept.length) status = 'empty';
  else if (ageH !== null && ageH > STALE_AFTER_H) status = 'stale';
  else status = 'live';
  return { key: feed.key, name: feed.name, siteUrl: feed.siteUrl, feedUrl: feed.url, status, error: null, feedItems: (items || []).length, kept: kept.length, latestPublished: latest, latestAgeH: ageH === null ? null : +ageH.toFixed(1), headlines: kept };
}

export function combine(feedResults, fetchedAt = new Date().toISOString()) {
  const feeds = feedResults;
  const headlines = feeds.flatMap(f => f.headlines).sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  const liveCount = feeds.filter(f => f.status === 'live').length;
  const problems = feeds.filter(f => f.status !== 'live').map(f => `${f.name}: ${f.error || f.status}`);
  let status;
  if (liveCount === feeds.length) status = 'live';
  else if (liveCount > 0 || feeds.some(f => f.status === 'stale' || f.status === 'empty')) status = 'limited';
  else status = 'unavailable';
  return {
    source: SOURCE,
    timestamp: fetchedAt,
    fetchedAt,
    status,
    error: status === 'unavailable' ? (problems[0] || 'all feeds unavailable') : null,
    feeds,
    headlines,
    count: headlines.length,
    problems,
    disclaimer: DISCLAIMER,
  };
}

let _cache = null;
let _cacheTs = 0;

async function fetchOne(feed) {
  try {
    const r = await safeFetch(feed.url, { timeout: 20000, headers: { ...HEADERS, Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (r?.error) throw new Error(r.error);
    const xml = typeof r?.rawText === 'string' ? r.rawText : '';
    if (!xml) throw new Error('empty feed body');
    if (xml.length > MAX_XML_BYTES) throw new Error('feed body too large');
    return filterFeed(parseFeed(xml), feed);
  } catch (err) {
    console.log(`[TaiwanNews] ${feed.key}: ${err.message}`);
    return { ...filterFeed([], feed), error: err.message };
  }
}

export async function fetchTaiwanNews() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const results = await Promise.all(FEEDS.map(fetchOne));
  const combined = combine(results);
  if (combined.status === 'unavailable' && _cache) {
    const ageH = (now - _cacheTs) / 3600000;
    return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
  }
  if (combined.status !== 'unavailable') { _cache = combined; _cacheTs = now; }
  return combined;
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }

export async function briefing() {
  return fetchTaiwanNews();
}

export default briefing;
