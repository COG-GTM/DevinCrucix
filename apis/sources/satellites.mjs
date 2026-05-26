// Satellite Tracking — Self-contained TLE/SGP4 Propagation
// Fetches TLE data from CelesTrak, computes real-time positions using simplified SGP4
// Classifies satellites by mission type (SIGINT, Recon, Navigation, etc.)
// Ported from Osiris OSINT platform's satellite tracking API
// FREE — no API key required

import { safeFetch } from '../utils/fetch.mjs';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let _cache = null;
let _cacheTs = 0;

// TLE sources from CelesTrak (free, no key)
const TLE_SOURCES = [
  { url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle', label: 'Active' },
  { url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle', label: 'SpaceStations' },
  { url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=military&FORMAT=tle', label: 'Military' },
];

// Mission classification by NORAD name keywords
const MISSION_CLASSIFY = {
  'USA': { mission: 'Military Recon', color: '#FF3D3D', category: 'military' },
  'NROL': { mission: 'NRO Classified', color: '#FF3D3D', category: 'military' },
  'LACROSSE': { mission: 'SAR Imaging', color: '#00E5FF', category: 'military' },
  'MENTOR': { mission: 'SIGINT', color: '#FFFFFF', category: 'military' },
  'ORION': { mission: 'SIGINT', color: '#FFFFFF', category: 'military' },
  'TRUMPET': { mission: 'SIGINT', color: '#FFFFFF', category: 'military' },
  'INTRUDER': { mission: 'SIGINT', color: '#FFFFFF', category: 'military' },
  'GPS': { mission: 'Navigation', color: '#448AFF', category: 'navigation' },
  'NAVSTAR': { mission: 'Navigation', color: '#448AFF', category: 'navigation' },
  'GLONASS': { mission: 'Navigation', color: '#448AFF', category: 'navigation' },
  'GALILEO': { mission: 'Navigation', color: '#448AFF', category: 'navigation' },
  'BEIDOU': { mission: 'Navigation', color: '#448AFF', category: 'navigation' },
  'SBIRS': { mission: 'Early Warning', color: '#FF00FF', category: 'military' },
  'DSP': { mission: 'Early Warning', color: '#FF00FF', category: 'military' },
  'STARLINK': { mission: 'Commercial Comms', color: '#00E676', category: 'commercial' },
  'ONEWEB': { mission: 'Commercial Comms', color: '#00E676', category: 'commercial' },
  'PLANET': { mission: 'Earth Imaging', color: '#00E676', category: 'commercial' },
  'WORLDVIEW': { mission: 'Commercial Imaging', color: '#00E676', category: 'commercial' },
  'ISS': { mission: 'Space Station', color: '#FFD700', category: 'station' },
  'TIANGONG': { mission: 'Space Station', color: '#FFD700', category: 'station' },
  'COSMOS': { mission: 'Russian Military', color: '#FF6B6B', category: 'military' },
  'YAOGAN': { mission: 'Chinese Recon', color: '#FF6B6B', category: 'military' },
  'FENGYUN': { mission: 'Weather', color: '#87CEEB', category: 'weather' },
  'GOES': { mission: 'Weather', color: '#87CEEB', category: 'weather' },
  'NOAA': { mission: 'Weather', color: '#87CEEB', category: 'weather' },
  'METEOSAT': { mission: 'Weather', color: '#87CEEB', category: 'weather' },
  'LANDSAT': { mission: 'Earth Observation', color: '#90EE90', category: 'science' },
  'SENTINEL': { mission: 'Earth Observation', color: '#90EE90', category: 'science' },
  'TERRA': { mission: 'Earth Science', color: '#90EE90', category: 'science' },
  'AQUA': { mission: 'Earth Science', color: '#90EE90', category: 'science' },
  'HUBBLE': { mission: 'Space Telescope', color: '#FFD700', category: 'science' },
};

function classifySatellite(name) {
  const upper = (name || '').toUpperCase();
  for (const [keyword, info] of Object.entries(MISSION_CLASSIFY)) {
    if (upper.includes(keyword)) return info;
  }
  return { mission: 'Unknown', color: '#808080', category: 'unknown' };
}

function parseTLE(tleText) {
  if (!tleText || typeof tleText !== 'string') return [];
  const lines = tleText.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const satellites = [];

  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    if (name.startsWith('1 ') || name.startsWith('2 ')) continue;

    satellites.push({ name: name.trim(), line1, line2 });
    i += 2;
  }
  return satellites;
}

// Simplified SGP4 propagation for real-time position estimation
function propagatePosition(line1, line2) {
  try {
    const incDeg = parseFloat(line2.substring(8, 16));
    const raanDeg = parseFloat(line2.substring(17, 25));
    const eccStr = '0.' + line2.substring(26, 33).trim();
    const ecc = parseFloat(eccStr);
    const argPerDeg = parseFloat(line2.substring(34, 42));
    const meanAnomDeg = parseFloat(line2.substring(43, 51));
    const meanMotion = parseFloat(line2.substring(52, 63));

    if (isNaN(meanMotion) || meanMotion === 0) return null;

    const now = new Date();
    const epochYear = parseInt(line1.substring(18, 20));
    const epochDay = parseFloat(line1.substring(20, 32));
    const fullYear = epochYear > 56 ? 1900 + epochYear : 2000 + epochYear;

    const epochDate = new Date(fullYear, 0, 1);
    epochDate.setDate(epochDate.getDate() + epochDay - 1);
    const elapsedMin = (now.getTime() - epochDate.getTime()) / 60000;

    // Reject stale TLEs (> 30 days old)
    if (Math.abs(elapsedMin) > 43200) return null;

    const n = meanMotion * 2 * Math.PI / 1440;
    const M = ((meanAnomDeg * Math.PI / 180) + n * elapsedMin) % (2 * Math.PI);

    // Kepler's equation (Newton-Raphson)
    let E = M;
    for (let j = 0; j < 10; j++) {
      E = M + ecc * Math.sin(E);
    }

    const sinV = Math.sqrt(1 - ecc * ecc) * Math.sin(E) / (1 - ecc * Math.cos(E));
    const cosV = (Math.cos(E) - ecc) / (1 - ecc * Math.cos(E));
    const v = Math.atan2(sinV, cosV);

    const a = Math.pow(398600.4418 / Math.pow(meanMotion * 2 * Math.PI / 86400, 2), 1 / 3);
    const r = a * (1 - ecc * Math.cos(E));

    const inc = incDeg * Math.PI / 180;
    const raan = raanDeg * Math.PI / 180;
    const argPer = argPerDeg * Math.PI / 180;
    const u = v + argPer;

    const xECI = r * (Math.cos(raan) * Math.cos(u) - Math.sin(raan) * Math.sin(u) * Math.cos(inc));
    const yECI = r * (Math.sin(raan) * Math.cos(u) + Math.cos(raan) * Math.sin(u) * Math.cos(inc));
    const zECI = r * Math.sin(u) * Math.sin(inc);

    // GMST for ECI → ECEF
    const jd = 2440587.5 + now.getTime() / 86400000;
    const t = (jd - 2451545.0) / 36525.0;
    const gmstSec = 67310.54841 + (876600.0 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t;
    const gmstRad = ((gmstSec % 86400) / 86400.0) * 2 * Math.PI;

    const xECEF = xECI * Math.cos(gmstRad) + yECI * Math.sin(gmstRad);
    const yECEF = -xECI * Math.sin(gmstRad) + yECI * Math.cos(gmstRad);

    const lng = Math.atan2(yECEF, xECEF) * 180 / Math.PI;
    const lat = Math.asin(zECI / r) * 180 / Math.PI;
    const alt = r - 6371; // altitude above Earth's surface in km

    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat: +lat.toFixed(3), lng: +lng.toFixed(3), alt: Math.round(alt) };
  } catch {
    return null;
  }
}

export async function fetchSatellites() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  console.log('[Satellites] Fetching TLE data from CelesTrak...');

  // Fetch from military source only (most relevant for OSINT, ~300 satellites)
  const militaryRaw = await safeFetch(TLE_SOURCES[2].url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' },
  });

  let allSats = [];
  if (militaryRaw && !militaryRaw.error && militaryRaw.rawText) {
    allSats = parseTLE(militaryRaw.rawText);
  }

  // Also fetch space stations
  const stationsRaw = await safeFetch(TLE_SOURCES[1].url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' },
  });
  if (stationsRaw && !stationsRaw.error && stationsRaw.rawText) {
    const stationSats = parseTLE(stationsRaw.rawText);
    // Only add ISS/Tiangong (avoid duplicates from full active set)
    for (const s of stationSats) {
      const upper = s.name.toUpperCase();
      if (upper.includes('ISS') || upper.includes('ZARYA') || upper.includes('TIANGONG')) {
        allSats.push(s);
      }
    }
  }

  // Propagate positions and classify
  const tracked = [];
  const byCategory = {};
  const byMission = {};

  for (const sat of allSats) {
    const pos = propagatePosition(sat.line1, sat.line2);
    if (!pos) continue;

    const classification = classifySatellite(sat.name);
    const entry = {
      name: sat.name,
      lat: pos.lat,
      lng: pos.lng,
      alt: pos.alt,
      mission: classification.mission,
      color: classification.color,
      category: classification.category,
    };

    tracked.push(entry);
    byCategory[classification.category] = (byCategory[classification.category] || 0) + 1;
    byMission[classification.mission] = (byMission[classification.mission] || 0) + 1;
  }

  console.log(`[Satellites] ${tracked.length} satellites tracked from ${allSats.length} TLEs`);

  // Generate signals for notable satellite activity
  const signals = [];
  const militaryCount = byCategory.military || 0;
  if (militaryCount > 0) {
    signals.push({
      severity: 'info',
      signal: `${militaryCount} military/intelligence satellites tracked. Categories: ${Object.entries(byMission).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    });
  }

  const result = {
    source: 'Satellites',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalTracked: tracked.length,
    totalTLEs: allSats.length,
    byCategory,
    byMission,
    satellites: tracked.slice(0, 200), // cap at 200 for dashboard
    signals,
  };

  _cache = result;
  _cacheTs = Date.now();
  return result;
}

export async function briefing() {
  return fetchSatellites();
}

if (process.argv[1]?.endsWith('satellites.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
