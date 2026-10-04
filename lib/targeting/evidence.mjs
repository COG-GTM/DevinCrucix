// Evidence locker for Target Development (after Bellingcat's auto-archiver / Velocity's locker):
// an analyst captures a public https URL into the target package. CRUCIX fetches it through the
// SSRF-safe client, stores the bytes (bounded), records SHA-256 + response metadata, asks the
// Wayback Machine for a public snapshot (best-effort, keyless) and appends a hash-chained custody
// line. The chain is append-only: every line carries the SHA-256 of the previous line, so an edited
// or dropped line is detectable with `verifyChain()`. Content is served back only as a download,
// never rendered inline.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeOutboundFetch } from '../safeOutboundFetch.mjs';
import { isPublicHttpsUrl } from './store.mjs';

export const EVIDENCE_SCHEMA = 'crucix-evidence/1';
export const EVIDENCE_ID_RE = /^ev_[a-f0-9]{12}$/;
export const MAX_PER_TARGET = 40;
export const MAX_TOTAL = 600;
export const MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const WAYBACK_TIMEOUT_MS = 8_000;
export const NOTE_MAX = 240;
export const GENESIS = '0'.repeat(64);

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function titleOf(buf, contentType) {
  if (!/html/i.test(contentType || '')) return null;
  const head = buf.subarray(0, 64 * 1024).toString('utf8');
  const m = head.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim().slice(0, 160) || null : null;
}

/** Wayback "available" lookup -> { url, timestamp } of the closest public snapshot, or null. */
export async function waybackLookup(url, fetchImpl = safeOutboundFetch) {
  try {
    const res = await fetchImpl(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeout: WAYBACK_TIMEOUT_MS, maxBytes: 64 * 1024, headers: { 'User-Agent': 'Crucix/1.0' } });
    if (!res.ok) return null;
    const j = await res.json();
    const s = j?.archived_snapshots?.closest;
    if (!s?.available || !/^https?:\/\/web\.archive\.org\//.test(s.url || '')) return null;
    return { url: s.url, timestamp: String(s.timestamp || '').slice(0, 14) || null };
  } catch { return null; }
}

/** Ask the Wayback Machine to save the page. Best-effort: returns the archived URL from Content-Location / Location or null. */
export async function waybackSave(url, fetchImpl = safeOutboundFetch) {
  try {
    const res = await fetchImpl(`https://web.archive.org/save/${url}`, { timeout: WAYBACK_TIMEOUT_MS * 3, maxBytes: 64 * 1024, redirect: 'manual', headers: { 'User-Agent': 'Crucix/1.0' } });
    const loc = res.headers.get('content-location') || res.headers.get('location') || '';
    if (/^\/web\/\d{14}\//.test(loc)) return { url: `https://web.archive.org${loc}`, timestamp: loc.slice(5, 19) };
    if (/^https:\/\/web\.archive\.org\/web\/\d{14}\//.test(loc)) return { url: loc, timestamp: loc.replace(/^https:\/\/web\.archive\.org\/web\//, '').slice(0, 14) };
    return null;
  } catch { return null; }
}

/** Verify a custody chain (array of parsed lines). Returns { ok, length, brokenAt }. */
export function verifyChain(lines) {
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.prev !== prev) return { ok: false, length: lines.length, brokenAt: i, reason: 'prev hash mismatch' };
    const { hash, ...body } = l;
    const h = sha256(JSON.stringify(body));
    if (h !== hash) return { ok: false, length: lines.length, brokenAt: i, reason: 'line hash mismatch' };
    prev = hash;
  }
  return { ok: true, length: lines.length, brokenAt: null };
}

export class EvidenceLocker {
  constructor({ dataDir, fetchImpl = safeOutboundFetch, now = () => Date.now(), log = (l) => console.log(l), wayback = true } = {}) {
    this.dataDir = dataDir;
    this.blobDir = join(dataDir, 'evidence');
    this.indexFile = join(dataDir, 'evidence.json');
    this.custodyFile = join(dataDir, 'custody.jsonl');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.wayback = wayback;
    this.items = [];
    this.inflight = new Set();
    this.load();
  }

