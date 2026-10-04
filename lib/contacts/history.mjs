// Rolling contact position history — the replay store behind the Military tab's scrubber.
//
// Layout: runs/contacts/positions.jsonl, one compact row per contact per sweep
//   {"ts","id","k","r","lat","lon","alt","hdg","vel","cs","c","n","s"}
// (k = kind air|sea, r = hotspot key, c = confidence, n = source count, s = sources). Append-only
// during a run; rewritten only when the oldest row falls outside the retention window. Resolution
// is the sweep cadence (~15 min), which the API reports so the UI never implies a live track.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HOTSPOTS } from '../../apis/sources/opensky.mjs';

export const RETENTION_HOURS = 48;
export const MAX_ROWS = 250_000;
export const MAX_FRAMES = 200;
export const REGION_KEYS = Object.keys(HOTSPOTS);
export const KINDS = ['air', 'sea'];
export const ID_RE = /^[0-9a-z]{3,12}$/;
const HOUR = 3_600_000;

const isoTs = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const intOrNull = (v) => (Number.isFinite(v) ? Math.round(v) : null);

export class ContactHistory {
  constructor(runsDir, { retentionHours = RETENTION_HOURS, now = () => Date.now() } = {}) {
    this.dir = join(runsDir, 'contacts');
    this.file = join(this.dir, 'positions.jsonl');
    this.retentionMs = retentionHours * HOUR;
    this.now = now;
    this.rows = null;      // sorted asc by ts
    this.seen = null;      // Set(ts|id)
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  _load() {
    if (this.rows) return this.rows;
    const rows = [], seen = new Set();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r.ts !== 'string' || isoTs(r.ts) === null || !ID_RE.test(String(r.id || '')) || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
          const k = `${r.ts}|${r.id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          rows.push(r);
        } catch { /* skip corrupt line */ }
      }
      rows.sort((a, b) => isoTs(a.ts) - isoTs(b.ts));
    }
    this.rows = rows;
    this.seen = seen;
    return rows;
  }

  _rewrite(rows) {
    const tmp = this.file + '.tmp';
    try {
      writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[Contacts] rewrite failed:', err.message);
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  prune(now = this.now()) {
    const rows = this._load();
    const cutoff = now - this.retentionMs;
    let keep = rows;
    if (rows.length && isoTs(rows[0].ts) < cutoff) keep = rows.filter(r => isoTs(r.ts) >= cutoff);
    if (keep.length > MAX_ROWS) keep = keep.slice(keep.length - MAX_ROWS);
    if (keep !== rows) {
      this.rows = keep;
      this.seen = new Set(keep.map(r => `${r.ts}|${r.id}`));
      this._rewrite(keep);
    }
    return rows.length - keep.length;
  }

  // Record one sweep's fused contacts ({hotspots:[{key,tracks}], military:[]}). Returns rows written.
  record(fused, ts) {
    const t = isoTs(ts) ?? this.now();
    if (t > this.now() + HOUR || t < this.now() - this.retentionMs) return 0;
    const iso = new Date(t).toISOString();
    this._load();
    const out = [];
    const push = (c, region, kind = 'air') => {
      const id = String(c?.icao24 || c?.id || '').toLowerCase();
      if (!ID_RE.test(id) || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !REGION_KEYS.includes(region)) return;
      const key = `${iso}|${id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const p = c.prov || {};
      out.push({
        ts: iso, id, k: kind, r: region, lat: r3(c.lat), lon: r3(c.lon),
        alt: intOrNull(c.altitude), hdg: intOrNull(c.heading), vel: intOrNull(c.velocity),
        cs: String(c.callsign || '').trim().slice(0, 8),
        c: p.confidence || null, n: Number.isFinite(p.n) ? p.n : (Array.isArray(p.sources) ? p.sources.length : 0),
        s: Array.isArray(p.sources) ? p.sources.slice(0, 4) : [],
      });
    };
    for (const h of fused?.hotspots || []) for (const tr of h?.tracks || []) push(tr, h.key);
    for (const m of fused?.military || []) push(m, m.region);
    if (!out.length) return 0;
    this.rows.push(...out);
    if (this.rows.length > out.length && isoTs(this.rows[this.rows.length - out.length - 1].ts) > t) this.rows.sort((a, b) => isoTs(a.ts) - isoTs(b.ts));
    try {
      appendFileSync(this.file, out.map(r => JSON.stringify(r)).join('\n') + '\n');
    } catch (err) {
      console.error('[Contacts] append failed:', err.message);
    }
    this.prune();
    return out.length;
  }

  query({ region, id, from, to, kind } = {}) {
    const rows = this._load();
    const f = isoTs(from), tt = isoTs(to);
    return rows.filter(r => (!region || r.r === region) && (!id || r.id === id) && (!kind || r.k === kind)
      && (f === null || isoTs(r.ts) >= f) && (tt === null || isoTs(r.ts) <= tt));
  }

  // Replay payload: one frame per sweep timestamp (contacts at that instant) plus per-contact
  // polylines, for a region over the trailing `hours`.
  replay({ region, hours = 24, id, now = this.now() } = {}) {
    const h = Math.max(1, Math.min(RETENTION_HOURS, Number(hours) || 24));
    const from = now - h * HOUR;
    const rows = this.query({ region, id, from, to: now });
    const byTs = new Map();
    const byId = new Map();
    for (const r of rows) {
      if (!byTs.has(r.ts)) byTs.set(r.ts, []);
      byTs.get(r.ts).push({ id: r.id, cs: r.cs, lat: r.lat, lon: r.lon, alt: r.alt, hdg: r.hdg, vel: r.vel, c: r.c, n: r.n, s: r.s, k: r.k });
      if (!byId.has(r.id)) byId.set(r.id, { id: r.id, cs: r.cs, k: r.k, points: [] });
      const tr = byId.get(r.id);
      if (r.cs && !tr.cs) tr.cs = r.cs;
      tr.points.push([r.ts, r.lat, r.lon, r.alt, r.c]);
    }
    let frames = [...byTs.entries()].sort((a, b) => isoTs(a[0]) - isoTs(b[0])).map(([ts, contacts]) => ({ ts, contacts }));
    if (frames.length > MAX_FRAMES) frames = frames.slice(frames.length - MAX_FRAMES);
    const tracks = [...byId.values()].filter(t => t.points.length >= 2).sort((a, b) => b.points.length - a.points.length).slice(0, 400);
    const b = HOTSPOTS[region] || null;
    return {
      region, label: b?.label || region, box: b ? { lamin: b.lamin, lomin: b.lomin, lamax: b.lamax, lomax: b.lomax } : null,
      hours: h, from: new Date(from).toISOString(), to: new Date(now).toISOString(),
      resolution: 'one frame per sweep (~15 min); positions are the fix at sweep time, not a continuous track',
      sweeps: frames.length, contacts: byId.size, frames, tracks,
    };
  }

  stats(now = this.now()) {
    const rows = this._load();
    const regions = {};
    for (const r of rows) regions[r.r] = (regions[r.r] || 0) + 1;
    const sweeps = new Set(rows.map(r => r.ts)).size;
    return {
      rows: rows.length, sweeps, regions,
      oldest: rows.length ? rows[0].ts : null, newest: rows.length ? rows[rows.length - 1].ts : null,
      retentionHours: this.retentionMs / HOUR,
      coverageHours: rows.length ? Math.round((now - isoTs(rows[0].ts)) / HOUR * 10) / 10 : 0,
    };
  }
}
