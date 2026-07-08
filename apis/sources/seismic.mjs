// Seismic Event Monitor — USGS live earthquake feed with nuclear-test discrimination
// Pulls all M2.5+ events from the last 24h and flags shallow events near known
// nuclear test sites (classic underground-test signature: shallow depth, proximity
// to a historic test range).
// FREE — no API key required (USGS FDSN public feed)

import { safeFetch } from '../utils/fetch.mjs';

const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cache = null;
let _cacheTs = 0;

// Historic / active nuclear test sites — proximity to these + shallow depth = suspect
const TEST_SITES = [
  { name: 'Punggye-ri', country: 'KP', lat: 41.28, lng: 129.09 },
  { name: 'Lop Nur', country: 'CN', lat: 41.5, lng: 88.5 },
  { name: 'Novaya Zemlya', country: 'RU', lat: 73.4, lng: 54.8 },
  { name: 'Semipalatinsk', country: 'KZ', lat: 50.07, lng: 78.43 },
  { name: 'Nevada NNSS', country: 'US', lat: 37.12, lng: -116.05 },
  { name: 'Pokhran', country: 'IN', lat: 27.08, lng: 71.72 },
  { name: 'Chagai Hills', country: 'PK', lat: 28.8, lng: 64.5 },
];

const SUSPECT_RADIUS_KM = 250;
const SUSPECT_MAX_DEPTH_KM = 15;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestTestSite(lat, lng) {
  let best = null;
  for (const site of TEST_SITES) {
    const km = haversineKm(lat, lng, site.lat, site.lng);
    if (!best || km < best.km) best = { site, km };
  }
  return best;
}

export async function collectSeismic() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;

  const data = await safeFetch(USGS_FEED, { timeout: 12000, retries: 1 });
  if (data.error || !Array.isArray(data.features)) {
    return _cache || { status: 'unavailable', totalEvents: 0, events: [], suspectEvents: [], signals: [] };
  }

  const events = data.features.map((f) => {
    const [lng, lat, depth] = f.geometry?.coordinates || [];
    const p = f.properties || {};
    const near = nearestTestSite(lat, lng);
    const suspect = near && near.km <= SUSPECT_RADIUS_KM && depth != null && depth <= SUSPECT_MAX_DEPTH_KM;
    return {
      lat, lng,
      mag: p.mag,
      depthKm: depth != null ? Math.round(depth * 10) / 10 : null,
      place: p.place || 'Unknown location',
      time: p.time ? new Date(p.time).toISOString() : null,
      tsunami: p.tsunami === 1,
      suspect: !!suspect,
      nearSite: suspect ? { name: near.site.name, country: near.site.country, km: Math.round(near.km) } : null,
    };
  }).filter((e) => e.lat != null && e.lng != null);

  events.sort((a, b) => (b.mag || 0) - (a.mag || 0));

  const suspectEvents = events.filter((e) => e.suspect);
  const significant = events.filter((e) => (e.mag || 0) >= 5.0);
  const maxMag = events.length ? events[0].mag : null;

  const signals = [];
  for (const s of suspectEvents) {
    signals.push(`SUSPECT SEISMIC EVENT: M${s.mag} at ${s.depthKm}km depth, ${s.nearSite.km}km from ${s.nearSite.name} test site (${s.nearSite.country})`);
  }
  for (const s of significant.slice(0, 3)) {
    signals.push(`MAJOR QUAKE: M${s.mag} — ${s.place}`);
  }
  const tsunamiCount = events.filter((e) => e.tsunami).length;
  if (tsunamiCount > 0) signals.push(`${tsunamiCount} event(s) with tsunami flag`);

  const result = {
    status: 'live',
    source: 'USGS FDSN',
    totalEvents: events.length,
    maxMagnitude: maxMag,
    significantCount: significant.length,
    suspectCount: suspectEvents.length,
    suspectEvents,
    events: events.slice(0, 200),
    testSites: TEST_SITES,
    signals,
    timestamp: new Date().toISOString(),
  };

  _cache = result;
  _cacheTs = Date.now();
  return result;
}
