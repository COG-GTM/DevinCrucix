// Polymarket China/Taiwan threat markets — explicit slug allow-list (no keyword search, so a
// "Taiwan" tag on an unrelated market can never leak in). Values are market-implied
// probabilities: what traders are paying, not a forecast and not an assessment.

import { safeFetch } from '../utils/fetch.mjs';
import { parseMarket } from './polymarket.mjs';

export const SOURCE = 'TaiwanMarkets';
export const PROVIDER = 'Polymarket';
const API = 'https://gamma-api.polymarket.com/markets';
const CACHE_TTL_MS = 5 * 60 * 1000;
export const STALE_AFTER_H = 6;

export const MARKETS = [
  { slug: 'will-china-invade-taiwan-by-september-30-2026', kind: 'invasion', horizon: '2026-09-30' },
  { slug: 'will-china-invade-taiwan-before-2027', kind: 'invasion', horizon: '2026-12-31' },
  { slug: 'will-china-invade-taiwan-by-june-30-2027', kind: 'invasion', horizon: '2027-06-30' },
  { slug: 'will-china-invade-taiwan-by-december-31-2027', kind: 'invasion', horizon: '2027-12-31' },
  { slug: 'china-x-taiwan-military-clash-before-2027', kind: 'clash', horizon: '2026-12-31' },
  { slug: 'will-china-blockade-taiwan-by-in-2026', kind: 'blockade', horizon: '2026-12-31' },
];

export const DISCLAIMER = [
  'Market-implied probability = current YES price on Polymarket. It reflects trader positioning and liquidity, not an intelligence assessment.',
  'Markets are selected by an explicit slug list; resolution criteria are defined by Polymarket and linked per market.',
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };

export function toRecord(raw, def) {
  const p = parseMarket(raw);
  const prob = Number.isFinite(p.yesProb) ? p.yesProb : null;
  const yesRaw = (() => { try { const a = typeof raw.outcomePrices === 'string' ? JSON.parse(raw.outcomePrices) : raw.outcomePrices; return Number(a?.[0]); } catch { return NaN; } })();
  return {
    slug: def.slug,
    kind: def.kind,
    horizon: def.horizon,
    question: String(raw.question || def.slug).slice(0, 160),
    impliedProbability: Number.isFinite(yesRaw) ? +(yesRaw * 100).toFixed(1) : prob,
    change24h: p.change24h,
    volume24hr: Math.round(p.volume24hr || 0),
    totalVolume: Math.round(p.totalVolume || 0),
    liquidity: Number.isFinite(Number(raw.liquidity)) ? Math.round(Number(raw.liquidity)) : null,
    endDate: raw.endDate || null,
    active: raw.active !== false && raw.closed !== true,
    closed: raw.closed === true,
    url: `https://polymarket.com/event/${encodeURIComponent(def.slug)}`,
  };
}

export function buildResult(rows, fetchedAt = new Date().toISOString()) {
  const found = rows.filter(r => r && r.record).map(r => r.record);
  const missing = rows.filter(r => !r || !r.record).map(r => ({ slug: r?.slug, error: r?.error || 'not found' }));
  const invasion = found.filter(m => m.kind === 'invasion' && m.active).sort((a, b) => a.horizon.localeCompare(b.horizon));
  const problems = missing.map(m => `${m.slug}: ${m.error}`);
  let status;
  if (!found.length) status = 'unavailable';
  else if (missing.length) status = 'limited';
  else status = 'live';
  return {
    source: SOURCE,
    timestamp: fetchedAt,
    fetchedAt,
    status,
    error: status === 'unavailable' ? (problems[0] || 'no markets returned') : null,
    provider: PROVIDER,
    markets: found,
    missing,
    summary: {
      invasionCurve: invasion.map(m => ({ horizon: m.horizon, impliedProbability: m.impliedProbability })),
      blockade: found.find(m => m.kind === 'blockade' && m.active)?.impliedProbability ?? null,
      clash: found.find(m => m.kind === 'clash' && m.active)?.impliedProbability ?? null,
      biggestMove: found.slice().sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))[0] || null,
    },
    problems,
    disclaimer: DISCLAIMER,
  };
}

let _cache = null;
let _cacheTs = 0;

async function fetchOne(def) {
  try {
    const r = await safeFetch(`${API}?slug=${encodeURIComponent(def.slug)}`, { timeout: 10000, headers: HEADERS });
    if (r?.error) throw new Error(r.error);
    const raw = Array.isArray(r) ? r[0] : null;
    if (!raw || typeof raw !== 'object') throw new Error('market not found');
    return { slug: def.slug, record: toRecord(raw, def) };
  } catch (err) {
    return { slug: def.slug, error: err.message };
  }
}

export async function fetchTaiwanMarkets() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const rows = await Promise.all(MARKETS.map(fetchOne));
  const result = buildResult(rows);
  if (result.status === 'unavailable') {
    console.log(`[TaiwanMarkets] ${result.error}`);
    if (_cache) {
      const ageH = (now - _cacheTs) / 3600000;
      return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
    }
    return result;
  }
  _cache = result;
  _cacheTs = now;
  return result;
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }

export async function briefing() {
  return fetchTaiwanMarkets();
}

export default briefing;
