// Geographic Convergence Detection — Detects multi-stream convergence on geographic areas
// Maintains 1° × 1° grid cells tracking 4 event types
// Clean-room implementation based on behavioral specification

import '../utils/env.mjs';

// Event type constants
const EVENT_TYPES = {
  PROTEST: 'protests',
  MILITARY_FLIGHT: 'military_flights',
  NAVAL_VESSEL: 'naval_vessels',
  EARTHQUAKE: 'earthquakes',
};

// Grid cell state — persists across sweeps within the 24h window
const gridCells = new Map();
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Convert lat/lng to grid cell key (1° resolution)
function cellKey(lat, lng) {
  const gLat = Math.floor(lat);
  const gLng = Math.floor(lng);
  return `${gLat},${gLng}`;
}

// Add event to grid
function addEvent(lat, lng, type, metadata) {
  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return;
  const key = cellKey(lat, lng);
  if (!gridCells.has(key)) {
    gridCells.set(key, {
      gridLat: Math.floor(lat),
      gridLng: Math.floor(lng),
      events: [],
    });
  }
  gridCells.get(key).events.push({
    type,
    lat,
    lng,
    timestamp: Date.now(),
    metadata: metadata || {},
  });
}

// Prune events older than 24h
function pruneOldEvents() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, cell] of gridCells) {
    cell.events = cell.events.filter(e => e.timestamp > cutoff);
    if (cell.events.length === 0) {
      gridCells.delete(key);
    }
  }
}

// Ingest protests from ACLED data
function ingestProtests(acledData) {
  const events = acledData?.deadliestEvents || [];
  for (const e of events) {
    if (e.lat != null && e.lon != null) {
      addEvent(e.lat, e.lon, EVENT_TYPES.PROTEST, {
        country: e.country,
        type: e.type,
        fatalities: e.fatalities || 0,
      });
    }
  }

  // Also process top countries for broader coverage — use known country coords
  const countryCoords = {
    'Ukraine': [49, 32], 'Russia': [56, 38], 'Syria': [35, 38],
    'Yemen': [15, 48], 'Myanmar': [20, 96], 'Israel': [31.5, 35],
    'Iran': [32, 53], 'Iraq': [33, 44], 'Nigeria': [10, 8],
    'Pakistan': [30, 70], 'India': [20, 78], 'Mexico': [23, -102],
    'Colombia': [4, -74], 'Sudan': [13, 30], 'Ethiopia': [9, 38],
    'Somalia': [5, 46], 'Congo': [-4, 22],
  };

  const topCountries = acledData?.topCountries || {};
  for (const [name, stats] of Object.entries(topCountries)) {
    const coords = countryCoords[name];
    if (coords && (stats.count || 0) > 5) {
      addEvent(coords[0], coords[1], EVENT_TYPES.PROTEST, {
        country: name,
        count: stats.count,
        fatalities: stats.fatalities || 0,
      });
    }
  }
}

// Ingest military flights from ADS-B / OpenSky
function ingestMilitaryFlights(adsbData, openSkyData) {
  // ADS-B military aircraft
  const aircraft = adsbData?.militaryAircraft || [];
  for (const ac of aircraft) {
    const lat = ac.latitude ?? ac.lat;
    const lon = ac.longitude ?? ac.lon;
    if (lat != null && lon != null) {
      addEvent(lat, lon, EVENT_TYPES.MILITARY_FLIGHT, {
        callsign: ac.callsign || '',
        country: ac.militaryMatch || ac.country || '',
        altitude: ac.altitude || 0,
      });
    }
  }

  // OpenSky hotspot regions — add centroid events
  const hotspots = openSkyData?.hotspots || [];
  for (const h of hotspots) {
    if ((h.totalAircraft || 0) > 0) {
      const lat = (h.lamin + h.lamax) / 2 || 0;
      const lon = (h.lomin + h.lomax) / 2 || 0;
      if (lat && lon) {
        addEvent(lat, lon, EVENT_TYPES.MILITARY_FLIGHT, {
          region: h.region,
          count: h.totalAircraft,
        });
      }
    }
  }
}

// Ingest naval vessels from Maritime data
function ingestNavalVessels(maritimeData) {
  const chokepoints = maritimeData?.chokepoints || {};
  for (const [name, data] of Object.entries(chokepoints)) {
    if (data.lat != null && data.lon != null && (data.vesselCount || 0) > 0) {
      addEvent(data.lat, data.lon, EVENT_TYPES.NAVAL_VESSEL, {
        chokepoint: name,
        vesselCount: data.vesselCount || 0,
      });
    }
  }

  // Vessel positions if available
  const vessels = maritimeData?.vessels || [];
  for (const v of vessels) {
    const lat = v.lat ?? v.latitude;
    const lon = v.lon ?? v.longitude;
    if (lat != null && lon != null) {
      addEvent(lat, lon, EVENT_TYPES.NAVAL_VESSEL, {
        name: v.name || '',
        type: v.type || '',
      });
    }
  }
}

