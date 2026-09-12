// China / Taiwan dashboard view model: the bounded slice of the five Taiwan adapters (MND bulletin +
// Skyfaring trend, CGA grey-zone incidents, Focus Taiwan / Taipei Times headlines, GCA observational
// strip, Polymarket threat markets) that goes into the client payload, plus the existing CRUCIX
// signals for the theater (PRC tension composite, Taiwan Strait / SCS air, Chinese ISR, carriers).
// Geometry for the map goes out separately via /api/taiwan/geo. Every string is third-party text:
// bounded here, HTML-escaped again by the dashboard before insertion.

import { prcTension } from './situation.mjs';

const MAX_TREND = 31;
const MAX_INCIDENTS = 40;
const MAX_HEADLINES = 30;
const MAX_GCA = 24;
const MAX_MARKETS = 8;

const str = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const num = (v) => (Number.isFinite(v) ? v : 0);
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const coord = (v, lim) => (Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
const httpUrl = (raw) => {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
};
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const clock = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : null);
const counts = (o, maxKeys = 12) => Object.fromEntries(Object.entries(o || {}).slice(0, maxKeys).map(([k, v]) => [str(k, 32), num(v)]));
const strList = (a, max, len) => (Array.isArray(a) ? a : []).slice(0, max).map(x => str(x, len));

// Health for a source result, in the vocabulary the Sources tab already uses.
const STATUSES = new Set(['live', 'limited', 'stale', 'empty', 'unavailable', 'no-key', 'link-out']);
function health(s) {
  if (!s || typeof s !== 'object') return 'unavailable';
  if (STATUSES.has(s.status)) return s.status;
  if (s.status === 'failed' || s.status === 'error') return 'unavailable';
  return 'unavailable';
}

// Honest link-outs: sources that cannot be polled (request-based data policy, Akamai/Cloudflare
// challenge, no feed). Listed so the operator knows they exist and were not silently skipped.
export const LINK_OUTS = [
  { key: 'platracker', name: 'PLATracker (Ben Lewis / Gerald Brown) — ADIZ incursion sheet', url: 'https://pla-tracker.skyfaring.net/en/about', reason: 'Google-Sheets source; data policy asks for a request before redistribution. Skyfaring CC BY mirror is used instead.' },
  { key: 'csis-chinapower', name: 'CSIS ChinaPower — Tracking PLA activity around Taiwan', url: 'https://chinapower.csis.org/tracker/china-taiwan/', reason: 'Interactive tracker, no feed; analysis is copyrighted.' },
  { key: 'jsdf-joint-staff', name: 'Japan Joint Staff — PLA transit press releases (Miyako / Yonaguni)', url: 'https://www.mod.go.jp/js/press/index.html', reason: 'PDF releases behind a bot challenge; not polled in this increment.' },
  { key: 'indopacom', name: 'U.S. INDOPACOM press releases', url: 'https://www.pacom.mil/Media/News/', reason: 'Akamai bot protection blocks server-side fetch.' },
  { key: 'c7f', name: 'U.S. 7th Fleet — Taiwan Strait transit statements', url: 'https://www.c7f.navy.mil/Press-Room/', reason: 'Akamai bot protection blocks server-side fetch.' },
  { key: 'gca-map', name: 'Global Conflict Awareness — live Taiwan map', url: 'https://globalconflictawareness.com/?conflict=taiwan', reason: 'Their map view; the feed behind it is shown here as the observational strip.' },
  { key: 'mnd-en', name: 'Taiwan MND — PLA activities (English list)', url: 'https://www.mnd.gov.tw/en/news/PlaactList', reason: 'Bulletin of record; the daily numbers above are parsed from it.' },
];

