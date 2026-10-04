// Country Home Page view model: one bounded payload per country built from the adapters the country
// config names (official open data, country wires, InSight Crime country feed + group profiles, OVCS,
// CII, ACLED) plus the honest health / link-out rows. Geometry (ADM1 polygons, choropleth values,
// place anchors, historical points) goes out separately via /api/country/:cc/geo. Every string is
// third-party text: bounded here, HTML-escaped again by the dashboard before insertion.

import { COUNTRY_IDS, countryConfig, countryAdm1, countryLocalidades, fold } from './countryconfig.mjs';

const MAX_FEED = 60;
const MAX_IC = 15;
const MAX_PROFILES = 24;
const MAX_CAT_ROWS = 10;
const MAX_SAT = 40;
const MAX_MASSACRE_ROWS = 160;

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
  const m = (x) => ({
    month: month(x.month), title: str(x.title, 120), url: httpUrl(x.url), published: iso(x.published), protests: numOrNull(x.protests), perDay: numOrNull(x.perDay), yoyPct: numOrNull(x.yoyPct), yoyBase: numOrNull(x.yoyBase), desca: numOrNull(x.desca), descaPct: numOrNull(x.descaPct), dcp: numOrNull(x.dcp), dcpPct: numOrNull(x.dcpPct), repressed: numOrNull(x.repressed),
    // Partial ranking only: OVCS names the top and bottom states in prose, never a full table.
    byState: (Array.isArray(x.byState) ? x.byState : []).slice(0, 14).map(b => ({ state: str(b.state, 40), iso: b.iso ? str(b.iso, 8) : null, n: num(b.n), rank: b.rank === 'bottom' ? 'bottom' : 'top' })),
    modalities: (Array.isArray(x.modalities) ? x.modalities : []).slice(0, 6).map(d => ({ kind: str(d.kind, 32), n: num(d.n), pct: numOrNull(d.pct) })),
    abuseComplaints: numOrNull(x.abuseComplaints), repressedStates: numOrNull(x.repressedStates),
  });
  const h = o.historical;
  return {
    source: 'OVCS', status: health(o), stale: Boolean(o.stale), fetchedAt: iso(o.fetchedAt || o.timestamp), error: o.error ? str(o.error, 160) : null, site: httpUrl(o.site),
    monthly: (Array.isArray(o.monthly) ? o.monthly : []).slice(0, 12).map(m).filter(x => x.month),
    latest: o.latest ? m({ ...((Array.isArray(o.monthly) ? o.monthly : []).find(x => x.month === o.latest.month) || {}), ...o.latest }) : null, latestAgeD: numOrNull(o.latestAgeD),
    periods: (Array.isArray(o.periods) ? o.periods : []).slice(0, 6).map(p => ({ title: str(p.title, 120), url: httpUrl(p.url), published: iso(p.published), year: str(p.year, 4) })),
    historical: h ? { title: str(h.title, 120), year: numOrNull(h.year), count: num(h.count), url: httpUrl(h.url), kind: 'historical', note: str(h.note, 120) } : null,
    problems: strList(o.problems, 6, 200), disclaimer: strList(o.disclaimer, 4, 240),
  };
}

const point = (p) => ({ name: str(p.name, 60), department: str(p.department, 40), iso: p.iso ? str(p.iso, 8) : null, lat: coord(p.lat, 90), lon: coord(p.lon, 180), precision: p.precision === 'municipality' ? 'municipality' : 'department' });
const named = (a, max = 12) => (Array.isArray(a) ? a : []).slice(0, max).map(r => ({ name: str(r.name, 60), n: num(r.n) }));
const monthly = (a, max = 14) => (Array.isArray(a) ? a : []).slice(-max).map(r => ({ month: month(r.month), n: num(r.n) })).filter(r => r.month);

