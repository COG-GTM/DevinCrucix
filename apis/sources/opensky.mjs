// OpenSky Network — Real-time flight tracking
// https://openskynetwork.github.io/opensky-api/rest.html
//
// Credit model (per /states/* bucket): anonymous 400/day, OAuth2 client 4,000/day,
// active feeder 8,000/day. A /states/all call costs 1–4 credits by bounding-box
// area; anything > 400 sq° (or global) costs 4.
//
// Strategy: ONE global /states/all per sweep (4 credits) partitioned locally
// into hotspot regions, instead of one request per region. Honors the 429
// `x-rate-limit-retry-after-seconds` header and serves the last good snapshot
// while cooling down. Set OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET for 10x quota.
//
// OpenSky is unreachable from some cloud networks (connection timeouts). When
// there is no OpenSky snapshot to serve, each hotspot is sampled in 250 nm circles
// from an ADS-B aggregator instead and flagged as a sample: ADS-B Exchange when
// ADSBX_RAPIDAPI_KEY is set (it then replaces OpenSky outright), else the keyless
// api.adsb.lol. api.adsb.lol admits roughly one request every 7 s from a cloud
// egress IP (burst of ~3, then 429 with no Retry-After), far too slow to sample all
// 33 points inside one sweep's 60 s budget. So sampling runs as a background
// rotation between sweeps — one point every AIR_SAMPLE_PACE_MS, theater by theater —
// and a sweep reads each theater's most recent result, tagged with its age. A result
// older than the fresh window is `stale`; older than the last-good window it is dropped
// and the theater reports a failure rather than fake zeros.

import { safeFetch } from '../utils/fetch.mjs';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';
import { adsbxConfigured, adsbxDailyBudget, adsbxPoint, adsbxRemaining, adsbxStatus } from './adsbx.mjs';
import { isMilitaryCallsign, isMilitaryHex } from './adsb.mjs';

const BASE = 'https://opensky-network.org/api';
const ADSB_LOL = 'https://api.adsb.lol/v2';
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';
const SAMPLE_RADIUS_NM = 250;
const PACE_OVERRIDE_MS = process.env.AIR_SAMPLE_PACE_MS ? Math.max(0, Number(process.env.AIR_SAMPLE_PACE_MS) || 0) : null;
const SAMPLE_PACE_MS = PACE_OVERRIDE_MS ?? 8_000;
const SAMPLE_COOLDOWN_MS = 60_000;
const FRESH_MIN_MS = 15 * 60_000;      // ≤ one sweep interval old counts as current
const LAST_GOOD_MIN_MS = 90 * 60_000;  // beyond this a theater reports failure, not old data
const SAMPLE_DEADLINE_MS = Math.max(5_000, Number(process.env.AIR_SAMPLE_DEADLINE_MS ?? 40_000));
const SWEEP_BUDGET_MS = 55_000; // briefing.mjs gives OpenSky 60 s
const HIGH_ALT_FT = 39370; // 12 km
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 24 * 3600_000;
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.OPENSKY_MIN_INTERVAL_MINUTES ?? 15)) * 60_000;
const TRACK_SAMPLE_LIMIT = 150;

// State vector indices — https://openskynetwork.github.io/opensky-api/rest.html#response
const SV = {
  ICAO24: 0, CALLSIGN: 1, ORIGIN_COUNTRY: 2, TIME_POSITION: 3, LAST_CONTACT: 4,
  LON: 5, LAT: 6, BARO_ALT: 7, ON_GROUND: 8, VELOCITY: 9, TRUE_TRACK: 10,
  VERTICAL_RATE: 11, SENSORS: 12, GEO_ALT: 13, SQUAWK: 14, SPI: 15, POSITION_SOURCE: 16,
};

