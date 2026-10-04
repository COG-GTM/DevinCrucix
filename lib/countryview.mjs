// Country Home Page view model: one bounded payload per country built from the adapters the country
// config names (official open data, country wires, InSight Crime country feed + group profiles, OVCS,
// CII, ACLED) plus the honest health / link-out rows. Geometry (ADM1 polygons, choropleth values,
// place anchors, historical points) goes out separately via /api/country/:cc/geo. Every string is
// third-party text: bounded here, HTML-escaped again by the dashboard before insertion.

import { COUNTRY_IDS, countryConfig, countryAdm1 } from './countryconfig.mjs';

const MAX_FEED = 60;
const MAX_IC = 15;
const MAX_PROFILES = 24;
const MAX_CAT_ROWS = 10;

const str = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const num = (v) => (Number.isFinite(v) ? v : 0);
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const coord = (v, lim) => (Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
const httpUrl = (raw) => { if (!raw) return null; try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const month = (v) => (/^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const strList = (a, max, len) => (Array.isArray(a) ? a : []).slice(0, max).map(x => str(x, len));
const counts = (o, maxKeys = 16) => Object.fromEntries(Object.entries(o || {}).slice(0, maxKeys).map(([k, v]) => [str(k, 32), num(v)]));

// Health in the vocabulary the Sources tab already uses.
const STATUSES = new Set(['live', 'limited', 'stale', 'empty', 'unavailable', 'no-key', 'link-out', 'off']);
export function health(s) {
  if (!s || typeof s !== 'object') return 'unavailable';
  if (s.status === 'no_credentials' || s.status === 'no_key' || s.status === 'no_api_key') return 'no-key';
  if (s.status === 'cached') return 'stale';
  if (STATUSES.has(s.status)) return s.status;
  return 'unavailable';
}

function trimCategory(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    name: str(c.name, 80), month: month(c.month), unit: str(c.unit, 32), dataset: str(c.dataset, 12),
    total: numOrNull(c.total), distinct: numOrNull(c.distinct),
    rows: (Array.isArray(c.rows) ? c.rows : []).slice(0, MAX_CAT_ROWS).map(r => ({ label: str(r.label, 80), article: r.article ? str(r.article, 6) : null, n: num(r.n) })),
  };
}

export function trimOpenData(o) {
  if (!o || typeof o !== 'object') return null;
  const b = o.bogota || {}, n = o.national || {}, tl = b.theftLatest;
  return {
    source: 'ColombiaOpenData',
    status: health(o),
    stale: Boolean(o.stale),
    cacheAgeH: numOrNull(o.cacheAgeH),
    fetchedAt: iso(o.fetchedAt || o.timestamp),
    error: o.error ? str(o.error, 160) : null,
    attribution: str(o.attribution, 80),
    license: str(o.license, 80),
    portal: httpUrl(o.portal),
    asOf: { theftMonth: month(o.asOf?.theftMonth), bogotaMonth: month(o.asOf?.bogotaMonth) },
    focus: {
      code: str(b.code, 8), name: str(b.name, 40),
      theftMonthly: (Array.isArray(b.theftMonthly) ? b.theftMonthly : []).slice(-14).map(m => ({ month: month(m.month), n: num(m.n) })).filter(m => m.month),
      theftLatest: tl ? { month: month(tl.month), n: num(tl.n), prevMonth: month(tl.prevMonth), prevN: numOrNull(tl.prevN), momPct: numOrNull(tl.momPct), yoyMonth: month(tl.yoyMonth), yoyN: numOrNull(tl.yoyN), yoyPct: numOrNull(tl.yoyPct) } : null,
      categories: Object.fromEntries(Object.entries(b.categories || {}).slice(0, 8).map(([k, v]) => [str(k, 16), trimCategory(v)])),
    },
    national: {
      month: month(n.month), total: numOrNull(n.total),
      byDept: (Array.isArray(n.byDept) ? n.byDept : []).slice(0, 40).map(d => ({ code: str(d.code, 4), iso: d.iso ? str(d.iso, 8) : null, name: str(d.name, 60), n: num(d.n) })),
      topMunicipios: (Array.isArray(n.topMunicipios) ? n.topMunicipios : []).slice(0, 12).map(m => ({ code: str(m.code, 6), name: str(m.name, 60), dept: str(m.dept, 60), n: num(m.n) })),
    },
    datasets: (Array.isArray(o.datasets) ? o.datasets : []).slice(0, 8).map(d => ({ key: str(d.key, 16), id: str(d.id, 12), name: str(d.name, 80), url: httpUrl(d.url), status: str(d.status, 16), month: month(d.month), rows: num(d.rows), error: d.error ? str(d.error, 160) : null })),
    problems: strList(o.problems, 6, 200),
    disclaimer: strList(o.disclaimer, 4, 240),
  };
}

function trimItem(i) {
  return {
    id: str(i.id, 16), title: str(i.title, 160), url: httpUrl(i.url), published: iso(i.published),
    outlet: str(i.outlet, 40), feed: str(i.feed, 24), tier: i.tier ? str(i.tier, 24) : null, scope: i.scope ? str(i.scope, 16) : null,
    excerpt: str(i.excerpt, 200), topics: strList(i.topics, 6, 16),
    places: (Array.isArray(i.places) ? i.places : []).slice(0, 4).map(p => ({ key: str(p.key, 32), name: str(p.name, 40), level: str(p.level, 16) })),
    groups: strList(i.groups, 4, 40),
  };
}

export function trimNews(n) {
  if (!n || typeof n !== 'object') return null;
  return {
    source: str(n.source, 24),
    status: health(n),
    stale: Boolean(n.stale),
    cacheAgeH: numOrNull(n.cacheAgeH),
    fetchedAt: iso(n.fetchedAt || n.timestamp),
    error: n.error ? str(n.error, 160) : null,
    count: num(n.count),
    feeds: (Array.isArray(n.feeds) ? n.feeds : []).slice(0, 8).map(f => ({ key: str(f.key, 24), name: str(f.name, 40), type: str(f.type, 8), siteUrl: httpUrl(f.siteUrl), tier: f.tier ? str(f.tier, 24) : null, scope: f.scope ? str(f.scope, 16) : null, note: f.note ? str(f.note, 120) : null, status: health(f), error: f.error ? str(f.error, 160) : null, feedItems: num(f.feedItems), kept: num(f.kept), latestPublished: iso(f.latestPublished), latestAgeH: numOrNull(f.latestAgeH) })),
    items: (Array.isArray(n.items) ? n.items : []).slice(0, MAX_FEED).map(trimItem),
    topicCounts: counts(n.topicCounts), placeCounts: counts(n.placeCounts, 24), groupCounts: counts(n.groupCounts),
    problems: strList(n.problems, 6, 200),
    disclaimer: strList(n.disclaimer, 4, 240),
  };
}

export function trimInsight(ic, cc) {
  if (!ic || typeof ic !== 'object') return { source: 'InSightCrime', status: 'unavailable', articles: [], profiles: null, error: null };
  const c = ic.byCountry?.[cc] || {}, p = ic.profiles?.[cc] || null;
  const articles = (Array.isArray(c.articles) ? c.articles : []).slice(0, MAX_IC).map(a => ({ title: str(a.title, 160), url: httpUrl(a.link), published: iso(a.date), excerpt: str(a.description, 200), categories: strList(a.categories, 5, 32) })).filter(a => a.url);
  const feedStatus = c.error ? 'unavailable' : articles.length ? 'live' : 'empty';
  const profiles = p ? {
    label: str(p.label, 40), status: p.status === 'cached' ? 'stale' : (p.status === 'live' ? 'live' : 'unavailable'), fetchedAt: iso(p.fetchedAt), error: p.error ? str(p.error, 160) : null,
    tagUrl: `https://insightcrime.org/${cc === 've' ? 'venezuela' : 'colombia'}-organized-crime-news/`,
    cards: (Array.isArray(p.cards) ? p.cards : []).slice(0, MAX_PROFILES).map(k => ({ name: str(k.name, 120), url: httpUrl(k.url), kind: k.kind === 'profile' ? 'profile' : 'analysis', summary: str(k.summary, 320), published: iso(k.published), updated: iso(k.updated) })).filter(k => k.url),
  } : null;
  const status = feedStatus === 'live' && (!profiles || profiles.status === 'live') ? 'live' : (feedStatus === 'unavailable' && (!profiles || !profiles.cards.length)) ? 'unavailable' : 'limited';
  return { source: 'InSightCrime', status, feed: str(c.feed, 24), feedStatus, error: c.error ? str(c.error, 160) : null, count: num(c.count), articles, profiles, timestamp: iso(ic.timestamp) };
}

export function trimOvcs(o) {
  if (!o || typeof o !== 'object') return null;
  const m = (x) => ({ month: month(x.month), title: str(x.title, 120), url: httpUrl(x.url), published: iso(x.published), protests: numOrNull(x.protests), perDay: numOrNull(x.perDay), yoyPct: numOrNull(x.yoyPct), yoyBase: numOrNull(x.yoyBase), desca: numOrNull(x.desca), descaPct: numOrNull(x.descaPct), dcp: numOrNull(x.dcp), dcpPct: numOrNull(x.dcpPct), repressed: numOrNull(x.repressed) });
  const h = o.historical;
  return {
    source: 'OVCS', status: health(o), stale: Boolean(o.stale), fetchedAt: iso(o.fetchedAt || o.timestamp), error: o.error ? str(o.error, 160) : null, site: httpUrl(o.site),
    monthly: (Array.isArray(o.monthly) ? o.monthly : []).slice(0, 12).map(m).filter(x => x.month),
    latest: o.latest ? m(o.latest) : null, latestAgeD: numOrNull(o.latestAgeD),
    periods: (Array.isArray(o.periods) ? o.periods : []).slice(0, 6).map(p => ({ title: str(p.title, 120), url: httpUrl(p.url), published: iso(p.published), year: str(p.year, 4) })),
    historical: h ? { title: str(h.title, 120), year: numOrNull(h.year), count: num(h.count), url: httpUrl(h.url), kind: 'historical', note: str(h.note, 120) } : null,
    problems: strList(o.problems, 6, 200), disclaimer: strList(o.disclaimer, 4, 240),
  };
}

export function trimCii(cii, code) {
  const c = (Array.isArray(cii?.countries) ? cii.countries : []).find(x => x.code === code);
  if (!c) return null;
  return { code: str(c.code, 2), name: str(c.name, 40), score: num(c.score), level: str(c.level, 16), trend: str(c.trend, 16), trendDelta: numOrNull(c.trendDelta), components: { unrest: num(c.components?.unrest), security: num(c.components?.security), information: num(c.components?.information) }, newsVolume: num(c.newsVolume), warmingUp: Boolean(cii.warmingUp), topHeadlines: strList(c.topHeadlines, 5, 160), timestamp: iso(cii.timestamp) };
}

const pct = (v) => (v === null ? null : `${v > 0 ? '+' : ''}${v}%`);

function heroFor(cfg, parts) {
  const tiles = [];
  const od = parts.openData, ov = parts.ovcs, news = parts.news, ic = parts.insight, cii = parts.cii;
  if (cfg.id === 'co') {
    const tl = od?.focus?.theftLatest;
    tiles.push({ key: 'theft', kind: 'official', label: `Hurto a personas · ${od?.focus?.name || 'Bogotá'} · ${tl?.month || '—'}`, value: tl ? tl.n : null, sub: tl ? `${pct(tl.momPct) ?? '—'} vs ${tl.prevMonth || 'prev'} · ${pct(tl.yoyPct) ?? '—'} vs ${tl.yoyMonth || 'yr ago'}` : (od?.error || 'datos.gov.co not available'), source: 'ColombiaOpenData' });
    const ar = od?.focus?.categories?.arrests;
    tiles.push({ key: 'arrests', kind: 'official', label: `Capturas · Bogotá · ${ar?.month || '—'}`, value: ar?.total ?? null, sub: ar?.rows?.[0] ? `top: ${ar.rows[0].label.toLowerCase()} ${ar.rows[0].n}` : 'no rows', source: 'ColombiaOpenData' });
    const nat = od?.national;
    tiles.push({ key: 'national', kind: 'official', label: `Hurto a personas · national · ${nat?.month || '—'}`, value: nat?.total ?? null, sub: nat?.byDept?.length ? `${nat.byDept.length} departamentos · Bogotá ${nat.total ? Math.round((nat.byDept.find(d => d.code === '11')?.n || 0) / nat.total * 100) : 0}% of reports` : 'no rows', source: 'ColombiaOpenData' });
  }
  if (cfg.id === 've') {
    const l = ov?.latest;
    tiles.push({ key: 'protests', kind: 'observational', label: `Protests · OVCS · ${l?.month || '—'}`, value: l?.protests ?? null, sub: l ? `${l.perDay ?? '—'}/day · ${pct(l.yoyPct) ?? '—'} y/y${l.repressed !== null ? ` · ${l.repressed} repressed` : ''}` : (ov?.error || 'OVCS not available'), source: 'OVCS' });
    tiles.push({ key: 'desca', kind: 'observational', label: `Economic / social-rights protests · ${l?.month || '—'}`, value: l?.desca ?? null, sub: l?.descaPct !== null && l?.descaPct !== undefined ? `${l.descaPct}% of the month · DCP ${l.dcp ?? '—'} (${l.dcpPct ?? '—'}%)` : 'share not stated', source: 'OVCS' });
    tiles.push({ key: 'cii', kind: 'derived', label: 'Country Instability Index (CRUCIX)', value: cii ? cii.score : null, sub: cii ? `${cii.level} · ${cii.trend}${cii.warmingUp ? ' · warming up' : ''} · unrest ${cii.components.unrest} / security ${cii.components.security} / info ${cii.components.information}` : 'CII not available', source: 'CII' });
  }
  const sec = news?.topicCounts?.security ?? null;
  tiles.push({ key: 'wires', kind: 'observational', label: `Wires · ${news?.feeds?.filter(f => f.status === 'live').length ?? 0}/${news?.feeds?.length ?? 0} feeds live`, value: news ? news.count : null, sub: news ? `${sec ?? 0} security · ${news.topicCounts?.protest ?? 0} protest · ${news.topicCounts?.rights ?? 0} rights · ${news.topicCounts?.politics ?? 0} politics` : 'no wires', source: news?.source || 'CountryNews' });
  tiles.push({ key: 'insight', kind: 'observational', label: 'InSight Crime · country feed / group profiles', value: ic ? ic.articles.length : null, sub: ic?.profiles ? `${ic.profiles.cards.filter(c => c.kind === 'profile').length} group profiles · ${ic.profiles.cards.filter(c => c.kind === 'analysis').length} analyses${ic.profiles.status === 'stale' ? ' · cached' : ''}` : 'profiles not available', source: 'InSightCrime' });
  tiles.push({ key: 'acled', kind: 'no-key', label: 'ACLED conflict events', value: null, sub: parts.acled === 'live' ? 'ACLED reporting' : 'NO KEY — register at acleddata.com; layer stays off', source: 'ACLED' });
  return tiles.slice(0, 6).map(t => ({ ...t, label: str(t.label, 80), sub: str(t.sub, 160), value: numOrNull(t.value) }));
}

function sourceRows(cfg, runtime) {
  return (cfg.sources || []).map(s => {
    const r = runtime[s.name] || {};
    return { name: str(s.name, 24), label: str(s.label, 60), kind: str(s.kind, 16), detail: str(s.detail, 160), status: r.status || (s.kind === 'licensed' ? 'no-key' : 'off'), error: r.error ? str(r.error, 160) : null, fetchedAt: iso(r.fetchedAt), stale: Boolean(r.stale), problems: strList(r.problems, 3, 160) };
  });
}

export function buildCountryView(cc, sources = {}, errors = []) {
  const cfg = countryConfig(cc);
  const sweepErr = Object.fromEntries((Array.isArray(errors) ? errors : []).map(e => [e.name, e.error]));
  // A configured source that returned nothing this sweep (runSource timeout / throw) is an error, not 'off'.
  const missing = (name) => ({ status: 'error', error: sweepErr[name] || 'source returned no data this sweep' });
  const openData = cc === 'co' ? trimOpenData(sources.ColombiaOpenData) : null;
  const news = trimNews(sources[cc === 'co' ? 'ColombiaNews' : 'VenezuelaNews']);
  const insight = trimInsight(sources.InSightCrime, cc);
  const ovcs = cc === 've' ? trimOvcs(sources.OVCS) : null;
  const cii = trimCii(sources.CII, cc.toUpperCase());
  const acled = health(sources.ACLED);
  const parts = { openData, news, insight, ovcs, cii, acled };
  const runtime = {
    ColombiaOpenData: openData ? { status: openData.status, error: openData.error, fetchedAt: openData.fetchedAt, stale: openData.stale, problems: openData.problems } : cc === 'co' ? missing('ColombiaOpenData') : {},
    ColombiaNews: cc === 'co' ? (news ? { status: news.status, error: news.error, fetchedAt: news.fetchedAt, stale: news.stale, problems: news.problems } : missing('ColombiaNews')) : {},
    VenezuelaNews: cc === 've' ? (news ? { status: news.status, error: news.error, fetchedAt: news.fetchedAt, stale: news.stale, problems: news.problems } : missing('VenezuelaNews')) : {},
    InSightCrime: sources.InSightCrime ? { status: insight.status, error: insight.error || insight.profiles?.error || null, fetchedAt: insight.timestamp } : missing('InSightCrime'),
    OVCS: ovcs ? { status: ovcs.status, error: ovcs.error, fetchedAt: ovcs.fetchedAt, stale: ovcs.stale, problems: ovcs.problems } : cc === 've' ? missing('OVCS') : {},
    CII: cii ? { status: 'live', fetchedAt: cii.timestamp } : { status: 'off', error: `${cfg.name} is not in the CII country set` },
    ACLED: { status: acled === 'live' ? 'live' : 'no-key', error: acled === 'live' ? null : 'ACLED_EMAIL / ACLED_KEY not configured' },
  };
  const rows = sourceRows(cfg, runtime);
  const polled = rows.filter(r => r.kind !== 'licensed' && r.status !== 'off');
  const liveish = polled.filter(r => ['live', 'limited', 'stale', 'empty'].includes(r.status)).length;
  const status = liveish === 0 ? 'unavailable' : polled.every(r => r.status === 'live') ? 'live' : 'limited';
  const adm = countryAdm1(cc);
  return {
    source: `Country-${cc}`,
    id: cc, iso3: str(cfg.iso3, 3), name: str(cfg.name, 40), title: str(cfg.title, 60), subtitle: str(cfg.subtitle, 200),
    focusCity: { name: str(cfg.focusCity?.name, 40), lon: coord(cfg.focusCity?.lon, 180), lat: coord(cfg.focusCity?.lat, 90), adm1Iso: str(cfg.focusCity?.adm1Iso, 8) },
    viewport: { bbox: Array.isArray(cfg.viewport?.bbox) && cfg.viewport.bbox.length === 4 ? cfg.viewport.bbox.map(Number) : null },
    geo: adm ? { unitLabel: str(cfg.geo?.unitLabel, 20), units: num(adm.units?.length), vintage: str(adm.vintage, 8), source: str(adm.source, 80), license: str(adm.license, 60), sourceUrl: httpUrl(adm.sourceUrl) } : null,
    status,
    hero: heroFor(cfg, parts),
    openData, news, insight, ovcs, cii,
    acled: { status: acled === 'live' ? 'live' : 'no-key', registerUrl: 'https://acleddata.com/api-documentation/getting-started' },
    sourceRows: rows,
    linkOuts: (cfg.linkOuts || []).slice(0, 10).map(l => ({ label: str(l.label, 80), url: httpUrl(l.href), why: str(l.why, 160) })),
    notes: strList(cfg.notes, 6, 240),
    places: (cfg.places || []).slice(0, 40).map(p => ({ key: str(p.key, 32), name: str(p.name, 40), level: str(p.level, 16), lon: coord(p.lon, 180), lat: coord(p.lat, 90) })),
    groups: strList(cfg.groups, 40, 40),
  };
}

// Geometry for the country map (served from /api/country/:cc/geo): ADM1 outlines with the latest
// official value per unit (Colombia), configured place anchors with this sweep's mention counts, and
// historical points (Venezuela SIGCO 2017) flagged as such.
export function buildCountryGeo(cc, sources = {}) {
  const cfg = countryConfig(cc);
  const adm = countryAdm1(cc);
  const news = sources[cc === 'co' ? 'ColombiaNews' : 'VenezuelaNews'] || {};
  const placeCounts = news.placeCounts || {};
  const places = (cfg.places || []).map(p => ({ type: 'place', key: str(p.key, 32), name: str(p.name, 40), level: str(p.level, 16), lon: coord(p.lon, 180), lat: coord(p.lat, 90), mentions: num(placeCounts[p.key]) })).filter(p => p.lon !== null && p.lat !== null);
  let values = null;
  if (cc === 'co') {
    const od = sources.ColombiaOpenData || {};
    const byIso = {};
    for (const d of Array.isArray(od.national?.byDept) ? od.national.byDept : []) if (d.iso) byIso[str(d.iso, 8)] = num(d.n);
    if (Object.keys(byIso).length) values = { metric: 'theft', label: 'Hurto a personas (reports)', month: month(od.national?.month), kind: 'official', attribution: str(od.attribution, 80), byIso };
  }
  const historical = [];
  if (cc === 've') {
    const h = sources.OVCS?.historical;
    for (const p of Array.isArray(h?.points) ? h.points : []) {
      const lon = coord(p.lon, 180), lat = coord(p.lat, 90);
      if (lon === null || lat === null) continue;
      historical.push({ type: 'sigco-death', kind: 'historical', lon, lat, date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : null });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    country: cc, iso3: str(cfg.iso3, 3),
    bbox: Array.isArray(cfg.viewport?.bbox) && cfg.viewport.bbox.length === 4 ? cfg.viewport.bbox.map(Number) : null,
    adm1: adm ? { level: 'ADM1', unit: str(adm.unit, 20), vintage: str(adm.vintage, 8), source: str(adm.source, 80), sourceUrl: httpUrl(adm.sourceUrl), license: str(adm.license, 60), units: (adm.units || []).map(u => ({ iso: str(u.iso, 8), name: str(u.name, 60), centroid: Array.isArray(u.centroid) ? u.centroid.slice(0, 2).map(Number) : null, rings: Array.isArray(u.rings) ? u.rings : [] })) } : null,
    values,
    places,
    historical: historical.length ? { kind: 'historical', label: str(sources.OVCS?.historical?.title, 120), year: numOrNull(sources.OVCS?.historical?.year), note: str(sources.OVCS?.historical?.note, 120), url: httpUrl(sources.OVCS?.historical?.url), count: historical.length, points: historical.slice(0, 400) } : null,
  };
}

export function buildAllCountryViews(sources = {}, errors = []) {
  return Object.fromEntries(COUNTRY_IDS.map(cc => [cc, buildCountryView(cc, sources, errors)]));
}

export function buildAllCountryGeo(sources = {}) {
  return Object.fromEntries(COUNTRY_IDS.map(cc => [cc, buildCountryGeo(cc, sources)]));
}
