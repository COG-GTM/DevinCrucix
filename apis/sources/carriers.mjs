// Carrier Strike Group OSINT Tracker
// Scrapes GDELT news articles for mentions of US Navy carrier names,
// extracts geographic context, and maps mentions to estimated lat/lng
// using a region-to-coordinate lookup table.
// Adapted from Shadowbroker carrier_tracker.py for CRUCIX architecture.

import { safeFetch } from '../utils/fetch.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, '..', '..', 'runs', 'carrier_cache.json');

// Carrier registry: hull number → metadata + fallback position
// Fallback positions sourced from USNI News Fleet & Marine Tracker
const CARRIER_REGISTRY = {
  'CVN-68': {
    name: 'USS Nimitz (CVN-68)', wiki: 'https://en.wikipedia.org/wiki/USS_Nimitz',
    homeport: 'Bremerton, WA', homeportLat: 47.5535, homeportLng: -122.6400,
    fallbackLat: 47.5535, fallbackLng: -122.6400, fallbackHeading: 90,
    fallbackDesc: 'Bremerton, WA (Maintenance)',
  },
  'CVN-76': {
    name: 'USS Ronald Reagan (CVN-76)', wiki: 'https://en.wikipedia.org/wiki/USS_Ronald_Reagan',
    homeport: 'Bremerton, WA', homeportLat: 47.5580, homeportLng: -122.6360,
    fallbackLat: 47.5580, fallbackLng: -122.6360, fallbackHeading: 90,
    fallbackDesc: 'Bremerton, WA (Decommissioning)',
  },
  'CVN-69': {
    name: 'USS Dwight D. Eisenhower (CVN-69)', wiki: 'https://en.wikipedia.org/wiki/USS_Dwight_D._Eisenhower',
    homeport: 'Norfolk, VA', homeportLat: 36.9465, homeportLng: -76.3265,
    fallbackLat: 36.9465, fallbackLng: -76.3265, fallbackHeading: 0,
    fallbackDesc: 'Norfolk, VA (Post-deployment maintenance)',
  },
  'CVN-78': {
    name: 'USS Gerald R. Ford (CVN-78)', wiki: 'https://en.wikipedia.org/wiki/USS_Gerald_R._Ford',
    homeport: 'Norfolk, VA', homeportLat: 36.9505, homeportLng: -76.3250,
    fallbackLat: 18.0, fallbackLng: 39.5, fallbackHeading: 0,
    fallbackDesc: 'Red Sea — Operation Epic Fury',
  },
  'CVN-74': {
    name: 'USS John C. Stennis (CVN-74)', wiki: 'https://en.wikipedia.org/wiki/USS_John_C._Stennis',
    homeport: 'Norfolk, VA', homeportLat: 36.9540, homeportLng: -76.3235,
    fallbackLat: 36.98, fallbackLng: -76.43, fallbackHeading: 0,
    fallbackDesc: 'Newport News, VA (RCOH refueling overhaul)',
  },
  'CVN-75': {
    name: 'USS Harry S. Truman (CVN-75)', wiki: 'https://en.wikipedia.org/wiki/USS_Harry_S._Truman',
    homeport: 'Norfolk, VA', homeportLat: 36.9580, homeportLng: -76.3220,
    fallbackLat: 36.0, fallbackLng: 15.0, fallbackHeading: 0,
    fallbackDesc: 'Mediterranean Sea deployment',
  },
  'CVN-77': {
    name: 'USS George H.W. Bush (CVN-77)', wiki: 'https://en.wikipedia.org/wiki/USS_George_H.W._Bush',
    homeport: 'Norfolk, VA', homeportLat: 36.9620, homeportLng: -76.3210,
    fallbackLat: 36.5, fallbackLng: -74.0, fallbackHeading: 0,
    fallbackDesc: 'Atlantic — Pre-deployment workups',
  },
  'CVN-70': {
    name: 'USS Carl Vinson (CVN-70)', wiki: 'https://en.wikipedia.org/wiki/USS_Carl_Vinson',
    homeport: 'San Diego, CA', homeportLat: 32.6840, homeportLng: -117.1290,
    fallbackLat: 32.6840, fallbackLng: -117.1290, fallbackHeading: 180,
    fallbackDesc: 'San Diego, CA (Homeport)',
  },
  'CVN-71': {
    name: 'USS Theodore Roosevelt (CVN-71)', wiki: 'https://en.wikipedia.org/wiki/USS_Theodore_Roosevelt_(CVN-71)',
    homeport: 'San Diego, CA', homeportLat: 32.6885, homeportLng: -117.1280,
    fallbackLat: 32.6885, fallbackLng: -117.1280, fallbackHeading: 180,
    fallbackDesc: 'San Diego, CA (Maintenance)',
  },
  'CVN-72': {
    name: 'USS Abraham Lincoln (CVN-72)', wiki: 'https://en.wikipedia.org/wiki/USS_Abraham_Lincoln_(CVN-72)',
    homeport: 'San Diego, CA', homeportLat: 32.6925, homeportLng: -117.1275,
    fallbackLat: 20.0, fallbackLng: 64.0, fallbackHeading: 0,
    fallbackDesc: 'Arabian Sea — Operation Epic Fury',
  },
  'CVN-73': {
    name: 'USS George Washington (CVN-73)', wiki: 'https://en.wikipedia.org/wiki/USS_George_Washington_(CVN-73)',
    homeport: 'Yokosuka, Japan', homeportLat: 35.2830, homeportLng: 139.6700,
    fallbackLat: 35.2830, fallbackLng: 139.6700, fallbackHeading: 180,
    fallbackDesc: 'Yokosuka, Japan (Forward deployed)',
  },
};