// Key hotspot regions for monitoring
export const HOTSPOTS = {
  middleEast: { lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' },
  taiwan: { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' },
  ukraine: { lamin: 44, lomin: 22, lamax: 53, lomax: 41, label: 'Ukraine Region' },
  baltics: { lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' },
  southChinaSea: { lamin: 5, lomin: 105, lamax: 23, lomax: 122, label: 'South China Sea' },
  koreanPeninsula: { lamin: 33, lomin: 124, lamax: 43, lomax: 132, label: 'Korean Peninsula' },
  caribbean: { lamin: 18, lomin: -90, lamax: 30, lomax: -72, label: 'Caribbean' },
  gulfOfGuinea: { lamin: -2, lomin: -5, lamax: 8, lomax: 10, label: 'Gulf of Guinea' },
  capeRoute: { lamin: -38, lomin: 12, lamax: -28, lomax: 24, label: 'Cape Route' },
  hornOfAfrica: { lamin: 5, lomin: 40, lamax: 15, lomax: 55, label: 'Horn of Africa' },
};

// --- Module state: token cache, rate-limit cooldown, last good snapshot ---
const state = {
  token: null,
  tokenExpiresAt: 0,
  cooldownUntil: 0,
  lastFetchAt: 0,
  lastGood: null,      // { fetchedAt, states, time }
  lastError: null,
  quota: { remaining: null, updatedAt: null },
  hotspotLastGood: {}, // key -> { at, result } from the last successful sample
  lolCooldownUntil: 0,
  sampleCursor: 0,     // next theater to sample (shared by sweeps and the background rotation)
  sampleLock: Promise.resolve(),
  background: null,    // { timer } while the background rotation is running
  attempted: new Set(),// theaters the rotation has reached at least once
  waiters: new Set(),  // resolvers waiting for the rotation to cover every theater
  gen: 0,              // bumped by resetState so in-flight samples discard their result
};

export function resetState() {
  stopBackgroundSampler();
  Object.assign(state, {
    token: null, tokenExpiresAt: 0, cooldownUntil: 0, lastFetchAt: 0,
    lastGood: null, lastError: null, quota: { remaining: null, updatedAt: null },
    hotspotLastGood: {}, lolCooldownUntil: 0, sampleCursor: 0,
    attempted: new Set(), waiters: new Set(), gen: state.gen + 1,
  });
}

// Resolves once no sample is in flight (queued work after a reset is dropped).
export function samplerIdle() { return state.sampleLock; }

function credentials() {
  const id = process.env.OPENSKY_CLIENT_ID?.trim();
  const secret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

async function getAccessToken() {
  const creds = credentials();
  if (!creds) return null;
  if (state.token && Date.now() < state.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return state.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await safeOutboundFetch(TOKEN_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Crucix/1.0' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.id,
        client_secret: creds.secret,
      }),
    });
    if (!res.ok) throw new Error(`OpenSky auth HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.access_token) throw new Error('OpenSky auth: no access_token in response');
    state.token = data.access_token;
    state.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 1800) * 1000;
    return state.token;
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfter(res) {
  const raw = res.headers.get('x-rate-limit-retry-after-seconds') ?? res.headers.get('retry-after');
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(secs * 1000, MAX_COOLDOWN_MS);
}

function recordQuota(res) {
  const remaining = Number(res.headers.get('x-rate-limit-remaining'));
  if (Number.isFinite(remaining)) {
    state.quota = { remaining, updatedAt: new Date().toISOString() };
  }
}

// Single authenticated GET against the OpenSky REST API. Never retries on 429;
// instead records the cooldown so subsequent calls short-circuit.
async function openskyGet(path, { timeout = 30000 } = {}) {
  const now = Date.now();
  if (now < state.cooldownUntil) {
    return { error: `OpenSky rate-limited; retry after ${new Date(state.cooldownUntil).toISOString()}`, rateLimited: true };
  }

  const headers = { 'User-Agent': 'Crucix/1.0', Accept: 'application/json' };
  try {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (e) {
    // Auth failure: fall through anonymously but surface the reason.
    state.lastError = e.message;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await safeOutboundFetch(`${BASE}${path}`, { signal: controller.signal, headers });
    recordQuota(res);

    if (res.status === 429) {
      const wait = parseRetryAfter(res);
      state.cooldownUntil = Date.now() + wait;
      return {
        error: `HTTP 429: Too many requests (cooldown ${Math.round(wait / 60000)} min, retry after ${new Date(state.cooldownUntil).toISOString()})`,
        rateLimited: true,
      };
    }
    if (res.status === 401 && state.token) {
      // Expired/revoked token — drop it so the next call re-authenticates.
      state.token = null;
      state.tokenExpiresAt = 0;
      return { error: 'HTTP 401: OpenSky token rejected; will re-authenticate on next sweep' };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return await res.json();
  } catch (e) {
    return { error: e.name === 'AbortError' ? `OpenSky request timed out after ${timeout / 1000}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// --- Public API (kept for callers; each is a metered request) ---

export async function getAllFlights() {
  return openskyGet('/states/all', { timeout: 20000 });
}

export async function getFlightsInArea(lamin, lomin, lamax, lomax) {
  const params = new URLSearchParams({
    lamin: String(lamin), lomin: String(lomin), lamax: String(lamax), lomax: String(lomax),
  });
  return openskyGet(`/states/all?${params}`, { timeout: 20000 });
}

export async function getFlightsByIcao(icao24List) {
  const icao = Array.isArray(icao24List) ? icao24List : [icao24List];
  const params = icao
    .map(i => String(i).toLowerCase())
    .filter(i => /^[0-9a-f]{6}$/.test(i))
    .map(i => `icao24=${i}`)
    .join('&');
  if (!params) return { error: 'No valid ICAO24 hex codes supplied' };
  return openskyGet(`/states/all?${params}`, { timeout: 20000 });
}

function airportParams(airportIcao, begin, end) {
  const airport = String(airportIcao || '').toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(airport)) return null;
  return new URLSearchParams({
    airport,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
}

export async function getDepartures(airportIcao, begin, end) {
  const params = airportParams(airportIcao, begin, end);
  if (!params) return { error: 'Invalid airport ICAO code' };
  return openskyGet(`/flights/departure?${params}`);
}

export async function getArrivals(airportIcao, begin, end) {
  const params = airportParams(airportIcao, begin, end);
  if (!params) return { error: 'Invalid airport ICAO code' };
  return openskyGet(`/flights/arrival?${params}`);
}

// --- Partitioning ---

function inBox(lat, lon, box) {
  return lat >= box.lamin && lat <= box.lamax && lon >= box.lomin && lon <= box.lomax;
}

function sanitizeText(value, max = 32) {
  return String(value ?? '').replace(/[<>"'`;&|$()\\]/g, '').trim().slice(0, max);
}

// OpenSky state vectors carry no military flag; hex-range and callsign heuristics stand in.
function openskyMil(s) {
  return Boolean(isMilitaryHex(s[SV.ICAO24]) || isMilitaryCallsign(String(s[SV.CALLSIGN] ?? '')));
}

function toTrack(s) {
  return {
    icao24: sanitizeText(s[SV.ICAO24], 6),
    callsign: sanitizeText(s[SV.CALLSIGN], 8),
    country: sanitizeText(s[SV.ORIGIN_COUNTRY], 64),
    type: '',
    reg: '',
    mil: openskyMil(s),
    lat: s[SV.LAT],
    lon: s[SV.LON],
    altitude: s[SV.BARO_ALT] ?? s[SV.GEO_ALT] ?? null,
    velocity: s[SV.VELOCITY] ?? null,
    heading: s[SV.TRUE_TRACK] ?? null,
    verticalRate: s[SV.VERTICAL_RATE] ?? null,
    squawk: sanitizeText(s[SV.SQUAWK], 4) || null,
    onGround: Boolean(s[SV.ON_GROUND]),
    lastContact: s[SV.LAST_CONTACT] ?? null,
  };
}

// Partition a global state-vector array into the HOTSPOTS regions.
export function partitionStates(states = []) {
  const buckets = Object.fromEntries(Object.keys(HOTSPOTS).map(k => [k, []]));
  let positioned = 0;
  for (const s of states) {
    const lat = s?.[SV.LAT];
    const lon = s?.[SV.LON];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    positioned++;
    for (const [key, box] of Object.entries(HOTSPOTS)) {
      if (inBox(lat, lon, box)) buckets[key].push(s);
    }
  }

  const hotspots = Object.entries(HOTSPOTS).map(([key, box]) => {
    const inRegion = buckets[key];
    const byCountry = {};
    for (const s of inRegion) {
      const country = sanitizeText(s[SV.ORIGIN_COUNTRY], 64) || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
    }
    const military = inRegion.filter(openskyMil);
    const noCallsign = inRegion.filter(s => !String(s[SV.CALLSIGN] ?? '').trim());
    const highAltitude = inRegion.filter(s => typeof s[SV.BARO_ALT] === 'number' && s[SV.BARO_ALT] > 12000);
    const airborne = inRegion.filter(s => !s[SV.ON_GROUND]);

    // Sample: military first, then anomalous tracks (no callsign, very high altitude), then fill.
    const prioritized = [...new Set([...military, ...noCallsign, ...highAltitude, ...airborne])].slice(0, TRACK_SAMPLE_LIMIT);

    return {
      region: box.label,
      key,
      method: 'opensky',
      provider: 'opensky',
      lamin: box.lamin, lomin: box.lomin, lamax: box.lamax, lomax: box.lomax,
      totalAircraft: inRegion.length,
      airborne: airborne.length,
      byCountry,
      military: military.length,
      noCallsign: noCallsign.length,
      highAltitude: highAltitude.length,
      tracks: prioritized.map(toTrack),
    };
  });

  return { hotspots, totalStates: states.length, positioned };
}

// --- ADS-B aggregator sampling (ADS-B Exchange / api.adsb.lol) ---

function shortError(msg = '') {
  if (/abort|timeout|timed out/i.test(msg)) return 'timed out';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'unreachable';
  if (/rate.?limit|HTTP 429/i.test(msg)) return 'rate limited';
  if (/auth HTTP 40[13]/i.test(msg)) return 'auth rejected';
  const m = String(msg).match(/HTTP (\d{3})/);
  return m ? `HTTP ${m[1]}` : 'error';
}

// Sample centres for a bounding box: one 250 nm circle for compact boxes,
// a 2x2 grid for wide ones. Coverage is partial by design and reported as such.
export function samplePoints(box) {
  const midLat = (box.lamin + box.lamax) / 2;
  const latNm = (box.lamax - box.lamin) * 60;
  const lonNm = (box.lomax - box.lomin) * 60 * Math.cos(midLat * Math.PI / 180);
  const rows = latNm > SAMPLE_RADIUS_NM * 2 ? 2 : 1;
  const cols = lonNm > SAMPLE_RADIUS_NM * 2 ? 2 : 1;
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pts.push({
        lat: +(box.lamin + (box.lamax - box.lamin) * (r + 0.5) / rows).toFixed(3),
        lon: +(box.lomin + (box.lomax - box.lomin) * (c + 0.5) / cols).toFixed(3),
      });
    }
  }
  return pts;
}


// readsb-style aircraft JSON (ADS-B Exchange / api.adsb.lol) → hotspot summary
export function fromAdsbSample(key, box, aircraft, points, provider = 'adsb.lol') {
  const inRegion = aircraft.filter(a => typeof a.lat === 'number' && typeof a.lon === 'number' && inBox(a.lat, a.lon, box));
  const byType = {};
  for (const a of inRegion) if (a.t) byType[sanitizeText(a.t, 8)] = (byType[sanitizeText(a.t, 8)] || 0) + 1;
  const isMil = a => Boolean((a.dbFlags || 0) & 1);
  const noCall = a => !(a.flight || '').trim();
  const highAlt = a => typeof a.alt_baro === 'number' && a.alt_baro > HIGH_ALT_FT;
  const airborne = a => a.alt_baro !== 'ground';
  // Sample: military first, then anomalous tracks (no callsign, very high altitude), then fill.
  const prioritized = [...new Set([
    ...inRegion.filter(isMil), ...inRegion.filter(noCall), ...inRegion.filter(highAlt), ...inRegion.filter(airborne), ...inRegion,
  ])].slice(0, TRACK_SAMPLE_LIMIT);
  return {
    region: box.label,
    key,
    method: 'adsb_sample',
    provider,
    sampled: true,
    samplePoints: points.length,
    sampleRadiusNm: SAMPLE_RADIUS_NM,
    lamin: box.lamin, lomin: box.lomin, lamax: box.lamax, lomax: box.lomax,
    totalAircraft: inRegion.length,
    byCountry: {},
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5)),
    military: inRegion.filter(isMil).length,
    noCallsign: inRegion.filter(noCall).length,
    highAltitude: inRegion.filter(highAlt).length,
    tracks: prioritized.map(a => ({
      icao24: sanitizeText(a.hex, 6),
      callsign: sanitizeText(a.flight, 8),
      country: '',
      type: sanitizeText(a.t, 8),
      reg: sanitizeText(a.r, 12),
      mil: isMil(a),
      lat: a.lat,
      lon: a.lon,
      altitude: typeof a.alt_baro === 'number' ? Math.round(a.alt_baro * 0.3048) : null,
      velocity: typeof a.gs === 'number' ? Math.round(a.gs * 0.5144) : null,
      heading: typeof a.track === 'number' ? a.track : null,
      verticalRate: typeof a.baro_rate === 'number' ? Math.round(a.baro_rate * 0.00508 * 100) / 100 : null,
      squawk: sanitizeText(a.squawk, 4) || null,
      onGround: a.alt_baro === 'ground',
      lastContact: null,
    })),
  };
}

const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const TOTAL_SAMPLE_POINTS = Object.values(HOTSPOTS).reduce((n, b) => n + samplePoints(b).length, 0);

// Which aggregator a sample call should use right now.
function pickProvider() {
  if (adsbxRemaining() > 0) return 'adsbexchange';
  if (Date.now() >= state.lolCooldownUntil) return 'adsb.lol';
  return null;
}

// ADS-B Exchange requests are spread over the day so the budget lasts; adsb.lol just needs
// the pace. AIR_SAMPLE_PACE_MS, when set, overrides both.
function paceMs(provider = pickProvider()) {
  if (PACE_OVERRIDE_MS != null) return PACE_OVERRIDE_MS;
  if (provider === 'adsbexchange') return Math.max(SAMPLE_PACE_MS, Math.floor(86_400_000 / Math.max(1, adsbxDailyBudget())));
  return SAMPLE_PACE_MS;
}

// One full rotation through every sample point at the current pace.
function rotationMs() { return TOTAL_SAMPLE_POINTS * paceMs(); }
function freshWindowMs() { return Math.max(FRESH_MIN_MS, Math.round(rotationMs() * 1.25)); }
function lastGoodWindowMs() { return Math.max(LAST_GOOD_MIN_MS, rotationMs() * 3); }

// Sweeps and the background rotation share one aggregator; never let them overlap.
// Work queued before a resetState() is dropped (resolves null) instead of running.
function withSampleLock(fn) {
  const gen = state.gen;
  const guarded = () => (gen === state.gen ? fn() : null);
  const run = state.sampleLock.then(guarded, guarded);
  state.sampleLock = run.then(() => {}, () => {});
  return run;
}

async function fetchSamplePoint(provider, p) {
  if (provider === 'adsbexchange') return adsbxPoint(p.lat, p.lon, SAMPLE_RADIUS_NM, { timeout: 15000 });
  const data = await safeFetch(`${ADSB_LOL}/point/${p.lat}/${p.lon}/${SAMPLE_RADIUS_NM}`, {
    timeout: 15000, retries: 0, headers: { 'User-Agent': UA },
  });
  if (data?.error && /HTTP 429/.test(data.error)) state.lolCooldownUntil = Date.now() + SAMPLE_COOLDOWN_MS;
  return data;
}

function failedHotspot(key, box, error) {
  return {
    region: box.label, key, method: 'none',
    lamin: box.lamin, lomin: box.lomin, lamax: box.lamax, lomax: box.lomax,
    totalAircraft: 0, byCountry: {}, noCallsign: 0, highAltitude: 0, tracks: [],
    error,
  };
}

// A theater not sampled right now serves its most recent result, tagged with its age:
// `reused` always, `stale` once it is older than the fresh window, dropped (failure,
// zero aircraft) once it is older than the last-good window.
function withLastGood(key, box, reason) {
  const lg = state.hotspotLastGood[key];
  const ageMs = lg ? Date.now() - lg.at : Infinity;
  if (lg && ageMs <= lastGoodWindowMs()) {
    const ageMin = Math.round(ageMs / 60000);
    const out = { ...lg.result, reused: true, reuseReason: reason, sampledAt: new Date(lg.at).toISOString(), ageMin };
    if (ageMs > freshWindowMs()) Object.assign(out, { stale: true, staleAgeMin: ageMin, staleReason: reason });
    return out;
  }
  return failedHotspot(key, box, reason);
}

async function sampleHotspot(key, box) {
  const gen = state.gen;
  const points = samplePoints(box);
  const seen = new Map();
  const errors = [];
  const providers = new Set();
  for (const p of points) {
    if (gen !== state.gen) return failedHotspot(key, box, 'sampler reset');
    const provider = pickProvider();
    if (!provider) { errors.push('all aggregators cooling down'); continue; }
    const data = await fetchSamplePoint(provider, p);
    await sleep(paceMs(provider));
    if (data?.error || !Array.isArray(data?.ac)) { errors.push(`${provider} ${shortError(data?.error || 'no ac[] in response')}`); continue; }
    providers.add(provider);
    for (const a of data.ac) if (a.hex && !seen.has(a.hex)) seen.set(a.hex, a);
  }
  if (gen !== state.gen) return failedHotspot(key, box, 'sampler reset');
  if (errors.length === points.length) return withLastGood(key, box, errors[0]);

  const provider = providers.size === 1 ? [...providers][0] : 'mixed';
  const at = Date.now();
  const out = { ...fromAdsbSample(key, box, [...seen.values()], points, provider), sampledAt: new Date(at).toISOString(), ageMin: 0 };
  if (errors.length) out.partial = `${errors.length}/${points.length} sample(s) failed: ${errors[0]}`;
  state.hotspotLastGood[key] = { at, result: out };
  return out;
}

const allAttempted = () => Object.keys(HOTSPOTS).every(k => state.attempted.has(k));

// Sample the next theater in rotation (shared cursor), holding the aggregator lock.
function sampleNextHotspot() {
  return withSampleLock(async () => {
    const gen = state.gen;
    const entries = Object.entries(HOTSPOTS);
    const idx = state.sampleCursor % entries.length;
    const [key, box] = entries[idx];
    const result = await sampleHotspot(key, box);
    if (gen !== state.gen) return result;
    state.sampleCursor = (idx + 1) % entries.length;
    state.attempted.add(key);
    if (allAttempted()) for (const w of state.waiters) w();
    return result;
  });
}

// Resolves once the rotation has attempted every theater, or at the deadline.
function waitForCoverage(deadlineMs) {
  if (allAttempted() || deadlineMs <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); state.waiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, deadlineMs);
    state.waiters.add(finish);
  });
}

