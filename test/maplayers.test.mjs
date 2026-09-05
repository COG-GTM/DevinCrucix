import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS, LAYER_IDS, MAX_DEFAULT_LAYERS, MIN_DEFAULT_LAYERS, LAYER_STATES, evaluateLayers } from '../lib/maplayers.mjs';
import { buildSituation } from '../lib/situation.mjs';

const air = (region, total, china = 0, noCallsign = 0) => ({ region, total, noCallsign, highAlt: 0, top: china ? [['China', china]] : [] });

test('registry: ids unique, every layer has types/color/eval, ranks unique', () => {
  assert.equal(new Set(LAYER_IDS).size, LAYERS.length);
  assert.equal(new Set(LAYERS.map(l => l.rank)).size, LAYERS.length);
  for (const l of LAYERS) {
    assert.ok(l.types.length > 0, `${l.id} has types`);
    assert.match(l.color, /^#[0-9a-f]{6}$/i);
    assert.equal(typeof l.eval, 'function');
  }
  const allTypes = LAYERS.flatMap(l => l.types);
  assert.equal(new Set(allTypes).size, allTypes.length, 'a marker type maps to exactly one layer');
});

test('empty sweep: every layer is none, nothing is on, why comes from source health', () => {
  const r = evaluateLayers({ sourceHealth: { sources: [{ name: 'ACLED', state: 'no_key', envVars: ['ACLED_EMAIL', 'ACLED_API_KEY'] }, { name: 'FIRMS', state: 'error', reason: 'HTTP 503' }] } });
  assert.equal(r.layers.length, LAYERS.length);
  assert.ok(r.layers.every(l => l.state === 'none' && l.on === false && l.count === 0));
  assert.deepEqual(r.defaults, []);
  assert.equal(r.layers.find(l => l.id === 'conflict').why, 'needs ACLED_EMAIL + ACLED_API_KEY');
  assert.equal(r.layers.find(l => l.id === 'thermal').why, 'FIRMS failed: HTTP 503');
  assert.equal(r.layers.find(l => l.id === 'air').why, 'nothing to plot this sweep');
  for (const l of r.layers) assert.ok(LAYER_STATES.includes(l.state));
});

test('signal layers win defaults and are capped at MAX_DEFAULT_LAYERS', () => {
  const V2 = {
    air: [air('Taiwan Strait', 60, 30), air('South China Sea', 40, 20), air('Middle East', 100, 0, 30)],
    adsbMilitary: { categories: { reconnaissance: [{ lat: 1, lon: 1 }], bombers: [{ lat: 2, lon: 2 }], isr: [{ lat: 1, lon: 1, country: 'China' }] } },
    gpsJamming: { zones: [{ lat: 1, lng: 1, severity: 'high' }] },
    acled: { deadliestEvents: [{ lat: 1, lon: 1, fatalities: 12 }] },
    carriers: { carriers: [{ lat: 1, lng: 1, source: 'GDELT geo' }] },
    nuke: [{ site: 'X', anom: true, cpm: 90 }],
    tg: { urgent: [{}, {}] },
  };
  const prc = { level: 'ELEVATED', score: 80, straitCn: 30, scsTotal: 40, isr: 1 };
  const r = evaluateLayers(V2, { prc });
  const signal = r.layers.filter(l => l.state === 'signal').map(l => l.id);
  assert.deepEqual(signal, ['prc', 'military', 'gps', 'conflict', 'carriers', 'nuke', 'air', 'osint']);
  assert.equal(r.defaults.length, MAX_DEFAULT_LAYERS);
  assert.deepEqual(r.defaults, ['prc', 'military', 'gps', 'conflict', 'carriers']);
  assert.equal(r.layers.find(l => l.id === 'nuke').on, false, 'signal layers past the cap stay off by default');
  assert.equal(r.layers.find(l => l.id === 'air').why, 'Middle East: ≥15% no callsign');
});

test('quiet sweep: defaults are padded with data layers up to MIN_DEFAULT_LAYERS, in rank order', () => {
  const V2 = {
    air: [air('Middle East', 100, 0, 2)],
    nuke: [{ site: 'X', anom: false, cpm: 20 }],
    chokepoints: [{ lat: 1, lon: 1 }],
    news: [{ lat: 1, lon: 1 }],
    space: { stationPositions: [{ lat: 1, lon: 1 }] },
  };
  const r = evaluateLayers(V2, { prc: { level: 'REDUCED', score: 0 } });
  assert.equal(r.signal, 0);
  assert.equal(r.defaults.length, MIN_DEFAULT_LAYERS);
  assert.deepEqual(r.defaults, ['nuke', 'air', 'maritime']);
  assert.equal(r.layers.find(l => l.id === 'news').state, 'data');
  assert.equal(r.layers.find(l => l.id === 'news').on, false);
});

test('a throwing eval degrades that layer to none instead of blanking the map', () => {
  const V2 = { thermal: [{ fires: 'not-an-array' }], air: [air('Middle East', 10)] };
  const r = evaluateLayers(V2);
  assert.equal(r.layers.find(l => l.id === 'thermal').state, 'none');
  assert.equal(r.layers.find(l => l.id === 'air').state, 'data');
});

test('buildSituation attaches map layer evaluation using the same PRC composite', () => {
  const s = buildSituation({ air: [air('Taiwan Strait', 60, 40), air('South China Sea', 30, 10)], adsbMilitary: { categories: { isr: [{ country: 'China' }] } } });
  assert.ok(s.map && Array.isArray(s.map.layers));
  const prcLayer = s.map.layers.find(l => l.id === 'prc');
  assert.equal(prcLayer.state, 'signal');
  assert.equal(prcLayer.count, s.prc.straitCn + s.prc.scsTotal + s.prc.isr);
  assert.ok(s.map.defaults.includes('prc'));
});

test('registry types and dashboard marker types agree in both directions', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  // 3D globe: `type:'x'` on point/label objects; flat map: trailing layer-type arg to addPt() / layerOn('x').
  const used = new Set([
    ...[...html.matchAll(/type:\s*['"]([a-z-]+)['"]/g)].map(m => m[1]),
    ...[...html.matchAll(/layerOn\(['"]([a-z-]+)['"]\)/g)].map(m => m[1]),
    ...[...html.matchAll(/addPt\([^;]*?,\s*\d,\s*['"]([a-z-]+)['"]\)/g)].map(m => m[1]),
  ]);
  const registry = new Set(LAYERS.flatMap(l => l.types));
  const unowned = [...used].filter(t => !registry.has(t));
  assert.deepEqual(unowned, [], `marker types plotted but owned by no layer: ${unowned.join(', ')}`);
  const unplotted = [...registry].filter(t => !used.has(t));
  assert.deepEqual(unplotted, [], `layer types never plotted by the dashboard: ${unplotted.join(', ')}`);
});