// Region → approximate center coordinates for geographic context extraction
const REGION_COORDS = {
  // Oceans & Seas
  'eastern mediterranean': [34.0, 25.0], 'mediterranean': [36.0, 15.0],
  'western mediterranean': [37.0, 2.0], 'red sea': [18.0, 39.5],
  'arabian sea': [16.0, 64.0], 'persian gulf': [26.5, 51.5],
  'gulf of oman': [24.5, 58.5], 'north arabian sea': [20.0, 64.0],
  'south china sea': [15.0, 115.0], 'east china sea': [28.0, 125.0],
  'philippine sea': [20.0, 130.0], 'sea of japan': [40.0, 135.0],
  'taiwan strait': [24.0, 119.5], 'western pacific': [20.0, 140.0],
  'pacific': [20.0, -150.0], 'indian ocean': [-5.0, 70.0],
  'north atlantic': [40.0, -40.0], 'atlantic': [30.0, -50.0],
  'gulf of aden': [12.5, 45.0], 'horn of africa': [10.0, 50.0],
  'strait of hormuz': [26.5, 56.3], 'bab el-mandeb': [12.6, 43.3],
  'suez canal': [30.5, 32.3], 'baltic sea': [57.0, 18.0],
  'north sea': [56.0, 3.0], 'black sea': [43.0, 34.0],
  'south atlantic': [-20.0, -20.0], 'coral sea': [-18.0, 155.0],
  'gulf of mexico': [25.0, -90.0], 'caribbean': [15.0, -75.0],
  // Specific bases / ports
  'norfolk': [36.95, -76.33], 'san diego': [32.68, -117.15],
  'yokosuka': [35.28, 139.67], 'pearl harbor': [21.35, -157.95],
  'guam': [13.45, 144.79], 'bahrain': [26.23, 50.55],
  'rota': [36.62, -6.35], 'naples': [40.85, 14.27],
  'bremerton': [47.56, -122.63], 'puget sound': [47.56, -122.63],
  'newport news': [36.98, -76.43],
  // Areas of operation
  'centcom': [25.0, 55.0], 'indopacom': [20.0, 130.0],
  'eucom': [48.0, 15.0], 'southcom': [10.0, -80.0],
  '5th fleet': [25.0, 55.0], '6th fleet': [36.0, 15.0],
  '7th fleet': [25.0, 130.0], '3rd fleet': [30.0, -130.0],
  '2nd fleet': [35.0, -60.0],
};

// Sort regions by length (longest first) for greedy matching
const SORTED_REGIONS = Object.entries(REGION_COORDS)
  .sort((a, b) => b[0].length - a[0].length);

function matchRegion(text) {
  const lower = text.toLowerCase();
  for (const [region, coords] of SORTED_REGIONS) {
    if (lower.includes(region)) return coords;
  }
  return null;
}

