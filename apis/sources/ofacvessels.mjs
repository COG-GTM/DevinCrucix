// OFAC SDN vessels — IMO / MMSI / name index of every sanctioned ship, refreshed daily from the
// SDN.CSV export (sanctionslistservice.ofac.treas.gov). Used by the tanker layer to flag hulls.
import { safeFetch } from '../utils/fetch.mjs';
import { parseCsv } from '../../lib/map/csv.mjs';

export const SDN_CSV_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';
const COLS = ['ent_num', 'name', 'type', 'program', 'title', 'call_sign', 'vess_type', 'tonnage', 'grt', 'flag', 'owner', 'remarks'];

export function parseSdnVessels(csvText) {
  // SDN.CSV has no header row; prepend one so parseCsv can key the columns.
  const rows = parseCsv(`${COLS.join(',')}\n${csvText}`);
  const byImo = new Map(), byMmsi = new Map(), byName = new Map();
  let total = 0;
  for (const r of rows) {
    if (String(r.type).toLowerCase() !== 'vessel') continue;
    total++;
    const remarks = r.remarks || '';
    const imo = remarks.match(/IMO\s+(\d{7})/i)?.[1] || null;
    const mmsi = remarks.match(/MMSI\s+(\d{9})/i)?.[1] || null;
    const v = { id: r.ent_num, name: r.name, program: r.program, vesselType: r.vess_type !== '-0- ' ? String(r.vess_type).trim() : '', flag: String(r.flag).trim(), owner: r.owner && !/^-0-/.test(r.owner) ? r.owner.trim() : '', imo, mmsi };
    if (imo) byImo.set(imo, v);
    if (mmsi) byMmsi.set(mmsi, v);
    if (v.name) byName.set(v.name.toUpperCase().replace(/\s+/g, ' ').trim(), v);
  }
  return { total, byImo, byMmsi, byName };
}

export class OfacVesselIndex {
  constructor({ fetchImpl = safeFetch, ttlMs = 24 * 3600_000 } = {}) { this.fetchImpl = fetchImpl; this.ttlMs = ttlMs; this.index = null; this.loadedAt = 0; this.loading = null; }
  async load() {
    if (this.index && Date.now() - this.loadedAt < this.ttlMs) return this.index;
    if (!this.loading) {
      this.loading = (async () => {
        const r = await this.fetchImpl(SDN_CSV_URL, { timeout: 60000, retries: 1 });
        if (r?.error) throw new Error(`OFAC SDN.CSV: ${r.error}`);
        const text = typeof r === 'string' ? r : r.rawText || '';
        this.index = parseSdnVessels(text); this.loadedAt = Date.now();
        return this.index;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }
  // Match by MMSI, then IMO, then exact name. Returns the SDN record or null.
  match({ mmsi, imo, name } = {}) {
    const i = this.index; if (!i) return null;
    return (mmsi && i.byMmsi.get(String(mmsi))) || (imo && i.byImo.get(String(imo))) || (name && i.byName.get(String(name).toUpperCase().replace(/\s+/g, ' ').trim())) || null;
  }
  get stats() { return { total: this.index?.total || 0, withImo: this.index?.byImo.size || 0, withMmsi: this.index?.byMmsi.size || 0, loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null }; }
}
