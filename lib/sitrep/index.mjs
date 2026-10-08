// lib/sitrep — Commander's SITREP engine. Drafts a 1–2 page commander-facing report from the
// SOUTHCOM-weighted context pack with the configured LLM provider (every claim cites a pack section),
// falls back to a deterministic "data SITREP" when no model is configured or the provider fails,
// and renders the edition to Markdown. The outside-source review pass and the weekly / monthly
// arcs build on the stored editions (see store.mjs); this module is pure apart from the provider call.
import { buildSitrepPack, renderSitrepPack, SITREP_CONTEXT_CHARS, COMMAND } from './context.mjs';
import { sha256 } from './store.mjs';
import { localParts, localDateKey, DEFAULT_TIMEZONE } from './schedule.mjs';

export const SITREP_VERSION = 'sitrep/1';
export const DAILY_EDITIONS = ['am', 'pm', 'adhoc'];
export const DOMAINS = COMMAND.short === 'EUCOM' ? ['Russia–Ukraine war', 'NATO eastern flank & Baltics', 'Belarus / Moldova / Balkans / Caucasus', 'Maritime & air (Black Sea, Baltic, Arctic)', 'Cyber, sabotage & energy', 'Sanctions & political'] : ['Counter-narcotics & transnational crime', 'Political / security (Colombia, Venezuela, AOR)', 'Maritime & air', 'Cyber & information', 'Sanctions & enforcement', 'Humanitarian / instability'];
export const DRAFT_MAX_TOKENS = 1800;
export const MAX_FIELD_CHARS = { bluf: 900, activity: 700, changes: 900, assessment: 1100, integrity: 900, watch: 220 };
export const MAX_ACTIVITY = 7;
export const MAX_WATCH = 7;
export const BANNER = 'OSINT DEMONSTRATION PRODUCT — model-drafted from CRUCIX open-source feeds. Not an official US Government product; computed indicators (DEFCON, CII, grades) are CRUCIX metrics, not official assessments.';
export const EDITION_LABEL = { am: 'AM edition', pm: 'PM edition', adhoc: 'Ad hoc edition' };

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const arr = v => (Array.isArray(v) ? v : []);
const words = s => String(s || '').split(/\s+/).filter(Boolean).length;

function parseJSON(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* give up */ } }
  return null;
}

