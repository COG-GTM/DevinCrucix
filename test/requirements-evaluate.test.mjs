// lib/requirements/evaluate.mjs — firing, evidence, historical hits, episode de-dup, Situation headlines, store persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { HistoryStore, computeBaseline } from '../lib/requirements/history.mjs';
import { RequirementsStore, SEED_REQUIREMENTS, decideFired, dimCombos, evaluateRule, headlineFor, mergeHeadlines, seriesForRule } from '../lib/requirements/evaluate.mjs';
import { validateRule } from '../lib/requirements/compile.mjs';
import { buildSituation, TABS } from '../lib/situation.mjs';

const HOUR = 3600e3;
const NOW = Date.parse('2026-09-14T06:00:00.000Z');
const here = dirname(fileURLToPath(import.meta.url));
const sweep = JSON.parse(readFileSync(join(here, 'fixtures/requirements/sweep.json'), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'crucix-rq-ev-'));
const quiet = { log() {}, warn() {}, error() {}, info() {} };

// 30 days of a flat baseline for the seeded border-violence rule, then a hot observation window.
function seedHistory(dir, { baselineValue = 1, spikeValue = 9, clock = NOW } = {}) {
  const h = new HistoryStore(dir, { now: () => clock });
  for (let hrs = 13; hrs <= 24 * 31; hrs += 12) {
    const ts = clock - hrs * HOUR;
    h.append([
      { metric: 'border_violence_events', dims: { state: 'Tamaulipas' }, value: baselineValue },
      { metric: 'border_violence_events', dims: { state: 'Nuevo León' }, value: baselineValue },
      { metric: 'conflict_fatalities', dims: { country: 'Ukraine' }, value: 30 },
      { metric: 'kev_additions', dims: {}, value: 1 },
    ], ts);
  }
  h.append([
    { metric: 'border_violence_events', dims: { state: 'Tamaulipas' }, value: spikeValue },
    { metric: 'border_violence_events', dims: { state: 'Nuevo León' }, value: spikeValue },
    { metric: 'conflict_fatalities', dims: { country: 'Ukraine' }, value: 28 },
    { metric: 'kev_additions', dims: {}, value: 2 },
  ], clock - HOUR);
  return h;
}

test('seed requirements validate and cover the three shipped defaults', () => {
  assert.equal(SEED_REQUIREMENTS.length, 3);
  const metrics = SEED_REQUIREMENTS.map(s => validateRule({ ...s, id: undefined }));
  assert.ok(metrics.every(v => v.ok), JSON.stringify(metrics.map(v => v.errors)));
  assert.deepEqual(metrics.map(v => v.rule.metric), ['border_violence_events', 'conflict_fatalities', 'kev_additions']);
  assert.deepEqual(metrics[0].rule.dims, { state: ['Tamaulipas', 'Nuevo León'] });
  assert.equal(metrics[0].rule.window, 'overnight'); assert.equal(metrics[0].rule.baseline, '30d');
  assert.equal(metrics[1].rule.window, '24h'); assert.equal(metrics[1].rule.baseline, '7d');
  assert.equal(metrics[2].rule.window, '24h'); assert.equal(metrics[2].rule.baseline, '30d');
});

test('decideFired honours comparison + direction; sparse / missing observations never fire', () => {
  const base = { observed: 10, z: 3, pctChange: 200, sparse: false };
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'up' }, base), true);
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'down' }, base), false);
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'down' }, { ...base, z: -2.5 }), true);
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'either' }, { ...base, z: -2.5 }), true);
  assert.equal(decideFired({ comparison: 'pct', threshold: 50, direction: 'up' }, base), true);
  assert.equal(decideFired({ comparison: 'pct', threshold: 50, direction: 'up' }, { ...base, pctChange: 20 }), false);
  assert.equal(decideFired({ comparison: 'pct', threshold: 50, direction: 'up' }, { ...base, pctChange: null }), false);
  assert.equal(decideFired({ comparison: 'abs', threshold: 5, direction: 'up' }, base), true);
  assert.equal(decideFired({ comparison: 'abs', threshold: 5, direction: 'down' }, base), false);
  assert.equal(decideFired({ comparison: 'abs', threshold: 20, direction: 'down' }, base), true);
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'up' }, { ...base, sparse: true }), false);
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'up' }, { ...base, observed: null }), false);
  assert.equal(decideFired({ comparison: 'z', threshold: 2, direction: 'up' }, null), false);
  assert.deepEqual(dimCombos({ state: ['A', 'B'], country: 'MX' }), [{ state: 'A', country: 'MX' }, { state: 'B', country: 'MX' }]);
  assert.deepEqual(dimCombos({}), [{}]);
});

