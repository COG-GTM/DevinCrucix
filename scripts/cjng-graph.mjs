#!/usr/bin/env node
// Refresh the InSight Crime CJNG corpus and rebuild the CJNG knowledge graph.
//   node scripts/cjng-graph.mjs            incremental corpus refresh + graph rebuild
//   node scripts/cjng-graph.mjs --full     re-download every matching post
//   node scripts/cjng-graph.mjs --offline  rebuild the graph from the cached corpus only
import { refreshCorpus, loadCorpus, DEFAULT_DATA_DIR } from '../lib/cjng/corpus.mjs';
import { buildCjngGraph, saveGraph } from '../lib/cjng/graph.mjs';

const args = new Set(process.argv.slice(2));
const log = m => console.log(`[cjng] ${m}`);

let corpus = args.has('--offline') ? loadCorpus() : await refreshCorpus({ full: args.has('--full'), log });
if (!corpus) { console.error('[cjng] no cached corpus; run without --offline first'); process.exit(1); }
log(`corpus: ${corpus.totals.articles} articles (${corpus.totals.focused} CJNG-focused) · ${corpus.totals.words.toLocaleString()} words · ${corpus.span ? `${corpus.span.from.slice(0, 10)} → ${corpus.span.to.slice(0, 10)}` : 'empty'}`);
if (corpus.stats?.errors?.length) log(`fetch errors: ${corpus.stats.errors.join('; ')}`);

const graph = buildCjngGraph(corpus);
saveGraph(graph);
log(`graph: ${graph.totals.nodes} nodes · ${graph.totals.edges} edges (${graph.totals.typedEdges} typed) from ${graph.totals.articles} articles · saved to ${DEFAULT_DATA_DIR}/graph.json`);