// Every theater's most recent rotation result, tagged with its age (no sampling here).
function readHotspots() {
  return Object.entries(HOTSPOTS).map(([key, box]) => withLastGood(key, box,
    state.attempted.has(key) ? 'background rotation' : 'awaiting first sample (rotation in progress)'));
}

// What a sweep reports: start the rotation if needed, give it until the deadline to
// reach every theater (only matters on the first sweep of a process), then read.
async function collectHotspots(deadlineMs) {
  startBackgroundSampler();
  await waitForCoverage(deadlineMs);
  return readHotspots();
}

// Sample theaters sequentially (paced) from the rotation cursor until the deadline;
// theaters not reached serve their most recent result. Synchronous counterpart of the
// background rotation (CLI, tests); shares its cursor and lock.
export async function sampleAllHotspots(deadlineMs = SAMPLE_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  const entries = Object.entries(HOTSPOTS);
  const sampled = new Map();
  let done = 0;
  while (done < entries.length && (done === 0 || Date.now() < deadline)) {
    const result = await sampleNextHotspot();
    if (!result) break;
    sampled.set(result.key, result);
    done++;
  }
  return entries.map(([key, box]) => sampled.get(key) || withLastGood(key, box, 'not sampled this sweep (time budget)'));
}

// Background rotation: one theater at a time, forever, while aggregator sampling is
// the active path. It idles when OpenSky is serving (no ADS-B Exchange key and a global
// snapshot exists) so the free aggregator is not hit for nothing. Timers are unref'd
// so the loop never keeps a process alive (a pending waitForCoverage holds its own timer).
const BACKGROUND_IDLE_MS = 30_000;
export function startBackgroundSampler() {
  if (state.background) return;
  const bg = { timer: null };
  state.background = bg;
  const schedule = delay => { bg.timer = setTimeout(tick, delay); bg.timer.unref?.(); };
  const tick = async () => {
    if (state.background !== bg) return;
    let delay = 0;
    try {
      const needed = adsbxConfigured() || !state.lastGood;
      if (!needed) delay = BACKGROUND_IDLE_MS;
      else if (!pickProvider()) delay = Math.max(1_000, state.lolCooldownUntil - Date.now());
      else await sampleNextHotspot();
    } catch {
      delay = BACKGROUND_IDLE_MS;
    }
    if (state.background !== bg) return;
    schedule(delay);
  };
  schedule(0);
}

