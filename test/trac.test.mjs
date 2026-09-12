// TRAC (Syracuse University) ICE detention adapter — unit tests against recorded JSON samples
// (no network). The population and book-in fixtures are the full live payloads; facilities and
// ATD are trimmed to the two most recent download dates (the live tables carry every release
// since 2019 and run to several MB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import * as trac from '../apis/sources/trac.mjs';
import { resetRobotsCacheForTests, CRAWLER_UA } from '../apis/utils/robots.mjs';
import { classifySource } from '../lib/sourcehealth.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trac');
const read = f => readFileSync(join(FIX, f), 'utf8');
const RAW = {
  population: read('pop_agen_table.json'),
  bookins: read('book_in_agen_program_table.json'),
  facilities: read('facilities.json'),
  atd: read('atd_pop_table.json'),
};
const ROWS = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, JSON.parse(v)]));
const ROBOTS_OPEN = 'User-agent: *\nDisallow: /cgi-bin/\n';
const ROBOTS_CLOSED = 'User-agent: *\nDisallow: /\n';
const NOW = Date.parse('2026-09-12T12:00:00Z');

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
const tmp = () => mkdtempSync(join(tmpdir(), 'crucix-trac-'));
const allOk = (robots = ROBOTS_OPEN) => mockFetch([
  ['/robots.txt', res(200, robots)],
  ['pop_agen_table.json', res(200, RAW.population, { ETag: '"p1"', 'Last-Modified': 'Mon, 13 Jul 2026 14:00:00 GMT' })],
  ['book_in_agen_program_table.json', res(200, RAW.bookins, { ETag: '"b1"' })],
  ['facilities.json', res(200, RAW.facilities, { ETag: '"f1"' })],
  ['atd_pop_table.json', res(200, RAW.atd, { ETag: '"a1"' })],
]);

// --- normalisation ----------------------------------------------------------------------------
test('TRAC dates: MM/DD/YYYY and DDMONYY period codes normalise to ISO; garbage -> null', () => {
  assert.equal(trac.isoDate('07/11/2026'), '2026-07-11');
  assert.equal(trac.isoDate('7/4/2026'), '2026-07-04');
  assert.equal(trac.isoDate('2026-07-11'), null);
  assert.equal(trac.isoDate(''), null);
  assert.equal(trac.isoMonth('01JUL26'), '2026-07');
  assert.equal(trac.isoMonth('01jun25'), '2025-06');
  assert.equal(trac.isoMonth('01XXX26'), null);
  assert.equal(trac.isoMonth(undefined), null);
});

// --- summaries ---------------------------------------------------------------------------------
test('population: latest snapshot, agency and conviction-status split, prior/year-ago deltas, bounded series', () => {
  const p = trac.summarizePopulation(ROWS.population);
  assert.equal(p.asOf, '2026-07-11');
  assert.equal(p.snapshots, 155);
  assert.equal(p.latest.total, 65765);
  assert.equal(p.latest.ice, 58231);
  assert.equal(p.latest.cbp, 7534);
  assert.equal(p.latest.icePct, 88.5);
  assert.equal(p.latest.convicted + p.latest.pending + p.latest.noRecord, p.latest.total, 'conviction-status buckets partition the total');
  assert.equal(p.latest.noConvictionPct, 70.6, 'pending + no record, as TRAC words it');
  assert.deepEqual(p.previous, { date: '2026-04-04', total: 60311, changePct: 9 });
  assert.deepEqual(p.yearAgo, { date: '2025-07-13', total: 56816, changePct: 15.8 });
  assert.equal(p.series.length, 26, 'browser series bounded to ~1 year of snapshots');
  assert.equal(p.series[p.series.length - 1].date, p.asOf);
  assert.ok(p.series.every((s, i) => i === 0 || s.date > p.series[i - 1].date), 'series sorted ascending');
  assert.equal(trac.summarizePopulation([]), null);
  assert.equal(trac.summarizePopulation([{ date: 'n/a', total_all: 'x' }]), null);
});

