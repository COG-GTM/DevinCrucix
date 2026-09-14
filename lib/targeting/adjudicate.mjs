// Adjudication — turn correlation candidates into target / associate / background calls against the
// analyst's stated requirement.
//
// Two passes. Rules run first and always: they map sourced relation types onto roles deterministically and
// are fully explainable. When an LLM provider is configured (Anthropic, OpenAI or any lib/llm provider)
// it is asked, as a bounded second reader, to re-assess the same candidates with the same evidence. Its
// output is JSON only and every field is validated: it may only cite evidence indices we gave it, may only
// use the role / relation vocabularies below, and may not introduce a candidate. On any failure the rules
// result stands and the package records why the model was not used.
import { parseJSON } from '../narco/llm.mjs';
import { RELATIONS } from '../cjng/graph.mjs';

export const ROLES = ['target', 'associate', 'background'];
export const RELATION_IDS = ['same_actor', ...Object.keys(RELATIONS)];
export const MAX_LLM_CANDIDATES = 40;
export const MAX_RATIONALE_CHARS = 240;
export const ADJUDICATOR_VERSION = 'targeting-adjudicate/1';

const ASSOCIATE_RELS = new Set(['leader_of', 'member_of', 'family_of', 'allied_with', 'rival_of', 'lineage']);

/** Deterministic pass. Every call carries a one-line reason that names the rule that fired. */
export function rulesAssess(candidate, target) {
  const c = candidate;
  if (c.kind === 'persona') {
    const strong = c.relConfidence === 'ofac-aka' || c.relConfidence === 'kg-alias';
    return { role: 'target', relation: 'same_actor', confidence: strong ? 0.8 : c.relConfidence === 'cue' ? 0.55 : 0.4, reason: strong ? `published a.k.a. (${c.relConfidence})` : c.relConfidence === 'cue' ? 'alias phrase in a sentence naming the target' : 'weak a.k.a. variant', by: 'rules' };
  }
  if (c.kind === 'place') {
    return { role: 'background', relation: 'operates_in', confidence: c.docs >= 3 ? 0.6 : 0.35, reason: `place named with the target in ${c.docs} document(s)`, by: 'rules' };
  }
  if (ASSOCIATE_RELS.has(c.rel) && c.relConfidence === 'typed') {
    const conf = Math.min(0.9, 0.5 + 0.1 * Math.min(4, c.articles || c.docs || 1));
    return { role: 'associate', relation: c.rel, confidence: conf, reason: `${RELATIONS[c.rel]?.label || c.rel} · typed relation in ${c.articles || c.docs} article(s)`, by: 'rules' };
  }
  if (c.type === 'org' || c.type === 'faction') {
    if (target.type === 'person' && (c.rel === 'leader_of' || c.rel === 'member_of')) return { role: 'associate', relation: c.rel, confidence: 0.7, reason: `${c.rel.replace('_', ' ')} organisation`, by: 'rules' };
    return { role: c.docs >= 3 ? 'associate' : 'background', relation: 'mentioned_with', confidence: c.docs >= 3 ? 0.45 : 0.3, reason: `organisation co-mentioned in ${c.docs} document(s)`, by: 'rules' };
  }
  if (c.type === 'person') {
    if (c.docs >= 3 || (c.coMentions || 0) >= 3) return { role: 'associate', relation: 'mentioned_with', confidence: 0.45, reason: `named alongside the target in ${c.docs} document(s), no typed relation`, by: 'rules' };
    return { role: 'background', relation: 'mentioned_with', confidence: 0.25, reason: `single co-mention · likely reporting context`, by: 'rules' };
  }
  return { role: 'background', relation: c.rel || 'mentioned_with', confidence: 0.2, reason: 'no rule matched · default background', by: 'rules' };
}

export const SYSTEM_PROMPT = [
  'You are a targeting analyst reviewing PUBLIC reporting about an already-designated or already-indicted actor (sanctions lists, prosecutions, published journalism).',
  'You will be given the analyst\'s intelligence requirement, the target, and numbered CANDIDATES that public sources named together with the target, each with numbered EVIDENCE sentences.',
  'For each candidate decide:',
  '- role: "target" if the candidate is the same actor under another name (alias, transliteration, persona); "associate" if the evidence shows an operational, family, command or rival relationship relevant to the requirement; "background" if merely reporting context.',
  `- relation: one of ${RELATION_IDS.join(', ')} or null.`,
  '- confidence: 0 to 1.',
  '- evidence: the indices of the evidence sentences that support your call. Cite only indices you were given.',
  '- rationale: at most 200 characters, plain text, referring only to the evidence given.',
  'Rules: never invent names, places, dates or identifiers that are not in the evidence. Never guess a private address, phone number or home location. If the evidence is insufficient, choose "background" with low confidence.',
  'Reply with JSON only: {"assessments":[{"i":0,"role":"associate","relation":"member_of","confidence":0.7,"evidence":[0,1],"rationale":"..."}]}',
].join('\n');