// Defensoría del Pueblo early-warning index: one bounded row per alert (number, type, places, key
// threat, date, ficha + PDF links). The alert body stays in the Defensoría PDF.
export function trimSat(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    source: 'DefensoriaSAT', status: health(s), stale: Boolean(s.stale), cacheAgeH: numOrNull(s.cacheAgeH), fetchedAt: iso(s.fetchedAt || s.timestamp), error: s.error ? str(s.error, 160) : null, site: httpUrl(s.site),
    pagesFetched: num(s.pagesFetched), pagesTotal: numOrNull(s.pagesTotal),
    alerts: (Array.isArray(s.alerts) ? s.alerts : []).slice(0, MAX_SAT).map(a => ({
      id: str(a.id, 12), year: numOrNull(a.year), type: a.type === 'imminence' ? 'imminence' : a.type === 'structural' ? 'structural' : str(a.type, 16), date: /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) ? a.date : null,
      departments: strList(a.departments, 6, 40), municipalities: strList(a.municipalities, 8, 60), placesText: str(a.placesText, 200), theme: str(a.theme, 320),
      groups: (Array.isArray(a.groups) ? a.groups : []).slice(0, 6).map(g => ({ id: str(g.id, 32), short: str(g.short, 32) })),
      points: (Array.isArray(a.points) ? a.points : []).slice(0, 8).map(point).filter(p => p.lat !== null && p.lon !== null),
      fichaUrl: httpUrl(a.fichaUrl), pdfUrl: httpUrl(a.pdfUrl), infographic: Boolean(a.infographic), followUp: a.followUp ? str(a.followUp, 60) : null,
    })),
    latest: s.latest ? { id: str(s.latest.id, 12), date: str(s.latest.date, 10), type: str(s.latest.type, 16), placesText: str(s.latest.placesText, 200) } : null, latestAgeD: numOrNull(s.latestAgeD),
    ytd: s.ytd ? { year: numOrNull(s.ytd.year), alerts: num(s.ytd.alerts), byType: { structural: num(s.ytd.byType?.structural), imminence: num(s.ytd.byType?.imminence) }, departments: num(s.ytd.departments), topDepartments: named(s.ytd.topDepartments, 10), topGroups: named((Array.isArray(s.ytd.groups) ? s.ytd.groups : []).map(g => ({ name: g.short || g.name, n: g.n })), 10) } : null,
    problems: strList(s.problems, 6, 200), disclaimer: strList(s.disclaimer, 4, 240),
  };
}

