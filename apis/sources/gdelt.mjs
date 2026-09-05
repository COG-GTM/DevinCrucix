// GDELT — Global Database of Events, Language, and Tone
// No auth required. Updates every 15 minutes. Monitors news in 100+ languages.
//
// Primary path: the raw 15-minute export feeds on data.gdeltproject.org
//   - events  (.export.CSV.zip)  → geolocated CAMEO events, Goldstein, tone
//   - GKG     (.gkg.csv.zip)     → article titles, themes, tone
// These are static files with no query rate limit, so they work from shared-IP
// hosts (Fly, CI) where the DOC/GEO search APIs answer 429 for every caller.
//
// The DOC 2.0 search API is still exported for ad-hoc queries (`searchEvents`,
// `geoEvents`) but goes through a single process-wide throttle so callers can
// never exceed GDELT's 1 request / 5 s rule.

import { safeFetch } from '../utils/fetch.mjs';
import { latestStamp, loadRecent, compactEvent, compactGkg, eventHeadline, dateFromStamp, CAMEO_ROOT } from '../utils/gdeltfeed.mjs';

const BASE = 'https://api.gdeltproject.org/api/v2';
const DOC_MIN_INTERVAL_MS = 5500;
const EVENT_FILES = Number(process.env.GDELT_EVENT_FILES) || 24; // 24 × 15 min = 6 h
const GKG_FILES = Number(process.env.GDELT_GKG_FILES) || 4;      // 4 × 15 min = 1 h

// ─── throttled DOC/GEO search (ad-hoc use only) ─────────────────────────
let docChain = Promise.resolve();
let lastDocCall = 0;
function throttledFetch(url, opts) {
  const run = docChain.then(async () => {
    const wait = lastDocCall + DOC_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastDocCall = Date.now();
    return safeFetch(url, { timeout: 20000, retries: 0, ...opts });
  });
  docChain = run.catch(() => {});
  return run;
}

// Search recent global events/articles by keyword (DOC 2.0, throttled)
export async function searchEvents(query = '', opts = {}) {
  const {
    mode = 'ArtList',
    maxRecords = 75,
    timespan = '24h',
    format = 'json',
    sortBy = 'DateDesc',
    timeout = 20000,
  } = opts;
  const q = query || '(conflict OR crisis OR military OR sanctions OR war OR economy)';
  const finalQ = (q.includes(' OR ') && !q.startsWith('(')) ? `(${q})` : q;
  const params = new URLSearchParams({ query: finalQ, mode, maxrecords: String(maxRecords), timespan, format, sort: sortBy });
  return throttledFetch(`${BASE}/doc/doc?${params}`, { timeout });
}

// Geographic event mapping (GEO 2.0, throttled)
export async function geoEvents(query = '', opts = {}) {
  const { mode = 'PointData', format = 'GeoJSON', timespan = '24h', maxPoints = 250 } = opts;
  const q = query || '(conflict OR military OR protest OR crisis)';
  const finalQ = (q.includes(' OR ') && !q.startsWith('(')) ? `(${q})` : q;
  const params = new URLSearchParams({ query: finalQ, mode, format, timespan, maxpoints: String(maxPoints) });
  return throttledFetch(`${BASE}/geo/geo?${params}`, { timeout: 15000 });
}

// ─── shared feed snapshot (one download set per sweep, shared by consumers) ──
let snapshotPromise = null;
let snapshotAt = 0;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

// Returns { latest, events, articles, eventFiles, gkgFiles, errors }
export function loadFeeds({ force = false } = {}) {
  if (!force && snapshotPromise && Date.now() - snapshotAt < SNAPSHOT_TTL_MS) return snapshotPromise;
  snapshotAt = Date.now();
  snapshotPromise = (async () => {
    const latest = await latestStamp();
    const [ev, gkg] = await Promise.all([
      loadRecent('export', { latest, count: EVENT_FILES }),
      loadRecent('gkg', { latest, count: GKG_FILES, timeout: 30000, concurrency: 2 }),
    ]);
    const events = ev.rows.map(compactEvent);
    const articles = gkg.rows.map(compactGkg).filter(Boolean);
    return {
      latest,
      events,
      articles,
      eventFiles: { requested: ev.stamps.length, loaded: ev.stamps.length - ev.failed.length, fetched: ev.fetched, failed: ev.failed },
      gkgFiles: { requested: gkg.stamps.length, loaded: gkg.stamps.length - gkg.failed.length, fetched: gkg.fetched, failed: gkg.failed },
    };
  })();
  snapshotPromise.catch(() => { snapshotPromise = null; });
  return snapshotPromise;
}

