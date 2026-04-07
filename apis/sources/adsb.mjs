// ADS-B Exchange — Unfiltered Flight Tracking (including Military)
// Unlike FlightRadar24/FlightAware, ADS-B Exchange does NOT filter military aircraft.
// Primary: opendata.adsb.fi (free, no key required, community-run)
// Fallback: RapidAPI tier for programmatic use (requires ADSB_API_KEY)

import { safeFetch } from '../utils/fetch.mjs';

// Known endpoints
const ENDPOINTS = {
  // opendata.adsb.fi — free, no key, community-run ADS-B aggregator
  adsbFi: 'https://opendata.adsb.fi/api/v2',
  // v2 API via RapidAPI (requires ADSB_API_KEY)
  rapidApi: 'https://adsbexchange-com1.p.rapidapi.com/v2',
  // Public globe feed (may be rate-limited or blocked for automated access)
  publicFeed: 'https://globe.adsbexchange.com/data/aircraft.json',
};

// Watchlist countries for PRIORITY alerts over sensitive regions
const WATCHLIST_COUNTRIES = ['Russia', 'China', 'Iran', 'North Korea', 'US Military', 'UK Military', 'France Military', 'Germany Military'];

// Sensitive regions — bounding boxes [minLat, maxLat, minLon, maxLon, name]
const SENSITIVE_REGIONS = [
  [44, 52, 28, 42, 'Ukraine/Black Sea'],
  [20, 28, 118, 124, 'Taiwan Strait'],
  [10, 22, 108, 118, 'South China Sea'],
  [24, 40, 44, 60, 'Persian Gulf'],
  [54, 60, 20, 30, 'Baltic Region'],
  [33, 42, 124, 132, 'Korean Peninsula'],
  [60, 72, 25, 45, 'Arctic/Barents Sea'],
];

// Known military aircraft types and ICAO type designators
const MILITARY_TYPES = {
  // Reconnaissance / ISR
  'RC135': 'RC-135 Rivet Joint (SIGINT)',
  'E3CF':  'E-3 Sentry AWACS',
  'E3TF':  'E-3 Sentry AWACS',
  'E6B':   'E-6B Mercury (TACAMO)',
  'EP3':   'EP-3 Aries (SIGINT)',
  'P8':    'P-8 Poseidon (Maritime Patrol)',
  'P8A':   'P-8A Poseidon',
  'RQ4':   'RQ-4 Global Hawk (UAV)',
  'RQ4B':  'RQ-4B Global Hawk',
  'U2':    'U-2 Dragon Lady',
  'MQ9':   'MQ-9 Reaper (UAV)',
  'MQ1':   'MQ-1 Predator (UAV)',
  'E8':    'E-8 JSTARS',
  // Tankers
  'KC135': 'KC-135 Stratotanker',
  'KC10':  'KC-10 Extender',
  'KC46':  'KC-46 Pegasus',
  // Bombers
  'B52':   'B-52 Stratofortress',
  'B1':    'B-1B Lancer',
  'B2':    'B-2 Spirit',
  // Transport / Special
  'C17':   'C-17 Globemaster III',
  'C5':    'C-5 Galaxy',
  'C130':  'C-130 Hercules',
  'VC25':  'VC-25 (Air Force One)',
  'E4B':   'E-4B Nightwatch (Doomsday Plane)',
  'C32':   'C-32 (Air Force Two)',
  'C40':   'C-40 Clipper',
};

// Known military ICAO hex ranges (partial — US military allocations)
const MIL_HEX_RANGES = [
  { start: 0xADF7C8, end: 0xAFFFFF, country: 'US Military' },
  { start: 0xAE0000, end: 0xAFFFFF, country: 'US Military (alt)' },
  { start: 0x43C000, end: 0x43CFFF, country: 'UK Military' },
  { start: 0x3F0000, end: 0x3FFFFF, country: 'France Military' },
  { start: 0x3CC000, end: 0x3CFFFF, country: 'Germany Military' },
];

// Interesting callsign patterns that suggest military/government flights
const MIL_CALLSIGN_PATTERNS = [
  /^RCH/,      // US AMC (Air Mobility Command) — strategic airlift
  /^REACH/,    // US AMC alternate
  /^DUKE/,     // Often military special ops
  /^IRON/,     // US military
  /^JAKE/,     // Military
  /^NAVY/,     // US Navy
  /^TOPCAT/,   // E-6B Mercury
  /^DARKST/,   // Dark Star / classified
  /^GORDO/,    // USAF
  /^BISON/,    // B-52
  /^DEATH/,    // B-1B
  /^DOOM/,     // E-4B
  /^SAM/,      // Special Air Mission (VIP)
  /^EXEC/,     // Executive transport
  /^PCSF/,     // Chinese military
  /^CHN/,      // Chinese military
  /^RF/,       // Russian Air Force
  /^RFF/,      // Russian Air Force
];

