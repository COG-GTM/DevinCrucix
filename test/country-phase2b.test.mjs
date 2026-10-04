// Phase 2b country sources: Bogotá localidad polygons, Defensoría SAT index, Indepaz tallies, the OVCS
// state / modality breakdown, exact country geocoding, armed-actor cards and their country-view wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactLocalidades, LOCALIDAD_NAMES, titleCase } from '../scripts/build-bogota-localidades.mjs';
import { countryLocalidades, countryConfig } from '../lib/countryconfig.mjs';
import { resolveDepartment, geocodeMunicipio } from '../lib/countrygeo.mjs';
import * as SAT from '../apis/sources/defensoriasat.mjs';
import * as IND from '../apis/sources/indepaz.mjs';
import { parseReports, parseReportBreakdown } from '../apis/sources/ovcs.mjs';
import { buildActorCards, MAX_CARDS } from '../lib/cjng/actors.mjs';
import { loadGroups } from '../lib/narco/groups.mjs';
import { PROFILES } from '../lib/cjng/profiles.mjs';
import { normalizeProfiles } from '../apis/sources/insightcrime.mjs';
import { buildCountryView, buildCountryGeo, trimSat, trimIndepaz } from '../lib/countryview.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => readFileSync(join(here, 'fixtures/country', f), 'utf8');
const LEADER_NAMES = /Burgos|Mojica|Guacheta|Yeison|Jhon Jairo/;

function satFixture() {
  const alerts = [...SAT.parseIndex(fx('sat-index-p1.html')).alerts, ...SAT.parseIndex(fx('sat-index-p2.html')).alerts];
  return SAT.buildResult({ alerts, pages: 19, pagesFetched: 2 }, '2026-10-03T12:00:00Z');
}
function indepazFixture() {
  const mp = JSON.parse(fx('indepaz-masacres.json')), lp = JSON.parse(fx('indepaz-lideres.json'));
  return IND.buildResult({ masacres: IND.parseMasacres(IND.pickPost(mp, /masacres/i)), lideres: IND.parseLideres(IND.pickPost(lp, /l[ií]deres/i)) }, '2026-10-03T12:00:00Z');
}
function ovcsFixture() {
  const r = parseReports(JSON.parse(fx('ovcs-reports.json')));
  return { source: 'OVCS', status: 'live', fetchedAt: '2026-10-03T12:00:00Z', monthly: r.monthly, latest: r.monthly[0], site: 'https://www.observatoriodeconflictos.org.ve/' };
}
function graphOf(key) {
  const snap = JSON.parse(gunzipSync(readFileSync(PROFILES[key].snapshotFile)).toString());
  return snap.graph || snap;
}

// --- Bogotá localidades ------------------------------------------------------------------------

test('localidades: ESRI rings from Datos Abiertos compact to 20 named units with centroids and attribution', () => {
  const raw = { spatialReference: { wkid: 4686 }, features: [
    { attributes: { LocCodigo: '01', LocNombre: 'USAQUEN', LocArea: 65310000 }, geometry: { rings: [[[-74.03, 4.70], [-74.02, 4.70], [-74.02, 4.72], [-74.03, 4.72], [-74.035, 4.71], [-74.03, 4.70]]] } },
    { attributes: { LocCodigo: '17', LocNombre: 'CANDELARIA', LocArea: 2060000 }, geometry: { rings: [[[-74.08, 4.59], [-74.07, 4.59], [-74.07, 4.60], [-74.08, 4.60], [-74.085, 4.595], [-74.08, 4.59]]] } },
  ] };
  const out = compactLocalidades(raw);
  assert.equal(out.units.length, 2);
  assert.deepEqual(out.units.map(u => u.name), ['Usaquén', 'La Candelaria']);
  assert.deepEqual(out.units.map(u => u.code), ['01', '17']);
  assert.ok(out.units[0].rings[0].length >= 4);
  assert.ok(Math.abs(out.units[0].centroid[0] + 74.025) < 0.02 && Math.abs(out.units[0].centroid[1] - 4.71) < 0.02);
  assert.ok(out.units[0].areaKm2 > 60 && out.units[0].areaKm2 < 70);
  assert.match(out.sourceUrl, /datosabiertos\.bogota\.gov\.co/);
  assert.match(out.crs, /4686/);
  assert.equal(Object.keys(LOCALIDAD_NAMES).length, 20);
  assert.equal(titleCase('RAFAEL URIBE URIBE'), 'Rafael Uribe Uribe');
});

