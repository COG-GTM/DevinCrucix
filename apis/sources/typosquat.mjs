// Typosquat Watch — DNS-Twist-style look-alike domain monitoring
// Generates permutations (omission, transposition, homoglyph, TLD swap, …) for
// each watchlisted domain and resolves them via DNS-over-HTTPS. Registered
// look-alikes are surfaced in the sweep and diffed against the previous run.
// Data source: Cloudflare DoH (free, no key). Configure via TYPOSQUAT_WATCHLIST.

import { safeFetch } from '../utils/fetch.mjs';

const DOH = 'https://cloudflare-dns.com/dns-query';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WATCHLIST = 'treasury.gov,irs.gov,cisa.gov,defense.gov,login.gov';
const PER_DOMAIN_CAP = 150;
const CONCURRENCY = 12;

const HOMOGLYPHS = { a: ['4', 'q'], b: ['d', '8'], c: ['e'], d: ['b', 'cl'], e: ['3', 'c'], g: ['q', '9'], i: ['1', 'l', 'j'], l: ['1', 'i'], m: ['rn', 'n'], n: ['m', 'r'], o: ['0', 'c'], q: ['g', 'p'], s: ['5', 'z'], t: ['7', 'f'], u: ['v'], v: ['u', 'w'], w: ['vv', 'v'], z: ['2', 's'] };
const KEYBOARD = { q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'o', a: 'qsz', s: 'awdz', d: 'sefx', f: 'drgc', g: 'fthv', h: 'gyjb', j: 'hukn', k: 'jilm', l: 'kop', z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk' };
const TLDS = ['com', 'net', 'org', 'co', 'us', 'info', 'io', 'gov', 'mil', 'online', 'site', 'xyz', 'app'];
const VOWELS = 'aeiou';

let _cache = null;
let _cacheTs = 0;
let _previousRegistered = new Set();

function splitDomain(domain) {
  const parts = domain.toLowerCase().split('.');
  const tld = parts.pop();
  const label = parts.pop();
  const prefix = parts.length ? parts.join('.') + '.' : '';
  return { prefix, label, tld };
}

// Returns [{domain, technique}] — capped and ordered by likelihood of abuse
export function generatePermutations(domain, cap = PER_DOMAIN_CAP) {
  const { prefix, label, tld } = splitDomain(domain);
  if (!label) return [];
  const seen = new Set([domain.toLowerCase()]);
  const out = [];
  const add = (l, technique, t = tld) => {
    const d = `${prefix}${l}.${t}`;
    if (l && !seen.has(d) && /^[a-z0-9-]+$/.test(l) && !l.startsWith('-') && !l.endsWith('-')) { seen.add(d); out.push({ domain: d, technique }); }
  };

  for (const t of TLDS) if (t !== tld) add(label, 'tld-swap', t);
  if (tld !== 'com') add(label, 'tld-append', `${tld}.com`);
  for (let i = 0; i < label.length; i++) {
    for (const g of HOMOGLYPHS[label[i]] || []) add(label.slice(0, i) + g + label.slice(i + 1), 'homoglyph');
  }
  for (let i = 0; i < label.length; i++) add(label.slice(0, i) + label.slice(i + 1), 'omission');
  for (let i = 0; i < label.length - 1; i++) add(label.slice(0, i) + label[i + 1] + label[i] + label.slice(i + 2), 'transposition');
  for (let i = 0; i < label.length; i++) add(label.slice(0, i) + label[i] + label.slice(i), 'repetition');
  for (let i = 1; i < label.length; i++) add(label.slice(0, i) + '-' + label.slice(i), 'hyphenation');
  for (let i = 0; i < label.length; i++) {
    if (VOWELS.includes(label[i])) for (const v of VOWELS) if (v !== label[i]) add(label.slice(0, i) + v + label.slice(i + 1), 'vowel-swap');
  }
  for (let i = 0; i < label.length; i++) {
    for (const k of KEYBOARD[label[i]] || '') add(label.slice(0, i) + k + label.slice(i + 1), 'replacement');
  }
  for (const suffix of ['login', 'secure', 'portal', 'support', 'account', 'verify', 'my', 'online', 'us', 'gov']) {
    add(`${label}-${suffix}`, 'addition'); add(`${suffix}-${label}`, 'addition'); add(`${label}${suffix}`, 'addition');
  }
  for (const c of 'abcdefghijklmnopqrstuvwxyz') add(label + c, 'addition');
  for (let i = 1; i < label.length; i++) add(`${label.slice(0, i)}.${label.slice(i)}`, 'subdomain');
  return out.slice(0, cap);
}

async function resolveA(domain) {
  const data = await safeFetch(`${DOH}?name=${encodeURIComponent(domain)}&type=A`, { timeout: 6000, retries: 0, headers: { Accept: 'application/dns-json' } });
  if (data.error) return null;
  if (data.Status !== 0) return { registered: false };
  const ips = (data.Answer || []).filter(a => a.type === 1).map(a => a.data);
  // NODATA with an SOA owned by the domain itself (not its parent TLD) means it is delegated/registered
  const soaName = (data.Authority || []).find(a => a.type === 6)?.name?.replace(/\.$/, '').toLowerCase();
  const ownSoa = !!soaName && (soaName === domain || soaName.endsWith('.' + domain));
  return { registered: ips.length > 0 || ownSoa, ips };
}

// Resolves permutations with bounded concurrency; returns registered ones
export async function resolveMany(perms) {
  const registered = [];
  let idx = 0;
  async function worker() {
    while (idx < perms.length) {
      const p = perms[idx++];
      const r = await resolveA(p.domain);
      if (r?.registered) registered.push({ ...p, ips: r.ips || [] });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, perms.length) }, worker));
  return registered;
}

export function getWatchlist() {
  const raw = process.env.TYPOSQUAT_WATCHLIST ?? DEFAULT_WATCHLIST;
  return [...new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(s => /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s)))].slice(0, 25);
}

export async function briefing() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;

  const watchlist = getWatchlist();
  if (watchlist.length === 0) {
    return { status: 'disabled', watchlist: [], totalChecked: 0, registered: [], byBase: {}, newCount: 0, timestamp: new Date().toISOString() };
  }

  const start = Date.now();
  const perBase = await Promise.all(watchlist.map(async base => {
    const perms = generatePermutations(base);
    const hits = await resolveMany(perms);
    return { base, checked: perms.length, hits: hits.map(h => ({ ...h, base })) };
  }));

  const registered = perBase.flatMap(b => b.hits);
  const currentSet = new Set(registered.map(r => r.domain));
  const firstRun = _previousRegistered.size === 0;
  for (const r of registered) r.isNew = !firstRun && !_previousRegistered.has(r.domain);
  _previousRegistered = currentSet;

  const byTechnique = {};
  for (const r of registered) byTechnique[r.technique] = (byTechnique[r.technique] || 0) + 1;

  const result = {
    status: 'live',
    watchlist,
    totalChecked: perBase.reduce((s, b) => s + b.checked, 0),
    registered: registered.sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.base.localeCompare(b.base)),
    byBase: Object.fromEntries(perBase.map(b => [b.base, { checked: b.checked, registered: b.hits.length }])),
    byTechnique,
    newCount: registered.filter(r => r.isNew).length,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
  _cache = result;
  _cacheTs = Date.now();
  return result;
}

// Standalone test: node apis/sources/typosquat.mjs
if (process.argv[1]?.endsWith('typosquat.mjs')) {
  briefing().then(d => console.log(JSON.stringify(d, null, 2)));
}
