// Builds config/geo/bog-localidades.json — Bogotá D.C.'s 20 localidades — from the Secretaría
// Distrital de Planeación layer published on Datos Abiertos Bogotá (dataset localidad-bogota-d-c).
// The portal labels the download GeoJSON but serves Esri JSON (features[].attributes +
// geometry.rings, EPSG:4686 MAGNA-SIRGAS geographic = lon/lat degrees). Run once per release;
// the output is checked in so the server never fetches geometry at runtime.
//
//   node scripts/build-bogota-localidades.mjs                 # downloads from datosabiertos.bogota.gov.co
//   node scripts/build-bogota-localidades.mjs ./loca.json     # from a local copy
//
// Rings are Douglas–Peucker simplified (≈0.0008°, ~90 m) and rounded to 4 decimals; holes dropped.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simplifyRing } from '../apis/sources/frontlines.mjs';
import { fold } from '../lib/countryconfig.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../config/geo/bog-localidades.json');
export const SOURCE_URL = 'https://datosabiertos.bogota.gov.co/dataset/localidad-bogota-d-c';
export const DOWNLOAD_URL = 'https://datosabiertos.bogota.gov.co/dataset/856cb657-8ca3-4ee8-857f-37211173b1f8/resource/497b8756-0927-4aee-8da3-ca4e32ca3a8/download/loca';
const TOL = 0.0008;
const MIN_RING_POINTS = 5;
const round = (v) => Math.round(v * 10000) / 10000;

// The portal stores names upper-case and without most accents ("USAQUEN", "CANDELARIA"); the
// Acuerdo 117 de 2003 names, keyed by localidad code, are what the page shows.
export const LOCALIDAD_NAMES = Object.freeze({
  '01': 'Usaquén', '02': 'Chapinero', '03': 'Santa Fe', '04': 'San Cristóbal', '05': 'Usme', '06': 'Tunjuelito', '07': 'Bosa',
  '08': 'Kennedy', '09': 'Fontibón', '10': 'Engativá', '11': 'Suba', '12': 'Barrios Unidos', '13': 'Teusaquillo', '14': 'Los Mártires',
  '15': 'Antonio Nariño', '16': 'Puente Aranda', '17': 'La Candelaria', '18': 'Rafael Uribe Uribe', '19': 'Ciudad Bolívar', '20': 'Sumapaz',
});
const SMALL = new Set(['de', 'del', 'la', 'los', 'las', 'y']);
export function titleCase(s) {
  return String(s || '').toLowerCase().split(/\s+/).filter(Boolean).map((w, i) => (SMALL.has(w) && i ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function centroidOf(rings) {
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

// Esri JSON (rings, outer rings clockwise) or GeoJSON FeatureCollection → compact units.
export function compactLocalidades(raw) {
  const wkid = raw?.spatialReference?.wkid ?? raw?.spatialReference?.latestWkid ?? null;
  if (wkid !== null && wkid !== 4686 && wkid !== 4326) throw new Error(`unexpected spatial reference wkid ${wkid} (need geographic lon/lat)`);
  const feats = Array.isArray(raw?.features) ? raw.features : [];
  const units = [];
  for (const f of feats) {
    const a = f.attributes || f.properties || {};
    const code = String(a.LocCodigo ?? a.loccodigo ?? a.CODIGO ?? '').padStart(2, '0');
    const name = LOCALIDAD_NAMES[code] || titleCase(a.LocNombre ?? a.locnombre ?? a.NOMBRE ?? '');
    const srcRings = f.geometry?.rings
      ? f.geometry.rings
      : f.geometry?.type === 'Polygon' ? [f.geometry.coordinates[0]]
        : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.map(p => p[0]) : [];
    const rings = srcRings
      .filter(r => Array.isArray(r) && r.length >= 4)
      .map(r => simplifyRing(r.map(([x, y]) => [Number(x), Number(y)]), TOL).map(([x, y]) => [round(x), round(y)]))
      .filter(r => r.length >= MIN_RING_POINTS);
    if (!name || !rings.length) continue;
    // Esri rings are clockwise outer / counter-clockwise holes: keep the biggest ring per feature plus any
    // other ring at least 5% of its area (Sumapaz / Usme have none; this drops slivers, not localidades).
    const area = (r) => Math.abs(r.reduce((s, [x0, y0], i) => { const [x1, y1] = r[(i + 1) % r.length]; return s + x0 * y1 - x1 * y0; }, 0) / 2);
    const big = Math.max(...rings.map(area));
    const kept = rings.filter(r => area(r) >= big * 0.05);
    units.push({ key: fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), code, name, areaKm2: Number.isFinite(a.LocArea) ? Math.round(a.LocArea / 1e6) : null, centroid: centroidOf(kept), rings: kept });
  }
  units.sort((a, b) => a.code.localeCompare(b.code));
  return {
    country: 'COL', city: 'Bogotá D.C.', level: 'localidad', unit: 'localidad',
    source: 'Datos Abiertos Bogotá · Secretaría Distrital de Planeación (localidad-bogota-d-c)',
    sourceUrl: SOURCE_URL, downloadUrl: DOWNLOAD_URL,
    license: 'Datos Abiertos Bogotá open-data terms (attribution)',
    crs: 'EPSG:4686 MAGNA-SIRGAS (geographic lon/lat)',
    built: new Date().toISOString().slice(0, 10), tolerance: TOL, units,
  };
}

async function main() {
  const local = process.argv[2];
  let raw;
  if (local) raw = JSON.parse(readFileSync(local, 'utf8'));
  else {
    const r = await fetch(DOWNLOAD_URL, { headers: { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix)' } });
    if (!r.ok) throw new Error(`datosabiertos.bogota.gov.co: HTTP ${r.status}`);
    raw = await r.json();
  }
  const out = compactLocalidades(raw);
  if (out.units.length !== 20) console.warn(`warning: expected 20 localidades, got ${out.units.length}`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`${out.units.length} localidades → ${OUT} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
  for (const u of out.units) console.log(`  ${u.code} ${u.name} · ${u.rings.length} ring(s) · ${u.rings.reduce((n, r) => n + r.length, 0)} pts · ${u.areaKm2} km²`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err); process.exit(1); });
}
