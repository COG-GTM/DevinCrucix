// Live ADS-B for the map — key-free community aggregators, seconds-fresh (the sweep adapters in
// opensky.mjs / adsb.mjs are 15-minute snapshots). Primary api.adsb.lol, fallback opendata.adsb.fi;
// both expose the same readsb JSON (`/v2/mil`, `/v2/lat/{lat}/lon/{lon}/dist/{nm}`).
import { safeFetch } from '../utils/fetch.mjs';
import { MILITARY_TYPES } from './adsb.mjs';

export const PROVIDERS = [
  { id: 'adsb.lol', base: 'https://api.adsb.lol/v2' },
  { id: 'adsb.fi', base: 'https://opendata.adsb.fi/api/v2' },
];
export const MAX_DIST_NM = 250;
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';

const n = v => (Number.isFinite(+v) ? +v : null);

// readsb aircraft → map contact. Drops aircraft without a position.
export function normalizeAircraft(a, { military = false } = {}) {
  const lat = n(a?.lat), lng = n(a?.lon);
  if (lat === null || lng === null) return null;
  const onGround = a.alt_baro === 'ground';
  const alt = onGround ? 0 : n(a.alt_baro) ?? n(a.alt_geom);
  const type = String(a.t || '').trim();
  const mil = military || (a.dbFlags & 1) === 1;
  const emergency = a.emergency && a.emergency !== 'none' ? String(a.emergency).toUpperCase() : null;
  return {
    hex: String(a.hex || '').toLowerCase(), callsign: String(a.flight || '').trim() || null, reg: a.r || null, type: type || null,
    typeName: MILITARY_TYPES[type] || null, lat, lng, alt, gs: n(a.gs), track: n(a.track) ?? n(a.calc_track), vr: n(a.baro_rate) ?? n(a.geom_rate),
    squawk: a.squawk || null, emergency, military: mil, onGround, seenPos: n(a.seen_pos), category: a.category || null,
  };
}

const altColor = (c) => c.emergency ? '#ff1744' : c.military ? '#ff9100' : c.onGround ? 'rgba(160,160,160,0.6)' : c.alt > 30000 ? '#80d8ff' : c.alt > 10000 ? '#40c4ff' : '#00b0ff';
const fmtAlt = (c) => c.onGround ? 'on ground' : Number.isFinite(c.alt) ? `FL${String(Math.round(c.alt / 100)).padStart(3, '0')}` : 'alt n/a';

export function aircraftPoint(c) {
  return {
    lat: c.lat, lng: c.lng, alt: c.onGround ? 0.005 : 0.01 + Math.min(0.03, (c.alt || 0) / 1_500_000), size: c.military ? 0.32 : 0.18,
    color: altColor(c),
    head: `${c.callsign || c.hex.toUpperCase()}${c.typeName ? ` · ${c.typeName}` : c.type ? ` · ${c.type}` : ''}`,
    text: [fmtAlt(c), c.gs !== null ? `${Math.round(c.gs)} kt` : '', c.track !== null ? `hdg ${Math.round(c.track)}°` : '', c.emergency ? `EMERGENCY ${c.emergency}` : '', c.squawk ? `sqk ${c.squawk}` : ''].filter(Boolean).join(' · '),
    meta: [c.military ? 'MILITARY' : 'civil', c.reg ? `reg ${c.reg}` : '', `icao ${c.hex}`, c.seenPos !== null ? `fix ${Math.round(c.seenPos)}s ago` : ''].filter(Boolean).join(' · '),
    kind: 'aircraft', hex: c.hex, military: c.military,
  };
}

async function tryProviders(path, { fetchImpl }) {
  const errors = [];
  for (const p of PROVIDERS) {
    const d = await fetchImpl(`${p.base}${path}`, { timeout: 12000, retries: 0, headers: { 'User-Agent': UA } });
    if (d && !d.error && Array.isArray(d.ac)) return { provider: p.id, ac: d.ac, now: d.now, errors };
    errors.push(`${p.id}: ${d?.error || 'bad payload'}`);
  }
  throw new Error(errors.join('; '));
}

export async function fetchMilitary({ fetchImpl = safeFetch } = {}) {
  const r = await tryProviders('/mil', { fetchImpl });
  const contacts = r.ac.map(a => normalizeAircraft(a, { military: true })).filter(Boolean);
  return { provider: r.provider, contacts, notes: r.errors };
}

export async function fetchArea(lat, lon, distNm, { fetchImpl = safeFetch } = {}) {
  const d = Math.min(MAX_DIST_NM, Math.max(1, distNm || 100));
  const r = await tryProviders(`/lat/${(+lat).toFixed(3)}/lon/${(+lon).toFixed(3)}/dist/${Math.round(d)}`, { fetchImpl });
  const contacts = r.ac.map(a => normalizeAircraft(a)).filter(Boolean);
  return { provider: r.provider, contacts, notes: r.errors };
}
