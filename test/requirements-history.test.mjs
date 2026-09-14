// lib/requirements/history.mjs + metrics.mjs — append / prune / backfill / baseline math. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { HistoryStore, computeBaseline, zScore, meanStd, pctChange, WINDOWS, WINDOW_HOURS, dimsKey, normalizeDims } from '../lib/requirements/history.mjs';
import { METRICS, METRIC_KEYS, catalog, extractSamples, extractEvidence } from '../lib/requirements/metrics.mjs';

const HOUR = 3600e3;
const NOW = Date.parse('2026-09-14T06:00:00.000Z');
const here = dirname(fileURLToPath(import.meta.url));
const sweep = JSON.parse(readFileSync(join(here, 'fixtures/requirements/sweep.json'), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'crucix-rq-'));

test('metric catalog is derived from the extractor list (no hand-copied keys)', () => {
  const cat = catalog();
  assert.deepEqual(cat.map(m => m.key), METRIC_KEYS);
  assert.deepEqual(new Set(METRIC_KEYS), new Set(METRICS.map(m => m.key)));
  for (const m of cat) {
    assert.match(m.key, /^[a-z0-9_]+$/);
    assert.ok(m.label && m.unit && m.source, m.key);
    assert.ok(Array.isArray(m.dims));
  }
  for (const k of ['conflict_events', 'conflict_fatalities', 'border_violence_events', 'urgent_posts', 'thermal_total', 'kev_total', 'kev_additions', 'gdelt_tone', 'air_total']) {
    assert.ok(METRIC_KEYS.includes(k), `catalog lacks ${k}`);
  }
});

test('extractSamples pulls scalar + dimensional samples from a synthesized sweep', () => {
  const rows = extractSamples(sweep, { now: NOW });
  const find = (metric, dims = {}) => rows.find(r => r.metric === metric && dimsKey(r.dims) === dimsKey(dims));
  assert.equal(find('conflict_events').value, 120);
  assert.equal(find('conflict_fatalities', { country: 'Ukraine' }).value, 28);
  assert.equal(find('conflict_events', { theater: 'Europe' }).value, 70);
  // 2 narco events dated today + 1 violence-flagged ingest article; the August event is outside 24h
  assert.equal(find('border_violence_events').value, 3);
  assert.equal(find('border_violence_events', { state: 'Tamaulipas' }).value, 2);
  assert.equal(find('border_violence_events', { state: 'Nuevo León' }).value, 1);
  assert.equal(find('urgent_posts').value, 1);
  assert.equal(find('thermal_total').value, 52);
  assert.equal(find('thermal_total', { theater: 'Ukraine Region' }).value, 40);
  assert.equal(find('air_total', { theater: 'Baltic Region' }).value, 30);
  assert.equal(find('kev_total').value, 1450);
  // dateAdded is day-precision: 09-14 and 09-13 both overlap the trailing 24 h at 06:00Z; 2025 does not
  assert.equal(find('kev_additions').value, 2);
  assert.equal(find('gdelt_tone').value, -3.6);
  // degraded sweep → no throw, still returns numbers
  const empty = extractSamples({}, { now: NOW });
  assert.ok(empty.every(r => Number.isFinite(r.value)));
  assert.equal(empty.find(r => r.metric === 'conflict_events').value, 0);
});

