// Contact provenance (Velocity model) + replay store — pure functions and the JSONL history,
// then the /api/contacts routes over loopback. No external network.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fuseAirContacts, scoreContact, compactProv, haversineKm, regionFor, AGREE_KM, FRESH_S, RULE } from '../lib/contacts/provenance.mjs';
import { ContactHistory, RETENTION_HOURS, MAX_FRAMES } from '../lib/contacts/history.mjs';

const NOW = Date.parse('2026-10-04T02:00:00Z');
const sec = NOW / 1000;

const track = (o) => ({ icao24: 'ae1234', callsign: 'RCH101', country: 'United States', lat: 48.5, lon: 31.0, altitude: 10000, velocity: 220, heading: 90, verticalRate: 0, squawk: null, onGround: false, lastContact: sec - 20, ...o });
const hotspot = (tracks, method = 'opensky') => ({ region: 'Ukraine Region', key: 'ukraine', method, lamin: 44, lomin: 22, lamax: 53, lomax: 41, totalAircraft: tracks.length, byCountry: {}, noCallsign: 0, highAltitude: 0, tracks });
const mil = (o) => ({ hex: 'ae1234', callsign: 'RCH101', type: 'C17', typeDescription: 'C-17 Globemaster', latitude: 48.52, longitude: 31.05, altitude: 33000, speed: 430, heading: 91, seen: 5, isMilitary: true, militaryMatch: 'US military', ...o });

describe('scoreContact rule', () => {
  it('two agreeing feeds → corroborated, one fresh feed → single, one old feed → stale, disagreement → conflict', () => {
    assert.equal(scoreContact({ sources: ['OpenSky', 'adsb.fi'], agreeKm: 3, fixAgeS: 10 }).confidence, 'corroborated');
    assert.equal(scoreContact({ sources: ['OpenSky', 'adsb.fi'], agreeKm: AGREE_KM + 1, fixAgeS: 10 }).confidence, 'conflict');
    assert.equal(scoreContact({ sources: ['OpenSky'], agreeKm: null, fixAgeS: FRESH_S }).confidence, 'single');
    assert.equal(scoreContact({ sources: ['OpenSky'], agreeKm: null, fixAgeS: FRESH_S + 1 }).confidence, 'stale');
    assert.equal(scoreContact({ sources: ['OpenSky'], agreeKm: null, fixAgeS: null }).confidence, 'single', 'unknown age is never guessed stale');
  });
  it('score falls 3 pts per minute of fix age, capped at −30, and stays within 0..100', () => {
    assert.equal(scoreContact({ sources: ['OpenSky'], fixAgeS: 0 }).score, 55);
    assert.equal(scoreContact({ sources: ['OpenSky'], fixAgeS: 125 }).score, 55 - 6);
    assert.equal(scoreContact({ sources: ['OpenSky'], fixAgeS: 3600 }).score, 55 - 30);
    assert.equal(scoreContact({ sources: ['OpenSky', 'adsb.fi'], agreeKm: 1, fixAgeS: 0 }).score, 90);
    assert.equal(scoreContact({ sources: ['OpenSky', 'adsb.fi'], agreeKm: 900, fixAgeS: 7200 }).score, 5);
  });
  it('haversine and region lookup', () => {
    assert.ok(Math.abs(haversineKm(48.5, 31.0, 48.52, 31.05) - 4.3) < 0.3);
    assert.equal(regionFor(48.5, 31.0), 'ukraine');
    assert.equal(regionFor(-40, -40), null);
  });
});

