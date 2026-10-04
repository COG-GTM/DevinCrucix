// Query layer over the local ICIJ Offshore Leaks index (see scripts/build-offshoreleaks.mjs). Read-only,
// bounded: every query has a LIMIT and the graph walk caps fan-out per node so a hub like "Mossack Fonseca"
// (hundreds of thousands of edges) cannot pin the 2 GB machine.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SCHEMA, roleGroup } from '../schema.mjs';
import { fold } from '../match.mjs';
import { icijRecord, icijLink, icijRef } from '../ftm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INDEX = join(__dirname, '../../../runs/finance/offshoreleaks.sqlite');
export const SNAPSHOT_GZ = join(__dirname, '../../../config/offshoreleaks-demo-snapshot.sqlite.gz');
export const SNAPSHOT_INDEX = join(__dirname, '../../../runs/finance/offshoreleaks-demo.sqlite');

export const MAX_SEARCH = 50;
export const MAX_FAN = 60;        // neighbours per node per hop in graph walks
export const MAX_GRAPH_NODES = 220;

const KIND_FILTER = { entity: ['entity'], company: ['entity'], officer: ['officer'], person: ['officer'], intermediary: ['intermediary'], address: ['address'], other: ['other'] };

export class OffshoreLeaks {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file, { readOnly: true });
    this.db.exec('PRAGMA cache_size=-32768; PRAGMA mmap_size=268435456; PRAGMA query_only=1;');
    this.meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, parseMeta(r.value)]));
    if (this.meta.schema !== SCHEMA) throw new Error(`index schema ${this.meta.schema} != ${SCHEMA}`);
    this.q = {
      node: this.db.prepare('SELECT * FROM nodes WHERE id = ?'),
      fts: this.db.prepare(`SELECT n.*, bm25(nodes_fts, 10.0, 1.0) AS rank FROM nodes_fts f JOIN nodes n ON n.id = f.rowid WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?`),
      fold: this.db.prepare('SELECT *, 0 AS rank FROM nodes WHERE name_fold = ? LIMIT ?'),
      foldPrefix: this.db.prepare("SELECT *, 1 AS rank FROM nodes WHERE name_fold >= ? AND name_fold < ? LIMIT ?"),
      out: this.db.prepare('SELECT * FROM edges WHERE src = ? LIMIT ?'),
      inn: this.db.prepare('SELECT * FROM edges WHERE dst = ? LIMIT ?'),
      degree: this.db.prepare('SELECT (SELECT count(*) FROM edges WHERE src = ?) + (SELECT count(*) FROM edges WHERE dst = ?) AS d'),
      sameAddress: this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? AND e.rel = 'registered_address' AND e.src != ? LIMIT ?`),
      addressOf: this.db.prepare(`SELECT e.dst AS id FROM edges e WHERE e.src = ? AND e.rel = 'registered_address' LIMIT 5`),
      sources: this.db.prepare('SELECT source, count(*) AS n FROM nodes GROUP BY source ORDER BY n DESC'),
      kinds: this.db.prepare('SELECT kind, count(*) AS n FROM nodes GROUP BY kind'),
    };
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  status() {
    const counts = this.meta.counts || {};
    return {
      ok: true, mode: this.meta.mode || 'full', schema: this.meta.schema, file: this.file, bytes: safeSize(this.file),
      release: this.meta.release || null, builtAt: this.meta.builtAt || null, counts,
      nodes: Object.values(counts).filter((v, i, a) => Object.keys(counts)[i] !== 'edges' && Object.keys(counts)[i] !== 'seeds').reduce((s, v) => s + (Number(v) || 0), 0),
      edges: counts.edges || null, fullCounts: this.meta.fullCounts || null,
    };
  }
  datasets() { return this.q.sources.all().map(r => ({ dataset: r.source, n: r.n })); }
  kindCounts() { return Object.fromEntries(this.q.kinds.all().map(r => [r.kind, r.n])); }

  record(id, extra) { const row = this.q.node.get(Number(id)); return row ? decorate(icijRecord(row, this.meta), row, this, extra) : null; }

  /**
   * Search by name / address. Exact folded-name hits first, then FTS5 prefix matching (bm25, names weighted
   * over addresses). Filters: kind, jurisdiction code, dataset substring, status substring.
   */
  search(query, { kind = null, juris = null, dataset = null, status = null, limit = 25 } = {}) {
    const q = String(query || '').trim();
    const lim = Math.max(1, Math.min(MAX_SEARCH, Number(limit) || 25));
    if (q.length < 2) return { query: q, total: 0, results: [] };
    const seen = new Set(); const rows = [];
    const kinds = kind ? KIND_FILTER[kind] || null : null;
    const accept = r => {
      if (seen.has(r.id)) return false;
      if (kinds && !kinds.includes(r.kind)) return false;
      if (juris && String(r.jurisdiction || '').toLowerCase() !== String(juris).toLowerCase() && !(r.country_codes || '').toLowerCase().split(';').includes(String(juris).toLowerCase())) return false;
      if (dataset && !String(r.source || '').toLowerCase().includes(String(dataset).toLowerCase())) return false;
      if (status && !String(r.status || '').toLowerCase().includes(String(status).toLowerCase())) return false;
      seen.add(r.id); rows.push(r); return true;
    };
    const f = fold(q);
    const fetchN = lim * 4;
    if (f) for (const r of this.q.fold.all(f, fetchN)) accept(r);
    if (rows.length < lim) { const m = ftsQuery(q); if (m) { try { for (const r of this.q.fts.all(m, fetchN)) { if (rows.length >= lim) break; accept(r); } } catch { /* bad token */ } } }
    if (rows.length < lim && f.length >= 3) for (const r of this.q.foldPrefix.all(f, f + '\uffff', fetchN)) { if (rows.length >= lim) break; accept(r); }
    const results = rows.slice(0, lim).map(r => decorate(icijRecord(r, this.meta), r, this, { degree: true }));
    return { query: q, total: results.length, truncated: rows.length >= lim, results };
  }

  /** Direct relationships for one node, grouped by role, each endpoint included as a record. */
  neighbors(id, { limit = MAX_FAN } = {}) {
    const nid = Number(id); const lim = Math.max(1, Math.min(300, Number(limit) || MAX_FAN));
    const edges = [...this.q.out.all(nid, lim), ...this.q.inn.all(nid, lim)];
    const links = [], nodes = new Map();
    for (const e of edges) {
      const other = e.src === nid ? e.dst : e.src;
      if (!nodes.has(other)) { const row = this.q.node.get(other); if (!row) continue; nodes.set(other, decorate(icijRecord(row, this.meta), row, this)); }
      links.push(icijLink(e));
    }
    const degree = this.q.degree.get(nid, nid)?.d ?? links.length;
    const byRole = {};
    for (const l of links) (byRole[l.role] ||= []).push(l);
    return { id: icijRef(nid), degree, truncated: degree > links.length, links, byRole, nodes: [...nodes.values()] };
  }

  /** Other nodes registered at the same address(es) as `id` (the classic shell-company pivot). */
  sameAddress(id, { limit = 25 } = {}) {
    const nid = Number(id); const out = [];
    for (const a of this.q.addressOf.all(nid)) for (const r of this.q.sameAddress.all(a.id, nid, limit)) out.push({ via: icijRef(a.id), record: decorate(icijRecord(r, this.meta), r, this) });
    return out.slice(0, limit);
  }

  /** Bounded breadth-first graph around `id` (depth 1–2), with identity-only edges optional. */
  graph(id, { depth = 2, fan = 25, maxNodes = MAX_GRAPH_NODES, identity = false } = {}) {
    const root = Number(id); const d = Math.max(1, Math.min(2, Number(depth) || 2));
    const f = Math.max(3, Math.min(MAX_FAN, Number(fan) || 25)); const cap = Math.max(10, Math.min(MAX_GRAPH_NODES, Number(maxNodes) || MAX_GRAPH_NODES));
    const nodes = new Map(); const links = new Map();
    const rootRow = this.q.node.get(root); if (!rootRow) return null;
    nodes.set(root, decorate(icijRecord(rootRow, this.meta), rootRow, this, { degree: true }));
    let frontier = [root]; let truncated = false;
    for (let h = 0; h < d && frontier.length && nodes.size < cap; h++) {
      const next = [];
      for (const nid of frontier) {
        const edges = [...this.q.out.all(nid, f * 2), ...this.q.inn.all(nid, f * 2)];
        let used = 0;
        for (const e of edges) {
          if (!identity && roleGroup(e.rel, e.link) === 'identity') continue;
          if (used >= f) { truncated = true; break; }
          const other = e.src === nid ? e.dst : e.src;
          if (!nodes.has(other)) {
            if (nodes.size >= cap) { truncated = true; break; }
            const row = this.q.node.get(other); if (!row) continue;
            nodes.set(other, decorate(icijRecord(row, this.meta), row, this)); next.push(other);
          }
          const l = icijLink(e); if (!links.has(l.id)) links.set(l.id, l); used++;
        }
      }
      frontier = next;
    }
    // Close the graph: edges among already-included nodes (same-address siblings etc.), bounded.
    for (const nid of [...nodes.keys()].slice(0, 80)) for (const e of this.q.out.all(nid, 200)) if (nodes.has(e.dst)) { const l = icijLink(e); if (!identity && l.role === 'identity') continue; if (!links.has(l.id)) links.set(l.id, l); }
    return { root: icijRef(root), depth: d, truncated, nodes: [...nodes.values()], links: [...links.values()] };
  }
}

function decorate(rec, row, idx, extra = {}) {
  if (extra.degree) rec.degree = idx.q.degree.get(row.id, row.id)?.d ?? 0;
  return rec;
}
function parseMeta(v) { try { return JSON.parse(v); } catch { return v; } }
function safeSize(f) { try { return statSync(f).size; } catch { return null; } }

/** Build an FTS5 prefix query from free text: each token quoted, trailing token a prefix. */
export function ftsQuery(q) {
  const toks = fold(q).split(' ').filter(Boolean).slice(0, 8);
  if (!toks.length) return null;
  return toks.map((t, i) => `"${t}"${i === toks.length - 1 && t.length >= 2 ? '*' : ''}`).join(' ');
}

/** Opens the best available index: full index on the volume, else the extracted demo snapshot, else null. */
export function openBest({ full = DEFAULT_INDEX, snapshot = SNAPSHOT_INDEX } = {}) {
  for (const f of [full, snapshot]) {
    if (!existsSync(f)) continue;
    try { return new OffshoreLeaks(f); } catch (err) { console.warn(`[finance] index ${f} unusable: ${err.message}`); }
  }
  return null;
}
