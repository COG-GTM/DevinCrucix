// OSM proximity queries via the public Overpass API (after Bellingcat's osm-search / Sightline idea,
// without the 700 GB planet import). Bounded on purpose: one request in flight, ≤ 4 feature kinds per
// query, radius ≤ 20 km, ≤ 60 features per kind, 20 s Overpass timeout, 6 h cache keyed on the rounded
// query. Everything returned is a literal OSM element (id, tags, position) with a link back to
// openstreetmap.org — CRUCIX adds distance / bearing and the "A within d of B" pairing only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeOutboundFetch } from '../safeOutboundFetch.mjs';

export const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
export const MIN_RADIUS_M = 250;
export const MAX_RADIUS_M = 20_000;
export const MAX_KINDS = 4;
export const MAX_PER_KIND = 60;
export const QUERY_TIMEOUT_S = 20;
export const CACHE_TTL_MS = 6 * 3600_000;
export const CACHE_MAX = 400;
export const MIN_GAP_MS = 2000;
export const DEFAULT_WITHIN_M = 500;

// kind -> Overpass selectors (each is one nwr[...] clause). Infrastructure classes an analyst asks
// "what is near X" about; nothing personal, nothing residential.
export const KINDS = {
  hospital: { label: 'Hospital / clinic', sel: ['["amenity"~"^(hospital|clinic)$"]'], glyph: 'H', color: '#ef5350' },
  police: { label: 'Police', sel: ['["amenity"="police"]'], glyph: 'P', color: '#64b5f6' },
  military: { label: 'Military', sel: ['["landuse"="military"]', '["military"]'], glyph: 'M', color: '#a1887f' },
  airstrip: { label: 'Airfield / helipad', sel: ['["aeroway"~"^(aerodrome|runway|helipad|heliport)$"]'], glyph: 'A', color: '#ffd54f' },
  port: { label: 'Port / pier / ferry', sel: ['["harbour"]', '["landuse"="harbour"]', '["amenity"="ferry_terminal"]', '["man_made"="pier"]'], glyph: 'W', color: '#4dd0e1' },
  fuel: { label: 'Fuel', sel: ['["amenity"="fuel"]'], glyph: 'F', color: '#ffb74d' },
  prison: { label: 'Prison', sel: ['["amenity"="prison"]'], glyph: 'J', color: '#b0bec5' },
  border: { label: 'Border control', sel: ['["barrier"="border_control"]'], glyph: 'B', color: '#ce93d8' },
  telecom: { label: 'Comms tower / mast', sel: ['["man_made"~"^(communications_tower|mast|tower)$"]["tower:type"!="observation"]'], glyph: 'T', color: '#80cbc4' },
  power: { label: 'Power plant / substation', sel: ['["power"~"^(plant|substation|generator)$"]'], glyph: 'E', color: '#fff176' },
  bridge: { label: 'Bridge', sel: ['["man_made"="bridge"]'], glyph: 'R', color: '#90a4ae' },
  school: { label: 'School / university', sel: ['["amenity"~"^(school|university|college)$"]'], glyph: 'S', color: '#aed581' },
  rail: { label: 'Rail station', sel: ['["railway"~"^(station|halt)$"]'], glyph: 'K', color: '#9575cd' },
  water: { label: 'Dam / reservoir / water works', sel: ['["waterway"="dam"]', '["man_made"~"^(water_works|reservoir_covered|water_tower)$"]'], glyph: 'D', color: '#4fc3f7' },
};
export const KIND_KEYS = Object.keys(KINDS);

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toR) * Math.cos(lat2 * toR);
  const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos((lon2 - lon1) * toR);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compass(deg) { return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }

export function normalizeKinds(kinds) {
  const list = (Array.isArray(kinds) ? kinds : String(kinds || '').split(/[,;|]/)).map(k => String(k).trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const k of list) if (KINDS[k] && !out.includes(k)) out.push(k);
  return out.slice(0, MAX_KINDS);
}
export function clampRadius(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return 2000;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(n)));
}

