// Taiwan MND daily PLA activity adapter — unit tests against recorded list/detail pages (no
// network). Covers the wording variants MND has used, the robots.txt gate (blocked by default,
// explicit operator override), conservative detail fetching, and the persisted report store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import * as mnd from '../apis/sources/plamnd.mjs';
import { resetRobotsCacheForTests, CRAWLER_UA } from '../apis/utils/robots.mjs';
import { classifySource } from '../lib/sourcehealth.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plamnd');
const read = f => readFileSync(join(FIX, f), 'utf8');
const LIST = read('list.html');
const DETAIL = { 87739: read('detail-87739.html'), 87682: read('detail-87682.html'), 87672: read('detail-87672.html') };
const MND_ROBOTS = 'User-agent: Googlebot\nDisallow: /search\nDisallow: /tag\nDisallow: /*?*\nDisallow: /*.aspx$\n\nSitemap: https://www.mnd.gov.tw/sitemap.xml\n\nUser-agent: *\nDisallow: /\n';
const NOW = Date.parse('2026-09-11T10:00:00Z');

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
const tmp = () => mkdtempSync(join(tmpdir(), 'crucix-plamnd-'));
const siteUp = () => mockFetch([
  ['/robots.txt', res(200, MND_ROBOTS)],
  ['/en/news/PlaactList', res(200, LIST, { ETag: '"l1"' })],
  ['/en/News/PLAAct/87739', res(200, DETAIL[87739])],
  ['/en/News/PLAAct/87672', res(200, DETAIL[87672])],
  ['/en/News/PLAAct/', res(200, DETAIL[87682])],
]);
const run = (fetch, dataDir, extra = {}) => mnd.briefing({ fetch, dataDir, now: NOW, delayMs: 0, ...extra });

// --- parsing -------------------------------------------------------------------------------------
test('list page: one entry per daily post, newest first, absolute detail URLs', () => {
  const list = mnd.parseList(LIST);
  assert.equal(list.length, 9);
  assert.deepEqual(list[0], { id: '87739', date: '2026-09-11', title: 'PLA activities in the waters and airspace around Taiwan', url: 'https://www.mnd.gov.tw/en/News/PLAAct/87739' });
  assert.equal(list[list.length - 1].date, '2026-09-03');
  assert.ok(list.every((e, i) => i === 0 || e.date <= list[i - 1].date));
  assert.deepEqual(mnd.parseList('<html><body>nothing here</body></html>'), []);
  assert.match(mnd.DATASETS.list.validate('<html></html>'), /no PLAAct entries/);
  assert.equal(mnd.DATASETS.list.validate(LIST), null);
});

test('activity sentence: standard, median-line, no-aircraft, balloon and singular wordings', () => {
  assert.deepEqual(mnd.parseActivities('11 sorties of PLA aircraft, 8 PLAN ships and 2 official ships operating around Taiwan were detected as of 6 a.m. (UTC+8) today. 10 out of 11 sorties entered Taiwan\u2019s southwestern and eastern ADIZ.'),
    { aircraft: 11, ships: 8, officialShips: 2, balloons: 0, adizSorties: 10, medianLine: false, adizSectors: ['eastern', 'southwestern'] });
  assert.deepEqual(mnd.parseActivities('21 sorties of PLA aircraft, 10 PLAN ships and 5 official ships ... 13 out of 21 sorties crossed the median line of the Taiwan Strait and entered Taiwan\'s northern, central, southwestern and eastern ADIZ.'),
    { aircraft: 21, ships: 10, officialShips: 5, balloons: 0, adizSorties: 13, medianLine: true, adizSectors: ['northern', 'eastern', 'southwestern', 'central'] });
  assert.deepEqual(mnd.parseActivities('5 PLAN ships and 3 official ships operating around Taiwan were detected as of 6 a.m. (UTC+8) today. Illustration of flight path is not provided due to no PLA aircraft operating around Taiwan were detected during this timeframe.'),
    { aircraft: 0, ships: 5, officialShips: 3, balloons: 0, adizSorties: 0, medianLine: false, adizSectors: [] });
  assert.deepEqual(mnd.parseActivities('1 sortie of PLA aircraft, 1 PLAN vessel, 1 official vessel and 2 PRC balloons operating around Taiwan were detected. 1 out of 1 sortie crossed the median line and entered the northern ADIZ.'),
    { aircraft: 1, ships: 1, officialShips: 1, balloons: 2, adizSorties: 1, medianLine: true, adizSectors: ['northern'] });
  assert.deepEqual(mnd.parseActivities('9 sorties of PLA aircraft and 6 PLAN ships operating around Taiwan were detected.'),
    { aircraft: 9, ships: 6, officialShips: 0, balloons: 0, adizSorties: null, medianLine: null, adizSectors: [] }, 'no ADIZ sentence -> unknown, never zero');
  assert.deepEqual(mnd.parseActivities('Ministry press conference schedule'),
    { aircraft: null, ships: null, officialShips: null, balloons: null, adizSorties: null, medianLine: null, adizSectors: [] });
});

