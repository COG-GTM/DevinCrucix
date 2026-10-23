// Live tanker tracking — aisstream.io WebSocket (free key: AISSTREAM_API_KEY), AIS ship types 80–89.
// One persistent server-side subscription over the oil chokepoints + major tanker basins; the last
// position per MMSI is kept in memory (no disk). Sanctioned hulls are flagged against the OFAC SDN
// vessel index (ofacvessels.mjs). Node 22+ ships a global WebSocket, so no dependency is needed.
import { CHOKEPOINTS } from './ships.mjs';

export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
// [[south-west lat, lon], [north-east lat, lon]] — aisstream bounding-box format.
export const TANKER_BOXES = {
  gulfHormuz: [[22.0, 47.0], [31.0, 63.0]],
  redSeaSuez: [[10.0, 31.0], [32.0, 46.0]],
  medGibraltar: [[30.0, -8.0], [46.0, 37.0]],
  malaccaSingapore: [[-6.0, 94.0], [8.0, 110.0]],
  taiwanScs: [[8.0, 110.0], [30.0, 125.0]],
  blackSeaBosporus: [[40.0, 27.0], [47.5, 42.0]],
  balticDanish: [[53.5, 9.0], [61.0, 30.0]],
  gulfOfMexicoCaribbean: [[8.0, -98.0], [31.0, -58.0]],
  northSeaChannel: [[48.0, -6.0], [62.0, 9.0]],
  capeOfGoodHope: [[-38.0, 14.0], [-28.0, 32.0]],
  panamaPacific: [[4.0, -84.0], [12.0, -76.0]],
  westAfricaGuinea: [[-8.0, -5.0], [10.0, 12.0]],
  japanKorea: [[30.0, 125.0], [42.0, 142.0]],
  indiaArabianSea: [[5.0, 63.0], [25.0, 80.0]],
};
export const NAV_STATUS = {
  0: 'under way (engine)', 1: 'at anchor', 2: 'not under command', 3: 'restricted manoeuvrability', 4: 'constrained by draught',
  5: 'moored', 6: 'aground', 7: 'fishing', 8: 'under way (sailing)', 11: 'towing astern', 12: 'pushing ahead', 14: 'AIS-SART', 15: 'undefined',
};
export const TANKER_TYPES = { 80: 'Tanker', 81: 'Tanker · hazardous A', 82: 'Tanker · hazardous B', 83: 'Tanker · hazardous C', 84: 'Tanker · hazardous D', 85: 'Tanker (reserved)', 86: 'Tanker (reserved)', 87: 'Tanker (reserved)', 88: 'Tanker (reserved)', 89: 'Tanker · no additional info' };
export const isTankerType = (t) => Number.isInteger(t) && t >= 80 && t <= 89;

export const GAP_MIN = 45;            // minutes without a position while under way = AIS gap ("dark")
export const EXPIRE_HOURS = 6;        // forget a vessel after this long without any message
const MAX_VESSELS = 12_000;
const COLORS = { underway: '#00e5a0', stopped: '#ffd600', gap: 'rgba(170,170,170,0.75)', sanctioned: '#ff1744' };

const n = v => (Number.isFinite(+v) ? +v : null);
const nowIso = (ms) => new Date(ms).toISOString();

// One aisstream message → partial vessel update, or null for message types we ignore.
export function parseAisMessage(msg, nowMs = Date.now()) {
  const meta = msg?.MetaData || {};
  const mmsi = String(meta.MMSI || '');
  if (!/^\d{9}$/.test(mmsi)) return null;
  const t = meta.time_utc ? Date.parse(String(meta.time_utc).replace(/ (\+0000|UTC).*$/, 'Z').replace(' ', 'T')) : NaN;
  const ts = Number.isFinite(t) ? t : nowMs;
  const name = String(meta.ShipName || '').trim().replace(/@+$/, '').trim() || null;
  if (msg.MessageType === 'PositionReport' || msg.MessageType === 'StandardClassBPositionReport') {
    const p = msg.Message?.[msg.MessageType] || {};
    const lat = n(p.Latitude) ?? n(meta.latitude), lng = n(p.Longitude) ?? n(meta.longitude);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { mmsi, name, lat, lng, sog: n(p.Sog), cog: n(p.Cog), heading: n(p.TrueHeading), navStatus: n(p.NavigationalStatus), posAt: ts };
  }
  if (msg.MessageType === 'ShipStaticData') {
    const s = msg.Message.ShipStaticData || {};
    const dim = s.Dimension || {};
    const length = (n(dim.A) || 0) + (n(dim.B) || 0) || null;
    return { mmsi, name: String(s.Name || '').trim().replace(/@+$/, '').trim() || name, type: n(s.Type), imo: n(s.ImoNumber) ? String(s.ImoNumber) : null, destination: String(s.Destination || '').trim().replace(/@+$/, '') || null, draught: n(s.MaximumStaticDraught), length, callSign: String(s.CallSign || '').trim() || null, staticAt: ts };
  }
  return null;
}

