// Border / CBP portal adapters (CBPSeizures, CBPForce, CBPCustody) — unit tests against recorded
// CSV/HTML samples (no network). The shared fetch/cache/status machinery lives in cbpcommon.mjs
// and is exercised end-to-end in cbpstats.test.mjs; here we cover what is new per adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { csvRecords, headerMatches, discoverCsvUrl, htmlSections, tableAfterHeading, tablesAfterHeading, SW_SECTORS } from '../apis/sources/cbpcommon.mjs';
import * as seizures from '../apis/sources/cbpseizures.mjs';
import * as force from '../apis/sources/cbpforce.mjs';
import * as custody from '../apis/sources/cbpcustody.mjs';
import { resetRobotsCacheForTests, CRAWLER_UA } from '../apis/utils/robots.mjs';
import { classifySource } from '../lib/sourcehealth.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cbp');
const read = f => readFileSync(join(FIX, f), 'utf8');
const CSV = {
  amo: read('amo-drug-seizures-sample.csv'),
  currency: read('currency-seizures-sample.csv'),
  weapons: read('weapons-ammunition-seizures-sample.csv'),
  assaults: read('assault-incidents-sample.csv'),
  assaultTypes: read('assault-types-sample.csv'),
  uof: read('use-of-force-incidents-sample.csv'),
  uofTypes: read('use-of-force-types-sample.csv'),
};
const PAGE = {
  amo: read('document-stats-amo-drug-seizures.html'),
  currency: read('document-stats-currency-and-other-monetary-instrument-seizures.html'),
  weapons: read('document-stats-weapons-and-ammunition-seizures.html'),
  assaults: read('document-stats-assault-incidents-and-officersagents-assaulted.html'),
  assaultTypes: read('document-stats-assault-types.html'),
  uof: read('document-stats-use-force-incidents-and-officersagents-using-force.html'),
  uofTypes: read('document-stats-use-force-type.html'),
};
const CUSTODY_PAGE = read('newsroom-stats-custody-and-transfer-statistics.html');
const ENFORCEMENT_PAGE = read('newsroom-stats-cbp-enforcement-statistics.html');
const ROBOTS = 'User-agent: *\nDisallow: /core/\nDisallow:  /sites/default/files/assets/documents/\n';

function res(status, body = '', headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: k => h.get(k.toLowerCase()) ?? null }, text: async () => body };
}
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    for (const [needle, handler] of routes) if (url.includes(needle)) return typeof handler === 'function' ? handler(url, opts) : handler;
    return res(404, 'not found');
  };
  fn.calls = calls;
  return fn;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'crucix-cbpportal-'));
const rec = id => csvRecords(CSV[id]).records;
const NOW = Date.parse('2026-09-11T16:00:00Z');

// --- headers / discovery -------------------------------------------------------------------

test('recorded CBP headers match exactly what each adapter expects', () => {
  for (const [id, ds] of Object.entries(seizures.DATASETS)) assert.ok(headerMatches(csvRecords(CSV[id]).header, ds.expectedHeader), id);
  for (const [id, ds] of Object.entries(force.DATASETS)) assert.ok(headerMatches(csvRecords(CSV[id]).header, ds.expectedHeader), id);
  assert.ok(!headerMatches(['FY', 'Month (abbv)', 'Component'], seizures.DATASETS.amo.expectedHeader));
});

