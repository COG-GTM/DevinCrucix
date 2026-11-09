// FAA Special Use Airspace — permanent Prohibited (P-xx) and Restricted (R-xxxx) areas.
// Source: FAA ArcGIS open data (Special_Use_Airspace FeatureServer), key-free, paged at 2000.
// Static for months at a time, so the layer caches it for a day.
import { safeFetch } from '../utils/fetch.mjs';
import { orientGeometry } from '../../lib/map/geo.mjs';

export const SUA_BASE = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query';
export const SUA_TYPES = {
  P: { label: 'Prohibited area', color: 'rgba(244,67,54,0.45)', stroke: 'rgba(244,67,54,0.95)' },
  R: { label: 'Restricted area', color: 'rgba(255,167,38,0.22)', stroke: 'rgba(255,167,38,0.7)' },
};
const PAGE = 2000;

export function suaUrl(types = ['P', 'R'], offset = 0) {
  const where = `TYPE_CODE IN (${types.map(t => `'${t}'`).join(',')})`;
  const q = new URLSearchParams({
    where, outFields: 'NAME,TYPE_CODE,UPPER_DESC,LOWER_DESC,CITY,STATE,CONT_AGENT,TIMESOFUSE,REMARKS',
    f: 'geojson', resultOffset: String(offset), resultRecordCount: String(PAGE), geometryPrecision: '3', maxAllowableOffset: '0.005', orderByFields: 'OBJECTID',
  });
  return `${SUA_BASE}?${q}`;
}

export function normalizeSua(features = []) {
  const polygons = [];
  for (const f of features) {
    const p = f?.properties || {};
    const g = f?.geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const m = SUA_TYPES[p.TYPE_CODE]; if (!m) continue;
    const alt = [p.LOWER_DESC, p.UPPER_DESC].filter(Boolean).join(' – ');
    polygons.push({
      geometry: orientGeometry(g), fill: m.color, stroke: m.stroke,
      head: `${p.NAME || p.TYPE_CODE} · ${m.label}`,
      text: [alt && `Altitude ${alt}`, p.TIMESOFUSE && `Hours ${p.TIMESOFUSE}`].filter(Boolean).join(' · '),
      meta: [p.CITY && p.STATE ? `${p.CITY}, ${p.STATE}` : p.STATE, p.CONT_AGENT && `Controlling agency ${p.CONT_AGENT}`].filter(Boolean).join(' · '),
      kind: 'sua', type: p.TYPE_CODE, id: p.NAME,
    });
  }
  return polygons;
}

export async function fetchSua({ fetchImpl = safeFetch, types = ['P', 'R'], maxPages = 4 } = {}) {
  const features = [];
  for (let page = 0; page < maxPages; page++) {
    const d = await fetchImpl(suaUrl(types, page * PAGE), { timeout: 30000, retries: 1 });
    if (d?.error) { if (!features.length) throw new Error(`SUA: ${d.error}`); break; }
    features.push(...(d.features || []));
    if (!d.properties?.exceededTransferLimit && (d.features || []).length < PAGE) break;
  }
  return normalizeSua(features);
}
