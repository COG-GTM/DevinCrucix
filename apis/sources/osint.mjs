// OSINT selector tools — on-demand lookups for the Investigations workbench.
// Each tool takes one validated selector and returns a structured, client-safe
// object. Keyless sources always run; keyed sources activate when their env var
// is set. Nothing here is part of the recurring sweep.
//
// Selectors:  email · username · phone · url · btc / eth wallet
// Enrichers:  IP geolocation (ipwho.is) · Wayback Machine · AlienVault OTX ·
//             urlscan.io · Tor exit list · HTTP fingerprint · OFAC crypto list
// Keyed:      HIBP_API_KEY · NUMVERIFY_API_KEY · GITHUB_TOKEN · OPENSANCTIONS_API_KEY

import { isIP } from 'net';
import { createHash } from 'crypto';
import { safeFetch } from '../utils/fetch.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Crucix/1.0 OSINT';

export const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,38})$/i;
export const PHONE_RE = /^\+?[0-9][0-9 .()-]{5,24}$/;
export const URL_RE = /^https?:\/\/[^\s<>"'`\\]{3,2000}$/i;
export const BTC_RE = /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
export const ETH_RE = /^0x[a-fA-F0-9]{40}$/;

function providerError(source, raw) {
  console.error(`[OSINT] ${source}: ${String(raw).slice(0, 300)}`);
  const m = /HTTP (\d{3})/.exec(String(raw));
  const code = m ? Number(m[1]) : 0;
  if (code === 401 || code === 403) return 'authentication rejected';
  if (code === 404) return 'not found';
  if (code === 429) return 'rate limited';
  if (code >= 500) return 'upstream error';
  if (/timeout|aborted/i.test(String(raw))) return 'timed out';
  return 'unavailable';
}

// Bounded fetch that returns status + a slice of the body instead of throwing.
async function probe(url, { timeout = 8000, method = 'GET', headers = {}, maxBytes = 65536, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, redirect, signal: controller.signal, headers: { 'User-Agent': UA, Accept: '*/*', ...headers } });
    let body = '';
    if (method !== 'HEAD' && res.body) {
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      while (got < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
      }
      reader.cancel().catch(() => {});
      body = Buffer.concat(chunks).toString('utf8');
    }
    return { ok: true, status: res.status, headers: res.headers, body, url: res.url };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timed out' : 'unreachable', headers: new Headers(), body: '' };
  } finally { clearTimeout(timer); }
}

// ─── SSRF guard ─────────────────────────────────────────────────────────────

const DOH = 'https://cloudflare-dns.com/dns-query';

function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:');
  }
  return true;
}

// Resolve a hostname via DoH and refuse anything that lands on a private network.
export async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'empty host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return { ok: false, reason: 'internal hostname' };
  if (isIP(host)) return isPrivateIp(host) ? { ok: false, reason: 'private address' } : { ok: true, ips: [host] };
  const ips = [];
  for (const type of ['A', 'AAAA']) {
    const data = await safeFetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { timeout: 6000, retries: 0, headers: { Accept: 'application/dns-json' } });
    for (const a of data.Answer || []) if (isIP(a.data)) ips.push(a.data);
  }
  if (!ips.length) return { ok: false, reason: 'does not resolve' };
  if (ips.some(isPrivateIp)) return { ok: false, reason: 'resolves to private address' };
  return { ok: true, ips };
}

// ─── Enrichers (shared by domain / IP / URL dossiers) ───────────────────────

export async function geolocate(ip) {
  const data = await safeFetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { timeout: 8000, retries: 0 });
  if (data.error || data.success === false) return { error: providerError('ipwho.is', data.error || data.message || 'no data') };
  return {
    country: data.country || null, countryCode: data.country_code || null, region: data.region || null, city: data.city || null,
    lat: typeof data.latitude === 'number' ? data.latitude : null, lon: typeof data.longitude === 'number' ? data.longitude : null,
    asn: data.connection?.asn || null, org: data.connection?.org || null, isp: data.connection?.isp || null, asDomain: data.connection?.domain || null,
    timezone: data.timezone?.id || null,
  };
}

