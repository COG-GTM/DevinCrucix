// Chinese Delegation Tracker + SYNTHETIC overlay (lib/prcdel/*). No external network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

import { findPlaces, placeByCity } from '../lib/prcdel/gazetteer.mjs';
import { toMgrs } from '../lib/prcdel/mgrs.mjs';
import { parseDelegationItem, parseEventItem, groupDelegations, findConcurrent, buildTracker } from '../lib/prcdel/tracker.mjs';
import { generateSynthetic, buildScenarioDelegations, buildScenarioEvents, pivot, DATASETS } from '../lib/prcdel/synthetic.mjs';
import { createPrcDelService, validateScenario } from '../lib/prcdel/service.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scenario = JSON.parse(readFileSync(join(ROOT, 'config/synthetic/scenario.json'), 'utf8'));
const NOW = Date.parse('2026-10-06T00:00:00Z');
const item = (title, published, link = 'https://example.org/a') => ({ title, published, link });

test('gazetteer: city beats country, aliases resolve', () => {
  const p = findPlaces('Chinese delegation in Cairo, Egypt meets minister');
  assert.equal(p[0].city, 'Cairo');
  assert.equal(p[0].precision, 'city');
  assert.equal(findPlaces('Chinese delegation visits Lebanon')[0].city, 'Beirut');
  assert.equal(findPlaces('Chinese delegation visits Lebanon')[0].precision, 'country');
  assert.ok(placeByCity('Islamabad'));
});

test('mgrs: known reference points', () => {
  assert.match(toMgrs(38.8977, -77.0365), /^18S UJ 23\d{3} 07\d{3}$/);
  assert.match(toMgrs(30.0444, 31.2357), /^36R UU \d{5} \d{5}$/);
});

test('tracker: parse, group, concurrent window', () => {
  const s1 = parseDelegationItem(item('Chinese economic delegation arrives in Cairo, meets Egyptian PM Madbouly - Ahram Online', 'Tue, 22 Sep 2026 10:00:00 GMT'));
  assert.ok(s1);
  assert.equal(s1.city, 'Cairo'); assert.equal(s1.date, '2026-09-22'); assert.equal(s1.outlet, 'Ahram Online');
  assert.equal(s1.category, 'Economic / Trade');
  assert.ok(s1.meetings.some(m => /Madbouly/.test(m)), JSON.stringify(s1.meetings));
  assert.equal(parseDelegationItem(item('Weather in Cairo today - Site', 'Tue, 22 Sep 2026 10:00:00 GMT')), null);
  const e = parseEventItem(item('ByteDance hosts programming and creator conference in Cairo - TechEgypt', 'Wed, 23 Sep 2026 10:00:00 GMT'));
  assert.ok(e); assert.equal(e.host, 'ByteDance'); assert.equal(e.city, 'Cairo');
  const dels = groupDelegations([s1, { ...s1, headline: s1.headline + ' (update)', outlet: 'Other', url: 'https://example.org/b' }]);
  assert.equal(dels.length, 1); assert.equal(dels[0].stops.length, 1); assert.equal(dels[0].stops[0].sources.length, 2);
  e.id = 'ev-1';
  assert.equal(findConcurrent(dels, [e], 3).length, 1);
  assert.equal(dels[0].stops[0].concurrent[0].gapDays, 1);
  assert.equal(findConcurrent(dels, [e], 0).length, 0);
  assert.equal(findConcurrent(dels, [{ ...e, synthetic: true }], 3).length, 0, 'synthetic events never attach to OSINT delegations');
  const t = buildTracker({ generatedAt: new Date(NOW).toISOString(), stops: [s1], events: [e] }, { windowDays: 3 });
  assert.equal(t.counts.overlaps, 1);
});

