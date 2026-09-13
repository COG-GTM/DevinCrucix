// Ukraine War view model. Runs against recorded fixtures + hand-built adapter payloads only — no network.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildResult } from '../apis/sources/frontlines.mjs';
import {
  buildUkraineView, trimFront, trimAir, trimThermal, trimNuclear, trimWires, trimSdr, trimCii, trimAcled,
  corroboration, dailySeries, isTheaterText, UA_BBOX, GPS_ZONE, TELEGRAM_CHANNELS,
} from '../lib/ukraineview.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deepstate');
const raw = JSON.parse(readFileSync(join(FIX, 'last.sample.json'), 'utf8'));
const history = JSON.parse(readFileSync(join(FIX, 'history.sample.json'), 'utf8'));
const NOW = Date.parse('2026-09-05T18:00:00Z');
const frontlines = buildResult(raw, history, NOW);

const LONG = 'x'.repeat(2000);
const health = [
  { name: 'Frontlines', state: 'live' }, { name: 'OpenSky', state: 'degraded', reason: 'stale' }, { name: 'ADS-B', state: 'live' },
  { name: 'GPSJamming', state: 'live' }, { name: 'FIRMS', state: 'live' }, { name: 'Nuclear', state: 'live' }, { name: 'Safecast', state: 'live' },
  { name: 'GDELT', state: 'live' }, { name: 'Telegram', state: 'live' }, { name: 'Polymarket', state: 'live' }, { name: 'KiwiSDR', state: 'live' },
  { name: 'CII', state: 'live' }, { name: 'ACLED', state: 'no_key', reason: 'needs credentials' },
];

