// Polymarket Geopolitical Odds — Prediction market intelligence
// Adapted from OSINT-War-Room backend/api/economy.py GET /api/economy/polymarket (MIT licensed)
// Fetches active markets from Polymarket gamma API, filters to geopolitical only,
// ranks by 24h volume, and flags large probability shifts as signals.

import { safeFetch } from '../utils/fetch.mjs';

const POLYMARKET_API = 'https://gamma-api.polymarket.com/markets';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache = null;
let _cacheTs = 0;

// Geopolitical filter keywords
const GEO_KEYWORDS = [
  'war', 'conflict', 'invasion', 'ceasefire', 'sanctions', 'election',
  'nuclear', 'nato', 'china', 'taiwan', 'russia', 'ukraine', 'iran',
  'military', 'missile', 'trump', 'biden', 'president', 'prime minister',
  'tariff', 'trade war', 'embargo', 'blockade', 'coup', 'regime',
  'north korea', 'syria', 'israel', 'palestine', 'gaza', 'hamas',
  'hezbollah', 'yemen', 'houthi', 'saudi', 'opec', 'oil',
  'diplomat', 'treaty', 'alliance', 'annexation', 'territory',
  'assassination', 'insurgent', 'rebel', 'terrorist',
  'ai regulation', 'semiconductor', 'chip', 'export control',
];

// Sports/entertainment keywords to exclude
const SPORTS_KEYWORDS = [
  'nba', 'nfl', 'nhl', 'mlb', 'ufc', 'mma', 'golf', 'f1', 'formula 1',
  'championship', 'playoff', 'super bowl', 'world cup', 'premier league',
  'la liga', 'serie a', 'bundesliga', 'champions league', 'europa league',
  'fixture', 'game winner', 'mvp', 'draft pick',
  'season wins', 'most kills', 'counter-strike', 'esport',
  'celtics', 'lakers', 'warriors', 'bucks', 'nuggets',
  'yankees', 'dodgers', 'red sox', 'cubs', 'play-in', 'bo3', 'bo5',
  'oscar', 'grammy', 'emmy', 'bachelor', 'reality tv', 'movie',
];

function isSports(question) {
  const q = question.toLowerCase();
  // Only flag "vs" as sports if no geopolitical keywords are present
  if ((/ vs /i.test(q) || / vs\./i.test(q)) && !GEO_KEYWORDS.some(kw => q.includes(kw))) return true;
  return SPORTS_KEYWORDS.some(kw => q.includes(kw));
}

function isGeopolitical(question) {
  const q = question.toLowerCase();
  return GEO_KEYWORDS.some(kw => q.includes(kw));
}

function parseMarket(m) {
  const question = m.question || 'Unknown';
  const volume24hr = parseFloat(m.volume24hr || 0);
  const totalVolume = parseFloat(m.volume || 0);
  const slug = m.slug || '';
  const url = `https://polymarket.com/event/${slug}`;

  let yesProbRaw = 0.5;
  try {
    const prices = typeof m.outcomePrices === 'string'
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices || [0.5, 0.5];
    yesProbRaw = parseFloat(prices[0]);
  } catch { /* default 0.5 */ }

  const yesProb = Math.round(yesProbRaw * 100);
  const changeRaw = m.priceChange24hr;
  const change24h = changeRaw != null ? Math.round(parseFloat(changeRaw) * 100 * 10) / 10 : 0;

  return {
    question,
    yesProb,
    noProb: 100 - yesProb,
    volume24hr,
    totalVolume,
    change24h,
    url,
    slug,
  };
}

function isValidMarket(parsed) {
  // Filter settled or near-settled markets
  if (parsed.yesProb >= 97 || parsed.yesProb <= 3) return false;
  // Filter dead markets
  if (parsed.volume24hr < 500 && parsed.totalVolume < 2000) return false;
  return true;
}

export async function briefing() {
  // Return cache if fresh
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    // Fetch top by 24h volume (grab extra to filter out sports)
    const r1 = await safeFetch(`${POLYMARKET_API}?active=true&limit=80&order=volume24hr&ascending=false`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' },
    });

    // Fetch top by all-time volume for supplementary data
    const r2 = await safeFetch(`${POLYMARKET_API}?active=true&limit=40&order=volume&ascending=false`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' },
    });

    const markets1 = Array.isArray(r1) ? r1 : [];
    const markets2 = Array.isArray(r2) ? r2 : [];

    // If both fetches failed, report as unavailable
    if (!Array.isArray(r1) && !Array.isArray(r2)) {
      if (_cache) return _cache;
      return {
        source: 'Polymarket', timestamp: new Date().toISOString(), status: 'unavailable',
        error: r1?.error || r2?.error || 'API unreachable',
        totalGeoMarkets: 0, markets: [], allMarkets: [], avgGeoRisk: 50, signals: [],
      };
    }

    // Filter to geopolitical, non-sports, valid markets
    const geoMarkets = [];
    const seen = new Set();

    for (const m of markets1) {
      const question = m.question || '';
      if (isSports(question)) continue;
      if (!isGeopolitical(question)) continue;
      try {
        const parsed = parseMarket(m);
        if (!isValidMarket(parsed)) continue;
        if (seen.has(parsed.question)) continue;
        seen.add(parsed.question);
        geoMarkets.push(parsed);
      } catch { continue; }
      if (geoMarkets.length >= 10) break;
    }

    // Add any from r2 that aren't already included
    for (const m of markets2) {
      if (geoMarkets.length >= 15) break;
      const question = m.question || '';
      if (isSports(question) || !isGeopolitical(question)) continue;
      try {
        const parsed = parseMarket(m);
        if (!isValidMarket(parsed) || seen.has(parsed.question)) continue;
        seen.add(parsed.question);
        geoMarkets.push(parsed);
      } catch { continue; }
    }

    // Sort by 24h volume
    geoMarkets.sort((a, b) => b.volume24hr - a.volume24hr);

    // Generate signals for large probability shifts
    const signals = [];
    for (const market of geoMarkets) {
      if (Math.abs(market.change24h) > 5) {
        signals.push({
          type: 'prediction_leading',
          severity: Math.abs(market.change24h) > 15 ? 'critical' : 'high',
          signal: `Polymarket: "${market.question.substring(0, 80)}" shifted ${market.change24h > 0 ? '+' : ''}${market.change24h}% in 24h (now ${market.yesProb}%)`,
          market: market.question,
          change: market.change24h,
          probability: market.yesProb,
        });
      }
    }

    // Compute average geopolitical risk (for DEFCON integration)
    const avgGeoRisk = geoMarkets.length > 0
      ? Math.round(geoMarkets.reduce((sum, m) => sum + m.yesProb, 0) / geoMarkets.length)
      : 50;

    const result = {
      source: 'Polymarket',
      timestamp: new Date().toISOString(),
      status: 'live',
      totalGeoMarkets: geoMarkets.length,
      markets: geoMarkets.slice(0, 10),
      allMarkets: geoMarkets,
      avgGeoRisk,
      signals,
      topVolume: geoMarkets.slice(0, 3),
    };

    _cache = result;
    _cacheTs = Date.now();
    return result;

  } catch (err) {
    console.log(`[Polymarket] Fetch error: ${err.message}`);
    if (_cache) return _cache;
    return {
      source: 'Polymarket',
      timestamp: new Date().toISOString(),
      status: 'unavailable',
      error: err.message,
      totalGeoMarkets: 0,
      markets: [],
      allMarkets: [],
      avgGeoRisk: 50,
      signals: [],
    };
  }
}

// Run standalone
if (process.argv[1]?.endsWith('polymarket.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
