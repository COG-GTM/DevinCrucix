#!/usr/bin/env node
// Build the local ICIJ Offshore Leaks index (SQLite + FTS5, Node's built-in node:sqlite — no native deps).
//
//   node scripts/build-offshoreleaks.mjs [--download] [--src DIR] [--out FILE]
//   node scripts/build-offshoreleaks.mjs --snapshot --seeds config/finance-seeds.json --from FULL.sqlite --out config/offshoreleaks-demo-snapshot.sqlite.gz
//
// --download fetches https://offshoreleaks-data.icij.org/offshoreleaks/csv/full-oldb.LATEST.zip (~300 MB) into
// --src (default runs/finance/oldb) and extracts it with python3 (present in the production image).
// The full build streams ~5.3 M CSV rows into a temp file and atomically renames it over --out so the
// dashboard keeps serving the previous index until the new one is complete.
// --snapshot copies a bounded 2-hop neighbourhood around the demo seeds into a small gzipped index that is
// committed under config/ so cold starts (no volume, no download yet) still demo.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, createWriteStream, createReadStream, readFileSync, writeFileSync } from 'fs';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { csvObjects } from '../lib/finance/csv.mjs';
import { DDL, INDEX_DDL, SCHEMA } from '../lib/finance/schema.mjs';
import { fold } from '../lib/finance/match.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const ICIJ_ZIP_URL = 'https://offshoreleaks-data.icij.org/offshoreleaks/csv/full-oldb.LATEST.zip';
export const DEFAULT_SRC = join(ROOT, 'runs/finance/oldb');
export const DEFAULT_OUT = join(ROOT, 'runs/finance/offshoreleaks.sqlite');

const FILES = {
  entity: 'nodes-entities.csv', officer: 'nodes-officers.csv', intermediary: 'nodes-intermediaries.csv',
  address: 'nodes-addresses.csv', other: 'nodes-others.csv',
};

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true; }
    else o._.push(a);
  }
  return o;
}
const log = (...m) => console.error('[offshoreleaks]', ...m);
const clean = v => { const s = String(v ?? '').trim(); return s === '' ? null : s; };

export function openForWrite(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536;');
  db.exec(DDL);
  return db;
}

