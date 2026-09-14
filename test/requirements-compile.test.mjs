// lib/requirements/compile.mjs — rule-based parser, strict validation of LLM output, LLM → fallback pipeline. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileWithRules, validateRule, compileRequirement, compileWithLLM, buildPrompt, ruleWindows,
  OBS_WINDOWS, COMPARISONS, DIRECTIONS, THRESHOLD_BOUNDS, ID_RE,
} from '../lib/requirements/compile.mjs';
import { METRIC_KEYS } from '../lib/requirements/metrics.mjs';

const fakeLLM = (text, { configured = true } = {}) => {
  const calls = [];
  return {
    calls,
    isConfigured: configured,
    async complete(system, user, opts) { calls.push({ system, user, opts }); return { text }; },
  };
};
const rulesOnly = (text) => { const c = compileWithRules(text); return { ...c, v: validateRule(c.candidate) }; };

test('fallback parser: canonical border-violence phrasing → structured, deterministic rule', () => {
  const { candidate, v } = rulesOnly('Flag overnight spikes in violence in Tamaulipas / Nuevo León vs the trailing month');
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const r = v.rule;
  assert.equal(r.metric, 'border_violence_events');
  assert.deepEqual(r.dims, { state: ['Tamaulipas', 'Nuevo León'] });
  assert.equal(r.window, 'overnight');
  assert.equal(r.baseline, '30d');
  assert.equal(r.comparison, 'z');
  assert.equal(r.threshold, 2);
  assert.equal(r.direction, 'up');
  assert.equal(r.compiledBy, 'rules');
  assert.match(r.id, ID_RE);
  assert.ok(r.name.length <= 80);
  assert.equal(candidate.compiledBy, 'rules');
  // deterministic apart from id/createdAt
  const again = rulesOnly('Flag overnight spikes in violence in Tamaulipas / Nuevo León vs the trailing month').v.rule;
  const strip = ({ id, createdAt, ...rest }) => rest;
  assert.deepEqual(strip(again), strip(r));
});

test('fallback parser: windows, baselines, comparisons, directions, metrics', () => {
  const cases = [
    ['ACLED fatalities in Ukraine over the last 24 hours vs the past week', { metric: 'conflict_fatalities', dims: { country: 'Ukraine' }, window: '24h', baseline: '7d', direction: 'up' }],
    ['Alert if new KEV additions in the last 24h exceed 2 sigma against the trailing 30 days', { metric: 'kev_additions', window: '24h', baseline: '30d', comparison: 'z', threshold: 2 }],
    ['Watch for a 40% drop in urgent telegram posts this week compared to the last 90 days', { metric: 'urgent_posts', window: '7d', baseline: '90d', comparison: 'pct', threshold: 40, direction: 'down' }],
    ['Thermal anomalies in the Ukraine Region above 3 standard deviations overnight', { metric: 'thermal_total', dims: { theater: 'Ukraine Region' }, comparison: 'z', threshold: 3, window: 'overnight' }],
    ['military aircraft / ADS-B activity over the Baltic rising or falling sharply, last day vs last month', { metric: 'air_total', dims: { theater: 'Baltic Region' }, direction: 'either' }],
    ['aircraft over the Black Sea and the Persian Gulf spiking overnight', { metric: 'air_total', dims: { theater: ['Persian Gulf', 'Ukraine/Black Sea'] } }],
    ['homicides and shootings in Sinaloa, Chihuahua and Sonora last week', { metric: 'border_violence_events', dims: { state: ['Sinaloa', 'Chihuahua', 'Sonora'] }, window: '7d' }],
    ['GDELT tone in the Middle East dropping overnight', { metric: 'gdelt_tone', dims: { theater: 'Middle East' }, direction: 'down' }],
    ['critical: more than 5 earthquakes in a day', { metric: 'seismic_events', comparison: 'abs', threshold: 5, severity: 'critical' }],
  ];
  for (const [text, want] of cases) {
    const { v } = rulesOnly(text);
    assert.equal(v.ok, true, `${text}: ${JSON.stringify(v.errors)}`);
    for (const [k, val] of Object.entries(want)) assert.deepEqual(v.rule[k], val, `${text} → ${k}`);
    assert.equal(v.rule.text, text);
  }
});

test('fallback parser: text without a recognisable metric is refused (no silent default), never a throw', () => {
  for (const text of ['', '   ', 'zzz qqq', 'flibbertigibbet purple waffles', '<script>alert(1)</script>', 'x'.repeat(2000)]) {
    let out;
    assert.doesNotThrow(() => { out = compileWithRules(text); });
    assert.equal(out.candidate, null, text.slice(0, 30));
    assert.deepEqual(out.errors, [{ field: 'metric', reason: 'unrecognized' }]);
  }
  const ok = compileWithRules('violence in Tamaulipas');
  assert.ok(ok.candidate && METRIC_KEYS.includes(ok.candidate.metric));
  assert.deepEqual(ok.errors, []);
  assert.equal(validateRule(compileWithRules('').candidate).ok, false);
});