export function buildPrompt(target, candidates) {
  const lines = [
    `REQUIREMENT: ${target.requirement}`,
    `TARGET: ${target.label} (${target.type})${target.aliases?.length ? ` · known aliases: ${target.aliases.join(', ')}` : ''}`,
    '',
    'CANDIDATES:',
  ];
  candidates.forEach((c, i) => {
    lines.push(`[${i}] ${c.label} · type=${c.type} · source relation=${c.rel || 'none'} (${c.relConfidence || 'n/a'}) · ${c.docs} document(s)`);
    c.evidence.forEach((e, j) => lines.push(`  (${j}) [${e.source}${e.date ? ' ' + e.date : ''}] ${e.sentence}`));
  });
  return lines.join('\n');
}

/** Validate one model assessment against the candidate it claims to describe. Returns null when unusable. */
export function validateAssessment(raw, candidate) {
  if (!raw || typeof raw !== 'object' || !candidate) return null;
  if (!ROLES.includes(raw.role)) return null;
  const relation = raw.relation === null || raw.relation === undefined ? null : (RELATION_IDS.includes(raw.relation) ? raw.relation : undefined);
  if (relation === undefined) return null;
  const conf = Number(raw.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null;
  const ev = Array.isArray(raw.evidence) ? raw.evidence.filter(i => Number.isInteger(i) && i >= 0 && i < candidate.evidence.length) : [];
  if (!ev.length) return null;
  // A "target" (same actor) call requires a persona-type candidate or a published alias in the cited evidence.
  if (raw.role === 'target' && candidate.kind !== 'persona') return null;
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_RATIONALE_CHARS) : '';
  return { role: raw.role, relation, confidence: Math.round(conf * 100) / 100, evidence: [...new Set(ev)].slice(0, 6), rationale };
}

export function parseAssessments(text, candidates) {
  const obj = parseJSON(text);
  const list = obj && Array.isArray(obj.assessments) ? obj.assessments : null;
  if (!list) return null;
  const out = new Map();
  for (const a of list) {
    if (!a || !Number.isInteger(a.i) || a.i < 0 || a.i >= candidates.length || out.has(a.i)) continue;
    const v = validateAssessment(a, candidates[a.i]);
    if (v) out.set(a.i, v);
  }
  return out;
}

/**
 * @returns {{ links: Array, llm: { used: boolean, model: string|null, reason: string|null, assessed: number } }}
 */
export async function adjudicate(provider, target, candidates, { timeout = 60000, maxTokens = 2500 } = {}) {
  const links = candidates.map(c => ({ ...c, rules: rulesAssess(c, target), assessment: null, decision: null }));
  for (const l of links) l.assessment = { ...l.rules };
  const llm = { used: false, model: null, reason: null, assessed: 0, version: ADJUDICATOR_VERSION };
  if (!provider || !provider.isConfigured) { llm.reason = 'no LLM provider configured (set LLM_PROVIDER + LLM_API_KEY)'; return { links, llm }; }
  const subset = links.slice(0, MAX_LLM_CANDIDATES).filter(l => l.evidence.length);
  if (!subset.length) { llm.reason = 'no candidates with evidence'; return { links, llm }; }
  try {
    const res = await provider.complete(SYSTEM_PROMPT, buildPrompt(target, subset), { maxTokens, timeout });
    const parsed = parseAssessments(res?.text, subset);
    if (!parsed) { llm.reason = 'model reply was not valid JSON'; return { links, llm }; }
    for (const [i, v] of parsed) {
      const l = subset[i];
      l.assessment = { ...v, by: 'llm', model: res.model || provider.name || 'llm', evidenceCited: v.evidence.map(j => l.evidence[j]?.sentence).filter(Boolean) };
    }
    llm.used = true; llm.model = res.model || provider.name || 'llm'; llm.assessed = parsed.size;
    llm.rejected = subset.length - parsed.size;
  } catch (err) {
    llm.reason = `model call failed: ${String(err?.message || err).slice(0, 120)}`;
  }
  return { links, llm };
}
