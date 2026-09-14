// lib/cyberfix/index.mjs — orchestration: KEV catalog → inventories (self + uploaded) → OSV → exposures,
// run-to-run diff, auto-remediation gating, single-flight reruns, and the summary shape consumed by the
// dashboard and the Situation rule. Recorded fixtures only; the injected fetch fails on anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createCyberfix, KEV_URL, INVENTORY_KINDS, MAX_INVENTORY_BYTES, InventoryError, DevinApiError } from '../lib/cyberfix/index.mjs';
import { OSV_BASE } from '../lib/cyberfix/resolve.mjs';
import { DISABLED_REASON } from '../lib/cyberfix/devin.mjs';
import { buildSituation } from '../lib/situation.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cyberfix');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const KEV_DOC = JSON.parse(fixture('kev-subset.json'));
const QUERYBATCH = JSON.parse(fixture('osv-querybatch.json')).results;
const RECORDED_QUERIES = { 'npm|vite': QUERYBATCH[0], 'npm|jquery': QUERYBATCH[1], 'PyPI|langflow': QUERYBATCH[2], 'Maven|org.apache.logging.log4j:log4j-core': QUERYBATCH[4] };
const KEY = 'test-key-not-a-real-credential';
const silent = { log() {}, error() {} };

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// KEV + OSV + Devin from fixtures. `devin` is a mutable state object so tests can drive session status.
function fixtureFetch({ kevStatus = 200, devin = null } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === KEV_URL) return kevStatus === 200 ? jsonResponse(200, KEV_DOC) : jsonResponse(kevStatus, {});
    if (url === `${OSV_BASE}/querybatch`) {
      const body = JSON.parse(init.body);
      return jsonResponse(200, { results: body.queries.map(q => RECORDED_QUERIES[`${q.package.ecosystem}|${q.package.name}`] || {}) });
    }
    let m = /^https:\/\/api\.osv\.dev\/v1\/vulns\/([A-Za-z0-9-]+)$/.exec(url);
    if (m) {
      const f = join(FIX, `osv-vuln-${m[1]}.json`);
      return existsSync(f) ? jsonResponse(200, JSON.parse(readFileSync(f, 'utf8'))) : jsonResponse(404, {});
    }
    if (devin && url.startsWith('https://api.devin.ai/v1/sessions')) {
      assert.equal(init.headers.authorization, `Bearer ${KEY}`);
      if (init.method === 'POST' && url.endsWith('/sessions')) {
        devin.created.push(JSON.parse(init.body));
        const id = `devin-${devin.created.length}`;
        return jsonResponse(200, { session_id: id, url: `https://app.devin.ai/sessions/${id}`, is_new_session: true });
      }
      m = /\/sessions\/([^/]+)$/.exec(url);
      return jsonResponse(200, { session_id: m[1], url: `https://app.devin.ai/sessions/${m[1]}`, ...(devin.state[m[1]] || { status_enum: 'working', pull_request: null }) });
    }
    throw new Error(`unexpected outbound request in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cyberfix-idx-'));
  copyFileSync(join(FIX, 'inventory-package-lock.json'), join(root, 'package-lock.json'));
  mkdirSync(join(root, 'ingest'));
  writeFileSync(join(root, 'ingest', 'pyproject.toml'), '[project]\nname = "x"\ndependencies = [\n  "langflow==1.2.0",\n  "requests==2.32.3",\n]\n');
  return root;
}

test('createCyberfix', async (t) => {
  await t.test('exports', () => {
    assert.deepEqual(INVENTORY_KINDS, ['cyclonedx', 'spdx', 'npm-lock', 'requirements', 'cpe']);
    assert.equal(MAX_INVENTORY_BYTES, 5 * 1024 * 1024);
    assert.ok(InventoryError && DevinApiError);
  });

  await t.test('summary before any run: pending, capability flags, self inventory listed, disabled reason verbatim', () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cf = createCyberfix({ root, fetchImpl: fixtureFetch(), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    const s = cf.summary();
    assert.equal(s.status, 'pending');
    assert.equal(s.lastRun, null);
    assert.deepEqual(s.capabilities.devin, { enabled: false, reason: DISABLED_REASON, targetRepo: 'COG-GTM/DevinCrucix', auto: false, apiVersion: 'v1' });
    assert.deepEqual(s.capabilities.uploadKinds, INVENTORY_KINDS);
    assert.equal(s.capabilities.maxUploadBytes, MAX_INVENTORY_BYTES);
    assert.equal(s.inventories.length, 1);
    assert.equal(s.inventories[0].id, 'self');
    assert.equal(s.inventories[0].source, 'self');
    assert.ok(s.inventories[0].componentCount >= 6, 'lockfile + pyproject pins');
    assert.deepEqual(s.counts, { confirmed: 0, probable: 0, 'name-match': 0, total: 0, new: 0, resolved: 0, remediations: 0, prOpen: 0 });
    assert.deepEqual(s.exposures, []);
    assert.deepEqual(s.remediations, []);
  });

  await t.test('first run: live KEV cached to disk, self-scan exposures with evidence chain, everything new; second run: nothing new; removed component → resolved', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fetchImpl = fixtureFetch();
    let clock = Date.parse('2026-03-01T00:00:00Z');
    const cf = createCyberfix({ root, fetchImpl, env: {}, log: silent, now: () => clock, setTimer: () => ({}), clearTimer() {} });

    const s1 = await cf.run({ trigger: 'sweep' });
    assert.equal(s1.status, 'ok');
    assert.equal(s1.trigger, 'sweep');
    assert.equal(s1.lastRun, '2026-03-01T00:00:00.000Z');
    assert.deepEqual(s1.kev, { count: KEV_DOC.vulnerabilities.length, source: 'live' });
    assert.ok(existsSync(join(root, 'runs', 'cyberfix', 'kev-catalog.json')));
    assert.ok(existsSync(join(root, 'runs', 'cyberfix', 'last-run.json')));
    assert.equal(s1.capabilities.osv.status, 'ok');
    assert.ok(s1.counts.confirmed >= 3, `vite, jquery (lockfile) + langflow (pyproject): ${JSON.stringify(s1.counts)}`);
    assert.equal(s1.counts.total, s1.exposures.length);
    assert.equal(s1.counts.new, s1.counts.total, 'first run: every exposure is new');
    assert.equal(s1.counts.resolved, 0);
    assert.deepEqual([...s1.newExposureKeys].sort(), s1.exposures.map(e => e.exposureKey).sort());
    const vite = s1.exposures.find(e => e.cveId === 'CVE-2025-31125' && e.component.name === 'vite');
    assert.equal(vite.confidence, 'confirmed');
    assert.equal(vite.component.source, 'self');
    assert.equal(vite.fixedVersion, '6.2.4');
    assert.equal(vite.remediation, null, 'no remediation attached yet');
    assert.deepEqual(vite.evidence.map(e => e.step), ['kev', 'cve', 'range', 'advisory', 'component']);
    const lf = s1.exposures.find(e => e.cveId === 'CVE-2025-3248');
    assert.equal(lf.component.ecosystem, 'PyPI');
    assert.equal(lf.component.source, 'self');
    assert.equal(lf.kev.knownRansomwareCampaignUse, 'Known');
    assert.equal(s1.stats.errors, 0);

    // second run inside the KEV / OSV TTL → cache, no new keys, no outbound calls
    const before = fetchImpl.calls.length;
    clock += 60 * 60 * 1000;
    const s2 = await cf.run({ trigger: 'rescan' });
    assert.equal(fetchImpl.calls.length, before, 'KEV and OSV served from disk cache');
    assert.equal(s2.kev.source, 'cache');
    assert.equal(s2.counts.new, 0);
    assert.equal(s2.counts.resolved, 0);
    assert.equal(s2.counts.total, s1.counts.total);

    // remove the vulnerable Python pin → langflow exposure resolves
    writeFileSync(join(root, 'ingest', 'pyproject.toml'), '[project]\ndependencies = ["requests==2.32.3"]\n');
    const s3 = await cf.run({ trigger: 'rescan' });
    assert.equal(s3.counts.total, s1.counts.total - 1);
    assert.deepEqual(s3.resolvedExposureKeys, [lf.exposureKey]);
    assert.equal(s3.counts.resolved, 1);
    assert.equal(s3.counts.new, 0);

    // stale KEV cache after 6 h → refetched
    clock += 7 * 60 * 60 * 1000;
    const s4 = await cf.run({});
    assert.equal(s4.kev.source, 'live');
    assert.ok(fetchImpl.calls.filter(c => c.url === KEV_URL).length === 2);
  });

  await t.test('KEV feed down: stale cache wins, then the sweep subset fallback; OSV down: degraded/unavailable flag, name-matches only', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const down = createCyberfix({ root, fetchImpl: fixtureFetch({ kevStatus: 503 }), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    const s = await down.run({ kevFallback: [{ cveID: 'CVE-2025-31125', vendor: 'Vite', product: 'Vitejs', name: 'Vitejs Vite Arbitrary File Read Vulnerability', dateAdded: '2026-01-22', dueDate: '2026-02-12', ransomware: false, description: 'x' }] });
    assert.equal(s.status, 'ok');
    assert.deepEqual(s.kev, { count: 1, source: 'sweep-subset' });
    assert.equal(s.counts.confirmed, 1, 'fallback entry still resolved through OSV');
    assert.equal(s.exposures[0].kev.knownRansomwareCampaignUse, 'Unknown');

    // populate the cache with a healthy run, then break KEV → stale cache
    const ok = createCyberfix({ root, fetchImpl: fixtureFetch(), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    await ok.run({});
    const stale = createCyberfix({ root, fetchImpl: fixtureFetch({ kevStatus: 500 }), env: {}, log: silent, now: () => Date.now() + 7 * 60 * 60 * 1000, setTimer: () => ({}), clearTimer() {} });
    const s2 = await stale.run({});
    assert.equal(s2.kev.source, 'stale-cache');
    assert.equal(s2.kev.count, KEV_DOC.vulnerabilities.length);

    const root2 = tempRoot();
    t.after(() => rmSync(root2, { recursive: true, force: true }));
    const osvDown = createCyberfix({ root: root2, fetchImpl: async (url) => url === KEV_URL ? jsonResponse(200, KEV_DOC) : jsonResponse(502, {}), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    const s3 = await osvDown.run({});
    assert.equal(s3.status, 'ok');
    assert.equal(s3.capabilities.osv.status, 'unavailable');
    assert.equal(s3.counts.confirmed, 0);
    assert.ok(s3.counts['name-match'] > 0, 'jquery/log4j-style name matches still surface');
  });

  await t.test('uploaded inventory: add → appears in run with its own exposure keys; delete → resolved; malformed rejected without persisting', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cf = createCyberfix({ root, fetchImpl: fixtureFetch(), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    await cf.run({});
    const inv = cf.addInventory({ kind: 'cyclonedx', name: 'mission portal', bytes: Buffer.from(fixture('inventory-cyclonedx.json')) });
    assert.match(inv.id, /^inv_[a-f0-9]{16}$/);
    assert.equal(inv.kind, 'cyclonedx');
    assert.equal(inv.name, 'mission portal');
    assert.equal(inv.source, 'sbom');
    assert.equal(inv.componentCount, 9);
    const s = await cf.run({ trigger: 'upload' });
    assert.equal(s.inventories.length, 2);
    assert.ok(s.counts.new > 0);
    const l4j = s.exposures.find(e => e.cveId === 'CVE-2021-44228' && e.component.inventoryId === inv.id);
    assert.equal(l4j.confidence, 'confirmed');
    assert.equal(l4j.component.inventoryName, 'mission portal');
    assert.equal(s.exposures.filter(e => e.component.name === 'vite').length, 2, 'same CVE, two inventories → two exposures');

    assert.throws(() => cf.addInventory({ kind: 'spdx', name: 'bad', bytes: Buffer.from('{"not":"spdx"}') }), (e) => e instanceof InventoryError && e.message === 'invalid inventory');
    assert.throws(() => cf.addInventory({ kind: 'nope', name: 'bad', bytes: Buffer.from('{}') }), InventoryError);
    assert.equal(cf.summary().inventories.length, 2, 'rejected uploads are not persisted');

    assert.equal(cf.removeInventory(inv.id), true);
    assert.equal(cf.removeInventory(inv.id), false);
    assert.equal(cf.removeInventory('inv_zzz'), false);
    const s2 = await cf.run({ trigger: 'delete' });
    assert.equal(s2.inventories.length, 1);
    assert.ok(s2.resolvedExposureKeys.includes(l4j.exposureKey));
  });

  await t.test('run() is single-flight: a request during a run queues exactly one follow-up', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let release;
    const gate = new Promise(r => { release = r; });
    const inner = fixtureFetch();
    let kevCalls = 0;
    const fetchImpl = async (url, init) => { if (url === KEV_URL) { kevCalls++; await gate; } return inner(url, init); };
    const cf = createCyberfix({ root, fetchImpl, env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    const p1 = cf.run({ trigger: 'sweep' });
    const p2 = cf.run({ trigger: 'upload' });
    const p3 = cf.run({ trigger: 'rescan' });
    assert.equal(p1, p2);
    assert.equal(p1, p3);
    release();
    const s1 = await p1;
    assert.equal(s1.trigger, 'sweep');
    // the queued rerun runs after p1 settles; wait for it via the next run() which shares its promise
    await new Promise(r => setTimeout(r, 20));
    await cf.run({ trigger: 'noop' });
    assert.equal(cf.summary().trigger, 'noop');
    assert.equal(kevCalls, 1, 'catalog cached for the reruns');
  });

  await t.test('remediate(): disabled → DevinApiError(0, reason), no network; unknown key → null; enabled → session + tracking in summary', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const off = createCyberfix({ root, fetchImpl: fixtureFetch(), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    await off.run({});
    const key = off.summary().exposures.find(e => e.confidence === 'confirmed').exposureKey;
    await assert.rejects(off.remediate(key), (e) => e instanceof DevinApiError && e.status === 0 && e.message === DISABLED_REASON);

    const devin = { created: [], state: {} };
    const fetchImpl = fixtureFetch({ devin });
    const timers = [];
    const on = createCyberfix({ root, fetchImpl, env: { DEVIN_API_KEY: KEY, CYBERFIX_TARGET_REPO: 'acme/portal' }, log: silent, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; }, clearTimer() {} });
    const s = await on.run({});
    assert.equal(s.capabilities.devin.enabled, true);
    assert.equal(s.capabilities.devin.reason, null);
    assert.equal(s.counts.remediations, 0, 'CYBERFIX_AUTO unset → nothing kicked automatically');
    assert.equal(devin.created.length, 0);

    assert.equal(await on.remediate('exp_000000000000000000000000'), null);
    const exposure = s.exposures.find(e => e.cveId === 'CVE-2025-31125');
    const r = await on.remediate(exposure.exposureKey, { ip: '10.1.1.1' });
    assert.equal(r.created, true);
    assert.equal(r.remediation.sessionId, 'devin-1');
    assert.equal(devin.created.length, 1);
    assert.equal(devin.created[0].title, 'security: remediate CVE-2025-31125 in vite');
    assert.ok(devin.created[0].prompt.includes('Repository: acme/portal'));
    assert.deepEqual(devin.created[0].tags, ['crucix', 'cyberfix', 'CVE-2025-31125']);
    assert.equal(timers.length, 1, 'polling scheduled');

    let sum = on.summary();
    assert.equal(sum.counts.remediations, 1);
    assert.equal(sum.counts.prOpen, 0);
    assert.equal(sum.exposures.find(e => e.exposureKey === exposure.exposureKey).remediation.sessionId, 'devin-1');

    devin.state['devin-1'] = { status_enum: 'finished', pull_request: { url: 'https://github.com/acme/portal/pull/5' } };
    const rec = await on.refreshRemediation('devin-1');
    assert.equal(rec.status, 'finished');
    assert.equal(rec.prUrl, 'https://github.com/acme/portal/pull/5');
    sum = on.summary();
    assert.equal(sum.counts.prOpen, 1);
    assert.equal(sum.exposures.find(e => e.exposureKey === exposure.exposureKey).remediation.prUrl, 'https://github.com/acme/portal/pull/5');
    assert.ok(existsSync(join(root, 'runs', 'cyberfix', 'remediations.json')));

    // a fresh instance over the same root sees the persisted remediation and would resume polling only for active ones
    const timers2 = [];
    const again = createCyberfix({ root, fetchImpl, env: { DEVIN_API_KEY: KEY }, log: silent, setTimer: (fn, ms) => { timers2.push(ms); return {}; }, clearTimer() {} });
    again.resumePolling();
    assert.equal(timers2.length, 0, 'finished session is not polled');
    assert.equal(again.summary().remediations[0].prUrl, 'https://github.com/acme/portal/pull/5');
  });

  await t.test('CYBERFIX_AUTO=true kicks a session for each NEW confirmed exposure only', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const devin = { created: [], state: {} };
    const env = { DEVIN_API_KEY: KEY, CYBERFIX_AUTO: 'true' };
    const cf = createCyberfix({ root, fetchImpl: fixtureFetch({ devin }), env, log: silent, setTimer: () => ({}), clearTimer() {} });
    const s = await cf.run({});
    assert.equal(s.capabilities.devin.auto, true);
    assert.equal(devin.created.length, s.counts.confirmed);
    assert.equal(s.counts.remediations, s.counts.confirmed);
    assert.ok(devin.created.every(c => /^security: remediate CVE-\d{4}-\d+ in /.test(c.title)));
    assert.ok(s.remediations.every(r => r.trigger === 'auto'));
    assert.equal(s.exposures.filter(e => e.confidence !== 'confirmed' && e.remediation).length, 0, 'name-matches are never auto-remediated');

    await cf.run({});
    assert.equal(devin.created.length, s.counts.confirmed, 'unchanged exposures are not re-kicked');

    const offAuto = createCyberfix({ root: tempRoot(), fetchImpl: fixtureFetch({ devin }), env: { CYBERFIX_AUTO: 'true' }, log: silent, setTimer: () => ({}), clearTimer() {} });
    const before = devin.created.length;
    await offAuto.run({});
    assert.equal(devin.created.length, before, 'auto without a key does nothing');
  });

  await t.test('Situation rule: confirmed exposures raise a cyber headline that targets the panel', async () => {
    const root = tempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cf = createCyberfix({ root, fetchImpl: fixtureFetch(), env: {}, log: silent, setTimer: () => ({}), clearTimer() {} });
    const cyberfix = await cf.run({});
    const { headlines } = buildSituation({ cyberfix });
    const h = headlines.find(x => x.rule === 'cyberfix');
    assert.ok(h, 'cyber headline present');
    assert.equal(h.tab, 'cyber');
    assert.equal(h.panel, 'cyberfix-panel');
    assert.match(h.title, /confirmed KEV exposure/);
    assert.match(h.title, /new/);
    assert.ok(/CVE-\d{4}-\d+/.test(h.why));
    assert.ok(/fix \d/.test(h.why));
    assert.ok(/KEV due \d{4}-\d{2}-\d{2}/.test(h.why));
    assert.equal(h.severity, 'critical', 'new + ransomware-known (langflow) → critical');
    assert.equal(buildSituation({ cyberfix: { ...cyberfix, exposures: [] } }).headlines.filter(x => x.rule === 'cyberfix').length, 0, 'no confirmed → no headline');
  });
});