// ─── analysis helpers ───────────────────────────────────────────────────
// Monitored regions for tone scoring — matched on ActionGeo country codes (FIPS 10-4)
const MONITORED_REGIONS = [
  { name: 'Ukraine/Russia', countries: ['UP', 'RS', 'BO'], keywords: ['ukraine', 'russia', 'kyiv', 'moscow', 'kremlin'] },
  { name: 'Middle East', countries: ['IR', 'IS', 'GZ', 'WE', 'SY', 'IZ', 'YM', 'LE'], keywords: ['iran', 'israel', 'gaza', 'syria', 'iraq', 'yemen', 'hezbollah', 'houthi'] },
  { name: 'East Asia', countries: ['CH', 'TW', 'KN', 'KS', 'JA', 'RP'], keywords: ['china', 'taiwan', 'north korea', 'south china sea', 'beijing', 'pyongyang'] },
  { name: 'Africa', countries: ['SU', 'ET', 'SO', 'CG', 'CF', 'ML', 'NG', 'UV', 'NI'], keywords: ['sudan', 'ethiopia', 'somalia', 'congo', 'sahel', 'mali', 'niger'] },
  { name: 'Latin America', countries: ['VE', 'CO', 'MX', 'HA', 'EC', 'GT', 'HO', 'ES'], keywords: ['venezuela', 'colombia', 'cartel', 'mexico', 'haiti', 'ecuador'] },
];

const CONFLICT_ROOTS = new Set(['18', '19', '20']);
const THEME_BUCKETS = {
  conflicts: /^(ARMEDCONFLICT|KILL|WOUND|TERROR|MILITARY|SEIGE|CRISISLEX_T03_DEAD|WB_2432_FRAGILITY_CONFLICT|CEASEFIRE|BLOCKADE)/,
  economy: /^(ECON_|EPU_ECONOMY|WB_(698|450|1[0-9]{3})_|TAX_ECON|INFLATION|SANCTIONS|TRADE|UNEMPLOYMENT)/,
  health: /^(GENERAL_HEALTH|MEDICAL|HEALTH_PANDEMIC|HEALTH_VACCINATION|TAX_DISEASE|WB_(621|1406)_|EPIDEMIC)/,
  crisis: /^(NATURAL_DISASTER|CRISISLEX_(C03|T01|T02|T05|T06|T08)|REFUGEES|DISPLACED|EVACUATION|FOOD_SECURITY|HUMAN_RIGHTS_ABUSES)/,
};
const TITLE_KEYWORDS = {
  conflicts: ['military', 'conflict', 'war', 'strike', 'missile', 'attack', 'bomb', 'troops'],
  economy: ['economy', 'recession', 'inflation', 'market', 'sanctions', 'tariff', 'trade', 'gdp'],
  health: ['pandemic', 'outbreak', 'epidemic', 'disease', 'virus', 'health'],
  crisis: ['crisis', 'disaster', 'emergency', 'refugee', 'famine'],
};

export function categorizeArticles(articles) {
  const out = { conflicts: [], economy: [], health: [], crisis: [] };
  for (const a of articles) {
    const t = (a.title || '').toLowerCase();
    for (const bucket of Object.keys(out)) {
      const themeHit = (a.themes || []).some(th => THEME_BUCKETS[bucket].test(th));
      const kwHit = TITLE_KEYWORDS[bucket].some(k => t.includes(k));
      if (themeHit || kwHit) out[bucket].push(a);
    }
  }
  return out;
}