test('localidades: the checked-in asset loads for co with all 20 localidades and is absent for ve', () => {
  const loc = countryLocalidades('co');
  assert.ok(loc, 'co localidad geometry should load');
  assert.equal(loc.units.length, 20);
  assert.deepEqual(new Set(loc.units.map(u => u.name)), new Set(Object.values(LOCALIDAD_NAMES)));
  for (const u of loc.units) {
    assert.ok(u.rings.length >= 1 && u.rings[0].length >= 5, `${u.name} rings`);
    assert.ok(u.centroid[0] > -74.6 && u.centroid[0] < -73.9 && u.centroid[1] > 3.7 && u.centroid[1] < 4.9, `${u.name} centroid in Bogotá D.C.`);
  }
  assert.equal(countryLocalidades('ve'), null);
  assert.equal(countryConfig('co').geo.localidadesFile, 'bog-localidades.json');
});

// --- geocoding ----------------------------------------------------------------------------------

test('countrygeo: exact municipio / department resolution with department fallback, no fuzzy matches', () => {
  const bagre = geocodeMunicipio('co', 'Antioquia', 'El Bagre');
  assert.equal(bagre.precision, 'municipality');
  assert.equal(bagre.iso, 'CO-ANT');
  assert.ok(bagre.lat > 7 && bagre.lat < 8.5 && bagre.lon < -74 && bagre.lon > -75.5);
  const bog = geocodeMunicipio('co', 'Bogotá D.C.', 'Bogotá D.C.');
  assert.equal(bog.precision, 'municipality');
  const fallback = geocodeMunicipio('co', 'Cauca', 'Not A Real Municipio');
  assert.equal(fallback.precision, 'department');
  assert.equal(fallback.department, 'Cauca');
  assert.equal(geocodeMunicipio('co', 'Narnia', 'Nowhere'), null);
  assert.equal(resolveDepartment('ve', 'Lara').iso, 'VE-K');
  assert.equal(resolveDepartment('ve', 'Distrito Capital').iso, 'VE-A');
  assert.equal(resolveDepartment('ve', 'Vargas').name, 'La Guaira');
  assert.equal(resolveDepartment('ve', 'Anzoategui').iso, 'VE-B');
  assert.equal(resolveDepartment('ve', 'Sucres'), null);
  assert.equal(resolveDepartment('CO', 'cauca').iso, 'CO-CAU');
});

// --- Defensoría SAT -----------------------------------------------------------------------------

