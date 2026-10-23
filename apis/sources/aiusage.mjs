// AI usage by region — a composite, labelled as such:
//   index: Anthropic Economic Index per-country / per-US-state usage (config/geo/ai-usage-index.json,
//          rebuilt by scripts/build-map-geo.mjs when a new release drops). Static.
//   live:  Cloudflare Radar domain rankings — where chatgpt.com / claude.ai rank in each country's
//          top domains today, and the top generative-AI services per country. Needs CLOUDFLARE_API_TOKEN
//          (any valid Cloudflare token can read Radar). Daily data, cached 6 h.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { safeFetch } from '../utils/fetch.mjs';

export const RADAR_BASE = 'https://api.cloudflare.com/client/v4/radar';
export const AI_DOMAINS = ['chatgpt.com', 'claude.ai'];
export const LIVE_COUNTRIES_MAX = 60;
const CONCURRENCY = 6;

const file = join(dirname(fileURLToPath(import.meta.url)), '../../config/geo/ai-usage-index.json');
let INDEX = null;
export function loadIndex() { return INDEX ||= JSON.parse(readFileSync(file, 'utf8')); }

// Countries to query live: the biggest by index and by share of global usage.
export function liveCountries(index = loadIndex(), max = LIVE_COUNTRIES_MAX) {
  const byIndex = [...index.countries].sort((a, b) => b.index - a.index).slice(0, max);
  const byShare = [...index.countries].sort((a, b) => (b.sharePct || 0) - (a.sharePct || 0)).slice(0, max);
  const seen = new Set(); const out = [];
  for (const c of [...byShare, ...byIndex]) if (c.a2 && !seen.has(c.a2) && out.length < max) { seen.add(c.a2); out.push(c.a2); }
  return out;
}

// Radar responses → per-country live record.
export function normalizeRadarCountry(a2, domainResults = {}, servicesResult = null) {
  const ranks = {};
  for (const [dom, r] of Object.entries(domainResults)) {
    const d = r?.result?.details_0;
    if (!d) continue;
    const rank = Number.isInteger(+d.rank) && +d.rank > 0 ? +d.rank : null;
    const bucket = +String(d.bucket ?? '').replace(/\D/g, '') || null; // ranks past 200 arrive only as a bucket ("500", "1000")
    ranks[dom] = rank ?? bucket;
  }
  const best = Object.values(ranks).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const services = (servicesResult?.result?.top_0 || []).map(s => s.service).filter(Boolean).slice(0, 5);
  return { a2, ranks, bestRank: best, services };
}

// Lower domain rank = AI sites are a larger share of that country's web traffic. 1..100 → hot.
export function liveScore(bestRank) {
  if (!Number.isFinite(bestRank)) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - 100 * Math.log10(bestRank) / 3))); // rank 1 → 100, 1000 → 0
}

export async function fetchRadarLive({ token = process.env.CLOUDFLARE_API_TOKEN, fetchImpl = safeFetch, countries = liveCountries(), date } = {}) {
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  const dateQ = date ? `&date=${date}` : '';
  const out = {}; const notes = []; let failures = 0;
  const queue = [...countries];
  const worker = async () => {
    while (queue.length) {
      const a2 = queue.shift();
      const domainResults = {};
      for (const dom of AI_DOMAINS) {
        const r = await fetchImpl(`${RADAR_BASE}/ranking/domain/${dom}?location=${a2}${dateQ}`, { timeout: 15000, retries: 0, headers });
        if (r?.error) { failures++; continue; }
        domainResults[dom] = r;
      }
      const svc = await fetchImpl(`${RADAR_BASE}/ranking/internet_services/top?serviceCategory=Generative%20AI&location=${a2}&limit=5${dateQ}`, { timeout: 15000, retries: 0, headers });
      out[a2] = normalizeRadarCountry(a2, domainResults, svc?.error ? null : svc);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, countries.length) }, worker));
  if (failures) notes.push(`Cloudflare Radar: ${failures} of ${countries.length * AI_DOMAINS.length} ranking lookups failed`);
  if (Object.values(out).every(c => c.bestRank === null && !c.services.length)) throw new Error('Cloudflare Radar returned no rankings (token rejected?)');
  return { countries: out, notes, fetchedAt: new Date().toISOString() };
}

const TIER_COLORS = { 'Leading (top 25%)': 'rgba(0,229,255,0.55)', 'Upper middle (50-75%)': 'rgba(0,176,255,0.45)', 'Lower middle (25-50%)': 'rgba(41,98,255,0.35)', 'Emerging (bottom 25%)': 'rgba(98,0,234,0.3)', Minimal: 'rgba(120,120,120,0.15)' };
export const tierColor = (tier) => TIER_COLORS[tier] || 'rgba(120,120,120,0.12)';

// Index + live → the per-country / per-state records the layer joins with the country polygons client-side.
export function aiUsagePayload(index = loadIndex(), live = null) {
  const countries = index.countries.map((c, i) => {
    const l = live?.countries?.[c.a2];
    return { a2: c.a2, a3: c.a3, name: c.name, index: c.index, rank: i + 1, tier: c.tier, sharePct: c.sharePct ?? c.sharePct2025 ?? null, count: c.count ?? null, useCases: c.useCases || [], fill: tierColor(c.tier),
      live: l ? { bestRank: l.bestRank, ranks: l.ranks, services: l.services, score: liveScore(l.bestRank) } : null };
  });
  const states = index.states.map((s, i) => ({ ...s, rank: i + 1 }));
  return { countries, states, source: index.source, url: index.url, indexWindow: index.indexWindow, shareWindow: index.shareWindow };
}
