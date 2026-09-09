// Cartels adapter (Google My Maps KML) + START 2020 baseline + dashboard view model — fixture-only, no network.
// The fixture is a reduced hand-written KML with one placemark per folder we classify, a StyleMap
// (normal/highlight), a placemark with no geometry, an unknown folder, and hostile third-party text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  cleanText, firstUrl, mentionedDate, kmlColor, classifyOrg, orgsMentioned,
  parseKml, summarize, buildResult, ORGS, LAYER_LABELS, CARTEL_MAP_ID, PROVIDER,
} from '../apis/sources/cartels.mjs';
import { buildCartelsView, trimCartels, trimBaseline, regionFeed, isRegionText, loadBaseline, decodeEntities } from '../lib/cartelview.mjs';
import { evaluateLayers } from '../lib/maplayers.mjs';
import { buildSituation, TABS } from '../lib/situation.mjs';
import { computeDelta } from '../lib/delta/engine.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cartels');
const xml = readFileSync(join(FIX, 'cartels.sample.kml'), 'utf8');
// Fixed clock a few days after the fixture's newest dated entry (2026-09-03).
const NOW = Date.parse('2026-09-06T12:00:00Z');
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'public', 'jarvis.html'), 'utf8');

describe('text helpers', () => {
  it('cleanText strips tags/entities, collapses whitespace and bounds length', () => {
    assert.equal(cleanText('<b>Los  Chapitos</b> &amp; friends\n\n', 100), 'Los Chapitos & friends');
    const long = cleanText('x'.repeat(50), 10);
    assert.equal(long.length, 10);
    assert.ok(long.endsWith('…'));
  });
  it('firstUrl finds the first http(s) link and trims trailing punctuation', () => {
    assert.equal(firstUrl('see https://example.org/news/culiacan, more'), 'https://example.org/news/culiacan');
    assert.equal(firstUrl('no link'), null);
    assert.equal(firstUrl('javascript:alert(1)'), null);
  });
  it('mentionedDate handles US numeric, ISO and prose forms and rejects nonsense', () => {
    assert.equal(mentionedDate('09/01/2026 | Culiacán'), '2026-09-01');
    assert.equal(mentionedDate('since 2024-09-09'), '2024-09-09');
    assert.equal(mentionedDate('SEDENA raid — Sept 3 2026'), '2026-09-03');
    assert.equal(mentionedDate('As of May 2024'), '2024-05-01');
    assert.equal(mentionedDate('99/99/2026'), null);
    assert.equal(mentionedDate('nothing here'), null);
  });
  it('kmlColor converts aabbggrr to #rrggbb + alpha', () => {
    assert.deepEqual(kmlColor('805252ff'), { hex: '#ff5252', alpha: 128 / 255 });
    assert.equal(kmlColor('nope'), null);
  });
});

