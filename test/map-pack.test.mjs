// Map layer pack — normalizers (recorded fixtures under test/fixtures/map/) and the /api/map routes
// driven with injected fetchers. No network.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import express from 'express';

import { normalizeTfrs, notamIdOf } from '../apis/sources/faatfr.mjs';
import { normalizeSua, suaUrl } from '../apis/sources/faasua.mjs';
import { parseNas, nasPoints } from '../apis/sources/faanas.mjs';
import { normalizeAircraft, aircraftPoint, fetchArea, fetchMilitary } from '../apis/sources/adsblive.mjs';
import { parseSdnVessels, OfacVesselIndex } from '../apis/sources/ofacvessels.mjs';
import { AisTankerFeed, parseAisMessage, tankerDatasets, vesselStatus, GAP_MIN } from '../apis/sources/aistankers.mjs';
import { normalizeTmPage, normalizeWikidata, festivalDatasets, tmUrl } from '../apis/sources/festivals.mjs';
import { normalizeRadarCountry, liveScore, aiUsagePayload, liveCountries, loadIndex } from '../apis/sources/aiusage.mjs';
import { LayerCache } from '../lib/map/cache.mjs';
import { parseCsv } from '../lib/map/csv.mjs';
import { createMapLayers, conflictPolygons } from '../lib/map/layers.mjs';
import { createMapRouter } from '../lib/map/router.mjs';

const fx = (name) => readFileSync(new URL(`./fixtures/map/${name}`, import.meta.url), 'utf8');
const fxJson = (name) => JSON.parse(fx(name));

describe('faatfr', () => {
  it('joins the TFR list with WFS shapes on the NOTAM id and reports shapeless TFRs', () => {
    assert.equal(notamIdOf('6/9169-1-FDC-F'), '6/9169');
    const wfs = fxJson('tfr-wfs.json');
    const list = [
      { notam_id: '6/9169', type: 'SECURITY', facility: 'ZDC', state: 'NC', description: 'RALEIGH, NC …', creation_date: '10/13/2026' },
      { notam_id: '9/9999', type: 'VIP', facility: 'ZNY', state: 'NY', description: 'no shape yet', creation_date: '10/23/2026' },
    ];
    const out = normalizeTfrs(list, wfs);
    assert.equal(out.polygons.length, 3);
    const p = out.polygons.find(x => x.id === '6/9169');
    assert.equal(p.type, 'SECURITY');
    assert.match(p.head, /TFR 6\/9169 · Security/);
    assert.match(p.meta, /ARTCC ZDC/);
    assert.equal(p.geometry.type, 'Polygon');
    assert.deepEqual(out.noShape.map(x => x.id), ['9/9999']);
    assert.equal(out.total, 2);
    assert.equal(out.byType.VIP, 1);
  });
  it('falls back to the WFS LEGAL type when the TFR is not in the list', () => {
    const out = normalizeTfrs([], fxJson('tfr-wfs.json'));
    assert.equal(out.polygons.length, 3);
    assert.ok(out.polygons.every(p => p.type && p.fill));
  });
});

describe('faasua', () => {
  it('builds a paged ArcGIS query and keeps only P/R polygons', () => {
    const u = new URL(suaUrl(['P', 'R'], 2000));
    assert.equal(u.searchParams.get('where'), "TYPE_CODE IN ('P','R')");
    assert.equal(u.searchParams.get('resultOffset'), '2000');
    assert.equal(u.searchParams.get('f'), 'geojson');
    const polys = normalizeSua([...fxJson('sua-p.json').features, { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { NAME: 'W-123', TYPE_CODE: 'W' } }]);
    assert.equal(polys.length, 2);
    assert.ok(polys.every(p => p.type === 'P' && /Prohibited/.test(p.head)));
  });
});

describe('faanas', () => {
  it('parses ground delays, delays and closures and places known airports', () => {
    const parsed = parseNas(fx('nas-status.xml'));
    assert.ok(parsed.updateTime);
    const kinds = new Set(parsed.events.map(e => e.kind));
    assert.ok(kinds.has('ground_delay') && kinds.has('delay') && kinds.has('closure'));
    const san = parsed.events.filter(e => e.airport === 'SAN');
    assert.ok(san.length >= 2);
    const { points, unplaced } = nasPoints(parsed.events);
    const sfo = points.find(p => p.airport === 'SFO');
    assert.ok(sfo && Math.abs(sfo.lat - 37.62) < 0.1);
    assert.equal(sfo.severity, 'ground_delay');
    assert.match(sfo.text, /GDP avg/);
    assert.ok(unplaced.some(u => u.code === 'YUL') || points.some(p => p.airport === 'YUL'));
  });
  it('ranks the worst event per airport', () => {
    const { points } = nasPoints([{ airport: 'SFO', kind: 'delay', reason: 'x', min: '1', max: '2' }, { airport: 'SFO', kind: 'ground_stop', reason: 'wx', end: '20:00' }]);
    assert.equal(points[0].severity, 'ground_stop');
    assert.match(points[0].text, /^GROUND STOP/);
  });
});

