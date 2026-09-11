// Optional LLM gap-filling for narco event records. Runs only when a provider is configured and
// NARCO_LLM_EXTRACT=true, and only for records the rule-based pass left materially incomplete.
// Every field the model returns is validated against the gazetteers / enum before it is accepted;
// nothing the model says can introduce a place, group or type the system does not already know.

import { fold, loadGazetteer } from './gazetteer.mjs';
import { loadGroups } from './groups.mjs';
import { EVENT_TYPE_IDS } from './extract.mjs';

const MAX_TEXT = 6000;
const MAX_PER_SWEEP = clampInt(process.env.NARCO_LLM_MAX_PER_SWEEP, 0, 100, 10);
export const LLM_ENABLED = process.env.NARCO_LLM_EXTRACT === 'true';

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// Locations the rules could only pin to a state (or an ambiguous capital/state name) are worth a second look.
export const VAGUE_PRECISIONS = new Set(['state', 'capital-or-state']);

export function needsLLM(rec) {
  return !rec.location || VAGUE_PRECISIONS.has(rec.location.precision) || rec.eventType === 'other' || (rec.cartels.length === 0 && rec.factions.length === 0);
}

const SYSTEM = `You extract structured facts from a news article about organized crime in Mexico or the US–Mexico border.
Return ONLY a JSON object with these keys (use null when the article does not say):
{"eventType": one of [${EVENT_TYPE_IDS.join(', ')}] or "other",
 "state": Mexican state name or null,
 "city": municipality or city name or null,
 "locality": neighbourhood (colonia), highway, ejido or landmark where it happened, copied exactly as written, or null,
 "locationEvidence": [up to 2 sentences copied VERBATIM from the article that establish where the event happened],
 "cartels": [organization or faction names exactly as written],
 "people": [full personal names exactly as written, no titles],
 "killed": integer or null, "wounded": integer or null, "arrested": integer or null, "kidnapped": integer or null,
 "eventDate": "YYYY-MM-DD" or null}
Do not guess. Do not infer facts that are not in the text.`;