// Check if an ICAO hex code falls in known military ranges
function isMilitaryHex(hex) {
  if (!hex) return false;
  const num = parseInt(hex, 16);
  if (isNaN(num)) return false;
  return MIL_HEX_RANGES.find(r => num >= r.start && num <= r.end) || null;
}

// Check if a callsign matches military patterns
function isMilitaryCallsign(callsign) {
  if (!callsign) return false;
  const cs = callsign.trim().toUpperCase();
  return MIL_CALLSIGN_PATTERNS.some(p => p.test(cs));
}

// Check if aircraft type is a known military type
function isMilitaryType(typeCode) {
  if (!typeCode) return false;
  const tc = typeCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return MILITARY_TYPES[tc] || null;
}

// Classify an aircraft from ADS-B data
function classifyAircraft(ac) {
  const hex = ac.hex || ac.icao || ac.icao24 || null;
  const callsign = ac.flight || ac.callsign || ac.call || '';
  const type = ac.t || ac.type || ac.typecode || '';
  const mil = ac.mil || ac.military || false;

  const milHex = isMilitaryHex(hex);
  const milCall = isMilitaryCallsign(callsign);
  const milType = isMilitaryType(type);

  const isMilitary = !!(mil || milHex || milCall || milType);

  return {
    hex,
    callsign: callsign.trim(),
    type,
    typeDescription: milType || null,
    latitude: ac.lat || ac.latitude || null,
    longitude: ac.lon || ac.longitude || null,
    altitude: ac.alt_baro || ac.alt_geom || ac.altitude || null,
    speed: ac.gs || ac.speed || null,
    heading: ac.track || ac.heading || null,
    squawk: ac.squawk || null,
    isMilitary,
    militaryMatch: milHex?.country || (milCall ? 'callsign pattern' : null) || (milType ? 'type match' : null),
    registration: ac.r || ac.registration || null,
    seen: ac.seen || ac.last_contact || null,
  };
}

// Fetch military aircraft from opendata.adsb.fi (free, no key)
async function fetchFromAdsbFi() {
  // /mil endpoint returns only military-flagged aircraft
  const data = await safeFetch(`${ENDPOINTS.adsbFi}/mil`, { timeout: 20000 });
  if (data && !data.error && Array.isArray(data.ac)) return data;

  // Fallback: try specific military type codes
  const milTypes = ['RC135', 'E3CF', 'E6B', 'P8A', 'KC135', 'KC46', 'C17', 'B52', 'E4B'];
  for (const t of milTypes.slice(0, 3)) {
    const typeData = await safeFetch(`${ENDPOINTS.adsbFi}/type/${t}`, { timeout: 10000 });
    if (typeData && !typeData.error && Array.isArray(typeData.ac) && typeData.ac.length > 0) {
      return typeData;
    }
  }

  return null;
}

// Fetch military aircraft via RapidAPI (requires ADSB_API_KEY)
async function fetchViaRapidApi(apiKey) {
  if (!apiKey) return null;
  const data = await safeFetch(`${ENDPOINTS.rapidApi}/mil`, {
    timeout: 20000,
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': 'adsbexchange-com1.p.rapidapi.com',
    },
  });
  return data;
}

// Check if aircraft is in a sensitive region
function findSensitiveRegion(lat, lon) {
  if (lat == null || lon == null) return null;
  for (const [minLat, maxLat, minLon, maxLon, name] of SENSITIVE_REGIONS) {
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) return name;
  }
  return null;
}

// Get military aircraft from available sources
export async function getMilitaryAircraft(apiKey) {
  // Try opendata.adsb.fi first (free, no key needed)
  const adsbFiData = await fetchFromAdsbFi();
  if (adsbFiData && !adsbFiData.error) {
    const aircraft = adsbFiData.ac || adsbFiData.aircraft || [];
    if (Array.isArray(aircraft) && aircraft.length > 0) {
      return aircraft.map(classifyAircraft).filter(a => a.isMilitary);
    }
  }

  // Fallback to RapidAPI if key available
  if (apiKey) {
    const data = await fetchViaRapidApi(apiKey);
    if (data && !data.error) {
      const aircraft = data.ac || data.aircraft || [];
      if (Array.isArray(aircraft)) {
        return aircraft.map(classifyAircraft).filter(a => a.isMilitary);
      }
    }
  }

  return null; // all sources failed
}

