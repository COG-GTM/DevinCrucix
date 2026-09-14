// Cyberfix — software inventory parsers. Every supported format is reduced to the same component
// shape so the resolver never has to know where a component came from:
//   { ecosystem: 'npm'|'PyPI'|'Maven'|'Go'|'cargo'|'nuget'|'generic', name, version, purl?, cpe?, source }
// Inputs are bounded (bytes + component count) and anything that does not parse as the declared kind is
// rejected with a generic InventoryError — the raw upload is never echoed back or logged.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MAX_INVENTORY_BYTES = 5 * 1024 * 1024;
export const MAX_COMPONENTS = 5000;
export const INVENTORY_KINDS = ['cyclonedx', 'spdx', 'npm-lock', 'requirements', 'cpe'];
export const ECOSYSTEMS = ['npm', 'PyPI', 'Maven', 'Go', 'cargo', 'nuget', 'generic'];
export const SOURCES = ['sbom', 'lockfile', 'cpe-list', 'self'];

const NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9._@/:+ -]{0,199}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;
const INV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/;
const ID_RE = /^inv_[a-f0-9]{16}$/;

export class InventoryError extends Error {
  constructor(reason) {
    super('invalid inventory');
    this.name = 'InventoryError';
    this.reason = reason;
  }
}

// purl type → OSV ecosystem name. Unknown types stay 'generic' so they are still name-matchable.
const PURL_ECOSYSTEM = {
  npm: 'npm', pypi: 'PyPI', maven: 'Maven', golang: 'Go', cargo: 'cargo', nuget: 'nuget',
};

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export function normalizePackageName(name, ecosystem) {
  const n = clean(name);
  if (ecosystem === 'PyPI') return n.toLowerCase().replace(/[-_.]+/g, '-');
  if (ecosystem === 'npm' || ecosystem === 'nuget' || ecosystem === 'generic') return n.toLowerCase();
  return n;
}

export function parsePurl(purl) {
  const s = clean(purl, 400);
  const m = /^pkg:([a-z0-9.+-]+)\/(.+)$/i.exec(s);
  if (!m) return null;
  const type = m[1].toLowerCase();
  let rest = m[2];
  const hash = rest.indexOf('#'); if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf('?'); if (q >= 0) rest = rest.slice(0, q);
  const at = rest.lastIndexOf('@');
  let version = null;
  if (at > 0) { version = decodeURIComponent(rest.slice(at + 1)); rest = rest.slice(0, at); }
  const parts = rest.split('/').filter(Boolean).map(p => decodeURIComponent(p));
  if (!parts.length) return null;
  let name;
  if (type === 'maven' && parts.length >= 2) name = `${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
  else if (type === 'npm' && parts.length >= 2 && parts[0].startsWith('@')) name = `${parts[0]}/${parts[1]}`;
  else if (type === 'golang') name = parts.join('/');
  else name = parts[parts.length - 1];
  return { ecosystem: PURL_ECOSYSTEM[type] || 'generic', name, version, purl: s };
}

// CPE 2.3 formatted string: cpe:2.3:part:vendor:product:version:update:edition:language:sw_edition:target_sw:target_hw:other
export function parseCpe(line) {
  const s = clean(line, 400);
  if (!s.startsWith('cpe:2.3:')) return null;
  const f = s.split(':');
  if (f.length < 6) return null;
  const vendor = f[3], product = f[4], version = f[5];
  if (!product || product === '*' || product === '-') return null;
  return {
    ecosystem: 'generic',
    name: `${vendor === '*' || vendor === '-' ? '' : vendor + ':'}${product}`,
    version: version === '*' || version === '-' || !version ? null : version,
    cpe: s,
    vendor: vendor === '*' || vendor === '-' ? null : vendor,
    product,
  };
}

function component(base, source) {
  const ecosystem = ECOSYSTEMS.includes(base.ecosystem) ? base.ecosystem : 'generic';
  const name = clean(base.name);
  if (!NAME_RE.test(name)) return null;
  let version = base.version == null ? null : clean(base.version, 64);
  if (version !== null && !VERSION_RE.test(version)) version = null;
  const c = { ecosystem, name, version, source };
  if (base.purl) c.purl = clean(base.purl, 400);
  if (base.cpe) c.cpe = clean(base.cpe, 400);
  if (base.vendor) c.vendor = clean(base.vendor, 100);
  if (base.product) c.product = clean(base.product, 100);
  if (base.versionBasis) c.versionBasis = base.versionBasis;
  return c;
}

function dedupe(components) {
  const seen = new Set();
  const out = [];
  for (const c of components) {
    if (!c) continue;
    const k = `${c.ecosystem}|${normalizePackageName(c.name, c.ecosystem)}|${c.version ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length > MAX_COMPONENTS) throw new InventoryError('too many components');
  }
  return out;
}

function parseJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new InventoryError('not json'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new InventoryError('not an object');
  return doc;
}

export function parseCycloneDX(text) {
  const doc = parseJson(text);
  if (doc.bomFormat !== 'CycloneDX' || !Array.isArray(doc.components)) throw new InventoryError('not cyclonedx');
  if (doc.components.length > MAX_COMPONENTS) throw new InventoryError('too many components');
  return dedupe(doc.components.map(c => {
    if (!c || typeof c !== 'object') return null;
    const fromPurl = c.purl ? parsePurl(c.purl) : null;
    if (fromPurl) return component({ ...fromPurl, version: fromPurl.version ?? c.version ?? null }, 'sbom');
    if (c.cpe) { const cp = parseCpe(c.cpe); if (cp) return component({ ...cp, version: cp.version ?? c.version ?? null }, 'sbom'); }
    if (!c.name) return null;
    return component({ ecosystem: 'generic', name: c.name, version: c.version ?? null }, 'sbom');
  }));
}

export function parseSPDX(text) {
  const doc = parseJson(text);
  if (typeof doc.spdxVersion !== 'string' || !Array.isArray(doc.packages)) throw new InventoryError('not spdx');
  if (doc.packages.length > MAX_COMPONENTS) throw new InventoryError('too many components');
  return dedupe(doc.packages.map(p => {
    if (!p || typeof p !== 'object') return null;
    const refs = Array.isArray(p.externalRefs) ? p.externalRefs : [];
    const purlRef = refs.find(r => r && r.referenceType === 'purl' && typeof r.referenceLocator === 'string');
    const cpeRef = refs.find(r => r && /^cpe23Type$/i.test(String(r.referenceType)) && typeof r.referenceLocator === 'string');
    if (purlRef) {
      const pu = parsePurl(purlRef.referenceLocator);
      if (pu) return component({ ...pu, version: pu.version ?? p.versionInfo ?? null }, 'sbom');
    }
    if (cpeRef) {
      const cp = parseCpe(cpeRef.referenceLocator);
      if (cp) return component({ ...cp, version: cp.version ?? p.versionInfo ?? null }, 'sbom');
    }
    if (!p.name) return null;
    return component({ ecosystem: 'generic', name: p.name, version: p.versionInfo ?? null }, 'sbom');
  }));
}

export function parseNpmLock(text, source = 'lockfile') {
  const doc = parseJson(text);
  const lv = Number(doc.lockfileVersion);
  if (!(lv >= 2) || !doc.packages || typeof doc.packages !== 'object' || Array.isArray(doc.packages)) throw new InventoryError('not npm lockfile v2/v3');
  const entries = Object.entries(doc.packages);
  if (entries.length > MAX_COMPONENTS) throw new InventoryError('too many components');
  return dedupe(entries.map(([path, meta]) => {
    if (!path || !meta || typeof meta !== 'object' || !meta.version) return null;
    const idx = path.lastIndexOf('node_modules/');
    if (idx < 0) return null;
    const name = path.slice(idx + 'node_modules/'.length);
    if (meta.link) return null;
    return component({ ecosystem: 'npm', name, version: meta.version, purl: `pkg:npm/${name}@${meta.version}` }, source);
  }));
}

// requirements.txt: only exact pins (==, ===) yield a version. Ranges are kept as name-only components so a
// KEV hit can still surface as a name match, never as a confirmed exposure.
const REQ_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(===?|>=|~=)?\s*([A-Za-z0-9._+!*-]*)?/;
export function parseRequirements(text, source = 'lockfile') {
  if (typeof text !== 'string' || /[\u0000]/.test(text)) throw new InventoryError('not text');
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_COMPONENTS) throw new InventoryError('too many components');
  const out = [];
  let parsed = 0;
  for (let raw of lines) {
    raw = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').replace(/\\$/, '').trim();
    if (!raw || raw.startsWith('-')) continue;
    if (raw.includes('://') || raw.startsWith('.') || raw.startsWith('/')) continue;
    const m = REQ_LINE.exec(raw);
    if (!m) throw new InventoryError('bad requirement line');
    parsed++;
    const [, name, op, ver] = m;
    const base = { ecosystem: 'PyPI', name, version: null };
    if (op && ver) {
      if (op === '==' || op === '===') { base.version = ver.replace(/\.\*$/, ''); base.purl = `pkg:pypi/${name.toLowerCase()}@${base.version}`; }
      else { base.version = ver; base.versionBasis = 'lower-bound'; }
    }
    out.push(component(base, source));
  }
  if (!parsed) throw new InventoryError('no requirements');
  return dedupe(out);
}

