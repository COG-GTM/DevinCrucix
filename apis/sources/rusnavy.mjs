// Russian Navy warship OSINT tracker (Europe profile only).
// Scans GDELT headlines (shared export snapshot + one DOC query, 14 days) for named Russian Navy
// ships and generic Russian warship sightings, and maps them to sea-region coordinates. Ships
// with no recent mention sit at their homeport, flagged as a default (not a live position).
// Live AIS for these hulls is on marinevesseltraffic.com (Cloudflare-gated, so linked, not scraped).
import { loadFeeds, searchEvents } from './gdelt.mjs';
import { getProfile } from '../../lib/profile.mjs';
import { fetchQuery } from '../../lib/prcdel/tracker.mjs';
import { safeFetch } from '../utils/fetch.mjs';

export const LIVE_MAP_URL = 'https://www.marinevesseltraffic.com/russia-navy-warships';

const HOME = {
  Severomorsk: [69.07, 33.42, 'Northern Fleet'], Murmansk: [68.97, 33.08, 'Northern Fleet'], Severodvinsk: [64.57, 39.83, 'Northern Fleet'],
  Baltiysk: [54.65, 19.9, 'Baltic Fleet'], Kronstadt: [59.99, 29.77, 'Baltic Fleet'],
  Novorossiysk: [44.72, 37.78, 'Black Sea Fleet'], Sevastopol: [44.62, 33.53, 'Black Sea Fleet'],
  Vladivostok: [43.1, 131.9, 'Pacific Fleet'],
};

// name → [type, homeport, needsContext]
export const SHIPS = {
  'Admiral Kuznetsov': ['Aircraft carrier', 'Murmansk'], 'Pyotr Velikiy': ['Battlecruiser', 'Severomorsk'],
  'Admiral Nakhimov': ['Battlecruiser', 'Severodvinsk'], 'Marshal Ustinov': ['Cruiser', 'Severomorsk'], 'Varyag': ['Cruiser', 'Vladivostok', true],
  'Admiral Gorshkov': ['Frigate', 'Severomorsk'], 'Admiral Kasatonov': ['Frigate', 'Severomorsk'], 'Admiral Golovko': ['Frigate', 'Severomorsk'],
  'Admiral Isakov': ['Frigate', 'Severomorsk'], 'Admiral Grigorovich': ['Frigate', 'Novorossiysk'], 'Admiral Essen': ['Frigate', 'Novorossiysk'],
  'Admiral Makarov': ['Frigate', 'Novorossiysk'], 'Severomorsk': ['Destroyer', 'Severomorsk', true], 'Vice-Admiral Kulakov': ['Destroyer', 'Severomorsk'],
  'Admiral Levchenko': ['Destroyer', 'Severomorsk'], 'Admiral Tributs': ['Destroyer', 'Vladivostok'], 'Neustrashimy': ['Frigate', 'Baltiysk'],
  'Yaroslav Mudry': ['Frigate', 'Baltiysk'], 'Soobrazitelny': ['Corvette', 'Baltiysk'], 'Boikiy': ['Corvette', 'Baltiysk'],
  'Stoikiy': ['Corvette', 'Baltiysk'], 'Steregushchiy': ['Corvette', 'Baltiysk'], 'Kazan': ['Submarine (Yasen-M)', 'Severomorsk', true],
  'Krasnodar': ['Submarine (Kilo)', 'Novorossiysk', true], 'Novorossiysk': ['Submarine (Kilo)', 'Novorossiysk', true],
  'Yantar': ['Oceanographic / intelligence ship', 'Severomorsk', true], 'Ivan Khurs': ['Intelligence ship', 'Sevastopol'],
  'Ivan Gren': ['Landing ship', 'Severomorsk'], 'Pyotr Morgunov': ['Landing ship', 'Severomorsk'], 'Admiral Vladimirsky': ['Oceanographic ship', 'Kronstadt'],
};