describe('organization matching', () => {
  it('prefers factions over their parent and drops the redundant parent', () => {
    assert.equal(classifyOrg('Los Chapitos Culiacán', 'influence').id, 'sinaloa_chapitos');
    assert.deepEqual(orgsMentioned('Cártel de Sinaloa (Los Chapitos) vs CJNG'), ['cjng', 'sinaloa_chapitos']);
    assert.deepEqual(orgsMentioned('Zetas Vieja Escuela vs Los Zetas'), ['zve']);
  });
  it('routes editorial/analysis polygons to the analysis pseudo-org only on shape layers', () => {
    assert.equal(classifyOrg('Situation In CDMX', 'influence').id, 'analysis');
    assert.equal(classifyOrg('Situation In CDMX', 'activity').id, 'other');
    assert.equal(classifyOrg('Unattributed thing', 'influence').id, 'other');
  });
  it('every org has a unique id, a valid colour and a regex', () => {
    const ids = new Set(ORGS.map(o => o.id));
    assert.equal(ids.size, ORGS.length);
    for (const o of ORGS) {
      assert.match(o.color, /^#[0-9a-f]{6}$/i, o.id);
      assert.ok(o.re instanceof RegExp, o.id);
      assert.ok(o.short.length <= 16, `${o.id} short label too long for a map label`);
    }
  });
});

describe('KML parsing', () => {
  const parsed = parseKml(xml);

  it('reads the document name, disclaimer lines and colour legend separately', () => {
    assert.equal(parsed.docName, 'Active Cartels In Mexico 2026');
    assert.equal(parsed.disclaimer.length, 2);
    assert.match(parsed.disclaimer[0], /not 100% accurate/);
    assert.deepEqual(parsed.legend.map(l => l.swatch), ['Red', 'Purple']);
    assert.equal(parsed.legend[1].text, 'Sinaloa Cartel (La Mayiza)');
  });

  it('classifies every folder into a CRUCIX layer and counts placemarks with geometry', () => {
    assert.deepEqual(parsed.layerCounts, {
      influence: 3, activity: 2, gov_ops: 1, wars: 1, truces: 1, alliances: 1, strongholds: 1, us_activity: 1, other: 1,
    });
    assert.equal(parsed.skipped, 1, 'placemark without geometry is counted, not silently dropped');
    for (const k of Object.keys(parsed.layerCounts)) assert.ok(LAYER_LABELS[k], `label for ${k}`);
  });

  it('separates polygons, points and lines with bounded records', () => {
    assert.equal(parsed.polygons.length, 2);
    assert.equal(parsed.points.length, 8);
    assert.equal(parsed.lines.length, 2);
    const cjng = parsed.polygons.find(p => p.name === 'CJNG Colima');
    assert.equal(cjng.layer, 'influence');
    assert.equal(cjng.org, 'cjng');
    assert.ok(cjng.areaKm2 > 5000 && cjng.areaKm2 < 10000, `area ${cjng.areaKm2}`);
    assert.ok(Math.abs(cjng.centroid.lat - 19.1) < 0.2 && Math.abs(cjng.centroid.lon + 103.95) < 0.2);
    assert.equal(cjng.link, 'https://example.org/colima');
    assert.equal(cjng.date, null, 'influence polygons never carry an activity date');
    assert.deepEqual(cjng.rings[0][0], cjng.rings[0][cjng.rings[0].length - 1], 'ring stays closed');
  });

  it('resolves StyleMap -> normal Style for fill and stroke colours', () => {
    const cjng = parsed.polygons.find(p => p.name === 'CJNG Colima');
    assert.equal(cjng.fill, '#ff5252');
    assert.equal(cjng.fillAlpha, 0.5);
    assert.equal(cjng.stroke, '#ff5252');
    const war = parsed.points.find(p => p.layer === 'wars');
    assert.equal(war.color, '#ff1744');
    const alliance = parsed.lines.find(l => l.layer === 'alliances');
    assert.equal(alliance.color, '#b39ddb');
    assert.equal(alliance.width, 1.5);
  });

  it('does not treat dates in influence prose as activity, but does for event layers', () => {
    const cdmx = parsed.polygons.find(p => p.name === 'Situation In CDMX');
    assert.equal(cdmx.org, 'analysis');
    assert.equal(cdmx.date, null);
    const shooting = parsed.points.find(p => p.layer === 'activity' && p.date);
    assert.equal(shooting.date, '2026-09-01');
    assert.equal(parsed.points.find(p => p.layer === 'gov_ops').date, '2026-09-03');
    assert.equal(parsed.points.find(p => p.layer === 'wars').date, '2024-09-09');
  });

  it('strips hostile markup from names/descriptions and keeps the link + image flag', () => {
    const shooting = parsed.points.find(p => p.layer === 'activity' && p.date);
    assert.ok(!/<script|<img|<b>/i.test(shooting.name + shooting.desc), 'no tags survive ingestion');
    assert.match(shooting.name, /alert\(1\)/, 'text content is kept as text, not executed');
    assert.equal(shooting.link, 'https://example.org/news/culiacan');
    assert.equal(shooting.hasImage, true);
    assert.deepEqual(shooting.involved, ['sinaloa_chapitos', 'sinaloa_mayiza'], 'orgs taken from the description when the name has none');
  });

  it('attributes wars/truces/alliances to every organization named', () => {
    assert.deepEqual(parsed.points.find(p => p.layer === 'wars').involved, ['cjng', 'sinaloa_mayiza']);
    assert.deepEqual(parsed.points.find(p => p.layer === 'truces').involved, ['cdn', 'golfo']);
    assert.deepEqual(parsed.lines.find(l => l.layer === 'alliances').involved, ['cjng', 'sinaloa_chapitos']);
  });

  it('tolerates garbage input', () => {
    const empty = parseKml('<kml><Document><name>x</name></Document></kml>');
    assert.equal(empty.polygons.length + empty.points.length + empty.lines.length, 0);
    assert.equal(parseKml('').docName, 'Active Cartels In Mexico');
    const bad = parseKml('<kml><Folder><name>Active Wars</name><Placemark><name>w</name><Point><coordinates>999,999,0</coordinates></Point></Placemark></Folder></kml>');
    assert.equal(bad.points.length, 0, 'out-of-range coordinates are rejected');
  });
});

describe('summary', () => {
  const parsed = parseKml(xml);
  const s = summarize(parsed, NOW);

  it('ranks organizations by drawn influence area and never lists analysis/other', () => {
    assert.equal(s.orgs[0].id, 'cjng');
    assert.ok(s.orgs.every(o => o.id !== 'analysis' && o.id !== 'other'));
    assert.equal(s.orgCount, s.orgs.length);
    const cjng = s.orgs[0];
    assert.equal(cjng.polygons, 1);
    assert.equal(cjng.wars, 1);
    assert.equal(cjng.strongholds, 1);
  });
  it('splits attributed influence from disputed/analysis area', () => {
    assert.ok(s.influenceKm2 > 0);
    assert.ok(s.disputedKm2 > 0);
    assert.notEqual(s.influenceKm2, s.disputedKm2);
  });
  it('builds recent/dated lists from event layers only, newest first', () => {
    assert.equal(s.latestMention, '2026-09-03');
    assert.deepEqual(s.recent.map(r => r.date), ['2026-09-03', '2026-09-01', '2024-09-09']);
    assert.equal(s.activityLast30d, 2);
    assert.equal(s.wars.length, 1);
    assert.equal(s.truces.length, 1);
    assert.equal(s.alliances.length, 1);
    assert.equal(s.usActivity.length, 1);
  });
});

describe('buildResult', () => {
  it('returns a live result with summary and geometry as separate branches', () => {
    const r = buildResult(xml, NOW);
    assert.equal(r.status, 'live');
    assert.equal(r.source, 'Cartels');
    assert.equal(r.provider, PROVIDER);
    assert.equal(r.mapId, CARTEL_MAP_ID);
    assert.match(r.caveat, /not verified control of territory/);
    assert.equal(r.featureCount, 12);
    assert.equal(r.geo.polygons.length, 2);
    assert.equal(r.geo.points.length, 8);
    assert.equal(r.geo.lines.length, 2);
    assert.ok(r.signals.some(x => x.kind === 'fresh'), 'fresh signal when latest mention is within 7 days');
    assert.ok(!r.signals.some(x => x.kind === 'wars'), 'one war is not a wars signal');
  });
  it('a KML with no placemarks is `empty`, not `live`', () => {
    const r = buildResult('<kml><Document><name>Empty</name></Document></kml>', NOW);
    assert.equal(r.status, 'empty');
    assert.equal(r.geo, undefined);
  });
  it('an old map does not raise the fresh signal', () => {
    const r = buildResult(xml, NOW + 60 * 86400000);
    assert.ok(!r.signals.some(x => x.kind === 'fresh'));
  });
});

describe('dashboard view model', () => {
  const live = buildResult(xml, NOW);

  it('trimCartels keeps the summary, drops geometry, and bounds every string', () => {
    const t = trimCartels(live);
    assert.equal(t.geo, undefined);
    assert.equal(t.status, 'live');
    assert.equal(t.stale, false);
    assert.equal(t.disclaimer.length, 2);
    assert.deepEqual(t.legend[0], { swatch: 'Red', text: 'CJNG' });
    assert.equal(t.orgs[0].id, 'cjng');
    assert.equal(t.recent[0].link, null);
    assert.equal(t.recent[1].link, 'https://example.org/news/culiacan');
    const huge = trimCartels({ ...live, caveat: 'x'.repeat(5000), wars: Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: 'w'.repeat(1000), involved: [] })) });
    assert.equal(huge.caveat.length, 300);
    assert.equal(huge.wars.length, 60);
    assert.equal(huge.wars[0].name.length, 200);
  });
  it('trimCartels reports unavailable/stale states honestly', () => {
    const off = trimCartels({ status: 'unavailable', error: 'KML fetch error: 503' });
    assert.equal(off.status, 'unavailable');
    assert.equal(off.error, 'KML fetch error: 503');
    assert.equal(off.orgs.length, 0);
    const stale = trimCartels({ ...live, stale: true, cacheAgeH: 50.2, status: 'stale' });
    assert.equal(stale.stale, true);
    assert.equal(stale.cacheAgeH, 50.2);
  });
  it('trimBaseline carries provenance and every START layer', () => {
    const b = trimBaseline(loadBaseline());
    assert.equal(b.asOf, '2020-06');
    assert.match(b.provider, /START/);
    assert.match(b.caveat, /NOT current control of territory/);
    assert.equal(b.seriesUrl, 'https://www.start.umd.edu/tracking-cartels-infographic-series');
    assert.equal(b.briefs.length, 4);
    for (const x of b.briefs) assert.match(x.url, /^https:\/\/www\.start\.umd\.edu\/pubs\/JointCOEProject_TrackingCartels0[1-4]_/);
    assert.equal(b.states.length, 32, 'all 32 Mexican states');
    assert.equal(b.states.filter(s => s.density).length, 31);
    assert.equal(b.states.filter(s => s.cjng).length, 23, 'CJNG in 23 states per the brief');
    assert.equal(Object.keys(b.densityClasses).length, 5);
    assert.ok(b.states.every(s => !s.density || b.densityClasses[s.density]), 'every state class exists in the legend');
    assert.equal(b.cities.length, 7);
    assert.ok(b.portsIntoMexico.length && b.pointsOfEntryUS.length && b.flows.length);
    assert.equal(b.cjngTimeline.length, 8);
    assert.deepEqual(b.hotspots.map(h => h.id).sort(), ['avocado_michoacan', 'huachicol_guanajuato']);
    assert.ok(b.states.some(s => /Chihuahua|Guanajuato/.test(s.name) && s.note), 'visually sampled states carry an uncertainty note');
  });
  it('regionFeed keeps only Mexico / Northern Triangle items, decodes entities, drops non-http links', () => {
    const feed = regionFeed({
      insightCrime: { articles: [
        { title: 'CJNG expands in Jalisco', link: 'https://insightcrime.org/a', date: '2026-09-05T00:00:00Z', entities: ['CJNG'] },
        { title: 'Colombia coca report', link: 'https://insightcrime.org/b', date: '2026-09-05T00:00:00Z' },
      ] },
      borderNews: { articles: [
        { title: 'Guns smuggled from Texas &#x2013; Mexico says', outlet: 'Border Report', url: 'javascript:alert(1)', publishedAt: '2026-09-04T00:00:00Z', tags: { topics: ['cartels'] } },
        { title: 'Old cartel story', outlet: 'Border Report', url: 'https://x.org/old', publishedAt: '2026-06-01T00:00:00Z', tags: { topics: ['cartels'] } },
      ] },
      gdelt: { allArticles: [
        { title: 'Fentanyl seized in Winnipeg', country: 'CA', url: 'https://cbc.ca/x', date: '2026-09-06T00:00:00Z' },
        { title: 'Army operation in Sinaloa', country: 'MX', place: 'Culiacan, Sinaloa, Mexico', domain: 'reuters.com', url: 'https://reuters.com/x', date: '2026-09-06T00:00:00Z' },
      ] },
    }, NOW);
    assert.deepEqual(feed.map(f => f.title), ['Army operation in Sinaloa', 'CJNG expands in Jalisco', 'Guns smuggled from Texas – Mexico says']);
    assert.equal(feed[2].url, null, 'non-http link is dropped');
    assert.equal(isRegionText('fentanyl'), false, 'a drug name alone is not a region match');
    assert.equal(decodeEntities('&#xFFFFFF; &#0; &amp;'), '&#xFFFFFF; &#0; &');
  });
  it('buildCartelsView assembles current + baseline + feed with no geometry', () => {
    const v = buildCartelsView({ Cartels: live }, { now: NOW });
    assert.equal(v.status, 'live');
    assert.equal(v.geo, undefined);
    assert.equal(v.baseline.asOf, '2020-06');
    assert.deepEqual(v.feed, []);
    const payload = JSON.stringify(v);
    assert.ok(payload.length < 60000, `payload ${payload.length} bytes should stay small without geometry`);
    assert.ok(!/"rings"/.test(payload));
  });
});