test('synthetic: one POI per delegation, partial coverage, multi-country, test-only identifiers', () => {
  const synDelegations = buildScenarioDelegations(scenario, NOW);
  const synEvents = buildScenarioEvents(scenario, synDelegations, NOW);
  findConcurrent(synDelegations, synEvents, 3);
  assert.ok(synDelegations[0].stops.find(s => s.city === 'Cairo').concurrent.length, 'Cairo stop has the ByteDance event');
  const osint = groupDelegations([parseDelegationItem(item('Chinese delegation visits Nairobi, meets Kenyan President Ruto - Nation', 'Mon, 28 Sep 2026 10:00:00 GMT'))]);
  const syn = generateSynthetic({ scenario, delegations: osint, events: synEvents, synDelegations, synEvents, now: NOW });
  const again = generateSynthetic({ scenario, delegations: osint, events: synEvents, synDelegations, synEvents, now: NOW });
  assert.deepEqual(syn.counts, again.counts, 'deterministic for a seed');
  const pois = syn.persons.filter(p => p.isPOI);
  assert.equal(pois.length, synDelegations.length + osint.length);
  for (const d of [...synDelegations, ...osint]) assert.ok(pois.some(p => p.delegationId === d.id), d.id);
  assert.ok(pois.some(p => p.absentFrom.length > 0), 'some POIs missing from some datasets');
  assert.ok(pois.every(p => p.absentFrom.length < DATASETS.length), 'every POI is findable somewhere');
  for (const k of DATASETS) assert.ok(syn.datasets[k].length > 0, k);
  assert.ok(new Set(syn.datasets.ss7.map(r => r.servingCountry)).size >= 3, 'SS7 hits across route countries');
  const all = JSON.stringify(syn.datasets);
  for (const r of syn.datasets.ss7) { assert.match(r.imsi, /^001/); assert.match(r.imei, /^00/); assert.ok(r.mgrs); }
  for (const m of all.matchAll(/"email":"([^"]+)"/g)) assert.match(m[1], /\.example\.test$/);
  assert.ok(syn.datasets.voter.some(v => v.iso2 === 'LB' && v.familyRegistryNo && v.fatherName && v.motherName), 'Lebanese voter rows carry family registry + parents');
  assert.ok(Object.values(syn.datasets).flat().every(r => r.synthetic === true));
  const pv = pivot(syn, pois[0].knownSelectors);
  assert.ok(pv.records.length > 0);
  assert.ok(pv.records.some(r => r.hop >= 1), 'pivot reaches records through derived selectors');
});

test('service routes: /api/prcdel, pivot, scenario CRUD', async (t) => {
  const runs = mkdtempSync(join(tmpdir(), 'prcdel-'));
  const raw = { generatedAt: new Date().toISOString(), days: 30, errors: [],
    stops: [parseDelegationItem(item('Chinese trade delegation in Beirut meets Lebanese PM - Naharnet', new Date().toUTCString()))], events: [] };
  const svc = createPrcDelService({ root: ROOT, runsDir: runs, collect: async () => raw });
  const app = express(); app.use(express.json()); svc.register(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); rmSync(runs, { recursive: true, force: true }); });

  const j = await (await fetch(`${base}/api/prcdel?window=3`)).json();
  assert.equal(j.counts.osintDelegations, 1);
  assert.ok(j.delegations.some(d => d.synthetic));
  assert.ok(j.synthetic.persons.length > 0);
  const off = await (await fetch(`${base}/api/prcdel?synthetic=0`)).json();
  assert.equal(off.synthetic, null); assert.ok(off.delegations.every(d => !d.synthetic));

  const poi = j.synthetic.persons.find(p => p.isPOI);
  const pv = await (await fetch(`${base}/api/prcdel/pivot?person=${poi.id}`)).json();
  assert.ok(pv.records.length > 0);
  assert.equal((await fetch(`${base}/api/prcdel/pivot?person=nobody`)).status, 404);
  assert.equal((await fetch(`${base}/api/prcdel/pivot?t=banana&v=1`)).status, 400);

  const bad = await fetch(`${base}/api/prcdel/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delegations: [{ id: 'x' }] }) });
  assert.equal(bad.status, 400);
  const custom = { ...scenario, seed: 7 };
  assert.equal((await fetch(`${base}/api/prcdel/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(custom) })).status, 200);
  const got = await (await fetch(`${base}/api/prcdel/scenario`)).json();
  assert.equal(got.custom, true); assert.equal(got.scenario.seed, 7);
  await fetch(`${base}/api/prcdel/scenario`, { method: 'DELETE' });
  assert.equal((await (await fetch(`${base}/api/prcdel/scenario`)).json()).custom, false);
  assert.throws(() => validateScenario({ coverage: { travel: 2 } }));
});
