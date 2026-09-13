// Iron Command Pacific Watch adapter + its slice of the China / Taiwan view. Recorded fixture only — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as IC from '../apis/sources/ironcommand.mjs';
import { buildTaiwanView, buildTaiwanGeo, trimIronCommand, LINK_OUTS } from '../lib/taiwanview.mjs';
import { LAYERS, evaluateLayers } from '../lib/maplayers.mjs';
import { prcTension } from '../lib/situation.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ironcommand', 'pacific-watch.json');
const raw = () => JSON.parse(readFileSync(FIX, 'utf8'));
// Fixture generated_at is 2026-09-13T21:50:07Z; poll "now" is 40 min later.
const AT = '2026-09-13T22:30:00.000Z';
const live = () => IC.buildResult(raw(), AT);

test('Fixture: recorded live payload has the documented shape', () => {
  const r = raw();
  assert.equal(r.generated_at, '2026-09-13T21:50:07Z');
  assert.equal(r.embargo_hours, 6);
  assert.equal(r.events.length, 80);
  assert.equal(r.chokepoints.length, 6);
  assert.equal(r.watch.length, 3);
  for (const k of ['id', 'title', 'place', 'lat', 'lon', 'corroboration', 'reports', 'grade', 'sources', 'source_count', 'region', 'first', 'last']) assert.ok(k in r.events[0], k);
  for (const k of ['name', 'key', 'lat', 'lon', 'events_7d', 'events_prior_7d', 'trend', 'state', 'spark', 'basis']) assert.ok(k in r.chokepoints[0], k);
  for (const k of ['description', 'last_fired', 'fired_7d']) assert.ok(k in r.watch[0], k);
});

test('Adapter: live status, only the three theater chokepoints, in display order, states whitelisted', () => {
  const r = live();
  assert.equal(r.source, 'IronCommand');
  assert.equal(r.status, 'live');
  assert.equal(r.error, null);
  assert.equal(r.generatedAt, '2026-09-13T21:50:07.000Z');
  assert.equal(r.generatedAgeH, 0.7);
  assert.equal(r.embargoHours, 6);
  assert.equal(r.windowHours, 96);
  assert.equal(r.feedChokepoints, 6);
  assert.deepEqual(r.chokepoints.map(c => c.key), IC.THEATER_CHOKEPOINTS);
  assert.deepEqual(r.chokepoints.map(c => [c.state, c.trend, c.events7d, c.eventsPrior7d]), [['SPIKE', 'up', 11, 2], ['SPIKE', 'up', 11, 2], ['ELEVATED', 'up', 3, 0]]);
  assert.ok(r.chokepoints.every(c => c.spark.length <= IC.MAX_SPARK && c.spark.every(v => Number.isInteger(v) && v >= 0)));
  assert.ok(r.chokepoints.every(c => Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180));
  assert.equal(r.stats.spike, 2);
  assert.equal(r.stats.elevated, 1);
  assert.equal(r.stats.feeds, 120);
  assert.equal(r.stats.items7d, 13059);
});

test('Adapter: tripwires keep last-fired dates and are tagged theater / out-of-theater', () => {
  const w = live().tripwires;
  assert.equal(w.length, 3);
  assert.deepEqual(w.map(x => [x.theater, x.lastFired, x.fired7d]), [[true, '2026-09-05', false], [true, '2026-08-15', false], [false, null, false]]);
  assert.match(w[2].description, /Hormuz/);
  assert.equal(IC.toTripwire({ description: 'x', last_fired: '13/09/2026', fired_7d: 1 }).lastFired, null);
});

