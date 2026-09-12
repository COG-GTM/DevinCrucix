// Iran War Live adapter + view model. Runs against recorded fixtures only — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseCsv, parseFeed, parseStrikesCsv, parseGroundCsv, parseActorsCsv, parseAirspaceCsv, parsePosturingCsv,
  buildResult, mergeEvents, canonicalId, confidenceTier, strikeKind, airspaceLevel, httpUrl, toCount, cleanText,
  inTheater, unavailable, THEATER, FRESH_AFTER_H, DISCLAIMER,
} from '../apis/sources/iranwarlive.mjs';
import { trimIranWar, buildIranWarView, corroboration, isTheaterText } from '../lib/iranwarview.mjs';
import { classifySource } from '../lib/sourcehealth.mjs';
import { LAYERS, evaluateLayers } from '../lib/maplayers.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'iranwarlive');
const fx = (name) => readFileSync(join(FIX, name), 'utf8');
const NOW = Date.parse('2026-09-11T22:00:00.000Z');

function parts(overrides = {}) {
  const ok = (p) => (p.error ? { ok: false, error: p.error, rows: [], items: [] } : { ok: true, ...p });
  return {
    feed: ok(parseFeed(JSON.parse(fx('feed.sample.json')))),
    strikes: ok(parseStrikesCsv(fx('strikes.sample.csv'))),
    ground: ok(parseGroundCsv(fx('ground.sample.csv'))),
    actors: ok(parseActorsCsv(fx('actors.sample.csv'))),
    airspace: ok(parseAirspaceCsv(fx('airspace.sample.csv'))),
    posturing: ok(parsePosturingCsv(fx('posturing.sample.csv'))),
    ...overrides,
  };
}

// ─── primitives ─────────────────────────────────────────────────────────────

test('httpUrl accepts http(s) only and rejects javascript:/data:/relative', () => {
  assert.equal(httpUrl('https://www.bbc.co.uk/news/x?at_medium=RSS'), 'https://www.bbc.co.uk/news/x?at_medium=RSS');
  assert.equal(httpUrl('javascript:alert(1)'), null);
  assert.equal(httpUrl('data:text/html,hi'), null);
  assert.equal(httpUrl('/relative'), null);
  assert.equal(httpUrl(''), null);
});

test('toCount handles thousands separators, blanks and free text', () => {
  assert.equal(toCount('610,000'), 610000);
  assert.equal(toCount(' 12 '), 12);
  assert.equal(toCount('0'), 0);
  assert.equal(toCount('Unknown'), null);
  assert.equal(toCount(''), null);
});

test('cleanText strips tags, decodes entities and bounds length', () => {
  assert.equal(cleanText('<img src=x onerror=alert(1)>Tehran &amp; depot'), 'Tehran & depot');
  assert.equal(cleanText('a'.repeat(500), 40).length, 40);
});

test('canonicalId folds feed IRW-V5- ids onto sheet IRW- ids', () => {
  assert.equal(canonicalId('IRW-V5-1789142458111-0'), 'IRW-1789142458111-0');
  assert.equal(canonicalId('IRW-1789142458111-0'), 'IRW-1789142458111-0');
  assert.equal(canonicalId('GRND-1789142486739-0'), 'GRND-1789142486739-0');
  assert.equal(canonicalId(''), null);
});

