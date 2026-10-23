// Map layer pack — the server side of dashboard/public/map-layers/*.js. Each entry below becomes
// GET /api/map/<id> (see router.mjs for the envelope). Upstream calls are cached per layer; the
// aisstream tanker feed is a long-lived WebSocket started once by startMapFeeds().
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LayerCache } from './cache.mjs';
import { envelope } from './router.mjs';
import { num, oneOf } from '../validate.mjs';
import { fetchTfrs, TFR_TYPES } from '../../apis/sources/faatfr.mjs';
import { fetchSua, SUA_TYPES } from '../../apis/sources/faasua.mjs';
import { fetchNas, NAS_KINDS } from '../../apis/sources/faanas.mjs';
import { fetchMilitary, fetchArea, aircraftPoint, MAX_DIST_NM } from '../../apis/sources/adsblive.mjs';
import { AisTankerFeed, tankerDatasets, TANKER_BOXES } from '../../apis/sources/aistankers.mjs';
import { OfacVesselIndex } from '../../apis/sources/ofacvessels.mjs';
import { fetchTicketmaster, fetchWikidataFestivals, festivalDatasets } from '../../apis/sources/festivals.mjs';
import { fetchRadarLive, aiUsagePayload, loadIndex as loadAiIndex } from '../../apis/sources/aiusage.mjs';
import { CHOKEPOINTS } from '../../apis/sources/ships.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFLICT = JSON.parse(readFileSync(join(ROOT, 'config/geo/conflict-airspace.json'), 'utf8'));
let WORLD = null;
const world = () => WORLD ||= JSON.parse(readFileSync(join(ROOT, 'dashboard/public/geo/world-110m.geojson'), 'utf8'));
const countryGeometry = (a2) => world().features.find(f => f.properties.a2 === a2)?.geometry || null;

export const TTL = { tfr: 10 * 60_000, sua: 24 * 3600_000, nas: 2 * 60_000, mil: 20_000, area: 10_000, festivals: 10 * 60_000, wikidata: 24 * 3600_000, aiLive: 6 * 3600_000 };
const CONFLICT_COLORS = { closed: { fill: 'rgba(244,67,54,0.28)', stroke: 'rgba(244,67,54,0.85)' }, restricted: { fill: 'rgba(255,152,0,0.22)', stroke: 'rgba(255,152,0,0.8)' }, warning: { fill: 'rgba(255,235,59,0.14)', stroke: 'rgba(255,235,59,0.7)' } };

export function conflictPolygons(zones = CONFLICT.zones) {
  return zones.map(z => {
    const geometry = countryGeometry(z.a2); if (!geometry) return null;
    const c = CONFLICT_COLORS[z.level] || CONFLICT_COLORS.warning;
    return { geometry, fill: c.fill, stroke: c.stroke, head: z.label, text: z.note, meta: `${z.authority} · ${z.level.toUpperCase()} · curated ${CONFLICT.reviewed} · ${z.url}`, kind: 'conflict', level: z.level, id: z.a2 };
  }).filter(Boolean);
}

