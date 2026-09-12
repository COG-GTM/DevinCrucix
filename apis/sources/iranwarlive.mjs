// Iran War Live (iranwarlive.com) — single-operator, fully automated OSINT aggregator for the
// 2026 Iran conflict theater. Pipeline (self-described): 5 English RSS wires → Gemini extraction →
// published Google Sheets → Leaflet site on Cloudflare, refreshed every 2 h.
//
//   /feed.json                     48 h event window (JSON, CORS *, max-age 60)
//   pub?gid=0            (CSV)     strikes / kinetic events, ~40 d retained
//   pub?gid=771466012    (CSV)     ground operations (duplicate `Units_Involved` header)
//   pub?gid=2133098001   (CSV)     regional actors + casualty tallies
//   pub?gid=1498621766   (CSV)     airspace / maritime status log (free-text statuses)
//   pub?gid=1935573357   (CSV)     posturing / diplomatic statements
//
// /ground-feed.json is documented but 404s and /hormuz-feed.json disagrees with its own page, so
// neither is polled. Everything here is machine-extracted from news wires with no human review:
// coordinates are city-level, most rows rest on a single wire, and casualty counts are the wire's
// claim. The adapter is observational (`limited` whenever anything material is missing), never
// ground truth, and every string is third-party text the dashboard must still HTML-escape.

import { safeFetch } from '../utils/fetch.mjs';
import { decodeEntities, stripTags } from '../utils/rss.mjs';

export const SOURCE = 'IranWarLive';
export const PROVIDER = 'IranWarLive (Tileterra Systems)';
export const SITE_URL = 'https://iranwarlive.com';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
export const FEED_URL = 'https://iranwarlive.com/feed.json';
export const SHEET_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSyinXiL-Ur469RUBFbu19pDta2jcrmPkJPBdPzlIlENpK_-DInxKtkM_PdxhUzG0ei0-yHhc9aqPRI/pub';
export const SHEETS = {
  strikes: 0,
  ground: 771466012,
  actors: 2133098001,
  airspace: 1498621766,
  posturing: 1935573357,
};
export const sheetUrl = (gid) => `${SHEET_BASE}?gid=${gid}&single=true&output=csv`;

const CACHE_TTL_MS = 30 * 60 * 1000;        // one sweep; upstream refreshes every 2 h
export const FRESH_AFTER_H = 6;             // 3 missed upstream runs → no longer `live`
export const STALE_AFTER_H = 12;            // cached copy older than this → `stale`
const MAX_CSV_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 800;
const MAX_LIST = 400;
const TEXT_MAX = 240;
const URL_MAX = 300;

// Theater box: Levant + Iraq + Iran + Arabian Peninsula + Red Sea/Horn approaches.
export const THEATER = { latMin: 10, latMax: 43, lonMin: 28, lonMax: 66 };

export const DISCLAIMER = [
  'Machine-extracted from 5 English news wires by an LLM (Google Gemini) with no human review; single operator.',
  'Coordinates are city-level approximations; casualty figures are the wire\'s claim, not a verified count.',
  'Western-aligned sources are over-represented; Iranian state, regional and non-English reporting is under-represented.',
  'Observational layer only — not intelligence, not for life-safety decisions. Click through to the cited article.',
];

let _cache = null;
let _cacheTs = 0;

// ─── text / value helpers ───────────────────────────────────────────────────

export function cleanText(raw, max = TEXT_MAX) {
  const s = stripTags(decodeEntities(String(raw ?? ''))).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export function httpUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > URL_MAX) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// "610,000" → 610000 · "N/A" / "" / "Unknown" → null