test('confidence tiers, strike kinds and airspace levels are conservative classifiers', () => {
  assert.equal(confidenceTier('US/IDF Military (High)'), 'high');
  assert.equal(confidenceTier('High Confidence (Multi-Source)'), 'high');
  assert.equal(confidenceTier('News Wire'), 'wire');
  assert.equal(confidenceTier('OSINT'), 'medium');
  assert.equal(confidenceTier('State Media/Unverified'), 'low');
  assert.equal(confidenceTier(''), 'unrated');
  assert.equal(strikeKind('Air Strike'), 'air');
  assert.equal(strikeKind('Missile Strike'), 'missile');
  assert.equal(strikeKind('Drone Attack'), 'drone');
  assert.equal(strikeKind('Interception'), 'intercept');
  assert.equal(strikeKind('Ground Forces'), 'ground');
  assert.equal(strikeKind('Something New'), 'other');
  assert.equal(airspaceLevel('Blockaded'), 'closed');
  assert.equal(airspaceLevel('Restricted (US naval blockade in effect since Monday)'), 'restricted');
  assert.equal(airspaceLevel('High Risk'), 'restricted');
  assert.equal(airspaceLevel('Open, but under Iranian supervision; US blockade continues; European leaders discussing.'), 'restricted');
  assert.equal(airspaceLevel('Normal Operations'), 'open');
  assert.equal(airspaceLevel('Monitored (by UKMTO for distress calls)'), 'open');
  assert.equal(airspaceLevel('Something entirely new'), 'unknown');
});

test('theater box covers Tehran, Tel Aviv, Sanaa and Hormuz but not Paris', () => {
  assert.ok(inTheater(35.69, 51.39));
  assert.ok(inTheater(32.08, 34.78));
  assert.ok(inTheater(15.35, 44.2));
  assert.ok(inTheater(26.5, 56.3));
  assert.ok(!inTheater(48.85, 2.35));
  assert.ok(THEATER.latMin < THEATER.latMax && THEATER.lonMin < THEATER.lonMax);
});

// ─── CSV ────────────────────────────────────────────────────────────────────

test('parseCsv handles quoted commas, escaped quotes, CRLF and duplicate headers', () => {
  const { headers, rows, duplicateHeaders } = parseCsv('A,B,B,C\r\n1,"x, y","say ""hi""",3\r\n');
  assert.deepEqual(headers, ['A', 'B', 'B_2', 'C']);
  assert.deepEqual(duplicateHeaders, ['B']);
  assert.equal(rows[0].B, 'x, y');
  assert.equal(rows[0].B_2, 'say "hi"');
  assert.equal(rows[0].C, '3');
});

test('strikes CSV: valid rows normalized, hostile strings bounded, bad rows dropped', () => {
  const p = parseStrikesCsv(fx('strikes.sample.csv'));
  assert.equal(p.error, undefined);
  assert.equal(p.rows.length, 12, 'ten live rows + hostile + Paris; bad timestamp / no lat / no id dropped');
  assert.equal(p.dropped, 3);
  const hostile = p.rows.find(r => r.id === 'IRW-1789000000000-9');
  assert.ok(hostile);
  assert.ok(!hostile.text.includes('<'), 'tags stripped');
  assert.ok(hostile.text.includes('"quoted"'), 'escaped quotes preserved');
  assert.equal(hostile.sourceUrl, null, 'javascript: URL rejected');
  assert.equal(hostile.casualties, 1250, 'thousands separator parsed');
  assert.equal(hostile.confidence, 'low');
  assert.equal(hostile.kind, 'missile');
  const paris = p.rows.find(r => r.id === 'IRW-1789000000001-0');
  assert.equal(paris.inTheater, false);
  assert.equal(paris.casualties, null, '"Unknown" is not a count');
  for (const r of p.rows) {
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon));
    assert.ok(r.text.length <= 240);
  }
});

test('ground CSV keeps both duplicate Units_Involved columns as units + movement', () => {
  const p = parseGroundCsv(fx('ground.sample.csv'));
  assert.equal(p.error, undefined);
  assert.deepEqual(p.duplicateHeaders, ['Units_Involved']);
  const adv = p.rows.find(r => r.id === 'GRND-1789000000000-0');
  assert.equal(adv.units, 'IDF, Hezbollah');
  assert.equal(adv.movement, 'Advance');
  assert.equal(adv.control, 'IDF');
  assert.equal(adv.casualties, 2);
  assert.ok(!adv.text.includes('<b>'));
  assert.equal(adv.kind, 'ground');
  const live = p.rows.find(r => r.id === 'GRND-1789142486739-0');
  assert.ok(live, 'live row present');
  assert.equal(live.movement, 'Holding');
});