test('detail page: date, window (UTC+8 -> UTC), counts, chart URL and bounded text; unrelated page -> null', () => {
  const r = mnd.parseDetail(DETAIL[87739], { id: '87739', title: 'PLA activities in the waters and airspace around Taiwan' });
  assert.equal(r.id, '87739');
  assert.equal(r.date, '2026-09-11');
  assert.equal(r.url, 'https://www.mnd.gov.tw/en/News/PLAAct/87739');
  assert.equal(r.window, '6 a.m. Sep. 10 (Thu.) to 6 a.m. Sep. 11 (Fri.) (UTC+8)');
  assert.equal(r.windowEndUtc, '2026-09-10T22:00:00.000Z', '06:00 Taipei = 22:00Z the day before');
  assert.equal(r.aircraft, 11);
  assert.equal(r.ships, 8);
  assert.equal(r.officialShips, 2);
  assert.equal(r.adizSorties, 10);
  assert.deepEqual(r.adizSectors, ['eastern', 'southwestern']);
  assert.match(r.chartUrl, /^https:\/\/www\.mnd\.gov\.tw\/NewUpload\/202609\/.*\.jpg$/);
  assert.ok(r.text.startsWith('11 sorties of PLA aircraft') && r.text.length <= 400 && !/<[a-z]/i.test(r.text), 'text is tag-free and bounded');
  assert.equal(r.parsed, true);

  const m = mnd.parseDetail(DETAIL[87682], { id: '87682' });
  assert.equal(m.medianLine, true);
  assert.equal(m.aircraft, 21);
  assert.equal(m.adizSorties, 13);

  const z = mnd.parseDetail(DETAIL[87672], { id: '87672' });
  assert.equal(z.aircraft, 0);
  assert.equal(z.ships, 5);
  assert.equal(z.chartUrl, null, 'MND publishes no track chart on zero-aircraft days');
  assert.equal(z.parsed, true);

  assert.equal(mnd.parseDetail('<html><div class="maincontent">Weather notice</div></html>', { id: '1' }), null);
  assert.equal(mnd.parseDetail(DETAIL[87739].replace(/class="pageinfo"/g, 'class="pageinfo-v2"'), {}), null, 'no date -> not a report');
});

test('summary: 7/30-day windows, per-day averages, peak, bounded ascending series; unparsed reports excluded', () => {
  const reports = {};
  for (let i = 0; i < 40; i++) {
    const date = new Date(Date.UTC(2026, 8, 11) - i * 86_400_000).toISOString().slice(0, 10);
    reports[String(90000 - i)] = { id: String(90000 - i), date, aircraft: i === 3 ? 50 : 10, ships: 8, officialShips: 2, balloons: i === 0 ? 1 : 0, adizSorties: i === 3 ? 40 : 6, medianLine: i % 2 === 0, url: `https://www.mnd.gov.tw/en/News/PLAAct/${90000 - i}`, parsed: true };
  }
  reports.junk = { id: 'junk', date: '2026-09-12', aircraft: null, ships: null, parsed: false };
  const s = mnd.summarize(reports);
  assert.equal(s.asOf, '2026-09-11', 'unparsed newer entry does not become the headline');
  assert.equal(s.reports, 40);
  assert.equal(s.earliest, '2026-08-03');
  assert.equal(s.latest.aircraft, 10);
  assert.deepEqual(s.last7, { days: 7, aircraft: 110, adizSorties: 76, ships: 8, officialShips: 2, balloons: 1, aircraftPerDay: 15.7 });
  assert.equal(s.last30.days, 30);
  assert.equal(s.last30.aircraft, 340);
  assert.equal(s.last30.medianLineDays, 15);
  assert.equal(s.aircraftPerDayDelta7, 5.7, 'last 7 days vs the 7 before');
  assert.deepEqual(s.peak, { date: '2026-09-08', aircraft: 50, adizSorties: 40, url: 'https://www.mnd.gov.tw/en/News/PLAAct/89997' });
  assert.equal(s.series.length, 30);
  assert.equal(s.series[0].date, '2026-08-13');
  assert.equal(s.series[29].date, '2026-09-11');
  assert.equal(mnd.summarize({}), null);
  assert.equal(mnd.summarize({ junk: reports.junk }), null);
});

