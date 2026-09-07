// OFAC Narco — Treasury SDN entries under the counter-narcotics / transnational-crime programs
// (SDNTK, SDNT, ILLICIT-DRUGS-EO14059, TCO) plus FTO/SDGT-designated cartels, indexed for entity
// matching against names and groups extracted from cartel reporting and DOJ prosecutions.
//
// The full SDN.XML is ~29 MB, so it is refreshed at most once per OFAC_NARCO_REFRESH_HOURS and only
// when the server's Last-Modified changes; the compact index persists under runs/ofacnarco/.
//
//   status: live | stale | error   (live = index present and verified against the list this cycle)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fold } from '../../lib/narco/gazetteer.mjs';
import { loadGroups, findGroups } from '../../lib/narco/groups.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/ofacnarco');
export const SDN_XML_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
export const INDEX_SCHEMA = 'ofac-narco-index/1';

export const NARCO_PROGRAMS = ['SDNTK', 'SDNT', 'ILLICIT-DRUGS-EO14059', 'TCO'];
export const TERROR_PROGRAMS = ['FTO', 'SDGT'];
const REFRESH_HOURS = clampNum(process.env.OFAC_NARCO_REFRESH_HOURS, 1, 168, 24);
const MAX_REMARKS = 400;
const MAX_XML_BYTES = 120 * 1024 * 1024;

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function readJson(file, dflt) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt; } catch { return dflt; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}
const unesc = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const tag = (xml, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml); return m ? unesc(m[1]).trim() : ''; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map(m => unesc(m[1]).trim()).filter(Boolean);
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);

export function displayName(first, last) {
  return [first, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// One <sdnEntry> -> compact record, or null when it is outside the narco/TCO scope.
export function parseEntry(xml) {
  const programs = tags(blocks(xml, 'programList')[0] || '', 'program');
  const narco = programs.filter(p => NARCO_PROGRAMS.includes(p));
  const terror = programs.filter(p => TERROR_PROGRAMS.includes(p));
  const countries = new Set([
    ...blocks(xml, 'address').map(a => tag(a, 'country')),
    ...blocks(xml, 'nationality').map(n => tag(n, 'country')),
    ...blocks(xml, 'citizenship').map(n => tag(n, 'country')),
    ...blocks(xml, 'id').map(i => tag(i, 'idCountry')),
    ...tags(xml, 'placeOfBirth').map(p => p.split(',').pop().trim()),
  ].filter(Boolean));
  const mexico = countries.has('Mexico');
  if (!narco.length && !(terror.length && mexico)) return null;

  const first = tag(xml.split('<akaList>')[0], 'firstName');
  const last = tag(xml.split('<akaList>')[0], 'lastName');
  const akas = blocks(blocks(xml, 'akaList')[0] || '', 'aka').map(a => ({
    name: displayName(tag(a, 'firstName'), tag(a, 'lastName')),
    category: tag(a, 'category') || 'weak',
  })).filter(a => a.name);
  const ids = blocks(blocks(xml, 'idList')[0] || '', 'id').map(i => ({ type: tag(i, 'idType'), value: tag(i, 'idNumber') }));
  const orgType = ids.find(i => /Organization Type|Target Type/i.test(i.type))?.value || null;
  return {
    uid: Number(tag(xml, 'uid')) || null,
    name: displayName(first, last),
    type: tag(xml, 'sdnType') || 'Unknown',
    programs,
    narcoPrograms: narco,
    terrorPrograms: terror,
    akas: akas.slice(0, 40),
    countries: [...countries].sort(),
    mexico,
    dob: tags(xml, 'dateOfBirth')[0] || null,
    pob: tags(xml, 'placeOfBirth')[0] || null,
    orgType,
    remarks: tag(xml, 'remarks').slice(0, MAX_REMARKS) || null,
  };
}

export function parseSDN(xml, { groups = loadGroups() } = {}) {
  const publishDate = tag(xml, 'Publish_Date') || null;
  const recordCount = Number(tag(xml, 'Record_Count')) || null;
  const entries = [];
  let scanned = 0;
  for (const m of xml.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    scanned++;
    const e = parseEntry(m[1]);
    if (!e) continue;
    const g = findGroups([e.name, ...e.akas.map(a => a.name)].join(' | '), groups);
    e.groups = [...new Set([...g.cartels.map(c => c.orgId), ...g.factions.map(f => f.orgId)])];
    const linked = e.remarks ? findGroups(e.remarks, groups) : null;
    e.linkedGroups = linked ? [...new Set([...linked.cartels.map(c => c.orgId), ...linked.factions.map(f => f.orgId)])].filter(x => !e.groups.includes(x)) : [];
    entries.push(e);
  }
  return { schema: INDEX_SCHEMA, publishDate, recordCount, scanned, entries };
}

// ---- name matching -------------------------------------------------------------------------

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'el', 'da', 'do', 'dos', 'van', 'von']);
export function nameTokens(name) {
  return fold(name).split(' ').filter(t => t && !PARTICLES.has(t) && t.length > 1);
}

