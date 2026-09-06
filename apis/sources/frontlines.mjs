// Ukraine frontline map from DeepStateMAP (deepstatemap.live).
// /api/history/last   -> latest control-of-terrain GeoJSON (polygons + points)
// /api/history/public -> log of map updates; each entry links the places that changed
// DeepState is an observational map product: it is their assessment, not verified ground truth.

import { safeFetch } from '../utils/fetch.mjs';

const DEEPSTATE_URL = 'https://deepstatemap.live/api/history/last';
const DEEPSTATE_HISTORY_URL = 'https://deepstatemap.live/api/history/public';
export const DEEPSTATE_SITE_URL = 'https://deepstatemap.live/en';
const CACHE_TTL_MS = 30 * 60 * 1000;
const RECENT_DAYS = 7;
const MAX_UPDATES = 12;
const SIMPLIFY_TOLERANCE_DEG = 0.002; // ~200 m; polygons are drawn at country scale
const EARTH_RADIUS_KM = 6371.0088;

let _cache = null;
let _cacheTs = 0;

// Polygon categories (from the `geoJSON.<key>` suffix DeepState puts in every feature name).
// `editorial` = irredentist/satirical territories outside Ukraine that DeepState draws
// (Karelia, East Prussia, Kuril...). They are counted but never plotted or summed.
const POLY_CAT = [
  [/^status\.occupied/, 'occupied'],
  [/^territories\.(crimea|ordlo|tuzla)$/, 'occupied_pre2022'],
  [/^status\.unknown/, 'contested'],
  [/^status\.dismissed/, 'liberated'],
  [/^zmiinyi_island$/, 'liberated'],
  [/^territories\.(transnistria|abkhazia|tskhinvali-district)$/, 'other_occupied'],
];
export const PLOTTED_POLY_CATS = ['occupied', 'occupied_pre2022', 'contested', 'liberated'];

const POINT_CAT = [
  [/^status\.attack_direction/, 'attack'],
  [/^units\./, 'unit'],
  [/^(airfield|airport|airbase)\./, 'airfield'],
];

export function parseName(raw) {
  const parts = String(raw || '').split('///').map(s => s.trim());
  const key = ((parts[parts.length - 1] || '').match(/geoJSON\.([\w.\-]+)/) || [])[1] || '';
  const ua = parts[0] || '';
  const en = parts.length >= 3 ? parts[1] : (parts.length === 2 && !/geoJSON\./.test(parts[1]) ? parts[1] : '');
  return { key, ua, en: en || ua };
}

function classify(table, key) {
  for (const [re, cat] of table) if (re.test(key)) return cat;
  return null;
}

