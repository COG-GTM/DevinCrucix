// GDELT — Global Database of Events, Language, and Tone
// No auth required. Updates every 15 minutes. Monitors news in 100+ languages.
// DOC 2.0 API: full-text search across last 3 months of global news
// GEO 2.0 API: geolocation mapping of events

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.gdeltproject.org/api/v2';

// Search recent global events/articles by keyword
export async function searchEvents(query = '', opts = {}) {
  const {
    mode = 'ArtList',       // ArtList, TimelineVol, TimelineVolInfo, TimelineTone, TimelineLang, TimelineSourceCountry
    maxRecords = 75,
    timespan = '24h',       // e.g. "24h", "7d", "3m"
    format = 'json',
    sortBy = 'DateDesc',    // DateDesc, DateAsc, ToneDesc, ToneAsc
  } = opts;

  // If no query, use broad geopolitical terms
  // GDELT requires OR'd terms to be wrapped in parentheses
  const q = query || '(conflict OR crisis OR military OR sanctions OR war OR economy)';
  // Ensure OR queries are parenthesized
  const finalQ = (q.includes(' OR ') && !q.startsWith('(')) ? `(${q})` : q;
  const params = new URLSearchParams({
    query: finalQ,
    mode,
    maxrecords: String(maxRecords),
    timespan,
    format,
    sort: sortBy,
  });

  return safeFetch(`${BASE}/doc/doc?${params}`, { timeout: 20000, retries: 0 });
}

// GEO API — geographic event mapping
export async function geoEvents(query = '', opts = {}) {
  const {
    mode = 'PointData',
    timespan = '24h',
    format = 'GeoJSON',
    maxPoints = 500,
  } = opts;

  const raw = query || '(conflict OR military OR protest OR explosion)';
  const q = (raw.includes(' OR ') && !raw.startsWith('(')) ? `(${raw})` : raw;
  const params = new URLSearchParams({
    query: q,
    mode,
    timespan,
    format,
    maxpoints: String(maxPoints),
  });

  return safeFetch(`${BASE}/geo/geo?${params}`, { timeout: 15000, retries: 0 });
}

// Compact article for briefing
function compactArticle(a) {
  return {
    title: a.title,
    url: a.url,
    date: a.seendate,
    domain: a.domain,
    language: a.language,
    country: a.sourcecountry,
  };
}

// Monitored regions for tone scoring
const MONITORED_REGIONS = [
  { name: 'Ukraine/Russia', query: 'Ukraine OR Russia OR Kyiv OR Moscow' },
  { name: 'Middle East', query: 'Iran OR Israel OR Gaza OR Syria OR Iraq OR Yemen' },
  { name: 'East Asia', query: 'China OR Taiwan OR North Korea OR South China Sea' },
  { name: 'Africa', query: 'Sudan OR Ethiopia OR Somalia OR Congo OR Sahel' },
  { name: 'Latin America', query: 'Venezuela OR Colombia OR Mexico cartel OR Central America' },
];

// Geographic clustering — group events by proximity
function clusterGeoPoints(points, radiusDeg = 2) {
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
        // Update centroid
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

// GDELT rate limit: 1 request per 5 seconds
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Briefing mode — full integration with regional coverage + geographic clustering
export async function briefing() {
  // Stagger start to avoid rate-limit collisions with other concurrent sources
  await delay(3000);

  // Broad query for global events — retry up to 3 times if rate-limited
  let all;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(6000); // GDELT rate limit: 1 req per 5s
    all = await searchEvents(
      'conflict OR military OR economy OR crisis OR war OR sanctions OR tariff OR strike OR outbreak',
      { maxRecords: 75, timespan: '24h' }
    );
    // If we got articles or a real error (not rate-limit text), stop retrying
    if (all?.articles?.length > 0 || all?.error) break;
    // rawText means we got a non-JSON response (likely rate limit message)
    if (all?.rawText && !all.rawText.includes('Please limit requests')) break;
  }

  const articles = (all?.articles || []).map(compactArticle);

  // Categorize by keyword matching in titles
  const categorize = (keywords) => articles.filter(a =>
    keywords.some(k => a.title?.toLowerCase().includes(k))
  );

  // Regional article coverage — count articles per monitored region
  // Note: GDELT ArtList mode doesn't include tone scores; regional coverage
  // is tracked by article count instead.
  const toneScores = MONITORED_REGIONS.map(region => {
    const regionArticles = articles.filter(a =>
      region.query.split(' OR ').some(kw => a.title?.toLowerCase().includes(kw.toLowerCase()))
    );
    return {
      region: region.name,
      articleCount: regionArticles.length,
      currentTone: 0, // ArtList doesn't include tone
      previousTone: 0,
      shift: 0,
      dataPoints: 0,
    };
  }).filter(r => r.articleCount > 0);

  // Geo events — get mapped event locations
  await delay(6000); // respect GDELT 5s rate limit
  let geoPoints = [];
  try {
    const geo = await geoEvents('conflict OR military OR protest OR crisis OR explosion', { maxPoints: 50, timespan: '24h' });
    geoPoints = (geo?.features || []).filter(f => f.geometry?.coordinates).map(f => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      name: f.properties?.name || f.properties?.html || '',
      count: f.properties?.count || 1,
      type: f.properties?.type || 'event',
    }));
  } catch (e) { /* geo endpoint optional */ }

  // Geographic event clustering
  const geoClusters = clusterGeoPoints(geoPoints);

  // PRIORITY alerts: high volume coverage in monitored regions
  const priorityAlerts = toneScores
    .filter(t => t.articleCount >= 10) // significant coverage spike
    .map(t => ({
      tier: 'PRIORITY',
      headline: `HIGH COVERAGE: ${t.region} — ${t.articleCount} articles in last 24h`,
      detail: `Region is generating significant news coverage`,
    }));

  return {
    source: 'GDELT',
    timestamp: new Date().toISOString(),
    totalArticles: articles.length,
    allArticles: articles,
    geoPoints,
    geoClusters: geoClusters.slice(0, 20),
    toneScores,
    conflicts: categorize(['military', 'conflict', 'war', 'strike', 'missile', 'attack', 'bomb', 'troops']),
    economy: categorize(['economy', 'recession', 'inflation', 'market', 'sanctions', 'tariff', 'trade', 'gdp']),
    health: categorize(['pandemic', 'outbreak', 'epidemic', 'disease', 'virus', 'health']),
    crisis: categorize(['crisis', 'disaster', 'emergency', 'refugee', 'famine']),
    priorityAlerts,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('gdelt.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
