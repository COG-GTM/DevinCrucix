// CBP Enforcement Statistics adapter — unit tests against recorded CSV/HTML samples (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import {
  briefing, parseCsv, csvRecords, headerMatches, periodOf, shiftPeriod, discoverCsvUrl,
  summarizeEncounters, summarizeDrugs, DATASETS, SW_SECTORS, PIPELINE_VERSION,
} from '../apis/sources/cbpstats.mjs';
import { resetRobotsCacheForTests, CRAWLER_UA } from '../apis/utils/robots.mjs';
import { classifySource } from '../lib/sourcehealth.mjs';
import { PLACES } from '../apis/sources/bordernews.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cbp');
const ENC_CSV = readFileSync(join(FIX, 'nationwide-encounters-aor-sample.csv'), 'utf8');
const DRUG_CSV = readFileSync(join(FIX, 'nationwide-drugs-sample.csv'), 'utf8');
const ENC_PAGE = readFileSync(join(FIX, 'document-stats-nationwide-encounters.html'), 'utf8');
const DRUG_PAGE = readFileSync(join(FIX, 'document-stats-nationwide-drug-seizures.html'), 'utf8');
const ROBOTS = 'User-agent: *\nDisallow: /core/\nDisallow:  /sites/default/files/assets/documents/\nDisallow:  /sites/default/files/assets/documents/*\n';

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
const tmp = () => mkdtempSync(join(tmpdir(), 'crucix-cbp-'));

const ENC_URL = 'https://www.cbp.gov/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv';
const DRUG_URL = 'https://www.cbp.gov/sites/default/files/2026-08/nationwide-drugs-fy23-fy26-jul.csv';
const happy = () => mockFetch([
  ['/robots.txt', res(200, ROBOTS)],
  ['/document/stats/nationwide-encounters', res(200, ENC_PAGE)],
  ['/document/stats/nationwide-drug-seizures', res(200, DRUG_PAGE)],
  ['nationwide-encounters-fy23-fy26-jul-aor.csv', res(200, ENC_CSV, { ETag: '"e1"', 'Last-Modified': 'Fri, 07 Aug 2026 15:05:45 GMT' })],
  ['nationwide-drugs-fy23-fy26-jul.csv', res(200, DRUG_CSV, { ETag: '"d1"' })],
]);

// --- CSV -------------------------------------------------------------------------

test('parseCsv: quoted commas, doubled quotes, CRLF, BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n'), [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
});

test('recorded CBP headers match exactly what the adapter expects', () => {
  const e = csvRecords(ENC_CSV);
  assert.deepEqual(e.header, DATASETS.encounters.expectedHeader);
  assert.ok(headerMatches(e.header, DATASETS.encounters.expectedHeader));
  assert.equal(e.records.length, 322);
  assert.ok(e.records.some(r => r.Citizenship === 'CHINA, PEOPLES REPUBLIC OF'), 'quoted citizenship survives');
  const d = csvRecords(DRUG_CSV);
  assert.deepEqual(d.header, DATASETS.drugs.expectedHeader);
  assert.equal(d.records.length, 202);
  assert.ok(!headerMatches(['FY', 'Month'], DATASETS.drugs.expectedHeader));
});

// --- fiscal calendar --------------------------------------------------------------

test('periodOf maps CBP fiscal year + month abbreviation to a calendar month', () => {
  assert.equal(periodOf('2026 (FYTD)', 'OCT'), '2025-10');
  assert.equal(periodOf('2026 (FYTD)', 'DEC'), '2025-12');
  assert.equal(periodOf('2026 (FYTD)', 'JAN'), '2026-01');
  assert.equal(periodOf('2026 (FYTD)', 'JUL'), '2026-07');
  assert.equal(periodOf('2023', 'SEP'), '2023-09');
  assert.equal(periodOf('n/a', 'JUL'), null);
  assert.equal(periodOf('2026', 'XYZ'), null);
  assert.equal(shiftPeriod('2026-07', -12), '2025-07');
  assert.equal(shiftPeriod('2026-01', -1), '2025-12');
});

