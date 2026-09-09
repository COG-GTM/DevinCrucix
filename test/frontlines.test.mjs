// DeepStateMAP (Frontlines) adapter — unit tests against recorded fixtures (no network)
// Fixtures are a trimmed subset of the live /api/history/last and /api/history/public payloads:
// one or two features per category we classify, plus editorial territories we must ignore.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseName, arrowHeading, unitEchelon, simplifyRing, ringAreaKm2,
  extractGeo, parseUpdate, summarizeHistory, buildResult, PLOTTED_POLY_CATS, DEEPSTATE_SITE_URL,
} from '../apis/sources/frontlines.mjs';
import { evaluateLayers, LAYERS } from '../lib/maplayers.mjs';
import { buildSituation } from '../lib/situation.mjs';
import { computeDelta } from '../lib/delta/engine.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deepstate');
const raw = JSON.parse(readFileSync(join(FIX, 'last.sample.json'), 'utf8'));
const history = JSON.parse(readFileSync(join(FIX, 'history.sample.json'), 'utf8'));
// Fixed clock just after the fixture's newest record so "7d" windows are deterministic.
const NOW = Date.parse('2026-09-05T18:00:00Z');

describe('DeepState name / icon parsing', () => {
  it('splits the trilingual name into a geoJSON key and an English label', () => {
    const p = parseName('Тимчасово окуповано /// Occupied /// geoJSON.status.occupied {{at:01.01}}');
    assert.equal(p.key, 'status.occupied');
    assert.equal(p.en, 'Occupied');
  });
  it('tolerates junk', () => {
    assert.deepEqual(parseName(null).key, '');
    assert.equal(parseName('just a name').key, '');
  });
  it('maps arrow_N icons to compass headings (16 = north, 4 = east)', () => {
    assert.equal(arrowHeading('{icon=arrow_16}'), 0);
    assert.equal(arrowHeading('{icon=arrow_4}'), 90);
    assert.equal(arrowHeading('{icon=arrow_8}'), 180);
    assert.equal(arrowHeading('{icon=arrow_12}'), 270);
    assert.equal(arrowHeading('{icon=enemy}'), null);
    assert.equal(arrowHeading(''), null);
  });
  it('derives unit echelon from the key', () => {
    assert.equal(unitEchelon('units.brigade'), 'brigade');
    assert.equal(unitEchelon('units.storm-z'), 'other');
  });
});

describe('geometry helpers', () => {
  it('simplifies a ring but keeps it closed and >= 4 points', () => {
    const ring = [];
    for (let i = 0; i < 200; i++) ring.push([30 + 0.05 * Math.cos(i / 200 * 2 * Math.PI), 48 + 0.05 * Math.sin(i / 200 * 2 * Math.PI)]);
    ring.push(ring[0]);
    const s = simplifyRing(ring, 0.002);
    assert.ok(s.length >= 4 && s.length < ring.length, `${s.length} of ${ring.length}`);
    assert.deepEqual(s[0], s[s.length - 1]);
    // a sliver that would collapse below 4 points is returned untouched rather than degenerate
    const sliver = [[30, 48], [30.001, 48.0001], [30.002, 48], [30.001, 47.9999], [30, 48]];
    assert.deepEqual(simplifyRing(sliver, 0.01), sliver);
  });
  it('computes a plausible spherical area (1° x 1° box near 48N ≈ 8,300 km²)', () => {
    const box = [[30, 48], [31, 48], [31, 49], [30, 49], [30, 48]];
    const a = ringAreaKm2(box);
    assert.ok(a > 7800 && a < 8800, `got ${a}`);
  });
});

