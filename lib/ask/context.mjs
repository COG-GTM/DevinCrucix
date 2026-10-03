// Ask CRUCIX — bounded context pack over the live dashboard state.
//
// The /api/data payload is far too large to hand to a model, so each dashboard area is
// reduced to a short, source-attributed text section with a stable id and the tab it lives
// on. Sections are ranked against the question and packed under a character budget; the
// model cites section ids, and the drawer turns those into "jump to tab" links.

export const DEFAULT_CONTEXT_CHARS = 14000;
export const SECTION_CHARS = 1800;

const STOP = new Set(('a an and are as at be by for from has have how in is it of on or that the this to was what when where which who why will with about any does do did there their them they can could should would latest current now today recent tell me show give list').split(' '));

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const arr = v => Array.isArray(v) ? v : [];
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const kv = o => Object.entries(o || {}).filter(([, v]) => v != null && v !== 0 && v !== '' && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(', ');
const clipLines = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const top = (o, n = 6) => Object.entries(o || {}).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
const day = v => { const s = String(v || ''); return s.length >= 10 ? s.slice(0, 10) : s; };

// Pick a human label out of records whose shape differs per source.
function labelOf(o) {
  if (!o || typeof o !== 'object') return clip(o, 160);
  return clip(o.title || o.headline || o.summary || o.text || o.name || o.label || o.question || o.type || JSON.stringify(o), 160);
}

// Each builder returns lines (strings) or null when the area has no data this sweep.
const BUILDERS = [
  { id: 'situation', tab: 'situation', label: 'Situation · headlines & rule counts', always: true, keys: ['situation', 'headline', 'summary', 'overview', 'matter', 'happening', 'alert'],
    build: ({ data }) => {
      const s = data?.situation; if (!s) return null;
      const out = [`as of ${s.asOf || 'unknown'} · rules fired ${s.rulesFired ?? '?'} · counts ${kv(s.counts)}${s.quiet ? ' · QUIET baseline' : ''}`];
      for (const h of arr(s.headlines).slice(0, 8)) out.push(`[${h.severity}] ${clip(h.title, 140)} — ${clip(h.why, 140)} (source: ${h.source || '?'}; tab ${h.tab || '?'})`);
      if (s.prc) out.push(`PRC posture: score ${s.prc.score} ${s.prc.level}; strait ${s.prc.straitCn}, SCS ${s.prc.scsTotal}`);
      return out;
    } },
  { id: 'defcon', tab: 'situation', label: 'DEFCON composite', always: true, keys: ['defcon', 'readiness', 'threat level', 'posture'],
    build: ({ data }) => {
      const d = data?.defcon; if (!d) return null;
      const out = [`DEFCON ${d.level} "${d.label}" score ${d.score}/100 (computed by CRUCIX from weighted components, not an official US DEFCON)`];
      for (const [k, c] of Object.entries(d.components || {})) out.push(`${k}: component score ${c.score}/100 (weight ${c.weight}) · basis: ${clip(c.detail, 100)}${c.available === false ? ' (unavailable)' : ''}`);
      return out;
    } },
  { id: 'delta', tab: 'situation', label: 'Delta since last sweep', keys: ['change', 'changed', 'delta', 'new', 'since', 'escalat', 'deescalat'],
    build: ({ data }) => {
      const d = data?.delta; if (!d?.summary) return null;
      const out = [`changes ${d.summary.totalChanges} (critical ${d.summary.criticalChanges}), direction ${d.summary.direction}, signals ${kv(d.summary.signalBreakdown)}`];
      for (const k of ['new', 'escalated', 'deescalated']) for (const s of arr(d.signals?.[k]).slice(0, 4)) out.push(`${k}: ${clip(s.text, 150)} — ${clip(s.reason, 60)}`);
      return out;
    } },
  { id: 'signals', tab: 'situation', label: 'Correlated signals', keys: ['signal', 'surge', 'military', 'aircraft', 'flight', 'adsb', 'ship', 'ais', 'convergence'],
    build: ({ data }) => {
      const list = arr(data?.signals?.signals); if (!list.length) return null;
      return list.slice(0, 8).map(s => `${s.type} (${s.confidence}% conf, ${s.region || 'global'}): ${clip(s.title, 120)} — ${clip(s.whyItMatters, 140)}`);
    } },
  { id: 'focal', tab: 'situation', label: 'Focal points (entities)', keys: ['focal', 'entity', 'country', 'who', 'actor', 'mention'],
    build: ({ data }) => {
      const list = arr(data?.focalPoints?.focalPoints); if (!list.length) return null;
      return list.slice(0, 8).map(f => `${f.name} (${f.type}) score ${f.score} ${f.urgency}, ${f.mentions} mentions via ${arr(f.sources).join('/')}: ${arr(f.topHeadlines).slice(0, 2).map(h => clip(h, 80)).join(' | ')}`);
    } },
  { id: 'cii', tab: 'situation', label: 'Country Instability Index', keys: ['instability', 'cii', 'unstable', 'country', 'unrest', 'stability'],
    build: ({ data }) => {
      const list = arr(data?.cii?.countries); if (!list.length) return null;
      return [...list].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10).map(c => `${c.name} ${c.score}/100 ${c.level}, trend ${c.trend}${c.trendDelta ? ` (${c.trendDelta > 0 ? '+' : ''}${c.trendDelta})` : ''}; components ${kv(c.components)}`);
    } },
  { id: 'news', tab: 'situation', label: 'World news wire', keys: ['news', 'headline', 'article', 'report', 'press'],
    build: ({ data }) => {
      const list = arr(data?.news); if (!list.length) return null;
      return list.slice(0, 10).map(n => `${clip(n.title, 120)} (${n.source || '?'}, ${day(n.date)})`);
    } },
  { id: 'narco', tab: 'cartels', label: 'Cartel / border-crime events (graded)', chars: 2400, keys: ['cartel', 'narco', 'cjng', 'sinaloa', 'mexico', 'massacre', 'kidnap', 'homicide', 'seizure', 'arrest', 'violence', 'jalisco', 'tamaulipas', 'chihuahua', 'sonora', 'michoac', 'guanajuato', 'zacatecas', 'tijuana', 'juarez', 'culiac'],
    build: ({ narco }) => {
      const t = narco?.totals; if (!t) return null;
      const out = [`${t.current} current clusters in a ${narco.windowDays || '?'}-day window (grades ${kv(t.byGrade)}); by type ${top(t.byType, 6)}; by state ${top(t.byState, 6)}; by cartel ${top(t.byCartel, 6)}; OFAC sanctions matches ${t.sanctionsMatches ?? 0}`];
      for (const e of arr(narco.events).filter(e => !e.historical).slice(0, 14)) {
        const loc = e.location ? [e.location.municipality || e.location.city, e.location.state].filter(Boolean).join(', ') : 'location unknown';
        out.push(`${day(e.date)} ${e.typeLabel || e.type} · ${loc} · cartels ${arr(e.cartels).map(c => c.short || c.id).join('/') || 'none named'} · grade ${e.grade || e.evidence?.grade || '?'} · ${labelOf(e.headline || e.title || e.summary || arr(e.sources)[0]?.title || e.people?.join(', '))}`);
      }
      return out;
    } },
  { id: 'border', tab: 'cartels', label: 'Border Watch news (US–MX local outlets)', chars: 2000, keys: ['border', 'cbp', 'migration', 'migrant', 'el paso', 'rio grande', 'laredo', 'reynosa', 'matamoros', 'nogales', 'tijuana', 'spike', 'enforcement', 'rail', 'port of entry'],
    build: ({ data }) => {
      const b = data?.borderNews; if (!b?.summary) return null;
      const out = [`${b.summary.articlesInWindow} articles / ${b.summary.windowDays}d; topics ${top(b.summary.topicCounts, 7)}; outlets ${Object.keys(b.summary.outletCounts || {}).length}`];
      for (const s of arr(b.spikes).slice(0, 5)) out.push(`SPIKE ${s.placeName} (${s.sector}) ${s.topic}: ${s.count24h} in 24h vs ${s.baselineDailyMean}/day baseline (${s.ratio}×)`);
      for (const a of arr(b.articles).slice(0, 10)) out.push(`${day(a.publishedAt)} ${a.outlet}: ${clip(a.title, 120)}${arr(a.topics).length ? ` [${a.topics.join(',')}]` : ''}`);
      return out;
    } },
  { id: 'cbp', tab: 'cartels', label: 'CBP official statistics', keys: ['cbp', 'encounter', 'apprehension', 'seizure', 'fentanyl', 'custody', 'use of force', 'official'],
    build: ({ data }) => {
      const c = data?.cbpStats; if (!c || c.status === 'off') return null;
      const out = [`status ${c.status || '?'}${c.fetchedAt ? ` as of ${day(c.fetchedAt)}` : ''}`];
      for (const [k, v] of Object.entries(c).slice(0, 14)) if (v && typeof v === 'object' && !Array.isArray(v)) out.push(`${k}: ${clip(kv(v), 220)}`);
      return out.length > 1 ? out : null;
    } },
  { id: 'insightcrime', tab: 'cartels', label: 'InsightCrime reporting', keys: ['insight', 'organized crime', 'latin america', 'cocaine', 'honduras', 'colombia', 'venezuela', 'ecuador', 'brazil'],
    build: ({ data }) => {
      const list = arr(data?.insightCrime?.articles); if (!list.length) return null;
      return list.slice(0, 6).map(a => `${day(a.date)} ${clip(a.title.replace(/&#8217;/g, '’').replace(/&amp;/g, '&'), 120)} [${arr(a.categories).slice(0, 3).join(', ')}]`);
    } },
  { id: 'cjng', tab: 'cartels', label: 'CJNG knowledge graph (verified graph; analyst-reviewed)', chars: 2000, keys: ['cjng', 'jalisco', 'mencho', 'graph', 'network', 'faction', 'leader', 'relationship', 'connected', 'link', 'who is', 'person'],
    build: ({ graph, question }) => {
      if (!graph?.nodes) return null;
      const t = graph.totals || {};
      const out = [`${graph.snapshot ? 'snapshot' : 'live'} graph computed ${day(graph.computedAt)}: ${kv(t)}`];
      const byType = type => graph.nodes.filter(n => n.type === type).sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 6).map(n => `${n.label} (${n.articles ?? '?'} art)`).join('; ');
      out.push(`top people: ${byType('person')}`, `top orgs/factions: ${graph.nodes.filter(n => n.type === 'org' || n.type === 'faction').slice(0, 6).map(n => n.label).join('; ')}`, `top places: ${byType('place')}`);
      const toks = questionTokens(question).filter(w => w.length >= 4);
      const hits = toks.length ? graph.nodes.filter(n => { const l = [n.label, ...arr(n.aliases), ...arr(n.meta?.aliases)].join(' ').toLowerCase(); return toks.some(w => l.includes(w)); }).slice(0, 5) : [];
      const edges = arr(graph.edges || graph.links);
      for (const n of hits) {
        const nb = edges.filter(e => (e.source ?? e.from) === n.id || (e.target ?? e.to) === n.id).slice(0, 6)
          .map(e => { const src = e.source ?? e.from, dst = e.target ?? e.to; const rel = e.rel || e.type || 'related'; const other = graph.nodes.find(x => x.id === (src === n.id ? dst : src)); const ol = other?.label || (src === n.id ? dst : src); return src === n.id ? `${rel} → ${ol}` : `${ol} ${rel} → ${n.label}`; });
        out.push(`node ${n.label} [${n.type}] ${n.articles ?? '?'} articles, degree ${n.degree ?? '?'}${nb.length ? `: ${nb.join('; ')}` : ''}`);
      }
      return out;
    } },
  { id: 'kev', tab: 'cyber', label: 'CISA KEV (known exploited vulnerabilities)', keys: ['cve', 'kev', 'cyber', 'vulnerab', 'exploit', 'ransomware', 'cisa', 'patch'],
    build: ({ data }) => {
      const k = data?.cyberKev; const list = arr(k?.vulnerabilities); if (!list.length) return null;
      return [`${k.totalVulnerabilities ?? list.length} tracked; ${list.filter(v => v.ransomware).length} ransomware-linked in view`, ...list.slice(0, 8).map(v => `${v.cveID} ${v.vendor} ${v.product} (${v.severity}, added ${v.dateAdded}${v.ransomware ? ', ransomware' : ''}): ${clip(v.description, 110)}`)];
    } },
  { id: 'telegram', tab: 'cyber', label: 'Telegram OSINT channels (unverified posts)', keys: ['telegram', 'osint', 'channel', 'post', 'rumor', 'breaking'],
    build: ({ data }) => {
      const list = arr(data?.telegramLive?.recentMessages); if (!list.length) return null;
      return list.slice(0, 8).map(m => `${day(m.timestamp)} @${m.channel}: ${clip(m.text, 150)}`);
    } },
  { id: 'macro', tab: 'macro', label: 'Markets & prediction odds', keys: ['market', 'stock', 'index', 'oil', 'energy', 'rate', 'yield', 'odds', 'polymarket', 'probability', 'election', 'price', 'economy', 'trade'],
    build: ({ data }) => {
      const out = [];
      for (const i of arr(data?.markets?.indexes).slice(0, 8)) out.push(`${i.name} ${i.price} (${i.changePct > 0 ? '+' : ''}${i.changePct}%)`);
      for (const m of arr(data?.polymarket?.markets).slice(0, 6)) out.push(`odds: ${clip(m.question, 110)} → yes ${m.yesProb}%`);
      for (const i of arr(data?.ideas?.ideas || data?.ideas).slice(0, 4)) out.push(`trade idea (model-generated, not advice): ${labelOf(i)}`);
      return out.length ? out : null;
    } },
  { id: 'ukraine', tab: 'ukraine', label: 'Ukraine War theater', keys: ['ukraine', 'russia', 'russian', 'kyiv', 'moscow', 'front', 'deepstate', 'znpp', 'donetsk', 'kharkiv', 'zaporizh', 'crimea'],
    build: ({ data }) => {
      const u = data?.ukraine; if (!u) return null;
      const f = u.front || {}; const out = [];
      if (f.status) out.push(`DeepStateMAP ${f.status}${f.stale ? ' (stale)' : ''}, map updated ${day(f.mapUpdatedAt)}: occupied ${num(f.occupiedKm2) ? Math.round(f.occupiedKm2) : '?'} km², contested ${num(f.contestedKm2) ? Math.round(f.contestedKm2) : '?'} km², ${arr(f.attackDirections).length} attack directions, ${arr(f.units).length} RU units, ${arr(f.airfields).length} airfields`);
      for (const d of arr(f.attackDirections).slice(0, 5)) out.push(`axis: ${labelOf(d)}`);
      for (const [k, v] of Object.entries(u)) if (k !== 'front' && v && typeof v === 'object' && (v.status || v.source)) out.push(`${k}: ${v.status || 'n/a'}${v.summary ? ` — ${clip(labelOf(v.summary), 120)}` : ''}`);
      return out.length ? out : null;
    } },
  { id: 'iranwar', tab: 'iranwar', label: 'Iran War Live (machine-extracted, observational)', keys: ['iran', 'israel', 'tehran', 'hormuz', 'irgc', 'houthi', 'hezbollah', 'gulf', 'saudi', 'strike'],
    build: ({ data }) => {
      const i = data?.iranwar; if (!i || !i.status) return null;
      const out = [`feed ${i.status}${i.stale ? ' (stale)' : ''}, latest event ${i.latestEventAt || '?'}; counts ${clip(kv(i.counts), 200)}${i.casualties ? `; casualties ${clip(kv(i.casualties), 120)}` : ''}`];
      for (const e of arr(i.events).slice(0, 8)) out.push(`${day(e.date || e.time || e.at || e.timestamp)} ${labelOf(e)}`);
      return out;
    } },
  { id: 'taiwan', tab: 'taiwan', label: 'China / Taiwan (MND bulletins, grey zone)', keys: ['taiwan', 'china', 'chinese', 'pla', 'adiz', 'strait', 'beijing', 'taipei', 'coast guard', 'grey zone', 'gray zone', 'prc'],
    build: ({ data }) => {
      const t = data?.taiwan; const b = t?.mnd?.bulletin; if (!t) return null;
      const out = [];
      if (b) out.push(`MND bulletin ${b.publishedDate}: ${b.aircraft ?? '?'} PLA aircraft, ${b.adizEntries ?? b.adiz ?? '?'} ADIZ entries, ${b.ships ?? b.vessels ?? '?'} vessels${b.balloons != null ? `, ${b.balloons} balloons` : ''} (${t.mnd.siteUrl})`);
      for (const [k, v] of Object.entries(t)) if (k !== 'mnd' && v && typeof v === 'object' && v.status) out.push(`${k}: ${v.status}${v.summary ? ` — ${clip(labelOf(v.summary), 120)}` : ''}`);
      return out.length ? out : null;
    } },
  { id: 'requirements', tab: 'requirements', label: 'Standing requirements (analyst-authored)', keys: ['requirement', 'standing', 'watch', 'threshold', 'fired', 'pir', 'rule'],
    build: ({ requirements }) => {
      const rules = arr(requirements?.rules); if (!rules.length) return null;
      return [`${rules.length} rules, ${requirements.firedCount || 0} fired this sweep`, ...rules.slice(0, 10).map(r => `${r.latest?.fired ? 'FIRED' : 'quiet'} [${r.severity}] ${clip(r.name, 60)}: ${clip(r.text, 120)}${r.latest?.value != null ? ` (value ${r.latest.value}${r.latest.baseline != null ? ` vs baseline ${r.latest.baseline}` : ''})` : ''}`)];
    } },
  { id: 'targeting', tab: 'targeting', label: 'Target Development packages (analyst-nominated)', keys: ['target', 'nominate', 'dossier', 'package', 'find', 'fix', 'last known', 'pattern of activity', 'proposal'],
    build: ({ targets }) => {
      const list = arr(targets); if (!list.length) return null;
      return list.slice(0, 8).map(t => `${t.label} (${t.type}, ${t.status}, priority ${t.priority}) — requirement: ${clip(t.requirement, 100)}${t.stats ? `; links ${t.stats.links} (${t.stats.pendingLinks} pending, ${t.stats.accepted} accepted, ${t.stats.rejected} rejected), graph proposals ${t.stats.proposals}${t.stats.lastKnown ? `; last known ${t.stats.lastKnown.place} ${t.stats.lastKnown.date}` : ''}` : '; not yet developed'}`);
    } },
  { id: 'sources', tab: 'sources', label: 'Source health', keys: ['source', 'feed', 'health', 'degraded', 'offline', 'key', 'missing', 'why not', 'stale', 'working'],
    build: ({ data }) => {
      const h = data?.meta?.health; if (!h) return null;
      const out = [`sources: ${kv(h)}`];
      for (const s of arr(data.meta.sources).filter(s => s.status && s.status !== 'live').slice(0, 10)) out.push(`${s.name || s.id}: ${s.status}${s.error ? ` — ${clip(s.error, 80)}` : ''}`);
      return out;
    } },
];