test('book-ins: TRAC\u2019s latest-complete flag picks the headline month; later months are surfaced as partial, not charted', () => {
  const b = trac.summarizeBookIns(ROWS.bookins);
  assert.equal(b.asOf, '2026-07-11');
  assert.deepEqual(b.latest, { month: '2026-06', label: 'Jun-26', total: 43138, ice: 39563, cbp: 3575, icePct: 91.7 });
  assert.equal(b.momPct, 26.6);
  assert.equal(b.yoyPct, 17.5);
  assert.deepEqual(b.partial, [{ month: '2026-07', label: 'Jul-26', total: 17525, ice: 16213, cbp: 1312 }]);
  assert.equal(b.series.length, 13, 'latest complete month plus the same month a year earlier');
  assert.equal(b.series[0].month, '2025-06');
  assert.equal(b.series[12].month, '2026-06');
  assert.ok(b.series.every(m => m.month <= b.latest.month), 'partial month never enters the charted series');

  const noFlag = ROWS.bookins.map(r => ({ ...r, f_latest_period: 0 }));
  assert.equal(trac.summarizeBookIns(noFlag).latest.month, '2026-07', 'without the flag the newest reported month is used');
  assert.equal(trac.summarizeBookIns([]), null);
});

test('facilities: total row separated from facility rows; state aggregates carry centroids, not facility positions; strings bounded', () => {
  const f = trac.summarizeFacilities(ROWS.facilities);
  assert.equal(f.asOf, '2026-07-09', 'only the newest release is summarised even though the table carries history');
  assert.equal(f.total, 62517, 'headline total comes from TRAC\u2019s Total row');
  assert.equal(f.guaranteedMin, 47773);
  assert.equal(f.facilities, 208);
  assert.equal(f.withGuaranteedMin, 67);
  assert.equal(f.byType[0].type, 'DIGSA');
  assert.equal(f.byType[0].detainees, 22128);
  assert.equal(f.byState.length, 46);
  const tx = f.byState[0];
  assert.equal(tx.state, 'TX');
  assert.equal(tx.facilities, 27);
  assert.equal(tx.detainees, 16447);
  assert.equal(tx.sharePct, 26.3);
  assert.deepEqual([tx.lat, tx.lon], trac.STATE_CENTROIDS.TX);
  assert.ok(f.byState.every(s => Number.isFinite(s.lat) && Number.isFinite(s.lon)), 'every state in the release has a centroid');
  assert.equal(f.top.length, 15);
  assert.equal(f.top[0].name, 'ERO EL PASO CAMP EAST MONTANA');
  assert.equal(f.top[0].count, 2026);
  assert.ok(f.top.every((x, i) => i === 0 || x.count <= f.top[i - 1].count), 'top facilities sorted by ADP');
  assert.ok(!f.top.some(x => 'lat' in x || 'lon' in x || 'zip' in x), 'facility rows expose no coordinates or ZIPs');
  assert.ok(f.top.every(x => x.name.length <= 80 && x.city.length <= 40 && x.state.length <= 2 && x.type.length <= 12));

  const noTotal = ROWS.facilities.filter(r => !/^total$/i.test(r.name));
  const g = trac.summarizeFacilities(noTotal);
  assert.equal(g.facilities, 208);
  assert.equal(g.total, g.byState.reduce((n, s) => n + s.detainees, 0), 'without a Total row the total is the sum of facility ADP');
  assert.equal(trac.summarizeFacilities([]), null);
});

