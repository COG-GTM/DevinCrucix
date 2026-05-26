// Ukraine Frontline — DeepState Map Integration
// Live warfront GeoJSON positions from DeepState Map API
// Ported from Osiris OSINT platform's frontlines API
// FREE — no API key required
// Provides real-time conflict zone visualization

import { safeFetch } from '../utils/fetch.mjs';

const DEEPSTATE_URL = 'https://deepstatemap.live/api/history/last';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let _cache = null;
let _cacheTs = 0;

export async function fetchFrontlines() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    const raw = await safeFetch(DEEPSTATE_URL, {
      timeout: 15000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)',
      },
    });

    if (raw.error) {
      console.log(`[Frontlines] API error: ${raw.error}`);
      return _cache || { source: 'Frontlines', status: 'unavailable', error: raw.error, geojson: null, signals: [] };
    }

    // DeepState wraps GeoJSON inside a `map` property
    const geojson = raw.type === 'FeatureCollection' ? raw : (raw.map || raw.geojson || raw.data || raw);

    let featureCount = 0;
    let totalCoords = 0;
    const featureTypes = {};

    if (geojson && geojson.features) {
      featureCount = geojson.features.length;
      for (const feature of geojson.features) {
        const gType = feature.geometry?.type || 'unknown';
        featureTypes[gType] = (featureTypes[gType] || 0) + 1;
        if (feature.geometry?.coordinates) {
          const coords = feature.geometry.coordinates;
          if (Array.isArray(coords[0])) {
            totalCoords += coords.length;
          } else {
            totalCoords += 1;
          }
        }
      }
    }

    const signals = [];
    if (featureCount > 0) {
      signals.push({
        severity: 'info',
        signal: `Ukraine frontline data: ${featureCount} features, ${totalCoords} coordinate points from DeepState Map.`,
      });
    }

    const result = {
      source: 'Frontlines',
      timestamp: new Date().toISOString(),
      status: 'live',
      geojson,
      featureCount,
      totalCoords,
      featureTypes,
      signals,
    };

    _cache = result;
    _cacheTs = Date.now();
    return result;
  } catch (err) {
    console.log(`[Frontlines] Fetch error: ${err.message}`);
    if (_cache) return _cache;
    return {
      source: 'Frontlines',
      timestamp: new Date().toISOString(),
      status: 'unavailable',
      error: err.message,
      geojson: null,
      signals: [],
    };
  }
}

export async function briefing() {
  return fetchFrontlines();
}

if (process.argv[1]?.endsWith('frontlines.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
