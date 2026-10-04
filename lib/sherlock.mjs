// Sherlock manifest engine — username → profile presence across the sites described in
// config/sherlock/data.json (vendored from github.com/sherlock-project/sherlock, MIT; see
// THIRD_PARTY_NOTICES.md and scripts/update-sherlock-manifest.mjs).
//
// Only the data is Sherlock's. This module re-implements the detection semantics in Node so every
// request goes through the SSRF-guarded fetch path the rest of CRUCIX uses:
//   status_code   — 2xx at the (redirect-followed) profile URL means claimed, unless the status
//                   is one of the entry's errorCode values;
//   message       — claimed unless one of errorMsg appears in the body;
//   response_url  — redirects are NOT followed; a 2xx at the profile URL means claimed.
// regexCheck short-circuits usernames the site could never hold ("illegal"); WAF fingerprints turn
// a challenge page into "waf" rather than a false positive. Nothing here authenticates, posts to
// or touches the target's accounts — every probe is a public profile URL (or the site's public
// username-availability endpoint for the handful of POST entries).

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_DIR = join(__dirname, '../config/sherlock');

export const DETECTORS = ['message', 'status_code', 'response_url'];
export const STATUSES = ['found', 'not_found', 'waf', 'error', 'illegal'];

// Higher = a hit is harder to fake. `api` is reserved for the curated probes in apis/sources/osint.mjs
// that ask a platform's own JSON API; manifest detectors rank below it.
export const CONFIDENCE_RANK = { api: 3, message: 2, status_code: 1, response_url: 0 };
export const CONFIDENCE_LABEL = {
  api: 'platform API confirmed the account',
  message: 'profile page lacks the site\'s "no such user" marker',
  status_code: 'profile URL answered 2xx (sites that 200 everything are filtered by the self-test)',
  response_url: 'profile URL answered 2xx without redirecting away',
};

// Challenge pages that would otherwise read as a 200 "found". Kept in step with Sherlock's list.
export const WAF_FINGERPRINTS = [
  '.loading-spinner{visibility:hidden}body.no-js .challenge-running{display:none}body.dark{background-color:#222;color:#d9d9d9}body.dark a{color:#fff}body.dark a:hover{color:#ee730a;text-decoration:underline}body.dark .lds-ring div{border-color:#999 transparent transparent}body.dark .font-red{color:#b20f03}body.dark', // Cloudflare 2024-05
  '<span id="challenge-error-text">',                       // Cloudflare error page 2024-11
  'AwsWafIntegration.forceRefreshToken',                    // AWS CloudFront WAF 2024-11
  '{return l.onPageView}}),Object.defineProperty(r,"perimeterxIdentifiers",{enumerable:', // PerimeterX 2024-04
  'cf-browser-verification',                                // Cloudflare JS challenge (legacy)
  '<title>Just a moment...</title>',                        // Cloudflare managed challenge
  '<title>Attention Required! | Cloudflare</title>',        // Cloudflare block page
];

export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0';

