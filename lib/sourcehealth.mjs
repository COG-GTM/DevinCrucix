// Source health — classifies every sweep source into an honest operational state so the
// dashboard can distinguish "quiet" from "not reporting".
//
//   live      returned usable data this sweep
//   degraded  returned data but with a fallback, partial coverage, or an empty payload
//   no_key    disabled until an API key / credential is configured
//   off       source explicitly offline / disabled / unavailable
//   error     failed or timed out this sweep (no data)
//
// Composite sources (CII, Convergence, …) report `deferred` from the sweep and are computed
// post-sweep by the server; they are reported as `live` with kind `derived`.

export const STATES = ['live', 'degraded', 'no_key', 'off', 'error'];

const NO_KEY_STATUS = new Set(['no_key', 'no_credentials', 'no_api_key', 'no_token']);
const OFF_STATUS = new Set(['offline', 'disabled', 'unavailable', 'stopped', 'not_configured']);
const DEGRADED_STATUS = new Set(['limited', 'partial', 'fallback', 'web_scrape', 'stale', 'cached']);
const DERIVED_STATUS = new Set(['deferred', 'ready']);
const META_KEYS = new Set(['source', 'timestamp', 'status', 'message', 'note', 'hint', 'error', 'durationMs', 'method', 'dataSource', 'description']);

const ENV_VAR_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|EMAIL|APPNAME|ID))\b/g;

export function envVarsFrom(text) {
  const out = [];
  for (const m of String(text || '').matchAll(ENV_VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Reduce an upstream error string to a short, non-leaking label.
export function shortError(raw) {
  const s = String(raw || '');
  if (/timed out|timeout|aborted/i.test(s)) return 'timed out';
  const m = /HTTP (\d{3})/.exec(s);
  if (m) {
    const code = Number(m[1]);
    if (code === 429) return 'rate limited (429)';
    if (code === 401 || code === 403) return `access denied (${code})`;
    if (code === 406) return 'blocked (406)';
    if (code >= 500) return `upstream error (${code})`;
    return `HTTP ${code}`;
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(s)) return 'unreachable';
  return 'error';
}

function hasContent(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'boolean') return false;
  return String(v).length > 0;
}

// True when a "successful" payload carries no actual observations.
export function isEmptyPayload(src) {
  const keys = Object.keys(src).filter(k => !META_KEYS.has(k));
  if (!keys.length) return true;
  return keys.every(k => !hasContent(src[k]));
}

export function classifySource(name, src, timing, errorEntry) {
  const base = { name, ms: timing?.ms ?? null };

  if (!src || typeof src !== 'object') {
    return { ...base, state: 'error', reason: shortError(errorEntry?.error || timing?.status || 'no data') };
  }

  const status = typeof src.status === 'string' ? src.status.toLowerCase() : null;
  const text = Object.keys(src)
    .filter(k => /(message|hint|note)$/i.test(k) && typeof src[k] === 'string')
    .map(k => src[k]).join(' ');
  const envVars = envVarsFrom(text);

  if (status && NO_KEY_STATUS.has(status)) return { ...base, state: 'no_key', reason: 'needs credentials', envVars };
  if (status && DERIVED_STATUS.has(status)) return { ...base, state: 'live', kind: 'derived', reason: 'computed post-sweep' };
  if (status && OFF_STATUS.has(status)) {
    if (envVars.length) return { ...base, state: 'no_key', reason: 'needs credentials', envVars };
    return { ...base, state: 'off', reason: status, ...(src.error ? { detail: shortError(src.error) } : {}) };
  }

  const dataKeys = Object.keys(src).filter(k => !META_KEYS.has(k) && !/error$/i.test(k) && hasContent(src[k]));
  const sideErrors = Object.keys(src).filter(k => /error$/i.test(k) && src[k]);

  if (src.error) {
    if (envVars.length) return { ...base, state: 'no_key', reason: 'needs credentials', envVars };
    if (!dataKeys.length) return { ...base, state: 'error', reason: shortError(src.error) };
    return { ...base, state: 'degraded', reason: shortError(src.error) };
  }

  if (status && DEGRADED_STATUS.has(status)) return { ...base, state: 'degraded', reason: status.replace('_', ' '), ...(envVars.length ? { envVars } : {}) };
  if (src.stale) return { ...base, state: 'degraded', reason: 'stale' };
  if (sideErrors.length) return { ...base, state: 'degraded', reason: `${shortError(src[sideErrors[0]])} · fallback`, ...(envVars.length ? { envVars } : {}) };
  if (isEmptyPayload(src)) return { ...base, state: 'degraded', reason: 'empty response' };

  return { ...base, state: 'live', reason: null };
}

export function buildSourceHealth(rawData) {
  const sources = rawData?.sources || {};
  const timing = rawData?.timing || {};
  const errors = new Map((rawData?.errors || []).map(e => [e.name, e]));
  const names = new Set([...Object.keys(sources), ...Object.keys(timing), ...errors.keys()]);

  const list = [...names].map(n => classifySource(n, sources[n], timing[n], errors.get(n)));
  list.sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.name.localeCompare(b.name));

  const summary = { total: list.length };
  for (const s of STATES) summary[s] = 0;
  for (const s of list) summary[s.state]++;
  summary.reporting = summary.live + summary.degraded;

  return { summary, sources: list, timestamp: rawData?.crucix?.timestamp || null };
}
