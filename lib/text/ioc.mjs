// IOC extraction from the text CRUCIX already ingests (ThreatIngestor pattern, ported to zero-dep Node).
//
// Every indicator is a literal string found in a headline, Telegram message or article title held in
// the current sweep — nothing is inferred or enriched here. Defanged forms (hxxp, [.], (dot), [at]) are
// refanged before matching and the original spelling is kept so the analyst can see what the source
// actually wrote. Indicators pivot into the Investigations workbench, which does the enrichment on click.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const IOC_TYPES = ['ip', 'domain', 'url', 'email', 'hash', 'cve', 'btc', 'eth'];
export const MAX_INDICATORS = 300;
export const MAX_CONTEXTS = 3;
export const MAX_SNIPPET = 160;
export const LEDGER_RETENTION_H = 24 * 7;
export const LEDGER_MAX = 5000;
export const RULE = 'Literal matches in feed text after refanging (hxxp → http, [.] → ., [at] → @). Private/reserved IPs, version-like numbers, bare file names and well-known media/social hosts are dropped. A hit is a string in a source, not a verdict.';

// Hosts that appear in news/Telegram text constantly and never mean "indicator".
const NOISE_HOSTS = new Set([
  't.me', 'telegram.me', 'telegram.org', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com',
  'reddit.com', 'linkedin.com', 'wikipedia.org', 'google.com', 'goo.gl', 'bit.ly', 'apple.com', 'microsoft.com', 'github.com', 'medium.com',
  'reuters.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'washingtonpost.com', 'apnews.com', 'aljazeera.com', 'theguardian.com', 'bloomberg.com',
  'ft.com', 'wsj.com', 'foxnews.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'npr.org', 'politico.com', 'thehill.com', 'axios.com',
  'insightcrime.org', 'gdeltproject.org', 'cisa.gov', 'nist.gov', 'mitre.org', 'cve.org', 'whitehouse.gov', 'state.gov', 'defense.gov', 'justice.gov', 'treasury.gov',
  'europa.eu', 'un.org', 'nato.int', 'who.int', 'imf.org', 'worldbank.org', 'opensanctions.org', 'ransomware.live', 'otx.alienvault.com', 'virustotal.com', 'shodan.io',
  'example.com', 'example.org', 'localhost',
]);
// Common file extensions that look like "name.tld" in prose (report.pdf, update.exe, image.jpg).
const FILE_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'json', 'xml', 'zip', 'rar', '7z', 'exe', 'dll', 'bat', 'ps1', 'sh', 'py', 'js', 'mjs', 'html', 'htm', 'php', 'asp', 'aspx', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'mp4', 'mp3', 'mov', 'avi', 'iso', 'img', 'bin', 'dat', 'log', 'md', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'jar', 'war', 'class', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'ts', 'tsx', 'jsx', 'vue', 'sql', 'db', 'bak', 'tmp', 'tar', 'gz', 'bz2', 'xz', 'wav', 'flac', 'ogg', 'webm', 'webp', 'ico', 'ttf', 'woff', 'woff2', 'eot', 'otf', 'css', 'scss', 'less', 'map', 'min', 'lock', 'toml', 'env', 'crt', 'pem', 'key', 'pub', 'ppk', 'cer', 'der', 'p12', 'pfx', 'jks', 'kdb', 'kdbx', 'ovpn', 'rdp', 'vbs', 'wsf', 'hta', 'scr', 'pif', 'cmd', 'msi', 'msp', 'cab', 'lnk', 'url', 'inf', 'reg', 'sys', 'drv', 'ocx', 'cpl', 'ax', 'tlb', 'olb', 'mui', 'nls', 'ime', 'iec', 'tsp', 'acm', 'ds', 'rs', 'sfx']);
// Real-world TLDs we accept for bare domains (matched case-insensitively). Bare `.com`-style tokens
// without a scheme are the noisiest IOC class, so the list is deliberately conservative.
const TLDS = 'com|net|org|info|biz|io|co|me|ru|su|cn|ir|kp|by|ua|kz|uz|tj|tm|ge|am|az|tr|sy|iq|lb|ye|sa|ae|qa|kw|om|bh|jo|eg|ly|sd|ma|dz|tn|ng|ke|et|so|ml|ne|td|cm|cd|cg|cf|ao|mz|zw|za|ve|co|mx|br|ar|cl|pe|ec|bo|py|uy|cu|ni|hn|gt|sv|pa|do|ht|jm|tt|us|ca|uk|de|fr|nl|be|it|es|pt|pl|cz|sk|hu|ro|bg|rs|hr|si|ba|mk|al|md|lt|lv|ee|fi|se|no|dk|is|ie|at|ch|gr|cy|mt|il|ps|in|pk|af|bd|lk|np|mm|th|vn|la|kh|my|sg|id|ph|tw|hk|jp|kr|mn|au|nz|pg|fj|xyz|top|club|online|site|website|space|tech|store|shop|app|dev|cloud|live|life|world|today|news|media|press|blog|link|click|download|zip|mov|ws|cc|tv|fm|to|gg|is|ly|sh|pw|tk|ml|ga|cf|gq|buzz|icu|cyou|monster|quest|rest|bar|win|bid|loan|work|party|trade|date|stream|review|racing|science|men|accountant|faith|cricket|country|kim|cam|hair|skin|beauty|makeup|boats|lol|mom|wtf|bond|cfd|sbs|autos|motorcycles|yachts|homes|realestate|pics|lat|pro|name|mobi|tel|asia|cat|jobs|travel|museum|aero|coop|int|mil|gov|edu|onion';