test('ATD: nationwide total from the blank-AOR Total row, technology split from per-AOR rows, AORs bounded to top 10', () => {
  const a = trac.summarizeAtd(ROWS.atd);
  assert.equal(a.asOf, '2026-07-11');
  assert.equal(a.total, 183181);
  assert.equal(a.avgDays, 788.5);
  assert.deepEqual(a.byTech.map(t => [t.technology, t.count, t.sharePct]), [['SmartLINK', 127296, 69.5], ['Ankle Monitor', 53192, 29], ['Wristworn', 2686, 1.5], ['Dual Tech', 6, 0]]);
  const techSum = a.byTech.reduce((n, t) => n + t.count, 0);
  assert.ok(Math.abs(techSum - a.total) <= 1, `technology rows sum to the Total row within rounding (${techSum} vs ${a.total})`);
  assert.equal(a.total, 183181, 'headline uses TRAC\u2019s Total row, not the technology sum');
  assert.equal(a.aors, 24);
  assert.equal(a.topAors.length, 10);
  assert.deepEqual(a.topAors[0], { aor: 'San Francisco', count: 20804, avgDays: 855.4 });
  assert.deepEqual(a.series, [{ date: '2026-04-04', total: 180701 }, { date: '2026-07-11', total: 183181 }]);
  assert.equal(a.yearAgo, null, 'trimmed fixture has no snapshot >= 350 days back');
  assert.equal(trac.summarizeAtd([]), null);
});

// --- payload validation ------------------------------------------------------------------------
test('dataset validators accept the recorded payloads and reject wrong shapes with a bounded reason', () => {
  for (const [id, rows] of Object.entries(ROWS)) assert.equal(trac.DATASETS[id].validate(rows), null, id);
  assert.match(trac.DATASETS.population.validate({ data: [] }), /unexpected population layout: object/);
  assert.match(trac.DATASETS.population.validate([]), /unexpected population layout/);
  assert.match(trac.DATASETS.facilities.validate([{ facility: 'x', renamed: 1 }]), /unexpected facilities layout: facility,renamed/);
  const wide = [Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`column_number_${i}`, i]))];
  assert.ok(trac.DATASETS.atd.validate(wide).length < 220, 'reason string bounded even for wide payloads');
  assert.ok(Object.values(trac.DATASETS).every(d => d.kind === 'json' && d.pageUrl.startsWith('https://tracreports.org/immigration/detentionstats/') && d.publisher === 'TRAC'));
});

// --- briefing: fetch / cache / status ----------------------------------------------------------
test('briefing: four JSON tables -> live, summaries populated, conditional-request state persisted, crawler UA used', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const f = allOk();
  const out = await trac.briefing({ fetch: f, dataDir, now: NOW });
  assert.equal(out.source, 'TRAC');
  assert.equal(out.status, 'live');
  assert.equal(out.pipelineVersion, trac.PIPELINE_VERSION);
  assert.match(out.attribution, /TRAC.*Syracuse University/);
  assert.equal(out.siteUrl, 'https://tracreports.org/immigration/quickfacts/');
  assert.deepEqual(out.datasets.map(d => [d.id, d.kind, d.status, d.httpStatus, d.rows]), [
    ['population', 'json', 'ok', 200, 155], ['bookins', 'json', 'ok', 200, 95], ['facilities', 'json', 'ok', 200, 413], ['atd', 'json', 'ok', 200, 211],
  ]);
  assert.equal(out.datasets[0].etag, '"p1"');
  assert.equal(out.datasets[0].lastModified, 'Mon, 13 Jul 2026 14:00:00 GMT');
  assert.equal(out.population.latest.total, 65765);
  assert.equal(out.bookIns.latest.total, 43138);
  assert.equal(out.facilities.total, 62517);
  assert.equal(out.atd.total, 183181);
  assert.equal(out.error, undefined);
  const dataCalls = f.calls.filter(c => !c.url.endsWith('/robots.txt'));
  assert.equal(dataCalls.length, 4);
  assert.ok(dataCalls.every(c => c.headers['User-Agent'] === CRAWLER_UA && /application\/json/.test(c.headers.Accept)));
  assert.ok(['pop_agen_table.json', 'book_in_agen_program_table.json', 'facilities.json', 'atd_pop_table.json', 'state-trac.json'].every(n => existsSync(join(dataDir, n))));
  assert.equal(classifySource('TRAC', out).state, 'live');
});

