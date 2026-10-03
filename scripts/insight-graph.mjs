#!/usr/bin/env node
// Refresh an InSight Crime corpus and rebuild its knowledge graph for one profile (cjng | co | ve).
//   node scripts/insight-graph.mjs co              incremental corpus refresh + graph rebuild
//   node scripts/insight-graph.mjs co --full       re-download every matching post
//   node scripts/insight-graph.mjs co --offline    rebuild the graph from the cached corpus only
//   node scripts/insight-graph.mjs co --snapshot   also write the committed fallback snapshot (config/*.json.gz)
import { refreshCorpus, loadCorpus } from '../lib/cjng/corpus.mjs';
import { buildGraph, saveGraph, saveSnapshot } from '../lib/cjng/graph.mjs';
import { getProfile, PROFILE_KEYS } from '../lib/cjng/profiles.mjs';

const argv = process.argv.slice(2);
const key = argv.find(a => !a.startsWith('--')) || 'cjng';
const args = new Set(argv.filter(a => a.startsWith('--')));
if (!PROFILE_KEYS.includes(key)) { console.error(`unknown profile ${key}; expected one of ${PROFILE_KEYS.join(', ')}`); process.exit(2); }
const profile = getProfile(key);
const log = m => console.log(`[${profile.key}] ${m}`);

let corpus = args.has('--offline') ? loadCorpus(profile.dataDir, profile) : await refreshCorpus({ profile, full: args.has('--full'), log });
if (!corpus) { console.error(`[${profile.key}] no cached corpus; run without --offline first`); process.exit(1); }
log(`corpus: ${corpus.totals.articles} articles (${corpus.totals.focused} ${profile.subject}-focused) · ${corpus.totals.words.toLocaleString()} words · ${corpus.span ? `${corpus.span.from.slice(0, 10)} → ${corpus.span.to.slice(0, 10)}` : 'empty'}`);
if (corpus.stats?.errors?.length) log(`fetch errors: ${corpus.stats.errors.join('; ')}`);

const t0 = Date.now();
const graph = buildGraph(corpus, { profile });
saveGraph(graph, profile.dataDir);
log(`graph: ${graph.totals.nodes} nodes · ${graph.totals.edges} edges (${graph.totals.typedEdges} typed) from ${graph.totals.articles} articles in ${Date.now() - t0} ms · saved to ${profile.dataDir}/graph.json`);
if (args.has('--snapshot')) { saveSnapshot(graph, profile.snapshotFile); log(`snapshot written to ${profile.snapshotFile}`); }