// Sherlock's manifest has no categories; this is a keyword heuristic over the site name and host,
// good enough to group a dossier. Unknown sites fall back to "web".
const CATEGORY_KEYWORDS = {
  dev: ['github', 'gitlab', 'gitee', 'codeberg', 'bitbucket', 'sourceforge', 'npm', 'pypi', 'crates', 'rubygems', 'nuget', 'packagist', 'docker', 'hackerone', 'bugcrowd', 'kaggle', 'replit', 'codepen', 'jsfiddle', 'leetcode', 'codeforces', 'codechef', 'hackerrank', 'hackster', 'launchpad', 'stackoverflow', 'dev.to', 'exercism', 'freecodecamp', 'hashnode', 'glitch', 'codewars', 'topcoder', 'kernel', 'opensource', 'hackaday', 'scratch', 'arduino', 'wordpress.org', 'drupal', 'typo3', 'joomla', 'splits.io', 'huggingface', 'colab', 'observable', 'gradle', 'maven', 'cargo'],
  social: ['twitter', 'x.com', 'facebook', 'instagram', 'threads', 'mastodon', 'bluesky', 'bsky', 'vk.com', 'ok.ru', 'telegram', 't.me', 'snapchat', 'tiktok', 'reddit', 'tumblr', 'pinterest', 'linktr', 'about.me', 'keybase', 'minds', 'gab', 'truthsocial', 'gettr', 'weibo', 'linkedin', 'xing', 'fediverse', 'pixelfed', 'lemmy', 'nostr', 'diaspora', 'friendica', 'social', 'clubhouse', 'tellonym', 'ask.fm', 'curiouscat', 'carrd', 'bio.link', 'beacons', 'solo.to', 'allmylinks', 'linkt'],
  media: ['youtube', 'vimeo', 'twitch', 'soundcloud', 'spotify', 'bandcamp', 'mixcloud', 'flickr', '500px', 'deviantart', 'behance', 'dribbble', 'artstation', 'imgur', 'giphy', 'letterboxd', 'myanimelist', 'anilist', 'wattpad', 'medium', 'substack', 'blogger', 'wordpress', 'livejournal', 'last.fm', 'genius', 'audiomack', 'reverbnation', 'smule', 'dailymotion', 'rumble', 'bitchute', 'odysee', 'kick', 'trakt', 'goodreads', 'imdb', 'archive.org', 'pixiv', 'newgrounds', 'unsplash', 'pexels', 'vsco', 'ello', 'issuu', 'scribd', 'slideshare', 'slides', 'podcast', 'anchor', 'tunefind', 'discogs', 'rateyourmusic', 'kinopoisk', 'fandom', 'wikipedia', 'wiki', 'photo', 'music', 'tv', 'film', 'book'],
  gaming: ['steam', 'xbox', 'playstation', 'psn', 'chess', 'lichess', 'roblox', 'minecraft', 'osu', 'speedrun', 'itch.io', 'gamespot', 'ign', 'gog', 'epicgames', 'battle.net', 'fortnite', 'game', 'nitrotype', 'tetr', 'pokemon', 'mmo', 'lolchess', 'op.gg', 'tracker.gg', 'faceit', 'esea', 'rocketleague', 'overwatch', 'valorant', 'warframe', 'destiny', 'ps', 'nintendo', 'gamer', 'moddb', 'nexusmods', 'curseforge', 'modrinth', 'namemc', 'hypixel', 'aoe', 'geoguessr'],
  forum: ['forum', 'board', 'community', 'discourse', 'ycombinator', 'slashdot', 'discuss', 'disqus', 'xda', 'bbs', 'phpbb', 'vbulletin', 'mybb', 'kaskus', 'pikabu', 'habr', 'dzen', 'yaplakal', 'lor.', 'linux.org', 'ubuntu', 'fedora', 'arch', 'gentoo', 'raid', 'irc'],
  crypto: ['bitcoin', 'btc', 'crypto', 'binance', 'coin', 'blockchain', 'ethereum', 'nft', 'opensea', 'rarible', 'foundation.app', 'mirror.xyz', 'lens', 'uniswap', 'metamask', 'hive', 'steemit', 'dtube', 'coinbase', 'bitcointalk', 'kraken', 'polymarket', 'ens'],
  marketplace: ['ebay', 'etsy', 'fiverr', 'upwork', 'freelancer', 'amazon', 'aliexpress', 'ozon', 'avito', 'shop', 'store', 'market', 'gumroad', 'patreon', 'ko-fi', 'buymeacoffee', 'liberapay', 'opencollective', 'kickstarter', 'indiegogo', 'producthunt', 'crunchbase', 'angel', 'trustpilot', 'yelp', 'tripadvisor', 'airbnb', 'depop', 'vinted', 'poshmark', 'mercari', 'redbubble', 'teespring', 'society6', 'cults3d', 'thingiverse', 'printables'],
  fitness: ['strava', 'garmin', 'fitbit', 'myfitnesspal', 'runkeeper', 'nike', 'peloton', 'zwift', 'komoot', 'alltrails', 'wikiloc', 'mountainproject', 'climb', 'cycling', 'bodybuilding', 'duolingo', 'memrise', 'chesscom', 'sport'],
  dating: ['tinder', 'bumble', 'okcupid', 'badoo', 'dating', 'match', 'mamba', 'lovoo', 'zoosk', 'plentyoffish', 'pof', 'hinge', 'grindr', 'fetlife'],
};

const SPECIAL_HOST_SUFFIXES = ['co.uk', 'com.au', 'com.br', 'co.jp', 'co.in', 'com.tr', 'org.uk', 'net.au', 'co.za', 'com.mx', 'com.ar', 'co.kr', 'com.ua', 'com.pl'];