// --- aggregation --------------------------------------------------------------------

test('summarizeEncounters: Southwest-only totals, sector table, MoM/YoY, latest-month breakdowns', () => {
  const s = summarizeEncounters(csvRecords(ENC_CSV).records);
  assert.equal(s.region, 'Southwest Land Border');
  assert.equal(s.rows, 320, 'Northern rows excluded');
  assert.deepEqual(s.coverage, { first: '2025-07', last: '2026-07', months: 3 });
  assert.equal(s.latest.period, '2026-07');
  assert.equal(s.latest.label, 'Jul 2026');
  assert.equal(s.latest.total, 5636);
  assert.equal(s.latest.usbp, 5031);
  assert.equal(s.latest.ofo, 605);
  assert.equal(s.latest.momPct, -2.7); // vs 5792
  assert.equal(s.latest.yoyPct, 78.1); // vs 3165
  assert.deepEqual(s.series.map(x => [x.period, x.total]), [['2025-07', 3165], ['2026-06', 5792], ['2026-07', 5636]]);
  const rgv = s.sectors.find(x => x.abbv === 'RGV');
  assert.equal(rgv.latest, 2438);
  assert.equal(rgv.previous, 2231);
  assert.equal(rgv.momPct, 9.3);
  assert.equal(rgv.yoyPct, 156.9);
  assert.equal(rgv.sector, 'Rio Grande Valley');
  assert.equal(s.sectors[0].abbv, 'RGV', 'sorted by latest count');
  assert.equal(s.sectors.length, SW_SECTORS.length, 'every SW sector listed even with zero rows');
  assert.equal(s.sectors.find(x => x.abbv === 'YUM').latest, 0);
  assert.deepEqual(s.fieldOffices[0], { aor: 'El Paso Field Office', latest: 605 });
  assert.equal(s.demographic.reduce((a, b) => a + b.count, 0), 5636);
  assert.equal(s.encounterType.reduce((a, b) => a + b.count, 0), 5636);
  assert.ok(s.citizenship.length <= 10 && s.citizenship[0].key === 'MEXICO');
  assert.equal(summarizeEncounters([]), null);
});

test('SW_SECTORS agree with the Border Watch gazetteer sector names', () => {
  const gaz = new Set(PLACES.map(p => p.sector).filter(Boolean));
  for (const s of SW_SECTORS) assert.ok(gaz.has(s.sector), `${s.sector} missing from PLACES`);
  for (const g of gaz) assert.ok(SW_SECTORS.some(s => s.sector === g), `${g} missing from SW_SECTORS`);
});

test('summarizeDrugs: Southwest-only lbs/events by month, drug type and AOR', () => {
  const d = summarizeDrugs(csvRecords(DRUG_CSV).records);
  assert.equal(d.rows, 200);
  assert.equal(d.latest.period, '2026-07');
  assert.equal(d.latest.events, 744);
  assert.equal(d.latest.lbs, 25208.7);
  assert.equal(d.latest.momLbsPct, 11.7); // vs 22558.2
  assert.equal(d.latest.yoyLbsPct, 5.1); // vs 23996.5
  const fent = d.drugs.find(x => x.type === 'Fentanyl');
  assert.equal(fent.latest.lbs, 969.6);
  assert.equal(fent.yoyLbsPct, -27.7); // vs 1341.3
  assert.deepEqual(fent.series.map(x => x.period), ['2025-07', '2026-06', '2026-07']);
  assert.equal(d.drugs[0].type, 'Marijuana', 'sorted by latest lbs');
  assert.equal(d.byAor[0].aor, 'San Diego Field Office');
  assert.equal(d.byAor[0].lbs, 8241.5);
  assert.equal(summarizeDrugs([]), null);
});

// --- discovery ------------------------------------------------------------------------

