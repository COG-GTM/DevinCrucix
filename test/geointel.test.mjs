// Geo-intelligence additions: OSM proximity (Overpass), VIIRS night-lights change, evidence locker.
// Pure functions and stores are exercised with fixtures and a mocked fetch; nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

import { buildQuery, parseElements, pairWithin, normalizeKinds, clampRadius, haversineM, bearingDeg, compass, cacheKey, OverpassClient, KINDS, MAX_KINDS, MAX_RADIUS_M, MIN_RADIUS_M, MAX_PER_KIND, QUERY_TIMEOUT_S } from '../lib/geo/overpass.mjs';
import { decodePngGray, cellMeans, diffCells, lonLatToTile, tilePixelToLonLat, tilesFor, tileUrl, nearestPlace, NightLights, NODATA, CELL_PX, TILE_PX, MAX_TILES, GIBS_LAYER, MIN_LIT, MAX_CELLS } from '../lib/geo/nightlights.mjs';
import { EvidenceLocker, verifyChain, sha256, titleOf, waybackLookup, waybackSave, GENESIS, MAX_PER_TARGET, MAX_BYTES, EVIDENCE_ID_RE } from '../lib/targeting/evidence.mjs';

// ---------- helpers
const resp = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
/** Minimal PNG encoder for the fixtures: palette (ctype 3, grey ramp, index 0 transparent) or grey (ctype 0). */
function png(width, height, pixelAt, { palette = true, filter = 0 } = {}) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width);
    for (let x = 0; x < width; x++) row[x] = pixelAt(x, y);
    if (filter === 1) { for (let x = width - 1; x > 0; x--) row[x] = (row[x] - row[x - 1]) & 255; }
    rows.push(Buffer.from([filter]), row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = palette ? 3 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) {
    const plte = Buffer.alloc(256 * 3), trns = Buffer.alloc(256, 255);
    for (let i = 0; i < 256; i++) { const g = i === 0 ? 0 : Math.min(255, i); plte[i * 3] = plte[i * 3 + 1] = plte[i * 3 + 2] = g; }
    trns[0] = 0;
    parts.push(chunk('PLTE', plte), chunk('tRNS', trns));
  }
  parts.push(chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- Overpass
test('overpass: query is bounded and literal', () => {
  assert.deepEqual(normalizeKinds('hospital, police,bogus;hospital'), ['hospital', 'police']);
  assert.equal(normalizeKinds(['a', 'b', 'c', 'd', 'e', 'f'].map(() => 'hospital')).length, 1);
  assert.equal(normalizeKinds(Object.keys(KINDS)).length, MAX_KINDS);
  assert.equal(clampRadius(5), MIN_RADIUS_M);
  assert.equal(clampRadius(1e9), MAX_RADIUS_M);
  assert.equal(clampRadius('nope'), 2000);
  const q = buildQuery({ lat: 4.711, lon: -74.0721, radiusM: 3000, kinds: ['hospital', 'military'] });
  assert.match(q, new RegExp(`^\\[out:json\\]\\[timeout:${QUERY_TIMEOUT_S}\\];`));
  assert.ok(q.includes('(around:3000,4.71100,-74.07210)'));
  assert.ok(q.includes(`.hospital out center tags ${MAX_PER_KIND};`));
  assert.ok(q.includes('["landuse"="military"]') && q.includes('["military"]'));
  assert.ok(!q.includes('out body;'), 'never an unbounded out');
});

test('overpass: elements -> features with distance/bearing, per-kind cap, pairing', () => {
  const q = { lat: 4.7, lon: -74.07, kinds: ['hospital', 'police'] };
  const json = { osm3s: { timestamp_osm_base: '2026-10-03T00:00:00Z' }, elements: [
    { type: 'node', id: 1, lat: 4.71, lon: -74.07, tags: { amenity: 'hospital', name: 'Hospital Norte', operator: 'X', 'addr:street': 'secret' } },
    { type: 'way', id: 2, center: { lat: 4.7, lon: -74.06 }, tags: { amenity: 'police', name: 'CAI' } },
    { type: 'node', id: 3, lat: 4.7, lon: -74.08, tags: { amenity: 'clinic' } },
    { type: 'node', id: 4, lat: 4.7, lon: -74.09, tags: { amenity: 'school' } },      // kind not requested
    { type: 'relation', id: 5, tags: { amenity: 'hospital' } },                        // no geometry
  ] };
  const f = parseElements(json, q);
  assert.equal(f.length, 3);
  assert.equal(f[0].id, 'way/2');                                 // sorted by distance (≈1.1 km)
  assert.equal(f[0].compass, 'E');
  assert.equal(f.find(x => x.id === 'node/1').compass, 'N');
  assert.equal(f.find(x => x.id === 'node/1').tags['addr:street'], undefined, 'only infrastructure tags survive');
  assert.equal(f.find(x => x.id === 'node/3').name, null);
  assert.ok(f.every(x => x.osmUrl.startsWith('https://www.openstreetmap.org/')));
  const pairs = pairWithin(f, 1700);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].aKind, pairs[0].bKind].sort(), ['hospital', 'police']);
  assert.equal(pairWithin(f, 100).length, 0);
  // per-kind cap
  const many = { elements: Array.from({ length: MAX_PER_KIND + 20 }, (_, i) => ({ type: 'node', id: 100 + i, lat: 4.7 + i * 0.001, lon: -74.07, tags: { amenity: 'hospital' } })) };
  assert.equal(parseElements(many, { lat: 4.7, lon: -74.07, kinds: ['hospital'] }).length, MAX_PER_KIND);
});

