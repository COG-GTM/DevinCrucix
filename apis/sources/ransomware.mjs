// Ransomware attack tape — leak-site victim postings from ransomware.live (free, no key).
// Victim posts are claims by criminal groups, not confirmed breaches; the UI says so.
//   https://api.ransomware.live/v2/recentvictims  (last ~100 posts)
//   https://api.ransomware.live/v2/groups         (group profiles: tools, TTPs, locations)

import { safeFetch } from '../utils/fetch.mjs';

const VICTIMS_URL = 'https://api.ransomware.live/v2/recentvictims';
const MONTH_URL = (y, m) => `https://api.ransomware.live/v2/victims/${y}/${String(m).padStart(2, '0')}`;
const GROUPS_URL = 'https://api.ransomware.live/v2/groups';
const WINDOW_DAYS = 7;
const GROUPS_TTL_MS = 24 * 60 * 60 * 1000;

let groupsCache = { at: 0, byName: null };

const DAY = 86400000;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}

function tally(list, key) {
  const m = new Map();
  for (const v of list) {
    const k = v[key];
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function normalizeVictim(raw, now = Date.now()) {
  const discovered = parseDate(raw.discovered) ?? parseDate(raw.attackdate);
  if (!discovered) return null;
  const country = String(raw.country || '').trim().toUpperCase();
  return {
    victim: clip(raw.victim, 80),
    domain: clip(raw.domain, 120),
    group: clip(raw.group, 40).toLowerCase(),
    sector: (() => { const a = clip(raw.activity, 40); return !a || /^not found$/i.test(a) ? 'Unknown' : a; })(),
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    discovered: new Date(discovered).toISOString(),
    ageHours: Math.max(0, Math.round((now - discovered) / 3600000)),
    url: /^https?:\/\//.test(String(raw.url || '')) ? clip(raw.url, 300) : null,
  };
}

export function dedupeVictims(list) {
  const seen = new Set();
  return list.filter(v => { const k = v.url || `${v.group}|${v.victim}|${v.discovered.slice(0, 10)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function summarizeVictims(rawList, { now = Date.now(), windowDays = WINDOW_DAYS, groupsByName = null } = {}) {
  const since = now - windowDays * DAY;
  const all = dedupeVictims((Array.isArray(rawList) ? rawList : []).map(v => normalizeVictim(v, now)).filter(Boolean)).sort((a, b) => b.discovered.localeCompare(a.discovered));
  const victims = all.filter(v => Date.parse(v.discovered) >= since).sort((a, b) => b.discovered.localeCompare(a.discovered));
  const last24h = victims.filter(v => v.ageHours < 24).length;
  const groups = tally(victims, 'group').map(g => {
    const meta = groupsByName?.get(g.name);
    return {
      name: g.name, count: g.count,
      sectors: tally(victims.filter(v => v.group === g.name), 'sector').slice(0, 3).map(s => s.name),
      tools: meta?.tools || [], ttps: meta?.ttps || [], description: meta?.description || null, firstSeen: meta?.added || null,
    };
  });
  return {
    windowDays, total: victims.length, last24h,
    oldestInFeed: all.length ? all[all.length - 1].discovered : null,
    feedCovered: all.length ? now - Date.parse(all[all.length - 1].discovered) >= windowDays * DAY : false,
    groups, sectors: tally(victims, 'sector'), countries: tally(victims, 'country').map(c => ({ code: c.name, count: c.count })),
    victims: victims.slice(0, 60),
  };
}

export function indexGroups(rawGroups) {
  const m = new Map();
  for (const g of Array.isArray(rawGroups) ? rawGroups : []) {
    const name = clip(g.name, 40).toLowerCase();
    if (!name) continue;
    // tools: [{ Category: [names…] }], ttps: [{ tactic_name, techniques: [{ technique_id, technique_name }] }]
    const tools = [];
    for (const t of Array.isArray(g.tools) ? g.tools : []) {
      if (typeof t === 'string') tools.push(clip(t, 40));
      else if (t && typeof t === 'object') for (const names of Object.values(t)) if (Array.isArray(names)) names.forEach(n => tools.push(clip(n, 40)));
    }
    const ttps = [];
    for (const t of Array.isArray(g.ttps) ? g.ttps : []) {
      if (typeof t === 'string') ttps.push(clip(t, 60));
      else for (const q of Array.isArray(t?.techniques) ? t.techniques : []) if (q?.technique_id) ttps.push(`${clip(q.technique_id, 12)} ${clip(q.technique_name, 40)}`.trim());
    }
    m.set(name, { tools: [...new Set(tools.filter(Boolean))].slice(0, 12), ttps: [...new Set(ttps.filter(Boolean))].slice(0, 10), description: clip(g.description, 240) || null, added: g.added_date || null });
  }
  return m;
}

async function loadGroups() {
  if (groupsCache.byName && Date.now() - groupsCache.at < GROUPS_TTL_MS) return groupsCache.byName;
  const raw = await safeFetch(GROUPS_URL, { timeout: 15000, retries: 0 });
  if (raw?.error || !Array.isArray(raw)) return groupsCache.byName;
  groupsCache = { at: Date.now(), byName: indexGroups(raw) };
  return groupsCache.byName;
}

// Month archives the 7-day window spans (the recent feed only covers ~100 posts, i.e. a few days).
export function monthsForWindow(now = Date.now(), windowDays = WINDOW_DAYS) {
  const out = [];
  for (const t of [now, now - windowDays * DAY]) {
    const d = new Date(t); const key = [d.getUTCFullYear(), d.getUTCMonth() + 1];
    if (!out.some(([y, m]) => y === key[0] && m === key[1])) out.push(key);
  }
  return out;
}

export async function briefing() {
  const now = Date.now();
  const [raw, groupsByName, ...months] = await Promise.all([
    safeFetch(VICTIMS_URL, { timeout: 20000, retries: 1 }),
    loadGroups(),
    ...monthsForWindow(now).map(([y, m]) => safeFetch(MONTH_URL(y, m), { timeout: 20000, retries: 0 })),
  ]);
  const archive = months.filter(Array.isArray).flat();
  if (!Array.isArray(raw) && !archive.length) return { source: 'Ransomware', timestamp: new Date().toISOString(), status: 'error', error: raw?.error || 'unexpected payload' };
  const summary = summarizeVictims([...(Array.isArray(raw) ? raw : []), ...archive], { now, groupsByName });
  summary.archiveLoaded = months.filter(Array.isArray).length;
  const signals = [];
  if (summary.last24h >= 15) {
    signals.push({ type: 'ransomware_surge', severity: 'high', confidence: 0.7,
      title: `${summary.last24h} ransomware leak-site postings in 24h`,
      detail: `Top groups: ${summary.groups.slice(0, 3).map(g => `${g.name} (${g.count})`).join(', ')}` });
  }
  return {
    source: 'Ransomware', timestamp: new Date().toISOString(), status: 'live',
    attribution: 'ransomware.live (leak-site claims, unverified)',
    ...summary, signals,
  };
}
