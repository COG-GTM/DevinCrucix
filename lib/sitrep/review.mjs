// Outside-source review pass (step 2 of the SITREP workflow). Hands the CRUCIX-grounded draft to the
// provider's hosted web search and asks what material AOR developments it misses or gets wrong. Everything
// that comes back is kept in its own block, labelled EXTERNAL — UNVERIFIED, with the provider's URL
// citations; nothing is merged into the grounded sections. Pure apart from the provider call.
export const EXTERNAL_LABEL = 'EXTERNAL — UNVERIFIED';
export const REVIEW_MAX_TOKENS = 1100;
export const MAX_FINDINGS = 8;
export const MAX_FINDING_CHARS = 320;
export const MAX_SOURCES = 12;
export const KINDS = ['missing', 'contradicts', 'corroborates'];

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const arr = v => (Array.isArray(v) ? v : []);
const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : null; } catch { return null; } };

function parseJSON(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* give up */ } }
  return null;
}

export function normalizeSources(list) {
  const seen = new Set(); const out = [];
  for (const s of arr(list)) {
    const url = httpsUrl(s?.url); if (!url || seen.has(url)) continue;
    seen.add(url); out.push({ title: clip(s.title || '', 160), url });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

export function draftSummary(ed) {
  return [
    `BLUF: ${ed.bluf || '—'}`,
    `ACTIVITY: ${arr(ed.activity).map(a => `${a.domain}: ${a.text}`).join(' | ') || '—'}`,
    `CHANGES: ${ed.changes || '—'}`,
    `WATCH: ${arr(ed.watch).join(' | ') || '—'}`,
    `ASSESSMENT: ${ed.assessment || '—'}`,
  ].join('\n').replace(/\s?\[(?:[a-z]+|UNCITED)\]/g, '');
}

export function reviewSystemPrompt(ed, { windowHours = 24 } = {}) {
  return [
    'You are the outside-source reviewer for a Commander\'s SITREP covering the US Southern Command (SOUTHCOM) AOR — Central America, South America and the Caribbean.',
    `The draft below was written only from an open-source monitor's own feeds. Use web search to check what MATERIAL developments in the AOR from roughly the last ${windowHours} hours it is missing or gets wrong: security incidents, coups / unrest, major narcotics interdictions, maritime or air incidents, sanctions or indictments, natural disasters, cyber incidents affecting the AOR, major political decisions.`,
    'Rules:',
    '- Report only items you actually found in search results, each with the URL you took it from. No URL → do not report it.',
    `- At most ${MAX_FINDINGS} findings, one or two sentences each, most important first. Skip anything the draft already covers unless you are correcting it.`,
    '- Do not restate or rewrite the draft; do not assess. Mexico / US-border items only if they bear on AOR trafficking routes.',
    '- If nothing material is missing, return an empty findings list and say so in "note".',
    'Respond with ONLY a JSON object: {"findings": [{"kind": "missing" | "contradicts" | "corroborates", "text": string, "url": string, "published": string (date if known, else "")}], "note": string (one sentence on coverage: what you searched and whether the draft holds up)}',
    '',
    `DRAFT (generated ${ed.generatedAt || 'unknown'}, data as of ${ed.asOf || 'unknown'}):`,
    draftSummary(ed),
  ].join('\n');
}

// Only URLs the provider itself cited are trusted; a finding whose URL the model typed from memory is dropped.
export function parseReview(text, sources) {
  const j = parseJSON(text);
  if (!j || !Array.isArray(j.findings)) return null;
  const cited = new Set(sources.map(s => s.url));
  const hosts = new Set(sources.map(s => { try { return new URL(s.url).host; } catch { return null; } }).filter(Boolean));
  const findings = []; let dropped = 0;
  for (const f of j.findings) {
    if (!f || typeof f.text !== 'string' || !f.text.trim()) continue;
    const url = httpsUrl(f.url);
    let host = null; try { host = url ? new URL(url).host : null; } catch { /* ignore */ }
    if (!url || !(cited.has(url) || hosts.has(host))) { dropped++; continue; }
    findings.push({ kind: KINDS.includes(f.kind) ? f.kind : 'missing', text: clip(f.text, MAX_FINDING_CHARS), url, published: clip(f.published || '', 40) });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return { findings, dropped, note: clip(j.note || '', 400) };
}

// Returns the `external` block for an edition. Never throws: provider problems become status/error fields.
export async function reviewSitrep({ provider, edition, windowHours = 24, maxTokens = REVIEW_MAX_TOKENS, timeout = 75000 } = {}) {
  const base = { label: EXTERNAL_LABEL, reviewedAt: new Date().toISOString(), findings: [], sources: [], note: '', model: null, usage: null };
  if (!provider?.isConfigured) return { ...base, status: 'unavailable', error: 'no model configured', note: 'Outside-source review not run: no model configured.' };
  if (!provider.supportsWebSearch) return { ...base, status: 'unavailable', error: `provider ${provider.name} has no web search`, note: `Outside-source review not run: provider ${provider.name} has no hosted web search.` };
  try {
    const res = await provider.completeWithWebSearch(reviewSystemPrompt(edition, { windowHours }), 'Review the draft against current open sources now.', { maxTokens, timeout });
    const sources = normalizeSources(res?.sources);
    const parsed = parseReview(res?.text, sources);
    if (!parsed) return { ...base, status: 'error', error: 'unparseable review response', sources, model: res?.model || null, usage: res?.usage || null, note: 'Outside-source review returned an unreadable response; no external findings recorded.' };
    return {
      ...base, status: 'ok', findings: parsed.findings, sources, dropped: parsed.dropped, searched: res?.searched !== false,
      note: parsed.note || (parsed.findings.length ? '' : 'No material developments found that the draft misses.'),
      model: res?.model || null, usage: res?.usage || null,
    };
  } catch (e) {
    return { ...base, status: 'error', error: clip(e.message, 160), note: 'Outside-source review failed; no external findings recorded.' };
  }
}
