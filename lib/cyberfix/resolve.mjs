// Cyberfix — CVE → affected package resolution against OSV.dev, and the KEV × inventory join.
//   GET  https://api.osv.dev/v1/vulns/{id}          — one record (CVE-, GHSA-, PYSEC-… ids). CVE records
//                                                    carry GIT ranges only; package ranges live on the
//                                                    GHSA/PYSEC aliases, so a CVE is followed to its aliases.
//   POST https://api.osv.dev/v1/querybatch          — {queries:[{package:{name,ecosystem},version}]} → vuln ids
// Responses are cached as JSON under runs/cyberfix/osv-cache/ for 24 h. All network goes through
// safeOutboundFetch; the resolver accepts a fetch replacement so tests run on recorded fixtures only.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { safeOutboundFetch } from '../safeOutboundFetch.mjs';
import { normalizePackageName } from './inventory.mjs';
import { versionInRange, describeRange, compareVersions } from './versions.mjs';

export const OSV_BASE = 'https://api.osv.dev/v1';
export const OSV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OSV_BATCH_SIZE = 1000;
export const CONFIDENCE = ['confirmed', 'probable', 'name-match'];
const MAX_VULN_FETCHES = 150;
const MAX_ALIAS_FOLLOW = 4;
const OSV_ECOSYSTEMS = new Set(['npm', 'PyPI', 'Maven', 'Go', 'crates.io', 'NuGet']);
const ECO_TO_OSV = { npm: 'npm', PyPI: 'PyPI', Maven: 'Maven', Go: 'Go', cargo: 'crates.io', nuget: 'NuGet' };
const OSV_TO_ECO = Object.fromEntries(Object.entries(ECO_TO_OSV).map(([k, v]) => [v, k]));
const CVE_RE = /^CVE-\d{4}-\d{4,}$/;
const OSV_ID_RE = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]{3,60}$/;