test('SAT: index pages parse to bounded alert rows with id, type, places, theme, groups, ficha + PDF', () => {
  const p1 = SAT.parseIndex(fx('sat-index-p1.html')), p2 = SAT.parseIndex(fx('sat-index-p2.html'));
  assert.equal(p1.alerts.length, 20);
  assert.equal(p2.alerts.length, 20);
  const a = [...p1.alerts, ...p2.alerts].find(x => x.id === '023-26');
  assert.ok(a, 'alert 023-26 present');
  assert.equal(a.id, '023-26');
  assert.equal(a.year, 2026);
  assert.equal(a.type, 'structural');
  assert.equal(a.date, '2026-09-29');
  assert.deepEqual(a.departments, ['Valle del Cauca']);
  assert.deepEqual(a.municipalities, ['Jamundí']);
  assert.match(a.theme, /Estado Mayor Central/);
  assert.deepEqual(a.groups.map(g => g.short).sort(), ['ELN', 'EMC']);
  assert.equal(a.points[0].precision, 'municipality');
  assert.match(a.fichaUrl, /^https:\/\/alertastempranas\.defensoria\.gov\.co\/Alerta\/Details\/\d+$/);
  assert.match(a.pdfUrl, /023-26\.pdf$/);
  for (const x of p1.alerts) {
    assert.match(x.id, /^\d{3}-\d{2}$/);
    assert.ok(['structural', 'imminence'].includes(x.type), x.id);
    assert.ok(x.theme.length <= 400, 'theme is a one-line summary, not the alert body');
  }
  assert.deepEqual(SAT.TYPES, { estructural: 'structural', inminencia: 'imminence' });
  assert.deepEqual(SAT.parsePlaces('Cali y Jamundí (Valle del Cauca); Popayán, El Tambo (Cauca)'), [{ department: 'Valle del Cauca', municipalities: ['Cali', 'Jamundí'] }, { department: 'Cauca', municipalities: ['Popayán', 'El Tambo'] }]);
});

test('SAT: buildResult bounds to MAX_ALERTS, tallies the current year by type / department / group', () => {
  const r = satFixture();
  assert.equal(r.status, 'live');
  assert.equal(r.alerts.length, 40);
  assert.ok(r.alerts.length <= SAT.MAX_ALERTS);
  assert.equal(r.pagesFetched, 2);
  assert.equal(r.pagesTotal, 19);
  assert.deepEqual(r.ytd, { ...r.ytd, year: 2026, alerts: 23, byType: { structural: 7, imminence: 16 }, departments: 19 });
  assert.equal(r.ytd.topDepartments[0].name, 'Cauca');
  assert.ok(r.ytd.groups.some(g => g.short === 'ELN'));
  assert.equal(r.latest.id, '023-26');
  assert.ok(r.disclaimer.some(d => /PDF/.test(d)));
  const dates = r.alerts.map(a => a.date);
  assert.deepEqual(dates, dates.slice().sort().reverse(), 'newest first');
});

// --- Indepaz ------------------------------------------------------------------------------------

test('Indepaz: massacre rows and leader tallies parse as counts; malformed years are dropped; no names', () => {
  const r = indepazFixture();
  assert.equal(r.status, 'live');
  const m = r.masacres;
  assert.equal(m.latestYear, 2026);
  assert.deepEqual(m.years.map(y => [y.year, y.massacres, y.victims]), [[2026, 89, 336], [2025, 78, 256], [2024, 76, 267], [2023, 93, 300], [2022, 94, 300], [2021, 96, 338], [2020, 91, 378]]);
  assert.equal(m.rows.length, 89);
  for (const row of m.rows) {
    assert.match(row.date, /^20\d\d-\d\d-\d\d$/, `no phantom year in ${row.date}`);
    assert.ok(row.victims >= 3, 'Indepaz definition: three or more victims');
    assert.ok(!('names' in row) && !('victimsNamed' in row));
  }
  assert.equal(m.byDepartment[0].name, 'Antioquia');
  assert.equal(m.byMonth[0].month, '2026-01');
  const l = r.lideres;
  assert.deepEqual(l.years.map(y => [y.year, y.leaders, y.signatories]), [[2026, 108, 11], [2025, 187, 39], [2024, 172, 31]]);
  assert.equal(l.current.year, 2026);
  assert.equal(l.current.bySector[0].name, 'Comunal');
  assert.ok(l.current.byDepartment.length <= 12);
  assert.match(l.note, /no names|does not store/i);
  assert.doesNotMatch(JSON.stringify(r), LEADER_NAMES, 'leader names from the source tables must not survive into the payload');
  const html = fx('indepaz-lideres.json');
  assert.match(html, LEADER_NAMES, 'fixture really contains names (so the test above proves something)');
});