test('briefing: 304 -> not_modified (still live); HTTP 500 and a re-shaped table -> stale copies served, source partial', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  await trac.briefing({ fetch: allOk(), dataDir, now: NOW });

  resetRobotsCacheForTests();
  const f2 = mockFetch([
    ['/robots.txt', res(200, ROBOTS_OPEN)],
    ['pop_agen_table.json', (u, o) => (o.headers['If-None-Match'] === '"p1"' && o.headers['If-Modified-Since'] === 'Mon, 13 Jul 2026 14:00:00 GMT' ? res(304) : res(500))],
    ['book_in_agen_program_table.json', (u, o) => (o.headers['If-None-Match'] === '"b1"' ? res(304) : res(500))],
    ['facilities.json', res(500, 'upstream error')],
    ['atd_pop_table.json', res(200, JSON.stringify([{ region: 'x', tech: 'y' }]), { ETag: '"a2"' })],
  ]);
  const out = await trac.briefing({ fetch: f2, dataDir, now: NOW + 86_400_000 });
  assert.equal(out.status, 'partial');
  assert.deepEqual(out.datasets.map(d => [d.id, d.status, d.httpStatus]), [['population', 'not_modified', 304], ['bookins', 'not_modified', 304], ['facilities', 'stale', 500], ['atd', 'stale', 200]]);
  assert.equal(out.datasets[2].reason, 'HTTP 500');
  assert.match(out.datasets[3].reason, /unexpected ATD layout: region,tech/);
  assert.ok(out.datasets[3].notes.some(n => /TRAC changed the JSON layout/.test(n)));
  assert.equal(out.population.latest.total, 65765, 'not_modified still summarises the cached table');
  assert.equal(out.facilities.total, 62517, 'last good facilities copy still served');
  assert.equal(out.atd.total, 183181, 'last good ATD copy still served, not the re-shaped one');
  assert.equal(out.error, undefined, 'stale is not an error');
  assert.equal(classifySource('TRAC', out).state, 'degraded');
});

test('briefing: cold start with TRAC unreachable / invalid JSON -> error with per-dataset reasons, no summaries, health degraded not thrown', async () => {
  resetRobotsCacheForTests();
  const f = mockFetch([
    ['/robots.txt', res(200, ROBOTS_OPEN)],
    ['pop_agen_table.json', () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
    ['book_in_agen_program_table.json', res(200, '<html>maintenance</html>')],
  ]);
  const out = await trac.briefing({ fetch: f, dataDir: tmp(), now: NOW });
  assert.equal(out.status, 'error');
  assert.deepEqual(out.datasets.map(d => [d.id, d.status, d.reason]), [
    ['population', 'error', 'timed out'], ['bookins', 'error', 'body is not valid JSON'], ['facilities', 'error', 'HTTP 404'], ['atd', 'error', 'HTTP 404'],
  ]);
  assert.equal(out.population, null);
  assert.equal(out.bookIns, null);
  assert.equal(out.facilities, null);
  assert.equal(out.atd, null);
  assert.match(out.error, /population: timed out; bookins: body is not valid JSON/);
  assert.notEqual(classifySource('TRAC', out).state, 'live');
});

test('briefing: robots.txt disallow is honoured -> nothing fetched, reason robots-disallowed', async () => {
  resetRobotsCacheForTests();
  const f = allOk(ROBOTS_CLOSED);
  const out = await trac.briefing({ fetch: f, dataDir: tmp(), now: NOW });
  assert.equal(out.status, 'error');
  assert.ok(out.datasets.every(d => d.status === 'error' && d.reason === 'robots-disallowed'));
  assert.ok(f.calls.every(c => c.url.endsWith('/robots.txt')), 'no table requested');
});
