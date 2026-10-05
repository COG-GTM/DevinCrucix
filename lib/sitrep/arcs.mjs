// lib/sitrep/arcs — weekly and monthly narrative arcs, written FROM THE STORED SITREPs ONLY (never from
// live feeds). Each source edition gets a token ([d1]… dailies, [w1]… weeklies) that the model must cite,
// so every sentence traces back to an archived, hashed edition. Deterministic "trend lines" (edition counts,
// grounding rates, missed slots, theme recurrence) are computed here, not by the model. Rules-only fallback
// when no model is configured. Same guardrails as the daily engine: bounded context, bounded output,
// unsupported citations stripped, uncited sentences marked, NORTHCOM tagging.
import { sha256 } from './store.mjs';
import { localParts, localDateKey, DEFAULT_TIMEZONE } from './schedule.mjs';
import { AOR_COUNTRIES } from './context.mjs';
import { BANNER, UNCITED, annotateSentences, splitSentences, parseJSON, clip, DAILY_EDITIONS } from './index.mjs';

export const ARC_VERSION = 'sitrep-arc/1';
export const ARC_KINDS = ['weekly', 'monthly'];
export const ARC_LABEL = { weekly: 'Weekly arc', monthly: 'Monthly arc' };
export const ARC_DAYS = { weekly: 7, monthly: 30 };
export const ARC_MAX_TOKENS = 2200;
export const ARC_CONTEXT_CHARS = 30000;
export const MIN_SOURCES = 2;
export const MAX_ARC_ITEMS = 7;
export const MAX_FIELD = { bluf: 900, arc: 700, fizzled: 700, outlook: 1000, integrity: 900 };
export const SPAN_FLAG = '[BEYOND EDITION SPAN]';
export const ALREADY_RE = /\[ALREADY IN [a-z]+\d*\]/g;
const PERIOD_RE = /\b((?:throughout|across|over|during|all|the entire|the whole|every day of) the (?:week|month|period)|all (?:week|month)|daily|day[- ]to[- ]day|week-?long|month-?long|each day|every day|steadily|consistently|repeatedly|persist(?:ed|ently)|sustained|continued?(?:ly)? (?:throughout|across|all))\b/i;
const THEME_STOP = new Set(['the','and','for','with','from','into','over','aor','activity','activities','trend','trends','situation','status','update','updates','levels?','level','posture','region','regional','threat','threats','risk','risks','reporting','coverage','ops','operations','index','indicator','indicators','watch','item','items']);
export const TRAJECTORIES = ['emerged', 'escalating', 'steady', 'de-escalating', 'resolved'];
// Theme recurrence is counted over these terms (AOR countries + recurring SOUTHCOM subjects); deterministic.
export const THEME_TERMS = [...AOR_COUNTRIES, 'blackout', 'outage', 'cocaine', 'seizure', 'sanction', 'protest', 'massacre', 'Telegram', 'military aircraft', 'vessel', 'migrant', 'hurricane', 'earthquake', 'election', 'ELN', 'FARC', 'Tren de Aragua', 'Clan del Golfo', 'cartel', 'DEFCON', 'ransomware'];

const arr = v => (Array.isArray(v) ? v : []);
const words = s => String(s || '').split(/\s+/).filter(Boolean).length;
const strip = t => String(t || '').replace(/\s*\[[a-z]+\d*\]/g, '').replace(/\s*\[UNCITED\]/g, '').replace(/\s+/g, ' ').trim();
const EDL = { am: 'AM edition', pm: 'PM edition', adhoc: 'ad hoc edition', weekly: 'weekly arc', monthly: 'monthly arc' };