export function buildNameIndex(index) {
  const byToken = new Map();
  const variants = [];
  index.entries.forEach((e, i) => {
    const names = [{ name: e.name, category: 'primary' }, ...e.akas];
    for (const n of names) {
      const toks = nameTokens(n.name);
      if (!toks.length) continue;
      const v = { entry: i, name: n.name, category: n.category, toks: new Set(toks), key: toks.join(' ') };
      variants.push(v);
      for (const t of toks) { if (!byToken.has(t)) byToken.set(t, []); byToken.get(t).push(v); }
    }
  });
  return { byToken, variants };
}

// A query name matches when all its tokens appear in a listed name variant and the variant is at most
// one token longer (exact), or when they share three or more tokens (partial). A lone given name never
// matches, and weak a.k.a. variants only count for exact matches.
export function matchName(name, index, nameIdx) {
  const qToks = nameTokens(name);
  if (qToks.length < 2) return null;
  const candidates = new Set();
  for (const t of qToks) for (const v of nameIdx.byToken.get(t) || []) candidates.add(v);
  let best = null;
  for (const v of candidates) {
    const shared = qToks.filter(t => v.toks.has(t)).length;
    let strength = null;
    if (shared === qToks.length && shared >= 2 && v.toks.size <= qToks.length + 1) strength = 'exact';
    else if (shared >= 3) strength = 'partial';
    if (!strength) continue;
    if (v.category === 'weak' && strength === 'partial') continue;
    const score = shared * 10 + (strength === 'exact' ? 5 : 0) + (v.category === 'primary' ? 2 : v.category === 'strong' ? 1 : 0);
    if (!best || score > best.score) best = { entry: index.entries[v.entry], matchedName: v.name, category: v.category, strength, score, shared };
  }
  return best;
}

export function matchNames(names, index, nameIdx = buildNameIndex(index)) {
  const out = [];
  for (const n of names || []) {
    const m = matchName(typeof n === 'string' ? n : n.name, index, nameIdx);
    if (!m) continue;
    const e = m.entry;
    out.push({
      query: typeof n === 'string' ? n : n.name,
      uid: e.uid, name: e.name, type: e.type, programs: e.programs, matchedName: m.matchedName, akaCategory: m.category, strength: m.strength,
      countries: e.countries, dob: e.dob, url: sdnSearchUrl(e.name),
    });
  }
  return out;
}

export function sdnSearchUrl(name) {
  return `https://sanctionssearch.ofac.treas.gov/?q=${encodeURIComponent(String(name || '').slice(0, 120))}`;
}

// Organisation-level designations for cartel orgIds (Sinaloa Cartel -> FTO/SDGT/SDNTK/...).
export function groupDesignations(index) {
  const out = {};
  for (const e of index.entries) {
    if (e.type !== 'Entity') continue;
    for (const g of e.groups || []) {
      if (!out[g]) out[g] = [];
      out[g].push({ uid: e.uid, name: e.name, programs: e.programs, orgType: e.orgType, url: sdnSearchUrl(e.name) });
    }
  }
  return out;
}

