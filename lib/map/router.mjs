// /api/map/<layer> — one route per map layer (dashboard/public/map-layers/*.js fetches these).
// Every layer answers with the same envelope so the map can show LIVE / STALE / DEGRADED / NO KEY:
//   { layer, status, fetchedAt, ageSec, ttlSec, source, notes: [], counts: {}, ...datasets }
// where datasets are the Globe.gl collections map.html understands (points, arcs, rings, labels,
// polygons, paths). `status`:
//   live      fresh upstream data
//   stale     upstream failed, serving the last good copy (notes[] says why)
//   degraded  partial data (one of several feeds failed, or a key-free fallback is in use)
//   no_key    the layer needs an API key that is not configured; only static context is returned
import { Router } from 'express';
import { validateQuery } from '../validate.mjs';

export const STATUSES = ['live', 'stale', 'degraded', 'no_key'];

export function envelope(layer, { status = 'live', fetchedAt = Date.now(), ttlMs = 0, source = '', notes = [], ...datasets } = {}) {
  const counts = {};
  for (const k of ['points', 'arcs', 'rings', 'labels', 'polygons', 'paths']) if (Array.isArray(datasets[k])) counts[k] = datasets[k].length;
  return {
    layer, status: STATUSES.includes(status) ? status : 'live',
    fetchedAt: new Date(fetchedAt).toISOString(), ageSec: Math.max(0, Math.round((Date.now() - fetchedAt) / 1000)),
    ttlSec: Math.round(ttlMs / 1000), source, notes: notes.filter(Boolean), counts, ...datasets,
  };
}

// layers: { [id]: { query?: validateQuery schema, handler(query) -> envelope-ish object } }
export function createMapRouter(layers) {
  const r = Router();
  r.get('/', (req, res) => res.json({ layers: Object.keys(layers) }));
  for (const [id, def] of Object.entries(layers)) {
    const mw = def.query ? [validateQuery(def.query)] : [];
    r.get(`/${id}`, ...mw, async (req, res) => {
      try {
        const out = await def.handler(req.validated?.query || {}, req);
        res.set('Cache-Control', 'no-store');
        res.json(out.layer ? out : envelope(id, out));
      } catch (err) {
        console.error(`[map/${id}]`, err?.message || err);
        res.status(502).json({ layer: id, error: 'upstream unavailable', detail: String(err?.message || err).slice(0, 200) });
      }
    });
  }
  r.use((req, res) => res.status(404).json({ error: 'not found' }));
  return r;
}
