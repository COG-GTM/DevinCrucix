// FIND — gather every public mention of a nominated target across the sources CRUCIX already holds and
// turn them into (a) verbatim, URL-backed mentions, (b) published selectors, and (c) correlation
// candidates: other actors, personas and places that the sources tie to the target.
//
// Nothing here is inferred. A mention exists only when an alias of the target literally occurs in a
// document; a candidate exists only when a source names it in the same sentence as the target (or the
// knowledge graph already carries a sourced edge). The LLM step (adjudicate.mjs) may re-rank or
// re-label candidates but cannot add ones the sources never named.
import { fold, findPlaces, loadGazetteer } from '../narco/gazetteer.mjs';
import { loadGroups, findGroups, maskGroupNames } from '../narco/groups.mjs';
import { extractPeople } from '../narco/extract.mjs';
import { matchName, buildNameIndex, sdnSearchUrl } from '../../apis/sources/ofacnarco.mjs';
import { sha } from './store.mjs';
import { RELATIONS } from '../cjng/graph.mjs';

/** Graph snapshots carry `confidence: 'typed' | 'co-mention'`; derive it from the relation taxonomy when absent. */
function edgeConfidence(e) { return e.confidence || (RELATIONS[e.type]?.typed ? 'typed' : 'co-mention'); }

export const MAX_MENTIONS = 400;
export const MAX_SENTENCE_CHARS = 420;
export const MAX_EVIDENCE_PER_CANDIDATE = 6;
export const MAX_CANDIDATES = 80;
export const MAX_SELECTORS = 60;
export const MIN_ALIAS_CHARS = 5;
export const SOURCES = {
  kg: { label: 'Knowledge graph (InSight Crime)', tier: 'reported' },
  insightcrime: { label: 'InSight Crime', tier: 'reported' },
  doj: { label: 'DOJ press release', tier: 'official' },
  ofac: { label: 'OFAC SDN list', tier: 'official' },
  bordernews: { label: 'Border / Mexico press', tier: 'reported' },
  telegram: { label: 'Telegram public channel', tier: 'unverified' },
  narco: { label: 'Graded narco event', tier: 'reported' },
};

const STOP_ALIASES = new Set(['el', 'la', 'los', 'las', 'cartel', 'mexico', 'jalisco', 'sinaloa']);

export function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Aliases become word-bounded regexes over folded text. Single tokens must be distinctive (>= 5 chars, not a stop word). */
export function aliasMatchers(label, aliases = []) {
  const out = [];
  const seen = new Set();
  for (const raw of [label, ...aliases]) {
    const f = fold(String(raw || '')).replace(/\s+/g, ' ').trim();
    if (!f || seen.has(f)) continue;
    const toks = f.split(' ').filter(Boolean);
    if (toks.length === 1 && (f.length < MIN_ALIAS_CHARS || STOP_ALIASES.has(f))) continue;
    // "El Mencho" -> also match bare "Mencho"; particles alone never match.
    seen.add(f);
    out.push({ alias: String(raw).trim(), folded: f, re: new RegExp(`(^|[^a-z0-9])${esc(f)}(?![a-z0-9])`, 'g') });
    if (toks.length === 2 && STOP_ALIASES.has(toks[0]) && toks[1].length >= MIN_ALIAS_CHARS && !seen.has(toks[1])) {
      seen.add(toks[1]);
      out.push({ alias: String(raw).trim(), folded: toks[1], re: new RegExp(`(^|[^a-z0-9])${esc(toks[1])}(?![a-z0-9])`, 'g'), weak: true });
    }
  }
  return out;
}

export function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+(?=[A-Z\u00C0-\u00DC“"'(])/).map(s => s.trim()).filter(s => s.length >= 12);
}

/** Sentences of `text` that contain any alias; each returns which alias hit. */
export function matchingSentences(text, matchers, { max = 8 } = {}) {
  const out = [];
  for (const s of splitSentences(text)) {
    const f = fold(s);
    const hit = matchers.find(m => { m.re.lastIndex = 0; return m.re.test(f); });
    if (!hit) continue;
    out.push({ sentence: s.slice(0, MAX_SENTENCE_CHARS), alias: hit.alias, weak: Boolean(hit.weak) });
    if (out.length >= max) break;
  }
  return out;
}

export function day(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
}
function mentionId(source, docId, sentence) { return `m_${sha(`${source}|${docId}|${sentence}`).slice(0, 12)}`; }
function publicUrl(u) {
  if (typeof u !== 'string') return null;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString().slice(0, 400) : null; } catch { return null; }
}