test('robots override flag: only explicit truthy values enable it', () => {
  assert.equal(mnd.robotsOverrideEnabled({}), false);
  assert.equal(mnd.robotsOverrideEnabled({ PLAMND_ROBOTS_OVERRIDE: '0' }), false);
  assert.equal(mnd.robotsOverrideEnabled({ PLAMND_ROBOTS_OVERRIDE: 'false' }), false);
  assert.equal(mnd.robotsOverrideEnabled({ PLAMND_ROBOTS_OVERRIDE: '1' }), true);
  assert.equal(mnd.robotsOverrideEnabled({ PLAMND_ROBOTS_OVERRIDE: 'true' }), true);
  assert.equal(mnd.robotsOverrideEnabled({ PLAMND_ROBOTS_OVERRIDE: 'YES' }), true);
});

// --- briefing --------------------------------------------------------------------------------------
test('briefing default: mnd.gov.tw robots.txt disallows us -> nothing but robots.txt fetched, blocked/error state with link-out, health degraded not thrown', async () => {
  resetRobotsCacheForTests();
  const f = siteUp();
  const out = await run(f, tmp(), { env: {} });
  assert.equal(out.source, 'PLAMND');
  assert.equal(out.status, 'blocked', 'policy gate is not an outage');
  assert.equal(out.robotsOverride, false);
  assert.equal(out.siteUrl, mnd.LIST_URL);
  assert.match(out.attribution, /Ministry of National Defense/);
  assert.deepEqual(out.datasets.map(d => [d.id, d.status, d.reason]), [['list', 'error', 'robots-disallowed'], ['reports', 'error', 'list page unavailable']]);
  assert.equal(out.activity, null);
  assert.ok(f.calls.every(c => c.url.endsWith('/robots.txt')), 'no MND page requested without opt-in');
  assert.equal(out.error, undefined);
  assert.match(out.message, /PLAMND_ROBOTS_OVERRIDE=1 to opt in \(list: robots-disallowed/);
  assert.equal(classifySource('PLAMND', out).state, 'degraded');
});

test('briefing with operator override: list + at most MAX_NEW_DETAILS detail pages, reports persisted, override visible in metadata', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  const f = siteUp();
  const out = await run(f, dataDir, { env: { PLAMND_ROBOTS_OVERRIDE: '1' } });
  assert.equal(out.robotsOverride, true);
  assert.equal(out.status, 'live');
  assert.deepEqual(out.datasets.map(d => [d.id, d.kind, d.status, d.httpStatus]), [['list', 'html', 'ok', 200], ['reports', 'html', 'ok', 200]]);
  assert.ok(out.datasets.every(d => d.notes.includes('robots.txt override enabled by operator')));
  assert.equal(out.datasets[1].rows, mnd.MAX_NEW_DETAILS);
  assert.equal(out.activity.asOf, '2026-09-11');
  assert.equal(out.activity.latest.aircraft, 11);
  assert.equal(out.activity.reports, mnd.MAX_NEW_DETAILS);
  const pages = f.calls.filter(c => /\/en\//.test(c.url));
  assert.equal(pages.filter(c => c.url.endsWith('/PlaactList')).length, 1, 'one list request per sweep');
  assert.equal(pages.filter(c => /PLAAct\/\d+/.test(c.url)).length, mnd.MAX_NEW_DETAILS, 'detail fetches capped per sweep');
  assert.ok(pages.every(c => c.headers['User-Agent'] === CRAWLER_UA));
  assert.ok(f.calls.every(c => !c.url.endsWith('/robots.txt')), 'override skips robots.txt entirely');
  assert.ok(existsSync(join(dataDir, 'reports.json')) && existsSync(join(dataDir, 'plaact-list.html')));
  assert.equal(out.listing.length, 9);
});

test('briefing with override: cached reports survive an MND outage as stale; detail backlog trickles in across sweeps', async () => {
  resetRobotsCacheForTests();
  const dataDir = tmp();
  // Sweep 1: only the two oldest detail pages exist in this mock, so the newest three 404.
  const partialSite = mockFetch([
    ['/en/news/PlaactList', res(200, LIST, { ETag: '"l1"' })],
    ['/en/News/PLAAct/87682', res(200, DETAIL[87682])],
    ['/en/News/PLAAct/87672', res(200, DETAIL[87672])],
  ]);
  const s1 = await run(partialSite, dataDir, { ignoreRobots: true, maxDetails: 2 });
  assert.deepEqual(s1.datasets.map(d => [d.id, d.status]), [['list', 'ok'], ['reports', 'error']]);
  assert.equal(s1.datasets[1].reason, 'HTTP 404');
  assert.equal(s1.activity, null);
  assert.equal(s1.status, 'partial');

  // Sweep 2: pages come back; two new details per sweep.
  const fullSite = mockFetch([
    ['/en/news/PlaactList', (u, o) => (o.headers['If-None-Match'] === '"l1"' ? res(304) : res(500))],
    ['/en/News/PLAAct/87739', res(200, DETAIL[87739])],
    ['/en/News/PLAAct/87730', res(200, DETAIL[87682].replace(/2026\.09\.06/g, '2026.09.10').replace(/PLAAct\/87682/g, 'PLAAct/87730'))],
    ['/en/News/PLAAct/', res(200, DETAIL[87672])],
  ]);
  const s2 = await run(fullSite, dataDir, { ignoreRobots: true, maxDetails: 2, now: NOW + 3_600_000 });
  assert.deepEqual(s2.datasets.map(d => [d.id, d.status, d.httpStatus]), [['list', 'not_modified', 304], ['reports', 'ok', 200]]);
  assert.equal(s2.status, 'live');
  assert.equal(s2.datasets[1].rows, 2);
  assert.ok(s2.datasets[1].notes.some(n => /fetched 2 new reports/.test(n)) && s2.datasets[1].notes.some(n => /7 reports queued/.test(n)));
  assert.equal(s2.activity.asOf, '2026-09-11');
  assert.equal(s2.activity.latest.aircraft, 11);
  assert.equal(s2.activity.reports, 2);
  assert.equal(classifySource('PLAMND', s2).state, 'live');

  // Sweep 3: MND unreachable -> list stale from cache, cached reports still summarised, flagged stale.
  const down = mockFetch([['/en/', () => { throw new Error('ECONNRESET'); }]]);
  const s3 = await run(down, dataDir, { ignoreRobots: true, now: NOW + 7_200_000 });
  assert.deepEqual(s3.datasets.map(d => [d.id, d.status, d.reason]), [['list', 'stale', 'unreachable'], ['reports', 'stale', 'detail page unreachable']]);
  assert.equal(s3.status, 'stale');
  assert.equal(s3.activity.latest.aircraft, 11, 'last parsed report still served');
  assert.equal(s3.error, undefined);
  assert.equal(classifySource('PLAMND', s3).state, 'degraded');

  // Sweep 4: operator turns the override back off -> no MND requests, but the local series is still shown as stale.
  resetRobotsCacheForTests();
  const gated = siteUp();
  const s4 = await run(gated, dataDir, { env: {} });
  assert.equal(s4.robotsOverride, false);
  assert.deepEqual(s4.datasets.map(d => [d.id, d.status, d.reason]), [['list', 'stale', 'robots-disallowed'], ['reports', 'stale', 'robots-disallowed']]);
  assert.equal(s4.status, 'stale');
  assert.equal(s4.activity.reports, 2);
  assert.ok(gated.calls.every(c => c.url.endsWith('/robots.txt')));
});

test('report store is pruned to MAX_REPORTS newest entries and ignores corrupt files', async () => {
  const dataDir = tmp();
  mkdirSync(dataDir, { recursive: true });
  const reports = {};
  for (let i = 0; i < mnd.MAX_REPORTS + 25; i++) {
    const date = new Date(Date.UTC(2026, 8, 1) - i * 86_400_000).toISOString().slice(0, 10);
    reports[String(80000 - i)] = { id: String(80000 - i), date, aircraft: 1, ships: 1, officialShips: 0, balloons: 0, adizSorties: 0, medianLine: false, parsed: true };
  }
  writeFileSync(join(dataDir, 'reports.json'), JSON.stringify({ reports }));
  const f = mockFetch([['/en/news/PlaactList', res(200, LIST)], ['/en/News/PLAAct/', res(200, DETAIL[87739])]]);
  const out = await run(f, dataDir, { ignoreRobots: true, maxDetails: 1 });
  assert.equal(out.datasets[1].rows, mnd.MAX_REPORTS);
  const stored = JSON.parse(readFileSync(join(dataDir, 'reports.json'), 'utf8'));
  assert.equal(Object.keys(stored.reports).length, mnd.MAX_REPORTS);
  assert.ok(stored.reports['87739'], 'newest report kept');
  assert.ok(!stored.reports[String(80000 - mnd.MAX_REPORTS - 24)], 'oldest dropped');

  writeFileSync(join(dataDir, 'reports.json'), '{not json');
  const out2 = await run(mockFetch([['/en/news/PlaactList', res(200, LIST)], ['/en/News/PLAAct/', res(200, DETAIL[87739])]]), dataDir, { ignoreRobots: true, maxDetails: 1 });
  assert.equal(out2.datasets[1].rows, 1, 'corrupt store treated as empty, not fatal');
});