describe('extractGeo on the recorded map', () => {
  const geo = extractGeo(raw.map);
  it('classifies polygons into occupied / pre-2022 / contested / liberated and drops editorial territories', () => {
    assert.equal(geo.polyCats.occupied, 2);
    assert.equal(geo.polyCats.occupied_pre2022, 1);
    assert.equal(geo.polyCats.contested, 1);
    assert.equal(geo.polyCats.liberated, 2);
    assert.equal(geo.polyCats.editorial, 1, 'East Prussia counted but not plotted');
    assert.equal(geo.polyCats.other_occupied, 1, 'Transnistria counted but not plotted');
    for (const p of geo.polygons) assert.ok(PLOTTED_POLY_CATS.includes(p.cat), p.cat);
    assert.equal(geo.polygons.length, 6);
  });
  it('emits only closed lon/lat rings with 4-decimal coordinates', () => {
    for (const p of geo.polygons) {
      for (const r of p.rings) {
        assert.ok(r.length >= 4);
        assert.deepEqual(r[0], r[r.length - 1]);
        for (const [lon, lat] of r) {
          assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
          assert.equal(lon, Math.round(lon * 1e4) / 1e4);
        }
      }
    }
  });
  it('classifies points and skips the ones we do not plot (cruiser Moskva)', () => {
    assert.deepEqual(geo.pointCats, { attack: 3, unit: 3, airfield: 2 });
    assert.equal(geo.skipped, 1);
    const attacks = geo.points.filter(p => p.cat === 'attack');
    assert.ok(attacks.every(p => Number.isFinite(p.heading) && p.heading >= 0 && p.heading < 360));
    const units = geo.points.filter(p => p.cat === 'unit');
    assert.deepEqual(units.map(u => u.echelon).sort(), ['brigade', 'regiment', 'regiment']);
  });
  it('strips HTML and icon directives from names (untrusted third-party strings)', () => {
    for (const p of geo.points.concat(geo.polygons)) {
      assert.doesNotMatch(p.name, /<|>|\{icon=/);
    }
  });
  it('sums area per category; Crimea dominates the pre-2022 bucket', () => {
    assert.ok(geo.areaKm2.occupied_pre2022 > 20000 && geo.areaKm2.occupied_pre2022 < 30000, String(geo.areaKm2.occupied_pre2022));
    assert.ok(geo.areaKm2.contested > 0 && geo.areaKm2.liberated > 0);
  });
  it('is defensive about a bad payload', () => {
    assert.deepEqual(extractGeo(null).polygons, []);
    assert.deepEqual(extractGeo({ features: [{ geometry: { type: 'Point', coordinates: [999, 0] }, properties: { name: 'x /// y /// geoJSON.units.brigade' } }] }).points, []);
  });
});

describe('update history', () => {
  it('parses an English update into kind, clean text and geocoded places', () => {
    const u = parseUpdate(history[0]);
    assert.equal(u.kind, 'advance');
    assert.equal(u.lang, 'en');
    assert.doesNotMatch(u.text, /<a|href/);
    assert.ok(u.places.length >= 1);
    assert.ok(u.places.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.name));
  });
  it('summarizes the 7-day window and dedupes repeated record ids', () => {
    const h = summarizeHistory(history.concat([history[0]]), NOW);
    assert.equal(h.total, history.length);
    assert.equal(h.recent7d, 5);
    assert.equal(h.advances7d, 4);
    assert.equal(h.regains7d, 1);
    assert.equal(h.latestAt, '2026-09-04T07:29:43.000Z');
    assert.ok(h.changePoints.length > 0 && h.changePoints.every(c => c.kind && c.at));
  });
  it('handles a missing history', () => {
    const h = summarizeHistory(undefined, NOW);
    assert.equal(h.total, 0);
    assert.deepEqual(h.updates, []);
  });
});

