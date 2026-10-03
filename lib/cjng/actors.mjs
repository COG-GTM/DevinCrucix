// Armed-actor cards for the country pages: the country group index (config/<cc>-groups.json —
// public-record names, aliases, parent structure, U.S. designations) joined with that group's node in
// the InSight Crime knowledge graph (article count, degree, strongest typed relations) and, when the
// name matches, InSight Crime's own profile page. Everything here is already in the graph payload or
// the config; the card is a bounded summary, not new analysis.

import { fold } from '../narco/gazetteer.mjs';

export const MAX_CARDS = 24;
const MAX_RELATIONS = 4;
const RELATION_LABEL = { allied_with: 'allied with', rival_of: 'rival of', operates_in: 'operates in', lineage: 'lineage', leader_of: 'led by', member_of: 'members', family_of: 'family tie' };
const SHOWN = new Set(['allied_with', 'rival_of', 'operates_in', 'lineage']);

const str = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };

export function buildActorCards(graph, groupIdx, profileCards = []) {
  const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const edgesBy = new Map();
  for (const e of graph?.edges || []) {
    if (!SHOWN.has(e.type)) continue;
    for (const end of [e.source, e.target]) { if (!edgesBy.has(end)) edgesBy.set(end, []); edgesBy.get(end).push(e); }
  }
  const profiles = (Array.isArray(profileCards) ? profileCards : []).filter(c => c.kind === 'profile' && c.url).map(c => {
    const name = String(c.name || '').replace(/&#8211;|&#8212;/g, '-').replace(/&#8216;|&#8217;/g, '\'');
    const acronyms = [...name.matchAll(/\(([A-Z]{2,8})\)/g)].map(m => fold(m[1]));
    return { key: fold(name), keys: new Set([fold(name), ...acronyms, ...name.split(/\s*[-–]\s*/).map(fold)]), url: c.url, summary: c.summary || '' };
  });
  const cards = [];
  for (const g of groupIdx?.groups || []) {
    const node = nodes.get(`org:${g.id}`);
    const rels = (edgesBy.get(`org:${g.id}`) || []).slice().sort((a, b) => (b.articles || 0) - (a.articles || 0)).slice(0, MAX_RELATIONS).map(e => {
      const otherId = e.source === `org:${g.id}` ? e.target : e.source;
      const other = nodes.get(otherId);
      return { type: e.type, label: RELATION_LABEL[e.type] || e.type, other: str(other?.label || otherId.replace(/^[a-z]+:/, ''), 60), otherType: other?.type || null, articles: e.articles || 0 };
    });
    const nameKeys = [g.name, g.short, ...(g.aliases || [])].map(fold).filter(a => a.length >= 3);
    const prof = profiles.find(p => nameKeys.some(k => p.keys.has(k) || (k.length >= 5 && p.key.includes(k))));
    cards.push({
      id: str(g.id, 40), name: str(g.name, 80), short: str(g.short || g.name, 32), type: str(g.type || 'other', 40), parent: g.parent ? str(groupIdx.byId.get(g.parent)?.short || g.parent, 32) : null,
      usDesignation: g.usDesignation ? str(g.usDesignation, 60) : null,
      leaders: (g.leaders || []).slice(0, 4).map(l => str(l, 40)),
      graph: node ? { articles: node.articles || 0, degree: node.degree || 0, first: node.first || null, last: node.last || null, relations: rels } : null,
      profileUrl: prof?.url || null,
      profileSummary: prof ? str(prof.summary, 240) : null,
    });
  }
  cards.sort((a, b) => (b.graph?.articles || 0) - (a.graph?.articles || 0) || a.name.localeCompare(b.name));
  return {
    count: cards.length, inGraph: cards.filter(c => c.graph).length, withProfile: cards.filter(c => c.profileUrl).length,
    groupsVersion: str(groupIdx?.version, 24), extractor: str(graph?.extractor, 32), computedAt: graph?.computedAt || null,
    cards: cards.slice(0, MAX_CARDS),
    note: 'Group index is CRUCIX config (public-record names, aliases, parent structure, U.S. designations); article / relation counts come from the InSight Crime knowledge graph; PROFILE links to InSight Crime\u2019s own page. Leaders listed are public-record figures named in official releases or InSight Crime profiles.',
  };
}
