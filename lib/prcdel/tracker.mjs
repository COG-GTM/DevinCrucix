// Chinese Delegation Tracker: open-source reporting of PRC delegations abroad (Google News RSS
// search), geocoded to stops, grouped into delegations by leader / mission type, with headline-
// extracted meeting counterparts and PRC-linked events (ByteDance, Huawei, Confucius Institute,
// CGTN, ...) reported in the same places. Headline + link + date only; article bodies stay with
// the publisher. Everything here is machine-extracted from headlines → leads, not verified fact.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { safeFetch } from '../../apis/utils/fetch.mjs';
import { parseFeed } from '../../apis/utils/rss.mjs';
import { findPlaces, placeByCity } from './gazetteer.mjs';

const GN = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const DELEGATION_QUERIES = [
  '"Chinese delegation"', '"Chinese delegation" visit', '"Chinese delegation" meets', 'China delegation led by visit',
  '"Chinese vice premier" visit', '"Chinese foreign minister" visit', '"Wang Yi" visit meets', '"Chinese defense minister" OR "Chinese defence minister" visit',
  '"CPC delegation" OR "Communist Party of China delegation"', '"Chinese trade delegation" OR "Chinese business delegation" OR "Chinese economic delegation"',
  '"Chinese military delegation" OR "PLA delegation"', '"Chinese provincial delegation" OR "Chinese governor" visit',
];
export const EVENT_QUERIES = [
  'ByteDance conference OR summit OR forum OR bootcamp OR creators', 'TikTok creators summit OR conference OR bootcamp OR forum', 'Huawei forum OR summit OR conference OR "ICT competition" OR "Seeds for the Future"',
  'Alibaba OR Tencent OR ZTE forum OR summit OR conference', '"Confucius Institute" event OR festival OR ceremony', '"China Cultural Centre" OR "Chinese Cultural Center" event',
  'CGTN OR "China Media Group" OR Xinhua forum OR seminar OR workshop', '"Chinese embassy" hosts OR held reception OR seminar OR forum', '"Belt and Road" forum OR conference OR expo',
  '"China-Africa" OR "China-Arab" OR "China-CELAC" forum OR expo OR conference',
];

export const PRC_LEADERS = ['Xi Jinping', 'Li Qiang', 'Zhao Leji', 'Wang Huning', 'Cai Qi', 'Ding Xuexiang', 'Li Xi', 'Han Zheng', 'He Lifeng', 'Zhang Guoqing', 'Liu Guozhong',
  'Wang Yi', 'Dong Jun', 'Wang Wentao', 'Li Chenggang', 'Liu Jianchao', 'Liu Haixing', 'Shen Yiqin', 'Wu Zhenglong', 'Sun Weidong', 'Ma Zhaoxu', 'Hua Chunying', 'Zhang Youxia', 'Wang Xiaohong', 'Chen Wenqing'];

const SUBJECT_RE = new RegExp(String.raw`\b(?:Chinese|China(?:'s|’s)?|PRC|Beijing(?:'s|’s)?|CPC|Communist Party of China)\s+(?:[\w-]+\s+){0,4}?(?:delegation|vice[- ]premier|premier|vice[- ]president|president|foreign minister|defen[cs]e minister|state councilor|minister|vice[- ]minister|envoy|special envoy|officials?|governor|party secretary|team|mission)\b|\b(?:${PRC_LEADERS.join('|')})\b`, 'i');
const TRAVEL_RE = /\b(delegation|visits?|visited|visiting|arriv\w*|meets?|met|meeting|talks|tour|trip|calls? on|receives?|received|hosts?|hosted|welcomes?|lands?|lead|leads|led)\b/i;
const INBOUND_RE = /\b(?:to|in|visits?|visiting|arriv\w* in|trip to|tour of|lands? in)\s+(?:China|Beijing|Shanghai|Guangzhou|Shenzhen|Hangzhou|Nanjing|Xi'?an|Chongqing|Chengdu|Wuhan|Tianjin|Changsha|Xiamen|Hong Kong|Macau)\b/i;
const NOISE_RE = /\b(stocks?|shares|earnings|IPO|football|soccer|basketball|Olympic|recipe|horoscope|obituary)\b/i;

const CATEGORY_RULES = [
  ['Military', /\b(military|PLA|defen[cs]e|army|navy|naval|Dong Jun|Zhang Youxia)\b/i],
  ['Party (CPC / IDCPC)', /\b(CPC|Communist Party|IDCPC|International Department|Liu Jianchao|Liu Haixing|party delegation|Cai Qi|Li Xi)\b/i],
  ['Economic / Trade', /\b(trade|economic|economy|commerce|MOFCOM|business|investment|investors?|industrial|He Lifeng|Wang Wentao|Li Chenggang|enterprises?|chamber)\b/i],
  ['Diplomatic', /\b(foreign minist\w*|Foreign Ministry|Wang Yi|diplomat\w*|envoy|vice foreign minister|Sun Weidong|Ma Zhaoxu|bilateral|strategic dialogue)\b/i],
  ['Security / Policing', /\b(police|public security|Wang Xiaohong|Chen Wenqing|counter-?terror\w*|security cooperation)\b/i],
  ['Subnational', /\b(province|provincial|governor|mayor|municipal|city delegation|Changsha|Guangdong|Yunnan|Xinjiang|Sichuan|Shandong|Zhejiang|Jiangsu|Fujian|Hainan)\b/i],
  ['People-to-people', /\b(health\w*|medical|education|universit\w*|culture|cultural|youth|media|journalists?|think tank|science)\b/i],
];
export function classify(text) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return 'General';
}
export function leaderOf(text) {
  for (const n of PRC_LEADERS) if (new RegExp(`\\b${n}\\b`, 'i').test(text)) return n;
  return null;
}

