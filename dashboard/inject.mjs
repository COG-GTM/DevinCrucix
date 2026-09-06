#!/usr/bin/env node
// Crucix Dashboard Data Synthesizer
// Reads runs/latest.json, fetches RSS news, generates signal-based ideas,
// and injects everything into dashboard/public/jarvis.html
//
// Exports synthesize(), generateIdeas(), fetchAllNews() for use by server.mjs

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from '../crucix.config.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';
import { generateLLMIdeas } from '../lib/llm/ideas.mjs';
import { buildSourceHealth } from '../lib/sourcehealth.mjs';
import { buildCartelsView } from '../lib/cartelview.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// === Helpers ===
const cyrillic = /[\u0400-\u04FF]/;
function isEnglish(text) {
  if (!text) return false;
  return !cyrillic.test(text.substring(0, 80));
}

// === Geo-tagging keyword map ===
const geoKeywords = {
  'Ukraine':[49,32],'Russia':[56,38],'Moscow':[55.7,37.6],'Kyiv':[50.4,30.5],
  'China':[35,105],'Beijing':[39.9,116.4],'Iran':[32,53],'Tehran':[35.7,51.4],
  'Israel':[31.5,35],'Gaza':[31.4,34.4],'Palestine':[31.9,35.2],
  'Syria':[35,38],'Iraq':[33,44],'Saudi':[24,45],'Yemen':[15,48],'Lebanon':[34,36],
  'India':[20,78],'Japan':[36,138],'Korea':[37,127],'Pyongyang':[39,125.7],
  'Taiwan':[23.5,121],'Philippines':[13,122],'Myanmar':[20,96],
  'Canada':[56,-96],'Mexico':[23,-102],'Brazil':[-14,-51],'Argentina':[-38,-63],
  'Colombia':[4,-74],'Venezuela':[7,-66],'Cuba':[22,-80],'Chile':[-35,-71],
  'Germany':[51,10],'France':[46,2],'UK':[54,-2],'Britain':[54,-2],'London':[51.5,-0.1],
  'Spain':[40,-4],'Italy':[42,12],'Poland':[52,20],'NATO':[50,4],'EU':[50,4],
  'Turkey':[39,35],'Greece':[39,22],'Romania':[46,25],'Finland':[64,26],'Sweden':[62,15],
  'Africa':[0,20],'Nigeria':[10,8],'South Africa':[-30,25],'Kenya':[-1,38],
  'Egypt':[27,30],'Libya':[27,17],'Sudan':[13,30],'Ethiopia':[9,38],
  'Somalia':[5,46],'Congo':[-4,22],'Uganda':[1,32],'Morocco':[32,-6],
  'Pakistan':[30,70],'Afghanistan':[33,65],'Bangladesh':[24,90],
  'Australia':[-25,134],'Indonesia':[-2,118],'Thailand':[15,100],
  'US':[39,-98],'America':[39,-98],'Washington':[38.9,-77],'Pentagon':[38.9,-77],
  'Trump':[38.9,-77],'White House':[38.9,-77],
  'Wall Street':[40.7,-74],'New York':[40.7,-74],'California':[37,-120],
  'Nepal':[28,84],'Cambodia':[12.5,105],'Malawi':[-13.5,34],'Burundi':[-3.4,29.9],
  'Oman':[21,57],'Netherlands':[52.1,5.3],'Gabon':[-0.8,11.6],
  'Peru':[-10,-76],'Ecuador':[-2,-78],'Bolivia':[-17,-65],
  'Singapore':[1.35,103.8],'Malaysia':[4.2,101.9],'Vietnam':[16,108],
  'Algeria':[28,3],'Tunisia':[34,9],'Zimbabwe':[-20,30],'Mozambique':[-18,35],
  // Americas expansion
  'Texas':[31,-100],'Florida':[28,-82],'Chicago':[41.9,-87.6],'Los Angeles':[34,-118],
  'San Francisco':[37.8,-122.4],'Seattle':[47.6,-122.3],'Miami':[25.8,-80.2],
  'Toronto':[43.7,-79.4],'Ottawa':[45.4,-75.7],'Vancouver':[49.3,-123.1],
  'São Paulo':[-23.5,-46.6],'Rio':[-22.9,-43.2],'Buenos Aires':[-34.6,-58.4],
  'Bogotá':[4.7,-74.1],'Lima':[-12,-77],'Santiago':[-33.4,-70.7],
  'Caracas':[10.5,-66.9],'Havana':[23.1,-82.4],'Panama':[9,-79.5],
  'Guatemala':[14.6,-90.5],'Honduras':[14.1,-87.2],'El Salvador':[13.7,-89.2],
  'Costa Rica':[10,-84],'Jamaica':[18.1,-77.3],'Haiti':[19,-72],
  'Dominican':[18.5,-70],'Puerto Rico':[18.2,-66.5],
  // More Asia-Pacific
  'Sri Lanka':[7,80],'Hong Kong':[22.3,114.2],'Taipei':[25,121.5],
  'Seoul':[37.6,127],'Osaka':[34.7,135.5],'Mumbai':[19.1,72.9],
  'Delhi':[28.6,77.2],'Shanghai':[31.2,121.5],'Shenzhen':[22.5,114.1],
  'Auckland':[-36.8,174.8],'Papua New Guinea':[-6.3,147],
  // More Europe
  'Berlin':[52.5,13.4],'Paris':[48.9,2.3],'Madrid':[40.4,-3.7],
  'Rome':[41.9,12.5],'Warsaw':[52.2,21],'Prague':[50.1,14.4],
  'Vienna':[48.2,16.4],'Budapest':[47.5,19.1],'Bucharest':[44.4,26.1],
  'Kyiv':[50.4,30.5],'Oslo':[59.9,10.7],'Copenhagen':[55.7,12.6],
  'Brussels':[50.8,4.4],'Zurich':[47.4,8.5],'Dublin':[53.3,-6.3],
  'Lisbon':[38.7,-9.1],'Athens':[37.9,23.7],'Minsk':[53.9,27.6],
  // More Africa
  'Nairobi':[-1.3,36.8],'Lagos':[6.5,3.4],'Accra':[5.6,-0.2],
  'Addis Ababa':[9,38.7],'Cape Town':[-33.9,18.4],'Johannesburg':[-26.2,28],
  'Kinshasa':[-4.3,15.3],'Khartoum':[15.6,32.5],'Mogadishu':[2.1,45.3],
  'Dakar':[14.7,-17.5],'Abuja':[9.1,7.5],
  // Tech/Economy keywords with US locations
  'Fed':[38.9,-77],'Congress':[38.9,-77],'Senate':[38.9,-77],
  'Silicon Valley':[37.4,-122],'NASA':[28.6,-80.6],'Pentagon':[38.9,-77],
  'IMF':[38.9,-77],'World Bank':[38.9,-77],'UN':[40.7,-74],
};

function geoTagText(text) {
  if (!text) return null;
  for (const [keyword, [lat, lon]] of Object.entries(geoKeywords)) {
    if (text.includes(keyword)) {
      return { lat, lon, region: keyword };
    }
  }
  return null;
}

function sanitizeExternalUrl(raw) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function airSourceLabel(openSky) {
  const c = openSky?.coverage;
  if (!c || openSky.method === 'opensky') return 'OpenSky';
  if (openSky.method === 'adsb_sample') return 'ADS-B sample (OpenSky unreachable)';
  return `OpenSky ${c.opensky}/${c.total} · ADS-B sample ${c.adsbSample}/${c.total}`;
}

function sumAirHotspots(hotspots = []) {
  return hotspots.reduce((sum, hotspot) => sum + (hotspot.totalAircraft || 0), 0);
}