function trimBulletin(b) {
  if (!b) return null;
  return {
    publishedDate: date(b.publishedDate),
    articleUrl: httpUrl(b.articleUrl),
    zhArticleUrl: httpUrl(b.zhArticleUrl),
    mapUrl: httpUrl(b.mapUrl),
    windowStart: iso(b.windowStart),
    windowEnd: iso(b.windowEnd),
    aircraft: numOrNull(b.aircraft),
    adizEntries: numOrNull(b.adizEntries),
    sectors: strList(b.sectors, 5, 12),
    planShips: numOrNull(b.planShips),
    officialShips: numOrNull(b.officialShips),
    balloons: numOrNull(b.balloons),
    activityText: str(b.activityText, 400),
    crossCheck: b.crossCheck ? { state: str(b.crossCheck.state, 12), detail: str(b.crossCheck.detail, 160) } : null,
    problems: strList(b.problems, 6, 120),
  };
}

export function trimMnd(m = {}) {
  return {
    source: 'TaiwanMND',
    status: health(m),
    stale: Boolean(m.stale),
    error: m.error ? str(m.error, 200) : null,
    problems: strList(m.problems, 12, 160),
    provider: str(m.provider, 80),
    siteUrl: httpUrl(m.siteUrl),
    licenseUrl: httpUrl(m.licenseUrl),
    fetchedAt: iso(m.fetchedAt),
    cacheAgeH: numOrNull(m.cacheAgeH),
    parts: Object.fromEntries(Object.entries(m.parts || {}).slice(0, 6).map(([k, v]) => [str(k, 12), v === 'ok' ? 'ok' : 'error'])),
    bulletin: trimBulletin(m.bulletin),
    bulletinAgeH: numOrNull(m.bulletinAgeH),
    recentBulletins: (Array.isArray(m.recentBulletins) ? m.recentBulletins : []).slice(0, 7).map(r => ({ date: date(r.date), url: httpUrl(r.url) })),
    trend: (Array.isArray(m.trend) ? m.trend : []).slice(-MAX_TREND).map(t => ({ date: date(t.date), aircraft: numOrNull(t.aircraft), medianLineCross: numOrNull(t.medianLineCross), ships: numOrNull(t.ships) })),
    stats: {
      daysWithData: num(m.stats?.daysWithData),
      aircraft30d: num(m.stats?.aircraft30d),
      medianCross30d: num(m.stats?.medianCross30d),
      avgAircraft: numOrNull(m.stats?.avgAircraft),
      maxAircraft: numOrNull(m.stats?.maxAircraft),
      maxAircraftDate: date(m.stats?.maxAircraftDate),
      avgShips: numOrNull(m.stats?.avgShips),
    },
    skyfaring: m.skyfaring ? { siteUrl: httpUrl(m.skyfaring.siteUrl), csvUrl: httpUrl(m.skyfaring.csvUrl), licenseUrl: httpUrl(m.skyfaring.licenseUrl), latestDate: date(m.skyfaring.latestDate), rows: num(m.skyfaring.rows) } : null,
    sectors: (Array.isArray(m.sectors) ? m.sectors : []).slice(0, 6).map(s => ({ key: str(s.key, 12), label: str(s.label, 16), lat: coord(s.lat, 90), lon: coord(s.lon, 180), named: Boolean(s.named) })),
    disclaimer: strList(m.disclaimer, 6, 240),
  };
}

function trimIncident(r) {
  return {
    id: str(r.id, 40),
    title: str(r.title, 160),
    url: httpUrl(r.url),
    published: iso(r.published),
    kind: str(r.kind, 30),
    kindLabel: str(r.kindLabel, 40),
    hulls: strList(r.hulls, 12, 8),
    vesselCount: numOrNull(r.vesselCount),
    area: r.area ? { key: str(r.area.key, 12), en: str(r.area.en, 24), zh: str(r.area.zh, 8), lat: coord(r.area.lat, 90), lon: coord(r.area.lon, 180), radiusKm: numOrNull(r.area.radiusKm) } : null,
    entryTime: clock(r.entryTime),
    exitTime: clock(r.exitTime),
    photoUrl: httpUrl(r.photoUrl),
    excerpt: str(r.excerpt, 280),
    gloss: str(r.gloss, 160),
    partial: Boolean(r.partial),
    problems: strList(r.problems, 4, 60),
  };
}