/**
 * Resolve the target against the knowledge graph: nodes whose label or aliases match, with their edges.
 * `graph` is the CJNG graph object (nodes/edges/articles) or null.
 */
export function graphAnchors(graph, matchers) {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  const anchors = [];
  for (const n of graph.nodes) {
    if (!['person', 'org', 'faction'].includes(n.type)) continue;
    const names = [n.label, ...(n.meta?.aliases || [])].map(fold);
    if (names.some(nm => matchers.some(m => m.folded === nm))) anchors.push(n);
  }
  return anchors;
}

// ---- selectors ---------------------------------------------------------------------------------
// Only identifiers a public document literally publishes. Phone/email only from official documents
// (OFAC/DOJ), which list them for designated businesses; press mentions of numbers are tip lines.
const SELECTOR_RES = [
  { kind: 'doj-case', re: /\b(?:Case|Cause|Docket)\s+(?:No\.?|Number|#)\s*:?\s*([0-9]{1,2}:[0-9]{2}-[A-Za-z]{2,3}-[0-9]{2,6}(?:-[A-Za-z0-9-]{1,12})?)/gi, any: true },
  { kind: 'doj-case', re: /\b([0-9]{1,2}:[0-9]{2}-(?:cr|cv|mj|CR|CV|MJ)-[0-9]{3,6}(?:-[A-Za-z0-9-]{1,12})?)\b/g, any: true },
  { kind: 'imo', re: /\bIMO\s*(?:No\.?|Number|#)?\s*:?\s*([0-9]{7})\b/gi, any: true },
  { kind: 'aircraft-reg', re: /\b(?:tail\s+number|registration|matr[ií]cula|registered\s+as)\s*:?\s*([A-Z]{1,2}-?[A-Z0-9]{3,5})\b/g, any: true },
  { kind: 'domain', re: /\b(?:website|web\s*site|sitio\s+web|domain)\s*:?\s*((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi, any: true },
  { kind: 'email', re: /\b(?:e-?mail)\s*:?\s*([A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/gi, official: true },
  { kind: 'phone', re: /\b(?:tel(?:ephone)?|phone)\s*(?:no\.?|number)?\s*:?\s*(\+?\(?[0-9][0-9 ().-]{7,18}[0-9])/gi, official: true },
];
export function extractSelectors(text, { source, url = null, date = null, existing = [] } = {}) {
  const out = [];
  const official = SOURCES[source]?.tier === 'official';
  const s = String(text || '');
  for (const def of SELECTOR_RES) {
    if (def.official && !official) continue;
    def.re.lastIndex = 0;
    let m;
    while ((m = def.re.exec(s)) !== null) {
      const value = m[1].replace(/\s+/g, ' ').trim().slice(0, 60);
      const key = `${def.kind}|${value.toLowerCase()}`;
      if (existing.some(e => e.key === key) || out.some(e => e.key === key)) continue;
      const start = Math.max(0, m.index - 80), end = Math.min(s.length, m.index + m[0].length + 80);
      out.push({ key, kind: def.kind, value, source, url, date, evidence: s.slice(start, end).replace(/\s+/g, ' ').trim() });
      if (out.length + existing.length >= MAX_SELECTORS) return out;
    }
  }
  return out;
}

// ---- persona cues ---------------------------------------------------------------------------------
// "alias 'El 08'", "(a.k.a. Tony Montana)", "known as" — a persona is proposed only when the cue sits in a
// sentence that also names the target, and the analyst must accept it before it becomes an alias.
const PERSONA_RES = [
  /\b(?:alias|a\.?\s?k\.?\s?a\.?|also known as|known as|apodado|conocido como|nicknamed)\s+[“"'‘]?([A-Za-z\u00C0-\u017F0-9][A-Za-z\u00C0-\u017F0-9 .'-]{1,40}?)[”"'’]?(?=[,.;:)]|\s(?:and|who|y|que|the|a|an|was|is|has|had)\b|$)/gi,
  /[“"]([A-Z][A-Za-z\u00C0-\u017F0-9 .'-]{1,30})[”"],?\s+(?:the|a|an)\s+(?:alleged|reputed|purported)?\s*(?:leader|boss|lieutenant|plaza boss|jefe|capo|operator|financier|hitman|sicario)/g,
];
export function extractPersonas(sentence, matchers) {
  const out = [];
  for (const re of PERSONA_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sentence)) !== null) {
      const name = m[1].replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
      const f = fold(name);
      if (f.length < 3 || matchers.some(x => x.folded === f)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out.slice(0, 4);
}

// ---- gathering ---------------------------------------------------------------------------------

/**
 * @param target  stored target (label, aliases, type, basis)
 * @param ctx     { graph, corpus, articles, dojReleases, ofacIndex, telegram, narcoClusters, gz, groups }
 *                Every input is optional; missing sources are reported in `coverage`, never faked.
 */
export function gatherMentions(target, ctx = {}) {
  const gz = ctx.gz || loadGazetteer();
  const groups = ctx.groups || loadGroups();
  const matchers = aliasMatchers(target.label, target.aliases);
  const mentions = [];
  const selectors = [];
  const coverage = {};
  const seen = new Set();
  const push = (m) => {
    if (mentions.length >= MAX_MENTIONS) return false;
    const id = mentionId(m.source, m.docId, m.sentence);
    if (seen.has(id)) return true;
    seen.add(id);
    // Every date leaves this module as YYYY-MM-DD or null, whatever the source stored.
    mentions.push({ id, ...m, date: day(m.date) });
    return true;
  };
  const addSelectors = (text, source, url, date) => { for (const s of extractSelectors(text, { source, url, date, existing: selectors })) selectors.push(s); };

  // Knowledge graph: anchors + edges + per-article evidence sentences.
  const anchors = graphAnchors(ctx.graph, matchers);
  coverage.kg = { available: Boolean(ctx.graph), anchors: anchors.map(a => a.id), articles: 0 };
  if (ctx.graph && anchors.length) {
    const articlesById = new Map((ctx.graph.articles || []).map(a => [a.id, a]));
    const anchorIds = new Set(anchors.map(a => a.id));
    for (const e of ctx.graph.edges || []) {
      if (!anchorIds.has(e.source) && !anchorIds.has(e.target)) continue;
      for (const ev of e.evidence || []) {
        const art = articlesById.get(ev.a);
        if (!ev.s) continue;
        const hit = matchingSentences(ev.s, matchers, { max: 1 })[0];
        push({ source: 'kg', docId: String(ev.a), title: art?.title || null, url: publicUrl(art?.link), date: day(ev.d || art?.date), sentence: ev.s.slice(0, MAX_SENTENCE_CHARS), alias: hit?.alias || target.label, edge: e.id, weak: hit ? hit.weak : true });
        coverage.kg.articles++;
      }
    }
    for (const a of anchors) for (const ev of a.meta?.events || []) {
      const art = articlesById.get(ev.a);
      push({ source: 'kg', docId: String(ev.a), title: art?.title || null, url: publicUrl(art?.link), date: day(ev.d || art?.date), sentence: String(ev.s || '').slice(0, MAX_SENTENCE_CHARS), alias: target.label, eventKind: ev.kind, weak: false });
    }
  }

  // InSight Crime corpus (full text, when the server has fetched it).
  const corpusArticles = ctx.corpus?.articles || [];
  coverage.insightcrime = { available: Boolean(ctx.corpus), scanned: corpusArticles.length, hits: 0 };
  for (const a of corpusArticles) {
    const text = `${a.title || ''}. ${a.text || a.excerpt || ''}`;
    const hits = matchingSentences(text, matchers, { max: 6 });
    if (!hits.length) continue;
    coverage.insightcrime.hits++;
    const url = publicUrl(a.link);
    for (const h of hits) push({ source: 'insightcrime', docId: String(a.id), title: a.title || null, url, date: day(a.date), ...h });
    addSelectors(text, 'insightcrime', url, day(a.date));
  }

  // Border / Mexico press (bordernews store).
  const articles = ctx.articles || [];
  coverage.bordernews = { available: Array.isArray(ctx.articles), scanned: articles.length, hits: 0 };
  for (const a of articles) {
    const text = `${a.title || ''}. ${a.text || a.summary || ''}`;
    const hits = matchingSentences(text, matchers, { max: 4 });
    if (!hits.length) continue;
    coverage.bordernews.hits++;
    const url = publicUrl(a.url);
    for (const h of hits) push({ source: 'bordernews', docId: a.id, title: a.title || null, outlet: a.outlet || null, url, date: day(a.publishedAt), ...h });
    addSelectors(text, 'bordernews', url, day(a.publishedAt));
  }

  // DOJ press releases.
  const doj = ctx.dojReleases || [];
  coverage.doj = { available: Array.isArray(ctx.dojReleases), scanned: doj.length, hits: 0 };
  for (const r of doj) {
    const text = `${r.title || ''}. ${r.teaser || ''} ${r.body || ''}`;
    const hits = matchingSentences(text, matchers, { max: 6 });
    if (!hits.length) continue;
    coverage.doj.hits++;
    const url = publicUrl(r.url);
    for (const h of hits) push({ source: 'doj', docId: r.id, title: r.title || null, district: r.district?.name || null, url, date: day(r.publishedAt), ...h });
    addSelectors(text, 'doj', url, day(r.publishedAt));
    if (r.number) selectors.push({ key: `doj-release|${r.number}`, kind: 'doj-release', value: String(r.number), source: 'doj', url, date: day(r.publishedAt), evidence: r.title || '' });
  }

  // OFAC narco-program index: designation record for the target itself and every listed a.k.a.
  coverage.ofac = { available: Boolean(ctx.ofacIndex), matched: 0 };
  const ofacHits = [];
  if (ctx.ofacIndex?.entries?.length) {
    const nameIdx = buildNameIndex(ctx.ofacIndex);
    const tried = new Set();
    for (const m of matchers) {
      if (m.weak || tried.has(m.folded)) continue;
      tried.add(m.folded);
      const hit = matchName(m.alias, ctx.ofacIndex, nameIdx);
      if (!hit || ofacHits.some(h => h.entry.uid === hit.entry.uid)) continue;
      ofacHits.push(hit);
    }
    for (const h of ofacHits) {
      const e = h.entry;
      coverage.ofac.matched++;
      const url = sdnSearchUrl(e.name);
      const pub = day(ctx.ofacIndex.publishDate) || null;
      const sentence = `OFAC SDN ${e.uid}: ${e.name} (${e.type}) — programs ${(e.programs || []).join(', ') || 'n/a'}${e.dob ? `; DOB ${e.dob}` : ''}${e.pob ? `; POB ${e.pob}` : ''}${(e.countries || []).length ? `; ${e.countries.join(', ')}` : ''}${(e.akas || []).length ? `; a.k.a. ${e.akas.map(a => a.name).slice(0, 8).join(' / ')}` : ''}`;
      push({ source: 'ofac', docId: String(e.uid), title: `SDN ${e.uid} · ${e.name}`, url, date: pub, sentence: sentence.slice(0, MAX_SENTENCE_CHARS), alias: h.matchedName, weak: false, ofac: { uid: e.uid, strength: h.strength, programs: e.programs || [], akas: (e.akas || []).map(a => a.name).slice(0, 12) } });
      if (e.remarks) push({ source: 'ofac', docId: `${e.uid}:remarks`, title: `SDN ${e.uid} · remarks`, url, date: pub, sentence: String(e.remarks).slice(0, MAX_SENTENCE_CHARS), alias: h.matchedName, weak: false });
      selectors.push({ key: `ofac-uid|${e.uid}`, kind: 'ofac-uid', value: String(e.uid), source: 'ofac', url, date: pub, evidence: sentence.slice(0, 200) });
      for (const p of (e.programs || []).slice(0, 6)) if (!selectors.some(s => s.key === `ofac-program|${p}`)) selectors.push({ key: `ofac-program|${p}`, kind: 'ofac-program', value: String(p), source: 'ofac', url, date: pub, evidence: `${e.name} listed under ${p}` });
      for (const x of (e.ids || []).slice(0, 10)) {
        if (!x?.value || /Organization Type|Target Type|Gender/i.test(x.type || '')) continue;
        const key = `ofac-id|${String(x.value).toLowerCase()}`;
        if (!selectors.some(s => s.key === key)) selectors.push({ key, kind: 'ofac-id', value: `${x.type ? x.type + ' ' : ''}${x.value}`.slice(0, 80), source: 'ofac', url, date: pub, evidence: `${e.name} · SDN ${e.uid}` });
      }
      if (e.remarks) addSelectors(e.remarks, 'ofac', url, pub);
    }
  }

  // Telegram public channels (unverified tier: kept apart, never used for location).
  const tg = ctx.telegram || [];
  coverage.telegram = { available: Array.isArray(ctx.telegram), scanned: tg.length, hits: 0 };
  for (const msg of tg) {
    const hits = matchingSentences(msg.text || '', matchers, { max: 2 });
    if (!hits.length) continue;
    coverage.telegram.hits++;
    for (const h of hits) push({ source: 'telegram', docId: msg.id, title: `@${msg.channel}`, channel: msg.channel, url: publicUrl(msg.url), date: day(msg.timestamp), hasMedia: Boolean(msg.hasMedia), ...h });
  }

  // Graded narco events (already-located, already-dated clusters that name the target).
  const clusters = ctx.narcoClusters || [];
  coverage.narco = { available: Array.isArray(ctx.narcoClusters), scanned: clusters.length, hits: 0 };
  for (const c of clusters) {
    const names = [...(c.people || []).map(p => typeof p === 'string' ? p : p?.name), ...(c.leaders || []).map(l => typeof l === 'string' ? l : l?.name)].filter(Boolean);
    const text = `${c.title || c.headline || ''}. ${c.summary || ''} ${names.join('; ')}`;
    const hits = matchingSentences(text, matchers, { max: 2 });
    if (!hits.length) continue;
    coverage.narco.hits++;
    const src = (c.sources || c.docs || [])[0] || {};
    for (const h of hits) push({ source: 'narco', docId: c.id, title: c.title || c.headline || null, url: publicUrl(src.url), date: day(c.date), grade: c.confidence?.grade || null, eventType: c.eventType || null, location: c.location?.lat != null ? { name: c.location.city || c.location.municipality || c.location.state, state: c.location.state, adm1: c.location.adm1, lat: c.location.lat, lon: c.location.lon, precision: c.location.precision } : null, ...h });
  }

  const candidates = buildCandidates(target, mentions, { anchors, graph: ctx.graph, ofacHits, matchers, gz, groups });
  return {
    matchers: matchers.map(m => ({ alias: m.alias, weak: Boolean(m.weak) })),
    mentions: mentions.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
    selectors: selectors.slice(0, MAX_SELECTORS),
    candidates,
    anchors: anchors.map(a => ({ id: a.id, label: a.label, type: a.type, articles: a.articles, first: a.first, last: a.last, aliases: a.meta?.aliases || [], groupId: a.meta?.groupId || null })),
    coverage,
  };
}

/** Blank person names and cartel names so "Rubén Guerrero" / "Sinaloa Cartel" never read as places. */
export function maskNames(sentence, people = [], groups = loadGroups()) {
  let s = maskGroupNames(sentence, groups);
  for (const p of people) if (p?.name) s = s.split(p.name).join(' '.repeat(p.name.length));
  return s;
}

/** "Nemesio Ruben Oseguera Cervantes" vs "Nemesio Oseguera Cervantes": shares >= 2 name tokens incl. the last one. */
export function nameVariantOf(folded, target) {
  const tt = fold(target.label).split(' ').filter(t => t.length > 2);
  const ft = folded.split(' ').filter(t => t.length > 2);
  if (tt.length < 2 || ft.length < 2) return false;
  const shared = ft.filter(t => tt.includes(t));
  return shared.length >= 2 && ft.includes(tt[tt.length - 1]);
}

// ---- correlation candidates ---------------------------------------------------------------------------

function candId(kind, key) { return `lnk_${sha(`${kind}|${key}`).slice(0, 12)}`; }

/**
 * Candidates are (1) graph neighbours of the anchor node(s) with their typed relation and evidence,
 * (2) actors named in the same sentence as the target in any mention, (3) personas proposed by alias cues
 * or OFAC a.k.a. lists. Evidence is always the verbatim sentence + URL; counts are how many distinct
 * documents support the tie.
 */
export function buildCandidates(target, mentions, { anchors = [], graph = null, ofacHits = [], matchers, gz, groups }) {
  const byId = new Map();
  const add = (id, base, ev) => {
    let c = byId.get(id);
    if (!c) { c = { id, ...base, docs: new Set(), evidence: [], sources: new Set() }; byId.set(id, c); }
    if (ev) {
      if (ev.docId) c.docs.add(`${ev.source}|${ev.docId}`);
      c.sources.add(ev.source);
      if (c.evidence.length < MAX_EVIDENCE_PER_CANDIDATE && !c.evidence.some(e => e.sentence === ev.sentence)) c.evidence.push({ sentence: ev.sentence, url: ev.url || null, date: ev.date || null, source: ev.source, title: ev.title || null });
    }
    return c;
  };
  const anchorIds = new Set(anchors.map(a => a.id));
  const nodeById = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const articlesById = new Map((graph?.articles || []).map(a => [a.id, a]));

  // (1) graph neighbours
  for (const e of graph?.edges || []) {
    const other = anchorIds.has(e.source) ? e.target : anchorIds.has(e.target) ? e.source : null;
    if (!other || anchorIds.has(other)) continue;
    const n = nodeById.get(other);
    if (!n || n.type === 'topic') continue;
    const directed = anchorIds.has(e.source) ? 'out' : 'in';
    const c = add(candId('node', n.id), { kind: n.type === 'place' || n.type === 'country' ? 'place' : 'entity', label: n.label, nodeId: n.id, type: n.type, rel: e.type, relDirection: directed, relConfidence: edgeConfidence(e), coMentions: 0, articles: e.articles || 0, meta: n.type === 'place' ? { lat: n.meta?.lat, lon: n.meta?.lon, adm1: n.meta?.adm1, country: n.meta?.country } : n.type === 'person' ? { aliases: (n.meta?.aliases || []).slice(0, 6), groupId: n.meta?.groupId || null } : {} }, null);
    // Typed relations outrank plain co-mention when both exist.
    if (c.rel === 'mentioned_with' && e.type !== 'mentioned_with') { c.rel = e.type; c.relDirection = directed; c.relConfidence = edgeConfidence(e); }
    c.coMentions += e.mentions || 0;
    for (const ev of (e.evidence || []).slice(0, MAX_EVIDENCE_PER_CANDIDATE)) {
      const art = articlesById.get(ev.a);
      add(c.id, {}, { source: 'kg', docId: String(ev.a), sentence: String(ev.s || '').slice(0, MAX_SENTENCE_CHARS), url: art?.link || null, date: ev.d || art?.date || null, title: art?.title || null });
    }
  }

  // (2) same-sentence actors in mentions (people via extractor, groups via alias list, places via gazetteer)
  const known = new Set((graph?.nodes || []).filter(n => n.type === 'person').flatMap(n => [n.label, ...(n.meta?.aliases || [])]).map(fold));
  const labelByFold = new Map((graph?.nodes || []).filter(n => n.type === 'person').flatMap(n => [n.label, ...(n.meta?.aliases || [])].map(a => [fold(a), n])));
  for (const m of mentions) {
    if (m.source === 'kg') continue;
    const { people } = extractPeople(m.sentence, { isKnown: k => known.has(k) });
    for (const p of people) {
      const f = fold(p.name);
      if (matchers.some(x => x.folded === f || f.includes(x.folded) || x.folded.includes(f))) continue;
      if (nameVariantOf(f, target)) {
        const c = add(candId('persona', f), { kind: 'persona', label: p.name, nodeId: null, type: target.type, rel: 'same_actor', relDirection: null, relConfidence: 'name-variant', coMentions: 0, articles: 0, meta: { cue: 'name-variant' } }, m);
        c.coMentions++;
        continue;
      }
      const node = labelByFold.get(f) || null;
      const c = add(candId(node ? 'node' : 'name', node ? node.id : f), { kind: 'entity', label: node ? node.label : p.name, nodeId: node?.id || null, type: 'person', rel: 'mentioned_with', relDirection: null, relConfidence: 'co-mention', coMentions: 0, articles: 0, meta: node ? { aliases: (node.meta?.aliases || []).slice(0, 6), groupId: node.meta?.groupId || null } : {} }, m);
      c.coMentions++;
    }
    const grp = findGroups(m.sentence, groups);
    for (const g of [...grp.cartels, ...grp.factions]) {
      if (g.implied) continue;
      const c = add(candId('group', g.id), { kind: 'entity', label: g.name, nodeId: `org:${g.orgId}`, type: g.type === 'faction' ? 'faction' : 'org', rel: 'mentioned_with', relDirection: null, relConfidence: 'co-mention', coMentions: 0, articles: 0, meta: { orgId: g.orgId } }, m);
      c.coMentions++;
    }
    if (m.source !== 'telegram') {
      const found = findPlaces(maskNames(m.sentence, people, groups), gz);
      for (const p of [...found.places.slice(0, 2), ...found.states.slice(0, 2)]) {
        const isState = p.adm1 && !p.id;
        const id = isState ? `place:MX-${p.adm1}` : `place:MX-${p.adm1}/${p.id}`;
        const c = add(candId('place', id), { kind: 'place', label: p.name, nodeId: id, type: 'place', rel: 'operates_in', relDirection: 'out', relConfidence: 'co-mention', coMentions: 0, articles: 0, meta: { lat: p.lat, lon: p.lon, adm1: p.adm1, level: isState ? 'state' : 'city', country: 'MX' } }, m);
        c.coMentions++;
      }
    }
    // (3a) persona cues
    for (const name of extractPersonas(m.sentence, matchers)) {
      const c = add(candId('persona', fold(name)), { kind: 'persona', label: name, nodeId: null, type: target.type, rel: 'same_actor', relDirection: null, relConfidence: 'cue', coMentions: 0, articles: 0, meta: { cue: 'alias-phrase' } }, m);
      c.coMentions++;
    }
  }
  // (3b) OFAC a.k.a. names not already among the target's aliases
  for (const h of ofacHits) for (const aka of (h.entry.akas || []).slice(0, 12)) {
    const f = fold(aka.name);
    if (!f || matchers.some(x => x.folded === f)) continue;
    const c = add(candId('persona', f), { kind: 'persona', label: aka.name, nodeId: null, type: target.type, rel: 'same_actor', relDirection: null, relConfidence: aka.category === 'weak' ? 'ofac-weak-aka' : 'ofac-aka', coMentions: 0, articles: 0, meta: { cue: 'ofac-aka', uid: h.entry.uid } }, { source: 'ofac', docId: String(h.entry.uid), sentence: `OFAC lists "${aka.name}" as a.k.a. of ${h.entry.name} (SDN ${h.entry.uid})`, url: sdnSearchUrl(h.entry.name), date: null, title: `SDN ${h.entry.uid}` });
    c.coMentions++;
  }
  // (3c) graph aliases of the anchor not yet in the target record
  for (const a of anchors) for (const alias of a.meta?.aliases || []) {
    const f = fold(alias);
    if (matchers.some(x => x.folded === f)) continue;
    add(candId('persona', f), { kind: 'persona', label: alias, nodeId: a.id, type: target.type, rel: 'same_actor', relDirection: null, relConfidence: 'kg-alias', coMentions: a.mentions || 0, articles: a.articles || 0, meta: { cue: 'kg-alias' } }, { source: 'kg', docId: a.id, sentence: `Knowledge graph resolves "${alias}" to ${a.label} (${a.articles} InSight Crime articles)`, url: null, date: a.last || null, title: a.label });
  }

  const list = [...byId.values()].map(c => ({ ...c, docs: c.docs.size, sources: [...c.sources] }));
  list.sort((a, b) => (b.kind === 'persona') - (a.kind === 'persona') || (b.articles + b.docs) - (a.articles + a.docs) || b.coMentions - a.coMentions);
  return list.slice(0, MAX_CANDIDATES);
}