export async function wayback(target) {
  const [first, last] = await Promise.all([
    safeFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}&timestamp=19960101`, { timeout: 10000, retries: 0 }),
    safeFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, { timeout: 10000, retries: 0 }),
  ]);
  if (first.error && last.error) return { error: providerError('Wayback', first.error) };
  const ts = t => t ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
  const f = first.archived_snapshots?.closest, l = last.archived_snapshots?.closest;
  return { firstSeen: ts(f?.timestamp), lastSeen: ts(l?.timestamp), firstUrl: f?.url || null, lastUrl: l?.url || null, archived: !!(f || l) };
}

export async function otx(kind, value) {
  const path = { domain: 'domain', ip: isIP(value) === 6 ? 'IPv6' : 'IPv4', url: 'url', hash: 'file' }[kind];
  if (!path) return null;
  const data = await safeFetch(`https://otx.alienvault.com/api/v1/indicators/${path}/${encodeURIComponent(value)}/general`, { timeout: 15000, retries: 0 });
  if (data.error) return { error: providerError('OTX', data.error) };
  const pulses = data.pulse_info?.pulses || [];
  const tags = new Map();
  for (const p of pulses) for (const t of p.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  const validation = (data.validation || []).map(v => String(v.message || '')).slice(0, 3);
  return {
    pulseCount: data.pulse_info?.count || 0,
    whitelisted: validation.some(v => /whitelist/i.test(v)),
    pulses: pulses.slice(0, 8).map(p => ({ name: String(p.name || '').slice(0, 120), created: p.created || null, adversary: p.adversary || null, malwareFamilies: (p.malware_families || []).map(m => m.display_name || m).slice(0, 4) })),
    topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t),
    adversaries: [...new Set(pulses.map(p => p.adversary).filter(Boolean))].slice(0, 6),
    malwareFamilies: [...new Set(pulses.flatMap(p => (p.malware_families || []).map(m => m.display_name || m)))].slice(0, 8),
    validation,
  };
}

export async function urlscan(domain) {
  const data = await safeFetch(`https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(domain)}&size=10`, { timeout: 12000, retries: 0 });
  if (data.error) return { error: providerError('urlscan', data.error) };
  const results = data.results || [];
  return {
    total: data.total || results.length,
    scans: results.slice(0, 8).map(r => ({
      url: String(r.page?.url || r.task?.url || '').slice(0, 200), title: String(r.page?.title || '').slice(0, 100), time: r.task?.time || null,
      ip: r.page?.ip || null, server: r.page?.server || null, country: r.page?.country || null, tags: (r.task?.tags || []).slice(0, 4),
      domainAgeDays: r.page?.domainAgeDays ?? null, result: r.result || null,
    })),
  };
}

let _torCache = { ts: 0, set: new Set() };
export async function torExitCheck(ip) {
  if (Date.now() - _torCache.ts > 6 * 3600 * 1000) {
    const data = await safeFetch('https://check.torproject.org/torbulkexitlist', { timeout: 15000, retries: 0 });
    if (!data.error && data.rawText) _torCache = { ts: Date.now(), set: new Set(data.rawText.split('\n').map(s => s.trim()).filter(Boolean)) };
  }
  return { isTorExit: _torCache.set.has(ip), listSize: _torCache.set.size };
}

const SECURITY_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
const TECH_HINTS = [
  [/cloudflare/i, 'Cloudflare'], [/nginx/i, 'nginx'], [/apache/i, 'Apache'], [/microsoft-iis/i, 'IIS'], [/litespeed/i, 'LiteSpeed'], [/openresty/i, 'OpenResty'],
  [/akamai/i, 'Akamai'], [/vercel/i, 'Vercel'], [/netlify/i, 'Netlify'], [/gws|google/i, 'Google'], [/amazons3|awselb|cloudfront/i, 'AWS'], [/fly\.io|fly-request-id/i, 'Fly.io'],
];

// Fetch the landing page (bounded) and summarise server + security posture.
export async function httpFingerprint(url) {
  const r = await probe(url, { timeout: 10000, maxBytes: 65536 });
  if (!r.ok) return { error: r.error };
  const h = r.headers;
  const techs = new Set();
  const hdrBlob = ['server', 'x-powered-by', 'via', 'x-served-by', 'x-vercel-id', 'x-nf-request-id', 'fly-request-id', 'cf-ray', 'x-amz-cf-id', 'x-github-request-id'].map(k => `${k}:${h.get(k) || ''}`).join(' ');
  for (const [re, name] of TECH_HINTS) if (re.test(hdrBlob)) techs.add(name);
  if (h.get('x-powered-by')) techs.add(String(h.get('x-powered-by')).slice(0, 40));
  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,60})/i.exec(r.body);
  if (gen) techs.add(gen[1]);
  if (/wp-content|wp-includes/i.test(r.body)) techs.add('WordPress');
  if (/__NEXT_DATA__|_next\/static/i.test(r.body)) techs.add('Next.js');
  if (/react|data-reactroot/i.test(r.body) && !techs.has('Next.js')) techs.add('React');
  if (/shopify/i.test(r.body)) techs.add('Shopify');
  const title = /<title[^>]*>([^<]{0,200})/i.exec(r.body)?.[1]?.trim() || null;
  const present = SECURITY_HEADERS.filter(k => h.has(k));
  const grade = present.length >= 5 ? 'A' : present.length >= 4 ? 'B' : present.length >= 2 ? 'C' : present.length ? 'D' : 'F';
  return {
    status: r.status, finalUrl: r.url && r.url !== url ? r.url : null, title,
    server: h.get('server') || null, contentType: (h.get('content-type') || '').split(';')[0] || null,
    technologies: [...techs].slice(0, 10),
    securityHeaders: { present, missing: SECURITY_HEADERS.filter(k => !h.has(k)), grade },
    cookies: (h.getSetCookie ? h.getSetCookie() : []).length,
  };
}

// ─── Email ──────────────────────────────────────────────────────────────────

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com', 'tuta.io', 'zoho.com', 'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'fastmail.com', 'hey.com', 'qq.com', '163.com', '126.com']);
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'sharklasers.com', 'grr.la', 'mohmal.com', 'fakeinbox.com', 'emailondeck.com', 'mintemail.com', 'tempr.email', 'discard.email', 'spamgourmet.com', 'mailnesia.com', 'burnermail.io', 'tmpmail.net', 'tempail.com', 'moakt.com', 'inboxkitten.com', 'mailsac.com', 'harakirimail.com', 'anonaddy.com']);

async function dohRecords(name, type) {
  const data = await safeFetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { timeout: 8000, retries: 0, headers: { Accept: 'application/dns-json' } });
  return (data.Answer || []).map(a => String(a.data).replace(/^"|"$/g, ''));
}

export async function gravatar(email) {
  const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  const [avatar, profile] = await Promise.all([
    probe(`https://www.gravatar.com/avatar/${hash}?d=404`, { method: 'HEAD', timeout: 8000 }),
    safeFetch(`https://en.gravatar.com/${hash}.json`, { timeout: 8000, retries: 0 }),
  ]);
  const entry = profile.entry?.[0];
  return {
    hash,
    hasAvatar: avatar.status === 200,
    profile: entry ? {
      username: entry.preferredUsername || null, displayName: entry.displayName || null, location: entry.currentLocation || null,
      about: String(entry.aboutMe || '').slice(0, 300) || null, profileUrl: entry.profileUrl || null, jobTitle: entry.job_title || null, company: entry.company || null,
      accounts: (entry.accounts || []).map(a => ({ service: a.shortname || a.name, url: a.url, handle: a.username || a.display || null })).slice(0, 12),
      urls: (entry.urls || []).map(u => u.value).slice(0, 8),
    } : null,
  };
}

async function keybaseLookup(field, value) {
  const data = await safeFetch(`https://keybase.io/_/api/1.0/user/lookup.json?${field}=${encodeURIComponent(value)}&fields=basics,profile,proofs_summary`, { timeout: 10000, retries: 0 });
  if (data.error) return { error: providerError('Keybase', data.error), users: [] };
  const them = (data.them || []).filter(Boolean);
  return {
    users: them.slice(0, 5).map(u => ({
      username: u.basics?.username || null, fullName: u.profile?.full_name || null, location: u.profile?.location || null, bio: String(u.profile?.bio || '').slice(0, 200) || null,
      proofs: Object.entries(u.proofs_summary?.by_presentation_group || {}).flatMap(([svc, arr]) => arr.map(p => ({ service: svc, handle: p.nametag, url: p.service_url }))).slice(0, 12),
    })),
  };
}

