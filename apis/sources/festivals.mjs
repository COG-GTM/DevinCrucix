// Music festivals — what is on right now and in the next 72 h.
//   live schedule: Ticketmaster Discovery API (free key TICKETMASTER_API_KEY, 5k calls/day)
//   background:    Wikidata — major recurring music festivals (instances of Q868557) with coordinates
//                  and yearly visitor counts; key-free, cached a day. Keeps the layer populated without a key.
// "Live now" is schedule-derived (start ≤ now ≤ start + LIVE_HOURS); no free feed reports attendance.
import { safeFetch } from '../utils/fetch.mjs';

export const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
export const WIKIDATA_URL = 'https://query.wikidata.org/sparql';
export const LIVE_HOURS = 10;
export const LOOKBACK_HOURS = 12;
export const LOOKAHEAD_HOURS = 72;
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)';
const COLORS = { live: '#ff4081', upcoming: 'rgba(255,64,129,0.55)', major: 'rgba(255,255,255,0.35)' };

const n = v => (Number.isFinite(+v) ? +v : null);
const isoNoMs = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function tmUrl(apiKey, { nowMs = Date.now(), page = 0, size = 200, keyword = 'festival' } = {}) {
  const q = new URLSearchParams({
    apikey: apiKey, classificationName: 'music', keyword, size: String(size), page: String(page), sort: 'date,asc',
    startDateTime: isoNoMs(nowMs - LOOKBACK_HOURS * 3600_000), endDateTime: isoNoMs(nowMs + LOOKAHEAD_HOURS * 3600_000),
  });
  return `${TM_BASE}?${q}`;
}

export const eventStatus = (e, nowMs = Date.now()) => { const s = Date.parse(e.start), x = Date.parse(e.end); return nowMs >= s && nowMs <= x ? 'live' : nowMs < s ? 'upcoming' : 'ended'; };

// Ticketmaster event → festival record (null when it has no coordinates).
export function normalizeTmEvent(ev, nowMs = Date.now()) {
  const venue = ev?._embedded?.venues?.[0];
  const lat = n(venue?.location?.latitude), lng = n(venue?.location?.longitude);
  if (lat === null || lng === null) return null;
  const startIso = ev.dates?.start?.dateTime || (ev.dates?.start?.localDate ? `${ev.dates.start.localDate}T${ev.dates.start.localTime || '12:00:00'}Z` : null);
  const start = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(start)) return null;
  const endIso = ev.dates?.end?.dateTime || null;
  const end = endIso ? Date.parse(endIso) : start + LIVE_HOURS * 3600_000;
  const status = nowMs >= start && nowMs <= end ? 'live' : nowMs < start ? 'upcoming' : 'ended';
  const acts = (ev._embedded?.attractions || []).map(a => a.name).filter(Boolean).slice(0, 6);
  const cls = (ev.classifications || [])[0] || {};
  return {
    id: ev.id, name: ev.name, url: ev.url || null, start: new Date(start).toISOString(), end: new Date(end).toISOString(), status,
    venue: venue.name || null, city: venue.city?.name || null, country: venue.country?.countryCode || null, lat, lng, acts,
    genre: [cls.genre?.name, cls.subGenre?.name].filter(x => x && x !== 'Undefined').join(' / ') || null, saleStatus: ev.dates?.status?.code || null,
  };
}

export function normalizeTmPage(page, nowMs = Date.now()) {
  return (page?._embedded?.events || []).map(e => normalizeTmEvent(e, nowMs)).filter(Boolean).filter(e => e.status !== 'ended' && e.saleStatus !== 'cancelled');
}

export const WIKIDATA_QUERY = `SELECT ?item ?itemLabel ?coord ?visitors ?countryLabel WHERE {
  ?item wdt:P31/wdt:P279* wd:Q868557 . ?item wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P1174 ?visitors } OPTIONAL { ?item wdt:P17 ?country }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" } } ORDER BY DESC(?visitors) LIMIT 600`;

