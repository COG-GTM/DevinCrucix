// Border Watch ingestion — unit tests against recorded fixtures (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import {
  briefing, loadRegistry, validateRegistry, normalizeItem, normalizeUrl, titleKey, wpPostId,
  tagTopics, tagPlaces, conditionalHeaders, classifyHttp, pollFeed, enrichArticle, mergeIntoStore,
  detectSpikes, baselineCoverage, summarizeStore, queryArticles, applyTags, sha256, stripDateline,
  PLACES, PLACE_KEYS, PLACE_BY_KEY, TOPIC_KEYS, PIPELINE_VERSION, TAGGER_VERSION, resetForTests, matchesPathPrefixes,
} from '../apis/sources/bordernews.mjs';
import { parseRobots, isAllowedByRules, checkRobots, resetRobotsCacheForTests, CRAWLER_UA } from '../apis/utils/robots.mjs';
import { extractArticle, htmlToText, bodyParagraphs } from '../apis/utils/article.mjs';
import { parseFeed, feedMeta, isNewsSitemap } from '../apis/utils/rss.mjs';
import { classifySource } from '../lib/sourcehealth.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'border');
const BR_FEED = readFileSync(join(FIX, 'borderreport-feed.xml'), 'utf8');
const TT_FEED = readFileSync(join(FIX, 'texastribune-feed.xml'), 'utf8');
const TT_POST = readFileSync(join(FIX, 'texastribune-post-242108.json'), 'utf8');
const BR_POST = readFileSync(join(FIX, 'borderreport-post-3078323.json'), 'utf8');

const registry = loadRegistry();
const BR = registry.find(s => s.id === 'borderreport');
const TT = registry.find(s => s.id === 'texastribune');
const THIN = [BR, TT]; // original two-outlet slice; end-to-end sweeps below script fetch for exactly these

function res(status, body = '', headers = {}, url = '') {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, url, headers: { get: k => h.get(k.toLowerCase()) ?? null }, text: async () => body };
}

// Scripted fetch: routes by URL substring, records every call (url + headers).
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    for (const [needle, handler] of routes) if (url.includes(needle)) return typeof handler === 'function' ? handler(url, opts) : handler;
    return res(404, 'not found');
  };
  fn.calls = calls;
  return fn;
}

const ROBOTS_OK = res(200, 'User-agent: *\nDisallow: /wp-admin/\n');
const fast = { politeDelayMs: 0 };

function tmpDir() { return mkdtempSync(join(tmpdir(), 'crucix-border-')); }

// --- registry -------------------------------------------------------------------

