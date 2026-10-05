// lib/sitrep/review — outside-source review pass: prompt, parse (only provider-cited URLs survive),
// provider gating, failure modes, and how the block rides on an edition. Fake providers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSitrep, reviewSystemPrompt, parseReview, normalizeSources, draftSummary, EXTERNAL_LABEL, MAX_FINDINGS, REVIEW_MAX_TOKENS } from '../lib/sitrep/review.mjs';
import { generateSitrep, renderMarkdown } from '../lib/sitrep/index.mjs';

const ED = {
  id: 'sitrep-20261005-am', edition: 'am', generatedAt: '2026-10-05T10:05:00Z', asOf: '2026-10-05T10:02:00Z',
  bluf: 'Caracas blackout continues [venezuela][outages]. Fabricated [UNCITED].', activity: [{ domain: 'Maritime & air', text: '212 aircraft in the box [caribbeanair].' }],
  changes: 'Baseline [delta].', watch: ['Power restoration [outages]'], assessment: 'Moderate confidence [aor].', integrity: 'Thin [sources].',
  llm: { used: true, reason: null }, model: 'fake-1', usage: { inputTokens: 1000, outputTokens: 400 }, citations: [], context: { chars: 100, sections: ['aor'], omitted: [] }, words: 40, banner: 'B',
};
const SOURCES = [{ title: 'Reuters', url: 'https://www.reuters.com/world/americas/x?utm_source=a' }, { title: '', url: 'https://insightcrime.org/news/y' }, { url: 'http://insecure.example/z' }, { url: 'https://www.reuters.com/world/americas/x?utm_source=a' }];
const REVIEW = JSON.stringify({
  findings: [
    { kind: 'missing', text: 'Ecuador declared a state of emergency in Guayas after prison riots.', url: 'https://www.reuters.com/world/americas/x?utm_source=a', published: '2026-10-05' },
    { kind: 'contradicts', text: 'Power was restored to most of Caracas overnight.', url: 'https://insightcrime.org/news/other-article' },
    { kind: 'bogus', text: 'Made-up item with a typed URL.', url: 'https://example.org/made-up' },
    { kind: 'corroborates', text: 'No URL at all.' },
  ],
  note: 'Searched Reuters, AP, InSight Crime for the last 24 h; the draft holds up apart from Ecuador.',
});
const webProvider = (text, { sources = SOURCES, fail = false, searched = true } = {}) => ({
  isConfigured: true, name: 'fake', supportsWebSearch: true, calls: [],
  async complete() { throw new Error('should not be called'); },
  async completeWithWebSearch(system, user, opts) { this.calls.push({ system, user, opts }); if (fail) throw new Error('web search 429'); return { text, sources, searched, model: 'fake-search', usage: { inputTokens: 700, outputTokens: 250 } }; },
});

test('parseReview: host match ignores www. / m. / amp. prefixes; dropped hosts are reported for diagnosis', () => {
  const srcs = [{ title: 'UPI', url: 'https://www.upi.com/Top_News/2026/10/05/x/' }];
  const r = parseReview(JSON.stringify({ findings: [
    { kind: 'missing', text: 'Same publisher, no www.', url: 'https://upi.com/Top_News/2026/10/05/other/' },
    { kind: 'missing', text: 'Mobile host.', url: 'https://m.upi.com/story' },
    { kind: 'missing', text: 'Typed from memory.', url: 'https://www.reuters.com/world/americas/x' },
  ], note: 'n' }), srcs);
  assert.equal(r.findings.length, 2); assert.equal(r.dropped, 1); assert.deepEqual(r.droppedHosts, ['reuters.com']);
});

test('reviewSitrep: pages the search read (visited) count as provider-cited; JSON answers carry no annotations', async () => {
  // Real behaviour observed: JSON output → zero url_citation annotations, so trust must come from web_search_call.action.sources.
  const p = webProvider(REVIEW, { sources: [] });
  p.completeWithWebSearch = async () => ({ text: REVIEW, sources: [], visited: SOURCES, searched: true, model: 'fake-search', usage: { inputTokens: 1, outputTokens: 1 } });
  const ok = await reviewSitrep({ provider: p, edition: ED });
  assert.equal(ok.status, 'ok'); assert.equal(ok.findings.length, 2); assert.equal(ok.dropped, 2); assert.equal(ok.sources.length, 2);
  // Nothing trusted at all → every finding dropped and the note says so instead of echoing the model's "holds up well".
  const none = await reviewSitrep({ provider: webProvider(REVIEW, { sources: [] }), edition: ED });
  assert.equal(none.status, 'ok'); assert.equal(none.findings.length, 0); assert.equal(none.dropped, 4);
  assert.equal(none.note, 'No finding kept: the model offered 4 but none pointed at a page the search actually read (0 read).');
});