export function toCount(raw) {
  const s = String(raw ?? '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function toIso(raw) {
  const t = Date.parse(String(raw ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function toCoord(raw, limit) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && Math.abs(n) <= limit && String(raw ?? '').trim() !== '' ? n : null;
}

export function inTheater(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= THEATER.latMin && lat <= THEATER.latMax && lon >= THEATER.lonMin && lon <= THEATER.lonMax;
}

// `IRW-V5-<ms>-<n>` (feed.json) and `IRW-<ms>-<n>` (sheet) are the same event.
export function canonicalId(raw) {
  const s = cleanText(raw, 64).replace(/\s+/g, '');
  return s.replace(/^(IRW|GRND)-V\d+-/, '$1-') || null;
}

// Verified_By / confidence free text → 4 tiers the UI can colour.
export function confidenceTier(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return 'unrated';
  if (/multi-source|high confidence|military|\(high\)/.test(s)) return 'high';
  if (/osint|regional|\(medium\)/.test(s)) return 'medium';
  if (/state media|unverified|rumou?r|social media|\(low\)/.test(s)) return 'low';
  if (/news wire|wire/.test(s)) return 'wire';
  return 'unrated';
}

// Strike_Type / feed `type` → marker kind. Sheet's "Ground Forces" rows are kinetic events reported
// on the strikes tab; the dedicated ground-ops tab is a separate table with its own kinds.
export function strikeKind(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (/intercept/.test(s)) return 'intercept';
  if (/missile|rocket|ballistic/.test(s)) return 'missile';
  if (/drone|uav|uas/.test(s)) return 'drone';
  if (/ground|infantry|raid|artillery/.test(s)) return 'ground';
  if (/air ?strike|airstrike|bomb/.test(s)) return 'air';
  return 'other';
}

// Airspace statuses are free text ("Restricted (US naval blockade in effect since Monday)").
export function airspaceLevel(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return 'unknown';
  // The leading word is the operator's verdict; what follows is the caveat ("Restricted (US naval
  // blockade...)", "Open, but under Iranian supervision; US blockade continues").
  if (/^(open|normal|reopen)/.test(s)) return /\bbut\b|however|;|supervis|blockad|restrict|escort|risk/.test(s) ? 'restricted' : 'open';
  if (/^(restrict|high risk|contested|partial)/.test(s)) return 'restricted';
  if (/closed|blockad|dangerous|active engagement/.test(s) && !/lifted|reopen/.test(s)) return 'closed';
  if (/restrict|high risk|contested|threat|disruption/.test(s)) return 'restricted';
  if (/open|normal|lifted|reopen|monitored|de-confliction|talks/.test(s)) return 'open';
  return 'unknown';
}

// ─── CSV ────────────────────────────────────────────────────────────────────

// RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF. Returns arrays of cells.
export function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// Header row → objects. Duplicate headers get a positional suffix (`Units_Involved`, `Units_Involved_2`)
// so a schema drift upstream can never silently overwrite a column.
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return { headers: [], rows: [], duplicateHeaders: [] };
  const seen = new Map(), headers = [], duplicateHeaders = [];
  for (const raw of rows[0]) {
    const base = cleanText(raw, 64).replace(/^\uFEFF/, '');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) duplicateHeaders.push(base);
    headers.push(n > 1 ? `${base}_${n}` : base);
  }
  const out = [];
  for (const r of rows.slice(1)) {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
    out.push(o);
  }
  return { headers, rows: out, duplicateHeaders };
}

export function missingColumns(headers, required) {
  const have = new Set(headers);
  return required.filter(h => !have.has(h));
}

// ─── normalizers (one row/item → compact record or null) ────────────────────

export const STRIKE_COLS = ['Event_ID', 'Timestamp', 'Latitude', 'Longitude', 'Strike_Type', 'Target_Description', 'Source_URL'];
export const GROUND_COLS = ['Event_ID', 'Timestamp', 'Latitude', 'Longitude', 'Event_Type', 'Target_Description', 'Source_URL'];
export const ACTOR_COLS = ['Country', 'Alliance', 'Military_Deaths', 'Civilian_Deaths', 'Status'];
export const AIRSPACE_COLS = ['Timestamp', 'Country', 'Status'];
export const POSTURING_COLS = ['Timestamp', 'Country', 'Stance', 'Statement_Summary'];

function baseEvent(id, at, lat, lon, text, url) {
  if (!id || !at || lat == null || lon == null) return null;
  const sourceUrl = httpUrl(url);
  return {
    id, at, lat, lon,
    inTheater: inTheater(lat, lon),
    text: cleanText(text),
    sourceUrl,
    sourceHost: sourceUrl ? hostOf(sourceUrl) : null,
  };
}

export function normalizeStrike(r) {
  const e = baseEvent(canonicalId(r.Event_ID), toIso(r.Timestamp), toCoord(r.Latitude, 90), toCoord(r.Longitude, 180), r.Target_Description, r.Source_URL);
  if (!e) return null;
  return {
    ...e,
    table: 'strikes',
    type: cleanText(r.Strike_Type, 40) || 'Unknown',
    kind: strikeKind(r.Strike_Type),
    casualties: toCount(r.Casualties),
    verifiedBy: cleanText(r.Verified_By, 60) || null,
    confidence: confidenceTier(r.Verified_By),
    context: cleanText(r.Escalation_Context, 160) || null,
    verificationStatus: cleanText(r.Verification_Status, 40) || null,
  };
}

export function normalizeFeedItem(it) {
  if (!it || typeof it !== 'object') return null;
  const c = it._osint_meta?.coordinates || {};
  const e = baseEvent(canonicalId(it.event_id), toIso(it.timestamp), toCoord(c.lat, 90), toCoord(c.lng ?? c.lon, 180), it.event_summary, it.source_url);
  if (!e) return null;
  return {
    ...e,
    table: 'feed',
    type: cleanText(it.type, 40) || 'Unknown',
    kind: strikeKind(it.type),
    location: cleanText(it.location, 100) || null,
    casualties: toCount(it._osint_meta?.casualties),
    verifiedBy: cleanText(it.confidence, 60) || null,
    confidence: confidenceTier(it.confidence),
    context: null,
    verificationStatus: null,
  };
}

export function normalizeGround(r) {
  const e = baseEvent(canonicalId(r.Event_ID), toIso(r.Timestamp), toCoord(r.Latitude, 90), toCoord(r.Longitude, 180), r.Target_Description, r.Source_URL);
  if (!e) return null;
  const units = cleanText(r.Units_Involved, 80) || null;
  const movement = cleanText(r.Units_Involved_2, 40) || null;   // 2nd duplicate column holds Advance/Holding/Retreat
  return {
    ...e,
    table: 'ground',
    type: cleanText(r.Event_Type, 40) || 'Unknown',
    kind: 'ground',
    units,
    movement: movement && !/^unknown$/i.test(movement) ? movement : null,
    control: cleanText(r.Territory_Control, 40) || null,
    casualties: toCount(r.Casualties),
    verifiedBy: cleanText(r.Verified_By, 60) || null,
    confidence: confidenceTier(r.Verified_By),
  };
}

export function normalizeActor(r) {
  const name = cleanText(r.Country, 60);
  if (!name) return null;
  return {
    name,
    alliance: cleanText(r.Alliance, 40) || null,
    troops: toCount(r.Est_Troops),
    aircraft: toCount(r.Est_Aircraft),
    armor: toCount(r.Est_Armor),
    militaryDeaths: toCount(r.Military_Deaths),
    civilianDeaths: toCount(r.Civilian_Deaths),
    status: cleanText(r.Status, 40) || null,
  };
}

export function normalizeAirspace(r) {
  const at = toIso(r.Timestamp), region = cleanText(r.Country, 80);
  if (!at || !region) return null;
  const url = httpUrl(r.Source_URL);
  return { at, region, status: cleanText(r.Status, 120) || 'Unknown', level: airspaceLevel(r.Status), sourceUrl: url, sourceHost: url ? hostOf(url) : null };
}

export function normalizePosturing(r) {
  const at = toIso(r.Timestamp), actor = cleanText(r.Country, 60);
  if (!at || !actor) return null;
  const url = httpUrl(r.Source_URL);
  return { at, actor, stance: cleanText(r.Stance, 40) || null, text: cleanText(r.Statement_Summary), sourceUrl: url, sourceHost: url ? hostOf(url) : null };
}

// ─── table parsers (raw text → { rows, error?, drift? }) ────────────────────

function parseTable(text, required, normalize) {
  if (typeof text !== 'string') return { rows: [], error: 'no body' };
  if (!text.trim()) return { rows: [], error: 'empty response' };
  if (text.length > MAX_CSV_BYTES) return { rows: [], error: 'CSV exceeded size limit' };
  if (/^\s*<(!doctype|html)/i.test(text)) return { rows: [], error: 'response was HTML, not CSV (sheet unpublished?)' };
  const { headers, rows, duplicateHeaders } = parseCsv(text);
  const missing = missingColumns(headers, required);
  if (missing.length) return { rows: [], error: `schema drift: missing ${missing.join(', ')}` };
  // Sheets are append-only logs (oldest first): keep the tail so the cap never drops the newest rows.
  const out = [];
  for (const r of rows.slice(-MAX_LIST * 2)) {
    const n = normalize(r);
    if (n) out.push(n);
  }
  return { rows: out.slice(-MAX_LIST), dropped: Math.max(0, rows.length - out.length), duplicateHeaders };
}

export const parseStrikesCsv = (t) => parseTable(t, STRIKE_COLS, normalizeStrike);
export const parseGroundCsv = (t) => parseTable(t, GROUND_COLS, normalizeGround);
export const parseActorsCsv = (t) => parseTable(t, ACTOR_COLS, normalizeActor);
export const parseAirspaceCsv = (t) => parseTable(t, AIRSPACE_COLS, normalizeAirspace);
export const parsePosturingCsv = (t) => parseTable(t, POSTURING_COLS, normalizePosturing);

export function parseFeed(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { items: [], error: 'feed was not a JSON object' };
  if (!Array.isArray(json.items)) return { items: [], error: 'feed has no items[]' };
  const items = [];
  for (const it of json.items.slice(0, MAX_LIST)) {
    const n = normalizeFeedItem(it);
    if (n) items.push(n);
  }
  return {
    items,
    updatedAt: toIso(json.last_updated),
    windowHours: toCount(json.window_hours),
    version: cleanText(json.version, 12) || null,
    dropped: json.items.length - items.length,
  };
}

// ─── assembly ───────────────────────────────────────────────────────────────

// Feed + strikes sheet describe the same events: sheet is the longer record, feed carries the
// operator's confidence string. Merge by canonical id, then by (hour, rounded coords, kind).
export function mergeEvents(feedItems, strikeRows) {
  const byId = new Map();
  const sig = (e) => `${e.at.slice(0, 13)}|${e.lat.toFixed(1)}|${e.lon.toFixed(1)}|${e.kind}`;
  const bySig = new Map();
  for (const e of strikeRows) { byId.set(e.id, e); bySig.set(sig(e), e); }
  for (const f of feedItems) {
    const hit = byId.get(f.id) || bySig.get(sig(f));
    if (hit) {
      if (!hit.verifiedBy && f.verifiedBy) { hit.verifiedBy = f.verifiedBy; hit.confidence = f.confidence; }
      if (!hit.text && f.text) hit.text = f.text;
      if (f.location) hit.location = f.location;
      hit.inFeed = true;
    } else {
      byId.set(f.id, { ...f, inFeed: true });
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_EVENTS);
}

function countBy(list, key) {
  const m = {};
  for (const x of list) { const k = x[key] || 'other'; m[k] = (m[k] || 0) + 1; }
  return m;
}

function hoursAgo(iso, now) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? +((now - t) / 3600000).toFixed(1) : null;
}

// parts = { feed, strikes, ground, actors, airspace, posturing } each { ok, error?, ... }
export function buildResult(parts, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const feed = parts.feed || { ok: false, error: 'not fetched', items: [] };
  const strikes = parts.strikes || { ok: false, error: 'not fetched', rows: [] };
  const ground = parts.ground || { ok: false, error: 'not fetched', rows: [] };
  const actors = parts.actors || { ok: false, error: 'not fetched', rows: [] };
  const airspace = parts.airspace || { ok: false, error: 'not fetched', rows: [] };
  const posturing = parts.posturing || { ok: false, error: 'not fetched', rows: [] };

  const problems = [];
  for (const [name, p] of Object.entries({ feed, strikes, ground, actors, airspace, posturing })) {
    if (!p.ok) problems.push(`${name}: ${p.error || 'failed'}`);
    else if (p.duplicateHeaders?.length && name !== 'ground') problems.push(`${name}: duplicate header ${p.duplicateHeaders.join(', ')}`);
  }

  const events = mergeEvents(feed.ok ? feed.items : [], strikes.ok ? strikes.rows : []);
  const groundEvents = (ground.ok ? ground.rows : []).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const theater = events.filter(e => e.inTheater);
  const outOfTheater = events.length - theater.length;
  const h24 = now - 24 * 3600000, h48 = now - 48 * 3600000, d7 = now - 7 * 86400000;
  const within = (list, t) => list.filter(e => Date.parse(e.at) >= t && Date.parse(e.at) <= now + 3600000);
  const ev48 = within(events, h48), ev24 = within(events, h24), ev7d = within(events, d7);
  const gr48 = within(groundEvents, h48);
  const sum = (list, k) => list.reduce((s, e) => s + (Number.isFinite(e[k]) ? e[k] : 0), 0);

  const latestEventAt = events[0]?.at || groundEvents[0]?.at || null;
  const feedUpdatedAt = feed.ok ? feed.updatedAt : null;
  const freshnessAt = feedUpdatedAt || latestEventAt;
  const feedAgeH = hoursAgo(freshnessAt, now);

  const actorRows = actors.ok ? actors.rows : [];
  const casualties = {
    military: actorRows.reduce((s, a) => s + (a.militaryDeaths ?? 0), 0),
    civilian: actorRows.reduce((s, a) => s + (a.civilianDeaths ?? 0), 0),
    actors: actorRows.filter(a => (a.militaryDeaths ?? 0) + (a.civilianDeaths ?? 0) > 0).length,
  };

  // Airspace: latest status per region, newest first (the log is append-only).
  const airLatest = new Map();
  for (const a of (airspace.ok ? airspace.rows : []).slice().sort((x, y) => Date.parse(y.at) - Date.parse(x.at))) {
    if (!airLatest.has(a.region.toLowerCase())) airLatest.set(a.region.toLowerCase(), a);
  }
  const airspaceNow = [...airLatest.values()];
  const postRows = (posturing.ok ? posturing.rows : []).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  // Status. `live` needs the primary tables fresh and populated; anything material missing → `limited`.
  let status = 'live';
  const why = [];
  const hasEvents = theater.length > 0 || groundEvents.length > 0;
  if (!feed.ok && !strikes.ok) {
    return unavailable(`primary sources failed — ${problems.join('; ')}`.slice(0, 300), nowIso);
  }
  if (!hasEvents) { status = 'empty'; why.push('feeds parsed but contain no theater events'); }
  else {
    if (!feed.ok || !strikes.ok) { status = 'limited'; why.push('one primary source failed'); }
    if (!ground.ok || !actors.ok || !airspace.ok) { status = 'limited'; why.push('supporting sheet failed'); }
    if (feedAgeH != null && feedAgeH > FRESH_AFTER_H) { status = 'limited'; why.push(`upstream last ran ${feedAgeH} h ago (>${FRESH_AFTER_H} h)`); }
    if (feed.ok && feed.items.length === 0 && ev48.length === 0) { status = 'limited'; why.push('48 h feed window is empty'); }
  }

  const signals = [];
  if (ev24.length) signals.push({ kind: 'kinetic', text: `${ev24.length} extracted event${ev24.length === 1 ? '' : 's'} in 24 h · ${sum(ev24, 'casualties')} reported casualties` });
  const byKind48 = countBy(ev48, 'kind');
  if (byKind48.missile || byKind48.drone) signals.push({ kind: 'kinetic', text: `${byKind48.missile || 0} missile · ${byKind48.drone || 0} drone · ${byKind48.intercept || 0} intercept events in 48 h` });
  if (gr48.length) signals.push({ kind: 'ground', text: `${gr48.length} ground-ops row${gr48.length === 1 ? '' : 's'} in 48 h · control: ${Object.entries(countBy(gr48, 'control')).map(([k, v]) => `${k} ${v}`).join(', ')}` });
  const closed = airspaceNow.filter(a => a.level === 'closed').length, restricted = airspaceNow.filter(a => a.level === 'restricted').length;
  if (closed || restricted) signals.push({ kind: 'airspace', text: `${closed} closed / blockaded · ${restricted} restricted airspace or sea-lane entries` });
  const conf = countBy(ev48, 'confidence');
  const singleWire = (conf.wire || 0) + (conf.low || 0) + (conf.unrated || 0);
  if (ev48.length) signals.push({ kind: 'quality', text: `${Math.round(100 * singleWire / ev48.length)}% of 48 h events rest on a single wire or unverified source` });
  if (outOfTheater) signals.push({ kind: 'quality', text: `${outOfTheater} event${outOfTheater === 1 ? '' : 's'} geocoded outside the theater box (not plotted)` });

  return {
    source: SOURCE,
    timestamp: nowIso,
    status,
    stale: false,
    error: why.length ? why.join('; ') : null,
    problems: problems.slice(0, 8),
    provider: PROVIDER,
    siteUrl: SITE_URL,
    licenseUrl: LICENSE_URL,
    feedUrl: FEED_URL,
    fetchedAt: nowIso,
    feedUpdatedAt,
    feedVersion: feed.ok ? feed.version : null,
    feedWindowHours: feed.ok ? feed.windowHours : null,
    feedAgeH,
    latestEventAt,
    parts: {
      feed: feed.ok ? 'ok' : 'error',
      strikes: strikes.ok ? 'ok' : 'error',
      ground: ground.ok ? 'ok' : 'error',
      actors: actors.ok ? 'ok' : 'error',
      airspace: airspace.ok ? 'ok' : 'error',
      posturing: posturing.ok ? 'ok' : 'error',
    },
    counts: {
      events: events.length,
      theaterEvents: theater.length,
      outOfTheater,
      events24h: ev24.length,
      events48h: ev48.length,
      events7d: ev7d.length,
      casualties48h: sum(ev48, 'casualties'),
      casualties7d: sum(ev7d, 'casualties'),
      byKind48h: byKind48,
      byConfidence48h: conf,
      ground: groundEvents.length,
      ground48h: gr48.length,
      groundControl: countBy(groundEvents.slice(0, 60), 'control'),
      airspaceRegions: airspaceNow.length,
      airspaceClosed: closed,
      airspaceRestricted: restricted,
      posturing: postRows.length,
      actors: actorRows.length,
    },
    casualties,
    actors: actorRows,
    airspace: airspaceNow.slice(0, 40),
    posturing: postRows.slice(0, 40),
    events: theater.slice(0, 60),
    groundEvents: groundEvents.slice(0, 40),
    signals: signals.slice(0, 6),
    disclaimer: DISCLAIMER,
    // Full geocoded set for the map, served separately (/api/iranwar/geo), never in the compact payload.
    geo: {
      fetchedAt: nowIso,
      events: theater,
      ground: groundEvents.filter(g => g.inTheater),
    },
  };
}

export function unavailable(error, nowIso = new Date().toISOString()) {
  return {
    source: SOURCE,
    timestamp: nowIso,
    status: 'unavailable',
    error,
    provider: PROVIDER,
    siteUrl: SITE_URL,
    licenseUrl: LICENSE_URL,
    disclaimer: DISCLAIMER,
  };
}

function staleCopy() {
  const ageMs = Date.now() - _cacheTs;
  const ageH = ageMs / 3600000;
  return {
    ..._cache,
    stale: true,
    status: ageH > STALE_AFTER_H ? 'stale' : (_cache.status === 'live' ? 'limited' : _cache.status),
    cacheAgeH: +ageH.toFixed(1),
    error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed`,
  };
}

// ─── network ────────────────────────────────────────────────────────────────

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' };

async function fetchCsvPart(gid, parse) {
  const raw = await safeFetch(sheetUrl(gid), { timeout: 20000, headers: { ...HEADERS, Accept: 'text/csv, text/plain, */*' } });
  if (raw?.error) return { ok: false, error: raw.error.slice(0, 160) };
  const text = typeof raw === 'string' ? raw : raw?.rawText;
  const parsed = parse(text);
  if (parsed.error) return { ok: false, error: parsed.error };
  return { ok: true, ...parsed };
}

async function fetchFeedPart() {
  const raw = await safeFetch(FEED_URL, { timeout: 15000, headers: { ...HEADERS, Accept: 'application/json' } });
  if (raw?.error) return { ok: false, error: raw.error.slice(0, 160), items: [] };
  const parsed = parseFeed(raw?.rawText !== undefined ? null : raw);
  if (parsed.error) return { ok: false, error: parsed.error, items: [] };
  return { ok: true, ...parsed };
}

export async function fetchIranWarLive() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    const [feed, strikes, ground, actors, airspace, posturing] = await Promise.all([
      fetchFeedPart(),
      fetchCsvPart(SHEETS.strikes, parseStrikesCsv),
      fetchCsvPart(SHEETS.ground, parseGroundCsv),
      fetchCsvPart(SHEETS.actors, parseActorsCsv),
      fetchCsvPart(SHEETS.airspace, parseAirspaceCsv),
      fetchCsvPart(SHEETS.posturing, parsePosturingCsv),
    ]);
    const result = buildResult({ feed, strikes, ground, actors, airspace, posturing });
    if (result.status === 'unavailable') {
      console.log(`[IranWarLive] ${result.error}`);
      return _cache ? staleCopy() : result;
    }
    const c = result.counts;
    console.log(`[IranWarLive] ${result.status} · ${c.theaterEvents} events (${c.events48h} in 48 h) · ${c.ground} ground rows · ${c.actors} actors · feed age ${result.feedAgeH ?? '?'} h${result.error ? ` · ${result.error}` : ''}`);
    for (const p of result.problems) console.log(`[IranWarLive] part: ${p}`);
    _cache = result;
    _cacheTs = Date.now();
    return result;
  } catch (err) {
    console.log(`[IranWarLive] fetch error: ${err.message}`);
    return _cache ? staleCopy() : unavailable(err.message);
  }
}

export function cachedIranWarGeo() {
  return _cache?.geo || null;
}

export async function briefing() {
  return fetchIranWarLive();
}
