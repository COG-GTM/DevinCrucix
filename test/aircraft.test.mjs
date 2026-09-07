// Aircraft layer: ADS-B Exchange adapter (keyed on ADSBX_RAPIDAPI_KEY), paced adsb.lol
// sampling with per-theater last-good reuse, readsb → track normalization, and the
// inject.mjs synthesis that carries individual tracks through to D.air for the map.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.AIR_SAMPLE_PACE_MS = '0';
delete process.env.ADSBX_RAPIDAPI_KEY;

const adsbx = await import('../apis/sources/adsbx.mjs');
const opensky = await import('../apis/sources/opensky.mjs');
const { classifySource } = await import('../lib/sourcehealth.mjs');
const { HOTSPOTS, samplePoints, fromAdsbSample, sampleAllHotspots, briefing, resetState } = opensky;

// Recorded api.adsb.lol payload: /v2/point/27/47/250 (Gulf), trimmed to 7 aircraft.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/adsb/point_27_47_250.json', import.meta.url), 'utf8'));
const THEATERS = Object.keys(HOTSPOTS).length;
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// readsb record positioned inside the given theater box
const inBoxAc = (box, extra = {}) => ({
  hex: extra.hex || 'abc123', flight: 'TEST1   ', t: 'B738', r: 'N1',
  lat: (box.lamin + box.lamax) / 2, lon: (box.lomin + box.lomax) / 2,
  alt_baro: 35000, gs: 450, track: 90, baro_rate: 0, squawk: '1200', ...extra,
});

const realFetch = globalThis.fetch;
const calls = [];
let inflight = 0, maxInflight = 0;
let responder = () => json({ ac: [] });
function installFetch() {
  globalThis.fetch = async (url, init) => {
    const h = new Headers(init?.headers || {});
    calls.push({ url: String(url), headers: Object.fromEntries(h.entries()) });
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 2));
    try { return await responder(String(url), init); } finally { inflight--; }
  };
}
before(installFetch);
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls.length = 0; maxInflight = 0; resetState(); adsbx.resetAdsbxState(); delete process.env.ADSBX_RAPIDAPI_KEY; });

describe('ADS-B Exchange adapter (adsbx.mjs)', () => {
  it('is keyed on ADSBX_RAPIDAPI_KEY only — legacy names do not activate it', () => {
    assert.equal(adsbx.adsbxKey({}), null);
    assert.equal(adsbx.adsbxKey({ ADSB_API_KEY: KEY }), null);
    assert.equal(adsbx.adsbxKey({ RAPIDAPI_KEY: KEY }), null);
    assert.equal(adsbx.adsbxKey({ ADSBX_RAPIDAPI_KEY: ` ${KEY} ` }), KEY, 'trimmed');
    assert.equal(adsbx.adsbxKey({ ADSBX_RAPIDAPI_KEY: 'short' }), null);
    assert.equal(adsbx.adsbxKey({ ADSBX_RAPIDAPI_KEY: `${KEY}<script>` }), null, 'charset whitelist');
    assert.equal(adsbx.adsbxConfigured({}), false);
    assert.equal(adsbx.adsbxRemaining({}), 0, 'no budget without a key');
  });

  it('never calls the network without a key and never leaks the key in its status', async () => {
    const r = await adsbx.adsbxPoint(30, 44);
    assert.match(r.error, /ADSBX_RAPIDAPI_KEY/);
    assert.equal(calls.length, 0);
    process.env.ADSBX_RAPIDAPI_KEY = KEY;
    assert.equal(JSON.stringify(adsbx.adsbxStatus()).includes(KEY), false);
  });

  it('sends RapidAPI headers to the v2 point endpoint, meters the daily budget, and cools down on 429', async () => {
    process.env.ADSBX_RAPIDAPI_KEY = KEY;
    process.env.ADSBX_DAILY_BUDGET = '2';
    try {
      responder = () => json(FIXTURE);
      const ok = await adsbx.adsbxPoint(27.1234, 47, 999);
      assert.equal(ok.ac.length, FIXTURE.ac.length);
      assert.equal(calls[0].url, `https://${adsbx.ADSBX_HOST}/v2/lat/27.123/lon/47.000/dist/250/`, 'radius clamped to 250 nm');
      assert.equal(calls[0].headers['x-rapidapi-key'], KEY);
      assert.equal(calls[0].headers['x-rapidapi-host'], adsbx.ADSBX_HOST);
      assert.equal(adsbx.adsbxRemaining(), 1);

      responder = () => json({ message: 'slow down' }, 429);
      const limited = await adsbx.adsbxPoint(27, 47);
      assert.equal(limited.rateLimited, true);
      assert.equal(adsbx.adsbxRemaining(), 0, 'cooling down → no budget');
      assert.equal(adsbx.adsbxStatus().coolingDown, true);
      assert.equal(calls.length, 2, 'a 429 is not retried');

      adsbx.resetAdsbxState();
      responder = () => json(FIXTURE);
      await adsbx.adsbxPoint(27, 47); await adsbx.adsbxPoint(27, 47);
      const over = await adsbx.adsbxPoint(27, 47);
      assert.equal(over.budget, true, 'third call exceeds ADSBX_DAILY_BUDGET=2');
      assert.equal(calls.length, 4);
    } finally { delete process.env.ADSBX_DAILY_BUDGET; }
  });

  it('treats 401/403 as a configuration problem and stops spending requests', async () => {
    process.env.ADSBX_RAPIDAPI_KEY = KEY;
    responder = () => json({ message: 'not subscribed' }, 403);
    const r = await adsbx.adsbxPoint(27, 47);
    assert.equal(r.auth, true);
    assert.equal(adsbx.adsbxRemaining(), 0);
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });
});

