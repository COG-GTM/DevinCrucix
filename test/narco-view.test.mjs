// Narco dashboard payload (lib/narco/view.mjs), commercial NO KEY slots and their source-health
// classification. Synthetic pipeline output only; no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNarcoView, compactCluster, compactRelease, MAX_EVENTS, MAX_DOJ, MAX_SANCTIONS, MAX_PER_LIST, NARCO_SOURCES,
} from '../lib/narco/view.mjs';
import { VENDORS, slotFor } from '../apis/sources/commercialnarco.mjs';
import { classifySource, buildSourceHealth } from '../lib/sourcehealth.mjs';
import { DISTRICTS, CATEGORIES } from '../apis/sources/doj.mjs';

const LONG = 'x'.repeat(5000);
const EVIL = '<img src=x onerror=alert(1)>';

function cluster(over = {}) {
  return {
    schema: 'narco-cluster/1', id: 'cl_0123456789abcdef0123', eventType: 'armed_clash', eventTypes: ['armed_clash', 'arrest'],
    date: '2026-09-04', dateRange: ['2026-09-04', '2026-09-04'],
    location: { country: 'MX', state: 'Zacatecas', municipality: 'Ojocaliente', city: 'Ojocaliente', precision: 'city', lat: 22.5678912, lon: -102.2512345 },
    cartels: [{ orgId: 'cjng', short: 'CJNG', implied: false }],
    factions: [], people: [{ name: 'Luis Enrique Barragán Chávez' }],
    counts: { killed: 4, wounded: 2, arrested: 3, kidnapped: 0 },
    seizures: { drugs: [{ substance: 'methamphetamine', kg: 12 }], weapons: 3, vehicles: 0, cash: [] },
    title: 'Three Captured after CJNG Car Bomb', excerpt: 'Gunmen killed four police officers.',
    confidence: { grade: 'B', independentSources: 2, official: 0, media: 1, aggregator: 1, citedOutlets: 1 },
    records: [{ outlet: 'Borderland Beat', sourceKind: 'aggregator', url: 'https://www.borderlandbeat.com/x', title: 't', publishedAt: '2026-09-04T10:00:00Z' }],
    citedSources: [{ name: 'El Universal', url: 'https://www.eluniversal.com.mx/', kind: 'cited' }, { name: 'Milenio', kind: 'mention' }],
    sanctions: { people: [{ query: 'Luis Enrique Barragán Chávez', uid: 1, name: 'BARRAGAN CHAVEZ, Luis Enrique', type: 'individual', programs: ['SDNTK'], strength: 'exact', matchedName: 'BARRAGAN CHAVEZ, Luis Enrique', countries: ['Mexico'], url: 'https://sanctionssearch.ofac.treas.gov/?q=x' }], groups: [] },
    ...over,
  };
}

function pipeline(clusters, over = {}) {
  return {
    schema: 'narco-pipeline/1', computedAt: '2026-09-05T12:00:00Z', durationMs: 1200, windowDays: 90, currentDays: 30,
    inputs: { articles: 40, mexicoRelevantArticles: 20, dojReleases: 12, ofacIndexed: 2618, ofacPublishDate: '09/04/2026' },
    llm: { used: 0, errors: 0, skipped: 'no provider' },
    records: clusters.length, clusters,
    totals: { clusters: clusters.length, current: clusters.length, historical: 0, byGrade: { B: clusters.length }, byType: { armed_clash: clusters.length }, byState: { Zacatecas: clusters.length }, byCartel: { cjng: clusters.length }, sanctionsMatches: 1, mapped: clusters.length },
    ...over,
  };
}