// Get all aircraft in a geographic bounding box via RapidAPI
export async function getAircraftInArea(lat, lon, radiusNm = 250, apiKey) {
  if (!apiKey) {
    return { error: 'ADSB_API_KEY required for area search', hint: 'Set ADSB_API_KEY (RapidAPI key)' };
  }

  const data = await safeFetch(
    `${ENDPOINTS.rapidApi}/lat/${lat}/lon/${lon}/dist/${radiusNm}/`,
    {
      timeout: 20000,
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'adsbexchange-com1.p.rapidapi.com',
      },
    }
  );

  if (data && !data.error) {
    const aircraft = data.ac || data.aircraft || [];
    if (Array.isArray(aircraft)) return aircraft.map(classifyAircraft);
  }

  return data;
}

// Briefing — attempt to get military flight data, document what's available
export async function briefing() {
  const apiKey = process.env.ADSB_API_KEY || process.env.RAPIDAPI_KEY || null;
  const militaryAircraft = await getMilitaryAircraft(apiKey);

  // If we got data, analyze it
  if (militaryAircraft && militaryAircraft.length > 0) {
    // Group by military match type
    const byCountry = {};
    const reconAircraft = [];
    const bombers = [];
    const tankers = [];
    const vipTransport = [];

    for (const ac of militaryAircraft) {
      const country = ac.militaryMatch || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;

      const desc = (ac.typeDescription || '').toLowerCase();
      if (desc.includes('sigint') || desc.includes('awacs') || desc.includes('patrol') ||
          desc.includes('global hawk') || desc.includes('dragon lady') || desc.includes('jstars')) {
        reconAircraft.push(ac);
      } else if (desc.includes('stratofortress') || desc.includes('lancer') || desc.includes('spirit')) {
        bombers.push(ac);
      } else if (desc.includes('tanker') || desc.includes('extender') || desc.includes('pegasus')) {
        tankers.push(ac);
      } else if (desc.includes('air force one') || desc.includes('nightwatch') ||
                 desc.includes('air force two') || desc.includes('special air')) {
        vipTransport.push(ac);
      }
    }

    const signals = [];
    if (reconAircraft.length > 5) {
      signals.push(`HIGH ISR ACTIVITY: ${reconAircraft.length} reconnaissance/surveillance aircraft airborne`);
    }
    if (bombers.length > 0) {
      signals.push(`BOMBERS AIRBORNE: ${bombers.length} strategic bombers detected`);
    }
    if (tankers.length > 8) {
      signals.push(`ELEVATED TANKER OPS: ${tankers.length} aerial refueling aircraft active (possible surge)`);
    }
    if (vipTransport.length > 0) {
      signals.push(`VIP AIRCRAFT: ${vipTransport.length} VIP/continuity-of-government aircraft airborne`);
    }

    // PRIORITY alerts: watchlist country military aircraft over sensitive regions
    const priorityAlerts = [];
    for (const ac of militaryAircraft) {
      if (!ac.latitude || !ac.longitude) continue;
      const region = findSensitiveRegion(ac.latitude, ac.longitude);
      if (region && WATCHLIST_COUNTRIES.some(w => (ac.militaryMatch || '').includes(w.split(' ')[0]))) {
        priorityAlerts.push({
          tier: 'PRIORITY',
          headline: `MILITARY AIRCRAFT: ${ac.militaryMatch || 'Unknown'} over ${region}`,
          detail: `${ac.callsign || ac.hex} — ${ac.typeDescription || ac.type || 'Unknown type'} at FL${Math.round((ac.altitude || 0) / 100)}`,
          lat: ac.latitude, lon: ac.longitude,
        });
      }
    }

    return {
      source: 'ADS-B Exchange',
      timestamp: new Date().toISOString(),
      status: 'live',
      dataSource: 'opendata.adsb.fi',
      totalMilitary: militaryAircraft.length,
      byCountry,
      categories: {
        reconnaissance: reconAircraft.slice(0, 20),
        bombers: bombers.slice(0, 10),
        tankers: tankers.slice(0, 10),
        vipTransport: vipTransport.slice(0, 5),
      },
      militaryAircraft: militaryAircraft.slice(0, 50),
      signals: signals.length > 0 ? signals : ['Military flight activity within normal patterns'],
      priorityAlerts: priorityAlerts.slice(0, 10),
    };
  }

  // No data available — return stub
  return {
    source: 'ADS-B Exchange',
    timestamp: new Date().toISOString(),
    status: 'no_data',
    dataSource: 'opendata.adsb.fi',
    militaryAircraft: [],
    message: 'ADS-B military feed returned no data. The opendata.adsb.fi endpoint may be temporarily unavailable.',
    signals: ['ADS-B data unavailable — cannot assess military flight activity'],
    priorityAlerts: [],
  };
}

// Run standalone
if (process.argv[1]?.endsWith('adsb.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
