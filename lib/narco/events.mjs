// Normalized narco event records, event-level de-duplication and corroboration grading.
//
// One *event record* is produced per source document (article / press release). Records that
// describe the same real-world incident are grouped into a *cluster*; the cluster carries the
// confidence grade, which depends on how many independent sources corroborate it.

import { createHash } from 'crypto';
import { findPlaces, resolveLocation, haversineKm, loadGazetteer, fold } from './gazetteer.mjs';
import { findGroups, loadGroups, maskGroupNames } from './groups.mjs';
import { classifyEvent, extractCounts, extractSeizures, extractPeople, maskPeopleNames, extractCitedSources, toDay, EXTRACTOR_VERSION } from './extract.mjs';

const ENFORCEMENT_TYPES = new Set(['tunnel', 'sanctions', 'extradition', 'prosecution', 'arrest', 'seizure', 'smuggling']);

export const EVENT_SCHEMA = 'narco-event/1';
export const CLUSTER_SCHEMA = 'narco-cluster/1';

// Source-kind weights for corroboration. `official` = government publication (DOJ, Treasury);
// `media` = established news outlet; `aggregator` = citizen / volunteer aggregation (not ground truth).
export const SOURCE_KINDS = ['official', 'media', 'aggregator'];
export function sourceKind(sourceType) {
  const t = String(sourceType || '');
  if (/official|government|gov|doj|treasury|ofac/i.test(t)) return 'official';
  if (/citizen|aggregator|blog|volunteer/i.test(t)) return 'aggregator';
  return 'media';
}

export const CONFIDENCE = {
  A: 'Corroborated by an official source or 3+ independent outlets',
  B: 'Corroborated by 2 independent outlets (at least one established media)',
  C: 'Single established media report',
  D: 'Single citizen-aggregator report, not independently corroborated',
  E: 'Undated or unlocated; not actionable as an event',
};

const sha = s => createHash('sha256').update(String(s), 'utf8').digest('hex');

// Families used for cluster matching: distinct types that commonly describe the same incident.
const TYPE_FAMILY = {
  massacre: 'violence', homicide: 'violence', armed_clash: 'violence', attack_on_authorities: 'violence', blockade: 'violence',
  kidnapping: 'kidnapping', displacement: 'displacement', extortion: 'extortion', prison: 'prison',
  arrest: 'enforcement', extradition: 'enforcement', prosecution: 'enforcement', seizure: 'enforcement', tunnel: 'enforcement', smuggling: 'enforcement',
  sanctions: 'sanctions', other: 'other',
};
export function typeFamily(t) { return TYPE_FAMILY[t] || 'other'; }

// Build one normalized event record from a document.
// doc: { id, sourceId, outlet, sourceType, url, title, text, summary, rawHtml, publishedAt, collectedAt, wireSource, syndicated, language,
//        location (optional pre-resolved), eventDate (optional), extra (optional provenance object) }
export function normalizeEvent(doc, { gz = loadGazetteer(), groups = loadGroups() } = {}) {
  const body = [doc.title, doc.text || doc.summary || ''].filter(Boolean).join('\n\n');
  const grp = findGroups(body, groups);
  const isKnown = phrase => {
    const k = fold(phrase);
    return gz.stateKey.has(k) || gz.placeKey.has(k) || gz.muniKey.has(k) || groups.aliasKey.has(k);
  };
  const ppl = extractPeople(body, { isKnown });
  const found = findPlaces(maskPeopleNames(maskGroupNames(body, groups), ppl.people), gz);
  const location = doc.location || resolveLocation(found, gz);
  for (const l of grp.leaders) {
    if (!ppl.people.some(p => fold(p.name) === fold(l.name) || fold(p.name).includes(fold(l.name)))) ppl.people.unshift({ name: l.name, mentions: 1, groupId: l.groupId });
    else { const p = ppl.people.find(p => fold(p.name).includes(fold(l.name))); if (p) p.groupId = l.groupId; }
  }
  const counts = extractCounts(body);
  const seizures = extractSeizures(body);
  const cls = classifyEvent(body, counts, doc.title || '');
  if (doc.extra?.kind === 'prosecution' && !ENFORCEMENT_TYPES.has(cls.primary)) {
    const primary = cls.types.find(t => ENFORCEMENT_TYPES.has(t)) || 'prosecution';
    cls.types = [primary, ...cls.types.filter(t => t !== primary)];
    cls.primary = primary;
  }
  const cited = extractCitedSources(body, doc.rawHtml || null);
  const eventDate = doc.eventDate || toDay(doc.publishedAt) || null;
  const excerptSrc = String(doc.text || doc.summary || '').replace(/\s+/g, ' ').trim();
  return {
    schema: EVENT_SCHEMA,
    id: `ev_${sha(`${doc.sourceId}|${doc.id}`).slice(0, 20)}`,
    docId: String(doc.id).slice(0, 300),
    sourceId: doc.sourceId,
    outlet: doc.outlet,
    sourceType: doc.sourceType || 'news-outlet',
    sourceKind: sourceKind(doc.sourceType),
    url: doc.url || null,
    title: String(doc.title || '').slice(0, 300),
    language: doc.language || 'en',
    publishedAt: doc.publishedAt || null,
    collectedAt: doc.collectedAt || null,
    eventDate,
    dateSource: doc.eventDate ? 'document' : 'published',
    eventType: cls.primary,
    eventTypes: cls.types,
    location,
    placeMentions: { states: found.states.slice(0, 5).map(s => s.name), places: found.places.slice(0, 8).map(p => p.name), municipalities: found.municipalities.slice(0, 8).map(m => m.name) },
    cartels: grp.cartels.map(({ id, name, short, orgId, implied }) => ({ id, name, short, orgId, implied })),
    factions: grp.factions.map(({ id, name, short, orgId, parent }) => ({ id, name, short, orgId, parent })),
    people: ppl.people.slice(0, 12),
    nicknames: ppl.nicknames,
    counts,
    seizures,
    citedSources: cited,
    syndicated: Boolean(doc.syndicated),
    wireSource: doc.wireSource || null,
    extractor: { version: EXTRACTOR_VERSION, method: 'rules', llm: null },
    excerpt: excerptSrc.slice(0, 280) || null,
    ...(doc.extra ? { provenance: doc.extra } : {}),
  };
}