export function trimCga(c = {}) {
  return {
    source: 'TaiwanCGA',
    status: health(c),
    stale: Boolean(c.stale),
    error: c.error ? str(c.error, 200) : null,
    problems: strList(c.problems, 8, 160),
    provider: str(c.provider, 80),
    siteUrl: httpUrl(c.siteUrl),
    feedUrl: httpUrl(c.feedUrl),
    licenseUrl: httpUrl(c.licenseUrl),
    fetchedAt: iso(c.fetchedAt),
    cacheAgeH: numOrNull(c.cacheAgeH),
    feedItems: num(c.feedItems),
    latestPublished: iso(c.latestPublished),
    latestAgeH: numOrNull(c.latestAgeH),
    stats: {
      total: num(c.stats?.total),
      last7d: num(c.stats?.last7d),
      last30d: num(c.stats?.last30d),
      ccgIntrusions30d: num(c.stats?.ccgIntrusions30d),
      distinctHulls30d: num(c.stats?.distinctHulls30d),
      byArea: counts(c.stats?.byArea),
      byKind: counts(c.stats?.byKind),
    },
    incidents: (Array.isArray(c.records) ? c.records : []).slice(0, MAX_INCIDENTS).map(trimIncident),
    disclaimer: strList(c.disclaimer, 6, 240),
  };
}

export function trimNews(n = {}) {
  return {
    source: 'TaiwanNews',
    status: health(n),
    stale: Boolean(n.stale),
    error: n.error ? str(n.error, 200) : null,
    problems: strList(n.problems, 4, 160),
    fetchedAt: iso(n.fetchedAt),
    feeds: (Array.isArray(n.feeds) ? n.feeds : []).slice(0, 4).map(f => ({ key: str(f.key, 16), name: str(f.name, 40), siteUrl: httpUrl(f.siteUrl), status: health(f), feedItems: num(f.feedItems), kept: num(f.kept), latestPublished: iso(f.latestPublished), latestAgeH: numOrNull(f.latestAgeH) })),
    headlines: (Array.isArray(n.headlines) ? n.headlines : []).slice(0, MAX_HEADLINES).map(h => ({ title: str(h.title, 160), url: httpUrl(h.url), published: iso(h.published), outlet: str(h.outlet, 40), feed: str(h.feed, 16) })),
    disclaimer: strList(n.disclaimer, 4, 240),
  };
}

export function trimGca(g = {}) {
  return {
    source: 'GCATaiwan',
    status: health(g),
    stale: Boolean(g.stale),
    error: g.error ? str(g.error, 200) : null,
    problems: strList(g.problems, 6, 160),
    provider: str(g.provider, 60),
    siteUrl: httpUrl(g.siteUrl),
    license: str(g.license, 20),
    licenseUrl: httpUrl(g.licenseUrl),
    attribution: str(g.attribution, 120),
    fetchedAt: iso(g.fetchedAt),
    cacheAgeH: numOrNull(g.cacheAgeH),
    feedRecords: num(g.feedRecords),
    keptRecords: num(g.keptRecords),
    latestPublished: iso(g.latestPublished),
    stats: { shown: num(g.stats?.shown), placed: num(g.stats?.placed), countryLevel: num(g.stats?.countryLevel), bySide: counts(g.stats?.bySide, 4), bySource: counts(g.stats?.bySource) },
    records: (Array.isArray(g.records) ? g.records : []).slice(0, MAX_GCA).map(r => ({
      id: r.id ? str(r.id, 40) : null,
      title: str(r.title, 160),
      summary: str(r.summary, 220),
      source: str(r.source, 40),
      url: httpUrl(r.url),
      published: iso(r.published),
      side: ['china', 'taiwan'].includes(r.side) ? r.side : 'unknown',
      locationName: r.locationName ? str(r.locationName, 60) : null,
      lat: coord(r.lat, 90),
      lon: coord(r.lon, 180),
      locationPrecision: ['named', 'region', 'country'].includes(r.locationPrecision) ? r.locationPrecision : 'none',
    })),
    disclaimer: strList(g.disclaimer, 6, 240),
  };
}

