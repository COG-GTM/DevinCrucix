#!/usr/bin/env node
// Builds config/mx-gazetteer.json from the GeoNames Mexico dump (CC BY 4.0).
//
//   curl -L -o /tmp/MX.zip https://download.geonames.org/export/dump/MX.zip && unzip -o -d /tmp/mxgeo /tmp/MX.zip
//   node scripts/build-mx-gazetteer.mjs /tmp/mxgeo/MX.txt
//
// Output: the 32 states (ADM1), every municipality (ADM2, 2,4xx rows) and populated places above
// MIN_PLACE_POP, each with a centroid, INEGI-style admin codes and ASCII lookup keys. The narco
// event pipeline geocodes against this file; nothing is fetched at runtime.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../config/mx-gazetteer.json');
const MIN_PLACE_POP = 15000;

const src = process.argv[2];
if (!src) { console.error('usage: build-mx-gazetteer.mjs <MX.txt>'); process.exit(2); }

// GeoNames "geoname" table columns
const COL = { id: 0, name: 1, ascii: 2, alt: 3, lat: 4, lon: 5, fclass: 6, fcode: 7, cc: 8, adm1: 10, adm2: 11, pop: 14 };

// Well-known short forms and English exonyms that appear in press copy but not as GeoNames alternates.
const STATE_ALIASES = {
  '02': ['BC', 'Baja'],
  '03': ['BCS'],
  '07': ['Coahuila de Zaragoza'],
  '09': ['CDMX', 'Ciudad de México', 'Ciudad de Mexico', 'Mexico City', 'Distrito Federal', 'DF'],
  '15': ['Estado de México', 'Estado de Mexico', 'Edomex', 'Mexico State', 'State of Mexico'],
  '16': ['Michoacán de Ocampo', 'Michoacan'],
  '19': ['NL', 'Nuevo Leon'],
  '22': ['Queretaro'],
  '24': ['SLP', 'San Luis Potosi'],
  '30': ['Veracruz de Ignacio de la Llave'],
  '31': ['Yucatan'],
};
// Border-press shorthand for cities, keyed "GeoNames name|adm1" (GeoNames alternates are mostly transliterations).
const PLACE_ALIASES = {
  'Ciudad Juárez|06': ['Juárez', 'Juarez', 'Cd. Juárez', 'Cd. Juarez'],
  'Heroica Matamoros|28': ['Matamoros'],
  'Nuevo Laredo|28': ['Nvo. Laredo'],
  'San Luis Río Colorado|26': ['SLRC'],
  'Ciudad Acuña|07': ['Acuña', 'Acuna'],
  'Guadalajara|14': ['GDL'],
  'Monterrey|19': ['MTY'],
  'Ciudad Obregón|26': ['Obregón', 'Obregon'],
  'Chilpancingo|12': ['Chilpancingo de los Bravo'],
  'Acapulco de Juárez|12': ['Acapulco'],
  'Tuxtla|05': ['Tuxtla Gutiérrez', 'Tuxtla Gutierrez'],
  'Ciudad Mante|28': ['El Mante', 'Mante'],
  'Zamora de Hidalgo|16': ['Zamora'],
  'Ciudad Lázaro Cárdenas|16': ['Lázaro Cárdenas', 'Lazaro Cardenas', 'Puerto de Lázaro Cárdenas'],
  'Victoria de Durango|10': ['Durango'],
  'Santiago de Querétaro|22': ['Querétaro', 'Queretaro'],
  'León de los Aldama|11': ['León', 'Leon'],
  'Oaxaca|20': ['Oaxaca City', 'Oaxaca de Juárez'],
  'Heroica Caborca|26': ['Caborca'],
  'Heroica Guaymas|26': ['Guaymas'],
  'Ciudad Miguel Alemán|28': ['Miguel Alemán', 'Miguel Aleman'],
  'Ciudad Río Bravo|28': ['Río Bravo', 'Rio Bravo'],
  'Santa Rosalía de Camargo|06': ['Camargo'],
};

export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const rows = readFileSync(src, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const states = [], municipalities = [], places = [];
for (const r of rows) {
  if (r[COL.cc] !== 'MX') continue;
  const base = {
    id: Number(r[COL.id]),
    name: r[COL.name],
    ascii: r[COL.ascii],
    lat: Number(Number(r[COL.lat]).toFixed(4)),
    lon: Number(Number(r[COL.lon]).toFixed(4)),
    adm1: r[COL.adm1],
    pop: Number(r[COL.pop]) || 0,
  };
  if (r[COL.fclass] === 'A' && r[COL.fcode] === 'ADM1') {
    states.push({ ...base, aliases: STATE_ALIASES[base.adm1] || [] });
  } else if (r[COL.fclass] === 'A' && r[COL.fcode] === 'ADM2') {
    municipalities.push({ ...base, adm2: r[COL.adm2] });
  } else if (r[COL.fclass] === 'P' && /^PPL(A|A2|A3|C)?$/.test(r[COL.fcode]) && base.pop >= MIN_PLACE_POP) {
    places.push({ ...base, adm2: r[COL.adm2], fcode: r[COL.fcode], aliases: PLACE_ALIASES[`${base.name}|${base.adm1}`] || [] });
  }
}
states.sort((a, b) => a.adm1.localeCompare(b.adm1));
municipalities.sort((a, b) => a.adm1.localeCompare(b.adm1) || a.adm2.localeCompare(b.adm2));
places.sort((a, b) => b.pop - a.pop);

if (states.length !== 32) throw new Error(`expected 32 ADM1 rows, got ${states.length}`);
if (municipalities.length < 2400) throw new Error(`expected ~2,470 ADM2 rows, got ${municipalities.length}`);
for (const p of places) {
  if (!states.some(s => s.adm1 === p.adm1)) throw new Error(`place ${p.name} has unknown adm1 ${p.adm1}`);
}
for (const key of Object.keys(PLACE_ALIASES)) {
  const [name, adm1] = key.split('|');
  if (!places.some(p => p.name === name && p.adm1 === adm1)) throw new Error(`alias key ${key} matches no place row`);
}

const out = {
  generatedAt: new Date().toISOString(),
  source: 'GeoNames MX.txt (https://download.geonames.org/export/dump/MX.zip), CC BY 4.0',
  builder: 'scripts/build-mx-gazetteer.mjs',
  minPlacePop: MIN_PLACE_POP,
  counts: { states: states.length, municipalities: municipalities.length, places: places.length },
  states, municipalities, places,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT}: ${states.length} states, ${municipalities.length} municipalities, ${places.length} places (${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0)} KB)`);
