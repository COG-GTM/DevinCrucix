// Target Development store — nominated targets, their developed packages and analyst decisions.
//
// Plain JSON under runs/targeting so the workbench needs no database. Every mutation appends a JSON audit
// line (nomination, development, link/graph decisions, exports, closure) so the targeting record is
// reconstructable: who-what-when for every claim that entered or left the package.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/targeting');
export const STORE_SCHEMA = 'crucix-targeting/1';

export const MAX_TARGETS = 60;
export const MAX_ALIASES = 12;
export const TARGET_TYPES = ['person', 'org', 'facility', 'vehicle', 'vessel', 'aircraft'];
export const BASIS_KINDS = ['kg-node', 'ofac-uid', 'doj-release', 'source-url'];
export const TARGET_STATUS = ['nominated', 'developed', 'closed'];
export const DECISIONS = ['accept', 'reject', 'reset'];

export const LABEL_RE = /^[A-Za-z\u00C0-\u017F0-9][A-Za-z\u00C0-\u017F0-9 .,'’"“”()/-]{1,79}$/;
export const KG_NODE_RE = /^(?:org|faction|person|place|country|topic):[a-z0-9-]{1,80}$/;
export const OFAC_UID_RE = /^\d{3,8}$/;
export const DOJ_RELEASE_RE = /^[a-f0-9]{16}$/;
export const TARGET_ID_RE = /^tgt_[a-f0-9]{12}$/;
export const LINK_ID_RE = /^lnk_[a-f0-9]{12}$/;
export const PROPOSAL_ID_RE = /^gp_[a-f0-9]{12}$/;

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}
export function sha(s) { return createHash('sha256').update(String(s)).digest('hex'); }

/** Validates a nomination body; returns { ok, value } or { ok:false, field }. Pure — no I/O. */
export function validateNomination(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' };
  const label = typeof body.label === 'string' ? body.label.replace(/\s+/g, ' ').trim() : '';
  if (!LABEL_RE.test(label)) return { ok: false, field: 'label' };
  const type = TARGET_TYPES.includes(body.type) ? body.type : null;
  if (!type) return { ok: false, field: 'type' };
  const aliasesIn = body.aliases === undefined ? [] : body.aliases;
  if (!Array.isArray(aliasesIn) || aliasesIn.length > MAX_ALIASES) return { ok: false, field: 'aliases' };
  const aliases = [];
  for (const a of aliasesIn) {
    if (typeof a !== 'string') return { ok: false, field: 'aliases' };
    const s = a.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (!LABEL_RE.test(s)) return { ok: false, field: 'aliases' };
    if (s.toLowerCase() !== label.toLowerCase() && !aliases.some(x => x.toLowerCase() === s.toLowerCase())) aliases.push(s);
  }
  const basis = body.basis;
  if (!basis || typeof basis !== 'object' || !BASIS_KINDS.includes(basis.kind) || typeof basis.ref !== 'string') return { ok: false, field: 'basis' };
  const ref = basis.ref.trim();
  const refOk = basis.kind === 'kg-node' ? KG_NODE_RE.test(ref)
    : basis.kind === 'ofac-uid' ? OFAC_UID_RE.test(ref)
      : basis.kind === 'doj-release' ? DOJ_RELEASE_RE.test(ref)
        : isPublicHttpsUrl(ref);
  if (!refOk) return { ok: false, field: 'basis.ref' };
  const requirement = typeof body.requirement === 'string' ? body.requirement.replace(/\s+/g, ' ').trim() : '';
  if (requirement.length < 8 || requirement.length > 400 || /[<>]/.test(requirement)) return { ok: false, field: 'requirement' };
  const priority = body.priority === undefined ? 2 : body.priority;
  if (![1, 2, 3].includes(priority)) return { ok: false, field: 'priority' };
  return { ok: true, value: { label, type, aliases, basis: { kind: basis.kind, ref }, requirement, priority } };
}