test('discoverCsvUrl picks the newest file on each discovery page', () => {
  const expect = {
    amo: '2026-08/amo-drug-seizures-fy23-fy26-jul.csv',
    currency: '2026-08/currency-seizures-fy23-fy26-jul.csv',
    weapons: '2026-08/weapons-ammunition-seizures-fy23-fy26-jul.csv',
    assaults: '2026-08/assault-incidents-officer-agent-fy23-fy26-jul.csv',
    assaultTypes: '2026-08/assault-types-fy23-fy26-jul.csv',
    uof: '2026-08/use-of-force-incidents-officer-agent-fy23-fy26-jul.csv',
    uofTypes: '2026-08/use-of-force-types-fy23-fy26-jul.csv',
  };
  for (const [id, ds] of [...Object.entries(seizures.DATASETS), ...Object.entries(force.DATASETS)]) {
    assert.equal(discoverCsvUrl(PAGE[id], ds), `https://www.cbp.gov/sites/default/files/${expect[id]}`, id);
    assert.equal(discoverCsvUrl(PAGE[id], ds), ds.fallbackUrl, `${id} fallback is the verified current file`);
  }
  // older-month pages sort below the newest directory, no match returns null
  assert.equal(discoverCsvUrl('<a href="/sites/default/files/2025-01/amo-drug-seizures-fy22-fy25-dec.csv">x</a><a href="/sites/default/files/2026-03/amo-drug-seizures-fy23-fy26-feb.csv">y</a>', seizures.DATASETS.amo),
    'https://www.cbp.gov/sites/default/files/2026-03/amo-drug-seizures-fy23-fy26-feb.csv');
  assert.equal(discoverCsvUrl(PAGE.amo, seizures.DATASETS.currency), null);
});

// --- CBPSeizures -----------------------------------------------------------------------------

test('summarizeAmo: nationwide lbs/events, Southwest share, per-drug series, regions and branches', () => {
  const s = seizures.summarizeAmo(rec('amo'));
  assert.equal(s.latest.period, '2026-07');
  assert.equal(s.latest.label, 'Jul 2026');
  assert.equal(s.latest.events, 65);
  assert.equal(s.latest.lbs, 8737.1);
  assert.equal(s.latest.swLbs, 411.4);
  assert.equal(s.latest.momLbsPct, 42.8);
  assert.equal(s.series.length, 13);
  assert.equal(s.series.at(-1).period, '2026-07');
  const fent = s.drugs.find(d => d.type === 'Fentanyl');
  assert.deepEqual(fent.latest, { events: 20, lbs: 108 });
  assert.equal(fent.series.length, 13);
  assert.deepEqual(s.regions.map(r => r.region), ['Coastal/Interior', 'Southwest Border', 'Northern Border']);
  assert.equal(s.regions[1].lbs, 411.4);
  assert.equal(s.branches[0].branch, 'NASOC - Jacksonville');
  assert.deepEqual(s.coverage, { first: '2024-10', last: '2026-07', months: 22 });
});

test('summarizeCurrency: USD + events nationwide and Southwest, direction, component, top AORs', () => {
  const s = seizures.summarizeCurrency(rec('currency'));
  assert.equal(s.latest.period, '2026-07');
  assert.equal(s.latest.events, 201);
  assert.equal(s.latest.usd, 3550403);
  assert.equal(s.latest.swEvents, 65);
  assert.equal(s.latest.swUsd, 1100394);
  assert.equal(s.latest.yoyUsdPct, 24.3);
  assert.deepEqual(s.direction.map(d => d.key), ['Outbound', 'Inbound', 'Other']);
  assert.equal(s.direction[0].usd + s.direction[1].usd + s.direction[2].usd, s.latest.usd);
  assert.equal(s.components[0].key, 'Office of Field Operations');
  assert.deepEqual(s.byAor[0], { aor: 'Boston Field Office', region: 'Northern Border', events: 43, usd: 762793 });
  assert.equal(s.series.length, 13);
});