function summarizeAirHotspots(hotspots = []) {
  return hotspots.map(h => ({
    region: h.region,
    total: h.totalAircraft || 0,
    noCallsign: h.noCallsign || 0,
    highAlt: h.highAltitude || 0,
    top: Object.entries(h.byCountry || {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
  }));
}

// Air hotspot regions — mirrors OpenSky HOTSPOTS for ADS-B fallback
const AIR_REGIONS = [
  { region: 'Middle East', lamin: 12, lomin: 30, lamax: 42, lomax: 65 },
  { region: 'Taiwan Strait', lamin: 20, lomin: 115, lamax: 28, lomax: 125 },
  { region: 'Ukraine Region', lamin: 44, lomin: 22, lamax: 53, lomax: 41 },
  { region: 'Baltic Region', lamin: 53, lomin: 19, lamax: 60, lomax: 29 },
  { region: 'South China Sea', lamin: 5, lomin: 105, lamax: 23, lomax: 122 },
  { region: 'Korean Peninsula', lamin: 33, lomin: 124, lamax: 43, lomax: 132 },
  { region: 'Caribbean', lamin: 18, lomin: -90, lamax: 30, lomax: -72 },
  { region: 'Gulf of Guinea', lamin: -2, lomin: -5, lamax: 8, lomax: 10 },
  { region: 'Cape Route', lamin: -38, lomin: 12, lamax: -28, lomax: 24 },
  { region: 'Horn of Africa', lamin: 5, lomin: 40, lamax: 15, lomax: 55 },
];

// Build air hotspots from ADS-B military aircraft when OpenSky is unavailable
function buildAirHotspotsFromADSB(adsbSource) {
  const aircraft = adsbSource?.militaryAircraft || [];
  // Also include all aircraft from category arrays
  const catArrays = adsbSource?.categories || {};
  const allCategorized = [
    ...(catArrays.reconnaissance || []),
    ...(catArrays.bombers || []),
    ...(catArrays.tankers || []),
    ...(catArrays.vipTransport || []),
  ];
  // Merge: use militaryAircraft as primary, add any categorized aircraft not already present
  const seenHex = new Set(aircraft.map(a => a.hex).filter(Boolean));
  const merged = [...aircraft];
  for (const ac of allCategorized) {
    if (ac.hex && !seenHex.has(ac.hex)) {
      seenHex.add(ac.hex);
      merged.push(ac);
    }
  }

  return AIR_REGIONS.map(r => {
    const inRegion = merged.filter(ac => {
      const lat = ac.latitude ?? ac.lat ?? null;
      const lon = ac.longitude ?? ac.lon ?? null;
      if (lat == null || lon == null) return false;
      return lat >= r.lamin && lat <= r.lamax && lon >= r.lomin && lon <= r.lomax;
    });
    const byCountry = {};
    for (const ac of inRegion) {
      const country = ac.militaryMatch || ac.country || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
    }
    return {
      region: r.region,
      totalAircraft: inRegion.length,
      noCallsign: inRegion.filter(ac => !(ac.callsign || '').trim()).length,
      highAltitude: inRegion.filter(ac => (ac.altitude || 0) > 39370).length, // >12km in feet
      byCountry,
    };
  });
}

function loadOpenSkyFallback(currentTimestamp) {
  const runsDir = join(ROOT, 'runs');
  if (!existsSync(runsDir)) return null;

  const currentMs = currentTimestamp ? new Date(currentTimestamp).getTime() : NaN;
  const files = readdirSync(runsDir)
    .filter(name => /^briefing_.*\.json$/.test(name))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = join(runsDir, file);
    try {
      const prior = JSON.parse(readFileSync(filePath, 'utf8'));
      const priorTimestamp = prior.sources?.OpenSky?.timestamp || prior.crucix?.timestamp || null;
      if (priorTimestamp && Number.isFinite(currentMs) && new Date(priorTimestamp).getTime() >= currentMs) continue;

      const hotspots = prior.sources?.OpenSky?.hotspots || [];
      if (sumAirHotspots(hotspots) > 0) {
        return { file, timestamp: priorTimestamp, hotspots };
      }
    } catch {
      // Ignore unreadable historical runs and continue searching backward.
    }
  }

  return null;
}

// === RSS Fetching ===
async function fetchRSS(url, source) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
      const link = sanitizeExternalUrl((block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1] || '').trim());
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (title && title !== source) items.push({ title, date: pubDate, source, url: link || undefined });
    }
    return items;
  } catch (e) {
    console.log(`RSS fetch failed (${source}):`, e.message);
    return [];
  }
}

const RSS_SOURCE_FALLBACKS = {
  'SBS Australia': { lat: -35.2809, lon: 149.13, region: 'Australia' },
  'Indian Express': { lat: 28.6139, lon: 77.209, region: 'India' },
  'The Hindu': { lat: 13.0827, lon: 80.2707, region: 'India' },
  'MercoPress': { lat: -34.9011, lon: -56.1645, region: 'South America' }
};
const REGIONAL_NEWS_SOURCES = ['MercoPress', 'Indian Express', 'The Hindu', 'SBS Australia', 'INSIGHT CRIME'];