const REGIONS = {
  'english channel': [50.2, -1.0], 'irish sea': [53.8, -5.2], 'north sea': [56.0, 3.0], 'skagerrak': [57.8, 9.0], 'kattegat': [56.8, 11.5],
  'danish straits': [55.6, 11.0], 'great belt': [55.4, 11.0], 'gulf of finland': [59.9, 26.0], 'baltic sea': [56.5, 19.0], 'baltic': [56.5, 19.0],
  'kaliningrad': [54.7, 20.5], 'norwegian sea': [68.0, 5.0], 'barents sea': [73.0, 38.0], 'kola': [69.0, 33.5], 'arctic': [76.0, 40.0],
  'north atlantic': [55.0, -25.0], 'atlantic': [45.0, -20.0], 'bay of biscay': [45.5, -4.5], 'strait of gibraltar': [36.0, -5.6], 'gibraltar': [36.0, -5.6],
  'eastern mediterranean': [34.5, 30.0], 'mediterranean': [36.0, 15.0], 'tartus': [34.9, 35.87], 'syria': [34.9, 35.87], 'libya': [32.9, 13.2],
  'bosphorus': [41.1, 29.05], 'dardanelles': [40.2, 26.4], 'aegean': [38.5, 25.0], 'black sea': [43.5, 34.0], 'sea of azov': [46.0, 36.6],
  'kerch': [45.3, 36.5], 'crimea': [44.6, 33.5], 'sevastopol': [44.62, 33.53], 'novorossiysk': [44.72, 37.78], 'odesa': [46.2, 30.9], 'odessa': [46.2, 30.9],
  'severomorsk': [69.07, 33.42], 'murmansk': [68.97, 33.08], 'baltiysk': [54.65, 19.9], 'st petersburg': [59.9, 30.0], 'kronstadt': [59.99, 29.77],
  'norway': [64.0, 8.0], 'denmark': [56.0, 10.5], 'sweden': [58.5, 18.5], 'finland': [60.0, 24.0], 'estonia': [59.5, 24.0], 'latvia': [57.0, 21.0],
  'lithuania': [55.7, 21.0], 'poland': [54.6, 18.6], 'germany': [54.5, 10.5], 'netherlands': [53.0, 4.0], 'uk ': [52.5, 1.5], 'britain': [52.5, 1.5],
  'ireland': [52.5, -8.0], 'france': [48.5, -3.5], 'italy': [39.0, 16.0], 'greece': [37.5, 24.0], 'cyprus': [34.8, 33.0], 'turkey': [41.1, 29.05],
};
const SORTED = Object.entries(REGIONS).sort((a, b) => b[0].length - a[0].length);
export function matchRegion(text) {
  const t = ` ${String(text).toLowerCase()} `;
  for (const [k, c] of SORTED) if (t.includes(k)) return { region: k.trim(), lat: c[0], lng: c[1] };
  return null;
}

