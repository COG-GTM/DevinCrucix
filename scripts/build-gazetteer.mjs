#!/usr/bin/env node
// Builds config/<cc>-gazetteer.json (Colombia, Venezuela) from a GeoNames country dump (CC BY 4.0), in the
// same shape lib/narco/gazetteer.mjs reads for Mexico (config/mx-gazetteer.json, scripts/build-mx-gazetteer.mjs).
//
//   curl -L -o /tmp/CO.zip https://download.geonames.org/export/dump/CO.zip && unzip -o -d /tmp/cogeo /tmp/CO.zip
//   node scripts/build-gazetteer.mjs co /tmp/cogeo/CO.txt
//
// Output: first-level divisions (ADM1: departamentos / estados), every ADM2 (municipios) and populated places
// above the per-country population floor, each with a centroid and folded lookup keys. The country knowledge
// graphs geocode against this file; nothing is fetched at runtime.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// GeoNames "geoname" table columns
const COL = { id: 0, name: 1, ascii: 2, alt: 3, lat: 4, lon: 5, fclass: 6, fcode: 7, cc: 8, adm1: 10, adm2: 11, pop: 14 };

// GeoNames ADM1 names are long-form ("Departamento de Antioquia", "Estado Zulia"); press copy uses the short form.
function shortName(name) {
  return name
    .replace(/^Departamento (?:de|del) /, '').replace(/ Department$/, '')
    .replace(/^Estado (?:de |del )?/, '')
    .replace(/^Distrito Capital de Bogotá$/, 'Bogotá')
    .replace(/^Providencia y Santa Catalina, Departamento de Archipiélago de San Andrés$/, 'San Andrés y Providencia');
}

const SPECS = {
  co: {
    country: 'CO', countryName: 'Colombia', minPlacePop: 15000, expectAdm1: 33, expectAdm2: 1000,
    // GeoNames ADM1 code of the capital district: the capital is where ministries speak from, so it ranks last
    // whenever any other place is named (see findPlaces).
    capitalAdm1: '34',
    stateAliases: {
      '34': ['Bogotá D.C.', 'Bogota D.C.', 'Bogotá DC', 'Bogota', 'Distrito Capital', 'Bogotá, D.C.'],
      '21': ['Norte de Santander', 'Catatumbo'],
      '29': ['Valle del Cauca', 'Valle'],
      '25': ['San Andrés', 'San Andres', 'San Andrés y Providencia'],
      '17': ['Guajira'],
      '35': ['Bolivar'],
      '36': ['Boyaca'],
      '08': ['Caqueta'],
      '11': ['Choco'],
      '12': ['Cordoba'],
      '20': ['Narino'],
      '23': ['Quindio'],
      '02': ['Antioquía'],
      '04': ['Atlantico'],
    },
    placeAliases: {
      'Bogotá|34': ['Bogota', 'Bogotá D.C.', 'Santa Fe de Bogotá'],
      'Medellín|02': ['Medellin'],
      'Cali|29': ['Santiago de Cali'],
      'Cartagena|35': ['Cartagena de Indias'],
      'Cúcuta|21': ['Cucuta', 'San José de Cúcuta'],
      'Buenaventura|29': ['Puerto de Buenaventura'],
      'Tumaco|20': ['San Andrés de Tumaco'],
      'Barrancabermeja|26': ['Barranca'],
    },
  },
  ve: {
    country: 'VE', countryName: 'Venezuela', minPlacePop: 15000, expectAdm1: 25, expectAdm2: 300,
    capitalAdm1: '25',
    stateAliases: {
      '25': ['Caracas', 'Distrito Capital', 'Distrito Federal', 'Libertador'],
      '26': ['Vargas', 'Estado Vargas'],
      '09': ['Delta Amacuro'],
      '15': ['Estado Miranda', 'Miranda'],
      '24': ['Dependencias Federales', 'Federal Dependencies'],
      '02': ['Anzoategui'],
      '06': ['Bolivar'],
      '11': ['Falcon'],
      '12': ['Guarico'],
      '14': ['Merida'],
      '20': ['Tachira'],
    },
    placeAliases: {
      'Caracas|25': ['Gran Caracas', 'Libertador'],
      'Petare|15': ['José Félix Ribas'],
      'Ciudad Guayana|06': ['Puerto Ordaz', 'San Félix'],
      'San Cristóbal|20': ['San Cristobal'],
      'Cumaná|19': ['Cumana'],
      'Ciudad Bolívar|06': ['Ciudad Bolivar'],
      'La Guaira|26': ['Vargas'],
    },
  },
};

export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const cc = String(process.argv[2] || '').toLowerCase(), src = process.argv[3];
const spec = SPECS[cc];
if (!spec || !src) { console.error('usage: build-gazetteer.mjs <co|ve> <CC.txt>'); process.exit(2); }
const OUT = join(__dirname, `../config/${cc}-gazetteer.json`);

const rows = readFileSync(src, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const states = [], municipalities = [], places = [];
for (const r of rows) {
  if (r[COL.cc] !== spec.country) continue;
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
    states.push({ ...base, short: shortName(base.name), aliases: spec.stateAliases[base.adm1] || [] });
  } else if (r[COL.fclass] === 'A' && r[COL.fcode] === 'ADM2') {
    municipalities.push({ ...base, adm2: r[COL.adm2] });
  } else if (r[COL.fclass] === 'P' && /^PPL(A|A2|A3|C)?$/.test(r[COL.fcode]) && base.pop >= spec.minPlacePop) {
    places.push({ ...base, adm2: r[COL.adm2], fcode: r[COL.fcode], aliases: spec.placeAliases[`${base.name}|${base.adm1}`] || [] });
  }
}
states.sort((a, b) => a.adm1.localeCompare(b.adm1));
municipalities.sort((a, b) => a.adm1.localeCompare(b.adm1) || a.adm2.localeCompare(b.adm2));
places.sort((a, b) => b.pop - a.pop);

if (states.length !== spec.expectAdm1) throw new Error(`expected ${spec.expectAdm1} ADM1 rows, got ${states.length}`);
if (municipalities.length < spec.expectAdm2) throw new Error(`expected >= ${spec.expectAdm2} ADM2 rows, got ${municipalities.length}`);
if (!states.some(s => s.adm1 === spec.capitalAdm1)) throw new Error(`capital adm1 ${spec.capitalAdm1} not found`);
for (const p of places) if (!states.some(s => s.adm1 === p.adm1)) throw new Error(`place ${p.name} has unknown adm1 ${p.adm1}`);
for (const key of Object.keys(spec.placeAliases)) {
  const [name, adm1] = key.split('|');
  if (!places.some(p => p.name === name && p.adm1 === adm1)) throw new Error(`alias key ${key} matches no place row`);
}

const out = {
  generatedAt: new Date().toISOString(),
  source: `GeoNames ${spec.country}.txt (https://download.geonames.org/export/dump/${spec.country}.zip), CC BY 4.0`,
  builder: 'scripts/build-gazetteer.mjs',
  country: spec.country,
  countryName: spec.countryName,
  capitalAdm1: spec.capitalAdm1,
  minPlacePop: spec.minPlacePop,
  counts: { states: states.length, municipalities: municipalities.length, places: places.length },
  states, municipalities, places,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT}: ${states.length} states, ${municipalities.length} municipalities, ${places.length} places (${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0)} KB)`);
