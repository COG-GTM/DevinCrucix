// Cartels page view model: trims the Cartels source result for the dashboard payload,
// attaches the START 2020 historical baseline, and pulls Mexico / Northern Triangle
// items out of the live feeds CRUCIX already polls (InSight Crime, Border Watch, GDELT).
// Geometry is never included here — the browser fetches /api/cartels/geo on demand.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = join(__dirname, '../config/cartels-baseline-2020.json');

const MAX_FEED_ITEMS = 24;
const MAX_ORGS = 32;
const MAX_LIST = 60;
const FEED_WINDOW_MS = 14 * 86400000;

// FIPS 10-4 codes used by GDELT for Mexico and the Northern Triangle
const REGION_FIPS = new Set(['MX', 'GT', 'HN', 'ES']);
const REGION_RE = /\b(mexic[oa]n?|m[eé]xico|cartel|c[aá]rtel|cjng|sinaloa|jalisco|michoac[aá]n|guanajuato|tamaulipas|chihuahua|sonora|guerrero|zacatecas|tijuana|ciudad ju[aá]rez|nuevo laredo|reynosa|matamoros|culiac[aá]n|narco\w*|huachicol|mencho|chapitos|mayiza|zambada|guzm[aá]n|noreste|los zetas|gulf cartel|colima|veracruz|oaxaca|chiapas|guatemala|honduras|el salvador|mara salvatrucha|ms-13|barrio 18|sheinbaum|sedena|guardia nacional|fgr)\b/i;

