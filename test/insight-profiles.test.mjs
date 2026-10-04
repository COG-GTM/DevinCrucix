// Country gazetteers / group indexes and the InSight Crime graph profiles (cjng, co, ve).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadGazetteer, loadCountryGazetteer, findPlaces, GAZETTEER_FILES, resetForTests as resetGz } from '../lib/narco/gazetteer.mjs';
import { loadGroups, findGroups, DEFAULT_GROUPS_FILE, resetForTests as resetGroups } from '../lib/narco/groups.mjs';
import { PROFILES, PROFILE_KEYS, COUNTRY_PROFILES, getProfile, rootNodeId, DEFAULT_PROFILE } from '../lib/cjng/profiles.mjs';
import { normalizePost, isFocused, isCjngFocused, focusScore, cjngFocus, QUERIES, loadCorpus } from '../lib/cjng/corpus.mjs';
import { buildGraph, buildCjngGraph, classifyTag, loadProfileGraph, filterGraph, summarizeGraph, ROOT_NODE, GRAPH_SCHEMAS } from '../lib/cjng/graph.mjs';

test('gazetteers: MX stays the default; CO and VE load independently with their own ADM1 sets', () => {
  resetGz();
  const mx = loadGazetteer();
  const co = loadCountryGazetteer('co');
  const ve = loadCountryGazetteer('VE');
  assert.equal(mx, loadCountryGazetteer('MX'));
  assert.equal(co.country, 'CO');
  assert.equal(ve.country, 'VE');
  assert.notEqual(co, ve);
  assert.ok(co.states.length >= 32 && co.states.length <= 34, `CO departments ${co.states.length}`);
  assert.ok(ve.states.length >= 24 && ve.states.length <= 26, `VE states ${ve.states.length}`);
  assert.throws(() => loadCountryGazetteer('XX'), /no gazetteer/);
  for (const f of Object.values(GAZETTEER_FILES)) assert.ok(existsSync(f), f);
});

test('gazetteers: country place lookup resolves cities to the right ADM1 and does not bleed across countries', () => {
  const co = loadCountryGazetteer('CO');
  const ve = loadCountryGazetteer('VE');
  const f = findPlaces('Clashes in Tumaco, Nariño and Cúcuta left the Catatumbo region tense; Bogotá responded.', co);
  const names = [...f.places, ...f.municipalities].map(p => p.name.toLowerCase());
  assert.ok(names.some(n => n.startsWith('tumaco')) || f.states.some(s => /Nari/.test(s.name)), JSON.stringify(f).slice(0, 300));
  assert.ok(f.states.some(s => /Norte de Santander|Nari/.test(s.name)));
  const v = findPlaces('Tren de Aragua grew out of Tocorón prison in Aragua; cells reached Maracaibo in Zulia.', ve);
  assert.ok(v.states.some(s => /Aragua/.test(s.name)) && v.states.some(s => /Zulia/.test(s.name)), JSON.stringify(v.states));
  const bleed = findPlaces('Tren de Aragua grew out of Tocorón prison in Aragua.', co);
  assert.equal(bleed.states.filter(s => /Aragua/.test(s.name)).length, 0);
});

test('groups: file-keyed cache keeps MX, CO and VE indexes apart; aliases resolve', () => {
  resetGroups();
  const mx = loadGroups();
  const co = loadGroups(PROFILES.co.groupsFile);
  const ve = loadGroups(PROFILES.ve.groupsFile);
  assert.equal(mx, loadGroups(DEFAULT_GROUPS_FILE));
  assert.notEqual(co, ve);
  assert.ok(mx.byId.has('cjng') && !co.byId.has('cjng_elite') );
  const c = findGroups('The Clan del Golfo (AGC) and the ELN clashed with the Estado Mayor Central near the border; Segunda Marquetalia denied it.', co);
  assert.deepEqual([...new Set(c.cartels.map(g => g.id))].sort(), ['agc', 'eln', 'emc', 'segunda_marquetalia']);
  const v = findGroups('Tren de Aragua, the colectivos and the Cartel de los Soles were named; Niño Guerrero fled Tocorón.', ve);
  assert.deepEqual(v.cartels.map(g => g.id).sort(), ['cartel_de_los_soles', 'colectivos', 'tren_de_aragua']);
  assert.ok(v.leaders.some(l => l.groupId === 'tren_de_aragua'));
  // Mexico index unaffected by loading the others.
  assert.ok(findGroups('CJNG convoy in Jalisco', loadGroups()).cartels.some(g => g.id === 'cjng'));
});

