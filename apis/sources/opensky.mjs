// OpenSky Network — Real-time flight tracking
// Free for research. 4,000 API credits/day (no auth), 8,000 with account.
// Tracks all aircraft with ADS-B transponders including many military.
// OpenSky is unreachable from some cloud networks (connection timeouts); when a
// hotspot query fails, the region is sampled from the keyless api.adsb.lol
// aggregator instead (250 nm radius circles) and flagged as a sample.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://opensky-network.org/api';
const ADSB_LOL = 'https://api.adsb.lol/v2';
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';
const SAMPLE_RADIUS_NM = 250;
const HIGH_ALT_FT = 39370; // 12 km

// Get all current flights (global state vector)
export async function getAllFlights() {
  return safeFetch(`${BASE}/states/all`, { timeout: 30000 });
}

// Get flights in a bounding box (lat/lon)
export async function getFlightsInArea(lamin, lomin, lamax, lomax) {
  const params = new URLSearchParams({
    lamin: String(lamin),
    lomin: String(lomin),
    lamax: String(lamax),
    lomax: String(lomax),
  });
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 12000, retries: 0 });
}

// Get flights by specific aircraft (ICAO24 hex codes)
export async function getFlightsByIcao(icao24List) {
  const icao = Array.isArray(icao24List) ? icao24List : [icao24List];
  const params = icao.map(i => `icao24=${i}`).join('&');
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000 });
}

// Get departures from an airport in a time range
export async function getDepartures(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/departure?${params}`);
}

// Get arrivals at an airport
export async function getArrivals(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/arrival?${params}`);
}

// Key hotspot regions for monitoring
const HOTSPOTS = {
  middleEast: { lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' },
  taiwan: { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' },
  ukraine: { lamin: 44, lomin: 22, lamax: 53, lomax: 41, label: 'Ukraine Region' },
  baltics: { lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' },
  southChinaSea: { lamin: 5, lomin: 105, lamax: 23, lomax: 122, label: 'South China Sea' },
  koreanPeninsula: { lamin: 33, lomin: 124, lamax: 43, lomax: 132, label: 'Korean Peninsula' },
  caribbean: { lamin: 18, lomin: -90, lamax: 30, lomax: -72, label: 'Caribbean' },
  gulfOfGuinea: { lamin: -2, lomin: -5, lamax: 8, lomax: 10, label: 'Gulf of Guinea' },
  capeRoute: { lamin: -38, lomin: 12, lamax: -28, lomax: 24, label: 'Cape Route' },
  hornOfAfrica: { lamin: 5, lomin: 40, lamax: 15, lomax: 55, label: 'Horn of Africa' },
};

function shortError(msg = '') {
  if (/abort|timeout|timed out/i.test(msg)) return 'timed out';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'unreachable';
  const m = String(msg).match(/HTTP (\d{3})/);
  return m ? `HTTP ${m[1]}` : 'error';
}

function fromOpenSky(key, box, states) {
  return {
    region: box.label,
    key,
    method: 'opensky',
    totalAircraft: states.length,
    // states format: [icao24, callsign, origin_country, ...]
    byCountry: states.reduce((acc, s) => {
      const country = s[2] || 'Unknown';
      acc[country] = (acc[country] || 0) + 1;
      return acc;
    }, {}),
    // Flag potentially interesting (military often have no callsign or specific patterns)
    noCallsign: states.filter(s => !s[1]?.trim()).length,
    highAltitude: states.filter(s => s[7] && s[7] > 12000).length, // >12km altitude
  };
}

// Sample centres for a bounding box: one 250 nm circle for compact boxes,
// a 2x2 grid for wide ones. Coverage is partial by design and reported as such.
export function samplePoints(box) {
  const midLat = (box.lamin + box.lamax) / 2;
  const latNm = (box.lamax - box.lamin) * 60;
  const lonNm = (box.lomax - box.lomin) * 60 * Math.cos(midLat * Math.PI / 180);
  const rows = latNm > SAMPLE_RADIUS_NM * 2 ? 2 : 1;
  const cols = lonNm > SAMPLE_RADIUS_NM * 2 ? 2 : 1;
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pts.push({
        lat: +(box.lamin + (box.lamax - box.lamin) * (r + 0.5) / rows).toFixed(3),
        lon: +(box.lomin + (box.lomax - box.lomin) * (c + 0.5) / cols).toFixed(3),
      });
    }
  }
  return pts;
}

// readsb-style aircraft JSON (api.adsb.lol) → hotspot summary
export function fromAdsbSample(key, box, aircraft, points) {
  const inBox = aircraft.filter(a => typeof a.lat === 'number' && typeof a.lon === 'number'
    && a.lat >= box.lamin && a.lat <= box.lamax && a.lon >= box.lomin && a.lon <= box.lomax);
  const byType = {};
  for (const a of inBox) if (a.t) byType[a.t] = (byType[a.t] || 0) + 1;
  return {
    region: box.label,
    key,
    method: 'adsb_sample',
    sampled: true,
    samplePoints: points.length,
    sampleRadiusNm: SAMPLE_RADIUS_NM,
    totalAircraft: inBox.length,
    byCountry: {},
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5)),
    military: inBox.filter(a => (a.dbFlags || 0) & 1).length,
    noCallsign: inBox.filter(a => !(a.flight || '').trim()).length,
    highAltitude: inBox.filter(a => typeof a.alt_baro === 'number' && a.alt_baro > HIGH_ALT_FT).length,
  };
}

