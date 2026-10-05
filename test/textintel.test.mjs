// Text intelligence: IOC extraction (lib/text/ioc.mjs), Telegram forward/link graph + coordination
// (lib/telegram/graph.mjs), name variants (lib/targeting/variants.mjs) and their server routes. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { refang, extractIocs, collectDocuments, extractFromDocuments, IocLedger, IOC_TYPES, MAX_INDICATORS } from '../lib/text/ioc.mjs';
import { buildTelegramGraph, contentSignature, tmeChannel, pagerank, COORD_WINDOW_MIN } from '../lib/telegram/graph.mjs';
import { nameVariants, transliterateCyrillic, stripDiacritics, MAX_VARIANTS } from '../lib/targeting/variants.mjs';
import { aliasMatchers, gatherMentions, matchingSentences } from '../lib/targeting/find.mjs';
import { parseWebPreview } from '../apis/sources/telegramlive.mjs';
import { app } from '../server.mjs';

const SHA = 'a'.repeat(63) + 'b';
const TEXT = `Actor used hxxp://evil-domain[.]ru/payload.exe (C2 at 185.220.101.5, sha256 ${SHA}) exploiting CVE-2024-3400; contact admin[at]evil-domain[.]ru. Report at https://www.reuters.com/x and version 1.2.3.4. Wallet bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq; internal 10.0.0.1. File report.pdf.`;