describe('fuseAirContacts', () => {
  it('annotates OpenSky tracks with prov, matches adsb.fi by ICAO24 and reports the agreement distance', () => {
    const sources = {
      OpenSky: { status: 'live', dataTimestamp: new Date(NOW).toISOString(), hotspots: [hotspot([track(), track({ icao24: '4b1800', callsign: 'SWR12', lastContact: sec - 400 })])] },
      'ADS-B': { militaryAircraft: [mil(), mil({ hex: '3f0001', latitude: 25.0, longitude: 120.0, seen: 2 }), mil({ hex: '000bad', latitude: -40, longitude: -40 })] },
    };
    const out = fuseAirContacts(sources, { now: NOW });
    const [a, b] = out.hotspots[0].tracks;
    assert.deepEqual(a.prov.sources, ['OpenSky', 'adsb.fi']);
    assert.equal(a.prov.confidence, 'corroborated');
    assert.ok(a.prov.agreeKm > 3 && a.prov.agreeKm < 6);
    assert.equal(a.prov.fixAgeS, 5, 'newest fix across feeds wins');
    assert.equal(a.prov.score, 90);
    assert.deepEqual(b.prov.sources, ['OpenSky']);
    assert.equal(b.prov.confidence, 'stale');
    assert.equal(b.prov.fixAgeS, 400);
    assert.deepEqual(out.hotspots[0].provenance, { corroborated: 1, single: 0, stale: 1, conflict: 0 });
    // adsb.fi-only airframe inside the Taiwan box surfaces; the one at 0,0 (no hotspot) does not
    assert.equal(out.military.length, 1);
    assert.equal(out.military[0].region, 'taiwan');
    assert.equal(out.military[0].altitude, Math.round(33000 * 0.3048));
    assert.deepEqual(out.military[0].prov.sources, ['adsb.fi']);
    assert.equal(out.summary.total, 2);
    assert.equal(out.summary.military, 1);
    assert.deepEqual(out.summary.bySource, { OpenSky: { contacts: 2, exclusive: 1 }, 'adsb.fi': { contacts: 2, exclusive: 1 } });
    assert.equal(out.summary.meanScore, Math.round((90 + (55 - 18)) / 2));
    assert.equal(out.summary.rule, RULE);
    // inputs are not mutated
    assert.equal(sources.OpenSky.hotspots[0].tracks[0].prov, undefined);
  });
  it('labels adsb.lol sample hotspots as their own source and tolerates missing feeds', () => {
    const out = fuseAirContacts({ OpenSky: { hotspots: [hotspot([track({ lastContact: null })], 'adsb_sample')] } }, { now: NOW });
    assert.deepEqual(out.hotspots[0].tracks[0].prov, { sources: ['adsb.lol'], n: 1, fixAgeS: null, agreeKm: null, confidence: 'single', score: 55 });
    const empty = fuseAirContacts({}, { now: NOW });
    assert.deepEqual(empty.hotspots, []);
    assert.equal(empty.summary.total, 0);
    assert.equal(empty.summary.meanScore, null);
  });
  it('compactProv bounds every field', () => {
    assert.equal(compactProv(null), null);
    const c = compactProv({ sources: ['a', 'b', 'c', 'd', 'e'], fixAgeS: 1e9, agreeKm: 1.26, confidence: 'bogus', score: 250 });
    assert.deepEqual(c, { sources: ['a', 'b', 'c', 'd'], n: 4, fixAgeS: 86400, agreeKm: 1.3, confidence: 'single', score: 100 });
  });
});