export async function fetchAllNews() {
  const feeds = [
    // Global
    ['http://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'NYT'],
    ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
    // USA
    ['https://feeds.npr.org/1001/rss.xml', 'NPR'],
    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'],
    ['http://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'BBC Science'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml', 'NYT Americas'],
    // Europe
    ['https://rss.dw.com/rdf/rss-en-all', 'DW'],
    ['https://www.france24.com/en/rss', 'France 24'],
    ['https://www.euronews.com/rss?format=mrss', 'Euronews'],
    // Africa & Cameroon region
    ['https://rss.dw.com/rdf/rss-en-africa', 'DW Africa'],
    ['https://www.rfi.fr/en/rss', 'RFI'],
    ['https://www.africanews.com/feed/rss', 'Africa News'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml', 'NYT Africa'],
    // Asia-Pacific
    ['https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml', 'NYT Asia'],
    ['https://www.sbs.com.au/news/topic/australia/feed', 'SBS Australia'],
    // India
    ['https://indianexpress.com/section/india/feed/', 'Indian Express'],
    ['https://www.thehindu.com/news/national/feeder/default.rss', 'The Hindu'],
    // South America
    ['https://en.mercopress.com/rss/latin-america', 'MercoPress'],
  ];

  const results = await Promise.allSettled(
    feeds.map(([url, source]) => fetchRSS(url, source))
  );

  const allNews = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // De-duplicate and geo-tag
  const seen = new Set();
  const geoNews = [];
  for (const item of allNews) {
    const key = item.title.substring(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const geo = geoTagText(item.title) || RSS_SOURCE_FALLBACKS[item.source];
    if (geo) {
      geoNews.push({
        title: item.title.substring(0, 100),
        source: item.source,
        date: item.date,
        url: item.url,
        lat: geo.lat + (Math.random() - 0.5) * 2,
        lon: geo.lon + (Math.random() - 0.5) * 2,
        region: geo.region
      });
    }
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filtered = geoNews.filter(n => !n.date || new Date(n.date) >= cutoff);
  filtered.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.source}|${item.title}|${item.date}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  // Reserve a little space so newly-added regional feeds are not crowded out by larger globals.
  for (const source of REGIONAL_NEWS_SOURCES) {
    filtered.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  filtered.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === Leverageable Ideas from Signals ===
export function generateIdeas(V2) {
  const ideas = [];
  const vix = V2.fred.find(f => f.id === 'VIXCLS');
  const hy = V2.fred.find(f => f.id === 'BAMLH0A0HYM2');
  const spread = V2.fred.find(f => f.id === 'T10Y2Y');

  if (V2.tg.urgent.length > 3 && V2.energy.wti > 68) {
    ideas.push({
      title: 'Conflict-Energy Nexus Active',
      text: `${V2.tg.urgent.length} urgent conflict signals with WTI at $${V2.energy.wti}. Geopolitical risk premium may expand. Consider energy exposure.`,
      type: 'long', confidence: 'Medium', horizon: 'swing'
    });
  }
  if (vix && vix.value > 20) {
    ideas.push({
      title: 'Elevated Volatility Regime',
      text: `VIX at ${vix.value} — fear premium elevated. Portfolio hedges justified. Short-term equity upside is capped.`,
      type: 'hedge', confidence: vix.value > 25 ? 'High' : 'Medium', horizon: 'tactical'
    });
  }
  if (vix && vix.value > 20 && hy && hy.value > 3) {
    ideas.push({
      title: 'Safe Haven Demand Rising',
      text: `VIX ${vix.value} + HY spread ${hy.value}% = risk-off building. Gold, treasuries, quality dividends may outperform.`,
      type: 'hedge', confidence: 'Medium', horizon: 'tactical'
    });
  }
  if (V2.energy.wtiRecent.length > 1) {
    const latest = V2.energy.wtiRecent[0];
    const oldest = V2.energy.wtiRecent[V2.energy.wtiRecent.length - 1];
    const pct = ((latest - oldest) / oldest * 100).toFixed(1);
    if (Math.abs(pct) > 3) {
      ideas.push({
        title: pct > 0 ? 'Oil Momentum Building' : 'Oil Under Pressure',
        text: `WTI moved ${pct > 0 ? '+' : ''}${pct}% recently to $${V2.energy.wti}/bbl. ${pct > 0 ? 'Energy and commodity names benefit.' : 'Demand concerns may be emerging.'}`,
        type: pct > 0 ? 'long' : 'watch', confidence: 'Medium', horizon: 'swing'
      });
    }
  }
  if (spread) {
    ideas.push({
      title: spread.value > 0 ? 'Yield Curve Normalizing' : 'Yield Curve Inverted',
      text: `10Y-2Y spread at ${spread.value.toFixed(2)}. ${spread.value > 0 ? 'Recession signal fading — cyclical rotation possible.' : 'Inversion persists — defensive positioning warranted.'}`,
      type: 'watch', confidence: 'Medium', horizon: 'strategic'
    });
  }
  const debt = parseFloat(V2.treasury.totalDebt);
  if (debt > 35e12) {
    ideas.push({
      title: 'Fiscal Trajectory Supports Hard Assets',
      text: `National debt at $${(debt / 1e12).toFixed(1)}T. Long-term gold, bitcoin, and real asset appreciation thesis intact.`,
      type: 'long', confidence: 'High', horizon: 'strategic'
    });
  }
  const totalThermal = V2.thermal.reduce((s, t) => s + t.det, 0);
  if (totalThermal > 30000 && V2.tg.urgent.length > 2) {
    ideas.push({
      title: 'Satellite Confirms Conflict Intensity',
      text: `${totalThermal.toLocaleString()} thermal detections + ${V2.tg.urgent.length} urgent OSINT flags. Defense sector procurement may accelerate.`,
      type: 'watch', confidence: 'Medium', horizon: 'swing'
    });
  }

  // Yield Curve + Labor Interaction
  const unemployment = V2.bls.find(b => b.id === 'LNS14000000' || b.id === 'UNRATE');
  const payrolls = V2.bls.find(b => b.id === 'CES0000000001' || b.id === 'PAYEMS');
  if (spread && unemployment && payrolls) {
    const weakLabor = (unemployment.value > 4.3) || (payrolls.momChange && payrolls.momChange < -50);
    if (spread.value > 0.3 && weakLabor) {
      ideas.push({
        title: 'Steepening Curve Meets Weak Labor',
        text: `10Y-2Y at ${spread.value.toFixed(2)} + UE ${unemployment.value}%. Curve steepening with deteriorating employment = recession positioning warranted.`,
        type: 'hedge', confidence: 'High', horizon: 'tactical'
      });
    }
  }

  // ACLED Conflict + Energy Momentum
  const conflictEvents = V2.acled?.totalEvents || 0;
  if (conflictEvents > 50 && V2.energy.wtiRecent.length > 1) {
    const wtiMove = V2.energy.wtiRecent[0] - V2.energy.wtiRecent[V2.energy.wtiRecent.length - 1];
    if (wtiMove > 2) {
      ideas.push({
        title: 'Conflict Fueling Energy Momentum',
        text: `${conflictEvents} ACLED events this week + WTI up $${wtiMove.toFixed(1)}. Conflict-energy transmission channel active.`,
        type: 'long', confidence: 'Medium', horizon: 'swing'
      });
    }
  }

  // Defense + Conflict Intensity
  const totalFatalities = V2.acled?.totalFatalities || 0;
  const totalThermalAll = V2.thermal.reduce((s, t) => s + t.det, 0);
  if (totalFatalities > 500 && totalThermalAll > 20000) {
    ideas.push({
      title: 'Defense Procurement Acceleration Signal',
      text: `${totalFatalities.toLocaleString()} conflict fatalities + ${totalThermalAll.toLocaleString()} thermal detections. Defense contractors may see accelerated procurement.`,
      type: 'long', confidence: 'Medium', horizon: 'swing'
    });
  }

  // HY Spread + VIX Divergence
  if (hy && vix) {
    const hyWide = hy.value > 3.5;
    const vixLow = vix.value < 18;
    const hyTight = hy.value < 2.5;
    const vixHigh = vix.value > 25;
    if (hyWide && vixLow) {
      ideas.push({
        title: 'Credit Stress Ignored by Equity Vol',
        text: `HY spread ${hy.value.toFixed(1)}% (wide) but VIX only ${vix.value.toFixed(0)} (complacent). Equity may be underpricing credit deterioration.`,
        type: 'watch', confidence: 'Medium', horizon: 'tactical'
      });
    } else if (hyTight && vixHigh) {
      ideas.push({
        title: 'Equity Fear Exceeds Credit Stress',
        text: `VIX at ${vix.value.toFixed(0)} but HY spread only ${hy.value.toFixed(1)}%. Equity vol may be overshooting — credit markets aren't confirming.`,
        type: 'watch', confidence: 'Medium', horizon: 'tactical'
      });
    }
  }

  // Supply Chain + Inflation Pipeline
  const ppi = V2.bls.find(b => b.id === 'WPUFD49104' || b.id === 'PCU--PCU--');
  const cpi = V2.bls.find(b => b.id === 'CUUR0000SA0' || b.id === 'CPIAUCSL');
  if (ppi && cpi && V2.gscpi) {
    const supplyPressure = V2.gscpi.value > 0.5;
    const ppiRising = ppi.momChangePct > 0.3;
    if (supplyPressure && ppiRising) {
      ideas.push({
        title: 'Inflation Pipeline Building Pressure',
        text: `GSCPI at ${V2.gscpi.value.toFixed(2)} (${V2.gscpi.interpretation}) + PPI momentum +${ppi.momChangePct?.toFixed(1)}%. Input costs flowing through — CPI may follow.`,
        type: 'long', confidence: 'Medium', horizon: 'strategic'
      });
    }
  }

  return ideas.slice(0, 8);
}

// === Synthesize raw sweep data into dashboard format ===
export async function synthesize(data) {
  const liveAirHotspots = data.sources.OpenSky?.hotspots || [];
  const airFallback = sumAirHotspots(liveAirHotspots) > 0
    ? null
    : loadOpenSkyFallback(data.sources.OpenSky?.timestamp || data.crucix?.timestamp);
  // ADS-B fallback: build air region hotspots from military aircraft when OpenSky is unavailable
  const adsbAirHotspots = (!airFallback && sumAirHotspots(liveAirHotspots) === 0)
    ? buildAirHotspotsFromADSB(data.sources['ADS-B'])
    : null;
  const effectiveAirHotspots = airFallback?.hotspots || (adsbAirHotspots && sumAirHotspots(adsbAirHotspots) > 0 ? adsbAirHotspots : liveAirHotspots);
  const air = summarizeAirHotspots(effectiveAirHotspots);
  const thermal = (data.sources.FIRMS?.hotspots || []).map(h => ({
    region: h.region, det: h.totalDetections || 0, night: h.nightDetections || 0,
    hc: h.highConfidence || 0,
    fires: (h.highIntensity || []).slice(0, 8).map(f => ({ lat: f.lat, lon: f.lon, frp: f.frp || 0 }))
  }));
  const tSignals = data.sources.FIRMS?.signals || [];
  const chokepoints = Object.values(data.sources.Maritime?.chokepoints || {}).map(c => ({
    label: c.label || c.name, note: c.note || '', lat: c.lat || 0, lon: c.lon || 0
  }));
  const nuke = (data.sources.Safecast?.sites || []).map(s => ({
    site: s.site, anom: s.anomaly || false, cpm: s.avgCPM, n: s.recentReadings || 0
  }));
  const nukeSignals = (data.sources.Safecast?.signals || []).filter(s => s);
  const sdrData = data.sources.KiwiSDR || {};
  const sdrNet = sdrData.network || {};
  const sdrConflict = sdrData.conflictZones || {};
  const sdrZones = Object.values(sdrConflict).map(z => ({
    region: z.region, count: z.count || 0,
    receivers: (z.receivers || []).slice(0, 5).map(r => ({ name: r.name || '', lat: r.lat || 0, lon: r.lon || 0 }))
  }));
  const tgData = data.sources.Telegram || {};
  const tgUrgent = (tgData.urgentPosts || []).filter(p => isEnglish(p.text)).map(p => ({
    channel: p.channel, text: p.text?.substring(0, 200), views: p.views, date: p.date, urgentFlags: p.urgentFlags || []
  }));
  const tgTop = (tgData.topPosts || []).filter(p => isEnglish(p.text)).map(p => ({
    channel: p.channel, text: p.text?.substring(0, 200), views: p.views, date: p.date, urgentFlags: []
  }));
  const who = (data.sources.WHO?.diseaseOutbreakNews || []).slice(0, 10).map(w => ({
    title: w.title?.substring(0, 120), date: w.date, summary: w.summary?.substring(0, 150)
  }));
  const fred = (data.sources.FRED?.indicators || []).map(f => ({
    id: f.id, label: f.label, value: f.value, date: f.date,
    recent: f.recent || [],
    momChange: f.momChange, momChangePct: f.momChangePct
  }));
  const energyData = data.sources.EIA || {};
  const oilPrices = energyData.oilPrices || {};
  const wtiRecent = (oilPrices.wti?.recent || []).map(d => d.value);
  const energy = {
    wti: oilPrices.wti?.value, brent: oilPrices.brent?.value,
    natgas: energyData.gasPrice?.value, crudeStocks: energyData.inventories?.crudeStocks?.value,
    wtiRecent, signals: energyData.signals || []
  };
  const bls = data.sources.BLS?.indicators || [];
  const treasuryData = data.sources.Treasury || {};
  const debtArr = treasuryData.debt || [];
  const treasury = { totalDebt: debtArr[0]?.totalDebt || '0', signals: treasuryData.signals || [] };
  const gscpi = data.sources.GSCPI?.latest || null;
  const defense = (data.sources.USAspending?.recentDefenseContracts || []).slice(0, 5).map(c => ({
    recipient: c.recipient?.substring(0, 40), amount: c.amount, desc: c.description?.substring(0, 80)
  }));
  const noaa = {
    totalAlerts: data.sources.NOAA?.totalSevereAlerts || 0,
    alerts: (data.sources.NOAA?.topAlerts || []).filter(a => a.lat != null && a.lon != null).slice(0, 10).map(a => ({
      event: a.event, severity: a.severity, headline: a.headline?.substring(0, 120),
      lat: a.lat, lon: a.lon
    }))
  };

  // EPA RadNet — pass through geo-tagged readings
  const epaData = data.sources.EPA || {};
  const epaStations = [];
  const seenEpa = new Set();
  for (const r of (epaData.readings || [])) {
    if (r.lat == null || r.lon == null) continue;
    const key = `${r.lat},${r.lon}`;
    if (seenEpa.has(key)) continue;
    seenEpa.add(key);
    epaStations.push({ location: r.location, state: r.state, lat: r.lat, lon: r.lon, analyte: r.analyte, result: r.result, unit: r.unit });
  }
  const epa = { totalReadings: epaData.totalReadings || 0, stations: epaStations.slice(0, 10) };

  // Space/CelesTrak satellite data
  const spaceData = data.sources.Space || {};
  // Approximate subsatellite position from TLE orbital elements
  function estimateSatPosition(sat) {
    if (!sat?.inclination || !sat?.epoch) return null;
    const epoch = new Date(sat.epoch);
    const now = new Date();
    const elapsed = (now - epoch) / 1000;
    const period = (sat.period || 92.7) * 60; // minutes to seconds
    const orbits = elapsed / period;
    const frac = orbits % 1;
    const lat = sat.inclination * Math.sin(frac * 2 * Math.PI);
    const lonShift = (elapsed / 86400) * 360;
    const orbitLon = frac * 360;
    const lon = ((orbitLon - lonShift) % 360 + 540) % 360 - 180;
    return { lat: +lat.toFixed(2), lon: +lon.toFixed(2), name: sat.name };
  }
  const issPos = estimateSatPosition(spaceData.iss);
  const spaceStations = (spaceData.spaceStations || []).map(s => estimateSatPosition(s)).filter(Boolean);
  const space = {
    totalNewObjects: spaceData.totalNewObjects || 0,
    militarySats: spaceData.militarySatellites || 0,
    militaryByCountry: spaceData.militaryByCountry || {},
    constellations: spaceData.constellations || {},
    iss: spaceData.iss || null,
    issPosition: issPos,
    stationPositions: spaceStations.slice(0, 5),
    recentLaunches: (spaceData.recentLaunches || []).slice(0, 10).map(l => ({
      name: l.name, country: l.country, epoch: l.epoch,
      apogee: l.apogee, perigee: l.perigee, type: l.objectType
    })),
    launchByCountry: spaceData.launchByCountry || {},
    signals: spaceData.signals || [],
  };

  // ACLED conflict events
  const acledData = data.sources.ACLED || {};
  const acled = acledData.error ? { totalEvents: 0, totalFatalities: 0, byRegion: {}, byType: {}, deadliestEvents: [], flashAlerts: [] } : {
    totalEvents: acledData.totalEvents || 0,
    totalFatalities: acledData.totalFatalities || 0,
    byRegion: acledData.byRegion || {},
    byType: acledData.byType || {},
    deadliestEvents: (acledData.deadliestEvents || []).slice(0, 15).map(e => ({
      date: e.date, type: e.type, country: e.country, location: e.location,
      fatalities: e.fatalities || 0, lat: e.lat || null, lon: e.lon || null
    })),
    flashAlerts: (acledData.flashAlerts || []).slice(0, 5),
  };

  // GDELT news articles + geo events + tone scoring + clustering
  const gdeltData = data.sources.GDELT || {};
  const gdelt = {
    totalArticles: gdeltData.totalArticles || 0,
    conflicts: (gdeltData.conflicts || []).length,
    economy: (gdeltData.economy || []).length,
    health: (gdeltData.health || []).length,
    crisis: (gdeltData.crisis || []).length,
    topTitles: (gdeltData.allArticles || []).slice(0, 5).map(a => a.title?.substring(0, 80)),
    geoPoints: (gdeltData.geoPoints || []).slice(0, 30).map(p => ({
      lat: p.lat, lon: p.lon, name: (p.name || '').substring(0, 80), count: p.count || 1
    })),
    geoClusters: (gdeltData.geoClusters || []).slice(0, 15).map(c => ({
      lat: c.lat, lon: c.lon, count: c.count, label: (c.label || '').substring(0, 80)
    })),
    toneScores: (gdeltData.toneScores || []).map(t => ({
      region: t.region, currentTone: t.currentTone, previousTone: t.previousTone, shift: t.shift
    })),
    priorityAlerts: (gdeltData.priorityAlerts || []).slice(0, 5),
  };

  const sourceHealth = buildSourceHealth(data);
  const health = sourceHealth.sources.map(s => ({
    n: s.name, err: s.state === 'error', stale: s.state === 'degraded'
  }));

  // === Yahoo Finance live market data ===
  const yfData = data.sources.YFinance || {};
  const yfQuotes = yfData.quotes || {};
  const markets = {
    indexes: (yfData.indexes || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct, history: q.history || []
    })),
    rates: (yfData.rates || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct
    })),
    commodities: (yfData.commodities || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct, history: q.history || []
    })),
    crypto: (yfData.crypto || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct
    })),
    vix: yfQuotes['^VIX'] ? {
      value: yfQuotes['^VIX'].price,
      change: yfQuotes['^VIX'].change,
      changePct: yfQuotes['^VIX'].changePct,
    } : null,
    timestamp: yfData.summary?.timestamp || null,
  };

  const yfGold = yfQuotes['GC=F'];
  const yfSilver = yfQuotes['SI=F'];
  const metals = {
    gold: yfGold?.price,
    goldChange: yfGold?.change,
    goldChangePct: yfGold?.changePct,
    goldRecent: yfGold?.history?.map(h => h.close) || [],
    silver: yfSilver?.price,
    silverChange: yfSilver?.change,
    silverChangePct: yfSilver?.changePct,
    silverRecent: yfSilver?.history?.map(h => h.close) || [],
  };

  // Override stale EIA prices with live Yahoo Finance data if available
  const yfWti = yfQuotes['CL=F'];
  const yfBrent = yfQuotes['BZ=F'];
  const yfNatgas = yfQuotes['NG=F'];
  if (yfWti?.price) energy.wti = yfWti.price;
  if (yfBrent?.price) energy.brent = yfBrent.price;
  if (yfNatgas?.price) energy.natgas = yfNatgas.price;
  if (yfWti?.history?.length) energy.wtiRecent = yfWti.history.map(h => h.close);

  // Fetch RSS
  const news = await fetchAllNews();

  const V2 = {
    meta: { ...data.crucix, health: sourceHealth.summary }, air, thermal, tSignals, chokepoints, nuke, nukeSignals,
    sourceHealth,
    airMeta: {
      fallback: Boolean(airFallback || adsbAirHotspots),
      liveTotal: sumAirHotspots(liveAirHotspots),
      timestamp: airFallback?.timestamp || data.sources['ADS-B']?.timestamp || data.sources.OpenSky?.timestamp || data.crucix?.timestamp || null,
      source: adsbAirHotspots ? 'ADS-B Military' : (airFallback ? 'OpenSky fallback' : airSourceLabel(data.sources.OpenSky)),
      method: data.sources.OpenSky?.method || null,
      ...(data.sources.OpenSky?.coverage ? { coverage: data.sources.OpenSky.coverage } : {}),
      ...(data.sources.OpenSky?.note ? { note: data.sources.OpenSky.note } : {}),
      ...(airFallback ? { fallbackFile: airFallback.file } : {}),
      ...(data.sources.OpenSky?.status ? { status: data.sources.OpenSky.status } : {}),
      ...(data.sources.OpenSky?.dataTimestamp ? { dataTimestamp: data.sources.OpenSky.dataTimestamp } : {}),
      ...(data.sources.OpenSky?.auth ? { auth: data.sources.OpenSky.auth } : {}),
      ...(data.sources.OpenSky?.creditsRemaining != null ? { creditsRemaining: data.sources.OpenSky.creditsRemaining } : {}),
      ...(data.sources.OpenSky?.error ? { error: data.sources.OpenSky.error } : {}),
    },
    sdr: { total: sdrNet.totalReceivers || 0, online: sdrNet.online || 0, zones: sdrZones },
    tg: { posts: tgData.totalPosts || 0, urgent: tgUrgent, topPosts: tgTop },
    who, fred, energy, metals, bls, treasury, gscpi, defense, noaa, epa, acled, gdelt, space, health, news,
    markets, // Live Yahoo Finance market data
    // Phase 2A: ADS-B military aircraft data
    adsbMilitary: (() => {
      const adsbData = data.sources['ADS-B'] || {};
      return {
        status: adsbData.status || 'unknown',
        dataSource: adsbData.dataSource || 'unknown',
        totalMilitary: adsbData.totalMilitary || 0,
        byCountry: adsbData.byCountry || {},
        categories: {
          reconnaissance: (adsbData.categories?.reconnaissance || []).slice(0, 10).map(a => ({
            callsign: a.callsign, type: a.typeDescription || a.type, lat: a.latitude, lon: a.longitude,
            altitude: a.altitude, speed: a.speed, country: a.militaryMatch
          })),
          bombers: (adsbData.categories?.bombers || []).slice(0, 5).map(a => ({
            callsign: a.callsign, type: a.typeDescription || a.type, lat: a.latitude, lon: a.longitude,
            altitude: a.altitude, country: a.militaryMatch
          })),
          tankers: (adsbData.categories?.tankers || []).slice(0, 5).map(a => ({
            callsign: a.callsign, type: a.typeDescription || a.type, lat: a.latitude, lon: a.longitude,
            country: a.militaryMatch
          })),
          vipTransport: (adsbData.categories?.vipTransport || []).slice(0, 3).map(a => ({
            callsign: a.callsign, type: a.typeDescription || a.type, lat: a.latitude, lon: a.longitude,
            country: a.militaryMatch
          })),
        },
        signals: adsbData.signals || [],
        priorityAlerts: (adsbData.priorityAlerts || []).slice(0, 5),
      };
    })(),
    // Phase 2A: SpiderFoot OSINT results
    spiderfoot: (() => {
      const sfData = data.sources.SpiderFoot || {};
      return {
        status: sfData.status || 'offline',
        sfUrl: sfData.sfUrl || null,
        totalScans: sfData.totalScans || 0,
        recentScans: (sfData.recentScans || []).slice(0, 5).map(s => ({
          name: s.name, target: s.target, status: s.status, started: s.started,
          summaryCount: (s.summary || []).reduce((sum, e) => sum + (e.count || 0), 0)
        })),
        findings: (sfData.findings || []).slice(0, 10),
      };
    })(),
    // Phase 2A: InSight Crime intelligence
    insightCrime: (() => {
      const icData = data.sources.InSightCrime || {};
      return {
        totalArticles: icData.totalArticles || 0,
        feeds: icData.feeds || [],
        articles: (icData.articles || []).slice(0, 15).map(a => ({
          title: (a.title || '').substring(0, 100), date: a.date, feed: a.feed,
          entities: (a.entities || []).slice(0, 5), categories: (a.categories || []).slice(0, 3),
          link: a.link
        })),
        extractedEntities: (icData.extractedEntities || []).slice(0, 20),
        sanctionsHits: (icData.sanctionsHits || []).slice(0, 10),
        priorityAlerts: (icData.priorityAlerts || []).slice(0, 5),
      };
    })(),
    // Phase 2A: OpenSanctions cross-referencing
    sanctionsCrossRef: (() => {
      const osData = data.sources.OpenSanctions || {};
      return {
        hasApiKey: osData.hasApiKey || false,
        crossRefAvailable: osData.crossRefAvailable || false,
        totalSanctionedEntities: osData.totalSanctionedEntities || 0,
        monitoringTargets: osData.monitoringTargets || [],
        recentSearches: (osData.recentSearches || []).map(s => ({
          query: s.query, totalResults: s.totalResults, entityCount: (s.entities || []).length
        })),
      };
    })(),
    // Unusual Whales market intelligence
    unusualWhales: (() => {
      const uwData = data.sources.UnusualWhales || {};
      if (uwData.status !== 'live') return { status: uwData.status || 'offline' };
      const of = uwData.optionsFlow || {};
      const ct = uwData.congressTrades || {};
      const dp = uwData.darkPool || {};
      return {
        status: 'live',
        optionsFlow: {
          total: of.total || 0,
          totalPremium: of.totalPremium || 0,
          sweepCount: of.sweepCount || 0,
          topAlerts: (of.topAlerts || []).slice(0, 10).map(o => ({
            ticker: o.ticker, type: o.type, strike: o.strike, expiry: o.expiry,
            premium: o.premium, size: o.size, sector: o.sector,
            hasSweep: o.hasSweep, underlyingPrice: o.underlyingPrice,
            alertRule: o.alertRule, createdAt: o.createdAt,
          })),
          largeFlow: (of.largeFlow || []).slice(0, 5),
          bigDefenseFlow: (of.bigDefenseFlow || []).slice(0, 5),
        },
        congressTrades: {
          total: ct.total || 0,
          recent: (ct.recent || []).slice(0, 15).map(t => ({
            name: t.name, ticker: t.ticker, txnType: t.txnType,
            amounts: t.amounts, amountMid: t.amountMid,
            transactionDate: t.transactionDate, filedDate: t.filedDate,
            memberType: t.memberType, isDefenseCommittee: t.isDefenseCommittee,
            isDefenseEnergySector: t.isDefenseEnergySector,
          })),
          defenseSector: (ct.defenseSector || []).slice(0, 10),
          defenseCommittee: (ct.defenseCommittee || []).slice(0, 10),
        },
        darkPool: {
          total: dp.total || 0,
          totalVolume: dp.totalVolume || 0,
          largePrints: (dp.largePrints || []).slice(0, 10).map(d => ({
            ticker: d.ticker, size: d.size, price: d.price,
            premium: d.premium, executedAt: d.executedAt,
          })),
          topPrints: (dp.topPrints || []).slice(0, 10).map(d => ({
            ticker: d.ticker, size: d.size, price: d.price,
            premium: d.premium, executedAt: d.executedAt,
          })),
        },
        globeMarkers: (uwData.globeMarkers || []).slice(0, 15),
        signals: uwData.signals || [],
        priorityAlerts: (uwData.priorityAlerts || []).slice(0, 5),
      };
    })(),
    // Phase 3: Carrier Strike Groups
    carriers: (() => {
      const cData = data.sources.Carriers || {};
      return {
        totalCarriers: cData.totalCarriers || 0,
        carriers: (cData.carriers || []).map(c => ({
          hull: c.hull, name: c.name, type: c.type,
          lat: c.lat, lng: c.lng, heading: c.heading,
          homeport: c.homeport, desc: (c.desc || '').substring(0, 120),
          wiki: c.wiki, estimated: c.estimated,
          source: c.source, sourceUrl: c.sourceUrl,
          lastUpdate: c.lastUpdate,
        })),
        sourceBreakdown: cData.sourceBreakdown || {},
        signals: (cData.signals || []).slice(0, 10),
      };
    })(),
    // Phase 3: GPS Jamming Detection
    gpsJamming: (() => {
      const gjData = data.sources.GPSJamming || {};
      return {
        status: gjData.status || 'unknown',
        dataSource: gjData.dataSource || 'unknown',
        totalZones: gjData.totalZones || 0,
        zones: (gjData.zones || []).map(z => ({
          lat: z.lat, lng: z.lng,
          gridLat: z.gridLat, gridLng: z.gridLng, gridSize: z.gridSize,
          severity: z.severity, ratio: z.ratio,
          degraded: z.degraded, total: z.total,
          pctLabel: z.pctLabel, region: z.region,
        })),
        aircraftAnalyzed: gjData.aircraftAnalyzed || 0,
        totalDegraded: gjData.totalDegraded || 0,
        severityBreakdown: gjData.severityBreakdown || {},
        signals: (gjData.signals || []).slice(0, 5),
      };
    })(),
    // Phase 3: CCTV Mesh
    cctvMesh: (() => {
      const ccData = data.sources.CCTV || {};
      return {
        status: ccData.status || 'unknown',
        totalCameras: ccData.totalCameras || 0,
        cameras: (ccData.cameras || []).slice(0, 500).map(c => ({
          id: c.id, source: c.source,
          lat: c.lat, lng: c.lng,
          name: (c.name || '').substring(0, 80),
          direction: c.direction || '',
          feedUrl: c.feedUrl || '',
          feedType: c.feedType || 'image',
        })),
        sourceCounts: ccData.sourceCounts || {},
        sourceErrors: ccData.sourceErrors || {},
      };
    })(),
    // Phase 4: Analytical Features (computed post-sweep, stubs here for inject.mjs CLI mode)
    cii: (() => {
      const ciiData = data.sources.CII || {};
      return {
        source: ciiData.source || 'CII',
        status: ciiData.status || 'deferred',
        totalCountries: ciiData.totalCountries || 0,
        countries: (ciiData.countries || []).map(c => ({
          code: c.code, name: c.name, lat: c.lat, lng: c.lng,
          score: c.score, level: c.level, color: c.color,
          trend: c.trend, trendDelta: c.trendDelta,
          components: c.components || {},
          boosts: c.boosts || {},
          topHeadlines: (c.topHeadlines || []).slice(0, 5),
        })),
        warmingUp: ciiData.warmingUp || false,
        warmupProgress: ciiData.warmupProgress || 100,
        levelBreakdown: ciiData.levelBreakdown || {},
        signals: (ciiData.signals || []).slice(0, 10),
      };
    })(),
    convergence: (() => {
      const convData = data.sources.Convergence || {};
      return {
        source: convData.source || 'Convergence',
        status: convData.status || 'deferred',
        totalZones: convData.totalZones || 0,
        zones: (convData.zones || []).map(z => ({
          key: z.key, lat: z.lat, lng: z.lng,
          gridLat: z.gridLat, gridLng: z.gridLng, gridSize: z.gridSize || 1.0,
          eventTypes: z.eventTypes || [], typeCount: z.typeCount || 0,
          totalEvents: z.totalEvents || 0, typeCounts: z.typeCounts || {},
          score: z.score, alertLevel: z.alertLevel, color: z.color,
        })),
        levelBreakdown: convData.levelBreakdown || {},
        signals: (convData.signals || []).slice(0, 5),
      };
    })(),
    signals: (() => {
      const sigData = data.sources.Signals || {};
      return {
        source: sigData.source || 'Signals',
        status: sigData.status || 'deferred',
        totalSignals: sigData.totalSignals || 0,
        signals: (sigData.signals || []).slice(0, 20).map(s => ({
          type: s.type, confidence: s.confidence,
          title: (s.title || '').substring(0, 200),
          sources: (s.sources || []).slice(0, 5),
          whyItMatters: (s.whyItMatters || '').substring(0, 300),
          actionableInsight: (s.actionableInsight || '').substring(0, 300),
          timestamp: s.timestamp,
          propagandaFlags: s.propagandaFlags || [],
          lat: s.lat, lng: s.lng,
          countryCode: s.countryCode, countryName: s.countryName,
        })),
        byType: sigData.byType || {},
      };
    })(),
    focalPoints: (() => {
      const fpData = data.sources.FocalPoints || {};
      return {
        source: fpData.source || 'FocalPoints',
        status: fpData.status || 'deferred',
        totalFocalPoints: fpData.totalFocalPoints || 0,
        focalPoints: (fpData.focalPoints || []).slice(0, 30).map(f => ({
          entityId: f.entityId, name: f.name, type: f.type, sector: f.sector,
          countryCode: f.countryCode,
          score: f.score, urgency: f.urgency,
          components: f.components || {},
          mentions: f.mentions,
          topHeadlines: (f.topHeadlines || []).slice(0, 5),
          signalTypes: f.signalTypes || [],
          narrative: (f.narrative || '').substring(0, 300),
          lat: f.lat, lng: f.lng,
        })),
        urgencyBreakdown: fpData.urgencyBreakdown || {},
        signals: (fpData.signals || []).slice(0, 5),
      };
    })(),
    // Phase 5: Pentagon Pizza Index
    pizzaIndex: (() => {
      const piData = data.sources.PizzaIndex || {};
      return {
        status: piData.status || 'unavailable',
        doughcon: piData.doughcon ?? null,
        alertLevel: piData.alertLevel || 'unknown',
        avgWait: piData.avgWait || 0,
        storesOpen: piData.storesOpen || 0,
        totalStores: piData.totalStores || 0,
        trend: piData.trend || 'stable',
        graph: (piData.graph || []).slice(-24).map(g => typeof g === 'number' ? g : (g.avgWait || g.avg_wait || 0)),
        signals: piData.signals || [],
      };
    })(),
    // Phase 5: CISA KEV Cyber Threat Layer
    cyberKev: (() => {
      const ckData = data.sources.CyberKEV || {};
      return {
        status: ckData.status || 'unavailable',
        totalVulnerabilities: ckData.totalVulnerabilities || 0,
        recentCount: ckData.recentCount || 0,
        vulnerabilities: (ckData.vulnerabilities || []).slice(0, 50).map(v => ({
          cveID: (v.cveID || '').substring(0, 20), vendor: (v.vendor || '').substring(0, 40), product: (v.product || '').substring(0, 60),
          name: (v.name || '').substring(0, 120),
          dateAdded: v.dateAdded, dueDate: v.dueDate,
          description: (v.description || '').substring(0, 200),
          ransomware: v.ransomware, categories: v.categories || [],
          severity: v.severity, prcRelevant: v.prcRelevant,
          lat: v.lat, lng: v.lng, vendorCountry: v.vendorCountry,
          nvdUrl: v.nvdUrl,
        })),
        globeMarkers: ckData.globeMarkers || [],
        categoryBreakdown: ckData.categoryBreakdown || {},
        prcRelevantCount: ckData.prcRelevantCount || 0,
        ransomwareCount: ckData.ransomwareCount || 0,
        signals: ckData.signals || [],
      };
    })(),
    // Phase 7: Typosquat Watch (look-alike domains against the watchlist)
    typosquat: (() => {
      const tsData = data.sources.Typosquat || {};
      return {
        status: tsData.status || 'unavailable',
        watchlist: (tsData.watchlist || []).slice(0, 25),
        totalChecked: tsData.totalChecked || 0,
        newCount: tsData.newCount || 0,
        byBase: tsData.byBase || {},
        byTechnique: tsData.byTechnique || {},
        registered: (tsData.registered || []).slice(0, 80).map(r => ({
          domain: String(r.domain || '').substring(0, 253),
          base: String(r.base || '').substring(0, 253),
          technique: String(r.technique || '').substring(0, 20),
          ips: (r.ips || []).slice(0, 3),
          isNew: !!r.isNew,
        })),
        timestamp: tsData.timestamp || null,
      };
    })(),
    // Border Watch: registry-driven regional news with per-feed health, tags and spikes
    borderNews: (() => {
      const bn = data.sources.BorderNews || {};
      const str = (v, n) => String(v ?? '').substring(0, n);
      const num = (v) => (Number.isFinite(v) ? v : 0);
      return {
        status: bn.status || 'unavailable',
        error: bn.error ? str(bn.error, 200) : null,
        note: bn.note ? str(bn.note, 200) : null,
        timestamp: bn.timestamp || null,
        pipelineVersion: str(bn.pipelineVersion, 40),
        totalArticles: num(bn.totalArticles),
        newThisSweep: num(bn.newThisSweep),
        feeds: (bn.feeds || []).slice(0, 20).map(f => ({
          id: str(f.id, 40), outlet: str(f.outlet, 60), status: str(f.status, 20), httpStatus: f.httpStatus ?? null,
          reason: f.reason ? str(f.reason, 120) : null, items: num(f.items), newItems: num(f.newItems),
          reliability: str(f.reliability, 10), lastPolled: f.lastPolled || null, lastChanged: f.lastChanged || null,
          articleFetch: f.articleFetch || null,
        })),
        articles: (bn.articles || []).slice(0, 40).map(a => ({
          id: str(a.id, 64), outlet: str(a.outlet, 60), sourceId: str(a.sourceId, 40), title: str(a.title, 200),
          url: sanitizeExternalUrl(a.url), canonicalUrl: sanitizeExternalUrl(a.canonicalUrl),
          publishedAt: a.publishedAt || null, collectedAt: a.collectedAt || null,
          excerpt: str(a.excerpt, 300), categories: (a.categories || []).slice(0, 8).map(c => str(c, 40)),
          topics: (a.tags?.topics || []).slice(0, 7).map(t => str(t, 20)),
          places: (a.tags?.places || []).slice(0, 6).map(p => str(p, 40)),
          extraction: str(a.extraction?.method, 30), fetchStatus: str(a.extraction?.fetchStatus, 60),
          paywalled: !!a.paywalled, syndicated: !!a.syndicated, wireSource: a.wireSource ? str(a.wireSource, 60) : null,
          reliability: str(a.reliability, 10), language: str(a.language, 8),
        })),
        summary: bn.summary ? {
          windowDays: num(bn.summary.windowDays), articlesInWindow: num(bn.summary.articlesInWindow),
          topicCounts: bn.summary.topicCounts || {},
          outletCounts: bn.summary.outletCounts || {},
          places: (bn.summary.places || []).slice(0, 25).map(p => ({
            key: str(p.key, 40), name: str(p.name, 60), country: str(p.country, 2), sector: p.sector ? str(p.sector, 30) : null,
            lat: Number.isFinite(p.lat) ? p.lat : null, lon: Number.isFinite(p.lon) ? p.lon : null, count: num(p.count),
          })),
        } : null,
        baseline: bn.baseline || null,
        spikes: (bn.spikes || []).slice(0, 10).map(s => ({
          place: str(s.place, 40), placeName: str(s.placeName, 60), sector: s.sector ? str(s.sector, 30) : null,
          lat: Number.isFinite(s.lat) ? s.lat : null, lon: Number.isFinite(s.lon) ? s.lon : null,
          topic: str(s.topic, 20), count24h: num(s.count24h), baselineDailyMean: num(s.baselineDailyMean), ratio: s.ratio ?? null,
          articleIds: (s.articleIds || []).slice(0, 10).map(i => str(i, 64)), rule: str(s.rule, 120),
        })),
        registry: (bn.registry || []).slice(0, 20).map(r => ({
          id: str(r.id, 40), outlet: str(r.outlet, 60), language: str(r.language, 8), regionTag: str(r.regionTag, 40),
          reliability: str(r.reliability, 10), discoveryDate: str(r.discoveryDate, 10), paywall: !!r.paywall,
        })),
      };
    })(),
    // Phase 5: Telegram OSINT Live (background scraper data)
    telegramLive: (() => {
      const tlData = data.sources.TelegramLive || {};
      return {
        status: tlData.status || 'stopped',
        totalMessages: tlData.totalMessages || 0,
        channels: tlData.channels || 0,
        recentMessages: (tlData.recentMessages || []).slice(0, 15).map(m => ({ ...m, url: sanitizeExternalUrl(m.url) })),
      };
    })(),
    // Phase 5: Polymarket Geopolitical Odds
    polymarket: (() => {
      const pmData = data.sources.Polymarket || {};
      return {
        status: pmData.status || 'unavailable',
        totalGeoMarkets: pmData.totalGeoMarkets || 0,
        markets: (pmData.markets || []).slice(0, 10).map(m => ({
          question: (m.question || '').substring(0, 120),
          yesProb: m.yesProb, noProb: m.noProb,
          volume24hr: m.volume24hr, totalVolume: m.totalVolume,
          change24h: m.change24h, url: m.url,
        })),
        avgGeoRisk: pmData.avgGeoRisk ?? 50,
        signals: pmData.signals || [],
      };
    })(),
    // Phase 5: DEFCON Threat Meter (computed post-sweep like CII)
    defcon: (() => {
      const dcData = data.sources.DEFCON || {};
      return {
        source: dcData.source || 'DEFCON',
        status: dcData.status || 'deferred',
        level: dcData.level || 5,
        score: dcData.score || 0,
        color: dcData.color || '#00ff41',
        label: dcData.label || 'NORMAL READINESS',
        pulse: dcData.pulse || false,
        components: dcData.components || {},
        fallbackMode: dcData.fallbackMode ?? true,
      };
    })(),
    // Phase 6: Osiris-Ported Features
    nuclear: (() => {
      const nData = data.sources.Nuclear || {};
      return {
        source: 'NuclearFacilities',
        status: nData.status || 'unavailable',
        totalFacilities: nData.totalFacilities || 0,
        totalReactors: nData.totalReactors || 0,
        totalCapacityMW: nData.totalCapacityMW || 0,
        byCountry: nData.byCountry || {},
        statusCounts: nData.statusCounts || {},
        facilities: (nData.facilities || []).map(f => ({
          id: f.id, name: f.name, country: f.country,
          lat: f.lat, lng: f.lng,
          reactors: f.reactors, capacityMW: f.capacityMW,
          operator: f.operator, status: f.status, risk: f.risk || null,
        })),
        signals: nData.signals || [],
      };
    })(),
    spaceWeather: (() => {
      const swData = data.sources.SpaceWeather || {};
      return {
        source: 'SpaceWeather',
        status: swData.status || 'unavailable',
        kp: swData.kp || { current: 0, level: 'Quiet', color: '#00E676', severity: 'nominal', history: [] },
        flares: (swData.flares || []).slice(0, 10),
        alerts: (swData.alerts || []).slice(0, 10),
        signals: swData.signals || [],
      };
    })(),
    frontlines: (() => {
      // Geometry stays out of the dashboard payload; the browser pulls /api/frontlines/geo on demand.
      const flData = data.sources.Frontlines || {};
      const area = flData.areaKm2 || {};
      const hist = flData.history || {};
      return {
        source: 'Frontlines',
        provider: flData.provider || 'DeepStateMAP',
        siteUrl: flData.siteUrl || 'https://deepstatemap.live/en',
        status: flData.status || 'unavailable',
        stale: Boolean(flData.stale),
        mapId: flData.mapId || null,
        mapUpdatedAt: flData.mapUpdatedAt || null,
        mapAgeH: Number.isFinite(flData.mapAgeH) ? flData.mapAgeH : null,
        featureCount: flData.featureCount || 0,
        polyCats: flData.polyCats || {},
        pointCats: flData.pointCats || {},
        areaKm2: {
          occupied: area.occupied || 0,
          occupied_pre2022: area.occupied_pre2022 || 0,
          contested: area.contested || 0,
          liberated: area.liberated || 0,
        },
        occupiedKm2: flData.occupiedKm2 || 0,
        contestedKm2: flData.contestedKm2 || 0,
        attackDirections: flData.attackDirections || 0,
        units: flData.units || 0,
        airfields: flData.airfields || 0,
        history: {
          total: hist.total || 0,
          recent7d: hist.recent7d || 0,
          advances7d: hist.advances7d || 0,
          regains7d: hist.regains7d || 0,
          latestAt: hist.latestAt || null,
          updates: Array.isArray(hist.updates) ? hist.updates.slice(0, 12) : [],
        },
        signals: flData.signals || [],
      };
    })(),
    // Cartels page: crowd-sourced KML summary + START 2020 baseline + Mexico-filtered live feeds.
    // Geometry stays out of the payload; the browser pulls /api/cartels/geo on demand.
    cartels: buildCartelsView(data.sources),
    satTracking: (() => {
      const stData = data.sources.SatTracking || {};
      return {
        source: 'Satellites',
        status: stData.status || 'unavailable',
        totalTracked: stData.totalTracked || 0,
        totalTLEs: stData.totalTLEs || 0,
        byCategory: stData.byCategory || {},
        byMission: stData.byMission || {},
        satellites: (stData.satellites || []).slice(0, 200).map(s => ({
          name: s.name, lat: s.lat, lng: s.lng, alt: s.alt,
          mission: s.mission, color: s.color, category: s.category,
        })),
        signals: stData.signals || [],
      };
    })(),
    liveNews: (() => {
      const lnData = data.sources.LiveNews || {};
      return {
        source: 'LiveNews',
        status: lnData.status || 'unavailable',
        totalStreams: lnData.totalStreams || 0,
        byCountry: lnData.byCountry || {},
        byCategory: lnData.byCategory || {},
        streams: (lnData.streams || []).map(s => ({
          id: s.id, name: s.name, country: s.country,
          lat: s.lat, lng: s.lng, url: s.url,
          network: s.network, category: s.category,
        })),
        signals: lnData.signals || [],
      };
    })(),
    ideas: [], ideasSource: 'disabled',
    // newsFeed for ticker (merged RSS + GDELT + Telegram + InSight Crime)
    newsFeed: buildNewsFeed(news, gdeltData, tgUrgent, tgTop, data.sources.InSightCrime, data.sources.BorderNews),
  };

  return V2;
}