describe('situation / map layers / delta hooks', () => {
  const live = trimCartels(buildResult(xml, NOW));

  it('cartels is a tab and the map layer counts only live, non-empty data', () => {
    assert.ok(TABS.includes('cartels'));
    const on = evaluateLayers({ cartels: live }).layers.find(l => l.id === 'cartels');
    assert.equal(on.count, 10);
    assert.equal(on.state, 'data', 'crowd-sourced data is never `signal`');
    assert.match(on.why, /3 influence areas/);
    const off = evaluateLayers({ cartels: { status: 'unavailable' } }).layers.find(l => l.id === 'cartels');
    assert.equal(off.count, 0);
    assert.equal(off.state, 'none');
    const stale = evaluateLayers({ cartels: { ...live, stale: true } }).layers.find(l => l.id === 'cartels');
    assert.match(stale.why, /cached copy/);
  });

  it('situation rule is info-level, current-only, and silent when stale or old', () => {
    const fresh = { ...live, latestMention: new Date(Date.now() - 86400000).toISOString().slice(0, 10) };
    const s = buildSituation({ cartels: fresh });
    const h = s.headlines.find(x => x.rule === 'cartels');
    assert.ok(h, 'headline present for a fresh live map');
    assert.equal(h.severity, 'info');
    assert.equal(h.tab, 'cartels');
    assert.match(h.why, /unverified/i);
    assert.equal(buildSituation({ cartels: { ...fresh, stale: true } }).headlines.find(x => x.rule === 'cartels'), undefined);
    assert.equal(buildSituation({ cartels: { ...fresh, latestMention: '2020-06-01' } }).headlines.find(x => x.rule === 'cartels'), undefined);
    assert.equal(buildSituation({ cartels: { status: 'unavailable' } }).headlines.find(x => x.rule === 'cartels'), undefined);
  });

  it('delta metric tracks wars only between two live sweeps', () => {
    const prev = { cartels: { ...live, wars: [] } };
    const d = computeDelta({ cartels: live }, prev);
    const hit = Object.values(d.signals).flat().find(s => s.key === 'cartel_wars');
    assert.ok(hit, 'war count change surfaced');
    const outage = computeDelta({ cartels: { status: 'unavailable', wars: [] } }, { cartels: live });
    assert.equal(Object.values(outage.signals).flat().filter(s => s.key === 'cartel_wars').length, 0, 'an outage never reads as wars ending');
  });
});

