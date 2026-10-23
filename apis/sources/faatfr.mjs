// FAA Temporary Flight Restrictions (TFRs) — key-free.
//   list:   https://tfr.faa.gov/tfrapi/exportTfrList            (every active TFR, no geometry)
//   shapes: https://tfr.faa.gov/geoserver/TFR/ows  (WFS, TFR:V_TFR_LOC — polygons for TFRs that have one)
// The two are joined on the NOTAM id ("6/9169"); TFRs without a shape are reported but not drawn.
import { safeFetch } from '../utils/fetch.mjs';
import { orientGeometry } from '../../lib/map/geo.mjs';

export const TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';
export const TFR_WFS_URL = 'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=500&outputFormat=application/json&srsname=EPSG:4326';
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';

// Colour per legal basis (data colour, not chrome): VIP = presidential movement, SECURITY = 99.7
export const TFR_TYPES = {
  'VIP': { label: 'VIP movement', color: 'rgba(255,82,82,0.55)', stroke: 'rgba(255,82,82,0.95)' },
  'SECURITY': { label: 'Security (99.7)', color: 'rgba(255,152,0,0.5)', stroke: 'rgba(255,152,0,0.95)' },
  'HAZARDS': { label: 'Hazard (fire, rocket, disaster)', color: 'rgba(255,214,0,0.4)', stroke: 'rgba(255,214,0,0.9)' },
  'SPECIAL': { label: 'Special (99.7 special)', color: 'rgba(171,71,188,0.5)', stroke: 'rgba(171,71,188,0.95)' },
  'AIR SHOWS/SPORTS': { label: 'Air show / stadium (91.145)', color: 'rgba(66,165,245,0.45)', stroke: 'rgba(66,165,245,0.95)' },
  'UAS PUBLIC GATHERING': { label: 'UAS no-drone zone', color: 'rgba(120,144,156,0.45)', stroke: 'rgba(120,144,156,0.95)' },
  'SPACE OPERATIONS': { label: 'Space launch / re-entry', color: 'rgba(0,229,255,0.4)', stroke: 'rgba(0,229,255,0.9)' },
};
const typeMeta = (t) => TFR_TYPES[String(t || '').toUpperCase()] || { label: t || 'TFR', color: 'rgba(255,255,255,0.25)', stroke: 'rgba(255,255,255,0.7)' };

export const notamIdOf = (key) => String(key || '').split('-')[0].trim();

// Shapes + list → polygons (one per shape) and a list of TFRs without geometry.
export function normalizeTfrs(list = [], wfs = {}) {
  const byId = new Map();
  for (const t of Array.isArray(list) ? list : []) if (t?.notam_id) byId.set(String(t.notam_id), t);
  const polygons = [];
  const drawn = new Set();
  for (const f of wfs?.features || []) {
    const p = f?.properties || {};
    const id = notamIdOf(p.NOTAM_KEY);
    const g = f.geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const row = byId.get(id);
    const type = row?.type || p.LEGAL || '';
    const m = typeMeta(type);
    drawn.add(id);
    polygons.push({
      geometry: orientGeometry(g), fill: m.color, stroke: m.stroke,
      head: `TFR ${id} · ${m.label}`,
      text: row?.description || p.TITLE || '',
      meta: [p.STATE || row?.state, p.CNS_LOCATION_ID || row?.facility ? `ARTCC ${p.CNS_LOCATION_ID || row?.facility}` : '', row?.creation_date ? `issued ${row.creation_date}` : '', `https://tfr.faa.gov/tfr3/?page=detail_${id.replace('/', '_')}`].filter(Boolean).join(' · '),
      kind: 'tfr', type: String(type).toUpperCase(), id,
    });
  }
  const noShape = [...byId.values()].filter(t => !drawn.has(String(t.notam_id))).map(t => ({ id: t.notam_id, type: t.type, state: t.state, description: t.description }));
  const byType = {};
  for (const t of byId.values()) byType[t.type || 'OTHER'] = (byType[t.type || 'OTHER'] || 0) + 1;
  return { polygons, noShape, total: byId.size, byType };
}

export async function fetchTfrs({ fetchImpl = safeFetch } = {}) {
  const [list, wfs] = await Promise.all([
    fetchImpl(TFR_LIST_URL, { timeout: 20000, headers: { 'User-Agent': UA } }),
    fetchImpl(TFR_WFS_URL, { timeout: 30000, headers: { 'User-Agent': UA } }),
  ]);
  const notes = [];
  if (list?.error) notes.push(`TFR list: ${list.error}`);
  if (wfs?.error) notes.push(`TFR shapes: ${wfs.error}`);
  if (list?.error && wfs?.error) throw new Error(notes.join('; '));
  const out = normalizeTfrs(Array.isArray(list) ? list : [], wfs?.error ? {} : wfs);
  return { ...out, notes, partial: notes.length > 0 };
}