test('summarizeWeapons: one event per Event ID, weapons vs ammo/parts quantities, direction, mode, category, AORs', () => {
  const records = rec('weapons');
  const s = seizures.summarizeWeapons(records);
  assert.ok(records.length > new Set(records.map(r => r['Event ID'])).size, 'fixture repeats Event IDs across category rows');
  const julRows = records.filter(r => /^2026/.test(r['Fiscal Year']) && r['Month (abbv)'] === 'JUL');
  assert.ok(julRows.length > new Set(julRows.map(r => r['Event ID'])).size, 'latest month has multi-row events');
  assert.equal(s.latest.events, new Set(julRows.map(r => r['Event ID'])).size);
  assert.equal(s.latest.events, 315);
  assert.equal(s.latest.swEvents, 55);
  assert.equal(s.latest.weapons, 2626);
  assert.equal(s.latest.ammoParts, 134342);
  assert.equal(s.latest.outboundEvents, 61);
  assert.equal(s.direction.reduce((a, d) => a + d.events, 0), 315);
  assert.equal(s.modes.reduce((a, d) => a + d.events, 0), 315);
  assert.deepEqual(s.categories.slice(0, 2).map(c => c.key), ['Other Ammunition & Gun Parts', 'Ammunition']);
  assert.equal(s.byAor[0].aor, 'Chicago Field Office');
  assert.deepEqual(s.swByAor[0], { aor: 'Laredo Field Office', component: 'Office of Field Operations', events: 15, outboundEvents: 10, weapons: 40, ammoParts: 2287 });
  assert.equal(s.series.at(-1).events, 315);
});

test('CBPSeizures briefing: discovery -> robots -> conditional download -> cache; one dataset down -> partial + stale copy', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const happy = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/amo-drug-seizures', res(200, PAGE.amo)],
    ['/document/stats/currency-and-other', res(200, PAGE.currency)],
    ['/document/stats/weapons-and-ammunition', res(200, PAGE.weapons)],
    ['/amo-drug-seizures-fy23-fy26-jul.csv', res(200, CSV.amo, { ETag: '"a1"' })],
    ['/currency-seizures-fy23-fy26-jul.csv', res(200, CSV.currency, { ETag: '"c1"' })],
    ['/weapons-ammunition-seizures-fy23-fy26-jul.csv', res(200, CSV.weapons, { 'Last-Modified': 'Fri, 22 Aug 2026 14:00:00 GMT' })],
  ]);
  const out = await seizures.briefing({ fetch: happy, dataDir, now: NOW });
  assert.equal(out.source, 'CBPSeizures');
  assert.equal(out.status, 'live');
  assert.equal(out.pipelineVersion, seizures.PIPELINE_VERSION);
  assert.match(out.attribution, /not endorsed by CBP/);
  assert.deepEqual(out.datasets.map(d => [d.id, d.status, d.discovered, d.rows]), [['amo', 'ok', true, 720], ['currency', 'ok', true, 929], ['weapons', 'ok', true, 1932]]);
  assert.equal(out.amo.latest.lbs, 8737.1);
  assert.equal(out.currency.latest.usd, 3550403);
  assert.equal(out.weapons.latest.events, 315);
  assert.ok(happy.calls.every(c => c.headers['User-Agent'] === CRAWLER_UA));
  assert.ok(existsSync(join(dataDir, 'amo-drugs.csv')) && existsSync(join(dataDir, 'state-seizures.json')));
  assert.ok(!existsSync(join(dataDir, 'state.json')), 'does not share the CBPStats state file');
  assert.equal(classifySource('CBPSeizures', out).state, 'live');

  // second sweep: 304 on two, weapons HTTP 503 -> partial, stale weapons from cache
  const second = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/', (url) => res(200, url.includes('amo') ? PAGE.amo : url.includes('currency') ? PAGE.currency : PAGE.weapons)],
    ['/amo-drug-seizures-fy23-fy26-jul.csv', (u, o) => (o.headers['If-None-Match'] === '"a1"' ? res(304) : res(500))],
    ['/currency-seizures-fy23-fy26-jul.csv', (u, o) => (o.headers['If-None-Match'] === '"c1"' ? res(304) : res(500))],
    ['/weapons-ammunition-seizures-fy23-fy26-jul.csv', (u, o) => (o.headers['If-Modified-Since'] ? res(503) : res(500))],
  ]);
  const out2 = await seizures.briefing({ fetch: second, dataDir, now: NOW + 3_600_000 });
  assert.equal(out2.status, 'partial');
  assert.deepEqual(out2.datasets.map(d => [d.id, d.status, d.httpStatus]), [['amo', 'not_modified', 304], ['currency', 'not_modified', 304], ['weapons', 'stale', 503]]);
  assert.equal(out2.weapons.latest.events, 315, 'stale copy still summarized');
  assert.equal(out2.error, undefined);
  assert.equal(classifySource('CBPSeizures', out2).state, 'degraded');

  // cold cache + CBP down -> error, no fabricated numbers
  resetRobotsCacheForTests();
  const down = mockFetch([['/robots.txt', res(200, ROBOTS)]]);
  const out3 = await seizures.briefing({ fetch: down, dataDir: tmp(), now: NOW });
  assert.equal(out3.status, 'error');
  assert.deepEqual([out3.amo, out3.currency, out3.weapons], [null, null, null]);
  assert.match(out3.error, /amo: HTTP 404; currency: HTTP 404; weapons: HTTP 404/);
  assert.equal(classifySource('CBPSeizures', out3).state, 'error');
});