describe('readsb → track normalization (fromAdsbSample)', () => {
  const box = HOTSPOTS.middleEast;
  const pts = samplePoints(box);

  it('parses the recorded adsb.lol fixture with explicit unit conversions', () => {
    const h = fromAdsbSample('middleEast', box, FIXTURE.ac, pts, 'adsb.lol');
    assert.equal(h.provider, 'adsb.lol');
    assert.equal(h.totalAircraft, 7);
    assert.equal(h.tracks.length, 7);
    const thy = h.tracks.find(t => t.icao24 === '4bb1e2');
    assert.equal(thy.callsign, 'THY2DJ');
    assert.equal(thy.type, 'A333');
    assert.equal(thy.altitude, Math.round(38000 * 0.3048), 'alt_baro feet → metres');
    assert.equal(thy.velocity, Math.round(479.5 * 0.5144), 'gs knots → m/s');
    assert.equal(thy.heading, 299.34, 'track is already degrees true');
    assert.equal(thy.onGround, false);
    const ground = h.tracks.find(t => t.icao24 === '8940c5');
    assert.equal(ground.onGround, true, 'alt_baro === "ground"');
    assert.equal(ground.altitude, null);
    const climbing = fromAdsbSample('x', box, [inBoxAc(box, { baro_rate: 1000 })], pts).tracks[0];
    assert.equal(climbing.verticalRate, 5.08, 'baro_rate ft/min → m/s');
  });

  it('drops aircraft without a numeric fix or outside the box; an empty successful poll is not an error', () => {
    const bad = [
      inBoxAc(box, { hex: 'a', lat: 'twenty', lon: 47 }),
      inBoxAc(box, { hex: 'b', lat: null }),
      inBoxAc(box, { hex: 'c', lat: 60, lon: 47 }), // north of the box
      inBoxAc(box, { hex: 'd' }),
    ];
    const h = fromAdsbSample('middleEast', box, bad, pts);
    assert.equal(h.totalAircraft, 1);
    assert.deepEqual(h.tracks.map(t => t.icao24), ['d']);
    const empty = fromAdsbSample('middleEast', box, [], pts);
    assert.equal(empty.totalAircraft, 0);
    assert.deepEqual(empty.tracks, []);
    assert.equal(empty.error, undefined);
    assert.equal(empty.method, 'adsb_sample');
  });

  it('flags military via dbFlags bit 0 and prioritizes it into the track sample', () => {
    const many = Array.from({ length: 200 }, (_, i) => inBoxAc(box, { hex: `c${String(i).padStart(5, '0')}` }));
    const mil = inBoxAc(box, { hex: 'mil001', dbFlags: 1, flight: '' });
    const h = fromAdsbSample('middleEast', box, [...many, mil], pts);
    assert.equal(h.totalAircraft, 201);
    assert.equal(h.tracks.length, 150, 'capped');
    assert.equal(h.military, 1);
    assert.equal(h.tracks[0].icao24, 'mil001');
    assert.equal(h.tracks[0].mil, true);
    assert.equal(h.tracks[0].callsign, '');
  });
});