test('overpass: geometry helpers', () => {
  assert.ok(Math.abs(haversineM(0, 0, 0, 1) - 111195) < 100);
  assert.equal(compass(bearingDeg(0, 0, 1, 0)), 'N');
  assert.equal(compass(bearingDeg(0, 0, 0, 1)), 'E');
  assert.equal(compass(bearingDeg(0, 0, -1, -1)), 'SW');
  assert.equal(cacheKey({ lat: 4.7111, lon: -74.0721, radiusM: 3000, kinds: ['police', 'hospital'] }), '4.711,-74.072,3000,hospital+police');
});

test('overpass client: cache, serialised requests, errors degrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osm-'));
  let calls = 0, now = 1_000_000;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.method, 'POST');
    assert.ok(String(init.body).startsWith('data=%5Bout%3Ajson%5D'));
    if (calls === 3) return resp('busy', { status: 504 });
    return resp(JSON.stringify({ osm3s: { timestamp_osm_base: 't' }, elements: [{ type: 'node', id: calls, lat: 4.71, lon: -74.07, tags: { amenity: 'police', name: `P${calls}` } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const c = new OverpassClient({ dataDir: dir, fetchImpl, now: () => now, log: () => {} });
  const [a, b] = await Promise.all([c.nearby({ lat: 4.7, lon: -74.07, radiusM: 2000, kinds: ['police'] }), c.nearby({ lat: 4.7, lon: -74.07, radiusM: 2000, kinds: ['police'] })]);
  assert.equal(a.count, 1); assert.equal(a.cached, false);
  assert.equal(b.cached, true, 'second identical query is a cache hit while/after the first resolves');
  assert.equal(calls, 1);
  assert.ok(existsSync(join(dir, 'osm-cache.json')));
  assert.equal(a.attribution.includes('OpenStreetMap'), true);
  assert.deepEqual(a.pairs, [], 'single kind -> no pairs');
  const c2 = new OverpassClient({ dataDir: dir, fetchImpl, now: () => now, log: () => {} });
  assert.equal((await c2.nearby({ lat: 4.7, lon: -74.07, radiusM: 2000, kinds: ['police'] })).cached, true, 'cache survives restart');
  now += 3000;
  await c.nearby({ lat: 10, lon: 10, radiusM: 2000, kinds: ['police'] });
  now += 3000;
  await assert.rejects(() => c.nearby({ lat: 20, lon: 20, radiusM: 2000, kinds: ['police'] }), /Overpass HTTP 504/);
  assert.equal(c.stats.errors, 1);
  await assert.rejects(() => c.nearby({ lat: 1, lon: 1, radiusM: 2000, kinds: ['nothing'] }), /no valid kinds/);
});

// ---------- Night lights
test('nightlights: PNG decode (palette + grey, filters), cells, nodata', () => {
  const pal = decodePngGray(png(8, 8, (x, y) => (y < 4 ? 0 : x < 4 ? 20 : 200), { filter: 1 }));
  assert.equal(pal.palette, true);
  assert.equal(pal.gray[0], NODATA, 'index 0 is transparent -> nodata');
  assert.equal(pal.gray[4 * 8 + 0], 20); assert.equal(pal.gray[4 * 8 + 7], 200);
  const grey = decodePngGray(png(4, 4, () => 77, { palette: false }));
  assert.equal(grey.palette, false); assert.equal(grey.gray[15], 77);
  const cells = cellMeans(pal, 4);
  assert.equal(cells.length, 4);
  assert.equal(cells[0], NODATA); assert.equal(cells[1], NODATA);
  assert.equal(cells[2], 20); assert.equal(cells[3], 200);
  assert.throws(() => decodePngGray(Buffer.from('<html>404')), /not a PNG/);
});

test('nightlights: diffCells thresholds and nodata', () => {
  const cw = 4;
  const recent = Float32Array.from([200, 10, 60, NODATA, 5, 100, 100, 100]);
  const base = Float32Array.from([60, 200, 60, 200, 5, 100, 20, NODATA]);
  const d = diffCells(recent, base, cw);
  assert.deepEqual(d.map(c => [c.cx, c.cy, c.kind, c.delta]), [[0, 0, 'brightened', 140], [1, 0, 'dimmed', -190], [2, 1, 'brightened', 80]]);
  assert.equal(diffCells(Float32Array.from([30, MIN_LIT - 1]), Float32Array.from([5, 2]), 2).length, 0, 'below MIN_LIT never counts');
});

test('nightlights: web-mercator tile math and bounded tile set', () => {
  assert.deepEqual(lonLatToTile(-74.07, 4.71, 6), { x: 18, y: 31 });
  const p = tilePixelToLonLat(18, 31, 6, 128, 128);
  assert.ok(p.lon > -76 && p.lon < -75.9 && p.lat > 2.7 && p.lat < 2.9, JSON.stringify(p));
  const co = tilesFor([-79.6, -4.4, -66.6, 13.2]);
  assert.equal(co.length, 16);
  assert.ok(tilesFor([-180, -60, 180, 70]).length <= MAX_TILES, 'capped centre-out');
  assert.equal(tileUrl({ x: 18, y: 31, z: 6 }, '2026-10-02'), `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/2026-10-02/GoogleMapsCompatible_Level8/6/31/18.png`);
  assert.deepEqual(nearestPlace(4.7, -74.07, [{ name: 'Bogotá', lat: 4.711, lon: -74.072 }, { name: 'Cali', lat: 3.44, lon: -76.52 }]), { name: 'Bogotá', km: 1 });
});

test('nightlights: end-to-end over mocked GIBS tiles -> dimmed/brightened cells, persistence, caveat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nl-'));
  const now = Date.parse('2026-10-04T00:00:00Z');
  const cfg = { id: 'co', viewport: { bbox: [-74.5, 4.3, -73.5, 5.2] }, places: [{ name: 'Bogotá', lat: 4.711, lon: -74.072 }] };
  const tiles = tilesFor(cfg.viewport.bbox);
  assert.equal(tiles.length, 1);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const m = url.match(/default\/(\d{4}-\d{2}-\d{2})\//); const date = m[1];
    if (date === '2026-10-03') return resp('nope', { status: 404 });                                  // most recent night missing
    if (date === '2026-08-03') return resp(png(TILE_PX, TILE_PX, () => 1, { palette: false }), { headers: { 'content-type': 'image/png' } }); // odd RGBA/grey rendering -> rejected
    const baseline = date !== '2026-10-02';
    // Cells (cx 48-59, cy 5-14) fall inside the viewport bbox; (10,10) is lit but outside it. One town lit on every
    // night; a second lit only in the baseline (dimmed now); a flare only now; one cell nodata on both nights.
    const px = (x, y) => {
      const cx = Math.floor(x / CELL_PX), cy = Math.floor(y / CELL_PX);
      if (cx === 10 && cy === 10) return baseline ? 180 : 5;                                        // outside bbox -> ignored
      if (cx === 50 && cy === 8) return 180;
      if (cx === 54 && cy === 10) return baseline ? 150 : 5;
      if (cx === 57 && cy === 12) return baseline ? 3 : 120;
      if (cx === 52 && cy === 6) return 0;
      return 2;
    };
    return resp(png(TILE_PX, TILE_PX, px), { headers: { 'content-type': 'image/png' } });
  };
  const nl = new NightLights({ dataDir: dir, fetchImpl, now: () => now, log: () => {} });
  const r = await nl.compute(cfg);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.recentDate, '2026-10-02');
  assert.deepEqual(r.baselineDates, ['2026-09-02', '2026-09-01', '2026-08-03', '2026-08-02']);
  assert.equal(r.tiles.failed, 1, 'the non-palette baseline tile is dropped, not compared');
  assert.equal(r.summary.changed, 2);
  assert.equal(r.summary.dimmed, 1); assert.equal(r.summary.brightened, 1);
  assert.equal(r.cells[0].kind, 'dimmed'); assert.equal(r.cells[0].near.name, 'Bogotá');
  assert.ok(r.cells.every(c => c.cx === undefined && Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.sizeDeg > 0));
  assert.ok(r.cells.length <= MAX_CELLS);
  assert.match(r.caveat, /not an outage/);
  assert.ok(r.tileTemplate.includes('{z}/{y}/{x}.png'));
  assert.ok(existsSync(join(dir, 'nightlights', 'co.json')));
  assert.equal(nl.status('co'), 'live');
  // second call within TTL does not refetch; in-flight dedupe returns same promise
  const n = requests.length;
  await nl.compute(cfg);
  assert.equal(requests.length, n);
  const nl2 = new NightLights({ dataDir: dir, fetchImpl, now: () => now + 7 * 3600_000, log: () => {} });
  assert.equal(nl2.status('co'), 'stale');
  const p1 = nl2.compute(cfg), p2 = nl2.compute(cfg);
  assert.equal(p1, p2);
  await p1;
});

