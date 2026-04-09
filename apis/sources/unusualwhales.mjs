// Unusual Whales — Options Flow, Congressional Trades, Dark Pool
// Provides market intelligence: unusual options activity, congressional trading,
// and large dark pool prints for cross-referencing with geopolitical events.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.unusualwhales.com/api';

// Defense/energy/maritime/aerospace sectors and tickers for alert filtering
const DEFENSE_ENERGY_AERO_SECTORS = [
  'Industrials', 'Energy', 'Utilities', 'Aerospace', 'Defense',
];
const DEFENSE_TICKERS = new Set([
  'LMT', 'RTX', 'NOC', 'GD', 'BA', 'HII', 'LHX', 'LDOS', 'BAH', 'KTOS',
  'TXT', 'HEI', 'TDG', 'AXON', 'PLTR', 'BWXT', 'MRCY', 'AVAV', 'RKLB',
]);
const ENERGY_TICKERS = new Set([
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC', 'VLO', 'PSX', 'HES',
  'DVN', 'HAL', 'FANG', 'BKR', 'OKE', 'WMB', 'KMI', 'ET', 'LNG', 'TRGP',
]);
const MARITIME_TICKERS = new Set([
  'ZIM', 'MATX', 'KEX', 'SBLK', 'GOGL', 'GNK', 'EGLE', 'SB', 'STNG',
  'INSW', 'TNK', 'FRO', 'DHT', 'KNOP', 'TGP', 'FLNG',
]);
const AERO_TICKERS = new Set([
  'BA', 'LMT', 'RTX', 'NOC', 'GD', 'TDG', 'HEI', 'SPR', 'ERJ', 'RKLB',
  'ASTS', 'RDW', 'ASTR', 'LUNR', 'MNTS',
]);

function isDefenseEnergyMaritime(ticker, sector) {
  if (!ticker) return false;
  const t = ticker.toUpperCase();
  if (DEFENSE_TICKERS.has(t) || ENERGY_TICKERS.has(t) || MARITIME_TICKERS.has(t) || AERO_TICKERS.has(t)) return true;
  if (sector && DEFENSE_ENERGY_AERO_SECTORS.some(s => sector.toLowerCase().includes(s.toLowerCase()))) return true;
  return false;
}

// Known defense committee members (House Armed Services, Senate Armed Services, etc.)
const DEFENSE_COMMITTEE_MEMBERS = new Set([
  'Adam Smith', 'Mike Rogers', 'Jack Reed', 'Roger Wicker',
  'Jim Inhofe', 'Joe Courtney', 'Rob Wittman', 'Elaine Luria',
  'Mike Gallagher', 'Seth Moulton', 'Jared Golden', 'Mikie Sherrill',
  'Kai Kahele', 'Pat Fallon', 'Stephanie Bice', 'Mark Kelly',
  'Tim Kaine', 'Jeanne Shaheen', 'Kirsten Gillibrand', 'Richard Blumenthal',
  'Tammy Duckworth', 'Jacky Rosen', 'Gary Peters', 'Dan Sullivan',
  'Tom Cotton', 'Joni Ernst', 'Kevin Cramer', 'Mike Rounds',
  'Marsha Blackburn', 'Tommy Tuberville', 'Eric Schmitt', 'Ted Budd',
  'Markwayne Mullin', 'Rick Scott', 'Ruben Gallego', 'Elissa Slotkin',
  'Gilbert Cisneros',
]);