// === Unified News Feed for Ticker ===
function buildNewsFeed(rssNews, gdeltData, tgUrgent, tgTop, insightCrimeData, borderNewsData) {
  const feed = [];

  // RSS news
  for (const n of rssNews) {
    feed.push({
      headline: n.title, source: n.source, type: 'rss',
      timestamp: n.date, region: n.region, urgent: false, url: n.url
    });
  }

  // GDELT top articles
  for (const a of (gdeltData.allArticles || []).slice(0, 10)) {
    if (a.title) {
      const geo = geoTagText(a.title);
      feed.push({
        headline: a.title.substring(0, 100), source: 'GDELT', type: 'gdelt',
        timestamp: new Date().toISOString(), region: geo?.region || 'Global', urgent: false, url: sanitizeExternalUrl(a.url)
      });
    }
  }

  // Telegram urgent
  for (const p of tgUrgent.slice(0, 10)) {
    const text = (p.text || '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
    feed.push({
      headline: text.substring(0, 100), source: p.channel?.toUpperCase() || 'TELEGRAM',
      type: 'telegram', timestamp: p.date, region: 'OSINT', urgent: true
    });
  }

  // Telegram top (non-urgent)
  for (const p of tgTop.slice(0, 5)) {
    const text = (p.text || '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
    feed.push({
      headline: text.substring(0, 100), source: p.channel?.toUpperCase() || 'TELEGRAM',
      type: 'telegram', timestamp: p.date, region: 'OSINT', urgent: false
    });
  }

  // InSight Crime articles
  if (insightCrimeData) {
    for (const a of (insightCrimeData.articles || []).slice(0, 10)) {
      if (a.title) {
        feed.push({
          headline: a.title.substring(0, 100), source: 'INSIGHT CRIME',
          type: 'insightcrime', timestamp: a.date || a.pubDate, region: 'Latin America',
          urgent: false, url: a.link
        });
      }
    }
  }

  // Border Watch articles (registry outlets; title/url are third-party and escaped client-side)
  if (borderNewsData) {
    for (const a of (borderNewsData.articles || []).slice(0, 10)) {
      if (a.title) {
        feed.push({
          headline: String(a.title).substring(0, 100), source: String(a.outlet || 'BORDER WATCH').toUpperCase().substring(0, 40),
          type: 'bordernews', timestamp: a.publishedAt || a.collectedAt, region: 'US-MX Border',
          urgent: false, url: sanitizeExternalUrl(a.url)
        });
      }
    }
  }

  // Filter to last 30 days, sort by timestamp descending, limit to 50
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = feed.filter(item => !item.timestamp || new Date(item.timestamp) >= cutoff);
  recent.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.type}|${item.source}|${item.headline}|${item.timestamp}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  for (const source of REGIONAL_NEWS_SOURCES) {
    recent.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  recent.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === CLI Mode: inject into HTML file ===
function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

async function cliInject() {
  const data = JSON.parse(readFileSync(join(ROOT, 'runs/latest.json'), 'utf8'));
  const htmlOverride = getCliArg('--html');
  const shouldOpen = !process.argv.includes('--no-open');

  console.log('Fetching RSS news feeds...');
  const V2 = await synthesize(data);
  const llmProvider = createLLMProvider(config.llm);

  if (llmProvider?.isConfigured) {
    try {
      console.log(`[LLM] Generating ideas via ${llmProvider.name}...`);
      const llmIdeas = await generateLLMIdeas(llmProvider, V2, null, []);
      if (llmIdeas?.length) {
        V2.ideas = llmIdeas;
        V2.ideasSource = 'llm';
        console.log(`[LLM] Generated ${llmIdeas.length} ideas`);
      } else {
        V2.ideas = [];
        V2.ideasSource = 'llm-failed';
        console.log('[LLM] No ideas returned');
      }
    } catch (err) {
      V2.ideas = [];
      V2.ideasSource = 'llm-failed';
      console.log('[LLM] Idea generation failed:', err.message);
    }
  } else {
    V2.ideas = [];
    V2.ideasSource = 'disabled';
  }
  console.log(`Generated ${V2.ideas.length} leverageable ideas`);

  const json = JSON.stringify(V2);
  console.log('\n--- Synthesis ---');
  console.log('Size:', json.length, 'bytes | Air:', V2.air.length, '| Thermal:', V2.thermal.length,
    '| News:', V2.news.length, '| Ideas:', V2.ideas.length, '| Sources:', V2.health.length);

  const htmlPath = htmlOverride || join(ROOT, 'dashboard/public/jarvis.html');
  let html = readFileSync(htmlPath, 'utf8');
  // Use a replacer function so JSON is inserted literally even if it contains `$`.
  html = html.replace(/^(let|const) D = .*;\s*$/m, () => 'let D = ' + json + ';');
  writeFileSync(htmlPath, html);
  console.log('Data injected into jarvis.html!');

  if (!shouldOpen) return;

  // Auto-open dashboard in default browser
  // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
  // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
  const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
  const dashUrl = htmlPath.replace(/\\/g, '/');
  exec(`${openCmd} "${dashUrl}"`, (err) => {
    if (err) console.log('Could not auto-open browser:', err.message);
    else console.log('Dashboard opened in browser!');
  });
}

// Run CLI if invoked directly
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) {
  await cliInject();
}
