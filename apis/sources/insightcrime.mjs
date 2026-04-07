// InSight Crime — Latin America Organized Crime & Security RSS Intelligence
// Pulls RSS feeds from insightcrime.org (main + regional category feeds).
// Extracts named entities from articles and cross-references against OpenSanctions.
// Alert logic: PRIORITY if a named entity matches a sanctions hit simultaneously.

import { safeFetch } from '../utils/fetch.mjs';
import { crossReference } from './opensanctions.mjs';

const FEEDS = [
  { name: 'Main', url: 'https://insightcrime.org/feed/' },
  { name: 'Mexico', url: 'https://insightcrime.org/tag/mexico/feed/' },
  { name: 'Colombia', url: 'https://insightcrime.org/tag/colombia/feed/' },
];

// Simple XML RSS parser (no dependencies)
function parseRSS(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const xml = match[1];
    const get = (tag) => {
      const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
        || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    items.push({
      title: get('title'),
      link: get('link'),
      pubDate: get('pubDate'),
      description: get('description').replace(/<[^>]+>/g, '').substring(0, 300),
      categories: [...xml.matchAll(/<category[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gi)].map(m => m[1].trim()),
    });
  }
  return items;
}

// Extract named entities from text (simple NER: capitalized multi-word sequences, known patterns)
function extractEntities(text) {
  if (!text) return [];
  const entities = new Set();

  // Match capitalized multi-word names (2+ words, each starting with uppercase)
  const namePattern = /\b([A-Z][a-z]+(?:\s+(?:de\s+|del\s+|la\s+|el\s+)?[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1].trim();
    // Filter out common non-entity phrases
    if (name.length > 4 && name.length < 60 &&
        !['The United', 'New York', 'Los Angeles', 'San Francisco', 'United States',
          'Central America', 'South America', 'North America', 'Latin America',
          'Read More', 'Click Here', 'Learn More'].includes(name)) {
      entities.add(name);
    }
  }

  // Known cartel/organization patterns
  const orgPatterns = [
    /(?:Cartel|Clan|Familia)\s+(?:de\s+)?[A-Z]\w+/gi,
    /(?:CJNG|Sinaloa|Gulf\s+Cartel|Zetas|MS-13|Mara\s+Salvatrucha|Tren\s+de\s+Aragua|Primera\s+Comando)/gi,
  ];
  for (const pattern of orgPatterns) {
    while ((match = pattern.exec(text)) !== null) {
      entities.add(match[0].trim());
    }
  }

  return [...entities];
}

// Fetch and parse a single RSS feed
async function fetchFeed(feed) {
  const data = await safeFetch(feed.url, { timeout: 15000 });
  // safeFetch returns { rawText } for non-JSON responses
  const text = data?.rawText || (typeof data === 'string' ? data : null);
  if (!text || data?.error) {
    return { feed: feed.name, error: data?.error || 'No RSS data returned', articles: [] };
  }
  const articles = parseRSS(text);
  return { feed: feed.name, articles };
}

// Briefing — pull all feeds, extract entities, cross-reference OpenSanctions
export async function briefing() {
  // Fetch all feeds in parallel
  const feedResults = await Promise.all(FEEDS.map(fetchFeed));

  // Aggregate all articles
  const allArticles = [];
  const feedSummary = [];
  for (const result of feedResults) {
    feedSummary.push({ name: result.feed, count: result.articles.length, error: result.error || null });
    for (const article of result.articles) {
      allArticles.push({ ...article, feed: result.feed });
    }
  }

  // Deduplicate by title
  const seen = new Set();
  const uniqueArticles = allArticles.filter(a => {
    if (seen.has(a.title)) return false;
    seen.add(a.title);
    return true;
  });

  // Extract entities from all articles
  const allEntities = new Set();
  const articleEntities = uniqueArticles.map(a => {
    const entities = extractEntities(`${a.title} ${a.description}`);
    entities.forEach(e => allEntities.add(e));
    return { ...a, entities };
  });

  // Cross-reference top entities against OpenSanctions
  const entityList = [...allEntities].slice(0, 30); // cap at 30 to avoid rate limits
  let sanctionsHits = [];
  let priorityAlerts = [];
  try {
    sanctionsHits = await crossReference(entityList);
    // PRIORITY alerts for sanctions matches
    priorityAlerts = sanctionsHits.map(hit => ({
      tier: 'PRIORITY',
      headline: `SANCTIONS MATCH: "${hit.name}" found in InSight Crime + OpenSanctions`,
      detail: `Matched: ${hit.matches.map(m => m.caption).join(', ')} (datasets: ${hit.matches.flatMap(m => m.datasets || []).slice(0, 3).join(', ')})`,
    }));
  } catch (e) {
    // Cross-referencing is best-effort
  }

  return {
    source: 'InSight Crime',
    timestamp: new Date().toISOString(),
    feeds: feedSummary,
    totalArticles: uniqueArticles.length,
    articles: articleEntities.slice(0, 30).map(a => ({
      title: a.title,
      link: a.link,
      date: a.pubDate,
      feed: a.feed,
      description: a.description?.substring(0, 200),
      categories: a.categories?.slice(0, 5),
      entities: a.entities?.slice(0, 10),
    })),
    extractedEntities: entityList.slice(0, 50),
    sanctionsHits,
    priorityAlerts,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('insightcrime.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