async function hibp(email) {
  const key = process.env.HIBP_API_KEY;
  if (!key) return { status: 'no_key' };
  const r = await probe(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`, { timeout: 12000, headers: { 'hibp-api-key': key } });
  if (!r.ok) return { status: 'error', error: r.error };
  if (r.status === 404) return { status: 'ok', breaches: [], total: 0 };
  if (r.status !== 200) return { status: 'error', error: providerError('HIBP', `HTTP ${r.status}`) };
  let list = [];
  try { list = JSON.parse(r.body); } catch { return { status: 'error', error: 'unavailable' }; }
  return {
    status: 'ok', total: list.length,
    breaches: list.sort((a, b) => new Date(b.BreachDate) - new Date(a.BreachDate)).slice(0, 25).map(b => ({ name: b.Name, title: b.Title, domain: b.Domain, date: b.BreachDate, pwnCount: b.PwnCount, dataClasses: (b.DataClasses || []).slice(0, 8), verified: b.IsVerified, sensitive: b.IsSensitive })),
  };
}

export async function investigateEmail(email) {
  const [local, domain] = email.split('@');
  const [mx, txt, dmarc, grav, kb, breaches, wb] = await Promise.all([
    dohRecords(domain, 'MX'), dohRecords(domain, 'TXT'), dohRecords(`_dmarc.${domain}`, 'TXT'), gravatar(email), keybaseLookup('email', email), hibp(email), wayback(domain),
  ]);
  const mxHosts = mx.map(m => m.split(' ').pop().replace(/\.$/, '').toLowerCase()).filter(Boolean);
  const provider = mxHosts.some(h => /google|googlemail/.test(h)) ? 'Google Workspace / Gmail' : mxHosts.some(h => /outlook|microsoft/.test(h)) ? 'Microsoft 365 / Outlook' : mxHosts.some(h => /protonmail|proton\.ch/.test(h)) ? 'Proton Mail' : mxHosts.some(h => /zoho/.test(h)) ? 'Zoho' : mxHosts.some(h => /yahoodns/.test(h)) ? 'Yahoo' : mxHosts.some(h => /icloud|apple/.test(h)) ? 'iCloud' : mxHosts.some(h => /mimecast|pphosted|proofpoint/.test(h)) ? 'Proofpoint / Mimecast (corporate)' : mxHosts.some(h => /messagelabs|barracuda|mailgun|sendgrid|fastmail/.test(h)) ? 'Hosted relay' : mxHosts.length ? 'Self-hosted / other' : 'none';
  const plusTag = local.includes('+') ? local.split('+')[1] : null;
  const derivedHandle = local.split('+')[0].replace(/[^a-z0-9._-]/gi, '');
  return {
    local, domain, plusTag,
    deliverable: mxHosts.length > 0,
    mx: mxHosts.slice(0, 6), provider,
    freeProvider: FREE_MAIL.has(domain), disposable: DISPOSABLE.has(domain),
    spf: txt.find(t => /^v=spf1/i.test(t)) || null, dmarc: dmarc.find(t => /^v=DMARC1/i.test(t)) || null,
    gravatar: grav, keybase: kb, breaches, domainHistory: wb,
    pivots: { domain, username: USERNAME_RE.test(derivedHandle) && derivedHandle.length >= 3 ? derivedHandle : null },
  };
}

// ─── Username ───────────────────────────────────────────────────────────────

// Presence checks. `ok` decides whether a response means the handle exists.
// Only platforms whose public responses reliably distinguish found/not-found are listed.
export const PLATFORMS = [
  { name: 'GitHub', cat: 'dev', url: u => `https://github.com/${u}`, check: u => `https://api.github.com/users/${u}`, ok: r => r.status === 200 },
  { name: 'GitLab', cat: 'dev', url: u => `https://gitlab.com/${u}`, check: u => `https://gitlab.com/api/v4/users?username=${u}`, ok: r => r.status === 200 && r.body.trim() !== '[]' },
  { name: 'Docker Hub', cat: 'dev', url: u => `https://hub.docker.com/u/${u}`, check: u => `https://hub.docker.com/v2/users/${u}`, ok: r => r.status === 200 },
  { name: 'PyPI', cat: 'dev', url: u => `https://pypi.org/user/${u}/`, ok: r => r.status === 200 && !/no projects|Not Found|404/i.test(r.body.slice(0, 20000)) && /Projects|projects/.test(r.body) },
  { name: 'Dev.to', cat: 'dev', url: u => `https://dev.to/${u}`, check: u => `https://dev.to/api/users/by_username?url=${u}`, ok: r => r.status === 200 },
  { name: 'Replit', cat: 'dev', url: u => `https://replit.com/@${u}`, ok: r => r.status === 200 },
  { name: 'HackerOne', cat: 'dev', url: u => `https://hackerone.com/${u}`, ok: r => r.status === 200 },
  { name: 'Kaggle', cat: 'dev', url: u => `https://www.kaggle.com/${u}`, ok: r => r.status === 200 },
  { name: 'Hacker News', cat: 'social', url: u => `https://news.ycombinator.com/user?id=${u}`, check: u => `https://hacker-news.firebaseio.com/v0/user/${u}.json`, ok: r => r.status === 200 && r.body.trim() !== 'null' },
  { name: 'Keybase', cat: 'social', url: u => `https://keybase.io/${u}`, check: u => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${u}&fields=basics`, ok: r => r.status === 200 && /"username"/.test(r.body) },
  { name: 'X / Twitter', cat: 'social', url: u => `https://x.com/${u}`, ok: r => r.status === 200 },
  { name: 'Mastodon.social', cat: 'social', url: u => `https://mastodon.social/@${u}`, check: u => `https://mastodon.social/api/v1/accounts/lookup?acct=${u}`, ok: r => r.status === 200 },
  { name: 'Bluesky', cat: 'social', url: u => `https://bsky.app/profile/${u}.bsky.social`, check: u => `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${u}.bsky.social`, ok: r => r.status === 200 },
  { name: 'Telegram', cat: 'social', url: u => `https://t.me/${u}`, ok: r => r.status === 200 && /tgme_page_title/.test(r.body) && !/og:title" content="Telegram: Contact @/.test(r.body) },
  { name: 'YouTube', cat: 'media', url: u => `https://www.youtube.com/@${u}`, ok: r => r.status === 200 },
  { name: 'Snapchat', cat: 'social', url: u => `https://www.snapchat.com/add/${u}`, ok: r => r.status === 200 },
  { name: 'Patreon', cat: 'social', url: u => `https://www.patreon.com/${u}`, ok: r => r.status === 200 },
  { name: 'about.me', cat: 'social', url: u => `https://about.me/${u}`, ok: r => r.status === 200 },
  { name: 'Wikipedia', cat: 'social', url: u => `https://en.wikipedia.org/wiki/User:${u}`, check: u => `https://en.wikipedia.org/w/api.php?action=query&list=users&ususers=${u}&format=json`, ok: r => r.status === 200 && !/"missing"|"invalid"/.test(r.body) },
  { name: 'SoundCloud', cat: 'media', url: u => `https://soundcloud.com/${u}`, ok: r => r.status === 200 },
  { name: 'Spotify', cat: 'media', url: u => `https://open.spotify.com/user/${u}`, ok: r => r.status === 200 },
  { name: 'Vimeo', cat: 'media', url: u => `https://vimeo.com/${u}`, ok: r => r.status === 200 },
  { name: 'Flickr', cat: 'media', url: u => `https://www.flickr.com/people/${u}`, ok: r => r.status === 200 },
  { name: 'DeviantArt', cat: 'media', url: u => `https://www.deviantart.com/${u}`, ok: r => r.status === 200 },
  { name: 'Behance', cat: 'media', url: u => `https://www.behance.net/${u}`, ok: r => r.status === 200 },
  { name: 'Dribbble', cat: 'media', url: u => `https://dribbble.com/${u}`, ok: r => r.status === 200 },
  { name: 'Letterboxd', cat: 'media', url: u => `https://letterboxd.com/${u}/`, ok: r => r.status === 200 },
  { name: 'MyAnimeList', cat: 'media', url: u => `https://myanimelist.net/profile/${u}`, ok: r => r.status === 200 },
  { name: 'Wattpad', cat: 'media', url: u => `https://www.wattpad.com/user/${u}`, ok: r => r.status === 200 },
  { name: 'Pastebin', cat: 'paste', url: u => `https://pastebin.com/u/${u}`, ok: r => r.status === 200 },
  { name: 'Chess.com', cat: 'gaming', url: u => `https://www.chess.com/member/${u}`, check: u => `https://api.chess.com/pub/player/${u}`, ok: r => r.status === 200 },
  { name: 'Lichess', cat: 'gaming', url: u => `https://lichess.org/@/${u}`, check: u => `https://lichess.org/api/user/${u}`, ok: r => r.status === 200 },
  { name: 'Roblox', cat: 'gaming', url: u => `https://www.roblox.com/users/profile?username=${u}`, ok: r => r.status === 200 },
  { name: 'Steam', cat: 'gaming', url: u => `https://steamcommunity.com/id/${u}`, ok: r => r.status === 200 && !/could not be found/i.test(r.body) },
  { name: 'Duolingo', cat: 'other', url: u => `https://www.duolingo.com/profile/${u}`, check: u => `https://www.duolingo.com/2017-06-30/users?username=${u}`, ok: r => r.status === 200 && !/"users":\s*\[\]/.test(r.body) },
  { name: 'Strava', cat: 'other', url: u => `https://www.strava.com/athletes/${u}`, ok: r => r.status === 200 },
  { name: 'Buy Me a Coffee', cat: 'other', url: u => `https://www.buymeacoffee.com/${u}`, ok: r => r.status === 200 },
];

async function githubProfile(username) {
  const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const user = await safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}`, { timeout: 10000, retries: 0, headers });
  if (user.error) return /HTTP 404/.test(user.error) ? { status: 'not_found' } : { status: 'error', error: providerError('GitHub', user.error) };
  const [repos, events] = await Promise.all([
    safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=30`, { timeout: 10000, retries: 0, headers }),
    safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`, { timeout: 10000, retries: 0, headers }),
  ]);
  const emails = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    for (const c of e.payload?.commits || []) {
      const em = String(c.author?.email || '').toLowerCase();
      if (em && !em.endsWith('@users.noreply.github.com') && EMAIL_RE.test(em)) emails.set(em, (emails.get(em) || 0) + 1);
    }
  }
  const langs = new Map();
  for (const r of Array.isArray(repos) ? repos : []) if (r.language) langs.set(r.language, (langs.get(r.language) || 0) + 1);
  return {
    status: 'ok', login: user.login, name: user.name || null, company: user.company || null, location: user.location || null, blog: user.blog || null, email: user.email || null,
    bio: String(user.bio || '').slice(0, 200) || null, twitter: user.twitter_username || null, publicRepos: user.public_repos, followers: user.followers, following: user.following,
    created: user.created_at || null, updated: user.updated_at || null, avatar: user.avatar_url || null, url: user.html_url,
    languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l),
    topRepos: (Array.isArray(repos) ? repos : []).slice(0, 6).map(r => ({ name: r.name, stars: r.stargazers_count, language: r.language, pushed: r.pushed_at, description: String(r.description || '').slice(0, 100) })),
    commitEmails: [...emails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([email, n]) => ({ email, commits: n })),
    eventCount: Array.isArray(events) ? events.length : 0,
  };
}

export async function investigateUsername(username) {
  const u = encodeURIComponent(username);
  const pool = 8; let i = 0;
  const results = new Array(PLATFORMS.length);
  await Promise.all(Array.from({ length: pool }, async () => {
    while (i < PLATFORMS.length) {
      const idx = i++; const p = PLATFORMS[idx];
      const r = await probe(p.check ? p.check(u) : p.url(u), { timeout: 9000, maxBytes: 48 * 1024 });
      results[idx] = { platform: p.name, category: p.cat, url: p.url(u), status: !r.ok ? 'error' : p.ok(r) ? 'found' : 'not_found', http: r.status || null };
    }
  }));
  const [gh, kb, grav] = await Promise.all([githubProfile(username), keybaseLookup('usernames', username), safeFetch(`https://en.gravatar.com/${u}.json`, { timeout: 8000, retries: 0 })]);
  const g = grav.entry?.[0];
  const found = results.filter(r => r.status === 'found');
  return {
    checked: results.length, foundCount: found.length, errorCount: results.filter(r => r.status === 'error').length,
    platforms: results.sort((a, b) => (a.status === 'found' ? 0 : a.status === 'error' ? 2 : 1) - (b.status === 'found' ? 0 : b.status === 'error' ? 2 : 1)),
    github: gh, keybase: kb,
    gravatar: g ? { displayName: g.displayName || null, location: g.currentLocation || null, about: String(g.aboutMe || '').slice(0, 200) || null, accounts: (g.accounts || []).map(a => ({ service: a.shortname || a.name, url: a.url })).slice(0, 10), profileUrl: g.profileUrl || null } : null,
    variants: [...new Set([username.toLowerCase(), username.replace(/[._-]/g, ''), username.replace(/[._]/g, '-'), username.replace(/[-.]/g, '_'), `${username}1`, `${username}_`, `_${username}`, `real${username}`, `${username}official`].filter(v => v !== username && USERNAME_RE.test(v)))].slice(0, 8),
  };
}