describe('OpenSky state vectors → tracks (partitionStates)', () => {
  // [icao24, callsign, country, timePos, lastContact, lon, lat, baroAlt, onGround, velocity, track, vRate, sensors, geoAlt, squawk, spi, posSrc]
  const sv = (icao, cs, lon, lat, alt = 10000) => [icao, cs, 'United States', 1, 1, lon, lat, alt, false, 230, 90, 0, null, alt, '1200', false, 0];
  it('flags military by USAF hex range or callsign pattern and samples those first', () => {
    const states = [
      sv('a1b2c3', 'UAL123  ', 50, 25),
      sv('ae1234', 'XYZ1    ', 51, 26),      // US military hex block
      sv('a2b2c3', 'RCH412  ', 52, 27),      // AMC callsign
      sv('a3b2c3', '', 53, 28),              // dark
      ['bad', 'BAD', 'X', 1, 1, 'lon', 'lat'], // malformed → dropped
    ];
    const { hotspots, positioned } = opensky.partitionStates(states);
    assert.equal(positioned, 4);
    const me = hotspots.find(h => h.key === 'middleEast');
    assert.equal(me.totalAircraft, 4);
    assert.equal(me.military, 2);
    assert.equal(me.noCallsign, 1);
    assert.deepEqual(me.tracks.slice(0, 2).map(t => t.icao24).sort(), ['a2b2c3', 'ae1234']);
    assert.ok(me.tracks.slice(0, 2).every(t => t.mil === true));
    assert.equal(me.tracks.find(t => t.icao24 === 'a1b2c3').mil, false);
    assert.equal(me.tracks.find(t => t.icao24 === 'a1b2c3').callsign, 'UAL123');
  });
});

