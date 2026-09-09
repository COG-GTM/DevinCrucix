// DOJ press-release watcher: district filter, topic classifier, persistent store, degraded states.
// Uses a recorded page-0 payload; no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  briefing, classifyRelease, districtOf, datelineOf, factText, normalizeRelease, summarize, queryReleases, loadReleases,
  DISTRICTS, CATEGORIES, CATEGORY_IDS, API_URL,
} from '../apis/sources/doj.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/doj/press_releases.page0.json');
const page0 = JSON.parse(readFileSync(FIX, 'utf8'));

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const fetchPage0 = async () => jsonRes(page0);
const NOW = Date.parse('2026-09-05T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'doj-'));

describe('DOJ district + classifier', () => {
  it('watches exactly the five south-west border USAOs and maps component names client-side', () => {
    assert.deepEqual(DISTRICTS.map(d => d.code), ['CASD', 'AZ', 'NM', 'TXWD', 'TXSD']);
    assert.equal(districtOf([{ name: 'Federal Bureau of Investigation (FBI)' }, { name: 'USAO - Texas, Western' }]).code, 'TXWD');
    assert.equal(districtOf([{ name: 'USAO - Florida, Middle' }]), null);
    assert.equal(districtOf(undefined), null);
  });

  it('category taxonomy is consistent', () => {
    assert.deepEqual(CATEGORY_IDS, CATEGORIES.map(c => c.id));
    assert.deepEqual(CATEGORY_IDS, ['cartel', 'smugglers', 'trafficking_org', 'weapons', 'money_laundering', 'human_smuggling', 'tunnel', 'violent_org']);
  });

  it('classifies the watched topics and ignores quoted boilerplate', () => {
    assert.ok(classifyRelease('Man pleads guilty to alien smuggling conspiracy involving a tunnel from Ciudad Juárez').includes('tunnel'));
    assert.ok(classifyRelease('Man pleads guilty to alien smuggling conspiracy').includes('human_smuggling'));
    assert.ok(classifyRelease('Sinaloa Cartel associate sentenced for fentanyl distribution conspiracy').includes('cartel'));
    assert.ok(classifyRelease('Two charged with firearms trafficking; rifles were destined for Mexico').includes('weapons'));
    assert.ok(classifyRelease('Money laundering conspiracy moved bulk cash through casas de cambio').includes('money_laundering'));
    assert.ok(classifyRelease('Barrio Azteca gang member convicted of racketeering').includes('violent_org'));
    assert.deepEqual(classifyRelease('Local man sentenced for tax evasion.'), []);
    const quoted = 'Local man sentenced for tax evasion. "We will continue to pursue cartel members and violent gang leaders who threaten our communities," said the U.S. Attorney.';
    assert.deepEqual(classifyRelease(quoted), []);
    assert.ok(!/cartel/.test(factText(quoted)));
  });

  it('parses datelines and rejects sentence starts', () => {
    assert.deepEqual(datelineOf('EL PASO, Texas – A man pleaded guilty today.'), { city: 'El Paso', state: 'Texas' });
    assert.deepEqual(datelineOf('SAN ANTONIO – Two men were sentenced.'), { city: 'San Antonio', state: null });
    assert.equal(datelineOf('Today – nothing happened.'), null);
    assert.equal(datelineOf('The defendant pleaded guilty.'), null);
  });

  it('normalizes only watched-district releases with bounded fields and provenance', () => {
    const raw = page0.results.find(r => r.component.some(c => c.name === 'USAO - Texas, Western'));
    const rec = normalizeRelease(raw, '2026-09-05T00:00:00Z');
    assert.ok(rec);
    assert.equal(rec.district.code, 'TXWD');
    assert.match(rec.url, /^https:\/\/www\.justice\.gov\//);
    assert.equal(rec.uuid, raw.uuid);
    assert.match(rec.publishedAt, /^2026-/);
    assert.ok(rec.body.length <= 20_000);
    assert.ok(!/<[a-z]+>/i.test(rec.body), 'body is text, not HTML');
    assert.ok(rec.components.includes('USAO - Texas, Western'));
    assert.equal(normalizeRelease(page0.results.find(r => r.component.every(c => !/USAO - (?:Texas, (?:Western|Southern)|Arizona|New Mexico|California, Southern)/.test(c.name))), 'x'), null);
    assert.equal(normalizeRelease({ component: [{ name: 'USAO - Arizona' }], url: 'https://evil.example/x', uuid: '' }, 'x'), null, 'non-DOJ url with no uuid is dropped');
    const spoofed = normalizeRelease({ component: [{ name: 'USAO - Arizona' }], url: 'https://evil.example/x', uuid: 'abc', title: 'Cartel case' }, 'x');
    assert.equal(spoofed.url, null);
  });
});

describe('DOJ briefing (fixture fetch)', () => {
  it('first sweep back-fills, stores watched releases and reports live with API metadata', async () => {
    const dir = tmp();
    try {
      const b = await briefing({ fetch: fetchPage0, dataDir: dir, now: NOW, backfillPages: 1, pageDelayMs: 0 });
      assert.equal(b.source, 'DOJ');
      assert.equal(b.status, 'live');
      assert.equal(b.api.url, API_URL);
      assert.equal(b.api.pageSize, 50);
      assert.equal(b.api.releasesScanned, page0.results.length);
      assert.equal(b.api.nationalCount, Number(page0.metadata.resultset.count));
      assert.ok(b.districtHitsThisSweep >= b.totalReleases);
      assert.ok(b.totalReleases > 0);
      assert.ok(b.releases.every(r => r.url && r.district && r.categories.length));
      assert.ok(b.releases.every(r => !('body' in r)), 'public records omit body');
      assert.ok(existsSync(join(dir, 'releases.json')));
      assert.equal(b.summary.days, 30);
      assert.equal(Object.keys(b.summary.byDistrict).length, 5);
      assert.deepEqual(Object.keys(b.summary.byCategory), CATEGORY_IDS);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('second sweep adds nothing new and query/load helpers filter the store', async () => {
    const dir = tmp();
    try {
      await briefing({ fetch: fetchPage0, dataDir: dir, now: NOW, backfillPages: 1, pageDelayMs: 0 });
      const b = await briefing({ fetch: fetchPage0, dataDir: dir, now: NOW + 60_000, pages: 1, pageDelayMs: 0 });
      assert.equal(b.newThisSweep, 0);
      assert.equal(b.status, 'live');
      const all = loadReleases({ dataDir: dir, now: NOW });
      assert.equal(all.length, b.totalReleases);
      assert.ok(all.every(r => r.body !== undefined));
      const q = queryReleases({ district: 'TXWD', days: 30 }, { dataDir: dir, now: NOW });
      assert.ok(q.releases.every(r => r.district.code === 'TXWD'));
      assert.equal(queryReleases({ district: 'ZZ' }, { dataDir: dir, now: NOW }).count, 0);
      assert.equal(summarize(all, NOW, 30).watched, all.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('degrades honestly: error with no store, stale with a store, partial on a failed later page', async () => {
    const dir = tmp();
    try {
      const down = async () => jsonRes({ error: 'nope' }, 503);
      const e = await briefing({ fetch: down, dataDir: dir, now: NOW, backfillPages: 2, pageDelayMs: 0 });
      assert.equal(e.status, 'error');
      assert.match(e.error, /HTTP 503/);
      assert.equal(e.totalReleases, 0);

      await briefing({ fetch: fetchPage0, dataDir: dir, now: NOW, backfillPages: 1, pageDelayMs: 0 });
      const s = await briefing({ fetch: async () => { throw new Error('ECONNRESET'); }, dataDir: dir, now: NOW + 1000, pages: 1, pageDelayMs: 0 });
      assert.equal(s.status, 'stale');
      assert.equal(s.stale, true);
      assert.ok(s.totalReleases > 0);
      assert.ok(!/ECONNRESET/.test(JSON.stringify(s)), 'internal error text is not echoed');

      let n = 0;
      const flaky = async () => (n++ === 0 ? jsonRes(page0) : jsonRes({}, 500));
      const p = await briefing({ fetch: flaky, dataDir: dir, now: NOW + 2000, pages: 2, pageDelayMs: 0 });
      assert.equal(p.status, 'partial');
      assert.equal(p.api.pagesFetched, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports empty when the API answers but nothing matches the watched districts', async () => {
    const dir = tmp();
    try {
      const none = async () => jsonRes({ metadata: page0.metadata, results: page0.results.filter(r => !districtOf(r.component)) });
      const b = await briefing({ fetch: none, dataDir: dir, now: NOW, backfillPages: 1, pageDelayMs: 0 });
      assert.equal(b.status, 'empty');
      assert.equal(b.totalReleases, 0);
      const bad = await briefing({ fetch: async () => jsonRes({ foo: 1 }), dataDir: tmp(), now: NOW, backfillPages: 1, pageDelayMs: 0 });
      assert.equal(bad.status, 'error');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