export const SECTION_IDS = BUILDERS.map(b => b.id);
export const SECTION_TABS = Object.fromEntries(BUILDERS.map(b => [b.id, b.tab]));

export function questionTokens(q) {
  return [...new Set(String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w)))];
}

function relevance(def, text, toks) {
  const q = toks.join(' ');
  let score = 0;
  for (const k of def.keys) if (q.includes(k)) score += 4;
  const lower = text.toLowerCase();
  for (const w of toks) { let n = 0, i = -1; while ((i = lower.indexOf(w, i + 1)) >= 0 && n < 3) n++; score += n; }
  return score;
}

export function buildContextPack(state, question, { maxChars = DEFAULT_CONTEXT_CHARS } = {}) {
  const toks = questionTokens(question);
  const built = [];
  for (const def of BUILDERS) {
    let lines;
    try { lines = def.build({ ...state, question }); } catch { lines = null; }
    if (!lines || !lines.length) continue;
    const text = clipLines(lines.join('\n'), def.chars || SECTION_CHARS);
    built.push({ id: def.id, tab: def.tab, label: def.label, text, score: relevance(def, text, toks), always: !!def.always, order: built.length });
  }
  built.sort((a, b) => (b.always - a.always) || (b.score - a.score) || (a.order - b.order));
  const sections = [], omitted = [];
  let used = 0;
  for (const s of built) {
    const cost = s.text.length + s.label.length + 20;
    if (used + cost > maxChars && !s.always) { omitted.push(s.id); continue; }
    used += cost; sections.push({ id: s.id, tab: s.tab, label: s.label, text: s.text, score: s.score });
  }
  return {
    asOf: state.data?.situation?.asOf || state.lastSweepTime || null,
    sections, omitted, chars: used, tokens: toks,
  };
}

export function renderContextPack(pack) {
  return pack.sections.map(s => `### [${s.id}] ${s.label} (tab: ${s.tab})\n${s.text}`).join('\n\n');
}
