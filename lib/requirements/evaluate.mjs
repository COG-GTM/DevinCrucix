// Rule store + evaluator for standing requirements.
//
// runs/requirements/rules.json      — the validated rules (seeded on first run)
// runs/requirements/latest.json     — last evaluation per rule (observed / baseline / evidence), rewritten every sweep
// runs/requirements/findings.jsonl  — one line per *new* firing (bounded); this is the historical-hits log
//
// A rule that stays above threshold for several consecutive 45-minute sweeps is one firing, not one
// per sweep: a new findings line (and a fresh "fired" event) is only written when the rule was not
// already fired inside its own observation window. The Situation headline, being a picture of the
// current state, is emitted every sweep while the rule is fired.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadGazetteer } from '../narco/gazetteer.mjs';
import { SEVERITIES } from '../situation.mjs';
import { METRIC_BY_KEY, extractEvidence } from './metrics.mjs';
import { validateRule, ruleWindows, newRuleId, OBS_HOURS } from './compile.mjs';

export const MAX_FINDINGS = 5000;
export const MAX_HISTORICAL_HITS = 10;
export const MAX_EVIDENCE = 12;
export const FINDINGS_RETENTION_DAYS = 400;
const HOUR = 3_600_000;
const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

const round = (v, p = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : null);
const fmt = (v) => (v === null || v === undefined ? '—' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(round(v, 1)));

export const SEED_REQUIREMENTS = [
  {
    name: 'Border violence · Tamaulipas / Nuevo León · overnight vs 30d',
    text: 'Flag overnight spikes in violence in Tamaulipas / Nuevo León vs the trailing month',
    metric: 'border_violence_events', dims: { state: ['Tamaulipas', 'Nuevo León'] },
    window: 'overnight', baseline: '30d', comparison: 'z', threshold: 2, direction: 'up', severity: 'high', owner: 'seed',
  },
  {
    name: 'ACLED fatalities · Ukraine · 24h vs 7d',
    text: 'Flag ACLED fatalities in Ukraine over the last 24 hours that exceed 2 standard deviations vs the trailing week',
    metric: 'conflict_fatalities', dims: { country: 'Ukraine' },
    window: '24h', baseline: '7d', comparison: 'z', threshold: 2, direction: 'up', severity: 'elevated', owner: 'seed',
  },
  {
    name: 'CISA KEV additions · 24h vs 30d',
    text: 'Flag a spike in CISA Known Exploited Vulnerabilities added in the last 24 hours vs the trailing 30 days',
    metric: 'kev_additions', dims: {},
    window: '24h', baseline: '30d', comparison: 'z', threshold: 2, direction: 'up', severity: 'elevated', owner: 'seed',
  },
];

// ─── pure evaluation ────────────────────────────────────────────────────────────────────────────