test('nightlights: total outage degrades to an error record, never throws', async () => {
  const nl = new NightLights({ fetchImpl: async () => resp('x', { status: 503 }), now: () => Date.parse('2026-10-04T00:00:00Z'), log: () => {} });
  const r = await nl.compute({ id: 've', viewport: { bbox: [-73.6, 0.4, -59.6, 12.5] }, places: [] });
  assert.match(r.error, /no VIIRS night available/);
  assert.equal(nl.status('ve'), 'error');  // an error record is still a record; the route reports it
});

// ---------- Evidence locker
test('evidence: hash chain verifies and detects tampering', () => {
  const l1 = { seq: 0, ts: 't', action: 'a', prev: GENESIS }; l1.hash = sha256(JSON.stringify(l1));
  const l2 = { seq: 1, ts: 't', action: 'b', prev: l1.hash }; l2.hash = sha256(JSON.stringify(l2));
  assert.deepEqual(verifyChain([l1, l2]), { ok: true, length: 2, brokenAt: null });
  assert.equal(verifyChain([]).ok, true);
  const edited = { ...l1, action: 'z' };
  assert.equal(verifyChain([edited, l2]).ok, false);
  assert.equal(verifyChain([l2]).brokenAt, 0, 'dropped first line breaks prev');
  assert.equal(titleOf(Buffer.from('<html><head><title> DOJ &amp; Co \n press</title></head>'), 'text/html; charset=utf-8'), 'DOJ & Co press');
  assert.equal(titleOf(Buffer.from('%PDF'), 'application/pdf'), null);
});