describe('buildNarcoView states', () => {
  it('is pending before the first sweep and error when the pipeline failed, with the DOJ/OFAC/commercial slots still present', () => {
    const pending = buildNarcoView(null, {});
    assert.equal(pending.status, 'pending');
    assert.deepEqual(pending.events, []);
    assert.equal(pending.totals, null);
    assert.equal(pending.doj.status, 'unavailable');
    assert.equal(pending.sanctions.status, 'unavailable');
    assert.deepEqual(pending.commercial.map(c => c.name), ['DataInt', 'Lantia']);
    assert.equal(pending.feeds.length, 3);
    assert.ok(pending.feeds.every(f => f.registered === false && f.status === 'unregistered'));

    const failed = buildNarcoView(null, {}, { error: 'event pipeline failed this sweep' });
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, 'event pipeline failed this sweep');
  });

  it('is live with bounded totals, legend and current/historical split when the pipeline ran', () => {
    const cur = cluster();
    const old = cluster({ id: 'cl_aaaaaaaaaaaaaaaaaaaa', date: '2026-07-01' });
    const v = buildNarcoView(pipeline([cur, old]), {});
    assert.equal(v.status, 'live');
    assert.equal(v.currentCut, '2026-08-06');
    assert.equal(v.events[0].historical, false);
    assert.equal(v.events[1].historical, true);
    assert.deepEqual(Object.keys(v.legend.confidence), ['A', 'B', 'C', 'D', 'E']);
    assert.ok(v.legend.eventTypes.tunnel);
    assert.equal(v.totals.sanctionsMatches, 1);
    assert.equal(v.sanctions.matches.length, 1);
    assert.equal(v.sanctions.matches[0].eventId, cur.id);
    assert.equal(v.sourceNames.length, new Set(NARCO_SOURCES.map(s => s.name)).size);
  });
});

