#!/usr/bin/env node
// Refresh the InSight Crime CJNG corpus and rebuild the CJNG knowledge graph (thin wrapper kept for the
// npm script / docs; see scripts/insight-graph.mjs for all profiles).
//   node scripts/cjng-graph.mjs            incremental corpus refresh + graph rebuild
//   node scripts/cjng-graph.mjs --full     re-download every matching post
//   node scripts/cjng-graph.mjs --offline  rebuild the graph from the cached corpus only
process.argv.splice(2, 0, 'cjng');
await import('./insight-graph.mjs');