export const kevUrl = (cve) => `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${encodeURIComponent(cve)}`;
export const nvdUrl = (cve) => `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve)}`;
export const osvUrl = (id) => `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;

const foldName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function exposureKeyFor({ cveId, inventoryId, component }) {
  const raw = [cveId, inventoryId, component.ecosystem, normalizePackageName(component.name, component.ecosystem), component.version ?? ''].join('|');
  return `exp_${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function cveIdsOf(rec) {
  const ids = new Set();
  if (CVE_RE.test(rec?.id || '')) ids.add(rec.id);
  for (const a of rec?.aliases || []) if (typeof a === 'string' && CVE_RE.test(a)) ids.add(a);
  return [...ids];
}

// Does the KEV vendor/product plausibly name this component? Used for CPE lists and as the fallback tier.
export function kevNameMatch(kev, component) {
  const prod = foldName(kev.product), vendor = foldName(kev.vendorProject);
  if (!prod) return false;
  if (component.cpe) {
    const cv = foldName(component.vendor), cp = foldName(component.product);
    if (!cp) return false;
    if (cp === prod && (!cv || !vendor || cv === vendor || prod.includes(cv) || vendor.includes(cv))) return true;
    return cv && cv === vendor && (prod.includes(cp) || cp.includes(prod));
  }
  const name = String(component.name || '');
  const last = foldName(name.split(/[/:]/).pop());
  const whole = foldName(name);
  if (!last) return false;
  if (prod === last || prod === whole) return true;
  // "Log4j2" vs "log4j-core", "Spring Framework" vs "spring-core": product token starts the package name.
  const stem = prod.replace(/\d+$/, '');
  return stem.length >= 5 && (last.startsWith(stem) || whole.startsWith(stem));
}

export function createResolver({ fetchImpl = safeOutboundFetch, cacheDir = null, now = () => Date.now(), ttlMs = OSV_CACHE_TTL_MS, maxVulnFetches = MAX_VULN_FETCHES, log = console } = {}) {
  const stats = { requests: 0, cacheHits: 0, errors: 0, notFound: 0 };
  const mem = new Map();

  function cacheFile(key) {
    if (!cacheDir) return null;
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return join(cacheDir, `${safe}.json`);
  }
  function cacheRead(key) {
    if (mem.has(key)) { const e = mem.get(key); if (now() - e.at < ttlMs) return e; mem.delete(key); }
    const f = cacheFile(key);
    if (!f || !existsSync(f)) return null;
    try {
      const e = JSON.parse(readFileSync(f, 'utf8'));
      if (e && typeof e.at === 'number' && now() - e.at < ttlMs) { mem.set(key, e); return e; }
    } catch { /* corrupt cache entry → refetch */ }
    return null;
  }
  function cacheWrite(key, value) {
    const e = { at: now(), value };
    mem.set(key, e);
    const f = cacheFile(key);
    if (!f) return;
    try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(f, JSON.stringify(e)); } catch (err) { log.error?.('[Cyberfix] OSV cache write failed:', err?.message || err); }
  }

  async function request(url, init) {
    stats.requests++;
    const res = await fetchImpl(url, { timeout: 20000, maxBytes: 8 * 1024 * 1024, ...init, headers: { accept: 'application/json', 'user-agent': 'Crucix/1.0', ...(init?.headers || {}) } });
    if (res.status === 404) { stats.notFound++; return null; }
    if (!res.ok) throw new Error(`OSV HTTP ${res.status}`);
    return res.json();
  }

  async function getVuln(id) {
    if (!OSV_ID_RE.test(id)) return null;
    const key = `vuln_${id}`;
    const hit = cacheRead(key);
    if (hit) { stats.cacheHits++; return hit.value; }
    try {
      const rec = await request(`${OSV_BASE}/vulns/${encodeURIComponent(id)}`);
      cacheWrite(key, rec);
      return rec;
    } catch (err) {
      stats.errors++;
      log.error?.('[Cyberfix] OSV vuln fetch failed:', id, err?.message || err);
      return undefined;
    }
  }

  // components → array (same order) of vuln id lists; null entries mean "not queried / failed".
  async function queryBatch(components) {
    const out = new Array(components.length).fill(null);
    const pending = [];
    components.forEach((c, i) => {
      const eco = ECO_TO_OSV[c.ecosystem];
      if (!eco || !c.version) return;
      const key = `q_${eco}_${normalizePackageName(c.name, c.ecosystem)}_${c.version}`;
      const hit = cacheRead(key);
      if (hit) { stats.cacheHits++; out[i] = hit.value; return; }
      pending.push({ i, key, query: { package: { name: c.name, ecosystem: eco }, version: c.version } });
    });
    for (let s = 0; s < pending.length; s += OSV_BATCH_SIZE) {
      const chunk = pending.slice(s, s + OSV_BATCH_SIZE);
      try {
        const body = await request(`${OSV_BASE}/querybatch`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: chunk.map(p => p.query) }),
        });
        const results = Array.isArray(body?.results) ? body.results : [];
        chunk.forEach((p, j) => {
          const ids = (results[j]?.vulns || []).map(v => v?.id).filter(id => typeof id === 'string' && OSV_ID_RE.test(id));
          out[p.i] = ids;
          cacheWrite(p.key, ids);
        });
      } catch (err) {
        stats.errors++;
        log.error?.('[Cyberfix] OSV querybatch failed:', err?.message || err);
      }
    }
    return out;
  }

  // Evaluate one OSV record against one component: is the component's version inside an affected range?
  function matchRecord(rec, component) {
    const eco = ECO_TO_OSV[component.ecosystem];
    const want = normalizePackageName(component.name, component.ecosystem);
    let sawPackage = false;
    let best = null;
    const fixes = [];
    for (const a of rec?.affected || []) {
      const p = a?.package;
      if (!p || p.ecosystem !== eco) continue;
      const have = normalizePackageName(p.name, OSV_TO_ECO[p.ecosystem] || 'generic');
      if (have !== want) continue;
      sawPackage = true;
      for (const r of a.ranges || []) for (const ev of r.events || []) if (ev?.fixed) fixes.push(String(ev.fixed));
      if (!component.version) continue;
      if (Array.isArray(a.versions) && a.versions.includes(component.version)) {
        best = { affected: true, range: bestRange(a, component), exact: true };
        break;
      }
      for (const r of a.ranges || []) {
        const res = versionInRange(component.version, r, component.ecosystem);
        if (res.affected === true) { best = { affected: true, range: res }; break; }
        if (res.affected === null && !best) best = { affected: null, range: null };
        if (res.affected === false && (!best || best.affected === null)) best = { affected: false, range: res };
      }
      if (best?.affected === true) break;
    }
    const fixedVersion = best?.range?.fixed || highest(fixes, component.ecosystem);
    return { sawPackage, affected: best ? best.affected : null, range: best?.range || null, fixedVersion };
  }

  function bestRange(a, component) {
    for (const r of a.ranges || []) { const res = versionInRange(component.version, r, component.ecosystem); if (res.affected) return res; }
    return null;
  }
  function highest(list, ecosystem) {
    let top = null;
    for (const v of list) if (top === null || (compareVersions(v, top, ecosystem) ?? -1) > 0) top = v;
    return top;
  }

  function advisoryRefs(rec, limit = 2) {
    const out = [];
    for (const r of rec?.references || []) {
      if (out.length >= limit) break;
      if (typeof r?.url !== 'string' || !/^https:\/\//.test(r.url)) continue;
      const vendorAdvisory = r.type === 'WEB' && /\/security\/advisories\//.test(r.url);
      if (r.type !== 'ADVISORY' && !vendorAdvisory) continue;
      // NVD / KEV already appear as their own evidence steps; the cvelist mirror adds nothing.
      if (/cvelistV5|nvd\.nist\.gov|cisa\.gov/.test(r.url)) continue;
      out.push(r.url);
    }
    return out;
  }

  function buildExposure({ kev, component, inventory, confidence, rec, match }) {
    const cveId = kev.cveID;
    const evidence = [
      { step: 'kev', label: `CISA KEV · ${kev.vendorProject} ${kev.product}`, url: kevUrl(cveId) },
      { step: 'cve', label: `NVD · ${cveId}`, url: nvdUrl(cveId) },
    ];
    if (rec?.id) {
      evidence.push({ step: 'range', label: `OSV · ${rec.id}${match?.range ? ` · ${describeRange(match.range)}` : ''}`, url: osvUrl(rec.id) });
      for (const u of advisoryRefs(rec)) evidence.push({ step: 'advisory', label: 'Advisory', url: u });
    }
    evidence.push({ step: 'component', label: `${inventory.name} · ${component.ecosystem} ${component.name}${component.version ? '@' + component.version : ''}`, url: component.purl ? `https://osv.dev/list?ecosystem=${encodeURIComponent(ECO_TO_OSV[component.ecosystem] || '')}&q=${encodeURIComponent(component.name)}` : kevUrl(cveId) });
    return {
      exposureKey: exposureKeyFor({ cveId, inventoryId: inventory.id, component }),
      cveId,
      kev: {
        vendorProject: kev.vendorProject, product: kev.product, vulnerabilityName: kev.vulnerabilityName || null,
        dateAdded: kev.dateAdded || null, dueDate: kev.dueDate || null,
        knownRansomwareCampaignUse: kev.knownRansomwareCampaignUse || 'Unknown', shortDescription: kev.shortDescription || null,
      },
      component: { ...component, inventoryId: inventory.id, inventoryName: inventory.name },
      affectedRange: match?.range ? describeRange(match.range) : null,
      fixedVersion: match?.fixedVersion || null,
      confidence,
      osvId: rec?.id || null,
      evidence,
    };
  }

  // The join. `kev` is the array of catalog entries; `inventories` [{id,name,components}].
  async function resolveExposures({ kev = [], inventories = [] }) {
    const kevByCve = new Map();
    for (const k of kev) if (k && CVE_RE.test(k.cveID || '')) kevByCve.set(k.cveID, k);

    const items = [];
    for (const inv of inventories) for (const c of inv.components || []) items.push({ inv, c });

    const exposures = new Map();
    const add = (e) => { const prev = exposures.get(e.exposureKey); if (!prev || CONFIDENCE.indexOf(e.confidence) < CONFIDENCE.indexOf(prev.confidence)) exposures.set(e.exposureKey, e); };

    // 1) inventory side: querybatch every versioned package component, follow returned ids to CVEs in KEV.
    const ids = await queryBatch(items.map(x => x.c));
    const wanted = new Map(); // osv id → [item index]
    ids.forEach((list, i) => { for (const id of list || []) { if (!wanted.has(id)) wanted.set(id, []); wanted.get(id).push(i); } });
    let fetches = 0;
    for (const [id, idxs] of wanted) {
      if (fetches >= maxVulnFetches) break;
      const rec = await getVuln(id); fetches++;
      if (!rec) continue;
      for (const cve of cveIdsOf(rec)) {
        const k = kevByCve.get(cve);
        if (!k) continue;
        for (const i of idxs) {
          const { inv, c } = items[i];
          const m = matchRecord(rec, c);
          let confidence = 'probable';
          if (m.affected === true && c.versionBasis !== 'lower-bound') confidence = 'confirmed';
          else if (m.affected === false) continue;
          add(buildExposure({ kev: k, component: c, inventory: inv, confidence, rec, match: m }));
        }
      }
    }

    // 2) KEV side: vendor/product name matches (CPE lists, generic components, packages OSV did not flag).
    const keyed = new Set([...exposures.values()].map(e => `${e.cveId}|${e.component.inventoryId}|${e.component.ecosystem}|${normalizePackageName(e.component.name, e.component.ecosystem)}|${e.component.version ?? ''}`));
    const followUps = [];
    for (const k of kevByCve.values()) {
      for (const { inv, c } of items) {
        if (!kevNameMatch(k, c)) continue;
        const key = `${k.cveID}|${inv.id}|${c.ecosystem}|${normalizePackageName(c.name, c.ecosystem)}|${c.version ?? ''}`;
        if (keyed.has(key)) continue;
        if (ECO_TO_OSV[c.ecosystem] && c.version) followUps.push({ k, inv, c });
        else add(buildExposure({ kev: k, component: c, inventory: inv, confidence: 'name-match', rec: null, match: null }));
      }
    }
    // 3) Name-matched package components with a version: follow CVE → aliases for a real range decision.
    for (const { k, inv, c } of followUps) {
      if (fetches >= maxVulnFetches) { add(buildExposure({ kev: k, component: c, inventory: inv, confidence: 'name-match', rec: null, match: null })); continue; }
      const cveRec = await getVuln(k.cveID); fetches++;
      if (cveRec === undefined) { add(buildExposure({ kev: k, component: c, inventory: inv, confidence: 'name-match', rec: null, match: null })); continue; }
      const aliasIds = (cveRec?.aliases || []).filter(a => typeof a === 'string' && !CVE_RE.test(a)).slice(0, MAX_ALIAS_FOLLOW);
      let decided = false;
      for (const rec of [cveRec, ...(await Promise.all(aliasIds.map(id => { fetches++; return getVuln(id); })))]) {
        if (!rec) continue;
        const m = matchRecord(rec, c);
        if (!m.sawPackage) continue;
        decided = true;
        if (m.affected === true) add(buildExposure({ kev: k, component: c, inventory: inv, confidence: c.versionBasis === 'lower-bound' ? 'probable' : 'confirmed', rec, match: m }));
        else if (m.affected === null) add(buildExposure({ kev: k, component: c, inventory: inv, confidence: 'probable', rec, match: m }));
        break; // affected === false → the package is named but this version is outside every range
      }
      if (!decided) add(buildExposure({ kev: k, component: c, inventory: inv, confidence: 'name-match', rec: cveRec || null, match: null }));
    }

    const list = [...exposures.values()].sort((a, b) => CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence) || String(b.kev.dateAdded).localeCompare(String(a.kev.dateAdded)));
    return { exposures: list, stats: { ...stats, kevEntries: kevByCve.size, components: items.length, vulnIdsSeen: wanted.size } };
  }

  return { getVuln, queryBatch, matchRecord, resolveExposures, stats };
}

export { OSV_ECOSYSTEMS };