describe('adsblive', () => {
  it('normalizes readsb aircraft and drops those without a position', () => {
    const d = fxJson('adsb-mil.json');
    const contacts = d.ac.map(a => normalizeAircraft(a, { military: true })).filter(Boolean);
    assert.equal(contacts.length, 5);
    const c = contacts[0];
    assert.ok(c.hex && Number.isFinite(c.lat) && Number.isFinite(c.lng));
    assert.equal(c.military, true);
    const pt = aircraftPoint(c);
    assert.equal(pt.color, '#ff9100');
    assert.match(pt.meta, /MILITARY/);
    assert.equal(normalizeAircraft({ hex: 'abc', alt_baro: 'ground' }), null);
    assert.equal(aircraftPoint(normalizeAircraft({ hex: 'abc', lat: 1, lon: 2, alt_baro: 'ground' })).text.split(' · ')[0], 'on ground');
  });
  it('falls back to the second provider and clamps the radius', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return url.includes('adsb.lol') ? { error: 'HTTP 503' } : { ac: [{ hex: 'a1', lat: 1, lon: 2, alt_baro: 1000 }], now: 1 }; };
    const r = await fetchArea(38.9, -77, 999, { fetchImpl });
    assert.equal(r.provider, 'adsb.fi');
    assert.equal(r.contacts.length, 1);
    assert.match(calls[1], /\/dist\/250$/);
    assert.deepEqual(r.notes, ['adsb.lol: HTTP 503']);
    await assert.rejects(fetchMilitary({ fetchImpl: async () => ({ error: 'down' }) }), /adsb\.lol: down; adsb\.fi: down/);
  });
});

describe('ofacvessels', () => {
  it('indexes SDN vessels by IMO / MMSI / name', () => {
    const idx = parseSdnVessels(fx('sdn-vessels.csv'));
    assert.equal(idx.total, 6);
    assert.ok(idx.byImo.get('7406784'));
    assert.equal(idx.byImo.get('7406784').name, 'EBANO');
    assert.equal(idx.byName.get('EBANO').program, 'CUBA');
    const i = new OfacVesselIndex({ fetchImpl: async () => ({ rawText: fx('sdn-vessels.csv') }) });
    return i.load().then(() => {
      assert.equal(i.match({ imo: '7406784' }).name, 'EBANO');
      assert.equal(i.match({ name: 'ebano' }).name, 'EBANO');
      assert.equal(i.match({ mmsi: '000000000' }), null);
      assert.equal(i.stats.total, 6);
    });
  });
  it('parseCsv handles quotes and embedded commas', () => {
    assert.deepEqual(parseCsv('a,b\n1,"x, ""y"""\n'), [{ a: '1', b: 'x, "y"' }]);
  });
});