// ─── Phone ──────────────────────────────────────────────────────────────────

// Country calling codes (longest-prefix match). Enough coverage for triage; NumVerify adds carrier/line type.
const CALLING_CODES = [
  ['1', 'US / Canada (NANP)', 'US'], ['7', 'Russia / Kazakhstan', 'RU'], ['20', 'Egypt', 'EG'], ['27', 'South Africa', 'ZA'], ['30', 'Greece', 'GR'], ['31', 'Netherlands', 'NL'], ['32', 'Belgium', 'BE'], ['33', 'France', 'FR'], ['34', 'Spain', 'ES'], ['36', 'Hungary', 'HU'], ['39', 'Italy', 'IT'], ['40', 'Romania', 'RO'], ['41', 'Switzerland', 'CH'], ['43', 'Austria', 'AT'], ['44', 'United Kingdom', 'GB'], ['45', 'Denmark', 'DK'], ['46', 'Sweden', 'SE'], ['47', 'Norway', 'NO'], ['48', 'Poland', 'PL'], ['49', 'Germany', 'DE'],
  ['51', 'Peru', 'PE'], ['52', 'Mexico', 'MX'], ['53', 'Cuba', 'CU'], ['54', 'Argentina', 'AR'], ['55', 'Brazil', 'BR'], ['56', 'Chile', 'CL'], ['57', 'Colombia', 'CO'], ['58', 'Venezuela', 'VE'], ['60', 'Malaysia', 'MY'], ['61', 'Australia', 'AU'], ['62', 'Indonesia', 'ID'], ['63', 'Philippines', 'PH'], ['64', 'New Zealand', 'NZ'], ['65', 'Singapore', 'SG'], ['66', 'Thailand', 'TH'], ['81', 'Japan', 'JP'], ['82', 'South Korea', 'KR'], ['84', 'Vietnam', 'VN'], ['86', 'China', 'CN'], ['90', 'Turkey', 'TR'], ['91', 'India', 'IN'], ['92', 'Pakistan', 'PK'], ['93', 'Afghanistan', 'AF'], ['94', 'Sri Lanka', 'LK'], ['95', 'Myanmar', 'MM'], ['98', 'Iran', 'IR'],
  ['212', 'Morocco', 'MA'], ['213', 'Algeria', 'DZ'], ['216', 'Tunisia', 'TN'], ['218', 'Libya', 'LY'], ['220', 'Gambia', 'GM'], ['221', 'Senegal', 'SN'], ['223', 'Mali', 'ML'], ['225', 'Ivory Coast', 'CI'], ['226', 'Burkina Faso', 'BF'], ['227', 'Niger', 'NE'], ['228', 'Togo', 'TG'], ['229', 'Benin', 'BJ'], ['233', 'Ghana', 'GH'], ['234', 'Nigeria', 'NG'], ['235', 'Chad', 'TD'], ['236', 'Central African Rep.', 'CF'], ['237', 'Cameroon', 'CM'], ['241', 'Gabon', 'GA'], ['242', 'Congo', 'CG'], ['243', 'DR Congo', 'CD'], ['244', 'Angola', 'AO'], ['249', 'Sudan', 'SD'], ['250', 'Rwanda', 'RW'], ['251', 'Ethiopia', 'ET'], ['252', 'Somalia', 'SO'], ['254', 'Kenya', 'KE'], ['255', 'Tanzania', 'TZ'], ['256', 'Uganda', 'UG'], ['260', 'Zambia', 'ZM'], ['263', 'Zimbabwe', 'ZW'],
  ['351', 'Portugal', 'PT'], ['352', 'Luxembourg', 'LU'], ['353', 'Ireland', 'IE'], ['354', 'Iceland', 'IS'], ['355', 'Albania', 'AL'], ['356', 'Malta', 'MT'], ['357', 'Cyprus', 'CY'], ['358', 'Finland', 'FI'], ['359', 'Bulgaria', 'BG'], ['370', 'Lithuania', 'LT'], ['371', 'Latvia', 'LV'], ['372', 'Estonia', 'EE'], ['373', 'Moldova', 'MD'], ['374', 'Armenia', 'AM'], ['375', 'Belarus', 'BY'], ['380', 'Ukraine', 'UA'], ['381', 'Serbia', 'RS'], ['385', 'Croatia', 'HR'], ['386', 'Slovenia', 'SI'], ['387', 'Bosnia', 'BA'], ['389', 'North Macedonia', 'MK'], ['420', 'Czechia', 'CZ'], ['421', 'Slovakia', 'SK'],
  ['501', 'Belize', 'BZ'], ['502', 'Guatemala', 'GT'], ['503', 'El Salvador', 'SV'], ['504', 'Honduras', 'HN'], ['505', 'Nicaragua', 'NI'], ['506', 'Costa Rica', 'CR'], ['507', 'Panama', 'PA'], ['509', 'Haiti', 'HT'], ['591', 'Bolivia', 'BO'], ['593', 'Ecuador', 'EC'], ['595', 'Paraguay', 'PY'], ['598', 'Uruguay', 'UY'],
  ['852', 'Hong Kong', 'HK'], ['853', 'Macau', 'MO'], ['855', 'Cambodia', 'KH'], ['856', 'Laos', 'LA'], ['880', 'Bangladesh', 'BD'], ['886', 'Taiwan', 'TW'], ['960', 'Maldives', 'MV'], ['961', 'Lebanon', 'LB'], ['962', 'Jordan', 'JO'], ['963', 'Syria', 'SY'], ['964', 'Iraq', 'IQ'], ['965', 'Kuwait', 'KW'], ['966', 'Saudi Arabia', 'SA'], ['967', 'Yemen', 'YE'], ['968', 'Oman', 'OM'], ['970', 'Palestine', 'PS'], ['971', 'UAE', 'AE'], ['972', 'Israel', 'IL'], ['973', 'Bahrain', 'BH'], ['974', 'Qatar', 'QA'], ['975', 'Bhutan', 'BT'], ['976', 'Mongolia', 'MN'], ['977', 'Nepal', 'NP'], ['992', 'Tajikistan', 'TJ'], ['993', 'Turkmenistan', 'TM'], ['994', 'Azerbaijan', 'AZ'], ['995', 'Georgia', 'GE'], ['996', 'Kyrgyzstan', 'KG'], ['998', 'Uzbekistan', 'UZ'],
];
const NANP_TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);
const NANP_PREMIUM = new Set(['900', '976']);