let _baseline = null;
export function loadBaseline(file = BASELINE_FILE) {
  if (_baseline && file === BASELINE_FILE) return _baseline;
  const b = JSON.parse(readFileSync(file, 'utf8'));
  if (file === BASELINE_FILE) _baseline = b;
  return b;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
// Feeds hand us titles with HTML entities still encoded; decode once so the dashboard's
// esc() does not double-escape them into visible "&#x2013;" noise.
const cp = (n, m) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
export const decodeEntities = (s) => String(s ?? '')
  .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => cp(parseInt(h, 16), m))
  .replace(/&#(\d{1,7});/g, (m, d) => cp(Number(d), m))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
const str = (v, n) => decodeEntities(v).substring(0, n);
const num = (v) => (Number.isFinite(v) ? v : 0);
const httpUrl = (raw) => {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
};
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export function isRegionText(text) { return REGION_RE.test(String(text || '')); }

// Pull Mexico / Northern-Triangle items from the feeds CRUCIX already polls. Every string is
// bounded here and still HTML-escaped again by the dashboard before insertion.
export function regionFeed({ insightCrime, borderNews, gdelt } = {}, now = Date.now()) {
  const items = [];
  for (const a of insightCrime?.articles || []) {
    const text = `${a.title || ''} ${a.description || ''} ${(a.categories || []).join(' ')}`;
    if (!isRegionText(text)) continue;
    items.push({ src: 'InSight Crime', title: str(a.title, 160), url: httpUrl(a.link), at: iso(a.date), tags: (a.entities || []).slice(0, 4).map(e => str(e, 40)) });
  }
  for (const a of borderNews?.articles || []) {
    const text = `${a.title || ''} ${a.excerpt || ''} ${(a.tags?.places || []).join(' ')}`;
    if (!isRegionText(text) && !(a.tags?.topics || []).includes('cartels')) continue;
    items.push({ src: str(a.outlet || 'Border Watch', 40), title: str(a.title, 160), url: httpUrl(a.canonicalUrl || a.url), at: iso(a.publishedAt || a.collectedAt), tags: (a.tags?.topics || []).slice(0, 4).map(t => str(t, 20)) });
  }
  for (const a of gdelt?.allArticles || []) {
    if (!REGION_FIPS.has(a.country) && !isRegionText(a.title)) continue;
    if (!isRegionText(`${a.title || ''} ${a.place || ''}`)) continue;
    items.push({ src: str(a.domain || 'GDELT', 40), title: str(a.title, 160), url: httpUrl(a.url), at: iso(a.date), tags: a.place ? [str(a.place, 40)] : [] });
  }
  const seen = new Set();
  return items
    .filter(i => i.title && (!i.at || now - Date.parse(i.at) <= FEED_WINDOW_MS))
    .filter(i => { const k = i.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, MAX_FEED_ITEMS);
}

export function trimCartels(c = {}) {
  const st = c.status || 'unavailable';
  return {
    source: 'Cartels',
    status: st,
    stale: Boolean(c.stale),
    error: c.error ? str(c.error, 200) : null,
    provider: str(c.provider, 80),
    siteUrl: httpUrl(c.siteUrl),
    mapId: str(c.mapId, 64),
    fetchedAt: c.fetchedAt || null,
    cacheAgeH: Number.isFinite(c.cacheAgeH) ? c.cacheAgeH : null,
    caveat: str(c.caveat, 300),
    docName: str(c.docName, 120),
    disclaimer: (Array.isArray(c.disclaimer) ? c.disclaimer : [c.disclaimer]).filter(Boolean).slice(0, 4).map(l => str(l, 300)),
    legend: (c.legend || []).slice(0, 24).map(l => ({ swatch: str(l.swatch, 40), text: str(l.text, 120) })),
    layerCounts: Object.fromEntries(Object.entries(c.layerCounts || {}).slice(0, 12).map(([k, v]) => [str(k, 20), num(v)])),
    featureCount: num(c.featureCount),
    polygonCount: num(c.polygonCount),
    pointCount: num(c.pointCount),
    lineCount: num(c.lineCount),
    influenceKm2: num(c.influenceKm2),
    disputedKm2: num(c.disputedKm2),
    orgCount: num(c.orgCount),
    orgs: (c.orgs || []).slice(0, MAX_ORGS).map(o => ({
      id: str(o.id, 32), label: str(o.label, 80), short: str(o.short, 32), color: str(o.color, 12),
      polygons: num(o.polygons), areaKm2: Math.round(num(o.areaKm2)), pins: num(o.pins), wars: num(o.wars), strongholds: num(o.strongholds), activity: num(o.activity),
    })),
    wars: (c.wars || []).slice(0, MAX_LIST).map(w => ({ id: str(w.id, 12), name: str(w.name, 200), lat: w.lat, lon: w.lon, involved: (w.involved || []).slice(0, 6), date: w.date || null })),
    truces: (c.truces || []).slice(0, 12).map(t => ({ id: str(t.id, 12), name: str(t.name, 240), lat: t.lat, lon: t.lon, involved: (t.involved || []).slice(0, 6) })),
    alliances: (c.alliances || []).slice(0, 12).map(a => ({ id: str(a.id, 12), name: str(a.name, 200), desc: str(a.desc, 300), involved: (a.involved || []).slice(0, 6), color: str(a.color, 12) })),
    usActivity: (c.usActivity || []).slice(0, 40).map(u => ({ id: str(u.id, 12), name: str(u.name, 120), lat: u.lat, lon: u.lon, involved: (u.involved || []).slice(0, 4) })),
    recent: (c.recent || []).slice(0, 25).map(r => ({ id: str(r.id, 12), date: r.date || null, layer: str(r.layer, 20), name: str(r.name, 200), lat: r.lat, lon: r.lon, org: str(r.org, 32), involved: (r.involved || []).slice(0, 6), link: httpUrl(r.link) })),
    latestMention: c.latestMention || null,
    activityLast30d: num(c.activityLast30d),
    signals: (c.signals || []).slice(0, 6).map(s => ({ kind: str(s.kind, 20), text: str(s.text, 200) })),
  };
}

export function trimBaseline(b) {
  if (!b) return null;
  return {
    provider: str(b.provider, 160),
    series: str(b.series, 80),
    asOf: str(b.asOf, 10),
    seriesUrl: httpUrl(b.seriesUrl),
    caveat: str(b._comment, 600),
    briefs: (b.briefs || []).map(x => ({ id: str(x.id, 24), title: str(x.title, 120), url: httpUrl(x.url), keyPoints: (x.keyPoints || []).slice(0, 8).map(k => str(k, 300)) })),
    densityClasses: Object.fromEntries(Object.entries(b.densityClasses || {}).map(([k, v]) => [str(k, 8), { label: str(v.label, 60), rank: num(v.rank) }])),
    states: (b.states || []).map(s => ({ name: str(s.name, 40), lat: s.lat, lon: s.lon, density: s.density ? str(s.density, 8) : null, cjng: Boolean(s.cjng), cjngBase: Boolean(s.cjngBase), note: s.note ? str(s.note, 160) : undefined })),
    cities: (b.cities || []).map(c => ({ name: str(c.name, 60), lat: c.lat, lon: c.lon })),
    portsIntoMexico: (b.portsIntoMexico || []).map(c => ({ name: str(c.name, 60), lat: c.lat, lon: c.lon })),
    pointsOfEntryUS: (b.pointsOfEntryUS || []).map(c => ({ name: str(c.name, 60), lat: c.lat, lon: c.lon })),
    flows: (b.flows || []).map(f => ({ name: str(f.name, 80), path: (f.path || []).slice(0, 12).map(p => [p[0], p[1]]) })),
    cjngTimeline: (b.cjngTimeline || []).map(e => ({ n: num(e.n), date: str(e.date, 12), place: str(e.place, 60), lat: e.lat, lon: e.lon, text: str(e.text, 240) })),
    hotspots: (b.hotspots || []).map(h => ({ id: str(h.id, 24), name: str(h.name, 80), brief: str(h.brief, 24), lat: h.lat, lon: h.lon, radiusKm: num(h.radiusKm), actors: (h.actors || []).slice(0, 8).map(a => str(a, 40)), text: str(h.text, 400) })),
  };
}

export function buildCartelsView(sources = {}, { now = Date.now(), baseline = loadBaseline() } = {}) {
  return {
    ...trimCartels(sources.Cartels || {}),
    baseline: trimBaseline(baseline),
    feed: regionFeed({ insightCrime: sources.InSightCrime, borderNews: sources.BorderNews, gdelt: sources.GDELT }, now),
  };
}
