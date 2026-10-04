// VIIRS nighttime-lights change detection (after Dark Light Viewer), zero-dep. NASA GIBS serves the
// daily Suomi-NPP Black Marble gap-filled, BRDF/moonlight-corrected DNB radiance (the VNP46A2
// product Dark Light Viewer uses) as key-free 256 px palette PNG tiles. For a country viewport we
// fetch the tiles once for a recent night and for two baseline nights (~30 / ~60 days earlier),
// decode the PNGs with node:zlib, read the palette index (monotonic in radiance; transparent = no
// data), reduce each tile to CELL_PX × CELL_PX cells (~10 km at Z6) and keep the cells whose value
// moved by more than the thresholds. Output is a bounded list of "dimmed" / "brightened" cells with
// the nearest configured place — a cue to look, never an assessment: gap-filling, residual cloud,
// snow, fires and sensor angle all move the value.
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeOutboundFetch } from '../safeOutboundFetch.mjs';

export const GIBS_LAYER = 'VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance';
export const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
export const ZOOM = 6;
export const CELL_PX = 4;
export const TILE_PX = 256;
export const MAX_TILES = 24;            // per date; Colombia at Z6 is 3 × 4
export const BASELINE_OFFSETS_D = [30, 31, 60, 61];   // two nights per baseline month: GIBS has gaps and odd renderings
export const RECENT_LOOKBACK_D = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14];
export const MIN_LIT = 40;              // mean grey a cell must reach to count as lit (unlit land renders ~7-13)
export const MIN_ABS_DELTA = 25;
export const MIN_REL_DELTA = 0.5;
export const NODATA = -1;
export const MAX_CELLS = 300;
export const TTL_MS = 6 * 3600_000;
export const TILE_TIMEOUT_MS = 15_000;

export const CAVEAT = 'One night of VIIRS Black Marble gap-filled, moonlight-corrected DNB radiance (NASA GIBS, ~500 m) compared with the brighter of two nights ~30 and ~60 days earlier, reduced to ~10 km cells. Gap-filling, residual cloud, snow, fires, flaring and sensor angle all move the value; a cell is a place to check against ground reporting, not an outage or a settlement change.';

// ---- PNG (RGB / RGBA / gray / gray+alpha / palette, 8-bit, non-interlaced) -> brightness per pixel
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }

/** Decode a PNG buffer to { width, height, gray: Int16Array, palette }. Values are luma 0..255 of the
 *  rendered pixel (for palette PNGs, of the palette colour — GIBS ramps are monotonic in radiance);
 *  fully transparent pixels -> NODATA. */
export function decodePngGray(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = []; let plte = null, trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`unsupported PNG colour type ${ctype}`);
  if (width <= 0 || height <= 0 || width * height > 4_194_304) throw new Error('PNG too large');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0, p = 0; y < height; y++) {
    const filter = raw[p++]; const line = raw.subarray(p, p + stride); p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1; else if (filter === 4) v += paeth(a, b, c);
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const gray = new Int16Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * channels;
    if (ctype === 3) { const idx = px[o]; const alpha = trns && idx < trns.length ? trns[idx] : 255; gray[i] = alpha === 0 || !plte || idx * 3 + 2 >= plte.length ? NODATA : luma(plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2]); }
    else if (ctype === 0) gray[i] = px[o];
    else if (ctype === 4) gray[i] = px[o + 1] === 0 ? NODATA : px[o];
    else if (ctype === 2) gray[i] = luma(px[o], px[o + 1], px[o + 2]);
    else gray[i] = px[o + 3] === 0 ? NODATA : luma(px[o], px[o + 1], px[o + 2]);
  }
  return { width, height, gray, palette: ctype === 3 };
}
function luma(r, g, b) { return Math.round(0.299 * r + 0.587 * g + 0.114 * b); }

/** Mean value per CELL_PX square, row-major; a cell with fewer than half its pixels valid is NODATA. */
export function cellMeans(img, cell = CELL_PX) {
  const cw = Math.floor(img.width / cell), ch = Math.floor(img.height / cell);
  const out = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let s = 0, n = 0;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const v = img.gray[(cy * cell + y) * img.width + cx * cell + x]; if (v >= 0) { s += v; n++; } }
    out[cy * cw + cx] = n * 2 >= cell * cell ? s / n : NODATA;
  }
  return out;
}