export function vesselStatus(v, nowMs = Date.now()) {
  const ageMin = v.posAt ? (nowMs - v.posAt) / 60_000 : Infinity;
  const stopped = [1, 5, 6].includes(v.navStatus) || (v.sog !== null && v.sog < 0.5);
  if (ageMin > GAP_MIN && !stopped) return 'gap';
  return stopped ? 'stopped' : 'underway';
}

export function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Vessels (with sanction match applied) → map datasets.
export function tankerDatasets(vessels, { nowMs = Date.now(), chokepointRadiusNm = 120 } = {}) {
  const points = [];
  const counts = { underway: 0, stopped: 0, gap: 0, sanctioned: 0 };
  const perChoke = Object.fromEntries(Object.keys(CHOKEPOINTS).map(k => [k, 0]));
  for (const v of vessels) {
    const st = vesselStatus(v, nowMs);
    counts[st]++;
    if (v.sanction) counts.sanctioned++;
    for (const [k, c] of Object.entries(CHOKEPOINTS)) if (haversineNm(v.lat, v.lng, c.lat, c.lon) <= chokepointRadiusNm) perChoke[k]++;
    const typeLabel = TANKER_TYPES[v.type] || 'Tanker';
    points.push({
      lat: v.lat, lng: v.lng, size: v.sanction ? 0.42 : 0.26, alt: 0.008, color: v.sanction ? COLORS.sanctioned : COLORS[st],
      head: `${v.name || `MMSI ${v.mmsi}`}${v.sanction ? ' · OFAC SANCTIONED' : ''}`,
      text: [typeLabel, NAV_STATUS[v.navStatus] || '', v.sog !== null ? `${v.sog.toFixed(1)} kt` : '', v.cog !== null ? `cog ${Math.round(v.cog)}°` : '', v.destination ? `→ ${v.destination}` : '', st === 'gap' ? `AIS GAP ${Math.round((nowMs - v.posAt) / 60_000)} min` : ''].filter(Boolean).join(' · '),
      meta: [`MMSI ${v.mmsi}`, v.imo ? `IMO ${v.imo}` : '', v.length ? `${v.length} m` : '', v.draught ? `draught ${v.draught} m` : '', v.sanction ? `SDN ${v.sanction.program}${v.sanction.flag ? ` · flag ${v.sanction.flag}` : ''}` : '', `fix ${nowIso(v.posAt)}`].filter(Boolean).join(' · '),
      kind: 'tanker', mmsi: v.mmsi, status: st, sanctioned: !!v.sanction,
    });
  }
  const rings = Object.entries(CHOKEPOINTS).map(([k, c]) => ({ lat: c.lat, lng: c.lon, maxR: 3.2, speed: 1.2, period: 1600, color: perChoke[k] ? 'rgba(0,229,160,1)' : 'rgba(160,160,160,1)' }));
  const labels = Object.entries(CHOKEPOINTS).map(([k, c]) => ({ lat: c.lat, lng: c.lon, text: `${c.label.toUpperCase()} · ${perChoke[k]}`, size: 0.55, color: 'rgba(230,230,230,0.9)' }));
  return { points, rings, labels, counts, chokepoints: Object.entries(CHOKEPOINTS).map(([k, c]) => ({ id: k, label: c.label, note: c.note, lat: c.lat, lng: c.lon, tankers: perChoke[k] })) };
}

