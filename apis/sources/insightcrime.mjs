// InSight Crime — Latin America Organized Crime & Security RSS Intelligence
// Pulls RSS feeds from insightcrime.org (main + regional category feeds).
// Extracts named entities from articles and cross-references against OpenSanctions.
// Alert logic: PRIORITY if a named entity matches a sanctions hit simultaneously.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetch } from '../utils/fetch.mjs';
import { decodeEntities } from '../utils/rss.mjs';
import { crossReference } from './opensanctions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_CACHE = join(__dirname, '../../runs/insightcrime/profiles.json');

const FEEDS = [
  { name: 'Main', url: 'https://insightcrime.org/feed/' },
  { name: 'Mexico', url: 'https://insightcrime.org/tag/mexico/feed/' },
  { name: 'Colombia', url: 'https://insightcrime.org/tag/colombia/feed/', country: 'co' },
  { name: 'Venezuela', url: 'https://insightcrime.org/tag/venezuela/feed/', country: 've' },
  { name: 'Central America', url: 'https://insightcrime.org/tag/central-america/feed/' },
];

// Criminal-group profile pages, by InSight Crime's own "<Country> Groups" tag. Refreshed daily;
// the last good copy is kept on disk so a 429 from the WordPress API never blanks the cards.
export const PROFILE_TAGS = { co: { tag: 540, label: 'Colombia Groups' }, ve: { tag: 612, label: 'Venezuela Groups' } };
const PROFILE_TTL_MS = 24 * 3600 * 1000;
const PROFILE_URL = (tag) => `https://insightcrime.org/wp-json/wp/v2/posts?tags=${tag}&per_page=30&_fields=id,date_gmt,modified_gmt,link,title,excerpt`;
const COUNTRY_ARTICLES_MAX = 20;

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
      return m ? decodeEntities(m[1].trim()) : '';
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

const stripHtml = (s, max) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’').replace(/&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, '…')).replace(/\s+/g, ' ').trim().slice(0, max);
const icUrl = (raw) => { try { const u = new URL(String(raw ?? '')); return u.protocol === 'https:' && /(^|\.)insightcrime\.org$/.test(u.hostname) ? u.toString() : null; } catch { return null; } };
const isoDate = (raw) => { const t = Date.parse(String(raw ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// Bounded profile card from a WordPress post record (title / excerpt / link only).
export function normalizeProfile(post) {
  const url = icUrl(post?.link);
  const name = stripHtml(post?.title?.rendered, 120);
  if (!url || !name) return null;
  return {
    id: Number.isInteger(post?.id) ? post.id : null,
    name,
    url,
    kind: /\/[a-z-]*organized-crime-news\/[^/]+\/?$/.test(new URL(url).pathname) ? 'profile' : 'analysis',
    summary: stripHtml(post?.excerpt?.rendered, 320),
    published: isoDate(post?.date_gmt ? `${post.date_gmt}Z` : post?.date),
    updated: isoDate(post?.modified_gmt ? `${post.modified_gmt}Z` : post?.modified),
  };
}

export function normalizeProfiles(posts) {
  return (Array.isArray(posts) ? posts : []).map(normalizeProfile).filter(Boolean)
    .sort((a, b) => (b.updated || b.published || '').localeCompare(a.updated || a.published || ''));
}

let profileState = null;
function loadProfileState() {
  if (profileState) return profileState;
  try { profileState = JSON.parse(readFileSync(PROFILE_CACHE, 'utf8')); } catch { profileState = {}; }
  // Text fields pass through stripHtml again so a cache written by an older normalizer is still clean.
  for (const st of Object.values(profileState)) {
    if (Array.isArray(st?.cards)) st.cards = st.cards.map(c => ({ ...c, name: stripHtml(c.name, 120), summary: stripHtml(c.summary, 320) }));
  }
  return profileState;
}
function saveProfileState() {
  try { mkdirSync(dirname(PROFILE_CACHE), { recursive: true }); writeFileSync(PROFILE_CACHE, JSON.stringify(profileState)); } catch { /* best effort */ }
}

// Upstream error bodies are HTML pages; keep the status line only.
function shortErr(e) { const m = /^HTTP \d{3}/.exec(String(e || '')); return (m ? m[0] + (m[0] === 'HTTP 429' ? ' rate limited' : '') : String(e || 'error').split('\n')[0]).slice(0, 120); }

async function fetchProfiles(cc) {
  const { tag, label } = PROFILE_TAGS[cc];
  const state = loadProfileState();
  const prev = state[cc];
  const now = Date.now();
  if (prev && now - Date.parse(prev.fetchedAt) < PROFILE_TTL_MS) return { ...prev, status: 'live', error: null };
  const r = await safeFetch(PROFILE_URL(tag), { timeout: 20000, retries: 0, headers: { Accept: 'application/json' } });
  if (!r?.error && Array.isArray(r)) {
    const cards = normalizeProfiles(r);
    if (cards.length) {
      state[cc] = { tag, label, fetchedAt: new Date(now).toISOString(), cards };
      saveProfileState();
      return { ...state[cc], status: 'live', error: null };
    }
  }
  const err = shortErr(r?.error || 'no profile records');
  if (prev) return { ...prev, status: 'cached', error: `serving cached profiles: ${err}`.slice(0, 160) };
  return { tag, label, fetchedAt: null, cards: [], status: 'unavailable', error: err };
}

export function _resetProfilesForTests() { profileState = null; }

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
  // Profile tags hit the same origin as the feeds: fetch them one at a time, after the feeds, so a
  // sweep never fires more than one WP-API request at insightcrime.org at once (it rate-limits bursts).
  const profiles = {};
  for (const cc of Object.keys(PROFILE_TAGS)) {
    profiles[cc] = await fetchProfiles(cc).catch(e => ({ ...PROFILE_TAGS[cc], fetchedAt: null, cards: [], status: 'unavailable', error: shortErr(e.message) }));
  }

  // Country-tagged articles for the Country Home Pages (bounded: title / link / date / excerpt).
  const byCountry = {};
  for (const feed of FEEDS) {
    if (!feed.country) continue;
    const res = feedResults.find(r => r.feed === feed.name);
    byCountry[feed.country] = {
      feed: feed.name,
      error: res?.error || null,
      count: res?.articles.length || 0,
      articles: (res?.articles || []).slice(0, COUNTRY_ARTICLES_MAX).map(a => ({ title: a.title, link: icUrl(a.link), date: isoDate(a.pubDate), description: a.description?.substring(0, 200), categories: a.categories?.slice(0, 5) })).filter(a => a.link),
    };
  }

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
    byCountry,
    profiles,
    sanctionsHits,
    priorityAlerts,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('insightcrime.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