describe('aistankers', () => {
  const pos = (mmsi, over = {}) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: 'HULL @@', latitude: 26.5, longitude: 56.4, time_utc: '2026-10-23 19:00:00.1 +0000 UTC' }, Message: { PositionReport: { Latitude: 26.5, Longitude: 56.4, Sog: 11, Cog: 95, TrueHeading: 96, NavigationalStatus: 0, ...over } } });
  const stat = (mmsi, type, over = {}) => ({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi }, Message: { ShipStaticData: { Type: type, ImoNumber: 7406784, Destination: 'FUJAIRAH@@', Name: 'HULL', Dimension: { A: 180, B: 60 }, MaximumStaticDraught: 15, ...over } } });
  it('parses position + static messages and only reports typed tankers', () => {
    const now = Date.parse('2026-10-23T19:05:00Z');
    const p = parseAisMessage(pos(211111111), now);
    assert.equal(p.mmsi, '211111111'); assert.equal(p.name, 'HULL'); assert.equal(p.posAt, Date.parse('2026-10-23T19:00:00.1Z'));
    assert.equal(parseAisMessage({ MessageType: 'PositionReport', MetaData: { MMSI: 12 } }), null);
    const f = new AisTankerFeed({ apiKey: 'k', WebSocketImpl: null });
    f.ingest(pos(211111111), now); f.ingest(pos(222222222), now); f.ingest(stat(222222222, 70), now);
    assert.equal(f.tankers({ nowMs: now }).length, 0);
    f.ingest(stat(211111111, 81), now);
    const t = f.tankers({ nowMs: now });
    assert.equal(t.length, 1); assert.equal(t[0].imo, '7406784'); assert.equal(t[0].destination, 'FUJAIRAH'); assert.equal(t[0].length, 240);
    assert.equal(f.stats.vessels, 2); assert.equal(f.stats.tankers, 1);
  });
  it('flags AIS gaps, sanctioned hulls and counts tankers at chokepoints', async () => {
    const now = Date.parse('2026-10-23T19:00:00Z');
    const f = new AisTankerFeed({ apiKey: 'k', WebSocketImpl: null });
    f.ingest(pos(211111111), now); f.ingest(stat(211111111, 80), now);
    f.ingest(pos(233333333, { NavigationalStatus: 1, Sog: 0 }), now); f.ingest(stat(233333333, 80, { ImoNumber: 1, Name: 'OTHER' }), now);
    const idx = new OfacVesselIndex({ fetchImpl: async () => ({ rawText: fx('sdn-vessels.csv') }) }); await idx.load();
    const later = now + (GAP_MIN + 5) * 60_000;
    const vessels = f.tankers({ sanctions: idx, nowMs: later });
    const hull = vessels.find(v => v.mmsi === '211111111'), other = vessels.find(v => v.mmsi === '233333333');
    assert.equal(hull.sanction.program, 'CUBA');
    assert.equal(vesselStatus(hull, later), 'gap');
    assert.equal(vesselStatus(other, later), 'stopped');
    const ds = tankerDatasets(vessels, { nowMs: later });
    assert.deepEqual(ds.counts, { underway: 0, stopped: 1, gap: 1, sanctioned: 1 });
    assert.equal(ds.chokepoints.find(c => c.id === 'straitOfHormuz').tankers, 2);
    assert.equal(ds.rings.length, 9);
    assert.match(ds.points.find(p => p.mmsi === '211111111').head, /OFAC SANCTIONED/);
    assert.equal(ds.points.find(p => p.mmsi === '211111111').color, '#ff1744');
  });
  it('stays idle without a key and expires stale vessels', () => {
    const f = new AisTankerFeed({ apiKey: '', WebSocketImpl: null }).start();
    assert.equal(f.state, 'no_key');
    const g = new AisTankerFeed({ apiKey: 'k', WebSocketImpl: null });
    const t0 = Date.parse('2026-10-23T00:00:00Z');
    g.ingest(pos(211111111), t0); g.expire(t0 + 7 * 3600_000);
    assert.equal(g.vessels.size, 0);
  });
});

describe('festivals', () => {
  it('normalizes Ticketmaster events with coordinates and derives live / upcoming', () => {
    const page = fxJson('ticketmaster-events.json');
    const before = Date.parse('2016-03-06T10:00:00Z'), during = Date.parse('2016-03-06T13:00:00Z'), after = Date.parse('2016-03-08T00:00:00Z');
    assert.equal(normalizeTmPage(page, before)[0].status, 'upcoming');
    assert.equal(normalizeTmPage(page, during)[0].status, 'live');
    assert.equal(normalizeTmPage(page, after).length, 0);
    const e = normalizeTmPage(page, before)[0];
    assert.equal(e.city, 'Miami'); assert.equal(e.country, 'US'); assert.ok(Math.abs(e.lat - 25.81) < 0.01);
    const u = new URL(tmUrl('KEY', { nowMs: before }));
    assert.equal(u.searchParams.get('classificationName'), 'music');
    assert.equal(u.searchParams.get('keyword'), 'festival');
    assert.match(u.searchParams.get('startDateTime'), /^2016-03-05T22:00:00Z$/);
  });
  it('dedupes Wikidata rows and builds live rings', () => {
    const majors = normalizeWikidata(fxJson('wikidata-festivals.json'));
    const lorient = majors.find(m => m.id === 'Q2322517');
    assert.equal(lorient.visitors, 950000);
    assert.equal(majors.filter(m => m.id === 'Q2322517').length, 1);
    const now = Date.parse('2026-10-23T20:00:00Z');
    const ds = festivalDatasets([{ id: 'e1', name: 'Fest', venue: 'V', start: '2026-10-23T18:00:00.000Z', end: '2026-10-24T04:00:00.000Z', status: 'live', lat: 1, lng: 2, acts: ['A'], city: 'C', country: 'US', url: 'http://x' }], majors, { nowMs: now });
    assert.equal(ds.rings.length, 1);
    assert.equal(ds.counts.live, 1);
    assert.match(ds.points[0].head, /LIVE NOW/);
    assert.equal(ds.points.length, 1 + majors.length);
  });
});

