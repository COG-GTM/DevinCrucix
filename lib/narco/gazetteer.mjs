// Mexico gazetteer — state / municipality / city lookup and geocoding for narco event extraction.
// Backed by config/mx-gazetteer.json (built from GeoNames by scripts/build-mx-gazetteer.mjs).
// All matching is done on accent-folded, lower-cased text with whole-word boundaries.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SURNAMES_SET } from './names.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GAZETTEER_FILE = join(__dirname, '../../config/mx-gazetteer.json');

export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Municipality / place names that are also ordinary words or U.S. places and must only be
// accepted when the article also names their state (or a more specific alias hits first).
const AMBIGUOUS = new Set([
  'centro', 'progreso', 'victoria', 'reforma', 'guadalupe', 'hidalgo', 'juarez', 'morelos', 'allende', 'ocampo',
  'union', 'libertad', 'independencia', 'la paz', 'el oro', 'jimenez', 'ramos', 'general', 'villa', 'mier', 'colon',
  'aldama', 'abasolo', 'zaragoza', 'bravo', 'guerrero', 'mexico', 'santiago', 'san juan', 'san pedro', 'san miguel',
  'san jose', 'san luis', 'santa maria', 'santa ana', 'santa cruz', 'rosario', 'dolores', 'benito juarez', 'valle',
  'la union', 'el carmen', 'carmen', 'san antonio', 'san francisco', 'san martin', 'san andres', 'san felipe',
  'san nicolas', 'san lorenzo', 'san mateo', 'san pablo', 'san agustin', 'santa catarina', 'santa clara', 'laredo',
  'nogales', 'tecate', 'el paso', 'del rio', 'eagle pass', 'presidio', 'columbus', 'douglas', 'naco', 'sasabe', 'lukeville',
  'rio grande', 'el salvador', 'china', 'altar', 'frontera', 'mier', 'medina', 'lopez', 'garcia', 'gonzalez', 'mendez', 'alvarado',
  'salinas', 'ramos arizpe', 'escobedo', 'galeana', 'mina', 'iturbide', 'madero', 'lerdo', 'cortazar', 'ojinaga', 'cadereyta',
  'lazaro cardenas', 'cordoba', 'merida', 'valencia', 'guadalajara de buga',
]);
// A locative preposition immediately before a name is weak evidence that it is a place, not a surname.
const LOCATIVE_RE = /(?:^|\s)(?:in|en|at|near|from|to|of|de|del|desde|hacia|hasta|municipio de|municipality of|town of|city of|ciudad de|outside|inside|around)\s$/;
// Surname-named places only count with a locative cue ("in Garcia"), unless the name is far better known
// as a city than as a surname.
const PLACE_FIRST = new Set(['juarez', 'guerrero', 'zaragoza', 'leon', 'zamora']);
function surnameLike(key) { return !key.includes(' ') && SURNAMES_SET.has(key) && !PLACE_FIRST.has(key); }
// "New Mexico" / "Mexico City" are not Estado de México.
function maskCountry(t) { return t.replace(/\bnew mexico\b/g, 'newmexico').replace(/\bmexico city\b/g, 'ciudad de mexico'); }
// Municipalities named after a generic word plus nothing else are not worth matching without state context
const MIN_MUNI_CHARS = 5;

let _cache = null;

export function loadGazetteer(file = DEFAULT_GAZETTEER_FILE) {
  if (_cache && _cache.file === file) return _cache.gz;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const gz = buildIndex(raw);
  _cache = { file, gz };
  return gz;
}

// GeoNames ADM1 names are long-form ("Estado de Sinaloa", "Michoacán de Ocampo"); articles use the short form.
export function shortStateName(s) {
  if (s.adm1 === '15') return 'Estado de México';
  return s.name.replace(/^Estado de /, '').replace(/ de (Ocampo|Zaragoza|Ignacio de la Llave)$/, '').replace(/^Veracruz.*$/, 'Veracruz');
}

