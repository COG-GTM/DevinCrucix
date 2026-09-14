// CJNG article corpus from InSight Crime's public WordPress REST API.
//
// Pulls every post tagged "Jalisco Cartel" plus every post whose full text matches "CJNG", de-duplicates
// by WordPress post id, strips the HTML to paragraph text and persists the result under runs/. Only the
// public JSON API is used (no HTML scraping, no paywall handling); robots.txt is honoured and requests
// are paced. Re-runs are incremental: only posts modified since the last snapshot are fetched again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { safeOutboundFetch } from '../safeOutboundFetch.mjs';
import { checkRobots, CRAWLER_UA } from '../../apis/utils/robots.mjs';
import { htmlToText } from '../../apis/utils/article.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/insightcrime/cjng');
export const CORPUS_SCHEMA = 'insightcrime-cjng-corpus/1';

export const API_BASE = 'https://insightcrime.org/wp-json/wp/v2';
export const SITE_HOST = 'insightcrime.org';
// WordPress taxonomy ids on insightcrime.org (verified live 2026-09): tag 676 = "Jalisco Cartel",
// tag 3426 = "El Mencho", category 360 = "The Organization" (group profiles).
export const TAG_JALISCO_CARTEL = 676;
export const TAG_EL_MENCHO = 3426;
export const CATEGORY_ORGANIZATION = 360;
export const SEARCH_TERM = 'CJNG';

const PER_PAGE = 100;
const MAX_PAGES = 40;          // 4,000 posts per query — far above the current corpus, guards a runaway loop
const MAX_TEXT_CHARS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_DELAY_MS = 1_200;
const POST_FIELDS = 'id,date_gmt,modified_gmt,link,slug,title,excerpt,content,tags,categories';
export const QUERIES = [
  { name: 'tag:jalisco-cartel', params: { tags: String(TAG_JALISCO_CARTEL) } },
  { name: 'tag:el-mencho', params: { tags: String(TAG_EL_MENCHO) } },
  { name: `search:${SEARCH_TERM}`, params: { search: SEARCH_TERM } },
];

// Words that mark a post as *about* CJNG rather than mentioning it in passing.
export const CJNG_RE = /\bCJNG\b|Jalisco (?:New Generation )?Cartel|C[aá]rtel (?:de )?Jalisco Nueva Generaci[oó]n|\bEl Mencho\b|Nemesio (?:Rub[eé]n )?Oseguera/gi;

function readJson(file, dflt) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt; } catch { return dflt; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

function decodeTitle(s) {
  return htmlToText(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function isSiteUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === SITE_HOST || x.hostname === `www.${SITE_HOST}`); } catch { return false; }
}