export function stopBackgroundSampler() {
  if (state.background?.timer) clearTimeout(state.background.timer);
  state.background = null;
}

export function backgroundSamplerRunning() { return Boolean(state.background); }

function sampleCoverage(results) {
  const c = { opensky: 0, adsbx: 0, adsbLol: 0, stale: 0, failed: 0, total: results.length };
  for (const r of results) {
    if (r.method === 'none') c.failed++;
    else if (r.stale) c.stale++;
    else if (r.provider === 'adsbexchange') c.adsbx++;
    else c.adsbLol++;
  }
  c.adsbSample = c.adsbx + c.adsbLol + c.stale;
  c.rotationMin = Math.round(rotationMs() / 60000);
  return c;
}

function providerLabel(coverage) {
  if (coverage.adsbx && !coverage.adsbLol) return 'ADS-B Exchange';
  if (coverage.adsbLol && !coverage.adsbx) return 'api.adsb.lol';
  return 'ADS-B Exchange + api.adsb.lol';
}

// ADS-B Exchange configured: it is the primary feed, not a fallback.
async function adsbxBriefing(deadlineMs = SAMPLE_DEADLINE_MS) {
  const results = await collectHotspots(deadlineMs);
  const coverage = sampleCoverage(results);
  const failed = results.filter(r => r.method === 'none');
  const adsbx = adsbxStatus();
  if (coverage.failed === coverage.total) {
    return emptyBriefing(`ADS-B Exchange sampling failed for every theater: ${shortError(failed[0]?.error)}`, 'ADS-B Exchange');
  }
  const provider = providerLabel(coverage);
  return {
    source: provider,
    timestamp: new Date().toISOString(),
    status: coverage.failed || coverage.stale || coverage.adsbLol ? 'partial' : 'live',
    method: 'adsb_sample',
    primary: 'adsbexchange',
    auth: 'rapidapi',
    coverage,
    note: `${coverage.total - coverage.failed} theater(s) sampled from ${provider} in ${SAMPLE_RADIUS_NM} nm circles — counts are sample coverage, not full-box totals; no origin-country data`,
    adsbx: { usedToday: adsbx.usedToday, dailyBudget: adsbx.dailyBudget, coolingDown: adsbx.coolingDown },
    creditsRemaining: state.quota.remaining,
    hotspots: results,
    ...(failed.length ? { hotspotErrors: failed.map(r => ({ region: r.region, error: r.error })) } : {}),
  };
}