test('CBPSeizures briefing refuses a CSV whose header changed', async () => {
  resetRobotsCacheForTests();
  const f = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/', res(200, '')],
    ['/amo-drug-seizures-fy23-fy26-jul.csv', res(200, CSV.amo.replace('Sum Qty (lbs)', 'Sum Qty (kg)'))],
    ['/currency-seizures-fy23-fy26-jul.csv', res(200, CSV.currency)],
    ['/weapons-ammunition-seizures-fy23-fy26-jul.csv', res(200, CSV.weapons)],
  ]);
  const out = await seizures.briefing({ fetch: f, dataDir: tmp(), now: NOW });
  assert.equal(out.status, 'partial');
  assert.equal(out.datasets[0].status, 'error');
  assert.match(out.datasets[0].reason, /unexpected header/);
  assert.equal(out.datasets[0].discovered, false, 'empty discovery page -> fallback URL');
  assert.equal(out.amo, null);
  assert.ok(out.currency && out.weapons);
});

// --- CBPForce --------------------------------------------------------------------------------

test('summarizeIncidents: distinct Unique ID per incident, summed officers, Southern Border cut, sector table, FYTD', () => {
  const records = rec('assaults');
  const s = force.summarizeIncidents(records);
  assert.ok(records.length > new Set(records.map(r => r['Unique ID'])).size, 'fixture repeats Unique IDs per officer');
  const jul = records.filter(r => /^2026/.test(r['Fiscal Year']) && r['Month (abbv)'] === 'JUL');
  assert.equal(s.latest.incidents, new Set(jul.map(r => r['Unique ID'])).size);
  assert.equal(s.latest.officers, jul.reduce((a, r) => a + Number(r['Count of Officers/Agents']), 0));
  assert.equal(s.latest.incidents, 20);
  assert.equal(s.latest.officers, 24);
  assert.equal(s.latest.southernIncidents, 18);
  assert.equal(s.latest.momPct, -9.1);
  assert.deepEqual(s.fytd, { incidents: 455, officers: 1294 });
  assert.equal(s.series.length, 13);
  assert.equal(s.series[0].label, 'Jul 2025');
  assert.deepEqual(s.components.map(c => [c.key, c.incidents]), [['U.S. Border Patrol', 14], ['Office of Field Operations', 6]]);
  assert.equal(s.sectors.length, SW_SECTORS.length);
  assert.deepEqual(s.sectors[0], { ...SW_SECTORS.find(x => x.sector === 'Tucson'), latest: 3, previous: s.sectors[0].previous, yoyPct: 50, fytd: 36, series: s.sectors[0].series });
  assert.ok(s.sectors.every(x => typeof x.lat === 'number' && x.series.length === 13), 'sectors carry lat/lon for the map');

  const u = force.summarizeIncidents(rec('uof'));
  assert.equal(u.latest.incidents, 43);
  assert.equal(u.latest.officers, 59);
  assert.equal(u.fytd.incidents, 640);
});