// Geographic clustering — group events by proximity
export function clusterGeoPoints(points, radiusDeg = 2) {
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    const cluster = { lat: points[i].lat, lon: points[i].lon, count: points[i].count || 1, names: [points[i].name], points: [points[i]] };
    used.add(i);
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      const dLat = Math.abs(points[j].lat - cluster.lat);
      const dLon = Math.abs(points[j].lon - cluster.lon);
      if (dLat < radiusDeg && dLon < radiusDeg) {
        cluster.count += points[j].count || 1;
        cluster.names.push(points[j].name);
        cluster.points.push(points[j]);
        cluster.lat = (cluster.lat + points[j].lat) / 2;
        cluster.lon = (cluster.lon + points[j].lon) / 2;
        used.add(j);
      }
    }
    cluster.label = cluster.names.filter(Boolean).slice(0, 3).join(', ') || 'Event cluster';
    clusters.push(cluster);
  }
  return clusters.sort((a, b) => b.count - a.count);
}

// Aggregate conflict/unrest events into map points (one per named place)
export function buildGeoPoints(events, limit = 50) {
  const byPlace = new Map();
  for (const ev of events) {
    if (ev.lat === null || ev.lon === null) continue;
    if (!(ev.quad >= 3 || ev.root === '14')) continue; // material/verbal conflict or protest
    const key = ev.place || `${ev.lat.toFixed(1)},${ev.lon.toFixed(1)}`;
    const cur = byPlace.get(key) || { lat: ev.lat, lon: ev.lon, name: ev.place, country: ev.country, count: 0, mentions: 0, type: 'event' };
    cur.count += 1;
    cur.mentions += ev.mentions;
    if (CONFLICT_ROOTS.has(ev.root)) cur.type = 'conflict';
    else if (ev.root === '14' && cur.type !== 'conflict') cur.type = 'protest';
    byPlace.set(key, cur);
  }
  return Array.from(byPlace.values()).sort((a, b) => b.count - a.count || b.mentions - a.mentions).slice(0, limit);
}

// Regional tone: compare the newest half of the window against the older half
export function buildToneScores(events, articles, latest) {
  const latestMs = latest ? dateFromStamp(latest).getTime() : Date.now();
  const halfMs = (EVENT_FILES * 15 * 60 * 1000) / 2;
  const stampMs = s => dateFromStamp(s).getTime();
  return MONITORED_REGIONS.map(region => {
    const set = new Set(region.countries);
    const regionEvents = events.filter(e => set.has(e.country));
    const recent = regionEvents.filter(e => latestMs - stampMs(e.stamp) < halfMs);
    const older = regionEvents.filter(e => latestMs - stampMs(e.stamp) >= halfMs);
    const avg = arr => arr.length ? arr.reduce((s, e) => s + e.tone, 0) / arr.length : 0;
    const currentTone = +avg(recent.length ? recent : regionEvents).toFixed(2);
    const previousTone = older.length ? +avg(older).toFixed(2) : currentTone;
    const articleCount = articles.filter(a => region.keywords.some(k => a.title.toLowerCase().includes(k))).length;
    const conflictEvents = regionEvents.filter(e => CONFLICT_ROOTS.has(e.root)).length;
    const recentConflict = recent.filter(e => CONFLICT_ROOTS.has(e.root)).length;
    const olderConflict = older.filter(e => CONFLICT_ROOTS.has(e.root)).length;
    return {
      region: region.name,
      articleCount,
      eventCount: regionEvents.length,
      conflictEvents,
      recentConflict,
      olderConflict,
      currentTone,
      previousTone,
      shift: +(currentTone - previousTone).toFixed(2),
      dataPoints: regionEvents.length,
    };
  }).filter(r => r.eventCount > 0 || r.articleCount > 0);
}