export function arcId(now, kind, tz = DEFAULT_TIMEZONE, scheduled = false) {
  const p = localParts(now, tz);
  const d = `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
  return scheduled ? `sitrep-${d}-${kind}` : `sitrep-${d}-${kind}-${String(p.hh).padStart(2, '0')}${String(p.mm).padStart(2, '0')}${String(p.ss).padStart(2, '0')}`;
}

export function arcWindow(kind, now = new Date(), tz = DEFAULT_TIMEZONE) {
  const days = ARC_DAYS[kind] || 7;
  const end = now, start = new Date(now.getTime() - days * 86400_000);
  return { kind, days, start: start.toISOString(), end: end.toISOString(), startKey: localDateKey(start, tz), endKey: localDateKey(end, tz) };
}

// Pick the editions an arc is written from: weekly ← dailies in the window; monthly ← weeklies + dailies in the window.
export function selectSources(store, kind, window) {
  const dailies = store.range({ sinceIso: window.start, untilIso: window.end, kinds: DAILY_EDITIONS });
  const weeklies = kind === 'monthly' ? store.range({ sinceIso: window.start, untilIso: window.end, kinds: ['weekly'] }) : [];
  return { dailies, weeklies };
}

function fmtLocal(iso, tz) {
  if (!iso) return '?';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso);
  const p = localParts(d, tz);
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][p.m - 1];
  return `${String(p.d).padStart(2, '0')} ${mon} ${p.y} ${String(p.hh).padStart(2, '0')}${String(p.mm).padStart(2, '0')}`;
}

// One edition → one context block. `scale` (0–1) shrinks the per-field budget when the pack is over budget.
function digest(ed, token, tz, scale = 1) {
  const n = k => Math.max(80, Math.round(k * scale));
  const g = ed.grounding;
  const head = `### [${token}] ${EDL[ed.edition] || ed.edition} ${ed.id} — ${fmtLocal(ed.generatedAt, tz)} · ${ed.llm?.used ? `model ${ed.model || ''}` : 'RULES-ONLY digest (no model)'}${g?.sentences ? ` · ${g.sentences - g.uncited}/${g.sentences} sentences cited` : ''}`;
  const L = [head, `BLUF: ${clip(strip(ed.bluf), n(520))}`];
  if (ARC_KINDS.includes(ed.edition)) {
    for (const a of arr(ed.arc).slice(0, 5)) L.push(`ARC ${a.trajectory || '?'} — ${clip(strip(a.theme), 60)}: ${clip(strip(a.text), n(220))}`);
    if (ed.outlook) L.push(`OUTLOOK: ${clip(strip(ed.outlook), n(300))}`);
  } else {
    if (ed.changes) L.push(`CHANGES: ${clip(strip(ed.changes), n(320))}`);
    const w = arr(ed.watch).map(x => clip(strip(x), n(110))).slice(0, 5);
    if (w.length) L.push(`WATCH: ${w.join(' | ')}`);
    if (ed.assessment) L.push(`ASSESSMENT: ${clip(strip(ed.assessment), n(280))}`);
    const f = arr(ed.external?.findings);
    if (f.length) L.push(`EXTERNAL (web search, UNVERIFIED): ${f.slice(0, 4).map(x => `${x.kind || 'missing'}: ${clip(x.text, n(120))}`).join(' | ')}`);
  }
  return L.join('\n');
}

