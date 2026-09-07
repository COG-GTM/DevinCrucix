// Narco dashboard view model: trims the pipeline output (runs/narco/events.json) plus the DOJ / OFAC
// sweep results into a bounded payload for /api/data and /api/narco. Every string is length-bounded
// here and still HTML-escaped by the dashboard before insertion. Current (last 30 days) and historical
// (31–90 days) clusters are flagged separately so the UI never presents an old event as fresh.
import { CONFIDENCE } from './events.mjs';
import { EVENT_TYPE_LABELS } from './extract.mjs';
import { DISTRICTS, CATEGORIES } from '../../apis/sources/doj.mjs';

export const MAX_EVENTS = 150;
export const MAX_DOJ = 40;
export const MAX_SANCTIONS = 40;
export const MAX_PER_LIST = 6;

// Sweep sources that feed the Homeland / Narco page, in the order the source panel shows them.
export const NARCO_SOURCES = [
  { name: 'BorderNews', feed: 'borderlandbeat', label: 'Borderland Beat', kind: 'citizen aggregator (RSS)', role: 'cartel-violence reporting; unverified, cited sources preserved' },
  { name: 'BorderNews', feed: 'elpasomatters', label: 'El Paso Matters', kind: 'nonprofit newsroom (RSS)', role: 'El Paso / Juárez border reporting; CC BY-ND, attribution required' },
  { name: 'BorderNews', feed: 'fronterasdesk', label: 'Fronteras Desk (KJZZ)', kind: 'public radio (RSS)', role: 'Arizona–Sonora border reporting' },
  { name: 'DOJ', label: 'DOJ press releases', kind: 'official (Open Data API)', role: `${DISTRICTS.length} south-west border U.S. Attorney districts` },
  { name: 'OFACNarco', label: 'OFAC SDN (narco programs)', kind: 'official (XML list)', role: 'sanctioned people / entities matched against event names' },
  { name: 'DataInt', label: 'DataInt', kind: 'commercial', role: 'curated event alerts — licence required, not scraped' },
  { name: 'Lantia', label: 'Lantia Intelligence', kind: 'commercial', role: 'cartel presence by municipality — licence required, not scraped' },
];

const str = (v, n) => String(v ?? '').substring(0, n);
const num = (v) => (Number.isFinite(v) ? v : 0);
const httpUrl = (raw) => {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, 500) : null; } catch { return null; }
};
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const boundedTally = (m, n = 40) => Object.fromEntries(Object.entries(m || {}).slice(0, n).map(([k, v]) => [str(k, 60), num(v)]));

function compactSanction(s) {
  return {
    query: str(s.query, 80), uid: str(s.uid, 20), name: str(s.name, 120), type: str(s.type, 12),
    programs: (s.programs || []).slice(0, 6).map(p => str(p, 30)), strength: str(s.strength, 10), matchedName: str(s.matchedName, 120),
    countries: (s.countries || []).slice(0, 4).map(c => str(c, 40)), url: httpUrl(s.url),
  };
}

function compactGroupDesignation(g) {
  return { orgId: str(g.orgId, 40), uid: str(g.uid, 20), name: str(g.name, 120), programs: (g.programs || []).slice(0, 6).map(p => str(p, 30)), orgType: str(g.orgType, 20), url: httpUrl(g.url) };
}

function seizureSummary(sz = {}) {
  const parts = [];
  for (const d of (sz.drugs || []).slice(0, 4)) if (d.substance) parts.push(`${num(d.kg) ? `${Math.round(num(d.kg) * 10) / 10} kg` : num(d.units) ? `${num(d.units).toLocaleString('en-US')} ${str(d.unit || 'units', 12)}` : ''} ${str(d.substance, 30)}`.trim());
  if (num(sz.weapons)) parts.push(`${num(sz.weapons)} weapons`);
  if (num(sz.vehicles)) parts.push(`${num(sz.vehicles)} vehicles`);
  for (const c of (sz.cash || []).slice(0, 2)) if (num(c.amount)) parts.push(`${str(c.currency || 'USD', 4)} ${num(c.amount).toLocaleString('en-US')}`);
  return parts.slice(0, 6).map(p => str(p, 60));
}

