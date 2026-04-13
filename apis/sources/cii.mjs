// Country Instability Index (CII) — Real-time instability scoring for 24 countries
// Computes 0-100 score from Unrest (40%), Security (30%), Information (30%)
// Clean-room implementation based on behavioral specification

import '../utils/env.mjs';

// === 24 Tracked Countries ===
const COUNTRIES = [
  { code: 'US', name: 'United States', lat: 39, lng: -98, keywords: ['united states', 'u.s.', 'america', 'washington', 'pentagon', 'white house', 'congress', 'biden', 'trump'] },
  { code: 'VE', name: 'Venezuela', lat: 7, lng: -66, keywords: ['venezuela', 'caracas', 'maduro'] },
  { code: 'BR', name: 'Brazil', lat: -14, lng: -51, keywords: ['brazil', 'brasilia', 'lula'] },
  { code: 'MX', name: 'Mexico', lat: 23, lng: -102, keywords: ['mexico', 'mexico city', 'amlo', 'sheinbaum'] },
  { code: 'CU', name: 'Cuba', lat: 22, lng: -80, keywords: ['cuba', 'havana'] },
  { code: 'DE', name: 'Germany', lat: 51, lng: 10, keywords: ['germany', 'berlin', 'bundestag', 'scholz'] },
  { code: 'FR', name: 'France', lat: 46, lng: 2, keywords: ['france', 'paris', 'macron', 'elysee'] },
  { code: 'GB', name: 'United Kingdom', lat: 54, lng: -2, keywords: ['united kingdom', 'britain', 'london', 'downing street', 'starmer'] },
  { code: 'PL', name: 'Poland', lat: 52, lng: 20, keywords: ['poland', 'warsaw', 'tusk'] },
  { code: 'RU', name: 'Russia', lat: 56, lng: 38, keywords: ['russia', 'moscow', 'kremlin', 'putin'] },
  { code: 'UA', name: 'Ukraine', lat: 49, lng: 32, keywords: ['ukraine', 'kyiv', 'zelensky', 'zelenskyy'] },
  { code: 'IR', name: 'Iran', lat: 32, lng: 53, keywords: ['iran', 'tehran', 'khamenei', 'irgc'] },
  { code: 'IL', name: 'Israel', lat: 31.5, lng: 35, keywords: ['israel', 'tel aviv', 'jerusalem', 'netanyahu', 'idf', 'gaza', 'hamas', 'hezbollah'] },
  { code: 'SA', name: 'Saudi Arabia', lat: 24, lng: 45, keywords: ['saudi', 'riyadh', 'mbs', 'saudi arabia'] },
  { code: 'AE', name: 'UAE', lat: 24, lng: 54, keywords: ['uae', 'emirates', 'abu dhabi', 'dubai'] },
  { code: 'TR', name: 'Turkey', lat: 39, lng: 35, keywords: ['turkey', 'ankara', 'erdogan', 'turkiye'] },
  { code: 'SY', name: 'Syria', lat: 35, lng: 38, keywords: ['syria', 'damascus', 'assad'] },
  { code: 'YE', name: 'Yemen', lat: 15, lng: 48, keywords: ['yemen', 'sanaa', 'houthi', 'houthis'] },
  { code: 'CN', name: 'China', lat: 35, lng: 105, keywords: ['china', 'beijing', 'xi jinping', 'pla', 'ccp', 'prc'] },
  { code: 'TW', name: 'Taiwan', lat: 23.5, lng: 121, keywords: ['taiwan', 'taipei', 'tsai'] },
  { code: 'KP', name: 'North Korea', lat: 40, lng: 127, keywords: ['north korea', 'pyongyang', 'kim jong'] },
  { code: 'IN', name: 'India', lat: 20, lng: 78, keywords: ['india', 'delhi', 'modi', 'new delhi'] },
  { code: 'PK', name: 'Pakistan', lat: 30, lng: 70, keywords: ['pakistan', 'islamabad', 'karachi'] },
  { code: 'MM', name: 'Myanmar', lat: 20, lng: 96, keywords: ['myanmar', 'burma', 'naypyidaw', 'junta'] },
];