// Deterministic trend lines over the source editions (computed, labelled as such).
export function computeStats(dailies, weeklies, window, tz) {
  const all = [...weeklies, ...dailies];
  const byKind = {}; for (const e of all) byKind[e.edition] = (byKind[e.edition] || 0) + 1;
  const model = all.filter(e => e.llm?.used).length;
  const gr = all.filter(e => e.grounding?.sentences);
  const sentences = gr.reduce((a, e) => a + e.grounding.sentences, 0), uncited = gr.reduce((a, e) => a + e.grounding.uncited, 0);
  const ext = { reviewed: 0, missing: 0, contradicts: 0, corroborates: 0 };
  for (const e of dailies) if (e.external?.status === 'ok') { ext.reviewed++; for (const f of arr(e.external.findings)) ext[f.kind] = (ext[f.kind] || 0) + 1; }
  // Missed AM / PM slots: every local day fully inside the window should have both.
  const have = new Set(dailies.filter(e => e.slotKey).map(e => e.slotKey));
  const missed = [];
  for (let t = new Date(window.start).getTime() + 86400_000; t < new Date(window.end).getTime() - 86400_000; t += 86400_000) {
    const k = localDateKey(new Date(t), tz);
    for (const ed of ['am', 'pm']) if (!have.has(`${k}-${ed}`)) missed.push(`${k}-${ed}`);
  }
  // Theme recurrence: how many editions mention each term (BLUF + changes + watch + assessment).
  const themes = [];
  const tokens = new Map(dailies.map((e, i) => [e.id, `d${i + 1}`]));
  for (const term of THEME_TERMS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const hits = dailies.filter(e => re.test([e.bluf, e.changes, ...arr(e.watch), e.assessment].join(' ')));
    if (hits.length >= 2) themes.push({ term, editions: hits.length, of: dailies.length, first: tokens.get(hits[0].id), last: tokens.get(hits[hits.length - 1].id) });
  }
  themes.sort((a, b) => b.editions - a.editions || a.term.localeCompare(b.term));
  const times = all.map(e => new Date(e.generatedAt).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  const spanHours = times.length > 1 ? Math.round((times[times.length - 1] - times[0]) / 3600) / 1000 : 0;
  const first = times.length ? new Date(times[0]).toISOString() : null, last = times.length ? new Date(times[times.length - 1]).toISOString() : null;
  return { editions: all.length, spanHours, first, last, windowDays: window.days, byKind, model, rulesOnly: all.length - model, sentences, uncited, citedPct: sentences ? Math.round(100 * (sentences - uncited) / sentences) : null, external: ext, missedSlots: missed.slice(0, 40), missedCount: missed.length, themes: themes.slice(0, 12) };
}

// Pack: weeklies first ([w1]…), then dailies oldest→newest ([d1]…); shrink, then drop the oldest dailies to fit.
export function buildArcPack({ dailies, weeklies, kind, window, tz = DEFAULT_TIMEZONE, maxChars = ARC_CONTEXT_CHARS }) {
  const sources = [...weeklies.map((e, i) => ({ token: `w${i + 1}`, ed: e })), ...dailies.map((e, i) => ({ token: `d${i + 1}`, ed: e }))];
  let scale = 1, kept = sources, omitted = [];
  const render = () => kept.map(s => digest(s.ed, s.token, tz, scale)).join('\n\n');
  let text = render();
  for (const sc of [0.75, 0.5, 0.35]) { if (text.length <= maxChars) break; scale = sc; text = render(); }
  while (text.length > maxChars && kept.filter(s => s.token[0] === 'd').length > MIN_SOURCES) {
    const dropIdx = kept.findIndex(s => s.token[0] === 'd');
    omitted.push(kept[dropIdx].ed.id); kept = kept.filter((_, i) => i !== dropIdx); text = render();
  }
  const stats = computeStats(dailies, weeklies, window, tz);
  const legend = kept.map(s => ({ token: s.token, id: s.ed.id, edition: s.ed.edition, generatedAt: s.ed.generatedAt, llm: s.ed.llm?.used ? 'model' : 'rules', sha256: s.ed.sha256 || null }));
  const firstDaily = kept.find(s => s.token[0] === 'd');
  const first = firstDaily ? { token: firstDaily.token, text: [firstDaily.ed.bluf, ...arr(firstDaily.ed.activity).map(a => a?.text), firstDaily.ed.changes, ...arr(firstDaily.ed.watch), firstDaily.ed.assessment].filter(Boolean).join(' ').toLowerCase() } : null;
  return { kind, window, text, chars: text.length, sources: legend, omitted, stats, scale, first };
}

export function fmtSpan(h) { if (!h) return '0 h'; if (h < 1) return `${Math.round(h * 60)} min`; if (h < 48) return `${Math.round(h * 10) / 10} h`; return `${Math.round(h / 24 * 10) / 10} days`; }

export function renderStats(st) {
  const L = [
    `${st.editions} source edition(s) in the window (${Object.entries(st.byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}); ${st.model} model-drafted, ${st.rulesOnly} rules-only.`,
    `Source editions span ${fmtSpan(st.spanHours)} of the ${st.windowDays ?? '?'}-day window (first ${st.first || '?'}, last ${st.last || '?'}); anything said about the rest of the period is not covered by an edition.`,
    st.citedPct != null ? `Grounding across editions: ${st.citedPct}% of ${st.sentences} sentences cite a CRUCIX section (${st.uncited} uncited).` : 'Grounding statistics unavailable (rules-only editions).',
    `Outside-source review ran on ${st.external.reviewed} edition(s): ${st.external.missing} missing, ${st.external.contradicts} contradicting, ${st.external.corroborates} corroborating finding(s) — all EXTERNAL — UNVERIFIED.`,
    st.missedCount ? `Missed scheduled slots: ${st.missedCount} (${st.missedSlots.slice(0, 8).join(', ')}${st.missedCount > 8 ? ', …' : ''}).` : 'No scheduled AM / PM slot was missed inside the window.',
  ];
  if (st.themes.length) L.push(`Theme recurrence (editions mentioning the term): ${st.themes.map(t => `${t.term} ${t.editions}/${t.of} [${t.first}→${t.last}]`).join('; ')}.`);
  return L;
}

export function arcSystemPrompt(pack) {
  const span = pack.kind === 'weekly' ? 'week' : 'month';
  return [
    `You write the ${ARC_LABEL[pack.kind]} of the Commander's SITREP for US Southern Command (SOUTHCOM) inside CRUCIX, an open-source intelligence monitor. Your ONLY material is the archived SITREP editions below (window ${pack.window.startKey} → ${pack.window.endKey}). No live feeds, no outside knowledge.`,
    'Audience: the commander and staff — what developed over the period, what did not, where it is heading.',
    'Rules:',
    `- EVERY sentence in EVERY field must end with at least one edition citation in square brackets using the tokens given, e.g. "... blackout persisted through the week [d3][d9]." Only cite tokens that appear below. Sentences without a citation are marked UNCITED in the product.`,
    '- Never invent events, numbers, names or dates. If the editions do not cover something, say "not covered in the period\'s SITREPs".',
    '- Keep provenance: items that an edition marked EXTERNAL / unverified stay unverified here; CRUCIX indices are computed metrics; rules-only editions carry feed text, not analysis.',
    '- Mexico / US-Mexico border material is NORTHCOM context, not SOUTHCOM: mention only as trafficking-flow context, end such sentences with "(NORTHCOM context)".',
    `- The editions span only ${fmtSpan(pack.stats.spanHours)} (see trend lines). Never write "throughout the ${span}", "daily", "consistently", "sustained" or any phrase implying coverage beyond that span; say "across the ${pack.sources.length} editions on file" instead. Sentences that overreach are flagged ${SPAN_FLAG}.`,
    '- "emerged" is only for a theme ABSENT from the earliest edition and present later; a theme already in [d1] is "steady", "escalating" or "de-escalating". Flagged when violated.',
    '- Detection rules / requirements: never characterise their activity ("quiet", "low activations") unless you quote an edition\'s own count for them.',
    '- integrity: do not state that there are no uncited claims — CRUCIX appends its own measured count to that field.',
    '- Trajectories must be defensible from the editions in order: "escalating" only if later editions report more than earlier ones; "resolved" only if an edition says so.',
    `- Length: 600–1000 words. Plain prose; no markdown headings inside fields.`,
    'Respond with ONLY a JSON object:',
    `{"bluf": string (3–5 sentences: the ${span} in brief),`,
    ` "arc": [up to ${MAX_ARC_ITEMS} objects {"theme": short name, "trajectory": one of ${JSON.stringify(TRAJECTORIES)}, "text": 2–4 sentences tracing the storyline through the editions with citations}],`,
    ' "fizzled": string (watch items or storylines flagged early that did not develop, with the editions that flagged them),',
    ` "outlook": string (assessment for the next ${span}; label it as assessment, state confidence low/moderate/high and why),`,
    ' "integrity": string (how much of the period rests on rules-only editions, uncited claims, Telegram / single-source items, EXTERNAL findings; gaps in coverage)}',
    '',
    'CRUCIX-COMPUTED TREND LINES (deterministic, cite as [stats]):',
    ...renderStats(pack.stats).map(l => `- ${l}`),
    '',
    `ARCHIVED EDITIONS (${pack.sources.length}${pack.omitted.length ? `; omitted for size: ${pack.omitted.join(', ')}` : ''}):`,
    pack.text,
  ].join('\n');
}

function citeFilter(text, ok, seen) {
  return String(text || '').replace(/\[([a-z]+\d*)\]/g, (m, id) => { if (ok.has(id)) { seen.add(id); return m; } return ''; }).replace(/\s+([.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export function parseArc(text, pack) {
  const j = parseJSON(text);
  if (!j || typeof j.bluf !== 'string' || !j.bluf.trim()) return null;
  const ok = new Set([...pack.sources.map(s => s.token), 'stats']);
  const seen = new Set();
  let uncited = 0, total = 0;
  const shortSpan = (pack.stats?.spanHours ?? 0) < 24;
  let spanFlagged = 0, trajectoryFlagged = 0;
  const g = (v, n) => {
    const a = annotateSentences(citeFilter(clip(v, n), ok, seen)); uncited += a.uncited; total += a.total;
    if (!shortSpan) return a.text;
    return splitSentences(a.text).map(sen => { if (!PERIOD_RE.test(sen)) return sen; spanFlagged++; return sen.replace(/(\s*(?:\[[A-Z ]+\])?(?:\[[a-z]+\d*\])*)\s*([.!?]+)?$/, (m, cites, p) => ` ${SPAN_FLAG}${(cites || '').trim()}${p || '.'}`); }).join(' ');
  };
  const alreadyInFirst = theme => { if (!pack.first?.text) return false; const w = String(theme || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || []; const keep = w.filter(x => !THEME_STOP.has(x)); return keep.length > 0 && keep.every(x => pack.first.text.includes(x)); };
  const bluf = g(j.bluf, MAX_FIELD.bluf);
  const arc = arr(j.arc).filter(a => a && typeof a.text === 'string' && a.text.trim()).slice(0, MAX_ARC_ITEMS)
    .map(a => {
      const trajectory = TRAJECTORIES.includes(a.trajectory) ? a.trajectory : 'steady';
      let text = g(a.text, MAX_FIELD.arc);
      if (trajectory === 'emerged' && alreadyInFirst(a.theme)) { trajectoryFlagged++; text = `${text} [ALREADY IN ${pack.first.token}]`; }
      return { theme: clip(a.theme || 'Theme', 60), trajectory, text };
    });
  const fizzled = g(j.fizzled, MAX_FIELD.fizzled);
  const outlook = g(j.outlook, MAX_FIELD.outlook);
  const integrity = `${g(j.integrity, MAX_FIELD.integrity)} CRUCIX check: ${total - uncited} of ${total} model sentences cite an edition or the trend lines, ${uncited} marked ${UNCITED}${spanFlagged ? `, ${spanFlagged} marked ${SPAN_FLAG}` : ''}${trajectoryFlagged ? `, ${trajectoryFlagged} "emerged" theme(s) already present in ${pack.first?.token || 'the first edition'}` : ''}; editions span ${fmtSpan(pack.stats?.spanHours)} [stats].`;
  seen.add('stats');
  const citations = [...seen].map(id => id === 'stats' ? { id, editionId: null, label: 'CRUCIX-computed trend lines' } : { id, editionId: pack.sources.find(s => s.token === id)?.id || null, label: `${EDL[pack.sources.find(s => s.token === id)?.edition] || 'edition'} ${pack.sources.find(s => s.token === id)?.id || ''}` });
  return { bluf, arc, fizzled, outlook, integrity, citations, grounding: { sentences: total, uncited, spanFlagged, trajectoryFlagged } };
}

export function rulesOnlyArc(pack, reason = 'no model configured') {
  const st = pack.stats, span = pack.kind === 'weekly' ? 'week' : 'month';
  const first = pack.sources.find(s => s.token[0] === 'd'), last = [...pack.sources].reverse().find(s => s.token[0] === 'd');
  return {
    bluf: `Data arc for the ${span} (${reason}; no model narrative). ${renderStats(st)[0]} [stats]${first && last ? ` Editions run from ${first.id} to ${last.id} [${first.token}][${last.token}].` : ''}`,
    arc: st.themes.slice(0, MAX_ARC_ITEMS).map(t => ({ theme: t.term, trajectory: 'steady', text: `${t.term} appears in ${t.editions} of ${t.of} daily editions, first [${t.first}], last [${t.last}] (recurrence count, not an assessment) [stats].` })),
    fizzled: 'No model is configured, so storylines are not assessed; compare the WATCH lines of the archived editions directly [stats].',
    outlook: 'No model is configured, so no outlook is offered; the trend lines above are CRUCIX-computed counts over the archived editions [stats].',
    integrity: renderStats(st).slice(1).map(l => `${l} [stats]`).join(' '),
    citations: [{ id: 'stats', editionId: null, label: 'CRUCIX-computed trend lines' }, ...(first ? [{ id: first.token, editionId: first.id, label: `${EDL[first.edition]} ${first.id}` }] : []), ...(last && last !== first ? [{ id: last.token, editionId: last.id, label: `${EDL[last.edition]} ${last.id}` }] : [])],
    grounding: null,
  };
}

export function renderArcMarkdown(ed) {
  const tz = ed.timezone || DEFAULT_TIMEZONE;
  const L = [];
  L.push(`# SITREP ${String(ed.edition).toUpperCase()} ARC — SOUTHCOM AOR (OSINT)`);
  L.push(`**${ARC_LABEL[ed.edition] || ed.edition}** · ${fmtLocal(ed.generatedAt, tz)} · window ${ed.window?.startKey} → ${ed.window?.endKey} (${ed.window?.days} days) · ${arr(ed.sources).length} source edition(s) · \`${ed.id}\``);
  L.push('');
  L.push(`> ${BANNER} Written from archived SITREP editions only; [dN] / [wN] cite the edition tokens listed at the end.`);
  L.push('');
  L.push('## 1. BLUF'); L.push(ed.bluf || '—'); L.push('');
  L.push('## 2. Narrative arc by theme');
  for (const a of arr(ed.arc)) L.push(`- **${a.theme}** — *${a.trajectory}*. ${a.text}`);
  if (!arr(ed.arc).length) L.push('- No storylines identified in the period\'s SITREPs.');
  L.push('');
  L.push('## 3. What did not develop'); L.push(ed.fizzled || '—'); L.push('');
  L.push('## 4. Trend lines (CRUCIX-computed) [stats]');
  for (const l of renderStats(ed.stats || { editions: 0, byKind: {}, model: 0, rulesOnly: 0, external: { reviewed: 0, missing: 0, contradicts: 0, corroborates: 0 }, missedCount: 0, missedSlots: [], themes: [] })) L.push(`- ${l}`);
  L.push('');
  L.push(`## 5. Outlook (next ${ed.edition === 'weekly' ? 'week' : 'month'})`); L.push(ed.outlook || '—'); L.push('');
  L.push('## 6. Source integrity & caveats'); L.push(ed.integrity || '—'); L.push('');
  L.push('---');
  L.push('Editions cited:'); for (const s of arr(ed.sources)) L.push(`- [${s.token}] ${EDL[s.edition] || s.edition} ${s.id} · ${fmtLocal(s.generatedAt, tz)} · ${s.llm}${s.sha256 ? ` · sha256 ${String(s.sha256).slice(0, 16)}…` : ''}`);
  if (arr(ed.omitted).length) L.push(`Omitted for size: ${ed.omitted.join(', ')}.`);
  if (ed.grounding?.sentences) L.push(`Grounding: ${ed.grounding.sentences - ed.grounding.uncited}/${ed.grounding.sentences} sentences cite an archived edition or the trend lines${ed.grounding.uncited ? `; ${ed.grounding.uncited} marked ${UNCITED}` : ''}${ed.grounding.spanFlagged ? `; ${ed.grounding.spanFlagged} marked ${SPAN_FLAG}` : ''}${ed.grounding.trajectoryFlagged ? `; ${ed.grounding.trajectoryFlagged} "emerged" theme(s) already in the first edition` : ''}.`);
  L.push(`Generation: ${ed.llm?.used ? `${ed.model || 'model'} · ${ed.usage?.inputTokens ?? '?'} in / ${ed.usage?.outputTokens ?? '?'} out tokens` : `rules-only (${ed.llm?.reason || 'no model'})`} · context ${ed.context?.chars ?? '?'} chars.`);
  return L.join('\n');
}

// Write one arc from the store. Throws only when the archive has too few editions to say anything.
export async function generateArc({ provider, store, kind = 'weekly', now = new Date(), tz = DEFAULT_TIMEZONE, maxContextChars = ARC_CONTEXT_CHARS, slotKey = null, trigger = 'manual' } = {}) {
  if (!ARC_KINDS.includes(kind)) throw new Error(`unknown arc kind ${kind}`);
  const window = arcWindow(kind, now, tz);
  const { dailies, weeklies } = selectSources(store, kind, window);
  if (dailies.length + weeklies.length < MIN_SOURCES) { const e = new Error(`need at least ${MIN_SOURCES} archived editions in the last ${window.days} days (have ${dailies.length + weeklies.length})`); e.code = 'TOO_FEW'; throw e; }
  const pack = buildArcPack({ dailies, weeklies, kind, window, tz, maxChars: maxContextChars });
  const base = {
    version: ARC_VERSION, id: arcId(now, kind, tz, !!slotKey), edition: kind, slotKey, dateKey: localDateKey(now, tz), timezone: tz, trigger,
    generatedAt: now.toISOString(), window, sources: pack.sources, omitted: pack.omitted, stats: pack.stats, trend: renderStats(pack.stats),
    context: { chars: pack.chars, scale: pack.scale, editions: pack.sources.length }, banner: BANNER,
  };
  let body, llm, model = null, usage = null;
  if (!provider?.isConfigured) { body = rulesOnlyArc(pack); llm = { used: false, reason: 'no model configured' }; }
  else {
    try {
      const res = await provider.complete(arcSystemPrompt(pack), `Write the ${ARC_LABEL[kind]} now.`, { maxTokens: ARC_MAX_TOKENS, timeout: 120000 });
      model = res?.model || null; usage = res?.usage || null;
      const parsed = parseArc(res?.text, pack);
      if (parsed) { body = parsed; llm = { used: true, reason: null }; }
      else { body = rulesOnlyArc(pack, 'model returned an unparseable arc'); llm = { used: false, reason: 'unparseable model response' }; }
    } catch (e) { body = rulesOnlyArc(pack, 'provider error'); llm = { used: false, reason: `provider error: ${clip(e.message, 160)}` }; }
  }
  const ed = { ...base, ...body, llm, model, usage };
  ed.words = words([ed.bluf, ...arr(ed.arc).map(a => a.text), ed.fizzled, ed.outlook, ed.integrity].join(' '));
  ed.markdown = renderArcMarkdown(ed);
  ed.sha256 = sha256(ed.markdown);
  return ed;
}