test('Indepaz: pickPost tolerates missing posts and parseTables yields rows', () => {
  assert.equal(IND.pickPost([], /masacres/i), null);
  const mp = JSON.parse(fx('indepaz-masacres.json'));
  const tables = IND.parseTables(IND.pickPost(mp, /masacres/i).content.rendered);
  assert.ok(tables.length >= 1 && tables[0].rows.length > 10);
  assert.deepEqual(tables[0].headers.slice(0, 4), ['#', 'fecha', 'departamento', 'municipio']);
});

// --- OVCS breakdown -----------------------------------------------------------------------------

test('OVCS: monthly reports gain a partial state ranking, modalities and repression counts', () => {
  const r = parseReports(JSON.parse(fx('ovcs-reports.json')));
  const aug = r.monthly.find(m => m.month === '2026-08');
  assert.ok(aug, 'August 2026 report present');
  assert.equal(aug.protests, 652);
  const top = aug.byState.filter(b => b.rank === 'top'), bottom = aug.byState.filter(b => b.rank === 'bottom');
  assert.deepEqual(top.slice(0, 4).map(b => [b.state, b.n]), [['Lara', 70], ['Anzoátegui', 68], ['Miranda', 60], ['Sucre', 59]]);
  assert.deepEqual(bottom.map(b => b.state), ['Delta Amacuro', 'Trujillo', 'Amazonas', 'Apure', 'Portuguesa']);
  for (const b of aug.byState) assert.match(b.iso, /^VE-[A-Z]$/, `${b.state} validated against the gazetteer`);
  assert.ok(aug.byState.length < 24, 'partial ranking, never a full table');
  assert.deepEqual(aug.modalities[0], { kind: 'concentraciones', n: 394, pct: 60 });
  assert.equal(aug.abuseComplaints, 14);
  assert.equal(aug.repressedStates, 5);
  assert.equal(aug.repressed, 9);
  const empty = parseReportBreakdown('<p>Sin datos por estado.</p>');
  assert.deepEqual(empty, { byState: [], modalities: [], abuseComplaints: null, repressedStates: null });
  const bogus = parseReportBreakdown('<p>Narnia con 99 protestas fue el estado con más protestas.</p>');
  assert.equal(bogus.byState.length, 0, 'unknown states are dropped, not invented');
});

// --- actor cards --------------------------------------------------------------------------------

test('actors: country group index joins the InSight Crime graph and profile cards, bounded and sorted', () => {
  const profiles = normalizeProfiles(JSON.parse(fx('insightcrime-colombia-groups.json')));
  const r = buildActorCards(graphOf('co'), loadGroups(PROFILES.co.groupsFile), profiles);
  assert.ok(r.count >= 20 && r.cards.length <= MAX_CARDS);
  assert.ok(r.inGraph >= 20, `most configured groups appear in the graph (${r.inGraph})`);
  assert.ok(r.withProfile >= 8, `InSight Crime profiles attach by name / acronym (${r.withProfile})`);
  const eln = r.cards.find(c => c.id === 'eln');
  assert.ok(eln.graph.articles > 100 && eln.graph.degree > 10);
  assert.match(eln.profileUrl, /eln-profile/);
  assert.equal(eln.usDesignation, 'FTO (1997-10-08)');
  for (const c of r.cards) {
    assert.ok(c.graph === null || c.graph.relations.length <= 4);
    for (const rel of c.graph?.relations || []) assert.ok(['allied with', 'rival of', 'operates in', 'lineage'].includes(rel.label));
    assert.ok(c.leaders.length <= 4);
  }
  const arts = r.cards.map(c => c.graph?.articles || 0);
  assert.deepEqual(arts, arts.slice().sort((a, b) => b - a), 'sorted by graph article count');
  assert.equal(r.extractor, 'insight-rules/2');
  const bare = buildActorCards(null, loadGroups(PROFILES.ve.groupsFile), []);
  assert.equal(bare.inGraph, 0);
  assert.ok(bare.count > 0 && bare.cards.every(c => c.graph === null && c.profileUrl === null));
});

// --- country view / geo integration -------------------------------------------------------------

