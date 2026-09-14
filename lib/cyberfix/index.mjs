// Cyberfix — orchestration. Runs after each KEV refresh: load inventories (self + uploaded), resolve
// every KEV entry against them through OSV, compute exposures, diff against the previous run, and (when
// CYBERFIX_AUTO=true) start a Devin remediation session for each new confirmed exposure. The summary is
// exposed as currentData.cyberfix and read by the Situation rule `cyberfix` and the dashboard panel.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeOutboundFetch } from '../safeOutboundFetch.mjs';
import { loadSelfInventory, loadUploadedInventories, summarizeInventory, saveInventory, deleteInventory, parseInventory, InventoryError, INVENTORY_KINDS, MAX_INVENTORY_BYTES } from './inventory.mjs';
import { createResolver } from './resolve.mjs';
import { createDevinClient, createRemediationManager, getDevinConfig, DevinApiError } from './devin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const KEV_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_EXPOSURES_EXPOSED = 500;

export { InventoryError, DevinApiError, INVENTORY_KINDS, MAX_INVENTORY_BYTES };

export function createCyberfix({ root = ROOT, fetchImpl = safeOutboundFetch, env = process.env, log = console, now = () => Date.now(), setTimer, clearTimer } = {}) {
  const dir = join(root, 'runs', 'cyberfix');
  const lastRunFile = join(dir, 'last-run.json');
  const kevCacheFile = join(dir, 'kev-catalog.json');
  const resolver = createResolver({ fetchImpl, cacheDir: join(dir, 'osv-cache'), now, log });
  const client = createDevinClient({ fetchImpl, env, log });
  const manager = createRemediationManager({ client, root, log, ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });

  let state = {
    status: 'pending', lastRun: null, kevCount: 0, kevSource: null, exposures: [], newExposureKeys: [], resolvedExposureKeys: [],
    inventories: [], stats: null, osv: { status: 'unknown' }, error: null,
  };
  let running = null;
  let rerun = null;

  function readLastRun() {
    if (!existsSync(lastRunFile)) return null;
    try { return JSON.parse(readFileSync(lastRunFile, 'utf8')); } catch { return null; }
  }
  function writeLastRun(data) {
    try { mkdirSync(dir, { recursive: true }); writeFileSync(lastRunFile, JSON.stringify(data)); } catch (err) { log.error?.('[Cyberfix] last-run write failed:', err?.message || err); }
  }

  // Full catalog (the dashboard's cyberKev source only keeps the newest 50). 6 h disk cache; on failure the
  // cached copy is used regardless of age, then the caller-supplied fallback (the sweep's own KEV subset).
  async function loadKevCatalog(fallback = []) {
    let cached = null;
    if (existsSync(kevCacheFile)) {
      try { cached = JSON.parse(readFileSync(kevCacheFile, 'utf8')); } catch { cached = null; }
      if (cached && now() - cached.at < KEV_TTL_MS && Array.isArray(cached.vulnerabilities)) return { entries: cached.vulnerabilities, source: 'cache' };
    }
    try {
      const res = await fetchImpl(KEV_URL, { timeout: 20000, maxBytes: 20 * 1024 * 1024, headers: { accept: 'application/json', 'user-agent': 'Crucix/1.0' } });
      if (!res.ok) throw new Error(`KEV HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.vulnerabilities)) throw new Error('KEV feed shape');
      const vulnerabilities = data.vulnerabilities.filter(v => v && typeof v.cveID === 'string').map(v => ({
        cveID: v.cveID, vendorProject: v.vendorProject, product: v.product, vulnerabilityName: v.vulnerabilityName, dateAdded: v.dateAdded,
        shortDescription: v.shortDescription, dueDate: v.dueDate, knownRansomwareCampaignUse: v.knownRansomwareCampaignUse,
      }));
      try { mkdirSync(dir, { recursive: true }); writeFileSync(kevCacheFile, JSON.stringify({ at: now(), vulnerabilities })); } catch { /* cache is best-effort */ }
      return { entries: vulnerabilities, source: 'live' };
    } catch (err) {
      log.error?.('[Cyberfix] KEV catalog fetch failed:', err?.message || err);
      if (cached?.vulnerabilities?.length) return { entries: cached.vulnerabilities, source: 'stale-cache' };
      return { entries: (fallback || []).map(v => ({ cveID: v.cveID, vendorProject: v.vendor || v.vendorProject, product: v.product, vulnerabilityName: v.name || v.vulnerabilityName, dateAdded: v.dateAdded, shortDescription: v.description || v.shortDescription, dueDate: v.dueDate, knownRansomwareCampaignUse: v.ransomware ? 'Known' : (v.knownRansomwareCampaignUse || 'Unknown') })), source: 'sweep-subset' };
    }
  }

  function loadInventories() {
    return [loadSelfInventory(root), ...loadUploadedInventories(root)];
  }

  // One run at a time; a request that arrives mid-run (e.g. a second upload) queues exactly one follow-up.
  function run(opts = {}) {
    if (running) { rerun = opts; return running; }
    running = execute(opts).finally(() => { running = null; if (rerun) { const o = rerun; rerun = null; run(o); } });
    return running;
  }

  async function execute({ kev = null, kevFallback = [], trigger = 'sweep' } = {}) {
    const startedAt = new Date(now()).toISOString();
    try {
      const catalog = kev ? { entries: kev, source: 'provided' } : await loadKevCatalog(kevFallback);
      const inventories = loadInventories();
      const { exposures, stats } = await resolver.resolveExposures({ kev: catalog.entries, inventories });
      const prev = readLastRun();
      const prevKeys = new Set(Array.isArray(prev?.exposureKeys) ? prev.exposureKeys : []);
      const keys = exposures.map(e => e.exposureKey);
      const newKeys = keys.filter(k => !prevKeys.has(k));
      const resolvedKeys = [...prevKeys].filter(k => !keys.includes(k));
      writeLastRun({ at: startedAt, exposureKeys: keys });
      const osvStatus = stats.errors === 0 ? 'ok' : stats.requests > stats.errors ? 'degraded' : 'unavailable';
      state = {
        status: 'ok', lastRun: startedAt, trigger, kevCount: catalog.entries.length, kevSource: catalog.source,
        exposures: exposures.slice(0, MAX_EXPOSURES_EXPOSED), newExposureKeys: newKeys, resolvedExposureKeys: resolvedKeys,
        inventories: inventories.map(summarizeInventory), stats, osv: { status: osvStatus, requests: stats.requests, cacheHits: stats.cacheHits, errors: stats.errors }, error: null,
      };
      log.log(JSON.stringify({ timestamp: startedAt, event: 'cyberfix_run', trigger, kev: catalog.entries.length, kevSource: catalog.source, components: stats.components, exposures: exposures.length, confirmed: exposures.filter(e => e.confidence === 'confirmed').length, new: newKeys.length, resolved: resolvedKeys.length, osv: osvStatus }));
      if (getDevinConfig(env).auto && getDevinConfig(env).enabled) {
        for (const e of exposures) {
          if (e.confidence !== 'confirmed' || !newKeys.includes(e.exposureKey)) continue;
          try { await manager.start(e, { trigger: 'auto' }); } catch (err) { log.error?.('[Cyberfix] auto remediation failed:', e.exposureKey, err?.message || err); }
        }
      }
    } catch (err) {
      log.error?.('[Cyberfix] run failed:', err?.stack || err?.message || err);
      state = { ...state, status: 'error', lastRun: startedAt, error: 'run failed' };
    }
    return summary();
  }

  function summary() {
    const cfg = getDevinConfig(env);
    const remediations = manager.list();
    const counts = { confirmed: 0, probable: 0, 'name-match': 0 };
    for (const e of state.exposures) counts[e.confidence] = (counts[e.confidence] || 0) + 1;
    return {
      status: state.status, lastRun: state.lastRun, trigger: state.trigger || null, error: state.error,
      kev: { count: state.kevCount, source: state.kevSource },
      capabilities: {
        devin: { enabled: cfg.enabled, reason: cfg.disabledReason, targetRepo: cfg.targetRepo, auto: cfg.auto, apiVersion: cfg.v3 ? 'v3' : 'v1' },
        osv: state.osv,
        uploadKinds: INVENTORY_KINDS, maxUploadBytes: MAX_INVENTORY_BYTES,
      },
      inventories: state.inventories.length ? state.inventories : loadInventories().map(summarizeInventory),
      counts: { ...counts, total: state.exposures.length, new: state.newExposureKeys.length, resolved: state.resolvedExposureKeys.length, remediations: remediations.length, prOpen: remediations.filter(r => r.prUrl).length },
      exposures: state.exposures.map(e => ({ ...e, remediation: remediations.find(r => r.exposureKey === e.exposureKey) || null })),
      newExposureKeys: state.newExposureKeys,
      resolvedExposureKeys: state.resolvedExposureKeys,
      remediations,
      stats: state.stats,
    };
  }

  function addInventory({ kind, name, bytes }) {
    const components = parseInventory(kind, bytes);   // throws InventoryError
    return summarizeInventory(saveInventory({ kind, name, components }, root));
  }

  function removeInventory(id) { return deleteInventory(id, root); }

  function findExposure(exposureKey) { return state.exposures.find(e => e.exposureKey === exposureKey) || null; }

  async function remediate(exposureKey, { ip = null } = {}) {
    const cfg = getDevinConfig(env);
    if (!cfg.enabled) throw new DevinApiError(0, cfg.disabledReason);
    const exposure = findExposure(exposureKey);
    if (!exposure) return null;
    return manager.start(exposure, { trigger: 'analyst', ip });
  }

  return { run, summary, addInventory, removeInventory, findExposure, remediate, refreshRemediation: manager.refresh, resumePolling: manager.resume, stopPolling: manager.stop, manager, resolver, client, loadKevCatalog };
}
