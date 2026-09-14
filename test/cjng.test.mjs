import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';
import {
  CORPUS_SCHEMA, TAG_JALISCO_CARTEL, TAG_EL_MENCHO, QUERIES,
  cjngFocus, normalizePost, isCjngFocused, loadCorpus, refreshCorpus,
} from '../lib/cjng/corpus.mjs';
import {
  GRAPH_SCHEMA, ROOT_NODE, NODE_TYPES, RELATIONS, buildCjngGraph, splitSentences, isProse, classifyTag,
  saveGraph, loadGraph, saveSnapshot, filterGraph, summarizeGraph,
} from '../lib/cjng/graph.mjs';
import { loadGazetteer } from '../lib/narco/gazetteer.mjs';
import { loadGroups } from '../lib/narco/groups.mjs';
import { resetRobotsCacheForTests } from '../apis/utils/robots.mjs';

const gz = loadGazetteer();
const groups = loadGroups();
const tmp = () => mkdtempSync(join(tmpdir(), 'cjng-'));

function post(id, over = {}) {
  return {
    id, date_gmt: '2024-03-01T12:00:00', modified_gmt: '2024-03-02T12:00:00',
    link: `https://insightcrime.org/news/post-${id}/`, slug: `post-${id}`,
    title: { rendered: `Post ${id}` }, excerpt: { rendered: '<p>x</p>' }, content: { rendered: '<p>body</p>' },
    tags: [], categories: [], ...over,
  };
}

function article(id, title, text, over = {}) {
  return { id, link: `https://insightcrime.org/news/a-${id}/`, slug: `a-${id}`, title, date: `2024-0${(id % 9) + 1}-10T00:00:00.000Z`, modified: null, tags: [], categories: [], excerpt: '', text, tagged: false, focus: cjngFocus(title, text), words: text.split(/\s+/).length, ...over };
}

// ---------------------------------------------------------------- corpus

test('cjngFocus / isCjngFocused: tag or repeated naming counts, a passing mention does not', () => {
  assert.equal(cjngFocus('CJNG expands', 'no mention'), 3);
  assert.equal(cjngFocus('x', 'The Jalisco Cartel New Generation, or CJNG, and El Mencho'), 3);
  assert.ok(isCjngFocused({ tagged: true, focus: 0 }));
  assert.ok(isCjngFocused({ tagged: false, focus: 3 }));
  assert.ok(!isCjngFocused({ tagged: false, focus: 2 }));
  assert.ok(!isCjngFocused(null));
});

test('normalizePost: bounded record, only https insightcrime.org links, tag flags', () => {
  const rec = normalizePost(post(7, { title: { rendered: 'El &#8220;Mencho&#8221; &amp; the <b>CJNG</b>' }, content: { rendered: '<p>The CJNG grew.</p><p>Second para about CJNG.</p>' }, tags: [TAG_EL_MENCHO, 3, 'x'] }));
  assert.equal(rec.id, 7);
  assert.equal(rec.title, 'El “Mencho” & the CJNG');
  assert.ok(rec.text.includes('Second para'));
  assert.deepEqual(rec.tags, [TAG_EL_MENCHO, 3]);
  assert.equal(rec.tagged, true);
  assert.equal(rec.date, '2024-03-01T12:00:00.000Z');
  assert.ok(rec.focus >= 3);
  assert.equal(normalizePost(post(8, { link: 'http://insightcrime.org/x/' })), null);
  assert.equal(normalizePost(post(9, { link: 'https://evil.example/insightcrime.org/' })), null);
  assert.equal(normalizePost(post(-1)), null);
  assert.equal(normalizePost({ id: 'a' }), null);
  assert.equal(normalizePost(post(10, { tags: [TAG_JALISCO_CARTEL] })).tagged, true);
});