// ---------- clustering / de-duplication ----------

const DAY_MS = 86_400_000;
const NEAR_KM = 40;
const WINDOW_DAYS = 3;

function dayDiff(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / DAY_MS);
}

function entityOverlap(a, b) {
  const aC = new Set([...a.cartels, ...a.factions].map(g => g.id));
  const bC = new Set([...b.cartels, ...b.factions].map(g => g.id));
  const cartel = [...aC].some(id => bC.has(id));
  const aP = new Set(a.people.map(p => fold(p.name)));
  const person = b.people.some(p => aP.has(fold(p.name)));
  return { cartel, person, any: cartel || person };
}

function placeOverlap(a, b) {
  const la = a.location, lb = b.location;
  if (!la || !lb) return { same: false, score: 0 };
  if (la.adm1 !== lb.adm1) return { same: false, score: 0 };
  if (la.city && lb.city && la.city === lb.city) return { same: true, score: 3 };
  if (la.municipality && lb.municipality && la.municipality === lb.municipality) return { same: true, score: 3 };
  if (la.lat != null && lb.lat != null && haversineKm(la.lat, la.lon, lb.lat, lb.lon) <= NEAR_KM) return { same: true, score: 2 };
  // Both only known to state level: same state counts, weakly.
  if ((la.precision === 'state' || la.precision === 'capital-or-state') && (lb.precision === 'state' || lb.precision === 'capital-or-state')) return { same: true, score: 1 };
  return { same: false, score: 0 };
}

// Outlets frame one incident differently ("three captured" vs "four police killed"); any shared family
// across the secondary types counts.
function familiesOverlap(a, b) {
  const fa = new Set((a.eventTypes?.length ? a.eventTypes : [a.eventType]).map(typeFamily));
  return (b.eventTypes?.length ? b.eventTypes : [b.eventType]).some(t => fa.has(typeFamily(t)));
}

// Two records describe the same incident when they are close in time and place, share an event
// family, and either share a named entity or agree on a specific place plus a casualty figure.
export function sameIncident(a, b) {
  if (!familiesOverlap(a, b)) return false;
  if (dayDiff(a.eventDate, b.eventDate) > WINDOW_DAYS) return false;
  const pl = placeOverlap(a, b);
  if (!pl.same) return false;
  const ent = entityOverlap(a, b);
  if (ent.any && pl.score >= 1) return true;
  if (pl.score >= 3) {
    const ka = a.counts.killed, kb = b.counts.killed;
    if (ka != null && kb != null && ka === kb) return true;
    if (ka == null && kb == null && a.eventType === b.eventType && (a.people.length === 0 || b.people.length === 0)) return true;
  }
  return false;
}