export async function investigatePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  const hadPlus = raw.trim().startsWith('+');
  // Without a leading +, a 10-digit number is assumed NANP.
  const e164 = hadPlus ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.startsWith('00') ? `+${digits.slice(2)}` : `+${digits}`;
  const national = e164.slice(1);
  const match = CALLING_CODES.filter(([cc]) => national.startsWith(cc)).sort((a, b) => b[0].length - a[0].length)[0];
  const valid = national.length >= 7 && national.length <= 15 && !!match;
  const subscriber = match ? national.slice(match[0].length) : national;
  let lineType = 'unknown';
  const flags = [];
  if (match?.[0] === '1') {
    const npa = subscriber.slice(0, 3);
    if (NANP_TOLL_FREE.has(npa)) { lineType = 'toll-free'; flags.push('Toll-free NANP range'); }
    else if (NANP_PREMIUM.has(npa)) { lineType = 'premium-rate'; flags.push('Premium-rate NANP range'); }
    else if (subscriber.length !== 10) flags.push('NANP numbers should have 10 national digits');
    else if (/^[01]/.test(npa) || subscriber[3] === '0' || subscriber[3] === '1') flags.push('Invalid NANP area/exchange code');
    else if (subscriber.slice(3, 6) === '555') flags.push('555 fictional / directory exchange');
  } else if (match) {
    if (['44', '33', '49', '34', '39', '61', '91', '86', '81'].includes(match[0])) {
      const mobilePrefix = { '44': /^7/, '33': /^[67]/, '49': /^1[5-7]/, '34': /^[67]/, '39': /^3/, '61': /^4/, '91': /^[6-9]/, '86': /^1[3-9]/, '81': /^[789]0/ }[match[0]];
      lineType = mobilePrefix.test(subscriber) ? 'mobile' : 'landline / other';
    }
  }
  if (/^(\d)\1{6,}$/.test(subscriber)) flags.push('Repeated-digit subscriber number');
  const numverify = await (async () => {
    const key = process.env.NUMVERIFY_API_KEY;
    if (!key) return { status: 'no_key' };
    const data = await safeFetch(`https://apilayer.net/api/validate?access_key=${encodeURIComponent(key)}&number=${encodeURIComponent(national)}`, { timeout: 10000, retries: 0 });
    if (data.error || data.success === false) return { status: 'error', error: providerError('NumVerify', (data.error || data.error?.info || 'unavailable').toString().replaceAll(key, '***')) };
    return { status: 'ok', valid: data.valid, carrier: data.carrier || null, lineType: data.line_type || null, location: data.location || null, country: data.country_name || null, international: data.international_format || null };
  })();
  return {
    e164, national, valid, countryCode: match ? `+${match[0]}` : null, country: match?.[1] || 'Unknown', iso: match?.[2] || null,
    lineType: numverify.status === 'ok' && numverify.lineType ? numverify.lineType : lineType, flags, numverify,
    pivots: {
      whatsapp: `https://wa.me/${national}`, telegram: `https://t.me/${e164}`, truecaller: `https://www.truecaller.com/search/${(match?.[2] || 'us').toLowerCase()}/${national}`,
      google: `https://www.google.com/search?q=%22${encodeURIComponent(e164)}%22`, sync: `https://sync.me/search/?number=${national}`,
    },
  };
}

