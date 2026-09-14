// Natural-language requirement → structured, deterministic rule.
//
// Two compilers produce a *candidate*; one validator decides what is stored. The LLM path (any
// provider behind lib/llm — Anthropic, OpenAI, ...) gets a JSON-only prompt built from the metric
// catalog and the gazetteer; the fallback path is a keyword / regex parser. Both feed
// validateRule(), which checks every field against the catalog, the Mexican-state gazetteer, the
// country / theater allow-lists, the enumerated windows and numeric bounds. Nothing the validator
// rejects is ever persisted or evaluated.

import { randomBytes } from 'crypto';
import { fold, loadGazetteer } from '../narco/gazetteer.mjs';
import { SEVERITIES } from '../situation.mjs';
import { parseJSON } from '../narco/llm.mjs';
import { catalog as metricCatalog, METRIC_BY_KEY, DIM_KEYS } from './metrics.mjs';
import { WINDOWS as BASELINE_WINDOWS, WINDOW_HOURS } from './history.mjs';

export const OBS_WINDOWS = ['overnight', '24h', '7d', '30d'];
export const OBS_HOURS = { overnight: 12, '24h': 24, '7d': 168, '30d': 720 };
export { BASELINE_WINDOWS };
export const COMPARISONS = ['z', 'pct', 'abs'];
export const DIRECTIONS = ['up', 'down', 'either'];
export const THRESHOLD_BOUNDS = { z: [0.5, 10], pct: [5, 1000], abs: [0, 10_000_000] };
export const MAX_TEXT = 500;
export const MAX_NAME = 80;
export const MAX_DIM_VALUES_PER_KEY = 4;
export const ID_RE = /^req_[a-z0-9]{10,16}$/;
const NAME_RE = /^[\p{L}\p{N} .,:;'’"/()+\-–—·&%#]{1,80}$/u;
const OWNER_RE = /^[\p{L}\p{N} ._@\-]{1,60}$/u;
const DIM_VALUE_RE = /^[\p{L}\p{N} .'’/&\-–()]{2,60}$/u;

// Countries the ACLED feed and the rest of the sweep can name. Anything else must already occur in
// the history store for that metric (observed dimension values are allow-listed dynamically).
export const COUNTRIES = [
  'Ukraine', 'Russia', 'Belarus', 'Moldova', 'Poland', 'Lithuania', 'Latvia', 'Estonia', 'Finland', 'Georgia', 'Armenia', 'Azerbaijan',
  'Israel', 'Palestine', 'Lebanon', 'Syria', 'Iraq', 'Iran', 'Yemen', 'Saudi Arabia', 'Jordan', 'Egypt', 'Libya', 'Turkey',
  'Sudan', 'South Sudan', 'Ethiopia', 'Somalia', 'Eritrea', 'Kenya', 'Nigeria', 'Niger', 'Mali', 'Burkina Faso', 'Chad', 'Cameroon',
  'Democratic Republic of Congo', 'Mozambique', 'Central African Republic',
  'Afghanistan', 'Pakistan', 'India', 'Myanmar', 'Bangladesh', 'Sri Lanka', 'Philippines', 'Indonesia', 'Thailand',
  'China', 'Taiwan', 'North Korea', 'South Korea', 'Japan',
  'Mexico', 'United States', 'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua', 'Colombia', 'Venezuela', 'Ecuador', 'Peru', 'Brazil', 'Haiti',
];
// Theater / region labels used by the FIRMS, OpenSky, GDELT and ACLED feeds; matched by folded key.
export const THEATERS = [
  'Ukraine', 'Ukraine Region', 'Ukraine/Black Sea', 'Middle East', 'Iran', 'Persian Gulf', 'Taiwan Strait', 'Baltic Region', 'South China Sea', 'Korean Peninsula', 'Arctic/Barents Sea',
  'Caribbean', 'Gulf of Guinea', 'Cape Route', 'Horn of Africa', 'Sudan / Horn of Africa', 'Myanmar', 'South Asia',
  'Europe', 'Africa', 'Asia', 'Asia-Pacific', 'Latin America', 'Latin America & the Caribbean', 'North America', 'Caucasus and Central Asia',
  'Eastern Europe', 'Western Africa', 'Eastern Africa', 'Middle Africa', 'Northern Africa', 'Southern Africa', 'South Asia', 'Southeast Asia', 'East Asia', 'Oceania',
];

const HOUR = 3_600_000;
export const newRuleId = () => `req_${randomBytes(8).toString('hex').slice(0, 12)}`;
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Analyst shorthand → canonical theater label used by the feeds.
const THEATER_ALIASES = {
  'baltic': 'Baltic Region', 'baltics': 'Baltic Region', 'baltic sea': 'Baltic Region', 'black sea': 'Ukraine/Black Sea',
  'gulf': 'Persian Gulf', 'arabian gulf': 'Persian Gulf', 'taiwan': 'Taiwan Strait', 'scs': 'South China Sea', 'korea': 'Korean Peninsula',
  'arctic': 'Arctic/Barents Sea', 'barents': 'Arctic/Barents Sea', 'barents sea': 'Arctic/Barents Sea', 'mideast': 'Middle East',
};
function lookup(list, v) {
  const k = fold(v);
  if (!k) return null;
  return list.find(x => fold(x) === k) || (list === THEATERS && THEATER_ALIASES[k]) || null;
}

// ─── validation ─────────────────────────────────────────────────────────────────────────────────

// ctx.dimValues(metric, dim) → observed values (from the history store); optional.
export function validateRule(cand, ctx = {}) {
  const gz = ctx.gz || loadGazetteer();
  const errors = [];
  const c = cand && typeof cand === 'object' ? cand : {};
  const fail = (field, reason) => { errors.push({ field, reason }); };

  const text = clean(c.text, MAX_TEXT + 1);
  if (!text) fail('text', 'required'); else if (text.length > MAX_TEXT) fail('text', 'max');

  const metric = typeof c.metric === 'string' ? c.metric.trim() : '';
  const m = METRIC_BY_KEY.get(metric);
  if (!m) fail('metric', 'unknown');

  const dims = {};
  const rawDims = c.dims && typeof c.dims === 'object' && !Array.isArray(c.dims) ? c.dims : {};
  for (const key of Object.keys(rawDims)) {
    if (!DIM_KEYS.includes(key)) { fail(`dims.${key}`, 'unknown'); continue; }
    if (rawDims[key] === null || rawDims[key] === undefined || rawDims[key] === '') continue;
    if (m && !m.dims.includes(key)) { fail(`dims.${key}`, 'not_supported_by_metric'); continue; }
    const values = Array.isArray(rawDims[key]) ? rawDims[key] : [rawDims[key]];
    if (values.length > MAX_DIM_VALUES_PER_KEY) { fail(`dims.${key}`, 'max'); continue; }
    const out = [];
    for (const v of values) {
      if (typeof v !== 'string' || !DIM_VALUE_RE.test(v.trim())) { fail(`dims.${key}`, 'pattern'); continue; }
      const observed = typeof ctx.dimValues === 'function' && m ? (ctx.dimValues(m.key, key) || []) : [];
      let canon = null;
      if (key === 'state') canon = gz.stateKey.get(fold(v))?.shortName || null;
      else if (key === 'country') canon = lookup(COUNTRIES, v) || lookup(observed, v);
      else if (key === 'theater') canon = lookup(THEATERS, v) || lookup(observed, v);
      if (!canon) { fail(`dims.${key}`, 'not_in_gazetteer'); continue; }
      if (!out.includes(canon)) out.push(canon);
    }
    if (out.length) dims[key] = out.length === 1 ? out[0] : out;
  }

  const window = typeof c.window === 'string' && OBS_WINDOWS.includes(c.window) ? c.window : (fail('window', 'enum'), null);
  const baseline = typeof c.baseline === 'string' && BASELINE_WINDOWS.includes(c.baseline) ? c.baseline : (fail('baseline', 'enum'), null);
  if (window && baseline && WINDOW_HOURS[baseline] < 2 * OBS_HOURS[window]) fail('baseline', 'shorter_than_window');

  const comparison = typeof c.comparison === 'string' && COMPARISONS.includes(c.comparison) ? c.comparison : (fail('comparison', 'enum'), null);
  let threshold = null;
  if (comparison) {
    const n = typeof c.threshold === 'number' ? c.threshold : (typeof c.threshold === 'string' && /^-?\d{1,9}(\.\d{1,4})?$/.test(c.threshold.trim()) ? Number(c.threshold) : NaN);
    const [lo, hi] = THRESHOLD_BOUNDS[comparison];
    if (!Number.isFinite(n) || n < lo || n > hi) fail('threshold', 'range'); else threshold = n;
  }
  if (m && m.kind === 'level' && comparison === 'pct') fail('comparison', 'pct_not_meaningful_for_level_metric');

  const direction = typeof c.direction === 'string' && DIRECTIONS.includes(c.direction) ? c.direction : (fail('direction', 'enum'), null);
  const severity = typeof c.severity === 'string' && SEVERITIES.includes(c.severity) ? c.severity : (fail('severity', 'enum'), null);

  const name = clean(c.name, MAX_NAME + 1);
  if (!name || !NAME_RE.test(name)) fail('name', 'pattern');
  const owner = clean(c.owner || 'analyst', 61);
  if (!OWNER_RE.test(owner)) fail('owner', 'pattern');

  const id = typeof c.id === 'string' && ID_RE.test(c.id) ? c.id : (c.id === undefined || c.id === null ? newRuleId() : (fail('id', 'pattern'), null));
  const createdAt = Number.isFinite(Date.parse(c.createdAt)) ? new Date(Date.parse(c.createdAt)).toISOString() : new Date().toISOString();
  const enabled = c.enabled === undefined ? true : c.enabled === true || c.enabled === 'true';
  const compiledBy = c.compiledBy === 'llm' || c.compiledBy === 'rules' || c.compiledBy === 'seed' ? c.compiledBy : 'rules';

  if (errors.length) return { ok: false, errors, rule: null };
  return {
    ok: true, errors: [],
    rule: { id, name, text, metric, dims, window, baseline, comparison, threshold, direction, severity, owner, createdAt, enabled, compiledBy },
  };
}

// ─── deterministic fallback parser ──────────────────────────────────────────────────────────────

const METRIC_PATTERNS = [
  ['border_violence_events', /\b(violence|violent|homicide|homicides|murder|murders|shooting|shootings|shootout|shootouts|killing|killings|massacre|cartel|cartels|narco|kidnapping|kidnappings|sicario|gunmen|bodies)\b/],
  ['conflict_fatalities', /\b(fatalities|fatality|deaths|death toll|casualties|killed)\b/],
  ['kev_additions', /\b(kev|known exploited|exploited vulnerabilit(y|ies)|cisa|cve|cves|vulnerabilit(y|ies))\b/],
  ['urgent_posts', /\b(urgent|telegram|osint posts?|channels?)\b/],
  ['thermal_total', /\b(thermal|fires?|firms|hotspots?|burn(ing)?)\b/],
  ['air_total', /\b(air activity|aircraft|air traffic|flights?|sorties|ads ?b|opensky|military aircraft)\b/],
  ['gdelt_tone', /\b(tone|sentiment|gdelt|media mood|coverage tone)\b/],
  ['seismic_events', /\b(seismic|earthquakes?|tremors?|usgs)\b/],
  ['who_alerts', /\b(who alerts?|outbreaks?|disease|epidemic|pandemic|health alerts?)\b/],
  ['iranwar_events_48h', /\b(iran|iranian|irgc|persian gulf|hormuz)\b/],
  ['border_spikes', /\b(border watch|place spikes?|border spikes?)\b/],
  ['border_news_articles', /\b(border (news|articles?|reporting|coverage)|articles?)\b/],
  ['conflict_events', /\b(conflict|conflicts|battles?|clashes|attacks?|strikes?|acled|fighting|explosions?|combat|events?)\b/],
];

const WINDOW_TERMS = [
  ['overnight', /\b(overnight|over night|tonight|last night|since last night|last 12 ?h(ours)?|past 12 ?h(ours)?|12h)\b/],
  ['7d', /\b(this week|past 7 ?d(ays)?|last 7 ?d(ays)?|past week|last week|weekly|7d)\b/],
  ['30d', /\b(this month|past 30 ?d(ays)?|last 30 ?d(ays)?|past month|last month|monthly|30d)\b/],
  ['24h', /\b(today|daily|last 24 ?h(ours)?|past 24 ?h(ours)?|24h|past day|last day|yesterday)\b/],
];
const BASELINE_TERMS = [
  ['90d', /\b(quarter|quarterly|90 ?d(ays)?|three months|3 months|trailing quarter|90d)\b/],
  ['30d', /\b(month|monthly|30 ?d(ays)?|trailing month|four weeks|4 weeks|30d)\b/],
  ['7d', /\b(week|weekly|7 ?d(ays)?|seven days|7d)\b/],
  ['24h', /\b(day|daily|24 ?h(ours)?|24h|yesterday)\b/],
];
// "... vs / against / compared to / relative to <baseline phrase>"
const BASELINE_SPLIT_RE = /\b(?:vs\.?|versus|against|compared (?:to|with)|relative to|baseline(?: of)?|normal for the)\b/i;

function detectMetric(t) {
  for (const [key, re] of METRIC_PATTERNS) if (re.test(t)) return key;
  return null;
}
function detectStates(t, gz) {
  const out = [];
  gz.stateRe.lastIndex = 0;
  let m;
  while ((m = gz.stateRe.exec(t)) !== null) {
    const s = gz.stateKey.get(m[1])?.shortName;
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_DIM_VALUES_PER_KEY);
}
// Longest label wins and its span is masked so "Ukraine Region" does not also yield "Ukraine".
function detectFromList(t, list) {
  const out = [];
  let hay = t;
  for (const name of [...new Set(list)].sort((a, b) => b.length - a.length)) {
    const k = fold(name);
    if (!k) continue;
    const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(hay) && !out.includes(name)) { out.push(name); hay = hay.replace(re, ' '.repeat(k.length)); }
  }
  return out.slice(0, MAX_DIM_VALUES_PER_KEY);
}
function detectWindow(observationText) {
  for (const [w, re] of WINDOW_TERMS) if (re.test(observationText)) return w;
  return null;
}
function detectBaseline(baselineText) {
  for (const [w, re] of BASELINE_TERMS) if (re.test(baselineText)) return w;
  return null;
}
function detectComparison(t) {
  let m;
  if ((m = /\b(?:z|z[- ]?score|sigma|std|standard deviations?)\s*(?:>|>=|above|over|of|at|=)?\s*(\d+(?:\.\d+)?)/.exec(t)) || (m = /(\d+(?:\.\d+)?)\s*(?:sigma|std|standard deviations?|z)\b/.exec(t))) return { comparison: 'z', threshold: Number(m[1]) };
  if ((m = /(\d+(?:\.\d+)?)\s*(?:%|\b(?:percent|pct)\b)/.exec(t))) return { comparison: 'pct', threshold: Number(m[1]) };
  if ((m = /\b(?:more than|over|above|at least|exceeds?|exceeding|greater than|>|>=|below|under|fewer than|less than|<)\s*(\d+(?:\.\d+)?)\b/.exec(t))) return { comparison: 'abs', threshold: Number(m[1]) };
  if ((m = /\b(\d+(?:\.\d+)?)\s*(?:x|times)\b/.exec(t))) return { comparison: 'pct', threshold: Math.max(5, (Number(m[1]) - 1) * 100) };
  return null;
}
function detectDirection(t) {
  const down = /\b(drop\w*|declin\w*|fall\w*|fell|decreas\w*|lull|quiet|go(es|ing)? dark|silence|below|under|fewer|less|lower|plunge\w*|collapse\w*)\b/.test(t);
  const up = /\b(spik\w*|surg\w*|increas\w*|ris(e|es|ing|en)|rose|jump\w*|uptick|escalat\w*|above|more than|exceed\w*|higher|flare|flare-?up|climb\w*)\b/.test(t);
  if (/\b(either|any change|any deviation|anomal\w*|unusual|abnormal|shift|change|deviat\w*)\b/.test(t) && !(up ^ down)) return 'either';
  if (down && !up) return 'down';
  if (up && down) return 'either';
  return 'up';
}
function detectSeverity(t) {
  if (/\b(critical|flash|immediate)\b/.test(t)) return 'critical';
  if (/\b(high priority|high|priority|important)\b/.test(t)) return 'high';
  if (/\b(info|informational|low|fyi|watch only)\b/.test(t)) return 'info';
  return 'elevated';
}

export function compileWithRules(text, ctx = {}) {
  const gz = ctx.gz || loadGazetteer();
  const raw = clean(text, MAX_TEXT);
  const t = fold(raw);
  const low = raw.toLowerCase();
  const metric = detectMetric(t);
  if (!metric) return { candidate: null, compiledBy: 'rules', errors: [{ field: 'metric', reason: 'unrecognized' }] };
  const m = METRIC_BY_KEY.get(metric);

  const dims = {};
  if (m.dims.includes('state')) { const st = detectStates(t, gz); if (st.length) dims.state = st.length === 1 ? st[0] : st; }
  if (m.dims.includes('country')) { const c = detectFromList(t, COUNTRIES); if (c.length) dims.country = c.length === 1 ? c[0] : c; }
  if (m.dims.includes('theater') && !dims.country) {
    const th = detectFromList(t, THEATERS);
    for (const alias of detectFromList(t, Object.keys(THEATER_ALIASES))) { const c = THEATER_ALIASES[alias]; if (!th.includes(c)) th.push(c); }
    if (th.length) dims.theater = th.length === 1 ? th[0] : th.slice(0, MAX_DIM_VALUES_PER_KEY);
  }

  const split = BASELINE_SPLIT_RE.exec(raw);
  const obsText = fold(split ? raw.slice(0, split.index) : raw);
  const baseText = fold(split ? raw.slice(split.index + split[0].length) : '');
  const window = detectWindow(obsText) || (split ? null : detectWindow(t)) || '24h';
  let baseline = detectBaseline(baseText) || (window === '7d' || window === '30d' ? '90d' : '30d');
  if (WINDOW_HOURS[baseline] < 2 * OBS_HOURS[window]) baseline = BASELINE_WINDOWS.find(b => WINDOW_HOURS[b] >= 2 * OBS_HOURS[window]) || '90d';

  const cmp = detectComparison(low) || { comparison: 'z', threshold: 2 };
  const direction = detectDirection(t);
  const severity = ctx.severity || detectSeverity(t);
  const dimLabel = Object.values(dims).flat().join(' / ');
  const name = ctx.name || clean(`${m.label}${dimLabel ? ` · ${dimLabel}` : ''} · ${window} vs ${baseline}`, MAX_NAME);

  return {
    candidate: { name, text: raw, metric, dims, window, baseline, comparison: cmp.comparison, threshold: cmp.threshold, direction, severity, owner: ctx.owner || 'analyst', compiledBy: 'rules' },
    compiledBy: 'rules', errors: [],
  };
}

// ─── LLM path ───────────────────────────────────────────────────────────────────────────────────

export function buildPrompt(ctx = {}) {
  const gz = ctx.gz || loadGazetteer();
  const cat = metricCatalog();
  const states = gz.states.map(s => s.shortName);
  const system = `You compile an analyst's standing intelligence requirement into ONE JSON rule for a monitoring system. Return ONLY a JSON object, no prose.
Schema:
{"name": short title (<= ${MAX_NAME} chars),
 "metric": one of [${cat.map(c => c.key).join(', ')}],
 "dims": {"state"?: Mexican state name or array (<= ${MAX_DIM_VALUES_PER_KEY}) from [${states.join(', ')}],
          "country"?: country name or array from [${COUNTRIES.join(', ')}],
          "theater"?: region label or array from [${THEATERS.join(', ')}]},
 "window": observation window, one of [${OBS_WINDOWS.join(', ')}] (overnight = last 12 hours),
 "baseline": comparison lookback, one of [${BASELINE_WINDOWS.join(', ')}] (must be at least twice the window),
 "comparison": "z" (standard deviations from the baseline mean), "pct" (percent change vs baseline mean) or "abs" (absolute value),
 "threshold": number (z: ${THRESHOLD_BOUNDS.z.join('..')}, pct: ${THRESHOLD_BOUNDS.pct.join('..')}, abs: >= 0),
 "direction": one of [${DIRECTIONS.join(', ')}],
 "severity": one of [${SEVERITIES.join(', ')}]}
Metric catalog (key: what it measures; supported dims):
${cat.map(c => `- ${c.key}: ${c.describe}; dims [${c.dims.join(', ') || 'none'}]`).join('\n')}
Only use dims the metric supports. Do not invent metrics, places or fields. If the requirement gives no threshold, use comparison "z" with threshold 2. If it gives no baseline, use "30d".`;
  return system;
}

export async function compileWithLLM(provider, text, ctx = {}) {
  if (!provider || !provider.isConfigured || typeof provider.complete !== 'function') return null;
  const raw = clean(text, MAX_TEXT);
  const res = await provider.complete(buildPrompt(ctx), `Requirement: ${raw}`, { maxTokens: 400, temperature: 0 });
  const obj = parseJSON(res?.text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { candidate: null, compiledBy: 'llm', error: 'unparseable' };
  const candidate = {
    name: ctx.name || obj.name, text: raw, metric: obj.metric, dims: obj.dims, window: obj.window, baseline: obj.baseline,
    comparison: obj.comparison, threshold: obj.threshold, direction: obj.direction, severity: ctx.severity || obj.severity,
    owner: ctx.owner || 'analyst', compiledBy: 'llm',
  };
  return { candidate, compiledBy: 'llm' };
}

// Full pipeline: LLM when configured → validate; otherwise (or on any LLM failure / rejection) the
// rule-based parser → validate. Returns {ok, rule, compiledBy, errors, fallbackReason}.
export async function compileRequirement(text, { provider = null, name, severity, owner, gz, dimValues, log = console } = {}) {
  const ctx = { gz: gz || loadGazetteer(), name, severity, owner, dimValues };
  let fallbackReason = null;
  if (provider && provider.isConfigured) {
    try {
      const llm = await compileWithLLM(provider, text, ctx);
      if (llm?.candidate) {
        const v = validateRule(llm.candidate, ctx);
        if (v.ok) return { ok: true, rule: v.rule, compiledBy: 'llm', errors: [], fallbackReason: null };
        fallbackReason = `llm_rejected:${v.errors.map(e => e.field).join(',')}`;
      } else {
        fallbackReason = `llm_${llm?.error || 'empty'}`;
      }
    } catch (err) {
      fallbackReason = 'llm_error';
      log.error?.('[Requirements] LLM compile failed:', err?.message || err);
    }
  } else {
    fallbackReason = 'llm_not_configured';
  }
  const rules = compileWithRules(text, ctx);
  if (!rules.candidate) return { ok: false, rule: null, compiledBy: 'rules', errors: rules.errors, fallbackReason };
  const v = validateRule(rules.candidate, ctx);
  return { ok: v.ok, rule: v.rule, compiledBy: 'rules', errors: v.errors, fallbackReason };
}

// Windows in hours for the evaluator / UI.
export function ruleWindows(rule) {
  return { observationHours: OBS_HOURS[rule.window] || 24, baselineHours: WINDOW_HOURS[rule.baseline] || 720 };
}
export const hoursMs = (h) => h * HOUR;
