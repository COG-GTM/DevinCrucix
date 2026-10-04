// lib/ask — context packing, request validation, grounded parsing and the two provider paths,
// driven with fake providers so nothing leaves the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextPack, renderContextPack, validateAskRequest, parseGroundedAnswer, normalizeSources,
  askGrounded, askExternal, rulesOnlyAnswer, MAX_QUESTION_CHARS, EXTERNAL_LABEL, SECTION_TABS,
} from '../lib/ask/index.mjs';
import { questionTokens, SECTION_IDS } from '../lib/ask/context.mjs';

const STATE = {
  lastSweepTime: '2026-10-03T21:00:00.000Z',
  data: {
    situation: { asOf: '2026-10-03T21:02:50.848Z', rulesFired: 2, counts: { critical: 1, high: 1 }, headlines: [{ severity: 'critical', title: 'Radiation anomaly: Chernobyl 124 CPM', why: 'above baseline', source: 'Safecast', tab: 'military' }], prc: { score: 40, level: 'LOW', straitCn: 3, scsTotal: 10 } },
    defcon: { level: 3, label: 'ROUND THE CLOCK READINESS', score: 50, components: { gdelt: { score: 100, weight: 0.3, detail: '60 conflict events' } } },
    delta: { summary: { totalChanges: 1, criticalChanges: 0, direction: 'mixed', signalBreakdown: { new: 1 } }, signals: { new: [{ text: 'New urgent post', reason: 'Telegram' }] } },
    cyberKev: { totalVulnerabilities: 1, vulnerabilities: [{ cveID: 'CVE-2026-1', vendor: 'Acme', product: 'Widget', severity: 'high', dateAdded: '2026-10-02', ransomware: true, description: 'RCE' }] },
    meta: { health: { live: 40, degraded: 2, no_key: 3, off: 1, error: 0 }, sources: [{ name: 'OpenSky', status: 'degraded', error: 'timeout' }] },
  },
  narco: { windowDays: 30, totals: { current: 2, byGrade: { C: 2 }, byType: { massacre: 1, arrest: 1 }, byState: { Sinaloa: 2 }, byCartel: { cjng: 1, sinaloa: 1 }, sanctionsMatches: 1 },
    events: [{ date: '2026-10-03', type: 'massacre', typeLabel: 'Massacre', location: { municipality: 'Culiacán', state: 'Sinaloa' }, cartels: [{ id: 'cjng', short: 'CJNG' }], grade: 'C', headline: 'Six killed in Culiacán' }] },
  graph: { computedAt: '2026-10-03T00:00:00Z', totals: { nodes: 2, edges: 1, byNodeType: { person: 1 } },
    nodes: [{ id: 'person:mencho', type: 'person', label: 'Nemesio Oseguera Cervantes', articles: 119, degree: 22, meta: { aliases: ['El Mencho'] } }, { id: 'org:cjng', type: 'org', label: 'CJNG', articles: 500, degree: 90 }],
    edges: [{ source: 'person:mencho', target: 'org:cjng', type: 'leader_of' }] },
  requirements: { rules: [{ id: 'r1', name: 'Sinaloa violence', text: 'Alert on violence spikes in Sinaloa', severity: 'high', latest: { fired: true, value: 5, baseline: 1 } }], firedCount: 1 },
  targets: [{ label: 'Nemesio Oseguera Cervantes', type: 'person', status: 'developed', priority: 1, requirement: 'whereabouts', stats: { links: 10, pendingLinks: 4, accepted: 5, rejected: 1, proposals: 3, lastKnown: { place: 'Jalisco', date: '2026-08-20' } } }],
};

test('questionTokens drops stop words and punctuation', () => {
  assert.deepEqual(questionTokens('What is the DEFCON level, and why?'), ['defcon', 'level']);
});