// ─── URL ────────────────────────────────────────────────────────────────────

const SUSPICIOUS_TLDS = new Set(['zip', 'mov', 'top', 'xyz', 'tk', 'ml', 'ga', 'cf', 'gq', 'work', 'click', 'link', 'rest', 'cam', 'icu', 'buzz', 'monster', 'quest', 'cfd', 'sbs', 'bond']);
const PHISH_WORDS = /login|signin|verify|verification|secure|account|update|confirm|password|wallet|invoice|billing|suspend|unlock|bonus|prize|support|helpdesk|webmail|docusign|sharepoint|onedrive|dropbox|paypal|apple|microsoft|office365|bank|irs|ssa/i;
const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 't.ly', 'rb.gy', 'lnkd.in', 'tiny.cc', 's.id', 'v.gd', 'qr.ae', 'tr.im']);

function urlHeuristics(u) {
  const flags = [];
  const host = u.hostname.toLowerCase();
  const tld = host.split('.').pop();
  if (isIP(host.replace(/^\[|\]$/g, ''))) flags.push('Raw IP address instead of hostname');
  if (host.startsWith('xn--') || host.includes('.xn--')) flags.push('Punycode / IDN hostname (homoglyph risk)');
  if (u.username || u.password) flags.push('Credentials embedded in URL (@ trick)');
  if (host.split('.').length >= 5) flags.push('Deeply nested subdomains');
  if (host.length > 50) flags.push('Unusually long hostname');
  if (SUSPICIOUS_TLDS.has(tld)) flags.push(`High-abuse TLD .${tld}`);
  if (u.protocol === 'http:') flags.push('Cleartext HTTP');
  if (u.port && !['', '80', '443'].includes(u.port)) flags.push(`Non-standard port ${u.port}`);
  if (PHISH_WORDS.test(host) || PHISH_WORDS.test(u.pathname)) flags.push('Credential-lure keywords in host/path');
  if (/[a-z0-9-]+\.(com|net|org)[.-]/.test(host)) flags.push('Brand-like label followed by extra labels (look-alike pattern)');
  if (/%[0-9a-f]{2}/i.test(u.hostname)) flags.push('Percent-encoding in hostname');
  if (u.href.length > 200) flags.push('Very long URL');
  if (/\.(exe|scr|zip|rar|7z|iso|js|vbs|hta|msi|apk|dmg)$/i.test(u.pathname)) flags.push('Direct executable / archive download');
  if (SHORTENERS.has(host)) flags.push('URL shortener (destination hidden)');
  return flags;
}

