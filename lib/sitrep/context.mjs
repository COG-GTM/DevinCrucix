// lib/sitrep/context — the SOUTHCOM-weighted context pack a Commander's SITREP is drafted from.
// Reuses the Ask CRUCIX section builders (stable ids the model must cite) and adds the AOR
// sections Ask does not carry: Colombia / Venezuela country pages, Caribbean air contacts with
// provenance, maritime chokepoints and carrier groups in the AOR, AOR-filtered CII / ACLED /
// IODA, sanctions hits, and the previous edition (so "changes since last SITREP" is grounded).
// Pure functions over the server's askState() shape; nothing here touches the network.
import { buildContextPack as buildAskPack, SECTION_TABS } from '../ask/context.mjs';
import { getProfile } from '../profile.mjs';

// Europe profile: EUCOM AOR (Europe, Russia, Ukraine, Belarus, the Caucasus, Turkey).
const EU = getProfile()?.id === 'europe';
const EUCOM_COUNTRIES = ['Ukraine', 'Russia', 'Belarus', 'Moldova', 'Poland', 'Lithuania', 'Latvia', 'Estonia', 'Finland', 'Sweden', 'Norway', 'Denmark', 'Germany',
  'France', 'United Kingdom', 'Netherlands', 'Belgium', 'Italy', 'Spain', 'Portugal', 'Austria', 'Switzerland', 'Czechia', 'Slovakia', 'Hungary', 'Romania', 'Bulgaria',
  'Serbia', 'Bosnia and Herzegovina', 'Croatia', 'Slovenia', 'Montenegro', 'Kosovo', 'North Macedonia', 'Albania', 'Greece', 'Cyprus', 'Turkey', 'Georgia', 'Armenia', 'Azerbaijan', 'Ireland', 'Iceland'];
const EUCOM_ISO2 = ['UA', 'RU', 'BY', 'MD', 'PL', 'LT', 'LV', 'EE', 'FI', 'SE', 'NO', 'DK', 'DE', 'FR', 'GB', 'NL', 'BE', 'IT', 'ES', 'PT', 'AT', 'CH', 'CZ', 'SK', 'HU', 'RO', 'BG',
  'RS', 'BA', 'HR', 'SI', 'ME', 'XK', 'MK', 'AL', 'GR', 'CY', 'TR', 'GE', 'AM', 'AZ', 'IE', 'IS'];
export const COMMAND = EU ? { name: 'US European Command (EUCOM)', short: 'EUCOM' } : { name: 'US Southern Command (SOUTHCOM)', short: 'SOUTHCOM' };

export const SITREP_CONTEXT_CHARS = 24000;
const SECTION_CHARS = 1800;

// SOUTHCOM AOR: Central America, South America and the Caribbean. Mexico is NORTHCOM; cartel /
// border sections are still packed because trafficking flows originate in the AOR, and the prompt
// says so.
export const AOR_COUNTRIES = EU ? EUCOM_COUNTRIES : [
  'Colombia', 'Venezuela', 'Ecuador', 'Peru', 'Bolivia', 'Brazil', 'Chile', 'Argentina', 'Uruguay', 'Paraguay', 'Guyana', 'Suriname',
  'Guatemala', 'Belize', 'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama',
  'Cuba', 'Haiti', 'Dominican Republic', 'Jamaica', 'Trinidad and Tobago', 'Bahamas', 'Barbados', 'Puerto Rico',
];
const AOR_ISO2 = new Set(EU ? EUCOM_ISO2 : ['CO', 'VE', 'EC', 'PE', 'BO', 'BR', 'CL', 'AR', 'UY', 'PY', 'GY', 'SR', 'GT', 'BZ', 'HN', 'SV', 'NI', 'CR', 'PA', 'CU', 'HT', 'DO', 'JM', 'TT', 'BS', 'BB', 'PR']);
const AOR_LC = AOR_COUNTRIES.map(c => c.toLowerCase());