describe('aiusage', () => {
  it('reads ranks and buckets from Radar and scores them', () => {
    const r = normalizeRadarCountry('US', {
      'chatgpt.com': { result: { details_0: { rank: 53, bucket: '200' } } },
      'claude.ai': { result: { details_0: { rank: null, bucket: '500' } } },
    }, { result: { top_0: [{ rank: 1, service: 'ChatGPT / OpenAI' }, { rank: 2, service: 'Claude / Anthropic' }] } });
    assert.deepEqual(r.ranks, { 'chatgpt.com': 53, 'claude.ai': 500 });
    assert.equal(r.bestRank, 53);
    assert.deepEqual(r.services, ['ChatGPT / OpenAI', 'Claude / Anthropic']);
    assert.equal(liveScore(1), 100); assert.equal(liveScore(1000), 0); assert.equal(liveScore(null), 0);
    assert.ok(liveScore(53) > liveScore(500));
  });
  it('joins the static index with live data', () => {
    const idx = loadIndex();
    assert.ok(idx.countries.length > 150 && idx.states.length === 51);
    const live = { countries: { US: { bestRank: 53, ranks: { 'chatgpt.com': 53 }, services: ['ChatGPT / OpenAI'] } } };
    const p = aiUsagePayload(idx, live);
    const us = p.countries.find(c => c.a2 === 'US');
    assert.equal(us.live.score, liveScore(53));
    assert.equal(p.countries.find(c => c.a2 === 'FR').live, null);
    assert.ok(p.countries[0].rank === 1 && p.countries[0].index >= p.countries[1].index);
    assert.ok(liveCountries(idx).includes('US') && liveCountries(idx).length <= 60);
  });
});

describe('LayerCache', () => {
  it('serves fresh, then stale on failure, and dedupes in-flight producers', async () => {
    const c = new LayerCache({ ttlMs: 50 });
    let n = 0;
    const [a, b] = await Promise.all([c.get('k', async () => ++n), c.get('k', async () => ++n)]);
    assert.equal(a.value, 1); assert.equal(b.value, 1); assert.equal(n, 1);
    await new Promise(r => setTimeout(r, 60));
    const s = await c.get('k', async () => { throw new Error('boom'); });
    assert.equal(s.value, 1); assert.equal(s.stale, true); assert.equal(s.error, 'boom');
    await assert.rejects(c.get('new', async () => { throw new Error('first'); }), /first/);
  });
});

