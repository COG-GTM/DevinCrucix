// Follow the Money — service layer behind /api/finance/*. Fans a query out to the local ICIJ index, the local
// full-SDN index and the live keyed/keyless registries; screens a name; computes the SDN ∩ Offshore Leaks
// overlap list used as demo seeds; owns the trail store. Everything returns FtM-shaped records with a
// `source` stamp and nothing is ever merged across sources.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { openBest, OffshoreLeaks, DEFAULT_INDEX, SNAPSHOT_GZ, SNAPSHOT_INDEX } from './sources/offshoreleaks.mjs';
import { OfacIndex } from './sources/ofac.mjs';
import { opensanctionsScreen, opensanctionsSearch, opencorporatesSearch, gleifSearch } from './sources/live.mjs';
import { TrailStore } from './trails.mjs';
import { SOURCES, EVIDENCE_TIERS, recordCountries, parseIcijRef } from './ftm.mjs';
import { fold, scoreCandidate, matchBand } from './match.mjs';
import { gunzipFile } from '../../scripts/build-offshoreleaks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
export const SEEDS_FILE = join(ROOT, 'config/finance-seeds.json');
const OVERLAPS_FILE = join(ROOT, 'runs/finance/overlaps.json');

export const CLAIM_STATES = {
  reported: 'as published by the cited source (ICIJ relationship, registry filing, sanctions listing)',
  proposed: 'cross-source "possible same" candidate scored by name / country rules; awaiting analyst',
  accepted: 'analyst accepted the candidate as the same real-world entity',
  rejected: 'analyst rejected the candidate',
};

export class FinanceService {
  constructor({ indexFile = DEFAULT_INDEX, snapshotGz = SNAPSHOT_GZ, snapshotFile = SNAPSHOT_INDEX, ofacFile, trailsDir, seedsFile = SEEDS_FILE, overlapsFile = OVERLAPS_FILE, autoBuild = process.env.FINANCE_BUILD_ON_BOOT === '1' } = {}) {
    this.indexFile = indexFile; this.snapshotGz = snapshotGz; this.snapshotFile = snapshotFile; this.overlapsFile = overlapsFile;
    this.ofac = new OfacIndex(ofacFile ? { file: ofacFile } : {});
    this.trails = new TrailStore(trailsDir ? { dataDir: trailsDir } : {});
    this.seeds = readJsonSafe(seedsFile, { seeds: [] }).seeds || [];
    this.build = { status: 'idle', startedAt: null, finishedAt: null, error: null, log: [] };
    this.overlaps = readJsonSafe(overlapsFile, null);
    this.icij = null;
    this.ready = this.openIndex().then(() => { if (autoBuild && (!this.icij || this.icij.meta.mode !== 'full')) this.startBuild(); });
    // A full index copied onto the volume after boot (fly ssh sftp put …) is picked up without a restart.
    this.watch = setInterval(() => {
      if (this.icij?.meta.mode !== 'full' && existsSync(this.indexFile) && this.build.status !== 'running') {
        this.reopen(); if (this.icij?.meta.mode === 'full') { this.overlaps = null; this.computeOverlaps().catch(() => {}); }
      }
    }, 60_000); this.watch.unref?.();
  }

  async openIndex() {
    if (!existsSync(this.indexFile) && !existsSync(this.snapshotFile) && existsSync(this.snapshotGz)) {
      try { await gunzipFile(this.snapshotGz, this.snapshotFile); } catch (err) { console.warn('[finance] snapshot extract failed:', err.message); }
    }
    this.icij = openBest({ full: this.indexFile, snapshot: this.snapshotFile });
    if (this.icij) console.log(`[finance] Offshore Leaks index: ${this.icij.meta.mode} (${this.icij.file})`);
    else console.warn('[finance] no Offshore Leaks index available; run scripts/build-offshoreleaks.mjs --download');
    return this.icij;
  }

