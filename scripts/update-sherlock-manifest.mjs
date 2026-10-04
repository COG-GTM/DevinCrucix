#!/usr/bin/env node
// Refresh the vendored Sherlock site manifest (config/sherlock/data.json) from a pinned upstream
// commit and record the pin in MANIFEST.json. Entries that fail normalization are reported and
// the run aborts unless --force. Usage:
//   node scripts/update-sherlock-manifest.mjs [--ref <commit|branch>] [--force] [--dry-run]
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeSite, MANIFEST_DIR } from '../lib/sherlock.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPO = 'sherlock-project/sherlock';
const PATH = 'sherlock_project/resources/data.json';
const ref = opt('--ref', 'master');
const dir = opt('--dir', MANIFEST_DIR);

async function gh(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'crucix-sherlock-update', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

const commit = (await (await gh(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`)).json()).sha;
const text = await (await gh(`https://raw.githubusercontent.com/${REPO}/${commit}/${PATH}`)).text();
const raw = JSON.parse(text);
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest is not an object map');

const names = Object.keys(raw).filter(k => k !== '$schema');
const invalid = [];
let nsfw = 0;
for (const name of names) {
  const site = normalizeSite(name, raw[name]);
  if (!site) invalid.push(name); else if (site.nsfw) nsfw++;
}
let previous = {};
try { previous = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')); } catch { /* first run */ }
const prevNames = (() => { try { return new Set(Object.keys(JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')))); } catch { return new Set(); } })();
const added = names.filter(n => !prevNames.has(n));
const removed = [...prevNames].filter(n => n !== '$schema' && !names.includes(n));

console.log(`Sherlock ${ref} @ ${commit.slice(0, 12)}: ${names.length} sites (${nsfw} NSFW), +${added.length} / -${removed.length} vs ${previous.commit ? previous.commit.slice(0, 12) : 'none'}`);
if (added.length) console.log('  added:  ' + added.join(', '));
if (removed.length) console.log('  removed: ' + removed.join(', '));
if (invalid.length) console.log(`  ${invalid.length} entries fail normalization: ${invalid.join(', ')}`);
if (invalid.length > Math.max(5, names.length * 0.02) && !flag('--force')) {
  console.error('Too many invalid entries — upstream schema may have changed. Inspect lib/sherlock.mjs normalizeSite(), or re-run with --force.');
  process.exit(2);
}
if (flag('--dry-run')) process.exit(0);

writeFileSync(join(dir, 'data.json'), text.endsWith('\n') ? text : text + '\n');
writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({
  source: `https://github.com/${REPO}`, path: PATH, commit, ref, license: 'MIT',
  fetchedAt: new Date().toISOString().slice(0, 10), sites: names.length, nsfw, invalid,
}, null, 2) + '\n');
console.log(`Wrote ${join(dir, 'data.json')} and MANIFEST.json. Run \`npm run sherlock:selftest\` to re-check detectors, then \`npm test\`.`);