export function isPublicHttpsUrl(s) {
  if (typeof s !== 'string' || s.length > 400) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const h = u.hostname;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) || /^(localhost|.*\.local|.*\.internal)$/i.test(h)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
    return true;
  } catch { return false; }
}

export class TargetStore {
  constructor({ dataDir = DEFAULT_DATA_DIR, now = () => Date.now(), log = (line) => console.log(line) } = {}) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'targets.json');
    this.auditFile = join(dataDir, 'audit.jsonl');
    this.now = now;
    this.log = log;
    const raw = readJson(this.file, null);
    this.targets = raw && raw.schema === STORE_SCHEMA && Array.isArray(raw.targets) ? raw.targets : [];
  }

  save() {
    writeJson(this.file, { schema: STORE_SCHEMA, savedAt: new Date(this.now()).toISOString(), targets: this.targets.slice(0, MAX_TARGETS) });
  }

  audit(action, details = {}) {
    const rec = { ts: new Date(this.now()).toISOString(), component: 'targeting', action, ...details };
    const line = JSON.stringify(rec);
    try { mkdirSync(this.dataDir, { recursive: true }); appendFileSync(this.auditFile, line + '\n'); } catch { /* audit file is best-effort; the console line still lands */ }
    this.log(`[Audit] ${line}`);
    return rec;
  }

  list() { return this.targets.map(summarizeTarget); }
  get(id) { return this.targets.find(t => t.id === id) || null; }

  nominate(value, { actor = 'operator' } = {}) {
    if (this.targets.filter(t => t.status !== 'closed').length >= MAX_TARGETS) return { error: 'capacity' };
    const dup = this.targets.find(t => t.status !== 'closed' && t.basis.kind === value.basis.kind && t.basis.ref === value.basis.ref);
    if (dup) return { error: 'duplicate', target: dup };
    const ts = new Date(this.now()).toISOString();
    const target = {
      id: `tgt_${randomBytes(6).toString('hex')}`,
      schema: STORE_SCHEMA,
      ...value,
      status: 'nominated',
      nominatedBy: actor,
      createdAt: ts,
      updatedAt: ts,
      developedAt: null,
      package: null,
      decisions: {},
      graphProposals: [],
      exports: 0,
    };
    this.targets.unshift(target);
    this.save();
    this.audit('target.nominate', { targetId: target.id, label: target.label, type: target.type, basis: target.basis, actor });
    return { target };
  }

  setPackage(id, pkg, { actor = 'operator' } = {}) {
    const t = this.get(id);
    if (!t) return null;
    const ts = new Date(this.now()).toISOString();
    t.package = pkg;
    t.status = t.status === 'closed' ? 'closed' : 'developed';
    t.developedAt = ts;
    t.updatedAt = ts;
    // Prior analyst decisions survive re-development: links are keyed by stable ids.
    for (const l of pkg.links || []) { const d = t.decisions[l.id]; if (d) l.decision = d.decision; }
    t.graphProposals = reconcileProposals(t.graphProposals, pkg.graphProposals || [], ts);
    pkg.graphProposals = undefined;
    this.save();
    this.audit('target.develop', { targetId: id, actor, mentions: pkg.stats?.mentions ?? 0, links: (pkg.links || []).length, llm: pkg.llm?.used ? pkg.llm.model : 'rules' });
    return t;
  }

  decideLink(id, linkId, decision, { actor = 'operator' } = {}) {
    const t = this.get(id);
    if (!t || !t.package) return null;
    const link = (t.package.links || []).find(l => l.id === linkId);
    if (!link) return null;
    const ts = new Date(this.now()).toISOString();
    if (decision === 'reset') { delete t.decisions[linkId]; link.decision = null; }
    else { t.decisions[linkId] = { decision, at: ts, actor }; link.decision = decision; }
    // Graph proposals derived from the link follow the analyst's call on the link.
    for (const gp of t.graphProposals) {
      if (gp.linkId !== linkId) continue;
      gp.status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'proposed';
      gp.decidedAt = decision === 'reset' ? null : ts;
    }
    t.updatedAt = ts;
    this.save();
    this.audit('target.link.decide', { targetId: id, linkId, decision, actor, label: link.label, role: link.assessment?.role || null });
    return { target: t, link };
  }

  decideProposal(id, proposalId, decision, { actor = 'operator' } = {}) {
    const t = this.get(id);
    if (!t) return null;
    const gp = t.graphProposals.find(p => p.id === proposalId);
    if (!gp) return null;
    const ts = new Date(this.now()).toISOString();
    gp.status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'proposed';
    gp.decidedAt = decision === 'reset' ? null : ts;
    t.updatedAt = ts;
    this.save();
    this.audit('target.graph.decide', { targetId: id, proposalId, decision, actor, rel: gp.rel, source: gp.source, target: gp.target });
    return { target: t, proposal: gp };
  }

  close(id, { actor = 'operator' } = {}) {
    const t = this.get(id);
    if (!t) return null;
    t.status = 'closed';
    t.updatedAt = new Date(this.now()).toISOString();
    this.save();
    this.audit('target.close', { targetId: id, actor });
    return t;
  }

  remove(id, { actor = 'operator' } = {}) {
    const i = this.targets.findIndex(t => t.id === id);
    if (i < 0) return false;
    const [t] = this.targets.splice(i, 1);
    this.save();
    this.audit('target.delete', { targetId: id, label: t.label, actor });
    return true;
  }

  recordExport(id, format, { actor = 'operator' } = {}) {
    const t = this.get(id);
    if (!t) return null;
    t.exports = (t.exports || 0) + 1;
    this.save();
    this.audit('target.export', { targetId: id, format, actor });
    return t;
  }

  /** Accepted graph proposals across all targets — the analyst-approved overlay for the knowledge graph. */
  acceptedGraphOverlay() {
    const edges = [];
    for (const t of this.targets) for (const gp of t.graphProposals) if (gp.status === 'accepted') edges.push({ ...gp, targetId: t.id, targetLabel: t.label });
    return edges;
  }
}

