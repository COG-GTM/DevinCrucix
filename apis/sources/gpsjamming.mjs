// GPS Jamming Detection via NACp (Navigation Accuracy Category — Position) analysis
// Analyzes ADS-B aircraft telemetry to detect GPS interference zones.
// Aircraft with degraded NACp are aggregated into geographic grid cells.
// Cells exceeding severity thresholds are flagged as jamming zones.
// Adapted from Shadowbroker data_fetcher.py GPS jamming logic for CRUCIX.

import { safeFetch } from '../utils/fetch.mjs';

// --- Constants ---
// NACp below 8 = position accuracy worse than FAA-mandated 0.05 NM
const NACP_THRESHOLD = 8;
// Minimum ratio of degraded aircraft to flag a zone
const MIN_RATIO = 0.30;
// Minimum aircraft in a grid cell for statistical significance
const MIN_AIRCRAFT = 5;
// Grid cell size in degrees (1.0° ≈ 111 km at equator)
const GRID_SIZE = 1.0;

// Known conflict/jamming hotspot regions for context enrichment
const KNOWN_JAMMING_REGIONS = {
  'Eastern Mediterranean': { lat: [32, 37], lng: [30, 38] },
  'Eastern Ukraine': { lat: [47, 50], lng: [35, 40] },
  'Kaliningrad': { lat: [54, 56], lng: [19, 23] },
  'Northern Iraq / Syria': { lat: [34, 38], lng: [38, 46] },
  'Red Sea / Yemen': { lat: [12, 18], lng: [40, 50] },
  'Baltic States': { lat: [54, 60], lng: [20, 28] },
  'Northern Scandinavia': { lat: [66, 72], lng: [22, 32] },
  'Korean Peninsula': { lat: [36, 40], lng: [124, 130] },
  'South China Sea': { lat: [5, 22], lng: [105, 120] },
  'Persian Gulf': { lat: [24, 30], lng: [48, 56] },
};

function getRegionName(lat, lng) {
  for (const [name, bounds] of Object.entries(KNOWN_JAMMING_REGIONS)) {
    if (lat >= bounds.lat[0] && lat <= bounds.lat[1] &&
        lng >= bounds.lng[0] && lng <= bounds.lng[1]) {
      return name;
    }
  }
  return null;
}

// Fetch all aircraft (not just military) from ADS-B Exchange for NACp analysis
async function fetchAllAircraft() {
  // Primary: opendata.adsb.fi vectors endpoint (free, no key)
  const url = 'https://opendata.adsb.fi/api/v2/ladd';
  try {
    const data = await safeFetch(url, { timeout: 15000, retries: 1 });
    if (data && Array.isArray(data.ac)) {
      return data.ac;
    }
    if (data && Array.isArray(data.aircraft)) {
      return data.aircraft;
    }
  } catch { /* fall through */ }

  // Fallback: try the mil endpoint which also returns nac_p
  try {
    const milUrl = 'https://opendata.adsb.fi/api/v2/mil';
    const milData = await safeFetch(milUrl, { timeout: 15000, retries: 1 });
    if (milData && Array.isArray(milData.ac)) {
      return milData.ac;
    }
  } catch { /* fall through */ }

  return [];
}

function computeJammingGrid(aircraft) {
  const grid = {};

  for (const ac of aircraft) {
    const lat = ac.lat;
    const lng = ac.lon ?? ac.lng;
    if (lat == null || lng == null) continue;

    const nacp = ac.nac_p ?? ac.nacp;
    // Skip unknown accuracy (nac_p == 0) — old transponders, not evidence of jamming
    if (nacp == null || nacp === 0) continue;

    // Floor to grid cell
    const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
    const gridLng = Math.floor(lng / GRID_SIZE) * GRID_SIZE;
    const key = `${gridLat},${gridLng}`;

    if (!grid[key]) {
      grid[key] = { degraded: 0, total: 0, lat: gridLat, lng: gridLng };
    }
    grid[key].total += 1;
    if (nacp < NACP_THRESHOLD) {
      grid[key].degraded += 1;
    }
  }

  return grid;
}