// Surnames that are too common to match alone — require naval context words nearby
const AMBIGUOUS_NAMES = new Set(['ford', 'bush', 'washington', 'lincoln', 'roosevelt', 'truman', 'reagan', 'vinson']);
const NAVAL_CONTEXT = /\b(carrier|navy|uss|cvn|strike group|deployed|fleet|naval|warship|aircraft carrier|shipyard)\b/i;

function matchCarrier(text) {
  const lower = text.toLowerCase();
  for (const [hull, info] of Object.entries(CARRIER_REGISTRY)) {
    const hullClean = hull.toLowerCase().replace('-', '');
    // Hull number match (e.g. "CVN-78" or "CVN78") — always reliable
    if (lower.includes(hull.toLowerCase()) || lower.includes(hullClean)) return hull;
    // Full "USS <Name>" match — always reliable
    const shipName = info.name.split('(')[0].trim().toLowerCase();
    if (lower.includes(shipName)) return hull;
    // "USS <LastName>" match — reliable
    const lastName = shipName.split(' ').pop();
    if (lastName && lower.includes('uss ' + lastName)) return hull;
    // Bare last name match — only if naval context words are present
    if (lastName && lastName.length > 3 && lower.includes(lastName)) {
      if (AMBIGUOUS_NAMES.has(lastName)) {
        // Require at least one naval context word in the same title
        if (NAVAL_CONTEXT.test(text)) return hull;
      } else {
        // Unique names like "nimitz", "eisenhower", "stennis" — safe to match
        return hull;
      }
    }
  }
  return null;
}

