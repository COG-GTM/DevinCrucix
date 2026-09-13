// FIRMS strike candidates — fuse NASA FIRMS thermal detections in the Ukraine box with
// DeepStateMAP contact-line geometry to surface the hot pixels an analyst would actually
// triage: night passes and high-FRP pixels within a few tens of km of the front, clustered
// so one fire is one row instead of a smear of adjacent 375 m VIIRS pixels.
//
// Everything here is an INDICATOR. A thermal anomaly near the front is consistent with a
// strike, but also with crop burning, shelling-induced grass fires, industry or flares.
// Nothing in this module attributes a detection to a weapon, a side or an event.
//
// Contact-line anchors come from DeepState geometry: attack-axis markers, dated update
// places, and the vertices of the "contested" (grey-zone) polygons — those polygons hug the
// line of contact, unlike the occupied polygons whose outer ring is also the state border.

// Same theater box the FIRMS adapter polls (44–53 N, 22–41 E); lib/ukraineview.mjs passes its UA_BBOX.
const DEFAULT_BBOX = { lamin: 44, lomin: 22, lamax: 53, lomax: 41 };

export const STRIKE_RADIUS_KM = 30;   // max distance from the nearest DeepState anchor
export const CLUSTER_KM = 2.5;        // pixels closer than this collapse into one candidate
export const HOT_FRP_MW = 20;         // daytime pixels need at least this much radiative power
export const TIER_A_KM = 15;
export const TIER_A_FRP_MW = 10;
export const MAX_CLUSTERS = 60;
export const PLACE_KM = 60;           // label a cluster with the nearest DeepState-named place within this range
export const MAX_ANCHORS = 6000;
export const MAX_DETECTIONS = 4000;

const EARTH_KM = 6371.0088;
const rad = d => d * Math.PI / 180;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const coord = (v, lim) => (isNum(v) && Math.abs(v) <= lim ? v : null);
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n) : '');
const inBox = (lat, lon, b) => lat >= b.lamin && lat <= b.lamax && lon >= b.lomin && lon <= b.lomax;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Flatten DeepState geometry into point anchors on / near the line of contact.
export function frontAnchors(geo) {
  if (!geo || typeof geo !== 'object') return [];
  const out = [];
  const push = (lat, lon, kind, name) => {
    const la = coord(lat, 90), lo = coord(lon, 180);
    if (la === null || lo === null || out.length >= MAX_ANCHORS) return;
    out.push({ lat: la, lon: lo, kind, name: str(name, 60) });
  };
  for (const p of Array.isArray(geo.points) ? geo.points : []) {
    if (p && p.cat === 'attack') push(p.lat, p.lon, 'attack', p.name || 'Attack axis');
  }
  for (const c of Array.isArray(geo.changes) ? geo.changes : []) {
    if (c) push(c.lat, c.lon, 'update', c.name || 'DeepState update');
  }
  for (const poly of Array.isArray(geo.polygons) ? geo.polygons : []) {
    if (!poly || poly.cat !== 'contested' || !Array.isArray(poly.rings)) continue;
    for (const ring of poly.rings) {
      if (!Array.isArray(ring)) continue;
      for (const v of ring) {
        if (Array.isArray(v) && v.length >= 2) push(v[1], v[0], 'grey', 'Contested (grey) zone edge');
      }
    }
  }
  return out;
}

// Nearest anchor by great-circle distance; the coarse degree pre-check keeps ~1.3k × ~2k
// comparisons well under 100 ms per sweep.
export function nearestAnchor(lat, lon, anchors) {
  let best = null, bestKm = Infinity;
  for (const a of anchors) {
    if (Math.abs(a.lat - lat) > 0.6 || Math.abs(a.lon - lon) > 0.9) continue;
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (d < bestKm) { bestKm = d; best = a; }
  }
  return best ? { km: bestKm, anchor: best } : null;
}