function sources() {
  return {
    Frontlines: frontlines,
    OpenSky: {
      status: 'live', method: 'anonymous',
      hotspots: [
        { region: 'Ukraine Region', key: 'ukraine', totalAircraft: 3, airborne: 2, noCallsign: 1, highAltitude: 1, byCountry: { Poland: 2, Romania: 1 },
          tracks: [
            { icao24: '4ca1b2', callsign: 'LOT123', country: 'Poland', lat: 50.1, lon: 24.5, altitude: 11000, velocity: 240, heading: 90, onGround: false },
            { icao24: 'bad', callsign: LONG, country: 'Romania', lat: 999, lon: 30, altitude: 1, velocity: 1, heading: 1, onGround: false },
          ] },
        { region: 'Taiwan Strait', key: 'taiwan', totalAircraft: 40, tracks: [{ lat: 24, lon: 121 }] },
      ],
    },
    'ADS-B': {
      status: 'live', totalMilitary: 5,
      militaryAircraft: [
        { callsign: 'RFF7123', type: 'IL76', typeDescription: 'Il-76 Candid', latitude: 45.2, longitude: 36.4, altitude: 9000, speed: 400, militaryMatch: 'Russia' },
        { callsign: 'FORTE12', type: 'RQ4', typeDescription: 'RQ-4 Global Hawk', latitude: 44.8, longitude: 30.1, altitude: 16000, speed: 300, militaryMatch: 'callsign pattern' },
        { callsign: 'RCH400', type: 'C17', latitude: 33, longitude: 44, altitude: 9000, speed: 400, militaryMatch: 'USA' },
        { callsign: 'NOPOS', type: 'C17', latitude: null, longitude: null, militaryMatch: 'USA' },
      ],
    },
    GPSJamming: {
      status: 'live', aircraftAnalyzed: 3000,
      zones: [
        { lat: 48.5, lng: 37.5, severity: 'high', ratio: 0.8, degraded: 8, total: 10, gridSize: 1, region: 'Eastern Ukraine' },
        { lat: 49.5, lng: 36.5, severity: 'medium', ratio: 0.5, degraded: 5, total: 10, gridSize: 1, region: 'Eastern Ukraine' },
        { lat: 55.5, lng: 20.5, severity: 'high', ratio: 0.9, degraded: 9, total: 10, gridSize: 1, region: 'Baltic Sea' },
      ],
    },
    FIRMS: {
      status: 'active',
      hotspots: [
        { region: 'Ukraine', totalDetections: 120, highConfidence: 40, nightDetections: 25, avgFRP: 7.2,
          highIntensity: [
            { lat: 48.0, lon: 37.8, brightness: 340, frp: 55.5, date: '2026-09-05', time: '0112', confidence: 'h', daynight: 'N' },
            { lat: 47.1, lon: 35.2, brightness: 320, frp: 22.1, date: '2026-09-05', time: '1130', confidence: 'n', daynight: 'D' },
            { lat: 10, lon: 10, brightness: 300, frp: 99, date: '2026-09-05', time: '1130', confidence: 'n', daynight: 'D' },
          ] },
        { region: 'Gaza / Israel', totalDetections: 9, highIntensity: [] },
      ],
    },
    Nuclear: {
      status: 'live',
      facilities: [
        { name: 'Zaporizhzhia NPP', country: 'UA', lat: 47.507, lng: 34.585, reactors: 6, capacityMW: 5700, operator: 'Energoatom', status: 'occupied', risk: 'critical' },
        { name: 'Rivne NPP', country: 'UA', lat: 51.325, lng: 25.892, reactors: 4, capacityMW: 2835, operator: 'Energoatom', status: 'operational', risk: 'elevated' },
        { name: 'Kursk NPP', country: 'RU', lat: 51.675, lng: 35.607, reactors: 4, capacityMW: 4000, operator: 'Rosenergoatom', status: 'operational', risk: 'elevated' },
        { name: 'Bushehr', country: 'IR', lat: 28.83, lng: 50.89, reactors: 1, status: 'operational' },
        { name: 'NoCoords', country: 'UA', lat: null, lng: null },
      ],
    },
    Safecast: { sites: [{ site: 'Zaporizhzhia NPP', key: 'zaporizhzhia', recentReadings: 12, avgCPM: 38, maxCPM: 61, anomaly: false, lastReading: '2026-09-05T12:00:00Z' }, { site: 'Fukushima', key: 'fukushima', recentReadings: 3 }] },
    GDELT: {
      toneScores: [{ region: 'Ukraine/Russia', articleCount: 80, eventCount: 30, conflictEvents: 12, currentTone: -5.1, previousTone: -4.2, shift: -0.9 }, { region: 'Taiwan Strait', currentTone: -1 }],
      allArticles: [
        { title: 'Russian drones strike Kharkiv overnight', url: 'https://example.com/a', domain: 'example.com', date: '2026-09-05T10:00:00Z', country: 'UP', place: 'Kharkiv' },
        { title: 'Russian drones strike Kharkiv overnight', url: 'https://example.com/dup', domain: 'dup.com', date: '2026-09-05T09:00:00Z', country: 'UP' },
        { title: 'Ukraine strikes refinery in Russia', url: 'javascript:alert(1)', domain: 'bad.com', date: '2026-09-05T08:00:00Z', country: 'RS' },
        { title: 'Markets rally on tech earnings', url: 'https://x.com/b', domain: 'x.com', date: '2026-09-05T08:00:00Z', country: 'US' },
        { title: LONG + ' Donetsk', url: 'https://x.com/c', domain: 'x.com', date: '2026-08-01T08:00:00Z', country: 'UP' },
      ],
      topEvents: [{ headline: 'Fight in Pokrovsk', type: 'Fight', place: 'Pokrovsk', country: 'UP', mentions: 30, goldstein: -10, tone: -8, url: 'https://x.com/e' }, { headline: 'Protest in Paris', country: 'FR', mentions: 12 }],
    },
    Telegram: {
      status: 'live',
      channels: [
        { channel: 'DeepStateUA', title: 'DeepState', topic: 'conflict', postCount: 9, reachable: true },
        { channel: 'mod_russia', title: 'Минобороны России', topic: 'conflict', postCount: 5, reachable: true },
        { channel: 'GeneralStaffZSU', title: 'ЗСУ', topic: 'conflict', postCount: 0, reachable: false },
        { channel: 'disclosetv', title: 'Disclose.tv', topic: 'geopolitics', postCount: 40, reachable: true },
      ],
      topPosts: [
        { channel: 'DeepStateUA', postId: 123456, text: 'Ворог просунувся поблизу Покровська', date: '2026-09-05T11:00:00Z', views: 4000, urgentFlags: true },
        { channel: 'mod_russia', postId: 'abc', text: '<b>Сводка</b> ' + LONG, date: '2026-09-05T10:00:00Z', views: 100 },
        { channel: 'disclosetv', postId: 99, text: 'Unrelated world news', date: '2026-09-05T10:00:00Z', views: 100 },
      ],
    },
    Polymarket: {
      status: 'live',
      markets: [
        { question: 'Russia x Ukraine ceasefire in 2026?', yesProb: 0.21, change24h: -0.02, volume24hr: 15000, url: 'https://polymarket.com/event/x' },
        { question: 'Will Putin meet Zelensky?', yesProb: 0.05, url: 'ftp://polymarket.com/nope' },
        { question: 'Fed cuts rates in October?', yesProb: 0.7, url: 'https://polymarket.com/event/fed' },
      ],
    },
    KiwiSDR: { conflictZones: { ukraine: { region: 'Ukraine / Eastern Europe', count: 2, receivers: [{ name: 'Kyiv RX', location: 'Kyiv', lat: 50.4, lon: 30.5, users: 2, country: 'UA' }, { name: 'Far', location: 'Nowhere', lat: 10, lon: 10, users: 0 }] } } },
    CII: { status: 'live', countries: [{ code: 'UA', name: 'Ukraine', lat: 49, lng: 32, score: 78, level: 'critical', trend: 'rising', trendDelta: 3, components: { unrest: 20, security: 50, information: 8 }, boosts: { hotspot: 5, total: 5 } }, { code: 'RU', name: 'Russia', score: 61, level: 'high', trend: 'stable', trendDelta: 0, components: {} }, { code: 'MX', name: 'Mexico', score: 55 }] },
    ACLED: { status: 'no_key', message: 'Set ACLED_KEY', deadliestEvents: [{ date: '2026-09-04', type: 'Shelling', country: 'Ukraine', location: 'Kherson', fatalities: 3, lat: 46.6, lon: 32.6 }] },
  };
}