function fakeApi({ pages, fail = () => null }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { ok: true, status: 200, headers: new Map(), text: async () => 'User-agent: *\nAllow: /\n' };
    const failure = fail(u);
    if (failure) return { ok: false, status: failure, headers: new Map([['retry-after', '0']]), json: async () => ({}) };
    const kind = u.pathname.split('/').pop();
    const body = kind === 'posts' ? pages(u) : kind === 'tags' ? [{ id: TAG_JALISCO_CARTEL, name: 'Jalisco Cartel', slug: 'jalisco-cartel', count: 1 }] : [{ id: 1, name: 'News', slug: 'news', count: 1 }];
    return { ok: true, status: 200, headers: new Map([['x-wp-totalpages', '1'], ['x-wp-total', String(body.length)]]), json: async () => body };
  };
  return { fetchImpl, calls };
}

test('refreshCorpus: de-duplicates across queries, persists, and is incremental on the next run', async () => {
  resetRobotsCacheForTests();
  const dir = tmp();
  const api = fakeApi({
    pages: (u) => {
      if (u.searchParams.get('tags') === String(TAG_JALISCO_CARTEL)) return [post(1, { tags: [TAG_JALISCO_CARTEL] }), post(2, { tags: [TAG_JALISCO_CARTEL] })];
      if (u.searchParams.get('tags') === String(TAG_EL_MENCHO)) return [post(2, { tags: [TAG_JALISCO_CARTEL, TAG_EL_MENCHO] })];
      if (u.searchParams.get('search') === 'CJNG') return [post(3, { content: { rendered: '<p>CJNG once</p>' } })];
      return [];
    },
  });
  const c = await refreshCorpus({ dataDir: dir, fetchImpl: api.fetchImpl, delayMs: 0, now: Date.parse('2024-04-01T00:00:00Z') });
  assert.equal(c.schema, CORPUS_SCHEMA);
  assert.equal(c.totals.articles, 3);
  assert.equal(c.totals.focused, 2);
  assert.equal(c.totals.peripheral, 1);
  assert.deepEqual(c.stats.errors, []);
  assert.ok(c.fetchedAt);
  for (const q of QUERIES) assert.ok(c.completed[q.name]);
  assert.ok(existsSync(join(dir, 'corpus.json')));
  assert.equal(loadCorpus(dir).totals.articles, 3);
  // A UA and JSON accept header go out on every API call; no call leaves insightcrime.org.
  for (const u of api.calls) assert.equal(new URL(u).hostname, 'insightcrime.org');

  api.calls.length = 0;
  const c2 = await refreshCorpus({ dataDir: dir, fetchImpl: api.fetchImpl, delayMs: 0, now: Date.parse('2024-04-02T00:00:00Z') });
  assert.equal(c2.incremental, true);
  const postCalls = api.calls.filter(u => u.includes('/posts?'));
  assert.ok(postCalls.length >= 3);
  for (const u of postCalls) assert.ok(new URL(u).searchParams.get('modified_after'), 'incremental runs ask only for modified posts');
  assert.equal(c2.totals.articles, 3);
  assert.equal(c2.stats.added, 0);
});

test('refreshCorpus: a failing query keeps the previous corpus and is re-run in full next time', async () => {
  resetRobotsCacheForTests();
  const dir = tmp();
  let failSearch = true;
  const api = fakeApi({
    pages: (u) => u.searchParams.get('search') ? [post(5, { content: { rendered: '<p>CJNG CJNG CJNG</p>' } })] : u.searchParams.get('tags') === String(TAG_JALISCO_CARTEL) ? [post(4, { tags: [TAG_JALISCO_CARTEL] })] : [],
    fail: (u) => failSearch && u.searchParams.get('search') ? 503 : null,
  });
  const slept = [];
  const c1 = await refreshCorpus({ dataDir: dir, fetchImpl: api.fetchImpl, delayMs: 0, sleep: async ms => { slept.push(ms); }, now: Date.parse('2024-04-01T00:00:00Z') });
  assert.deepEqual(slept, [5000, 20000, 60000], 'bounded backoff before giving up on a 5xx');
  assert.equal(c1.totals.articles, 1);
  assert.equal(c1.stats.errors.length, 1);
  assert.match(c1.stats.errors[0], /^search:CJNG: http-503$/);
  assert.equal(c1.fetchedAt, null, 'not a complete fetch');
  assert.equal(c1.completed['search:CJNG'], undefined);

  failSearch = false;
  api.calls.length = 0;
  const c2 = await refreshCorpus({ dataDir: dir, fetchImpl: api.fetchImpl, delayMs: 0, sleep: async () => {}, now: Date.parse('2024-04-02T00:00:00Z') });
  const searchCall = api.calls.find(u => u.includes('search=CJNG'));
  assert.ok(searchCall);
  assert.equal(new URL(searchCall).searchParams.get('modified_after'), null, 'failed query is re-run from scratch');
  assert.equal(c2.totals.articles, 2);
  assert.deepEqual(c2.stats.errors, []);
  assert.ok(c2.fetchedAt);
});