export function buildIndex(raw) {
  const states = raw.states.map(s => {
    const short = shortStateName(s);
    const keys = [...new Set([fold(s.name), fold(s.ascii), fold(short), ...(s.aliases || []).map(fold)].filter(Boolean))];
    return { ...s, shortName: short, key: fold(short), keys };
  });
  const stateByAdm1 = new Map(states.map(s => [s.adm1, s]));
  const stateKey = new Map();
  for (const s of states) for (const k of s.keys) if (!stateKey.has(k)) stateKey.set(k, s);

  // Municipalities: folded name -> [rows]; ambiguous ones are only accepted with state context.
  const muniKey = new Map();
  for (const m of raw.municipalities) {
    const k = fold(m.name);
    if (k.length < MIN_MUNI_CHARS) continue;
    if (!muniKey.has(k)) muniKey.set(k, []);
    muniKey.get(k).push(m);
  }
  // Places: name, ascii, aliases -> [rows] (population-sorted already)
  const placeKey = new Map();
  for (const p of raw.places) {
    const keys = new Set([fold(p.name), fold(p.ascii), ...(p.aliases || []).map(fold)].filter(k => k.length >= 4));
    for (const k of keys) {
      if (!placeKey.has(k)) placeKey.set(k, []);
      placeKey.get(k).push({ ...p, viaAlias: k !== fold(p.name) && k !== fold(p.ascii) });
    }
  }
  const byLen = (a, b) => b.length - a.length || a.localeCompare(b);
  const stateRe = new RegExp(`\\b(${[...stateKey.keys()].sort(byLen).map(escapeRe).join('|')})\\b`, 'g');
  const placeRe = new RegExp(`\\b(${[...placeKey.keys()].sort(byLen).map(escapeRe).join('|')})\\b`, 'g');
  const muniRe = new RegExp(`\\b(${[...muniKey.keys()].sort(byLen).map(escapeRe).join('|')})\\b`, 'g');
  return { states, stateByAdm1, stateKey, muniKey, placeKey, stateRe, placeRe, muniRe, counts: raw.counts, generatedAt: raw.generatedAt };
}

function scan(re, text, cat) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ cat, key: m[1], index: m.index, end: m.index + m[1].length });
  return out;
}

// "Sabinas Hidalgo" is one municipality, not Sabinas plus the state of Hidalgo: when hits from different
// categories overlap, only the longest span survives.
function dropOverlaps(hits) {
  const sorted = [...hits].sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));
  const kept = [];
  for (const h of sorted) {
    const last = kept[kept.length - 1];
    if (last && h.index < last.end) {
      if (h.end - h.index > last.end - last.index) kept[kept.length - 1] = h;
      continue;
    }
    kept.push(h);
  }
  return kept;
}

// Countries / regions outside Mexico and the US border states: an article set there that name-drops one
// Mexican state once is not a Mexican event.
const FOREIGN_RE = /\b(?:africa|nigeria|kenya|ghana|south africa|colombia|ecuador|peru|bolivia|venezuela|brazil|argentina|chile|paraguay|guatemala|honduras|el salvador|nicaragua|costa rica|panama|dominican republic|haiti|cuba|europe|spain|netherlands|belgium|italy|germany|france|portugal|turkey|china|hong kong|india|japan|australia|asia|canada|middle east|dubai|israel|jordan|new zealand|czech republic|czechia|prague)\b/g;

// "Nuevo Laredo–Monterrey highway" / "carretera Monterrey-Nuevo Laredo": the endpoints name the road, not the scene.
// Runs on the raw text: fold() strips the dash that marks the pair.
const ROUTE_W = '[a-z\\u00C0-\\u017F]+';
const ROUTE_RE = new RegExp(`\\b(?:carretera|autopista|tramo)\\s+${ROUTE_W}(?: ${ROUTE_W}){0,2}\\s?[-\\u2013\\u2014]\\s?${ROUTE_W}(?: ${ROUTE_W}){0,2}\\b|\\b${ROUTE_W}(?: ${ROUTE_W}){0,2}\\s?[-\\u2013\\u2014]\\s?${ROUTE_W}(?: ${ROUTE_W}){0,2}\\s+(?:highway|freeway|road|route|corridor)\\b`, 'gi');
function maskRoutes(s) { return String(s || '').replace(ROUTE_RE, m => ' '.repeat(m.length)); }