const EVENT_HOSTS = [
  ['ByteDance', /\bByte ?Dance\b|\bDouyin\b|\bCapCut\b|\bLark\b/i], ['TikTok', /\bTikTok\b/i], ['Huawei', /\bHuawei\b/i], ['Alibaba', /\bAlibaba\b|\bAliExpress\b|\bAlibaba Cloud\b/i],
  ['Tencent', /\bTencent\b|\bWeChat\b/i], ['ZTE', /\bZTE\b/i], ['Confucius Institute', /\bConfucius (?:Institute|Classroom)\b/i], ['China Cultural Centre', /\bChin(?:a|ese) Cultural Cent(?:re|er)\b/i],
  ['CGTN / CMG', /\bCGTN\b|\bChina Media Group\b|\bCMG\b/i], ['Xinhua', /\bXinhua\b/i], ['Chinese Embassy', /\bChinese (?:embassy|ambassador)\b|\bEmbassy of China\b/i],
  ['Belt and Road', /\bBelt and Road\b|\bBRI\b/i], ['China-region forum', /\bChina[- ](?:Africa|Arab|CELAC|ASEAN|Central Asia|Pacific|Gulf)\b|\bFOCAC\b/i], ['Chinese firm', /\bChinese(?:-funded)? (?:firm|company|enterprise|tech)\b/i],
];
const EVENT_KIND_RE = /\b(conference|summit|forum|expo|exhibition|festival|workshop|bootcamp|boot camp|hackathon|training|seminar|symposium|launch(?:es|ed)?|fair|week|day|ceremony|creators?|gala|competition|reception|showcase|roadshow|academy|dialogue|open day|celebrat\w*|hosts?|hosted|held|holds|inaugurat\w*|unveil\w*|opens?)\b/i;

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export function splitOutlet(title) {
  const t = clean(title); const i = t.lastIndexOf(' - ');
  return i > 20 ? { headline: t.slice(0, i), outlet: t.slice(i + 3) } : { headline: t, outlet: '' };
}
const toIso = d => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const dayOf = iso => iso ? iso.slice(0, 10) : null;

