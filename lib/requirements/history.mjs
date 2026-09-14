// Queryable metric time-series for standing requirements.
//
// Layout: runs/history/<metric>.jsonl, one compact sample per line {"ts","dims","value"} (metric is
// the file name). Files are append-only during a run and rewritten only when the oldest line falls
// outside the retention window. A one-time backfill walks the MemoryManager cold archive
// (runs/memory/cold/*.json — compacted sweeps) plus hot.json so the first baselines are not empty.
//
// Baselines follow ingest/crucix_ingest/anomaly.py evaluate_region_series: observed bucket vs mean /
// std of trailing buckets, Poisson floor on the std for count metrics, sparse flag when there are
// too few baseline buckets to trust the z-score.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { extractSamples, METRIC_BY_KEY, METRIC_KEYS, DIM_KEYS } from './metrics.mjs';

export const RETENTION_DAYS = 400;
export const WINDOWS = ['24h', '7d', '30d', '90d'];
export const WINDOW_HOURS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90 };
// Observation bucket used when the caller does not override it: hourly buckets against a day,
// daily buckets against a week or longer.
export const DEFAULT_BUCKET_HOURS = { '24h': 1, '7d': 24, '30d': 24, '90d': 24 };
export const MIN_BASELINE_BUCKETS = 3;
const HOUR = 3_600_000;
const MAX_SAMPLES_PER_METRIC = 200_000;
const METRIC_FILE_RE = /^[a-z][a-z0-9_]{1,40}$/;

const round = (v, p = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : null);
const isoTs = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

export function dimsKey(dims) {
  const d = dims || {};
  return DIM_KEYS.filter(k => d[k] !== undefined && d[k] !== null && d[k] !== '').map(k => `${k}=${d[k]}`).join('|');
}

export function normalizeDims(dims) {
  const out = {};
  for (const k of DIM_KEYS) {
    const v = dims && typeof dims[k] === 'string' ? dims[k].trim() : '';
    if (v) out[k] = v;
  }
  return out;
}

// ─── statistics (port of anomaly.py evaluate_region_series) ─────────────────────────────────────

export function meanStd(values) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, std: Math.sqrt(variance), n: xs.length };
}

// z-score with the Poisson floor: sparse count series otherwise produce absurd z from a std of ~0.
export function zScore(observed, mean, std, { poisson = true } = {}) {
  const effStd = poisson ? Math.max(std, Math.sqrt(Math.max(mean, 1))) : std;
  return effStd > 0 ? (observed - mean) / effStd : 0;
}

export function pctChange(observed, mean) {
  if (!Number.isFinite(observed) || !Number.isFinite(mean)) return null;
  if (mean === 0) return observed === 0 ? 0 : null;
  return ((observed - mean) / Math.abs(mean)) * 100;
}

// Pure function so the tests (and the evaluator) can run it over synthetic series.
// samples: [{ts, value}] (any order). Returns the baseline shape plus the per-bucket series.
export function computeBaseline(samples, { now = Date.now(), window = '30d', bucketHours, kind = 'count', minBuckets = MIN_BASELINE_BUCKETS } = {}) {
  const lookbackH = WINDOW_HOURS[window] || WINDOW_HOURS['30d'];
  const bucketH = Number.isFinite(bucketHours) && bucketHours > 0 ? bucketHours : (DEFAULT_BUCKET_HOURS[window] || 24);
  const bucketMs = bucketH * HOUR;
  const start = now - lookbackH * HOUR - bucketMs;
  const obsStart = now - bucketMs;

  const obs = [];
  const buckets = new Map(); // bucketIndex -> values
  for (const s of samples) {
    const t = isoTs(s.ts);
    if (t === null || !Number.isFinite(s.value) || t < start || t > now) continue;
    if (t >= obsStart) { obs.push(s.value); continue; }
    const idx = Math.floor((now - t) / bucketMs); // 1 = most recent baseline bucket
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push(s.value);
  }
  const series = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([idx, vals]) => ({
    ts: new Date(now - idx * bucketMs).toISOString(), value: round(vals.reduce((a, b) => a + b, 0) / vals.length),
  }));
  const baseVals = series.map(b => b.value);
  const { mean, std, n } = meanStd(baseVals);
  const observed = obs.length ? obs.reduce((a, b) => a + b, 0) / obs.length : null;
  const sparse = n < minBuckets || observed === null;
  const z = observed === null ? null : zScore(observed, mean, std, { poisson: kind === 'count' });
  return {
    observed: round(observed), baselineMean: round(mean), baselineStd: round(std),
    z: round(z), pctChange: round(pctChange(observed, mean), 1), n, sparse,
    window, bucketHours: bucketH, observedSamples: obs.length,
    series: series.slice(-96).concat(observed === null ? [] : [{ ts: new Date(now).toISOString(), value: round(observed), observed: true }]),
  };
}

