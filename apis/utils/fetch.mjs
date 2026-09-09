// Fetch with timeout, retry, and SSRF protection (see lib/safeOutboundFetch.mjs).
// Returns parsed JSON, or { rawText } for non-JSON bodies, or { error, source } after all retries fail.

import { safeOutboundFetch, SafeFetchError } from '../../lib/safeOutboundFetch.mjs';

export async function safeFetch(url, opts = {}) {
  const { timeout = 15000, retries = 1, headers = {}, ...rest } = opts;
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await safeOutboundFetch(url, {
        ...rest,
        timeout,
        headers: { 'User-Agent': 'Crucix/1.0', ...headers },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const text = await res.text();
      try { return JSON.parse(text); } catch { return { rawText: text }; }
    } catch (e) {
      lastError = e;
      if (e instanceof SafeFetchError && (e.code === 'blocked' || e.code === 'invalid_url')) break;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { error: lastError?.message || 'Unknown error', source: url };
}

export { safeOutboundFetch, SafeFetchError };

export function ago(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

export function today() {
  return new Date().toISOString().split('T')[0];
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