const RE = {
  ipv4: /(?<![\d.])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?![\d.])/g,
  url: /\bhttps?:\/\/[^\s<>"'()\[\]{}]+/gi,
  email: /\b[a-z0-9._%+-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,24}\b/gi,
  domain: new RegExp(`(?<![a-z0-9@/._-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?![a-z0-9._-])`, 'gi'),
  sha256: /\b[a-f0-9]{64}\b/gi,
  sha1: /\b[a-f0-9]{40}\b/gi,
  md5: /\b[a-f0-9]{32}\b/gi,
  cve: /\bCVE-(?:19|20)\d{2}-\d{4,7}\b/gi,
  btc: /\b(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
  eth: /\b0x[a-f0-9]{40}\b/gi,
};

export function refang(text) {
  return String(text || '')
    .replace(/\bhxxps?\b/gi, m => m.toLowerCase().replace('xx', 'tt'))
    .replace(/\bfxp\b/gi, 'ftp')
    .replace(/\[(?:\.|dot)\]|\((?:\.|dot)\)|\{(?:\.|dot)\}|\s\(dot\)\s|\s\[dot\]\s/gi, '.')
    .replace(/\[(?:@|at)\]|\((?:@|at)\)|\{(?:@|at)\}/gi, '@')
    .replace(/\[:\]|\[:\/\/\]/g, m => m.replace(/[\[\]]/g, ''))
    .replace(/\\\./g, '.');
}

function isPrivateIp(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } }
function isNoiseHost(host) {
  if (!host) return true;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (NOISE_HOSTS.has(parts.slice(i).join('.'))) return true;
  return false;
}
function allSameChar(s) { return /^(.)\1+$/.test(s); }

/**
 * Extract indicators from one text. Returns [{ type, value, raw }] deduped by type+value (lowercased).
 * `raw` is the spelling in the source (possibly defanged); `value` is the normalized form.
 */