const _lastHit = { t: 0 };
async function politeWait(delayMs) {
  const wait = _lastHit.t + delayMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastHit.t = Date.now();
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [5_000, 20_000, 60_000];

async function getJson(url, { fetchImpl, delayMs, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const robots = await checkRobots(url, { fetch: fetchImpl });
  if (!robots.allowed) throw new Error('robots-disallowed');
  let res;
  for (let attempt = 0; ; attempt++) {
    await politeWait(Math.max(delayMs, (robots.crawlDelay || 0) * 1000));
    res = await fetchImpl(url, { headers: { 'User-Agent': CRAWLER_UA, Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS });
    if (!RETRY_STATUS.has(res.status) || attempt >= BACKOFF_MS.length) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Math.min(120_000, Math.max(BACKOFF_MS[attempt], Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
  }
  if (!res.ok) throw new Error(`http-${res.status}`);
  const totalPages = Number(res.headers.get('x-wp-totalpages')) || 1;
  const total = Number(res.headers.get('x-wp-total')) || 0;
  const body = await res.json();
  return { body: Array.isArray(body) ? body : [], totalPages, total };
}

// Count how strongly a post is about CJNG: title hit counts as 3, each body hit as 1.
export function cjngFocus(title, text) {
  const t = (String(title || '').match(CJNG_RE) || []).length;
  const b = (String(text || '').match(CJNG_RE) || []).length;
  return t * 3 + b;
}

// WordPress post -> corpus record. Returns null for anything that isn't a public insightcrime.org post.
export function normalizePost(p) {
  if (!p || typeof p !== 'object' || !Number.isInteger(p.id) || p.id <= 0) return null;
  const link = typeof p.link === 'string' && isSiteUrl(p.link) ? p.link : null;
  if (!link) return null;
  const title = decodeTitle(p.title?.rendered);
  const text = htmlToText(p.content?.rendered).slice(0, MAX_TEXT_CHARS);
  const excerpt = htmlToText(p.excerpt?.rendered).replace(/\s+/g, ' ').trim().slice(0, 600);
  const tags = Array.isArray(p.tags) ? p.tags.filter(Number.isInteger).slice(0, 40) : [];
  const categories = Array.isArray(p.categories) ? p.categories.filter(Number.isInteger).slice(0, 20) : [];
  const date = typeof p.date_gmt === 'string' && !Number.isNaN(Date.parse(p.date_gmt + 'Z')) ? new Date(p.date_gmt + 'Z').toISOString() : null;
  const modified = typeof p.modified_gmt === 'string' && !Number.isNaN(Date.parse(p.modified_gmt + 'Z')) ? new Date(p.modified_gmt + 'Z').toISOString() : date;
  return {
    id: p.id, link, slug: String(p.slug || '').slice(0, 200), title, date, modified, tags, categories, excerpt, text,
    tagged: tags.includes(TAG_JALISCO_CARTEL) || tags.includes(TAG_EL_MENCHO),
    focus: cjngFocus(title, text),
    words: text ? text.split(/\s+/).length : 0,
  };
}

// An article is "about CJNG" when InSight Crime tagged it so, or when it names the group in the title,
// or when the body names it repeatedly. Passing mentions stay in the corpus file but out of the graph.
export function isCjngFocused(rec) {
  return Boolean(rec && (rec.tagged || rec.focus >= 3));
}

async function pagedQuery(params, opts, onPage) {
  const seen = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ ...params, per_page: String(PER_PAGE), page: String(page), _fields: POST_FIELDS, orderby: 'date', order: 'desc' });
    const { body, totalPages } = await getJson(`${API_BASE}/posts?${q}`, opts);
    for (const p of body) seen.push(p);
    if (onPage) onPage(page, totalPages, body.length);
    if (page >= totalPages || body.length === 0) break;
  }
  return seen;
}

export async function fetchTerms(kind, opts) {
  const out = {};
  for (let page = 1; page <= 20; page++) {
    const q = new URLSearchParams({ per_page: '100', page: String(page), _fields: 'id,name,slug,count' });
    const { body, totalPages } = await getJson(`${API_BASE}/${kind}?${q}`, opts);
    for (const t of body) if (Number.isInteger(t.id)) out[t.id] = { name: decodeTitle(t.name), slug: String(t.slug || '').slice(0, 120), count: Number(t.count) || 0 };
    if (page >= totalPages || body.length === 0) break;
  }
  return out;
}

export function loadCorpus(dataDir = DEFAULT_DATA_DIR) {
  const c = readJson(join(dataDir, 'corpus.json'), null);
  return c && c.schema === CORPUS_SCHEMA && Array.isArray(c.articles) ? c : null;
}

// Full or incremental refresh. `since` (ISO) limits the post queries to items modified after that instant.
export async function refreshCorpus({
  dataDir = DEFAULT_DATA_DIR, fetchImpl = safeOutboundFetch, delayMs = DEFAULT_DELAY_MS, now = Date.now(), full = false, log = () => {}, sleep,
} = {}) {
  const started = Date.now();
  const prev = full ? null : loadCorpus(dataDir);
  const byId = new Map((prev?.articles || []).map(a => [a.id, a]));
  const opts = sleep ? { fetchImpl, delayMs, sleep } : { fetchImpl, delayMs };
  const stats = { requests: 0, fetched: 0, added: 0, updated: 0, errors: [] };
  const onPage = (page, totalPages, n) => { stats.requests++; log(`page ${page}/${totalPages} · ${n} posts`); };

  // Each query remembers when it last completed, so a query that failed (rate limit, outage) is re-run in
  // full next time while the others only ask for posts modified since their own last success.
  const completed = { ...(prev?.completed || {}) };
  const attemptedAt = new Date(now).toISOString();
  for (const qd of QUERIES) {
    const since = completed[qd.name] || null;
    try {
      const params = since ? { ...qd.params, modified_after: since } : qd.params;
      const posts = await pagedQuery(params, opts, onPage);
      for (const p of posts) {
        const rec = normalizePost(p);
        if (!rec) continue;
        stats.fetched++;
        const old = byId.get(rec.id);
        if (!old) stats.added++;
        else if (old.modified !== rec.modified) stats.updated++;
        byId.set(rec.id, rec);
      }
      completed[qd.name] = attemptedAt;
      log(`${qd.name}: ${posts.length} posts${since ? ` modified since ${since.slice(0, 10)}` : ''}`);
    } catch (err) {
      stats.errors.push(`${qd.name}: ${err.message}`);
      log(`${qd.name} failed: ${err.message}`);
    }
  }

  let tags = prev?.tags || null, categories = prev?.categories || null;
  if (!tags || full) {
    try { tags = await fetchTerms('tags', opts); stats.requests++; } catch (err) { stats.errors.push(`tags: ${err.message}`); tags = tags || {}; }
  }
  if (!categories || full) {
    try { categories = await fetchTerms('categories', opts); stats.requests++; } catch (err) { stats.errors.push(`categories: ${err.message}`); categories = categories || {}; }
  }

  const articles = [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const focused = articles.filter(isCjngFocused).length;
  const corpus = {
    schema: CORPUS_SCHEMA,
    source: 'InSight Crime',
    api: `${API_BASE}/posts`,
    queries: QUERIES.map(q => q.name),
    completed,
    fetchedAt: QUERIES.every(q => completed[q.name]) ? attemptedAt : (prev?.fetchedAt || null),
    attemptedAt,
    durationMs: Date.now() - started,
    incremental: Boolean(prev),
    stats,
    totals: { articles: articles.length, focused, peripheral: articles.length - focused, tagged: articles.filter(a => a.tagged).length, words: articles.reduce((s, a) => s + a.words, 0) },
    span: articles.length ? { from: articles[articles.length - 1].date, to: articles[0].date } : null,
    tags, categories,
    articles,
  };
  writeJson(join(dataDir, 'corpus.json'), corpus);
  return corpus;
}
