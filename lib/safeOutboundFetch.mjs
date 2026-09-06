// SSRF-safe outbound HTTP. Every third-party request the app makes goes through here:
//   - http(s) only; hostname resolved with dns.lookup and every address checked against the
//     private/special-use deny list (literal IPs are checked without a lookup);
//   - redirects are never delegated to fetch — we follow at most `maxRedirects` ourselves and
//     re-run the full host check on each hop;
//   - AbortController timeout and a response size cap; the body is buffered and handed back as a
//     regular `Response` (status / headers / text() / json() work as usual; `url` is the final URL).
// `isPrivateAddress` and `assertPublicHost` are pure exports so the policy is unit-testable.

import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local'];

export class SafeFetchError extends Error {
  constructor(code, detail, url) {
    super(detail || code);
    this.name = 'SafeFetchError';
    this.code = code;       // blocked | invalid_url | too_many_redirects | too_large | timeout | network
    this.url = url ? String(url) : undefined;
  }
}

// ─── Address policy ─────────────────────────────────────────────────────────

function parseIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

function isPrivateIPv4(octets) {
  const [a, b] = octets;
  return a === 0                                   // 0.0.0.0/8 "this network"
    || a === 10                                    // 10/8
    || a === 127                                   // 127/8 loopback
    || (a === 169 && b === 254)                    // 169.254/16 link-local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31)           // 172.16/12
    || (a === 192 && b === 168)                    // 192.168/16
    || (a === 100 && b >= 64 && b <= 127)          // 100.64/10 CGNAT
    || a >= 224;                                   // 224/4 multicast, 240/4 reserved, broadcast
}

// Expand an IPv6 literal into 8 groups (16-bit ints), handling `::` and a trailing dotted IPv4.
function parseIPv6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]);
    if (!v4) return null;
    s = s.slice(0, -dotted[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every(Number.isInteger) ? nums : null;
}

function isPrivateIPv6(g) {
  const allZeroPrefix = (n) => g.slice(0, n).every(x => x === 0);
  if (allZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true;             // :: and ::1
  if (allZeroPrefix(5) && g[5] === 0xffff) return isPrivateIPv4(v4FromGroups(g)); // ::ffff:a.b.c.d IPv4-mapped
  if (allZeroPrefix(6)) return isPrivateIPv4(v4FromGroups(g));                  // ::a.b.c.d IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isPrivateIPv4(v4FromGroups(g));                                      // 64:ff9b::/96 NAT64 well-known prefix
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                  // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                  // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true;                                  // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                          // 2001:db8::/32 documentation
  return false;
}

const v4FromGroups = (g) => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];

/** True if `ip` (IPv4 or IPv6 literal) must never be contacted. Unparseable input is treated as private. */
export function isPrivateAddress(ip) {
  const raw = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (!raw) return true;
  const v4 = parseIPv4(raw);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(raw);
  if (v6) return isPrivateIPv6(v6);
  return true;
}

export function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

/** Hostnames that are refused outright, before any DNS. */
export function isBlockedHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === 'localhost') return true;
  return BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/**
 * Resolve `hostname` and refuse it if the name is internal or ANY resolved address is private.
 * Returns { ok: true, addresses } or { ok: false, reason } — reason is a short, client-safe token.
 */
export async function assertPublicHost(hostname, { lookup = dnsLookup } = {}) {
  const host = normalizeHostname(hostname);
  if (!host) return { ok: false, reason: 'empty host' };
  if (isBlockedHostname(host)) return { ok: false, reason: 'internal hostname' };
  if (isIP(host)) return isPrivateAddress(host) ? { ok: false, reason: 'private address' } : { ok: true, addresses: [host] };
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'does not resolve' };
  }
  const addresses = (Array.isArray(records) ? records : [records]).map(r => r.address).filter(Boolean);
  if (!addresses.length) return { ok: false, reason: 'does not resolve' };
  if (addresses.some(isPrivateAddress)) return { ok: false, reason: 'resolves to private address' };
  return { ok: true, addresses };
}

// ─── Transport ──────────────────────────────────────────────────────────────

function parseHttpUrl(input) {
  let url;
  try { url = input instanceof URL ? input : new URL(String(input)); } catch { throw new SafeFetchError('invalid_url', 'invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('invalid_url', 'unsupported URL scheme', url);
  if (url.username || url.password) throw new SafeFetchError('invalid_url', 'credentials in URL', url);
  return url;
}

// Buffer at most `maxBytes` of the body and rebuild a Response the caller can .text()/.json().
async function bufferResponse(res, { maxBytes, truncate, url }) {
  const declared = Number(res.headers.get('content-length'));
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SafeFetchError('too_large', 'response too large', url);
  }
  let body = null;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        if (!truncate) throw new SafeFetchError('too_large', 'response too large', url);
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        break;
      }
      chunks.push(value);
    }
    body = Buffer.concat(chunks);
  }
  const nullBodyStatus = res.status === 204 || res.status === 205 || res.status === 304;
  const out = new Response(nullBodyStatus || !body ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: url.href, enumerable: true });
  return out;
}

/**
 * fetch() with SSRF protection. Extra options beyond RequestInit:
 *   timeout (ms), maxBytes, maxRedirects, followRedirects (false → return the 3xx as-is; also implied
 *   by the standard `redirect: 'manual'`),
 *   truncate (true → cut the body at maxBytes instead of failing), allowPrivate (operator-configured
 *   loopback services only), lookup (dns.lookup replacement, tests).
 * Resolves to a buffered `Response`; rejects with SafeFetchError or the underlying fetch error.
 */
export async function safeOutboundFetch(input, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, maxRedirects = DEFAULT_MAX_REDIRECTS,
    followRedirects = opts.redirect !== 'manual', truncate = false, allowPrivate = false, lookup = dnsLookup, signal, ...init
  } = opts;

  let url = parseHttpUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SafeFetchError('timeout', 'request timed out', url)), timeout);
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers || {});
  const origin = url.origin;

  try {
    for (let hop = 0; ; hop++) {
      if (!allowPrivate) {
        const guard = await assertPublicHost(url.hostname, { lookup });
        if (!guard.ok) throw new SafeFetchError('blocked', guard.reason, url);
      }
      const res = await globalThis.fetch(url, { ...init, method, body, headers, redirect: 'manual', signal: controller.signal });
      const location = res.headers.get('location');
      if (!REDIRECT_STATUS.has(res.status) || !location || !followRedirects) {
        return await bufferResponse(res, { maxBytes, truncate, url });
      }
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'too many redirects', url);
      let next;
      try { next = new URL(location, url); } catch { throw new SafeFetchError('invalid_url', 'invalid redirect target', url); }
      url = parseHttpUrl(next);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      if (url.origin !== origin) {
        headers = new Headers(headers);
        headers.delete('authorization');
        headers.delete('cookie');
      }
    }
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof SafeFetchError) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}