test('country view: Colombia carries SAT and Indepaz trims, hero tiles and runtime rows', () => {
  const sources = { DefensoriaSAT: satFixture(), Indepaz: indepazFixture() };
  const co = buildCountryView('co', sources);
  assert.equal(co.sat.status, 'live');
  assert.equal(co.sat.alerts.length, 40);
  assert.equal(co.sat.ytd.alerts, 23);
  assert.equal(co.indepaz.masacres.rows.length, 89);
  assert.equal(co.indepaz.lideres.current.leaders, 108);
  const keys = co.hero.map(h => h.key);
  assert.ok(keys.includes('sat') && keys.includes('massacres') && keys.includes('leaders'));
  assert.equal(co.hero.find(h => h.key === 'sat').value, 23);
  assert.equal(co.hero.find(h => h.key === 'sat').kind, 'official');
  assert.equal(co.hero.find(h => h.key === 'massacres').kind, 'observational');
  assert.equal(co.sourceRows.find(r => r.name === 'DefensoriaSAT').status, 'live');
  assert.equal(co.sourceRows.find(r => r.name === 'Indepaz').status, 'live');
  assert.equal(co.geo.localidades.units, 20);
  assert.doesNotMatch(JSON.stringify(co), LEADER_NAMES);
  const ve = buildCountryView('ve', sources);
  assert.equal(ve.sat, null);
  assert.equal(ve.indepaz, null);
  assert.equal(ve.geo.localidades, null);
  assert.equal(trimSat(null), null);
  assert.equal(trimIndepaz(undefined), null);
  const missing = buildCountryView('co', {});
  assert.equal(missing.sat, null);
  assert.equal(missing.sourceRows.find(r => r.name === 'DefensoriaSAT').status, 'error');
  assert.equal(missing.hero.find(h => h.key === 'sat').value, null);
});

test('country geo: Colombia adds localidad polygons, SAT alert points and massacre points; Venezuela shades the OVCS-named states only', () => {
  const sources = { DefensoriaSAT: satFixture(), Indepaz: indepazFixture(), OVCS: ovcsFixture() };
  const co = buildCountryGeo('co', sources);
  assert.equal(co.localidades.count, 20);
  assert.equal(co.localidades.values.metric, 'mentions');
  assert.match(co.localidades.values.note, /No official per-localidad/);
  assert.ok(co.localidades.units.every(u => Number.isInteger(u.mentions) && u.rings.length >= 1));
  assert.equal(co.alerts.kind, 'official');
  assert.ok(co.alerts.count >= 40 && co.alerts.points.length <= 200);
  assert.ok(co.alerts.points.every(p => p.type === 'sat-alert' && /^\d{3}-\d{2}$/.test(p.id) && Number.isFinite(p.lat)));
  assert.equal(co.massacres.kind, 'observational');
  assert.equal(co.massacres.count, 89);
  assert.ok(co.massacres.points.every(p => p.type === 'massacre' && p.victims >= 3 && !('names' in p)));
  assert.ok(JSON.stringify(co).length < 400000, 'geo payload stays bounded');
  const ve = buildCountryGeo('ve', sources);
  assert.equal(ve.localidades, null);
  assert.equal(ve.alerts, null);
  assert.equal(ve.massacres, null);
  assert.equal(ve.values.kind, 'observational');
  assert.equal(ve.values.partial, true);
  assert.equal(ve.values.month, '2026-08');
  assert.equal(ve.values.byIso['VE-K'], 70);
  assert.ok(Object.keys(ve.values.byIso).length < 20, 'only the named states are shaded');
  const bare = buildCountryGeo('ve', {});
  assert.equal(bare.values, null);
});

test('fixtures present', () => {
  for (const f of ['sat-index-p1.html', 'sat-index-p2.html', 'indepaz-masacres.json', 'indepaz-lideres.json', 'ovcs-reports.json']) assert.ok(existsSync(join(here, 'fixtures/country', f)), f);
});