// Indepaz tallies: massacre rows (date, place, victims) and killed-leader / signatory counts. Names are
// never carried into the payload.
export function trimIndepaz(i) {
  if (!i || typeof i !== 'object') return null;
  const post = (p) => (p ? { title: str(p.title, 160), url: httpUrl(p.url), published: iso(p.published), modified: iso(p.modified) } : null);
  const m = i.masacres, l = i.lideres;
  return {
    source: 'Indepaz', status: health(i), stale: Boolean(i.stale), cacheAgeH: numOrNull(i.cacheAgeH), fetchedAt: iso(i.fetchedAt || i.timestamp), error: i.error ? str(i.error, 160) : null, site: httpUrl(i.site), latestAgeD: numOrNull(i.latestAgeD),
    masacres: m ? {
      post: post(m.post), latestYear: numOrNull(m.latestYear), latestDate: str(m.latestDate, 10), asOf: str(m.asOf, 10),
      years: (Array.isArray(m.years) ? m.years : []).slice(0, 8).map(y => ({ year: num(y.year), massacres: numOrNull(y.massacres), victims: numOrNull(y.victims), asOf: y.asOf ? str(y.asOf, 10) : null, tallied: y.tallied ? { massacres: num(y.tallied.massacres), victims: num(y.tallied.victims) } : null })),
      rows: (Array.isArray(m.rows) ? m.rows : []).slice(0, MAX_MASSACRE_ROWS).map(r => ({ date: str(r.date, 10), department: str(r.department, 40), municipality: str(r.municipality, 60), victims: num(r.victims), lat: coord(r.lat, 90), lon: coord(r.lon, 180), iso: r.iso ? str(r.iso, 8) : null, precision: r.precision === 'municipality' ? 'municipality' : r.precision === 'department' ? 'department' : null })),
      byDepartment: named(m.byDepartment, 12), byMonth: monthly(m.byMonth),
    } : null,
    lideres: l ? {
      post: post(l.post), note: str(l.note, 160),
      years: (Array.isArray(l.years) ? l.years : []).slice(0, 6).map(y => ({ year: num(y.year), leaders: numOrNull(y.leaders), signatories: numOrNull(y.signatories), latestDate: y.latestDate ? str(y.latestDate, 10) : null })),
      current: l.current ? { year: num(l.current.year), leaders: numOrNull(l.current.leaders), signatories: numOrNull(l.current.signatories), latestDate: str(l.current.latestDate, 10), byMonth: monthly(l.current.byMonth), byDepartment: named(l.current.byDepartment, 12), bySector: named(l.current.bySector, 10) } : null,
    } : null,
    problems: strList(i.problems, 6, 200), disclaimer: strList(i.disclaimer, 4, 240),
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
    const sat = parts.sat, y = sat?.ytd;
    tiles.push({ key: 'sat', kind: 'official', label: `Defensoría SAT alerts · ${y?.year || '—'} to date`, value: y ? y.alerts : null, sub: y ? `${y.byType.imminence} imminence · ${y.byType.structural} structural · ${y.departments} departamentos · latest ${sat.latest?.id || '—'} ${sat.latest?.date || ''}` : (sat?.error || 'SAT index not available'), source: 'DefensoriaSAT' });
    const ms = parts.indepaz?.masacres, my = ms?.years?.[0];
    tiles.push({ key: 'massacres', kind: 'observational', label: `Massacres · Indepaz · ${my?.year || '—'}`, value: my ? my.massacres : null, sub: my ? `${my.victims ?? '—'} victims · as of ${my.asOf || ms.asOf || '—'} · ${ms.byDepartment?.[0] ? `${ms.byDepartment[0].name} ${ms.byDepartment[0].n}` : ''}` : (parts.indepaz?.error || 'Indepaz not available'), source: 'Indepaz' });
    const lc = parts.indepaz?.lideres?.current;
    tiles.push({ key: 'leaders', kind: 'observational', label: `Social leaders killed · Indepaz · ${lc?.year || '—'}`, value: lc ? lc.leaders : null, sub: lc ? `${lc.signatories ?? '—'} peace signatories · latest ${lc.latestDate || '—'} · counts only, no names` : 'Indepaz not available', source: 'Indepaz' });
  }
  if (cfg.id === 've') {
    const l = ov?.latest;
    tiles.push({ key: 'protests', kind: 'observational', label: `Protests · OVCS · ${l?.month || '—'}`, value: l?.protests ?? null, sub: l ? `${l.perDay ?? '—'}/day · ${pct(l.yoyPct) ?? '—'} y/y${l.repressed !== null ? ` · ${l.repressed} repressed` : ''}` : (ov?.error || 'OVCS not available'), source: 'OVCS' });
    tiles.push({ key: 'desca', kind: 'observational', label: `Economic / social-rights protests · ${l?.month || '—'}`, value: l?.desca ?? null, sub: l?.descaPct !== null && l?.descaPct !== undefined ? `${l.descaPct}% of the month · DCP ${l.dcp ?? '—'} (${l.dcpPct ?? '—'}%)` : 'share not stated', source: 'OVCS' });
    const top = l?.byState?.find(b => b.rank === 'top');
    tiles.push({ key: 'topState', kind: 'observational', label: `Most protests by state · ${l?.month || '—'}`, value: top ? top.n : null, sub: top ? `${top.state} · ${l.byState.filter(b => b.rank === 'top').length} states named${l.repressedStates !== null ? ` · repression in ${l.repressedStates} states` : ''}` : 'state ranking not stated in the report', source: 'OVCS' });
    tiles.push({ key: 'cii', kind: 'derived', label: 'Country Instability Index (CRUCIX)', value: cii ? cii.score : null, sub: cii ? `${cii.level} · ${cii.trend}${cii.warmingUp ? ' · warming up' : ''} · unrest ${cii.components.unrest} / security ${cii.components.security} / info ${cii.components.information}` : 'CII not available', source: 'CII' });
  }
  const sec = news?.topicCounts?.security ?? null;
  tiles.push({ key: 'wires', kind: 'observational', label: `Wires · ${news?.feeds?.filter(f => f.status === 'live').length ?? 0}/${news?.feeds?.length ?? 0} feeds live`, value: news ? news.count : null, sub: news ? `${sec ?? 0} security · ${news.topicCounts?.protest ?? 0} protest · ${news.topicCounts?.rights ?? 0} rights · ${news.topicCounts?.politics ?? 0} politics` : 'no wires', source: news?.source || 'CountryNews' });
  tiles.push({ key: 'insight', kind: 'observational', label: 'InSight Crime · country feed / group profiles', value: ic ? ic.articles.length : null, sub: ic?.profiles ? `${ic.profiles.cards.filter(c => c.kind === 'profile').length} group profiles · ${ic.profiles.cards.filter(c => c.kind === 'analysis').length} analyses${ic.profiles.status === 'stale' ? ' · cached' : ''}` : 'profiles not available', source: 'InSightCrime' });
  tiles.push({ key: 'acled', kind: 'no-key', label: 'ACLED conflict events', value: null, sub: parts.acled === 'live' ? 'ACLED reporting' : 'NO KEY — register at acleddata.com; layer stays off', source: 'ACLED' });
  return tiles.slice(0, 9).map(t => ({ ...t, label: str(t.label, 80), sub: str(t.sub, 160), value: numOrNull(t.value) }));
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
  const sat = cc === 'co' ? trimSat(sources.DefensoriaSAT) : null;
  const indepaz = cc === 'co' ? trimIndepaz(sources.Indepaz) : null;
  const cii = trimCii(sources.CII, cc.toUpperCase());
  const acled = health(sources.ACLED);
  const parts = { openData, news, insight, ovcs, sat, indepaz, cii, acled };
  const rt = (x) => ({ status: x.status, error: x.error, fetchedAt: x.fetchedAt, stale: x.stale, problems: x.problems });
  const runtime = {
    ColombiaOpenData: openData ? { status: openData.status, error: openData.error, fetchedAt: openData.fetchedAt, stale: openData.stale, problems: openData.problems } : cc === 'co' ? missing('ColombiaOpenData') : {},
    ColombiaNews: cc === 'co' ? (news ? { status: news.status, error: news.error, fetchedAt: news.fetchedAt, stale: news.stale, problems: news.problems } : missing('ColombiaNews')) : {},
    VenezuelaNews: cc === 've' ? (news ? { status: news.status, error: news.error, fetchedAt: news.fetchedAt, stale: news.stale, problems: news.problems } : missing('VenezuelaNews')) : {},
    InSightCrime: sources.InSightCrime ? { status: insight.status, error: insight.error || insight.profiles?.error || null, fetchedAt: insight.timestamp } : missing('InSightCrime'),
    OVCS: ovcs ? rt(ovcs) : cc === 've' ? missing('OVCS') : {},
    DefensoriaSAT: sat ? rt(sat) : cc === 'co' ? missing('DefensoriaSAT') : {},
    Indepaz: indepaz ? rt(indepaz) : cc === 'co' ? missing('Indepaz') : {},
    CII: cii ? { status: 'live', fetchedAt: cii.timestamp } : { status: 'off', error: `${cfg.name} is not in the CII country set` },
    ACLED: { status: acled === 'live' ? 'live' : 'no-key', error: acled === 'live' ? null : 'ACLED_EMAIL / ACLED_KEY not configured' },
  };
  const rows = sourceRows(cfg, runtime);
  const polled = rows.filter(r => r.kind !== 'licensed' && r.status !== 'off');
  const liveish = polled.filter(r => ['live', 'limited', 'stale', 'empty'].includes(r.status)).length;
  const status = liveish === 0 ? 'unavailable' : polled.every(r => r.status === 'live') ? 'live' : 'limited';
  const adm = countryAdm1(cc);
  const loc = countryLocalidades(cc);
  return {
    source: `Country-${cc}`,
    id: cc, iso3: str(cfg.iso3, 3), name: str(cfg.name, 40), title: str(cfg.title, 60), subtitle: str(cfg.subtitle, 200),
    focusCity: { name: str(cfg.focusCity?.name, 40), lon: coord(cfg.focusCity?.lon, 180), lat: coord(cfg.focusCity?.lat, 90), adm1Iso: str(cfg.focusCity?.adm1Iso, 8) },
    viewport: { bbox: Array.isArray(cfg.viewport?.bbox) && cfg.viewport.bbox.length === 4 ? cfg.viewport.bbox.map(Number) : null },
    geo: adm ? { unitLabel: str(cfg.geo?.unitLabel, 20), units: num(adm.units?.length), vintage: str(adm.vintage, 8), source: str(adm.source, 80), license: str(adm.license, 60), sourceUrl: httpUrl(adm.sourceUrl),
      localidades: loc ? { city: str(loc.city, 40), units: num(loc.units?.length), source: str(loc.source, 100), sourceUrl: httpUrl(loc.sourceUrl), license: str(loc.license, 60) } : (cfg.geo?.localidadesFile ? { city: str(cfg.focusCity?.name, 40), units: 0, source: null, sourceUrl: null, license: null, unavailable: 'localidad geometry file missing or unreadable' } : null) } : null,
    status,
    hero: heroFor(cfg, parts),
    openData, news, insight, ovcs, sat, indepaz, cii,
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
  if (cc === 've') {
    // OVCS names only the top and bottom states for the month; shading is partial by construction.
    const latest = Array.isArray(sources.OVCS?.monthly) ? sources.OVCS.monthly[0] : null;
    const byIso = {};
    for (const b of Array.isArray(latest?.byState) ? latest.byState : []) if (b.iso) byIso[str(b.iso, 8)] = num(b.n);
    if (Object.keys(byIso).length) values = { metric: 'protests', label: 'Protests (OVCS monthly report)', month: month(latest.month), kind: 'observational', partial: true, attribution: 'Observatorio Venezolano de Conflictividad Social', note: 'Only the states OVCS names as most / least active are shaded; unshaded states are not zero.', byIso };
  }
  // Bogotá localidades: official polygons (Datos Abiertos Bogotá); the only per-localidad figure CRUCIX
  // has is wire mentions of the configured place aliases, so that is what is attached — labelled as such.
  const loc = countryLocalidades(cc);
  let localidades = null;
  if (loc) {
    const mentions = {};
    for (const p of cfg.places || []) {
      if (p.level !== 'localidad' && p.level !== 'locality') continue;
      const key = fold(p.name);
      mentions[key] = (mentions[key] || 0) + num(placeCounts[p.key]);
    }
    const units = (loc.units || []).map(u => ({ key: str(u.key, 40), code: str(u.code, 4), name: str(u.name, 60), areaKm2: numOrNull(u.areaKm2), centroid: Array.isArray(u.centroid) ? u.centroid.slice(0, 2).map(Number) : null, rings: Array.isArray(u.rings) ? u.rings : [], mentions: num(mentions[fold(u.name)]) }));
    localidades = { level: 'localidad', city: str(loc.city, 40), unit: str(loc.unit, 20), source: str(loc.source, 100), sourceUrl: httpUrl(loc.sourceUrl), downloadUrl: httpUrl(loc.downloadUrl), license: str(loc.license, 60), crs: str(loc.crs, 60), count: units.length, units,
      values: { metric: 'mentions', label: 'Wire mentions (configured alias match)', kind: 'observational', note: 'No official per-localidad crime series is polled; shading is this sweep\u2019s wire mentions, not incidents.' } };
  }
  // Point layers from the Colombia adapters: SAT alert municipios and Indepaz massacre rows.
  const alerts = [];
  if (cc === 'co') {
    for (const a of Array.isArray(sources.DefensoriaSAT?.alerts) ? sources.DefensoriaSAT.alerts : []) {
      for (const p of Array.isArray(a.points) ? a.points : []) {
        const lon = coord(p.lon, 180), lat = coord(p.lat, 90);
        if (lon === null || lat === null) continue;
        alerts.push({ type: 'sat-alert', kind: 'official', lon, lat, id: str(a.id, 12), alertType: str(a.type, 16), date: str(a.date, 10), name: str(p.name, 60), department: str(p.department, 40), precision: p.precision === 'municipality' ? 'municipality' : 'department', groups: strList((a.groups || []).map(g => g.short), 6, 32), fichaUrl: httpUrl(a.fichaUrl), pdfUrl: httpUrl(a.pdfUrl) });
      }
    }
  }
  const massacres = [];
  if (cc === 'co') {
    for (const r of Array.isArray(sources.Indepaz?.masacres?.rows) ? sources.Indepaz.masacres.rows : []) {
      const lon = coord(r.lon, 180), lat = coord(r.lat, 90);
      if (lon === null || lat === null) continue;
      massacres.push({ type: 'massacre', kind: 'observational', lon, lat, date: str(r.date, 10), municipality: str(r.municipality, 60), department: str(r.department, 40), victims: num(r.victims), precision: r.precision === 'municipality' ? 'municipality' : 'department' });
    }
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
    localidades,
    places,
    alerts: cc === 'co' ? { kind: 'official', label: 'Defensoría SAT alerts (municipio seats)', source: 'Defensoría del Pueblo · Sistema de Alertas Tempranas', url: httpUrl(sources.DefensoriaSAT?.site) || 'https://alertastempranas.defensoria.gov.co/', note: 'Alerts cover whole municipios; the point is the listed municipio seat (department centroid when the municipio is not in the gazetteer).', count: alerts.length, points: alerts.slice(0, 200) } : null,
    massacres: cc === 'co' ? { kind: 'observational', label: `Massacres (Indepaz) · ${sources.Indepaz?.masacres?.latestYear || ''}`.trim(), source: 'Indepaz', url: httpUrl(sources.Indepaz?.masacres?.post?.url) || 'https://indepaz.org.co/', asOf: str(sources.Indepaz?.masacres?.asOf, 10), note: 'Municipio seat of the massacre as listed by Indepaz; victims as counted by Indepaz. No names.', count: massacres.length, points: massacres.slice(0, MAX_MASSACRE_ROWS) } : null,
    historical: historical.length ? { kind: 'historical', label: str(sources.OVCS?.historical?.title, 120), year: numOrNull(sources.OVCS?.historical?.year), note: str(sources.OVCS?.historical?.note, 120), url: httpUrl(sources.OVCS?.historical?.url), count: historical.length, points: historical.slice(0, 400) } : null,
  };
}

export function buildAllCountryViews(sources = {}, errors = []) {
  return Object.fromEntries(COUNTRY_IDS.map(cc => [cc, buildCountryView(cc, sources, errors)]));
}

export function buildAllCountryGeo(sources = {}) {
  return Object.fromEntries(COUNTRY_IDS.map(cc => [cc, buildCountryGeo(cc, sources)]));
}