test('Adapter: MND daily transcription dropped, non-security in-theater clusters dropped, rest graded and bounded', () => {
  const r = live();
  assert.equal(r.stats.mndDuplicates, 1);
  assert.equal(r.stats.offTopic, 3);
  assert.equal(r.stats.shown, 7);
  assert.ok(r.problems.some(p => /MND daily-report cluster dropped \(CRUCIX polls MND directly\)/.test(p)));
  assert.ok(!r.events.some(e => /MND daily/i.test(e.title)), 'no MND transcription survives');
  assert.ok(!r.events.some(e => /weather|cost of living|semiconductor/i.test(e.title)), 'no noise survives');
  assert.ok(r.events.every(e => ['A', 'B', 'C', 'D', 'E', 'F'].includes(e.grade)));
  assert.deepEqual(r.stats.byGrade, { A: 6, B: 1 });
  assert.ok(r.events.every(e => e.locationPrecision === 'centroid'));
  assert.ok(r.events.every(e => /^https:\/\/www\.ironcommand\.co\/watch#e\d+$/.test(e.url)));
  assert.ok(r.events.every(e => e.sources.length <= 12 && e.sources.every(s => s.length <= 60)));
  assert.ok(r.events.every(e => e.title.length <= 200));
  for (let i = 1; i < r.events.length; i++) assert.ok(r.events[i - 1].last >= r.events[i].last, 'newest first');
  assert.equal(r.events[0].grade, 'A');
  assert.match(r.events[0].title, /Coast Guard Cooperation with Taiwan/);
  assert.equal(r.events[0].corroboration, 6);
  // Hormuz / Korea / Malacca events never enter the theater list.
  assert.ok(!r.events.some(e => /Hormuz|Korea|Malacca/i.test(`${e.place} ${e.region}`)));
  assert.ok(raw().events.some(e => e.id === 8205 && /Hormuz/.test(e.title)), 'the #e8205 fragment the user linked is a Hormuz event in the fixture');
});

test('Adapter: filters — region tag admits, place name needs a security term, MND transcription is a duplicate', () => {
  assert.equal(IC.isTheaterEvent({ region: 'taiwan-strait' }), true);
  assert.equal(IC.isTheaterEvent({ region: null, place: 'Okinawa' }), true);
  assert.equal(IC.isTheaterEvent({ region: 'hormuz', place: 'Bandar Abbas' }), false);
  assert.equal(IC.isRelevant({ region: 'taiwan-strait', title: 'PLA sorties near median line' }), true);
  assert.equal(IC.isRelevant({ region: 'taiwan-strait', title: 'Hot weather to persist across Taiwan' }), false);
  assert.equal(IC.isRelevant({ region: null, place: 'Japan', title: 'Cost of living rises in Japan' }), false);
  assert.equal(IC.isRelevant({ region: null, place: 'Japan', title: 'JSDF scrambles fighters over East China Sea' }), true);
  assert.equal(IC.isMndDuplicate({ title: 'Taiwan MND daily PLA report: 12 aircraft, 7 ships' }), true);
});

test('Adapter: hostile / malformed records are bounded, not thrown', () => {
  const e = IC.toEvent({ id: -3, title: '<script>x</script>'.repeat(40), lat: 999, lon: 'abc', grade: 'z', sources: Array(40).fill('s'), corroboration: -5, region: 'TAIWAN-STRAIT' });
  assert.equal(e.id, null);
  assert.equal(e.url, IC.SITE_URL);
  assert.ok(e.title.length <= 200 && !e.title.includes('<'));
  assert.equal(e.lat, null);
  assert.equal(e.lon, null);
  assert.equal(e.grade, null);
  assert.equal(e.sources.length, 12);
  assert.equal(e.corroboration, 0);
  assert.equal(e.region, 'taiwan-strait');
  const c = IC.toChokepoint({ key: 'Taiwan-Strait', state: 'panic', trend: 'sideways', spark: Array(50).fill(3), events_7d: -1 });
  assert.equal(c.key, 'taiwan-strait');
  assert.equal(c.state, 'UNKNOWN');
  assert.equal(c.trend, 'flat');
  assert.equal(c.spark.length, IC.MAX_SPARK);
  assert.equal(c.events7d, 0);
});

test('Adapter: health vocabulary — unavailable / empty / stale / limited are distinct from live', () => {
  assert.equal(IC.buildResult(null, AT).status, 'unavailable');
  assert.equal(IC.buildResult([], AT).status, 'unavailable');
  assert.equal(IC.buildResult({ events: [], chokepoints: [] }, AT).status, 'unavailable');
  assert.match(IC.buildResult({}, AT).error, /no events and no chokepoints/);
  const hormuzOnly = IC.buildResult({ generated_at: '2026-09-13T21:50:07Z', events: [{ id: 1, title: 'Tanker hit', place: 'Hormuz', region: 'hormuz' }], chokepoints: [{ key: 'hormuz', state: 'SPIKE' }] }, AT);
  assert.equal(hormuzOnly.status, 'empty');
  assert.ok(hormuzOnly.problems.some(p => /matched the Taiwan theater keys/.test(p)));
  const stale = IC.buildResult(raw(), '2026-09-15T12:00:00.000Z');
  assert.equal(stale.status, 'stale');
  assert.ok(stale.generatedAgeH > IC.STALE_AFTER_H);
  assert.ok(stale.problems.some(p => /snapshot generated .* h ago/.test(p)));
  const odd = raw(); odd.chokepoints.find(c => c.key === 'taiwan-strait').state = 'MELTDOWN';
  const lim = IC.buildResult(odd, AT);
  assert.equal(lim.status, 'limited');
  assert.equal(lim.chokepoints[0].state, 'UNKNOWN');
  const noChoke = raw(); noChoke.chokepoints = [];
  assert.equal(IC.buildResult(noChoke, AT).status, 'limited');
});

test('Adapter: attribution, link-back and disclaimers ride with every result; PLAN tracker is a link-out', () => {
  const r = live();
  assert.equal(r.attribution, IC.ATTRIBUTION);
  assert.match(r.attribution, /Iron Command Pacific Watch \(ironcommand\.co\)/);
  assert.equal(r.license, 'Attribution + link-back (informal)');
  assert.equal(r.siteUrl, 'https://www.ironcommand.co/watch');
  assert.equal(r.methodologyUrl, 'https://www.ironcommand.co/methodology');
  assert.ok(r.disclaimer.some(d => /Grades are source reliability/.test(d)));
  assert.ok(r.disclaimer.some(d => /not vessel or aircraft activity/.test(d)));
  assert.ok(r.disclaimer.some(d => /CRUCIX polls MND directly/.test(d)));
  const lo = LINK_OUTS.find(l => l.key === 'ic-plan');
  assert.ok(lo, 'PLA Navy Tracker listed as link-out');
  assert.equal(lo.url, IC.PLAN_TRACKER_URL);
  assert.match(lo.reason, /not a position feed/);
});

test('View: trimIronCommand is bounded and normalises; ironcommand is a sixth part of the Taiwan view', () => {
  const t = trimIronCommand(live());
  assert.equal(t.status, 'live');
  assert.equal(t.chokepoints.length, 3);
  assert.ok(t.chokepoints.every(c => ['SPIKE', 'ELEVATED', 'NORMAL', 'QUIET', 'UNKNOWN'].includes(c.state)));
  assert.equal(t.tripwires.length, 3);
  assert.equal(t.events.length, 7);
  assert.ok(t.events.every(e => e.locationPrecision === 'centroid' && /^https:\/\//.test(e.url)));
  assert.equal(t.stats.mndDuplicates, 1);
  assert.equal(t.disclaimer.length, 4);
  assert.equal(trimIronCommand({ status: 'failed' }).status, 'unavailable');
  assert.deepEqual(trimIronCommand({}).chokepoints, []);
  const v = buildTaiwanView({ IronCommand: live() }, {});
  assert.equal(v.parts.ironcommand, 'live');
  assert.equal(v.status, 'limited', 'one live part of six is limited, not live');
  assert.equal(v.ironcommand.stats.spike, 2);
  assert.equal(buildTaiwanView({}, {}).parts.ironcommand, 'unavailable');
});

test('View: Iron Command never moves the PRC tension composite', () => {
  const base = { air: [{ region: 'Taiwan Strait', total: 40, top: [['China', 12]], tracks: [] }], gdelt: { headlines: [] } };
  const without = buildTaiwanView({}, base).signals.prcTension;
  const with_ = buildTaiwanView({ IronCommand: live() }, base).signals.prcTension;
  assert.deepEqual(with_, without);
  assert.equal(prcTension(base).score, without.score);
});

test('Geo: chokepoints emitted once each as reference points, never as tracks; events are not drawn', () => {
  const g = buildTaiwanGeo({ IronCommand: live() });
  const cps = g.features.filter(f => f.type === 'ic-chokepoint');
  assert.equal(cps.length, 3);
  assert.deepEqual(cps.map(f => f.key), IC.THEATER_CHOKEPOINTS);
  assert.ok(cps.every(f => f.precision === 'reference' && Number.isFinite(f.lat) && Number.isFinite(f.lon)));
  assert.ok(cps.every(f => ['SPIKE', 'ELEVATED', 'NORMAL', 'QUIET', 'UNKNOWN'].includes(f.state) && ['up', 'down', 'flat'].includes(f.trend)));
  assert.equal(cps[0].generatedAt, '2026-09-13T21:50:07.000Z');
  assert.equal(g.features.filter(f => f.type === 'ic-event').length, 0);
  assert.equal(buildTaiwanGeo({}).features.filter(f => f.type === 'ic-chokepoint').length, 0);
});

test('Layers: ic-chokepoints is a data layer (never signal) that goes dark when the source does', () => {
  const layer = LAYERS.find(l => l.id === 'ic-chokepoints');
  assert.ok(layer);
  assert.deepEqual(layer.types, ['ic-chokepoint']);
  assert.deepEqual(layer.sources, ['IronCommand']);
  const on = evaluateLayers({ taiwan: buildTaiwanView({ IronCommand: live() }, {}) }).layers.find(r => r.id === 'ic-chokepoints');
  assert.equal(on.state, 'data');
  assert.equal(on.count, 3);
  assert.match(on.why, /Taiwan Strait SPIKE \(11 vs 2 prior 7 d\)/);
  assert.match(on.why, /6 h delayed/);
  const off = evaluateLayers({ taiwan: buildTaiwanView({}, {}) }).layers.find(r => r.id === 'ic-chokepoints');
  assert.equal(off.state, 'none');
  const cached = evaluateLayers({ taiwan: buildTaiwanView({ IronCommand: { ...live(), stale: true, status: 'limited' } }, {}) }).layers.find(r => r.id === 'ic-chokepoints');
  assert.match(cached.why, /cached copy/);
});
