// Builds the compact ADM1 polygon files under config/geo/ for the Country Home Pages from
// geoBoundaries (gbOpen) simplified GeoJSON. Run once per release; output is checked in so the
// server never fetches geometry at runtime.
//
//   node scripts/build-country-geo.mjs            # downloads COL + VEN ADM1 from geoBoundaries
//   node scripts/build-country-geo.mjs ./col.geojson ./ven.geojson   # from local files
//
// Coordinates are Douglas–Peucker simplified (≈0.012°) and rounded to 3 decimals; holes are
// dropped (country-scale choropleth only). Attribution, licence and vintage travel with the file.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simplifyRing } from '../apis/sources/frontlines.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../config/geo');
const TOL = 0.012;
const MIN_RING_POINTS = 5;

const TARGETS = [
  { iso3: 'COL', out: 'col-adm1.json', unit: 'departamento' },
  { iso3: 'VEN', out: 'ven-adm1.json', unit: 'estado' },
];

async function metaFor(iso3) {
  const r = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/ADM1/`, { headers: { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix)' } });
  if (!r.ok) throw new Error(`geoBoundaries meta ${iso3}: HTTP ${r.status}`);
  return r.json();
}

async function geojsonFor(meta) {
  const r = await fetch(meta.simplifiedGeometryGeoJSON, { headers: { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix)' } });
  if (!r.ok) throw new Error(`geoBoundaries geojson ${meta.boundaryISO}: HTTP ${r.status}`);
  return r.json();
}

const round = (v) => Math.round(v * 1000) / 1000;

function outerRings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(p => p[0]);
  return [];
}

function centroidOf(rings) {
  // area-weighted centroid of the largest ring (good enough for a label anchor)
  let best = null, bestA = -1;
  for (const r of rings) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < r.length - 1; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[i + 1];
      const f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    }
    a /= 2;
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = a ? [cx / (6 * a), cy / (6 * a)] : r[0]; }
  }
  return best ? best.map(round) : null;
}

export function compact(geojson, meta, unit) {
  const units = [];
  for (const f of geojson.features || []) {
    const p = f.properties || {};
    const rings = outerRings(f.geometry)
      .map(r => simplifyRing(r, TOL).map(([x, y]) => [round(x), round(y)]))
      .filter(r => r.length >= MIN_RING_POINTS);
    if (!rings.length) continue;
    units.push({ iso: String(p.shapeISO || ''), name: String(p.shapeName || ''), centroid: centroidOf(rings), rings });
  }
  units.sort((a, b) => a.name.localeCompare(b.name));
  return {
    country: meta.boundaryISO,
    level: 'ADM1',
    unit,
    source: `geoBoundaries gbOpen (${meta.boundarySource})`,
    sourceUrl: 'https://www.geoboundaries.org/',
    license: meta.boundaryLicense,
    vintage: String(meta.boundaryYearRepresented || ''),
    built: new Date().toISOString().slice(0, 10),
    tolerance: TOL,
    units,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const local = process.argv.slice(2);
  for (let i = 0; i < TARGETS.length; i++) {
    const t = TARGETS[i];
    const meta = await metaFor(t.iso3);
    const gj = local[i] ? JSON.parse(readFileSync(local[i], 'utf8')) : await geojsonFor(meta);
    const out = compact(gj, meta, t.unit);
    const file = join(OUT_DIR, t.out);
    writeFileSync(file, JSON.stringify(out));
    console.log(`${t.iso3}: ${out.units.length} units → ${file} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err); process.exit(1); });
}