// Counterparts named in a headline ("... meets Egyptian FM Badr Abdelatty", "Kenya's Ruto receives Chinese delegation").
export function extractMeetings(headline) {
  const out = [];
  const after = /\b(?:meets?(?: with)?|met(?: with)?|meeting with|holds? talks with|held talks with|talks with|calls? on|called on|received by|hosted by|welcomed by|discuss\w* with|confers? with|sign\w* \w+ with)\s+(.+?)(?=\s+(?:in|on|at|to|for|over|amid|as|during|ahead|after|before|and discuss|discuss\w*)\b|[,;:|]| - |$)/gi;
  let m; while ((m = after.exec(headline))) out.push(m[1]);
  const before = /^(.{3,80}?)\s+(?:receives?|received|hosts?|hosted|welcomes?|welcomed|meets?|met)\s+(?:a\s+|the\s+|visiting\s+|high-level\s+)*(?:Chinese|China|CPC|PRC)\b/i.exec(headline);
  if (before) out.push(before[1]);
  return [...new Set(out.map(s => clean(s).replace(/^(the|a)\s+/i, '').replace(/['’]s$/, '')).filter(s => s.length > 2 && s.length < 90 && !/^(Chinese|China)\b/i.test(s)))];
}

export function isDelegationHeadline(headline) {
  const h = clean(headline);
  if (!h || NOISE_RE.test(h)) return false;
  if (!SUBJECT_RE.test(h) || !TRAVEL_RE.test(h)) return false;
  if (INBOUND_RE.test(h)) return false;
  return true;
}

export function parseDelegationItem(item, query = '') {
  const { headline, outlet } = splitOutlet(item.title);
  if (!isDelegationHeadline(headline)) return null;
  const places = findPlaces(headline);
  if (!places.length) return null;
  const at = toIso(item.published);
  if (!at) return null;
  const p = places[0];
  return { kind: 'stop', date: dayOf(at), at, city: p.city, country: p.country, iso2: p.iso2, lat: p.lat, lon: p.lon, precision: p.precision,
    headline, outlet, url: String(item.link || ''), leader: leaderOf(headline), category: classify(headline), meetings: extractMeetings(headline), query, source: 'osint' };
}

export function parseEventItem(item, query = '') {
  const { headline, outlet } = splitOutlet(item.title);
  if (!headline || NOISE_RE.test(headline) || !EVENT_KIND_RE.test(headline)) return null;
  const host = EVENT_HOSTS.find(([, re]) => re.test(headline));
  if (!host) return null;
  const places = findPlaces(headline);
  if (!places.length) return null;
  const at = toIso(item.published);
  if (!at) return null;
  const p = places[0];
  return { kind: 'event', date: dayOf(at), at, city: p.city, country: p.country, iso2: p.iso2, lat: p.lat, lon: p.lon, precision: p.precision,
    host: host[0], headline, outlet, url: String(item.link || ''), query, source: 'osint' };
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Group stops into delegations: by named leader when one is present, else by mission category.
// The same headline syndicated by several outlets collapses into one stop with several sources.
export function groupDelegations(stops) {
  const byKey = new Map();
  for (const s of stops) {
    const key = s.leader ? `leader:${s.leader}` : `cat:${s.category}`;
    if (!byKey.has(key)) byKey.set(key, { id: `del-${slug(s.leader || s.category)}`, label: s.leader ? `${s.leader} delegation` : `PRC ${s.category} delegation(s)`,
      leader: s.leader, category: s.category, source: s.source || 'osint', stops: [] });
    const d = byKey.get(key);
    const near = d.stops.find(x => x.city === s.city && x.country === s.country && Math.abs(Date.parse(x.date) - Date.parse(s.date)) <= 2 * 86400e3);
    const src = { headline: s.headline, outlet: s.outlet, url: s.url, date: s.date };
    if (near) {
      if (!near.sources.some(x => x.url === src.url || x.headline === src.headline)) near.sources.push(src);
      for (const m of s.meetings || []) if (!near.meetings.includes(m)) near.meetings.push(m);
      if (s.date < near.date) near.date = s.date;
      if (s.precision === 'city') near.precision = 'city';
    } else {
      d.stops.push({ id: `${d.id}-${d.stops.length + 1}`, date: s.date, city: s.city, country: s.country, iso2: s.iso2, lat: s.lat, lon: s.lon, precision: s.precision,
        meetings: [...(s.meetings || [])], sources: [src], ...(s.note ? { note: s.note } : {}) });
    }
  }
  const out = [...byKey.values()];
  for (const d of out) {
    d.stops.sort((a, b) => a.date.localeCompare(b.date));
    d.stops.forEach((s, i) => { s.id = `${d.id}-${i + 1}`; s.seq = i + 1; });
    d.countries = [...new Set(d.stops.map(s => s.country))];
    d.first = d.stops[0]?.date; d.last = d.stops.at(-1)?.date;
  }
  return out.sort((a, b) => b.stops.length - a.stops.length || (b.last || '').localeCompare(a.last || ''));
}

// PRC-linked events in the same city (or same country when either side is only country-precise)
// within ±windowDays of a delegation stop.
export function findConcurrent(delegations, events, windowDays = 3) {
  const win = Math.max(0, Number(windowDays) || 0) * 86400e3;
  const overlaps = [];
  for (const d of delegations) for (const s of d.stops) {
    s.concurrent = [];
    for (const e of events) {
      if (e.country !== s.country) continue;
      if (e.synthetic && !d.synthetic) continue; // never pin scenario events on real delegations
      const sameCity = e.city === s.city;
      if (!sameCity && e.precision === 'city' && s.precision === 'city') continue;
      const gap = Math.round((Date.parse(e.date) - Date.parse(s.date)) / 86400e3);
      if (Math.abs(gap) * 86400e3 > win) continue;
      const o = { eventId: e.id, stopId: s.id, delegationId: d.id, gapDays: gap, match: sameCity ? 'city' : 'country' };
      s.concurrent.push(o); overlaps.push(o);
    }
  }
  return overlaps;
}

function loadCurated(path) {
  if (!path || !existsSync(path)) return { stops: [], events: [] };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const geo = r => { const p = r.lat != null ? { city: r.city, country: r.country, iso2: r.iso2 || '', lat: r.lat, lon: r.lon, precision: 'city' } : placeByCity(r.city); return p ? { ...r, ...p, city: r.city || p.city } : null; };
    const stops = (j.stops || []).map(geo).filter(Boolean).map(s => ({ kind: 'stop', category: s.category || classify(s.headline || ''), leader: s.leader || null, meetings: s.meetings || [], outlet: s.outlet || 'analyst', url: s.url || '', headline: s.headline || s.note || 'Analyst-entered stop', source: 'curated', ...s }));
    const events = (j.events || []).map(geo).filter(Boolean).map(e => ({ kind: 'event', outlet: e.outlet || 'analyst', url: e.url || '', headline: e.headline || e.title || 'Analyst-entered event', source: 'curated', ...e }));
    return { stops, events };
  } catch { return { stops: [], events: [] }; }
}

async function fetchQuery(q, days, fetchImpl) {
  const res = await fetchImpl(GN(`${q} when:${days}d`), { timeout: 15000, headers: { 'User-Agent': 'Crucix/1.0 (OSINT dashboard)' } });
  const xml = res?.rawText || '';
  return xml ? parseFeed(xml) : [];
}

export async function collectTracker({ days = 30, fetchImpl = safeFetch, curatedPath } = {}) {
  const errors = [];
  const run = async (qs, parse) => (await Promise.all(qs.map(async q => {
    try { return (await fetchQuery(q, days, fetchImpl)).map(it => parse(it, q)).filter(Boolean); }
    catch (e) { errors.push(`${q}: ${e.message}`); return []; }
  }))).flat();
  const [rawStops, rawEvents] = await Promise.all([run(DELEGATION_QUERIES, parseDelegationItem), run(EVENT_QUERIES, parseEventItem)]);
  const curated = loadCurated(curatedPath);
  const seen = new Set(); const stops = [];
  for (const s of [...curated.stops, ...rawStops]) { const k = `${s.url}|${s.headline}`; if (s.url && seen.has(k)) continue; seen.add(k); stops.push(s); }
  const evSeen = new Set(); const events = [];
  for (const e of [...curated.events, ...rawEvents]) {
    const k = `${e.headline}|${e.city}`; if (evSeen.has(k)) continue; evSeen.add(k);
    events.push({ id: `ev-${events.length + 1}`, ...e });
  }
  return { generatedAt: new Date().toISOString(), days, stops, events, errors,
    queries: { delegations: DELEGATION_QUERIES.length, events: EVENT_QUERIES.length } };
}

// Build the client payload from a raw collection (cheap; re-run per window change).
export function buildTracker(raw, { windowDays = 3 } = {}) {
  const delegations = groupDelegations(raw.stops || []);
  const events = raw.events || [];
  const overlaps = findConcurrent(delegations, events, windowDays);
  return { generatedAt: raw.generatedAt, days: raw.days, windowDays, delegations, events, overlaps,
    counts: { delegations: delegations.length, stops: delegations.reduce((n, d) => n + d.stops.length, 0), events: events.length, overlaps: overlaps.length },
    errors: raw.errors || [],
    disclaimer: 'Machine-extracted from news headlines (Google News search). Dates are publication dates, places and counterparts are parsed from headline text — leads, not verified itineraries.' };
}

export class TrackerCache {
  constructor({ path, ttlMs = 30 * 60 * 1000, curatedPath, collect = collectTracker } = {}) {
    this.path = path; this.ttlMs = ttlMs; this.curatedPath = curatedPath; this.collect = collect; this.raw = null; this.inflight = null;
    if (path && existsSync(path)) { try { this.raw = JSON.parse(readFileSync(path, 'utf8')); } catch { this.raw = null; } }
  }
  fresh() { return this.raw && Date.now() - Date.parse(this.raw.generatedAt) < this.ttlMs; }
  async get({ force = false } = {}) {
    if (!force && this.fresh()) return this.raw;
    if (!this.inflight) this.inflight = this.collect({ curatedPath: this.curatedPath }).then(r => {
      this.raw = r;
      if (this.path) { try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(r)); } catch {} }
      return r;
    }).finally(() => { this.inflight = null; });
    if (this.raw && !force) { this.inflight.catch(() => {}); return this.raw; }
    return this.inflight;
  }
}
