// Cartel / faction gazetteer — alias matching for narco event extraction (config/cartel-groups.json).

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fold } from './gazetteer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GROUPS_FILE = join(__dirname, '../../config/cartel-groups.json');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

let _cache = null;

export function loadGroups(file = DEFAULT_GROUPS_FILE) {
  if (_cache && _cache.file === file) return _cache.idx;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const idx = buildGroupIndex(raw);
  _cache = { file, idx };
  return idx;
}

export function buildGroupIndex(raw) {
  const groups = raw.groups.map(g => ({ ...g, aliases: (g.aliases || []).map(fold).filter(Boolean) }));
  const byId = new Map(groups.map(g => [g.id, g]));
  for (const g of groups) if (g.parent && !byId.has(g.parent)) throw new Error(`group ${g.id}: unknown parent ${g.parent}`);
  const aliasKey = new Map();
  for (const g of groups) for (const a of g.aliases) {
    if (aliasKey.has(a) && aliasKey.get(a).id !== g.id) throw new Error(`alias "${a}" claimed by ${aliasKey.get(a).id} and ${g.id}`);
    aliasKey.set(a, g);
  }
  const leaderKey = new Map();
  for (const g of groups) for (const l of g.leaders || []) leaderKey.set(fold(l), { name: l, groupId: g.id });
  const byLen = (a, b) => b.length - a.length || a.localeCompare(b);
  const aliasRe = new RegExp(`\\b(${[...aliasKey.keys()].sort(byLen).map(escapeRe).join('|')})\\b`, 'g');
  const leaderRe = leaderKey.size ? new RegExp(`\\b(${[...leaderKey.keys()].sort(byLen).map(escapeRe).join('|')})\\b`, 'g') : null;
  // Case-insensitive matcher over the original (unfolded) text, used to blank group names out before place
  // scanning so "Cártel de Sinaloa" / "Cartel Jalisco Nueva Generación" do not count as state mentions.
  const rawAliases = new Set();
  for (const g of raw.groups) for (const a of [g.name, ...(g.aliases || [])]) if (a) { rawAliases.add(a); rawAliases.add(fold(a)); }
  const maskRe = new RegExp(`\\b(${[...rawAliases].sort(byLen).map(escapeRe).join('|')})\\b`, 'gi');
  return { version: raw.version, groups, byId, aliasKey, aliasRe, leaderKey, leaderRe, maskRe };
}

export function maskGroupNames(text, idx = loadGroups()) {
  return String(text || '').replace(idx.maskRe, m => ' '.repeat(m.length));
}

// Returns { cartels: [{id,name,short,orgId,mentions}], factions: [...same], leaders: [{name,groupId}] }.
// A faction mention implies its parent cartel; the parent is listed under `cartels` with `implied: true`
// when it was not itself named.
export function findGroups(text, idx = loadGroups()) {
  const t = fold(text);
  const hits = new Map();
  idx.aliasRe.lastIndex = 0;
  let m;
  while ((m = idx.aliasRe.exec(t)) !== null) {
    const g = idx.aliasKey.get(m[1]);
    const cur = hits.get(g.id) || { id: g.id, name: g.name, short: g.short, orgId: g.orgId || 'other', type: g.type, parent: g.parent || null, mentions: 0, first: m.index, implied: false };
    cur.mentions++;
    hits.set(g.id, cur);
  }
  for (const h of [...hits.values()]) {
    if (h.parent && !hits.has(h.parent)) {
      const p = idx.byId.get(h.parent);
      hits.set(p.id, { id: p.id, name: p.name, short: p.short, orgId: p.orgId || 'other', type: p.type, parent: p.parent || null, mentions: 0, first: h.first, implied: true });
    }
  }
  const leaders = [];
  if (idx.leaderRe) {
    idx.leaderRe.lastIndex = 0;
    const seen = new Set();
    while ((m = idx.leaderRe.exec(t)) !== null) {
      const l = idx.leaderKey.get(m[1]);
      if (seen.has(l.name)) continue;
      seen.add(l.name);
      leaders.push(l);
      // Naming a leader implies the organization.
      if (!hits.has(l.groupId)) {
        const g = idx.byId.get(l.groupId);
        hits.set(g.id, { id: g.id, name: g.name, short: g.short, orgId: g.orgId || 'other', type: g.type, parent: g.parent || null, mentions: 0, first: m.index, implied: true });
        if (g.parent && !hits.has(g.parent)) {
          const p = idx.byId.get(g.parent);
          hits.set(p.id, { id: p.id, name: p.name, short: p.short, orgId: p.orgId || 'other', type: p.type, parent: null, mentions: 0, first: m.index, implied: true });
        }
      }
    }
  }
  const rank = (a, b) => b.mentions - a.mentions || a.first - b.first;
  const all = [...hits.values()].sort(rank);
  return {
    cartels: all.filter(g => g.type !== 'faction'),
    factions: all.filter(g => g.type === 'faction'),
    leaders,
  };
}

export function resetForTests() { _cache = null; }
