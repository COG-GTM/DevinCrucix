// Live, keyed / keyless lookups: OpenSanctions (sanctions + PEP), OpenCorporates (registry aggregate),
// GLEIF (LEI). Each returns { status, hits|results, ... } and degrades to `no_key` / `error` without throwing.
// Nothing here is bulk-stored; OpenCorporates responses are cached for 15 minutes only.
import { searchEntities } from '../../../apis/sources/opensanctions.mjs';
import { opensanctionsRecord, opencorporatesRecord, gleifRecord } from '../ftm.mjs';
import { scoreCandidate, matchBand } from '../match.mjs';

const CACHE_MS = 15 * 60_000;
const cache = new Map();
function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < CACHE_MS) return c.p;
  const p = fn().catch(err => { cache.delete(key); throw err; });
  cache.set(key, { t: Date.now(), p });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.t > CACHE_MS) cache.delete(k);
  return p;
}
async function getJson(url, { timeout = 12_000, headers = {} } = {}) {
  const controller = new AbortController(); const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Crucix/1.0', accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function opensanctionsScreen(name, { schema = null, countries = [], limit = 8 } = {}) {
  if (!process.env.OPENSANCTIONS_API_KEY) return { status: 'no_key', hint: 'Set OPENSANCTIONS_API_KEY (free for non-commercial use at opensanctions.org/api)', hits: [] };
  try {
    const subject = { name, schema, countries };
    const osSchema = schema === 'Person' ? 'Person' : schema === 'Company' ? 'Company' : 'LegalEntity';
    const r = await cached(`os:match:${osSchema}:${name}:${limit}`, () => searchEntities(name, { schema: osSchema, limit: limit * 2 }));
    if (!r || r.error) throw new Error(r?.error || 'empty response');
    const hits = (r.results || []).map(e => {
      const rec = opensanctionsRecord(e);
      const own = scoreCandidate(subject, { name: rec.caption, countries: rec.properties.country, schema: rec.schema });
      const score = typeof e.score === 'number' ? Math.round(e.score * 100) / 100 : own.score;
      return { score, band: matchBand(score), matched: [...own.matched, 'opensanctions:match'], record: rec };
    }).filter(h => h.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, limit);
    return { status: 'ok', total: hits.length, hits };
  } catch (err) { return { status: 'error', error: err.message, hits: [] }; }
}

export async function opensanctionsSearch(q, { limit = 8 } = {}) {
  if (!process.env.OPENSANCTIONS_API_KEY) return { status: 'no_key', results: [] };
  try {
    const r = await cached(`os:search:${q}:${limit}`, () => searchEntities(q, { limit }));
    if (!r || r.error) throw new Error(r?.error || 'empty response');
    return { status: 'ok', total: r?.totalResults || 0, results: (r?.results || r?.entities || []).slice(0, limit).map(opensanctionsRecord) };
  } catch (err) { return { status: 'error', error: err.message, results: [] }; }
}

export async function opencorporatesSearch(name, { jurisdiction = null, limit = 10 } = {}) {
  const token = process.env.OPENCORPORATES_API_TOKEN;
  if (!token) return { status: 'no_key', hint: 'Set OPENCORPORATES_API_TOKEN (free for non-commercial use at opencorporates.com/api_accounts/new)', results: [] };
  const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&per_page=${limit}${jurisdiction ? `&jurisdiction_code=${encodeURIComponent(jurisdiction)}` : ''}&api_token=${encodeURIComponent(token)}`;
  try {
    const j = await cached(`oc:${jurisdiction || ''}:${limit}:${name}`, () => getJson(url));
    const results = (j?.results?.companies || []).map(c => opencorporatesRecord(c.company)).map(rec => ({ ...scoreCandidate({ name, schema: 'Company' }, { name: rec.caption, countries: rec.properties.country, schema: 'Company' }), record: rec })).map(h => ({ ...h, band: matchBand(h.score) }));
    return { status: 'ok', total: j?.results?.total_count || results.length, results: results.filter(r => r.score >= 0.5).sort((a, b) => b.score - a.score) };
  } catch (err) { return { status: 'error', error: err.message, results: [] }; }
}

export async function gleifSearch(name, { limit = 10 } = {}) {
  const url = `https://api.gleif.org/api/v1/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(name)}&page%5Bsize%5D=${limit}`;
  try {
    const j = await cached(`lei:${name}`, () => getJson(url, { headers: { accept: 'application/vnd.api+json' } }));
    const results = (j?.data || []).map(gleifRecord).map(rec => {
      const names = [rec.caption, ...(rec.properties.alias || [])];
      let best = { score: 0, matched: [] };
      for (const n of names) { const s = scoreCandidate({ name, schema: 'Company' }, { name: n, countries: rec.properties.country, schema: 'Company' }); if (s.score > best.score) best = { ...s, ...(n !== rec.caption ? { via: `alias:${n}` } : {}) }; }
      return { ...best, band: matchBand(best.score), record: rec };
    }).filter(r => r.score >= 0.5).sort((a, b) => b.score - a.score);
    return { status: 'ok', total: j?.meta?.pagination?.total || results.length, results };
  } catch (err) { return { status: 'error', error: err.message, results: [] }; }
}