describe('paced theater sampling (no key → adsb.lol)', () => {
  it('samples every theater sequentially from adsb.lol and populates all of them', async () => {
    responder = url => {
      const [, lat, lon] = url.match(/\/point\/(-?[\d.]+)\/(-?[\d.]+)\//);
      return json({ ac: [{ ...inBoxAc({ lamin: +lat, lamax: +lat, lomin: +lon, lomax: +lon }), hex: `h${lat}${lon}`.replace(/\W/g, '').slice(0, 6) }] });
    };
    const results = await sampleAllHotspots();
    assert.equal(results.length, THEATERS);
    assert.ok(calls.every(c => c.url.startsWith('https://api.adsb.lol/v2/point/')));
    assert.equal(calls.length, Object.values(HOTSPOTS).reduce((n, b) => n + samplePoints(b).length, 0));
    assert.equal(maxInflight, 1, 'never bursts the free aggregator');
    for (const r of results) {
      assert.equal(r.method, 'adsb_sample', r.region);
      assert.equal(r.provider, 'adsb.lol');
      assert.equal(r.stale, undefined);
      assert.ok(r.totalAircraft >= 1, `${r.region} has aircraft`);
      assert.ok(r.tracks.every(t => typeof t.lat === 'number' && typeof t.lon === 'number'));
    }
  });

  it('on 429 reuses each theater\'s last good sample, marked stale with its age, instead of dropping to zero', async () => {
    responder = () => json({ ac: [inBoxAc(HOTSPOTS.ukraine)] });
    const first = await sampleAllHotspots();
    const ukr = first.find(r => r.key === 'ukraine');
    assert.equal(ukr.tracks.length, 1);

    calls.length = 0;
    responder = () => json({ error: 'rate limited' }, 429);
    const second = await sampleAllHotspots();
    assert.ok(calls.length < 3, `after the first 429 the aggregator cools down; made ${calls.length} calls`);
    for (const r of second) {
      assert.equal(r.stale, true, r.region);
      assert.equal(r.staleAgeMin, 0);
      assert.match(r.staleReason, /rate limited|cooling down/);
    }
    assert.equal(second.find(r => r.key === 'ukraine').tracks.length, 1, 'tracks survive into the stale result');
  });

  it('a theater with no last-good result reports a failure with zero aircraft (not fake data)', async () => {
    responder = () => { throw new TypeError('fetch failed'); };
    const results = await sampleAllHotspots();
    for (const r of results) {
      assert.equal(r.method, 'none');
      assert.equal(r.totalAircraft, 0);
      assert.deepEqual(r.tracks, []);
      assert.match(r.error, /unreachable|cooling down|fetch failed/);
    }
  });

  it('stops at the sweep deadline and resumes from the next theater on the following sweep', async () => {
    responder = () => json({ ac: [] });
    const keys = Object.keys(HOTSPOTS);
    const first = await sampleAllHotspots(0);
    assert.equal(first.filter(r => r.method === 'adsb_sample').length, 1);
    assert.equal(first[0].key, keys[0]);
    assert.equal(first[0].method, 'adsb_sample');
    assert.match(first[1].error, /time budget/);
    const second = await sampleAllHotspots(0);
    assert.equal(second[1].method, 'adsb_sample', 'rotation moved on to the second theater');
    assert.equal(second[1].stale, undefined);
    assert.equal(second[0].stale, true, 'the theater sampled last sweep keeps its (empty but successful) result as stale');
    assert.equal(second[2].method, 'none', 'never-sampled theaters report failure, not fake zeros');
  });
});

describe('theater sampling with ADSBX_RAPIDAPI_KEY set', () => {
  it('uses ADS-B Exchange as the primary provider and reports it honestly', async () => {
    process.env.ADSBX_RAPIDAPI_KEY = KEY;
    responder = () => json({ ac: [inBoxAc(HOTSPOTS.taiwan)] });
    const results = await sampleAllHotspots();
    assert.ok(calls.every(c => c.url.startsWith(`https://${adsbx.ADSBX_HOST}/v2/lat/`)), 'no adsb.lol calls while budget remains');
    assert.ok(calls.every(c => c.headers['x-rapidapi-key'] === KEY));
    assert.equal(results.find(r => r.key === 'taiwan').provider, 'adsbexchange');
    assert.equal(adsbx.adsbxStatus().usedToday, calls.length);

    const b = await briefing();
    assert.equal(b.primary, 'adsbexchange');
    assert.equal(b.source, 'ADS-B Exchange');
    assert.equal(b.method, 'adsb_sample');
    assert.equal(b.coverage.adsbx, THEATERS);
    assert.equal(b.adsbx.dailyBudget, 300);
    assert.equal(JSON.stringify(b).includes(KEY), false, 'key never appears in the payload');
    assert.equal(classifySource('OpenSky', b).state, 'live');
  });

  it('falls back to adsb.lol mid-sweep when the daily budget runs out and labels the mix', async () => {
    process.env.ADSBX_RAPIDAPI_KEY = KEY;
    process.env.ADSBX_DAILY_BUDGET = '1';
    try {
      responder = () => json({ ac: [] });
      const results = await sampleAllHotspots();
      const hosts = calls.map(c => new URL(c.url).host);
      assert.equal(hosts[0], adsbx.ADSBX_HOST);
      assert.ok(hosts.slice(1).every(h => h === 'api.adsb.lol'));
      assert.equal(results[0].provider, 'mixed', 'first theater used both providers');
      assert.ok(results.slice(1).every(r => r.provider === 'adsb.lol'));
      const b = await briefing();
      assert.equal(b.status, 'partial');
      assert.equal(classifySource('OpenSky', b).state, 'degraded');
    } finally { delete process.env.ADSBX_DAILY_BUDGET; }
  });
});

describe('briefing() without a key when OpenSky is unreachable', () => {
  it('returns an adsb.lol fallback briefing with all theaters and honest degraded health', async () => {
    responder = url => {
      if (url.includes('opensky-network.org')) throw new TypeError('fetch failed');
      return json({ ac: [inBoxAc(HOTSPOTS.baltics, { dbFlags: 1 })] });
    };
    const b = await briefing();
    assert.equal(b.status, 'fallback');
    assert.equal(b.primary, 'opensky');
    assert.match(b.source, /api\.adsb\.lol/);
    assert.match(b.openskyError, /unreachable/);
    assert.equal(b.hotspots.length, THEATERS);
    assert.equal(b.coverage.adsbLol, THEATERS);
    assert.equal(b.hotspots.find(h => h.key === 'baltics').military, 1);
    assert.equal(classifySource('OpenSky', b).state, 'degraded');
  });
});

describe('synthesis: tracks reach D.air for the map layer', () => {
  it('carries normalized per-aircraft tracks, provider and stale metadata into D.air', async () => {
    const { synthesize } = await import('../dashboard/inject.mjs');
    const box = HOTSPOTS.middleEast;
    const hot = fromAdsbSample('middleEast', box, [
      ...FIXTURE.ac,
      inBoxAc(box, { hex: 'bad001', lat: 'NaN' }),
      inBoxAc(box, { hex: 'sq7700', squawk: '7700', dbFlags: 1, flight: 'RCH123<b>' }),
    ], samplePoints(box), 'adsb.lol');
    const staleHot = { ...fromAdsbSample('taiwan', HOTSPOTS.taiwan, [inBoxAc(HOTSPOTS.taiwan)], samplePoints(HOTSPOTS.taiwan)), stale: true, staleAgeMin: 12, staleReason: 'HTTP 429' };
    const failed = { region: 'Baltic Region', key: 'baltics', method: 'none', totalAircraft: 0, byCountry: {}, noCallsign: 0, highAltitude: 0, tracks: [], error: 'adsb.lol rate limited', ...HOTSPOTS.baltics };
    const out = await synthesize({
      crucix: { timestamp: new Date().toISOString() },
      sources: { OpenSky: { source: 'ADS-B sample (api.adsb.lol) — OpenSky unreachable', status: 'fallback', method: 'adsb_sample', primary: 'opensky', coverage: { opensky: 0, adsbx: 0, adsbLol: 2, stale: 1, failed: 1, total: 3, adsbSample: 3 }, hotspots: [hot, staleHot, failed] } },
    });
    assert.equal(out.air.length, 3);
    const me = out.air[0];
    assert.equal(me.region, 'Middle East');
    assert.equal(me.total, 8);
    assert.equal(me.provider, 'adsb.lol');
    assert.equal(me.sampled, true);
    assert.equal(me.stale, false);
    assert.deepEqual([me.lamin, me.lomin, me.lamax, me.lomax], [box.lamin, box.lomin, box.lamax, box.lomax]);
    assert.equal(me.tracks.length, 8, 'the record with a non-numeric latitude is dropped');
    assert.ok(me.tracks.every(t => Number.isFinite(t.lat) && Number.isFinite(t.lon) && Math.abs(t.lat) <= 90));
    const thy = me.tracks.find(t => t.hex === '4bb1e2');
    assert.deepEqual(Object.keys(thy).sort(), ['altM', 'country', 'cs', 'ground', 'hdg', 'hex', 'lat', 'lon', 'mil', 'reg', 'spdMs', 'squawk', 'type', 'vsMs']);
    assert.equal(thy.altM, Math.round(38000 * 0.3048));
    assert.equal(thy.hdg, 299);
    assert.equal(thy.cs, 'THY2DJ');
    const mil = me.tracks.find(t => t.hex === 'sq7700');
    assert.equal(mil.mil, true);
    assert.equal(mil.squawk, '7700');
    assert.equal(mil.cs.includes('<'), false, 'source sanitizer strips markup before it reaches the browser');
    assert.equal(me.military, 1);

    const tw = out.air[1];
    assert.equal(tw.stale, true);
    assert.equal(tw.staleAgeMin, 12);
    assert.equal(tw.tracks.length, 1);
    const bl = out.air[2];
    assert.equal(bl.total, 0);
    assert.deepEqual(bl.tracks, []);
    assert.equal(bl.error, 'adsb.lol rate limited');

    assert.equal(out.airMeta.trackCount, 9);
    assert.equal(out.airMeta.primary, 'opensky');
    assert.equal(out.airMeta.method, 'adsb_sample');
    assert.equal(out.airMeta.coverage.adsbLol, 2);
    assert.equal(JSON.stringify(out.air).includes('NaN'), false);
    assert.equal(JSON.stringify(out.air).includes('undefined'), false);
  });
});