export class AisTankerFeed {
  constructor({ apiKey = process.env.AISSTREAM_API_KEY, boxes = Object.values(TANKER_BOXES), WebSocketImpl = globalThis.WebSocket, log = console.log } = {}) {
    this.apiKey = apiKey; this.boxes = boxes; this.WS = WebSocketImpl; this.log = log;
    this.vessels = new Map(); this.ws = null; this.state = apiKey ? 'idle' : 'no_key'; this.lastMessageAt = 0; this.connectedAt = 0;
    this.messages = 0; this.backoffMs = 5_000; this.timer = null; this.stopped = false; this.lastError = null;
  }
  start() {
    if (!this.apiKey || !this.WS) { this.state = this.apiKey ? 'unsupported' : 'no_key'; return this; }
    this.stopped = false; this.connect();
    this.sweeper = setInterval(() => this.expire(), 60_000); this.sweeper.unref?.();
    return this;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.sweeper); try { this.ws?.close(); } catch {} this.ws = null; this.state = 'stopped'; }
  connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    let ws;
    try { ws = new this.WS(AISSTREAM_URL); } catch (e) { this.lastError = e.message; return this.scheduleReconnect(); }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ APIKey: this.apiKey, BoundingBoxes: this.boxes, FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
      this.state = 'live'; this.connectedAt = Date.now(); this.backoffMs = 5_000; this.lastError = null;
      this.log(`[AIS] aisstream connected · ${this.boxes.length} boxes`);
    });
    ws.addEventListener('message', (ev) => { this.ingestRaw(ev.data); });
    ws.addEventListener('error', (ev) => { this.lastError = ev?.message || ev?.error?.message || 'websocket error'; });
    ws.addEventListener('close', (ev) => {
      if (this.ws === ws) this.ws = null;
      if (ev?.reason) this.lastError = String(ev.reason).slice(0, 200);
      this.state = 'disconnected';
      this.scheduleReconnect();
    });
  }
  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoffMs); this.timer.unref?.();
    this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
  }
  ingestRaw(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg?.error) { this.lastError = String(msg.error).slice(0, 200); return; }
    this.ingest(msg);
  }
  ingest(msg, nowMs = Date.now()) {
    const u = parseAisMessage(msg, nowMs);
    if (!u) return false;
    this.messages++; this.lastMessageAt = nowMs;
    const v = this.vessels.get(u.mmsi) || { mmsi: u.mmsi, name: null, type: null, imo: null, lat: null, lng: null, sog: null, cog: null, heading: null, navStatus: null, destination: null, draught: null, length: null, posAt: 0, staticAt: 0, seenAt: 0 };
    for (const [k, val] of Object.entries(u)) if (val !== null && val !== undefined) v[k] = val;
    v.seenAt = nowMs;
    this.vessels.set(u.mmsi, v);
    if (this.vessels.size > MAX_VESSELS) this.expire(nowMs, true);
    return true;
  }
  expire(nowMs = Date.now(), aggressive = false) {
    const limit = (aggressive ? 1 : EXPIRE_HOURS) * 3600_000;
    for (const [k, v] of this.vessels) if (nowMs - v.seenAt > limit || (aggressive && !isTankerType(v.type) && nowMs - v.seenAt > 20 * 60_000)) this.vessels.delete(k);
  }
  // Tankers with a position; `sanctions` is an OfacVesselIndex (optional).
  tankers({ sanctions = null, nowMs = Date.now() } = {}) {
    const out = [];
    for (const v of this.vessels.values()) {
      if (!isTankerType(v.type) || v.lat === null) continue;
      const s = sanctions?.match({ mmsi: v.mmsi, imo: v.imo, name: v.name });
      out.push(s ? { ...v, sanction: { id: s.id, program: s.program, flag: s.flag, vesselType: s.vesselType } } : v);
    }
    return out;
  }
  get stats() {
    const typed = [...this.vessels.values()].filter(v => isTankerType(v.type)).length;
    return { state: this.state, vessels: this.vessels.size, tankers: typed, messages: this.messages, lastMessageAt: this.lastMessageAt ? nowIso(this.lastMessageAt) : null, connectedAt: this.connectedAt ? nowIso(this.connectedAt) : null, lastError: this.lastError, boxes: this.boxes.length };
  }
}
