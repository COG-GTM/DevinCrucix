// Situation strip rules — unit tests (no network)
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSituation, prcTension, SEVERITIES, TABS, MAX_HEADLINES } from '../lib/situation.mjs';

const health = (over = {}) => ({
  summary: { live: 40, degraded: 3, no_key: 5, off: 2, error: 0, total: 50, reporting: 43, ...over },
  sources: [],
});

describe('buildSituation', () => {
  it('returns a single baseline headline when nothing fires', () => {
    const s = buildSituation({ sourceHealth: health(), defcon: { level: 5 } });
    assert.equal(s.quiet, true);
    assert.equal(s.headlines.length, 1);
    assert.equal(s.headlines[0].rule, 'baseline');
    assert.equal(s.headlines[0].severity, 'info');
    assert.match(s.headlines[0].why, /40 sources live/);
    assert.ok(Date.parse(s.asOf));
  });

  it('tolerates a missing or empty payload', () => {
    for (const payload of [undefined, null, {}]) {
      const s = buildSituation(payload);
      assert.equal(s.quiet, true);
      assert.equal(s.headlines.length, 1);
    }
  });

  it('ranks by severity, caps at MAX_HEADLINES and routes each headline to a valid tab', () => {
    const s = buildSituation({
      sourceHealth: health({ error: 3, total: 50 }),
      defcon: { level: 2, label: 'HIGH READINESS', score: 81, components: { cii: { score: 40 }, signals: 20 } },
      nuke: [{ site: 'Zaporizhzhia', anom: true, cpm: 412 }],
      delta: { signals: { escalated: [{ key: 'vix', label: 'VIX', from: 14, to: 31, pctChange: 121, severity: 'critical' }], new: [] } },
      focalPoints: { focalPoints: [{ name: 'Strait of Hormuz', type: 'chokepoint', urgency: 'Critical', narrative: 'Three sources converge.' }] },
      cii: { countries: [{ name: 'Sudan', level: 'Critical' }, { name: 'Haiti', level: 'Critical' }], warmingUp: true, warmupProgress: 40 },
      convergence: { zones: [{ alertLevel: 'Critical', typeCount: 4, totalEvents: 22, lat: 31.5, lng: 34.4 }] },
      borderNews: { spikes: [{ place: 'el-paso-tx', placeName: 'El Paso, TX', topic: 'enforcement', count24h: 9, baselineDailyMean: 1.5, ratio: 6 }] },
      cyberKev: { recentCount: 7, ransomwareCount: 2, prcRelevantCount: 1 },
      spaceWeather: { kp: { current: 7, level: 'G3 Strong', severity: 'severe' } },
      typosquat: { newCount: 3, watchlist: ['treasury.gov'] },
    });
    assert.equal(s.quiet, false);
    assert.equal(s.headlines.length, MAX_HEADLINES);
    assert.ok(s.rulesFired > MAX_HEADLINES);
    const ranks = s.headlines.map(h => SEVERITIES.indexOf(h.severity));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.equal(s.headlines[0].severity, 'critical');
    for (const h of s.headlines) {
      assert.ok(TABS.includes(h.tab), h.tab);
      assert.ok(h.title.length <= 140 && h.why.length <= 220);
      assert.ok(h.source && h.panel);
    }
    assert.equal(s.counts.critical, 2);
  });

  it('describes DEFCON drivers and treats level 5 as silent', () => {
    const fired = buildSituation({ defcon: { level: 3, label: 'INCREASED READINESS', score: 55, components: { cii: 30, polymarket: 10 } } });
    const d = fired.headlines.find(h => h.rule === 'defcon');
    assert.equal(d.severity, 'high');
    assert.match(d.title, /DEFCON 3 — INCREASED READINESS/);
    assert.match(d.why, /cii 30, polymarket 10/);
    assert.equal(buildSituation({ defcon: { level: 5 } }).headlines.some(h => h.rule === 'defcon'), false);
  });

  it('flags provisional CII judgments during warm-up and lists at most three countries', () => {
    const s = buildSituation({ cii: { warmingUp: true, warmupProgress: 25,
      countries: ['A', 'B', 'C', 'D'].map(n => ({ name: n, level: 'Critical' })) } });
    const h = s.headlines.find(x => x.rule === 'cii');
    assert.match(h.title, /^4 countries at Critical instability: A, B, C$/);
    assert.match(h.why, /provisional/);
  });

  it('routes Border Watch spikes to the regional tab with the baseline ratio', () => {
    const s = buildSituation({ borderNews: { spikes: [{ place: 'hidalgo-county-tx', placeName: 'Hidalgo County, TX', topic: 'migration', count24h: 6, baselineDailyMean: 0.5, ratio: 12 }] } });
    const h = s.headlines.find(x => x.rule === 'border');
    assert.equal(h.tab, 'regional');
    assert.equal(h.panel, 'border-panel');
    assert.match(h.title, /Hidalgo County, TX · migration \(12× baseline\)/);
  });

  it('surfaces coverage when a quarter of sources are dark or any source failed, naming the failures', () => {
    const quietCoverage = buildSituation({ sourceHealth: health({ no_key: 2, off: 0, error: 0, total: 50 }) });
    assert.equal(quietCoverage.headlines.some(h => h.rule === 'coverage'), false);

    const dark = buildSituation({ sourceHealth: health({ no_key: 11, off: 2, error: 0, total: 52 }) });
    const c = dark.headlines.find(h => h.rule === 'coverage');
    assert.equal(c.severity, 'info');
    assert.match(c.title, /13 of 52 sources not reporting/);
    assert.match(c.why, /not "quiet"/);

    const failed = buildSituation({ sourceHealth: { ...health({ error: 2, total: 50 }), sources: [
      { name: 'OpenSky', state: 'error' }, { name: 'ReliefWeb', state: 'error' }, { name: 'GDELT', state: 'live' }] } });
    const f = failed.headlines.find(h => h.rule === 'coverage');
    assert.equal(f.severity, 'elevated');
    assert.match(f.why, /Failed this sweep: OpenSky, ReliefWeb/);
    assert.equal(f.tab, 'sources');
  });

  it('collapses whitespace and truncates third-party text in titles', () => {
    const s = buildSituation({ focalPoints: { focalPoints: [{ name: `<b>${'x'.repeat(300)}</b>\n\n  y`, type: 'org', urgency: 'Critical' }] } });
    const h = s.headlines.find(x => x.rule === 'focal');
    assert.equal(h.title.length, 140);
    assert.equal(h.title.includes('\n'), false);
    assert.ok(h.title.startsWith('Focal point: <b>'));
  });

  it('keeps going when one rule throws', () => {
    const s = buildSituation({ defcon: { level: 3, components: Object.create(null, { bad: { get() { throw new Error('boom'); }, enumerable: true } }) },
      typosquat: { newCount: 1, watchlist: [] } });
    assert.ok(s.headlines.some(h => h.rule === 'typosquat'));
  });
});

