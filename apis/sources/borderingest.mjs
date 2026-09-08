// Border Watch — bridge to the Python ingestion service (ingest/crucix_ingest).
// The Python side owns collection (robots.txt-checked feed polling, article extraction, NER,
// geotagging, violence scoring) and the structured baselines (SESNSP, CBP, FRA, Justice in Mexico,
// InSight Crime). This module only reads its JSON API; it never fetches publisher sites itself.
//
// Configure with INGEST_API_URL (default http://127.0.0.1:3118). When the service is not running the
// source reports status 'offline' and the dashboard panel degrades gracefully.

import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

export const INGEST_API_URL = (process.env.INGEST_API_URL || 'http://127.0.0.1:3118').replace(/\/+$/, '');
const TIMEOUT_MS = 10_000;

// Read-only endpoints the Node side is allowed to proxy. Anything else is rejected before a request
// is made, so a dashboard user cannot reach the loopback-only POST endpoints through Express.
export const PROXY_ROUTES = [
  { pattern: /^\/health$/, params: [] },
  { pattern: /^\/sources$/, params: [] },
  { pattern: /^\/articles$/, params: ['limit', 'since', 'region', 'violence', 'language', 'source', 'paywalled'] },
  { pattern: /^\/articles\/\d{1,9}$/, params: [] },
  { pattern: /^\/anomalies$/, params: ['limit', 'since'] },
  { pattern: /^\/baselines$/, params: [] },
  { pattern: /^\/baselines\/[a-z0-9_]{1,64}\/records$/, params: ['series', 'region', 'since', 'limit'] },
  { pattern: /^\/summary$/, params: [] },
];
export const PROXY_PARAM_RE = /^[A-Za-z0-9_:+.\-]{1,64}$/;

/** Build a validated upstream URL for a proxied GET, or null if the path/params are not allow-listed. */
export function buildProxyUrl(path, query = {}) {
  const clean = String(path || '').replace(/\/+$/, '') || '/';
  const route = PROXY_ROUTES.find(r => r.pattern.test(clean));
  if (!route) return null;
  const url = new URL(INGEST_API_URL + clean);
  for (const key of route.params) {
    const val = query[key];
    if (typeof val === 'string' && PROXY_PARAM_RE.test(val)) url.searchParams.set(key, val);
  }
  return url.toString();
}

export async function ingestGet(path, query = {}) {
  const url = buildProxyUrl(path, query);
  if (!url) return { status: 404, body: { error: 'not found' } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await safeOutboundFetch(url, { signal: controller.signal, allowPrivate: true, headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: 'upstream returned non-JSON' }; }
    return { status: res.status, body };
  } catch (e) {
    return { status: 502, body: { error: 'ingest service unavailable' }, detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Sweep entry point used by apis/briefing.mjs. Returns the ingest /summary payload or an offline marker. */
export async function briefing() {
  const res = await ingestGet('/summary');
  if (res.status !== 200 || !res.body || typeof res.body !== 'object' || res.body.error) {
    return { status: 'offline', error: res.body?.error || `HTTP ${res.status}` };
  }
  return { status: 'live', ...res.body };
}
