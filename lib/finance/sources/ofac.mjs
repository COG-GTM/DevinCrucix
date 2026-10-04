// Full OFAC SDN name index for screening (every program, not just the narco/TCO slice kept by
// apis/sources/ofacnarco.mjs). Same bulk-download pattern: SDN.XML (~30 MB) → compact JSON under
// runs/finance, refreshed at most once per OFAC_REFRESH_HOURS and only when Last-Modified moved.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SDN_XML_URL } from '../../../apis/sources/ofacnarco.mjs';
import { fold, foldCompany, scoreCandidate, matchBand } from '../match.mjs';
import { ofacRecord } from '../ftm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FILE = join(__dirname, '../../../runs/finance/ofac-sdn.json');
export const INDEX_SCHEMA = 'crucix-finance-ofac/1';
const REFRESH_MS = Math.max(1, Number(process.env.OFAC_REFRESH_HOURS) || 12) * 3600_000;
const MAX_XML_BYTES = 120 * 1024 * 1024;

const unesc = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const tag = (xml, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml); return m ? unesc(m[1]).trim() : ''; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map(m => unesc(m[1]).trim()).filter(Boolean);
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);
const displayName = (first, last) => [first, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

export function parseEntry(xml) {
  const head = xml.split('<akaList>')[0];
  const name = displayName(tag(head, 'firstName'), tag(head, 'lastName'));
  if (!name) return null;
  const akas = blocks(blocks(xml, 'akaList')[0] || '', 'aka').map(a => ({ name: displayName(tag(a, 'firstName'), tag(a, 'lastName')), category: tag(a, 'category') || 'weak' })).filter(a => a.name).slice(0, 30);
  const countries = [...new Set([...blocks(xml, 'address').map(a => tag(a, 'country')), ...blocks(xml, 'nationality').map(n => tag(n, 'country')), ...blocks(xml, 'citizenship').map(n => tag(n, 'country'))].filter(Boolean))].sort();
  return {
    uid: Number(tag(xml, 'uid')) || null, name, type: tag(xml, 'sdnType') || 'Unknown',
    programs: tags(blocks(xml, 'programList')[0] || '', 'program'), akas, countries,
    remarks: tag(xml, 'remarks').slice(0, 400) || null,
  };
}

export function parseSdn(xml) {
  if (xml.length > MAX_XML_BYTES) throw new Error('SDN.XML too large');
  const publish = tag(blocks(xml, 'publshInformation')[0] || '', 'Publish_Date') || null;
  const entries = [];
  for (const b of blocks(xml, 'sdnEntry')) { const e = parseEntry(b); if (e) entries.push(e); }
  return { schema: INDEX_SCHEMA, publishDate: publish, fetchedAt: new Date().toISOString(), count: entries.length, entries };
}

export class OfacIndex {
  constructor({ file = DEFAULT_FILE, fetchImpl = fetch } = {}) {
    this.file = file; this.fetchImpl = fetchImpl; this.index = null; this.refresh = { status: 'pending', lastAttempt: null, lastSuccess: null, error: null, inProgress: false };
    this.load();
  }
  load() {
    try { if (existsSync(this.file)) { const j = JSON.parse(readFileSync(this.file, 'utf8')); if (j?.schema === INDEX_SCHEMA && Array.isArray(j.entries)) { this.index = j; this.refresh.lastSuccess = j.fetchedAt; this.refresh.status = 'cached'; this.prepare(); } } } catch { this.index = null; }
  }
  prepare() {
    this.folded = this.index.entries.map(e => ({ e, names: [fold(e.name), ...e.akas.map(a => fold(a.name))].filter(Boolean), cores: [foldCompany(e.name), ...e.akas.map(a => foldCompany(a.name))].filter(Boolean) }));
  }
  stale() { return !this.index || Date.now() - new Date(this.index.fetchedAt).getTime() > REFRESH_MS; }
  status() {
    return { ok: !!this.index, publishDate: this.index?.publishDate || null, fetchedAt: this.index?.fetchedAt || null, count: this.index?.count || 0, refresh: { ...this.refresh }, stale: this.stale() };
  }
  /** Downloads + rebuilds when stale. Never throws; records the error on refresh state. */
  async ensureFresh({ force = false } = {}) {
    if (this.refresh.inProgress || (!force && !this.stale())) return this.status();
    this.refresh.inProgress = true; this.refresh.lastAttempt = new Date().toISOString();
    try {
      const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 120_000);
      let xml;
      try {
        const res = await this.fetchImpl(SDN_XML_URL, { signal: controller.signal, headers: { 'User-Agent': 'Crucix/1.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        xml = await res.text();
      } finally { clearTimeout(t); }
      const idx = parseSdn(xml);
      if (idx.count < 1000) throw new Error(`implausible SDN entry count ${idx.count}`);
      mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(idx));
      this.index = idx; this.prepare(); this.refresh.status = 'live'; this.refresh.lastSuccess = idx.fetchedAt; this.refresh.error = null;
    } catch (err) { this.refresh.status = this.index ? 'stale' : 'error'; this.refresh.error = err.message; }
    finally { this.refresh.inProgress = false; }
    return this.status();
  }
  /** Scored screening of one name. Returns candidates ≥ 0.5 with band + matched fields, strongest first. */
  screen(name, { countries = [], schema = null, limit = 10 } = {}) {
    if (!this.index) return { status: 'unavailable', hits: [] };
    const subject = { name, countries, schema };
    const f = fold(name), core = foldCompany(name);
    if (f.length < 3) return { status: 'ok', hits: [] };
    const toks = new Set(f.split(' ').filter(t => t.length > 2));
    const hits = [];
    for (const { e, names, cores } of this.folded) {
      // Cheap pre-filter: share a ≥3-char token or an exact core before paying for full scoring.
      if (!names.some(n => n === f) && !cores.some(c => c === core) && !names.some(n => { for (const t of toks) if (n.includes(t)) return true; return false; })) continue;
      let best = { score: 0, matched: [] };
      const cands = [e.name, ...e.akas.map(a => a.name)];
      for (const c of cands) { const s = scoreCandidate(subject, { name: c, countries: e.countries, schema: /individual/i.test(e.type) ? 'Person' : 'Company' }); if (s.score > best.score) best = { ...s, via: c === e.name ? 'name' : `aka:${c}` }; }
      if (best.score >= 0.5) hits.push({ ...best, band: matchBand(best.score), record: ofacRecord(e) });
    }
    hits.sort((a, b) => b.score - a.score);
    return { status: 'ok', total: hits.length, hits: hits.slice(0, limit) };
  }
}
