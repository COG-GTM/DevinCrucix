// Iran War Live dashboard view model: the compact, bounded slice of the IranWarLive adapter that
// goes into the client payload, plus a corroboration feed pulled from sources CRUCIX already polls
// (GDELT articles, ACLED events) so the operator can see whether anything independent agrees.
// Geometry stays out of the payload (/api/iranwar/geo on demand). Every string here is third-party
// text: bounded server-side, HTML-escaped again by the dashboard before insertion.

const MAX_EVENTS = 60;
const MAX_GROUND = 40;
const MAX_ACTORS = 48;
const MAX_LIST = 40;
const MAX_CORROBORATION = 24;
const CORROBORATION_WINDOW_MS = 72 * 3600000;

// GDELT FIPS codes for the theater + a text fallback for articles without a geocoded country.
const THEATER_FIPS = new Set(['IR', 'IS', 'LE', 'IZ', 'SY', 'YM', 'GZ', 'WE', 'SA', 'AE', 'QA', 'BA', 'KU', 'MU', 'JO']);
const THEATER_RE = /\b(iran|iranian|irgc|tehran|isfahan|israel|israeli|idf|hezbollah|houthi|hormuz|red sea|bab[- ]el[- ]mandeb|lebanon|beirut|gaza|iraq|baghdad|syria|damascus|yemen|sanaa|gulf state|persian gulf|centcom|khamenei|netanyahu)\b/i;
const ACLED_COUNTRIES = /^(iran|israel|lebanon|iraq|syria|yemen|palestine|saudi arabia|united arab emirates|qatar|bahrain|kuwait|oman|jordan)$/i;