test('registry: every verified outlet present with required provenance metadata', () => {
  assert.deepEqual(registry.map(s => s.id), ['borderreport', 'texastribune', 'valleycentral', 'zetatijuana', 'borderlandbeat', 'justiceinmexico', 'insightcrime-mexico', 'milenio', 'elpasomatters', 'fronterasdesk']);
  for (const s of registry) {
    for (const f of ['id', 'outlet', 'feedUrl', 'language', 'countryOfPublication', 'regionTag', 'reliability', 'discoveryDate']) assert.ok(s[f], `${s.id}.${f}`);
    assert.equal(s.reliability, 'ungraded');
    assert.match(s.discoveryDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(s.feedUrl.startsWith('https://'));
  }
});

test('README Border Watch section names every registered outlet and no unregistered one', () => {
  const readme = readFileSync(join(FIX, '..', '..', '..', 'README.md'), 'utf8');
  const section = readme.split('### Border Watch')[1].split('\n### ')[0];
  const base = o => o.replace(/\s*\(.*\)$/, '');
  for (const s of registry) assert.ok(section.includes(base(s.outlet)), `README lacks ${s.outlet}`);
  const listed = section.match(/^Registered outlets: (.*?)\. Per-source/ms)[1];
  const named = listed.split(/, (?:and )?/).map(x => x.replace(/\s*\(.*$/, '').replace(/'s.*$/, '').trim());
  assert.deepEqual(named.sort(), registry.map(s => base(s.outlet)).sort());
});

test('registry: validation rejects bad entries', () => {
  assert.throws(() => validateRegistry({ sources: [{ id: 'x', outlet: 'X' }] }), /missing/);
  assert.throws(() => validateRegistry({ sources: [{ ...BR, reliability: 'great' }] }), /reliability/);
  assert.throws(() => validateRegistry({ sources: [{ ...BR, feedUrl: 'http://insecure.example/feed' }] }), /https/);
  assert.throws(() => validateRegistry({ sources: [BR, { ...TT, id: 'borderreport' }] }), /duplicate/);
});

// --- feed parsing against recorded payloads -----------------------------------------

test('Border Report fixture parses to 10 items with title/link/guid/date/categories', () => {
  const items = parseFeed(BR_FEED);
  assert.equal(items.length, 10);
  const first = items[0];
  assert.match(first.title, /Juárez tunnel/);
  assert.ok(first.link.startsWith('https://www.borderreport.com/news/'));
  assert.equal(wpPostId(first.guid), '3078323');
  assert.ok(first.published);
  assert.ok(first.categories.includes('Immigration'));
});

test('Texas Tribune fixture parses to 20 items; tracking pixel stripped from description', () => {
  const items = parseFeed(TT_FEED);
  assert.equal(items.length, 20);
  const paxton = items.find(i => /MAGA Inc/.test(i.title));
  assert.ok(paxton);
  assert.ok(!/<img/i.test(paxton.description), 'description must be plain text');
  assert.ok(paxton.link.startsWith('https://feeds.texastribune.org/link/'));
  assert.equal(wpPostId(paxton.guid), '242116');
});

// --- normalisation / provenance ---------------------------------------------------

test('normalizeItem: record carries outlet metadata, timestamps, hash, pipeline version, paywall flag', () => {
  const item = parseFeed(BR_FEED)[0];
  const rec = normalizeItem(item, BR, '2026-09-05T21:00:00.000Z');
  assert.equal(rec.outlet, 'Border Report');
  assert.equal(rec.language, 'en');
  assert.equal(rec.countryOfPublication, 'US');
  assert.equal(rec.reliability, 'ungraded');
  assert.equal(rec.collectedAt, '2026-09-05T21:00:00.000Z');
  assert.equal(rec.publishedAt, '2026-09-05T00:08:42.000Z');
  assert.equal(rec.pipelineVersion, PIPELINE_VERSION);
  assert.equal(rec.contentHash, sha256(`${rec.title}\n${rec.summary}`));
  assert.equal(rec.paywalled, false);
  assert.equal(rec.extraction.method, 'feed-description');
  assert.equal(rec.id.length, 16);
  assert.equal(rec.summary, item.description, 'feed description is stored verbatim, not summarised');
});

test('normalizeItem is deterministic and drops non-http links', () => {
  const item = parseFeed(TT_FEED)[1];
  const a = normalizeItem(item, TT, '2026-09-05T21:00:00.000Z');
  const b = normalizeItem(item, TT, '2026-09-06T21:00:00.000Z');
  assert.equal(a.id, b.id);
  const bad = normalizeItem({ ...item, link: 'javascript:alert(1)' }, TT, 'x');
  assert.equal(bad.url, null);
});

test('normalizeUrl strips tracking params and fragments', () => {
  assert.equal(normalizeUrl('https://Example.com/a?utm_source=x&id=2#top'), 'https://example.com/a?id=2');
  assert.equal(normalizeUrl('https://example.com/a?utm_source=x'), 'https://example.com/a');
  assert.equal(normalizeUrl('ftp://example.com/a'), null);
});

test('titleKey clusters dateline variants of the same wire headline', () => {
  const a = titleKey('EL PASO, Texas (Border Report) — Agents rescue 8 migrants from locked train car');
  const b = titleKey('Agents rescue 8 migrants from locked train car');
  assert.equal(a, b);
  assert.notEqual(titleKey('Completely different story'), a);
});

// --- tagging ---------------------------------------------------------------------

test('topic rules fire on evidence and are labelled machine-generated', () => {
  const topics = tagTopics('Border Patrol agents seized 40 pounds of fentanyl after a shooting near the rail yard').map(t => t.topic);
  assert.deepEqual(topics.sort(), ['enforcement', 'narcotics', 'rail', 'violence']);
  const rec = applyTags(normalizeItem({ title: 'Quiet day', description: '', categories: [] }, BR, 'x'));
  assert.deepEqual(rec.tags.topics, []);
  assert.equal(rec.tags.tool, TAGGER_VERSION);
});

test('bureau datelines are stripped before place tagging; in-body mentions still tag', () => {
  assert.equal(stripDateline('McALLEN, Texas (Border Report) — U.S. Rep. Joaquin Castro said'), 'U.S. Rep. Joaquin Castro said');
  assert.equal(stripDateline('EL PASO — A tunnel was found'), 'A tunnel was found');
  assert.equal(stripDateline('WASHINGTON (AP) - The Senate voted'), 'The Senate voted');
  // Not a dateline: mixed-case lead or no dash.
  assert.equal(stripDateline('El Paso officials — and others — met'), 'El Paso officials — and others — met');
  assert.equal(stripDateline('Migrants in McAllen wait for court'), 'Migrants in McAllen wait for court');
  const bureauOnly = applyTags(normalizeItem({ title: 'ICE officer released on bond', description: 'McALLEN, Texas (Border Report) — An officer charged in Minnesota was released.', categories: [] }, BR, 'x'));
  assert.deepEqual(bureauOnly.tags.places, []);
  const inBody = applyTags(normalizeItem({ title: 'Bridge reopens', description: 'McALLEN, Texas (Border Report) — The Hidalgo international bridge reopened in McAllen on Friday.', categories: [] }, BR, 'x'));
  assert.deepEqual(inBody.tags.places, ['hidalgo-tx']);
  const titled = applyTags(normalizeItem({ title: 'El Paso drains used as crossings', description: 'McALLEN, Texas (Border Report) — Agents found tunnels.', categories: [] }, BR, 'x'));
  assert.deepEqual(titled.tags.places, ['el-paso-tx']);
  assert.ok(PLACE_BY_KEY.get('el-paso-tx'));
});

test('gazetteer: every place has coords + sector; Laredo/Nuevo Laredo and Nogales AZ/Sonora disambiguate', () => {
  for (const p of PLACES) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), p.key);
    assert.ok(p.sector, p.key);
    assert.ok(p.aliases.length, p.key);
  }
  assert.equal(new Set(PLACE_KEYS).size, PLACES.length);
  assert.deepEqual(tagPlaces('Shooting in Nuevo Laredo').map(p => p.key), ['nuevo-laredo-tamps']);
  assert.deepEqual(tagPlaces('Bridge closed in Laredo').map(p => p.key), ['webb-tx']);
  assert.deepEqual(tagPlaces('Seizure at Nogales, Sonora crossing').map(p => p.key), ['nogales-son']);
  assert.deepEqual(tagPlaces('Seizure at Nogales port').map(p => p.key), ['santa-cruz-az']);
  assert.deepEqual(tagPlaces('McAllen and Ciudad Juárez').map(p => p.key).sort(), ['hidalgo-tx', 'juarez-chih']);
});

// --- conditional polling -------------------------------------------------------------

test('conditionalHeaders sends If-None-Match / If-Modified-Since only when known, with the CRUCIX UA', () => {
  const h0 = conditionalHeaders({});
  assert.equal(h0['User-Agent'], CRAWLER_UA);
  assert.equal(h0['If-None-Match'], undefined);
  const h1 = conditionalHeaders({ etag: '"abc"', lastModified: 'Sat, 05 Sep 2026 00:09:58 GMT' });
  assert.equal(h1['If-None-Match'], '"abc"');
  assert.equal(h1['If-Modified-Since'], 'Sat, 05 Sep 2026 00:09:58 GMT');
});

test('classifyHttp: 304 unchanged, 403/406/429 blocked, 5xx error', () => {
  assert.equal(classifyHttp(304), 'not_modified');
  assert.equal(classifyHttp(403), 'blocked');
  assert.equal(classifyHttp(406), 'blocked');
  assert.equal(classifyHttp(429), 'blocked');
  assert.equal(classifyHttp(503), 'error');
  assert.equal(classifyHttp(200), 'ok');
});

test('pollFeed: 200 returns items + validators; 304 is a successful unchanged poll that keeps validators', async () => {
  resetForTests();
  const f = mockFetch([['borderreport.com/feed', res(200, BR_FEED, { ETag: '"e1"', 'Last-Modified': 'Sat, 05 Sep 2026 00:09:58 GMT' })]]);
  const p1 = await pollFeed(BR, {}, f, fast);
  assert.equal(p1.status, 'ok');
  assert.equal(p1.items.length, 10);
  assert.equal(p1.etag, '"e1"');
  assert.equal(p1.feedTitle, 'BorderReport');

  const f2 = mockFetch([['borderreport.com/feed', res(304)]]);
  const p2 = await pollFeed(BR, { etag: '"e1"', lastModified: p1.lastModified }, f2, fast);
  assert.equal(p2.status, 'not_modified');
  assert.equal(p2.items.length, 0);
  assert.equal(p2.etag, '"e1"');
  assert.equal(f2.calls[0].headers['If-None-Match'], '"e1"');
});

test('pollFeed: empty feed, blocked, and network failure are reported distinctly and never throw', async () => {
  resetForTests();
  const empty = await pollFeed(BR, {}, mockFetch([['feed', res(200, '<rss><channel><title>x</title></channel></rss>')]]), fast);
  assert.equal(empty.status, 'empty');
  const blocked = await pollFeed(BR, {}, mockFetch([['feed', res(406, 'bot')]]), fast);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'HTTP 406');
  const down = await pollFeed(BR, {}, async () => { throw new Error('fetch failed'); }, fast);
  assert.equal(down.status, 'error');
  assert.equal(down.reason, 'fetch failed');
});