// Conflict zone floors
const CONFLICT_FLOORS = {
  UA: 55, SY: 50, YE: 50, MM: 45, IL: 45,
};

// CII levels
function getLevel(score) {
  if (score >= 81) return { level: 'Critical', color: '#ff3333' };
  if (score >= 66) return { level: 'High', color: '#ff8c00' };
  if (score >= 51) return { level: 'Elevated', color: '#ffd700' };
  if (score >= 31) return { level: 'Normal', color: '#888888' };
  return { level: 'Low', color: '#33cc33' };
}

// News volume dampening threshold
const NEWS_VOLUME_THRESHOLD = 50;

// State for trend tracking
let previousScores = {};
let startupTime = Date.now();
const WARMUP_MS = 15 * 60 * 1000; // 15 minutes

// Compute unrest sub-score from ACLED data
function computeUnrest(countryAcled) {
  const protests = countryAcled.protests || 0;
  const fatalities = countryAcled.fatalities || 0;
  const highSeverity = countryAcled.highSeverity || 0;

  const base = Math.min(50, protests * 8);
  const fatalityBoost = Math.min(30, fatalities * 5);
  const severityBoost = Math.min(20, highSeverity * 10);
  return Math.min(100, base + fatalityBoost + severityBoost);
}

// Compute security sub-score from flight/vessel data
function computeSecurity(countryMilitary) {
  const flights = Math.min(50, (countryMilitary.flights || 0) * 3);
  const vessels = Math.min(30, (countryMilitary.vessels || 0) * 5);
  return Math.min(100, flights + vessels);
}

// Compute information sub-score from news data
function computeInformation(countryNews) {
  const base = Math.min(40, (countryNews.mentions || 0) * 5);
  const velocity = Math.min(40, (countryNews.avgVelocity || 0) * 10);
  const alert = countryNews.hasAlert ? 20 : 0;
  return Math.min(100, base + velocity + alert);
}

// Match headlines to countries using keyword lists
function matchHeadlinesToCountries(headlines) {
  const countryMatches = {};
  for (const c of COUNTRIES) {
    countryMatches[c.code] = { mentions: 0, headlines: [], avgVelocity: 0, hasAlert: false };
  }

  for (const h of headlines) {
    const lower = (h.title || h.headline || '').toLowerCase();
    for (const c of COUNTRIES) {
      for (const kw of c.keywords) {
        if (lower.includes(kw)) {
          countryMatches[c.code].mentions++;
          countryMatches[c.code].headlines.push(h);
          if (h.urgent) countryMatches[c.code].hasAlert = true;
          break; // one match per country per headline
        }
      }
    }
  }

  // Compute velocity (mentions per hour, simplified as mentions / time window)
  for (const code of Object.keys(countryMatches)) {
    const m = countryMatches[code];
    m.avgVelocity = m.mentions > 0 ? Math.min(10, m.mentions / 2) : 0;
  }

  return countryMatches;
}

// Extract ACLED data per country
function extractAcledByCountry(acledData) {
  const byCountry = {};
  for (const c of COUNTRIES) {
    byCountry[c.code] = { protests: 0, fatalities: 0, highSeverity: 0 };
  }

  // Map ACLED country names to our codes
  const nameToCode = {
    'United States': 'US', 'Venezuela': 'VE', 'Brazil': 'BR', 'Mexico': 'MX',
    'Cuba': 'CU', 'Germany': 'DE', 'France': 'FR', 'United Kingdom': 'GB',
    'Poland': 'PL', 'Russia': 'RU', 'Ukraine': 'UA', 'Iran': 'IR',
    'Israel': 'IL', 'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE',
    'Turkey': 'TR', 'Syria': 'SY', 'Yemen': 'YE', 'China': 'CN',
    'Taiwan': 'TW', 'North Korea': 'KP', 'India': 'IN', 'Pakistan': 'PK',
    'Myanmar': 'MM',
  };

  const topCountries = acledData?.topCountries || {};
  for (const [name, stats] of Object.entries(topCountries)) {
    const code = nameToCode[name];
    if (code && byCountry[code]) {
      byCountry[code].protests = stats.count || 0;
      byCountry[code].fatalities = stats.fatalities || 0;
    }
  }

  // Count high severity from deadliest events
  const deadliest = acledData?.deadliestEvents || [];
  for (const e of deadliest) {
    const code = nameToCode[e.country];
    if (code && byCountry[code] && (e.fatalities || 0) > 10) {
      byCountry[code].highSeverity++;
    }
  }

  return byCountry;
}