test('actors CSV parses separators and keeps zero-death rows', () => {
  const p = parseActorsCsv(fx('actors.sample.csv'));
  assert.equal(p.error, undefined);
  const iran = p.rows.find(a => a.name === 'Iran');
  assert.equal(iran.troops, 610000);
  assert.equal(iran.militaryDeaths, 6677);
  assert.equal(iran.alliance, 'Axis of Resistance');
  assert.ok(p.rows.every(a => typeof a.name === 'string' && a.name.length > 0));
});

test('airspace CSV keeps free-text status verbatim next to a coarse level', () => {
  const p = parseAirspaceCsv(fx('airspace.sample.csv'));
  assert.equal(p.error, undefined);
  const hormuz = p.rows.find(a => a.region.startsWith('Strait of Hormuz') && a.status.startsWith('Open, but'));
  assert.ok(hormuz);
  assert.equal(hormuz.level, 'restricted');
  assert.ok(hormuz.status.includes('European leaders'), 'original wording preserved');
  assert.equal(hormuz.sourceUrl, 'https://example.org/hormuz');
});

test('posturing CSV normalizes stance rows with source hosts', () => {
  const p = parsePosturingCsv(fx('posturing.sample.csv'));
  assert.equal(p.error, undefined);
  assert.ok(p.rows.length >= 8);
  assert.ok(p.rows.every(r => r.actor && r.text && r.at));
  assert.ok(p.rows.some(r => r.sourceHost === 'bbc.co.uk'));
});

test('schema drift and unpublished-sheet HTML surface as part errors, never as data', () => {
  assert.match(parseStrikesCsv('Event_ID,Timestamp,Foo\nIRW-1,2026-01-01T00:00:00Z,x\n').error, /schema drift: missing/);
  assert.match(parseStrikesCsv(fx('sheet.unpublished.html')).error, /HTML, not CSV/);
  assert.match(parseStrikesCsv('').error, /empty/i);
});

// ─── feed.json ──────────────────────────────────────────────────────────────

test('feed.json parses against the recorded shape and drops items without coordinates', () => {
  const f = parseFeed(JSON.parse(fx('feed.sample.json')));
  assert.equal(f.error, undefined);
  assert.equal(f.version, '2.1');
  assert.equal(f.windowHours, 48);
  assert.equal(f.updatedAt, '2026-09-11T18:00:47.282Z');
  assert.equal(f.dropped, 1, 'the no-coordinates item is dropped');
  const hostile = f.items.find(i => i.id === 'IRW-1789000000000-9');
  assert.ok(!hostile.text.includes('<script'));
  assert.equal(hostile.sourceUrl, null);
  assert.equal(hostile.location, 'Tehran, Iran');
  assert.equal(parseFeed([]).error, 'feed was not a JSON object');
  assert.equal(parseFeed({ version: '2.1' }).error, 'feed has no items[]');
});

test('mergeEvents joins feed and sheet by canonical id and keeps feed-only items', () => {
  const f = parseFeed(JSON.parse(fx('feed.sample.json')));
  const s = parseStrikesCsv(fx('strikes.sample.csv'));
  const merged = mergeEvents(f.items, s.rows);
  const ids = merged.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  const shared = merged.find(e => e.id === 'IRW-1789142458111-0');
  assert.ok(shared && shared.inFeed, 'sheet row marked as present in the 48 h feed');
  const feedOnly = merged.find(e => e.id === 'IRW-1789099999999-0');
  assert.ok(feedOnly && feedOnly.inFeed && feedOnly.table === 'feed');
  assert.equal(merged[0].at >= merged[merged.length - 1].at, true, 'newest first');
});

// ─── assembly / health ──────────────────────────────────────────────────────