// --- robots + article retrieval ---------------------------------------------------------

test('robots parser: longest match wins, agent-specific groups override *, crawl-delay read', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public/\nCrawl-delay: 2\n\nUser-agent: Scrapy\nDisallow: /\n');
  assert.equal(isAllowedByRules(rules, '/news/x'), true);
  assert.equal(isAllowedByRules(rules, '/private/x'), false);
  assert.equal(isAllowedByRules(rules, '/private/public/x'), true);
  assert.equal(isAllowedByRules(rules, '/anything', 'scrapy'), false);
  assert.equal(isAllowedByRules(parseRobots('User-agent: *\nDisallow: /*.pdf$\n'), '/a/b.pdf'), false);
  assert.equal(isAllowedByRules(parseRobots('User-agent: *\nDisallow:\n'), '/x'), true);
});

test('checkRobots fails open on 404 and honours a Disallow for our path', async () => {
  resetRobotsCacheForTests();
  const ok = await checkRobots('https://a.example/wp-json/x', { fetch: mockFetch([['robots.txt', res(404)]]) });
  assert.equal(ok.allowed, true);
  const no = await checkRobots('https://b.example/wp-json/x', { fetch: mockFetch([['robots.txt', res(200, 'User-agent: *\nDisallow: /wp-json/')]]) });
  assert.equal(no.allowed, false);
});

test('article extractor: paragraphs from <article>, canonical, boilerplate dropped, paywall detected not bypassed', () => {
  const html = `<html><head><link rel="canonical" href="https://apnews.com/article/abc"><meta property="og:title" content="Headline"></head>
  <body><nav>Home Subscribe</nav><article><p>${'Body sentence one that is long enough to count as copy.'} </p><p>Sign up for our newsletter today.</p><p>Second real paragraph with substantive content in it, ending here.</p></article></body></html>`;
  const a = extractArticle(html);
  assert.equal(a.canonical, 'https://apnews.com/article/abc');
  assert.equal(a.title, 'Headline');
  assert.equal(a.paragraphs, 2);
  assert.equal(a.paywalled, false);
  assert.equal(a.method, 'article-tag');

  const wall = extractArticle('<html><body><article><p>Subscribe to continue reading this story.</p></article><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"headline":"H"}</script></body></html>');
  assert.equal(wall.paywalled, true);
});

test('htmlToText/bodyParagraphs keep publisher paragraphs verbatim', () => {
  const t = htmlToText('<p class="wp-block-paragraph">McALLEN — A U.S. officer &amp; a judge.</p>\n\n<p>Second.</p><div class="ad">x</div>');
  assert.equal(t, 'McALLEN — A U.S. officer & a judge.\nSecond.\nx');
  assert.deepEqual(bodyParagraphs(t, { minLen: 5 }), ['McALLEN — A U.S. officer & a judge.', 'Second.']);
  assert.deepEqual(bodyParagraphs('Real paragraph here.\nRead more: click\nCopyright 2026 Nexstar', { minLen: 5 }), ['Real paragraph here.']);
});

test('enrichArticle via WP REST: body text, canonical from API, wire-copy marked syndicated, hash = sha256(text)', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const item = parseFeed(TT_FEED).find(i => wpPostId(i.guid) === '242108');
  const rec = normalizeItem(item, TT, '2026-09-05T21:00:00.000Z');
  const f = mockFetch([['robots.txt', ROBOTS_OK], ['/wp-json/wp/v2/posts/242108', res(200, TT_POST)]]);
  await enrichArticle(rec, TT, f, fast);
  assert.equal(rec.extraction.method, 'wp-rest');
  assert.equal(rec.extraction.fetchStatus, 'ok');
  assert.ok(rec.textChars > 1000);
  assert.match(rec.text, /^McALLEN/);
  assert.ok(!/<[a-z]+[^>]*>/i.test(rec.text), 'text must contain no HTML tags');
  assert.equal(rec.canonicalUrl.startsWith('https://apnews.com/'), true);
  assert.equal(rec.syndicated, true);
  assert.equal(rec.wireSource, 'apnews.com');
  assert.equal(rec.contentHash, sha256(rec.text));
  assert.equal(rec.paywalled, false);
  const apiCall = f.calls.find(c => c.url.includes('/wp-json/'));
  assert.equal(apiCall.headers['User-Agent'], CRAWLER_UA);
  assert.equal(f.calls.some(c => c.url.includes('feeds.texastribune.org/link')), false, 'API preferred over page scrape');
});

