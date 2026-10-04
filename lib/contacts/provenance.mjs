// Contact provenance — which independent feeds saw an air contact, whether they agree, and how
// old the fix is (age of the observation, not of the HTTP response). Ported from the Velocity
// model (AndrewCTF/velocity): a contact is only as good as the number of sources that agree on it
// and the age of its newest fix. Pure functions over the OpenSky and ADS-B briefings CRUCIX
// already pulls each sweep; no extra network.
//
// Rule (computed, documented, never an intent assessment):
//   corroborated  ≥2 independent feeds report the same ICAO24 within AGREE_KM
//   conflict      ≥2 feeds report the same ICAO24 but positions differ by more than AGREE_KM
//   single        one feed, fix ≤ FRESH_S old (or age unknown)
//   stale         one feed, fix older than FRESH_S
//   score 0–100 = base(sources) − age penalty (3 pts per minute of fix age, capped at 30)

import { HOTSPOTS } from '../../apis/sources/opensky.mjs';

export const AGREE_KM = 25;      // sources are fetched minutes apart; a jet covers ~15 km/min
export const FRESH_S = 120;      // OpenSky drops state vectors after ~15 s silence; 2 min is generous
export const CONFIDENCE = ['corroborated', 'single', 'stale', 'conflict'];
export const BASE_SCORE = { corroborated: 90, single: 55, stale: 55, conflict: 35 };
export const AGE_PENALTY_PER_MIN = 3;
export const MAX_AGE_PENALTY = 30;
export const RULE = `corroborated = 2+ feeds agree on the same ICAO24 within ${AGREE_KM} km · conflict = 2+ feeds disagree · single = one feed, fix ≤ ${FRESH_S}s · stale = one feed, fix > ${FRESH_S}s · score = base − ${AGE_PENALTY_PER_MIN}/min of fix age (max −${MAX_AGE_PENALTY})`;

const SOURCE_LABEL = { opensky: 'OpenSky', adsb_sample: 'adsb.lol', 'adsb.fi': 'adsb.fi' };
const HEX_RE = /^[0-9a-f]{6}$/;

const R_EARTH_KM = 6371;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function inBox(lat, lon, box) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= box.lamin && lat <= box.lamax && lon >= box.lomin && lon <= box.lomax;
}

export function regionFor(lat, lon) {
  for (const [key, box] of Object.entries(HOTSPOTS)) if (inBox(lat, lon, box)) return key;
  return null;
}

const hex = (v) => { const s = String(v || '').trim().toLowerCase(); return HEX_RE.test(s) ? s : null; };

// Age of a fix in whole seconds. OpenSky lastContact is unix seconds; adsb.fi `seen` is already
// seconds-ago. Unknown → null (never guessed).
export function fixAgeSeconds(track, nowMs) {
  if (Number.isFinite(track?.fixAgeS)) return Math.max(0, Math.round(track.fixAgeS));
  if (Number.isFinite(track?.lastContact) && track.lastContact > 1e9) return Math.max(0, Math.round(nowMs / 1000 - track.lastContact));
  if (Number.isFinite(track?.seen)) return Math.max(0, Math.round(track.seen));
  return null;
}

export function scoreContact({ sources, agreeKm, fixAgeS }) {
  const n = sources.length;
  let confidence;
  if (n >= 2) confidence = Number.isFinite(agreeKm) && agreeKm > AGREE_KM ? 'conflict' : 'corroborated';
  else confidence = Number.isFinite(fixAgeS) && fixAgeS > FRESH_S ? 'stale' : 'single';
  const penalty = Number.isFinite(fixAgeS) ? Math.min(MAX_AGE_PENALTY, Math.floor(fixAgeS / 60) * AGE_PENALTY_PER_MIN) : 0;
  const score = Math.max(0, Math.min(100, BASE_SCORE[confidence] - penalty));
  return { confidence, score };
}

// ADS-B military briefing → Map(hex → {lat, lon, fixAgeS, callsign, type})
function adsbIndex(adsb, nowMs) {
  const idx = new Map();
  const list = Array.isArray(adsb?.militaryAircraft) ? adsb.militaryAircraft : [];
  for (const a of list) {
    const h = hex(a?.hex);
    if (!h || !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) continue;
    idx.set(h, {
      lat: a.latitude, lon: a.longitude,
      fixAgeS: fixAgeSeconds({ seen: a.seen }, nowMs),
      callsign: String(a.callsign || '').trim().slice(0, 8),
      type: String(a.type || '').slice(0, 8),
      typeDescription: String(a.typeDescription || '').slice(0, 60),
      altitudeM: Number.isFinite(a.altitude) ? Math.round(a.altitude * 0.3048) : null,
      heading: Number.isFinite(a.heading) ? a.heading : null,
      velocity: Number.isFinite(a.speed) ? Math.round(a.speed * 0.5144) : null,
    });
  }
  return idx;
}