test('refreshCorpus: robots disallow blocks the fetch without throwing', async () => {
  resetRobotsCacheForTests();
  const dir = tmp();
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === '/robots.txt') return { ok: true, status: 200, headers: new Map(), text: async () => 'User-agent: *\nDisallow: /\n' };
    throw new Error('should not be called');
  };
  const c = await refreshCorpus({ dataDir: dir, fetchImpl, delayMs: 0 });
  assert.equal(c.totals.articles, 0);
  assert.ok(c.stats.errors.every(e => /robots-disallowed/.test(e)));
});

// ---------------------------------------------------------------- graph

test('splitSentences / isProse: drop navigation furniture and date strips', () => {
  const s = splitSentences('The CJNG is led by El Mencho. SEE ALSO: Coverage of Mexico. Sinaloa Cartel rivals fought the group in Zacatecas.');
  assert.ok(s.some(x => /led by/.test(x)));
  assert.ok(isProse('The CJNG is led by Nemesio Oseguera Cervantes, alias El Mencho.'));
  assert.ok(!isProse('SEE ALSO: Coverage of Mexico'));
  assert.ok(!isProse('12 MAR 2021 14 MAR 2021'));
  assert.ok(!isProse('Jalisco Cartel'));
});

test('classifyTag: groups, people, places, countries, org tags and topics', () => {
  const ctx = { gz, groups };
  assert.equal(classifyTag('Jalisco Cartel', ctx), 'org');
  assert.equal(classifyTag('El Mencho', ctx), 'person');
  assert.equal(classifyTag('Jalisco', ctx), 'place');
  assert.equal(classifyTag('Mexico', ctx), 'skip');
  assert.equal(classifyTag('PCC', ctx), 'org-tag');
  assert.equal(classifyTag('FARC peace', ctx), 'topic');
  assert.equal(classifyTag('Fentanyl', ctx), 'topic');
  assert.equal(classifyTag('News', ctx), 'skip');
});

const CORPUS = {
  schema: CORPUS_SCHEMA, fetchedAt: '2024-05-01T00:00:00.000Z', totals: { articles: 5, focused: 4 },
  tags: { [TAG_JALISCO_CARTEL]: { name: 'Jalisco Cartel', slug: 'jalisco-cartel' }, 900: { name: 'Fentanyl', slug: 'fentanyl' }, 901: { name: 'PCC', slug: 'pcc' }, 902: { name: 'Mexico', slug: 'mexico' } },
  articles: [
    article(1, 'CJNG leader profile',
      'The Jalisco Cartel New Generation (CJNG) is led by Nemesio Oseguera Cervantes, alias "El Mencho". The CJNG has a strong presence in Jalisco and Michoacán. The Sinaloa Cartel is the main rival of the CJNG in Zacatecas.',
      { tagged: true, tags: [TAG_JALISCO_CARTEL, 900, 902] }),
    article(2, 'Fentanyl and the CJNG',
      'Nemesio Oseguera Cervantes remains at large. The CJNG operates in Guanajuato where it battles the Santa Rosa de Lima Cartel. Authorities said the Jalisco Cartel New Generation controls fentanyl routes.',
      { tags: [900] }),
    article(3, 'Splinter groups',
      'The Cartel Nueva Plaza split from the CJNG in 2017. CJNG members were arrested in Colima. Officials described El Mencho as the leader of the Jalisco Cartel New Generation.',
      { tagged: true, tags: [TAG_JALISCO_CARTEL, 901] }),
    article(4, 'President speaks',
      'President Andrés Manuel López Obrador said the CJNG is a threat. The CJNG is Mexico\'s fastest-growing group, said the Jalisco Cartel New Generation report.',
      { tags: [] }),
    article(5, 'Colombian gangs', 'The Gulf Clan moves cocaine through Urabá. The CJNG buys some of it.', { tags: [] }),
  ],
};

