// FIX — where the public record places the target, and when.
//
// Text geolocation only: each dated mention is run through the Mexico gazetteer and yields a place-time
// observation with a precision-derived uncertainty radius. "Last known location" is the most recent
// observation from a reported/official source, never from Telegram, and is always shown with its radius,
// its date and the sentence that put the target there. An optional model pass (same provider as FIND)
// may pick, per mention, WHICH named place the target was at — it cannot name a place the sentence does
// not contain, because every answer is snapped back to the gazetteer hits of that sentence.
import { findPlaces, loadGazetteer, haversineKm, stateName } from '../narco/gazetteer.mjs';
import { parseJSON } from '../narco/llm.mjs';
import { extractPeople } from '../narco/extract.mjs';
import { loadGroups } from '../narco/groups.mjs';
import { maskNames } from './find.mjs';

export const MAX_OBSERVATIONS = 200;
export const RADIUS_KM = { city: 15, municipality: 30, state: 150, 'capital-or-state': 150 };
export const LOCATION_SOURCES = new Set(['kg', 'insightcrime', 'doj', 'bordernews', 'narco']);
// Verbs that say the target WAS somewhere, vs. verbs that only say something happened there.
const PRESENCE_RE = /\b(?:arrested|detained|captured|killed|died|extradited|hiding|hid|based|lives|lived|resides|resided|operates|operated|seen|spotted|located|sheltering|born|raised|fled to|moved to|traveled to|travelled to|escaped to|detenido|capturado|abatido|arrestado|refugiado|escondido)\b/i;
const OPERATION_RE = /\b(?:operation|operativo|raid|shootout|clash|enfrentamiento|convoy|ambush|strike)\b/i;

export function radiusFor(precision) { return RADIUS_KM[precision] || 150; }

/** One mention -> zero or one observation (the gazetteer's best resolution for that sentence). */
export function observe(mention, gz = loadGazetteer(), groups = loadGroups()) {
  if (!mention || !mention.date || !LOCATION_SOURCES.has(mention.source)) return null;
  if (mention.location && Number.isFinite(mention.location.lat)) {
    const precision = mention.location.precision || 'city';
    return obs(mention, { name: mention.location.name, state: mention.location.state, adm1: mention.location.adm1, lat: mention.location.lat, lon: mention.location.lon, precision }, 'event-pipeline');
  }
  const found = findPlaces(maskNames(mention.sentence, extractPeople(mention.sentence).people, groups), gz);
  const place = found.places[0] || null;
  const muni = found.municipalities[0] || null;
  const state = found.states[0] || null;
  const pick = place ? { name: place.name, adm1: place.adm1, lat: place.lat, lon: place.lon, precision: 'city' }
    : muni ? { name: muni.name, adm1: muni.adm1, lat: muni.lat, lon: muni.lon, precision: 'municipality' }
      : state ? { name: state.name, adm1: state.adm1, lat: state.lat, lon: state.lon, precision: 'state' } : null;
  if (!pick) return null;
  pick.state = stateName(pick.adm1, gz);
  const alternatives = [...found.places.slice(1, 3).map(p => ({ name: p.name, adm1: p.adm1, lat: p.lat, lon: p.lon, precision: 'city' })), ...found.states.filter(s => s.adm1 !== pick.adm1).slice(0, 2).map(s => ({ name: s.name, adm1: s.adm1, lat: s.lat, lon: s.lon, precision: 'state' }))];
  return obs(mention, pick, 'gazetteer', alternatives);
}

function obs(m, place, method, alternatives = []) {
  const presence = PRESENCE_RE.test(m.sentence);
  return {
    mentionId: m.id, date: m.date, source: m.source, url: m.url || null, title: m.title || null, sentence: m.sentence,
    place: place.name, state: place.state || null, adm1: place.adm1 || null, lat: place.lat, lon: place.lon, precision: place.precision,
    radiusKm: radiusFor(place.precision), method,
    presence: presence ? 'stated' : OPERATION_RE.test(m.sentence) ? 'operation' : 'contextual',
    eventKind: m.eventKind || m.eventType || null,
    alternatives: alternatives.map(a => ({ ...a, state: a.state || null })),
  };
}

export function textGeolocate(mentions, { gz = loadGazetteer(), groups = loadGroups() } = {}) {
  const observations = [];
  for (const m of mentions) {
    const o = observe(m, gz, groups);
    if (o) observations.push(o);
    if (observations.length >= MAX_OBSERVATIONS) break;
  }
  observations.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return observations;
}

/** Most recent stated-presence observation wins; falls back to the most recent of any kind. */
export function lastKnownLocation(observations) {
  const ranked = [...observations].sort((a, b) => String(b.date).localeCompare(String(a.date)) || rank(b) - rank(a));
  const best = ranked.find(o => o.presence === 'stated') || ranked[0] || null;
  if (!best) return null;
  const newer = ranked.filter(o => o.date > best.date && o !== best);
  return {
    place: best.state && best.place !== best.state ? `${best.place}, ${best.state}` : best.place,
    lat: best.lat, lon: best.lon, radiusKm: best.radiusKm, precision: best.precision, date: best.date,
    basis: best.presence, source: best.source, url: best.url, sentence: best.sentence,
    ageDays: Math.max(0, Math.round((Date.now() - Date.parse(best.date)) / 86_400_000)),
    caveat: newer.length ? `${newer.length} newer mention(s) name a place without stating the target was there` : null,
    confidence: best.presence === 'stated' && best.precision !== 'state' ? 'medium' : 'low',
  };
}
function rank(o) { return o.presence === 'stated' ? 2 : o.presence === 'operation' ? 1 : 0; }