function emptySummary(nowMs) {
  return {
    computedAt: new Date(nowMs).toISOString(),
    total: 0, military: 0,
    byConfidence: { corroborated: 0, single: 0, stale: 0, conflict: 0 },
    bySource: {}, meanScore: null, rule: RULE,
  };
}

// Annotate every OpenSky hotspot track with `prov`, and surface adsb.fi military airframes inside
// the hotspot boxes that OpenSky did not carry (their own single-source provenance). Does not
// mutate its inputs.
export function fuseAirContacts(sources = {}, { now = Date.now() } = {}) {
  const opensky = sources.OpenSky || {};
  const adsb = sources['ADS-B'] || {};
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const mil = adsbIndex(adsb, nowMs);
  const summary = emptySummary(nowMs);
  const bySource = {};
  const bump = (label, exclusive) => {
    const s = bySource[label] || (bySource[label] = { contacts: 0, exclusive: 0 });
    s.contacts++;
    if (exclusive) s.exclusive++;
  };
  let scoreSum = 0;
  const seenHex = new Set();

  const hotspots = (Array.isArray(opensky.hotspots) ? opensky.hotspots : []).map(h => {
    const primary = SOURCE_LABEL[h?.method] || null;
    const tracks = (Array.isArray(h?.tracks) ? h.tracks : []).map(t => {
      if (!primary || !Number.isFinite(t?.lat) || !Number.isFinite(t?.lon)) return t;
      const id = hex(t.icao24);
      const srcs = [primary];
      let agreeKm = null;
      let fixAgeS = fixAgeSeconds(t, nowMs);
      const m = id ? mil.get(id) : null;
      if (m) {
        srcs.push('adsb.fi');
        agreeKm = Math.round(haversineKm(t.lat, t.lon, m.lat, m.lon) * 10) / 10;
        if (Number.isFinite(m.fixAgeS)) fixAgeS = fixAgeS === null ? m.fixAgeS : Math.min(fixAgeS, m.fixAgeS);
        seenHex.add(id);
      }
      const { confidence, score } = scoreContact({ sources: srcs, agreeKm, fixAgeS });
      summary.total++;
      summary.byConfidence[confidence]++;
      scoreSum += score;
      for (const s of srcs) bump(s, srcs.length === 1);
      return { ...t, prov: { sources: srcs, n: srcs.length, fixAgeS, agreeKm, confidence, score } };
    });
    const counts = { corroborated: 0, single: 0, stale: 0, conflict: 0 };
    for (const t of tracks) if (t.prov) counts[t.prov.confidence]++;
    return { ...h, tracks, provenance: counts };
  });

  // adsb.fi military airframes inside a hotspot box that OpenSky did not list.
  const military = [];
  for (const [id, m] of mil) {
    if (seenHex.has(id)) continue;
    const region = regionFor(m.lat, m.lon);
    if (!region) continue;
    const { confidence, score } = scoreContact({ sources: ['adsb.fi'], agreeKm: null, fixAgeS: m.fixAgeS });
    summary.military++;
    bump('adsb.fi', true);
    military.push({
      icao24: id, callsign: m.callsign, type: m.type, typeDescription: m.typeDescription, region,
      lat: m.lat, lon: m.lon, altitude: m.altitudeM, velocity: m.velocity, heading: m.heading,
      prov: { sources: ['adsb.fi'], n: 1, fixAgeS: m.fixAgeS, agreeKm: null, confidence, score },
    });
  }

  summary.bySource = bySource;
  summary.meanScore = summary.total ? Math.round(scoreSum / summary.total) : null;
  summary.openskyStatus = opensky.status || null;
  summary.openskyDataTimestamp = opensky.dataTimestamp || null;
  return { hotspots, military, summary };
}

// Compact `prov` for dashboard payloads (drops nothing the UI needs, bounds every field).
export function compactProv(p) {
  if (!p || !Array.isArray(p.sources)) return null;
  return {
    sources: p.sources.slice(0, 4).map(s => String(s).slice(0, 16)),
    n: Math.min(4, p.sources.length),
    fixAgeS: Number.isFinite(p.fixAgeS) ? Math.min(86400, Math.round(p.fixAgeS)) : null,
    agreeKm: Number.isFinite(p.agreeKm) ? Math.round(p.agreeKm * 10) / 10 : null,
    confidence: CONFIDENCE.includes(p.confidence) ? p.confidence : 'single',
    score: Number.isFinite(p.score) ? Math.max(0, Math.min(100, Math.round(p.score))) : 0,
  };
}
