// Country Home Page wires: one adapter instance per country, driven by the feeds declared in
// config/countries/<cc>.json (RSS or public WordPress REST). Stores headline, time, link and a
// short excerpt only — article bodies stay with the publisher. Every item is tagged with topics,
// configured places (city sectors / localidades) and armed-group mentions so the page can count and
// pin them; nothing is geocoded beyond those configured anchors.

import { safeFetch } from '../utils/fetch.mjs';
import { parseFeed, stripTags } from '../utils/rss.mjs';
import { cleanText, httpUrl, toIso } from './iranwarlive.mjs';
import { COUNTRY_IDS, countryConfig, aliasMatcher } from '../../lib/countryconfig.mjs';

export const SOURCE_NAMES = Object.freeze({ co: 'ColombiaNews', ve: 'VenezuelaNews' });
export const DISCLAIMER = [
  'Headline, time, link and a short excerpt only; full text stays with the publisher.',
  'Topic / place / group tags are keyword matches against configured anchors — observational, not verified.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
export const MAX_PER_FEED = 20;
export const MAX_TOTAL = 80;
export const STALE_AFTER_H = 96;
const EXCERPT_MAX = 200;

// Spanish / English topic cues. Order matters only for display; an item may carry several.
export const TOPICS = [
  ['security', /homicid|asesinat|sicari|balacer|tirote|secuestr|extorsi|hurto|\brobo|atrac|captur|incaut|narco|coca[ií]na|\bcoca\b|droga|microtr[aá]fico|\bbanda|megabanda|pandilla|disidenc|guerrill|\bELN\b|\bFARC\b|Clan del Golfo|Tren de Aragua|explosiv|atentad|artefacto|masacre|desplaz|minas antipersona|fleteo|cartel|crimen|delincuen|polic[ií]a|ej[eé]rcito|militar|\bFANB\b|\bGNB\b|\bPNB\b|\bFAES\b|\bCICPC\b|\bDGCIM\b|\bSEBIN\b|operativo|enfrentamiento|combate|hostigamiento|feminicid|violencia|ataque|bombarde|lancha|buque|portaaviones|Southern Spear|Comando Sur|\bSOUTHCOM\b|cyberdelincuen|ciberdelincuen|terrorismo|traici[oó]n/i],
  ['protest', /protesta|manifesta|\bmarcha|\bparo\b|bloqueo|cacerolazo|plant[oó]n|huelga|movilizaci|conflictividad|represi[oó]n/i],
  ['rights', /presos? pol[ií]tic|detenid|liberad|excarcel|desaparecid|tortur|derechos humanos|\bDDHH\b|Foro Penal|\bCIDH\b|Misi[oó]n (?:Internacional )?(?:Independiente )?de Determinaci[oó]n|\bCPI\b|amnist[ií]a|indult|absuel|condena|juicio|tribunal|\bTSJ\b|fiscal[ií]a|Provea|\bONU\b|ACNUR|Bachelet|T[uü]rk/i],
  ['politics', /elecci[oó]n|electoral|\bCNE\b|gobierno|presiden|\bPetro\b|\bMaduro\b|\bDelcy\b|Jorge Rodr[ií]guez|Machado|Gonz[aá]lez Urrutia|Congreso|Asamblea|ministr|alcald|Gal[aá]n|di[aá]logo|negociaci|transici[oó]n|sanci[oó]n|\bOFAC\b|Washington|\bTrump\b|\bRubio\b|Casa Blanca|Departamento de Estado|Senado|plebiscito|acuerdo de paz|paz total|Santos|Uribe|constituyente|reforma/i],
  ['services', /apag[oó]n|apagones|electricidad|el[eé]ctric|megavatio|\bagua\b|\bgas\b|gasolina|combustible|hospital|\bsalud\b|transporte|Transmilenio|\bMetro\b|basura|internet|CANTV|Corpoelec|Hidrocapital/i],
  ['migration', /migra|deporta|retorno|frontera|\bICE\b|\bTPS\b|caminantes|Dari[eé]n/i],
  ['economy', /d[oó]lar|inflaci|salario|pensi[oó]n|pensionad|jubilad|precios|econom|\bPIB\b|petr[oó]l|\bPDVSA\b|\boro\b|miner[ií]a|Arco Minero|bolívar|canasta|Chevron|Ecopetrol|exportaci|arancel/i],
  ['humanitarian', /terremoto|sismo|inundaci|lluvias|emergencia|damnificad|Cecodap|desnutri|hambre|\bayuda humanitaria|deslizamiento|incendio/i],
];

export const FEED_SCHEMA = ['key', 'name', 'type', 'url', 'siteUrl', 'host'];

export function tagTopics(text) {
  const t = String(text ?? '');
  return TOPICS.filter(([, re]) => re.test(t)).map(([k]) => k);
}

function sha(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function wpPostsToItems(posts) {
  if (!Array.isArray(posts)) return [];
  return posts.map(p => ({
    title: stripTags(p?.title?.rendered ?? ''),
    link: String(p?.link ?? ''),
    guid: String(p?.id ?? ''),
    published: toIso(p?.date_gmt ? `${p.date_gmt}Z` : p?.date),
    description: stripTags(p?.excerpt?.rendered ?? ''),
    categories: [],
  }));
}

export function makeTagger(cfg) {
  const placeMatch = aliasMatcher(cfg.places || []);
  const groupMatch = aliasMatcher((cfg.groups || []).map(g => ({ name: g, aliases: [g] })), { minLen: 3 });
  return (text) => ({
    topics: tagTopics(text),
    places: placeMatch(text).map(p => ({ key: p.key, name: p.name, lon: p.lon, lat: p.lat, level: p.level })).slice(0, 4),
    groups: groupMatch(text).map(g => g.name).slice(0, 4),
  });
}

export function toItem(item, feed, tag) {
  const url = httpUrl(item.link);
  const title = cleanText(item.title, 160);
  const excerpt = cleanText(item.description, EXCERPT_MAX);
  const tags = tag(`${title} ${excerpt}`);
  return {
    id: sha(`${feed.key}|${url || item.guid || title}`),
    title,
    url,
    published: toIso(item.published),
    feed: feed.key,
    outlet: feed.name,
    tier: feed.tier || null,
    scope: feed.scope || null,
    excerpt,
    offSite: Boolean(url && !new RegExp(feed.host).test(url)),
    ...tags,
  };
}

export function reduceFeed(items, feed, tag, fetchedAt = new Date().toISOString()) {
  const kept = (items || []).map(i => toItem(i, feed, tag))
    .filter(h => h.title && h.url && !h.offSite)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, MAX_PER_FEED);
  const latest = kept.find(h => h.published)?.published || null;
  const ageH = latest ? (Date.parse(fetchedAt) - Date.parse(latest)) / 3600000 : null;
  let status;
  if (!(items || []).length) status = 'unavailable';
  else if (!kept.length) status = 'empty';
  else if (ageH !== null && ageH > (feed.staleAfterH || STALE_AFTER_H)) status = 'stale';
  else status = 'live';
  return { key: feed.key, name: feed.name, type: feed.type, siteUrl: feed.siteUrl, tier: feed.tier || null, scope: feed.scope || null, note: feed.note || null, status, error: null, feedItems: (items || []).length, kept: kept.length, latestPublished: latest, latestAgeH: ageH === null ? null : +ageH.toFixed(1), items: kept };
}

export function combine(cc, feedResults, fetchedAt = new Date().toISOString()) {
  const feeds = feedResults.map(({ items, ...f }) => f);
  const items = feedResults.flatMap(f => f.items).sort((a, b) => (b.published || '').localeCompare(a.published || '')).slice(0, MAX_TOTAL);
  const liveCount = feeds.filter(f => f.status === 'live').length;
  const problems = feeds.filter(f => f.status !== 'live').map(f => `${f.name}: ${f.error || f.status}`);
  let status;
  if (liveCount === feeds.length && feeds.length) status = 'live';
  else if (liveCount > 0 || feeds.some(f => f.status === 'stale' || f.status === 'empty')) status = 'limited';
  else status = 'unavailable';
  const count = (fn) => { const m = {}; for (const i of items) for (const k of fn(i)) m[k] = (m[k] || 0) + 1; return m; };
  return {
    source: SOURCE_NAMES[cc] || `CountryNews-${cc}`,
    country: cc,
    timestamp: fetchedAt,
    fetchedAt,
    status,
    error: status === 'unavailable' ? (problems[0] || 'all feeds unavailable') : null,
    feeds,
    items,
    count: items.length,
    topicCounts: count(i => i.topics),
    placeCounts: count(i => i.places.map(p => p.key)),
    groupCounts: count(i => i.groups),
    problems,
    disclaimer: DISCLAIMER,
  };
}

async function fetchOne(feed, tag) {
  try {
    for (const k of FEED_SCHEMA) if (!feed[k]) throw new Error(`feed config missing ${k}`);
    const accept = feed.type === 'wp-json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*';
    const r = await safeFetch(feed.url, { timeout: 20000, headers: { ...HEADERS, Accept: accept } });
    if (r?.error) throw new Error(r.error);
    let items;
    if (feed.type === 'wp-json') {
      if (!Array.isArray(r)) throw new Error('unexpected WordPress REST body');
      items = wpPostsToItems(r);
    } else {
      const xml = typeof r?.rawText === 'string' ? r.rawText : '';
      if (!xml) throw new Error('empty feed body');
      if (xml.length > MAX_BODY_BYTES) throw new Error('feed body too large');
      items = parseFeed(xml);
    }
    return reduceFeed(items, feed, tag);
  } catch (err) {
    console.log(`[${SOURCE_NAMES[feed._cc] || 'CountryNews'}] ${feed.key}: ${err.message}`);
    return { ...reduceFeed([], feed, tag), error: String(err.message || err).slice(0, 160) };
  }
}

const caches = new Map();

export async function fetchCountryNews(cc) {
  const cfg = countryConfig(cc);
  const now = Date.now();
  const c = caches.get(cc);
  if (c && now - c.ts < CACHE_TTL_MS) return c.value;
  const tag = makeTagger(cfg);
  const results = await Promise.all((cfg.feeds || []).map(f => fetchOne({ ...f, _cc: cc }, tag)));
  const combined = combine(cc, results);
  if (combined.status === 'unavailable' && c) {
    const ageH = (now - c.ts) / 3600000;
    return { ...c.value, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
  }
  if (combined.status !== 'unavailable') caches.set(cc, { ts: now, value: combined });
  return combined;
}

export function _resetCacheForTests() { caches.clear(); }

export function makeBriefing(cc) {
  if (!COUNTRY_IDS.includes(cc)) throw new Error(`unknown country id: ${cc}`);
  return async function briefing() { return fetchCountryNews(cc); };
}

export const briefingCo = makeBriefing('co');
export const briefingVe = makeBriefing('ve');