test('buildContextPack keeps the always-on sections, ranks by relevance and stays under budget', () => {
  const pack = buildContextPack(STATE, 'Who is El Mencho connected to?');
  const ids = pack.sections.map(s => s.id);
  assert.ok(ids.includes('situation') && ids.includes('defcon'), 'always-on sections present');
  assert.equal(pack.sections.find(s => s.id === 'cjng').score > 0, true);
  const cjng = pack.sections.find(s => s.id === 'cjng');
  assert.match(cjng.text, /Nemesio Oseguera Cervantes \[person\].*leader_of → CJNG/, 'alias hit expands the node with its edges');
  assert.ok(pack.sections.every(s => SECTION_IDS.includes(s.id) && s.tab === SECTION_TABS[s.id]));
  assert.ok(!ids.includes('macro') && !ids.includes('ukraine'), 'empty areas are skipped');
  assert.equal(pack.asOf, STATE.data.situation.asOf);

  const tight = buildContextPack(STATE, 'cartel massacre in Sinaloa', { maxChars: 1200 });
  assert.ok(tight.chars <= 1200 + 2000, 'always sections may exceed, nothing else may');
  assert.ok(tight.omitted.length > 0);
  assert.ok(tight.sections.slice(2).every(s => tight.sections.slice(2).indexOf(s) === 0 || s.score <= tight.sections[2].score), 'ranked descending after the always-on pair');
  assert.match(renderContextPack(tight), /^### \[situation\]/);
});

test('buildContextPack tolerates missing or malformed state', () => {
  const pack = buildContextPack({ data: null, narco: null, graph: null, requirements: null, targets: null }, 'anything');
  assert.deepEqual(pack.sections, []);
  assert.equal(pack.asOf, null);
  const half = buildContextPack({ data: { defcon: { level: 2, components: 'nope' } }, narco: { totals: { current: 0 } } }, 'defcon');
  assert.ok(half.sections.some(s => s.id === 'defcon'));
});

test('validateAskRequest enforces question, mode and history shape', () => {
  assert.equal(validateAskRequest({ question: 'hi' }).field, 'question');
  assert.equal(validateAskRequest({ question: 'x'.repeat(MAX_QUESTION_CHARS + 1) }).field, 'question');
  assert.equal(validateAskRequest({ question: 'what changed', mode: 'yolo' }).field, 'mode');
  assert.equal(validateAskRequest({ question: 'what changed', history: 'no' }).field, 'history');
  assert.equal(validateAskRequest({ question: 'what changed', history: [{ role: 'system', content: 'x' }] }).field, 'history');
  const ok = validateAskRequest({ question: '  what   changed ', history: Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i + 'y'.repeat(600) })) });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.question, 'what changed');
  assert.equal(ok.value.mode, 'grounded');
  assert.equal(ok.value.history.length, 6);
  assert.ok(ok.value.history.every(h => h.content.length <= 500));
});

test('parseGroundedAnswer validates citations against the pack and tolerates non-JSON', () => {
  const pack = buildContextPack(STATE, 'defcon');
  const good = parseGroundedAnswer('```json\n{"answer":"DEFCON is 3 [defcon], driven by GDELT [defcon][bogus].","citations":["defcon","situation","nope"],"sufficiency":"sufficient","followups":["Why?","How?","When?","Extra"]}\n```', pack);
  assert.equal(good.sufficiency, 'sufficient');
  assert.deepEqual(good.citations.map(c => c.id), ['defcon', 'situation']);
  assert.equal(good.citations[0].tab, 'situation');
  assert.equal(good.followups.length, 3);
  const raw = parseGroundedAnswer('Plain text answer citing [narco] and [defcon].', pack);
  assert.equal(raw.sufficiency, 'partial');
  assert.deepEqual(raw.citations.map(c => c.id), ['narco', 'defcon']);
  assert.equal(parseGroundedAnswer('', pack), null);
  const hedged = parseGroundedAnswer('{"answer":"Not available in CRUCIX data.","citations":[],"sufficiency":"sufficient"}', pack);
  assert.equal(hedged.sufficiency, 'partial');
  const none = parseGroundedAnswer('{"answer":"CRUCIX has nothing on this.","citations":["situation","news"],"sufficiency":"insufficient"}', pack);
  assert.deepEqual(none.citations, [], 'insufficient answers drop citations the text does not use');
  const noneInline = parseGroundedAnswer('{"answer":"Only the cartel feed [narco] mentions Mexico, nothing on the presidency.","citations":["situation","narco"],"sufficiency":"insufficient"}', pack);
  assert.deepEqual(noneInline.citations.map(c => c.id), ['narco']);
});

test('normalizeSources keeps http(s) only, dedupes and caps', () => {
  const src = normalizeSources([{ title: 'A', url: 'https://www.example.com/a?x=1' }, { url: 'https://example.com/a?x=2' }, { url: 'javascript:alert(1)' }, { url: 'ftp://x' }, ...Array.from({ length: 12 }, (_, i) => ({ url: `https://s${i}.test/p` }))]);
  assert.equal(src.length, 8);
  assert.equal(src[0].host, 'example.com');
  assert.equal(normalizeSources([{ url: 'https://x.org/p?utm_source=openai&id=2' }])[0].url, 'https://x.org/p?id=2', 'tracking params stripped');
  assert.equal(src.filter(s => s.url.includes('example.com/a')).length, 2, 'query-string variants are distinct URLs');
});