describe('front', () => {
  const f = trimFront(frontlines, health, NOW);
  it('carries the DeepStateMAP KPIs, provenance and per-day series', () => {
    assert.equal(f.live, true);
    assert.equal(f.provider, 'DeepStateMAP');
    assert.equal(f.siteUrl, frontlines.siteUrl);
    assert.equal(f.health.state, 'live');
    assert.equal(f.mapId, raw.id);
    assert.equal(f.occupiedKm2, frontlines.occupiedKm2);
    assert.equal(f.attackDirections, 3);
    assert.equal(f.units, 3);
    assert.equal(f.history.recent7d, 5);
    assert.equal(f.history.advances7d, 4);
    assert.equal(f.history.regains7d, 1);
    assert.equal(f.history.series7d.length, 8, 'today plus seven full UTC days');
    assert.equal(f.history.series30d.length, 31);
    assert.equal(f.history.series30d.at(-1).day, '2026-09-05');
    assert.equal(f.history.series7d[0].day, '2026-08-29');
    const adv = f.history.series7d.reduce((s, d) => s + d.advances, 0);
    const reg = f.history.series7d.reduce((s, d) => s + d.regains, 0);
    assert.equal(adv, 4);
    assert.equal(reg, 1);
    assert.ok(f.history.advances30d >= f.history.advances7d);
    assert.ok(f.history.updates.length > 0 && f.history.updates.every(u => u.at && u.text.length <= 240 && u.places.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))));
  });
  it('is honest about an unavailable front', () => {
    const u = trimFront({ status: 'unavailable', error: 'timeout' }, [{ name: 'Frontlines', state: 'error', reason: 'timeout' }], NOW);
    assert.equal(u.live, false);
    assert.equal(u.health.state, 'error');
    assert.equal(u.occupiedKm2, 0);
    assert.deepEqual(u.history.updates, []);
    assert.equal(u.history.series7d.length, 8);
    assert.equal(u.siteUrl, 'https://deepstatemap.live/en');
  });
  it('dailySeries buckets by UTC day and ignores unparsable dates', () => {
    const s = dailySeries([{ at: '2026-09-05T01:00:00Z', kind: 'advance' }, { at: '2026-09-03T23:59:00Z', kind: 'regain' }, { at: 'nope', kind: 'advance' }, { at: '2026-01-01T00:00:00Z', kind: 'advance' }], 7, NOW);
    assert.equal(s.at(-1).advances, 1);
    assert.equal(s.find(d => d.day === '2026-09-03').regains, 1);
    assert.equal(s.reduce((a, d) => a + d.advances + d.regains + d.other, 0), 2);
  });
});