// Extract military activity per country from ADS-B / OpenSky / Maritime
function extractMilitaryByCountry(adsbData, maritimeData, airHotspots) {
  const byCountry = {};
  for (const c of COUNTRIES) {
    byCountry[c.code] = { flights: 0, vessels: 0 };
  }

  // Map air hotspot regions to country codes
  const regionToCountries = {
    'Middle East': ['IR', 'IL', 'SA', 'AE', 'TR', 'SY', 'YE'],
    'Taiwan Strait': ['CN', 'TW'],
    'Ukraine Region': ['UA', 'RU'],
    'Baltic Region': ['PL', 'RU'],
    'South China Sea': ['CN', 'TW'],
    'Korean Peninsula': ['KP'],
    'Caribbean': ['CU', 'VE', 'MX'],
    'Horn of Africa': ['YE'],
  };

  for (const hotspot of (airHotspots || [])) {
    const codes = regionToCountries[hotspot.region] || [];
    const perCountry = Math.ceil((hotspot.totalAircraft || hotspot.total || 0) / Math.max(1, codes.length));
    for (const code of codes) {
      if (byCountry[code]) {
        byCountry[code].flights += perCountry;
      }
    }
  }

  // Maritime chokepoint vessels
  const chopointToCountries = {
    'Strait of Hormuz': ['IR', 'SA', 'AE'],
    'Bab el-Mandeb': ['YE'],
    'Taiwan Strait': ['CN', 'TW'],
    'South China Sea': ['CN'],
  };

  const chokepoints = maritimeData?.chokepoints || {};
  for (const [name, data] of Object.entries(chokepoints)) {
    const codes = chopointToCountries[name] || [];
    const perCountry = Math.ceil((data.vesselCount || 0) / Math.max(1, codes.length));
    for (const code of codes) {
      if (byCountry[code]) {
        byCountry[code].vessels += perCountry;
      }
    }
  }

  return byCountry;
}