test('enrichArticle: API blocked + page 403 keeps feed-level record and records why (no retry storms)', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const rec = normalizeItem(parseFeed(BR_FEED)[0], BR, '2026-09-05T21:00:00.000Z');
  const f = mockFetch([['robots.txt', ROBOTS_OK], ['/wp-json/', res(403, 'denied')], ['borderreport.com/news/', res(403, 'denied')]]);
  await enrichArticle(rec, BR, f, fast);
  assert.equal(rec.text, null);
  assert.equal(rec.extraction.method, 'feed-description');
  assert.equal(rec.extraction.fetchStatus, 'blocked (403)');
  assert.ok(rec.title && rec.summary && rec.url && rec.publishedAt, 'headline/summary/url/timestamp retained');
  assert.equal(f.calls.filter(c => c.url.includes('/wp-json/')).length, 1);
});

test('enrichArticle: robots Disallow stops both API and page fetches', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const rec = normalizeItem(parseFeed(BR_FEED)[1], BR, '2026-09-05T21:00:00.000Z');
  const f = mockFetch([['robots.txt', res(200, 'User-agent: *\nDisallow: /')]]);
  await enrichArticle(rec, BR, f, fast);
  assert.equal(rec.extraction.fetchStatus, 'robots-disallowed');
  assert.equal(f.calls.filter(c => !c.url.includes('robots.txt')).length, 0);
});

test('enrichArticle: paywalled page keeps headline/summary/url and sets paywalled=true', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const src = { ...BR, articleApi: null };
  const rec = normalizeItem(parseFeed(BR_FEED)[2], src, '2026-09-05T21:00:00.000Z');
  const html = '<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script></head><body><article><p>Subscribe to continue reading.</p></article></body></html>';
  const f = mockFetch([['robots.txt', ROBOTS_OK], ['www.borderreport.com/', res(200, html, {}, rec.url)]]);
  await enrichArticle(rec, src, f, fast);
  assert.equal(f.calls.some(c => c.url === rec.url), true, 'article page fetched once');
  assert.equal(rec.paywalled, true);
  assert.equal(rec.text, null);
  assert.equal(rec.extraction.fetchStatus, 'paywalled');
});

// --- store / dedupe / baselines -----------------------------------------------------------

test('mergeIntoStore dedupes on id, refreshes changed records, clusters same headline across outlets', () => {
  const store = [];
  const a = applyTags(normalizeItem({ title: 'Agents rescue 8 migrants from locked train car', link: 'https://a.example/1', guid: 'a1', description: 'x', categories: [] }, BR, 't1'));
  const b = applyTags(normalizeItem({ title: 'LAREDO, Texas (AP) — Agents rescue 8 migrants from locked train car', link: 'https://b.example/2', guid: 'b2', description: 'y', categories: [] }, TT, 't1'));
  let r = mergeIntoStore(store, [a, b]);
  assert.deepEqual(r, { added: 2, updated: 0 });
  assert.equal(store[1].clusterId, store[0].id);
  r = mergeIntoStore(store, [normalizeItem({ title: 'Agents rescue 8 migrants from locked train car', link: 'https://a.example/1', guid: 'a1', description: 'x', categories: [] }, BR, 't2')]);
  assert.deepEqual(r, { added: 0, updated: 0 }, 'identical content is a no-op');
  r = mergeIntoStore(store, [normalizeItem({ title: 'Agents rescue 8 migrants from locked train car', link: 'https://a.example/1', guid: 'a1', description: 'updated', categories: [] }, BR, 't3')]);
  assert.deepEqual(r, { added: 0, updated: 1 });
  assert.equal(store.length, 2);
  assert.equal(store[0].collectedAt, 't1', 'first-seen timestamp preserved');
  assert.equal(store[0].updatedAt, 't3');
});

test('spike detector: silent until baseline coverage exists, then flags 24h counts vs trailing mean with evidence ids', () => {
  const now = Date.parse('2026-09-05T21:00:00Z');
  const day = 86_400_000;
  const mk = (i, t, places, topics) => ({ id: `id${i}`, title: `t${i}`, publishedAt: new Date(t).toISOString(), collectedAt: new Date(t).toISOString(), tags: { topics, places, tool: 'x' } });
  const cold = [0, 1, 2].map(i => mk(i, now - i * 3_600_000, ['webb-tx'], ['narcotics']));
  assert.equal(baselineCoverage(cold, now).ready, false);
  assert.deepEqual(detectSpikes(cold, now), []);

  const warm = [...cold];
  for (let d = 2; d <= 20; d++) warm.push(mk(100 + d, now - d * day, ['webb-tx'], d % 5 === 0 ? ['narcotics'] : ['governance']));
  assert.equal(baselineCoverage(warm, now).ready, true);
  const flags = detectSpikes(warm, now);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].place, 'webb-tx');
  assert.equal(flags[0].topic, 'narcotics');
  assert.equal(flags[0].count24h, 3);
  assert.deepEqual(flags[0].articleIds, ['id0', 'id1', 'id2']);
  assert.ok(flags[0].baselineDailyMean > 0 && flags[0].ratio >= 3);
  assert.equal(flags.some(f => f.topic === 'governance'), false);
});