describe('air / EW', () => {
  const a = trimAir(sources(), health);
  it('keeps only the ukraine OpenSky box and validated tracks', () => {
    assert.equal(a.opensky.present, true);
    assert.equal(a.opensky.total, 3);
    assert.equal(a.opensky.health.state, 'degraded');
    assert.equal(a.opensky.tracks.length, 1);
    assert.equal(a.opensky.tracks[0].callsign, 'LOT123');
    assert.deepEqual(a.opensky.byCountry, [['Poland', 2], ['Romania', 1]]);
  });
  it('filters ADS-B to the Ukraine / Black Sea box and flags RF/RFF callsigns', () => {
    assert.equal(a.adsb.inTheater, 2);
    assert.equal(a.adsb.ruCount, 1);
    assert.deepEqual(a.adsb.ruCallsigns, ['RFF7123']);
    assert.ok(a.adsb.aircraft.every(x => Number.isFinite(x.lat) && Number.isFinite(x.lon)));
    assert.ok(!a.adsb.aircraft.some(x => x.callsign === 'RCH400' || x.callsign === 'NOPOS'));
  });
  it('keeps only the Eastern Ukraine jamming zone', () => {
    assert.equal(a.gps.zone, GPS_ZONE.name);
    assert.equal(a.gps.zones.length, 2);
    assert.equal(a.gps.high, 1);
    assert.equal(a.gps.medium, 1);
  });
  it('is empty and OFF when the adapters never ran', () => {
    const e = trimAir({}, []);
    assert.equal(e.opensky.present, false);
    assert.equal(e.opensky.health.state, null);
    assert.deepEqual(e.opensky.tracks, []);
    assert.deepEqual(e.adsb.aircraft, []);
    assert.deepEqual(e.gps.zones, []);
  });
});

describe('thermal / nuclear / sdr / cii / acled', () => {
  const S = sources();
  it('FIRMS ukraine bbox only, rows inside the theater', () => {
    const t = trimThermal(S, health);
    assert.equal(t.present, true);
    assert.equal(t.total, 120);
    assert.equal(t.night, 25);
    assert.equal(t.highIntensity, 3);
    assert.equal(t.rows.length, 2);
    assert.ok(t.rows.every(r => r.lat >= UA_BBOX.lamin && r.lat <= UA_BBOX.lamax && r.lon >= UA_BBOX.lomin && r.lon <= UA_BBOX.lomax));
    assert.equal(t.rows[0].night, true);
    const off = trimThermal({ FIRMS: { hotspots: [{ region: 'Ukraine', error: 'FIRMS_MAP_KEY missing' }] } }, [{ name: 'FIRMS', state: 'no_key' }]);
    assert.equal(off.present, false);
    assert.equal(off.health.state, 'no_key');
    assert.deepEqual(off.rows, []);
  });
  it('nuclear UA/RU only, ZNPP first, Safecast ring attached', () => {
    const n = trimNuclear(S, health);
    assert.deepEqual(n.facilities.map(f => f.name), ['Zaporizhzhia NPP', 'Rivne NPP', 'Kursk NPP']);
    assert.equal(n.znpp.status, 'occupied');
    assert.equal(n.znpp.risk, 'critical');
    assert.equal(n.safecast.present, true);
    assert.equal(n.safecast.avgCPM, 38);
    assert.equal(n.safecast.lastReading, '2026-09-05T12:00:00.000Z');
    const e = trimNuclear({}, []);
    assert.deepEqual(e.facilities, []);
    assert.equal(e.znpp, null);
    assert.equal(e.safecast.present, false);
  });
  it('KiwiSDR receivers only inside the theater box', () => {
    const k = trimSdr(S, health);
    assert.equal(k.count, 2);
    assert.equal(k.receivers.length, 1);
    assert.equal(k.listening, 1);
    assert.equal(trimSdr({}, []).present, false);
  });
  it('CII keeps UA + RU rows only, UA first', () => {
    const c = trimCii(S, health);
    assert.deepEqual(c.rows.map(r => r.code), ['UA', 'RU']);
    assert.equal(c.rows[0].components.security, 50);
    assert.equal(c.rows[0].boosts.hotspot, 5);
    assert.deepEqual(trimCii({}, []).rows, []);
  });
  it('ACLED stays NO KEY and UA/RU only', () => {
    const a = trimAcled(S, health);
    assert.equal(a.health.state, 'no_key');
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0].location, 'Kherson');
  });
});