/** Overpass QL for one proximity query. Pure so it is unit-testable and visible in the response. */
export function buildQuery({ lat, lon, radiusM, kinds }) {
  const r = clampRadius(radiusM);
  const la = Number(lat).toFixed(5), lo = Number(lon).toFixed(5);
  const blocks = kinds.map(k => `(${KINDS[k].sel.map(s => `nwr${s}(around:${r},${la},${lo});`).join('')})->.${k};`);
  const outs = kinds.map(k => `.${k} out center tags ${MAX_PER_KIND};`);
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];${blocks.join('')}${outs.join('')}`;
}

function kindOf(tags) {
  for (const k of KIND_KEYS) {
    for (const sel of KINDS[k].sel) {
      // selector forms: ["key"="v"], ["key"~"re"], ["key"], optional trailing ["k"!="v"]
      const m = sel.match(/^\["([^"]+)"(?:(=|~)"([^"]+)")?\]/);
      if (!m) continue;
      const v = tags[m[1]];
      if (v === undefined) continue;
      if (!m[2]) return k;
      if (m[2] === '=' && v === m[3]) return k;
      if (m[2] === '~' && new RegExp(m[3]).test(v)) return k;
    }
  }
  return null;
}

/** Overpass JSON -> bounded, source-attributed features with distance / bearing from the query point. */
export function parseElements(json, { lat, lon, kinds }) {
  const els = Array.isArray(json?.elements) ? json.elements : [];
  const perKind = Object.fromEntries(kinds.map(k => [k, 0]));
  const out = [];
  for (const e of els) {
    const tags = e.tags || {};
    const k = kindOf(tags);
    if (!k || !kinds.includes(k) || perKind[k] >= MAX_PER_KIND) continue;
    const p = e.type === 'node' ? { lat: e.lat, lon: e.lon } : e.center;
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    perKind[k]++;
    const d = haversineM(lat, lon, p.lat, p.lon), b = bearingDeg(lat, lon, p.lat, p.lon);
    out.push({
      id: `${e.type}/${e.id}`, kind: k, name: String(tags.name || tags['name:es'] || tags['name:en'] || tags.operator || '').slice(0, 80) || null,
      lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), distanceM: Math.round(d), bearing: Math.round(b), compass: compass(b),
      tags: Object.fromEntries(Object.entries(tags).filter(([key]) => /^(amenity|military|landuse|aeroway|harbour|man_made|power|railway|waterway|barrier|operator|ref|iata|icao|emergency|capacity|surface|tower:type)$/.test(key)).map(([key, v]) => [key, String(v).slice(0, 60)])),
      osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/** "A within d m of B": every feature of the first kind that has a feature of another kind within `withinM`. */
export function pairWithin(features, withinM = DEFAULT_WITHIN_M) {
  const w = Math.min(MAX_RADIUS_M, Math.max(50, Number(withinM) || DEFAULT_WITHIN_M));
  const pairs = [];
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      const a = features[i], b = features[j];
      if (a.kind === b.kind) continue;
      const d = haversineM(a.lat, a.lon, b.lat, b.lon);
      if (d <= w) pairs.push({ a: a.id, b: b.id, aKind: a.kind, bKind: b.kind, aName: a.name, bName: b.name, distanceM: Math.round(d) });
      if (pairs.length >= 120) return pairs.sort((x, y) => x.distanceM - y.distanceM);
    }
  }
  return pairs.sort((x, y) => x.distanceM - y.distanceM);
}

export function cacheKey({ lat, lon, radiusM, kinds }) {
  return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)},${clampRadius(radiusM)},${[...kinds].sort().join('+')}`;
}

export class OverpassClient {
  constructor({ dataDir, fetchImpl = safeOutboundFetch, now = () => Date.now(), url = OVERPASS_URL, log = (l) => console.log(l) } = {}) {
    this.dataDir = dataDir;
    this.file = dataDir ? join(dataDir, 'osm-cache.json') : null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.url = url;
    this.log = log;
    this.cache = new Map();
    this.inflight = null;
    this.lastRequestAt = 0;
    this.stats = { requests: 0, hits: 0, errors: 0 };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const t = this.now();
      for (const [k, v] of Object.entries(raw?.entries || {})) if (v && t - Date.parse(v.fetchedAt) < CACHE_TTL_MS) this.cache.set(k, v);
    } catch { /* no cache yet */ }
  }
  save() {
    if (!this.file) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const entries = Object.fromEntries([...this.cache.entries()].slice(-CACHE_MAX));
      writeFileSync(this.file, JSON.stringify({ schema: 'crucix-osm-cache/1', savedAt: new Date(this.now()).toISOString(), entries }));
    } catch (e) { this.log(`[OSM] cache save failed: ${e.message}`); }
  }

  /** Resolve a proximity query (cache -> Overpass). Serialised: concurrent callers wait for the one in flight. */
  async nearby({ lat, lon, radiusM, kinds, withinM }) {
    const ks = normalizeKinds(kinds);
    if (!ks.length) throw new Error('no valid kinds');
    const q = { lat: Number(lat), lon: Number(lon), radiusM: clampRadius(radiusM), kinds: ks };
    const key = cacheKey(q);
    const hit = this.cache.get(key);
    if (hit && this.now() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) { this.stats.hits++; return this.decorate(hit, q, withinM, true); }
    while (this.inflight) await this.inflight.catch(() => {});
    const again = this.cache.get(key);
    if (again && this.now() - Date.parse(again.fetchedAt) < CACHE_TTL_MS) { this.stats.hits++; return this.decorate(again, q, withinM, true); }
    const run = this.request(q, key);
    this.inflight = run;
    try { return this.decorate(await run, q, withinM, false); } finally { this.inflight = null; }
  }

  async request(q, key) {
    const wait = MIN_GAP_MS - (this.now() - this.lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequestAt = this.now();
    this.stats.requests++;
    const query = buildQuery(q);
    const res = await this.fetchImpl(this.url, {
      method: 'POST', timeout: (QUERY_TIMEOUT_S + 8) * 1000, maxBytes: 4 * 1024 * 1024,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Crucix/1.0 (bounded proximity queries)' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) { this.stats.errors++; throw new Error(`Overpass HTTP ${res.status}${res.status === 429 || res.status === 504 ? ' — server busy, retry in a minute' : ''}`); }
    const json = await res.json();
    const features = parseElements(json, q);
    const entry = { fetchedAt: new Date(this.now()).toISOString(), osmBase: json?.osm3s?.timestamp_osm_base || null, query, features };
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.save();
    return entry;
  }

  decorate(entry, q, withinM, cached) {
    const byKind = {};
    for (const f of entry.features) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    return {
      query: { lat: q.lat, lon: q.lon, radiusM: q.radiusM, kinds: q.kinds, withinM: q.kinds.length > 1 ? Math.min(MAX_RADIUS_M, Math.max(50, Number(withinM) || DEFAULT_WITHIN_M)) : null },
      fetchedAt: entry.fetchedAt, cached, osmBase: entry.osmBase,
      count: entry.features.length, byKind, features: entry.features,
      pairs: q.kinds.length > 1 ? pairWithin(entry.features, withinM) : [],
      overpassQl: entry.query,
      attribution: '© OpenStreetMap contributors (ODbL) via Overpass API',
      rule: `Literal OSM elements within ${q.radiusM} m of the point; presence in OSM is not confirmation on the ground and absence is not absence. Each row links to the OSM element.`,
    };
  }
}