// Extract Mexican state / city / municipality mentions from free text.
// Returns { states: [{adm1,name,mentions}], places: [{...row, mentions}], municipalities: [...] }
export function findPlaces(text, gz = loadGazetteer()) {
  const t = maskCountry(fold(maskRoutes(text)));
  if (!t) return { states: [], places: [], municipalities: [], folded: '' };
  const locative = idx => LOCATIVE_RE.test(t.slice(Math.max(0, idx - 18), idx));
  const all = dropOverlaps([...scan(gz.stateRe, t, 'state'), ...scan(gz.placeRe, t, 'place'), ...scan(gz.muniRe, t, 'muni')]);
  // Identical spans matched as both place and municipality are kept in both categories.
  const spans = new Set(all.map(h => `${h.index}:${h.end}`));
  const hitsOf = (list, cat) => list.filter(h => h.cat === cat && spans.has(`${h.index}:${h.end}`));
  const stateHits = new Map();
  for (const h of hitsOf(scan(gz.stateRe, t, 'state'), 'state')) {
    const s = gz.stateKey.get(h.key);
    // "mexico" alone is the country far more often than the state; only count explicit forms.
    if (h.key === 'mexico') continue;
    const cur = stateHits.get(s.adm1) || { adm1: s.adm1, name: s.shortName, lat: s.lat, lon: s.lon, mentions: 0, first: h.index };
    cur.mentions++;
    stateHits.set(s.adm1, cur);
  }
  const stateSet = new Set(stateHits.keys());

  const placeHits = new Map();
  for (const h of hitsOf(scan(gz.placeRe, t, 'place'), 'place')) {
    const rows = gz.placeKey.get(h.key) || [];
    if (surnameLike(h.key) && !locative(h.index)) continue;
    let pick = rows.find(r => stateSet.has(r.adm1)) || null;
    if (!pick) {
      if (AMBIGUOUS.has(h.key) && !rows.some(r => r.viaAlias)) continue;
      pick = rows[0]; // most populous
    }
    const id = pick.id;
    const cur = placeHits.get(id) || { id, name: pick.name, adm1: pick.adm1, adm2: pick.adm2, lat: pick.lat, lon: pick.lon, pop: pick.pop, mentions: 0, first: h.index, stateContext: stateSet.has(pick.adm1) };
    cur.mentions++;
    placeHits.set(id, cur);
  }
  const muniHits = new Map();
  for (const h of hitsOf(scan(gz.muniRe, t, 'muni'), 'muni')) {
    const rows = gz.muniKey.get(h.key) || [];
    if (surnameLike(h.key) && !locative(h.index)) continue;
    // "Sinaloa" is the state; the municipality of the same name is only "Sinaloa de Leyva".
    if (gz.stateKey.has(h.key) && !(gz.placeKey.get(h.key) || []).some(p => p.adm2 === rows[0]?.adm2)) continue;
    const inState = rows.filter(r => stateSet.has(r.adm1));
    let pick = null;
    if (inState.length === 1) pick = inState[0];
    else if (inState.length === 0 && rows.length === 1 && !AMBIGUOUS.has(h.key) && locative(h.index)) pick = rows[0];
    if (!pick) continue;
    const cur = muniHits.get(pick.id) || { id: pick.id, name: pick.name, adm1: pick.adm1, adm2: pick.adm2, lat: pick.lat, lon: pick.lon, mentions: 0, first: h.index, stateContext: stateSet.has(pick.adm1) };
    cur.mentions++;
    muniHits.set(pick.id, cur);
  }
  // "Celaya, Guanajuato" names the state, not Guanajuato city: drop same-named capital/municipality rows
  // whenever a more specific place in that state was found.
  for (const hits of [placeHits, muniHits]) {
    for (const [id, h] of hits) {
      if (!gz.stateKey.has(fold(h.name))) continue;
      const other = [...placeHits.values(), ...muniHits.values()].some(o => o.adm1 === h.adm1 && !gz.stateKey.has(fold(o.name)));
      if (other) hits.delete(id);
    }
  }
  const rank = (a, b) => b.mentions - a.mentions || a.first - b.first;
  // The capital is where prosecutors and ministries speak from; when any other place is named, it is
  // almost never the scene.
  const places = [...placeHits.values()].sort(rank);
  if (places.length > 1) {
    const i = places.findIndex(p => p.adm1 === '09');
    if (i === 0) places.push(places.shift());
  }
  return {
    states: [...stateHits.values()].sort(rank),
    places,
    municipalities: [...muniHits.values()].sort(rank),
    foreign: (t.match(FOREIGN_RE) || []).length,
    folded: t,
  };
}