export function createMapLayers({ getCurrentData = () => null, env = process.env, aisFeed = null, ofac = null, deps = {} } = {}) {
  const caches = { tfr: new LayerCache({ ttlMs: TTL.tfr }), sua: new LayerCache({ ttlMs: TTL.sua }), nas: new LayerCache({ ttlMs: TTL.nas }), mil: new LayerCache({ ttlMs: TTL.mil }), area: new LayerCache({ ttlMs: TTL.area, maxKeys: 32 }), festivals: new LayerCache({ ttlMs: TTL.festivals }), wikidata: new LayerCache({ ttlMs: TTL.wikidata }), aiLive: new LayerCache({ ttlMs: TTL.aiLive }) };
  const f = { fetchTfrs, fetchSua, fetchNas, fetchMilitary, fetchArea, fetchTicketmaster, fetchWikidataFestivals, fetchRadarLive, ...deps };
  const feed = aisFeed || new AisTankerFeed({ apiKey: env.AISSTREAM_API_KEY });
  const sanctions = ofac || new OfacVesselIndex();
  const statusOf = (parts) => parts.some(p => p.error) ? (parts.every(p => p.error) ? 'stale' : 'degraded') : 'live';

  const layers = {
    // ── No-fly zones: TFRs (10 min) + prohibited/restricted SUA (daily) + curated conflict closures ──
    nofly: {
      async handler() {
        const [tfr, sua] = await Promise.allSettled([caches.tfr.get('all', () => f.fetchTfrs()), caches.sua.get('PR', () => f.fetchSua())]);
        const notes = [], polygons = [];
        let fetchedAt = Date.now(), status = 'live';
        if (tfr.status === 'fulfilled') { polygons.push(...tfr.value.value.polygons); notes.push(...(tfr.value.value.notes || [])); if (tfr.value.stale) notes.push(`TFR refresh failed: ${tfr.value.error}`); fetchedAt = Math.min(fetchedAt, tfr.value.fetchedAt); }
        else { notes.push(`TFRs unavailable: ${tfr.reason?.message}`); status = 'degraded'; }
        if (sua.status === 'fulfilled') { polygons.push(...sua.value.value); if (sua.value.stale) notes.push(`SUA refresh failed: ${sua.value.error}`); }
        else { notes.push(`Special-use airspace unavailable: ${sua.reason?.message}`); status = 'degraded'; }
        const conflict = conflictPolygons();
        polygons.push(...conflict);
        if ((tfr.value?.stale || sua.value?.stale) && status === 'live') status = 'stale';
        return envelope('nofly', {
          status, fetchedAt, ttlMs: TTL.tfr, notes, polygons,
          source: 'FAA TFR list + GeoServer shapes · FAA Special Use Airspace (ArcGIS) · curated conflict-zone closures (EASA CZIB / FAA SFAR)',
          summary: { tfr: tfr.value?.value ? { total: tfr.value.value.total, drawn: tfr.value.value.polygons.length, noShape: tfr.value.value.noShape.length, byType: tfr.value.value.byType } : null, sua: sua.value?.value?.length || 0, conflict: conflict.length },
          legend: { tfr: TFR_TYPES, sua: SUA_TYPES, conflict: CONFLICT_COLORS },
          noShape: tfr.value?.value?.noShape?.slice(0, 50) || [],
        });
      },
    },

    // ── Aviation: live military (20 s) + FAA NAS airport status (2 min) + GPS-jamming cells from the sweep ──
    aviation: {
      async handler() {
        const [mil, nas] = await Promise.allSettled([caches.mil.get('mil', () => f.fetchMilitary()), caches.nas.get('nas', () => f.fetchNas())]);
        const notes = [], points = [], polygons = [];
        let status = 'live', fetchedAt = Date.now();
        if (mil.status === 'fulfilled') { points.push(...mil.value.value.contacts.map(aircraftPoint)); notes.push(...mil.value.value.notes); fetchedAt = mil.value.fetchedAt; if (mil.value.stale) { status = 'stale'; notes.push(`ADS-B refresh failed: ${mil.value.error}`); } }
        else { notes.push(`Military ADS-B unavailable: ${mil.reason?.message}`); status = 'degraded'; }
        if (nas.status === 'fulfilled') { points.push(...nas.value.value.points); if (nas.value.stale) notes.push(`NAS status refresh failed: ${nas.value.error}`); }
        else { notes.push(`FAA NAS status unavailable: ${nas.reason?.message}`); if (status === 'live') status = 'degraded'; }
        const jam = getCurrentData()?.gpsJamming?.zones || [];
        for (const z of jam) {
          if (!Number.isFinite(z.gridLat) || !Number.isFinite(z.gridLng)) continue;
          const s = z.gridSize || 1, la = z.gridLat, lo = z.gridLng;
          const sev = String(z.severity || '').toLowerCase();
          const fill = sev === 'high' || sev === 'critical' ? 'rgba(255,23,68,0.35)' : sev === 'medium' ? 'rgba(255,145,0,0.3)' : 'rgba(255,234,0,0.22)';
          polygons.push({ geometry: { type: 'Polygon', coordinates: [[[lo, la], [lo + s, la], [lo + s, la + s], [lo, la + s], [lo, la]]] }, fill, stroke: fill.replace(/[\d.]+\)$/, '0.9)'), head: `GPS interference · ${z.region || 'cell'}`, text: `${z.pctLabel || ''} of ${z.total} aircraft report degraded position accuracy (NACp < 8) · severity ${z.severity}`, meta: 'Derived from ADS-B NACp in the last sweep (apis/sources/gpsjamming.mjs)', kind: 'jamming' });
        }
        return envelope('aviation', {
          status, fetchedAt, ttlMs: TTL.mil, notes, points, polygons,
          source: `ADS-B ${mil.value?.value?.provider || 'adsb.lol / adsb.fi'} (military, key-free) · FAA NAS status · sweep GPS-jamming cells`,
          summary: { military: mil.value?.value?.contacts.length || 0, airports: nas.value?.value?.points.length || 0, unplacedAirports: nas.value?.value?.unplaced || [], nasUpdate: nas.value?.value?.updateTime || null, jammingCells: polygons.length, kinds: NAS_KINDS },
        });
      },
    },

    // ── Civil traffic around a point (the map asks for its viewport centre when zoomed in) ──
    traffic: {
      query: { lat: v => num(v, { min: -90, max: 90, required: true }), lon: v => num(v, { min: -180, max: 180, required: true }), dist: v => num(v, { min: 5, max: MAX_DIST_NM, int: true }) },
      async handler(q) {
        const dist = q.dist || 150;
        const key = `${(+q.lat).toFixed(1)},${(+q.lon).toFixed(1)},${dist}`;
        const r = await caches.area.get(key, () => f.fetchArea(q.lat, q.lon, dist));
        const contacts = r.value.contacts;
        return envelope('traffic', {
          status: r.stale ? 'stale' : 'live', fetchedAt: r.fetchedAt, ttlMs: TTL.area, notes: [...r.value.notes, r.error].filter(Boolean),
          points: contacts.map(aircraftPoint), source: `ADS-B ${r.value.provider} · ${dist} nm around ${(+q.lat).toFixed(2)}, ${(+q.lon).toFixed(2)}`,
          summary: { total: contacts.length, airborne: contacts.filter(c => !c.onGround).length, military: contacts.filter(c => c.military).length, emergencies: contacts.filter(c => c.emergency).map(c => c.callsign || c.hex) },
        });
      },
    },

    // ── Oil tankers: aisstream feed (live), OFAC hull match, chokepoint counts ──
    tankers: {
      async handler() {
        const notes = [];
        if (sanctions.index === null || Date.now() - sanctions.loadedAt > sanctions.ttlMs) sanctions.load().catch(e => notes.push(`OFAC vessel list: ${e.message}`));
        const stats = feed.stats;
        const vessels = feed.tankers({ sanctions });
        const ds = tankerDatasets(vessels);
        let status = 'live';
        if (stats.state === 'no_key') { status = 'no_key'; notes.push('AISSTREAM_API_KEY not set — showing chokepoints only. Free key at aisstream.io.'); }
        else if (stats.state !== 'live') { status = vessels.length ? 'stale' : 'degraded'; notes.push(`AIS stream ${stats.state}${stats.lastError ? `: ${stats.lastError}` : ''}`); }
        else if (!vessels.length) notes.push('AIS stream connected — tankers appear as ShipStaticData messages arrive (first few minutes).');
        return envelope('tankers', {
          status, fetchedAt: stats.lastMessageAt ? Date.parse(stats.lastMessageAt) : Date.now(), ttlMs: 30_000, notes,
          points: ds.points, rings: ds.rings, labels: ds.labels,
          source: 'aisstream.io AIS (ship types 80–89) · OFAC SDN vessel list · chokepoints from apis/sources/ships.mjs',
          summary: { ...ds.counts, feed: stats, sanctionsIndex: sanctions.stats, chokepoints: ds.chokepoints, boxes: Object.keys(TANKER_BOXES) },
        });
      },
    },

    // ── Festivals: Ticketmaster (live/upcoming) + Wikidata majors (background) ──
    festivals: {
      async handler() {
        const notes = [];
        const key = env.TICKETMASTER_API_KEY;
        const [tm, wd] = await Promise.allSettled([
          key ? caches.festivals.get('tm', () => f.fetchTicketmaster(key)) : Promise.reject(new Error('no key')),
          caches.wikidata.get('majors', () => f.fetchWikidataFestivals()),
        ]);
        let status = 'live', fetchedAt = Date.now();
        let events = [], majors = [];
        if (!key) { status = 'no_key'; notes.push('TICKETMASTER_API_KEY not set — showing major recurring festivals only (Wikidata). Free key at developer.ticketmaster.com.'); }
        else if (tm.status === 'fulfilled') { events = tm.value.value.events; notes.push(...tm.value.value.notes); fetchedAt = tm.value.fetchedAt; if (tm.value.stale) { status = 'stale'; notes.push(`Ticketmaster refresh failed: ${tm.value.error}`); } }
        else { status = 'degraded'; notes.push(`Ticketmaster unavailable: ${tm.reason?.message}`); }
        if (wd.status === 'fulfilled') { majors = wd.value.value; if (wd.value.stale) notes.push(`Wikidata refresh failed: ${wd.value.error}`); }
        else { notes.push(`Wikidata unavailable: ${wd.reason?.message}`); if (status === 'live') status = 'degraded'; }
        const ds = festivalDatasets(events, majors);
        return envelope('festivals', {
          status, fetchedAt, ttlMs: TTL.festivals, notes, points: ds.points, rings: ds.rings,
          source: 'Ticketmaster Discovery (music · festival, −12 h → +72 h) · Wikidata music festivals (P1174 visitors)',
          summary: { ...ds.counts, liveRule: 'live = start ≤ now ≤ end (or start + 10 h); schedule-derived, not attendance' },
        });
      },
    },

    // ── AI usage: Anthropic Economic Index (static) + Cloudflare Radar AI domain rankings (daily) ──
    aiusage: {
      async handler() {
        const notes = [];
        let live = null, status = 'live', fetchedAt = Date.now();
        if (!env.CLOUDFLARE_API_TOKEN) { status = 'no_key'; notes.push('CLOUDFLARE_API_TOKEN not set — static Anthropic Economic Index only. Any Cloudflare API token can read Radar.'); }
        else {
          try { const r = await caches.aiLive.get('radar', () => f.fetchRadarLive({ token: env.CLOUDFLARE_API_TOKEN })); live = r.value; fetchedAt = r.fetchedAt; notes.push(...(live?.notes || [])); if (r.stale) { status = 'stale'; notes.push(`Radar refresh failed: ${r.error}`); } }
          catch (e) { status = 'degraded'; notes.push(`Cloudflare Radar unavailable: ${e.message}`); }
        }
        const payload = aiUsagePayload(loadAiIndex(), live);
        return envelope('aiusage', {
          status, fetchedAt, ttlMs: TTL.aiLive, notes, ...payload,
          source: 'Anthropic Economic Index (static, per-capita usage index) · Cloudflare Radar domain rankings for chatgpt.com / claude.ai + top generative-AI services per country (daily)',
          summary: { countries: payload.countries.length, states: payload.states.length, liveCountries: live ? Object.keys(live.countries).length : 0, geometry: '/geo/world-110m.geojson (join on properties.a2)' },
        });
      },
    },
  };
  return { layers, feed, sanctions, caches };
}

// Called once from server start(): opens the aisstream socket (when keyed) and warms the OFAC index.
export function startMapFeeds({ feed, sanctions }) {
  feed.start();
  if (feed.state === 'no_key') console.log('[AIS] AISSTREAM_API_KEY not set — tanker layer shows chokepoints only');
  sanctions.load().then(() => console.log(`[AIS] OFAC vessel index: ${sanctions.stats.total} vessels (${sanctions.stats.withImo} IMO, ${sanctions.stats.withMmsi} MMSI)`)).catch(e => console.warn('[AIS] OFAC vessel index failed:', e.message));
}