describe('ContactHistory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-contacts-'));
  let clock = NOW;
  const store = new ContactHistory(dir, { now: () => clock });
  const fusedAt = (n, extra = {}) => ({
    hotspots: [{ key: 'ukraine', tracks: [{ icao24: 'ae1234', callsign: 'RCH101', lat: 48.5 + n * 0.1, lon: 31 + n * 0.1, altitude: 10000, heading: 90, velocity: 220, prov: { sources: ['OpenSky', 'adsb.fi'], n: 2, confidence: 'corroborated' } }, ...(extra.tracks || [])] }],
    military: [{ icao24: '3f0001', callsign: '', region: 'taiwan', lat: 25, lon: 120, altitude: 9000, prov: { sources: ['adsb.fi'], n: 1, confidence: 'single' } }],
  });

  it('records one row per contact per sweep, idempotently, into runs/contacts/positions.jsonl', () => {
    assert.equal(store.record(fusedAt(0), NOW), 2);
    assert.equal(store.record(fusedAt(0), NOW), 0, 'same sweep twice writes nothing');
    clock = NOW + 15 * 60_000;
    assert.equal(store.record(fusedAt(1), clock), 2);
    clock = NOW + 30 * 60_000;
    assert.equal(store.record(fusedAt(2, { tracks: [{ icao24: 'ZZ', lat: 1, lon: 1 }, { icao24: '4b1800', lat: 'x', lon: 31 }] }), clock), 2, 'bad ids / coords are dropped');
    const lines = readFileSync(join(dir, 'contacts', 'positions.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 6);
    const row = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(row).sort(), ['alt', 'c', 'cs', 'hdg', 'id', 'k', 'lat', 'lon', 'n', 'r', 's', 'ts', 'vel'].sort());
    assert.equal(row.c, 'corroborated');
    assert.deepEqual(row.s, ['OpenSky', 'adsb.fi']);
  });

  it('replays a region as per-sweep frames + polylines, bounded to the window', () => {
    const r = store.replay({ region: 'ukraine', hours: 24, now: clock });
    assert.equal(r.sweeps, 3);
    assert.equal(r.contacts, 1);
    assert.equal(r.frames[0].contacts[0].id, 'ae1234');
    assert.equal(r.frames[2].contacts[0].lat, 48.7);
    assert.equal(r.tracks[0].points.length, 3);
    assert.match(r.resolution, /sweep/);
    const tw = store.replay({ region: 'taiwan', hours: 1, now: clock });
    assert.equal(tw.sweeps, 3);
    assert.equal(tw.tracks[0].id, '3f0001');
    assert.equal(store.replay({ region: 'baltics', now: clock }).sweeps, 0);
    assert.equal(store.replay({ region: 'ukraine', hours: 9999, now: clock }).hours, RETENTION_HOURS, 'hours is clamped to retention');
    assert.ok(MAX_FRAMES >= 4 * RETENTION_HOURS, 'frame cap covers a full retention window at 15-min sweeps');
  });

  it('prunes rows older than the retention window on the next record and reloads from disk', () => {
    clock = NOW + (RETENTION_HOURS + 1) * 3_600_000;
    assert.equal(store.record(fusedAt(5), clock), 2);
    const st = store.stats(clock);
    assert.equal(st.rows, 2, 'all earlier sweeps fell outside retention');
    assert.equal(st.sweeps, 1);
    const reloaded = new ContactHistory(dir, { now: () => clock });
    assert.equal(reloaded.stats(clock).rows, 2);
    assert.ok(!existsSync(join(dir, 'contacts', 'positions.jsonl.tmp')));
    rmSync(dir, { recursive: true, force: true });
  });
});

test('/api/contacts routes', async (t) => {
  const { app } = await import('../server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('summary lists regions and retention', async () => {
    const res = await fetch(`${base}/api/contacts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.regions.includes('ukraine'));
    assert.equal(body.retentionHours, RETENTION_HOURS);
    assert.ok(Number.isFinite(body.history.rows));
  });
  await t.test('history validates region / hours / id and returns the replay shape', async () => {
    for (const q of ['', 'region=mars', 'region=ukraine&hours=0', 'region=ukraine&hours=999', 'region=ukraine&id=<x>']) {
      const res = await fetch(`${base}/api/contacts/history?${q}`);
      assert.equal(res.status, 400, q);
      const body = await res.json();
      assert.equal(body.error, 'invalid request');
      assert.ok(!JSON.stringify(body).includes('mars'));
    }
    const ok = await fetch(`${base}/api/contacts/history?region=ukraine&hours=6`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.region, 'ukraine');
    assert.equal(body.hours, 6);
    assert.ok(Array.isArray(body.frames) && Array.isArray(body.tracks));
    assert.match(body.resolution, /sweep/);
  });
});