describe('wires', () => {
  const w = trimWires(sources(), health, NOW);
  it('GDELT theater tone + deduped, bounded, http(s)-only titles', () => {
    assert.equal(w.gdelt.tone.currentTone, -5.1);
    assert.equal(w.gdelt.titles.length, 3);
    assert.equal(w.gdelt.titles[0].title, 'Russian drones strike Kharkiv overnight');
    assert.equal(w.gdelt.titles[0].url, 'https://example.com/a');
    assert.equal(w.gdelt.titles.find(t => t.domain === 'bad.com').url, null);
    assert.ok(w.gdelt.titles.every(t => t.title.length <= 160));
    assert.ok(!w.gdelt.titles.some(t => /Markets rally/.test(t.title)));
    assert.equal(w.gdelt.events.length, 1);
  });
  it('Telegram is limited to the Ukraine / Russia channels with bounded text and safe links', () => {
    assert.equal(w.telegram.monitored, 3);
    assert.equal(w.telegram.reachable, 2);
    assert.equal(w.telegram.posts.length, 2);
    assert.ok(w.telegram.posts.every(p => TELEGRAM_CHANNELS.includes(p.channel) && p.text.length <= 260));
    assert.equal(w.telegram.posts[0].url, 'https://t.me/DeepStateUA/123456');
    assert.equal(w.telegram.posts[1].url, null);
    assert.equal(w.telegram.posts[0].side, 'UA');
    assert.equal(w.telegram.posts[1].side, 'RU');
  });
  it('Polymarket keeps Russia / Ukraine markets and http(s) URLs only', () => {
    assert.equal(w.polymarket.markets.length, 2);
    assert.equal(w.polymarket.markets[1].url, null);
    assert.ok(!w.polymarket.markets.some(m => /Fed cuts/.test(m.question)));
  });
  it('is empty when nothing ran', () => {
    const e = trimWires({}, [], NOW);
    assert.equal(e.gdelt.tone, null);
    assert.deepEqual(e.gdelt.titles, []);
    assert.deepEqual(e.telegram.posts, []);
    assert.deepEqual(e.polymarket.markets, []);
  });
});

describe('corroboration + buildUkraineView', () => {
  it('merges GDELT / Telegram / ACLED items in the 72 h window, deduped and sorted', () => {
    const w = trimWires(sources(), health, NOW);
    const c = corroboration({ gdelt: w.gdelt, telegram: w.telegram, acled: trimAcled(sources(), health) }, NOW);
    assert.ok(c.length >= 4);
    assert.ok(c.every(i => ['GDELT', 'Telegram', 'ACLED'].includes(i.via) && i.title.length <= 160));
    assert.ok(!c.some(i => i.title.startsWith('xxxx')), 'stale (Aug 1) item dropped by the 72 h window');
    for (let i = 1; i < c.length; i++) assert.ok(String(c[i - 1].at || '') >= String(c[i].at || ''));
    assert.deepEqual(corroboration({}, NOW), []);
  });
  it('builds the full bounded slice from populated sources', () => {
    const v = buildUkraineView(sources(), health, NOW);
    assert.equal(v.source, 'UkraineWar');
    assert.deepEqual(v.bbox, UA_BBOX);
    assert.equal(v.front.live, true);
    assert.equal(v.air.adsb.ruCount, 1);
    assert.equal(v.thermal.total, 120);
    assert.equal(v.nuclear.znpp.name, 'Zaporizhzhia NPP');
    assert.equal(v.wires.telegram.posts.length, 2);
    assert.equal(v.cii.rows.length, 2);
    assert.equal(v.acled.health.state, 'no_key');
    assert.ok(v.corroboration.length > 0);
    assert.match(v.attribution, /DeepStateMAP \(deepstatemap\.live\)/);
    assert.match(v.caveat, /not verified ground truth/);
    assert.ok(!('geo' in v.front), 'front geometry stays on /api/frontlines/geo');
    const json = JSON.stringify(v);
    assert.ok(json.length < 60000, `payload bounded (${json.length} bytes)`);
    assert.ok(!json.includes(LONG.slice(0, 300)), 'oversized third-party strings are cut');
  });
  it('degrades to an honest empty slice on offline / empty inputs', () => {
    for (const input of [undefined, {}, { Frontlines: { status: 'unavailable' } }]) {
      const v = buildUkraineView(input, [], NOW);
      assert.equal(v.front.live, false);
      assert.deepEqual(v.front.history.updates, []);
      assert.deepEqual(v.air.opensky.tracks, []);
      assert.deepEqual(v.thermal.rows, []);
      assert.deepEqual(v.nuclear.facilities, []);
      assert.deepEqual(v.wires.telegram.posts, []);
      assert.deepEqual(v.cii.rows, []);
      assert.deepEqual(v.corroboration, []);
      assert.equal(v.front.health.state, null);
    }
  });
});

test('isTheaterText matches the theater vocabulary only', () => {
  assert.equal(isTheaterText('Shelling reported near Kherson'), true);
  assert.equal(isTheaterText('Kremlin statement on talks'), true);
  assert.equal(isTheaterText('Fed holds rates steady'), false);
});