test('buildCjngGraph: root, typed relations with evidence, co-mention fallback, bounded output', () => {
  const g = buildCjngGraph(CORPUS, { gz, groups, now: Date.parse('2024-06-01T00:00:00Z') });
  assert.equal(g.schema, GRAPH_SCHEMA);
  assert.equal(g.totals.articles, 4, 'the peripheral article is excluded');
  assert.equal(g.totals.peripheral, 1);
  assert.equal(g.source.corpusArticles, 5);
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const root = byId.get(ROOT_NODE);
  assert.ok(root && root.type === 'org' && root.articles === 4);
  for (const n of g.nodes) assert.ok(NODE_TYPES.includes(n.type), n.type);
  for (const e of g.edges) {
    assert.ok(Object.hasOwn(RELATIONS, e.type), e.type);
    assert.ok(byId.has(e.source) && byId.has(e.target));
    assert.ok(['typed', 'co-mention'].includes(e.confidence));
    assert.ok(Array.isArray(e.evidence) && e.evidence.length <= 3);
    for (const ev of e.evidence) { assert.ok(Number.isInteger(ev.a), 'article id'); assert.ok(typeof ev.s === 'string' && ev.s.length <= 400); }
  }

  const mencho = g.nodes.find(n => n.type === 'person' && /Oseguera/.test(n.label));
  assert.ok(mencho, 'leader node');
  assert.equal(mencho.articles, 3, 'alias and full name merge into one person across articles');
  const leader = g.edges.find(e => e.type === 'leader_of' && e.source === mencho.id && e.target === ROOT_NODE);
  assert.ok(leader && leader.confidence === 'typed');
  assert.ok(leader.evidence.some(ev => /led by|leader/.test(ev.s)));

  const rival = g.edges.find(e => e.type === 'rival_of' && [e.source, e.target].includes('org:sinaloa') && [e.source, e.target].includes(ROOT_NODE));
  assert.ok(rival, 'Sinaloa rivalry');
  assert.ok(g.edges.some(e => e.type === 'lineage' && [e.source, e.target].includes('org:nueva_plaza')), 'Nueva Plaza split');
  const jalisco = g.nodes.find(n => n.type === 'place' && /^Jalisco$/i.test(n.label));
  assert.ok(jalisco, 'Jalisco place node');
  assert.ok(g.edges.some(e => e.type === 'operates_in' && e.source === ROOT_NODE && e.target === jalisco.id), 'operates_in Jalisco');
  assert.ok(g.edges.some(e => e.type === 'linked_topic' && e.target === 'topic:fentanyl'), 'topic tag');
  assert.ok(g.edges.some(e => e.type === 'linked_topic' && e.target === 'org:tag-pcc'), 'org tag without gazetteer entry');
  assert.ok(!g.nodes.some(n => /mexico/.test(n.id) && n.type === 'topic'), 'country tags are not topics');

  assert.ok(!g.nodes.some(n => n.type === 'person' && /L[oó]pez Obrador/.test(n.label) && g.edges.some(e => e.type === 'member_of' && e.source === n.id)),
    'officials are never typed as cartel members');

  for (const a of g.articles) {
    assert.ok(/^https:\/\/insightcrime\.org\//.test(a.link));
    assert.ok(!('text' in a), 'article bodies are not redistributed');
  }
  assert.ok(g.caveat.includes('not verified'));
});

test('buildCjngGraph: empty / missing corpus still yields a well-formed root-only graph', () => {
  for (const c of [null, {}, { articles: [] }]) {
    const g = buildCjngGraph(c, { gz, groups });
    assert.equal(g.nodes.length, 1);
    assert.equal(g.nodes[0].id, ROOT_NODE);
    assert.deepEqual(g.edges, []);
    assert.equal(g.totals.articles, 0);
  }
});

test('filterGraph: node types, relations and minimum support; root always kept', () => {
  const g = buildCjngGraph(CORPUS, { gz, groups });
  const f = filterGraph(g, { types: ['person'], rels: ['leader_of'], minArticles: 2 });
  assert.ok(f.nodes.some(n => n.id === ROOT_NODE));
  assert.ok(f.nodes.every(n => n.id === ROOT_NODE || (n.type === 'person' && n.articles >= 2)));
  assert.ok(f.edges.length >= 1 && f.edges.every(e => e.type === 'leader_of'));
  assert.deepEqual(f.filtered.types, ['person']);
  const strict = filterGraph(g, { minArticles: 999 });
  assert.deepEqual(strict.nodes.map(n => n.id), [ROOT_NODE]);
  assert.equal(filterGraph(null), null);
});

test('summarizeGraph: bounded client summary with health passthrough', () => {
  const g = buildCjngGraph(CORPUS, { gz, groups });
  const health = { status: 'cached', lastSuccess: '2024-06-01T00:00:00.000Z', error: null };
  const s = summarizeGraph(g, health);
  assert.equal(s.status, 'live');
  assert.deepEqual(s.refresh, health);
  assert.equal(s.totals.articles, 4);
  assert.equal(s.totals.nodes, g.nodes.length);
  assert.equal(s.totals.edges, g.edges.length);
  assert.ok(s.totals.typedEdges >= 1);
  assert.ok(s.totals.byNodeType && s.totals.byRelation);
  assert.equal(s.corpusArticles, 5);
  assert.ok(s.top.people.length <= 8 && s.top.people.every(p => p.id !== ROOT_NODE));
  assert.ok(!('nodes' in s) && !('edges' in s), 'summary never carries the full graph');
  assert.ok(s.caveat.includes('not verified'));
  assert.equal(summarizeGraph({ ...g, snapshot: true }).status, 'snapshot');
  const empty = summarizeGraph(null, { status: 'pending' });
  assert.equal(empty.status, 'pending');
  assert.equal(empty.totals, null);
});

test('saveGraph / loadGraph / saveSnapshot: runtime copy first, gzip snapshot fallback, garbage ignored', () => {
  const dir = tmp();
  const snap = join(dir, 'snap', 'graph.json.gz');
  const g = buildCjngGraph(CORPUS, { gz, groups });
  assert.equal(loadGraph(dir, snap), null);
  saveSnapshot(g, snap);
  const fromSnap = loadGraph(dir, snap);
  assert.equal(fromSnap.snapshot, true);
  assert.equal(fromSnap.nodes.length, g.nodes.length);
  saveGraph(g, dir);
  const fromRun = loadGraph(dir, snap);
  assert.equal(fromRun.snapshot, false);
  mkdirSync(join(dir, 'bad'), { recursive: true });
  writeFileSync(join(dir, 'bad', 'graph.json'), '{"schema":"other"}');
  writeFileSync(join(dir, 'bad', 'snap.gz'), gzipSync('not json'));
  assert.equal(loadGraph(join(dir, 'bad'), join(dir, 'bad', 'snap.gz')), null);
  assert.ok(readFileSync(join(dir, 'graph.json'), 'utf8').includes(GRAPH_SCHEMA));
});