const str = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const num = (v) => (Number.isFinite(v) ? v : 0);
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const coord = (v, lim) => (Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
const httpUrl = (raw) => {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
};
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const counts = (o, maxKeys = 12) => Object.fromEntries(Object.entries(o || {}).slice(0, maxKeys).map(([k, v]) => [str(k, 24), num(v)]));

export function isTheaterText(text) { return THEATER_RE.test(String(text || '')); }

function trimEvent(e) {
  return {
    id: str(e.id, 40),
    at: iso(e.at),
    lat: coord(e.lat, 90),
    lon: coord(e.lon, 180),
    type: str(e.type, 40),
    kind: str(e.kind, 12),
    text: str(e.text, 240),
    location: e.location ? str(e.location, 100) : null,
    casualties: numOrNull(e.casualties),
    confidence: str(e.confidence, 10),
    verifiedBy: e.verifiedBy ? str(e.verifiedBy, 60) : null,
    sourceUrl: httpUrl(e.sourceUrl),
    sourceHost: e.sourceHost ? str(e.sourceHost, 60) : null,
    inFeed: Boolean(e.inFeed),
  };
}

function trimGround(g) {
  return {
    ...trimEvent(g),
    units: g.units ? str(g.units, 80) : null,
    movement: g.movement ? str(g.movement, 40) : null,
    control: g.control ? str(g.control, 40) : null,
  };
}

// Independent items about the theater from feeds CRUCIX already runs. Not proof that IranWarLive
// is right — just what else is reporting in the same window.
export function corroboration({ gdelt, acled } = {}, now = Date.now()) {
  const items = [];
  for (const a of gdelt?.allArticles || []) {
    const text = `${a.title || ''} ${a.place || ''}`;
    if (!THEATER_FIPS.has(a.country) && !isTheaterText(text)) continue;
    if (!isTheaterText(text)) continue;
    items.push({ src: str(a.domain || 'GDELT', 40), via: 'GDELT', title: str(a.title, 160), url: httpUrl(a.url), at: iso(a.date), place: a.place ? str(a.place, 40) : null });
  }
  for (const e of acled?.deadliestEvents || []) {
    if (!ACLED_COUNTRIES.test(String(e.country || ''))) continue;
    items.push({ src: 'ACLED', via: 'ACLED', title: str(`${e.type || 'Event'} — ${e.location || ''}, ${e.country || ''} · ${num(e.fatalities)} fatalities`, 160), url: null, at: iso(e.date), place: e.location ? str(e.location, 40) : null });
  }
  const seen = new Set();
  return items
    .filter(i => i.title && (!i.at || now - Date.parse(i.at) <= CORROBORATION_WINDOW_MS))
    .filter(i => { const k = i.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, MAX_CORROBORATION);
}

export function trimIranWar(w = {}) {
  const c = w.counts || {};
  const cas = w.casualties || {};
  return {
    source: 'IranWarLive',
    status: w.status || 'unavailable',
    stale: Boolean(w.stale),
    error: w.error ? str(w.error, 200) : null,
    problems: (Array.isArray(w.problems) ? w.problems : []).slice(0, 8).map(p => str(p, 160)),
    provider: str(w.provider, 80),
    siteUrl: httpUrl(w.siteUrl),
    licenseUrl: httpUrl(w.licenseUrl),
    feedUrl: httpUrl(w.feedUrl),
    fetchedAt: iso(w.fetchedAt),
    cacheAgeH: numOrNull(w.cacheAgeH),
    feedUpdatedAt: iso(w.feedUpdatedAt),
    feedVersion: w.feedVersion ? str(w.feedVersion, 12) : null,
    feedWindowHours: numOrNull(w.feedWindowHours),
    feedAgeH: numOrNull(w.feedAgeH),
    latestEventAt: iso(w.latestEventAt),
    parts: Object.fromEntries(Object.entries(w.parts || {}).slice(0, 8).map(([k, v]) => [str(k, 12), v === 'ok' ? 'ok' : 'error'])),
    counts: {
      events: num(c.events),
      theaterEvents: num(c.theaterEvents),
      outOfTheater: num(c.outOfTheater),
      events24h: num(c.events24h),
      events48h: num(c.events48h),
      events7d: num(c.events7d),
      casualties48h: num(c.casualties48h),
      casualties7d: num(c.casualties7d),
      byKind48h: counts(c.byKind48h),
      byConfidence48h: counts(c.byConfidence48h),
      ground: num(c.ground),
      ground48h: num(c.ground48h),
      groundControl: counts(c.groundControl),
      airspaceRegions: num(c.airspaceRegions),
      airspaceClosed: num(c.airspaceClosed),
      airspaceRestricted: num(c.airspaceRestricted),
      posturing: num(c.posturing),
      actors: num(c.actors),
    },
    casualties: { military: num(cas.military), civilian: num(cas.civilian), actors: num(cas.actors) },
    actors: (w.actors || []).slice(0, MAX_ACTORS).map(a => ({
      name: str(a.name, 60),
      alliance: a.alliance ? str(a.alliance, 40) : null,
      troops: numOrNull(a.troops),
      aircraft: numOrNull(a.aircraft),
      armor: numOrNull(a.armor),
      militaryDeaths: numOrNull(a.militaryDeaths),
      civilianDeaths: numOrNull(a.civilianDeaths),
      status: a.status ? str(a.status, 40) : null,
    })),
    airspace: (w.airspace || []).slice(0, MAX_LIST).map(a => ({
      at: iso(a.at), region: str(a.region, 80), status: str(a.status, 120), level: str(a.level, 12), sourceUrl: httpUrl(a.sourceUrl), sourceHost: a.sourceHost ? str(a.sourceHost, 60) : null,
    })),
    posturing: (w.posturing || []).slice(0, MAX_LIST).map(p => ({
      at: iso(p.at), actor: str(p.actor, 60), stance: p.stance ? str(p.stance, 40) : null, text: str(p.text, 240), sourceUrl: httpUrl(p.sourceUrl), sourceHost: p.sourceHost ? str(p.sourceHost, 60) : null,
    })),
    events: (w.events || []).slice(0, MAX_EVENTS).map(trimEvent),
    groundEvents: (w.groundEvents || []).slice(0, MAX_GROUND).map(trimGround),
    signals: (w.signals || []).slice(0, 6).map(s => ({ kind: str(s.kind, 20), text: str(s.text, 200) })),
    disclaimer: (Array.isArray(w.disclaimer) ? w.disclaimer : [w.disclaimer]).filter(Boolean).slice(0, 4).map(l => str(l, 300)),
  };
}

export function buildIranWarView(sources = {}, now = Date.now()) {
  const view = trimIranWar(sources.IranWarLive || {});
  view.corroboration = corroboration({ gdelt: sources.GDELT, acled: sources.ACLED }, now);
  return view;
}