/** Places by frequency with first/last dates — the target's footprint. */
export function footprint(observations) {
  const by = new Map();
  for (const o of observations) {
    const key = o.adm1 ? `${o.adm1}|${o.place}` : o.place;
    const cur = by.get(key) || { place: o.place, state: o.state, adm1: o.adm1, lat: o.lat, lon: o.lon, precision: o.precision, count: 0, stated: 0, first: o.date, last: o.date, sources: new Set() };
    cur.count++;
    if (o.presence === 'stated') cur.stated++;
    if (o.date < cur.first) cur.first = o.date;
    if (o.date > cur.last) cur.last = o.date;
    cur.sources.add(o.source);
    by.set(key, cur);
  }
  return [...by.values()].map(f => ({ ...f, sources: [...f.sources] })).sort((a, b) => b.stated - a.stated || b.count - a.count || b.last.localeCompare(a.last)).slice(0, 40);
}

/** Spatial spread of the stated observations: the fix's own uncertainty, not the model's. */
export function dispersionKm(observations) {
  const pts = observations.filter(o => o.presence === 'stated');
  if (pts.length < 2) return null;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const d = pts.map(p => haversineKm(lat, lon, p.lat, p.lon)).sort((a, b) => a - b);
  return { centroid: { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 }, medianKm: Math.round(d[Math.floor(d.length / 2)]), maxKm: Math.round(d[d.length - 1]), n: pts.length };
}

// ---- optional model pass -----------------------------------------------------------------------------
// The model sees only sentences that already resolved to >= 2 candidate places and chooses among them.
export const FIX_SYSTEM = [
  'You are a targeting analyst. For each numbered sentence from public reporting, decide which of the listed candidate places the TARGET was physically at, according to that sentence alone.',
  'Answer with the candidate index, or -1 if the sentence does not place the target anywhere (e.g. a place is only where a prosecutor spoke, or where a rival operates).',
  'Also say whether the sentence states presence ("stated") or only implies it ("implied").',
  'Never add places, coordinates or dates that are not listed. JSON only: {"picks":[{"i":0,"place":1,"presence":"stated"}]}',
].join('\n');

export function ambiguousObservations(observations) {
  return observations.filter(o => o.alternatives && o.alternatives.length).slice(0, 30);
}

export function buildFixPrompt(target, obsList) {
  const lines = [`TARGET: ${target.label}${target.aliases?.length ? ` (aliases: ${target.aliases.join(', ')})` : ''}`, ''];
  obsList.forEach((o, i) => {
    lines.push(`[${i}] ${o.date} · ${o.sentence}`);
    [{ name: o.place, precision: o.precision }, ...o.alternatives].forEach((p, j) => lines.push(`   (${j}) ${p.name} (${p.precision})`));
  });
  return lines.join('\n');
}

export function applyFixPicks(text, obsList) {
  const obj = parseJSON(text);
  if (!obj || !Array.isArray(obj.picks)) return null;
  let applied = 0;
  for (const p of obj.picks) {
    if (!p || !Number.isInteger(p.i) || p.i < 0 || p.i >= obsList.length) continue;
    const o = obsList[p.i];
    const options = [{ name: o.place, state: o.state, adm1: o.adm1, lat: o.lat, lon: o.lon, precision: o.precision }, ...o.alternatives];
    if (p.place === -1) { o.presence = 'contextual'; o.modelNote = 'model: sentence does not place the target here'; applied++; continue; }
    if (!Number.isInteger(p.place) || p.place < 0 || p.place >= options.length) continue;
    const pick = options[p.place];
    Object.assign(o, { place: pick.name, state: pick.state || o.state, adm1: pick.adm1 || o.adm1, lat: pick.lat, lon: pick.lon, precision: pick.precision, radiusKm: radiusFor(pick.precision) });
    if (p.presence === 'stated') o.presence = 'stated';
    else if (p.presence === 'implied' && o.presence === 'stated') o.presence = 'operation';
    o.modelNote = `model picked ${pick.name}`;
    applied++;
  }
  return applied;
}

export async function refineWithModel(provider, target, observations, { timeout = 45000 } = {}) {
  const out = { used: false, reason: null, applied: 0 };
  if (!provider || !provider.isConfigured) { out.reason = 'no LLM provider configured'; return out; }
  const amb = ambiguousObservations(observations);
  if (!amb.length) { out.reason = 'no ambiguous sentences'; return out; }
  try {
    const res = await provider.complete(FIX_SYSTEM, buildFixPrompt(target, amb), { maxTokens: 1200, timeout });
    const applied = applyFixPicks(res?.text, amb);
    if (applied === null) { out.reason = 'model reply was not valid JSON'; return out; }
    out.used = true; out.applied = applied; out.model = res.model || provider.name || 'llm';
  } catch (err) {
    out.reason = `model call failed: ${String(err?.message || err).slice(0, 120)}`;
  }
  return out;
}

export async function fixTarget(provider, target, mentions, { gz = loadGazetteer() } = {}) {
  const observations = textGeolocate(mentions, { gz });
  const model = await refineWithModel(provider, target, observations);
  observations.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    observations,
    lastKnown: lastKnownLocation(observations),
    footprint: footprint(observations),
    dispersion: dispersionKm(observations),
    model,
    caveat: 'Text geolocation from public reporting: each point is where a dated sentence places the target, snapped to the Mexico gazetteer with a precision-based radius. Not a live position. Telegram content is never used for location.',
  };
}