test('discoverCsvUrl picks the newest AOR / drugs CSV from the official document page', () => {
  assert.equal(discoverCsvUrl(ENC_PAGE, DATASETS.encounters), ENC_URL);
  assert.equal(discoverCsvUrl(DRUG_PAGE, DATASETS.drugs), DRUG_URL);
  assert.equal(discoverCsvUrl('<html>no links</html>', DATASETS.encounters), null);
  // newest directory wins regardless of order on the page; "-state.csv" is never chosen
  const shuffled = '<a href="/sites/default/files/2026-07/nationwide-encounters-fy23-fy26-jun-aor.csv">x</a><a href="/sites/default/files/2026-09/nationwide-encounters-fy23-fy26-aug-state.csv">x</a><a href="/sites/default/files/2026-09/nationwide-encounters-fy23-fy26-aug-aor.csv">x</a>';
  assert.equal(discoverCsvUrl(shuffled, DATASETS.encounters), 'https://www.cbp.gov/sites/default/files/2026-09/nationwide-encounters-fy23-fy26-aug-aor.csv');
});

// --- briefing -----------------------------------------------------------------------------

test('briefing: discovery -> robots -> conditional download -> cache; second sweep 304 stays live', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const f = happy();
  const out = await briefing({ fetch: f, dataDir, now: Date.parse('2026-09-06T16:00:00Z') });
  assert.equal(out.source, 'CBPStats');
  assert.equal(out.status, 'live');
  assert.equal(out.pipelineVersion, PIPELINE_VERSION);
  assert.match(out.attribution, /Customs and Border Protection/);
  assert.deepEqual(out.datasets.map(d => [d.id, d.status, d.httpStatus, d.url, d.discovered, d.rows]), [
    ['encounters', 'ok', 200, ENC_URL, true, 322],
    ['drugs', 'ok', 200, DRUG_URL, true, 202],
  ]);
  assert.deepEqual(out.datasets[0].header, DATASETS.encounters.expectedHeader);
  assert.equal(out.datasets[0].etag, '"e1"');
  assert.equal(out.encounters.latest.total, 5636);
  assert.equal(out.drugs.latest.lbs, 25208.7);
  assert.ok(f.calls.every(c => c.headers['User-Agent'] === CRAWLER_UA), 'declared crawler UA on every request');
  assert.equal(f.calls.filter(c => c.url.endsWith('/robots.txt')).length, 1, 'robots cached per origin');
  assert.ok(existsSync(join(dataDir, 'encounters-aor.csv')) && existsSync(join(dataDir, 'drugs.csv')) && existsSync(join(dataDir, 'state.json')));
  assert.equal(classifySource('CBPStats', out).state, 'live');

  const f2 = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/nationwide-encounters', res(200, ENC_PAGE)],
    ['/document/stats/nationwide-drug-seizures', res(200, DRUG_PAGE)],
    ['.csv', res(304)],
  ]);
  const out2 = await briefing({ fetch: f2, dataDir, now: Date.parse('2026-09-06T17:00:00Z') });
  assert.equal(out2.status, 'live');
  assert.deepEqual(out2.datasets.map(d => d.status), ['not_modified', 'not_modified']);
  const csvCalls = f2.calls.filter(c => c.url.endsWith('.csv'));
  assert.equal(csvCalls.find(c => c.url.includes('encounters')).headers['If-None-Match'], '"e1"');
  assert.equal(csvCalls.find(c => c.url.includes('encounters')).headers['If-Modified-Since'], 'Fri, 07 Aug 2026 15:05:45 GMT');
  assert.equal(out2.encounters.latest.total, 5636, 'served from cache');
  assert.equal(out2.datasets[0].fetchedAt, '2026-09-06T16:00:00.000Z', 'fetchedAt is the last actual download');
  assert.equal(classifySource('CBPStats', out2).state, 'live');
});

