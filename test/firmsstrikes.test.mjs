// lib/firmsstrikes.mjs — FIRMS × DeepStateMAP strike-candidate derivation.
// Fixtures: test/fixtures/firms/ukraine.sample.csv (recorded VIIRS_SNPP_NRT rows for the Ukraine box,
// 2-day window) and test/fixtures/deepstate/geo.front.sample.json (recorded attack axes, update places
// and contested polygons from /api/frontlines/geo).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseCSV, analyzeFires, toDetection, MAX_DETECTIONS as ADAPTER_MAX } from '../apis/sources/firms.mjs';
import {
  deriveStrikeCandidates, frontAnchors, nearestAnchor, clusterDetections, haversineKm,
  STRIKE_RADIUS_KM, HOT_FRP_MW, MAX_CLUSTERS, CLUSTER_KM,
} from '../lib/firmsstrikes.mjs';
import { buildUkraineView } from '../lib/ukraineview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(path.join(here, 'fixtures', 'firms', 'ukraine.sample.csv'), 'utf8');
const geo = JSON.parse(readFileSync(path.join(here, 'fixtures', 'deepstate', 'geo.front.sample.json'), 'utf8'));
const NOW = Date.parse('2026-09-13T20:00:00Z');
const LIVE = [{ name: 'FIRMS', state: 'live' }, { name: 'Frontlines', state: 'live' }];

const hotspot = () => analyzeFires(parseCSV(csv), 'Ukraine', { keepDetections: true });
const sources = (extra = {}) => ({ FIRMS: { status: 'live', hotspots: [hotspot()] }, Frontlines: { geo }, ...extra });

describe('adapter: per-detection rows', () => {
  test('keepDetections retains every valid pixel, night first, with a 48 h window', () => {
    const h = hotspot();
    assert.equal(h.windowDays, 2);
    assert.equal(h.detections.length, h.totalDetections);
    assert.equal(h.detectionsDropped, 0);
    const firstDay = h.detections.findIndex(d => !d.night);
    assert.ok(h.detections.slice(0, firstDay).every(d => d.night));
    assert.ok(h.detections.slice(firstDay).every(d => !d.night));
    assert.equal(h.detections.filter(d => d.night).length, h.nightDetections);
  });
  test('rows without keepDetections are unchanged in shape', () => {
    const h = analyzeFires(parseCSV(csv), 'Ukraine');
    assert.equal(h.detections, undefined);
    assert.ok(h.highIntensity.length <= 15);
  });
  test('toDetection validates coordinates and normalizes time/confidence', () => {
    assert.equal(toDetection({ latitude: 'x', longitude: '30' }), null);
    assert.equal(toDetection({ latitude: '91', longitude: '30' }), null);
    const d = toDetection({ latitude: '48.1', longitude: '37.2', frp: '12.5', bright_ti4: '340', acq_date: '2026-09-12', acq_time: '130', confidence: 'nominal', daynight: 'N' });
    assert.deepEqual(d, { lat: 48.1, lon: 37.2, frp: 12.5, bright: 340, date: '2026-09-12', time: '0130', conf: 'n', night: true });
    const bad = toDetection({ latitude: '48.1', longitude: '37.2', frp: 'nan', acq_date: '12/09/2026', acq_time: 'late', confidence: 'zz', daynight: 'D' });
    assert.equal(bad.frp, 0); assert.equal(bad.date, null); assert.equal(bad.time, null); assert.equal(bad.conf, null); assert.equal(bad.night, false);
  });
  test('detections are capped and the drop is counted', () => {
    const rows = Array.from({ length: ADAPTER_MAX + 25 }, (_, i) => ({ latitude: String(45 + (i % 100) / 100), longitude: '30', frp: '1', acq_date: '2026-09-12', acq_time: '100', confidence: 'n', daynight: 'D' }));
    rows.push({ latitude: 'bad', longitude: '30' });
    const h = analyzeFires(rows, 'Ukraine', { keepDetections: true });
    assert.equal(h.detections.length, ADAPTER_MAX);
    assert.equal(h.detectionsDropped, 26);
  });
  test('empty successful poll keeps an empty detections list, not undefined', () => {
    const h = analyzeFires([], 'Ukraine', { keepDetections: true });
    assert.deepEqual(h.detections, []);
    assert.equal(h.totalDetections, 0);
  });
});