// ---- Web-Mercator tile math (EPSG:3857, GoogleMapsCompatible)
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z, latR = lat * Math.PI / 180;
  return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n) };
}
export function tilePixelToLonLat(x, y, z, px, py, tilePx = TILE_PX) {
  const n = 2 ** z, fx = x + px / tilePx, fy = y + py / tilePx;
  const lon = fx / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * fy / n))) * 180 / Math.PI;
  return { lon, lat };
}
/** Tiles covering a [w,s,e,n] bbox at zoom z, capped at MAX_TILES (centre-out). */
export function tilesFor(bbox, z = ZOOM, max = MAX_TILES) {
  const [w, s, e, n] = bbox;
  const a = lonLatToTile(w, n, z), b = lonLatToTile(e, s, z);
  const tiles = [];
  for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) tiles.push({ x, y, z });
  if (tiles.length <= max) return tiles;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  return tiles.sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy)).slice(0, max);
}
export function tileUrl({ x, y, z }, date, layer = GIBS_LAYER) {
  return `${GIBS_BASE}/${layer}/default/${date}/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;
}
export function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function daysAgo(now, d) { return isoDay(now - d * 86_400_000); }

/** Compare one recent cell grid with a baseline grid (same tile). Returns changed cells with tile-local cx/cy. */
export function diffCells(recent, baseline, cw, { minLit = MIN_LIT, minAbs = MIN_ABS_DELTA, minRel = MIN_REL_DELTA } = {}) {
  const out = [];
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i], b = baseline[i];
    if (r < 0 || b < 0) continue;
    const hi = Math.max(r, b);
    if (hi < minLit) continue;
    const d = r - b;
    if (Math.abs(d) < minAbs || Math.abs(d) / Math.max(1, hi) < minRel) continue;
    out.push({ cx: i % cw, cy: Math.floor(i / cw), recent: Math.round(r), base: Math.round(b), delta: Math.round(d), kind: d < 0 ? 'dimmed' : 'brightened' });
  }
  return out;
}

export function nearestPlace(lat, lon, places = []) {
  let best = null;
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const dLat = (p.lat - lat) * 111.2, dLon = (p.lon - lon) * 111.2 * Math.cos(lat * Math.PI / 180);
    const km = Math.hypot(dLat, dLon);
    if (!best || km < best.km) best = { name: p.name, km: Math.round(km) };
  }
  return best;
}

export class NightLights {
  constructor({ dataDir, fetchImpl = safeOutboundFetch, now = () => Date.now(), log = (l) => console.log(l) } = {}) {
    this.dataDir = dataDir;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.results = new Map();   // cc -> result
    this.inflight = new Map();  // cc -> promise
    if (dataDir) this.loadAll();
  }
  file(cc) { return join(this.dataDir, 'nightlights', `${cc}.json`); }
  loadAll() {
    for (const cc of ['co', 've']) {
      try { const r = JSON.parse(readFileSync(this.file(cc), 'utf8')); if (r?.computedAt) this.results.set(cc, r); } catch { /* none yet */ }
    }
  }
  save(cc, r) {
    if (!this.dataDir) return;
    try { mkdirSync(join(this.dataDir, 'nightlights'), { recursive: true }); writeFileSync(this.file(cc), JSON.stringify(r)); } catch (e) { this.log(`[NightLights] save failed: ${e.message}`); }
  }
  get(cc) { return this.results.get(cc) || null; }
  isFresh(cc) { const r = this.get(cc); return !!r && this.now() - Date.parse(r.computedAt) < TTL_MS; }
  status(cc) {
    if (this.inflight.has(cc)) return 'computing';
    const r = this.get(cc);
    if (!r) return 'pending';
    if (r.error && !r.cells) return 'error';
    return this.isFresh(cc) ? 'live' : 'stale';
  }

  async fetchTile(t, date) {
    const res = await this.fetchImpl(tileUrl(t, date), { timeout: TILE_TIMEOUT_MS, maxBytes: 1024 * 1024, headers: { 'User-Agent': 'Crucix/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!/image\/png/i.test(ct)) throw new Error(`not a PNG tile (${ct.slice(0, 40)})`);
    const img = decodePngGray(Buffer.from(await res.arrayBuffer()));
    // GIBS renders this layer as a palette PNG on the grey ramp; the occasional RGBA tile is a
    // different rendering (seen on range-boundary dates) and is not comparable -> treat as no data.
    if (!img.palette) throw new Error('non-palette tile rendering');
    return img;
  }
  /** A night is "available" when the first tile decodes and is not entirely black (GIBS serves blank tiles for missing dates). */
  async pickRecentDate(tiles) {
    for (const d of RECENT_LOOKBACK_D) {
      const date = daysAgo(this.now(), d);
      try {
        const img = await this.fetchTile(tiles[0], date);
        let valid = 0; for (let i = 0; i < img.gray.length; i += 16) if (img.gray[i] >= 0) valid++;
        if (valid * 16 > img.gray.length / 4) return { date, first: img };
      } catch { /* try an earlier night */ }
    }
    return null;
  }

  /** Compute (or return the in-flight computation for) a country. `cfg` = { id, viewport: { bbox }, places }. */
  compute(cfg, { force = false } = {}) {
    const cc = cfg.id;
    if (this.inflight.has(cc)) return this.inflight.get(cc);
    if (!force && this.isFresh(cc)) return Promise.resolve(this.get(cc));
    const p = this.run(cfg).then(r => { this.results.set(cc, r); this.save(cc, r); return r; })
      .catch(err => { const r = { ...(this.get(cc) || {}), cc, error: err.message, erroredAt: new Date(this.now()).toISOString() }; this.log(`[NightLights] ${cc}: ${err.message}`); if (!this.get(cc)) this.results.set(cc, r); return r; })
      .finally(() => this.inflight.delete(cc));
    this.inflight.set(cc, p);
    return p;
  }

  async run(cfg) {
    const bbox = cfg.viewport?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('no viewport bbox');
    const tiles = tilesFor(bbox);
    const recent = await this.pickRecentDate(tiles);
    if (!recent) throw new Error('no VIIRS night available in the last 6 days');
    const baseDates = BASELINE_OFFSETS_D.map(d => isoDay(Date.parse(recent.date) - d * 86_400_000));
    const cw = TILE_PX / CELL_PX;
    const cells = [];
    let fetched = 1, failed = 0, litCells = 0;
    for (const t of tiles) {
      let rImg;
      try { rImg = t === tiles[0] ? recent.first : await this.fetchTile(t, recent.date); fetched++; } catch { failed++; continue; }
      const bases = [];
      for (const d of baseDates) { try { bases.push(cellMeans(await this.fetchTile(t, d))); fetched++; } catch { failed++; } }
      if (!bases.length) continue;
      const rc = cellMeans(rImg);
      // Baseline = brighter of the two nights per cell: cloud and moon make nights darker or noisier,
      // rarely brighter at 10 km, so "max" is the conservative baseline for detecting dimming.
      const bc = new Float32Array(rc.length);
      for (let i = 0; i < rc.length; i++) { let m = NODATA; for (const b of bases) if (b[i] > m) m = b[i]; bc[i] = m; }
      for (let i = 0; i < rc.length; i++) if (Math.max(rc[i], bc[i]) >= MIN_LIT) litCells++;
      for (const c of diffCells(rc, bc, cw)) {
        const { lon, lat } = tilePixelToLonLat(t.x, t.y, t.z, (c.cx + 0.5) * CELL_PX, (c.cy + 0.5) * CELL_PX);
        if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
        const sizeDeg = 360 / 2 ** t.z / (TILE_PX / CELL_PX);
        cells.push({ lat: +lat.toFixed(3), lon: +lon.toFixed(3), sizeDeg: +sizeDeg.toFixed(4), ...c, cx: undefined, cy: undefined, near: nearestPlace(lat, lon, cfg.places) });
      }
    }
    cells.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const top = cells.slice(0, MAX_CELLS).map(c => { const { cx, cy, ...rest } = c; return rest; });
    return {
      cc: cfg.id, computedAt: new Date(this.now()).toISOString(), layer: GIBS_LAYER, zoom: ZOOM, cellKm: Math.round(40075 / 2 ** ZOOM / (TILE_PX / CELL_PX)),
      recentDate: recent.date, baselineDates: baseDates, tiles: { requested: tiles.length, fetched, failed },
      summary: { litCells, changed: cells.length, dimmed: cells.filter(c => c.kind === 'dimmed').length, brightened: cells.filter(c => c.kind === 'brightened').length, shown: top.length },
      cells: top,
      tileTemplate: tileUrl({ x: '{x}', y: '{y}', z: '{z}' }, recent.date),
      attribution: 'NASA Worldview / GIBS · VIIRS SNPP Day/Night Band at-sensor radiance (NASA EOSDIS, public domain)',
      caveat: CAVEAT,
    };
  }
}