test('briefing: discovery page down -> fallback URL; CBP down after a good sweep -> stale (degraded, data kept); cold + down -> error', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const noPage = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/', res(403, 'denied')],
    ['nationwide-encounters-fy23-fy26-jul-aor.csv', res(200, ENC_CSV)],
    ['nationwide-drugs-fy23-fy26-jul.csv', res(200, DRUG_CSV)],
  ]);
  const a = await briefing({ fetch: noPage, dataDir, now: Date.parse('2026-09-06T16:00:00Z') });
  assert.equal(a.status, 'live');
  assert.ok(a.datasets.every(d => d.discovered === false && d.url === DATASETS[d.id].fallbackUrl));
  assert.match(a.datasets[0].notes[0], /discovery page HTTP 403; using fallback URL/);

  const down = async () => { throw new Error('ENOTFOUND'); };
  const b = await briefing({ fetch: down, dataDir, now: Date.parse('2026-09-07T16:00:00Z') });
  assert.equal(b.status, 'stale');
  assert.deepEqual(b.datasets.map(d => d.status), ['stale', 'stale']);
  assert.equal(b.encounters.latest.total, 5636, 'cached CSV still summarized');
  assert.match(b.datasets[0].notes.join(' '), /serving cached copy/);
  assert.equal(classifySource('CBPStats', b).state, 'degraded');

  const c = await briefing({ fetch: down, dataDir: tmp(), now: Date.now() });
  assert.equal(c.status, 'error');
  assert.equal(c.encounters, null);
  assert.match(c.error, /encounters: /);
  assert.equal(classifySource('CBPStats', c).state, 'error');
});

test('briefing: one dataset blocked -> partial; robots disallow is honoured; changed header is refused', async () => {
  resetRobotsCacheForTests();
  const one = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/nationwide-encounters', res(200, ENC_PAGE)],
    ['/document/stats/nationwide-drug-seizures', res(200, DRUG_PAGE)],
    ['nationwide-encounters-fy23-fy26-jul-aor.csv', res(200, ENC_CSV)],
    ['nationwide-drugs-fy23-fy26-jul.csv', res(403, 'denied')],
  ]);
  const p = await briefing({ fetch: one, dataDir: tmp(), now: Date.now() });
  assert.equal(p.status, 'partial');
  assert.equal(p.datasets[1].status, 'error');
  assert.equal(p.datasets[1].reason, 'HTTP 403');
  assert.equal(p.drugs, null);
  assert.ok(p.encounters);
  assert.equal(classifySource('CBPStats', p).state, 'degraded');

  resetRobotsCacheForTests();
  const disallow = mockFetch([['/robots.txt', res(200, 'User-agent: *\nDisallow: /sites/default/files/\n')], ['/document/stats/', res(200, ENC_PAGE)]]);
  const r = await briefing({ fetch: disallow, dataDir: tmp(), now: Date.now() });
  assert.equal(r.status, 'error');
  assert.deepEqual(r.datasets.map(d => d.reason), ['robots-disallowed', 'robots-disallowed']);
  assert.ok(!disallow.calls.some(c => c.url.endsWith('.csv')), 'no CSV request when robots disallows it');

  resetRobotsCacheForTests();
  const dataDir = tmp();
  const changed = mockFetch([
    ['/robots.txt', res(200, ROBOTS)],
    ['/document/stats/nationwide-encounters', res(200, ENC_PAGE)],
    ['/document/stats/nationwide-drug-seizures', res(200, DRUG_PAGE)],
    ['nationwide-encounters-fy23-fy26-jul-aor.csv', res(200, 'Fiscal Year,Sector,Count\n2026,RGV,1\n')],
    ['nationwide-drugs-fy23-fy26-jul.csv', res(200, DRUG_CSV)],
  ]);
  const h = await briefing({ fetch: changed, dataDir, now: Date.now() });
  assert.equal(h.status, 'partial');
  assert.match(h.datasets[0].reason, /unexpected header: Fiscal Year,Sector,Count/);
  assert.equal(h.encounters, null, 'never guess column meanings');
  assert.ok(!readdirSync(dataDir).includes('encounters-aor.csv'), 'unparseable file is not cached');
});