export function trimMarkets(p = {}) {
  return {
    source: 'TaiwanMarkets',
    status: health(p),
    stale: Boolean(p.stale),
    error: p.error ? str(p.error, 200) : null,
    problems: strList(p.problems, 6, 160),
    provider: str(p.provider, 40),
    fetchedAt: iso(p.fetchedAt),
    markets: (Array.isArray(p.markets) ? p.markets : []).slice(0, MAX_MARKETS).map(m => ({
      slug: str(m.slug, 80),
      kind: ['invasion', 'blockade', 'clash'].includes(m.kind) ? m.kind : 'other',
      horizon: date(m.horizon),
      question: str(m.question, 160),
      impliedProbability: numOrNull(m.impliedProbability),
      change24h: num(m.change24h),
      volume24hr: num(m.volume24hr),
      totalVolume: num(m.totalVolume),
      liquidity: numOrNull(m.liquidity),
      endDate: iso(m.endDate),
      active: Boolean(m.active),
      url: httpUrl(m.url),
    })),
    summary: {
      invasionCurve: (Array.isArray(p.summary?.invasionCurve) ? p.summary.invasionCurve : []).slice(0, 6).map(x => ({ horizon: date(x.horizon), impliedProbability: numOrNull(x.impliedProbability) })),
      blockade: numOrNull(p.summary?.blockade),
      clash: numOrNull(p.summary?.clash),
    },
    disclaimer: strList(p.disclaimer, 4, 240),
  };
}

// Existing CRUCIX theater signals, reused rather than re-derived. `V2` is the synthesized dashboard
// payload (air / adsbMilitary / carriers / gdelt already trimmed by inject.mjs).
export function theaterSignals(V2 = {}) {
  const air = Array.isArray(V2.air) ? V2.air : [];
  const strait = air.find(a => a.region === 'Taiwan Strait') || {};
  const scs = air.find(a => a.region === 'South China Sea') || {};
  const top = (r) => (Array.isArray(r.top) ? r.top : []).slice(0, 5).map(t => [str(t[0], 24), num(t[1])]);
  const cnTracks = (r) => (Array.isArray(r.tracks) ? r.tracks : []).filter(t => /china/i.test(String(t.country || ''))).length;
  // Western-Pacific box: airframes whose position is in theater, regardless of operator.
  const inTheater = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat > 5 && lat < 45 && lon > 105 && lon < 150;
  const cats = V2.adsbMilitary?.categories || {};
  const isr = [...(Array.isArray(cats.reconnaissance) ? cats.reconnaissance : []), ...(Array.isArray(cats.tankers) ? cats.tankers : []), ...(Array.isArray(cats.bombers) ? cats.bombers : [])]
    .filter(a => inTheater(a.lat, a.lon))
    .slice(0, 12)
    .map(a => ({ callsign: str(a.callsign, 12), type: str(a.type, 24), country: str(a.country, 24), lat: coord(a.lat, 90), lon: coord(a.lon, 180) }));
  const carriers = (Array.isArray(V2.carriers?.carriers) ? V2.carriers.carriers : [])
    .filter(c => inTheater(c.lat, c.lng))
    .slice(0, 8)
    .map(c => ({ hull: str(c.hull, 12), name: str(c.name, 40), type: str(c.type, 24), desc: str(c.desc, 120), estimated: Boolean(c.estimated), source: str(c.source, 40), lat: coord(c.lat, 90), lon: coord(c.lng, 180) }));
  const meta = V2.airMeta || {};
  return {
    prcTension: prcTension(V2),
    strait: { total: num(strait.total), top: top(strait), chinaTracks: cnTracks(strait) },
    scs: { total: num(scs.total), top: top(scs), chinaTracks: cnTracks(scs) },
    air: { source: str(meta.source, 40), fallback: Boolean(meta.fallback), status: str(meta.status, 24) || null, timestamp: iso(meta.dataTimestamp || meta.timestamp) },
    adsbMilitary: { status: str(V2.adsbMilitary?.status, 24), total: num(V2.adsbMilitary?.totalMilitary) },
    isr,
    carriers,
  };
}