export function compactCluster(c, currentCut) {
  const loc = c.location || null;
  return {
    id: str(c.id, 40),
    type: str(c.eventType, 30),
    typeLabel: str(EVENT_TYPE_LABELS[c.eventType] || c.eventType, 40),
    types: (c.eventTypes || []).slice(0, 6).map(t => str(t, 30)),
    date: c.date ? str(c.date, 10) : null,
    dateRange: Array.isArray(c.dateRange) ? c.dateRange.slice(0, 2).map(d => str(d, 10)) : null,
    historical: !!(currentCut && c.date && c.date < currentCut),
    location: loc ? {
      country: str(loc.country, 2), state: str(loc.state, 40), municipality: loc.municipality ? str(loc.municipality, 60) : null,
      city: loc.city ? str(loc.city, 60) : null, precision: str(loc.precision, 12),
      lat: Number.isFinite(loc.lat) ? Math.round(loc.lat * 1e4) / 1e4 : null, lon: Number.isFinite(loc.lon) ? Math.round(loc.lon * 1e4) / 1e4 : null,
    } : null,
    cartels: (c.cartels || []).slice(0, MAX_PER_LIST).map(g => ({ id: str(g.orgId || g.id, 40), short: str(g.short || g.name, 40), implied: !!g.implied })),
    factions: (c.factions || []).slice(0, MAX_PER_LIST).map(g => ({ id: str(g.orgId || g.id, 40), short: str(g.short || g.name, 40), parent: g.parent ? str(g.parent, 40) : null })),
    people: (c.people || []).slice(0, MAX_PER_LIST).map(p => str(p.name, 80)),
    counts: { killed: num(c.counts?.killed), wounded: num(c.counts?.wounded), arrested: num(c.counts?.arrested), kidnapped: num(c.counts?.kidnapped) },
    seizures: seizureSummary(c.seizures),
    title: str(c.title, 200),
    excerpt: str(c.excerpt, 280),
    confidence: {
      grade: str(c.confidence?.grade, 1), independentSources: num(c.confidence?.independentSources), official: num(c.confidence?.official),
      media: num(c.confidence?.media), aggregator: num(c.confidence?.aggregator), citedOutlets: num(c.confidence?.citedOutlets),
    },
    sources: (c.records || []).slice(0, MAX_PER_LIST).map(r => ({
      outlet: str(r.outlet, 60), kind: str(r.sourceKind, 12), url: httpUrl(r.url), title: str(r.title, 160), publishedAt: iso(r.publishedAt),
    })),
    citedSources: (c.citedSources || []).filter(s => s.kind !== 'mention').slice(0, MAX_PER_LIST).map(s => ({ name: str(s.name, 80), url: httpUrl(s.url) })),
    sanctions: {
      people: (c.sanctions?.people || []).slice(0, 4).map(compactSanction),
      groups: (c.sanctions?.groups || []).slice(0, 4).map(compactGroupDesignation),
    },
  };
}

export function compactRelease(r) {
  return {
    id: str(r.id, 64), url: httpUrl(r.url), title: str(r.title, 200), teaser: str(r.teaser, 300), publishedAt: iso(r.publishedAt),
    district: { code: str(r.district?.code, 8), name: str(r.district?.name, 60) },
    categories: (r.categories || []).slice(0, 8).map(c => str(c, 30)),
    topics: (r.topics || []).slice(0, 6).map(t => str(t, 60)),
    dateline: r.dateline?.city ? str(r.dateline.city, 60) : null,
  };
}

function dojView(src) {
  const d = src || {};
  return {
    status: str(d.status || 'unavailable', 20),
    error: d.error ? str(d.error, 200) : null,
    note: d.note ? str(d.note, 200) : null,
    timestamp: d.timestamp || null,
    lastChanged: d.lastChanged || null,
    apiUrl: httpUrl(d.api?.url),
    pagesFetched: num(d.api?.pagesFetched), pagesRequested: num(d.api?.pagesRequested), releasesScanned: num(d.api?.releasesScanned),
    totalReleases: num(d.totalReleases), newThisSweep: num(d.newThisSweep),
    districts: DISTRICTS.map(x => ({ code: x.code, name: x.name, seat: x.seat, lat: x.lat, lon: x.lon })),
    categories: CATEGORIES.map(c => ({ id: c.id, label: c.label })),
    summary: d.summary ? { days: num(d.summary.days), watched: num(d.summary.watched), byDistrict: boundedTally(d.summary.byDistrict), byCategory: boundedTally(d.summary.byCategory) } : null,
    releases: (d.releases || []).slice(0, MAX_DOJ).map(compactRelease),
  };
}

