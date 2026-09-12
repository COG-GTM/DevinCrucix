// China / Taiwan sources + view model. Runs against recorded fixtures only — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseFeed } from '../apis/utils/rss.mjs';
import * as MND from '../apis/sources/taiwanmnd.mjs';
import * as CGA from '../apis/sources/taiwancga.mjs';
import * as GCA from '../apis/sources/gcataiwan.mjs';
import * as NEWS from '../apis/sources/taiwannews.mjs';
import * as MKT from '../apis/sources/taiwanmarkets.mjs';
import { buildTaiwanView, buildTaiwanGeo, trimMnd, trimGca, theaterSignals, LINK_OUTS } from '../lib/taiwanview.mjs';
import { buildSituation, TABS } from '../lib/situation.mjs';
import { LAYERS, evaluateLayers } from '../lib/maplayers.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'taiwan');
const fx = (name) => readFileSync(join(FIX, name), 'utf8');
const AT = '2026-09-12T19:00:00.000Z';

function mndParts() {
  const enList = MND.parseEnList(fx('mnd-en-list.html'));
  const zhList = MND.parseZhList(fx('mnd-zh-list.html'));
  const en = MND.parseEnArticle(fx('mnd-en-article.html'), enList[0]);
  const zh = MND.parseZhArticle(fx('mnd-zh-article.html'), zhList[0]);
  const sky = MND.parseSkyfaringCsv(fx('skyfaring-records.csv'));
  return { enList, zhList, en, zh, sky };
}
const mndResult = () => { const p = mndParts(); return MND.buildResult({ ...p, fetchedAt: AT }); };
const cgaResult = () => CGA.buildResult(parseFeed(fx('cga-rss.xml')), AT);
const gcaResult = () => GCA.buildResult(JSON.parse(fx('gca-events.json')), AT);
function newsResult() {
  const ft = NEWS.filterFeed(parseFeed(fx('focustaiwan-rss.xml')), NEWS.FEEDS[0], AT);
  const tt = NEWS.filterFeed(parseFeed(fx('taipeitimes-rss.xml')), NEWS.FEEDS[1], AT);
  return NEWS.combine([ft, tt], AT);
}
const rawMarket = (slug, yes, extra = {}) => ({
  slug, question: `Q ${slug}`, outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), oneDayPriceChange: 0.02,
  volume24hr: 1234.5, volume: 98765.4, liquidity: 4321.9, endDate: '2027-01-01T00:00:00Z', active: true, closed: false, ...extra,
});
const marketsResult = (missing = []) => MKT.buildResult(MKT.MARKETS.map((d, i) => missing.includes(d.slug) ? { slug: d.slug, error: 'market not found' } : { slug: d.slug, record: MKT.toRecord(rawMarket(d.slug, 0.1 + i * 0.05), d) }), AT);

// ---------------------------------------------------------------- MND

test('MND: EN and ZH lists parse with ISO dates; ids differ so pairing must be by date', () => {
  const { enList, zhList } = mndParts();
  assert.equal(enList.length, 9);
  assert.equal(enList[0].id, '87739');
  assert.equal(enList[0].date, '2026-09-11');
  assert.equal(enList[0].url, 'https://www.mnd.gov.tw/en/News/PLAAct/87739');
  assert.equal(zhList[0].id, '87738');
  assert.equal(zhList[0].date, '2026-09-11');
  assert.notEqual(enList[0].id, zhList[0].id);
});

test('MND: EN article yields counts, sectors and a 24 h window ending 06:00 UTC+8', () => {
  const { en } = mndParts();
  assert.equal(en.aircraft, 11);
  assert.equal(en.adizEntries, 10);
  assert.deepEqual(en.sectors, ['southwest', 'east']);
  assert.equal(en.planShips, 8);
  assert.equal(en.officialShips, 2);
  assert.equal(en.balloons, null);
  assert.equal(en.windowStart, '2026-09-09T22:00:00.000Z');
  assert.equal(en.windowEnd, '2026-09-10T22:00:00.000Z');
  assert.deepEqual(en.problems, []);
});

