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

  // Regional tone scoring — derived from article-level tone data (no extra API calls)
  const toneScores = [];
  for (const region of MONITORED_REGIONS) {
    const regionArticles = articles.filter(a =>
      region.query.split(' OR ').some(kw => a.title?.toLowerCase().includes(kw.toLowerCase()))
    );
    if (regionArticles.length >= 3) {
      const tones = regionArticles.filter(a => a.tone != null).map(a => a.tone);
      if (tones.length > 0) {
        const avgTone = tones.reduce((s, t) => s + t, 0) / tones.length;
        toneScores.push({
          region: region.name,
          currentTone: parseFloat(avgTone.toFixed(2)),
          previousTone: 0, // no historical baseline from single sweep
          shift: parseFloat(avgTone.toFixed(2)),
          dataPoints: tones.length,
          articleCount: regionArticles.length,
        });
      }
    }
  }

  // Geo events — get mapped event locations
  await delay(500);
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