export async function download(srcDir, fetchImpl = fetch) {
  mkdirSync(srcDir, { recursive: true });
  const zip = join(srcDir, 'full-oldb.LATEST.zip');
  log('downloading', ICIJ_ZIP_URL);
  const res = await fetchImpl(ICIJ_ZIP_URL, { headers: { 'User-Agent': 'Crucix/1.0 (+offshore-leaks index)' } });
  if (!res.ok || !res.body) throw new Error(`ICIJ download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  log('downloaded', (statSync(zip).size / 1e6).toFixed(0), 'MB; extracting');
  const r = spawnSync('python3', ['-m', 'zipfile', '-e', zip, srcDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('zip extraction failed (python3 -m zipfile)');
  rmSync(zip, { force: true });
  return srcDir;
}

function releaseDate(srcDir) {
  try {
    const gen = spawnSync('ls', [srcDir], { encoding: 'utf8' }).stdout.split('\n').find(f => /^GENERATED_ON_(\d{8})/.test(f));
    const m = gen && /GENERATED_ON_(\d{4})(\d{2})(\d{2})/.exec(gen);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  } catch { return null; }
}

export async function buildFull({ src = DEFAULT_SRC, out = DEFAULT_OUT, onProgress = log } = {}) {
  for (const f of Object.values(FILES).concat('relationships.csv')) if (!existsSync(join(src, f))) throw new Error(`missing ${join(src, f)} — run with --download`);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.building`;
  rmSync(tmp, { force: true });
  const db = openForWrite(tmp);
  const insNode = db.prepare(`INSERT OR REPLACE INTO nodes (id, kind, name, name_fold, original_name, former_name, jurisdiction, jurisdiction_description, company_type, address,
    incorporation_date, inactivation_date, struck_off_date, dorm_date, status, service_provider, countries, country_codes, source, valid_until, note, other_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insEdge = db.prepare('INSERT INTO edges (src, dst, rel, link, status, start_date, end_date, source) VALUES (?,?,?,?,?,?,?,?)');
  const counts = {};
  const started = Date.now();
  db.exec('BEGIN');
  let n = 0;
  for (const [kind, file] of Object.entries(FILES)) {
    let k = 0;
    for await (const r of csvObjects(join(src, file))) {
      const id = Number(r.node_id); if (!Number.isInteger(id)) continue;
      const name = clean(r.name) || (kind === 'address' ? clean(r.address) : null) || `(unnamed ${kind} ${id})`;
      insNode.run(id, kind, name, fold(name), clean(r.original_name), clean(r.former_name), clean(r.jurisdiction), clean(r.jurisdiction_description),
        clean(r.company_type), clean(r.address), clean(r.incorporation_date), clean(r.inactivation_date), clean(r.struck_off_date), clean(r.dorm_date),
        clean(r.status), clean(r.service_provider), clean(r.countries), clean(r.country_codes), clean(r.sourceID) || 'ICIJ Offshore Leaks', clean(r.valid_until), clean(r.note), clean(r.type));
      k++; if (++n % 200000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); onProgress(`${n} rows…`); }
    }
    counts[kind] = k;
  }
  let e = 0;
  for await (const r of csvObjects(join(src, 'relationships.csv'))) {
    const s = Number(r.node_id_start), d = Number(r.node_id_end);
    if (!Number.isInteger(s) || !Number.isInteger(d)) continue;
    insEdge.run(s, d, clean(r.rel_type) || 'connected_to', clean(r.link), clean(r.status), clean(r.start_date), clean(r.end_date), clean(r.sourceID));
    if (++e % 500000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); onProgress(`${e} edges…`); }
  }
  counts.edges = e;
  db.exec('COMMIT');
  onProgress('indexing');
  db.exec(INDEX_DDL);
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  writeMeta(db, { schema: SCHEMA, mode: 'full', builtAt: new Date().toISOString(), release: releaseDate(src), counts, source: ICIJ_ZIP_URL, buildMs: Date.now() - started });
  db.exec('PRAGMA optimize'); db.close();
  renameSync(tmp, out);
  onProgress(`done in ${((Date.now() - started) / 1000).toFixed(0)}s → ${out}`);
  return { out, counts };
}

function writeMeta(db, meta) {
  const ins = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) ins.run(k, typeof v === 'string' ? v : JSON.stringify(v));
}

/** Bounded 2-hop neighbourhood around the seed node ids (max `fan` edges per node per hop). */
export function buildSnapshot({ from = DEFAULT_OUT, seeds, out, hops = 2, fan = 40 }) {
  const full = new DatabaseSync(from, { readOnly: true });
  const seedIds = seeds.flatMap(s => s.ids || []).map(Number).filter(Number.isInteger);
  const byName = full.prepare('SELECT id FROM nodes WHERE name_fold = ? LIMIT 5');
  for (const s of seeds) for (const q of s.names || []) for (const r of byName.all(fold(q))) seedIds.push(r.id);
  const keep = new Set(seedIds);
  const nbr = full.prepare('SELECT dst AS o FROM edges WHERE src = ? UNION SELECT src AS o FROM edges WHERE dst = ? LIMIT ?');
  let frontier = [...keep];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const id of frontier) for (const r of nbr.all(id, id, fan)) if (!keep.has(r.o)) { keep.add(r.o); next.push(r.o); }
    frontier = next;
  }
  const tmp = `${out}.tmp.sqlite`; rmSync(tmp, { force: true });
  const db = openForWrite(tmp);
  const getNode = full.prepare('SELECT * FROM nodes WHERE id = ?');
  const cols = ['id', 'kind', 'name', 'name_fold', 'original_name', 'former_name', 'jurisdiction', 'jurisdiction_description', 'company_type', 'address', 'incorporation_date', 'inactivation_date', 'struck_off_date', 'dorm_date', 'status', 'service_provider', 'countries', 'country_codes', 'source', 'valid_until', 'note', 'other_type'];
  const insNode = db.prepare(`INSERT OR REPLACE INTO nodes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const insEdge = db.prepare('INSERT INTO edges (src, dst, rel, link, status, start_date, end_date, source) VALUES (?,?,?,?,?,?,?,?)');
  const edgesOf = full.prepare('SELECT * FROM edges WHERE src = ? OR dst = ?');
  db.exec('BEGIN');
  let nodes = 0, edges = 0;
  for (const id of keep) { const r = getNode.get(id); if (r) { insNode.run(...cols.map(c => r[c] ?? null)); nodes++; } }
  const seen = new Set();
  for (const id of keep) for (const e of edgesOf.all(id, id)) {
    if (!keep.has(e.src) || !keep.has(e.dst)) continue;
    const k = `${e.src}|${e.dst}|${e.rel}|${e.link || ''}`; if (seen.has(k)) continue; seen.add(k);
    insEdge.run(e.src, e.dst, e.rel, e.link, e.status, e.start_date, e.end_date, e.source); edges++;
  }
  db.exec('COMMIT'); db.exec(INDEX_DDL); db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  const fullMeta = Object.fromEntries(full.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
  writeMeta(db, { schema: SCHEMA, mode: 'snapshot', builtAt: new Date().toISOString(), release: fullMeta.release || null, counts: { nodes, edges, seeds: seedIds.length }, source: ICIJ_ZIP_URL, fullCounts: fullMeta.counts || null });
  db.exec('VACUUM'); db.close(); full.close();
  return { tmp, nodes, edges };
}

export async function gzipFile(src, dst) { await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dst)); }
export async function gunzipFile(src, dst) { mkdirSync(dirname(dst), { recursive: true }); const tmp = `${dst}.tmp`; await pipeline(createReadStream(src), createGunzip(), createWriteStream(tmp)); renameSync(tmp, dst); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  try {
    if (a.snapshot) {
      const seedsFile = resolve(a.seeds || join(ROOT, 'config/finance-seeds.json'));
      const seeds = JSON.parse(readFileSync(seedsFile, 'utf8')).seeds;
      // SDN ∩ Offshore Leaks leads (lib/finance computeOverlaps) ride along so the cold-start demo can screen too.
      const overlapsFile = resolve(a.overlaps || join(ROOT, 'runs/finance/overlaps.json'));
      if (existsSync(overlapsFile)) { const ov = JSON.parse(readFileSync(overlapsFile, 'utf8')); seeds.push({ names: [], ids: (ov.leads || []).slice(0, Number(a.leads) || 120).map(l => Number(String(l.icij.id).replace('icij:', ''))) }); }
      const out = resolve(a.out || join(ROOT, 'config/offshoreleaks-demo-snapshot.sqlite.gz'));
      const { tmp, nodes, edges } = buildSnapshot({ from: resolve(a.from || DEFAULT_OUT), seeds, out, hops: Number(a.hops) || 2, fan: Number(a.fan) || 40 });
      await gzipFile(tmp, out); rmSync(tmp, { force: true });
      log(`snapshot: ${nodes} nodes, ${edges} edges → ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
    } else {
      const src = resolve(a.src || DEFAULT_SRC);
      if (a.download) await download(src);
      await buildFull({ src, out: resolve(a.out || DEFAULT_OUT) });
    }
  } catch (err) { log('FAILED', err.message); process.exit(1); }
}
