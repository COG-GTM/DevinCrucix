// Cyberfix — dependency-free version comparison, good enough for OSV affected ranges.
//   compareSemverish: dotted numerics with optional pre-release ("1.2.3-beta.1", "v2.0", "1.0.0-rc1").
//   comparePep440:    PEP 440 public versions ("1.0a1", "2.1.post1", "3.0.dev2", "1!1.0", "1.0rc1").
// Both return -1 / 0 / 1 and null when either side cannot be parsed.

const PRE_ORDER = { dev: -3, a: -2, alpha: -2, b: -1, beta: -1, rc: 0, c: 0, pre: 0, preview: 0 };

export function parseSemverish(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/^[vV=]+/, '');
  if (!s) return null;
  const plus = s.indexOf('+'); if (plus >= 0) s = s.slice(0, plus);
  const m = /^(\d+(?:\.\d+)*)(?:[-.]?([A-Za-z][A-Za-z0-9.-]*))?$/.exec(s);
  if (!m) return null;
  const nums = m[1].split('.').map(n => parseInt(n, 10));
  const pre = m[2] ? m[2].split(/[.-]/).filter(Boolean).map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase())) : null;
  return { nums, pre };
}

function cmpNumArrays(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function cmpPre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;   // release > pre-release
  if (!b) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn) return x < y ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    const xo = PRE_ORDER[x], yo = PRE_ORDER[y];
    if (xo !== undefined && yo !== undefined && xo !== yo) return xo < yo ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareSemverish(a, b) {
  const pa = parseSemverish(a), pb = parseSemverish(b);
  if (!pa || !pb) return null;
  return cmpNumArrays(pa.nums, pb.nums) || cmpPre(pa.pre, pb.pre);
}

const PEP440 = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\d*)))?(?:[-_.]?(dev)[-_.]?(\d*))?(?:\+[A-Za-z0-9.]+)?$/i;
const PEP_PRE = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

export function parsePep440(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^[vV]/, '');
  const m = PEP440.exec(s);
  if (!m) return null;
  const epoch = m[1] ? parseInt(m[1], 10) : 0;
  const release = m[2].split('.').map(n => parseInt(n, 10));
  const pre = m[3] ? [PEP_PRE[m[3].toLowerCase()], m[4] ? parseInt(m[4], 10) : 0] : null;
  const post = m[5] !== undefined ? parseInt(m[5], 10) : (m[6] ? (m[7] ? parseInt(m[7], 10) : 0) : null);
  const dev = m[8] ? (m[9] ? parseInt(m[9], 10) : 0) : null;
  return { epoch, release, pre, post, dev };
}

// Ordering key per PEP 440: epoch, release, then (dev < pre < final < post) with dev/post modifiers.
function pepKey(p) {
  let stage;
  if (p.pre) stage = [1, p.pre[0], p.pre[1]];
  else if (p.post === null && p.dev !== null) stage = [0, 0, 0];
  else stage = [2, 0, 0];
  return { epoch: p.epoch, release: p.release, stage, post: p.post === null ? -1 : p.post, dev: p.dev === null ? Infinity : p.dev };
}

export function comparePep440(a, b) {
  const pa = parsePep440(a), pb = parsePep440(b);
  if (!pa || !pb) return null;
  const ka = pepKey(pa), kb = pepKey(pb);
  if (ka.epoch !== kb.epoch) return ka.epoch < kb.epoch ? -1 : 1;
  const r = cmpNumArrays(ka.release, kb.release); if (r) return r;
  const s = cmpNumArrays(ka.stage, kb.stage); if (s) return s;
  if (ka.post !== kb.post) return ka.post < kb.post ? -1 : 1;
  if (ka.dev !== kb.dev) return ka.dev < kb.dev ? -1 : 1;
  return 0;
}

export function compareVersions(a, b, ecosystem) {
  if (ecosystem === 'PyPI') return comparePep440(a, b) ?? compareSemverish(a, b);
  return compareSemverish(a, b) ?? comparePep440(a, b);
}

// OSV range semantics: events sorted; introduced ≤ v < fixed (or ≤ last_affected). Returns
// { affected: bool|null, introduced, fixed, lastAffected } — null when the version is not comparable.
export function versionInRange(version, range, ecosystem) {
  if (!range || !Array.isArray(range.events)) return { affected: null };
  const type = range.type || 'ECOSYSTEM';
  if (type === 'GIT') return { affected: null };
  let introduced = null, fixed = null, lastAffected = null;
  let inside = false, hit = null;
  for (const ev of range.events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.introduced !== undefined) {
      introduced = String(ev.introduced); fixed = null; lastAffected = null;
      inside = introduced === '0' || (compareVersions(version, introduced, ecosystem) ?? -1) >= 0;
      if (inside) hit = { introduced, fixed: null, lastAffected: null };
      else if (compareVersions(version, introduced, ecosystem) === null) return { affected: null };
    } else if (ev.fixed !== undefined && inside) {
      fixed = String(ev.fixed);
      const c = compareVersions(version, fixed, ecosystem);
      if (c === null) return { affected: null };
      if (c < 0) return { affected: true, introduced, fixed, lastAffected: null };
      inside = false; hit = null;
    } else if (ev.last_affected !== undefined && inside) {
      lastAffected = String(ev.last_affected);
      const c = compareVersions(version, lastAffected, ecosystem);
      if (c === null) return { affected: null };
      if (c <= 0) return { affected: true, introduced, fixed: null, lastAffected };
      inside = false; hit = null;
    }
  }
  if (hit) return { affected: true, ...hit };
  return { affected: false, introduced, fixed, lastAffected };
}

// Describe a range for the evidence chain: ">= 1.2.0, < 1.2.5".
export function describeRange(r) {
  if (!r) return null;
  const parts = [];
  if (r.introduced && r.introduced !== '0') parts.push(`>= ${r.introduced}`);
  if (r.fixed) parts.push(`< ${r.fixed}`);
  else if (r.lastAffected) parts.push(`<= ${r.lastAffected}`);
  return parts.length ? parts.join(', ') : 'all versions';
}
