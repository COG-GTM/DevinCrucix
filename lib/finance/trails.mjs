// Money-trail store — analyst-built paths across ICIJ, OFAC, OpenSanctions, OpenCorporates and GLEIF records.
//
// Plain JSON under runs/finance/trails (same shape of persistence as lib/targeting/store.mjs). Records from
// different sources are never merged: a trail holds the records as-is plus typed links between them. Links
// carry a claim state (reported | proposed | accepted | rejected) so cross-source "possible same" candidates
// stay proposals until an analyst decides; every mutation appends an audit line.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/finance/trails');
export const STORE_SCHEMA = 'crucix-finance-trail/1';
export const MAX_TRAILS = 100;
export const MAX_NODES = 80;
export const MAX_LINKS = 200;
export const TRAIL_ID_RE = /^trl_[a-f0-9]{12}$/;
export const LINK_ID_RE = /^tl_[a-f0-9]{12}$/;
export const RECORD_ID_RE = /^(icij:\d{1,12}|ofac:\d{1,10}|os:[A-Za-z0-9._:-]{1,120}|oc:[a-z_]{2,10}\/[A-Za-z0-9._-]{1,40}|lei:[A-Z0-9]{20}|manual:[a-z0-9-]{1,60})$/;
export const LINK_STATES = ['reported', 'proposed', 'accepted', 'rejected'];
export const DECISIONS = ['accept', 'reject', 'reset'];
export const TITLE_RE = /^[^\x00-\x1f]{2,120}$/;