// SPARQL bindings → deduped festivals with the max recorded yearly visitors.
export function normalizeWikidata(json) {
  const out = new Map();
  for (const b of json?.results?.bindings || []) {
    const id = b.item?.value?.split('/').pop(); if (!id) continue;
    const m = String(b.coord?.value || '').match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!m) continue;
    const visitors = n(b.visitors?.value);
    const cur = out.get(id);
    if (cur) { if (visitors !== null && (cur.visitors === null || visitors > cur.visitors)) cur.visitors = visitors; continue; }
    out.set(id, { id, name: b.itemLabel?.value || id, lat: +m[2], lng: +m[1], visitors, country: b.countryLabel?.value || null });
  }
  return [...out.values()].filter(f => !/^Q\d+$/.test(f.name));
}

export function festivalDatasets(events = [], majors = [], { nowMs = Date.now() } = {}) {
  const points = [], rings = [];
  const seen = new Set();
  let liveN = 0, upcomingN = 0;
  for (const raw of events) {
    const e = { ...raw, status: eventStatus(raw, nowMs) }; // cached records go stale within the TTL; re-derive at request time
    if (e.status === 'ended') continue;
    const k = `${e.name}|${e.venue}|${e.start.slice(0, 10)}`; if (seen.has(k)) continue; seen.add(k);
    const live = e.status === 'live';
    if (live) liveN++; else upcomingN++;
    const hrs = Math.round((Date.parse(e.start) - nowMs) / 3600_000);
    points.push({
      lat: e.lat, lng: e.lng, size: live ? 0.5 : 0.3, alt: 0.012, color: live ? COLORS.live : COLORS.upcoming,
      head: `${e.name}${live ? ' · LIVE NOW' : ''}`,
      text: [live ? `started ${new Date(e.start).toUTCString().slice(5, 22)} UTC` : `starts in ${hrs} h (${new Date(e.start).toUTCString().slice(5, 22)} UTC)`, e.acts.length ? e.acts.join(', ') : '', e.genre || ''].filter(Boolean).join(' · '),
      meta: [e.venue, e.city, e.country, e.url ? e.url : '', 'Ticketmaster'].filter(Boolean).join(' · '),
      kind: 'festival', status: e.status, id: e.id,
    });
    if (live) rings.push({ lat: e.lat, lng: e.lng, maxR: 2.2, speed: 1.5, period: 1100, color: 'rgba(255,64,129,1)' });
  }
  for (const f of majors) {
    points.push({
      lat: f.lat, lng: f.lng, size: 0.16 + Math.min(0.3, (f.visitors || 0) / 1_500_000), alt: 0.006, color: COLORS.major,
      head: f.name, text: f.visitors ? `~${f.visitors.toLocaleString('en-US')} visitors / year · recurring major festival` : 'recurring major festival',
      meta: [f.country, `Wikidata ${f.id}`].filter(Boolean).join(' · '), kind: 'festival', status: 'major', id: f.id,
    });
  }
  return { points, rings, counts: { live: liveN, upcoming: upcomingN, major: majors.length } };
}

export async function fetchTicketmaster(apiKey, { fetchImpl = safeFetch, nowMs = Date.now(), maxPages = 3 } = {}) {
  const events = [];
  const notes = [];
  for (let page = 0; page < maxPages; page++) {
    const d = await fetchImpl(tmUrl(apiKey, { nowMs, page }), { timeout: 15000, retries: 0, headers: { 'User-Agent': UA } });
    if (d?.error) { notes.push(`Ticketmaster: ${d.error.slice(0, 120)}`); if (!events.length) throw new Error(notes[0]); break; }
    events.push(...normalizeTmPage(d, nowMs));
    const pg = d.page || {};
    if (pg.number === undefined || pg.number + 1 >= (pg.totalPages || 0)) break;
  }
  return { events, notes };
}

export async function fetchWikidataFestivals({ fetchImpl = safeFetch } = {}) {
  const d = await fetchImpl(`${WIKIDATA_URL}?format=json&query=${encodeURIComponent(WIKIDATA_QUERY)}`, { timeout: 45000, retries: 1, headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
  if (d?.error) throw new Error(`Wikidata: ${d.error}`);
  return normalizeWikidata(d);
}