// ─── store ──────────────────────────────────────────────────────────────────────────────────────

export class HistoryStore {
  constructor(runsDir, { retentionDays = RETENTION_DAYS, now = () => Date.now() } = {}) {
    this.runsDir = runsDir;
    this.dir = join(runsDir, 'history');
    this.retentionMs = retentionDays * 24 * HOUR;
    this.now = now;
    this.cache = new Map(); // metric -> [{ts, dims, value}] sorted asc by ts
    this.seen = new Map();  // metric -> Set(ts|dimsKey) for idempotent appends
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  _path(metric) { return join(this.dir, `${metric}.jsonl`); }

  _load(metric) {
    if (this.cache.has(metric)) return this.cache.get(metric);
    const rows = [];
    const seen = new Set();
    if (METRIC_FILE_RE.test(metric) && existsSync(this._path(metric))) {
      for (const line of readFileSync(this._path(metric), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r.ts !== 'string' || !Number.isFinite(r.value) || isoTs(r.ts) === null) continue;
          const dims = normalizeDims(r.dims);
          const k = `${r.ts}|${dimsKey(dims)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          rows.push({ ts: r.ts, dims, value: r.value });
        } catch { /* skip corrupt line */ }
      }
      rows.sort((a, b) => isoTs(a.ts) - isoTs(b.ts));
    }
    this.cache.set(metric, rows);
    this.seen.set(metric, seen);
    return rows;
  }

  _rewrite(metric, rows) {
    const p = this._path(metric), tmp = p + '.tmp';
    try {
      writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      renameSync(tmp, p);
    } catch (err) {
      console.error('[History] rewrite failed:', err.message);
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // Drop samples older than the retention window (rewrites the file only when needed).
  prune(metric, now = this.now()) {
    const rows = this._load(metric);
    const cutoff = now - this.retentionMs;
    let keep = rows;
    if (rows.length && isoTs(rows[0].ts) < cutoff) keep = rows.filter(r => isoTs(r.ts) >= cutoff);
    if (keep.length > MAX_SAMPLES_PER_METRIC) keep = keep.slice(keep.length - MAX_SAMPLES_PER_METRIC);
    if (keep !== rows) {
      this.cache.set(metric, keep);
      this.seen.set(metric, new Set(keep.map(r => `${r.ts}|${dimsKey(r.dims)}`)));
      this._rewrite(metric, keep);
    }
    return rows.length - keep.length;
  }

  // Append samples [{metric, dims, value}] at one timestamp. Duplicate (ts, dims) pairs are ignored,
  // which makes the cold-archive backfill idempotent. Returns the number of samples written.
  append(samples, ts) {
    const t = isoTs(ts) ?? this.now();
    if (t > this.now() + 24 * HOUR || t < this.now() - this.retentionMs) return 0;
    const iso = new Date(t).toISOString();
    const byMetric = new Map();
    for (const s of samples || []) {
      if (!METRIC_BY_KEY.has(s.metric) || !Number.isFinite(s.value)) continue;
      const dims = normalizeDims(s.dims);
      const key = `${iso}|${dimsKey(dims)}`;
      this._load(s.metric);
      if (this.seen.get(s.metric).has(key)) continue;
      this.seen.get(s.metric).add(key);
      const row = { ts: iso, dims, value: s.value };
      if (!byMetric.has(s.metric)) byMetric.set(s.metric, []);
      byMetric.get(s.metric).push(row);
    }
    let written = 0;
    for (const [metric, rows] of byMetric) {
      const cache = this.cache.get(metric);
      cache.push(...rows);
      if (cache.length > 1 && isoTs(cache[cache.length - rows.length - 1]?.ts) > t) cache.sort((a, b) => isoTs(a.ts) - isoTs(b.ts));
      try {
        appendFileSync(this._path(metric), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        written += rows.length;
      } catch (err) {
        console.error('[History] append failed:', err.message);
      }
      this.prune(metric);
    }
    return written;
  }

  // Extract every catalog metric from a synthesized sweep and append it.
  record(sweep, { ts, gz } = {}) {
    const when = isoTs(ts ?? sweep?.meta?.timestamp) ?? this.now();
    return this.append(extractSamples(sweep, { now: when, ...(gz ? { gz } : {}) }), when);
  }

  // One-time import of the MemoryManager archive. Marker file keeps it from re-reading old days;
  // duplicate timestamps are ignored anyway.
  backfill({ force = false } = {}) {
    const marker = join(this.dir, '.backfill.json');
    let done = {};
    if (!force) { try { done = JSON.parse(readFileSync(marker, 'utf8')) || {}; } catch { done = {}; } }
    const coldDir = join(this.runsDir, 'memory', 'cold');
    const files = [];
    if (existsSync(coldDir)) {
      for (const f of readdirSync(coldDir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && !done[f]) files.push(join(coldDir, f));
    }
    const hot = join(this.runsDir, 'memory', 'hot.json');
    let runs = 0, samples = 0;
    const ingestRun = (run) => {
      const when = isoTs(run?.timestamp ?? run?.data?.meta?.timestamp);
      if (when === null || !run?.data) return;
      runs++;
      samples += this.append(extractSamples(run.data, { now: when }), when);
    };
    for (const file of files) {
      try { for (const run of JSON.parse(readFileSync(file, 'utf8')) || []) ingestRun(run); } catch { /* skip unreadable day */ }
      done[file.split(/[\\/]/).pop()] = true;
    }
    if (existsSync(hot)) {
      try { for (const run of JSON.parse(readFileSync(hot, 'utf8'))?.runs || []) ingestRun(run); } catch { /* ignore */ }
    }
    try { writeFileSync(marker, JSON.stringify(done)); } catch { /* non-fatal */ }
    return { files: files.length, runs, samples };
  }

  // ─── queries ───────────────────────────────────────────────────────────────────────────────

  series(metric, dims = {}, { from, to } = {}) {
    if (!METRIC_BY_KEY.has(metric)) return [];
    const key = dimsKey(normalizeDims(dims));
    const f = isoTs(from) ?? -Infinity, t = isoTs(to) ?? Infinity;
    return this._load(metric).filter(r => dimsKey(r.dims) === key).filter(r => { const x = isoTs(r.ts); return x >= f && x <= t; });
  }

  window(metric, dims = {}, hours = 24, now = this.now()) {
    return this.series(metric, dims, { from: now - hours * HOUR, to: now });
  }

  baseline(metric, dims = {}, { window = '30d', bucketHours, buckets, now = this.now(), minBuckets } = {}) {
    const m = METRIC_BY_KEY.get(metric);
    if (!m) return null;
    const bh = Number.isFinite(bucketHours) ? bucketHours : (Number.isFinite(buckets) && buckets > 0 ? (WINDOW_HOURS[window] || 720) / buckets : undefined);
    const rows = this.window(metric, dims, (WINDOW_HOURS[window] || 720) + (bh || 24), now);
    return computeBaseline(rows, { now, window, bucketHours: bh, kind: m.kind, minBuckets });
  }

  // Dimension values that actually occur in the store (feeds the compiler's allow-lists and the UI).
  dimValues(metric, dim, { max = 60 } = {}) {
    if (!METRIC_BY_KEY.has(metric) || !DIM_KEYS.includes(dim)) return [];
    const seen = new Set();
    for (const r of this._load(metric)) if (r.dims[dim]) seen.add(r.dims[dim]);
    return [...seen].sort().slice(0, max);
  }

  stats() {
    const out = {};
    for (const k of METRIC_KEYS) {
      const rows = this._load(k);
      out[k] = { samples: rows.length, first: rows[0]?.ts || null, last: rows[rows.length - 1]?.ts || null };
    }
    return out;
  }
}
