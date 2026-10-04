#!/usr/bin/env node
// Detector self-test for the vendored Sherlock manifest. Each site ships a `username_claimed`
// example that must be reported as found; sites whose detector no longer agrees are written to
// config/sherlock/health.json and skipped by normal handle sweeps until the next passing run.
// Transient outcomes (error, WAF challenge) never disable a site. Usage:
//   node scripts/sherlock-selftest.mjs [--pool 16] [--only Site1,Site2] [--dry-run] [--verbose]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, probeSite, MANIFEST_DIR } from '../lib/sherlock.mjs';
import { probe } from '../apis/sources/osint.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const pool = Math.max(1, Math.min(64, Number(opt('--pool', 16)) || 16));
const only = opt('--only', '') ? new Set(opt('--only', '').split(',').map(s => s.trim())) : null;
const dir = opt('--dir', MANIFEST_DIR);

const m = loadManifest({ dir, force: true });
const sites = m.sites.filter(s => s.usernameClaimed && (!only || only.has(s.name)));
const disabled = {};
const kept = { ...m.health.disabled };
const tally = { pass: 0, fail: 0, error: 0, waf: 0, illegal: 0, skipped: m.sites.length - sites.length };
let i = 0;
await Promise.all(Array.from({ length: pool }, async () => {
  while (i < sites.length) {
    const site = sites[i++];
    const r = await probeSite(site, site.usernameClaimed, probe, { timeout: 12000 });
    if (r.status === 'found') { tally.pass++; delete kept[site.name]; }
    else if (r.status === 'not_found') { tally.fail++; disabled[site.name] = { reason: `claimed example "${site.usernameClaimed}" reported not_found`, detector: site.errorType, http: r.http, at: new Date().toISOString() }; }
    else tally[r.status in tally ? r.status : 'error']++;
    if (flag('--verbose') || r.status === 'not_found') console.log(`${r.status.padEnd(9)} ${site.name} (${site.errorType}${r.http ? ` http ${r.http}` : ''}${r.error ? ` ${r.error}` : ''})`);
  }
}));

// Sites that errored or were challenged keep their previous disabled state (stale detectors stay
// off until a run can actually confirm them); sites that passed were re-enabled above.
const next = { ...kept, ...disabled };
const health = { checkedAt: new Date().toISOString(), sites: sites.length, pass: tally.pass, fail: tally.fail, error: tally.error, waf: tally.waf, disabled: next };
console.log(`self-test: ${tally.pass} pass · ${tally.fail} detector failures (disabled) · ${tally.waf} challenged · ${tally.error} unreachable · ${tally.illegal} illegal · ${tally.skipped} without example · carried over ${Object.keys(kept).length} previously disabled`);
if (flag('--dry-run')) process.exit(0);
writeFileSync(join(dir, 'health.json'), JSON.stringify(health, null, 2) + '\n');
console.log(`wrote ${join(dir, 'health.json')} (${Object.keys(next).length} disabled)`);
