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
  const q = query || 'conflict OR crisis OR military OR sanctions OR war OR economy';
  const params = new URLSearchParams({
    query: q,
    mode,
    maxrecords: String(maxRecords),
    timespan,
    format,
    sort: sortBy,
  });

  return safeFetch(`${BASE}/doc/doc?${params}`);
}

// Get tone/sentiment timeline for a topic
export async function toneTrend(query, timespan = '7d') {
  const params = new URLSearchParams({
    query,
    mode: 'TimelineTone',
    timespan,
    format: 'json',
  });
  return safeFetch(`${BASE}/doc/doc?${params}`);
}

// Get volume timeline for a topic (how much coverage)
export async function volumeTrend(query, timespan = '7d') {
  const params = new URLSearchParams({
    query,
    mode: 'TimelineVol',
    timespan,
    format: 'json',
  });
  return safeFetch(`${BASE}/doc/doc?${params}`);
}

// GEO API — geographic event mapping
export async function geoEvents(query = '', opts = {}) {
  const {
    mode = 'PointData',
    timespan = '24h',
    format = 'GeoJSON',
    maxPoints = 500,
  } = opts;

  const q = query || 'conflict OR military OR protest OR explosion';
  const params = new URLSearchParams({
    query: q,
    mode,
    timespan,
    format,
    maxpoints: String(maxPoints),
  });

  return safeFetch(`${BASE}/geo/geo?${params}`);
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
    tone: a.tone != null ? parseFloat(a.tone) : null,
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

// Briefing mode — full integration with tone scoring + geographic clustering
export async function briefing() {
  // Broad query for global events
  const all = await searchEvents(
    'conflict OR military OR economy OR crisis OR war OR sanctions OR tariff OR strike OR outbreak',
    { maxRecords: 75, timespan: '24h' }
  );

  const articles = (all?.articles || []).map(compactArticle);

  // Categorize by keyword matching in titles
  const categorize = (keywords) => articles.filter(a =>
    keywords.some(k => a.title?.toLowerCase().includes(k))
  );

  // Regional tone scoring — get tone trends for top 3 monitored regions
  // (limited to avoid 30s source timeout; GDELT rate limit is ~1 req/5s)
  const toneScores = [];
  for (const region of MONITORED_REGIONS.slice(0, 3)) {
    await delay(3000); // shorter delay — GDELT is lenient on light usage
    try {
      const toneData = await toneTrend(region.query, '7d');
      const timeline = toneData?.timeline || [];
      if (timeline.length >= 2) {
        const recent = timeline.slice(-3);
        const older = timeline.slice(0, Math.min(3, timeline.length - 3));
        const recentAvg = recent.reduce((s, t) => s + (t.value || t.tone || 0), 0) / recent.length;
        const olderAvg = older.length > 0 ? older.reduce((s, t) => s + (t.value || t.tone || 0), 0) / older.length : recentAvg;
        const shift = recentAvg - olderAvg;
        toneScores.push({
          region: region.name,
          currentTone: parseFloat(recentAvg.toFixed(2)),
          previousTone: parseFloat(olderAvg.toFixed(2)),
          shift: parseFloat(shift.toFixed(2)),
          dataPoints: timeline.length,
        });
      }
    } catch (e) { /* tone endpoint optional */ }
  }

  // Geo events — get mapped event locations
  await delay(3000);
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

  // PRIORITY alerts: sharp tone drops in monitored regions
  const priorityAlerts = toneScores
    .filter(t => t.shift < -2.0) // significant negative shift
    .map(t => ({
      tier: 'PRIORITY',
      headline: `TONE DETERIORATION: ${t.region} tone dropped ${Math.abs(t.shift).toFixed(1)} points`,
      detail: `Current: ${t.currentTone}, Previous: ${t.previousTone} (${t.dataPoints} data points over 7 days)`,
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
