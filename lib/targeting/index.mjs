// Target Development orchestrator: nominate -> FIND -> adjudicate -> FIX -> pattern -> graph proposals.
//
// The package a develop() run returns is the whole targeting record for one target. Every element points
// back at the sentence and URL that produced it; the model (if any) only ranked or labelled what the
// sources said. Graph proposals derived from links stay "proposed" until an analyst accepts them.
import { gatherMentions, SOURCES } from './find.mjs';
import { adjudicate } from './adjudicate.mjs';
import { fixTarget } from './fix.mjs';
import { patternOfActivity } from './pattern.mjs';
import { sha } from './store.mjs';
import { RELATIONS } from '../cjng/graph.mjs';

export { SOURCES };
export const PACKAGE_SCHEMA = 'crucix-target-package/1';
export const EVIDENCE_TIERS = {
  official: 'Official record (DOJ / OFAC) — published by the US Government',
  reported: 'Reported — published journalism or a sourced knowledge-graph edge',
  unverified: 'Unverified — public Telegram channel; never used for location',
};
export const CLAIM_STATES = {
  reported: 'as reported by the cited source',
  proposed: 'correlation proposed by rules or model; awaiting analyst',
  accepted: 'analyst accepted',
  rejected: 'analyst rejected',
};

/** Links that would change the knowledge graph if accepted: same-actor merges and typed relations. */
export function graphProposalsFrom(target, links, anchors) {
  const out = [];
  const anchorId = anchors[0]?.id || `${target.type === 'person' ? 'person' : 'org'}:${target.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  for (const l of links) {
    const a = l.assessment || l.rules;
    if (!a) continue;
    if (l.kind === 'persona' && a.role === 'target') {
      out.push(proposal({ kind: 'alias', rel: 'same_actor', source: anchorId, target: l.label, targetNode: l.nodeId, label: `${l.label} → alias of ${target.label}`, linkId: l.id, evidence: l.evidence, confidence: a.confidence, by: a.by, model: a.model || null, existing: l.relConfidence === 'kg-alias' }));
      continue;
    }
    if (a.role !== 'associate' || !a.relation || a.relation === 'same_actor' || a.relation === 'mentioned_with') continue;
    if (!l.nodeId) continue;
    const dir = l.relDirection === 'in';
    out.push(proposal({ kind: 'edge', rel: a.relation, source: dir ? l.nodeId : anchorId, target: dir ? anchorId : l.nodeId, label: `${dir ? l.label : target.label} ${RELATIONS[a.relation]?.label || a.relation} ${dir ? target.label : l.label}`, linkId: l.id, evidence: l.evidence, confidence: a.confidence, by: a.by, model: a.model || null, existing: l.relConfidence === 'typed' && l.rel === a.relation }));
  }
  return out.slice(0, 120);
}
function proposal(p) {
  return { id: `gp_${sha(`${p.rel}|${p.source}|${p.target}`).slice(0, 12)}`, ...p, evidence: (p.evidence || []).slice(0, 4), status: 'proposed', decidedAt: null };
}

/**
 * @param provider  lib/llm provider or null
 * @param target    stored target record
 * @param ctx       source context (see find.mjs gatherMentions)
 */
export async function developTarget(provider, target, ctx = {}, { now = Date.now() } = {}) {
  const started = Date.now();
  const found = gatherMentions(target, ctx);
  const { links, llm } = await adjudicate(provider, target, found.candidates);
  const fix = await fixTarget(provider, target, found.mentions, { gz: ctx.gz });
  const pattern = patternOfActivity(found.mentions, fix.observations, { now });
  const graphProposals = graphProposalsFrom(target, links, found.anchors);
  const bySource = {};
  for (const m of found.mentions) bySource[m.source] = (bySource[m.source] || 0) + 1;
  return {
    schema: PACKAGE_SCHEMA,
    computedAt: new Date(now).toISOString(),
    durationMs: Date.now() - started,
    requirement: target.requirement,
    matchers: found.matchers,
    anchors: found.anchors,
    coverage: found.coverage,
    stats: {
      mentions: found.mentions.length, documents: new Set(found.mentions.map(m => `${m.source}|${m.docId}`)).size, bySource,
      selectors: found.selectors.length, candidates: found.candidates.length, observations: fix.observations.length,
      span: pattern.aggregates.span,
    },
    mentions: found.mentions,
    selectors: found.selectors,
    links,
    llm: { ...llm, fix: fix.model },
    fix: { lastKnown: fix.lastKnown, footprint: fix.footprint, dispersion: fix.dispersion, observations: fix.observations, caveat: fix.caveat },
    pattern,
    graphProposals,
    legend: { tiers: EVIDENCE_TIERS, claims: CLAIM_STATES, sources: SOURCES },
  };
}

/** Strip the heavy arrays for list/summary responses. */
export function compactPackage(pkg) {
  if (!pkg) return null;
  const { mentions, ...rest } = pkg;
  return { ...rest, mentions: mentions.slice(0, 60), fix: { ...pkg.fix, observations: pkg.fix.observations.slice(0, 120) }, pattern: { ...pkg.pattern, timeline: pkg.pattern.timeline.slice(0, 120) } };
}