export function categorize(name, host, { nsfw = false } = {}) {
  if (nsfw) return 'adult';
  const hay = `${String(name).toLowerCase()} ${String(host || '').toLowerCase()}`;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) if (words.some(w => hay.includes(w))) return cat;
  return 'web';
}

export function registrableHost(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const tail2 = parts.slice(-2).join('.');
  return SPECIAL_HOST_SUFFIXES.includes(tail2) ? parts.slice(-3).join('.') : tail2;
}

function interpolate(template, username) {
  if (typeof template === 'string') return template.split('{}').join(username);
  if (Array.isArray(template)) return template.map(x => interpolate(x, username));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, interpolate(v, username)]));
  return template;
}

/** One raw manifest entry → normalized site record, or null when the entry can't be evaluated safely. */
export function normalizeSite(name, raw) {
  if (!raw || typeof raw !== 'object' || typeof name !== 'string' || !name.trim() || name.length > 40) return null;
  if (!DETECTORS.includes(raw.errorType)) return null;
  if (typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url)) return null;
  if (raw.urlProbe !== undefined && (typeof raw.urlProbe !== 'string' || !/^https?:\/\//i.test(raw.urlProbe))) return null;
  const method = String(raw.request_method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'HEAD'].includes(method)) return null;
  let regex = null;
  if (raw.regexCheck !== undefined) {
    if (typeof raw.regexCheck !== 'string' || raw.regexCheck.length > 200) return null;
    try { regex = new RegExp(raw.regexCheck); } catch { return null; }
  }
  const errorMsg = raw.errorMsg === undefined ? [] : (Array.isArray(raw.errorMsg) ? raw.errorMsg : [raw.errorMsg]).filter(m => typeof m === 'string' && m.length);
  if (raw.errorType === 'message' && !errorMsg.length) return null;
  const errorCode = raw.errorCode === undefined ? [] : (Array.isArray(raw.errorCode) ? raw.errorCode : [raw.errorCode]).map(Number).filter(Number.isInteger);
  const headers = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k) && !/^(cookie|authorization|host)$/i.test(k)) headers[k] = v.slice(0, 500);
  }
  const probeUrl = raw.urlProbe || raw.url;
  const host = registrableHost(raw.urlMain || raw.url) || registrableHost(probeUrl);
  if (!host) return null;
  const nsfw = raw.isNSFW === true;
  return {
    name: name.trim(), host, urlMain: typeof raw.urlMain === 'string' ? raw.urlMain : null, url: raw.url, probeUrl,
    errorType: raw.errorType, errorMsg, errorCode, errorUrl: typeof raw.errorUrl === 'string' ? raw.errorUrl : null,
    regex, method, payload: raw.request_payload && typeof raw.request_payload === 'object' ? raw.request_payload : null,
    headers, nsfw, category: categorize(name, host, { nsfw }), usernameClaimed: typeof raw.username_claimed === 'string' ? raw.username_claimed : null,
    confidence: raw.errorType,
  };
}

const _cache = new Map(); // dir -> { sites, info, health, loadedAt }

function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; }
}

/** Loads (and memoizes) the vendored manifest plus the self-test health file. */
export function loadManifest({ dir = MANIFEST_DIR, force = false } = {}) {
  if (!force && _cache.has(dir)) return _cache.get(dir);
  const raw = readJson(join(dir, 'data.json'), {});
  const info = readJson(join(dir, 'MANIFEST.json'), {});
  const health = readJson(join(dir, 'health.json'), { checkedAt: null, disabled: {} });
  const disabled = health.disabled && typeof health.disabled === 'object' ? health.disabled : {};
  const sites = []; const invalid = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith('$')) continue;
    const s = normalizeSite(name, entry);
    if (!s) { invalid.push(name); continue; }
    s.disabled = disabled[name] ? String(disabled[name].reason || disabled[name]) : null;
    sites.push(s);
  }
  sites.sort((a, b) => a.name.localeCompare(b.name));
  const loaded = { sites, invalid, info: { ...info, loadedSites: sites.length, invalid: invalid.length }, health: { checkedAt: health.checkedAt || null, disabled: Object.keys(disabled).length }, loadedAt: Date.now() };
  _cache.set(dir, loaded);
  return loaded;
}