export function parseCpeList(text) {
  if (typeof text !== 'string' || /[\u0000]/.test(text)) throw new InventoryError('not text');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length) throw new InventoryError('empty');
  if (lines.length > MAX_COMPONENTS) throw new InventoryError('too many components');
  const out = [];
  for (const l of lines) {
    const cp = parseCpe(l);
    if (!cp) throw new InventoryError('bad cpe line');
    out.push(component(cp, 'cpe-list'));
  }
  return dedupe(out);
}

const PARSERS = {
  cyclonedx: parseCycloneDX,
  spdx: parseSPDX,
  'npm-lock': (t) => parseNpmLock(t, 'lockfile'),
  requirements: (t) => parseRequirements(t, 'lockfile'),
  cpe: parseCpeList,
};

export function parseInventory(kind, buf) {
  if (!INVENTORY_KINDS.includes(kind)) throw new InventoryError('unsupported kind');
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_INVENTORY_BYTES) throw new InventoryError('bad size');
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD') && kind !== 'cpe') throw new InventoryError('not utf8');
  const components = PARSERS[kind](text);
  if (!components.length) throw new InventoryError('no components');
  return components;
}

// --- pyproject.toml [project].dependencies — minimal TOML reading, enough for PEP 621 dependency arrays.
export function parsePyprojectDependencies(text) {
  const src = String(text || '');
  const m = /^\s*dependencies\s*=\s*\[/m.exec(src);
  if (!m) return [];
  const items = [];
  let quote = null, cur = '';
  for (let i = m.index + m[0].length; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) { items.push(cur); cur = ''; quote = null; } else cur += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ']') break;
    else if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; }
  }
  if (!items.length) return [];
  try { return parseRequirements(items.join('\n'), 'self'); } catch { return []; }
}

// --- Self-scan: this repo's own lockfile + Python pins.
export function loadSelfInventory(root = ROOT) {
  const components = [];
  const files = [];
  const lock = join(root, 'package-lock.json');
  if (existsSync(lock)) {
    try { components.push(...parseNpmLock(readFileSync(lock, 'utf8'), 'self')); files.push('package-lock.json'); } catch { /* unreadable lockfile → skipped */ }
  }
  const py = join(root, 'ingest', 'pyproject.toml');
  if (existsSync(py)) {
    const deps = parsePyprojectDependencies(readFileSync(py, 'utf8'));
    if (deps.length) { components.push(...deps); files.push('ingest/pyproject.toml'); }
  }
  return { id: 'self', name: 'CRUCIX self-scan', kind: 'self', files, components: dedupe(components), createdAt: null };
}

// --- Persistence: runs/cyberfix/inventories/<id>.json
export function inventoriesDir(root = ROOT) { return join(root, 'runs', 'cyberfix', 'inventories'); }

export function validInventoryId(id) { return typeof id === 'string' && ID_RE.test(id); }
export function validInventoryName(name) { return typeof name === 'string' && INV_NAME_RE.test(name); }

export function saveInventory({ kind, name, components }, root = ROOT) {
  const dir = inventoriesDir(root);
  mkdirSync(dir, { recursive: true });
  const id = `inv_${randomBytes(8).toString('hex')}`;
  const rec = { id, name: validInventoryName(name) ? name : `${kind} upload`, kind, createdAt: new Date().toISOString(), componentCount: components.length, components };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec));
  console.log(JSON.stringify({ timestamp: rec.createdAt, event: 'cyberfix_inventory_saved', id, kind, components: components.length }));
  return rec;
}

export function deleteInventory(id, root = ROOT) {
  if (!validInventoryId(id)) return false;
  const file = join(inventoriesDir(root), `${id}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_inventory_deleted', id }));
  return true;
}

export function loadUploadedInventories(root = ROOT) {
  const dir = inventoriesDir(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (rec && validInventoryId(rec.id) && Array.isArray(rec.components)) out.push(rec);
    } catch { /* corrupt file → ignored */ }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function summarizeInventory(inv) {
  const byEco = {};
  for (const c of inv.components || []) byEco[c.ecosystem] = (byEco[c.ecosystem] || 0) + 1;
  const source = inv.id === 'self' ? 'self' : (inv.components?.[0]?.source || null);
  return { id: inv.id, name: inv.name, kind: inv.kind, source, createdAt: inv.createdAt, files: inv.files || null, componentCount: (inv.components || []).length, byEcosystem: byEco };
}