export async function investigateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { error: 'invalid URL' }; }
  const chain = [];
  let current = u.href;
  let finalResp = null;
  for (let hop = 0; hop < 8; hop++) {
    const cu = new URL(current);
    const guard = await assertPublicHost(cu.hostname);
    if (!guard.ok) { chain.push({ url: current, status: null, blocked: guard.reason }); break; }
    const r = await probe(current, { timeout: 10000, redirect: 'manual', maxBytes: 65536 });
    chain.push({ url: current.slice(0, 300), status: r.status || null, error: r.ok ? null : r.error, server: r.headers.get('server') || null });
    finalResp = r;
    const loc = r.headers.get('location');
    if (r.ok && r.status >= 300 && r.status < 400 && loc) { current = new URL(loc, current).href; continue; }
    break;
  }
  const final = new URL(chain[chain.length - 1].url);
  const heuristics = [...new Set([...urlHeuristics(u), ...(final.href !== u.href ? urlHeuristics(final).map(f => `Destination: ${f}`) : [])])];
  const body = finalResp?.body || '';
  const title = /<title[^>]*>([^<]{0,200})/i.exec(body)?.[1]?.trim() || null;
  const forms = (body.match(/<form\b/gi) || []).length;
  const pwFields = (body.match(/type=["']?password/gi) || []).length;
  if (pwFields) heuristics.push('Password field on landing page');
  const extHosts = new Set();
  for (const m of body.matchAll(/(?:src|action|href)=["']https?:\/\/([a-z0-9.-]+)/gi)) if (m[1] !== final.hostname) extHosts.add(m[1].toLowerCase());
  const h = finalResp?.headers || new Headers();
  const present = SECURITY_HEADERS.filter(k => h.has(k));
  const [otxInfo, scan, wb] = await Promise.all([otx('url', u.href), urlscan(final.hostname), wayback(final.hostname)]);
  const score = Math.min(100, heuristics.length * 12 + (otxInfo?.pulseCount ? 30 : 0) + (pwFields && forms ? 15 : 0));
  return {
    input: u.href.slice(0, 300), scheme: u.protocol.replace(':', ''), host: u.hostname, path: u.pathname.slice(0, 200), query: [...u.searchParams.keys()].slice(0, 12),
    redirects: chain.length - 1, chain, finalUrl: final.href.slice(0, 300), finalHost: final.hostname, finalStatus: finalResp?.status || null,
    page: { title, forms, passwordFields: pwFields, externalHosts: [...extHosts].slice(0, 12), contentType: (h.get('content-type') || '').split(';')[0] || null, server: h.get('server') || null, securityHeaders: { present, missing: SECURITY_HEADERS.filter(k => !h.has(k)) } },
    heuristics, otx: otxInfo, urlscan: scan, history: wb,
    phishScore: score, phishLevel: score >= 60 ? 'critical' : score >= 35 ? 'high' : score >= 15 ? 'elevated' : 'low',
    pivots: { domain: final.hostname.replace(/^www\./, ''), inputDomain: u.hostname.replace(/^www\./, '') },
  };
}

// ─── Crypto wallets ─────────────────────────────────────────────────────────

const OFAC_LISTS = 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_';
let _ofac = { ts: 0, sets: {} };
async function ofacCryptoCheck(chain, address) {
  const sym = chain === 'btc' ? 'XBT' : 'ETH';
  if (Date.now() - _ofac.ts > 24 * 3600 * 1000 || !_ofac.sets[sym]) {
    const data = await safeFetch(`${OFAC_LISTS}${sym}.txt`, { timeout: 15000, retries: 0 });
    if (!data.error && data.rawText) { _ofac.sets[sym] = new Set(data.rawText.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)); _ofac.ts = Date.now(); }
    else if (!_ofac.sets[sym]) return { error: providerError('OFAC list', data.error || 'empty') };
  }
  return { sanctioned: _ofac.sets[sym].has(address.toLowerCase()), listSize: _ofac.sets[sym].size, source: 'OFAC SDN digital currency addresses' };
}

async function opensanctionsWallet(address) {
  const key = process.env.OPENSANCTIONS_API_KEY;
  if (!key) return { status: 'no_key' };
  const data = await safeFetch(`https://api.opensanctions.org/search/default?q=${encodeURIComponent(address)}&limit=5&schema=CryptoWallet`, { timeout: 10000, retries: 0, headers: { Authorization: `ApiKey ${key}` } });
  if (data.error) return { status: 'error', error: providerError('OpenSanctions', data.error) };
  return { status: 'ok', matches: (data.results || []).map(r => ({ id: r.id, caption: r.caption, datasets: (r.datasets || []).slice(0, 4), topics: (r.properties?.topics || []).slice(0, 4), holder: (r.properties?.holder || []).slice(0, 2) })) };
}

export async function investigateWallet(chain, address) {
  if (chain === 'btc') {
    const [addr, txs, price, ofac, os] = await Promise.all([
      safeFetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`, { timeout: 12000, retries: 0 }),
      safeFetch(`https://mempool.space/api/address/${encodeURIComponent(address)}/txs`, { timeout: 12000, retries: 0 }),
      safeFetch('https://mempool.space/api/v1/prices', { timeout: 8000, retries: 0 }),
      ofacCryptoCheck('btc', address), opensanctionsWallet(address),
    ]);
    if (addr.error) return { chain: 'btc', address, error: providerError('mempool.space', addr.error), ofac, opensanctions: os };
    const cs = addr.chain_stats || {}; const ms = addr.mempool_stats || {};
    const sats = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
    const list = Array.isArray(txs) ? txs : [];
    const times = list.map(t => t.status?.block_time).filter(Boolean);
    const counterparties = new Map();
    for (const t of list.slice(0, 25)) {
      for (const vin of t.vin || []) { const a = vin.prevout?.scriptpubkey_address; if (a && a !== address) counterparties.set(a, (counterparties.get(a) || 0) + 1); }
      for (const vout of t.vout || []) { const a = vout.scriptpubkey_address; if (a && a !== address) counterparties.set(a, (counterparties.get(a) || 0) + 1); }
    }
    const type = address.startsWith('bc1p') ? 'P2TR (Taproot)' : address.startsWith('bc1') ? 'P2WPKH/P2WSH (SegWit)' : address.startsWith('3') ? 'P2SH' : 'P2PKH (legacy)';
    return {
      chain: 'btc', address, addressType: type,
      balance: sats / 1e8, balanceUsd: price?.USD ? +(sats / 1e8 * price.USD).toFixed(2) : null,
      totalReceived: (cs.funded_txo_sum || 0) / 1e8, totalSent: (cs.spent_txo_sum || 0) / 1e8, txCount: cs.tx_count || 0, unconfirmedTx: ms.tx_count || 0,
      windowFrom: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null, windowTo: times.length ? new Date(Math.max(...times) * 1000).toISOString() : null, windowTx: list.length,
      recentTx: list.slice(0, 10).map(t => ({ txid: t.txid, time: t.status?.block_time ? new Date(t.status.block_time * 1000).toISOString() : null, confirmed: !!t.status?.confirmed, fee: t.fee, inputs: (t.vin || []).length, outputs: (t.vout || []).length, valueOut: (t.vout || []).reduce((s, v) => s + (v.value || 0), 0) / 1e8 })),
      counterparties: [...counterparties.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, n]) => ({ address: a, interactions: n })),
      ofac, opensanctions: os, explorer: `https://mempool.space/address/${address}`,
    };
  }
  const [bal, ofac, os] = await Promise.all([
    safeFetch(`https://api.blockcypher.com/v1/eth/main/addrs/${address.slice(2).toLowerCase()}/balance`, { timeout: 12000, retries: 0 }),
    ofacCryptoCheck('eth', address), opensanctionsWallet(address),
  ]);
  if (bal.error) return { chain: 'eth', address, error: providerError('BlockCypher', bal.error), ofac, opensanctions: os };
  const wei = n => Number(BigInt(n || 0) / 1000000000000n) / 1e6;
  return {
    chain: 'eth', address, addressType: 'Ethereum account',
    balance: wei(bal.final_balance), totalReceived: wei(bal.total_received), totalSent: wei(bal.total_sent), txCount: bal.final_n_tx || 0, unconfirmedTx: bal.unconfirmed_n_tx || 0,
    ofac, opensanctions: os, explorer: `https://etherscan.io/address/${address}`,
  };
}

// ─── Image metadata (EXIF) — pure JS, JPEG/PNG/WebP/HEIC-agnostic container sniff ─

const EXIF_TAGS = { 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x0132: 'DateTime', 0x010e: 'ImageDescription', 0x013b: 'Artist', 0x8298: 'Copyright', 0x0112: 'Orientation', 0x011a: 'XResolution', 0x011b: 'YResolution', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8827: 'ISO', 0x920a: 'FocalLength', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification', 0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber', 0x9286: 'UserComment', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp', 0x001d: 'GPSDateStamp', 0x0011: 'GPSImgDirection', 0x001b: 'GPSProcessingMethod' };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIfd(buf, tiff, offset, le, out, gps) {
  if (offset + 2 > buf.length) return;
  const rd16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
  const rd32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  const rdS32 = o => le ? buf.readInt32LE(o) : buf.readInt32BE(o);
  const n = Math.min(rd16(offset), 200);
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > buf.length) return;
    const tag = rd16(e), type = rd16(e + 2), count = rd32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * count;
    const valOff = size > 4 ? tiff + rd32(e + 8) : e + 8;
    if (valOff + size > buf.length || size > 65536) continue;
    let val;
    if (type === 2) val = buf.toString('latin1', valOff, valOff + count).replace(/\0+$/, '').trim();
    else if (type === 3) val = count === 1 ? rd16(valOff) : Array.from({ length: Math.min(count, 16) }, (_, k) => rd16(valOff + k * 2));
    else if (type === 4) val = count === 1 ? rd32(valOff) : Array.from({ length: Math.min(count, 16) }, (_, k) => rd32(valOff + k * 4));
    else if (type === 5 || type === 10) val = Array.from({ length: Math.min(count, 16) }, (_, k) => { const a = type === 5 ? rd32(valOff + k * 8) : rdS32(valOff + k * 8), b = type === 5 ? rd32(valOff + k * 8 + 4) : rdS32(valOff + k * 8 + 4); return b ? a / b : 0; });
    else if (type === 1 || type === 7) val = count <= 8 ? Array.from(buf.subarray(valOff, valOff + count)) : `${count} bytes`;
    else continue;
    if (Array.isArray(val) && val.length === 1) val = val[0];
    if (tag === 0x8769 && typeof val === 'number') { readIfd(buf, tiff, tiff + val, le, out, gps); continue; }
    if (tag === 0x8825 && typeof val === 'number') { readIfd(buf, tiff, tiff + val, le, gps, gps); continue; }
    const name = EXIF_TAGS[tag];
    if (name) out[name] = val;
  }
}