// Company HQ coordinates for globe markers
const COMPANY_HQ = {
  // Defense
  LMT: { lat: 38.88, lon: -77.22, name: 'Lockheed Martin', city: 'Bethesda, MD' },
  RTX: { lat: 41.18, lon: -73.19, name: 'RTX Corp', city: 'Arlington, VA' },
  NOC: { lat: 38.88, lon: -77.10, name: 'Northrop Grumman', city: 'Falls Church, VA' },
  GD: { lat: 38.88, lon: -77.06, name: 'General Dynamics', city: 'Reston, VA' },
  BA: { lat: 38.88, lon: -77.02, name: 'Boeing', city: 'Arlington, VA' },
  HII: { lat: 36.98, lon: -76.43, name: 'Huntington Ingalls', city: 'Newport News, VA' },
  LHX: { lat: 32.84, lon: -83.63, name: 'L3Harris', city: 'Melbourne, FL' },
  PLTR: { lat: 37.79, lon: -122.40, name: 'Palantir', city: 'Denver, CO' },
  // Energy
  XOM: { lat: 32.41, lon: -94.85, name: 'ExxonMobil', city: 'Spring, TX' },
  CVX: { lat: 37.76, lon: -122.23, name: 'Chevron', city: 'San Ramon, CA' },
  COP: { lat: 29.76, lon: -95.37, name: 'ConocoPhillips', city: 'Houston, TX' },
  OXY: { lat: 29.76, lon: -95.36, name: 'Occidental Petroleum', city: 'Houston, TX' },
  SLB: { lat: 29.76, lon: -95.38, name: 'Schlumberger', city: 'Houston, TX' },
  HAL: { lat: 29.76, lon: -95.39, name: 'Halliburton', city: 'Houston, TX' },
  LNG: { lat: 29.76, lon: -95.40, name: 'Cheniere Energy', city: 'Houston, TX' },
  // Maritime
  ZIM: { lat: 32.79, lon: 34.99, name: 'ZIM Shipping', city: 'Haifa, Israel' },
  MATX: { lat: 21.31, lon: -157.86, name: 'Matson', city: 'Honolulu, HI' },
  // Tech giants
  AAPL: { lat: 37.33, lon: -122.01, name: 'Apple', city: 'Cupertino, CA' },
  MSFT: { lat: 47.64, lon: -122.13, name: 'Microsoft', city: 'Redmond, WA' },
  GOOGL: { lat: 37.42, lon: -122.08, name: 'Alphabet', city: 'Mountain View, CA' },
  AMZN: { lat: 47.62, lon: -122.34, name: 'Amazon', city: 'Seattle, WA' },
  NVDA: { lat: 37.37, lon: -121.96, name: 'NVIDIA', city: 'Santa Clara, CA' },
  META: { lat: 37.48, lon: -122.15, name: 'Meta', city: 'Menlo Park, CA' },
  TSLA: { lat: 30.22, lon: -97.62, name: 'Tesla', city: 'Austin, TX' },
  // Finance
  JPM: { lat: 40.76, lon: -73.97, name: 'JPMorgan Chase', city: 'New York, NY' },
  GS: { lat: 40.71, lon: -74.01, name: 'Goldman Sachs', city: 'New York, NY' },
  MS: { lat: 40.76, lon: -73.98, name: 'Morgan Stanley', city: 'New York, NY' },
  // Pharma
  JNJ: { lat: 40.49, lon: -74.45, name: 'Johnson & Johnson', city: 'New Brunswick, NJ' },
  PFE: { lat: 40.75, lon: -73.97, name: 'Pfizer', city: 'New York, NY' },
  // Default US center
  _DEFAULT: { lat: 39.83, lon: -98.58, name: 'US Market', city: 'United States' },
};

function getHQ(ticker) {
  return COMPANY_HQ[ticker?.toUpperCase()] || COMPANY_HQ._DEFAULT;
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  // Parse "$15,001 - $50,000" style ranges — use midpoint
  const matches = amountStr.match(/\$([\d,]+)/g);
  if (!matches || matches.length === 0) return 0;
  const nums = matches.map(m => parseFloat(m.replace(/[$,]/g, '')));
  if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
  return nums[0] || 0;
}

