// Builds the static geo files the map layer pack reads. Run by hand when the upstream data
// changes (new Anthropic Economic Index release, airport list, country borders):
//   node scripts/build-map-geo.mjs
// Outputs (all checked in):
//   dashboard/public/geo/world-110m.geojson   country polygons (Natural Earth 110m via world-atlas)
//   config/geo/airports-major.json            IATA -> { name, lat, lng, city, cc } for large US/CA airports
//   config/geo/ai-usage-index.json            Anthropic Economic Index per-country / per-US-state usage
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../lib/map/csv.mjs';
import { US_STATE_CENTROIDS } from '../lib/map/usstates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISO = JSON.parse(readFileSync(join(ROOT, 'config/geo/iso-codes.json'), 'utf8')); // a2 -> { a3, num }
const byNum = Object.fromEntries(Object.entries(ISO).map(([a2, v]) => [v.num, { a2, a3: v.a3 }]));
const byA3 = Object.fromEntries(Object.entries(ISO).map(([a2, v]) => [v.a3, { a2, num: v.num }]));

const WORLD_ATLAS = 'https://unpkg.com/world-atlas@2.0.2/countries-110m.json';
const OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const AEI = 'https://huggingface.co/datasets/Anthropic/EconomicIndex/resolve/main/';
// Enriched release: has usage_per_capita_index + usage_tier per country (ISO3) and US state.
const AEI_ENRICHED = `${AEI}release_2025_09_15/data/output/aei_enriched_claude_ai_2025-08-04_to_2025-08-11.csv`;
// Latest raw release: usage_pct share per country (ISO2) and top use cases.
const AEI_LATEST = `${AEI}release_2026_01_15/data/intermediate/aei_raw_claude_ai_2025-11-13_to_2025-11-20.csv`;
const AEI_LATEST_WINDOW = '2025-11-13 → 2025-11-20';

const get = async (url, as = 'text') => {
  const r = await fetch(url, { headers: { 'User-Agent': 'CRUCIX/2.0 build-map-geo' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return as === 'json' ? r.json() : r.text();
};

// ── TopoJSON → GeoJSON (minimal decoder, so no topojson-client dependency) ──
function topoToGeo(topo, objectName) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
  });
  const ring = (idxs) => {
    const out = [];
    idxs.forEach(i => {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      a.forEach((p, k) => { if (k === 0 && out.length) return; out.push([+p[0].toFixed(4), +p[1].toFixed(4)]); });
    });
    return out;
  };
  const geom = (g) => g.type === 'Polygon' ? { type: 'Polygon', coordinates: g.arcs.map(ring) }
    : g.type === 'MultiPolygon' ? { type: 'MultiPolygon', coordinates: g.arcs.map(poly => poly.map(ring)) } : null;
  return topo.objects[objectName].geometries.map(g => ({ type: 'Feature', id: g.id, properties: g.properties || {}, geometry: geom(g) })).filter(f => f.geometry);
}

async function buildWorld() {
  const topo = await get(WORLD_ATLAS, 'json');
  const features = topoToGeo(topo, 'countries').map(f => {
    const iso = f.id ? byNum[String(f.id).padStart(3, '0')] : null;
    return { ...f, properties: { name: f.properties.name, num: f.id ? String(f.id).padStart(3, '0') : null, a2: iso?.a2 || null, a3: iso?.a3 || null } };
  });
  const out = join(ROOT, 'dashboard/public/geo/world-110m.geojson');
  writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`world: ${features.length} countries (${features.filter(f => f.properties.a2).length} with ISO) → ${out}`);
}

async function buildAirports() {
  const rows = parseCsv(await get(OURAIRPORTS));
  const out = {};
  rows.filter(r => r.type === 'large_airport' && ['US', 'CA'].includes(r.iso_country) && r.iata_code)
    .forEach(r => { out[r.iata_code] = { name: r.name, lat: +(+r.latitude_deg).toFixed(4), lng: +(+r.longitude_deg).toFixed(4), city: r.municipality, cc: r.iso_country }; });
  const file = join(ROOT, 'config/geo/airports-major.json');
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`airports: ${Object.keys(out).length} → ${file}`);
}

async function buildAiUsage() {
  const enriched = parseCsv(await get(AEI_ENRICHED));
  const latest = parseCsv(await get(AEI_LATEST));
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const countries = {};
  enriched.filter(r => r.geography === 'country').forEach(r => {
    const c = countries[r.geo_id] ||= { a3: r.geo_id, a2: byA3[r.geo_id]?.a2 || null, name: r.geo_name };
    if (r.variable === 'usage_per_capita_index') c.index = +n(r.value).toFixed(3);
    if (r.variable === 'usage_tier') c.tier = r.cluster_name;
    if (r.variable === 'usage_pct') c.sharePct2025 = +n(r.value).toFixed(3);
  });
  const latestByA2 = {};
  latest.filter(r => r.geography === 'country' && r.facet === 'country').forEach(r => {
    const c = latestByA2[r.geo_id] ||= {};
    if (r.variable === 'usage_pct') c.sharePct = +n(r.value).toFixed(3);
    if (r.variable === 'usage_count') c.count = n(r.value);
  });
  const useCases = {};
  latest.filter(r => r.geography === 'country' && r.facet === 'use_case' && r.variable === 'use_case_pct').forEach(r => {
    (useCases[r.geo_id] ||= []).push({ name: r.cluster_name, pct: +n(r.value).toFixed(1) });
  });
  Object.values(countries).forEach(c => {
    const l = c.a2 ? latestByA2[c.a2] : null;
    if (l) { c.sharePct = l.sharePct; c.count = l.count; }
    if (c.a2 && useCases[c.a2]) c.useCases = useCases[c.a2].sort((a, b) => b.pct - a.pct).slice(0, 3);
  });
  const states = {};
  enriched.filter(r => r.geography === 'state_us').forEach(r => {
    const s = states[r.geo_id] ||= { code: r.geo_id, name: r.geo_name, ...(US_STATE_CENTROIDS[r.geo_id] || {}) };
    if (r.variable === 'usage_per_capita_index') s.index = +n(r.value).toFixed(3);
    if (r.variable === 'usage_tier') s.tier = r.cluster_name;
    if (r.variable === 'usage_pct') s.sharePct = +n(r.value).toFixed(3);
  });
  const out = {
    source: 'Anthropic Economic Index (Claude.ai Free + Pro usage; per-capita index = share of usage ÷ share of working-age population; 1.0 = global average)',
    url: 'https://huggingface.co/datasets/Anthropic/EconomicIndex',
    indexWindow: '2025-08-04 → 2025-08-11', shareWindow: AEI_LATEST_WINDOW,
    countries: Object.values(countries).filter(c => c.a2 && Number.isFinite(c.index)).sort((a, b) => b.index - a.index),
    states: Object.values(states).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.index)).sort((a, b) => b.index - a.index),
  };
  const file = join(ROOT, 'config/geo/ai-usage-index.json');
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`ai usage: ${out.countries.length} countries, ${out.states.length} states → ${file}`);
}

mkdirSync(join(ROOT, 'dashboard/public/geo'), { recursive: true });
const only = process.argv[2];
for (const [name, fn] of [['world', buildWorld], ['airports', buildAirports], ['aiusage', buildAiUsage]]) {
  if (!only || only === name) await fn();
}
