// Cyberfix — Devin API client + remediation session tracking.
// Implemented against the documented Sessions API (https://docs.devin.ai/api-reference):
//   v1 (default, DEVIN_API_BASE=https://api.devin.ai/v1):
//     POST {base}/sessions                  {prompt, title?, tags?, idempotent?}  → {session_id, url, is_new_session?}
//     GET  {base}/sessions/{session_id}     → {session_id, status, status_enum?, pull_request?: {url}, ...}
//     POST {base}/sessions/{session_id}/message  {message}
//   v3 (DEVIN_ORG_ID set → base https://api.devin.ai/v3/organizations/{org}):
//     POST {base}/sessions                  {prompt, title?, tags?}  → {session_id, url, status, pull_requests: [{pr_url, pr_state}]}
//     GET  {base}/sessions/{session_id}     → {status, status_detail?, pull_requests, url, ...}
//     POST {base}/sessions/{session_id}/messages {message}
// Auth: Authorization: Bearer DEVIN_API_KEY. The key is read from the environment at call time and never
// written to disk, logs or client responses. Remediation state persists in runs/cyberfix/remediations.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeOutboundFetch } from '../safeOutboundFetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_API_BASE = 'https://api.devin.ai/v1';
export const DEFAULT_TARGET_REPO = 'COG-GTM/DevinCrucix';
export const DISABLED_REASON = 'remediation disabled — set DEVIN_API_KEY';
export const REMEDIATION_STATUSES = ['queued', 'running', 'blocked', 'finished', 'failed', 'expired', 'suspended'];
export const TERMINAL_STATUSES = new Set(['finished', 'failed', 'expired']);
export const POLL = { initialMs: 2 * 60 * 1000, maxMs: 10 * 60 * 1000, factor: 1.5, maxPolls: 60 };
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

export class DevinApiError extends Error {
  constructor(status, message) { super(message || `Devin API HTTP ${status}`); this.name = 'DevinApiError'; this.status = status; }
}

export function getDevinConfig(env = process.env) {
  const apiKey = (env.DEVIN_API_KEY || '').trim() || null;
  const orgId = (env.DEVIN_ORG_ID || '').trim() || null;
  let apiBase = (env.DEVIN_API_BASE || '').trim().replace(/\/+$/, '');
  const customBase = !!apiBase && !/^https:\/\/api\.devin\.ai(\/|$)/.test(apiBase);
  if (!apiBase) apiBase = orgId ? `https://api.devin.ai/v3/organizations/${encodeURIComponent(orgId)}` : DEFAULT_API_BASE;
  const targetRepo = REPO_RE.test(env.CYBERFIX_TARGET_REPO || '') ? env.CYBERFIX_TARGET_REPO : DEFAULT_TARGET_REPO;
  return {
    enabled: !!apiKey, apiBase, targetRepo, orgId, customBase,
    auto: String(env.CYBERFIX_AUTO || '').toLowerCase() === 'true',
    v3: /\/v3\//.test(apiBase),
    disabledReason: apiKey ? null : DISABLED_REASON,
  };
}

// --- Prompt ---------------------------------------------------------------------------------------
const one = (s, max = 600) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function remediationTitle(exposure) {
  return `security: remediate ${exposure.cveId} in ${exposure.component.name}`;
}

export function buildRemediationPrompt(exposure, targetRepo) {
  const c = exposure.component, k = exposure.kev;
  const cur = c.version ? `${c.name}@${c.version}` : c.name;
  const fix = exposure.fixedVersion ? `${exposure.fixedVersion}` : 'the earliest non-affected release (determine it from the advisory)';
  const evidence = (exposure.evidence || []).map(e => `- ${one(e.label, 120)}: ${e.url}`).join('\n');
  return [
    `Repository: ${targetRepo}`,
    '',
    `Task: remediate ${exposure.cveId} (CISA Known Exploited Vulnerability) in the ${c.ecosystem} dependency ${cur}.`,
    '',
    'Context',
    `- Component: ${c.ecosystem} ${cur} (from inventory "${one(c.inventoryName, 80)}", source ${c.source})`,
    `- Affected range (OSV): ${exposure.affectedRange || 'not resolved — confirm from the advisory'}`,
    `- Fixed version: ${fix}`,
    `- KEV entry: ${one(k.vendorProject, 80)} ${one(k.product, 80)} — ${one(k.vulnerabilityName, 160)}; added ${k.dateAdded}, remediation due ${k.dueDate}; known ransomware campaign use: ${k.knownRansomwareCampaignUse}`,
    `- Summary: ${one(k.shortDescription, 500)}`,
    `- Exposure confidence: ${exposure.confidence}`,
    'Evidence',
    evidence,
    '',
    'Steps',
    `1. Reproduce: locate every place ${c.name} is depended on (direct and transitive). Add a failing test that asserts the installed ${c.name} version is not inside the affected range (a version-assertion test is acceptable when the vulnerable code path cannot be exercised safely).`,
    `2. Fix: upgrade ${c.name} to ${fix} (or the nearest compatible non-affected release), updating the lockfile/pins. If an upgrade is impossible, apply the vendor-recommended mitigation and document why.`,
    '3. Verify: run the full test suite (Node: `node --test \'test/*.test.mjs\'`; Python: `cd ingest && python -m pytest` if Python pins changed) and make sure the new test now passes.',
    `4. Open a pull request titled "${remediationTitle(exposure)}" against the default branch. In the description list the CVE, the KEV due date, the before/after versions and the evidence links above.`,
    '5. Report the pull request URL in your final message.',
    '',
    'Constraints: do not add new runtime dependencies, do not disable or delete existing tests, and do not commit secrets.',
  ].join('\n');
}