export function editionId(now, edition, tz = DEFAULT_TIMEZONE) {
  const p = localParts(now, tz);
  const d = `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
  if (edition === 'adhoc') return `sitrep-${d}-adhoc-${String(p.hh).padStart(2, '0')}${String(p.mm).padStart(2, '0')}${String(p.ss).padStart(2, '0')}`;
  return `sitrep-${d}-${edition}`;
}

export function draftSystemPrompt(pack, { edition = 'am', windowHours = 12 } = {}) {
  const prev = pack.previous || null;
  return [
    'You draft the Commander\'s SITREP for ' + COMMAND.name + ' inside CRUCIX, an open-source intelligence monitor. Write ONLY from the CRUCIX CONTEXT below — a snapshot of what the dashboard holds right now.',
    `This is the ${EDITION_LABEL[edition] || edition} covering roughly the last ${windowHours} hours. Audience: the commander and staff — direct, operational, no hedging filler.`,
    'Rules:',
    '- EVERY sentence in EVERY field (bluf, activity, changes, watch, assessment, integrity) must end with at least one section citation in square brackets, e.g. "... two-day blackout in Caracas [venezuela][outages]." Only cite ids that appear in the context. Sentences without a citation are marked UNCITED in the product and count against you.',
    '- Air-activity counts are ALL aircraft in the box (airliners, cargo, general aviation and military together); only tracks explicitly flagged military are military. Never call the total "military aircraft".',
    '- Keep CRUCIX\'s provenance distinctions: what a source reported (wire, official bulletin, Telegram post), what CRUCIX computed (DEFCON, CII, grades, spikes, provenance scores — say "CRUCIX-computed"), what a model proposed, and what an analyst decided.',
    COMMAND.short === 'EUCOM' ? '- The EUCOM AOR is Europe, Russia, Ukraine, Belarus, Moldova, the Balkans, the Caucasus and Turkey. Lead with the Russia–Ukraine war and NATO eastern-flank activity; keep anything outside the AOR out of the BLUF.' : '- The SOUTHCOM AOR is Central America, South America and the Caribbean. Mexico and the US-Mexico border ([border], [cbp], [narco], [cjng] and Border Watch spikes) are NORTHCOM, not SOUTHCOM: use them only for trafficking-flow context, keep them out of the BLUF unless they bear on AOR routes, and end every such sentence with "(NORTHCOM context)".',
    '- Never invent events, numbers, names, dates, units or URLs. No outside knowledge. If an area has no data, say "no reporting in CRUCIX feeds" rather than guessing. Telegram and single-source items are unverified; say so.',
    prev
      ? `- "changes": a [previous] section IS present — ${prev.label} ${prev.id}, generated ${prev.generatedAt}${prev.ageMinutes != null ? ` (${prev.ageMinutes} minutes before this edition)` : ''}. This edition is NOT a baseline; never use the word "baseline". Open "changes" with "Versus ${prev.label} ${prev.id}:" and compare ONLY against that section's text and the [delta] section. Call something new, escalated or de-escalated only if the previous text does not already contain the same fact or number; otherwise write "unchanged since the previous edition". Do not guess how long ago the previous edition ran; use the minutes given.`
      : '- "changes": there is NO [previous] section — this is the baseline edition. Say so in one sentence citing [situation] or [delta], then describe only what the [delta] section reports versus the last sweep.',
    '- Before writing that something increased, decreased, rose, fell, worsened or improved, quote BOTH figures: "from X (previous edition) to Y". If the [previous] section shows the SAME figure, write "unchanged at X since the previous edition". If it shows no figure for it, write "first reported this edition" — never call a figure an increase or a worsening on its own.',
    '- Confidence words follow the data: call a contact corroborated / high-confidence only if the provenance line reports corroborated > 0 for it; otherwise say single-source or unverified. Do not upgrade confidence.',
    '- Do not profile private individuals; people in the context are public figures or named in public reporting.',
    '- Length: 600–900 words total. Plain prose and short dashes; no markdown headings inside fields.',
    'Respond with ONLY a JSON object:',
    '{"bluf": string (3–5 sentences, the commander\'s bottom line up front),',
    ` "activity": [up to ${MAX_ACTIVITY} objects {"domain": one of ${JSON.stringify(DOMAINS)}, "text": 2–4 sentences with citations}],`,
    ` "changes": string (${prev ? `what is new, escalated or de-escalated versus ${prev.label} ${prev.id} [previous] and the last sweep [delta]` : 'baseline edition: what the last sweep [delta] reports; no previous edition to compare'}),`,
    ` "watch": [up to ${MAX_WATCH} short indicator-and-warning items to watch over the next 24 h, each with a citation],`,
    ' "assessment": string (CRUCIX-grounded assessment for the next 24 h; label it as assessment, state confidence low/moderate/high and why),',
    ' "integrity": string (which claims rest on single sources, Telegram, stale or degraded feeds; what the feeds cannot see)}',
    '',
    `CRUCIX CONTEXT (as of ${pack.asOf || 'unknown'}; ${pack.sections.length} sections${pack.omitted.length ? `; omitted for size: ${pack.omitted.join(', ')}` : ''}):`,
    renderSitrepPack(pack),
  ].join('\n');
}