function sanctionsView(src, clusters) {
  const o = src || {};
  const seen = new Set();
  const matches = [];
  for (const c of clusters) {
    for (const p of c.sanctions?.people || []) {
      const key = `${p.uid}|${p.query}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ ...compactSanction(p), eventId: str(c.id, 40), eventTitle: str(c.title, 120), eventDate: c.date ? str(c.date, 10) : null });
      if (matches.length >= MAX_SANCTIONS) break;
    }
    if (matches.length >= MAX_SANCTIONS) break;
  }
  const groups = Object.entries(o.designatedGroups || {}).slice(0, 40).map(([orgId, list]) => ({
    orgId: str(orgId, 40),
    entries: (list || []).slice(0, 6).map(compactGroupDesignation),
  }));
  return {
    status: str(o.status || 'unavailable', 20),
    error: o.error ? str(o.error, 200) : null,
    note: o.note ? str(o.note, 200) : null,
    timestamp: o.timestamp || null,
    listUrl: httpUrl(o.listUrl),
    programs: { narco: (o.programs?.narco || []).map(p => str(p, 30)), terror: (o.programs?.terror || []).map(p => str(p, 30)) },
    refresh: o.refresh ? { action: str(o.refresh.action, 20), hours: num(o.refresh.hours), lastChecked: o.refresh.lastChecked || null, lastRefreshed: o.refresh.lastRefreshed || null, listLastModified: o.refresh.listLastModified ? str(o.refresh.listLastModified, 40) : null } : null,
    summary: o.summary ? {
      entries: num(o.summary.entries), individuals: num(o.summary.individuals), entities: num(o.summary.entities), mexicoLinked: num(o.summary.mexicoLinked),
      byProgram: boundedTally(o.summary.byProgram), publishDate: str(o.summary.publishDate, 20), recordCount: num(o.summary.recordCount),
    } : null,
    designatedGroups: groups,
    matches,
  };
}

function commercialView(src, name) {
  const s = src || {};
  return { name, status: str(s.status || 'unavailable', 20), vendor: str(s.vendor, 60), message: str(s.message, 200), homepage: httpUrl(s.homepage), provides: str(s.provides, 160), access: str(s.access, 160) };
}

function feedRows(borderNews) {
  const feeds = borderNews?.feeds || [];
  return NARCO_SOURCES.filter(s => s.feed).map(s => {
    const f = feeds.find(x => x.id === s.feed) || null;
    return {
      id: s.feed, label: s.label, kind: s.kind, role: s.role,
      registered: !!f,
      status: f ? str(f.status, 20) : 'unregistered',
      reason: f?.reason ? str(f.reason, 120) : null,
      items: num(f?.items), newItems: num(f?.newItems), lastPolled: f?.lastPolled || null, lastChanged: f?.lastChanged || null,
      articleFetch: f?.articleFetch ? { attempted: num(f.articleFetch.attempted), ok: num(f.articleFetch.ok), blocked: num(f.articleFetch.blocked), robotsDisallowed: num(f.articleFetch.robotsDisallowed), paywalled: num(f.articleFetch.paywalled) } : null,
    };
  });
}

// pipeline: computeNarcoEvents() output (or null while the first sweep is running / when it failed)
// sources:  rawData.sources from the sweep (BorderNews, DOJ, OFACNarco, DataInt, Lantia)
export function buildNarcoView(pipeline, sources = {}, { error = null } = {}) {
  const p = pipeline || null;
  const clusters = Array.isArray(p?.clusters) ? p.clusters : [];
  const currentCut = p ? new Date(new Date(p.computedAt).getTime() - num(p.currentDays || 30) * 86_400_000).toISOString().slice(0, 10) : null;
  const events = clusters.slice(0, MAX_EVENTS).map(c => compactCluster(c, currentCut));
  return {
    status: p ? 'live' : error ? 'error' : 'pending',
    error: error ? str(error, 200) : null,
    schema: p ? str(p.schema, 40) : null,
    computedAt: p?.computedAt || null,
    durationMs: num(p?.durationMs),
    windowDays: num(p?.windowDays) || 90,
    currentDays: num(p?.currentDays) || 30,
    currentCut,
    inputs: p?.inputs ? {
      articles: num(p.inputs.articles), mexicoRelevantArticles: num(p.inputs.mexicoRelevantArticles), dojReleases: num(p.inputs.dojReleases),
      ofacIndexed: num(p.inputs.ofacIndexed), ofacPublishDate: p.inputs.ofacPublishDate ? str(p.inputs.ofacPublishDate, 20) : null,
    } : null,
    llm: p?.llm ? { used: num(p.llm.used), errors: num(p.llm.errors), skipped: p.llm.skipped ? str(p.llm.skipped, 40) : null } : null,
    records: num(p?.records),
    totals: p?.totals ? {
      clusters: num(p.totals.clusters), current: num(p.totals.current), historical: num(p.totals.historical),
      byGrade: boundedTally(p.totals.byGrade, 5), byType: boundedTally(p.totals.byType), byState: boundedTally(p.totals.byState),
      byCartel: boundedTally(p.totals.byCartel), sanctionsMatches: num(p.totals.sanctionsMatches), mapped: num(p.totals.mapped),
    } : null,
    legend: { confidence: CONFIDENCE, eventTypes: EVENT_TYPE_LABELS },
    events,
    doj: dojView(sources.DOJ),
    sanctions: sanctionsView(sources.OFACNarco, clusters),
    commercial: [commercialView(sources.DataInt, 'DataInt'), commercialView(sources.Lantia, 'Lantia')],
    feeds: feedRows(sources.BorderNews),
    sourceNames: [...new Set(NARCO_SOURCES.map(s => s.name))],
  };
}