test('askGrounded falls back to rules-only without a provider or on provider failure', async () => {
  const none = await askGrounded({ provider: null, state: STATE, question: 'cartel massacre Sinaloa' });
  assert.equal(none.mode, 'grounded');
  assert.equal(none.llm.used, false);
  assert.match(none.answer, /No model is configured/);
  assert.ok(none.citations.some(c => c.id === 'narco'));
  assert.equal(none.suggestExternal, false);
  const boom = await askGrounded({ provider: { isConfigured: true, supportsWebSearch: true, complete: async () => { throw new Error('OpenAI API 500'); } }, state: STATE, question: 'defcon' });
  assert.equal(boom.llm.used, false);
  assert.match(boom.llm.reason, /provider error: OpenAI API 500/);
  assert.equal(rulesOnlyAnswer(buildContextPack({}, 'x')).sufficiency, 'insufficient');
});

test('askGrounded returns a validated answer and suggests external only when insufficient and supported', async () => {
  let seen;
  const provider = (reply, ws = true) => ({ isConfigured: true, supportsWebSearch: ws, complete: async (sys, user, opts) => { seen = { sys, user, opts }; return { text: reply, model: 'fake-1', usage: { inputTokens: 10, outputTokens: 5 } }; } });
  const full = await askGrounded({ provider: provider('{"answer":"DEFCON 3 [defcon].","citations":["defcon"],"sufficiency":"sufficient","followups":[]}'), state: STATE, question: 'what is defcon?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
  assert.equal(full.llm.used, true);
  assert.equal(full.suggestExternal, false);
  assert.equal(full.model, 'fake-1');
  assert.deepEqual(full.citations.map(c => c.id), ['defcon']);
  assert.ok(full.context.sections.every(s => typeof s.chars === 'number' && !('text' in s)), 'context echo is metadata only');
  assert.match(seen.sys, /CRUCIX CONTEXT/);
  assert.match(seen.sys, /\[defcon\] DEFCON composite/);
  assert.match(seen.user, /Prior turns[\s\S]*Analyst: hi[\s\S]*Analyst question: what is defcon\?/);
  assert.ok(seen.opts.maxTokens <= 1000);
  const weak = await askGrounded({ provider: provider('{"answer":"Not in CRUCIX.","citations":[],"sufficiency":"insufficient"}'), state: STATE, question: 'price of eggs in Lima' });
  assert.equal(weak.suggestExternal, true);
  const noWs = await askGrounded({ provider: provider('{"answer":"Not in CRUCIX.","citations":[],"sufficiency":"insufficient"}', false), state: STATE, question: 'price of eggs in Lima' });
  assert.equal(noWs.suggestExternal, false);
});

test('askExternal labels output, normalizes sources and refuses providers without web search', async () => {
  const noWs = await askExternal({ provider: { isConfigured: true, supportsWebSearch: false, name: 'anthropic' }, state: STATE, question: 'q' });
  assert.equal(noWs.ok, false);
  assert.match(noWs.error, /no web search/);
  let seen;
  const provider = { isConfigured: true, supportsWebSearch: true, name: 'openai', completeWithWebSearch: async (sys, user, opts) => { seen = { sys, user, opts }; return { text: 'Reuters reports X.', sources: [{ title: 'Reuters', url: 'https://www.reuters.com/x' }, { url: 'not a url' }], searched: true, model: 'fake-ws', usage: { inputTokens: 1, outputTokens: 2 } }; } };
  const out = await askExternal({ provider, state: STATE, question: 'what happened in Lima today?' });
  assert.equal(out.ok, true);
  assert.equal(out.label, EXTERNAL_LABEL);
  assert.deepEqual(out.sources, [{ title: 'Reuters', url: 'https://www.reuters.com/x', host: 'reuters.com' }]);
  assert.match(seen.sys, /EXTERNAL SEARCH mode/);
  assert.match(seen.sys, /not verified by you/);
  assert.ok(!/CRUCIX CONTEXT/.test(seen.sys), 'external prompt does not carry the full grounded pack');
});