// Ask sections carried into the SITREP pack, in the order a commander reads them. Theater tabs
// (Ukraine, Iran, Taiwan) and markets are deliberately out of scope for a SOUTHCOM product.
export const ASK_SECTION_ORDER = EU ? ['situation', 'defcon', 'delta', 'ukraine', 'signals', 'focal', 'news', 'telegram', 'kev', 'ransomware', 'ioda', 'macro', 'requirements', 'targeting', 'sources'] : ['situation', 'defcon', 'delta', 'narco', 'insightcrime', 'border', 'cbp', 'cjng', 'signals', 'focal', 'news', 'telegram', 'requirements', 'targeting', 'sources'];

// Keyword query that steers the Ask relevance ranking toward the AOR when the budget is tight.
export const SOUTHCOM_QUERY = EU ? 'ukraine russia belarus moldova baltic nato poland black sea crimea kaliningrad drone missile strike front offensive sabotage cyber gas energy sanctions election balkans serbia georgia' : 'colombia venezuela caribbean panama ecuador peru haiti cuba honduras guatemala cartel narco cocaine trafficking border maritime vessel aircraft sanctions instability outage protest';

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const clipLines = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const arr = v => (Array.isArray(v) ? v : []);
const day = v => { const s = String(v || ''); return s.length >= 10 ? s.slice(0, 10) : s; };
const inAor = (name) => { const l = String(name || '').toLowerCase(); return AOR_LC.some(c => l === c || l.includes(c)); };
const tileLine = (t) => `${t.label}: ${t.value ?? 'n/a'}${t.sub ? ` (${clip(t.sub, 90)})` : ''} [${t.kind || 'observational'}]`;

function countryLines(view, cc) {
  if (!view || view.status === 'unavailable') return null;
  const out = [`${view.name || cc.toUpperCase()} page status ${view.status}; sources ${arr(view.sourceRows).map(r => `${r.name || r.id}=${r.status}`).join(', ')}`];
  for (const t of arr(view.hero?.tiles).slice(0, 7)) out.push(tileLine(t));
  for (const a of arr(view.news?.articles).slice(0, 7)) out.push(`${day(a.published || a.date)} ${a.feed || a.source || 'wire'}: ${clip(a.title, 120)}`);
  for (const a of arr(view.insight?.articles).slice(0, 4)) out.push(`${day(a.published)} InSight Crime: ${clip(a.title, 120)}`);
  if (view.sat?.ytd) out.push(`Defensoría SAT alerts ${view.sat.ytd.year}: ${view.sat.ytd.alerts} (official early-warning system)`);
  const ms = view.indepaz?.masacres?.years?.[0];
  if (ms) out.push(`Indepaz massacres ${ms.year}: ${ms.massacres}, victims ${ms.victims ?? 'n/a'} (observational NGO count)`);
  const ov = view.ovcs?.latest;
  if (ov) out.push(`OVCS protests ${ov.month}: ${ov.protests} (${ov.perDay ?? 'n/a'}/day) (observational NGO count)`);
  return out.length > 1 ? out : null;
}

export const PREVIOUS_LABEL = { am: 'AM edition', pm: 'PM edition', adhoc: 'ad hoc edition' };