// Independence: distinct outlets, excluding syndicated copies of the same wire story.
function independentSources(records) {
  const seen = new Map();
  for (const r of records) {
    const key = r.wireSource ? `wire:${fold(r.wireSource)}` : `src:${r.sourceId}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

export function gradeConfidence(records) {
  const indep = independentSources(records);
  const kinds = indep.map(r => r.sourceKind);
  const official = kinds.filter(k => k === 'official').length;
  const media = kinds.filter(k => k === 'media').length;
  const aggregator = kinds.filter(k => k === 'aggregator').length;
  const anchor = records[0];
  const unlocated = records.every(r => !r.location);
  const undated = records.every(r => !r.eventDate);
  // Cited original sources inside an aggregator post are secondary corroboration: they lift D to C once
  // two or more distinct outlets are credited, but never substitute for an independent record.
  const citedOutlets = new Set(records.flatMap(r => r.citedSources.filter(c => c.kind === 'explicit' || c.kind === 'attribution').map(c => fold(c.name))));
  let grade;
  if (unlocated || undated) grade = 'E';
  else if (official >= 1 || indep.length >= 3) grade = 'A';
  else if (indep.length >= 2 && media >= 1) grade = 'B';
  else if (indep.length >= 2) grade = 'C';
  else if (media >= 1) grade = 'C';
  else if (aggregator >= 1 && citedOutlets.size >= 2) grade = 'C';
  else grade = 'D';
  return {
    grade,
    label: CONFIDENCE[grade],
    independentSources: indep.length,
    official, media, aggregator,
    citedOutlets: citedOutlets.size,
    anchorType: anchor?.eventType || null,
  };
}

function maxCount(records, key) {
  let v = null;
  for (const r of records) if (r.counts[key] != null && (v == null || r.counts[key] > v)) v = r.counts[key];
  return v;
}

function bestLocation(records) {
  const order = { city: 4, municipality: 3, 'capital-or-state': 2, district: 2, state: 1 };
  return records.map(r => r.location).filter(Boolean).sort((a, b) => (order[b.precision] || 0) - (order[a.precision] || 0))[0] || null;
}

export function buildCluster(records) {
  const recs = [...records].sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));
  const conf = gradeConfidence(recs);
  const cartels = new Map(), factions = new Map(), people = new Map();
  for (const r of recs) {
    for (const c of r.cartels) if (!cartels.has(c.id) || (cartels.get(c.id).implied && !c.implied)) cartels.set(c.id, c);
    for (const f of r.factions) factions.set(f.id, f);
    for (const p of r.people) { const k = fold(p.name); if (!people.has(k) || p.name.length > people.get(k).name.length) people.set(k, p); }
  }
  const types = recs.map(r => r.eventType);
  const eventType = types.sort((a, b) => types.filter(t => t === b).length - types.filter(t => t === a).length)[0];
  const dates = recs.map(r => r.eventDate).filter(Boolean).sort();
  const seizures = recs.map(r => r.seizures).filter(s => Object.keys(s).length).sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] || {};
  const counts = {};
  for (const k of ['killed', 'wounded', 'arrested', 'kidnapped']) { const v = maxCount(recs, k); if (v != null) counts[k] = v; }
  const anchor = recs.find(r => r.sourceKind === 'official') || recs.find(r => r.sourceKind === 'media') || recs[0];
  return {
    schema: CLUSTER_SCHEMA,
    id: `cl_${sha(recs.map(r => r.id).sort().join('|')).slice(0, 20)}`,
    eventType,
    eventTypes: [...new Set(recs.flatMap(r => r.eventTypes))],
    date: dates[0] || null,
    dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    location: bestLocation(recs),
    cartels: [...cartels.values()],
    factions: [...factions.values()],
    people: [...people.values()].slice(0, 12),
    counts,
    seizures,
    title: anchor.title,
    excerpt: anchor.excerpt,
    confidence: conf,
    records: recs.map(r => ({ id: r.id, sourceId: r.sourceId, outlet: r.outlet, sourceKind: r.sourceKind, url: r.url, title: r.title, publishedAt: r.publishedAt, eventType: r.eventType, citedSources: r.citedSources.slice(0, 6) })),
    citedSources: dedupeCited(recs.flatMap(r => r.citedSources)),
    lastUpdated: recs.map(r => r.collectedAt || r.publishedAt).filter(Boolean).sort().pop() || null,
  };
}

function dedupeCited(list) {
  const m = new Map();
  for (const c of list) { const k = fold(c.name); if (!m.has(k)) m.set(k, c); }
  return [...m.values()].slice(0, 12);
}

// Greedy single-link clustering (records are few hundred at most; O(n²) is fine).
export function clusterEvents(records) {
  const sorted = [...records].sort((a, b) => String(a.eventDate || '').localeCompare(String(b.eventDate || '')));
  const clusters = [];
  for (const r of sorted) {
    let home = null;
    for (const c of clusters) {
      if (c.some(o => sameIncident(o, r))) { home = c; break; }
    }
    if (home) home.push(r); else clusters.push([r]);
  }
  return clusters.map(buildCluster).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.confidence.independentSources - a.confidence.independentSources);
}
