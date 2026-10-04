// Ask CRUCIX — grounded Q&A over the live dashboard state with an explicit external fallback.
//
// Two modes, never mixed in one answer:
//   grounded  — the model sees only the CRUCIX context pack and must cite section ids. If the
//               pack cannot answer, it says so (sufficiency=insufficient) and the drawer offers
//               an external search the analyst has to confirm.
//   external  — provider web search (OpenAI Responses API). Output is labelled EXTERNAL —
//               UNVERIFIED and carries the URLs the provider cited. CRUCIX data is summarised
//               for the model only as "what the analyst already has", never asserted as fact.
//
// Read-only: nothing here touches the target store, requirements or the verified graph.
import { parseJSON } from '../narco/llm.mjs';
import { buildContextPack, renderContextPack, SECTION_TABS } from './context.mjs';

export const ASK_VERSION = 'ask/1';
export const MODES = ['grounded', 'external'];
export const SUFFICIENCY = ['sufficient', 'partial', 'insufficient'];
export const MAX_QUESTION_CHARS = 600;
export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY_CHARS = 500;
export const MAX_ANSWER_CHARS = 2400;
export const MAX_FOLLOWUPS = 3;
export const MAX_SOURCES = 8;
export const EXTERNAL_LABEL = 'EXTERNAL — UNVERIFIED';
export const GROUNDED_MAX_TOKENS = 700;
export const EXTERNAL_MAX_TOKENS = 900;

const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function validateAskRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const question = typeof b.question === 'string' ? b.question.replace(/\s+/g, ' ').trim() : '';
  if (question.length < 3) return { ok: false, field: 'question', reason: 'too short' };
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, field: 'question', reason: `max ${MAX_QUESTION_CHARS} chars` };
  const mode = b.mode == null ? 'grounded' : b.mode;
  if (!MODES.includes(mode)) return { ok: false, field: 'mode', reason: `one of ${MODES.join('|')}` };
  if (b.history != null && !Array.isArray(b.history)) return { ok: false, field: 'history', reason: 'array' };
  const history = [];
  for (const h of (b.history || []).slice(-MAX_HISTORY_TURNS)) {
    if (!h || (h.role !== 'user' && h.role !== 'assistant') || typeof h.content !== 'string') return { ok: false, field: 'history', reason: 'each turn needs role user|assistant and string content' };
    history.push({ role: h.role, content: clip(h.content, MAX_HISTORY_CHARS) });
  }
  return { ok: true, value: { question, mode, history } };
}

export function groundedSystemPrompt(pack) {
  return [
    'You are "Ask CRUCIX", the read-only analyst assistant inside CRUCIX, an open-source intelligence monitor. Answer ONLY from the CRUCIX CONTEXT below, which is a snapshot of what the dashboard currently shows.',
    'Rules:',
    '- Every factual statement must be traceable to a context section. Cite by writing the section id in square brackets, e.g. [narco] or [defcon]. Only cite ids that appear in the context.',
    '- Keep the provenance distinctions CRUCIX makes: what a source reported (news wire, Telegram post, official bulletin), what CRUCIX computed (DEFCON, CII, grades, spikes, signals), what a model proposed (graded links, trade ideas), and what an analyst decided (requirements, target decisions). Say which one you are relying on when it matters.',
    '- Never invent events, numbers, names, dates or URLs. Do not use outside knowledge to fill gaps. If the context does not contain the answer, say so plainly and set sufficiency to "insufficient"; if it only partly answers, set "partial".',
    '- Telegram posts and single-source items are unverified; say so. Model-generated items are assessments, not facts.',
    '- Do not profile private individuals. People in the context are public figures / named in public reporting; stay within what the context says about them.',
    '- Be concise (under 220 words). Plain text, short paragraphs or dashes; no markdown headings.',
    'Respond with ONLY a JSON object: {"answer": string, "citations": [section ids used], "sufficiency": "sufficient"|"partial"|"insufficient", "followups": [up to 3 short follow-up questions the analyst could ask CRUCIX]}',
    '',
    `CRUCIX CONTEXT (as of ${pack.asOf || 'unknown'}; ${pack.sections.length} sections${pack.omitted.length ? `; omitted for size: ${pack.omitted.join(', ')}` : ''}):`,
    renderContextPack(pack),
  ].join('\n');
}

export function externalSystemPrompt(pack) {
  return [
    'You are "Ask CRUCIX" in EXTERNAL SEARCH mode. The analyst confirmed that the CRUCIX dashboard does not hold the answer, so you may use web search.',
    'Rules:',
    '- Use the web search tool. Base the answer on what you find and cite the pages (the platform attaches URL citations; also name the outlet inline).',
    '- Prefer primary and reputable sources (official statements, wire services, established outlets). Flag single-source or unconfirmed claims.',
    '- Keep CRUCIX data and external findings separate: do not present anything below as something you verified. Mention CRUCIX data only to note agreement or disagreement with what you found.',
    '- Do not profile private individuals. Public figures and organisations only.',
    '- Be concise (under 250 words). Plain text, no markdown headings. Begin directly with the answer.',
    pack ? `\nWhat the analyst already sees in CRUCIX (for orientation only, not verified by you):\n${pack.sections.slice(0, 4).map(s => `[${s.id}] ${clip(s.text, 500)}`).join('\n')}` : '',
  ].join('\n');
}

function historyBlock(history) {
  if (!history?.length) return '';
  return 'Prior turns in this conversation (for context):\n' + history.map(h => `${h.role === 'user' ? 'Analyst' : 'Ask CRUCIX'}: ${h.content}`).join('\n') + '\n\n';
}