test('MND: ZH article discovers the real File/… map link instead of a guessed URL', () => {
  const { zh } = mndParts();
  assert.equal(zh.mapUrl, 'https://www.mnd.gov.tw/File/59160');
  assert.ok(zh.files.every(f => /^https:\/\/www\.mnd\.gov\.tw\/File\/\d+$/.test(f.url)));
  assert.equal(zh.aircraft, 11);
  assert.equal(zh.adizEntries, 10);
});

test('MND: Skyfaring CSV → 30-day trend; median-line crossings are not ADIZ entries', () => {
  const { sky } = mndParts();
  assert.ok(sky.rows.length >= 30);
  const row = sky.rows.find(r => r.date === '2026-09-11');
  assert.ok(row);
  assert.equal(row.aircraft, 11);
  assert.ok('medianLineCross' in row);
  assert.ok(!('adizEntries' in row));
  const r = mndResult();
  assert.equal(r.status, 'limited');            // bulletin is 42 h old at AT → limited, not live
  assert.equal(r.bulletin.crossCheck.state, 'agree');
  assert.equal(r.trend.length, 30);
  assert.equal(r.trend[29].date, '2026-09-12');
  assert.equal(r.trend[29].aircraft, null);        // no Skyfaring row for the fetch day → null, not 0
  assert.equal(r.stats.daysWithData, 29);
  assert.equal(r.stats.aircraft30d, 140);
  assert.equal(r.stats.avgAircraft, 4.8);
  assert.equal(r.stats.maxAircraft, 21);
  assert.equal(r.stats.maxAircraftDate, '2026-09-06');
  assert.deepEqual(r.parts, { mndList: 'ok', mndEn: 'ok', mndZh: 'ok', skyfaring: 'ok' });
  assert.ok(r.problems.some(p => /42 h old/.test(p)));
  assert.equal(r.sectors.filter(s => s.named).map(s => s.key).join(','), 'southwest,east');
});

test('MND: EN/ZH published on different dates are not paired (no map from another day)', () => {
  const p = mndParts();
  const zh = { ...p.zh, publishedDate: '2026-09-10' };
  const r = MND.buildResult({ ...p, zh, fetchedAt: AT });
  assert.equal(r.bulletin.mapUrl, null);
  assert.ok(r.problems.some(x => /ZH|Chinese|pair/i.test(x)));
});

test('MND: nothing fetched → unavailable, no fabricated counts', () => {
  const r = MND.buildResult({ enList: [], en: null, zh: null, sky: null, fetchedAt: AT, errors: { fetch: 'boom' } });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.bulletin, null);
  assert.ok(r.trend.every(t => t.aircraft === null && t.ships === null));
  assert.equal(r.stats.daysWithData, 0);
  assert.equal(r.stats.avgAircraft, null);
  assert.ok(r.error);
});

test('MND: cross-check states are honest', () => {
  const b = { publishedDate: '2026-09-11', aircraft: 11 };
  assert.equal(MND.crossCheck(b, { date: '2026-09-11', aircraft: 11 }).state, 'agree');
  assert.equal(MND.crossCheck(b, { date: '2026-09-11', aircraft: 14 }).state, 'disagree');
  assert.equal(MND.crossCheck(b, null).state, 'unconfirmed');
  assert.equal(MND.crossCheck(null, { date: '2026-09-11', aircraft: 11 }).state, 'none');
});

// ---------------------------------------------------------------- CGA

test('CGA: strict grey-zone filter keeps PRC-actor releases only', () => {
  const items = parseFeed(fx('cga-rss.xml'));
  assert.equal(items.length, 150);
  const kept = items.filter(CGA.isGreyZone);
  assert.equal(kept.length, 20);
  assert.ok(kept.every(i => /海警|中國|中共|大陸|陸船|陸籍|公務船|科研船|調查船|海事局|解放軍|共軍|共艦/.test(i.title)));
  assert.equal(CGA.isGreyZone({ title: '海巡署查獲走私菸品', description: '驅離' }), false);
  assert.equal(CGA.isGreyZone({ title: '海巡人員救援落海民眾', description: '' }), false);
});