describe('prcTension', () => {
  it('matches the Signal Core composite: 1.5×air + 8×GDELT + 15×ISR, capped at 100', () => {
    const t = prcTension({
      air: [{ region: 'Taiwan Strait', total: 20, top: [['China', 10], ['Taiwan', 8]] }, { region: 'South China Sea', total: 6 }],
      gdelt: { topTitles: ['PLA drills near Taiwan', 'Markets rally', 'Beijing responds'] },
      adsbMilitary: { categories: { isr: [{ country: 'China' }, { country: 'United States' }] } },
    });
    assert.equal(t.straitCn, 10);
    assert.equal(t.scsTotal, 6);
    assert.equal(t.gdeltPrc, 2);
    assert.equal(t.isr, 1);
    assert.equal(t.score, Math.round(16 * 1.5 + 2 * 8 + 15));
    assert.equal(t.level, 'HEIGHTENED');
    assert.equal(prcTension({}).level, 'REDUCED');
    assert.equal(prcTension({ gdelt: { topTitles: Array(20).fill('China') } }).score, 100);
  });

  it('only raises a headline at HEIGHTENED or above', () => {
    assert.equal(buildSituation({ gdelt: { topTitles: ['China', 'China'] } }).headlines.some(h => h.rule === 'prc'), false);
    const s = buildSituation({ gdelt: { topTitles: Array(9).fill('Taiwan') } });
    const h = s.headlines.find(x => x.rule === 'prc');
    assert.equal(h.tab, 'military');
    assert.equal(h.prc.level, 'ELEVATED');
  });
});