test('evidence locker: capture -> blob + sha256 + custody; verify; download; limits; URL policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'));
  let now = Date.parse('2026-10-04T00:00:00Z');
  const body = '<html><head><title>Fugitive</title></head><body>page</body></html>';
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://archive.org/wayback/available')) return resp(JSON.stringify({ archived_snapshots: { closest: { available: true, url: 'https://web.archive.org/web/20261003120000/https://www.dea.gov/x', timestamp: '20261003120000' } } }));
    assert.ok(init.maxBytes <= MAX_BYTES && init.truncate === true);
    if (url.endsWith('/big')) return resp('x'.repeat(10), { headers: { 'content-type': 'text/plain' } });
    return resp(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const l = new EvidenceLocker({ dataDir: dir, fetchImpl, now: () => now, log: () => {}, wayback: false });
  assert.deepEqual(await l.capture('tgt_1', 'http://www.dea.gov/x'), { error: 'URL must be a public https URL', status: 400 });
  assert.equal((await l.capture('tgt_1', 'https://10.0.0.1/x')).status, 400);
  assert.equal((await l.capture('tgt_1', 'https://localhost/x')).status, 400);
  const r = await l.capture('tgt_1', 'https://www.dea.gov/fugitives/x', { note: 'DEA page <b>' });
  assert.ok(r.item, r.error);
  assert.match(r.item.id, EVIDENCE_ID_RE);
  assert.equal(r.item.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(r.item.title, 'Fugitive'); assert.equal(r.item.contentType, 'text/html'); assert.equal(r.item.bytes, body.length);
  assert.equal(r.item.wayback.status, 'off');
  assert.ok(existsSync(join(dir, 'evidence', `${r.item.sha256}.bin`)));
  assert.deepEqual(l.chainStatus(), { ok: true, length: 1, brokenAt: null });
  const lines = l.readChain();
  assert.equal(lines[0].action, 'evidence.capture'); assert.equal(lines[0].prev, GENESIS); assert.equal(lines[0].sha256, r.item.sha256);
  // list hides nothing sensitive and is per target
  assert.equal(l.list('tgt_1').length, 1); assert.equal(l.list('tgt_2').length, 0);
  // verify ok, then tamper with the blob -> mismatch recorded in custody
  now += 60_000;
  assert.equal(l.verify(r.item.id).ok, true);
  writeFileSync(join(dir, 'evidence', `${r.item.sha256}.bin`), 'tampered');
  const v = l.verify(r.item.id);
  assert.equal(v.ok, false); assert.notEqual(v.actual, v.expected);
  assert.equal(l.get(r.item.id).verified, false);
  assert.equal(l.chainStatus().ok, true, 'custody chain itself still intact');
  assert.equal(l.readChain().length, 3);
  // content download returns stored bytes (even tampered — that is what verify is for)
  assert.equal(l.content(r.item.id).buf.toString(), 'tampered');
  assert.equal(l.content('ev_000000000000'), null);
  // persistence across restart
  const l2 = new EvidenceLocker({ dataDir: dir, fetchImpl, now: () => now, log: () => {}, wayback: false });
  assert.equal(l2.list('tgt_1')[0].sha256, r.item.sha256);
  // per-target cap
  for (let i = 0; i < MAX_PER_TARGET - 1; i++) assert.ok((await l2.capture('tgt_1', `https://www.dea.gov/p/${i}`)).item);
  assert.equal((await l2.capture('tgt_1', 'https://www.dea.gov/p/last')).status, 409);
  // tampered custody file is detected
  const custody = readFileSync(join(dir, 'custody.jsonl'), 'utf8').split('\n');
  custody[0] = custody[0].replace('evidence.capture', 'evidence.deleted');
  writeFileSync(join(dir, 'custody.jsonl'), custody.join('\n'));
  assert.equal(l2.chainStatus().ok, false); assert.equal(l2.chainStatus().brokenAt, 0);
});