// arrow_N icons: 16 compass sectors, N*22.5° clockwise from north (arrow_16 = north, arrow_4 = east)
export function arrowHeading(description) {
  const m = String(description || '').match(/arrow_(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 16) return null;
  return (n * 22.5) % 360;
}

export function unitEchelon(key) {
  const m = key.match(/^units\.([a-z\-]+)/);
  if (!m) return null;
  const e = m[1];
  if (['army', 'division', 'brigade', 'regiment', 'battalion'].includes(e)) return e;
  return 'other';
}

// Douglas–Peucker on [lon, lat] rings; keeps ring closure.
export function simplifyRing(ring, tol) {
  if (!Array.isArray(ring) || ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1; keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let maxD = 0, idx = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 4 ? out : ring;
}

// Spherical polygon area (Chamberlain & Duquette). Holes (rings after the first) subtract.
export function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    sum += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return Math.abs(sum) * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2;
}

export function polygonAreaKm2(rings) {
  if (!Array.isArray(rings) || !rings.length) return 0;
  let a = ringAreaKm2(rings[0]);
  for (let i = 1; i < rings.length; i++) a -= ringAreaKm2(rings[i]);
  return Math.max(0, a);
}

function isLonLat(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

function round4(p) { return [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]; }

function cleanText(s, max = 240) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Reduce the raw DeepState FeatureCollection to what the dashboard plots.
export function extractGeo(geojson) {
  const polygons = [];
  const points = [];
  const polyCats = {};
  const pointCats = {};
  const areaKm2 = { occupied: 0, occupied_pre2022: 0, contested: 0, liberated: 0 };
  let skipped = 0;

  for (const f of (geojson?.features || [])) {
    const g = f?.geometry;
    const props = f?.properties || {};
    const { key, en } = parseName(props.name);
    if (!g) { skipped++; continue; }

    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const cat = classify(POLY_CAT, key) || (key.startsWith('territories.') ? 'editorial' : null);
      if (!cat) { skipped++; continue; }
      polyCats[cat] = (polyCats[cat] || 0) + 1;
      if (!PLOTTED_POLY_CATS.includes(cat)) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const rings of polys) {
        if (!Array.isArray(rings) || !rings.length || !rings[0].every(isLonLat)) { skipped++; continue; }
        const validRings = rings.filter(r => Array.isArray(r) && r.length >= 4 && r.every(isLonLat));
        areaKm2[cat] += polygonAreaKm2(validRings);
        polygons.push({
          cat,
          name: cleanText(en, 80),
          rings: validRings.map(r => simplifyRing(r, SIMPLIFY_TOLERANCE_DEG).map(round4)),
        });
      }
      continue;
    }

    if (g.type === 'Point') {
      const cat = classify(POINT_CAT, key);
      if (!cat) { skipped++; continue; }
      if (!isLonLat(g.coordinates)) { skipped++; continue; }
      pointCats[cat] = (pointCats[cat] || 0) + 1;
      const [lon, lat] = round4(g.coordinates);
      const pt = { cat, lat, lon, name: cleanText(en, 120) };
      if (cat === 'attack') {
        const h = arrowHeading(props.description);
        if (h !== null) pt.heading = h;
      } else if (cat === 'unit') {
        pt.echelon = unitEchelon(key);
      }
      points.push(pt);
      continue;
    }
    skipped++;
  }

  for (const k of Object.keys(areaKm2)) areaKm2[k] = Math.round(areaKm2[k]);
  return { polygons, points, polyCats, pointCats, areaKm2, skipped };
}

// "The enemy advanced near <a href="...#14/47.55/35.56">Mali Shcherbaky</a>, ..." -> places + kind
export function parseUpdate(rec) {
  const en = String(rec?.descriptionEn || '');
  const text = en || String(rec?.description || '');
  const places = [];
  const re = /<a[^>]*href="[^"]*#\d{1,2}\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)"[^>]*>([^<]{1,80})<\/a>/g;
  let m;
  while ((m = re.exec(text)) && places.length < 12) {
    const lat = Number(m[1]), lon = Number(m[2]);
    if (!isLonLat([lon, lat])) continue;
    places.push({ name: cleanText(m[3], 80), lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 });
  }
  const lower = text.toLowerCase();
  let kind = 'other';
  if (/regained|liberated|returned control|pushed (?:back|the enemy)|cleared/.test(lower)) kind = 'regain';
  else if (/enemy (?:has )?(?:advanced|occupied|captured|seized)|russians? (?:advanced|occupied|captured)/.test(lower)) kind = 'advance';
  const at = rec?.createdAt || rec?.updatedAt || null;
  return {
    id: rec?.id ?? null,
    at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null,
    kind,
    lang: en ? 'en' : 'uk',
    text: cleanText(text, 280),
    places,
  };
}

export function summarizeHistory(records, now = Date.now()) {
  const seen = new Set();
  const list = [];
  for (const u of (Array.isArray(records) ? records : []).map(parseUpdate)) {
    if (!u.at) continue;
    if (u.id !== null) { if (seen.has(u.id)) continue; seen.add(u.id); }
    list.push(u);
  }
  list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const cutoff = now - RECENT_DAYS * 86400000;
  const recent = list.filter(u => Date.parse(u.at) >= cutoff);
  return {
    total: list.length,
    recent7d: recent.length,
    advances7d: recent.filter(u => u.kind === 'advance').length,
    regains7d: recent.filter(u => u.kind === 'regain').length,
    latestAt: list[0]?.at || null,
    updates: list.slice(0, MAX_UPDATES),
    changePoints: recent.flatMap(u => u.places.map(p => ({ ...p, kind: u.kind, at: u.at, text: u.text }))),
  };
}

function unavailable(error) {
  return {
    source: 'Frontlines',
    timestamp: new Date().toISOString(),
    status: 'unavailable',
    error,
    provider: 'DeepStateMAP',
    siteUrl: DEEPSTATE_SITE_URL,
    mapId: null,
    mapUpdatedAt: null,
    featureCount: 0,
    signals: [],
    geo: null,
  };
}