test('profiles: three profiles with distinct roots, namespaces and data dirs; cjng stays the default', () => {
  assert.deepEqual(PROFILE_KEYS, ['cjng', 'co', 've']);
  assert.equal(DEFAULT_PROFILE.key, 'cjng');
  assert.equal(rootNodeId(PROFILES.cjng), 'org:cjng');
  assert.equal(rootNodeId(PROFILES.co), 'country:CO');
  assert.equal(rootNodeId(PROFILES.ve), 'country:VE');
  assert.equal(ROOT_NODE, 'org:cjng');
  assert.deepEqual(COUNTRY_PROFILES, { co: 'co', ve: 've' });
  assert.equal(getProfile('CO'), PROFILES.co);
  assert.throws(() => getProfile('mx'), /unknown graph profile/);
  const dirs = new Set(Object.values(PROFILES).map(p => p.dataDir));
  assert.equal(dirs.size, 3);
  assert.ok(GRAPH_SCHEMAS.includes('cjng-graph/1') && GRAPH_SCHEMAS.includes('insightcrime-graph/1'));
  assert.equal(QUERIES, PROFILES.cjng.queries);
  for (const p of Object.values(PROFILES)) {
    assert.ok(p.queries.length >= 3 && p.queries.every(q => /^(tag|search):/.test(q.name)));
    assert.ok(p.focusTags.length >= 2 && existsSync(p.groupsFile), p.key);
  }
});

const post = (over = {}) => ({
  id: 1, link: 'https://insightcrime.org/news/x/', date_gmt: '2025-01-02T03:04:05', modified_gmt: '2025-01-02T03:04:05', type: 'post', status: 'publish',
  title: { rendered: 'ELN and Clan del Golfo clash in Catatumbo' }, content: { rendered: '<p>Colombia Colombia Colombia. The ELN said so.</p>' }, excerpt: { rendered: '' }, tags: [627], categories: [], ...over,
});

test('corpus: focus is profile-driven (tags + subject regex); CJNG wrappers unchanged', () => {
  const co = normalizePost(post(), PROFILES.co);
  assert.ok(co.tagged && isFocused(co), JSON.stringify({ tagged: co.tagged, focus: co.focus }));
  const asCjng = normalizePost(post());
  assert.equal(asCjng.tagged, false);
  assert.equal(asCjng.focus, 0);
  assert.equal(isCjngFocused(asCjng), false);
  const cj = normalizePost(post({ tags: [676], title: { rendered: 'CJNG moves on Zacatecas' } }));
  assert.ok(cj.tagged && isCjngFocused(cj));
  assert.equal(cjngFocus('CJNG hit', 'the CJNG again'), focusScore('CJNG hit', 'the CJNG again'));
  assert.equal(focusScore('Venezuela', 'Venezuelan gangs', PROFILES.ve.focusRe), 4);
  const long = normalizePost(post({ content: { rendered: '<p>' + 'x'.repeat(30_000) + '</p>' } }), PROFILES.co);
  assert.equal(long.text.length, PROFILES.co.maxTextChars);
  assert.equal(loadCorpus(PROFILES.co.dataDir, PROFILES.cjng), null, 'schema mismatch rejects a corpus from another profile');
});

const corpusFor = (profile, articles) => ({ schema: profile.corpusSchema, articles, tags: { 627: { name: 'ELN', slug: 'eln' }, 547: { name: 'Colombia', slug: 'colombia' }, 3507: { name: 'Tren de Aragua', slug: 'tren-de-aragua' } }, totals: { articles: articles.length } });