function loadCache() {
  try {
    if (existsSync(CACHE_FILE)) {
      return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveCache(positions) {
  try {
    const dir = dirname(CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(positions, null, 2));
  } catch (e) {
    console.log('[Carriers] Cache write failed:', e.message);
  }
}

// GDELT search for carrier news — rate-limited with delays
async function fetchGdeltCarrierNews() {
  const searchTerms = [
    'aircraft+carrier+deployed',
    'carrier+strike+group+navy',
    'USS+Nimitz+carrier',
    'USS+Ford+carrier',
    'USS+Eisenhower+carrier',
    'USS+Vinson+carrier',
    'USS+Roosevelt+carrier+navy',
    'USS+Lincoln+carrier',
    'USS+Truman+carrier',
    'USS+Reagan+carrier',
    'USS+Washington+carrier+navy',
    'USS+Bush+carrier',
    'USS+Stennis+carrier',
  ];

  const results = [];
  for (let i = 0; i < searchTerms.length; i++) {
    const term = searchTerms[i];
    try {
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${term}&mode=artlist&maxrecords=5&format=json&timespan=14d`;
      const data = await safeFetch(url, { timeout: 8000, retries: 0 });
      if (data && !data.error && Array.isArray(data.articles)) {
        for (const art of data.articles) {
          results.push({ title: art.title || '', url: art.url || '' });
        }
      }
    } catch { /* skip failed queries */ }
    // Rate limit: GDELT requires ~5s between requests
    if (i < searchTerms.length - 1) {
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));
    }
  }

  console.log(`[Carriers] GDELT returned ${results.length} articles`);
  return results;
}

function parseCarrierPositionsFromNews(articles) {
  const updates = {};
  for (const article of articles) {
    const title = article.title || '';
    const hull = matchCarrier(title);
    if (!hull) continue;
    const coords = matchRegion(title);
    if (!coords) continue;
    // First match wins (most recent article)
    if (!updates[hull]) {
      updates[hull] = {
        lat: coords[0], lng: coords[1],
        desc: title.substring(0, 100),
        source: 'GDELT News API',
        sourceUrl: article.url || 'https://api.gdeltproject.org',
        updated: new Date().toISOString(),
      };
      console.log(`[Carriers] ${CARRIER_REGISTRY[hull].name} → [${coords[0]}, ${coords[1]}] (from: ${title.substring(0, 60)})`);
    }
  }
  return updates;
}

// Deconflict carriers that share identical coordinates
function deconflictPositions(carriers) {
  const groups = {};
  for (let i = 0; i < carriers.length; i++) {
    const key = `${Math.round(carriers[i].lat * 100) / 100},${Math.round(carriers[i].lng * 100) / 100}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(i);
  }
  for (const indices of Object.values(groups)) {
    if (indices.length < 2) continue;
    const sample = carriers[indices[0]];
    // Check if at port
    const atPort = Object.values(CARRIER_REGISTRY).some(info =>
      Math.abs(sample.lat - info.homeportLat) < 0.05 &&
      Math.abs(sample.lng - info.homeportLng) < 0.05
    );
    if (atPort) {
      // Use distinct homeport pier coordinates
      for (const idx of indices) {
        const carrier = carriers[idx];
        for (const [, info] of Object.entries(CARRIER_REGISTRY)) {
          if (info.name === carrier.name) {
            carrier.lat = info.homeportLat;
            carrier.lng = info.homeportLng;
            break;
          }
        }
      }
    } else {
      // At sea: spread in a line (~0.08° apart)
      const spacing = 0.08;
      const startOffset = -(indices.length - 1) * spacing / 2;
      for (let j = 0; j < indices.length; j++) {
        carriers[indices[j]].lng += startOffset + j * spacing;
      }
    }
  }
  return carriers;
}

export async function briefing() {
  console.log('[Carriers] Starting carrier strike group scan...');

  // Phase 1: Load fallback + cached positions (instant)
  const positions = {};
  for (const [hull, info] of Object.entries(CARRIER_REGISTRY)) {
    positions[hull] = {
      name: info.name, lat: info.fallbackLat, lng: info.fallbackLng,
      heading: info.fallbackHeading, desc: info.fallbackDesc,
      wiki: info.wiki, homeport: info.homeport,
      source: 'USNI News Fleet & Marine Tracker',
      sourceUrl: 'https://news.usni.org/category/fleet-tracker',
      updated: new Date().toISOString(),
    };
  }

  // Overlay cached GDELT positions from previous runs
  const cached = loadCache();
  for (const [hull, cachedPos] of Object.entries(cached)) {
    if (hull in positions && cachedPos.source && cachedPos.source.startsWith('GDELT')) {
      positions[hull].lat = cachedPos.lat;
      positions[hull].lng = cachedPos.lng;
      positions[hull].desc = cachedPos.desc || positions[hull].desc;
      positions[hull].source = cachedPos.source || 'Cached OSINT';
      positions[hull].updated = cachedPos.updated || '';
    }
  }

  // Phase 2: GDELT enrichment (slow, network)
  try {
    const articles = await fetchGdeltCarrierNews();
    const newsPositions = parseCarrierPositionsFromNews(articles);
    for (const [hull, pos] of Object.entries(newsPositions)) {
      if (hull in positions) {
        Object.assign(positions[hull], pos);
      }
    }
  } catch (e) {
    console.log('[Carriers] GDELT enrichment failed (using fallbacks):', e.message);
  }

  // Save enriched positions to cache
  saveCache(positions);

  // Build output list with deconfliction
  const carrierList = Object.entries(positions).map(([hull, pos]) => ({
    hull,
    name: pos.name,
    type: 'carrier',
    lat: pos.lat,
    lng: pos.lng,
    heading: pos.heading || null,
    homeport: pos.homeport || '',
    desc: pos.desc || '',
    wiki: pos.wiki || '',
    estimated: true,
    source: pos.source || 'OSINT estimated position',
    sourceUrl: pos.sourceUrl || 'https://news.usni.org/category/fleet-tracker',
    lastUpdate: pos.updated || new Date().toISOString(),
  }));

  const deconflicted = deconflictPositions(carrierList);

  // Source breakdown
  const sourceBreakdown = {};
  for (const c of deconflicted) {
    sourceBreakdown[c.source] = (sourceBreakdown[c.source] || 0) + 1;
  }

  console.log(`[Carriers] ${deconflicted.length} carriers tracked. Sources: ${JSON.stringify(sourceBreakdown)}`);

  return {
    source: 'Carrier Strike Groups',
    timestamp: new Date().toISOString(),
    totalCarriers: deconflicted.length,
    carriers: deconflicted,
    sourceBreakdown,
    signals: deconflicted
      .filter(c => !c.desc.includes('Homeport') && !c.desc.includes('Maintenance') && !c.desc.includes('overhaul'))
      .map(c => `${c.name}: ${c.desc}`),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('carriers.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