// No OpenSky snapshot available at all: sample every hotspot from an aggregator.
async function sampleBriefing(openskyReason, deadlineMs = SAMPLE_DEADLINE_MS) {
  const results = await collectHotspots(deadlineMs);
  const coverage = sampleCoverage(results);
  const failed = results.filter(r => r.method === 'none');
  const openskyError = `OpenSky ${shortError(openskyReason)}: ${openskyReason}`;

  if (coverage.failed === coverage.total) {
    return emptyBriefing(`${openskyError}; ADS-B fallback ${shortError(failed[0]?.error)}`);
  }
  const provider = providerLabel(coverage);
  return {
    source: `ADS-B sample (${provider}) — OpenSky ${shortError(openskyReason)}`,
    timestamp: new Date().toISOString(),
    status: 'fallback',
    method: 'adsb_sample',
    primary: 'opensky',
    auth: credentials() ? 'oauth2' : 'anonymous',
    coverage,
    note: `${coverage.total - coverage.failed} theater(s) sampled from ${provider} at ${SAMPLE_RADIUS_NM} nm radius, refreshed in rotation every ~${coverage.rotationMin} min — counts are partial, not full-box totals; no origin-country data`,
    openskyError,
    creditsRemaining: state.quota.remaining,
    hotspots: results,
    ...(failed.length ? { hotspotErrors: failed.map(r => ({ region: r.region, error: r.error })) } : {}),
  };
}