// Pick one location for an event: city > municipality > state, with a precision tag.
// Returns null when nothing in Mexico was recognised.
export function resolveLocation(found, gz = loadGazetteer()) {
  // An article set abroad (Ecuador sanctions, a lab in Nigeria) that mentions Mexico in passing has no Mexican scene.
  const munisOnly = found.municipalities.filter(m => !found.places.some(p => p.adm1 === m.adm1 && p.adm2 === m.adm2));
  const mx = [...found.states, ...found.places, ...munisOnly].reduce((n, h) => n + h.mentions, 0);
  const foreign = found.foreign || 0;
  if (foreign >= 6 && foreign >= 3 * mx) return null;
  let place = found.places[0] || null;
  const muni = found.municipalities[0] || null;
  const state = found.states[0] || null;
  let adm1 = null, precision = null, lat = null, lon = null, city = null, municipality = null;
  // A municipality named more often than any city ("Ojocaliente, Zacatecas" vs a passing "Aguascalientes") is the scene.
  // On a tie, a municipality inside the named state beats a city outside it.
  if (place && muni && !(muni.adm1 === place.adm1 && muni.adm2 === place.adm2) && (!state || muni.adm1 === state.adm1)
    && (muni.mentions > place.mentions || (muni.mentions === place.mentions && state && place.adm1 !== state.adm1))) place = null;
  if (place) {
    adm1 = place.adm1; lat = place.lat; lon = place.lon; city = place.name;
    // A bare "Chihuahua" / "Zacatecas" may be the state or its capital; flag the ambiguity.
    precision = gz.stateKey.has(fold(place.name)) && found.places.length === 1 && !found.municipalities.some(m => m.adm1 === place.adm1 && m.id !== place.id) ? 'capital-or-state' : 'city';
    municipality = gz.muniKey.get(fold(place.name))?.find(m => m.adm1 === place.adm1)?.name || null;
  } else if (muni) {
    adm1 = muni.adm1; precision = 'municipality'; lat = muni.lat; lon = muni.lon; municipality = muni.name;
  } else if (state) {
    if (state.mentions <= 1 && (found.foreign || 0) >= 3) return null;
    adm1 = state.adm1; precision = 'state'; lat = state.lat; lon = state.lon;
  } else {
    return null;
  }
  // If the top place is in a different state than the most-mentioned state, prefer the state's own place if one was found.
  if (place && state && place.adm1 !== state.adm1 && !place.stateContext) {
    const alt = found.places.find(p => p.adm1 === state.adm1) || found.municipalities.find(m => m.adm1 === state.adm1);
    if (alt) {
      adm1 = alt.adm1; lat = alt.lat; lon = alt.lon;
      if (alt.pop !== undefined) { precision = 'city'; city = alt.name; municipality = null; }
      else { precision = 'municipality'; city = null; municipality = alt.name; }
    } else if (place.mentions <= state.mentions) {
      // A city named once, in a state the article never mentions, is more likely a namesake elsewhere.
      adm1 = state.adm1; precision = 'state'; lat = state.lat; lon = state.lon; city = null; municipality = null;
    }
  }
  const st = gz.stateByAdm1.get(adm1);
  return { country: 'MX', adm1, state: st?.shortName || null, municipality, city, lat, lon, precision };
}

export function stateName(adm1, gz = loadGazetteer()) { return gz.stateByAdm1.get(String(adm1))?.shortName || null; }

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function resetForTests() { _cache = null; }