describe('dashboard wiring (static checks)', () => {
  it('has an independent CARTELS tab with its own rail, grid, map and panels', () => {
    assert.match(html, /\{id:'cartels',label:'Cartels'/, 'tab registered in the tab bar');
    assert.match(html, /id="cartelMapSvg"/);
    for (const fn of ['renderCartelSourcePanel', 'renderCartelOrgsPanel', 'renderCartelMapPanel', 'renderCartelWarsPanel', 'renderCartelActivityPanel', 'renderCartelBaselinePanel', 'renderCartelFeedPanel', 'initCartelMap', 'loadCartelGeo', 'ctFeaturePop']) {
      assert.match(html, new RegExp(`function ${fn}\\(`), fn);
    }
    assert.match(html, /\/api\/cartels\/geo/);
  });
  it('dashboard layer registry covers every adapter layer plus the START historical layers', () => {
    const m = /const CT_LAYERS=\[([\s\S]*?)\];/.exec(html);
    assert.ok(m, 'CT_LAYERS found');
    const ids = [...m[1].matchAll(/id:'([a-z_]+)'/g)].map(x => x[1]);
    for (const k of Object.keys(LAYER_LABELS)) assert.ok(ids.includes(k), `dashboard layer for ${k}`);
    const hist = ids.filter(i => i.startsWith('h_'));
    assert.deepEqual(hist.sort(), ['h_cities', 'h_cjng', 'h_density', 'h_flows', 'h_hotspots', 'h_ports', 'h_timeline']);
    const eras = [...m[1].matchAll(/id:'([a-z_]+)'[^}]*era:'(now|2020)'/g)];
    for (const [, id, era] of eras) assert.equal(era, id.startsWith('h_') ? '2020' : 'now', `${id} era`);
  });
  it('popup and panels escape third-party text and keep the crowd-sourced caveat', () => {
    const pop = /function ctFeaturePop\(p\)\{([\s\S]*?)\n\}/.exec(html)[1];
    assert.match(pop, /esc\(p\.desc\)/);
    assert.match(pop, /esc\(p\.date\)/);
    assert.match(pop, /safeExternalUrl\(p\.link\)/);
    assert.match(pop, /rel="noopener noreferrer"/);
    assert.match(pop, /unverified, not control of territory/);
    assert.match(html, /HISTORICAL \\u00b7 START June 2020/);
  });
  it('keeps the Cognition footer', () => {
    assert.match(html, /Built with Devin &middot; <b>Cognition AI<\/b>/);
  });
});