// Main CII computation
export function computeCII(sourceData, focalPoints) {
  const acledData = sourceData.ACLED || {};
  const adsbData = sourceData['ADS-B'] || {};
  const maritimeData = sourceData.Maritime || {};
  const gdeltData = sourceData.GDELT || {};
  const openSkyData = sourceData.OpenSky || {};

  // Gather all headlines from available sources
  const allHeadlines = [];

  // GDELT articles
  for (const a of (gdeltData.allArticles || gdeltData.articles || [])) {
    allHeadlines.push({ title: a.title || '', urgent: false, source: 'GDELT' });
  }

  // ACLED events as headline proxies
  for (const e of (acledData.deadliestEvents || [])) {
    allHeadlines.push({
      title: `${e.type || 'Event'} in ${e.country || 'Unknown'}: ${e.location || ''}`,
      urgent: (e.fatalities || 0) > 50,
      source: 'ACLED',
    });
  }

  // Build sub-components
  const newsMatches = matchHeadlinesToCountries(allHeadlines);
  const acledByCountry = extractAcledByCountry(acledData);
  const airHotspots = openSkyData.hotspots || [];
  const militaryByCountry = extractMilitaryByCountry(adsbData, maritimeData, airHotspots);

  const results = [];

  for (const country of COUNTRIES) {
    const code = country.code;

    // Raw sub-scores
    let unrest = computeUnrest(acledByCountry[code] || {});
    let security = computeSecurity(militaryByCountry[code] || {});
    let info = computeInformation(newsMatches[code] || {});

    // Bias correction: log dampening for high-volume countries
    const newsVolume = newsMatches[code]?.mentions || 0;
    if (newsVolume > NEWS_VOLUME_THRESHOLD) {
      const dampingFactor = 1 / (1 + Math.log10(newsVolume / NEWS_VOLUME_THRESHOLD));
      unrest = Math.round(unrest * dampingFactor);
      info = Math.round(info * dampingFactor);
    }

    // Weighted CII score
    let cii = Math.round(unrest * 0.4 + security * 0.3 + info * 0.3);

    // Contextual boosts (max +23)
    let boosts = { hotspot: 0, newsUrgency: 0, focalPoint: 0, total: 0 };

    // Hotspot activity boost (max +10)
    const hotspotActivity = (militaryByCountry[code]?.flights || 0) + (militaryByCountry[code]?.vessels || 0);
    if (hotspotActivity > 10) boosts.hotspot = 10;
    else if (hotspotActivity > 5) boosts.hotspot = 5;

    // News urgency boost
    const urgencyScore = newsMatches[code]?.avgVelocity || 0;
    if (urgencyScore >= 7) boosts.newsUrgency = 5;
    else if (urgencyScore >= 5) boosts.newsUrgency = 3;

    // Focal point boost (from Feature 4 cross-reference)
    if (focalPoints) {
      const fp = focalPoints.find(f => f.countryCode === code);
      if (fp) {
        if (fp.urgency === 'Critical') boosts.focalPoint = 8;
        else if (fp.urgency === 'Elevated') boosts.focalPoint = 4;
      }
    }

    boosts.total = Math.min(23, boosts.hotspot + boosts.newsUrgency + boosts.focalPoint);
    cii = Math.min(100, cii + boosts.total);

    // Apply conflict zone floors
    const floor = CONFLICT_FLOORS[code];
    if (floor && cii < floor) cii = floor;

    // Trend computation
    const prevScore = previousScores[code] || cii;
    let trend = 'Stable';
    if (cii - prevScore >= 5) trend = 'Rising';
    else if (prevScore - cii >= 5) trend = 'Falling';

    const levelInfo = getLevel(cii);

    results.push({
      code: country.code,
      name: country.name,
      lat: country.lat,
      lng: country.lng,
      score: cii,
      level: levelInfo.level,
      color: levelInfo.color,
      trend,
      trendDelta: cii - prevScore,
      components: {
        unrest: Math.round(unrest),
        security: Math.round(security),
        information: Math.round(info),
      },
      boosts,
      newsVolume,
      topHeadlines: (newsMatches[code]?.headlines || []).slice(0, 5).map(h => h.title),
    });
  }

  // Update previous scores for next cycle
  for (const r of results) {
    previousScores[r.code] = r.score;
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Learning mode state
  const isWarmingUp = (Date.now() - startupTime) < WARMUP_MS;
  const warmupProgress = isWarmingUp
    ? Math.min(100, Math.round((Date.now() - startupTime) / WARMUP_MS * 100))
    : 100;

  return {
    source: 'CII',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalCountries: results.length,
    countries: results,
    warmingUp: isWarmingUp,
    warmupProgress,
    levelBreakdown: {
      critical: results.filter(r => r.level === 'Critical').length,
      high: results.filter(r => r.level === 'High').length,
      elevated: results.filter(r => r.level === 'Elevated').length,
      normal: results.filter(r => r.level === 'Normal').length,
      low: results.filter(r => r.level === 'Low').length,
    },
    signals: results
      .filter(r => r.level === 'Critical' || r.level === 'High')
      .map(r => `${r.name} (${r.code}): ${r.level} — CII ${r.score}, trend ${r.trend}`),
  };
}

// Reset startup time (called when CII module is first loaded)
export function resetWarmup() {
  startupTime = Date.now();
}

// Briefing function for orchestrator integration
export async function briefing() {
  // CII needs cross-source data, so it returns a stub here.
  // The actual computation happens post-sweep in the synthesizer.
  return {
    source: 'CII',
    timestamp: new Date().toISOString(),
    status: 'deferred',
    message: 'CII scores computed post-sweep from aggregated source data',
  };
}

if (process.argv[1]?.endsWith('cii.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