test('graph: country profile roots on the country, namespaces places by ISO code and keeps configured groups as family', () => {
  const arts = [
    normalizePost(post({ id: 11, content: { rendered: '<p>In Colombia, the ELN clashed with the Clan del Golfo in Catatumbo, Norte de Santander. ELN commander Antonio García said the group would hold Arauca. Tren de Aragua cells were reported in Cúcuta.</p>' } }), PROFILES.co),
    normalizePost(post({ id: 12, title: { rendered: 'Clan del Golfo expands in Antioquia' }, tags: [547], content: { rendered: '<p>The Clan del Golfo, also called the Gaitanistas, moved into Bajo Cauca, Antioquia, Colombia. Otoniel led the Clan del Golfo until his 2021 capture in Colombia.</p>' } }), PROFILES.co),
  ];
  const g = buildGraph(corpusFor(PROFILES.co, arts), { profile: PROFILES.co });
  assert.equal(g.schema, 'insightcrime-graph/1');
  assert.equal(g.root, 'country:CO');
  assert.equal(g.profile.key, 'co');
  assert.equal(g.nodes[0].id, 'country:CO');
  const ids = new Set(g.nodes.map(n => n.id));
  assert.ok(ids.has('org:eln') && ids.has('org:agc'), [...ids].join(','));
  assert.ok([...ids].some(i => i.startsWith('place:CO-')), 'CO-namespaced places');
  assert.ok(![...ids].some(i => i.startsWith('place:MX-')));
  assert.ok(g.nodes.find(n => n.id === 'org:eln').family);
  assert.equal(g.totals.articles, 2);
  assert.equal(g.totals.truncated, 0);
  const sum = summarizeGraph(g, { status: 'cached' });
  assert.equal(sum.root, 'country:CO');
  assert.equal(sum.profile.subject, 'Colombia');
  const f = filterGraph(g, { types: ['org'], minArticles: 99 });
  assert.ok(f.nodes.some(n => n.id === 'country:CO'), 'root always kept');
});

test('graph: Venezuela profile uses VE gazetteer/groups and the CJNG wrapper still builds the Mexico graph', () => {
  const ve = normalizePost(post({ id: 21, tags: [3507], title: { rendered: 'Tren de Aragua spreads from Tocorón' }, content: { rendered: '<p>Venezuela’s Tren de Aragua, led by Niño Guerrero, grew out of Tocorón prison in Aragua, Venezuela, and now operates in Zulia and in Colombia.</p>' } }), PROFILES.ve);
  const g = buildGraph(corpusFor(PROFILES.ve, [ve]), { profile: PROFILES.ve });
  assert.equal(g.root, 'country:VE');
  const ids = new Set(g.nodes.map(n => n.id));
  assert.ok(ids.has('org:tren_de_aragua'), [...ids].join(','));
  assert.ok([...ids].some(i => i.startsWith('place:VE-')));
  assert.ok(ids.has('country:CO'), 'foreign country kept as a country node');
  const cj = buildCjngGraph({ schema: PROFILES.cjng.corpusSchema, articles: [], tags: {}, totals: { articles: 0 } });
  assert.equal(cj.root, 'org:cjng');
  assert.equal(cj.schema, 'cjng-graph/1');
  assert.equal(cj.nodes[0].id, 'org:cjng');
});

test('graph: classifyTag honours profile skip tags and aliases', () => {
  const gz = loadCountryGazetteer('CO'), groups = loadGroups(PROFILES.co.groupsFile);
  const lex = { aliases: { otoniel: 'Dairo Antonio Úsuga David' }, nicks: new Set(['otoniel']), skip: new Set(['colombia']), notPerson: /\bNOPE\b/i };
  assert.equal(classifyTag('Colombia', { gz, groups, lex }), 'skip');
  assert.equal(classifyTag('Otoniel', { gz, groups, lex }), 'person');
  assert.equal(classifyTag('ELN', { gz, groups, lex }), 'org');
  assert.equal(classifyTag('Peru', { gz, groups }), 'country');
  assert.equal(classifyTag('Colombia', { gz, groups }), 'place', 'Colombia is also a Huila municipality, hence the profile skip tag');
});

test('snapshots: every profile has a loadable committed graph with its own root', () => {
  for (const p of Object.values(PROFILES)) {
    const g = loadProfileGraph(p);
    assert.ok(g, `${p.key} graph loads`);
    assert.equal(g.root, rootNodeId(p));
    assert.ok(g.nodes.length > 50 && g.edges.length > 50, `${p.key}: ${g.nodes.length} nodes`);
    assert.ok(g.edges.every(e => (e.evidence || []).every(ev => typeof ev.s === 'string' && ev.s.length <= 400)), 'evidence bounded');
  }
});