  load() {
    try { const raw = JSON.parse(readFileSync(this.indexFile, 'utf8')); if (raw?.schema === EVIDENCE_SCHEMA && Array.isArray(raw.items)) this.items = raw.items; } catch { /* none yet */ }
  }
  save() {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.indexFile, JSON.stringify({ schema: EVIDENCE_SCHEMA, savedAt: new Date(this.now()).toISOString(), items: this.items.slice(0, MAX_TOTAL) }));
  }
  readChain() {
    if (!existsSync(this.custodyFile)) return [];
    return readFileSync(this.custodyFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } });
  }
  lastHash() {
    const lines = this.readChain();
    return lines.length ? lines[lines.length - 1]?.hash || GENESIS : GENESIS;
  }
  /** Append one hash-chained custody line. */
  custody(action, details) {
    mkdirSync(this.dataDir, { recursive: true });
    const body = { seq: this.readChain().length, ts: new Date(this.now()).toISOString(), action, ...details, prev: this.lastHash() };
    const line = { ...body, hash: sha256(JSON.stringify(body)) };
    appendFileSync(this.custodyFile, JSON.stringify(line) + '\n');
    this.log(`[Custody] ${JSON.stringify(line)}`);
    return line;
  }
  chainStatus() { return verifyChain(this.readChain()); }

  list(targetId) {
    return this.items.filter(i => i.targetId === targetId).map(i => ({ ...i, blobPath: undefined }));
  }
  get(evId) { return this.items.find(i => i.id === evId) || null; }
  blobFor(item) { return join(this.blobDir, `${item.sha256}.bin`); }

  /** Capture a URL for a target. Returns { item } or { error, status }. */
  async capture(targetId, url, { note = '', actor = 'operator' } = {}) {
    if (!isPublicHttpsUrl(url)) return { error: 'URL must be a public https URL', status: 400 };
    const mine = this.items.filter(i => i.targetId === targetId);
    if (mine.length >= MAX_PER_TARGET) return { error: `Evidence capacity for this target (${MAX_PER_TARGET}) reached`, status: 409 };
    if (this.items.length >= MAX_TOTAL) return { error: 'Evidence locker full', status: 409 };
    const key = `${targetId}|${url}`;
    if (this.inflight.has(key)) return { error: 'Capture already running for this URL', status: 409 };
    this.inflight.add(key);
    const started = this.now();
    try {
      let res;
      try {
        res = await this.fetchImpl(url, { timeout: FETCH_TIMEOUT_MS, maxBytes: MAX_BYTES, truncate: true, headers: { 'User-Agent': 'Crucix/1.0 (evidence capture)', Accept: 'text/html,application/pdf,application/json,text/plain,*/*;q=0.5' } });
      } catch (e) {
        return { error: `Fetch failed: ${e.code || e.message}`, status: 502 };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = sha256(buf);
      const contentType = String(res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 80);
      const item = {
        id: `ev_${randomBytes(6).toString('hex')}`, targetId, url: url.slice(0, 400), finalUrl: String(res.url || url).slice(0, 400),
        httpStatus: res.status, contentType, bytes: buf.length, truncated: buf.length >= MAX_BYTES, sha256: hash,
        title: titleOf(buf, contentType), note: String(note || '').slice(0, NOTE_MAX), actor: String(actor).slice(0, 40),
        capturedAt: new Date(this.now()).toISOString(), durationMs: this.now() - started,
        wayback: { status: this.wayback ? 'pending' : 'off', url: null, timestamp: null },
      };
      mkdirSync(this.blobDir, { recursive: true });
      const blob = this.blobFor(item);
      if (!existsSync(blob)) writeFileSync(blob, buf);
      this.items.unshift(item);
      this.save();
      this.custody('evidence.capture', { evidenceId: item.id, targetId, url: item.url, finalUrl: item.finalUrl, sha256: hash, bytes: buf.length, httpStatus: res.status, contentType, actor: item.actor });
      if (this.wayback) this.archive(item).catch(() => {});
      return { item: { ...item } };
    } finally { this.inflight.delete(key); }
  }

  /** Background: find or request a Wayback snapshot and record the outcome in custody. */
  async archive(item) {
    let snap = await waybackLookup(item.url, this.fetchImpl);
    const fresh = snap && Date.parse(item.capturedAt) - waybackTs(snap.timestamp) < 24 * 3600_000;
    if (!fresh) snap = (await waybackSave(item.url, this.fetchImpl)) || snap;
    const cur = this.get(item.id);
    if (!cur) return;
    cur.wayback = snap ? { status: 'archived', url: snap.url, timestamp: snap.timestamp } : { status: 'unavailable', url: null, timestamp: null };
    this.save();
    this.custody('evidence.archive', { evidenceId: item.id, targetId: item.targetId, wayback: cur.wayback.status, url: cur.wayback.url, actor: 'system' });
  }

  /** Re-hash the stored bytes and compare with the recorded digest. */
  verify(evId, { actor = 'operator' } = {}) {
    const item = this.get(evId);
    if (!item) return null;
    const blob = this.blobFor(item);
    let actual = null, ok = false;
    try { actual = sha256(readFileSync(blob)); ok = actual === item.sha256; } catch { actual = null; }
    item.verifiedAt = new Date(this.now()).toISOString(); item.verified = ok;
    this.save();
    this.custody('evidence.verify', { evidenceId: evId, targetId: item.targetId, sha256: item.sha256, actual, ok, actor });
    return { ok, expected: item.sha256, actual, chain: this.chainStatus() };
  }

  /** Stored bytes for download (null if the blob is gone — the custody line still says what was there). */
  content(evId) {
    const item = this.get(evId);
    if (!item) return null;
    const blob = this.blobFor(item);
    if (!existsSync(blob)) return { item, buf: null };
    return { item, buf: readFileSync(blob) };
  }

  stats() {
    let bytes = 0;
    try { for (const f of readdirSync(this.blobDir)) bytes += statSync(join(this.blobDir, f)).size; } catch { /* no blobs */ }
    return { items: this.items.length, bytes, chain: this.chainStatus(), maxPerTarget: MAX_PER_TARGET, maxBytes: MAX_BYTES };
  }
}
function waybackTs(ts) {
  if (!ts || ts.length < 8) return 0;
  return Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +(ts.slice(8, 10) || 0), +(ts.slice(10, 12) || 0), +(ts.slice(12, 14) || 0));
}