test('ioc extraction', async (t) => {
  await t.test('refang handles hxxp, [.], (dot), [at]', () => {
    assert.equal(refang('hxxps://a[.]b(dot)c'), 'https://a.b.c');
    assert.equal(refang('hxxp://evil[.]ru'), 'http://evil.ru');
    assert.equal(refang('admin[at]evil(.)ru'), 'admin@evil.ru');
  });

  await t.test('extracts every type once, drops noise/private/version/file-name look-alikes', () => {
    const got = extractIocs(TEXT);
    const by = Object.fromEntries(got.map(i => [i.type, i.value]));
    assert.equal(by.url, 'http://evil-domain.ru/payload.exe');
    assert.equal(by.email, 'admin@evil-domain.ru');
    assert.equal(by.ip, '185.220.101.5');
    assert.equal(by.cve, 'CVE-2024-3400');
    assert.equal(by.hash, SHA);
    assert.equal(by.btc, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    assert.ok(!got.some(i => i.value.includes('reuters')), 'media host is noise');
    assert.ok(!got.some(i => i.value === '10.0.0.1'), 'private ip dropped');
    assert.ok(!got.some(i => i.value === '1.2.3.4'), 'version-like dropped');
    assert.ok(!got.some(i => i.value === 'report.pdf'), 'bare file name dropped');
    assert.ok(!got.some(i => i.type === 'domain' && i.value === 'evil-domain.ru'), 'domain consumed by url/email is not duplicated');
    const url = got.find(i => i.type === 'url');
    assert.equal(url.raw, 'hxxp://evil-domain[.]ru/payload.exe', 'original defanged spelling kept');
    for (const i of got) assert.ok(IOC_TYPES.includes(i.type));
  });

  await t.test('plain news headlines yield nothing; source host of the document is excluded', () => {
    assert.deepEqual(extractIocs('Ukraine shoots down 40 drones overnight, officials say. Zelensky v2.0'), []);
    assert.deepEqual(extractIocs('Read more at kyivindependent.com', { sourceHost: 'kyivindependent.com' }), []);
    assert.equal(extractIocs('Read more at kyivindependent.com').length, 1);
    assert.deepEqual(extractIocs(''), []);
    assert.deepEqual(extractIocs(null), []);
  });

  await t.test('collectDocuments walks newsFeed, telegram, GDELT, InSight Crime, KEV', () => {
    const docs = collectDocuments(
      { GDELT: { allArticles: [{ title: 'GDELT title about something', url: 'https://x.example/a', seendate: '20261004T000000Z' }] }, InSightCrime: { articles: [{ title: 'IC title', summary: 'summary text here', url: 'https://insightcrime.org/a' }] }, CyberKEV: { recent: [{ cveID: 'CVE-2025-0001', vendorProject: 'V', product: 'P', shortDescription: 'bad bug', dateAdded: '2026-10-01' }] } },
      { newsFeed: [{ headline: 'A headline long enough', source: 'Reuters', url: 'https://reuters.com/x', timestamp: '2026-10-04T00:00:00Z', type: 'news' }, { headline: 'short' }] },
      [{ channel: 'alpha', text: 'telegram text long enough', url: 'https://t.me/alpha/1', timestamp: '2026-10-04T00:01:00Z' }],
    );
    assert.deepEqual(docs.map(d => d.kind), ['news', 'telegram', 'gdelt', 'insightcrime', 'kev']);
    assert.equal(docs[1].source, 't.me/alpha');
    assert.equal(docs.find(d => d.kind === 'kev').url, null);
  });

  await t.test('extractFromDocuments aggregates, bounds, and flags new-this-sweep via the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crucix-ioc-'));
    try {
      const ledger = new IocLedger(dir);
      const docs = [
        { text: TEXT, source: 't.me/alpha', url: 'https://t.me/alpha/1', ts: '2026-10-04T00:00:00Z', kind: 'telegram' },
        { text: 'Patch CVE-2024-3400 now, says CISA', source: 'CISA', url: null, ts: '2026-10-04T01:00:00Z', kind: 'news' },
      ];
      const r1 = extractFromDocuments(docs, { ledger, now: Date.parse('2026-10-04T02:00:00Z') });
      assert.equal(r1.documents, 2);
      const cve = r1.indicators.find(i => i.type === 'cve');
      assert.equal(cve.count, 2);
      assert.deepEqual(cve.sources, ['t.me/alpha', 'CISA']);
      assert.equal(cve.isNew, true);
      assert.equal(cve.firstTs, '2026-10-04T00:00:00Z');
      assert.equal(cve.lastTs, '2026-10-04T01:00:00Z');
      assert.ok(cve.contexts.length === 2 && cve.contexts[0].snippet.length <= 170);
      assert.equal(r1.newThisSweep, r1.total);
      assert.equal(r1.indicators[0].type, 'cve', 'most-seen first');
      assert.ok(existsSync(join(dir, 'iocs.json')));
      // Second sweep: nothing is new, ledger persisted & reloaded
      const ledger2 = new IocLedger(dir);
      const r2 = extractFromDocuments(docs, { ledger: ledger2, now: Date.parse('2026-10-04T02:15:00Z') });
      assert.equal(r2.newThisSweep, 0);
      assert.equal(r2.indicators.find(i => i.type === 'cve').sweepsSeen, 2);
      assert.equal(JSON.parse(readFileSync(join(dir, 'iocs.json'), 'utf8')).entries['cve:CVE-2024-3400'].seen, 2);
      // Retention prune
      const ledger3 = new IocLedger(dir, { retentionHours: 1 });
      ledger3.prune(Date.parse('2026-10-05T00:00:00Z'));
      assert.equal(ledger3.size, 0);
      // Bound
      const many = Array.from({ length: MAX_INDICATORS + 50 }, (_, i) => ({ text: `CVE-2024-${String(10000 + i)}`, source: 's', url: null, ts: null, kind: 'news' }));
      const r3 = extractFromDocuments(many);
      assert.equal(r3.total, MAX_INDICATORS + 50);
      assert.equal(r3.indicators.length, MAX_INDICATORS);
      assert.equal(r3.ledger, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const T0 = Date.parse('2026-10-04T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const MSGS = [
  { id: '1', channel: 'alpha', text: 'Breaking: explosions reported near the port of Odesa tonight, multiple sources confirm', timestamp: at(0), links: ['https://x.com/a/status/1', 'https://t.me/gamma/55'], views: 1000 },
  { id: '2', channel: 'bravo', text: 'BREAKING — explosions reported near the port of Odesa tonight!! multiple sources confirm 🔥', timestamp: at(5), fwdFrom: 'alpha', links: ['https://x.com/a/status/1'], views: 200 },
  { id: '3', channel: 'gamma', text: 'unrelated weather post about rain in Kyiv for the weekend ahead', timestamp: at(9), links: [] },
  { id: '4', channel: 'alpha', text: 'another thing entirely about grain exports and shipping insurance rates', timestamp: at(200), fwdFrom: 'delta_news' },
  { id: '5', channel: 'gamma', text: 'another thing entirely about grain exports and shipping insurance rates', timestamp: at(500) },
  { id: '6', channel: 'bravo', text: 'see report https://example-site.org/report/1 for details on the strike', timestamp: at(10), links: ['https://example-site.org/report/1'] },
  { id: '7', channel: 'gamma', text: 'report here https://example-site.org/report/1?utm=x', timestamp: at(20), links: ['https://example-site.org/report/1?utm=x'] },
  { id: 'bad', channel: 'x', text: 'invalid channel name dropped', timestamp: at(1) },
];

test('telegram graph', async (t) => {
  await t.test('content signature normalizes case, emoji, punctuation, urls; short text → null', () => {
    assert.equal(contentSignature(MSGS[0].text), contentSignature(MSGS[1].text));
    assert.equal(contentSignature('too short'), null);
    assert.equal(contentSignature('check https://a.b/c and #tag @user now for the full detailed story'), 'check and now for the full detailed story');
  });

  await t.test('tmeChannel parses public channel links only', () => {
    assert.equal(tmeChannel('https://t.me/gamma/55'), 'gamma');
    assert.equal(tmeChannel('https://t.me/s/gamma'), 'gamma');
    assert.equal(tmeChannel('https://t.me/+abc'), null);
    assert.equal(tmeChannel('https://t.me/joinchat/x'), null);
    assert.equal(tmeChannel('https://x.com/gamma'), null);
    assert.equal(tmeChannel('nope'), null);
  });

  await t.test('pagerank sums to 1 and rewards in-links', () => {
    const pr = pagerank(['a', 'b', 'c'], new Map([['a', new Map([['b', 1]])], ['c', new Map([['b', 1]])]]));
    const sum = [...pr.values()].reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(pr.get('b') > pr.get('a') && pr.get('b') > pr.get('c'));
  });

  await t.test('graph: forward/mention/link edges, monitored vs referenced, coordination clusters', () => {
    const g = buildTelegramGraph(MSGS, ['alpha', 'bravo', 'gamma'], { now: T0 });
    assert.equal(g.messages, MSGS.length);
    assert.equal(g.summary.channels, 4); // alpha beta gamma + delta_news (referenced)
    assert.equal(g.summary.monitored, 3);
    assert.equal(g.summary.referenced, 1);
    const edge = (type, from, to) => g.edges.find(e => e.type === type && e.from === from && e.to === to);
    assert.equal(edge('forward', 'alpha', 'bravo').count, 1);
    assert.equal(edge('forward', 'delta_news', 'alpha').count, 1);
    assert.equal(edge('mention', 'alpha', 'gamma').count, 1);
    assert.equal(edge('link', 'alpha', 'd:x.com').count, 1);
    assert.equal(edge('link', 'bravo', 'd:example-site.org').count, 1);
    assert.equal(g.summary.forwards, 2);
    assert.equal(g.summary.mentions, 1);
    assert.equal(g.summary.links, 4);
    const alpha = g.nodes.find(n => n.id === 'alpha');
    assert.equal(alpha.kind, 'channel');
    assert.equal(alpha.posts, 2);
    assert.equal(alpha.forwardsOut, 1);
    assert.equal(alpha.forwardsIn, 1);
    assert.equal(alpha.views, 1000);
    assert.ok(g.nodes.find(n => n.id === 'delta_news').monitored === false);
    assert.ok(g.nodes.find(n => n.id === 'd:x.com').kind === 'domain');
    assert.ok(!g.nodes.some(n => n.id === 'x'), 'invalid channel dropped');
    for (const n of g.nodes.filter(n => n.kind === 'channel')) assert.ok(n.influence >= 0 && n.influence <= 1);
    assert.equal(Math.max(...g.nodes.filter(n => n.kind === 'channel').map(n => n.influence)), 1);

    // Clusters: Odesa text (5 min apart → coordinated), x.com URL (5 min), example-site URL (10 min, utm stripped), grain text (300 min → duplicate but not within window)
    const text = g.clusters.filter(c => c.kind === 'text');
    const urls = g.clusters.filter(c => c.kind === 'url');
    assert.equal(text.length, 2);
    assert.equal(urls.length, 2);
    const odesa = text.find(c => c.sample.includes('Odesa'));
    assert.equal(odesa.withinWindow, true);
    assert.equal(odesa.tightestMin, 5);
    assert.deepEqual(odesa.channels.map(c => c.channel).sort(), ['alpha', 'bravo']);
    const grain = text.find(c => c.sample.includes('grain'));
    assert.equal(grain.withinWindow, false);
    assert.equal(grain.spanMin, 300);
    assert.equal(grain.tightestMin, null);
    const rep = urls.find(c => c.key === 'https://example-site.org/report/1');
    assert.equal(rep.withinWindow, true);
    assert.equal(rep.tightestMin, 10);
    assert.equal(g.summary.coordinatedClusters, 3);
    assert.equal(g.summary.duplicateClusters, 4);
    assert.ok(g.clusters[0].withinWindow, 'coordinated clusters sort first');
    assert.ok(g.rule.includes(String(COORD_WINDOW_MIN)));
  });

  await t.test('empty input → empty graph', () => {
    const g = buildTelegramGraph([], []);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.equal(g.summary.coordinatedClusters, 0);
  });

  await t.test('parseWebPreview captures forwarded-from, body links and (percent-encoded) hashtags', () => {
    const html = `<div data-post="rybar/100"><div class="tgme_widget_message_forwarded_from accent_color">Forwarded from&nbsp;<a class="tgme_widget_message_forwarded_from_name" href="https://t.me/dva_majors/99933"><span dir="auto">Два майора</span></a></div>
      <div class="tgme_widget_message_text js-message_text" dir="auto">Text body <a href="?q=%23%D0%BF%D0%BE%D1%8F%D1%81%D0%BD%D0%B5%D0%BD%D0%B8%D0%B5">#пояснение</a> <a href="https://t.me/rybar" target="_blank">src</a> <a href="https://example.org/a?x=1&amp;y=2">ext</a></div>
      <a class="tgme_widget_message_date" href="https://t.me/rybar/100"><time datetime="2026-10-04T00:00:00+00:00"></time></a><span class="tgme_widget_message_views">12.5K</span></div>
      <div data-post="rybar/101"><div class="tgme_widget_message_text js-message_text">Plain post with no forward</div><a class="tgme_widget_message_date" href="https://t.me/rybar/101"><time datetime="2026-10-04T00:01:00+00:00"></time></a></div>`;
    const msgs = parseWebPreview(html, 'rybar');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].fwdFrom, 'dva_majors');
    assert.deepEqual(msgs[0].hashtags, ['пояснение']);
    assert.deepEqual(msgs[0].links, ['https://t.me/rybar', 'https://example.org/a?x=1&y=2']);
    assert.equal(msgs[0].views, 12500);
    assert.equal(msgs[1].fwdFrom, null);
    assert.deepEqual(msgs[1].links, []);
    assert.deepEqual(msgs[1].hashtags, []);
  });
});

test('name variants', async (t) => {
  await t.test('diacritics / cyrillic helpers', () => {
    assert.equal(stripDiacritics('Guzmán Loera'), 'Guzman Loera');
    assert.ok(transliterateCyrillic('Шойгу').includes('shoygu'));
    assert.ok(transliterateCyrillic('Шойгу').includes('shoigu'));
  });

  await t.test('Arabic/Persian given names and surnames expand; label and known aliases excluded', () => {
    const v = nameVariants('Qasem Soleimani', ['Qassem Soleimani']);
    const names = v.map(x => x.variant);
    assert.ok(names.includes('Ghasem Soleimani'));
    assert.ok(names.includes('Qasem Suleimani'));
    assert.ok(names.includes('Soleimani, Qasem'));
    assert.ok(!names.includes('Qasem Soleimani'));
    assert.ok(!names.includes('Qassem Soleimani'), 'known alias not re-suggested');
    assert.ok(names.every(n => !/<|>/.test(n)));
    assert.ok(v.length <= MAX_VARIANTS);
    assert.ok(v.every(x => ['diacritics', 'transliteration', 'spelling', 'order', 'particle', 'hyphen'].includes(x.kind)));
  });

  await t.test('Cyrillic labels transliterate; Latin Russian names get -ov/-ev/-sky style and ye/e variants', () => {
    const cyr = nameVariants('Сергей Шойгу').map(x => x.variant);
    assert.ok(cyr.includes('Sergey Shoygu') && cyr.includes('Sergei Shoigu'));
    const lat = nameVariants('Yevgeny Prigozhin').map(x => x.variant);
    assert.ok(lat.includes('Evgeny Prigozhin') && lat.includes('Yevgeny Prigojin'));
  });

  await t.test('Spanish: accents, order, particles; Chinese: Wade-Giles + order flip', () => {
    const es = nameVariants('Nemesio Oseguera Cervantes', ['El Mencho']).map(x => x.variant);
    assert.ok(es.includes('Nemesio Oseguera') && es.includes('Cervantes, Nemesio Oseguera'));
    const acc = nameVariants('Joaquín Guzmán Loera').map(x => x.variant);
    assert.ok(acc.includes('Joaquin Guzman Loera'));
    const zh = nameVariants('Xi Jinping').map(x => x.variant);
    assert.ok(zh.includes('Hsi Jinping') && zh.includes('Jinping Xi'));
    assert.deepEqual(nameVariants(''), []);
    assert.deepEqual(nameVariants('   '), []);
  });

  await t.test('find.mjs: generated variants widen the search and are flagged generated + weak', () => {
    const m = aliasMatchers('Qasem Soleimani', [], ['Qassem Suleimani']);
    assert.equal(m.filter(x => x.generated).length, 1);
    assert.ok(m.find(x => x.generated).weak);
    const hits = matchingSentences('Reports name Qassem Suleimani in Baghdad. Nothing else here matters.', m);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].generated, true);
    assert.equal(hits[0].weak, true);
    const target = { id: 'tgt_000000000009', label: 'Qasem Soleimani', type: 'person', aliases: [], requirement: 'x', decisions: {}, graphProposals: [] };
    const ctx = { graph: { nodes: [], edges: [], articles: [] }, corpus: null, articles: [{ id: 'a1', title: 'Iran', outlet: 'X', url: 'https://example.com/a', publishedAt: '2026-09-01T00:00:00Z', text: 'Ghasem Soleimani was named in the report by officials in Tehran today.' }], dojReleases: [], ofacIndex: null, telegram: [], narcoClusters: [] };
    const found = gatherMentions(target, ctx);
    assert.ok(found.variants.generated > 0);
    assert.ok(found.variants.hit.includes('Ghasem Soleimani'));
    const gm = found.mentions.find(x => x.generated);
    assert.ok(gm && gm.weak && gm.alias === 'Ghasem Soleimani');
    assert.ok(found.matchers.some(x => x.generated && x.kind));
    const off = gatherMentions(target, { ...ctx, variants: false });
    assert.equal(off.variants.generated, 0);
    assert.equal(off.mentions.length, 0);
  });
});