test('CGA: record extracts hulls, count, area, in/out times; Chinese title preserved', () => {
  const r = cgaResult();
  assert.equal(r.status, 'live');
  const top = r.records[0];
  assert.equal(top.title, '中國海警連兩日侵擾金門 海巡頂浪強勢驅離堅守主權');
  assert.equal(top.kind, 'ccg-intrusion');
  assert.deepEqual(top.hulls, ['14527', '14604', '14531', '14608']);
  assert.equal(top.vesselCount, 4);
  assert.equal(top.area.en, 'Kinmen');
  assert.ok(Number.isFinite(top.area.radiusKm));
  assert.equal(top.entryTime, '09:00');
  assert.equal(top.exitTime, '11:13');
  assert.equal(top.published, '2026-09-11T00:00:00.000Z');
  assert.match(top.url, /^https?:\/\/www\.cga\.gov\.tw\//);
  assert.match(top.photoUrl, /^http:\/\/www\.cga\.gov\.tw\/.*\.jpg$/);
  assert.equal(top.partial, false);
  assert.equal(r.stats.ccgIntrusions30d, 8);
  assert.equal(r.stats.distinctHulls30d, 11);
  assert.equal(r.stats.byArea.kinmen, 7);
});

test('CGA: missing hulls / times produce a partial record, never invented values', () => {
  const rec = CGA.toRecord({ title: '中國海警船侵擾金門限制水域', description: '海巡署強勢驅離。', link: 'https://www.cga.gov.tw/x', published: '2026-09-10T00:00:00Z' });
  assert.equal(rec.partial, true);
  assert.deepEqual(rec.hulls, []);
  assert.equal(rec.entryTime, null);
  assert.equal(rec.exitTime, null);
  assert.equal(rec.area.en, 'Kinmen');
  assert.ok(rec.problems.length >= 2);
});

test('CGA: empty feed → unavailable; feed with no grey-zone item → empty', () => {
  assert.equal(CGA.buildResult([], AT).status, 'unavailable');
  assert.equal(CGA.buildResult([{ title: '海巡署淨灘活動', description: '', published: AT }], AT).status, 'empty');
});

// ---------------------------------------------------------------- GCA

test('GCA: relevance filter drops sport / business / Ireland-reunification noise, keeps PLA items', () => {
  assert.equal(GCA.isRelevant({ title: 'Ireland reunification vote gains support', summary: 'Sinn Fein says reunification of Ireland is closer' }), false);
  assert.equal(GCA.isRelevant({ title: 'FIFA World Cup qualifier: China beats Thailand', summary: 'football' }), false);
  assert.equal(GCA.isRelevant({ title: 'Chinese PLA aircraft to headline Egypt air show in display of export potential', summary: 'PLA Air Force aircraft overseas' }), false);
  assert.equal(GCA.isRelevant({ title: 'Taiwan shares slide on chip earnings', summary: 'stock market' }), false);
  assert.equal(GCA.isRelevant({ title: 'PLA Eastern Theater Command drills around Taiwan', summary: '' }), true);
  assert.equal(GCA.isRelevant({ title: 'Beijing plans reunification timetable for Taiwan, analysts say', summary: '' }), true);
  assert.equal(GCA.isRelevant({ title: 'We plan a picnic', summary: 'plan' }), false);   // lower-case "plan" ≠ PLAN
});

test('GCA: fixture keeps a minority of records, country-centroid points are flagged not placed', () => {
  const g = gcaResult();
  assert.equal(g.feedRecords, 200);
  assert.ok(g.keptRecords >= 15 && g.keptRecords <= 30, `kept ${g.keptRecords}`);
  assert.equal(g.stats.shown, g.records.length);
  assert.equal(g.stats.placed + g.stats.countryLevel, g.records.filter(r => r.locationPrecision !== 'none').length);
  assert.ok(g.records.every(r => ['named', 'region', 'country', 'none'].includes(r.locationPrecision)));
  assert.ok(g.records.filter(r => r.locationPrecision === 'country').every(r => Math.abs(r.lat - 23.6978) < 0.05 || /^(taiwan|china)$/i.test(r.locationName || '')));
  assert.equal(g.attribution, GCA.ATTRIBUTION);
  assert.equal(g.license, 'CC BY-NC 4.0');
  assert.equal(g.status, 'stale');                 // fixture latest is 78 h before AT
  assert.ok(g.records.every(r => r.title.length <= 160 && (r.summary || '').length <= 220));
  assert.ok(g.records.every(r => r.url === null || /^https?:\/\//.test(r.url)));
});

test('GCA: pubDate, date and Unix ts (s / ms) all parse', () => {
  const base = { title: 'PLA drills near Taiwan', lat: 24, lng: 119, locationName: 'Taiwan Strait' };
  assert.equal(GCA.toRecord({ ...base, pubDate: 'Wed, 09 Sep 2026 13:00:06 GMT' }).published, '2026-09-09T13:00:06.000Z');
  const secs = Date.parse('2026-09-09T13:00:06Z') / 1000;
  assert.equal(GCA.toRecord({ ...base, ts: secs }).published, '2026-09-09T13:00:06.000Z');
  assert.equal(GCA.toRecord({ ...base, ts: secs * 1000 }).published, '2026-09-09T13:00:06.000Z');
  assert.equal(GCA.toRecord(base).published, null);
  assert.equal(GCA.toRecord(base).locationPrecision, 'region');
});

test('GCA: empty / unusable payload → unavailable or empty, never a fabricated record', () => {
  assert.equal(GCA.buildResult([], AT).status, 'unavailable');
  assert.equal(GCA.buildResult({ events: [{ title: 'FIFA: China wins', summary: '' }] }, AT).status, 'empty');
});

// ---------------------------------------------------------------- News

test('News: security filter keeps cross-strait / defence headlines, drops markets and sport', () => {
  assert.equal(NEWS.isSecurityHeadline('China threatens US meeting over arms sales'), true);
  assert.equal(NEWS.isSecurityHeadline('Man critically injured in fire at Taitung air base'), true);
  assert.equal(NEWS.isSecurityHeadline('Taiwan shares close higher on tech gains'), false);
  assert.equal(NEWS.isSecurityHeadline('CPBL: Lions beat Monkeys in baseball opener'), false);
  const n = newsResult();
  assert.equal(n.status, 'live');
  assert.equal(n.headlines.length, 11);
  assert.equal(n.feeds.length, 2);
  assert.equal(n.feeds[0].feedItems, 30);
  assert.equal(n.feeds[0].kept, 7);
  assert.equal(n.feeds[1].kept, 4);
  for (const h of n.headlines) {
    assert.deepEqual(Object.keys(h).sort(), ['feed', 'offSite', 'outlet', 'published', 'title', 'url'], `unexpected field on ${JSON.stringify(h)}`);
    assert.equal(h.offSite, false);
    assert.match(h.url, /^https?:\/\/(focustaiwan\.tw|www\.taipeitimes\.com)\//);
  }
});

test('News: one feed down → limited with feed-level state', () => {
  const ok = NEWS.filterFeed(parseFeed(fx('focustaiwan-rss.xml')), NEWS.FEEDS[0], AT);
  const down = { ...NEWS.filterFeed([], NEWS.FEEDS[1], AT), error: 'timeout' };
  const n = NEWS.combine([ok, down], AT);
  assert.equal(n.status, 'limited');
  assert.equal(n.feeds[1].status, 'unavailable');
  assert.equal(NEWS.combine([{ ...down }, { ...down, key: 'x' }], AT).status, 'unavailable');
});

// ---------------------------------------------------------------- Markets

test('Markets: fixed slug allow-list, market-implied probability fields, missing slugs → limited', () => {
  assert.equal(MKT.MARKETS.length, 6);
  assert.ok(MKT.MARKETS.every(m => /taiwan/.test(m.slug) && ['invasion', 'clash', 'blockade'].includes(m.kind)));
  const live = marketsResult();
  assert.equal(live.status, 'live');
  assert.equal(live.markets.length, 6);
  const m = live.markets[0];
  assert.equal(m.impliedProbability, 10);
  assert.equal(m.totalVolume, 98765);
  assert.equal(m.liquidity, 4322);
  assert.equal(m.active, true);
  assert.equal(m.url, `https://polymarket.com/event/${m.slug}`);
  assert.ok(live.summary.invasionCurve.length === 4);
  assert.ok(live.summary.invasionCurve.every((p, i, a) => i === 0 || a[i - 1].horizon <= p.horizon));
  assert.match(live.disclaimer.join(' '), /Market-implied probability .* not an intelligence assessment/);
  const lim = marketsResult(['will-china-blockade-taiwan-by-in-2026']);
  assert.equal(lim.status, 'limited');
  assert.equal(lim.summary.blockade, null);
  assert.equal(marketsResult(MKT.MARKETS.map(m => m.slug)).status, 'unavailable');
});

// ---------------------------------------------------------------- View + geo

function sources() {
  return { TaiwanMND: mndResult(), TaiwanCGA: cgaResult(), TaiwanNews: newsResult(), GCATaiwan: gcaResult(), TaiwanMarkets: marketsResult() };
}
const V2 = () => ({
  air: [
    { region: 'Taiwan Strait', total: 40, top: [['China', 12], ['Taiwan', 9]], tracks: [{ icao24: 'a', country: 'China', lat: 24, lon: 119 }, { icao24: 'b', country: 'Japan', lat: 25, lon: 121 }] },
    { region: 'South China Sea', total: 25, top: [['China', 7]], tracks: [{ icao24: 'c', country: 'China', lat: 15, lon: 114 }] },
    { region: 'Ukraine Region', total: 9, top: [], tracks: [] },
  ],
  airMeta: { source: 'opensky', fallback: false, status: 'live', dataTimestamp: AT },
  adsbMilitary: {
    status: 'live', totalMilitary: 12,
    categories: {
      reconnaissance: [{ callsign: 'RC135A', type: 'RC-135', country: 'US', lat: 26.1, lon: 124.8 }, { callsign: 'FAR', type: 'P-8', country: 'US', lat: 50, lon: -1 }],
      tankers: [{ callsign: 'KC135', type: 'KC-135', country: 'US', lat: 25.5, lon: 127.3 }],
      bombers: [],
    },
  },
  carriers: { status: 'live', carriers: [{ hull: 'CVN-76', name: 'USS Ronald Reagan', type: 'CVN', lat: 20.5, lng: 125.0, estimated: true, source: 'OSINT' }, { hull: 'CVN-69', name: 'Y', lat: 30, lng: -70 }] },
  gdelt: { headlines: [] },
});

test('View: compact payload is bounded, statuses are the known vocabulary, sources kept apart', () => {
  const v = buildTaiwanView(sources(), V2());
  assert.equal(v.source, 'Taiwan');
  assert.equal(v.status, 'limited');            // MND limited + GCA stale → limited
  assert.deepEqual(v.parts, { mnd: 'limited', cga: 'live', news: 'live', gca: 'stale', markets: 'live' });
  assert.ok(v.mnd.trend.length <= 31);
  assert.ok(v.cga.incidents.length <= 40);
  assert.ok(v.news.headlines.length <= 30);
  assert.ok(v.gca.records.length <= 24);
  assert.ok(v.markets.markets.length <= 8);
  assert.equal(v.mnd.bulletin.aircraft, 11);
  assert.ok(!('adizEntries' in v.mnd.trend[0]));
  assert.equal(v.gca.attribution, GCA.ATTRIBUTION);
  assert.ok(v.linkOuts.length >= 4 && v.linkOuts === LINK_OUTS);
  assert.ok(v.linkOuts.every(l => /^https:\/\//.test(l.url) && l.reason && l.name));
  const json = JSON.stringify(v);
  assert.ok(json.length < 120_000, `payload ${json.length} bytes`);
});

test('View: theater signals reuse existing OpenSky / ADS-B / carrier data cut to the theater', () => {
  const s = theaterSignals(V2());
  assert.equal(s.strait.total, 40);
  assert.equal(s.strait.chinaTracks, 1);
  assert.deepEqual(s.strait.top[0], ['China', 12]);
  assert.equal(s.scs.total, 25);
  assert.equal(s.air.source, 'opensky');
  assert.equal(s.air.fallback, false);
  assert.equal(s.adsbMilitary.total, 12);
  assert.equal(s.isr.length, 2, 'only in-theater ISR / tanker airframes');
  assert.ok(s.isr.every(a => a.lon > 105 && a.lon < 150));
  assert.equal(s.carriers.length, 1);
  assert.equal(s.carriers[0].lon, 125);
  assert.equal(s.carriers[0].estimated, true);
  assert.ok(Number.isFinite(s.prcTension.score) || s.prcTension.score === null);
});

test('View: unknown or failed statuses normalise to unavailable; nothing live → unavailable overall', () => {
  assert.equal(trimMnd({ status: 'failed' }).status, 'unavailable');
  assert.equal(trimGca({ status: 'weird' }).status, 'unavailable');
  assert.equal(trimGca({ status: 'link-out' }).status, 'link-out');
  const v = buildTaiwanView({}, {});
  assert.equal(v.status, 'unavailable');
  assert.equal(v.mnd.bulletin, null);
  assert.deepEqual(v.cga.incidents, []);
});

test('Geo: every feature carries a precision class; country-level GCA points are not emitted', () => {
  const g = buildTaiwanGeo(sources());
  assert.equal(g.count, g.features.length);
  const by = g.features.reduce((a, f) => { a[f.type] = (a[f.type] || 0) + 1; return a; }, {});
  assert.equal(by['mnd-adiz'], 5);
  assert.ok(by['cga-incident'] >= 15);
  assert.ok(by['gca-taiwan'] >= 10);
  assert.ok(g.features.filter(f => f.type === 'mnd-adiz').every(f => f.precision === 'sector'));
  assert.ok(g.features.filter(f => f.type === 'cga-incident').every(f => f.precision === 'area' && Number.isFinite(f.radiusKm)));
  assert.ok(g.features.filter(f => f.type === 'gca-taiwan').every(f => (f.precision === 'named' || f.precision === 'region') && Math.abs(f.lat - 23.6978) > 0.05));
  assert.equal(g.features.filter(f => f.type === 'mnd-adiz' && f.named).length, 2);
  assert.equal(g.attribution, GCA.ATTRIBUTION);
  assert.ok(g.features.every(f => f.url === undefined || f.url === null || /^https?:\/\//.test(f.url)));
});

// ---------------------------------------------------------------- Situation + layers

test('Situation: taiwan tab is registered; MND spike → elevated headline, CGA intrusion → info', () => {
  assert.ok(TABS.includes('taiwan'));
  const base = V2();
  const quiet = buildSituation({ ...base, taiwan: buildTaiwanView(sources(), base) });
  assert.ok(!quiet.headlines.some(h => h.rule === 'taiwan-mnd'), 'bulletin 11 vs avg 4.8 is not a spike');
  const spiked = buildTaiwanView(sources(), base);
  spiked.mnd.bulletin.aircraft = 45;
  spiked.cga.incidents[0].published = new Date().toISOString();
  const s = buildSituation({ ...base, taiwan: spiked });
  const mnd = s.headlines.find(h => h.rule === 'taiwan-mnd');
  assert.ok(mnd, 'mnd headline');
  assert.equal(mnd.severity, 'elevated');
  assert.equal(mnd.tab, 'taiwan');
  assert.match(mnd.why, /Official daily count/);
  const cga = s.headlines.find(h => h.rule === 'taiwan-cga');
  assert.ok(cga, 'cga headline');
  assert.equal(cga.severity, 'info');
  assert.match(cga.why, /no vessel positions/);
  assert.match(cga.title, /Kinmen/);
});

test('Layers: mnd-adiz / cga-incidents / gca-taiwan are data layers with uncertainty in `why`', () => {
  const ids = LAYERS.map(l => l.id);
  for (const id of ['mnd-adiz', 'cga-incidents', 'gca-taiwan']) assert.ok(ids.includes(id), id);
  const base = V2();
  const { layers: rows } = evaluateLayers({ ...base, taiwan: buildTaiwanView(sources(), base) });
  const get = (id) => rows.find(r => r.id === id);
  assert.equal(get('mnd-adiz').state, 'data');
  assert.equal(get('mnd-adiz').count, 2);
  assert.match(get('mnd-adiz').why, /11 aircraft · 10 ADIZ entries · 8 PLAN ships/);
  assert.equal(get('cga-incidents').state, 'data');
  assert.match(get('cga-incidents').why, /CCG intrusions/);
  assert.equal(get('gca-taiwan').state, 'data');
  assert.match(get('gca-taiwan').why, /country-level \(not drawn\)/);
  const off = evaluateLayers({ ...base, taiwan: buildTaiwanView({}, base) }).layers;
  for (const id of ['mnd-adiz', 'cga-incidents', 'gca-taiwan']) assert.equal(off.find(r => r.id === id).state, 'none');
});