export function manifestInfo(opts) {
  const m = loadManifest(opts);
  return { source: m.info.source || null, commit: m.info.commit || null, fetchedAt: m.info.fetchedAt || null, license: m.info.license || 'MIT', sites: m.sites.length, nsfw: m.sites.filter(s => s.nsfw).length, disabled: m.health.disabled, selfTestAt: m.health.checkedAt, invalid: m.invalid.length };
}

export function usernameAllowed(site, username) {
  return !site.regex || site.regex.test(username);
}

/** Request plan for one site: never resolves hosts or sends anything itself. */
export function buildRequest(site, username) {
  const u = String(username).replace(/ /g, '%20');
  const profileUrl = site.url.includes('{}') ? interpolate(site.url, u) : (site.urlMain || site.url);
  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', ...site.headers };
  let body;
  if (site.payload) {
    body = JSON.stringify(interpolate(site.payload, String(username)));
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  return {
    url: interpolate(site.probeUrl, u), profileUrl, method: site.method, headers, body,
    followRedirects: site.errorType !== 'response_url',
  };
}

/** Sherlock's classification of a response. `res` = { ok, status, body, error? } as returned by osint.mjs probe(). */
export function evaluate(site, res) {
  if (!res || !res.ok || !res.status) return { status: 'error', detector: site.errorType, error: res?.error || 'unreachable' };
  const text = typeof res.body === 'string' ? res.body : '';
  if (WAF_FINGERPRINTS.some(f => text.includes(f))) return { status: 'waf', detector: site.errorType };
  let status;
  if (site.errorType === 'message') status = site.errorMsg.some(m => text.includes(m)) ? 'not_found' : 'found';
  else if (site.errorType === 'status_code') status = site.errorCode.includes(res.status) || res.status < 200 || res.status >= 300 ? 'not_found' : 'found';
  else status = res.status >= 200 && res.status < 300 ? 'found' : 'not_found';
  return { status, detector: site.errorType };
}

export function siteResult(site, extra = {}) {
  return { platform: site.name, category: site.category, url: extra.url || site.url, source: 'sherlock', confidence: site.confidence, detector: site.errorType, nsfw: site.nsfw || undefined, status: 'error', http: null, ...extra };
}

/**
 * Probe one site. `probe(url, opts)` must resolve to { ok, status, body, error? } and never throw
 * (apis/sources/osint.mjs probe()). Options mirror that helper: timeout, maxBytes.
 */
export async function probeSite(site, username, probe, { timeout = 8000, maxBytes = 160 * 1024 } = {}) {
  const req = buildRequest(site, username);
  if (!usernameAllowed(site, username)) return siteResult(site, { url: req.profileUrl, status: 'illegal', http: null });
  const res = await probe(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: req.followRedirects ? 'follow' : 'manual', timeout, maxBytes });
  const ev = evaluate(site, res);
  return siteResult(site, { url: req.profileUrl, status: ev.status, http: res?.status || null, error: ev.error });
}

/**
 * Run the whole manifest for one username with a bounded worker pool.
 *   probe        required — see probeSite
 *   exclude      Set of registrable hosts already covered by curated probes (skipped here)
 *   includeNsfw  false drops isNSFW sites entirely
 *   onProgress   ({ done, total, found, platform, status }) after each site
 */
export async function runManifest(username, { probe, pool = 32, exclude = new Set(), includeNsfw = false, includeDisabled = false, onProgress, sites, timeout, maxBytes, manifestDir } = {}) {
  if (typeof probe !== 'function') throw new TypeError('runManifest: probe function required');
  const all = sites || loadManifest(manifestDir ? { dir: manifestDir } : undefined).sites;
  const skipped = { nsfw: 0, disabled: 0, curated: 0 };
  const run = all.filter(s => {
    if (!includeNsfw && s.nsfw) { skipped.nsfw++; return false; }
    if (!includeDisabled && s.disabled) { skipped.disabled++; return false; }
    if (exclude.has(s.host)) { skipped.curated++; return false; }
    return true;
  });
  const results = new Array(run.length);
  let i = 0, done = 0, found = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(pool, run.length)) }, async () => {
    while (i < run.length) {
      const idx = i++;
      const r = await probeSite(run[idx], username, probe, { timeout, maxBytes });
      results[idx] = r;
      done++; if (r.status === 'found') found++;
      if (onProgress) { try { onProgress({ done, total: run.length, found, platform: r.platform, status: r.status }); } catch { /* observer errors never abort the run */ } }
    }
  });
  await Promise.all(workers);
  return { results, skipped, total: run.length };
}