describe('buildResult', () => {
  const r = buildResult(raw, history, NOW);
  it('produces the live summary the dashboard consumes', () => {
    assert.equal(r.source, 'Frontlines');
    assert.equal(r.status, 'live');
    assert.equal(r.provider, 'DeepStateMAP');
    assert.equal(r.siteUrl, DEEPSTATE_SITE_URL);
    assert.equal(r.mapId, raw.id);
    assert.equal(r.mapUpdatedAt, '2026-09-04T07:29:43.000Z');
    assert.equal(r.mapAgeH, 35);
    assert.equal(r.featureCount, raw.map.features.length);
    assert.equal(r.occupiedKm2, r.areaKm2.occupied + r.areaKm2.occupied_pre2022);
    assert.equal(r.attackDirections, 3);
    assert.equal(r.units, 3);
    assert.equal(r.airfields, 2);
    assert.equal(r.history.recent7d, 5);
    assert.ok(r.geo && r.geo.polygons.length === 6 && r.geo.points.length === 8);
    assert.equal(r.geo.mapId, raw.id);
    assert.ok(r.geo.changes.length > 0);
  });
  it('returns an explicit unavailable result for an unexpected payload (health stays truthful)', () => {
    const u = buildResult({ nope: true }, [], NOW);
    assert.equal(u.status, 'unavailable');
    assert.equal(u.featureCount, 0);
    assert.equal(u.geo, null);
    assert.equal(u.provider, 'DeepStateMAP');
  });
});

describe('dashboard wiring', () => {
  const live = buildResult(raw, history, NOW);
  const { geo, ...summary } = live;
  it('the front layer is a signal layer when the map updated this week, and none when the feed is down', () => {
    const rows = evaluateLayers({ frontlines: summary }).layers;
    const front = rows.find(r => r.id === 'front');
    assert.equal(front.state, 'signal');
    assert.match(front.why, /km² occupied/);
    assert.match(front.why, /updates\/7d/);
    const orbat = rows.find(r => r.id === 'front-orbat');
    assert.equal(orbat.state, 'data');
    assert.equal(orbat.count, 5);

    const down = evaluateLayers({
      frontlines: buildResult({}, [], NOW),
      sourceHealth: { sources: [{ name: 'Frontlines', state: 'error', reason: 'HTTP 503' }] },
    }).layers;
    assert.equal(down.find(r => r.id === 'front').state, 'none');
    assert.match(down.find(r => r.id === 'front').why, /Frontlines failed: HTTP 503/);
  });
  it('front layer types are registered exactly once', () => {
    const types = LAYERS.flatMap(l => l.types);
    for (const t of ['front-poly', 'front-attack', 'front-change', 'front-unit', 'front-airfield']) {
      assert.equal(types.filter(x => x === t).length, 1, t);
    }
  });
  it('situation rule fires only on a live map with recent updates and carries the caveat', () => {
    const s = buildSituation({ frontlines: summary, sourceHealth: { summary: { live: 1, degraded: 0, no_key: 0, off: 0, error: 0, total: 1, reporting: 1 }, sources: [] } });
    const h = s.headlines.find(x => x.rule === 'front');
    assert.ok(h, 'front headline present');
    assert.equal(h.tab, 'military');
    assert.equal(h.panel, 'front-panel');
    assert.match(h.title, /Ukraine front/);
    assert.match(h.why, /not verified ground truth/);
    assert.equal(h.severity, 'info');

    const quiet = buildSituation({ frontlines: { ...summary, status: 'unavailable' } });
    assert.equal(quiet.headlines.find(x => x.rule === 'front'), undefined);
  });
  it('delta metric moves only between two live sweeps', () => {
    const prev = { frontlines: { ...summary, occupiedKm2: summary.occupiedKm2 - 40 } };
    const d = computeDelta({ frontlines: summary }, prev);
    const hit = (d.signals.escalated || []).concat(d.signals.deescalated || []).find(s => s.key === 'front_occupied_km2');
    assert.ok(hit, 'occupied-area change surfaced');

    const outage = computeDelta({ frontlines: { status: 'unavailable', occupiedKm2: 0 } }, { frontlines: summary });
    const all = Object.values(d.signals).flat().concat(Object.values(outage.signals).flat());
    assert.equal(all.filter(s => s.key === 'front_occupied_km2' && s.to === 0).length, 0, 'an outage never reads as territory changing hands');
  });
});
