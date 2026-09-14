// lib/targeting — nomination validation, mention gathering against fixtures, selector evidence,
// deterministic + model-assisted adjudication with strict output validation, text geolocation,
// pattern-of-activity, graph-proposal lifecycle and the dossier. No network, no real provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TargetStore, validateNomination, summarizeTarget, TARGET_TYPES, BASIS_KINDS, DECISIONS, MAX_ALIASES, TARGET_ID_RE } from '../lib/targeting/store.mjs';
import { gatherMentions, extractSelectors, matchingSentences, maskNames, nameVariantOf, day } from '../lib/targeting/find.mjs';
import { rulesAssess, validateAssessment, parseAssessments, adjudicate, buildPrompt, ROLES, MAX_RATIONALE_CHARS } from '../lib/targeting/adjudicate.mjs';
import { observe, textGeolocate, lastKnownLocation, footprint, applyFixPicks, refineWithModel, LOCATION_SOURCES, radiusFor } from '../lib/targeting/fix.mjs';
import { buildTimeline, aggregate, deviations, patternOfActivity, gaps } from '../lib/targeting/pattern.mjs';
import { developTarget, graphProposalsFrom, compactPackage, EVIDENCE_TIERS, CLAIM_STATES } from '../lib/targeting/index.mjs';
import { renderDossier } from '../lib/targeting/dossier.mjs';
import { buildSourceContext } from '../lib/targeting/sources.mjs';

const NOMINATION = {
  label: 'Nemesio Oseguera Cervantes', type: 'person', aliases: ['El Mencho', 'el mencho', 'Nemesio Oseguera Cervantes'],
  basis: { kind: 'kg-node', ref: 'person:nemesio-oseguera-cervantes' },
  requirement: 'Leadership succession and last known location of CJNG leadership.', priority: 1,
};

const TARGET = { id: 'tgt_000000000001', ...NOMINATION, aliases: ['El Mencho'], status: 'nominated', nominatedBy: 'operator', createdAt: '2026-09-01T00:00:00.000Z', decisions: {}, graphProposals: [] };

// Minimal graph + stores in the shapes lib/targeting/sources.mjs hands to gatherMentions().
const GRAPH = {
  nodes: [
    { id: 'person:nemesio-oseguera-cervantes', type: 'person', label: 'Nemesio Oseguera Cervantes', meta: { aliases: ['El Mencho', 'Nemesio Oseguera Ramos'], events: [{ kind: 'killed', d: '2026-04-28', a: 3, s: '2026: Mexican security forces located Nemesio Oseguera, alias "El Mencho," the leader of the CJNG, in Tapalpa, Jalisco, and killed him.' }] } },
    { id: 'org:cjng', type: 'org', label: 'CJNG', meta: {} },
    { id: 'person:rosalinda-gonzalez-valencia', type: 'person', label: 'Rosalinda González Valencia', meta: {} },
  ],
  edges: [
    { id: 'e1', type: 'leader_of', source: 'person:nemesio-oseguera-cervantes', target: 'org:cjng', evidence: [{ a: 1, d: '2024-02-10', s: 'Nemesio Oseguera Cervantes, alias "El Mencho," leads the CJNG from the mountains of Jalisco.' }] },
    { id: 'e2', type: 'family_of', source: 'person:nemesio-oseguera-cervantes', target: 'person:rosalinda-gonzalez-valencia', evidence: [{ a: 2, d: '2021-11-16', s: 'Rosalinda González Valencia, wife of El Mencho, was arrested in Zapopan, Jalisco.' }] },
  ],
  articles: [
    { id: 1, title: 'CJNG leadership', link: 'https://insightcrime.org/a/1', date: '2024-02-10' },
    { id: 2, title: 'Wife arrested', link: 'https://insightcrime.org/a/2', date: '2021-11-16' },
    { id: 3, title: 'Is Mexico running out of kingpins?', link: 'https://insightcrime.org/a/3', date: '2026-04-28' },
  ],
};
const ARTICLES = [
  { id: 'bn1', title: 'From El Mencho to El Mayo', outlet: 'Borderland Beat', url: 'https://www.borderlandbeat.com/2026/09/x.html', publishedAt: '2026-09-12T10:00:00Z', text: 'A property in Villa Purificación is identified as one of the hideouts of Rubén Oseguera Cervantes, alias "El Mencho." Call 555-0100 for tips.' },
  { id: 'bn2', title: 'Unrelated', outlet: 'X', url: 'https://example.com/y', publishedAt: '2026-09-10T10:00:00Z', text: 'Nothing about the target here.' },
];
const DOJ = [
  { id: 'doj1', number: '24-118', title: 'CJNG leader charged', url: 'https://www.justice.gov/opa/pr/x', publishedAt: '2026-08-01T00:00:00Z', district: { name: 'District of Columbia' }, teaser: '', body: 'Nemesio Oseguera Cervantes, also known as "El Mencho," was charged in case 1:14-cr-00092. Contact the press office, phone: (202) 555-0100, e-mail: press@usdoj.gov.' },
];
const TELEGRAM = [{ id: 'tg1', channel: 'osint', url: 'https://t.me/osint/1', timestamp: '2026-09-13T01:00:00Z', text: 'El Mencho reportedly seen in Guadalajara, Jalisco', hasMedia: false }];
const CTX = { graph: GRAPH, corpus: null, articles: ARTICLES, dojReleases: DOJ, ofacIndex: null, telegram: TELEGRAM, narcoClusters: [] };