test('summarizeStore counts topics/places/outlets inside the window only', () => {
  const now = Date.parse('2026-09-05T21:00:00Z');
  const store = [
    { outlet: 'A', publishedAt: new Date(now - 1000).toISOString(), tags: { topics: ['violence'], places: ['webb-tx'] } },
    { outlet: 'B', publishedAt: new Date(now - 40 * 86_400_000).toISOString(), tags: { topics: ['violence'], places: ['webb-tx'] } },
  ];
  const s = summarizeStore(store, now, 30);
  assert.equal(s.articlesInWindow, 1);
  assert.equal(s.topicCounts.violence, 1);
  assert.deepEqual(s.places.map(p => [p.key, p.count, p.sector]), [['webb-tx', 1, 'Laredo']]);
  assert.deepEqual(Object.keys(s.topicCounts).sort(), [...TOPIC_KEYS].sort());
});

// --- full sweep ------------------------------------------------------------------------

test('briefing: first sweep ingests both fixtures, persists store/state/raw, is classified live', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const dataDir = tmpDir();
  const f = mockFetch([
    ['robots.txt', ROBOTS_OK],
    ['borderreport.com/feed', res(200, BR_FEED, { ETag: '"br1"', 'Last-Modified': 'Sat, 05 Sep 2026 00:09:58 GMT' })],
    ['feeds.texastribune.org/feeds/main', res(200, TT_FEED, { ETag: '"tt1"' })],
    ['texastribune.org/wp-json/wp/v2/posts/242108', res(200, TT_POST)],
    ['borderreport.com/wp-json/wp/v2/posts/3078323', res(200, BR_POST)],
    ['/wp-json/', res(403, 'denied')],
    ['borderreport.com/news/', res(403, 'denied')],
    ['feeds.texastribune.org/link/', res(403, 'denied')],
  ]);
  const now = Date.parse('2026-09-05T21:00:00Z');
  const out = await briefing({ registry: THIN, fetch: f, dataDir, now, maxArticleFetch: 2, politeDelayMs: 0 });
  assert.equal(out.source, 'BorderNews');
  assert.equal(out.status, 'live');
  assert.equal(out.totalArticles, 30);
  assert.equal(out.newThisSweep, 30);
  assert.equal(out.feeds.length, 2);
  const br = out.feeds.find(x => x.id === 'borderreport');
  assert.equal(br.status, 'ok');
  assert.equal(br.etag, '"br1"');
  assert.equal(br.articleFetch.attempted, 2);
  assert.equal(br.articleFetch.ok, 1);
  assert.equal(br.articleFetch.blocked, 1);
  assert.equal(br.articleFetch.skipped, 8);
  assert.ok(out.articles.length <= 40 && out.articles.every(a => a.text === undefined), 'sweep payload omits full text');
  const tunnel = out.articles.find(a => /Juárez tunnel/.test(a.title));
  assert.equal(tunnel.extraction.method, 'wp-rest');
  assert.ok(tunnel.excerpt.startsWith('EL PASO'));
  assert.ok(tunnel.tags.places.includes('el-paso-tx') && tunnel.tags.places.includes('juarez-chih'));
  assert.ok(existsSync(join(dataDir, 'articles.json')) && existsSync(join(dataDir, 'state.json')));
  assert.equal(readdirSync(join(dataDir, 'raw')).length, 2);
  assert.equal(out.summary.outletCounts['Border Report'], 10);
  assert.equal(classifySource('BorderNews', out).state, 'live');

  // second sweep: both 304 -> unchanged + still live, validators sent, feeds not re-parsed;
  // spare budget drains one skipped record per feed from the backlog.
  const f2 = mockFetch([
    ['borderreport.com/feed', res(304)], ['feeds.texastribune.org/feeds/main', res(304)],
    ['/wp-json/', res(403, 'denied')], ['borderreport.com/', res(403, 'denied')], ['feeds.texastribune.org/link/', res(403, 'denied')],
  ]);
  const out2 = await briefing({ registry: THIN, fetch: f2, dataDir, now: now + 900_000, maxArticleFetch: 1, politeDelayMs: 0 });
  assert.equal(out2.status, 'live');
  assert.equal(out2.newThisSweep, 0);
  assert.equal(out2.totalArticles, 30);
  assert.ok(out2.feeds.every(x => x.status === 'not_modified' && x.items === 0));
  const feedPolls = f2.calls.filter(c => /\/feed\/$|\/feeds\/main\/$/.test(c.url));
  assert.equal(feedPolls.length, 2);
  assert.equal(feedPolls.find(c => c.url.includes('borderreport')).headers['If-None-Match'], '"br1"');
  assert.equal(feedPolls.find(c => c.url.includes('texastribune')).headers['If-None-Match'], '"tt1"');
  assert.deepEqual(out2.feeds.map(x => x.articleFetch.backlog), [1, 1]);
  assert.equal(classifySource('BorderNews', out2).state, 'live');
  const remaining = queryArticles({ days: 30 }, { dataDir, now }).articles.filter(a => a.extraction.fetchStatus.startsWith('skipped')).length;
  assert.equal(remaining, 26 - 2);

  // catch-up is skipped when the enrichment time budget is already spent
  const f3 = mockFetch([['borderreport.com/feed', res(304)], ['feeds.texastribune.org/feeds/main', res(304)]]);
  const out3 = await briefing({ registry: THIN, fetch: f3, dataDir, now: now + 1_800_000, enrichBudgetMs: 0, politeDelayMs: 0 });
  assert.equal(f3.calls.length, 2, 'no article fetches once the budget is exhausted');
  assert.equal(out3.status, 'live');
  assert.equal(out3.retaggedThisSweep, 0);

  // stored records tagged by an older rule set are re-tagged in place on the next sweep
  const storePath = join(dataDir, 'articles.json');
  const stale = JSON.parse(readFileSync(storePath, 'utf8'));
  for (const r of stale) { r.tags = { topics: [], places: ['yuma-az'], tool: 'crucix-rules/0' }; }
  writeFileSync(storePath, JSON.stringify(stale));
  const out4 = await briefing({ registry: THIN, fetch: mockFetch([['borderreport.com/feed', res(304)], ['feeds.texastribune.org/feeds/main', res(304)]]), dataDir, now: now + 2_700_000, enrichBudgetMs: 0, politeDelayMs: 0 });
  assert.equal(out4.retaggedThisSweep, 30);
  assert.ok(out4.articles.every(a => a.tags.tool === TAGGER_VERSION && !a.tags.places.includes('yuma-az')));

  // query API helper honours filters
  const q = queryArticles({ place: 'el-paso-tx', topic: 'enforcement', days: 30 }, { dataDir, now });
  assert.ok(q.count >= 1 && q.articles.every(a => a.tags.places.includes('el-paso-tx')));
  assert.equal(queryArticles({ place: 'yuma-az', days: 30 }, { dataDir, now }).count, 0);
});