// Strip citations the pack cannot back; collect the ones it can.
function citeFilter(text, ids, seen) {
  return String(text || '').replace(/\[([a-z]+)\]/g, (m, id) => { if (ids.has(id)) { seen.add(id); return m; } return ''; }).replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

export const UNCITED = '[UNCITED]';
const NORTHCOM_RE = /\b(Mexic(?:o|an)|US[-–]Mexico|southwest border|Ciudad Ju[aá]rez|Tijuana|Reynosa|Matamoros|Nuevo Laredo|Nogales|El Paso|Rio Grande|Hidalgo County|Laredo|San Diego|Arizona|Texas|Sinaloa|Chihuahua|Tamaulipas|Sonora|Michoac[aá]n|Jalisco|CBP|Border Patrol|Border Watch)\b/i;
const splitSentences = (t) => String(t || '').match(/[^.!?]+(?:[.!?]+(?:\s*\[[a-z]+\])*|$)/g)?.map(x => x.trim()).filter(Boolean) || [];
// Sentence pass after citation filtering: tag NORTHCOM (Mexico / US border) material, mark sentences with no surviving citation.
export function annotateSentences(text) {
  let uncited = 0;
  const out = splitSentences(text).map(sen => {
    let x = sen;
    if (NORTHCOM_RE.test(x) && !/NORTHCOM/i.test(x)) x = x.replace(/(\s*(?:\[[a-z]+\])*)\s*([.!?]+)?$/, (m, cites, p) => ` (NORTHCOM context)${cites || ''}${p || '.'}`);
    if (!/\[[a-z]+\]/.test(x)) { uncited++; x = x.replace(/([.!?]+)?$/, (m, p) => ` ${UNCITED}${p || '.'}`); }
    return x;
  });
  return { text: out.join(' '), uncited, total: out.length };
}

// The model has a habit of calling an edition "the baseline" even when [previous] is in the context.
// With a previous edition present, replace any such sentence with the deterministic comparison line.
const BASELINE_RE = /\b(baseline|no (?:prior|previous|earlier) (?:SITREP|edition|report)|first (?:SITREP|edition)|without (?:a )?previous)\b/i;
export function fixBaselineClaim(changes, prev) {
  if (!prev || !BASELINE_RE.test(String(changes || ''))) return { text: changes, fixed: false };
  const kept = splitSentences(changes).filter(sen => !BASELINE_RE.test(sen));
  const lead = `Versus ${prev.label} ${prev.id} (generated ${prev.generatedAt}${prev.ageMinutes != null ? `, ${prev.ageMinutes} minutes before this edition` : ''}) [previous].`;
  return { text: [lead, ...kept].join(' '), fixed: true };
}

// A "changes" sentence that says increased / worsened / fell … while quoting a single figure that the previous
// edition already reported is not a change the data supports. Flag it (analyst cue), do not rewrite it.
export const SAME_FIGURE = '[SAME FIGURE AS PREVIOUS]';
const TREND_RE = /\b(increas\w*|ris(?:e|es|ing)|rose|risen|worsen\w*|escalat\w*|climb\w*|surg\w*|jump\w*|spik\w*|grew|grow\w*|up from|declin\w*|fell|fall\w*|dropp?\w*|de-?escalat\w*|down from|improv\w*|decreas\w*|deteriorat\w*|higher|lower|more than|fewer|doubl\w*|halv\w*)\b/i;
// Sentences that say a figure did NOT move are fine even though they contain a trend word ("no rise or fall").
const STEADY_RE = /\b(steady|stable|flat|unchanged|same as|first reported|remain(?:s|ed|ing)?\b|hold(?:s|ing)?\b|held\b|no (?:rise|fall|increase|decrease|change|movement)|neither|persist(?:s|ed|ing)?\b|continu(?:es|ed|ing)?\b)/i;
const NUM_RE = /\d[\d,]*(?:\.\d+)?\s?(?:%|×|x\b|percent\b)?/g;
const normNum = n => n.replace(/,/g, '').replace(/\s+/g, '').replace(/percent$/, '%').replace(/x$/, '×');
// Edition ids, ISO dates / times and citation tokens are not figures.
const deNoise = t => String(t || '').replace(/sitrep-\d{8}[a-z0-9-]*/gi, ' ').replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, ' ').replace(/\b\d{3,4}\s?(?:EDT|EST|UTC|Z)\b/g, ' ').replace(/\b\d+\s?(?:minutes?|min|hours?|h)\b/gi, ' ').replace(/\[[a-z]+\d*\]/g, ' ');
export function flagUnsupportedChanges(changes, previousText) {
  if (!previousText || !changes) return { text: changes, flagged: 0 };
  const prevNums = new Set((deNoise(previousText).match(NUM_RE) || []).map(normNum));
  let flagged = 0;
  const out = splitSentences(changes).map(sen => {
    if (!TREND_RE.test(sen) || STEADY_RE.test(sen)) return sen;
    const nums = [...new Set((deNoise(sen).match(NUM_RE) || []).map(normNum))];
    if (nums.length !== 1 || !prevNums.has(nums[0])) return sen;
    flagged++;
    return sen.replace(/(\s*(?:\[[a-z]+\d*\])*)\s*([.!?]+)?$/, (m, cites, p) => ` ${SAME_FIGURE}${(cites || '').trim()}${p || '.'}`);
  });
  return { text: out.join(' '), flagged };
}