// --- HTTP -----------------------------------------------------------------------------------------
export function createDevinClient({ fetchImpl = safeOutboundFetch, env = process.env, log = console } = {}) {
  const cfg = getDevinConfig(env);

  async function call(method, path, body) {
    const key = (env.DEVIN_API_KEY || '').trim();
    if (!key) throw new DevinApiError(0, DISABLED_REASON);
    const res = await fetchImpl(`${cfg.apiBase}${path}`, {
      method,
      timeout: 30000,
      maxBytes: 2 * 1024 * 1024,
      allowPrivate: cfg.customBase, // operator-configured gateway / proxy only; the public API never needs it
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      log.error?.(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_devin_api_error', method, path, status: res.status, bodyBytes: text.length }));
      throw new DevinApiError(res.status);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new DevinApiError(res.status, 'Devin API returned non-JSON'); }
  }

  async function createSession({ prompt, title, tags }) {
    const body = { prompt, title, tags };
    if (!cfg.v3) body.idempotent = false;
    const data = await call('POST', '/sessions', body);
    if (!data || typeof data.session_id !== 'string' || !SESSION_ID_RE.test(data.session_id)) throw new DevinApiError(502, 'Devin API returned no session_id');
    return { sessionId: data.session_id, sessionUrl: typeof data.url === 'string' ? data.url : null, isNew: data.is_new_session ?? null, raw: normalizeSession(data) };
  }

  async function getSession(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) throw new DevinApiError(400, 'bad session id');
    const data = await call('GET', `/sessions/${encodeURIComponent(sessionId)}`);
    return normalizeSession(data);
  }

  async function sendMessage(sessionId, message) {
    if (!SESSION_ID_RE.test(sessionId)) throw new DevinApiError(400, 'bad session id');
    return call('POST', `/sessions/${encodeURIComponent(sessionId)}/${cfg.v3 ? 'messages' : 'message'}`, { message });
  }

  return { config: cfg, createSession, getSession, sendMessage };
}

// Map both documented response shapes onto {status, prUrl, sessionUrl, detail}.
export function normalizeSession(data) {
  if (!data || typeof data !== 'object') return { status: 'queued', prUrl: null, sessionUrl: null, detail: null };
  const v3 = Array.isArray(data.pull_requests) || typeof data.status_detail === 'string';
  let prUrl = null;
  if (v3) { const pr = data.pull_requests?.find(p => typeof p?.pr_url === 'string'); prUrl = pr?.pr_url || null; }
  else if (data.pull_request && typeof data.pull_request.url === 'string') prUrl = data.pull_request.url;
  const status = v3 ? mapV3Status(data.status, data.status_detail) : mapV1Status(data.status_enum || data.status);
  return { status, prUrl: safeHttpsUrl(prUrl), sessionUrl: safeHttpsUrl(data.url), detail: typeof (data.status_detail ?? data.status) === 'string' ? String(data.status_detail ?? data.status).slice(0, 60) : null };
}

function mapV1Status(s) {
  switch (String(s || '').toLowerCase()) {
    case 'working': case 'resumed': case 'resume_requested': case 'resume_requested_frontend': return 'running';
    case 'blocked': return 'blocked';
    case 'finished': return 'finished';
    case 'expired': return 'expired';
    case 'suspend_requested': case 'suspend_requested_frontend': case 'suspended': return 'suspended';
    default: return 'queued';
  }
}
function mapV3Status(s, detail) {
  switch (String(s || '').toLowerCase()) {
    case 'new': case 'claimed': return 'queued';
    case 'running': {
      const d = String(detail || '').toLowerCase();
      if (d === 'finished') return 'finished';
      if (d === 'waiting_for_user' || d === 'waiting_for_approval') return 'blocked';
      return 'running';
    }
    case 'resuming': return 'running';
    case 'exit': return 'finished';
    case 'error': return 'failed';
    case 'suspended': return 'suspended';
    default: return 'queued';
  }
}
function safeHttpsUrl(u) {
  if (typeof u !== 'string') return null;
  try { const p = new URL(u); return p.protocol === 'https:' ? p.toString() : null; } catch { return null; }
}

// --- Remediation store ------------------------------------------------------------------------------
export function remediationsFile(root = ROOT) { return join(root, 'runs', 'cyberfix', 'remediations.json'); }

export function loadRemediations(root = ROOT) {
  const f = remediationsFile(root);
  if (!existsSync(f)) return [];
  try { const arr = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(arr) ? arr.filter(r => r && typeof r.exposureKey === 'string') : []; } catch { return []; }
}
export function saveRemediations(list, root = ROOT) {
  const f = remediationsFile(root);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(list, null, 2));
}