function dms(arr, ref) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const v = arr[0] + arr[1] / 60 + arr[2] / 3600;
  return +(ref === 'S' || ref === 'W' ? -v : v).toFixed(6);
}

export function parseImageMetadata(buf) {
  const out = { format: 'unknown', bytes: buf.length, md5: createHash('md5').update(buf).digest('hex'), sha1: createHash('sha1').update(buf).digest('hex'), sha256: createHash('sha256').update(buf).digest('hex'), exif: {}, gps: null, textChunks: [], warnings: [] };
  let exifStart = -1;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    out.format = 'JPEG';
    let p = 2;
    while (p + 4 < buf.length && buf[p] === 0xff) {
      const marker = buf[p + 1], len = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') exifStart = p + 10;
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 33).includes('http://ns.adobe.com/xap/1.0/')) out.xmp = true;
      if (marker === 0xed && buf.toString('latin1', p + 4, p + 18).startsWith('Photoshop 3.0')) out.iptc = true;
      if (marker === 0xc0 || marker === 0xc2) { out.height = buf.readUInt16BE(p + 5); out.width = buf.readUInt16BE(p + 7); }
      if (marker === 0xda) break;
      p += 2 + len;
    }
  } else if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') {
    out.format = 'PNG';
    let p = 8;
    while (p + 8 < buf.length) {
      const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
      if (type === 'IHDR') { out.width = buf.readUInt32BE(p + 8); out.height = buf.readUInt32BE(p + 12); }
      if (type === 'eXIf') exifStart = p + 8;
      if ((type === 'tEXt' || type === 'iTXt') && len < 8192) { const s = buf.toString('utf8', p + 8, p + 8 + len); const [k, ...v] = s.split('\0'); out.textChunks.push({ key: k.slice(0, 40), value: v.join(' ').replace(/\0/g, ' ').slice(0, 300) }); }
      if (type === 'IEND') break;
      p += 12 + len;
    }
  } else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    out.format = 'WebP';
    let p = 12;
    while (p + 8 < buf.length) { const type = buf.toString('latin1', p, p + 4), len = buf.readUInt32LE(p + 4); if (type === 'EXIF') { exifStart = p + 8; if (buf.toString('latin1', exifStart, exifStart + 6) === 'Exif\0\0') exifStart += 6; } p += 8 + len + (len % 2); }
  } else if (buf.toString('latin1', 4, 8) === 'ftyp') {
    out.format = 'HEIC/AVIF/MP4 container';
    out.warnings.push('ISO-BMFF container: EXIF parsing not supported in-browser; use exiftool for full metadata');
  } else if (buf.toString('latin1', 0, 4) === 'GIF8') out.format = 'GIF';
  else if (buf.toString('latin1', 0, 4) === '%PDF') { out.format = 'PDF'; const s = buf.toString('latin1', 0, Math.min(buf.length, 2 * 1024 * 1024)); for (const k of ['Title', 'Author', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Subject']) { const m = new RegExp(`/${k}\\s*\\(([^)]{1,200})\\)`).exec(s); if (m) out.exif[k] = m[1]; } }
  if (exifStart >= 0 && exifStart + 8 <= buf.length) {
    const le = buf.toString('latin1', exifStart, exifStart + 2) === 'II';
    const rd32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const gps = {};
    try { readIfd(buf, exifStart, exifStart + rd32(exifStart + 4), le, out.exif, gps); } catch { out.warnings.push('EXIF block truncated or malformed'); }
    if (gps.GPSLatitude && gps.GPSLongitude) {
      const lat = dms(gps.GPSLatitude, gps.GPSLatitudeRef), lon = dms(gps.GPSLongitude, gps.GPSLongitudeRef);
      if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) out.gps = { lat, lon, altitude: typeof gps.GPSAltitude === 'number' ? +gps.GPSAltitude.toFixed(1) : null, timestamp: gps.GPSDateStamp ? `${gps.GPSDateStamp}${Array.isArray(gps.GPSTimeStamp) ? ' ' + gps.GPSTimeStamp.map(n => String(Math.floor(n)).padStart(2, '0')).join(':') : ''}` : null, direction: typeof gps.GPSImgDirection === 'number' ? Math.round(gps.GPSImgDirection) : null };
    }
  }
  for (const k of Object.keys(out.exif)) if (typeof out.exif[k] === 'string') out.exif[k] = out.exif[k].slice(0, 200);
  const findings = [];
  if (out.gps) findings.push(`GPS coordinates embedded: ${out.gps.lat}, ${out.gps.lon}`);
  if (out.exif.BodySerialNumber || out.exif.LensSerialNumber) findings.push('Camera / lens serial number present (device attribution)');
  if (out.exif.CameraOwnerName || out.exif.Artist) findings.push('Owner / artist name embedded');
  if (out.exif.Software && /photoshop|gimp|lightroom|snapseed|facetune|canva|pixelmator|affinity/i.test(out.exif.Software)) findings.push(`Edited with ${out.exif.Software}`);
  if (out.exif.DateTimeOriginal && out.exif.DateTime && out.exif.DateTimeOriginal !== out.exif.DateTime) findings.push('Modified after capture (DateTime differs from DateTimeOriginal)');
  if (!Object.keys(out.exif).length && !out.gps && ['JPEG', 'PNG', 'WebP'].includes(out.format)) findings.push('No EXIF metadata: likely stripped by a platform (social media re-encode) or screenshot');
  if (out.textChunks.some(t => /parameters|prompt|Comment|Software/i.test(t.key) && /Stable Diffusion|midjourney|DALL|Steps:|Sampler|Negative prompt/i.test(t.value))) findings.push('AI-generation parameters embedded in PNG text chunks');
  out.findings = findings;
  return out;
}

export function osintKeyedStatus() {
  return {
    hibp: !!process.env.HIBP_API_KEY,
    numverify: !!process.env.NUMVERIFY_API_KEY,
    github: !!process.env.GITHUB_TOKEN,
    opensanctions: !!process.env.OPENSANCTIONS_API_KEY,
  };
}