test('draftSummary / reviewSystemPrompt: the grounded draft without citation tokens, rules and schema', () => {
  const d = draftSummary(ED);
  assert.doesNotMatch(d, /\[venezuela\]|\[UNCITED\]/); assert.match(d, /^BLUF: Caracas blackout continues\. Fabricated\./m); assert.match(d, /ACTIVITY: Maritime & air: 212 aircraft/);
  const p = reviewSystemPrompt(ED);
  assert.match(p, /last 24 hours/); assert.match(p, /No URL → do not report it/); assert.match(p, /"kind": "missing" \| "contradicts" \| "corroborates"/); assert.match(p, /DRAFT \(generated 2026-10-05T10:05:00Z/);
});

test('normalizeSources: https only, de-duplicated, capped', () => {
  const s = normalizeSources(SOURCES);
  assert.deepEqual(s.map(x => x.url), ['https://www.reuters.com/world/americas/x?utm_source=a', 'https://insightcrime.org/news/y']);
  assert.equal(s[0].title, 'Reuters');
  assert.equal(normalizeSources(Array.from({ length: 30 }, (_, i) => ({ url: `https://h${i}.example/` }))).length, 12);
  assert.deepEqual(normalizeSources(null), []);
});

test('parseReview: keeps findings whose URL (or host) the provider cited, drops typed URLs and URL-less items', () => {
  const r = parseReview(REVIEW, normalizeSources(SOURCES));
  assert.equal(r.findings.length, 2); assert.equal(r.dropped, 2);
  assert.deepEqual(r.findings[0], { kind: 'missing', text: 'Ecuador declared a state of emergency in Guayas after prison riots.', url: 'https://www.reuters.com/world/americas/x?utm_source=a', published: '2026-10-05' });
  assert.equal(r.findings[1].kind, 'contradicts'); assert.equal(r.findings[1].url, 'https://insightcrime.org/news/other-article', 'same host as a cited source is accepted');
  assert.match(r.note, /^Searched Reuters/);
  assert.equal(parseReview('nope', []), null); assert.equal(parseReview('{"note":"x"}', []), null);
  const many = JSON.stringify({ findings: Array.from({ length: 20 }, (_, i) => ({ text: `f${i}`, url: 'https://insightcrime.org/a' })) });
  assert.equal(parseReview(many, normalizeSources(SOURCES)).findings.length, MAX_FINDINGS);
  assert.equal(parseReview(many, normalizeSources(SOURCES)).findings[0].kind, 'missing', 'kind defaults to missing');
});

test('reviewSitrep: gating and failure modes never throw; success carries sources, model, usage', async () => {
  const none = await reviewSitrep({ provider: null, edition: ED });
  assert.equal(none.status, 'unavailable'); assert.equal(none.label, EXTERNAL_LABEL); assert.deepEqual(none.findings, []); assert.match(none.note, /no model configured/);
  const noweb = await reviewSitrep({ provider: { isConfigured: true, name: 'ollama', supportsWebSearch: false }, edition: ED });
  assert.equal(noweb.status, 'unavailable'); assert.match(noweb.error, /ollama has no web search/);
  const failed = await reviewSitrep({ provider: webProvider('', { fail: true }), edition: ED });
  assert.equal(failed.status, 'error'); assert.match(failed.error, /web search 429/); assert.deepEqual(failed.findings, []);
  const junk = await reviewSitrep({ provider: webProvider('not json'), edition: ED });
  assert.equal(junk.status, 'error'); assert.equal(junk.error, 'unparseable review response'); assert.equal(junk.sources.length, 2); assert.equal(junk.model, 'fake-search');
  const prov = webProvider(REVIEW);
  const ok = await reviewSitrep({ provider: prov, edition: ED });
  assert.equal(ok.status, 'ok'); assert.equal(ok.findings.length, 2); assert.equal(ok.dropped, 2); assert.equal(ok.sources.length, 2);
  assert.equal(ok.model, 'fake-search'); assert.deepEqual(ok.usage, { inputTokens: 700, outputTokens: 250 }); assert.equal(ok.searched, true); assert.match(ok.reviewedAt, /Z$/);
  assert.equal(prov.calls.length, 1); assert.equal(prov.calls[0].opts.maxTokens, REVIEW_MAX_TOKENS); assert.match(prov.calls[0].system, /outside-source reviewer/);
  const empty = await reviewSitrep({ provider: webProvider(JSON.stringify({ findings: [], note: '' })), edition: ED });
  assert.equal(empty.status, 'ok'); assert.match(empty.note, /No material developments found/);
});

test('generateSitrep with review: block attached apart from sections 1–6, skipped on rules-only, rendered as section 7', async () => {
  const STATE = { lastSweepTime: '2026-10-05T10:00:00Z', data: { situation: { asOf: '2026-10-05T10:02:00Z', headlines: [{ severity: 'high', title: 'Caracas blackout', why: 'IODA', source: 'IODA', tab: 'cyber' }] }, country: { ve: { status: 'live', name: 'Venezuela', news: { articles: [{ title: 'Caracas blackout enters second day', published: '2026-10-05T01:00:00Z', feed: 'Efecto Cocuyo' }] } } } } };
  const DRAFT = JSON.stringify({ bluf: 'Caracas blackout continues [venezuela].', activity: [], changes: 'Baseline [situation].', watch: [], assessment: 'Low confidence [venezuela].', integrity: 'Single source [venezuela].' });
  const prov = { ...webProvider(REVIEW), async complete() { return { text: DRAFT, model: 'fake-1', usage: { inputTokens: 500, outputTokens: 100 } }; } };
  const ed = await generateSitrep({ provider: prov, state: STATE, edition: 'am', now: new Date('2026-10-05T10:05:00Z'), review: true });
  assert.equal(ed.llm.used, true); assert.equal(ed.external.status, 'ok'); assert.equal(ed.external.findings.length, 2); assert.equal(ed.external.label, EXTERNAL_LABEL);
  assert.deepEqual(ed.usage, { inputTokens: 500, outputTokens: 100 }, 'draft usage stays separate from review usage');
  assert.deepEqual(ed.external.usage, { inputTokens: 700, outputTokens: 250 });
  assert.equal(ed.bluf, 'Caracas blackout continues [venezuela].', 'grounded sections untouched by the review');
  assert.doesNotMatch(ed.integrity, /Ecuador/);
  assert.match(ed.markdown, /## 7\. Outside-source review — EXTERNAL — UNVERIFIED\n> Found by the model's web search, not by CRUCIX feeds/);
  assert.match(ed.markdown, /- \*\*MISSING\*\* · 2026-10-05 — Ecuador declared a state of emergency.*<https:\/\/www\.reuters\.com/);
  assert.match(ed.markdown, /- \*\*CONTRADICTS\*\* — Power was restored/);
  assert.match(ed.markdown, /Search sources: <https:\/\/www\.reuters\.com[^>]*> · <https:\/\/insightcrime\.org\/news\/y>/);
  assert.match(ed.markdown, /Outside-source review: fake-search web search · 700 in \/ 250 out tokens · 2 finding\(s\), 2 source\(s\), 2 dropped for lacking a cited URL\./);
  const { sha256 } = await import('../lib/sitrep/store.mjs');
  assert.equal(ed.sha256, sha256(ed.markdown), 'hash covers section 7');

  const rules = await generateSitrep({ provider: null, state: STATE, edition: 'am', now: new Date('2026-10-05T10:05:00Z'), review: true });
  assert.equal(rules.external.status, 'skipped'); assert.match(rules.markdown, /Status: skipped \(draft is rules-only\)/); assert.match(rules.markdown, /- Outside-source review skipped/);
  const off = await generateSitrep({ provider: prov, state: STATE, edition: 'am', now: new Date('2026-10-05T10:05:00Z') });
  assert.equal(off.external, null); assert.doesNotMatch(off.markdown, /## 7\./);
  const md = renderMarkdown({ ...ed, external: { ...ed.external, status: 'error', error: 'web search 429', findings: [], sources: [], note: 'Outside-source review failed; no external findings recorded.', usage: null } });
  assert.match(md, /Status: error \(web search 429\)\.\n- Outside-source review failed/);
});