test('summarizeTypes: latest-month and FYTD breakdown by assault / force type', () => {
  const a = force.summarizeTypes(rec('assaultTypes'), 'Assault Type Used by Subject');
  assert.equal(a.latest.label, 'Jul 2026');
  assert.deepEqual(a.types.slice(0, 3).map(t => [t.type, t.latest, t.fytd]), [['Physical Assault', 13, 235], ['Rock or Other Thrown Projectile', 4, 116], ['Vehicle or Vessel', 3, 116]]);
  const f = force.summarizeTypes(rec('uofTypes'), 'Force Type');
  assert.deepEqual(f.types.map(t => [t.type, t.latest, t.fytd]), [['Vehicle/Vessel', 24, 272], ['Less-Lethal', 11, 305], ['Other', 8, 100], ['Firearm', 1, 13]]);
  assert.equal(force.summarizeTypes([], 'Force Type'), null);
});

test('CBPForce briefing: four datasets, own state file, robots disallow blocks every download', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const f = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/assault-incidents', res(200, PAGE.assaults)],
    ['/document/stats/assault-types', res(200, PAGE.assaultTypes)],
    ['/document/stats/use-force-incidents', res(200, PAGE.uof)],
    ['/document/stats/use-force-type', res(200, PAGE.uofTypes)],
    ['/assault-incidents-officer-agent-', res(200, CSV.assaults)],
    ['/assault-types-', res(200, CSV.assaultTypes)],
    ['/use-of-force-incidents-officer-agent-', res(200, CSV.uof)],
    ['/use-of-force-types-', res(200, CSV.uofTypes)],
  ]);
  const out = await force.briefing({ fetch: f, dataDir, now: NOW });
  assert.equal(out.source, 'CBPForce');
  assert.equal(out.status, 'live');
  assert.deepEqual(out.datasets.map(d => [d.id, d.status, d.discovered, d.rows]), [['assaults', 'ok', true, 936], ['assaultTypes', 'ok', true, 1122], ['uof', 'ok', true, 1310], ['uofTypes', 'ok', true, 1385]]);
  assert.equal(out.assaults.latest.incidents, 20);
  assert.equal(out.assaultTypes.types[0].type, 'Physical Assault');
  assert.equal(out.useOfForce.latest.incidents, 43);
  assert.equal(out.forceTypes.types[0].type, 'Vehicle/Vessel');
  assert.ok(existsSync(join(dataDir, 'state-force.json')));
  assert.equal(classifySource('CBPForce', out).state, 'live');

  resetRobotsCacheForTests();
  const disallow = mockFetch([['/robots.txt', res(200, 'User-agent: *\nDisallow: /sites/default/files/\n')], ['/document/stats/', res(200, PAGE.assaults)]]);
  const blocked = await force.briefing({ fetch: disallow, dataDir: tmp(), now: NOW });
  assert.equal(blocked.status, 'error');
  assert.deepEqual(blocked.datasets.map(d => d.reason), ['robots-disallowed', 'robots-disallowed', 'robots-disallowed', 'robots-disallowed']);
  assert.ok(!disallow.calls.some(c => c.url.endsWith('.csv')));
});

// --- CBPCustody (HTML tables) ----------------------------------------------------------------

test('htmlSections / tableAfterHeading locate CBP tables by the heading that precedes them', () => {
  const s = htmlSections(CUSTODY_PAGE);
  assert.ok(s.some(x => x.type === 'heading') && s.some(x => x.type === 'table'));
  const t = tableAfterHeading(s, /USBP Average Daily Subjects In Custody by Southwest Border Sector/i);
  assert.equal(t[0][0], 'Sector');
  assert.match(t[0][1], /^[A-Z][a-z]{2}-\d{2}$/);
  assert.equal(t.at(-1)[0], 'Total');
  assert.equal(tableAfterHeading(s, /No Such Heading/), null);
  const tsds = tablesAfterHeading(htmlSections(ENFORCEMENT_PAGE), /^CBP TSDS Encounters at and Between Land Ports of Entry/i);
  assert.equal(tsds.length, 2, 'two TSDS tables (OFO at POE, USBP between POE) follow one heading');
});