function extractJammingZones(grid) {
  const zones = [];

  for (const [, cell] of Object.entries(grid)) {
    // Skip cells without enough aircraft for statistical significance
    if (cell.total < MIN_AIRCRAFT) continue;

    // Subtract 1 from degraded count (GPSJam denoising technique)
    // — a single quirky transponder can't flag an entire zone
    const adjustedDegraded = Math.max(cell.degraded - 1, 0);
    if (adjustedDegraded === 0) continue;

    const ratio = adjustedDegraded / cell.total;
    if (ratio <= MIN_RATIO) continue;

    // Severity classification
    let severity;
    if (ratio < 0.5) severity = 'low';
    else if (ratio < 0.75) severity = 'medium';
    else severity = 'high';

    // Center of grid cell
    const centerLat = cell.lat + GRID_SIZE / 2;
    const centerLng = cell.lng + GRID_SIZE / 2;

    const region = getRegionName(centerLat, centerLng);

    zones.push({
      lat: centerLat,
      lng: centerLng,
      gridLat: cell.lat,
      gridLng: cell.lng,
      gridSize: GRID_SIZE,
      severity,
      ratio: Math.round(ratio * 100) / 100,
      degraded: cell.degraded,
      total: cell.total,
      adjustedDegraded,
      pctLabel: `${Math.round(ratio * 100)}%`,
      region: region || 'Unknown',
    });
  }

  // Sort by severity (high first), then by ratio
  zones.sort((a, b) => {
    const sevOrder = { high: 3, medium: 2, low: 1 };
    return (sevOrder[b.severity] - sevOrder[a.severity]) || (b.ratio - a.ratio);
  });

  return zones;
}

export async function briefing() {
  console.log('[GPS Jamming] Starting NACp analysis...');

  let aircraft = [];
  try {
    aircraft = await fetchAllAircraft();
  } catch (e) {
    console.log('[GPS Jamming] Failed to fetch aircraft:', e.message);
    return {
      source: 'GPS Jamming Detection',
      timestamp: new Date().toISOString(),
      status: 'error',
      error: e.message,
      totalZones: 0,
      zones: [],
      gridCells: 0,
      aircraftAnalyzed: 0,
      signals: [],
    };
  }

  console.log(`[GPS Jamming] Analyzing ${aircraft.length} aircraft for NACp degradation...`);

  const grid = computeJammingGrid(aircraft);
  const zones = extractJammingZones(grid);

  // Count totals
  let totalDegraded = 0;
  let totalAnalyzed = 0;
  for (const cell of Object.values(grid)) {
    totalDegraded += cell.degraded;
    totalAnalyzed += cell.total;
  }

  // Generate signals
  const signals = [];
  const highZones = zones.filter(z => z.severity === 'high');
  const medZones = zones.filter(z => z.severity === 'medium');

  if (highZones.length > 0) {
    signals.push(`HIGH GPS INTERFERENCE: ${highZones.length} zone(s) with >75% degraded NACp — ${highZones.map(z => z.region || `[${z.lat.toFixed(1)},${z.lng.toFixed(1)}]`).join(', ')}`);
  }
  if (medZones.length > 0) {
    signals.push(`MODERATE GPS INTERFERENCE: ${medZones.length} zone(s) with 50-75% degraded NACp`);
  }
  if (zones.length === 0 && aircraft.length > 0) {
    signals.push('GPS signal integrity nominal — no significant jamming detected');
  }

  console.log(`[GPS Jamming] ${zones.length} jamming zones detected (${totalDegraded}/${totalAnalyzed} degraded aircraft)`);

  return {
    source: 'GPS Jamming Detection',
    timestamp: new Date().toISOString(),
    status: 'live',
    dataSource: 'opendata.adsb.fi NACp analysis',
    totalZones: zones.length,
    zones,
    gridCells: Object.keys(grid).length,
    aircraftAnalyzed: totalAnalyzed,
    totalDegraded,
    severityBreakdown: {
      high: highZones.length,
      medium: medZones.length,
      low: zones.filter(z => z.severity === 'low').length,
    },
    signals: signals.length > 0 ? signals : ['GPS signal integrity nominal'],
  };
}

// Run standalone
if (process.argv[1]?.endsWith('gpsjamming.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