function parsePremium(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

async function fetchOptionsFlow(apiKey) {
  const data = await safeFetch(`${BASE}/option-trades/flow-alerts`, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (data?.error || data?.rawText) return [];
  return (data?.data || []).map(d => ({
    ticker: d.ticker,
    type: d.type,             // 'call' or 'put'
    strike: d.strike,
    expiry: d.expiry,
    premium: parsePremium(d.total_premium),
    size: d.total_size || 0,
    volume: d.volume || 0,
    openInterest: d.open_interest || 0,
    sector: d.sector || '',
    alertRule: d.alert_rule || '',
    hasSweep: d.has_sweep || false,
    hasFloor: d.has_floor || false,
    underlyingPrice: parseFloat(d.underlying_price) || 0,
    iv: parseFloat(d.iv_end) || 0,
    createdAt: d.created_at,
    optionChain: d.option_chain,
    marketCap: parseInt(d.marketcap) || 0,
  }));
}

async function fetchCongressTrades(apiKey) {
  const data = await safeFetch(`${BASE}/congress/recent-trades?limit=100`, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (data?.error || data?.rawText) return [];
  return (data?.data || []).map(d => ({
    name: d.name,
    ticker: d.ticker,
    txnType: d.txn_type,       // 'Buy', 'Sell'
    amounts: d.amounts,
    amountMid: parseAmount(d.amounts),
    transactionDate: d.transaction_date,
    filedDate: d.filed_at_date,
    memberType: d.member_type, // 'house' or 'senate'
    isActive: d.is_active,
    issuer: d.issuer,
    notes: d.notes,
    politicianId: d.politician_id,
    isDefenseCommittee: DEFENSE_COMMITTEE_MEMBERS.has(d.name),
    isDefenseEnergySector: isDefenseEnergyMaritime(d.ticker, ''),
  }));
}

async function fetchDarkPool(apiKey) {
  const data = await safeFetch(`${BASE}/darkpool/recent`, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (data?.error || data?.rawText) return [];
  return (data?.data || []).map(d => ({
    ticker: d.ticker,
    size: d.size || 0,
    price: parseFloat(d.price) || 0,
    premium: parsePremium(d.premium),
    executedAt: d.executed_at,
    marketCenter: d.market_center,
    nbboBid: parseFloat(d.nbbo_bid) || 0,
    nbboAsk: parseFloat(d.nbbo_ask) || 0,
    canceled: d.canceled || false,
  }));
}

export async function briefing() {
  const apiKey = process.env.UNUSUAL_WHALES_API_KEY;
  if (!apiKey) {
    return {
      source: 'Unusual Whales',
      timestamp: new Date().toISOString(),
      status: 'no_key',
      message: 'Set UNUSUAL_WHALES_API_KEY in .env',
    };
  }

  const [optionsFlow, congressTrades, darkPool] = await Promise.all([
    fetchOptionsFlow(apiKey),
    fetchCongressTrades(apiKey),
    fetchDarkPool(apiKey),
  ]);

  // Sort options flow by premium descending
  const sortedFlow = optionsFlow
    .filter(o => o.premium > 0)
    .sort((a, b) => b.premium - a.premium);

  // Top 10 by premium
  const topFlow = sortedFlow.slice(0, 20);

  // Options flow over $5M in defense/energy/maritime → PRIORITY
  const bigDefenseFlow = sortedFlow.filter(
    o => o.premium >= 5_000_000 && isDefenseEnergyMaritime(o.ticker, o.sector)
  );

  // All large flow ($5M+)
  const largeFlow = sortedFlow.filter(o => o.premium >= 5_000_000);

  // Congressional trades filtered to defense/energy/aerospace
  const defenseCongressTrades = congressTrades.filter(t => t.isDefenseEnergySector);

  // Defense committee member trades (for FLASH cross-ref)
  const defenseCommitteeTrades = congressTrades.filter(t => t.isDefenseCommittee);

  // Dark pool prints over $5M
  const largeDarkPool = darkPool
    .filter(d => !d.canceled && d.premium >= 5_000_000)
    .sort((a, b) => b.premium - a.premium)
    .slice(0, 20);

  // All dark pool sorted by premium
  const topDarkPool = darkPool
    .filter(d => !d.canceled && d.premium > 0)
    .sort((a, b) => b.premium - a.premium)
    .slice(0, 30);

  // Build priority alerts
  const priorityAlerts = [];

  // PRIORITY: options flow >$5M in defense/energy/maritime
  for (const o of bigDefenseFlow.slice(0, 5)) {
    priorityAlerts.push({
      tier: 'PRIORITY',
      headline: `UNUSUAL OPTIONS: $${(o.premium / 1e6).toFixed(1)}M ${o.type.toUpperCase()} flow on ${o.ticker}`,
      detail: `${o.ticker} ${o.strike} ${o.type} exp ${o.expiry} — ${o.sector} sector, ${o.hasSweep ? 'SWEEP' : 'block'}`,
      ticker: o.ticker,
    });
  }

  // Signals
  const signals = [];
  if (sortedFlow.length > 0) {
    const totalPremium = sortedFlow.reduce((s, o) => s + o.premium, 0);
    signals.push(`OPTIONS FLOW: ${sortedFlow.length} alerts, $${(totalPremium / 1e6).toFixed(1)}M total premium`);
  }
  if (largeFlow.length > 0) {
    signals.push(`LARGE FLOW: ${largeFlow.length} trades over $5M`);
  }
  if (defenseCommitteeTrades.length > 0) {
    signals.push(`DEFENSE COMMITTEE: ${defenseCommitteeTrades.length} trades by armed services members`);
  }
  if (largeDarkPool.length > 0) {
    signals.push(`DARK POOL: ${largeDarkPool.length} prints over $5M`);
  }

  // Globe markers data
  const globeMarkers = [];
  // Add markers for top options flow
  for (const o of topFlow.slice(0, 10)) {
    const hq = getHQ(o.ticker);
    globeMarkers.push({
      lat: hq.lat + (Math.random() - 0.5) * 0.5,
      lon: hq.lon + (Math.random() - 0.5) * 0.5,
      ticker: o.ticker,
      type: 'options',
      premium: o.premium,
      label: `${o.ticker} $${(o.premium / 1e3).toFixed(0)}K ${o.type}`,
      company: hq.name,
      city: hq.city,
    });
  }
  // Add markers for large dark pool
  for (const d of largeDarkPool.slice(0, 5)) {
    const hq = getHQ(d.ticker);
    globeMarkers.push({
      lat: hq.lat + (Math.random() - 0.5) * 0.5,
      lon: hq.lon + (Math.random() - 0.5) * 0.5,
      ticker: d.ticker,
      type: 'darkpool',
      premium: d.premium,
      label: `${d.ticker} $${(d.premium / 1e6).toFixed(1)}M DP`,
      company: hq.name,
      city: hq.city,
    });
  }

  return {
    source: 'Unusual Whales',
    timestamp: new Date().toISOString(),
    status: 'live',
    optionsFlow: {
      total: sortedFlow.length,
      topAlerts: topFlow.slice(0, 15),
      largeFlow: largeFlow.slice(0, 10),
      bigDefenseFlow: bigDefenseFlow.slice(0, 5),
      totalPremium: sortedFlow.reduce((s, o) => s + o.premium, 0),
      sweepCount: sortedFlow.filter(o => o.hasSweep).length,
    },
    congressTrades: {
      total: congressTrades.length,
      recent: congressTrades.slice(0, 20),
      defenseSector: defenseCongressTrades.slice(0, 10),
      defenseCommittee: defenseCommitteeTrades.slice(0, 10),
    },
    darkPool: {
      total: darkPool.filter(d => !d.canceled).length,
      largePrints: largeDarkPool,
      topPrints: topDarkPool.slice(0, 15),
      totalVolume: topDarkPool.reduce((s, d) => s + d.premium, 0),
    },
    globeMarkers,
    signals,
    priorityAlerts,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('unusualwhales.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