test('text-intel routes', async (t) => {
  let server, base;
  t.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
  t.after(() => new Promise(r => server.close(r)));

  await t.test('/api/iocs 503 before first sweep; rejects unknown type', async () => {
    const r = await fetch(`${base}/api/iocs`);
    assert.equal(r.status, 503);
    const bad = await fetch(`${base}/api/iocs?type=banana`);
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(await bad.json()).includes('banana'));
  });

  await t.test('/api/telegram/graph returns graph shape without a running scraper', async () => {
    const r = await fetch(`${base}/api/telegram/graph`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.nodes) && Array.isArray(j.edges) && Array.isArray(j.clusters));
    assert.ok(j.summary && typeof j.summary.coordinatedClusters === 'number');
    assert.ok(Array.isArray(j.monitored));
  });

  await t.test('/api/targeting/variants validates and returns bounded suggestions', async () => {
    const r = await fetch(`${base}/api/targeting/variants?label=${encodeURIComponent('Qasem Soleimani')}&type=person&aliases=${encodeURIComponent('Qassem Soleimani; Haj Qasem')}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.aliases, ['Qassem Soleimani', 'Haj Qasem']);
    assert.ok(j.variants.length > 0 && j.variants.length <= j.max);
    assert.ok(j.variants.every(v => v.variant && v.kind));
    assert.ok(!j.variants.some(v => v.variant === 'Qassem Soleimani'));
    assert.equal((await fetch(`${base}/api/targeting/variants`)).status, 400);
    assert.equal((await fetch(`${base}/api/targeting/variants?label=${encodeURIComponent('<b>x</b>')}`)).status, 400);
    assert.equal((await fetch(`${base}/api/targeting/variants?label=abc&type=human`)).status, 400);
    assert.equal((await fetch(`${base}/api/targeting/variants?label=${'a'.repeat(81)}`)).status, 400);
  });
});