test('evaluateRule: multi-state dims are summed, baseline is Poisson-floored, evidence rows attached', () => {
  const dir = tmp();
  const history = seedHistory(dir);
  const rule = validateRule({ ...SEED_REQUIREMENTS[0], id: undefined }).rule;
  const series = seriesForRule(history, rule, { now: NOW });
  assert.ok(series.length >= 60);
  assert.equal(series.at(-1).value, 18, 'Tamaulipas + Nuevo León summed per timestamp');
  const ev = evaluateRule(rule, { history, sweep, now: NOW, computeBaseline });
  assert.equal(ev.observed, 18);
  assert.equal(ev.baselineMean, 2);
  assert.equal(ev.baselineStd, 0);
  assert.equal(ev.z, Math.round((16 / Math.sqrt(2)) * 1000) / 1000, 'std floor = sqrt(mean)');
  assert.equal(ev.pctChange, 800);
  assert.equal(ev.sparse, false);
  assert.equal(ev.fired, true);
  assert.equal(ev.bucketHours, 12);
  assert.ok(ev.series.length > 0 && ev.series.at(-1).observed === true);
  assert.ok(ev.evidence.length >= 3, 'narco events + violence article for both states');
  assert.ok(ev.evidence.every(e => e.url === null || /^https?:\/\//.test(e.url)));
  assert.ok(ev.evidence.some(e => /Reynosa/.test(e.title)));
  assert.ok(!ev.evidence.some(e => /javascript:/.test(String(e.url))));
  // quiet: observation equals baseline → z 0, not fired, evidence still attached for context since observed > 0
  const calm = seedHistory(tmp(), { spikeValue: 1 });
  const ev2 = evaluateRule(rule, { history: calm, sweep, now: NOW, computeBaseline });
  assert.equal(ev2.fired, false);
  assert.equal(ev2.z, 0);
  // no history at all → sparse, no fire, no evidence
  const ev3 = evaluateRule(rule, { history: new HistoryStore(tmp(), { now: () => NOW }), sweep, now: NOW, computeBaseline });
  assert.equal(ev3.sparse, true); assert.equal(ev3.fired, false); assert.equal(ev3.observed, null); assert.deepEqual(ev3.evidence, []);
});

test('headlineFor targets tab requirements / panel = rule id and mergeHeadlines keeps the strip sane', () => {
  const rule = validateRule({ ...SEED_REQUIREMENTS[0], id: 'req_abcdef123456' }).rule;
  const h = headlineFor(rule, { observed: 18, baselineMean: 2, z: 11.3, pctChange: 800, n: 60 });
  assert.equal(h.tab, 'requirements');
  assert.equal(h.panel, 'req_abcdef123456');
  assert.equal(h.severity, 'high');
  assert.equal(h.rule, 'requirement');
  assert.match(h.title, /^Requirement fired: /);
  assert.match(h.why, /z \+11\.3 vs 30d baseline/);
  assert.ok(TABS.includes('requirements'), 'situation.mjs must whitelist the tab or the headline is re-targeted');
  // buildSituation's own validator must accept the headline shape untouched
  const sit = buildSituation({ ...sweep, situation: undefined }, new Date(NOW));
  const before = sit.headlines.length;
  mergeHeadlines(sit, [h]);
  assert.equal(sit.headlines[0].panel, 'req_abcdef123456');
  assert.equal(sit.requirementsFired, 1);
  assert.ok(sit.headlines.length >= Math.min(before, 1));
  assert.ok(sit.headlines.length <= Math.max(5, 1));
  assert.equal(sit.counts.high >= 1, true);
  // merging nothing is a no-op
  const copy = JSON.parse(JSON.stringify(sit));
  mergeHeadlines(sit, []);
  assert.deepEqual(sit, copy);
});

test('RequirementsStore: seeds once, only stores validator-approved rules, persists to runs/requirements', () => {
  const dir = tmp();
  const store = new RequirementsStore(dir, { now: () => NOW, log: quiet });
  assert.equal(store.seeded, true);
  assert.equal(store.list().length, 3);
  assert.ok(existsSync(join(dir, 'requirements', 'rules.json')));
  // reopening does not re-seed
  const again = new RequirementsStore(dir, { now: () => NOW, log: quiet });
  assert.equal(again.seeded, false);
  assert.equal(again.list().length, 3);
  // rejected candidates are never written
  const bad = store.add({ name: 'x', text: 'x', metric: 'nope', window: '24h', baseline: '30d', comparison: 'z', threshold: 2, direction: 'up', severity: 'high' });
  assert.equal(bad.ok, false);
  assert.equal(store.list().length, 3);
  assert.ok(!readFileSync(join(dir, 'requirements', 'rules.json'), 'utf8').includes('"nope"'));
  const good = store.add({ name: 'KEV total', text: 'kev total 7d vs 90d', metric: 'kev_total', window: '7d', baseline: '90d', comparison: 'z', threshold: 2, direction: 'up', severity: 'info', id: 'req_attacker_chosen' });
  assert.equal(good.ok, true);
  assert.notEqual(good.rule.id, 'req_attacker_chosen', 'ids are server-assigned');
  assert.equal(store.setEnabled(good.rule.id, false).enabled, false);
  assert.equal(store.setEnabled('req_000000000000', false), null);
  assert.equal(store.remove(good.rule.id), true);
  assert.equal(store.remove(good.rule.id), false);
  assert.equal(store.list().length, 3);
  // a tampered/invalid stored rule is dropped on load, not executed
  const raw = JSON.parse(readFileSync(join(dir, 'requirements', 'rules.json'), 'utf8'));
  raw.rules.push({ ...raw.rules[0], id: 'req_bad000000000', metric: 'rm_rf' });
  writeFileSync(join(dir, 'requirements', 'rules.json'), JSON.stringify(raw));
  const reloaded = new RequirementsStore(dir, { now: () => NOW, log: quiet });
  assert.equal(reloaded.list().length, 3);
  assert.ok(!reloaded.get('req_bad000000000'));
});

test('evaluateAll: fires, writes bounded findings, de-duplicates within the observation episode, records historical hits', () => {
  const dir = tmp();
  let clock = NOW;
  const history = seedHistory(dir, { clock: NOW });
  const store = new RequirementsStore(dir, { now: () => clock, log: quiet });
  const border = store.list().find(r => r.metric === 'border_violence_events');
  const kev = store.list().find(r => r.metric === 'kev_additions');
  const sit = () => ({ ...sweep, situation: { headlines: [], counts: {}, rulesFired: 0 } });

  const s1 = sit();
  const r1 = store.evaluateAll({ history, sweep: s1, computeBaseline, now: clock });
  assert.equal(r1.results.length, 3);
  assert.equal(r1.firedCount, 1, 'only the border rule spikes; KEV 2 vs mean 1 is z≈1; Ukraine 28 vs 30 is quiet');
  assert.equal(r1.newFirings.length, 1);
  const f = r1.newFirings[0];
  assert.equal(f.ruleId, border.id);
  assert.equal(f.firedAt, new Date(NOW).toISOString());
  assert.equal(f.observed, 18);
  assert.ok(f.evidence.length > 0 && f.evidence.length <= 12);
  assert.deepEqual(f.historicalHits, []);
  assert.equal(s1.situation.headlines[0].tab, 'requirements');
  assert.equal(s1.situation.headlines[0].panel, border.id);
  assert.equal(store.latestFor(kev.id).fired, false);
  assert.equal(store.latestFor(border.id).fired, true);
  assert.equal(store.snapshot().firedCount, 1);
  assert.equal(store.snapshot().rules.find(r => r.id === border.id).latest.fired, true);
  const lines = () => readFileSync(join(dir, 'requirements', 'findings.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines().length, 1);

  // 45 minutes later, still spiking → same episode: headline again, but NO new finding
  clock = NOW + 45 * 60e3;
  history.append([{ metric: 'border_violence_events', dims: { state: 'Tamaulipas' }, value: 9 }, { metric: 'border_violence_events', dims: { state: 'Nuevo León' }, value: 9 }], clock - 60e3);
  const s2 = sit();
  const r2 = store.evaluateAll({ history, sweep: s2, computeBaseline, now: clock });
  assert.equal(r2.firedCount, 1);
  assert.equal(r2.newFirings.length, 0, 'de-duplicated within the 12 h overnight window');
  assert.equal(store.latestFor(border.id).firedAt, f.firedAt);
  assert.equal(lines().length, 1);
  assert.equal(s2.situation.headlines.filter(h => h.tab === 'requirements').length, 1);

  // 13 hours later, spike persists → new episode, second finding with the first one as a historical hit
  clock = NOW + 13 * HOUR;
  history.append([{ metric: 'border_violence_events', dims: { state: 'Tamaulipas' }, value: 9 }, { metric: 'border_violence_events', dims: { state: 'Nuevo León' }, value: 9 }], clock - 60e3);
  const r3 = store.evaluateAll({ history, sweep: sit(), computeBaseline, now: clock });
  assert.equal(r3.newFirings.length, 1);
  assert.equal(r3.newFirings[0].historicalHits.length, 1);
  assert.equal(r3.newFirings[0].historicalHits[0].firedAt, f.firedAt);
  assert.equal(lines().length, 2);
  assert.deepEqual(store.findingsFor(border.id, 10).map(x => x.firedAt), [r3.newFirings[0].firedAt, f.firedAt]);
  assert.equal(store.findingsFor(border.id, 1).length, 1);
  assert.equal(store.latestFor(border.id).historicalHits.length, 1);

  // disabled rules are skipped and never fire; the persisted findings survive a reload
  store.setEnabled(border.id, false);
  const s4 = sit();
  const r4 = store.evaluateAll({ history, sweep: s4, computeBaseline, now: clock });
  assert.equal(r4.firedCount, 0);
  assert.equal(r4.results.length, 2);
  assert.equal(s4.situation.headlines.length, 0);
  assert.equal(store.snapshot().firedCount, 0);
  const reloaded = new RequirementsStore(dir, { now: () => clock, log: quiet });
  assert.equal(reloaded.findingsFor(border.id).length, 2);
  assert.equal(reloaded.latestFor(border.id).fired, false);
  for (const line of lines()) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(), ['baseline', 'baselineMean', 'baselineStd', 'comparison', 'direction', 'evidence', 'firedAt', 'historicalHits', 'n', 'observed', 'pctChange', 'ruleId', 'severity', 'threshold', 'window', 'z'].sort());
  }
});