test('/api/map routes', async (t) => {
  const deps = {
    fetchTfrs: async () => ({ ...normalizeTfrs([{ notam_id: '6/9169', type: 'SECURITY' }], fxJson('tfr-wfs.json')), notes: [] }),
    fetchSua: async () => normalizeSua(fxJson('sua-p.json').features),
    fetchNas: async () => { const p = parseNas(fx('nas-status.xml')); return { ...p, ...nasPoints(p.events) }; },
    fetchMilitary: async () => ({ provider: 'fixture', contacts: fxJson('adsb-mil.json').ac.map(a => normalizeAircraft(a, { military: true })).filter(Boolean), notes: [] }),
    fetchArea: async () => { throw new Error('area down'); },
    fetchTicketmaster: async () => ({ events: normalizeTmPage(fxJson('ticketmaster-events.json'), Date.parse('2016-03-06T13:00:00Z')), notes: [] }),
    fetchWikidataFestivals: async () => normalizeWikidata(fxJson('wikidata-festivals.json')),
    fetchRadarLive: async () => ({ countries: { US: normalizeRadarCountry('US', { 'chatgpt.com': { result: { details_0: { rank: 53 } } } }, null) }, notes: [] }),
  };
  const ofac = new OfacVesselIndex({ fetchImpl: async () => ({ rawText: fx('sdn-vessels.csv') }) });
  const feed = new AisTankerFeed({ apiKey: '', WebSocketImpl: null });
  const jamming = { zones: [{ gridLat: 54, gridLng: 20, gridSize: 1, severity: 'HIGH', pctLabel: '60%', total: 10, region: 'Kaliningrad' }] };
  const mk = (env) => { const app = express(); app.use('/api/map', createMapRouter(createMapLayers({ env, deps, ofac, aisFeed: feed, getCurrentData: () => ({ gpsJamming: jamming }) }).layers)); return app; };
  const app = mk({});
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

  await t.test('index + 404', async () => {
    assert.deepEqual((await get('/api/map')).body.layers, ['nofly', 'aviation', 'traffic', 'tankers', 'festivals', 'aiusage']);
    assert.equal((await get('/api/map/nope')).status, 404);
  });
  await t.test('nofly: TFR + SUA + conflict polygons in one envelope', async () => {
    const { status, body } = await get('/api/map/nofly');
    assert.equal(status, 200); assert.equal(body.layer, 'nofly'); assert.equal(body.status, 'live');
    assert.equal(body.counts.polygons, 3 + 2 + conflictPolygons().length);
    assert.equal(body.summary.conflict, 16);
    assert.ok(body.polygons.some(p => p.kind === 'conflict' && p.id === 'UA'));
  });
  await t.test('aviation: military points + airports + jamming polygons', async () => {
    const { body } = await get('/api/map/aviation');
    assert.equal(body.status, 'live');
    assert.equal(body.summary.military, 5);
    assert.ok(body.summary.airports >= 3);
    assert.equal(body.summary.jammingCells, 1);
    assert.equal(body.polygons[0].kind, 'jamming');
    assert.match(body.source, /fixture/);
  });
  await t.test('traffic: validates the query and surfaces upstream failure as 502', async () => {
    assert.deepEqual((await get('/api/map/traffic?lat=99&lon=0')).body, { error: 'invalid request', field: 'lat' });
    assert.equal((await get('/api/map/traffic?lon=0')).status, 400);
    assert.equal((await get('/api/map/traffic?lat=1&lon=0&dist=2.5')).status, 400);
    const r = await get('/api/map/traffic?lat=38.9&lon=-77&dist=100');
    assert.equal(r.status, 502); assert.equal(r.body.error, 'upstream unavailable');
  });
  await t.test('tankers without a key: no_key + chokepoint rings, sanctions index loaded', async () => {
    const { body } = await get('/api/map/tankers');
    assert.equal(body.status, 'no_key');
    assert.equal(body.counts.rings, 9); assert.equal(body.counts.points, 0);
    assert.match(body.notes[0], /AISSTREAM_API_KEY/);
    await ofac.load();
    assert.equal((await get('/api/map/tankers')).body.summary.sanctionsIndex.total, 6);
  });
  await t.test('festivals: no_key → Wikidata only; with key → Ticketmaster events + live ring', async () => {
    const a = (await get('/api/map/festivals')).body;
    assert.equal(a.status, 'no_key'); assert.equal(a.summary.live, 0); assert.ok(a.summary.major >= 1);
    const app2 = mk({ TICKETMASTER_API_KEY: 'k' });
    const s2 = app2.listen(0, '127.0.0.1'); await new Promise(r => s2.once('listening', r));
    try {
      const b = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/map/festivals`)).json();
      assert.equal(b.status, 'live'); assert.equal(b.summary.live, 1); assert.equal(b.counts.rings, 1);
    } finally { await new Promise(r => s2.close(r)); }
  });
  await t.test('aiusage: static index without a token, live ranks with one', async () => {
    const a = (await get('/api/map/aiusage')).body;
    assert.equal(a.status, 'no_key'); assert.equal(a.countries.length, loadIndex().countries.length); assert.equal(a.states.length, 51);
    assert.equal(a.countries.find(c => c.a2 === 'US').live, null);
    const app2 = mk({ CLOUDFLARE_API_TOKEN: 't' });
    const s2 = app2.listen(0, '127.0.0.1'); await new Promise(r => s2.once('listening', r));
    try {
      const b = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/map/aiusage`)).json();
      assert.equal(b.status, 'live'); assert.equal(b.summary.liveCountries, 1); assert.equal(b.countries.find(c => c.a2 === 'US').live.bestRank, 53);
    } finally { await new Promise(r => s2.close(r)); }
  });
});

describe('geo orientation', () => {
  it('forces clockwise exterior rings and counter-clockwise holes (Globe.gl convention)', async () => {
    const { orientGeometry, ringArea } = await import('../lib/map/geo.mjs');
    const ccw = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const hole = [[0.2, 0.2], [0.2, 0.4], [0.4, 0.4], [0.4, 0.2], [0.2, 0.2]]; // cw
    const g = orientGeometry({ type: 'Polygon', coordinates: [ccw, hole] });
    assert.ok(ringArea(g.coordinates[0]) < 0);
    assert.ok(ringArea(g.coordinates[1]) > 0);
    const tfr = normalizeTfrs([], fxJson('tfr-wfs.json'));
    assert.ok(tfr.polygons.every(p => ringArea(p.geometry.coordinates[0]) < 0));
    const mp = orientGeometry({ type: 'MultiPolygon', coordinates: [[ccw]] });
    assert.ok(ringArea(mp.coordinates[0][0]) < 0);
    assert.equal(orientGeometry(null), null);
  });
});