describe('geometry helpers', () => {
  test('haversine sanity: Kyiv → Kharkiv ≈ 410 km', () => {
    assert.ok(Math.abs(haversineKm(50.45, 30.52, 49.99, 36.23) - 410) < 10);
  });
  test('frontAnchors uses attack axes, update places and contested ring vertices only', () => {
    const a = frontAnchors(geo);
    assert.equal(a.filter(x => x.kind === 'attack').length, geo.points.filter(p => p.cat === 'attack').length);
    assert.equal(a.filter(x => x.kind === 'update').length, geo.changes.length);
    assert.equal(a.filter(x => x.kind === 'grey').length, geo.polygons.filter(p => p.cat === 'contested').reduce((s, p) => s + p.rings.reduce((t, r) => t + r.length, 0), 0));
    const withOccupied = { polygons: [{ cat: 'occupied', rings: [[[30, 48], [31, 48]]] }], points: [{ cat: 'unit', lat: 48, lon: 30 }] };
    assert.deepEqual(frontAnchors(withOccupied), []);
    assert.deepEqual(frontAnchors(null), []);
    assert.deepEqual(frontAnchors({ polygons: 'nope', points: 3 }), []);
  });
  test('frontAnchors drops invalid coordinates and strips markup from names', () => {
    const a = frontAnchors({ points: [{ cat: 'attack', lat: 91, lon: 30 }, { cat: 'attack', lat: 48, lon: 30, name: '<b>Axis</b>\u0001' }] });
    assert.equal(a.length, 1);
    assert.equal(a[0].name, 'b Axis /b');
  });
  test('nearestAnchor returns the closest anchor and null when nothing is within the coarse window', () => {
    const anchors = [{ lat: 48, lon: 37, kind: 'attack', name: 'a' }, { lat: 48.1, lon: 37.1, kind: 'grey', name: 'g' }];
    assert.equal(nearestAnchor(48.09, 37.09, anchors).anchor.name, 'g');
    assert.equal(nearestAnchor(50, 30, anchors), null);
  });
  test('clusterDetections merges pixels within CLUSTER_KM and keeps per-cluster counts', () => {
    const d = (lat, lon, frp, night, at) => ({ lat, lon, frp, bright: 330, night, conf: 'n', at });
    const cl = clusterDetections([
      d(48.000, 37.000, 30, false, '2026-09-13T10:58:00Z'), d(48.004, 37.004, 5, true, '2026-09-12T23:31:00Z'), d(48.008, 37.000, 1, true, '2026-09-12T23:31:00Z'),
      d(48.500, 37.000, 12, true, '2026-09-13T01:11:00Z'),
    ]);
    assert.equal(cl.length, 2);
    assert.equal(cl[0].n, 3); assert.equal(cl[0].night, 2); assert.equal(cl[0].maxFrp, 30); assert.equal(cl[0].sumFrp, 36);
    assert.equal(cl[0].firstAt, '2026-09-12T23:31:00Z'); assert.equal(cl[0].latestAt, '2026-09-13T10:58:00Z');
    assert.ok(haversineKm(cl[0].lat, cl[0].lon, 48, 37) < CLUSTER_KM);
    assert.equal(cl[1].n, 1);
    assert.deepEqual(clusterDetections([]), []);
  });
});

