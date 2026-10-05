// lib/sitrep/store — the SITREP repository: one JSON per edition under runs/sitreps/, a bounded
// index for listing, SHA-256 over the rendered Markdown so an edition can be re-verified later.
// Synchronous fs like the other runs/ stores; editions are small (a few KB) and infrequent.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const ID_RE = /^sitrep-\d{8}-(am|pm|adhoc|weekly|monthly)(-\d{6})?$/;
export const KINDS = ['am', 'pm', 'adhoc', 'weekly', 'monthly'];
export const MAX_EDITIONS = 400;

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

function summarize(ed) {
  return {
    id: ed.id, edition: ed.edition, slotKey: ed.slotKey || null, generatedAt: ed.generatedAt, asOf: ed.asOf || null,
    dateKey: ed.dateKey || null, bluf: String(ed.bluf || '').slice(0, 280), sha256: ed.sha256 || null,
    llm: ed.llm?.used ? 'model' : 'rules', model: ed.model || null, words: ed.words ?? null,
    citations: Array.isArray(ed.citations) ? ed.citations.length : 0,
    external: ed.external ? { findings: Array.isArray(ed.external.findings) ? ed.external.findings.length : 0 } : null,
    sources: Array.isArray(ed.sources) ? ed.sources.length : undefined, window: ed.window ? { start: ed.window.start, end: ed.window.end } : undefined,
  };
}

export class SitrepStore {
  constructor({ dir }) {
    this.dir = dir;
    this.indexFile = join(dir, 'index.json');
    mkdirSync(dir, { recursive: true });
    this.index = this._loadIndex();
  }

  _loadIndex() {
    try {
      const j = JSON.parse(readFileSync(this.indexFile, 'utf8'));
      if (Array.isArray(j.editions)) return j.editions;
    } catch { /* rebuild below */ }
    const eds = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try { const ed = JSON.parse(readFileSync(join(this.dir, f), 'utf8')); if (ed?.id) eds.push(summarize(ed)); } catch { /* skip corrupt */ }
    }
    eds.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    return eds;
  }

  _writeIndex() {
    const tmp = this.indexFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), editions: this.index }, null, 1));
    renameSync(tmp, this.indexFile);
  }

  file(id) { return join(this.dir, `${id}.json`); }

  has(id) { return this.index.some(e => e.id === id); }
  hasSlot(slotKey) { return this.index.some(e => e.slotKey === slotKey); }

  save(ed) {
    if (!ed?.id || !/^[a-z0-9-]{8,48}$/.test(ed.id)) throw new Error('invalid edition id');
    writeFileSync(this.file(ed.id), JSON.stringify(ed, null, 1));
    this.index = [summarize(ed), ...this.index.filter(e => e.id !== ed.id)]
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    while (this.index.length > MAX_EDITIONS) {
      const old = this.index.pop();
      try { unlinkSync(this.file(old.id)); } catch { /* already gone */ }
    }
    this._writeIndex();
    return summarize(ed);
  }

  get(id) {
    if (!this.has(id) || !existsSync(this.file(id))) return null;
    try { return JSON.parse(readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  list({ limit = 60, kind = null, before = null } = {}) {
    let out = this.index;
    if (kind) out = out.filter(e => e.edition === kind);
    if (before) out = out.filter(e => String(e.generatedAt) < String(before));
    return out.slice(0, Math.max(1, Math.min(limit, MAX_EDITIONS)));
  }

  latest({ kinds = ['am', 'pm', 'adhoc'] } = {}) {
    const s = this.index.find(e => kinds.includes(e.edition));
    return s ? this.get(s.id) : null;
  }

  // The most recent daily edition generated before `beforeIso` — the baseline for "changes since".
  previous(beforeIso, { kinds = ['am', 'pm', 'adhoc'] } = {}) {
    const s = this.index.find(e => kinds.includes(e.edition) && (!beforeIso || String(e.generatedAt) < String(beforeIso)));
    return s ? this.get(s.id) : null;
  }

  // Full editions of the given kinds generated in [sinceIso, untilIso), oldest first — the raw material for an arc.
  range({ sinceIso, untilIso = null, kinds = ['am', 'pm', 'adhoc'], limit = MAX_EDITIONS } = {}) {
    const hits = this.index.filter(e => kinds.includes(e.edition) && (!sinceIso || String(e.generatedAt) >= String(sinceIso)) && (!untilIso || String(e.generatedAt) < String(untilIso)));
    return hits.slice(0, limit).map(e => this.get(e.id)).filter(Boolean).sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
  }

  verify(id) {
    const ed = this.get(id);
    if (!ed) return null;
    const actual = sha256(ed.markdown || '');
    return { id, stored: ed.sha256 || null, actual, ok: ed.sha256 === actual };
  }

  stats() {
    const by = {};
    for (const e of this.index) by[e.edition] = (by[e.edition] || 0) + 1;
    return { editions: this.index.length, byKind: by, newest: this.index[0]?.generatedAt || null, oldest: this.index[this.index.length - 1]?.generatedAt || null, max: MAX_EDITIONS };
  }
}