export function buildResult(raw, history, now = Date.now()) {
  const geojson = raw?.type === 'FeatureCollection' ? raw : (raw?.map || raw?.geojson || raw?.data || null);
  if (!geojson || !Array.isArray(geojson.features)) return unavailable('unexpected payload shape');

  const geo = extractGeo(geojson);
  const hist = summarizeHistory(history, now);
  const mapId = Number.isFinite(Number(raw?.id)) ? Number(raw.id) : null;
  const mapRecord = mapId ? (history || []).find(r => Number(r?.id) === mapId) : null;
  const mapUpdatedAt = mapRecord?.createdAt && !Number.isNaN(Date.parse(mapRecord.createdAt))
    ? new Date(mapRecord.createdAt).toISOString()
    : hist.latestAt;
  const mapAgeH = mapUpdatedAt ? Math.round((now - Date.parse(mapUpdatedAt)) / 3600000) : null;

  const signals = [];
  const occupiedTotal = geo.areaKm2.occupied + geo.areaKm2.occupied_pre2022;
  if (geo.polygons.length) {
    signals.push({
      severity: hist.advances7d > hist.regains7d ? 'warning' : 'info',
      signal: `DeepStateMAP: ~${occupiedTotal.toLocaleString('en-US')} km² of Ukraine assessed occupied (${geo.areaKm2.occupied.toLocaleString('en-US')} since 2022), ${geo.areaKm2.contested.toLocaleString('en-US')} km² contested; ${hist.recent7d} map updates in ${RECENT_DAYS}d (${hist.advances7d} advances, ${hist.regains7d} regains).`,
    });
  }

  return {
    source: 'Frontlines',
    timestamp: new Date().toISOString(),
    status: 'live',
    provider: 'DeepStateMAP',
    siteUrl: DEEPSTATE_SITE_URL,
    mapId,
    mapUpdatedAt,
    mapAgeH,
    mapDatetimeLabel: typeof raw?.datetime === 'string' ? raw.datetime.slice(0, 40) : null,
    featureCount: geojson.features.length,
    polyCats: geo.polyCats,
    pointCats: geo.pointCats,
    areaKm2: geo.areaKm2,
    occupiedKm2: occupiedTotal,
    contestedKm2: geo.areaKm2.contested,
    attackDirections: geo.pointCats.attack || 0,
    units: geo.pointCats.unit || 0,
    airfields: geo.pointCats.airfield || 0,
    skippedFeatures: geo.skipped,
    history: {
      total: hist.total,
      recent7d: hist.recent7d,
      advances7d: hist.advances7d,
      regains7d: hist.regains7d,
      latestAt: hist.latestAt,
      updates: hist.updates,
    },
    signals,
    geo: {
      mapId,
      updatedAt: mapUpdatedAt,
      polygons: geo.polygons,
      points: geo.points,
      changes: hist.changePoints,
    },
  };
}

export async function fetchFrontlines() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;

  const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' };
  try {
    const [raw, hist] = await Promise.all([
      safeFetch(DEEPSTATE_URL, { timeout: 20000, headers }),
      safeFetch(DEEPSTATE_HISTORY_URL, { timeout: 20000, headers }),
    ]);

    if (raw.error) {
      console.log(`[Frontlines] API error: ${raw.error}`);
      return _cache ? { ..._cache, stale: true } : unavailable(raw.error);
    }
    if (hist.error) console.log(`[Frontlines] history unavailable: ${hist.error}`);

    const result = buildResult(raw, Array.isArray(hist) ? hist : []);
    if (result.status !== 'live') {
      console.log(`[Frontlines] ${result.error}`);
      return _cache ? { ..._cache, stale: true } : result;
    }
    console.log(`[Frontlines] map ${result.mapId} · ${result.geo.polygons.length} polygons · ${result.geo.points.length} points · ${result.history.recent7d} updates/7d`);
    _cache = result;
    _cacheTs = Date.now();
    return result;
  } catch (err) {
    console.log(`[Frontlines] Fetch error: ${err.message}`);
    return _cache ? { ..._cache, stale: true } : unavailable(err.message);
  }
}

export function cachedFrontGeo() {
  return _cache?.geo || null;
}

export async function briefing() {
  return fetchFrontlines();
}