test('briefing: one feed blocked -> partial/degraded; all feeds down with history -> stale; cold + down -> error', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const dataDir = tmpDir();
  const now = Date.parse('2026-09-05T21:00:00Z');
  const partial = await briefing({ registry: THIN, fetch: mockFetch([['robots.txt', ROBOTS_OK], ['borderreport.com/feed', res(200, BR_FEED)], ['texastribune', res(406, 'bot')]]), dataDir, now, fetchArticles: false, politeDelayMs: 0 });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.totalArticles, 10);
  assert.equal(partial.feeds.find(x => x.id === 'texastribune').status, 'blocked');
  assert.equal(classifySource('BorderNews', partial).state, 'degraded');

  const stale = await briefing({ registry: THIN, fetch: async () => { throw new Error('ENOTFOUND'); }, dataDir, now: now + 1000, fetchArticles: false, politeDelayMs: 0 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.totalArticles, 10, 'stored articles still served');
  const h = classifySource('BorderNews', stale);
  assert.equal(h.state, 'degraded');
  assert.equal(h.reason, 'stale');

  const cold = await briefing({ registry: THIN, fetch: async () => { throw new Error('ENOTFOUND'); }, dataDir: tmpDir(), now, fetchArticles: false, politeDelayMs: 0 });
  assert.equal(cold.status, 'error');
  assert.match(cold.error, /all feeds failed/);
  assert.equal(classifySource('BorderNews', cold).state, 'error');
});

test('briefing: reachable feeds with zero items is "empty" -> degraded, not live', async () => {
  resetForTests();
  const emptyRss = '<rss><channel><title>x</title></channel></rss>';
  const out = await briefing({ registry: THIN, fetch: mockFetch([['feed', res(200, emptyRss)], ['feeds/main', res(200, emptyRss)]]), dataDir: tmpDir(), now: Date.now(), fetchArticles: false, politeDelayMs: 0 });
  assert.equal(out.status, 'empty');
  assert.equal(classifySource('BorderNews', out).state, 'degraded');
});

test('briefing: invalid registry is reported as an error, not thrown', async () => {
  const out = await briefing({ registryFile: join(FIX, 'borderreport-feed.xml'), dataDir: tmpDir(), persist: false });
  assert.equal(out.status, 'error');
  assert.match(out.error, /registry invalid/);
});

// --- verified outlets added 2026-09-06: recorded payloads + per-source policy ---------

const load = f => readFileSync(join(FIX, f), 'utf8');
const src = id => registry.find(s => s.id === id);

test('ValleyCentral / Zeta / Justice in Mexico / InSight Crime MX fixtures parse as WordPress RSS with ?p= guids', () => {
  const cases = [
    ['valleycentral-feed.xml', 14, 'https://www.valleycentral.com/?p=3302830', 'https://www.valleycentral.com/'],
    ['zetatijuana-feed.xml', 10, 'https://zetatijuana.com/?p=521885', 'https://zetatijuana.com/'],
    ['justiceinmexico-feed.xml', 3, 'https://justiceinmexico.org/?p=26268', 'https://justiceinmexico.org/'],
    ['insightcrime-mexico-feed.xml', 4, 'https://insightcrime.org/?p=351087', 'https://insightcrime.org/'],
  ];
  for (const [file, count, guid, origin] of cases) {
    const items = parseFeed(load(file));
    assert.equal(items.length, count, file);
    assert.equal(items[0].guid, guid, file);
    assert.ok(items.every(i => i.link.startsWith(origin) && i.title && i.published), `${file}: link/title/date`);
    assert.equal(wpPostId(items[0].guid), guid.split('?p=')[1]);
  }
});

test('Borderland Beat Atom (Blogger, single-quoted attributes) parses link/categories and carries full post text', () => {
  const items = parseFeed(load('borderlandbeat-feed.xml'));
  assert.equal(items.length, 3);
  assert.ok(items.every(i => /^https:\/\/www\.borderlandbeat\.com\/2026\/\d{2}\/.+\.html$/.test(i.link)), JSON.stringify(items.map(i => i.link)));
  assert.ok(items.every(i => i.guid.startsWith('tag:blogger.com,1999:')));
  const labelled = parseFeed("<feed xmlns='http://www.w3.org/2005/Atom'><entry><id>tag:x</id><title type='text'>T</title><category scheme='http://www.blogger.com/atom/ns#' term='Tamaulipas'/><link rel='replies' href='https://x.example/c'/><link rel='alternate' type='text/html' href='https://x.example/p.html'/></entry></feed>");
  assert.deepEqual(labelled, [{ ...labelled[0], link: 'https://x.example/p.html', categories: ['Tamaulipas'] }]);
  const recs = items.map(i => applyTags(normalizeItem(i, src('borderlandbeat'), '2026-09-06T00:00:00Z')));
  const full = recs.filter(r => r.extraction.method === 'feed-content');
  assert.ok(full.length >= 2, 'long Atom <content> becomes the record text');
  assert.ok(full.every(r => r.textChars >= 1500 && r.text.length === r.textChars && r.contentHash === sha256(r.text)));
  assert.ok(recs.some(r => r.tags.topics.includes('narcotics')));
});