describe('deriveStrikeCandidates', () => {
  test('live: bounded clusters near the contact line, tiers, totals, attribution', () => {
    const r = deriveStrikeCandidates(sources(), LIVE, NOW);
    assert.equal(r.status, 'live');
    assert.equal(r.windowH, 48);
    assert.equal(r.radiusKm, STRIKE_RADIUS_KM);
    assert.ok(r.anchors > 1000 && r.anchorKinds.attack === 63 && r.anchorKinds.update === 11);
    assert.equal(r.totals.detections, hotspot().totalDetections);
    assert.ok(r.totals.nearFront > 0 && r.totals.nearFront <= r.totals.detections);
    assert.ok(r.totals.nearFrontNight <= r.totals.night);
    assert.ok(r.totals.candidates <= r.totals.nearFront);
    assert.equal(r.totals.clusters, r.clusters.length);
    assert.ok(r.clusters.length > 0 && r.clusters.length <= MAX_CLUSTERS);
    for (const c of r.clusters) {
      assert.ok(c.distKm <= STRIKE_RADIUS_KM, `cluster ${c.lat},${c.lon} at ${c.distKm} km`);
      assert.ok(c.night > 0 || c.maxFrp >= HOT_FRP_MW, 'day-only clusters must be hot');
      assert.ok(['A', 'B'].includes(c.tier));
      assert.ok(c.lat >= 44 && c.lat <= 53 && c.lon >= 22 && c.lon <= 41);
      assert.match(c.latestAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      assert.ok(c.place === null || (typeof c.place.name === 'string' && c.place.km <= 60));
    }
    const tiers = r.clusters.map(c => c.tier);
    assert.deepEqual(tiers, [...tiers].sort());
    assert.equal(r.totals.tierA, tiers.filter(t => t === 'A').length);
    assert.match(r.attribution, /NASA FIRMS/); assert.match(r.attribution, /DeepStateMAP/);
    assert.match(r.caveat, /not confirmed strikes/);
    assert.equal(r.mapId, geo.mapId);
    assert.equal(r.reason, null);
    assert.equal(r.builtAt, new Date(NOW).toISOString());
  });
  test('tier A requires a night pass within 15 km with real intensity or multiple pixels', () => {
    const anchor = { points: [{ cat: 'attack', lat: 48, lon: 37 }] };
    const det = (lat, lon, frp, night) => ({ lat, lon, frp, bright: 330, date: '2026-09-13', time: '0100', conf: 'n', night });
    const run = dets => deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', detections: dets }] }, Frontlines: { geo: anchor } }, LIVE, NOW).clusters;
    assert.equal(run([det(48.05, 37, 12, true)])[0].tier, 'A');
    assert.equal(run([det(48.05, 37, 2, true)])[0].tier, 'B');            // faint single night pixel
    assert.equal(run([det(48.2, 37, 40, true)])[0].tier, 'B');            // ~22 km out
    assert.equal(run([det(48.05, 37, 40, false)])[0].tier, 'B');          // hot but daytime
    assert.equal(run([det(48.05, 37, 4, false)]).length, 0);              // faint daytime → not a candidate
    assert.equal(run([det(48.5, 37, 90, true)]).length, 0);               // ~56 km → outside radius
  });
  test('coordinates outside the box or invalid are ignored; strings in geometry are bounded', () => {
    const dets = [
      { lat: 'x', lon: 37, frp: 50, night: true, date: '2026-09-13', time: '0100' },
      { lat: 55, lon: 37, frp: 50, night: true, date: '2026-09-13', time: '0100' },
      { lat: 48.01, lon: 37.01, frp: -5, night: true, date: 'bad', time: '99' },
      null, 'text',
    ];
    const g = { points: [{ cat: 'attack', lat: 48, lon: 37, name: 'x'.repeat(200) }] };
    const r = deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', detections: dets }] }, Frontlines: { geo: g } }, LIVE, NOW);
    assert.equal(r.totals.detections, 1);
    assert.equal(r.clusters.length, 1);
    assert.equal(r.clusters[0].maxFrp, 0);
    assert.equal(r.clusters[0].latestAt, null);
    assert.equal(r.clusters[0].near.length, 60);
  });
  test('cluster output is capped at MAX_CLUSTERS', () => {
    const dets = Array.from({ length: 200 }, (_, i) => ({ lat: 48 + (i % 20) * 0.04, lon: 37 + Math.floor(i / 20) * 0.06, frp: 30, night: true, date: '2026-09-13', time: '0100', conf: 'n' }));
    const anchors = { points: Array.from({ length: 20 }, (_, i) => ({ cat: 'attack', lat: 48 + i * 0.04, lon: 37.3 })) };
    const r = deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', detections: dets }] }, Frontlines: { geo: anchors } }, LIVE, NOW);
    assert.equal(r.status, 'live');
    assert.equal(r.clusters.length, MAX_CLUSTERS);
    assert.ok(r.totals.candidates > MAX_CLUSTERS);
  });
  test('empty: FIRMS live with zero pixels near the front is reported as empty, not an error', () => {
    const dets = [{ lat: 50.5, lon: 25.5, frp: 80, night: true, date: '2026-09-13', time: '0100', conf: 'h' }];
    const r = deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', detections: dets }] }, Frontlines: { geo } }, LIVE, NOW);
    assert.equal(r.status, 'empty');
    assert.equal(r.totals.detections, 1); assert.equal(r.totals.nightRear, 1); assert.equal(r.totals.nearFront, 0);
    assert.deepEqual(r.clusters, []);
    assert.match(r.reason, /No night or ≥20 MW detections within 30 km/);
    const e = deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', detections: [] }] }, Frontlines: { geo } }, LIVE, NOW);
    assert.equal(e.status, 'empty'); assert.equal(e.totals.detections, 0);
  });
  test('no_firms: missing key, failed poll, missing hotspot or hotspot error', () => {
    assert.equal(deriveStrikeCandidates({}, [{ name: 'FIRMS', state: 'no_key', reason: 'FIRMS_MAP_KEY not set' }], NOW).reason, 'FIRMS_MAP_KEY not set');
    assert.equal(deriveStrikeCandidates({}, [{ name: 'FIRMS', state: 'no_key' }], NOW).status, 'no_firms');
    assert.equal(deriveStrikeCandidates(sources(), [{ name: 'FIRMS', state: 'error', reason: 'HTTP 503' }], NOW).status, 'no_firms');
    assert.equal(deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Iran' }] } }, LIVE, NOW).status, 'no_firms');
    const r = deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', error: 'HTTP 429' }] } }, LIVE, NOW);
    assert.equal(r.status, 'no_firms'); assert.equal(r.reason, 'HTTP 429');
    assert.deepEqual(r.clusters, []);
    assert.equal(deriveStrikeCandidates({}, [], NOW).reason, 'FIRMS not in this sweep');
  });
  test('no_detections: legacy hotspot payload without per-detection rows', () => {
    const r = deriveStrikeCandidates({ FIRMS: { hotspots: [{ region: 'Ukraine', totalDetections: 900, highIntensity: [] }] }, Frontlines: { geo } }, LIVE, NOW);
    assert.equal(r.status, 'no_detections');
    assert.deepEqual(r.clusters, []);
  });
  test('no_front: DeepState geometry missing or without contact-line features keeps FIRMS totals', () => {
    const r = deriveStrikeCandidates(sources({ Frontlines: {} }), LIVE, NOW);
    assert.equal(r.status, 'no_front');
    assert.ok(r.totals.detections > 0 && r.totals.night > 0);
    assert.equal(r.totals.nearFront, 0);
    assert.deepEqual(r.clusters, []);
    assert.match(r.reason, /No DeepStateMAP contact-line geometry/);
    const off = deriveStrikeCandidates(sources({ Frontlines: {} }), [{ name: 'FIRMS', state: 'live' }, { name: 'Frontlines', state: 'error', reason: 'HTTP 502' }], NOW);
    assert.equal(off.status, 'no_front'); assert.match(off.reason, /DeepStateMAP error — HTTP 502/);
    const occupiedOnly = deriveStrikeCandidates(sources({ Frontlines: { geo: { polygons: [{ cat: 'occupied', rings: [[[37, 48]]] }], points: [] } } }), LIVE, NOW);
    assert.equal(occupiedOnly.status, 'no_front'); assert.equal(occupiedOnly.anchors, 0);
  });
  test('degraded FIRMS still derives candidates', () => {
    const r = deriveStrikeCandidates(sources(), [{ name: 'FIRMS', state: 'degraded', reason: 'stale' }, { name: 'Frontlines', state: 'live' }], NOW);
    assert.equal(r.status, 'live');
    assert.equal(r.firmsHealth.state, 'degraded');
  });
  test('buildUkraineView exposes the candidates as `strikes` and keeps the generic thermal slice', () => {
    const v = buildUkraineView(sources(), LIVE, NOW);
    assert.equal(v.strikes.status, 'live');
    assert.ok(v.strikes.clusters.length > 0);
    assert.ok(v.thermal.rows.length <= 15);
    assert.ok(JSON.stringify(v.strikes).length < 40000);
  });
});