describe('payload bounds', () => {
  it('caps events, per-event lists and string lengths', () => {
    const many = Array.from({ length: MAX_EVENTS + 25 }, (_, i) => cluster({ id: `cl_${String(i).padStart(20, '0')}` }));
    const v = buildNarcoView(pipeline(many), {});
    assert.equal(v.events.length, MAX_EVENTS);

    const fat = cluster({
      title: LONG, excerpt: LONG,
      people: Array.from({ length: 30 }, (_, i) => ({ name: `Person ${i} ${LONG}` })),
      cartels: Array.from({ length: 30 }, (_, i) => ({ orgId: `o${i}`, short: LONG })),
      records: Array.from({ length: 30 }, () => ({ outlet: LONG, sourceKind: 'media', url: 'https://a.example/' + LONG, title: LONG, publishedAt: 'garbage' })),
      seizures: { drugs: Array.from({ length: 10 }, () => ({ substance: LONG, kg: 1 })), weapons: 2, vehicles: 3, cash: [{ amount: 1e6, currency: 'USDXXXX' }, { amount: 5 }, { amount: 7 }] },
    });
    const c = compactCluster(fat, '2026-08-06');
    assert.equal(c.title.length, 200);
    assert.equal(c.excerpt.length, 280);
    assert.equal(c.people.length, MAX_PER_LIST);
    assert.ok(c.people.every(p => p.length <= 80));
    assert.equal(c.cartels.length, MAX_PER_LIST);
    assert.equal(c.sources.length, MAX_PER_LIST);
    assert.ok(c.sources.every(s => s.url.length <= 500 && s.publishedAt === null));
    assert.ok(c.seizures.length <= 6 && c.seizures.every(s => s.length <= 60));
    assert.equal(c.location.lat, 22.5679);
  });

  it('formats drug quantities in the unit that fits (grams, kg, tonnes) and never as "0 kg"', () => {
    const c = compactCluster(cluster({
      seizures: { drugs: [{ substance: 'marijuana', kg: 0 }, { substance: 'fentanyl', kg: 0.02 }, { substance: 'methamphetamine', kg: 0.002 }, { substance: 'cocaine', kg: 1500 }], weapons: 0, vehicles: 0, cash: [] },
    }), '2026-08-06');
    assert.deepEqual(c.seizures, ['marijuana', '20 g fentanyl', '2 g methamphetamine', '1.5 t cocaine']);
    const doses = compactCluster(cluster({ seizures: { drugs: [{ substance: 'heroin', qty: 200, unit: 'dose' }], cash: [] } }), '2026-08-06');
    assert.deepEqual(doses.seizures, ['200 doses heroin']);
    assert.ok(c.seizures.every(s => !/\b0 (?:kg|g|t)\b/.test(s)));
  });

  it('drops non-http(s) URLs and non-finite numbers instead of passing them to the browser', () => {
    const c = compactCluster(cluster({
      records: [{ outlet: 'x', sourceKind: 'media', url: 'javascript:alert(1)', title: 't', publishedAt: '2026-09-04T00:00:00Z' }],
      citedSources: [{ name: 'y', url: 'data:text/html,hi', kind: 'cited' }],
      location: { country: 'MX', state: 'Sonora', lat: 'NaN', lon: Infinity, precision: 'state' },
      counts: { killed: '4', wounded: NaN },
    }), '2026-08-06');
    assert.equal(c.sources[0].url, null);
    assert.equal(c.citedSources[0].url, null);
    assert.equal(c.location.lat, null);
    assert.equal(c.location.lon, null);
    assert.deepEqual(c.counts, { killed: 0, wounded: 0, arrested: 0, kidnapped: 0 });
  });

  it('passes hostile third-party strings through unchanged (escaping is the renderer\u2019s job) but bounded', () => {
    const c = compactCluster(cluster({ title: EVIL + LONG, people: [{ name: EVIL }] }), null);
    assert.ok(c.title.startsWith(EVIL));
    assert.equal(c.title.length, 200);
    assert.equal(c.people[0], EVIL);
    assert.equal(c.historical, false, 'no current cut -> nothing is historical');
  });

  it('caps DOJ releases and sanctions matches and mirrors the district/category taxonomy from code', () => {
    const doj = {
      status: 'live', api: { url: 'https://www.justice.gov/api/v1/press_releases.json', pagesFetched: 3, pagesRequested: 3, releasesScanned: 150 },
      summary: { days: 30, watched: 60, byDistrict: { TXWD: 20 }, byCategory: { tunnel: 3 } },
      releases: Array.from({ length: MAX_DOJ + 10 }, (_, i) => ({ id: `r${i}`, url: 'https://www.justice.gov/x', title: 'T', teaser: LONG, publishedAt: '2026-09-04T00:00:00Z', district: { code: 'TXWD', name: 'Western District of Texas' }, categories: ['tunnel'], topics: [], dateline: { city: 'El Paso' } })),
    };
    const v = buildNarcoView(pipeline([cluster()]), { DOJ: doj });
    assert.equal(v.doj.releases.length, MAX_DOJ);
    assert.equal(v.doj.releases[0].teaser.length, 300);
    assert.equal(v.doj.releases[0].dateline, 'El Paso');
    assert.deepEqual(v.doj.districts.map(d => d.code), DISTRICTS.map(d => d.code));
    assert.deepEqual(v.doj.categories.map(c => c.id), CATEGORIES.map(c => c.id));
    assert.equal(v.doj.pagesFetched, 3);

    const manyMatches = Array.from({ length: MAX_SANCTIONS + 5 }, (_, i) => cluster({
      id: `cl_${String(i).padStart(20, '0')}`,
      sanctions: { people: [{ query: `Q${i}`, uid: i, name: 'N', type: 'individual', programs: ['SDNTK'], strength: 'exact', matchedName: 'N', countries: [], url: 'https://sanctionssearch.ofac.treas.gov/' }], groups: [] },
    }));
    const v2 = buildNarcoView(pipeline(manyMatches), { OFACNarco: { status: 'live', summary: { entries: 1, individuals: 1, entities: 0, mexicoLinked: 1, byProgram: { SDNTK: 1 }, publishDate: '09/04/2026', recordCount: 19329 }, designatedGroups: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`g${i}`, [{ orgId: `g${i}`, uid: i, name: 'G', programs: ['SDNTK'], url: 'https://x.example/' }]])) } });
    assert.equal(v2.sanctions.matches.length, MAX_SANCTIONS);
    assert.equal(v2.sanctions.designatedGroups.length, 40);
    assert.equal(v2.sanctions.summary.recordCount, 19329);
  });

  it('serializes the whole view under 400 KB even at every cap', () => {
    const many = Array.from({ length: MAX_EVENTS + 25 }, (_, i) => cluster({ id: `cl_${String(i).padStart(20, '0')}`, title: LONG, excerpt: LONG, people: Array.from({ length: 30 }, () => ({ name: LONG })) }));
    const v = buildNarcoView(pipeline(many), {});
    assert.ok(JSON.stringify(v).length < 400_000);
  });
});

