// Feed adapters — unit tests against recorded fixtures (no network)
// Covers: GDELT static export/GKG parsing, ReliefWeb RSS fallback, generic RSS parser,
// OpenSky → ADS-B sample fallback shaping, sidecar source-health classification.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseTsv, compactEvent, compactGkg, recentStamps, stampFromDate, dateFromStamp, eventHeadline } from '../apis/utils/gdeltfeed.mjs';
import { categorizeArticles, buildGeoPoints, buildToneScores, buildPriorityAlerts, topEvents } from '../apis/sources/gdelt.mjs';
import { parseFeed, feedMeta, stripTags, decodeEntities } from '../apis/utils/rss.mjs';
import { reportsFromRss, disastersFromRss, parseRssTags } from '../apis/sources/reliefweb.mjs';
import { samplePoints, fromAdsbSample } from '../apis/sources/opensky.mjs';
import { classifySource, SIDECAR_SOURCES } from '../lib/sourcehealth.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = f => readFileSync(join(FIX, f), 'utf8');

describe('GDELT static export feed', () => {
  const events = parseTsv(read('gdelt_export.sample.tsv')).map(compactEvent);
  const gkgRows = parseTsv(read('gdelt_gkg.sample.tsv'));
  const articles = gkgRows.map(compactGkg).filter(Boolean);

  it('shapes export rows into compact events with geo + CAMEO fields', () => {
    assert.equal(events.length, 8);
    for (const e of events) {
      assert.match(e.id, /^\d+$/);
      assert.match(e.stamp, /^\d{14}$/);
      assert.match(e.root, /^\d{2}$/);
      assert.ok(Number.isFinite(e.lat) && Number.isFinite(e.lon));
      assert.ok(e.url.startsWith('http'), 'event keeps its source URL for provenance');
    }
    assert.ok(events.some(e => e.root === '19' && e.quad === 4), 'fixture includes a material-conflict event');
    assert.match(eventHeadline(events[0]), /^(Fighting|Assault|Protest|Consultation)/);
  });

  it('shapes GKG rows into articles with title, domain, url, themes', () => {
    assert.equal(articles.length, 4);
    for (const a of articles) {
      assert.ok(a.title.length > 5);
      assert.ok(a.url.startsWith('http'));
      assert.ok(a.domain.includes('.'));
      assert.ok(Array.isArray(a.themes));
      assert.match(a.date, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(compactGkg(gkgRows[0].map((c, i) => (i === 26 ? '' : c))), null, 'rows without a PAGE_TITLE are dropped');
  });

  it('categorizes articles and builds geo points / top events from events', () => {
    const cats = categorizeArticles(articles);
    assert.ok(cats.economy.some(a => /inflation|economy/i.test(a.title)));
    const pts = buildGeoPoints(events);
    assert.ok(pts.length > 0);
    assert.ok(pts.every(p => ['conflict', 'protest', 'event'].includes(p.type)));
    assert.ok(pts.every(p => Number.isFinite(p.lat) && p.count >= 1));
    for (const t of topEvents(events)) assert.ok(t.headline && t.url);
  });

  it('only raises a conflict spike when the recent half-window exceeds the older half by 1.5x', () => {
    const base = { region: 'Test', currentTone: -2, previousTone: -2, shift: 0, dataPoints: 100 };
    assert.equal(buildPriorityAlerts([{ ...base, recentConflict: 50, olderConflict: 45 }], 6).length, 0, 'steady volume is not a spike');
    assert.equal(buildPriorityAlerts([{ ...base, recentConflict: 60, olderConflict: 0 }], 6).length, 0, 'no baseline → no spike claim');
    const spike = buildPriorityAlerts([{ ...base, recentConflict: 60, olderConflict: 20 }], 6);
    assert.equal(spike.length, 1);
    assert.match(spike[0].headline, /CONFLICT SPIKE: Test — 60 .* vs 20/);
    const tone = buildPriorityAlerts([{ ...base, shift: -2, currentTone: -4, recentConflict: 0, olderConflict: 0 }], 6);
    assert.match(tone[0].headline, /TONE DETERIORATION/);
  });

  it('tone scores compare recent vs older halves of the window', () => {
    const stamp = '20260905203000';
    const evs = [
      { stamp, country: 'IR', tone: -6, root: '19', mentions: 5 },
      { stamp: '20260905123000', country: 'IR', tone: -1, root: '01', mentions: 5 },
    ];
    const [me] = buildToneScores(evs, [], stamp).filter(r => r.region === 'Middle East');
    assert.equal(me.eventCount, 2);
    assert.equal(me.recentConflict, 1);
    assert.equal(me.olderConflict, 0);
    assert.ok(me.shift < 0);
  });

  it('computes the 15-minute stamp ladder', () => {
    const stamps = recentStamps('20260905203000', 3);
    assert.deepEqual(stamps, ['20260905203000', '20260905201500', '20260905200000']);
    assert.equal(stampFromDate(dateFromStamp('20260905203000')), '20260905203000');
  });
});

describe('RSS/Atom parser', () => {
  it('parses RSS items with CDATA/entities and decodes them to plain text', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>T &amp; Co</title><lastBuildDate>Fri, 05 Sep 2026 10:00:00 GMT</lastBuildDate>
      <item><title><![CDATA[A &amp; B <b>bold</b>]]></title><link>https://x.test/a</link><guid>g1</guid><pubDate>Fri, 05 Sep 2026 09:00:00 GMT</pubDate>
      <description>&lt;p&gt;Hello &amp;quot;world&amp;quot;&lt;/p&gt;</description><category>one</category><category>two</category></item></channel></rss>`;
    const items = parseFeed(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'A & B bold');
    assert.equal(items[0].link, 'https://x.test/a');
    assert.equal(items[0].published, '2026-09-05T09:00:00.000Z');
    assert.equal(items[0].description, 'Hello "world"');
    assert.deepEqual(items[0].categories, ['one', 'two']);
    assert.deepEqual(feedMeta(xml), { title: 'T & Co', updated: '2026-09-05T10:00:00.000Z' });
  });

  it('parses Atom entries', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><updated>2026-09-05T10:00:00Z</updated>
      <entry><title>E1</title><link rel="alternate" href="https://x.test/e1"/><id>urn:1</id><published>2026-09-05T08:00:00Z</published><summary>S</summary></entry></feed>`;
    const [e] = parseFeed(xml);
    assert.equal(e.title, 'E1');
    assert.equal(e.link, 'https://x.test/e1');
    assert.equal(e.published, '2026-09-05T08:00:00.000Z');
    assert.equal(e.description, 'S');
  });

  it('returns plain text (escaping is left to the renderer)', () => {
    assert.equal(stripTags('<script>x</script> &lt;b&gt;'), 'x <b>');
    assert.equal(decodeEntities('&#169; &#x41;'), '© A');
  });
});

describe('ReliefWeb RSS fallback', () => {
  it('extracts reports with country/source/summary from the updates feed fixture', () => {
    const reports = reportsFromRss(read('reliefweb_updates.rss.xml'));
    assert.equal(reports.length, 5);
    for (const r of reports) {
      assert.ok(r.title.length > 5);
      assert.match(r.url, /^https:\/\/reliefweb\.int\//);
      assert.match(r.date, /^\d{4}-/);
      assert.ok(r.countries.length >= 1, `report "${r.title}" has a country`);
      assert.ok(r.source.length >= 1, `report "${r.title}" has a source`);
      assert.doesNotMatch(r.summary, /<[a-z]/i, 'summary is plain text');
    }
  });

  it('extracts disasters and infers hazard type from the GLIDE number', () => {
    const disasters = disastersFromRss(read('reliefweb_disasters.rss.xml'));
    assert.equal(disasters.length, 6);
    for (const d of disasters) {
      assert.ok(d.name && d.url && d.date);
      assert.ok(d.countries.length >= 1);
    }
    const withGlide = disasters.filter(d => d.glide);
    assert.ok(withGlide.length >= 1);
    assert.ok(withGlide.every(d => d.type.length >= 1), 'GLIDE-tagged disasters get a hazard type');
  });

  it('parseRssTags splits tagged metadata and strips it from the summary', () => {
    const raw = '&lt;div class="tag country"&gt;Country: Nepal, India&lt;/div&gt;&lt;div class="tag source"&gt;Source: OCHA&lt;/div&gt;&lt;p&gt;Body text&lt;/p&gt;';
    const { tags, summary } = parseRssTags(decodeEntities(raw));
    assert.deepEqual(tags.country, ['Nepal', 'India']);
    assert.deepEqual(tags.source, ['OCHA']);
    assert.equal(summary, 'Body text');
  });
});

describe('OpenSky → ADS-B sample fallback', () => {
  const box = { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' };
  it('uses one sample for compact boxes and a grid for wide ones', () => {
    assert.equal(samplePoints({ lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' }).length, 1);
    assert.equal(samplePoints(box).length, 2, 'Taiwan Strait is ~550 nm wide → two columns');
    assert.equal(samplePoints({ lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' }).length, 4);
    for (const p of samplePoints(box)) assert.ok(p.lat > box.lamin && p.lat < box.lamax && p.lon > box.lomin && p.lon < box.lomax);
  });

  it('shapes readsb aircraft JSON into the OpenSky hotspot shape and flags it as a sample', () => {
    const ac = [
      { hex: 'a1', flight: 'CES212  ', t: 'A21N', lat: 24.1, lon: 121.0, alt_baro: 35100, dbFlags: 0 },
      { hex: 'a2', flight: '', t: 'P8', lat: 23.5, lon: 119.9, alt_baro: 41000, dbFlags: 1 },
      { hex: 'a3', flight: 'X', t: 'B738', lat: 24.0, lon: 121.0, alt_baro: 'ground' },
      { hex: 'a4', flight: 'OUT', t: 'A320', lat: 31.0, lon: 121.0, alt_baro: 30000 }, // outside the box
    ];
    const h = fromAdsbSample('taiwan', box, ac, samplePoints(box));
    assert.equal(h.region, 'Taiwan Strait');
    assert.equal(h.method, 'adsb_sample');
    assert.equal(h.sampled, true);
    assert.equal(h.totalAircraft, 3);
    assert.equal(h.military, 1);
    assert.equal(h.noCallsign, 1);
    assert.equal(h.highAltitude, 1);
    assert.deepEqual(h.byCountry, {}, 'no origin-country data in ADS-B aggregator payloads');
    assert.deepEqual(h.byType, { A21N: 1, P8: 1, B738: 1 });
  });

  it('source health treats a sampled OpenSky payload as degraded, not live', () => {
    const r = classifySource('OpenSky', { source: 'OpenSky', status: 'fallback', note: 'sampled', hotspots: [{ totalAircraft: 3 }] });
    assert.equal(r.state, 'degraded');
    assert.equal(classifySource('OpenSky', { source: 'OpenSky', method: 'opensky', hotspots: [{ totalAircraft: 3 }] }).state, 'live');
  });
});

describe('sidecar sources', () => {
  it('are flagged so the dashboard can hide their panels while keeping them in Source Health', () => {
    for (const name of Object.keys(SIDECAR_SOURCES)) {
      const r = classifySource(name, { status: 'unavailable' });
      assert.equal(r.sidecar, true);
      assert.equal(r.state, 'off');
      assert.match(r.reason, /sidecar/);
    }
    assert.equal(classifySource('FIRMS', { status: 'unavailable' }).sidecar, undefined);
    const live = classifySource('PizzaIndex', { doughcon: 3, trend: 'rising' });
    assert.equal(live.state, 'live');
    assert.equal(live.sidecar, true);
  });
});