test('extractEvidence is bounded and only keeps http(s) URLs', () => {
  const ev = extractEvidence('border_violence_events', sweep, { state: 'Tamaulipas' }, { now: NOW });
  assert.equal(ev.length, 2);
  assert.ok(ev.every(e => e.title && e.source));
  assert.ok(ev.every(e => e.url === null || /^https?:\/\//.test(e.url)));
  const nl = extractEvidence('border_violence_events', sweep, { state: 'Nuevo León' }, { now: NOW });
  assert.equal(nl.length, 1);
  assert.equal(nl[0].url, null, 'javascript: URL must be dropped');
  const kev = extractEvidence('kev_additions', sweep, {}, { now: NOW });
  assert.equal(kev.length, 2);
  assert.equal(extractEvidence('nope', sweep).length, 0);
  assert.ok(extractEvidence('conflict_events', sweep, {}, { now: NOW, max: 1 }).length <= 1);
});

test('meanStd / zScore (Poisson floor) / pctChange follow anomaly.py', () => {
  assert.deepEqual(meanStd([]), { mean: 0, std: 0, n: 0 });
  // sample (n-1) standard deviation, exactly like anomaly.py _mean_std
  const { mean, std, n } = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5); assert.equal(std, Math.sqrt(32 / 7)); assert.equal(n, 8);
  assert.deepEqual(meanStd([3]), { mean: 3, std: 0, n: 1 });
  // std=0 over a mean of 1 → floor sqrt(max(mean,1)) = 1, so one extra event is z=1 not infinity
  assert.equal(zScore(2, 1, 0), 1);
  assert.equal(zScore(5, 2, 0), 3 / Math.sqrt(2));
  // floor only lifts std, never lowers it
  assert.equal(zScore(10, 4, 3), 2);
  assert.equal(zScore(7, 4, 3, { poisson: false }), 1);
  assert.equal(zScore(0, 0, 0), 0);
  assert.equal(pctChange(6, 4), 50);
  assert.equal(pctChange(2, 4), -50);
  assert.equal(pctChange(5, 0), null);
});

test('computeBaseline: buckets the trailing window, flags sparse, shape is stable', () => {
  // 30 daily buckets at value 2, current 12h bucket at value 5
  const samples = [];
  for (let d = 1; d <= 30; d++) samples.push({ ts: new Date(NOW - d * 24 * HOUR - 6 * HOUR).toISOString(), value: 2 });
  samples.push({ ts: new Date(NOW - HOUR).toISOString(), value: 5 });
  const b = computeBaseline(samples, { now: NOW, window: '30d', bucketHours: 12 });
  assert.deepEqual(Object.keys(b).sort(), ['baselineMean', 'baselineStd', 'bucketHours', 'n', 'observed', 'observedSamples', 'pctChange', 'series', 'sparse', 'window', 'z'].sort());
  assert.equal(b.observed, 5);
  assert.equal(b.baselineMean, 2);
  assert.equal(b.baselineStd, 0);
  assert.equal(b.n, 30);
  assert.equal(b.sparse, false);
  assert.equal(b.z, Math.round((3 / Math.sqrt(2)) * 1000) / 1000);
  assert.equal(b.pctChange, 150);
  assert.equal(b.series.at(-1).observed, true);
  assert.ok(b.series.length <= 97);

  // sparse: only two baseline buckets
  const s2 = computeBaseline(samples.slice(-3), { now: NOW, window: '30d', bucketHours: 12 });
  assert.equal(s2.sparse, true);
  assert.equal(s2.n, 2);
  // no observation → observed null, sparse, z null
  const s3 = computeBaseline(samples.slice(0, 30), { now: NOW, window: '30d', bucketHours: 12 });
  assert.equal(s3.observed, null);
  assert.equal(s3.sparse, true);
  assert.equal(s3.z, null);
  // samples outside the lookback are ignored; future samples are ignored
  const far = [{ ts: new Date(NOW - 200 * 24 * HOUR).toISOString(), value: 999 }, { ts: new Date(NOW + 48 * HOUR).toISOString(), value: 999 }];
  assert.equal(computeBaseline([...samples, ...far], { now: NOW, window: '30d', bucketHours: 12 }).baselineMean, 2);
  // level metrics do not use the Poisson floor
  const lvl = computeBaseline(samples, { now: NOW, window: '30d', bucketHours: 12, kind: 'level' });
  assert.equal(lvl.z, 0, 'std 0 and no floor → z clamps to 0');
  for (const w of WINDOWS) assert.ok(WINDOW_HOURS[w] > 0);
});

test('HistoryStore append / dedupe / query / prune / files', () => {
  const dir = tmp();
  let clock = NOW;
  const h = new HistoryStore(dir, { retentionDays: 10, now: () => clock });
  const n1 = h.append([{ metric: 'kev_total', dims: {}, value: 100 }, { metric: 'kev_total', dims: { theater: 'x' }, value: 1 }, { metric: 'not_a_metric', value: 5 }, { metric: 'kev_total', value: NaN }], NOW - HOUR);
  assert.equal(n1, 2, 'unknown metric and NaN are dropped');
  assert.equal(h.append([{ metric: 'kev_total', dims: {}, value: 100 }], NOW - HOUR), 0, 'duplicate (ts, dims) ignored');
  assert.ok(existsSync(join(dir, 'history', 'kev_total.jsonl')));
  assert.ok(!existsSync(join(dir, 'history', 'not_a_metric.jsonl')));
  // too old for retention → rejected on write
  assert.equal(h.append([{ metric: 'kev_total', dims: {}, value: 1 }], NOW - 11 * 24 * HOUR), 0);
  for (let d = 1; d <= 9; d++) h.append([{ metric: 'kev_total', dims: {}, value: 90 + d }], NOW - d * 24 * HOUR);
  assert.equal(h.series('kev_total').length, 10);
  assert.equal(h.series('kev_total', { theater: 'x' }).length, 1);
  // window(hours) is inclusive at both ends: rows at NOW-1h and exactly NOW-24h; dims filter drops the theater row
  assert.equal(h.window('kev_total', {}, 24).length, 2);
  assert.equal(h.window('kev_total', {}, 23).length, 1);
  assert.equal(h.window('kev_total', {}, 24 * 3 + 1).length, 4);
  // 12 h buckets: observation bucket holds only NOW-1h; the 7 daily rows land in 7 distinct baseline buckets
  const b = h.baseline('kev_total', {}, { window: '7d', bucketHours: 12 });
  assert.equal(b.observed, 100);
  assert.equal(b.n, 7);
  assert.equal(b.sparse, false);
  assert.equal(b.baselineMean, 94);
  // series() can be narrowed by from/to
  assert.equal(h.series('kev_total', {}, { from: NOW - 2 * 24 * HOUR - HOUR, to: NOW }).length, 3);
  // prune on write when the clock moves past retention
  clock = NOW + 8 * 24 * HOUR;
  h.append([{ metric: 'kev_total', dims: {}, value: 5 }], clock);
  const kept = h.series('kev_total');
  assert.ok(kept.every(r => Date.parse(r.ts) >= clock - 10 * 24 * HOUR));
  assert.ok(kept.length < 11);
  const onDisk = readFileSync(join(dir, 'history', 'kev_total.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(onDisk.length, kept.length + 1, 'pruned file has the pruned scalar rows plus the theater row');
  assert.deepEqual(Object.keys(onDisk[0]).sort(), ['dims', 'ts', 'value']);
  // a fresh store re-reads the file identically
  const h2 = new HistoryStore(dir, { retentionDays: 10, now: () => clock });
  assert.deepEqual(h2.series('kev_total'), kept);
  assert.ok(h2.stats().kev_total.samples >= kept.length);
  assert.deepEqual(h2.dimValues('kev_total', 'theater'), ['x']);
  // unsafe metric names never hit the filesystem
  assert.deepEqual(h2.series('../etc/passwd'), []);
});

test('HistoryStore.record + backfill from cold archive is idempotent', () => {
  const dir = tmp();
  const cold = join(dir, 'memory', 'cold');
  mkdirSync(cold, { recursive: true });
  const runAt = (iso, n) => ({ timestamp: iso, data: { ...sweep, meta: { ...sweep.meta, timestamp: iso }, acled: { ...sweep.acled, totalEvents: n } } });
  writeFileSync(join(cold, '2026-09-12.json'), JSON.stringify([runAt('2026-09-12T01:00:00.000Z', 10), runAt('2026-09-12T02:00:00.000Z', 11)]));
  writeFileSync(join(cold, 'garbage.json'), '{not json');
  writeFileSync(join(dir, 'memory', 'hot.json'), JSON.stringify({ runs: [runAt('2026-09-13T01:00:00.000Z', 12)] }));
  const h = new HistoryStore(dir, { now: () => NOW });
  const r1 = h.backfill();
  assert.equal(r1.files, 1);
  assert.equal(r1.runs, 3);
  assert.ok(r1.samples > 0);
  assert.deepEqual(h.series('conflict_events').map(s => s.value), [10, 11, 12]);
  const r2 = h.backfill();
  assert.equal(r2.files, 0, 'marker prevents re-reading the same day');
  assert.equal(new HistoryStore(dir, { now: () => NOW }).backfill({ force: true }).samples, 0, 'forced re-read writes no duplicates');
  // record() the live sweep appends every metric at the sweep timestamp
  const n = h.record(sweep);
  assert.ok(n > 10);
  assert.equal(h.series('conflict_events').at(-1).ts, sweep.meta.timestamp);
  assert.equal(h.record(sweep), 0, 'recording the same sweep twice is a no-op');
  assert.deepEqual(normalizeDims({ state: ' Tamaulipas ', bogus: 'x', country: '' }), { state: 'Tamaulipas' });
});