test('parseMonthlyTable / parseFiscalYearTable: future months are null, partial FY flagged, sub-heading rows kept as section', () => {
  const m = custody.parseMonthlyTable([['Sector', 'Oct-25', 'Nov-25', 'Dec-25'], ['Yuma', '8', '1,234', '-'], ['Total', '562', '617', '-']]);
  assert.deepEqual(m.periods, ['2025-10', '2025-11', '2025-12']);
  assert.equal(m.latest, '2025-11');
  assert.equal(m.latestLabel, 'Nov 2025');
  assert.deepEqual(m.rows[0], { key: 'Yuma', latest: 1234, previous: 8, momPct: 15325, series: [{ period: '2025-10', value: 8 }, { period: '2025-11', value: 1234 }] });
  assert.equal(custody.parseMonthlyTable([['Sector', 'Q1', 'Q2'], ['Yuma', '1', '2']]), null, 'non-month columns refused');

  const f = custody.parseFiscalYearTable([['Rescues', 'FY24', 'FY25', 'FY26 thru July'], ['Subtitle spanning row'], ['USBP Southwest Border', '5,420', '2,255', '1,128']]);
  assert.deepEqual(f.columns.map(c => [c.fy, c.partial]), [[2024, false], [2025, false], [2026, true]]);
  assert.equal(f.latest.label, 'FY26 thru July');
  assert.equal(f.lastFull.label, 'FY25');
  assert.deepEqual(f.rows[0], { key: 'USBP Southwest Border', section: 'Subtitle spanning row', latest: 1128, lastFull: 2255, priorFull: 5420, values: [5420, 2255, 1128] });
  assert.equal(custody.parseFiscalYearTable([['X', 'CY2024'], ['a', '1']]), null);
});

test('summarizeCustody: in-custody by sector, dispositions, transfers, OFO capacity from the published months only', () => {
  const c = custody.summarizeCustody(CUSTODY_PAGE);
  assert.equal(c.period, '2026-07');
  assert.equal(c.label, 'Jul 2026');
  assert.equal(c.inCustody.total.latest, 884);
  assert.equal(c.inCustody.total.momPct, -3.2);
  assert.equal(c.inCustody.total.series.length, 10, 'Oct-25 .. Jul-26; Aug/Sep unpublished');
  assert.deepEqual(c.inCustody.sectors.slice(0, 3).map(s => [s.sector, s.latest]), [['Rio Grande Valley', 377], ['Laredo', 131], ['San Diego', 123]]);
  assert.ok(c.inCustody.sectors.every(s => SW_SECTORS.some(d => d.sector === s.sector)), 'sector names align with SW_SECTORS for the map');
  assert.deepEqual(c.dispositions.total, { latest: 9295, momPct: -5.7 });
  assert.equal(c.dispositions.rows[0].key, 'Expedited Removal (ER)');
  assert.equal(c.dispositions.rows[0].share, 54.2);
  assert.ok(c.dispositions.rows.every(r => r.latest > 0), 'zero rows (NTA-OR, MPP, ...) dropped');
  assert.deepEqual(c.transfers.total, { latest: 8384, momPct: -12.7 });
  assert.deepEqual(c.ofo, { period: '2026-07', label: 'Jul 2026', capacity: 902, inCustody: 57, pct: 6.32 });
});