function readJson(file, fallback) { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(file, data) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data)); }
const newId = p => `${p}_${randomBytes(6).toString('hex')}`;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Validates a trail body (create or replace). Pure. Returns { ok, value } or { ok:false, field }. */
export function validateTrail(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' };
  const title = clip(body.title, 120);
  if (!TITLE_RE.test(title)) return { ok: false, field: 'title' };
  const notes = body.notes === undefined ? '' : clip(body.notes, 2000);
  if (!Array.isArray(body.nodes) || body.nodes.length < 1 || body.nodes.length > MAX_NODES) return { ok: false, field: 'nodes' };
  const nodes = []; const ids = new Set();
  for (const n of body.nodes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !RECORD_ID_RE.test(n.id)) return { ok: false, field: 'nodes' };
    if (ids.has(n.id)) continue; ids.add(n.id);
    const caption = clip(n.caption, 160); if (!caption) return { ok: false, field: 'nodes' };
    const schema = clip(n.schema, 30) || 'LegalEntity';
    const source = n.source && typeof n.source === 'object' ? { key: clip(n.source.key, 20), tier: clip(n.source.tier, 20), dataset: clip(n.source.dataset, 80) || null, url: safeUrl(n.source.url), license: clip(n.source.license, 80) || null, retrievedAt: clip(n.source.retrievedAt, 40) || null } : { key: n.id.split(':')[0], tier: null, dataset: null, url: null, license: null, retrievedAt: null };
    const props = n.properties && typeof n.properties === 'object' && !Array.isArray(n.properties) ? pickProps(n.properties) : {};
    nodes.push({ id: n.id, caption, schema, properties: props, source });
  }
  const links = []; const linkIds = new Set();
  const linksIn = body.links === undefined ? [] : body.links;
  if (!Array.isArray(linksIn) || linksIn.length > MAX_LINKS) return { ok: false, field: 'links' };
  for (const l of linksIn) {
    if (!l || typeof l !== 'object' || !ids.has(l.from) || !ids.has(l.to) || l.from === l.to) return { ok: false, field: 'links' };
    const id = typeof l.id === 'string' && LINK_ID_RE.test(l.id) ? l.id : newId('tl');
    if (linkIds.has(id)) continue; linkIds.add(id);
    const state = LINK_STATES.includes(l.state) ? l.state : 'proposed';
    const score = l.score === undefined || l.score === null ? null : Number(l.score);
    if (score !== null && !(score >= 0 && score <= 1)) return { ok: false, field: 'links' };
    links.push({
      id, from: l.from, to: l.to, label: clip(l.label, 80) || 'related to', role: clip(l.role, 20) || 'other', state, score,
      matched: Array.isArray(l.matched) ? l.matched.slice(0, 10).map(m => clip(m, 60)).filter(Boolean) : [],
      source: l.source && typeof l.source === 'object' ? { key: clip(l.source.key, 20) || 'analyst', dataset: clip(l.source.dataset, 80) || null } : { key: 'analyst', dataset: null },
      note: clip(l.note, 300) || null, decidedAt: null,
    });
  }
  return { ok: true, value: { title, notes, nodes, links } };
}
/** decidedAt is server-owned: kept when a decided link is unchanged or re-submitted as proposed, set when a new decision arrives. */
function stampDecisions(links, prev = new Map()) {
  const now = new Date().toISOString();
  return links.map(l => {
    const p = prev.get(l.id);
    if (p && p.state !== 'proposed' && l.state === 'proposed') return { ...l, state: p.state, decidedAt: p.decidedAt };
    if (l.state === 'proposed' || l.state === 'reported') return { ...l, decidedAt: null };
    return { ...l, decidedAt: p && p.state === l.state ? p.decidedAt : now };
  });
}
function pickProps(p) {
  const out = {};
  for (const [k, v] of Object.entries(p).slice(0, 30)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) continue;
    const arr = (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' || typeof x === 'number').map(x => clip(x, 300)).filter(Boolean).slice(0, 12);
    if (arr.length) out[k] = arr;
  }
  return out;
}
function safeUrl(u) { const s = String(u || ''); return /^https?:\/\/[^\s"'<>]{1,500}$/i.test(s) ? s : null; }

export class TrailStore {
  constructor({ dataDir = DEFAULT_DATA_DIR } = {}) { this.dataDir = dataDir; this.auditFile = join(dataDir, 'audit.jsonl'); }
  file(id) { return join(this.dataDir, `${id}.json`); }
  audit(event, details = {}) {
    try { mkdirSync(this.dataDir, { recursive: true }); appendFileSync(this.auditFile, JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + '\n'); } catch { /* audit must never break the request */ }
  }
  list() {
    if (!existsSync(this.dataDir)) return [];
    return readdirSync(this.dataDir).filter(f => /^trl_[a-f0-9]{12}\.json$/.test(f)).map(f => readJson(join(this.dataDir, f), null)).filter(t => t && t.schema === STORE_SCHEMA)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, nodes: t.nodes.length, links: t.links.length, sources: [...new Set(t.nodes.map(n => n.source?.key).filter(Boolean))], pending: t.links.filter(l => l.state === 'proposed').length, nominatedTarget: t.nominatedTarget || null }));
  }
  get(id) { return TRAIL_ID_RE.test(id) ? readJson(this.file(id), null) : null; }
  create(value, actor = {}) {
    if (this.list().length >= MAX_TRAILS) return { ok: false, error: 'trail limit reached' };
    const now = new Date().toISOString();
    const trail = { schema: STORE_SCHEMA, id: newId('trl'), createdAt: now, updatedAt: now, ...value, links: stampDecisions(value.links), nominatedTarget: null, exports: 0 };
    writeJson(this.file(trail.id), trail);
    this.audit('trail_created', { id: trail.id, title: trail.title, nodes: trail.nodes.length, links: trail.links.length, ...actor });
    return { ok: true, trail };
  }
  replace(id, value, actor = {}) {
    const cur = this.get(id); if (!cur) return { ok: false, error: 'not found' };
    // Preserve analyst decisions on links that survive the update (same id).
    const prev = new Map(cur.links.map(l => [l.id, l]));
    const links = stampDecisions(value.links, prev);
    const trail = { ...cur, ...value, links, updatedAt: new Date().toISOString() };
    writeJson(this.file(id), trail);
    this.audit('trail_updated', { id, nodes: trail.nodes.length, links: trail.links.length, ...actor });
    return { ok: true, trail };
  }
  remove(id, actor = {}) {
    const cur = this.get(id); if (!cur) return { ok: false, error: 'not found' };
    rmSync(this.file(id), { force: true }); this.audit('trail_deleted', { id, ...actor }); return { ok: true };
  }
  decide(id, linkId, decision, actor = {}) {
    const cur = this.get(id); if (!cur) return { ok: false, error: 'not found' };
    const link = cur.links.find(l => l.id === linkId); if (!link) return { ok: false, error: 'link not found' };
    if (!DECISIONS.includes(decision)) return { ok: false, error: 'bad decision' };
    if (link.state === 'reported' && decision !== 'reset') return { ok: false, error: 'reported links are source facts; add a note instead of adjudicating them' };
    link.state = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'proposed';
    link.decidedAt = decision === 'reset' ? null : new Date().toISOString();
    cur.updatedAt = new Date().toISOString();
    writeJson(this.file(id), cur);
    this.audit('trail_link_decision', { id, linkId, decision, from: link.from, to: link.to, score: link.score, ...actor });
    return { ok: true, trail: cur, link };
  }
  setNominated(id, target, actor = {}) {
    const cur = this.get(id); if (!cur) return { ok: false, error: 'not found' };
    cur.nominatedTarget = target; cur.updatedAt = new Date().toISOString(); writeJson(this.file(id), cur);
    this.audit('trail_nominated', { id, target: target?.id || null, ...actor });
    return { ok: true, trail: cur };
  }
  /**
   * License-aware export: ICIJ (ODbL), OFAC (public domain) and GLEIF (CC0) records are exported in full;
   * OpenSanctions (CC BY-NC) and OpenCorporates (terms) are exported as reference + URL only.
   */
  exportJson(id, actor = {}) {
    const cur = this.get(id); if (!cur) return null;
    cur.exports = (cur.exports || 0) + 1; writeJson(this.file(id), cur);
    this.audit('trail_exported', { id, ...actor });
    const FULL = new Set(['icij', 'ofac', 'gleif', 'manual']);
    const nodes = cur.nodes.map(n => FULL.has(n.source?.key) ? n : { id: n.id, caption: n.caption, schema: n.schema, source: { ...n.source, note: 'record body withheld under source terms; follow url' } });
    return {
      schema: 'crucix-finance-trail-export/1', exportedAt: new Date().toISOString(), id: cur.id, title: cur.title, notes: cur.notes, createdAt: cur.createdAt, updatedAt: cur.updatedAt,
      disclaimer: 'Leads, not verdicts. Records from different sources are not merged; "possible same" links are analyst-adjudicated proposals with transparent scores. There are legitimate uses for offshore companies and trusts; inclusion in the ICIJ Offshore Leaks Database does not suggest or imply illegal or improper conduct.',
      attribution: ['International Consortium of Investigative Journalists (ICIJ) Offshore Leaks Database, ODbL.', 'US Treasury OFAC SDN list (public domain).', 'GLEIF LEI data (CC0).'],
      nodes, links: cur.links, nominatedTarget: cur.nominatedTarget || null,
    };
  }
}