test('buildResult: all parts ok and fresh → live, geometry separate from compact lists', () => {
  const r = buildResult(parts(), NOW);
  assert.equal(r.status, 'live');
  assert.equal(r.stale, false);
  assert.equal(r.error, null);
  assert.deepEqual(r.problems, []);
  assert.equal(r.feedAgeH, 4);
  assert.ok(r.counts.events48h > 0);
  assert.equal(r.counts.outOfTheater, 1, 'Paris row excluded from the theater');
  assert.ok(r.events.every(e => e.inTheater));
  assert.ok(r.geo.events.every(e => e.inTheater));
  assert.equal(r.casualties.military > 0, true);
  assert.ok(r.airspace.length <= new Set(r.airspace.map(a => a.region.toLowerCase())).size, 'one latest row per region');
  assert.ok(r.signals.some(s => s.kind === 'quality' && /single wire/.test(s.text)));
  assert.ok(r.signals.some(s => /outside the theater box/.test(s.text)));
  assert.deepEqual(r.disclaimer, DISCLAIMER);
  assert.equal(classifySource('IranWarLive', r).state, 'live');
});

test('buildResult: a supporting sheet failing → limited with the problem recorded', () => {
  const r = buildResult(parts({ actors: { ok: false, error: 'HTTP 500', rows: [] } }), NOW);
  assert.equal(r.status, 'limited');
  assert.match(r.error, /supporting sheet failed/);
  assert.deepEqual(r.problems, ['actors: HTTP 500']);
  assert.equal(r.parts.actors, 'error');
  assert.equal(r.casualties.military, 0, 'no fabricated totals');
  assert.equal(classifySource('IranWarLive', r).state, 'degraded');
});

test('buildResult: feed down but sheet up → limited; both primaries down → unavailable', () => {
  const noFeed = buildResult(parts({ feed: { ok: false, error: 'HTTP 404', items: [] } }), NOW);
  assert.equal(noFeed.status, 'limited');
  assert.ok(noFeed.counts.events > 0, 'sheet rows still serve the map');
  const dead = buildResult(parts({ feed: { ok: false, error: 'HTTP 404', items: [] }, strikes: { ok: false, error: 'timeout', rows: [] } }), NOW);
  assert.equal(dead.status, 'unavailable');
  assert.match(dead.error, /primary sources failed/);
  assert.equal(dead.events, undefined, 'no data fields on an unavailable result');
  const h = classifySource('IranWarLive', dead);
  assert.equal(h.state, 'off');
});

test('buildResult: stale upstream (>6 h since last_updated) → limited even with rows', () => {
  const later = NOW + (FRESH_AFTER_H + 3) * 3600000;
  const r = buildResult(parts(), later);
  assert.equal(r.status, 'limited');
  assert.match(r.error, /upstream last ran/);
});

test('buildResult: empty successful feed is `empty`, not live and not an error', () => {
  const emptyFeed = { ok: true, ...parseFeed(JSON.parse(fx('feed.empty.json'))) };
  const emptySheet = { ok: true, rows: [], dropped: 0, duplicateHeaders: [] };
  const r = buildResult(parts({ feed: emptyFeed, strikes: emptySheet, ground: emptySheet }), NOW);
  assert.equal(r.status, 'empty');
  assert.equal(r.counts.events, 0);
  assert.equal(r.geo.events.length, 0);
  assert.equal(classifySource('IranWarLive', r).state, 'degraded');
});

test('unavailable() carries attribution + disclaimer so the panel can still explain itself', () => {
  const u = unavailable('boom');
  assert.equal(u.status, 'unavailable');
  assert.equal(u.siteUrl, 'https://iranwarlive.com');
  assert.equal(u.disclaimer.length, 4);
});

// ─── view model ─────────────────────────────────────────────────────────────