export function extractIocs(text, { sourceHost = null } = {}) {
  const src = String(text || '');
  if (!src) return [];
  const fanged = refang(src);
  const out = [];
  const seen = new Set();
  const add = (type, value, raw) => {
    const v = type === 'cve' ? value.toUpperCase() : type === 'btc' ? value : value.toLowerCase();
    const k = `${type}:${v}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type, value: v, raw: raw && raw !== v ? raw : undefined });
  };
  const rawFor = (v) => {
    // Find the defanged spelling in the original text when the refanged one is not literally there.
    if (src.includes(v)) return v;
    const pat = v.replace(/[.*+?^${}()|[\]\\/]/g, ch => ch === '.' ? '(?:\\.|\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\))' : '\\' + ch)
      .replace(/@/g, '(?:@|\\[at\\]|\\(at\\))')
      .replace(/^http/, 'h(?:tt|xx)p');
    const m = src.match(new RegExp(pat, 'i'));
    return m ? m[0] : v;
  };

  const consumed = new Set();
  for (const m of fanged.matchAll(RE.url)) {
    let u = m[0].replace(/[.,;:!?]+$/, '');
    const host = hostOf(u);
    if (!host || isNoiseHost(host) || host === sourceHost) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? isPrivateIp(host) : false) continue;
    consumed.add(host);
    add('url', u, rawFor(u));
  }
  for (const m of fanged.matchAll(RE.email)) {
    const e = m[0];
    const host = e.split('@')[1].toLowerCase();
    if (isNoiseHost(host)) continue;
    consumed.add(host);
    add('email', e, rawFor(e));
  }
  for (const m of fanged.matchAll(RE.ipv4)) {
    const ip = m[1];
    if (isPrivateIp(ip)) continue;
    // "version 1.2.3.4"-style strings: every octet tiny and the text says version/v
    if (/\bv(?:ersion)?\.?\s*$/i.test(fanged.slice(Math.max(0, m.index - 10), m.index))) continue;
    add('ip', ip, rawFor(ip));
  }
  for (const m of fanged.matchAll(RE.domain)) {
    const d = m[1].toLowerCase();
    if (consumed.has(d) || isNoiseHost(d) || d === sourceHost) continue;
    const parts = d.split('.');
    if (FILE_EXT.has(parts[parts.length - 1]) && parts.length === 2) continue;
    if (parts.some(p => p.length > 63) || parts[0].length < 2) continue;
    add('domain', d, rawFor(d));
  }
  for (const m of fanged.matchAll(RE.cve)) add('cve', m[0]);
  for (const m of fanged.matchAll(RE.sha256)) if (!allSameChar(m[0]) && !/^\d+$/.test(m[0])) add('hash', m[0]);
  for (const m of fanged.matchAll(RE.sha1)) if (!allSameChar(m[0]) && !/^\d+$/.test(m[0])) add('hash', m[0]);
  for (const m of fanged.matchAll(RE.md5)) if (!allSameChar(m[0]) && !/^\d+$/.test(m[0])) add('hash', m[0]);
  for (const m of fanged.matchAll(RE.eth)) add('eth', m[0]);
  for (const m of fanged.matchAll(RE.btc)) {
    const a = m[0];
    // Reject things that are plainly hex hashes or all-digit runs; legacy addresses must mix cases.
    if (/^[a-f0-9]+$/i.test(a) || /^\d+$/.test(a)) continue;
    if (!a.startsWith('bc1') && !(/[a-z]/.test(a) && /[A-Z]/.test(a))) continue;
    add('btc', a);
  }
  return out;
}

function snippetAround(text, value, max = MAX_SNIPPET) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const i = refang(t).toLowerCase().indexOf(String(value).toLowerCase());
  if (i < 0 || t.length <= max) return t.slice(0, max);
  const start = Math.max(0, i - Math.floor(max / 3));
  return (start > 0 ? '…' : '') + t.slice(start, start + max) + (start + max < t.length ? '…' : '');
}

/**
 * Collect the texts of one sweep into documents: { text, source, url, ts, kind }.
 * Walks the slots CRUCIX already fills; a missing slot is simply skipped.
 */
export function collectDocuments(rawSources = {}, synthesized = {}, telegramMessages = []) {
  const docs = [];
  const push = (text, source, url, ts, kind) => { const t = String(text || '').trim(); if (t.length >= 8) docs.push({ text: t.slice(0, 2000), source: String(source || kind || 'feed').slice(0, 64), url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null, ts: ts || null, kind }); };
  for (const n of synthesized.newsFeed || []) push(n.headline, n.source, n.url, n.timestamp, n.type || 'news');
  for (const m of telegramMessages) push(m.text, `t.me/${m.channel}`, m.url, m.timestamp, 'telegram');
  const g = rawSources.GDELT;
  for (const a of g?.allArticles || []) push(a.title, 'GDELT', a.url, a.seendate || null, 'gdelt');
  for (const a of rawSources.InSightCrime?.articles || []) push(`${a.title || ''}. ${a.summary || a.description || ''}`, 'InSight Crime', a.url || a.link, a.date, 'insightcrime');
  for (const a of rawSources.BorderNews?.articles || rawSources.BorderNews?.items || []) push(`${a.title || a.headline || ''}. ${a.summary || ''}`, a.source || 'Border press', a.url || a.link, a.date, 'bordernews');
  for (const v of rawSources.Ransomware?.recent || rawSources.Ransomware?.victims || []) push(`${v.victim || v.post_title || ''} ${v.description || ''} ${v.website || ''}`, `ransomware.live · ${v.group || v.group_name || ''}`, v.url || v.post_url, v.discovered || v.date, 'ransomware');
  for (const k of rawSources.CyberKEV?.recent || rawSources.CyberKEV?.vulnerabilities || []) push(`${k.cveID || ''} ${k.vendorProject || ''} ${k.product || ''} ${k.shortDescription || ''}`, 'CISA KEV', k.url || null, k.dateAdded, 'kev');
  return docs;
}

/** Rolling first/last-seen ledger so the panel can say "new this sweep" honestly. */
export class IocLedger {
  constructor(runsDir, { retentionHours = LEDGER_RETENTION_H, max = LEDGER_MAX } = {}) {
    this.file = join(runsDir, 'iocs.json');
    this.retentionMs = retentionHours * 3600_000;
    this.max = max;
    this.map = new Map();
    this._load(runsDir);
  }
  _load(runsDir) {
    try {
      if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
      if (!existsSync(this.file)) return;
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(j.entries || {})) if (v && typeof v.first === 'string' && typeof v.last === 'string') this.map.set(k, { first: v.first, last: v.last, seen: Number(v.seen) || 1 });
    } catch { this.map = new Map(); }
  }
  touch(key, nowIso) {
    const cur = this.map.get(key);
    if (cur) { cur.last = nowIso; cur.seen += 1; return { ...cur, isNew: false }; }
    const e = { first: nowIso, last: nowIso, seen: 1 };
    this.map.set(key, e);
    return { ...e, isNew: true };
  }
  prune(now = Date.now()) {
    for (const [k, v] of this.map) if (now - Date.parse(v.last) > this.retentionMs) this.map.delete(k);
    if (this.map.size > this.max) {
      const sorted = [...this.map.entries()].sort((a, b) => Date.parse(a[1].last) - Date.parse(b[1].last));
      for (const [k] of sorted.slice(0, this.map.size - this.max)) this.map.delete(k);
    }
  }
  save() {
    try { writeFileSync(this.file, JSON.stringify({ updatedAt: new Date().toISOString(), entries: Object.fromEntries(this.map) })); } catch { /* non-fatal */ }
  }
  get size() { return this.map.size; }
}

/**
 * Run extraction over a sweep's documents. Returns the compact result the dashboard and /api/iocs use.
 */
export function extractFromDocuments(docs, { ledger = null, now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const byKey = new Map();
  let scanned = 0;
  for (const d of docs) {
    scanned++;
    const host = d.url ? hostOf(d.url) : null;
    for (const ioc of extractIocs(d.text, { sourceHost: host })) {
      const key = `${ioc.type}:${ioc.value}`;
      let e = byKey.get(key);
      if (!e) { e = { type: ioc.type, value: ioc.value, raw: ioc.raw || null, count: 0, sources: [], kinds: [], contexts: [], firstTs: null, lastTs: null }; byKey.set(key, e); }
      e.count++;
      if (!e.sources.includes(d.source) && e.sources.length < 6) e.sources.push(d.source);
      if (!e.kinds.includes(d.kind)) e.kinds.push(d.kind);
      if (e.contexts.length < MAX_CONTEXTS) e.contexts.push({ source: d.source, url: d.url, ts: d.ts, snippet: snippetAround(d.text, ioc.raw || ioc.value) });
      if (d.ts) { if (!e.firstTs || d.ts < e.firstTs) e.firstTs = d.ts; if (!e.lastTs || d.ts > e.lastTs) e.lastTs = d.ts; }
    }
  }
  let indicators = [...byKey.values()];
  if (ledger) {
    for (const e of indicators) { const l = ledger.touch(`${e.type}:${e.value}`, nowIso); e.firstSeen = l.first; e.isNew = l.isNew; e.sweepsSeen = l.seen; }
    ledger.prune(now);
    ledger.save();
  }
  const order = { cve: 0, hash: 1, ip: 2, url: 3, domain: 4, email: 5, btc: 6, eth: 7 };
  indicators.sort((a, b) => (b.isNew === true) - (a.isNew === true) || b.count - a.count || b.sources.length - a.sources.length || order[a.type] - order[b.type] || a.value.localeCompare(b.value));
  indicators = indicators.slice(0, MAX_INDICATORS);
  const byType = Object.fromEntries(IOC_TYPES.map(t => [t, 0]));
  let fresh = 0;
  for (const e of byKey.values()) { byType[e.type]++; if (e.isNew) fresh++; }
  return {
    computedAt: nowIso,
    documents: scanned,
    total: byKey.size,
    newThisSweep: fresh,
    byType,
    indicators,
    ledger: ledger ? { tracked: ledger.size, retentionHours: Math.round(ledger.retentionMs / 3600_000) } : null,
    rule: RULE,
  };
}