function reconcileProposals(existing, fresh, ts) {
  const byId = new Map(existing.map(p => [p.id, p]));
  const out = [];
  for (const p of fresh) {
    const prev = byId.get(p.id);
    out.push(prev ? { ...p, status: prev.status, decidedAt: prev.decidedAt, firstProposedAt: prev.firstProposedAt } : { ...p, status: 'proposed', decidedAt: null, firstProposedAt: ts });
  }
  // Keep decided proposals even when the latest run no longer surfaces them, so decisions are never silently lost.
  for (const p of existing) if (!out.some(o => o.id === p.id) && p.status !== 'proposed') out.push({ ...p, stale: true });
  return out.slice(0, 200);
}

export function summarizeTarget(t) {
  const links = t.package?.links || [];
  const dec = Object.values(t.decisions || {});
  return {
    id: t.id, label: t.label, type: t.type, aliases: t.aliases, basis: t.basis, requirement: t.requirement, priority: t.priority,
    status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, developedAt: t.developedAt,
    stats: t.package ? {
      ...t.package.stats,
      links: links.length,
      pendingLinks: links.filter(l => !l.decision).length,
      accepted: dec.filter(d => d.decision === 'accept').length,
      rejected: dec.filter(d => d.decision === 'reject').length,
      proposals: t.graphProposals.length,
      acceptedProposals: t.graphProposals.filter(p => p.status === 'accepted').length,
      lastKnown: t.package.fix?.lastKnown ? { place: t.package.fix.lastKnown.place, date: t.package.fix.lastKnown.date, radiusKm: t.package.fix.lastKnown.radiusKm } : null,
      llm: t.package.llm?.used ? t.package.llm.model : null,
    } : null,
  };
}