// Multi-valued dims ("Tamaulipas / Nuevo León") are summed per timestamp for count metrics and
// averaged for level metrics before the baseline is computed.
export function seriesForRule(history, rule, { now = Date.now() } = {}) {
  const m = METRIC_BY_KEY.get(rule.metric);
  const { baselineHours, observationHours } = ruleWindows(rule);
  const hours = baselineHours + observationHours;
  const combos = dimCombos(rule.dims);
  if (combos.length === 1) return history.window(rule.metric, combos[0], hours, now);
  const byTs = new Map();
  for (const dims of combos) {
    for (const s of history.window(rule.metric, dims, hours, now)) {
      const cur = byTs.get(s.ts) || { sum: 0, n: 0 };
      cur.sum += s.value; cur.n += 1;
      byTs.set(s.ts, cur);
    }
  }
  return [...byTs.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
    .map(([ts, { sum, n }]) => ({ ts, dims: rule.dims, value: m?.kind === 'level' ? sum / n : sum }));
}

export function dimCombos(dims) {
  const keys = Object.keys(dims || {}).filter(k => dims[k] !== undefined && dims[k] !== null && dims[k] !== '');
  let combos = [{}];
  for (const k of keys) {
    const values = Array.isArray(dims[k]) ? dims[k] : [dims[k]];
    combos = combos.flatMap(c => values.map(v => ({ ...c, [k]: v })));
  }
  return combos;
}

export function decideFired(rule, b) {
  if (!b || b.observed === null || b.sparse) return false;
  let metricValue;
  if (rule.comparison === 'z') metricValue = b.z;
  else if (rule.comparison === 'pct') metricValue = b.pctChange;
  else metricValue = b.observed;
  if (!Number.isFinite(metricValue)) return false;
  if (rule.comparison === 'abs') {
    if (rule.direction === 'down') return metricValue <= rule.threshold;
    if (rule.direction === 'either') return metricValue >= rule.threshold;
    return metricValue >= rule.threshold;
  }
  if (rule.direction === 'up') return metricValue >= rule.threshold;
  if (rule.direction === 'down') return metricValue <= -rule.threshold;
  return Math.abs(metricValue) >= rule.threshold;
}

export function evaluateRule(rule, { history, sweep, now = Date.now(), computeBaseline, gz }) {
  const m = METRIC_BY_KEY.get(rule.metric);
  const { observationHours } = ruleWindows(rule);
  const samples = seriesForRule(history, rule, { now });
  const b = computeBaseline(samples, { now, window: rule.baseline, bucketHours: observationHours, kind: m?.kind || 'count' });
  const fired = decideFired(rule, b);
  const evidence = fired || (b.observed !== null && b.observed > 0)
    ? mergeEvidence(rule, sweep, { now, gz })
    : [];
  return {
    ruleId: rule.id, evaluatedAt: new Date(now).toISOString(), fired,
    observed: b.observed, baselineMean: b.baselineMean, baselineStd: b.baselineStd, z: b.z, pctChange: b.pctChange,
    n: b.n, sparse: b.sparse, bucketHours: b.bucketHours, window: rule.window, baseline: rule.baseline,
    comparison: rule.comparison, threshold: rule.threshold, direction: rule.direction, severity: rule.severity,
    unit: m?.unit || '', series: b.series, evidence,
  };
}

function mergeEvidence(rule, sweep, ctx) {
  const rows = [];
  const seen = new Set();
  for (const dims of dimCombos(rule.dims)) {
    for (const r of extractEvidence(rule.metric, sweep, dims, { ...ctx, max: MAX_EVIDENCE })) {
      const k = r.url || r.title;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
      if (rows.length >= MAX_EVIDENCE) return rows;
    }
  }
  return rows;
}

export function headlineFor(rule, ev) {
  const dimText = Object.values(rule.dims || {}).flat().join(' / ');
  const dev = rule.comparison === 'pct' || (ev.pctChange !== null && rule.comparison === 'abs')
    ? `${ev.pctChange > 0 ? '+' : ''}${fmt(ev.pctChange)}% vs ${rule.baseline} baseline`
    : `z ${ev.z > 0 ? '+' : ''}${fmt(ev.z)} vs ${rule.baseline} baseline`;
  const m = METRIC_BY_KEY.get(rule.metric);
  return {
    rule: 'requirement', severity: SEVERITIES.includes(rule.severity) ? rule.severity : 'elevated',
    title: `Requirement fired: ${rule.name}`.slice(0, 140),
    why: `${m?.label || rule.metric}${dimText ? ` · ${dimText}` : ''}: ${fmt(ev.observed)} ${m?.unit || ''} in the last ${rule.window} vs mean ${fmt(ev.baselineMean)} (${dev}, n=${ev.n})`.slice(0, 220),
    source: 'Requirements', tab: 'requirements', panel: rule.id,
  };
}

// ─── store ──────────────────────────────────────────────────────────────────────────────────────

export class RequirementsStore {
  constructor(runsDir, { now = () => Date.now(), log = console } = {}) {
    this.dir = join(runsDir, 'requirements');
    this.rulesPath = join(this.dir, 'rules.json');
    this.latestPath = join(this.dir, 'latest.json');
    this.findingsPath = join(this.dir, 'findings.jsonl');
    this.now = now;
    this.log = log;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.rules = this._loadRules();
    this.latest = this._loadJson(this.latestPath, {});
    this.findings = this._loadFindings();
    this.seeded = false;
    if (!existsSync(this.rulesPath)) { this.seed(); this.seeded = true; }
  }

  _loadJson(p, dflt) {
    try { return JSON.parse(readFileSync(p, 'utf8')) ?? dflt; } catch { return dflt; }
  }
  _writeJson(p, value) {
    const tmp = p + '.tmp';
    try { writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, p); }
    catch (err) { this.log.error?.('[Requirements] write failed:', err.message); try { unlinkSync(tmp); } catch { /* ignore */ } }
  }
  _loadRules() {
    const raw = this._loadJson(this.rulesPath, { rules: [] });
    const out = [];
    for (const r of Array.isArray(raw?.rules) ? raw.rules : []) {
      const v = validateRule(r);
      if (v.ok) out.push(v.rule);
      else this.log.warn?.('[Requirements] dropped invalid stored rule', r?.id, v.errors.map(e => `${e.field}:${e.reason}`).join(','));
    }
    return out;
  }
  _loadFindings() {
    const rows = [];
    if (!existsSync(this.findingsPath)) return rows;
    for (const line of readFileSync(this.findingsPath, 'utf8').split('\n')) {
      if (!line) continue;
      try { const f = JSON.parse(line); if (f && typeof f.ruleId === 'string' && typeof f.firedAt === 'string') rows.push(f); } catch { /* skip */ }
    }
    return rows;
  }
  _saveRules() { this._writeJson(this.rulesPath, { rules: this.rules, savedAt: new Date(this.now()).toISOString() }); }

  seed() {
    const createdAt = new Date(this.now()).toISOString();
    for (const s of SEED_REQUIREMENTS) {
      const v = validateRule({ ...s, id: newRuleId(), createdAt, enabled: true, compiledBy: 'seed' });
      if (v.ok) this.rules.push(v.rule);
    }
    this._saveRules();
    return this.rules.length;
  }

  list() { return this.rules.map(r => ({ ...r })); }
  get(id) { return this.rules.find(r => r.id === id) || null; }

  // Only a validator-approved rule is ever stored.
  add(candidate) {
    const v = validateRule({ ...candidate, id: undefined, createdAt: new Date(this.now()).toISOString() });
    if (!v.ok) return { ok: false, errors: v.errors, rule: null };
    if (this.rules.length >= 200) return { ok: false, errors: [{ field: 'rules', reason: 'max' }], rule: null };
    this.rules.push(v.rule);
    this._saveRules();
    return { ok: true, errors: [], rule: v.rule };
  }
  setEnabled(id, enabled) {
    const r = this.get(id);
    if (!r) return null;
    r.enabled = !!enabled;
    this._saveRules();
    return r;
  }
  remove(id) {
    const i = this.rules.findIndex(r => r.id === id);
    if (i < 0) return false;
    this.rules.splice(i, 1);
    delete this.latest[id];
    this._saveRules();
    this._writeJson(this.latestPath, this.latest);
    return true;
  }

  latestFor(id) { return this.latest[id] || null; }
  findingsFor(id, limit = 20) {
    return this.findings.filter(f => f.ruleId === id).slice(-Math.max(1, Math.min(limit, 500))).reverse();
  }
  historicalHits(id, before, max = MAX_HISTORICAL_HITS) {
    return this.findings.filter(f => f.ruleId === id && (!before || f.firedAt < before)).slice(-max).reverse()
      .map(f => ({ firedAt: f.firedAt, observed: f.observed, baselineMean: f.baselineMean, z: f.z, pctChange: f.pctChange, severity: f.severity }));
  }
  firedRules() {
    return this.rules.filter(r => r.enabled && this.latest[r.id]?.fired);
  }

  _appendFinding(f) {
    this.findings.push(f);
    try { appendFileSync(this.findingsPath, JSON.stringify(f) + '\n'); } catch (err) { this.log.error?.('[Requirements] findings append failed:', err.message); }
    const cutoff = new Date(this.now() - FINDINGS_RETENTION_DAYS * 24 * HOUR).toISOString();
    if (this.findings.length > MAX_FINDINGS || (this.findings.length && this.findings[0].firedAt < cutoff)) {
      this.findings = this.findings.filter(x => x.firedAt >= cutoff).slice(-MAX_FINDINGS);
      const tmp = this.findingsPath + '.tmp';
      try { writeFileSync(tmp, this.findings.map(x => JSON.stringify(x)).join('\n') + (this.findings.length ? '\n' : '')); renameSync(tmp, this.findingsPath); }
      catch (err) { this.log.error?.('[Requirements] findings rewrite failed:', err.message); try { unlinkSync(tmp); } catch { /* ignore */ } }
    }
  }

  // Evaluate every enabled rule against the history store and the current sweep. Returns
  // {results, headlines, newFirings}. When `sweep.situation` exists the fired headlines are merged
  // into it (severity order, MAX kept by the caller's cap).
  evaluateAll({ history, sweep, computeBaseline, now = this.now(), gz = loadGazetteer() }) {
    const results = [];
    const headlines = [];
    const newFirings = [];
    for (const rule of this.rules) {
      if (!rule.enabled) { if (this.latest[rule.id]) this.latest[rule.id].fired = false; continue; }
      let ev;
      try { ev = evaluateRule(rule, { history, sweep, now, computeBaseline, gz }); }
      catch (err) { this.log.error?.('[Requirements] evaluate failed for', rule.id, err.message); continue; }
      const prev = this.latest[rule.id];
      const obsMs = (OBS_HOURS[rule.window] || 24) * HOUR;
      const lastFiredAt = prev?.lastFiredAt || null;
      let firedAt = null;
      if (ev.fired) {
        const stillSameEpisode = lastFiredAt && (now - Date.parse(lastFiredAt)) < obsMs && prev?.fired;
        firedAt = stillSameEpisode ? lastFiredAt : ev.evaluatedAt;
        if (!stillSameEpisode) {
          const finding = {
            ruleId: rule.id, firedAt, observed: ev.observed, baselineMean: ev.baselineMean, baselineStd: ev.baselineStd, z: ev.z,
            pctChange: ev.pctChange, n: ev.n, severity: rule.severity, window: rule.window, baseline: rule.baseline,
            comparison: rule.comparison, threshold: rule.threshold, direction: rule.direction,
            evidence: ev.evidence.slice(0, MAX_EVIDENCE), historicalHits: this.historicalHits(rule.id, ev.evaluatedAt),
          };
          this._appendFinding(finding);
          newFirings.push(finding);
        }
        headlines.push(headlineFor(rule, ev));
      }
      this.latest[rule.id] = { ...ev, lastFiredAt: ev.fired ? firedAt : lastFiredAt, firedAt: ev.fired ? firedAt : null, historicalHits: this.historicalHits(rule.id, ev.fired ? firedAt : null) };
      results.push(this.latest[rule.id]);
    }
    this._writeJson(this.latestPath, this.latest);
    if (sweep && sweep.situation && Array.isArray(sweep.situation.headlines)) mergeHeadlines(sweep.situation, headlines);
    return { results, headlines, newFirings, firedCount: headlines.length };
  }

  snapshot() {
    return {
      rules: this.rules.map(r => ({ ...r, latest: this.latest[r.id] || null })),
      firedCount: this.firedRules().length,
      seeded: this.seeded,
    };
  }
}

// Fired requirements outrank the rule-based headlines of equal severity (an analyst asked for them),
// the quiet/baseline placeholder is dropped when something fires, and the strip keeps its cap.
export function mergeHeadlines(situation, headlines, max = 5) {
  if (!headlines.length) return situation;
  const existing = situation.headlines.filter(h => !(h.rule === 'requirement') && h.rule !== 'baseline');
  const merged = [...headlines, ...existing].sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
  situation.headlines = merged.slice(0, Math.max(max, headlines.length));
  situation.quiet = !situation.headlines.some(h => h.severity !== 'info');
  situation.rulesFired = (situation.rulesFired || 0) + headlines.length;
  situation.counts = situation.counts || {};
  for (const h of headlines) situation.counts[h.severity] = (situation.counts[h.severity] || 0) + 1;
  situation.requirementsFired = headlines.length;
  return situation;
}