test('trimIranWar bounds every list and drops geometry from the client payload', () => {
  const r = buildResult(parts(), NOW);
  const v = trimIranWar(r);
  assert.equal(v.geo, undefined);
  assert.ok(v.events.length <= 60 && v.groundEvents.length <= 40 && v.airspace.length <= 40 && v.posturing.length <= 40);
  assert.ok(v.events.every(e => e.sourceUrl === null || /^https?:/.test(e.sourceUrl)));
  assert.ok(v.events.every(e => !/[<>]/.test(e.text)));
  assert.equal(v.status, 'live');
  assert.equal(v.siteUrl, 'https://iranwarlive.com/');
  assert.equal(v.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(v.disclaimer.length, 4);
  const empty = trimIranWar({});
  assert.equal(empty.status, 'unavailable');
  assert.deepEqual(empty.events, []);
  assert.equal(empty.counts.events48h, 0);
  const junk = trimIranWar({ status: 'live', events: [{ id: 'x', at: 'nope', lat: 999, lon: 35, text: 'a', sourceUrl: 'javascript:1', kind: 'air', type: 'Air Strike', confidence: 'wire' }] });
  assert.equal(junk.events[0].lat, null);
  assert.equal(junk.events[0].at, null);
  assert.equal(junk.events[0].sourceUrl, null);
});

test('corroboration pulls theater items from GDELT/ACLED and windows them', () => {
  const now = NOW;
  const gdelt = { allArticles: [
    { title: 'Iran fires missiles at Israel', url: 'https://example.org/1', date: new Date(now - 3600000).toISOString(), country: 'IR', domain: 'example.org', place: 'Tehran' },
    { title: 'Quarterly earnings beat', url: 'https://example.org/2', date: new Date(now - 3600000).toISOString(), country: 'US', domain: 'example.org' },
    { title: 'Hezbollah strike in Lebanon', url: 'javascript:1', date: new Date(now - 100 * 3600000).toISOString(), country: 'LE', domain: 'example.org' },
  ] };
  const acled = { deadliestEvents: [
    { type: 'Explosions/Remote violence', location: 'Isfahan', country: 'Iran', fatalities: 12, date: new Date(now - 7200000).toISOString() },
    { type: 'Battles', location: 'Khartoum', country: 'Sudan', fatalities: 30, date: new Date(now - 7200000).toISOString() },
  ] };
  const items = corroboration({ gdelt, acled }, now);
  assert.equal(items.length, 2, 'earnings + Sudan filtered, 100 h old Lebanon item outside window');
  assert.ok(items.some(i => i.via === 'GDELT' && i.url === 'https://example.org/1'));
  assert.ok(items.some(i => i.via === 'ACLED' && /Isfahan/.test(i.title)));
  assert.ok(isTheaterText('Houthi attack near Bab el-Mandeb'));
  assert.ok(!isTheaterText('Irani cuisine festival'));
  const view = buildIranWarView({ IranWarLive: buildResult(parts(), NOW), GDELT: gdelt, ACLED: acled }, now);
  assert.equal(view.corroboration.length, 2);
});

// ─── map layers / situation contract ────────────────────────────────────────

test('iran map layers register their marker types and stay data-only (never signal)', () => {
  const kinetic = LAYERS.find(l => l.id === 'iran-kinetic');
  const ground = LAYERS.find(l => l.id === 'iran-ground');
  assert.ok(kinetic && ground);
  assert.deepEqual(kinetic.types, ['iwl-strike', 'iwl-intercept']);
  assert.deepEqual(ground.types, ['iwl-ground']);
  assert.deepEqual(kinetic.sources, ['IranWarLive']);
  const v = trimIranWar(buildResult(parts(), NOW));
  const ev = evaluateLayers({ iranwar: v }).layers;
  const k = ev.find(l => l.id === 'iran-kinetic'), g = ev.find(l => l.id === 'iran-ground');
  assert.ok(k.count > 0 && g.count > 0);
  assert.equal(k.state, 'data');
  assert.equal(g.state, 'data');
  assert.match(k.why, /events\/48 h/);
  const off = evaluateLayers({ iranwar: trimIranWar({ status: 'unavailable' }) }).layers;
  assert.equal(off.find(l => l.id === 'iran-kinetic').state, 'none');
});