function safeInt(v, max = 5000) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}
const NAME_OK = /^[A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{2,79}$/;
export const MAX_EVIDENCE = 2;
export const MAX_EVIDENCE_CHARS = 300;
const MAX_LOCALITY_CHARS = 80;

const norm = s => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// A span the model "quotes" is only kept if it really occurs in the article (whitespace/case/accent-insensitive).
export function verbatimSpans(cands, text, { max = MAX_EVIDENCE, maxChars = MAX_EVIDENCE_CHARS, minChars = 12 } = {}) {
  if (!Array.isArray(cands) || typeof text !== 'string' || !text) return [];
  const hay = fold(norm(text));
  const out = [];
  for (const c of cands) {
    if (typeof c !== 'string') continue;
    const s = norm(c).slice(0, maxChars);
    if (s.length < minChars) continue;
    const needle = fold(s);
    if (!needle || !hay.includes(needle) || out.some(o => fold(o) === needle)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function validateLLMOutput(out, { gz = loadGazetteer(), groups = loadGroups(), text = '' } = {}) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const v = {};
  if (typeof out.locality === 'string') {
    const [loc] = verbatimSpans([out.locality], text, { max: 1, maxChars: MAX_LOCALITY_CHARS, minChars: 4 });
    if (loc && !gz.stateKey.has(fold(loc))) v.locality = loc;
  }
  const ev = verbatimSpans(out.locationEvidence, text);
  if (ev.length) v.locationEvidence = ev;
  if (typeof out.eventType === 'string' && EVENT_TYPE_IDS.includes(out.eventType)) v.eventType = out.eventType;
  const st = typeof out.state === 'string' ? gz.stateKey.get(fold(out.state)) : null;
  if (st) v.state = { adm1: st.adm1, name: st.shortName, lat: st.lat, lon: st.lon };
  if (typeof out.city === 'string') {
    const k = fold(out.city);
    const rows = gz.placeKey.get(k) || gz.muniKey.get(k) || [];
    const pick = (st && rows.find(r => r.adm1 === st.adm1)) || (rows.length === 1 ? rows[0] : null);
    if (pick) v.city = { name: pick.name, adm1: pick.adm1, adm2: pick.adm2 || null, lat: pick.lat, lon: pick.lon };
  }
  if (Array.isArray(out.cartels)) {
    const ids = new Set();
    for (const c of out.cartels.slice(0, 10)) if (typeof c === 'string') { const g = groups.aliasKey.get(fold(c)); if (g) ids.add(g.id); }
    if (ids.size) v.cartelIds = [...ids];
  }
  if (Array.isArray(out.people)) {
    const names = [...new Set(out.people.filter(p => typeof p === 'string' && NAME_OK.test(p.trim()) && p.trim().split(/\s+/).length >= 2).map(p => p.trim()))].slice(0, 10);
    if (names.length) v.people = names;
  }
  for (const k of ['killed', 'wounded', 'arrested', 'kidnapped']) { const n = safeInt(out[k]); if (n != null) v[k] = n; }
  if (typeof out.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.eventDate) && Number.isFinite(new Date(out.eventDate).getTime())) v.eventDate = out.eventDate;
  return Object.keys(v).length ? v : null;
}

export function parseJSON(text) {
  const s = String(text || '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// Merge validated LLM fields into a rule-based record; rules win wherever they produced a value.
export function mergeLLM(rec, v, { gz = loadGazetteer(), groups = loadGroups() } = {}) {
  const r = { ...rec, extractor: { ...rec.extractor, method: 'rules+llm', llm: { fields: Object.keys(v) } } };
  if (!r.location && (v.city || v.state)) {
    const stName = v.city ? gz.stateByAdm1.get(v.city.adm1)?.shortName : v.state.name;
    r.location = v.city
      ? { country: 'MX', adm1: v.city.adm1, state: stName || null, municipality: null, city: v.city.name, lat: v.city.lat, lon: v.city.lon, precision: 'city' }
      : { country: 'MX', adm1: v.state.adm1, state: v.state.name, municipality: null, city: null, lat: v.state.lat, lon: v.state.lon, precision: 'state' };
    r.location.source = 'llm';
  } else if (r.location && VAGUE_PRECISIONS.has(r.location.precision) && v.city && v.city.adm1 === r.location.adm1) {
    // Refinement only: a gazetteer city inside the state the rules already found. A city elsewhere is ignored.
    r.location = { ...r.location, city: v.city.name, municipality: null, lat: v.city.lat, lon: v.city.lon, precision: 'city', source: 'rules+llm', rulePrecision: r.location.precision };
  }
  if (r.location && r.location.country === 'MX') {
    if (v.locality && !r.location.locality) r.location = { ...r.location, locality: v.locality, localitySource: 'llm-verbatim' };
    if (v.locationEvidence) r.location = { ...r.location, evidence: v.locationEvidence };
  }
  if (r.eventType === 'other' && v.eventType) { r.eventType = v.eventType; r.eventTypes = [v.eventType, ...r.eventTypes.filter(t => t !== v.eventType)]; }
  if (r.cartels.length === 0 && r.factions.length === 0 && v.cartelIds) {
    for (const id of v.cartelIds) {
      const g = groups.byId.get(id);
      const row = { id: g.id, name: g.name, short: g.short, orgId: g.orgId || 'other', implied: false, source: 'llm' };
      if (g.type === 'faction') r.factions = [...r.factions, { ...row, parent: g.parent || null }];
      else r.cartels = [...r.cartels, row];
    }
  }
  if (r.people.length === 0 && v.people) r.people = v.people.map(name => ({ name, mentions: 1, source: 'llm' }));
  for (const k of ['killed', 'wounded', 'arrested', 'kidnapped']) if (r.counts[k] == null && v[k] != null) r.counts = { ...r.counts, [k]: v[k] };
  if (r.dateSource === 'published' && v.eventDate) { r.eventDate = v.eventDate; r.dateSource = 'llm'; }
  return r;
}

// Enrich the incomplete records in place-order, capped per sweep. Returns { records, used, errors }.
export async function llmEnrichRecords(provider, records, docsById, { enabled = LLM_ENABLED, max = MAX_PER_SWEEP, gz, groups } = {}) {
  if (!enabled || !provider?.isConfigured) return { records, used: 0, errors: 0, skipped: 'disabled' };
  let used = 0, errors = 0;
  const out = [];
  for (const rec of records) {
    if (used >= max || !needsLLM(rec)) { out.push(rec); continue; }
    const doc = docsById.get(rec.docId);
    const text = String(doc?.text || doc?.summary || '').slice(0, MAX_TEXT);
    if (text.length < 200) { out.push(rec); continue; }
    used++;
    try {
      const res = await provider.complete(SYSTEM, `TITLE: ${rec.title}\n\n${text}`, { maxTokens: 600, timeout: 45000 });
      const v = validateLLMOutput(parseJSON(res?.text), { gz, groups, text });
      out.push(v ? mergeLLM(rec, v, { gz, groups }) : rec);
    } catch {
      errors++;
      out.push(rec);
    }
  }
  return { records: out, used, errors };
}