async function sampleHotspot(key, box) {
  const points = samplePoints(box);
  const seen = new Map();
  const errors = [];
  for (const p of points) {
    const data = await safeFetch(`${ADSB_LOL}/point/${p.lat}/${p.lon}/${SAMPLE_RADIUS_NM}`, {
      timeout: 15000, retries: 0, headers: { 'User-Agent': UA },
    });
    if (data?.error || !Array.isArray(data?.ac)) { errors.push(data?.error || 'no ac[] in response'); continue; }
    for (const a of data.ac) if (a.hex && !seen.has(a.hex)) seen.set(a.hex, a);
  }
  if (errors.length === points.length) return { region: box.label, key, method: 'none', totalAircraft: 0, byCountry: {}, noCallsign: 0, highAltitude: 0, error: `adsb.lol ${shortError(errors[0])}` };
  const out = fromAdsbSample(key, box, [...seen.values()], points);
  if (errors.length) out.partial = `${errors.length}/${points.length} sample(s) failed`;
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// Briefing — check hotspot regions for flight activity
export async function briefing() {
  const hotspotEntries = Object.entries(HOTSPOTS);

  // Probe one hotspot first: if OpenSky is unreachable from this network, skip
  // the remaining nine 12 s timeouts and go straight to the ADS-B sample.
  const [probeKey, probeBox] = hotspotEntries[0];
  const probe = await getFlightsInArea(probeBox.lamin, probeBox.lomin, probeBox.lamax, probeBox.lomax);
  const openSkyDown = !!probe?.error && /abort|timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(probe.error);

  const openSkyResults = openSkyDown
    ? hotspotEntries.map(([key, box]) => ({ key, box, error: probe.error }))
    : await Promise.all(hotspotEntries.map(async ([key, box]) => {
        if (key === probeKey) return { key, box, data: probe };
        return { key, box, data: await getFlightsInArea(box.lamin, box.lomin, box.lamax, box.lomax) };
      }));

  const openSkyErrors = [];
  const results = await mapLimit(openSkyResults, 3, async (r) => {
    const err = r.error || r.data?.error;
    // OpenSky returns {"states": null} for a box with no aircraft — a real zero, not a failure
    if (!err && r.data && 'states' in r.data) return fromOpenSky(r.key, r.box, r.data.states || []);
    openSkyErrors.push(shortError(err || 'no states[] in response'));
    return sampleHotspot(r.key, r.box);
  });

  const sampled = results.filter(r => r.method === 'adsb_sample').length;
  const failed = results.filter(r => r.method === 'none');
  const live = results.length - sampled - failed.length;

  const out = {
    source: sampled && !live ? 'ADS-B sample (api.adsb.lol) — OpenSky unreachable' : 'OpenSky',
    timestamp: new Date().toISOString(),
    method: live && !sampled ? 'opensky' : (sampled && !live ? 'adsb_sample' : 'mixed'),
    coverage: { opensky: live, adsbSample: sampled, failed: failed.length, total: results.length },
    hotspots: results,
  };
  if (openSkyErrors.length) {
    out.openskyError = `OpenSky ${openSkyErrors[0]} for ${openSkyErrors.length}/${results.length} hotspots`;
  }
  if (sampled) {
    out.status = 'fallback';
    out.note = `${sampled} region(s) sampled from api.adsb.lol at ${SAMPLE_RADIUS_NM} nm radius — counts are partial, not full-box totals; no origin-country data`;
  }
  if (failed.length) {
    out.hotspotErrors = failed.map(r => ({ region: r.region, error: r.error }));
    if (failed.length === results.length) {
      out.error = `OpenSky ${openSkyErrors[0] || 'unavailable'}; ADS-B fallback ${shortError(failed[0].error)}`;
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('opensky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
