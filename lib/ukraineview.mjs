// Ukraine War tab — bounded view model over sources CRUCIX already sweeps.
// No new upstream adapters: this slices the Frontlines (DeepStateMAP) summary, the OpenSky `ukraine`
// hotspot, ADS-B military tracks inside the Ukraine / Black Sea box, the GPS-jamming `Eastern Ukraine`
// zone, the FIRMS `Ukraine` bbox, UA / RU nuclear facilities + the Safecast Zaporizhzhia ring, GDELT's
// `Ukraine/Russia` theater, the Ukraine / Russia Telegram channels, Polymarket markets about the war,
// the KiwiSDR `ukraine` box and the UA / RU CII rows. Every string is third-party → bounded here and
// esc()'d in the browser; every coordinate is validated; every URL is http(s) only. Front geometry stays
// out of the payload (the browser pulls /api/frontlines/geo on demand, same as the globe).

import { deriveStrikeCandidates } from './firmsstrikes.mjs';

const MAX_UPDATES = 30;
const MAX_ROWS = 24;
const MAX_POSTS = 18;
const MAX_MARKETS = 10;
const MAX_CORROBORATION = 24;
const CORROBORATION_WINDOW_MS = 72 * 3600000;
const DAY_MS = 86400000;

// Theater box shared by the OpenSky / KiwiSDR / FIRMS adapters (44–53 N, 22–41 E).
export const UA_BBOX = { lamin: 44, lomin: 22, lamax: 53, lomax: 41 };
// ADS-B "Ukraine/Black Sea" sensitive region as declared in apis/sources/adsb.mjs.
const ADSB_BOX = { lamin: 44, lomin: 28, lamax: 52, lomax: 42 };
// GPS-jamming zone as declared in apis/sources/gpsjamming.mjs.
export const GPS_ZONE = { name: 'Eastern Ukraine', lat: [47, 50], lng: [35, 40] };

const NUCLEAR_COUNTRIES = new Set(['UA', 'RU']);
const CII_CODES = new Set(['UA', 'RU']);
const GDELT_REGION = 'Ukraine/Russia';
const GDELT_FIPS = new Set(['UP', 'RS', 'BO']);
const THEATER_RE = /\b(ukrain\w*|russia\w*|kyiv|kiev|kremlin|moscow|donetsk|luhansk|donbas|zaporizh\w*|kherson|kharkiv|crimea|odesa|odessa|sumy|kursk|belgorod|pokrovsk|bakhmut|avdiivka|kupiansk|black sea|putin|zelensk\w*|dnipro|mykolaiv)\b/i;
const MARKET_RE = /\b(ukrain\w*|russia\w*|putin|zelensk\w*|kyiv|kremlin|crimea|donbas|donetsk|kherson|zaporizh\w*|nato)\b/i;
const ACLED_COUNTRIES = /^(ukraine|russia)$/i;
export const TELEGRAM_CHANNELS = ['DeepStateUA', 'GeneralStaffZSU', 'operativnoZSU', 'mod_russia', 'ukraine_frontline', 'wartranslated', 'intelslava', 'RVvoenkor', 'readovkanews', 'legitimniy'];
const TELEGRAM_LABEL = {
  DeepStateUA: 'DeepState Ukraine', GeneralStaffZSU: 'General Staff ZSU', operativnoZSU: 'ZSU Operative', mod_russia: 'Russian MoD',
  ukraine_frontline: 'Ukraine Frontline', wartranslated: 'War Translated', intelslava: 'Intel Slava Z', RVvoenkor: 'Voenkor RV',
  readovkanews: 'Readovka', legitimniy: 'Legitimniy',
};
const TELEGRAM_SIDE = { DeepStateUA: 'UA', GeneralStaffZSU: 'UA', operativnoZSU: 'UA', ukraine_frontline: 'UA', legitimniy: 'UA', mod_russia: 'RU', RVvoenkor: 'RU', readovkanews: 'RU', intelslava: 'RU', wartranslated: 'OSINT' };
// Russian military / state callsign prefixes (RF-xxxxx registrations, RFF = Russian Air Force).
const RU_CALLSIGN_RE = /^(RFF|RF[- ]?\d|RSD)/i;

