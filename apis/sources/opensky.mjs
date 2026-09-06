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

const BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 24 * 3600_000;
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.OPENSKY_MIN_INTERVAL_MINUTES ?? 15)) * 60_000;
const TRACK_SAMPLE_LIMIT = 40;

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
};

export function resetState() {
  Object.assign(state, {
    token: null, tokenExpiresAt: 0, cooldownUntil: 0, lastFetchAt: 0,
    lastGood: null, lastError: null, quota: { remaining: null, updatedAt: null },
  });
}

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
    const res = await fetch(TOKEN_URL, {
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
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, headers });
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
  return openskyGet('/states/all', { timeout: 45000 });
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

function toTrack(s) {
  return {
    icao24: sanitizeText(s[SV.ICAO24], 6),
    callsign: sanitizeText(s[SV.CALLSIGN], 8),
    country: sanitizeText(s[SV.ORIGIN_COUNTRY], 64),
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
    const noCallsign = inRegion.filter(s => !String(s[SV.CALLSIGN] ?? '').trim());
    const highAltitude = inRegion.filter(s => typeof s[SV.BARO_ALT] === 'number' && s[SV.BARO_ALT] > 12000);
    const airborne = inRegion.filter(s => !s[SV.ON_GROUND]);

    // Sample: prioritize anomalous tracks (no callsign, very high altitude), then fill.
    const prioritized = [...new Set([...noCallsign, ...highAltitude, ...airborne])].slice(0, TRACK_SAMPLE_LIMIT);

    return {
      region: box.label,
      key,
      lamin: box.lamin, lomin: box.lomin, lamax: box.lamax, lomax: box.lomax,
      totalAircraft: inRegion.length,
      airborne: airborne.length,
      byCountry,
      noCallsign: noCallsign.length,
      highAltitude: highAltitude.length,
      tracks: prioritized.map(toTrack),
    };
  });

  return { hotspots, totalStates: states.length, positioned };
}

function buildBriefing({ states, time, fetchedAt }, extra = {}) {
  const { hotspots, totalStates, positioned } = partitionStates(states);
  return {
    source: 'OpenSky',
    timestamp: new Date().toISOString(),
    dataTimestamp: time ? new Date(time * 1000).toISOString() : fetchedAt,
    fetchedAt,
    status: extra.stale ? 'stale' : 'live',
    auth: credentials() ? 'oauth2' : 'anonymous',
    globalAircraft: totalStates,
    positionedAircraft: positioned,
    creditsRemaining: state.quota.remaining,
    hotspots,
    ...extra,
  };
}

function emptyBriefing(error) {
  const { hotspots } = partitionStates([]);
  return {
    source: 'OpenSky',
    timestamp: new Date().toISOString(),
    status: 'no_data',
    auth: credentials() ? 'oauth2' : 'anonymous',
    globalAircraft: 0,
    positionedAircraft: 0,
    creditsRemaining: state.quota.remaining,
    hotspots: hotspots.map(h => ({ ...h, tracks: [] })),
    error,
  };
}

// Briefing — one global pull per sweep, partitioned into hotspot regions.
export async function briefing() {
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
  return emptyBriefing(reason || 'OpenSky unavailable');
}

if (process.argv[1]?.endsWith('opensky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