export function parseGroundedAnswer(text, pack) {
  const ids = new Set(pack.sections.map(s => s.id));
  const raw = String(text || '');
  const j = parseJSON(raw);
  let answer, citations = [], sufficiency = 'partial', followups = [];
  if (j && typeof j.answer === 'string') {
    answer = j.answer;
    citations = Array.isArray(j.citations) ? j.citations : [];
    if (SUFFICIENCY.includes(j.sufficiency)) sufficiency = j.sufficiency;
    followups = Array.isArray(j.followups) ? j.followups.filter(f => typeof f === 'string').map(f => clip(f, 140)).slice(0, MAX_FOLLOWUPS) : [];
  } else {
    answer = raw.replace(/^```(?:json)?|```$/g, '').trim();
    if (!answer) return null;
  }
  answer = clip(answer, MAX_ANSWER_CHARS);
  const inline = [...answer.matchAll(/\[([a-z]+)\]/g)].map(m => m[1]);
  // A "not in CRUCIX" answer must not look sourced: keep only citations the text itself points at.
  citations = sufficiency === 'insufficient' ? inline : [...citations, ...inline];
  const seen = new Set();
  const cites = [];
  for (const c of citations) {
    const id = String(c || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    const s = pack.sections.find(x => x.id === id);
    cites.push({ id, tab: s.tab, label: s.label });
  }
  if (/\binsufficient\b|not (?:contain|include|available|present) in (?:the )?(?:crucix|context)|no (?:crucix )?data on/i.test(answer) && sufficiency === 'sufficient') sufficiency = 'partial';
  return { answer, citations: cites, sufficiency, followups };
}

// Deterministic fallback when no model is configured: return the best-matching sections verbatim.
export function rulesOnlyAnswer(pack) {
  const ranked = pack.sections.filter(s => s.score > 0).slice(0, 3);
  const pick = ranked.length ? ranked : pack.sections.slice(0, 2);
  return {
    answer: pick.length
      ? `No model is configured, so here is the CRUCIX data that best matches your question, verbatim:\n\n${pick.map(s => `[${s.id}] ${s.label}\n${clip(s.text, 700)}`).join('\n\n')}`
      : 'No model is configured and no sweep data is loaded yet.',
    citations: pick.map(s => ({ id: s.id, tab: s.tab, label: s.label })),
    sufficiency: ranked.length ? 'partial' : 'insufficient',
    followups: [],
  };
}

export async function askGrounded({ provider, state, question, history = [], maxContextChars } = {}) {
  const pack = buildContextPack(state, question, maxContextChars ? { maxChars: maxContextChars } : {});
  const context = { asOf: pack.asOf, sections: pack.sections.map(s => ({ id: s.id, tab: s.tab, label: s.label, chars: s.text.length })), omitted: pack.omitted, chars: pack.chars };
  const base = { mode: 'grounded', version: ASK_VERSION, question, context };
  if (!provider?.isConfigured) return { ...base, ...rulesOnlyAnswer(pack), llm: { used: false, reason: 'no provider' }, model: null, usage: null, suggestExternal: false };
  let res;
  try {
    res = await provider.complete(groundedSystemPrompt(pack), `${historyBlock(history)}Analyst question: ${question}`, { maxTokens: GROUNDED_MAX_TOKENS, timeout: 45000 });
  } catch (e) {
    return { ...base, ...rulesOnlyAnswer(pack), llm: { used: false, reason: `provider error: ${clip(e.message, 160)}` }, model: null, usage: null, suggestExternal: false };
  }
  const parsed = parseGroundedAnswer(res.text, pack);
  if (!parsed) return { ...base, ...rulesOnlyAnswer(pack), llm: { used: false, reason: 'empty model response' }, model: res.model || null, usage: res.usage || null, suggestExternal: false };
  return {
    ...base, ...parsed,
    suggestExternal: parsed.sufficiency !== 'sufficient' && !!provider.supportsWebSearch,
    llm: { used: true, reason: null }, model: res.model || null, usage: res.usage || null,
  };
}

export function normalizeSources(list) {
  const out = []; const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    let url = typeof s?.url === 'string' ? s.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    let host;
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
      url = u.toString().replace(/\?$/, '');
      host = u.hostname.replace(/^www\./, '');
    } catch { continue; }
    const key = url.replace(/[?#].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: clip(s.title || host, 120), url, host });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

export async function askExternal({ provider, state, question, history = [], maxContextChars } = {}) {
  const base = { mode: 'external', version: ASK_VERSION, question, label: EXTERNAL_LABEL };
  if (!provider?.isConfigured) return { ...base, ok: false, error: 'no model configured', answer: null, sources: [] };
  if (!provider.supportsWebSearch) return { ...base, ok: false, error: `provider ${provider.name} has no web search`, answer: null, sources: [] };
  const pack = state ? buildContextPack(state, question, { maxChars: Math.min(maxContextChars || 4000, 4000) }) : null;
  const res = await provider.completeWithWebSearch(externalSystemPrompt(pack), `${historyBlock(history)}Analyst question: ${question}`, { maxTokens: EXTERNAL_MAX_TOKENS, timeout: 60000 });
  const answer = clip(String(res.text || '').trim(), MAX_ANSWER_CHARS);
  if (!answer) return { ...base, ok: false, error: 'empty model response', answer: null, sources: [] };
  return { ...base, ok: true, answer, sources: normalizeSources(res.sources), searched: res.searched !== false, model: res.model || null, usage: res.usage || null, llm: { used: true, reason: null } };
}

export { buildContextPack, renderContextPack, SECTION_TABS };