const NAVAL = /\b(navy|naval|warship|frigate|corvette|destroyer|cruiser|submarine|fleet|vessel|ship|sub)\b/i;
const RU = /\b(russian|russia(?:'s|’s)?|kremlin)\b/i;
export const HEADLINE_RE = /\b(Russian (navy|naval|warships?|frigates?|corvettes?|destroyers?|submarines?|cruisers?|fleet|spy ship)|Black Sea Fleet|Northern Fleet|Baltic Fleet|Pacific Fleet)\b/i;
const SORTED_SHIPS = Object.keys(SHIPS).sort((a, b) => b.length - a.length);
export function matchShip(text) {
  for (const name of SORTED_SHIPS) {
    if (!new RegExp(`\\b${name.replace(/[-]/g, '[- ]')}\\b`, 'i').test(text)) continue;
    if (SHIPS[name][2] && !(NAVAL.test(text) && RU.test(text))) continue;
    if (SHIPS[name][2] && new RegExp(`\\b${name}\\b(?! (?:submarine|frigate|destroyer|cruiser|ship|vessel))`, 'i').test(text) && !/\b(submarine|frigate|destroyer|cruiser|warship|spy ship|vessel)\b/i.test(text)) continue;
    return name;
  }
  return null;
}

async function fetchNews() {
  const out = []; const seen = new Set();
  const push = (title, url, at) => { if (!title || seen.has(url || title)) return; seen.add(url || title); out.push({ title, url: url || '', at: at || '' }); };
  let feedStatus = 'ok', docStatus = 'ok';
  try { const f = await loadFeeds(); for (const a of f.articles) if (HEADLINE_RE.test(a.title) || matchShip(a.title)) push(a.title, a.url); }
  catch (e) { feedStatus = e.message; }
  const doc = await searchEvents('"Russian warship" OR "Russian navy" OR "Russian frigate" OR "Russian submarine" OR "Black Sea Fleet" OR "Baltic Fleet" OR "Northern Fleet"', { maxRecords: 100, timespan: '14d', timeout: 12000 });
  if (doc && Array.isArray(doc.articles)) for (const a of doc.articles) push(a.title || '', a.url || '', a.seendate || '');
  else docStatus = doc?.error || (doc?.rawText ? 'non-JSON response (rate limited)' : 'no articles');
  // Google News RSS backfill (GDELT DOC is often rate limited)
  for (const q of ['"Russian warship"', '"Russian navy" OR "Russian frigate" OR "Russian submarine" OR "Russian corvette"', '"Black Sea Fleet" OR "Baltic Fleet" OR "Northern Fleet"']) {
    try { for (const it of await fetchQuery(q, 14, safeFetch)) { const t = String(it.title || '').replace(/\s+-\s+[^-]+$/, ''); if (HEADLINE_RE.test(t) || matchShip(t)) push(t, it.link, it.published); } } catch {}
  }
  return { articles: out, feedStatus, docStatus };
}

export function buildRusNavy(articles) {
  const ships = Object.entries(SHIPS).map(([name, [type, home]]) => {
    const [lat, lng, fleet] = HOME[home];
    return { name, type, fleet, homeport: home, lat, lng, region: home, estimated: true, live: false, desc: `Homeport ${home} (default, no recent reporting)`, source: 'Homeport default', sourceUrl: LIVE_MAP_URL };
  });
  const byName = Object.fromEntries(ships.map(s => [s.name, s]));
  const sightings = [];
  for (const a of articles) {
    const r = matchRegion(a.title); const name = matchShip(a.title);
    if (name && r && !byName[name].live) Object.assign(byName[name], { lat: r.lat, lng: r.lng, region: r.region, live: true, desc: a.title.slice(0, 140), source: 'GDELT news', sourceUrl: a.url, reported: a.at });
    else if (!name && r && HEADLINE_RE.test(a.title) && sightings.length < 25) sightings.push({ headline: a.title.slice(0, 160), region: r.region, lat: r.lat, lng: r.lng, url: a.url, reported: a.at });
  }
  return { ships, sightings };
}

export async function briefing() {
  if (getProfile()?.id !== 'europe') return { status: 'skipped' };
  let news = { articles: [], feedStatus: 'skipped', docStatus: 'skipped' };
  try { news = await fetchNews(); } catch (e) { news.feedStatus = e.message; }
  const { ships, sightings } = buildRusNavy(news.articles);
  const reported = ships.filter(s => s.live);
  return {
    source: 'Russian Navy (OSINT)', timestamp: new Date().toISOString(), liveMapUrl: LIVE_MAP_URL,
    totalShips: ships.length, reportedShips: reported.length, ships, sightings,
    enrichment: { articles: news.articles.length, feedStatus: news.feedStatus, docStatus: news.docStatus },
    ...(news.feedStatus !== 'ok' && news.docStatus !== 'ok' ? { status: 'fallback', note: 'GDELT unreachable — homeport defaults only' } : {}),
    signals: [...reported.map(s => `${s.name} (${s.type}): ${s.region}`), ...sightings.slice(0, 5).map(s => `${s.region}: ${s.headline}`)].slice(0, 10),
  };
}

if (process.argv[1]?.endsWith('rusnavy.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