export function buildTaiwanView(sources = {}, V2 = {}) {
  const mnd = trimMnd(sources.TaiwanMND || {});
  const cga = trimCga(sources.TaiwanCGA || {});
  const news = trimNews(sources.TaiwanNews || {});
  const gca = trimGca(sources.GCATaiwan || {});
  const markets = trimMarkets(sources.TaiwanMarkets || {});
  const parts = { mnd: mnd.status, cga: cga.status, news: news.status, gca: gca.status, markets: markets.status };
  const liveish = Object.values(parts).filter(s => s === 'live' || s === 'limited' || s === 'stale').length;
  const status = liveish === 0 ? 'unavailable' : Object.values(parts).every(s => s === 'live') ? 'live' : 'limited';
  return {
    source: 'Taiwan',
    status,
    parts,
    mnd,
    cga,
    news,
    gca,
    markets,
    signals: theaterSignals(V2),
    linkOuts: LINK_OUTS,
  };
}

// Geometry for the theater map (served from /api/taiwan/geo). Every feature carries a precision
// class so the client draws it as a badge / circle / point accordingly, never as a track.
export function buildTaiwanGeo(sources = {}) {
  const features = [];
  const mnd = sources.TaiwanMND || {};
  for (const s of Array.isArray(mnd.sectors) ? mnd.sectors : []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    features.push({
      type: 'mnd-adiz', precision: 'sector', key: str(s.key, 12), label: str(s.label, 16), lat: s.lat, lon: s.lon,
      named: Boolean(s.named), date: date(mnd.bulletin?.publishedDate), aircraft: numOrNull(mnd.bulletin?.aircraft), adizEntries: numOrNull(mnd.bulletin?.adizEntries),
    });
  }
  const cga = sources.TaiwanCGA || {};
  for (const r of (Array.isArray(cga.records) ? cga.records : []).slice(0, MAX_INCIDENTS)) {
    if (!r.area || !Number.isFinite(r.area.lat) || !Number.isFinite(r.area.lon)) continue;
    features.push({
      type: 'cga-incident', precision: 'area', id: str(r.id, 40), lat: r.area.lat, lon: r.area.lon, radiusKm: numOrNull(r.area.radiusKm),
      area: str(r.area.en, 24), kind: str(r.kind, 30), kindLabel: str(r.kindLabel, 40), title: str(r.title, 160), gloss: str(r.gloss, 160),
      hulls: strList(r.hulls, 12, 8), vesselCount: numOrNull(r.vesselCount), published: iso(r.published), url: httpUrl(r.url), partial: Boolean(r.partial),
    });
  }
  const gca = sources.GCATaiwan || {};
  for (const r of (Array.isArray(gca.records) ? gca.records : []).slice(0, MAX_GCA)) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || r.locationPrecision === 'country' || r.locationPrecision === 'none') continue;
    features.push({
      type: 'gca-taiwan', precision: r.locationPrecision === 'named' ? 'named' : 'region', lat: r.lat, lon: r.lon,
      title: str(r.title, 160), source: str(r.source, 40), url: httpUrl(r.url), published: iso(r.published), locationName: r.locationName ? str(r.locationName, 60) : null,
    });
  }
  return { generatedAt: new Date().toISOString(), count: features.length, features, attribution: gca.attribution ? str(gca.attribution, 120) : null };
}