test('Milenio Google News sitemap parses via parseFeed with news:title / publication_date / keywords', () => {
  const xml = load('milenio-news-sitemap.xml');
  assert.ok(isNewsSitemap(xml) && !isNewsSitemap(BR_FEED));
  const items = parseFeed(xml);
  assert.equal(items.length, 14);
  assert.ok(items.every(i => i.link.startsWith('https://www.milenio.com/') && i.guid === i.link && i.title && i.published && i.description === ''));
  assert.ok(items.every(i => i.publication === 'Milenio' && i.language === 'es'));
  assert.ok(items[0].categories.length > 3, 'news:keywords -> categories');
  assert.deepEqual(feedMeta(xml), { title: '', updated: null });
});

test('Spanish headlines are topic/place tagged', () => {
  const t = s => tagTopics(s).map(x => x.topic).sort();
  assert.deepEqual(t('Asesinan a hombre a balazos; Guardia Nacional detiene a dos sicarios con fentanilo'), ['enforcement', 'narcotics', 'violence']);
  assert.deepEqual(t('Migrantes en albergues de Tijuana esperan cita de asilo'), ['migration']);
  assert.deepEqual(t('Gobernador anuncia aranceles al comercio por el T-MEC'), ['governance', 'trade']);
  const p = s => tagPlaces(s).map(x => x.key).sort();
  assert.deepEqual(p('Cae presunto extorsionador de floristas en Reynosa'), ['reynosa-tamps']);
  assert.deepEqual(p('Operativo en Nuevo Laredo y Piedras Negras'), ['nuevo-laredo-tamps', 'piedras-negras-coah']);
});

test('matchesPathPrefixes gates sitemap URLs by section', () => {
  assert.equal(matchesPathPrefixes('https://www.milenio.com/policia/x', ['/policia', '/estados']), true);
  assert.equal(matchesPathPrefixes('https://www.milenio.com/politica/', ['/politica']), true);
  assert.equal(matchesPathPrefixes('https://www.milenio.com/policiales/x', ['/policia']), false, 'prefix must end at a path segment');
  assert.equal(matchesPathPrefixes('https://www.milenio.com/deportes/x', ['/policia']), false);
  assert.equal(matchesPathPrefixes('not a url', ['/policia']), false);
  assert.equal(matchesPathPrefixes('https://x.example/anything', undefined), true);
  assert.equal(matchesPathPrefixes('https://x.example/anything', []), true);
});

test('registry validation: feedType / fetchArticles / requirePlaceTag / pathPrefixes', () => {
  assert.throws(() => validateRegistry({ sources: [{ ...BR, feedType: 'json' }] }), /feedType/);
  assert.throws(() => validateRegistry({ sources: [{ ...BR, fetchArticles: 'no' }] }), /fetchArticles/);
  assert.throws(() => validateRegistry({ sources: [{ ...BR, requirePlaceTag: 1 }] }), /requirePlaceTag/);
  assert.throws(() => validateRegistry({ sources: [{ ...BR, pathPrefixes: [] }] }), /pathPrefixes/);
  assert.throws(() => validateRegistry({ sources: [{ ...BR, pathPrefixes: ['policia'] }] }), /pathPrefixes/);
  assert.doesNotThrow(() => validateRegistry({ sources: [{ ...BR, feedType: 'news-sitemap', fetchArticles: false, requirePlaceTag: true, pathPrefixes: ['/policia'] }] }));
  const m = src('milenio');
  assert.equal(m.feedType, 'news-sitemap');
  assert.equal(m.fetchArticles, false);
  assert.equal(m.requirePlaceTag, true);
  assert.equal(src('insightcrime-mexico').requirePlaceTag, true);
});

test('briefing: Milenio sitemap sweep keeps only border-placed items in allowed sections, never fetches article pages', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const dataDir = tmpDir();
  const f = mockFetch([['sitemap-google-news-current-1.xml', res(200, load('milenio-news-sitemap.xml'), { ETag: '"ml1"' })]]);
  const out = await briefing({ registry: [src('milenio')], fetch: f, dataDir, now: Date.parse('2026-09-06T16:00:00Z'), politeDelayMs: 0 });
  assert.equal(out.status, 'live');
  const feed = out.feeds[0];
  assert.equal(feed.feedType, 'news-sitemap');
  assert.equal(feed.status, 'ok');
  assert.equal(feed.items, 14);
  assert.equal(feed.fetchArticles, false);
  assert.equal(feed.newItems + feed.filteredOut, 14);
  assert.equal(feed.newItems, 3, 'policia/estados items naming Reynosa/Matamoros/Tijuana');
  assert.equal(f.calls.length, 1, 'sitemap poll only — no robots/article/REST requests');
  assert.ok(out.articles.every(a => a.tags.places.length > 0 && a.outlet === 'Milenio' && a.language === 'es'));
  assert.ok(out.articles.every(a => a.extraction.fetchStatus === 'disabled (source policy: feed metadata only)'));
  assert.ok(!out.articles.some(a => /Toros de Tijuana/.test(a.title)), 'sports section filtered by pathPrefixes');
  assert.ok(out.articles.some(a => /Reynosa/.test(a.title)));

  // second sweep: 304 keeps everything, still live
  const out2 = await briefing({ registry: [src('milenio')], fetch: mockFetch([['sitemap-google-news-current-1.xml', res(304)]]), dataDir, now: Date.parse('2026-09-06T16:15:00Z'), politeDelayMs: 0 });
  assert.equal(out2.status, 'live');
  assert.equal(out2.totalArticles, 3);
});

test('briefing: empty <urlset> counts as a successful empty poll, not a failure', async () => {
  resetForTests();
  const empty = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"></urlset>';
  const out = await briefing({ registry: [src('milenio')], fetch: mockFetch([['sitemap', res(200, empty)]]), dataDir: tmpDir(), now: Date.now(), politeDelayMs: 0 });
  assert.equal(out.feeds[0].status, 'empty');
  assert.equal(out.status, 'empty');
});