// Ingest earthquakes from NOAA/USGS-type data
function ingestEarthquakes(noaaData) {
  const quakes = noaaData?.earthquakes || noaaData?.recentQuakes || [];
  for (const q of quakes) {
    const lat = q.lat ?? q.latitude;
    const lon = q.lon ?? q.longitude;
    if (lat != null && lon != null) {
      addEvent(lat, lon, EVENT_TYPES.EARTHQUAKE, {
        magnitude: q.magnitude || q.mag || 0,
        depth: q.depth || 0,
        location: q.location || q.place || '',
      });
    }
  }
}

// Compute convergence zones
function detectConvergence() {
  pruneOldEvents();

  const zones = [];

  for (const [key, cell] of gridCells) {
    // Count distinct event types in this cell
    const typeSet = new Set(cell.events.map(e => e.type));
    const typeCount = typeSet.size;

    if (typeCount < 3) continue; // Need 3+ types for convergence

    const totalEvents = cell.events.length;

    // Scoring
    const typeScore = Math.min(100, typeCount * 25);
    const countBoost = Math.min(25, totalEvents * 2);
    const convergenceScore = Math.min(100, typeScore + countBoost);

    // Alert level
    let alertLevel;
    if (typeCount >= 4) alertLevel = 'Critical';
    else if (convergenceScore >= 60) alertLevel = 'High';
    else alertLevel = 'Medium';

    // Determine color
    let color;
    if (alertLevel === 'Critical') color = 'rgba(255, 0, 0, 0.4)';
    else if (alertLevel === 'High') color = 'rgba(255, 140, 0, 0.4)';
    else color = 'rgba(255, 215, 0, 0.4)';

    // Center of cell
    const centerLat = cell.gridLat + 0.5;
    const centerLng = cell.gridLng + 0.5;

    // Event type breakdown
    const typeCounts = {};
    for (const type of Object.values(EVENT_TYPES)) {
      const count = cell.events.filter(e => e.type === type).length;
      if (count > 0) typeCounts[type] = count;
    }

    zones.push({
      key,
      lat: centerLat,
      lng: centerLng,
      gridLat: cell.gridLat,
      gridLng: cell.gridLng,
      gridSize: 1.0,
      eventTypes: Array.from(typeSet),
      typeCount,
      totalEvents,
      typeCounts,
      score: convergenceScore,
      alertLevel,
      color,
      oldestEvent: Math.min(...cell.events.map(e => e.timestamp)),
      newestEvent: Math.max(...cell.events.map(e => e.timestamp)),
    });
  }

  // Sort by score descending
  zones.sort((a, b) => b.score - a.score);
  return zones;
}

// Compute convergence from all source data (called post-sweep)
export function computeConvergence(sourceData) {
  const acledData = sourceData.ACLED || {};
  const adsbData = sourceData['ADS-B'] || {};
  const openSkyData = sourceData.OpenSky || {};
  const maritimeData = sourceData.Maritime || {};
  const noaaData = sourceData.NOAA || {};

  // Ingest all sources
  ingestProtests(acledData);
  ingestMilitaryFlights(adsbData, openSkyData);
  ingestNavalVessels(maritimeData);
  ingestEarthquakes(noaaData);

  // Detect convergence zones
  const zones = detectConvergence();

  return {
    source: 'Convergence',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalZones: zones.length,
    zones,
    gridCellsTracked: gridCells.size,
    levelBreakdown: {
      critical: zones.filter(z => z.alertLevel === 'Critical').length,
      high: zones.filter(z => z.alertLevel === 'High').length,
      medium: zones.filter(z => z.alertLevel === 'Medium').length,
    },
    signals: zones
      .filter(z => z.alertLevel === 'Critical' || z.alertLevel === 'High')
      .slice(0, 5)
      .map(z => `Convergence zone at ${z.lat.toFixed(1)}°, ${z.lng.toFixed(1)}°: ${z.typeCount} event types, score ${z.score}`),
  };
}

// Briefing stub — actual computation happens post-sweep
export async function briefing() {
  return {
    source: 'Convergence',
    timestamp: new Date().toISOString(),
    status: 'deferred',
    message: 'Convergence zones computed post-sweep from aggregated source data',
  };
}

if (process.argv[1]?.endsWith('convergence.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