test('validateRule rejects bad metrics / dims / windows / thresholds / enums and normalizes accepted ones', () => {
  const good = {
    name: 'KEV additions', text: 'kev additions 24h vs 30d', metric: 'kev_additions', dims: {}, window: '24h', baseline: '30d',
    comparison: 'z', threshold: 2, direction: 'up', severity: 'elevated', owner: 'analyst',
  };
  assert.equal(validateRule(good).ok, true);
  const bad = (patch, field) => {
    const v = validateRule({ ...good, ...patch });
    assert.equal(v.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    assert.equal(v.rule, null);
    assert.ok(v.errors.some(e => e.field === field), `${JSON.stringify(patch)} → ${JSON.stringify(v.errors)}`);
  };
  bad({ metric: 'made_up_metric' }, 'metric');
  bad({ metric: 'DROP TABLE' }, 'metric');
  bad({ metric: 42 }, 'metric');
  bad({ dims: { state: 'Narnia' }, metric: 'border_violence_events' }, 'dims.state');
  bad({ dims: { planet: 'Mars' } }, 'dims.planet');
  bad({ dims: { state: 'Tamaulipas' } }, 'dims.state'); // kev_additions has no state dimension
  bad({ dims: { country: '<img src=x>' }, metric: 'conflict_events' }, 'dims.country');
  bad({ dims: { state: ['Sonora', 'Sinaloa', 'Chihuahua', 'Coahuila', 'Tamaulipas'] }, metric: 'border_violence_events' }, 'dims.state');
  bad({ window: '5y' }, 'window');
  assert.equal(validateRule({ ...good, window: 'overnight', baseline: '24h' }).ok, true, 'baseline of exactly 2x the window is allowed');
  bad({ window: '24h', baseline: '24h' }, 'baseline');
  bad({ window: '7d', baseline: '7d' }, 'baseline');
  bad({ baseline: '400d' }, 'baseline');
  bad({ comparison: 'gt' }, 'comparison');
  bad({ threshold: 0.1 }, 'threshold');
  bad({ threshold: 99 }, 'threshold');
  bad({ threshold: 'NaN' }, 'threshold');
  bad({ threshold: '1e9' }, 'threshold');
  bad({ comparison: 'pct', threshold: 2 }, 'threshold');
  bad({ comparison: 'pct', threshold: 5000 }, 'threshold');
  bad({ comparison: 'abs', threshold: -1 }, 'threshold');
  bad({ direction: 'sideways' }, 'direction');
  bad({ severity: 'apocalyptic' }, 'severity');
  bad({ name: '' }, 'name');
  bad({ name: '<b>x</b>' }, 'name');
  bad({ name: 'x'.repeat(81) }, 'name');
  bad({ text: '' }, 'text');
  bad({ text: 'x'.repeat(501) }, 'text');
  bad({ owner: 'a;b' }, 'owner');
  bad({ id: 'not-an-id' }, 'id');
  bad({ metric: 'gdelt_tone', comparison: 'pct', threshold: 50 }, 'comparison');

  // normalization: state names are canonicalized via the gazetteer, ids/createdAt filled in, strings coerced
  const v = validateRule({ ...good, metric: 'border_violence_events', dims: { state: ['nuevo leon', 'TAMAULIPAS', 'Tamaulipas'], country: '' }, threshold: '2.5', enabled: 'true', compiledBy: 'llm' });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.rule.dims, { state: ['Nuevo León', 'Tamaulipas'] });
  assert.equal(v.rule.threshold, 2.5);
  assert.equal(v.rule.enabled, true);
  assert.equal(v.rule.compiledBy, 'llm');
  assert.match(v.rule.id, ID_RE);
  assert.ok(Number.isFinite(Date.parse(v.rule.createdAt)));
  assert.equal(validateRule({ ...good, id: 'req_abcdef123456' }).rule.id, 'req_abcdef123456');
  assert.equal(validateRule({ ...good, metric: 'air_total', dims: { theater: 'baltic' } }).rule.dims.theater, 'Baltic Region', 'theater alias canonicalized');
  assert.equal(validateRule(null).ok, false);
  assert.equal(validateRule('string').ok, false);
  for (const w of OBS_WINDOWS) assert.ok(ruleWindows({ window: w, baseline: '90d' }).observationHours > 0);
  assert.deepEqual(ruleWindows({ window: 'overnight', baseline: '30d' }), { observationHours: 12, baselineHours: 720 });
  assert.deepEqual(COMPARISONS, Object.keys(THRESHOLD_BOUNDS));
  assert.ok(DIRECTIONS.includes('either'));
});

