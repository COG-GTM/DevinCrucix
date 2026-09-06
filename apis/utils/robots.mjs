// Minimal robots.txt client (RFC 9309 subset): longest-match Allow/Disallow for the
// most specific matching User-agent group, per-host cache, fail-open on network
// errors (a missing or unreachable robots.txt means "no restrictions").

import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const _cache = new Map(); // origin -> { rules, ts }

export const CRAWLER_UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';
const UA_TOKEN = 'crucix';

// Parse robots.txt into [{ agents: [...lowercase], rules: [{ allow, path }], crawlDelay }]
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') continue; // empty Disallow = allow all
      cur.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) cur.crawlDelay = n;
    }
  }
  return groups;
}

// Select the rule groups that apply to us: exact/prefix UA token match, else '*'.
function applicableGroups(groups, uaToken = UA_TOKEN) {
  const token = uaToken.toLowerCase();
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && (token.startsWith(a) || a.startsWith(token))));
  if (specific.length) return specific;
  return groups.filter(g => g.agents.includes('*'));
}

function pathMatches(pattern, path) {
  if (!pattern) return false;
  let anchored = false;
  let p = pattern;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const parts = p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('^' + parts.join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

// Longest-match wins; ties go to Allow.
export function isAllowedByRules(groups, urlPath, uaToken = UA_TOKEN) {
  const path = urlPath || '/';
  let best = null;
  for (const g of applicableGroups(groups, uaToken)) {
    for (const r of g.rules) {
      if (!pathMatches(r.path, path)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

export function crawlDelayFor(groups, uaToken = UA_TOKEN) {
  for (const g of applicableGroups(groups, uaToken)) if (g.crawlDelay != null) return g.crawlDelay;
  return null;
}

async function loadRobots(origin, fetchImpl) {
  const hit = _cache.get(origin);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.rules;
  let rules = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetchImpl(`${origin}/robots.txt`, { signal: controller.signal, headers: { 'User-Agent': CRAWLER_UA } });
    clearTimeout(timer);
    if (res.ok) rules = parseRobots(await res.text());
    // 4xx (incl. 404/403) -> no restrictions; 5xx -> treat as no restrictions but do not cache long
    if (res.status >= 500) { _cache.set(origin, { rules, ts: Date.now() - CACHE_TTL_MS + 5 * 60 * 1000 }); return rules; }
  } catch { /* fail open */ }
  _cache.set(origin, { rules, ts: Date.now() });
  return rules;
}

// { allowed: boolean, crawlDelay: number|null }
export async function checkRobots(url, opts = {}) {
  const fetchImpl = opts.fetch || safeOutboundFetch;
  let u;
  try { u = new URL(url); } catch { return { allowed: false, crawlDelay: null }; }
  const rules = await loadRobots(u.origin, fetchImpl);
  return { allowed: isAllowedByRules(rules, u.pathname + u.search), crawlDelay: crawlDelayFor(rules) };
}

export function resetRobotsCacheForTests() { _cache.clear(); }