describe('feed rows', () => {
  it('reflects Border Watch feed state per registered narco feed and keeps empty polls distinct from healthy ones', () => {
    const bn = { feeds: [
      { id: 'borderlandbeat', status: 'ok', items: 25, newItems: 3, articleFetch: { attempted: 3, ok: 3, blocked: 0, robotsDisallowed: 0, paywalled: 0 } },
      { id: 'elpasomatters', status: 'empty', items: 0 },
      { id: 'fronterasdesk', status: 'error', reason: 'HTTP 503 ' + LONG },
    ] };
    const v = buildNarcoView(null, { BorderNews: bn });
    const byId = Object.fromEntries(v.feeds.map(f => [f.id, f]));
    assert.equal(byId.borderlandbeat.status, 'ok');
    assert.equal(byId.borderlandbeat.newItems, 3);
    assert.equal(byId.borderlandbeat.articleFetch.ok, 3);
    assert.equal(byId.elpasomatters.status, 'empty');
    assert.equal(byId.fronterasdesk.status, 'error');
    assert.equal(byId.fronterasdesk.reason.length, 120);
  });
});

describe('commercial vendors (DataInt, Lantia)', () => {
  it('report NO KEY when unlicensed, never scrape, and classify as no_key in source health', () => {
    for (const v of VENDORS) {
      const s = slotFor(v.name, {});
      assert.equal(s.status, 'no_key');
      assert.equal(s.commercial, true);
      assert.match(s.message, new RegExp(v.envKey));
      assert.equal(classifySource(v.name, s).state, 'no_key');
      assert.deepEqual(classifySource(v.name, s).envVars, [v.envKey]);
    }
  });

  it('stay not_configured (never live) when a key exists but no vendor API contract is implemented', () => {
    const noUrl = slotFor('DataInt', { DATAINT_API_KEY: 'k' });
    assert.equal(noUrl.status, 'not_configured');
    const httpUrl = slotFor('DataInt', { DATAINT_API_KEY: 'k', DATAINT_API_URL: 'http://insecure.example' });
    assert.equal(httpUrl.status, 'not_configured');
    const full = slotFor('Lantia', { LANTIA_API_KEY: 'k', LANTIA_API_URL: 'https://api.example' });
    assert.equal(full.status, 'not_configured');
    assert.match(full.message, /no data pulled/);
    assert.notEqual(classifySource('Lantia', full).state, 'live');
    assert.equal(slotFor('Nope', {}), null);
  });

  it('view carries vendor metadata for honest display and does not count them as reporting', () => {
    const v = buildNarcoView(null, { DataInt: slotFor('DataInt', {}), Lantia: slotFor('Lantia', {}) });
    assert.equal(v.commercial[0].vendor, 'DataInt (dataint.mx)');
    assert.equal(v.commercial[0].homepage, 'https://www.dataint.mx/en');
    assert.equal(v.commercial[1].status, 'no_key');
    const health = buildSourceHealth({ sources: { DataInt: slotFor('DataInt', {}), Lantia: slotFor('Lantia', {}) } });
    assert.equal(health.summary.reporting, 0);
    assert.equal(health.summary.no_key, 2);
  });
});

describe('compactRelease', () => {
  it('bounds every DOJ field and tolerates a release with no district or categories', () => {
    const r = compactRelease({ id: LONG, url: 'ftp://nope', title: LONG, teaser: null, publishedAt: null, categories: Array(20).fill(LONG), topics: null });
    assert.equal(r.id.length, 64);
    assert.equal(r.url, null);
    assert.equal(r.title.length, 200);
    assert.equal(r.teaser, '');
    assert.equal(r.publishedAt, null);
    assert.deepEqual(r.district, { code: '', name: '' });
    assert.equal(r.categories.length, 8);
    assert.equal(r.categories[0].length, 30);
    assert.deepEqual(r.topics, []);
    assert.equal(r.dateline, null);
  });
});