// Each builder returns lines or null. ids are lowercase letters only so inline [id] citations parse.
const ALL_SITREP_BUILDERS = [
  { id: 'previous', tab: 'sitrep', label: 'Previous SITREP edition (for change detection)', chars: 3000, always: true,
    build: ({ previous }) => {
      if (!previous?.bluf) return null;
      const label = PREVIOUS_LABEL[previous.edition] || previous.edition || '?';
      const out = [`previous edition ${previous.id || '?'} — ${label}, generated ${previous.generatedAt || '?'}${previous.ageMinutes != null ? ` (${previous.ageMinutes} minutes before this edition)` : ''}. This is the only earlier edition; "changes" are measured against this text alone. This edition is NOT a baseline.`, `BLUF: ${clip(previous.bluf, 500)}`];
      for (const a of arr(previous.activity).slice(0, 7)) if (a?.text) out.push(`activity — ${clip(a.domain || 'domain', 40)}: ${clip(a.text, 260)}`);
      if (previous.changes) out.push(`changes: ${clip(previous.changes, 300)}`);
      for (const w of arr(previous.watch).slice(0, 6)) out.push(`watch: ${clip(w, 160)}`);
      if (previous.assessment) out.push(`assessment: ${clip(previous.assessment, 400)}`);
      return out;
    } },
  { id: 'colombia', tab: 'colombia', label: 'Colombia country page (official counts vs observational)', chars: 2200,
    build: ({ data }) => countryLines(data?.country?.co, 'co') },
  { id: 'venezuela', tab: 'venezuela', label: 'Venezuela country page (independent wires, OVCS)', chars: 2200,
    build: ({ data }) => countryLines(data?.country?.ve, 've') },
  { id: 'aor', tab: 'situation', label: 'AOR instability (CII, countries in the SOUTHCOM AOR only)',
    build: ({ data }) => {
      const list = arr(data?.cii?.countries).filter(c => inAor(c.name) || AOR_ISO2.has(String(c.code || c.iso || '').toUpperCase()));
      if (!list.length) return null;
      return [...list].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12).map(c => `${c.name} ${c.score}/100 ${c.level}, trend ${c.trend}${c.trendDelta ? ` (${c.trendDelta > 0 ? '+' : ''}${c.trendDelta})` : ''} (CRUCIX-computed index, not an official assessment)`);
    } },
  { id: 'conflict', tab: 'situation', label: 'ACLED conflict events in the AOR',
    build: ({ data }) => {
      const a = data?.acled; if (!a || !a.totalEvents) return null;
      const ev = arr(a.deadliestEvents).filter(e => inAor(e.country)).slice(0, 8);
      const top = Object.entries(a.topCountries || {}).filter(([k]) => inAor(k)).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
      if (!ev.length && !top) return null;
      const out = [`AOR countries by event count: ${top || 'none in top list'} (of ${a.totalEvents} events globally in window)`];
      for (const e of ev) out.push(`${day(e.date)} ${e.country} · ${e.location || '?'} · ${e.type} · ${e.fatalities} fatalities`);
      return out;
    } },
  { id: 'caribbeanair', tab: 'military', label: 'Caribbean air activity (OpenSky × adsb.fi, provenance-scored)',
    build: ({ data, contacts }) => {
      const h = arr(data?.air).find(x => x.key === 'caribbean' || /caribbean/i.test(x.region));
      if (!h) return null;
      const mil = arr(h.tracks).filter(t => t.military).length;
      const out = [`${h.region}: ${h.total} aircraft of all types in box (airliners, cargo, GA and military together; ${mil} tracks flagged military), ${h.noCallsign} without callsign, ${h.highAlt} high-altitude; top registrations ${arr(h.top).map(([c, n]) => `${c} ${n}`).join(', ')}`];
      if (h.provenance) out.push(`provenance: ${Object.entries(h.provenance.byConfidence || {}).map(([k, v]) => `${k} ${v}`).join(', ')}, mean score ${h.provenance.meanScore ?? 'n/a'}`);
      if (contacts?.total != null) out.push(`all theaters this sweep: ${contacts.total} fused contacts, ${contacts.military ?? 0} flagged military, confidence ${Object.entries(contacts.byConfidence || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      for (const t of arr(h.tracks).filter(t => t.military || t.prov).slice(0, 6)) out.push(`track ${t.callsign || t.icao24 || '?'}${t.country ? ` (${t.country})` : ''}${t.alt != null ? ` alt ${t.alt}` : ''}${t.prov?.confidence ? ` · ${t.prov.confidence}` : ''}`);
      return out;
    } },
  { id: 'maritime', tab: 'military', label: 'Maritime: AOR chokepoints, carrier groups, GPS jamming',
    build: ({ data }) => {
      const out = [];
      for (const c of arr(data?.chokepoints).filter(c => /panama|caribbean|magellan|drake/i.test(c.label))) out.push(`chokepoint ${c.label}: ${c.note || 'monitored'} (static watch point; no live AIS count in this build)`);
      for (const c of arr(data?.carriers?.carriers).filter(c => c.lat != null && c.lat > -60 && c.lat < 32 && c.lng > -120 && c.lng < -30).slice(0, 6)) out.push(`carrier ${c.hull} ${c.name}: ${c.estimated ? 'OSINT-estimated' : 'reported'} position ${Number(c.lat).toFixed(1)},${Number(c.lng).toFixed(1)} · ${clip(c.desc, 100)} (${c.source || 'OSINT'})`);
      for (const z of arr(data?.gpsJamming?.zones).filter(z => inAor(z.region) || /caribbean|central america|south america/i.test(z.region)).slice(0, 4)) out.push(`GPS degradation ${z.region}: ${z.pctLabel || z.ratio} ${z.severity} (${z.degraded}/${z.total} aircraft)`);
      return out.length ? out : null;
    } },
  { id: 'sanctions', tab: 'cartels', label: 'Sanctions touchpoints (OFAC SDN matches in the feeds)',
    build: ({ data, narco }) => {
      const out = [];
      for (const h of arr(data?.insightCrime?.sanctionsHits).slice(0, 8)) out.push(`InSight Crime entity "${h.entity || h.name}" matches OFAC ${h.program || h.list || 'SDN'}${h.matchType ? ` (${h.matchType})` : ''}`);
      if (narco?.totals?.sanctionsMatches) out.push(`${narco.totals.sanctionsMatches} cartel-event clusters name an OFAC-listed actor`);
      return out.length ? out : null;
    } },
  { id: 'outages', tab: 'cyber', label: 'Internet disruption in the AOR (IODA)',
    build: ({ data }) => {
      const list = arr(data?.ioda?.countries).filter(c => inAor(c.name) || AOR_ISO2.has(String(c.code || '').toUpperCase()));
      if (!list.length) return null;
      return list.slice(0, 8).map(c => `${c.name} (${c.code}): ${c.severity}, ${c.alerts} alerts${c.maxDropPct ? `, up to ${c.maxDropPct}% drop` : ''}`);
    } },
];

export const SITREP_BUILDERS = EU
  ? ALL_SITREP_BUILDERS.filter(b => !['colombia', 'venezuela', 'caribbeanair', 'sanctions'].includes(b.id)).map(b => ({ ...b, label: b.label.replace(/SOUTHCOM/g, 'EUCOM') }))
  : ALL_SITREP_BUILDERS;
export const SITREP_SECTION_IDS = [...SITREP_BUILDERS.map(b => b.id), ...ASK_SECTION_ORDER];
export const SITREP_SECTION_TABS = { ...SECTION_TABS, ...Object.fromEntries(SITREP_BUILDERS.map(b => [b.id, b.tab])) };

// Build the pack: SOUTHCOM sections first (in builder order), then the Ask sections in reading
// order, dropping whole sections once the budget is spent (always-on sections never drop).
export function buildSitrepPack(state, { maxChars = SITREP_CONTEXT_CHARS, previous = null } = {}) {
  const built = [];
  for (const def of SITREP_BUILDERS) {
    let lines;
    try { lines = def.build({ ...state, previous }); } catch { lines = null; }
    if (!lines || !lines.length) continue;
    built.push({ id: def.id, tab: def.tab, label: def.label, text: clipLines(lines.join('\n'), def.chars || SECTION_CHARS), always: !!def.always });
  }
  let ask;
  try { ask = buildAskPack(state, SOUTHCOM_QUERY, { maxChars: Number.MAX_SAFE_INTEGER }); } catch { ask = { sections: [], asOf: null }; }
  for (const id of ASK_SECTION_ORDER) {
    const s = ask.sections.find(x => x.id === id);
    if (s) built.push({ id: s.id, tab: s.tab, label: s.label, text: s.text, always: id === 'situation' || id === 'defcon' });
  }
  const sections = [], omitted = [];
  let used = 0;
  for (const s of built) {
    const cost = s.text.length + s.label.length + 20;
    if (used + cost > maxChars && !s.always) { omitted.push(s.id); continue; }
    used += cost;
    sections.push({ id: s.id, tab: s.tab, label: s.label, text: s.text });
  }
  const prevSection = previous?.bluf && sections.some(s => s.id === 'previous');
  const prevMeta = prevSection ? { id: previous.id || '?', label: PREVIOUS_LABEL[previous.edition] || previous.edition || 'edition', generatedAt: previous.generatedAt || '?', ageMinutes: previous.ageMinutes ?? null } : null;
  return { asOf: state?.data?.situation?.asOf || state?.lastSweepTime || null, sections, omitted, chars: used, previous: prevMeta };
}

export function renderSitrepPack(pack) {
  return pack.sections.map(s => `### [${s.id}] ${s.label} (tab: ${s.tab})\n${s.text}`).join('\n\n');
}