const str = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const num = (v) => (Number.isFinite(v) ? v : 0);
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const coord = (v, lim) => (Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
const httpUrl = (raw) => {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
};
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const inBox = (lat, lon, b) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= b.lamin && lat <= b.lamax && lon >= b.lomin && lon <= b.lomax;

export function isTheaterText(text) { return THEATER_RE.test(String(text || '')); }

// Source-health state for one adapter, as computed by lib/sourcehealth.mjs for the same sweep.
// Panels render this as LIVE / DEGRADED / NO KEY / OFF / FAILED; `null` = adapter never ran.
function stateOf(health, name) {
  const s = (Array.isArray(health) ? health : []).find(h => h && h.name === name);
  return s ? { state: str(s.state, 16) || 'off', reason: s.reason ? str(s.reason, 80) : null } : { state: null, reason: 'not polled' };
}

// ─── DeepStateMAP front ───────────────────────────────────────────────────────

function trimUpdate(u) {
  const places = (Array.isArray(u.places) ? u.places : []).slice(0, 6)
    .map(p => ({ name: str(p.name, 60), lat: coord(p.lat, 90), lon: coord(p.lon, 180) }))
    .filter(p => p.lat !== null && p.lon !== null);
  return {
    id: Number.isFinite(Number(u.id)) ? Number(u.id) : null,
    at: iso(u.at),
    kind: ['advance', 'regain'].includes(u.kind) ? u.kind : 'other',
    text: str(u.text, 240),
    places,
  };
}

// Per-day advance / regain counts, newest (partial) UTC day last. Today plus the previous `days` full days,
// so a rolling `days`×24 h window (the adapter's recent7d) always lands inside the buckets. The 30-day series
// is only as deep as DeepState's own history endpoint (MAX_UPDATES rows).
export function dailySeries(updates, days, now = Date.now()) {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const out = [];
  for (let i = days; i >= 0; i--) {
    const day = new Date(start.getTime() - i * DAY_MS);
    out.push({ day: day.toISOString().slice(0, 10), advances: 0, regains: 0, other: 0 });
  }
  const byDay = new Map(out.map(d => [d.day, d]));
  for (const u of updates || []) {
    const t = Date.parse(u.at || '');
    if (!Number.isFinite(t)) continue;
    const d = byDay.get(new Date(t).toISOString().slice(0, 10));
    if (!d) continue;
    if (u.kind === 'advance') d.advances++; else if (u.kind === 'regain') d.regains++; else d.other++;
  }
  return out;
}

export function trimFront(fl = {}, health = [], now = Date.now()) {
  const live = fl.status === 'live' && num(fl.featureCount) > 0;
  const hist = fl.history || {};
  const area = fl.areaKm2 || {};
  const updates = (Array.isArray(hist.updates) ? hist.updates : []).slice(0, MAX_UPDATES).map(trimUpdate).filter(u => u.at);
  const cutoff30 = now - 30 * DAY_MS;
  const within30 = updates.filter(u => Date.parse(u.at) >= cutoff30);
  return {
    source: 'Frontlines',
    provider: str(fl.provider || 'DeepStateMAP', 40),
    siteUrl: httpUrl(fl.siteUrl) || 'https://deepstatemap.live/en',
    status: str(fl.status || 'unavailable', 24),
    live,
    stale: Boolean(fl.stale),
    health: stateOf(health, 'Frontlines'),
    mapId: Number.isFinite(Number(fl.mapId)) ? Number(fl.mapId) : null,
    mapUpdatedAt: iso(fl.mapUpdatedAt),
    mapAgeH: numOrNull(fl.mapAgeH),
    featureCount: num(fl.featureCount),
    areaKm2: {
      occupied: num(area.occupied), occupied_pre2022: num(area.occupied_pre2022),
      contested: num(area.contested), liberated: num(area.liberated),
    },
    occupiedKm2: num(fl.occupiedKm2),
    contestedKm2: num(fl.contestedKm2),
    attackDirections: num(fl.attackDirections),
    units: num(fl.units),
    airfields: num(fl.airfields),
    history: {
      total: num(hist.total), recent7d: num(hist.recent7d), advances7d: num(hist.advances7d), regains7d: num(hist.regains7d),
      latestAt: iso(hist.latestAt),
      advances30d: within30.filter(u => u.kind === 'advance').length,
      regains30d: within30.filter(u => u.kind === 'regain').length,
      updates,
      series7d: dailySeries(updates, 7, now),
      series30d: dailySeries(updates, 30, now),
    },
  };
}

// ─── Theater air + EW ─────────────────────────────────────────────────────────

function trimTrack(t) {
  return {
    icao24: str(t.icao24, 6), callsign: str(t.callsign, 8), country: str(t.country, 40),
    lat: coord(t.lat, 90), lon: coord(t.lon, 180),
    altitude: numOrNull(t.altitude), velocity: numOrNull(t.velocity), heading: numOrNull(t.heading), onGround: Boolean(t.onGround),
  };
}

export function trimAir(sources = {}, health = []) {
  const os = sources.OpenSky || {};
  const hot = (Array.isArray(os.hotspots) ? os.hotspots : []).find(h => h && (h.key === 'ukraine' || h.region === 'Ukraine Region')) || null;
  const tracks = (hot && Array.isArray(hot.tracks) ? hot.tracks : []).map(trimTrack).filter(t => t.lat !== null && t.lon !== null).slice(0, 40);
  const byCountry = Object.entries(hot?.byCountry || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [str(k, 32), num(v)]);

  const ad = sources['ADS-B'] || {};
  const mil = (Array.isArray(ad.militaryAircraft) ? ad.militaryAircraft : [])
    .filter(a => inBox(a.latitude, a.longitude, ADSB_BOX))
    .map(a => ({
      callsign: str(a.callsign, 8), type: str(a.typeDescription || a.type, 40), country: str(a.militaryMatch, 32),
      lat: coord(a.latitude, 90), lon: coord(a.longitude, 180), altitude: numOrNull(a.altitude), speed: numOrNull(a.speed),
      ru: RU_CALLSIGN_RE.test(String(a.callsign || '')) || /russia/i.test(String(a.militaryMatch || '')),
    }))
    .filter(a => a.lat !== null && a.lon !== null)
    .slice(0, MAX_ROWS);
  const ruCallsigns = mil.filter(a => a.ru).map(a => a.callsign).filter(Boolean).slice(0, 12);

  const gj = sources.GPSJamming || {};
  const zones = (Array.isArray(gj.zones) ? gj.zones : [])
    .filter(z => z && (z.region === GPS_ZONE.name || (Number.isFinite(z.lat) && Number.isFinite(z.lng) && z.lat >= GPS_ZONE.lat[0] && z.lat <= GPS_ZONE.lat[1] && z.lng >= GPS_ZONE.lng[0] && z.lng <= GPS_ZONE.lng[1])))
    .map(z => ({
      lat: coord(z.lat, 90), lon: coord(z.lng, 180), severity: ['high', 'medium', 'low'].includes(z.severity) ? z.severity : 'low',
      ratio: numOrNull(z.ratio), degraded: num(z.degraded), total: num(z.total), gridSize: numOrNull(z.gridSize),
    }))
    .filter(z => z.lat !== null && z.lon !== null)
    .slice(0, MAX_ROWS);

  return {
    opensky: {
      health: stateOf(health, 'OpenSky'),
      status: str(os.status, 24) || null,
      method: str(os.method, 24) || null,
      present: Boolean(hot),
      total: num(hot?.totalAircraft), airborne: numOrNull(hot?.airborne), noCallsign: num(hot?.noCallsign), highAltitude: num(hot?.highAltitude),
      byCountry, tracks,
      error: hot?.error ? str(hot.error, 120) : (os.error ? str(os.error, 120) : null),
    },
    adsb: {
      health: stateOf(health, 'ADS-B'),
      status: str(ad.status, 24) || null,
      totalMilitary: num(ad.totalMilitary),
      inTheater: mil.length,
      ruCount: mil.filter(a => a.ru).length,
      ruCallsigns,
      aircraft: mil,
    },
    gps: {
      health: stateOf(health, 'GPSJamming'),
      status: str(gj.status, 24) || null,
      zone: GPS_ZONE.name,
      zones,
      high: zones.filter(z => z.severity === 'high').length,
      medium: zones.filter(z => z.severity === 'medium').length,
      aircraftAnalyzed: num(gj.aircraftAnalyzed),
    },
  };
}

// ─── FIRMS thermal ────────────────────────────────────────────────────────────

export function trimThermal(sources = {}, health = []) {
  const f = sources.FIRMS || {};
  const hot = (Array.isArray(f.hotspots) ? f.hotspots : []).find(h => h && h.region === 'Ukraine') || null;
  const rows = (hot && Array.isArray(hot.highIntensity) ? hot.highIntensity : [])
    .map(h => ({
      lat: coord(h.lat, 90), lon: coord(h.lon, 180), frp: numOrNull(h.frp), brightness: numOrNull(h.brightness),
      date: str(h.date, 10), time: str(h.time, 4), confidence: str(h.confidence, 8), night: h.daynight === 'N',
    }))
    .filter(h => h.lat !== null && h.lon !== null && inBox(h.lat, h.lon, UA_BBOX))
    .slice(0, 15);
  return {
    health: stateOf(health, 'FIRMS'),
    status: str(f.status, 24) || null,
    present: Boolean(hot) && !hot.error,
    error: hot?.error ? str(hot.error, 120) : null,
    total: num(hot?.totalDetections), highConfidence: num(hot?.highConfidence), night: num(hot?.nightDetections),
    highIntensity: Array.isArray(hot?.highIntensity) ? hot.highIntensity.length : 0,
    avgFrp: numOrNull(hot?.avgFRP),
    rows,
  };
}

// ─── Nuclear + Safecast ───────────────────────────────────────────────────────

export function trimNuclear(sources = {}, health = []) {
  const n = sources.Nuclear || {};
  const facilities = (Array.isArray(n.facilities) ? n.facilities : [])
    .filter(f => f && NUCLEAR_COUNTRIES.has(String(f.country)))
    .map(f => ({
      name: str(f.name, 48), country: str(f.country, 2), lat: coord(f.lat, 90), lon: coord(f.lng, 180),
      reactors: num(f.reactors), capacityMW: num(f.capacityMW), operator: str(f.operator, 40),
      status: str(f.status, 24) || 'unknown', risk: str(f.risk, 16) || null,
    }))
    .filter(f => f.lat !== null && f.lon !== null)
    .sort((a, b) => (b.risk === 'critical') - (a.risk === 'critical') || (a.country === 'UA' ? -1 : 1) - (b.country === 'UA' ? -1 : 1) || a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS);
  const sc = sources.Safecast || {};
  const site = (Array.isArray(sc.sites) ? sc.sites : []).find(s => s && (s.key === 'zaporizhzhia' || /zaporizh/i.test(String(s.site || '')))) || null;
  return {
    health: stateOf(health, 'Nuclear'),
    status: str(n.status, 24) || null,
    facilities,
    znpp: facilities.find(f => /zaporizh/i.test(f.name)) || null,
    safecast: {
      health: stateOf(health, 'Safecast'),
      present: Boolean(site),
      site: site ? str(site.site, 48) : null,
      recentReadings: num(site?.recentReadings), avgCPM: numOrNull(site?.avgCPM), maxCPM: numOrNull(site?.maxCPM),
      anomaly: Boolean(site?.anomaly), lastReading: iso(site?.lastReading),
    },
  };
}

// ─── Wires: GDELT + Telegram + Polymarket ─────────────────────────────────────

export function trimWires(sources = {}, health = [], now = Date.now()) {
  const g = sources.GDELT || {};
  const tone = (Array.isArray(g.toneScores) ? g.toneScores : []).find(t => t && t.region === GDELT_REGION) || null;
  const seen = new Set();
  const titles = (Array.isArray(g.allArticles) ? g.allArticles : [])
    .filter(a => a && a.title && (GDELT_FIPS.has(a.country) || isTheaterText(`${a.title} ${a.place || ''}`)))
    .filter(a => isTheaterText(`${a.title} ${a.place || ''}`))
    .filter(a => { const k = String(a.title).toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_ROWS)
    .map(a => ({ title: str(a.title, 160), url: httpUrl(a.url), domain: str(a.domain, 40), at: iso(a.date), place: a.place ? str(a.place, 40) : null }));
  const events = (Array.isArray(g.topEvents) ? g.topEvents : [])
    .filter(e => e && (GDELT_FIPS.has(e.country) || isTheaterText(`${e.headline} ${e.place || ''}`)))
    .slice(0, 8)
    .map(e => ({ headline: str(e.headline, 160), type: str(e.type, 32), place: str(e.place, 40), mentions: num(e.mentions), goldstein: numOrNull(e.goldstein), tone: numOrNull(e.tone), url: httpUrl(e.url) }));

  const tg = sources.Telegram || {};
  const wanted = new Set(TELEGRAM_CHANNELS.map(c => c.toLowerCase()));
  const channels = (Array.isArray(tg.channels) ? tg.channels : [])
    .filter(c => c && wanted.has(String(c.channel || '').toLowerCase()))
    .map(c => ({ channel: str(c.channel, 32), title: str(c.title, 48), side: TELEGRAM_SIDE[c.channel] || 'OSINT', postCount: num(c.postCount), reachable: Boolean(c.reachable) }));
  const posts = (Array.isArray(tg.topPosts) ? tg.topPosts : [])
    .filter(p => p && wanted.has(String(p.channel || '').toLowerCase()) && p.text)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, MAX_POSTS)
    .map(p => ({
      channel: str(p.channel, 32), label: TELEGRAM_LABEL[p.channel] || str(p.channel, 32), side: TELEGRAM_SIDE[p.channel] || 'OSINT',
      text: str(p.text, 260), at: iso(p.date), views: num(p.views), urgent: Boolean(p.urgentFlags),
      url: p.postId && /^[A-Za-z0-9_]{5,32}$/.test(String(p.channel || '')) && /^\d{1,12}$/.test(String(p.postId)) ? `https://t.me/${p.channel}/${p.postId}` : null,
    }));

  const pm = sources.Polymarket || {};
  const markets = (Array.isArray(pm.markets) ? pm.markets : [])
    .filter(m => m && MARKET_RE.test(String(m.question || '')))
    .slice(0, MAX_MARKETS)
    .map(m => ({ question: str(m.question, 140), yesProb: numOrNull(m.yesProb), change24h: numOrNull(m.change24h), volume24hr: numOrNull(m.volume24hr), url: httpUrl(m.url) }));

  return {
    gdelt: {
      health: stateOf(health, 'GDELT'),
      tone: tone ? {
        articleCount: num(tone.articleCount), eventCount: num(tone.eventCount), conflictEvents: num(tone.conflictEvents),
        currentTone: numOrNull(tone.currentTone), previousTone: numOrNull(tone.previousTone), shift: numOrNull(tone.shift),
      } : null,
      titles, events,
    },
    telegram: {
      health: stateOf(health, 'Telegram'),
      status: str(tg.status, 40) || null,
      channels, posts,
      reachable: channels.filter(c => c.reachable).length,
      monitored: channels.length,
    },
    polymarket: { health: stateOf(health, 'Polymarket'), status: str(pm.status, 24) || null, markets },
  };
}

// ─── KiwiSDR + CII + ACLED ────────────────────────────────────────────────────

export function trimSdr(sources = {}, health = []) {
  const k = sources.KiwiSDR || {};
  const zone = k.conflictZones?.ukraine || null;
  const receivers = (zone && Array.isArray(zone.receivers) ? zone.receivers : [])
    .map(r => ({ name: str(r.name, 48), location: str(r.location, 48), country: str(r.country, 32), lat: coord(r.lat, 90), lon: coord(r.lon, 180), users: num(r.users) }))
    .filter(r => r.lat !== null && r.lon !== null && inBox(r.lat, r.lon, UA_BBOX))
    .slice(0, 10);
  return { health: stateOf(health, 'KiwiSDR'), present: Boolean(zone), region: zone ? str(zone.region, 40) : null, count: num(zone?.count), listening: receivers.filter(r => r.users > 0).length, receivers };
}

export function trimCii(sources = {}, health = []) {
  const c = sources.CII || {};
  const rows = (Array.isArray(c.countries) ? c.countries : [])
    .filter(r => r && CII_CODES.has(String(r.code)))
    .map(r => ({
      code: str(r.code, 2), name: str(r.name, 32), score: numOrNull(r.score), level: str(r.level, 16), trend: str(r.trend, 16), trendDelta: numOrNull(r.trendDelta),
      components: { unrest: num(r.components?.unrest), security: num(r.components?.security), information: num(r.components?.information) },
      boosts: { hotspot: num(r.boosts?.hotspot), newsUrgency: num(r.boosts?.newsUrgency), focalPoint: num(r.boosts?.focalPoint), total: num(r.boosts?.total) },
    }))
    .sort((a, b) => (a.code === 'UA' ? -1 : 1) - (b.code === 'UA' ? -1 : 1));
  return { health: stateOf(health, 'CII'), status: str(c.status, 24) || null, warmingUp: Boolean(c.warmingUp), warmupProgress: numOrNull(c.warmupProgress), rows };
}

export function trimAcled(sources = {}, health = []) {
  const a = sources.ACLED || {};
  const events = (Array.isArray(a.deadliestEvents) ? a.deadliestEvents : [])
    .filter(e => e && ACLED_COUNTRIES.test(String(e.country || '')))
    .slice(0, 12)
    .map(e => ({ date: str(e.date, 10), type: str(e.type, 40), country: str(e.country, 16), location: str(e.location, 48), fatalities: num(e.fatalities), lat: coord(e.lat, 90), lon: coord(e.lon, 180) }));
  return { health: stateOf(health, 'ACLED'), status: str(a.status, 24) || null, events };
}

// Independent items about the theater from feeds CRUCIX already runs, in the same 72 h window as the
// DeepState updates they sit next to. Not proof that DeepStateMAP is right — just what else is reporting.
export function corroboration({ gdelt, telegram, acled } = {}, now = Date.now()) {
  const items = [];
  for (const t of gdelt?.titles || []) items.push({ src: t.domain || 'GDELT', via: 'GDELT', title: t.title, url: t.url, at: t.at, place: t.place });
  for (const p of telegram?.posts || []) if (isTheaterText(p.text) || p.side !== 'OSINT') items.push({ src: p.label, via: 'Telegram', title: str(p.text, 160), url: p.url, at: p.at, place: null });
  for (const e of acled?.events || []) items.push({ src: 'ACLED', via: 'ACLED', title: str(`${e.type || 'Event'} — ${e.location || ''}, ${e.country || ''} · ${e.fatalities} fatalities`, 160), url: null, at: iso(e.date), place: e.location || null });
  const seen = new Set();
  return items
    .filter(i => i.title && (!i.at || now - Date.parse(i.at) <= CORROBORATION_WINDOW_MS))
    .filter(i => { const k = i.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, MAX_CORROBORATION);
}

export function buildUkraineView(sources = {}, health = [], now = Date.now()) {
  const front = trimFront(sources.Frontlines || {}, health, now);
  const wires = trimWires(sources, health, now);
  const acled = trimAcled(sources, health);
  return {
    source: 'UkraineWar',
    builtAt: new Date(now).toISOString(),
    bbox: UA_BBOX,
    front,
    air: trimAir(sources, health),
    thermal: trimThermal(sources, health),
    strikes: deriveStrikeCandidates(sources, health, now, UA_BBOX),
    nuclear: trimNuclear(sources, health),
    wires,
    sdr: trimSdr(sources, health),
    cii: trimCii(sources, health),
    acled,
    corroboration: corroboration({ gdelt: wires.gdelt, telegram: wires.telegram, acled }, now),
    attribution: 'Map data © DeepStateMAP (deepstatemap.live)',
    caveat: 'DeepStateMAP is an observational map product. Areas are computed from its polygons and are an assessment, not verified ground truth; “occupied” includes Crimea and pre-2022 ORDLO.',
  };
}