test('LLM path: JSON-only prompt, provider abstraction, accepted output is tagged compiledBy llm', async () => {
  const prompt = buildPrompt();
  assert.match(prompt, /Return ONLY a JSON object/);
  for (const k of METRIC_KEYS) assert.ok(prompt.includes(k), `prompt lacks metric ${k}`);
  assert.ok(prompt.includes('Tamaulipas'));
  const llm = fakeLLM('```json\n{"name":"Ukraine fatalities","metric":"conflict_fatalities","dims":{"country":"Ukraine"},"window":"24h","baseline":"7d","comparison":"z","threshold":2.5,"direction":"up","severity":"high"}\n```');
  const out = await compileRequirement('Fatalities in Ukraine last 24h vs week', { provider: llm });
  assert.equal(out.ok, true);
  assert.equal(out.compiledBy, 'llm');
  assert.equal(out.fallbackReason, null);
  assert.equal(out.rule.metric, 'conflict_fatalities');
  assert.deepEqual(out.rule.dims, { country: 'Ukraine' });
  assert.equal(out.rule.threshold, 2.5);
  assert.equal(out.rule.text, 'Fatalities in Ukraine last 24h vs week');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].opts.temperature, 0);
  assert.match(llm.calls[0].user, /^Requirement: Fatalities in Ukraine/);
  // analyst-supplied name/severity override the model's
  const out2 = await compileRequirement('Fatalities in Ukraine last 24h vs week', { provider: fakeLLM('{"name":"model name","metric":"conflict_fatalities","window":"24h","baseline":"7d","comparison":"z","threshold":2,"direction":"up","severity":"info"}'), name: 'Analyst name', severity: 'critical' });
  assert.equal(out2.rule.name, 'Analyst name');
  assert.equal(out2.rule.severity, 'critical');
});

test('LLM path: invalid model output is rejected and never returned; the deterministic parser takes over', async () => {
  const text = 'Flag overnight spikes in violence in Tamaulipas vs the trailing month';
  const badOutputs = [
    ['{"name":"x","metric":"exfiltrate_everything","window":"24h","baseline":"30d","comparison":"z","threshold":2,"direction":"up","severity":"high"}', /llm_rejected:.*metric/],
    ['{"name":"x","metric":"border_violence_events","dims":{"state":"Gotham"},"window":"overnight","baseline":"30d","comparison":"z","threshold":2,"direction":"up","severity":"high"}', /llm_rejected:.*dims\.state/],
    ['{"name":"x","metric":"border_violence_events","window":"overnight","baseline":"30d","comparison":"z","threshold":1000,"direction":"up","severity":"high"}', /llm_rejected:.*threshold/],
    ['{"name":"x","metric":"border_violence_events","window":"forever","baseline":"30d","comparison":"z","threshold":2,"direction":"up","severity":"high"}', /llm_rejected:.*window/],
    ['{"name":"x","metric":"border_violence_events","window":"overnight","baseline":"30d","comparison":"z","threshold":2,"direction":"up","severity":"high","dims":{"state":"Tamaulipas","__proto__":{"polluted":1}}}', /llm_rejected|llm_/],
    ['I cannot help with that.', /llm_unparseable/],
    ['[1,2,3]', /llm_unparseable/],
    ['', /llm_(unparseable|empty)/],
  ];
  for (const [raw, reason] of badOutputs) {
    const llm = fakeLLM(raw);
    const out = await compileRequirement(text, { provider: llm });
    assert.equal(llm.calls.length, 1);
    assert.equal(out.compiledBy, 'rules', raw);
    assert.match(String(out.fallbackReason), reason, raw);
    assert.equal(out.ok, true);
    assert.equal(out.rule.metric, 'border_violence_events');
    assert.deepEqual(out.rule.dims, { state: 'Tamaulipas' });
    assert.notEqual(out.rule.metric, 'exfiltrate_everything');
    assert.equal(out.rule.polluted, undefined);
  }
  assert.equal(({}).polluted, undefined, 'prototype not polluted by model output');
  // provider throwing → fallback, no throw to caller
  const boom = { isConfigured: true, async complete() { throw new Error('upstream 500 with secret sk-abc'); } };
  const errs = [];
  const out = await compileRequirement(text, { provider: boom, log: { error: (...a) => errs.push(a.join(' ')) } });
  assert.equal(out.ok, true);
  assert.equal(out.compiledBy, 'rules');
  assert.equal(out.fallbackReason, 'llm_error');
  assert.equal(errs.length, 1);
  // provider not configured → never called
  const idle = fakeLLM('{}', { configured: false });
  const out2 = await compileRequirement(text, { provider: idle });
  assert.equal(idle.calls.length, 0);
  assert.equal(out2.fallbackReason, 'llm_not_configured');
  assert.equal(out2.compiledBy, 'rules');
  assert.equal(await compileWithLLM(null, text), null);
  const out3 = await compileRequirement(text, { provider: null });
  assert.equal(out3.compiledBy, 'rules');
  assert.equal(out3.fallbackReason, 'llm_not_configured');
});