test('evidence locker: wayback lookup/save are best-effort and recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-wb-'));
  const fetchImpl = async (url) => {
    if (url.startsWith('https://archive.org/wayback/available')) return resp(JSON.stringify({ archived_snapshots: {} }));
    if (url.startsWith('https://web.archive.org/save/')) return resp('', { status: 302, headers: { location: '/web/20261004000100/https://www.dea.gov/x' } });
    return resp('<html><title>x</title></html>', { headers: { 'content-type': 'text/html' } });
  };
  assert.equal(await waybackLookup('https://www.dea.gov/x', fetchImpl), null);
  assert.deepEqual(await waybackSave('https://www.dea.gov/x', fetchImpl), { url: 'https://web.archive.org/web/20261004000100/https://www.dea.gov/x', timestamp: '20261004000100' });
  assert.equal(await waybackSave('https://www.dea.gov/x', async () => { throw new Error('down'); }), null);
  const l = new EvidenceLocker({ dataDir: dir, fetchImpl, now: () => Date.parse('2026-10-04T00:00:00Z'), log: () => {} });
  const r = await l.capture('tgt_1', 'https://www.dea.gov/x');
  assert.equal(r.item.wayback.status, 'pending');
  await new Promise(res => setTimeout(res, 50));
  assert.equal(l.get(r.item.id).wayback.status, 'archived');
  assert.equal(l.readChain().at(-1).action, 'evidence.archive');
  assert.equal(l.chainStatus().ok, true);
});