export function summarizeIndex(index) {
  const byProgram = {};
  let individuals = 0, entities = 0, mexico = 0;
  for (const e of index.entries) {
    for (const p of e.programs) byProgram[p] = (byProgram[p] || 0) + 1;
    if (e.type === 'Individual') individuals++; else if (e.type === 'Entity') entities++;
    if (e.mexico) mexico++;
  }
  return { entries: index.entries.length, individuals, entities, mexicoLinked: mexico, byProgram, publishDate: index.publishDate, recordCount: index.recordCount };
}

async function headLastModified(fetchImpl, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SDN_XML_URL, { method: 'HEAD', signal: controller.signal, headers: { 'User-Agent': 'Crucix/1.0' } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, lastModified: res.headers.get('last-modified') || null, digest: res.headers.get('digest') || null };
  } catch (e) {
    return { ok: false, reason: /abort/i.test(e?.message || '') ? 'timed out' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

async function downloadXml(fetchImpl, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SDN_XML_URL, { signal: controller.signal, headers: { 'User-Agent': 'Crucix/1.0', Accept: 'text/xml' } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.length > MAX_XML_BYTES) return { ok: false, reason: 'payload too large' };
    if (!/<sdnList[\s>]/.test(text.slice(0, 2000))) return { ok: false, reason: 'unexpected payload' };
    return { ok: true, text, lastModified: res.headers.get('last-modified') || null };
  } catch (e) {
    return { ok: false, reason: /abort/i.test(e?.message || '') ? 'timed out' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

export function loadIndex(dataDir = DEFAULT_DATA_DIR) {
  const idx = readJson(join(dataDir, 'index.json'), null);
  return idx && idx.schema === INDEX_SCHEMA && Array.isArray(idx.entries) ? idx : null;
}

export async function briefing(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const now = opts.now || Date.now();
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const persist = opts.persist !== false;
  const refreshHours = opts.refreshHours ?? REFRESH_HOURS;
  const collectedAt = new Date(now).toISOString();

  let index = loadIndex(dataDir);
  const state = readJson(join(dataDir, 'state.json'), {});
  const lastCheck = state.lastChecked ? new Date(state.lastChecked).getTime() : 0;
  const due = !index || !Number.isFinite(lastCheck) || (now - lastCheck) >= refreshHours * 3_600_000 || opts.force === true;

  let action = 'cached';
  let error = null;
  if (due) {
    const head = await headLastModified(fetchImpl);
    if (head.ok && index && state.lastModified && head.lastModified === state.lastModified) {
      action = 'unchanged';
      state.lastChecked = collectedAt;
    } else {
      const dl = await downloadXml(fetchImpl);
      if (dl.ok) {
        const parsed = parseSDN(dl.text, opts.groups ? { groups: opts.groups } : {});
        if (parsed.entries.length) {
          index = { ...parsed, fetchedAt: collectedAt, lastModified: dl.lastModified || head.lastModified || null };
          state.lastChecked = collectedAt;
          state.lastModified = index.lastModified;
          state.lastRefreshed = collectedAt;
          action = 'refreshed';
          if (persist) writeJson(join(dataDir, 'index.json'), index);
        } else {
          error = 'SDN list parsed to zero narco entries';
          action = 'failed';
        }
      } else {
        error = `SDN list ${dl.reason}`;
        action = 'failed';
      }
    }
    if (persist) writeJson(join(dataDir, 'state.json'), state);
  }

  let status = 'live';
  if (!index) status = 'error';
  else if (action === 'failed') status = 'stale';
  const summary = index ? summarizeIndex(index) : null;
  return {
    source: 'OFACNarco',
    timestamp: collectedAt,
    status,
    ...(error ? { error } : {}),
    ...(status === 'stale' ? { stale: true, note: `refresh failed; using index fetched ${index.fetchedAt}` } : {}),
    schema: INDEX_SCHEMA,
    listUrl: SDN_XML_URL,
    programs: { narco: NARCO_PROGRAMS, terror: TERROR_PROGRAMS },
    refresh: { action, hours: refreshHours, lastChecked: state.lastChecked || null, lastRefreshed: state.lastRefreshed || null, listLastModified: state.lastModified || null },
    summary,
    designatedGroups: index ? groupDesignations(index) : {},
    lastChanged: state.lastRefreshed || null,
  };
}