export function parseDraft(text, pack) {
  const j = parseJSON(text);
  if (!j || typeof j.bluf !== 'string' || !j.bluf.trim()) return null;
  const ids = new Set(pack.sections.map(s => s.id));
  const seen = new Set();
  const f = (v, n) => citeFilter(clip(v, n), ids, seen);
  let uncited = 0, total = 0;
  const g = (v, n) => { const a = annotateSentences(f(v, n)); uncited += a.uncited; total += a.total; return a.text; };
  const bluf = g(j.bluf, MAX_FIELD_CHARS.bluf);
  const activity = arr(j.activity).filter(a => a && typeof a.text === 'string' && a.text.trim()).slice(0, MAX_ACTIVITY)
    .map(a => ({ domain: DOMAINS.includes(a.domain) ? a.domain : clip(a.domain || 'Other', 60), text: g(a.text, MAX_FIELD_CHARS.activity) }));
  const watch = arr(j.watch).filter(w => typeof w === 'string' && w.trim()).slice(0, MAX_WATCH).map(w => g(w, MAX_FIELD_CHARS.watch));
  const fixed = fixBaselineClaim(citeFilter(clip(j.changes, MAX_FIELD_CHARS.changes), ids, seen), pack.previous);
  const same = flagUnsupportedChanges(fixed.text, pack.previous?.fullText);
  const changes = g(same.text, MAX_FIELD_CHARS.changes + 40 * same.flagged);
  const assessment = g(j.assessment, MAX_FIELD_CHARS.assessment);
  const integrity = g(j.integrity, MAX_FIELD_CHARS.integrity);
  const citations = [...seen].map(id => { const s = pack.sections.find(x => x.id === id); return { id, tab: s.tab, label: s.label }; });
  return { bluf, activity, changes, watch, assessment, integrity, citations, grounding: { sentences: total, uncited, ...(fixed.fixed ? { baselineFixed: true } : {}), ...(same.flagged ? { sameFigure: same.flagged } : {}) } };
}

// Deterministic fallback: a structured data digest, clearly not a narrative.
export function rulesOnlySitrep(pack, reason = 'no model configured') {
  const by = id => pack.sections.find(s => s.id === id);
  const sit = by('situation'), prev = by('previous'), delta = by('delta');
  const pick = (ids) => ids.map(by).filter(Boolean);
  const digest = (s, n = 420) => `[${s.id}] ${clip(s.text, n)}`;
  const activity = COMMAND.short === 'EUCOM' ? [
    { domain: DOMAINS[0], ids: ['ukraine', 'conflict'] },
    { domain: DOMAINS[1], ids: ['aor', 'signals'] },
    { domain: DOMAINS[2], ids: ['cii', 'news'] },
    { domain: DOMAINS[3], ids: ['maritime'] },
    { domain: DOMAINS[4], ids: ['outages', 'ioda', 'kev', 'ransomware', 'telegram'] },
    { domain: DOMAINS[5], ids: ['focal', 'macro'] },
  ] : [
    { domain: DOMAINS[0], ids: ['narco', 'insightcrime', 'sanctions', 'cjng'] },
    { domain: DOMAINS[1], ids: ['colombia', 'venezuela', 'aor', 'conflict'] },
    { domain: DOMAINS[2], ids: ['caribbeanair', 'maritime', 'signals'] },
    { domain: DOMAINS[3], ids: ['outages', 'telegram', 'ioda'] },
    { domain: DOMAINS[5], ids: ['focal', 'news'] },
  ].map(d => ({ domain: d.domain, text: pick(d.ids).map(s => digest(s)).join(' ') || 'No reporting in CRUCIX feeds this edition.' }));
  const bluf = sit
    ? `Data SITREP (${reason}; no model narrative). ${digest(sit, 600)}`
    : pack.sections.length
      ? `Data SITREP (${reason}; no model narrative). Situation headline section unavailable this sweep; the domain digests below are CRUCIX feed output verbatim.`
      : `Data SITREP (${reason}). No sweep data is loaded yet; the first sweep has not completed.`;
  const watch = pick(['requirements', 'delta', 'aor']).map(s => digest(s, 200));
  return {
    bluf, activity,
    changes: delta ? digest(delta, 700) : prev ? `No delta section this sweep. ${digest(prev, 500)}` : 'Baseline edition: no previous SITREP and no delta section available.',
    watch,
    assessment: 'No model is configured, so no assessment is offered. The sections above are CRUCIX data verbatim; the commander\'s staff should read them as feed output, not analysis.',
    integrity: `${by('sources') ? digest(by('sources'), 500) : 'Source health unavailable.'} Telegram and single-source items are unverified. CRUCIX indices (DEFCON, CII, grades) are computed metrics.`,
    citations: pack.sections.map(s => ({ id: s.id, tab: s.tab, label: s.label })),
    grounding: null,
  };
}