const fakeProvider = (text, { name = 'fake', model = 'fake-1', fail = false } = {}) => ({
  name, isConfigured: true,
  calls: [],
  async complete(system, user, opts) { this.calls.push({ system, user, opts }); if (fail) throw new Error('boom ' + 'secret-key-value'); return { text, model }; },
});

test('targeting', async (t) => {
  await t.test('validateNomination: allowlists, bounds, alias dedupe, basis formats', () => {
    const ok = validateNomination(NOMINATION);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.aliases, ['El Mencho']); // duplicates and label echo removed
    assert.equal(ok.value.priority, 1);
    assert.equal(validateNomination(null).field, 'body');
    assert.equal(validateNomination({ ...NOMINATION, label: '<b>x</b>' }).field, 'label');
    assert.equal(validateNomination({ ...NOMINATION, type: 'human' }).field, 'type');
    assert.equal(validateNomination({ ...NOMINATION, aliases: Array.from({ length: MAX_ALIASES + 1 }, (_, i) => `a${i}`) }).field, 'aliases');
    assert.equal(validateNomination({ ...NOMINATION, aliases: 'El Mencho' }).field, 'aliases');
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'twitter', ref: 'x' } }).field, 'basis');
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'kg-node', ref: 'bad node!' } }).field, 'basis.ref');
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'source-url', ref: 'http://insecure.example/x' } }).field, 'basis.ref');
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'source-url', ref: 'https://localhost/x' } }).field, 'basis.ref');
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'source-url', ref: 'https://www.justice.gov/opa/pr/x' } }).ok, true);
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'ofac-uid', ref: '17674' } }).ok, true);
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'doj-release', ref: '0123456789abcdef' } }).ok, true);
    assert.equal(validateNomination({ ...NOMINATION, basis: { kind: 'doj-release', ref: '24-118' } }).field, 'basis.ref');
    assert.equal(validateNomination({ ...NOMINATION, requirement: 'short' }).field, 'requirement');
    assert.equal(validateNomination({ ...NOMINATION, requirement: 'x'.repeat(401) }).field, 'requirement');
    assert.equal(validateNomination({ ...NOMINATION, requirement: 'find <script> them all' }).field, 'requirement');
    assert.equal(validateNomination({ ...NOMINATION, priority: 4 }).field, 'priority');
    assert.equal(validateNomination({ ...NOMINATION, priority: undefined }).value.priority, 2);
    assert.deepEqual(TARGET_TYPES, ['person', 'org', 'facility', 'vehicle', 'vessel', 'aircraft']);
    assert.deepEqual(BASIS_KINDS, ['kg-node', 'ofac-uid', 'doj-release', 'source-url']);
    assert.deepEqual(DECISIONS, ['accept', 'reject', 'reset']);
  });

  await t.test('TargetStore: nominate → package → decisions persist → close → remove, with JSON audit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
    const lines = [];
    let clock = Date.parse('2026-09-14T12:00:00Z');
    const store = new TargetStore({ dataDir: dir, now: () => clock, log: l => lines.push(l) });
    const { target } = store.nominate(validateNomination(NOMINATION).value);
    assert.match(target.id, TARGET_ID_RE);
    assert.equal(target.status, 'nominated');
    assert.equal(store.nominate(validateNomination(NOMINATION).value).error, 'duplicate');
    assert.ok(lines.some(l => l.includes('"action":"target.nominate"')));
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].component, 'targeting');
    assert.equal(audit[0].action, 'target.nominate');

    const pkg = {
      links: [{ id: 'lnk_aaaaaaaaaaaa', label: 'CJNG', kind: 'entity', assessment: { role: 'associate' }, decision: null }],
      graphProposals: [{ id: 'gp_aaaaaaaaaaaa', kind: 'edge', rel: 'leader_of', source: 'person:x', target: 'org:cjng', linkId: 'lnk_aaaaaaaaaaaa', evidence: [{ sentence: 's', url: 'https://x/y' }], confidence: 0.9, by: 'rules' }],
    };
    const proposal0 = { ...pkg.graphProposals[0] };
    const dev = store.setPackage(target.id, pkg);
    assert.equal(dev.status, 'developed');
    assert.equal(pkg.graphProposals, undefined, 'proposals live on the target, not inside the package');
    assert.equal(dev.graphProposals[0].status, 'proposed');
    assert.equal(dev.graphProposals[0].decidedAt, null);

    clock += 1000;
    const dl = store.decideLink(target.id, 'lnk_aaaaaaaaaaaa', 'accept');
    assert.equal(dl.link.decision, 'accept');
    assert.equal(store.decideLink(target.id, 'lnk_nope', 'accept'), null);
    assert.equal(store.decideLink('tgt_nope', 'lnk_aaaaaaaaaaaa', 'accept'), null);
    const dp = store.decideProposal(target.id, 'gp_aaaaaaaaaaaa', 'accept');
    assert.equal(dp.proposal.status, 'accepted');
    assert.equal(dp.proposal.decidedAt, new Date(clock).toISOString());
    assert.equal(store.decideProposal(target.id, 'gp_nope', 'accept'), null);
    assert.equal(store.acceptedGraphOverlay().length, 1);

    // Re-develop: analyst decisions on links and proposals survive a new package.
    const pkg2 = { links: [{ ...pkg.links[0], decision: null }], graphProposals: [{ ...proposal0 }] };
    const redev = store.setPackage(target.id, pkg2);
    assert.equal(redev.package.links[0].decision, 'accept');
    assert.equal(redev.graphProposals[0].status, 'accepted');

    // reset returns the proposal to the queue and drops it from the overlay.
    assert.equal(store.decideProposal(target.id, 'gp_aaaaaaaaaaaa', 'reset').proposal.status, 'proposed');
    assert.equal(store.acceptedGraphOverlay().length, 0);
    assert.equal(store.decideProposal(target.id, 'gp_aaaaaaaaaaaa', 'reject').proposal.status, 'rejected');
    assert.equal(store.acceptedGraphOverlay().length, 0);

    // Persistence: a fresh store on the same dir sees the same state.
    const again = new TargetStore({ dataDir: dir, now: () => clock, log: () => {} });
    assert.equal(again.get(target.id).graphProposals[0].status, 'rejected');
    assert.equal(again.get(target.id).package.links[0].decision, 'accept');

    assert.equal(store.close(target.id).status, 'closed');
    assert.equal(store.close('tgt_nope'), null);
    // A closed target no longer blocks a nomination on the same basis.
    assert.equal(store.nominate(validateNomination(NOMINATION).value).target.status, 'nominated');
    assert.equal(store.remove(target.id), true);
    assert.equal(store.remove(target.id), false);
    assert.equal(store.get(target.id), null);
    const s = summarizeTarget(store.targets[0]);
    assert.equal('package' in s, false);
    assert.ok(existsSync(join(dir, 'targets.json')));
  });

  await t.test('find: aliases match, names are masked before gazetteer, dates normalised, selectors need literal evidence', () => {
    assert.equal(day('2026-09-12T10:00:00Z'), '2026-09-12');
    assert.equal(day('garbage'), null);
    assert.equal(day(undefined), null);
    assert.ok(nameVariantOf('nemesio oseguera cervantes', { label: 'Nemesio Ruben Oseguera Cervantes' }));
    assert.equal(nameVariantOf('juan perez', { label: 'Nemesio Oseguera Cervantes' }), false);
    const masked = maskNames('Rubén Guerrero met the Sinaloa Cartel in Guerrero.', [{ name: 'Rubén Guerrero' }]);
    assert.equal(masked.includes('Rubén Guerrero'), false);
    assert.equal(masked.includes('Sinaloa Cartel'), false);
    assert.ok(masked.includes('in Guerrero'));

    const found = gatherMentions(TARGET, CTX);
    assert.ok(found.mentions.length >= 4);
    for (const m of found.mentions) {
      assert.match(m.id, /^m_[0-9a-f]+$/);
      assert.ok(m.date === null || /^\d{4}-\d{2}-\d{2}$/.test(m.date), `date normalised: ${m.date}`);
      assert.ok(typeof m.sentence === 'string' && m.sentence.length > 0);
    }
    const tg = found.mentions.find(m => m.source === 'telegram');
    assert.ok(tg, 'telegram alias hit');
    assert.equal(found.coverage.telegram.hits, 1);
    assert.equal(found.coverage.bordernews.hits, 1);
    assert.equal(found.coverage.doj.hits, 1);
    assert.equal(found.coverage.ofac.available, false);
    assert.equal(found.coverage.insightcrime.available, false);
    // Selectors: DOJ case number + phone from an official release; the press-tip phone in the blog is NOT a selector.
    const kinds = found.selectors.map(s => `${s.kind}=${s.value}`);
    assert.ok(kinds.includes('doj-case=1:14-cr-00092'), kinds.join(','));
    assert.ok(kinds.includes('doj-release=24-118'));
    assert.ok(found.selectors.filter(s => s.kind === 'phone').every(s => s.source === 'doj'));
    for (const s of found.selectors) { assert.ok(s.url === null || /^https:\/\//.test(s.url)); assert.equal(typeof s.evidence, 'string'); }
    // Candidates come only from graph edges / sentences that name them.
    const labels = found.candidates.map(c => c.label);
    assert.ok(labels.includes('CJNG'));
    assert.ok(labels.includes('Rosalinda González Valencia'));
    assert.ok(labels.includes('Nemesio Oseguera Ramos'), 'kg alias becomes a persona candidate');
    for (const c of found.candidates) for (const e of c.evidence) assert.ok(typeof e.sentence === 'string' && e.sentence.length);
  });

  await t.test('extractSelectors: literal evidence, official-only contact selectors, dedupe', () => {
    const text = 'Case 1:14-cr-00092 names the vessel IMO 9074729 and an aircraft with tail number XA-ABC; email: press@usdoj.gov, phone: (202) 555-0100; website: example.org.';
    const doj = extractSelectors(text, { source: 'doj', url: 'https://www.justice.gov/x', date: '2026-08-01' });
    const k = Object.fromEntries(doj.map(s => [s.kind, s]));
    assert.equal(k['doj-case'].value, '1:14-cr-00092');
    assert.ok(k.email, 'email on official source');
    assert.ok(k.phone, 'phone on official source');
    assert.equal(k.imo.value, '9074729');
    assert.equal(k['aircraft-reg'].value, 'XA-ABC');
    assert.equal(k.domain.value, 'example.org');
    for (const s of doj) assert.ok(text.includes(s.evidence.slice(0, 20)), 'evidence is a literal span');
    const blog = extractSelectors(text, { source: 'bordernews', url: 'https://example.com', date: '2026-08-01' });
    assert.equal(blog.some(s => s.kind === 'phone' || s.kind === 'email'), false, 'no contact selectors from press');
    const dup = extractSelectors(text, { source: 'doj', url: 'https://www.justice.gov/x', date: '2026-08-01', existing: doj });
    assert.equal(dup.length, 0);
    assert.ok(matchingSentences('Foo. El Mencho was here. Bar.', [{ text: 'El Mencho', folded: 'el mencho', re: /\bEl Mencho\b/i, alias: 'El Mencho', weak: false }]).length >= 1);
  });

  await t.test('adjudicate: rules baseline, provider output validated against candidate/evidence indexes', async () => {
    const found = gatherMentions(TARGET, CTX);
    const cjng = found.candidates.find(c => c.label === 'CJNG');
    const rules = rulesAssess(cjng, TARGET);
    assert.equal(rules.role, 'associate');
    assert.equal(rules.by, 'rules');
    assert.ok(rules.confidence > 0.5 && rules.confidence <= 0.9);

    // Provider-less: deterministic, every link carries a rules assessment and no decision.
    const off = await adjudicate(null, TARGET, found.candidates);
    assert.equal(off.llm.used, false);
    assert.match(off.llm.reason, /no LLM provider/);
    for (const l of off.links) { assert.equal(l.assessment.by, 'rules'); assert.equal(l.decision, null); assert.ok(ROLES.includes(l.assessment.role)); }

    // validateAssessment rejects everything the model may hallucinate.
    const cand = { kind: 'entity', label: 'CJNG', evidence: [{ sentence: 'a' }, { sentence: 'b' }] };
    assert.equal(validateAssessment({ role: 'enemy', relation: null, confidence: 0.5, evidence: [0] }, cand), null);
    assert.equal(validateAssessment({ role: 'associate', relation: 'controls', confidence: 0.5, evidence: [0] }, cand), null);
    assert.equal(validateAssessment({ role: 'associate', relation: null, confidence: 1.5, evidence: [0] }, cand), null);
    assert.equal(validateAssessment({ role: 'associate', relation: null, confidence: 0.5, evidence: [7] }, cand), null, 'evidence index out of range');
    assert.equal(validateAssessment({ role: 'associate', relation: null, confidence: 0.5, evidence: [] }, cand), null, 'no evidence');
    assert.equal(validateAssessment({ role: 'target', relation: 'same_actor', confidence: 0.9, evidence: [0] }, cand), null, 'same-actor only for persona candidates');
    const okv = validateAssessment({ role: 'associate', relation: 'leader_of', confidence: 0.876, evidence: [1, 1, 0], rationale: '<b>x</b>' + 'y'.repeat(500) }, cand);
    assert.deepEqual(okv.evidence, [1, 0]);
    assert.equal(okv.confidence, 0.88);
    assert.equal(okv.rationale.includes('<'), false);
    assert.equal(okv.rationale.length, MAX_RATIONALE_CHARS);
    assert.equal(parseAssessments('not json', [cand]), null);
    assert.equal(parseAssessments('{"assessments":[{"i":5,"role":"associate","relation":null,"confidence":0.5,"evidence":[0]}]}', [cand]).size, 0);

    // Configured provider: accepted assessments are marked by the model, rejected ones fall back to rules.
    const subset = found.candidates.filter(c => c.evidence.length);
    const idx = subset.findIndex(c => c.label === 'CJNG');
    const reply = '```json\n' + JSON.stringify({ assessments: [
      { i: idx, role: 'associate', relation: 'leader_of', confidence: 0.95, evidence: [0], rationale: 'named as leader' },
      { i: idx === 0 ? 1 : 0, role: 'target', relation: 'same_actor', confidence: 0.9, evidence: [0] },
      { i: 99, role: 'background', relation: null, confidence: 0.1, evidence: [0] },
    ] }) + '\n```';
    const p = fakeProvider(reply, { model: 'claude-test' });
    const on = await adjudicate(p, TARGET, found.candidates);
    assert.equal(on.llm.used, true);
    assert.equal(on.llm.model, 'claude-test');
    assert.ok(on.llm.assessed >= 1);
    const l = on.links.find(x => x.label === 'CJNG');
    assert.equal(l.assessment.by, 'llm');
    assert.equal(l.assessment.confidence, 0.95);
    assert.deepEqual(l.assessment.evidenceCited, [l.evidence[0].sentence]);
    assert.equal(l.rules.by, 'rules', 'rules baseline retained alongside model call');
    assert.ok(p.calls[0].user.includes('REQUIREMENT: ' + TARGET.requirement));
    assert.ok(buildPrompt(TARGET, subset).includes('[0] '));

    const bad = await adjudicate(fakeProvider('I refuse.'), TARGET, found.candidates);
    assert.equal(bad.llm.used, false);
    assert.match(bad.llm.reason, /not valid JSON/);
    const failed = await adjudicate(fakeProvider('', { fail: true }), TARGET, found.candidates);
    assert.equal(failed.llm.used, false);
    assert.match(failed.llm.reason, /model call failed/);
    for (const x of failed.links) assert.equal(x.assessment.by, 'rules');
  });

  await t.test('fix: gazetteer observations carry uncertainty; Telegram never places; model picks are index-checked', async () => {
    assert.equal(LOCATION_SOURCES.has('telegram'), false);
    const found = gatherMentions(TARGET, CTX);
    const obs = textGeolocate(found.mentions);
    assert.ok(obs.length >= 2, 'observations from kg sentences');
    for (const o of obs) {
      assert.ok(Number.isFinite(o.lat) && Number.isFinite(o.lon));
      assert.equal(o.radiusKm, radiusFor(o.precision));
      assert.ok(['stated', 'operation', 'contextual'].includes(o.presence));
      assert.ok(o.sentence && o.date && o.source && o.mentionId);
      assert.notEqual(o.source, 'telegram');
    }
    assert.equal(observe({ source: 'telegram', date: '2026-09-13', sentence: 'seen in Guadalajara, Jalisco' }), null);
    assert.equal(observe({ source: 'kg', date: null, sentence: 'in Guadalajara, Jalisco' }), null);
    const tapalpa = obs.find(o => /Tapalpa/.test(o.place));
    assert.ok(tapalpa, 'Tapalpa resolved');
    assert.equal(tapalpa.presence, 'stated');
    const lk = lastKnownLocation(obs);
    assert.equal(lk.date, '2026-04-28');
    assert.match(lk.place, /Tapalpa/);
    assert.match(lk.caveat, /newer mention/, 'the later Villa Purificación blog sentence does not state presence');
    assert.ok(['low', 'medium'].includes(lk.confidence));
    assert.equal(typeof lk.ageDays, 'number');
    const fp = footprint(obs);
    assert.ok(Array.isArray(fp) && fp.length >= 1 && fp[0].count >= 1);

    // Model refinement: out-of-range indexes are ignored; -1 downgrades presence to contextual.
    const amb = [{ place: 'Guerrero', state: 'Guerrero', adm1: 'GRO', lat: 17.5, lon: -99.5, precision: 'state', radiusKm: 150, presence: 'stated', date: '2026-01-01', sentence: 's', alternatives: [{ name: 'Jalisco', adm1: 'JAL', lat: 20.6, lon: -103.3, precision: 'state' }] }];
    assert.equal(applyFixPicks('nope', amb), null);
    assert.equal(applyFixPicks(JSON.stringify({ picks: [{ i: 0, place: 9 }, { i: 4, place: 0 }] }), amb), 0);
    assert.equal(applyFixPicks(JSON.stringify({ picks: [{ i: 0, place: 1, presence: 'stated' }] }), amb), 1);
    assert.equal(amb[0].place, 'Jalisco');
    assert.equal(amb[0].lat, 20.6);
    assert.equal(applyFixPicks(JSON.stringify({ picks: [{ i: 0, place: -1 }] }), amb), 1);
    assert.equal(amb[0].presence, 'contextual');
    const none = await refineWithModel(null, TARGET, obs);
    assert.equal(none.used, false);
    const noAmb = await refineWithModel(fakeProvider('{"picks":[]}'), TARGET, obs.map(o => ({ ...o, alternatives: [] })));
    assert.equal(noAmb.reason, 'no ambiguous sentences');
  });

  await t.test('pattern: timeline, month series with gaps, weekday/state/source aggregates, deviations vs own baseline', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const mk = (date, extra = {}) => ({ id: 'm' + date + (extra.docId || ''), source: 'kg', docId: extra.docId || date, sentence: `event on ${date}`, date, url: 'https://x/' + date, ...extra });
    const baseline = ['2025-01-05', '2025-03-10', '2025-05-02', '2025-07-15', '2025-09-01', '2025-11-20', '2026-01-14', '2026-03-03', '2026-04-21'].map(d => mk(d));
    const recent = ['2026-08-20', '2026-08-25', '2026-09-01', '2026-09-05', '2026-09-08', '2026-09-10', '2026-09-12'].map(d => mk(d));
    const status = mk('2026-09-13', { eventKind: 'arrested' });
    const timeline = buildTimeline([...baseline, ...recent, status, mk('2026-09-13', { eventKind: 'arrested' }), { id: 'nodate', source: 'kg', docId: 'x', sentence: 'no date', date: null }], [{ mentionId: 'm2026-09-12', place: 'Tapalpa', state: 'Jalisco', lat: 19.9, lon: -103.7, radiusKm: 30, presence: 'stated' }]);
    assert.equal(timeline[0].date, '2026-09-13');
    assert.equal(timeline[0].kind, 'status');
    assert.equal(timeline[0].status, 'arrested');
    assert.equal(timeline.filter(e => e.date === '2026-09-13').length, 1, 'duplicate sentences de-duplicated');
    assert.equal(timeline.find(e => e.date === '2026-09-12').place, 'Tapalpa, Jalisco');
    assert.equal(timeline.some(e => e.date === null), false);
    const agg = aggregate(timeline, { now });
    assert.equal(agg.span.first, '2025-01-05');
    assert.equal(agg.span.last, '2026-09-13');
    assert.equal(agg.byMonth[0].month, '2025-01');
    assert.equal(agg.byMonth.at(-1).month, '2026-09');
    assert.equal(agg.byMonth.find(m => m.month === '2025-02').n, 0, 'continuous series');
    assert.equal(agg.byWeekday.reduce((s, d) => s + d.n, 0), timeline.length);
    assert.deepEqual(agg.byState, [{ state: 'Jalisco', n: 1 }]);
    assert.deepEqual(agg.bySource, [{ source: 'kg', n: timeline.length }]);
    assert.equal(agg.statuses[0].status, 'arrested');
    assert.ok(agg.gaps.length >= 1 && agg.gaps.some(g => g.from === '2026-05' && g.months === 3), JSON.stringify(agg.gaps));
    assert.deepEqual(gaps([{ month: '2026-01', n: 1 }, { month: '2026-02', n: 0 }, { month: '2026-03', n: 0 }, { month: '2026-04', n: 0 }, { month: '2026-05', n: 2 }])[0], { from: '2026-02', to: '2026-04', months: 3 });
    const dev = deviations(timeline, { now });
    assert.equal(dev.window.days, 30);
    assert.ok(dev.observed >= 6 && dev.z >= 2, JSON.stringify(dev));
    assert.ok(dev.flags.some(f => f.kind === 'tempo-spike'), 'recent tempo well above the 12-month baseline flags a spike: ' + JSON.stringify(dev));
    assert.ok(dev.flags.some(f => f.kind === 'status-change'));
    assert.ok(dev.flags.some(f => f.kind === 'new-geography'));
    // 30 mentions spread over 2025-09..2026-06 (three per month), then silence: ~2.5/month baseline, 0 in the window.
    const quietDates = Array.from({ length: 30 }, (_, i) => { const m = 8 + Math.floor(i / 3); return `${2025 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-1${i % 3}`; });
    const quiet = deviations(buildTimeline(quietDates.map((d, i) => mk(d, { docId: 'q' + i }))), { now });
    assert.ok(quiet.flags.some(f => f.kind === 'went-quiet'), JSON.stringify(quiet));
    const poa = patternOfActivity([...baseline, ...recent, status], [], { now });
    assert.ok(poa.timeline.length && poa.aggregates && poa.deviations && Array.isArray(poa.deviations.flags));
    // Garbage dates never reach the aggregator.
    assert.doesNotThrow(() => aggregate([{ date: 'Tue Sep 14', source: 'kg', sentence: 'x' }], { now }));
  });

  await t.test('developTarget end-to-end (provider-less): package shape, proposals stay proposed, dossier is sourced', async () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const pkg = await developTarget(null, TARGET, CTX, { now });
    assert.equal(pkg.schema, 'crucix-target-package/1');
    assert.equal(pkg.llm.used, false);
    assert.equal(pkg.llm.fix.used, false);
    assert.equal(pkg.stats.mentions, pkg.mentions.length);
    assert.ok(pkg.stats.documents <= pkg.stats.mentions);
    assert.ok(pkg.fix.lastKnown && /Tapalpa/.test(pkg.fix.lastKnown.place));
    assert.equal(pkg.fix.lastKnown.basis, 'stated');
    assert.deepEqual(Object.keys(pkg.legend), ['tiers', 'claims', 'sources']);
    assert.deepEqual(Object.keys(EVIDENCE_TIERS), ['official', 'reported', 'unverified']);
    assert.deepEqual(Object.keys(CLAIM_STATES), ['reported', 'proposed', 'accepted', 'rejected']);
    assert.ok(pkg.graphProposals.length >= 2);
    for (const gp of pkg.graphProposals) {
      assert.match(gp.id, /^gp_[0-9a-f]{12}$/);
      assert.equal(gp.status, 'proposed');
      assert.ok(['rules', 'llm'].includes(gp.by));
      assert.ok(gp.evidence.length >= 1 && gp.evidence[0].sentence);
      assert.ok(gp.source && gp.target && gp.rel);
      assert.ok(gp.confidence >= 0 && gp.confidence <= 1);
      assert.ok(pkg.links.some(l => l.id === gp.linkId), 'proposal points at its link');
    }
    const leader = pkg.graphProposals.find(gp => gp.rel === 'leader_of');
    assert.ok(leader && leader.existing === true, 'edge already in the verified graph is flagged as existing, not re-added');
    // Personas of the anchor and "background" links do not become proposals.
    assert.equal(pkg.graphProposals.some(gp => pkg.links.find(l => l.id === gp.linkId)?.assessment.role === 'background'), false);
    assert.deepEqual(graphProposalsFrom(TARGET, [], []), []);

    const compact = compactPackage(pkg);
    assert.ok(compact.mentions.length <= 60 && compact.fix.observations.length <= 120 && compact.pattern.timeline.length <= 120);
    assert.equal(compactPackage(null), null);

    const target = { ...TARGET, status: 'developed', package: pkg, graphProposals: pkg.graphProposals.map(gp => ({ ...gp, status: 'proposed', decidedAt: null })), developedAt: new Date(now).toISOString() };
    target.package.links[0].decision = 'accept';
    target.graphProposals[0].status = 'accepted';
    target.graphProposals[0].decidedAt = new Date(now).toISOString();
    const md = renderDossier(target, { now });
    assert.match(md, /^# Target development package — Nemesio Oseguera Cervantes/);
    assert.ok(md.includes('Cognition AI'));
    assert.ok(md.includes('## 1. Nomination'));
    assert.ok(md.includes('kg-node · person:nemesio-oseguera-cervantes'));
    assert.ok(md.includes('Tapalpa'));
    assert.ok(md.includes('not used — no LLM provider configured'));
    assert.ok(md.includes('accepted'), 'analyst state rendered');
    assert.ok(md.includes('https://insightcrime.org/a/3'), 'source URL footnoted');
    assert.ok(/Nothing here is verified ground truth/.test(md));
    assert.equal(md.includes('<script'), false);
    // Every http(s) URL in the dossier comes from a package field, never synthesised.
    const urls = new Set(JSON.stringify(pkg).match(/https?:\/\/[^"\s)]+/g));
    for (const u of md.match(/\]\((https?:\/\/[^)]+)\)/g) || []) assert.ok(urls.has(u.slice(2, -1)), 'unknown URL in dossier: ' + u);
  });

  await t.test('developTarget with a mocked provider records the model on links and proposals', async () => {
    const found = gatherMentions(TARGET, CTX);
    const subset = found.candidates.filter(c => c.evidence.length);
    const i = subset.findIndex(c => c.label === 'Rosalinda González Valencia');
    const p = fakeProvider(JSON.stringify({ assessments: [{ i, role: 'associate', relation: 'family_of', confidence: 0.91, evidence: [0], rationale: 'wife per InSight Crime' }] }), { model: 'gpt-test' });
    const pkg = await developTarget(p, TARGET, CTX);
    assert.equal(pkg.llm.used, true);
    assert.equal(pkg.llm.model, 'gpt-test');
    const l = pkg.links.find(x => x.label === 'Rosalinda González Valencia');
    assert.equal(l.assessment.by, 'llm');
    assert.equal(l.assessment.rationale, 'wife per InSight Crime');
    const gp = pkg.graphProposals.find(x => x.linkId === l.id);
    assert.ok(gp);
    assert.equal(gp.by, 'llm');
    assert.equal(gp.model, 'gpt-test');
    assert.equal(gp.confidence, 0.91);
    assert.equal(p.calls.length, 1, 'fix pass skipped when nothing is ambiguous or called once; never leaks secrets');
    assert.equal(JSON.stringify(pkg).includes('secret-key-value'), false);
  });

  await t.test('buildSourceContext reports missing stores as unavailable rather than fabricating', () => {
    const ctx = buildSourceContext({}, { now: Date.parse('2000-01-01T00:00:00Z') });
    assert.equal(ctx.graph, null);
    assert.equal(ctx.telegram, null);
    assert.equal(ctx.narcoClusters, null);
    assert.ok(ctx.articles === null || Array.isArray(ctx.articles));
    assert.ok(ctx.dojReleases === null || Array.isArray(ctx.dojReleases));
    const live = buildSourceContext({ graph: GRAPH, telegramFeed: { messages: TELEGRAM }, narcoData: { clusters: [] } });
    assert.equal(live.graph, GRAPH);
    assert.equal(live.telegram.length, 1);
    assert.deepEqual(live.narcoClusters, []);
  });
});