function buildBriefing({ states, time, fetchedAt }, extra = {}) {
  const { hotspots, totalStates, positioned } = partitionStates(states);
  return {
    source: 'OpenSky',
    timestamp: new Date().toISOString(),
    dataTimestamp: time ? new Date(time * 1000).toISOString() : fetchedAt,
    fetchedAt,
    status: extra.stale ? 'stale' : 'live',
    method: 'opensky',
    primary: 'opensky',
    auth: credentials() ? 'oauth2' : 'anonymous',
    coverage: { opensky: hotspots.length, adsbx: 0, adsbLol: 0, adsbSample: 0, stale: 0, failed: 0, total: hotspots.length },
    globalAircraft: totalStates,
    positionedAircraft: positioned,
    creditsRemaining: state.quota.remaining,
    hotspots,
    ...extra,
  };
}

function emptyBriefing(error, source = 'OpenSky') {
  const { hotspots } = partitionStates([]);
  return {
    source,
    timestamp: new Date().toISOString(),
    status: 'no_data',
    method: 'none',
    primary: source === 'OpenSky' ? 'opensky' : 'adsbexchange',
    auth: credentials() ? 'oauth2' : 'anonymous',
    coverage: { opensky: 0, adsbx: 0, adsbLol: 0, adsbSample: 0, stale: 0, failed: hotspots.length, total: hotspots.length },
    globalAircraft: 0,
    positionedAircraft: 0,
    creditsRemaining: state.quota.remaining,
    hotspots: hotspots.map(h => ({ ...h, tracks: [] })),
    error,
  };
}