function fmtLocal(iso, tz) {
  if (!iso) return 'unknown';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso);
  const p = localParts(d, tz);
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][p.m - 1];
  return `${String(p.d).padStart(2, '0')} ${mon} ${p.y} ${String(p.hh).padStart(2, '0')}${String(p.mm).padStart(2, '0')} ${tzAbbrev(d, tz)}`;
}
function tzAbbrev(d, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || tz; } catch { return tz; }
}

export function renderMarkdown(ed) {
  const tz = ed.timezone || DEFAULT_TIMEZONE;
  const L = [];
  L.push(`# COMMANDER'S SITREP — ${COMMAND.short} AOR (OSINT)`);
  L.push(`**${EDITION_LABEL[ed.edition] || ed.edition}** · ${fmtLocal(ed.generatedAt, tz)} · CRUCIX sweep as of ${fmtLocal(ed.asOf, tz)} · edition \`${ed.id}\``);
  L.push('');
  L.push(`> ${BANNER}`);
  L.push('');
  L.push('## 1. BLUF');
  L.push(ed.bluf || '—');
  L.push('');
  L.push(`## 2. Significant activity (last ${ed.windowHours || 12} h)`);
  for (const a of arr(ed.activity)) L.push(`- **${a.domain}.** ${a.text}`);
  if (!arr(ed.activity).length) L.push('- No reporting in CRUCIX feeds.');
  L.push('');
  L.push('## 3. Changes since previous SITREP');
  L.push(ed.changes || '—');
  L.push('');
  L.push('## 4. Indicators & warnings — next 24 h');
  for (const w of arr(ed.watch)) L.push(`- ${w}`);
  if (!arr(ed.watch).length) L.push('- None identified in CRUCIX feeds.');
  L.push('');
  L.push('## 5. Assessment (next 24 h)');
  L.push(ed.assessment || '—');
  L.push('');
  L.push('## 6. Source integrity & caveats');
  L.push(ed.integrity || '—');
  if (ed.external) {
    L.push('');
    L.push(`## 7. ${ed.external.label || 'EXTERNAL — UNVERIFIED'}`);
    for (const f of arr(ed.external.findings)) L.push(`- ${f.text}${f.url ? ` (${f.url})` : ''}`);
    if (!arr(ed.external.findings).length) L.push(ed.external.note || '- No additional developments found.');
  }
  L.push('');
  L.push('---');
  L.push(`Sources cited (CRUCIX sections): ${arr(ed.citations).map(c => `[${c.id}] ${c.label}`).join('; ') || 'none'}.`);
  if (ed.grounding?.sentences) L.push(`Grounding: ${ed.grounding.sentences - ed.grounding.uncited}/${ed.grounding.sentences} sentences cite a CRUCIX section${ed.grounding.uncited ? `; ${ed.grounding.uncited} marked ${UNCITED} (not traceable to the feeds)` : ''}${ed.grounding.repaired ? ` · citation repair pass applied (${ed.grounding.before} → ${ed.grounding.uncited} uncited)` : ''}${ed.grounding.baselineFixed ? ' · model called this edition a baseline despite a previous edition; sentence replaced with the deterministic comparison line' : ''}${ed.grounding.sameFigure ? ` · ${ed.grounding.sameFigure} change sentence(s) claim a trend on a figure the previous edition already reported — marked ${SAME_FIGURE}, verify before briefing` : ''}.`);
  L.push(`Generation: ${ed.llm?.used ? `${ed.model || 'model'} · ${ed.usage?.inputTokens ?? '?'} in / ${ed.usage?.outputTokens ?? '?'} out tokens` : `rules-only (${ed.llm?.reason || 'no model'})`} · context ${ed.context?.chars ?? '?'} chars, ${arr(ed.context?.sections).length} sections${arr(ed.context?.omitted).length ? `, omitted ${ed.context.omitted.join(', ')}` : ''}.`);
  return L.join('\n');
}

export const REPAIR_MAX_TOKENS = 1800;
export const REPAIR_THRESHOLD = 0.15; // repair when more than 15 % of sentences came back uncited