  /** Spawns the full bulk download + build as a child process; swaps the index in when it lands. */
  startBuild() {
    if (this.build.status === 'running') return this.build;
    this.build = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, log: [] };
    const child = spawn(process.execPath, [join(ROOT, 'scripts/build-offshoreleaks.mjs'), '--download', '--clean', '--out', this.indexFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', d => { const s = String(d).trim(); if (s && !/ExperimentalWarning|--trace-warnings/.test(s)) { this.build.log.push(s.slice(0, 200)); if (this.build.log.length > 30) this.build.log.shift(); } });
    child.on('exit', code => {
      this.build.finishedAt = new Date().toISOString();
      if (code === 0) { this.build.status = 'done'; this.reopen(); this.overlaps = null; this.computeOverlaps().catch(() => {}); }
      else { this.build.status = 'error'; this.build.error = `exit ${code}: ${this.build.log.slice(-2).join(' | ')}`; }
    });
    child.on('error', err => { this.build.status = 'error'; this.build.error = err.message; this.build.finishedAt = new Date().toISOString(); });
    return this.build;
  }
  reopen() { const prev = this.icij; this.icij = openBest({ full: this.indexFile, snapshot: this.snapshotFile }); if (prev && prev !== this.icij) setTimeout(() => prev.close(), 5000); }

  status() {
    const icij = this.icij ? this.icij.status() : { ok: false };
    return {
      ok: true, asOf: new Date().toISOString(),
      sources: Object.fromEntries(Object.values(SOURCES).map(s => [s.key, { ...s, state: this.sourceState(s.key) }])),
      tiers: EVIDENCE_TIERS, claimStates: CLAIM_STATES,
      icij: { ...icij, build: this.build, datasets: this.icij ? this.icij.datasets().slice(0, 20) : [] },
      ofac: this.ofac.status(),
      overlaps: this.overlaps ? { count: this.overlaps.leads.length, computedAt: this.overlaps.computedAt } : null,
      seeds: this.seeds.map(s => ({ names: s.names, ids: s.ids, why: s.why })),
      trails: this.trails.list().length,
      disclaimer: SOURCES.icij.disclaimer,
    };
  }
  sourceState(key) {
    if (key === 'icij') return this.icij ? (this.icij.meta.mode === 'full' ? 'live' : 'snapshot') : (this.build.status === 'running' ? 'building' : 'off');
    if (key === 'ofac') return this.ofac.index ? (this.ofac.stale() ? 'stale' : 'live') : 'off';
    if (key === 'opensanctions') return process.env.OPENSANCTIONS_API_KEY ? 'live' : 'no_key';
    if (key === 'opencorporates') return process.env.OPENCORPORATES_API_TOKEN ? 'live' : 'no_key';
    return 'live';
  }

  /** Beat 1: one query → ICIJ (local, fast) + live sanctions/registry fan-out in parallel, kept separate. */
  async search(q, { kind, juris, dataset, status, limit = 25, live = true } = {}) {
    const offshore = this.icij ? this.icij.search(q, { kind, juris, dataset, status, limit }) : { query: q, total: 0, results: [], unavailable: true };
    const ofac = this.ofac.screen(q, { limit: 8 });
    const [os, oc, lei] = live ? await Promise.all([opensanctionsSearch(q, { limit: 6 }), opencorporatesSearch(q, { limit: 6 }), gleifSearch(q, { limit: 6 })]) : [null, null, null];
    return { query: q, offshore, sanctions: { ofac, opensanctions: os }, registry: { opencorporates: oc, gleif: lei }, asOf: new Date().toISOString() };
  }

  /** Beat 2: profile = record + grouped relationships + same-address pivot + inline screening of the name. */
  async entity(ref) {
    const id = parseIcijRef(ref); if (!this.icij || id === null) return null;
    const record = this.icij.record(id, { degree: true }); if (!record) return null;
    const rel = this.icij.neighbors(id, { limit: 80 });
    const sameAddress = this.icij.sameAddress(id, { limit: 20 });
    const screening = this.screenRecord(record);
    return { record, relationships: rel, sameAddress, screening, asOf: new Date().toISOString() };
  }
  graph(ref, opts) { const id = parseIcijRef(ref); return this.icij && id !== null ? this.icij.graph(id, opts) : null; }

  /** Local-only OFAC screen of one record (fast; used inline on profiles and search results). */
  screenRecord(record) {
    const r = this.ofac.screen(record.caption, { countries: recordCountries(record), schema: record.schema === 'Company' ? 'Company' : record.schema === 'Person' ? 'Person' : null, limit: 5 });
    return { ofac: r };
  }

  /** Beat 3a: screen a name against OFAC (local) + OpenSanctions (live). */
  async screen(name, { countries = [], schema = null } = {}) {
    const [ofac, os] = await Promise.all([Promise.resolve(this.ofac.screen(name, { countries, schema, limit: 10 })), opensanctionsScreen(name, { schema, countries, limit: 8 })]);
    return { name, ofac, opensanctions: os, asOf: new Date().toISOString() };
  }
  /** Beat 3b: registry hops — OpenCorporates (keyed) + GLEIF (keyless). */
  async registry(name, { jurisdiction = null } = {}) {
    const [oc, lei] = await Promise.all([opencorporatesSearch(name, { jurisdiction, limit: 10 }), gleifSearch(name, { limit: 10 })]);
    return { name, opencorporates: oc, gleif: lei, asOf: new Date().toISOString() };
  }

  /**
   * SDN ∩ Offshore Leaks: every SDN name or alias whose folded form exactly matches an ICIJ node name.
   * Exact folded equality only (no fuzzy), so each lead is "same spelling", never "same entity".
   */
  async computeOverlaps({ force = false } = {}) {
    if (!this.icij || !this.ofac.index) return this.overlaps;
    const fresh = this.overlaps && this.overlaps.icijMode === this.icij.meta.mode && this.overlaps.icijBuiltAt === (this.icij.meta.builtAt || null) && this.overlaps.sdnPublishDate === this.ofac.index.publishDate;
    if (fresh && !force) return this.overlaps;
    const leads = []; const seen = new Set();
    for (const e of this.ofac.index.entries) {
      for (const n of [e.name, ...e.akas.map(a => a.name)]) {
        const f = fold(n); if (f.split(' ').length < 2 || f.length < 6) continue;
        for (const r of this.icij.q.fold.all(f, 3)) {
          if (r.kind === 'address') continue;
          const k = `${e.uid}|${r.id}`; if (seen.has(k)) continue; seen.add(k);
          const degree = this.icij.q.degree.get(r.id, r.id)?.d ?? 0;
          leads.push({ icij: { id: `icij:${r.id}`, name: r.name, kind: r.kind, jurisdiction: r.jurisdiction_description || null, dataset: r.source, degree }, ofac: { id: `ofac:${e.uid}`, name: e.name, type: e.type, programs: e.programs.slice(0, 4), via: n === e.name ? 'name' : `aka:${n}` }, matched: ['name:exact'], score: 1 });
        }
      }
    }
    leads.sort((a, b) => b.icij.degree - a.icij.degree);
    this.overlaps = { computedAt: new Date().toISOString(), icijMode: this.icij.meta.mode, icijBuiltAt: this.icij.meta.builtAt || null, sdnPublishDate: this.ofac.index.publishDate, leads: leads.slice(0, 500) };
    try { mkdirSync(dirname(this.overlapsFile), { recursive: true }); writeFileSync(this.overlapsFile, JSON.stringify(this.overlaps)); } catch { /* ephemeral */ }
    return this.overlaps;
  }

  /** Candidate links between two records for the trail builder (possible-same scoring). */
  /**
   * A "reported" link is a claim that the source itself asserts the relationship. Clients cannot mint those:
   * every reported link must be between two ICIJ records that the local index connects (direct edge or shared
   * registered address); anything else is downgraded to an analyst proposal and says so in its note.
   */
  verifyReported(links) {
    return links.map(l => {
      if (l.state !== 'reported') return l;
      const a = parseIcijRef(l.from), b = parseIcijRef(l.to);
      if (a && b && this.icij && this.icij.related(a, b)) return { ...l, source: { ...l.source, key: 'icij' } };
      const why = 'reported claim not found in the local ICIJ index — downgraded to an analyst proposal';
      return { ...l, state: 'proposed', source: { key: 'analyst', dataset: null }, note: l.note ? `${l.note} · ${why}`.slice(0, 300) : why };
    });
  }
  candidate(a, b) { const s = scoreCandidate({ name: a.caption, countries: recordCountries(a), schema: a.schema }, { name: b.caption, countries: recordCountries(b), schema: b.schema }); return { ...s, band: matchBand(s.score) }; }
}

function readJsonSafe(f, dflt) { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt; } catch { return dflt; } }