function acquiredAt(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) return null;
  const t = /^\d{4}$/.test(String(d.time || '')) ? String(d.time) : '0000';
  const iso = `${d.date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? iso : null;
}

function cleanDetection(raw, bbox) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = coord(raw.lat, 90), lon = coord(raw.lon, 180);
  if (lat === null || lon === null || !inBox(lat, lon, bbox)) return null;
  const conf = ['h', 'n', 'l'].includes(raw.conf) ? raw.conf : null;
  return {
    lat, lon,
    frp: isNum(raw.frp) && raw.frp >= 0 ? raw.frp : 0,
    bright: isNum(raw.bright) ? raw.bright : null,
    night: raw.night === true,
    conf,
    at: acquiredAt(raw),
  };
}

// Greedy clustering: seeds are the strongest pixels; a pixel joins the first cluster whose
// seed is within CLUSTER_KM. Output is one row per fire, not per satellite pixel.
export function clusterDetections(dets, km = CLUSTER_KM) {
  const sorted = [...dets].sort((a, b) => b.frp - a.frp);
  const clusters = [];
  for (const d of sorted) {
    let home = null;
    for (const c of clusters) {
      if (Math.abs(c.seed.lat - d.lat) > 0.05 || Math.abs(c.seed.lon - d.lon) > 0.08) continue;
      if (haversineKm(c.seed.lat, c.seed.lon, d.lat, d.lon) <= km) { home = c; break; }
    }
    if (!home) { home = { seed: d, members: [] }; clusters.push(home); }
    home.members.push(d);
  }
  return clusters.map(c => {
    const m = c.members, n = m.length;
    const sumFrp = m.reduce((s, x) => s + x.frp, 0);
    const w = sumFrp > 0 ? sumFrp : n;
    const lat = sumFrp > 0 ? m.reduce((s, x) => s + x.lat * x.frp, 0) / w : m.reduce((s, x) => s + x.lat, 0) / n;
    const lon = sumFrp > 0 ? m.reduce((s, x) => s + x.lon * x.frp, 0) / w : m.reduce((s, x) => s + x.lon, 0) / n;
    const times = m.map(x => x.at).filter(Boolean).sort();
    const confRank = { h: 3, n: 2, l: 1 };
    const conf = m.reduce((b, x) => (x.conf && (confRank[x.conf] || 0) > (confRank[b] || 0) ? x.conf : b), null);
    return {
      lat: +lat.toFixed(4), lon: +lon.toFixed(4),
      n, night: m.filter(x => x.night).length,
      maxFrp: +Math.max(...m.map(x => x.frp)).toFixed(1), sumFrp: +sumFrp.toFixed(1),
      maxBright: m.some(x => isNum(x.bright)) ? Math.round(Math.max(...m.map(x => x.bright ?? -Infinity))) : null,
      conf,
      firstAt: times[0] || null, latestAt: times[times.length - 1] || null,
      distKm: null, near: null, nearKind: null, tier: null,
    };
  });
}

function tierOf(c) {
  if (c.night > 0 && c.distKm <= TIER_A_KM && (c.maxFrp >= TIER_A_FRP_MW || c.n >= 3)) return 'A';
  return 'B';
}

function healthOf(health, name) {
  const h = (Array.isArray(health) ? health : []).find(s => s && s.name === name);
  return h ? { state: str(h.state, 12) || 'off', reason: str(h.reason, 120) || null } : null;
}

const OK_STATES = new Set(['live', 'degraded']);

// Main entry. `sources` is the raw sweep bundle (FIRMS + Frontlines), `health` the sourcehealth rows.
export function deriveStrikeCandidates(sources = {}, health = [], now = Date.now(), bbox = DEFAULT_BBOX) {
  const firms = sources.FIRMS || {};
  const geo = sources.Frontlines?.geo || null;
  const firmsHealth = healthOf(health, 'FIRMS');
  const frontHealth = healthOf(health, 'Frontlines');
  const hot = (Array.isArray(firms.hotspots) ? firms.hotspots : []).find(h => h && h.region === 'Ukraine') || null;
  const windowH = (isNum(hot?.windowDays) ? hot.windowDays : 2) * 24;

  const base = {
    source: 'FIRMSStrikes',
    label: 'Strike candidates',
    windowH,
    radiusKm: STRIKE_RADIUS_KM, clusterKm: CLUSTER_KM, hotFrpMw: HOT_FRP_MW, tierAKm: TIER_A_KM, tierAFrpMw: TIER_A_FRP_MW,
    firmsHealth, frontHealth,
    anchors: 0, anchorKinds: { attack: 0, update: 0, grey: 0 },
    totals: { detections: 0, night: 0, nearFront: 0, nearFrontNight: 0, nightRear: 0, candidates: 0, clusters: 0, tierA: 0 },
    clusters: [],
    latestAt: null,
    mapId: geo?.mapId ?? null, mapUpdatedAt: str(geo?.updatedAt, 30) || null,
    attribution: 'Thermal detections © NASA FIRMS (VIIRS / MODIS). Contact-line context © DeepStateMAP (deepstatemap.live).',
    caveat: 'Candidate indicators, not confirmed strikes. A hot pixel near the front is consistent with a strike, shelling-induced grass fire, crop burning, industry or a flare; FIRMS does not attribute cause.',
  };

  if (!firmsHealth || !OK_STATES.has(firmsHealth.state) || !hot || hot.error) {
    return { ...base, status: 'no_firms', reason: hot?.error ? str(hot.error, 120) : firmsHealth?.reason || (firmsHealth ? `FIRMS ${firmsHealth.state}` : 'FIRMS not in this sweep') };
  }
  if (!Array.isArray(hot.detections)) {
    return { ...base, status: 'no_detections', reason: 'FIRMS Ukraine box carries no per-detection rows this sweep' };
  }

  const dets = hot.detections.slice(0, MAX_DETECTIONS).map(d => cleanDetection(d, bbox)).filter(Boolean);
  base.totals.detections = dets.length;
  base.totals.night = dets.filter(d => d.night).length;

  const anchors = frontAnchors(geo);
  base.anchors = anchors.length;
  for (const a of anchors) base.anchorKinds[a.kind]++;
  if (!anchors.length) {
    return { ...base, status: 'no_front', reason: frontHealth && !OK_STATES.has(frontHealth.state) ? `DeepStateMAP ${frontHealth.state}${frontHealth.reason ? ' — ' + frontHealth.reason : ''}` : 'No DeepStateMAP contact-line geometry this sweep — proximity cannot be computed' };
  }

  const near = [];
  for (const d of dets) {
    const hit = nearestAnchor(d.lat, d.lon, anchors);
    if (!hit || hit.km > STRIKE_RADIUS_KM) { if (d.night) base.totals.nightRear++; continue; }
    base.totals.nearFront++;
    if (d.night) base.totals.nearFrontNight++;
    if (d.night || d.frp >= HOT_FRP_MW) near.push({ ...d, distKm: hit.km, anchor: hit.anchor });
  }
  base.totals.candidates = near.length;

  const named = anchors.filter(a => a.kind === 'update');
  const clusters = clusterDetections(near).map(c => {
    const hit = nearestAnchor(c.lat, c.lon, anchors);
    const distKm = hit ? +hit.km.toFixed(1) : null;
    const town = nearestAnchor(c.lat, c.lon, named);
    const row = {
      ...c, distKm, near: hit ? hit.anchor.name : null, nearKind: hit ? hit.anchor.kind : null,
      place: town && town.km <= PLACE_KM ? { name: town.anchor.name, km: +town.km.toFixed(1) } : null,
    };
    row.tier = tierOf(row);
    return row;
  }).sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'A' ? -1 : 1) || (b.maxFrp - a.maxFrp) || (b.n - a.n))
    .slice(0, MAX_CLUSTERS);

  base.totals.clusters = clusters.length;
  base.totals.tierA = clusters.filter(c => c.tier === 'A').length;
  base.clusters = clusters;
  base.latestAt = clusters.map(c => c.latestAt).filter(Boolean).sort().pop() || null;
  base.builtAt = new Date(now).toISOString();
  return { ...base, status: clusters.length ? 'live' : 'empty', reason: clusters.length ? null : `No night or ≥${HOT_FRP_MW} MW detections within ${STRIKE_RADIUS_KM} km of the DeepState contact line in the last ${windowH} h` };
}