// Briefing — with ADSBX_RAPIDAPI_KEY set, ADS-B Exchange samples every theater.
// Otherwise one global OpenSky pull per sweep, partitioned into hotspot regions,
// falling back to the last good snapshot while throttled/cooling down, and to an
// api.adsb.lol sample when no OpenSky snapshot exists yet.
export async function briefing() {
  if (adsbxConfigured()) return adsbxBriefing();

  const now = Date.now();
  const sinceLast = now - state.lastFetchAt;

  // Throttle: never hit the API more often than MIN_INTERVAL_MS, or while cooling down.
  const throttled = state.lastGood && sinceLast < MIN_INTERVAL_MS - 30_000;
  const coolingDown = now < state.cooldownUntil;

  if (!throttled && !coolingDown) {
    state.lastFetchAt = now;
    const data = await getAllFlights();
    if (data && !data.error && Array.isArray(data.states)) {
      state.lastGood = { states: data.states, time: data.time, fetchedAt: new Date(now).toISOString() };
      state.lastError = null;
      return buildBriefing(state.lastGood);
    }
    state.lastError = data?.error || 'OpenSky returned no state vectors';
  }

  const reason = coolingDown
    ? `OpenSky rate-limited until ${new Date(state.cooldownUntil).toISOString()}`
    : (throttled ? `OpenSky throttled locally (min interval ${MIN_INTERVAL_MS / 60000} min)` : state.lastError);

  if (state.lastGood) {
    return buildBriefing(state.lastGood, {
      stale: true,
      staleReason: reason,
      ...(state.lastError && !throttled ? { error: state.lastError } : {}),
    });
  }
  // Whatever OpenSky consumed comes off the sampling budget so the source stays under its runSource timeout.
  return sampleBriefing(reason || 'OpenSky unavailable', Math.min(SAMPLE_DEADLINE_MS, SWEEP_BUDGET_MS - (Date.now() - now)));
}

if (process.argv[1]?.endsWith('opensky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