export function buildPriorityAlerts(toneScores, windowHours) {
  const alerts = [];
  for (const t of toneScores) {
    if (t.shift <= -1.5 && t.dataPoints >= 20) {
      alerts.push({
        tier: 'PRIORITY',
        headline: `TONE DETERIORATION: ${t.region} — ${t.currentTone} (was ${t.previousTone})`,
        detail: `Average GDELT tone fell ${Math.abs(t.shift)} points across ${t.dataPoints} events in ${windowHours}h`,
      });
    }
    // Spike: the newer half of the window carries ≥1.5× the material-conflict events of the older half
    if (t.recentConflict >= 20 && t.olderConflict > 0 && t.recentConflict >= t.olderConflict * 1.5) {
      alerts.push({
        tier: 'PRIORITY',
        headline: `CONFLICT SPIKE: ${t.region} — ${t.recentConflict} assault/fight events vs ${t.olderConflict} in the prior ${windowHours / 2}h`,
        detail: `Material-conflict CAMEO events (assault, fighting, mass violence) up ${Math.round((t.recentConflict / t.olderConflict - 1) * 100)}% half-window over half-window`,
      });
    }
  }
  return alerts;
}

export function topEvents(events, limit = 10) {
  return events
    .filter(e => e.place && e.mentions >= 5 && (e.quad === 4 || e.goldstein <= -7))
    .sort((a, b) => b.mentions - a.mentions || a.goldstein - b.goldstein)
    .slice(0, limit)
    .map(e => ({
      headline: eventHeadline(e),
      type: CAMEO_ROOT[e.root] || 'Event',
      place: e.place,
      country: e.country,
      mentions: e.mentions,
      goldstein: e.goldstein,
      tone: +e.tone.toFixed(2),
      url: e.url,
      lat: e.lat,
      lon: e.lon,
    }));
}

// ─── briefing ───────────────────────────────────────────────────────────
export async function briefing() {
  const windowHours = (EVENT_FILES * 15) / 60;
  let feeds;
  try {
    feeds = await loadFeeds();
  } catch (e) {
    return {
      source: 'GDELT',
      timestamp: new Date().toISOString(),
      mode: 'export',
      error: `GDELT export feed unavailable: ${e.message}`,
      totalArticles: 0,
      allArticles: [],
      geoPoints: [],
      geoClusters: [],
      toneScores: [],
      conflicts: [], economy: [], health: [], crisis: [],
      priorityAlerts: [],
    };
  }

  const { events, articles, latest } = feeds;
  const buckets = categorizeArticles(articles);
  const geoPoints = buildGeoPoints(events);
  const toneScores = buildToneScores(events, articles, latest);
  const conflictEvents = events.filter(e => CONFLICT_ROOTS.has(e.root)).length;
  const partial = feeds.eventFiles.failed.length || feeds.gkgFiles.failed.length;

  // Headline-worthy articles (any monitored theme) first, then newest; cap what we carry into the run file
  const themed = new Set([...buckets.conflicts, ...buckets.crisis, ...buckets.economy, ...buckets.health]);
  const allArticles = articles
    .slice()
    .sort((a, b) => (themed.has(b) - themed.has(a)) || (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
    .slice(0, 300)
    .map(({ themes, ...a }) => a);
  const slim = arr => arr.slice(0, 60).map(({ themes, ...a }) => a);

  return {
    source: 'GDELT',
    timestamp: new Date().toISOString(),
    mode: 'export',
    feedStamp: latest,
    windowHours,
    articleWindowHours: (GKG_FILES * 15) / 60,
    totalArticles: articles.length,
    totalEvents: events.length,
    conflictEvents,
    allArticles,
    topEvents: topEvents(events),
    geoPoints,
    geoClusters: clusterGeoPoints(geoPoints).slice(0, 20),
    toneScores,
    conflicts: slim(buckets.conflicts),
    economy: slim(buckets.economy),
    health: slim(buckets.health),
    crisis: slim(buckets.crisis),
    priorityAlerts: buildPriorityAlerts(toneScores, windowHours),
    files: { events: feeds.eventFiles, gkg: feeds.gkgFiles },
    ...(partial ? { status: 'partial', note: `${feeds.eventFiles.failed.length} event file(s) and ${feeds.gkgFiles.failed.length} GKG file(s) failed to download` } : {}),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('gdelt.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