test('summarizeEnforcement: FY tables for enforcement actions, rescues, criminal noncitizens, gangs, TSDS', () => {
  const e = custody.summarizeEnforcement(ENFORCEMENT_PAGE);
  assert.equal(e.asOf.label, 'FY26 thru July');
  assert.equal(e.asOf.partial, true);
  assert.equal(e.lastFull.label, 'FY25');
  assert.deepEqual(e.enforcement.rows.at(-1), { key: 'Total Enforcement Encounters', latest: 314440, lastFull: 691906, priorFull: 2901142, yoyFullPct: -76.2 });
  assert.deepEqual(e.rescues.rows.map(r => [r.key, r.latest, r.lastFull]), [['USBP Southwest Border', 1128, 2255], ['AMO Nationwide', 55, 78]]);
  assert.equal(e.criminalNoncitizens.ofo[1].key, 'NCIC Arrests');
  assert.equal(e.criminalNoncitizens.usbp[0].latest, 6721);
  assert.equal(e.gangs.total.latest, 398);
  assert.equal(e.gangs.rows[0].key, 'Paisas');
  assert.equal(e.gangs.rows.at(-1).key, 'Other', '"Other" sorts last');
  assert.ok(e.gangs.rows.some(r => r.key === 'Tren de Aragua'));
  assert.equal(e.tsds.length, 2);
  assert.match(e.tsds[0].label, /Office of Field Operations/);
  assert.deepEqual(e.tsds[0].rows.find(r => r.key === 'Total'), { key: 'Total', latest: 10310, lastFull: 4011, priorFull: 410 });
  assert.match(e.tsds[1].label, /Border Patrol/);
  assert.deepEqual(e.tsds[1].pctOfEncounters, { latest: 0.0928, lastFull: 0.0287 });
});

test('CBPCustody briefing: HTML pages validated by layout; drifted layout -> error (stale copy served), 304 -> not_modified', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const f = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/newsroom/stats/custody-and-transfer-statistics', res(200, CUSTODY_PAGE, { ETag: '"h1"' })],
    ['/newsroom/stats/cbp-enforcement-statistics', res(200, ENFORCEMENT_PAGE, { ETag: '"h2"' })],
  ]);
  const out = await custody.briefing({ fetch: f, dataDir, now: NOW });
  assert.equal(out.source, 'CBPCustody');
  assert.equal(out.status, 'live');
  assert.deepEqual(out.datasets.map(d => [d.id, d.kind, d.status, d.httpStatus]), [['custody', 'html', 'ok', 200], ['enforcement', 'html', 'ok', 200]]);
  assert.equal(out.custody.inCustody.total.latest, 884);
  assert.equal(out.enforcement.gangs.total.latest, 398);
  assert.ok(f.calls.every(c => c.headers['User-Agent'] === CRAWLER_UA));
  assert.ok(existsSync(join(dataDir, 'custody-and-transfer.html')) && existsSync(join(dataDir, 'state-custody.json')));
  assert.equal(classifySource('CBPCustody', out).state, 'live');

  const drifted = CUSTODY_PAGE.replace('USBP Average Daily Subjects In Custody by Southwest Border Sector', 'USBP Daily Custody (new layout)');
  const f2 = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/newsroom/stats/custody-and-transfer-statistics', res(200, drifted, { ETag: '"h1b"' })],
    ['/newsroom/stats/cbp-enforcement-statistics', (u, o) => (o.headers['If-None-Match'] === '"h2"' ? res(304) : res(500))],
  ]);
  const out2 = await custody.briefing({ fetch: f2, dataDir, now: NOW + 3_600_000 });
  assert.equal(out2.status, 'partial');
  assert.deepEqual(out2.datasets.map(d => [d.id, d.status, d.httpStatus]), [['custody', 'stale', 200], ['enforcement', 'not_modified', 304]]);
  assert.match(out2.datasets[0].reason, /in-custody-by-sector table not found/);
  assert.equal(out2.custody.inCustody.total.latest, 884, 'last good copy still served, flagged stale');

  resetRobotsCacheForTests();
  const cold = await custody.briefing({ fetch: mockFetch([['/robots.txt', res(200, ROBOTS)], ['/newsroom/stats/', res(200, drifted)]]), dataDir: tmp(), now: NOW });
  assert.equal(cold.status, 'error');
  assert.equal(cold.custody, null);
  assert.equal(cold.enforcement, null);
  assert.match(cold.error, /custody: in-custody-by-sector table not found; enforcement: enforcement table not found/);
});