test('briefing: full registry sweep with every fixture -> live, one record set per outlet, Blogger text needs no fetch', async () => {
  resetRobotsCacheForTests(); resetForTests();
  const dataDir = tmpDir();
  const f = mockFetch([
    ['borderreport.com/feed', res(200, BR_FEED)],
    ['feeds.texastribune.org/feeds/main', res(200, TT_FEED)],
    ['valleycentral.com/feed', res(200, load('valleycentral-feed.xml'))],
    ['zetatijuana.com/feed', res(200, load('zetatijuana-feed.xml'))],
    ['borderlandbeat.com/feeds/posts/default', res(200, load('borderlandbeat-feed.xml'))],
    ['justiceinmexico.org/feed', res(200, load('justiceinmexico-feed.xml'))],
    ['insightcrime.org/tag/mexico/feed', res(200, load('insightcrime-mexico-feed.xml'))],
    ['sitemap-google-news-current-1.xml', res(200, load('milenio-news-sitemap.xml'))],
    ['elpasomatters.org/feed', res(200, load('elpasomatters-feed.xml'))],
    ['kjzz.org/fronteras-desk.rss', res(200, load('fronterasdesk-feed.xml'))],
  ]);
  const out = await briefing({ fetch: f, dataDir, now: Date.parse('2026-09-06T16:00:00Z'), fetchArticles: false, politeDelayMs: 0 });
  assert.equal(out.status, 'live');
  assert.equal(out.feeds.length, 10);
  assert.ok(out.feeds.every(x => x.status === 'ok'), JSON.stringify(out.feeds.map(x => [x.id, x.status])));
  assert.equal(f.calls.length, 10, 'one poll per source, no article fetches');
  const stored = JSON.parse(readFileSync(join(dataDir, 'articles.json'), 'utf8'));
  const bySource = {};
  for (const a of stored) bySource[a.sourceId] = (bySource[a.sourceId] || 0) + 1;
  // JiM: 3 items, one (Feb 2026) is past the 90-day retention window. InSight Crime MX: none of the 4 Mexico-wide items names a border place.
  assert.deepEqual(bySource, { borderreport: 10, texastribune: 20, valleycentral: 14, zetatijuana: 10, borderlandbeat: 3, justiceinmexico: 2, milenio: 3, elpasomatters: 3, fronterasdesk: 3 });
  assert.equal(out.feeds.find(x => x.id === 'insightcrime-mexico').filteredOut, 4, 'requirePlaceTag drops Mexico-wide items without a border place');
  assert.equal(out.totalArticles, stored.length);
  const bb = stored.filter(a => a.sourceId === 'borderlandbeat' && a.extraction.method === 'feed-content');
  assert.ok(bb.length >= 2 && bb.every(a => a.extraction.fetchStatus === 'not needed (full text in feed)'));
  assert.ok(stored.every(a => a.language === src(a.sourceId).language && a.countryOfPublication === src(a.sourceId).countryOfPublication));
  assert.equal(classifySource('BorderNews', out).state, 'live');
});

// --- El Paso Matters / Fronteras Desk (recorded 2026-09-07) --------------------------------

test('Borderland Beat is a citizen aggregator (grade-D input to the Narco event pipeline), never a news outlet', () => {
  assert.equal(src('borderlandbeat').sourceType, 'citizen-aggregator');
});

test('Fronteras Desk fixture: KJZZ summaries-only feed, guid = article URL, article page fetched under robots', async () => {
  const FD = src('fronterasdesk');
  const items = parseFeed(readFileSync(join(FIX, 'fronterasdesk-feed.xml'), 'utf8'));
  assert.equal(items.length, 3);
  assert.equal(items[0].guid, items[0].link);
  assert.ok(items[0].link.startsWith('https://www.kjzz.org/fronteras-desk/2026-'));
  assert.ok(items[0].published && items[0].description.length < 400);
  assert.equal(FD.articleApi, undefined);
  const rec = normalizeItem(items[0], FD, '2026-09-07T20:30:00Z');
  assert.equal(rec.extraction.fetchStatus, 'not attempted');
  assert.equal(rec.text, null);

  resetRobotsCacheForTests(); resetForTests();
  const page = '<html><head><title>t</title></head><body><article>' + Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} of the Fronteras Desk story about the Sonora desert reserve and the border wall assessment mission.</p>`).join('') + '</article></body></html>';
  const f = mockFetch([['robots.txt', res(200, 'User-agent: *\nDisallow:\n')], ['kjzz.org/fronteras-desk.rss', res(200, readFileSync(join(FIX, 'fronterasdesk-feed.xml'), 'utf8'))], ['kjzz.org/fronteras-desk/2026-', res(200, page)]]);
  const out = await briefing({ registry: [FD], fetch: f, dataDir: tmpDir(), now: Date.parse('2026-09-07T21:00:00Z'), maxArticleFetch: 1, politeDelayMs: 0 });
  assert.equal(out.status, 'live');
  assert.equal(out.totalArticles, 3);
  assert.equal(out.feeds[0].articleFetch.ok, 1);
  assert.equal(out.feeds[0].articleFetch.skipped, 2);
  assert.ok(out.articles.some(a => a.extraction.method === 'page:article-tag'));
});

test('El Paso Matters fixture: WordPress guid resolves to a post id for the public REST API', () => {
  const EPM = src('elpasomatters');
  const items = parseFeed(readFileSync(join(FIX, 'elpasomatters-feed.xml'), 'utf8'));
  assert.equal(items.length, 3);
  assert.match(items[0].guid, /^https:\/\/elpasomatters\.org\/\?p=\d+$/);
  assert.equal(wpPostId(items[0].guid), items[0].guid.split('=')[1]);
  assert.equal(EPM.articleApi, 'wp-rest');
  assert.match(EPM.license, /BY-ND/);
  const rec = normalizeItem(items[0], EPM, '2026-09-07T20:30:00Z');
  assert.equal(rec.extraction.method, 'feed-description', 'wp-rest sources still fetch the text-of-record from the API');
});