export function nextPollDelay(polls) {
  return Math.min(POLL.maxMs, Math.round(POLL.initialMs * Math.pow(POLL.factor, Math.max(0, polls))));
}

// Manages sessions for exposures: start, refresh (one poll), bounded background polling.
export function createRemediationManager({ client, root = ROOT, log = console, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let items = loadRemediations(root);
  const timers = new Map();

  const persist = () => saveRemediations(items, root);
  const byKey = (k) => items.find(r => r.exposureKey === k);
  const byId = (id) => items.find(r => r.sessionId === id);

  function audit(event, extra) { log.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...extra })); }

  async function start(exposure, { trigger = 'analyst', ip = null } = {}) {
    const existing = byKey(exposure.exposureKey);
    if (existing && !TERMINAL_STATUSES.has(existing.status)) return { remediation: existing, created: false };
    const cfg = client.config;
    const prompt = buildRemediationPrompt(exposure, cfg.targetRepo);
    const title = remediationTitle(exposure);
    const created = await client.createSession({ prompt, title, tags: ['crucix', 'cyberfix', exposure.cveId] });
    const now = new Date().toISOString();
    const rec = {
      exposureKey: exposure.exposureKey, cveId: exposure.cveId, component: `${exposure.component.name}${exposure.component.version ? '@' + exposure.component.version : ''}`,
      targetRepo: cfg.targetRepo, sessionId: created.sessionId, sessionUrl: created.sessionUrl, status: created.raw?.status || 'queued', prUrl: created.raw?.prUrl || null,
      startedAt: now, updatedAt: now, polls: 0, trigger,
    };
    items = items.filter(r => r.exposureKey !== rec.exposureKey).concat(rec);
    persist();
    audit('cyberfix_remediation_started', { ip, exposureKey: rec.exposureKey, cveId: rec.cveId, sessionId: rec.sessionId, trigger });
    schedule(rec.sessionId);
    return { remediation: rec, created: true };
  }

  async function refresh(sessionId) {
    const rec = byId(sessionId);
    if (!rec) return null;
    if (!client.config.enabled) { rec.lastError = DISABLED_REASON; return rec; }
    try {
      const s = await client.getSession(sessionId);
      rec.status = s.status;
      if (s.prUrl) rec.prUrl = s.prUrl;
      if (s.sessionUrl && !rec.sessionUrl) rec.sessionUrl = s.sessionUrl;
      rec.detail = s.detail;
      rec.lastError = null;
    } catch (err) {
      rec.lastError = err instanceof DevinApiError ? `devin api ${err.status || 'error'}` : 'refresh failed';
      if (err instanceof DevinApiError && err.status === 404) rec.status = 'failed';
      log.error?.('[Cyberfix] session refresh failed:', sessionId, err?.message || err);
    }
    rec.polls = (rec.polls || 0) + 1;
    rec.updatedAt = new Date().toISOString();
    persist();
    audit('cyberfix_remediation_refreshed', { sessionId, status: rec.status, prUrl: !!rec.prUrl });
    return rec;
  }

  function schedule(sessionId) {
    const rec = byId(sessionId);
    if (!rec || !client.config.enabled || TERMINAL_STATUSES.has(rec.status) || (rec.polls || 0) >= POLL.maxPolls) { timers.delete(sessionId); return; }
    if (timers.has(sessionId)) clearTimer(timers.get(sessionId));
    const t = setTimer(async () => {
      timers.delete(sessionId);
      await refresh(sessionId);
      schedule(sessionId);
    }, nextPollDelay(rec.polls || 0));
    if (typeof t?.unref === 'function') t.unref();
    timers.set(sessionId, t);
  }

  function resume() { for (const r of items) schedule(r.sessionId); }
  function stop() { for (const t of timers.values()) clearTimer(t); timers.clear(); }
  function list() { return items.map(r => ({ ...r })); }

  return { start, refresh, schedule, resume, stop, list, byKey, byId };
}