export function repairSystemPrompt(pack) {
  return [
    'You are fixing a Commander\'s SITREP draft that was written from the CRUCIX context sections listed below. Several sentences lack citations.',
    'Return the SAME JSON object with the SAME fields and the SAME facts, changed only as follows:',
    '- Every sentence in every field ends with one or more section citations in square brackets chosen from the list below (the section whose data supports the sentence).',
    '- If a sentence cannot be supported by any listed section, delete it. Do not add new facts, numbers or names.',
    '- Sentences about Mexico or the US-Mexico border end with "(NORTHCOM context)" before the citation.',
    '- Air-activity totals are all aircraft, not military aircraft.',
    'Available sections:',
    ...pack.sections.map(s => `[${s.id}] ${s.label}`),
    'Respond with ONLY the JSON object.',
  ].join('\n');
}

// Draft one daily edition. `previous` is the last stored daily edition (or null for the baseline).
export async function generateSitrep({ provider, state, edition = 'adhoc', previous = null, now = new Date(), tz = DEFAULT_TIMEZONE, maxContextChars = SITREP_CONTEXT_CHARS, slotKey = null, windowHours = 12, trigger = 'manual' } = {}) {
  if (!DAILY_EDITIONS.includes(edition)) throw new Error(`unknown edition ${edition}`);
  const prevAge = previous?.generatedAt ? Math.max(0, Math.round((now.getTime() - new Date(previous.generatedAt).getTime()) / 60000)) : null;
  const pack = buildSitrepPack(state, { maxChars: maxContextChars, previous: previous ? { id: previous.id, edition: previous.edition, generatedAt: previous.generatedAt, ageMinutes: Number.isFinite(prevAge) ? prevAge : null, bluf: previous.bluf, activity: previous.activity, changes: previous.changes, watch: previous.watch, assessment: previous.assessment } : null });
  if (pack.previous && previous) pack.previous.fullText = [previous.bluf, ...arr(previous.activity).map(a => a?.text), previous.changes, ...arr(previous.watch), previous.assessment].join(' ');
  const base = {
    version: SITREP_VERSION, id: editionId(now, edition, tz), edition, slotKey, dateKey: localDateKey(now, tz), timezone: tz, trigger,
    generatedAt: now.toISOString(), asOf: pack.asOf, windowHours, previousId: previous?.id || null,
    context: { chars: pack.chars, sections: pack.sections.map(s => s.id), omitted: pack.omitted },
    external: null, banner: BANNER,
  };
  let body, llm, model = null, usage = null;
  if (!provider?.isConfigured) {
    body = rulesOnlySitrep(pack); llm = { used: false, reason: 'no model configured' };
  } else {
    try {
      const res = await provider.complete(draftSystemPrompt(pack, { edition, windowHours }), `Draft the ${EDITION_LABEL[edition] || edition} now.`, { maxTokens: DRAFT_MAX_TOKENS, timeout: 90000 });
      model = res?.model || null; usage = res?.usage || null;
      let parsed = parseDraft(res?.text, pack);
      if (parsed && parsed.grounding.sentences && parsed.grounding.uncited / parsed.grounding.sentences > REPAIR_THRESHOLD) {
        try {
          const fix = await provider.complete(repairSystemPrompt(pack), `Draft to fix:\n${res.text}`, { maxTokens: REPAIR_MAX_TOKENS, timeout: 90000 });
          const repaired = parseDraft(fix?.text, pack);
          if (repaired && repaired.grounding.uncited < parsed.grounding.uncited) {
            parsed = { ...repaired, grounding: { ...repaired.grounding, repaired: true, before: parsed.grounding.uncited } };
            if (fix?.usage) usage = { inputTokens: (usage?.inputTokens || 0) + (fix.usage.inputTokens || 0), outputTokens: (usage?.outputTokens || 0) + (fix.usage.outputTokens || 0) };
          }
        } catch { /* keep the first draft, uncited sentences stay marked */ }
      }
      if (parsed) { body = parsed; llm = { used: true, reason: null }; }
      else { body = rulesOnlySitrep(pack, 'model returned an unparseable draft'); llm = { used: false, reason: 'unparseable model response' }; }
    } catch (e) {
      body = rulesOnlySitrep(pack, 'provider error'); llm = { used: false, reason: `provider error: ${clip(e.message, 160)}` };
    }
  }
  const ed = { ...base, ...body, llm, model, usage };
  ed.words = words([ed.bluf, ...arr(ed.activity).map(a => a.text), ed.changes, ...arr(ed.watch), ed.assessment, ed.integrity].join(' '));
  ed.markdown = renderMarkdown(ed);
  ed.sha256 = sha256(ed.markdown);
  return ed;
}

export { buildSitrepPack, renderSitrepPack };
