// OpenSanctions — Global Sanctions & PEP Aggregator
// Aggregates sanctions data from OFAC, EU, UN, and 30+ other sources.
// Optional: OPENSANCTIONS_API_KEY for higher rate limits.
// Cross-references entity names from other live feeds against sanctions database.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.opensanctions.org';

function apiHeaders() {
  const headers = {};
  const key = process.env.OPENSANCTIONS_API_KEY;
  if (key) headers['Authorization'] = `ApiKey ${key}`;
  return headers;
}

// Search sanctioned entities by name/keyword
export async function searchEntities(query, opts = {}) {
  const { limit = 20, schema, topics } = opts;

  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  if (schema) params.set('schema', schema);
  if (topics) params.set('topics', topics);

  return safeFetch(`${BASE}/search/default?${params}`, { timeout: 15000, headers: apiHeaders() });
}

// Match an entity name against sanctions database (returns match score)
export async function matchEntity(name, opts = {}) {
  const { schema = 'Thing', topics } = opts;
  const params = new URLSearchParams({ q: name, limit: '5' });
  if (schema) params.set('schema', schema);
  if (topics) params.set('topics', topics);
  const result = await safeFetch(`${BASE}/search/default?${params}`, { timeout: 10000, headers: apiHeaders() });
  if (!result || result.error) return null;
  const matches = (result.results || []).filter(r => {
    const score = r.score || 0;
    return score > 0.7; // high confidence match
  });
  return matches.length > 0 ? matches : null;
}

// Cross-reference a list of entity names against sanctions database
export async function crossReference(names) {
  const hits = [];
  // Batch in parallel, max 10 concurrent
  const batches = [];
  for (let i = 0; i < names.length; i += 10) {
    batches.push(names.slice(i, i + 10));
  }
  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(async (name) => {
        const matches = await matchEntity(name, { topics: 'sanction' });
        if (matches && matches.length > 0) {
          return { name, matches: matches.map(m => ({ id: m.id, caption: m.caption, score: m.score, datasets: m.datasets, topics: m.topics })) };
        }
        return null;
      })
    );
    hits.push(...results.filter(Boolean));
  }
  return hits;
}

// Get available datasets/collections
export async function getCollections() {
  return safeFetch(`${BASE}/collections`, { timeout: 15000 });
}

// Get details about a specific dataset
export async function getDataset(name) {
  return safeFetch(`${BASE}/datasets/${name}`, { timeout: 15000 });
}

// Get a specific entity by ID
export async function getEntity(entityId) {
  return safeFetch(`${BASE}/entities/${entityId}`, { timeout: 15000 });
}

// Compact entity for briefing output
function compactEntity(e) {
  return {
    id: e.id,
    name: e.caption || e.name,
    schema: e.schema,
    datasets: e.datasets,
    topics: e.topics,
    countries: e.properties?.country || [],
    lastSeen: e.last_seen,
    firstSeen: e.first_seen,
    score: e.score || null,
  };
}

// Compact search results
function compactSearchResult(result, query) {
  const entities = (result?.results || []).map(compactEntity);
  const rawTotal = result?.total;
  const totalResults = typeof rawTotal === 'object' ? (rawTotal?.value || 0) : (rawTotal || 0);
  return {
    query,
    totalResults,
    entities: entities.slice(0, 10),
  };
}

// Key entities/subjects to monitor for sanctions intelligence
const BRIEFING_QUERIES = [
  'Iran',
  'Russia',
  'North Korea',
  'Syria',
  'Venezuela',
  'Wagner',
];

// Briefing — search for notable sanctioned entities across key targets
export async function briefing() {
  const hasKey = !!process.env.OPENSANCTIONS_API_KEY;

  // Without an API key the search endpoint returns 401;
  // still report status so the dashboard knows the module is loaded.
  if (!hasKey) {
    return {
      source: 'OpenSanctions',
      timestamp: new Date().toISOString(),
      hasApiKey: false,
      status: 'no_api_key',
      message: 'Set OPENSANCTIONS_API_KEY in .env for sanctions search. Get a free key at https://www.opensanctions.org/api/',
      recentSearches: [],
      totalSanctionedEntities: 0,
      datasets: [],
      monitoringTargets: BRIEFING_QUERIES,
      crossRefAvailable: false,
    };
  }

  // Run searches in parallel
  const results = await Promise.all(
    BRIEFING_QUERIES.map(async (query) => {
      const data = await searchEntities(query, { limit: 10, topics: 'sanction' });
      return compactSearchResult(data, query);
    })
  );

  // Dataset metadata (collections endpoint may not be available)
  let datasetSummary = [];
  try {
    const collections = await getCollections();
    if (Array.isArray(collections)) {
      datasetSummary = collections.slice(0, 10).map(c => ({
        name: c.name,
        title: c.title,
        entityCount: c.entity_count,
        lastUpdated: c.updated_at,
      }));
    }
  } catch { /* optional */ }

  // Aggregate totals
  const totalSanctionedEntities = results.reduce(
    (sum, r) => sum + (r.totalResults || 0), 0
  );

  return {
    source: 'OpenSanctions',
    timestamp: new Date().toISOString(),
    hasApiKey: true,
    recentSearches: results,
    totalSanctionedEntities,
    datasets: datasetSummary,
    monitoringTargets: BRIEFING_QUERIES,
    crossRefAvailable: true,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('opensanctions.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
