// lib/cyberfix/resolve.mjs — KEV × inventory join against recorded OSV responses. The fetch is a fixture
// server: every request is asserted against the OSV API shape and answered from test/fixtures/cyberfix/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createResolver, exposureKeyFor, kevNameMatch, OSV_BASE, CONFIDENCE, kevUrl, nvdUrl, osvUrl,
} from '../lib/cyberfix/resolve.mjs';
import { parseCycloneDX, parseSPDX, parseNpmLock, parseRequirements, parseCpeList } from '../lib/cyberfix/inventory.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cyberfix');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const KEV = JSON.parse(fixture('kev-subset.json')).vulnerabilities;
const QUERYBATCH = JSON.parse(fixture('osv-querybatch.json')).results;

// Recorded querybatch results, keyed by the package that produced them.
const RECORDED_QUERIES = {
  'npm|vite': QUERYBATCH[0], 'npm|jquery': QUERYBATCH[1], 'PyPI|langflow': QUERYBATCH[2], 'Maven|org.apache.logging.log4j:log4j-core': QUERYBATCH[4],
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

function fixtureFetch(log = []) {
  const fetchImpl = async (url, init = {}) => {
    log.push({ url, init });
    assert.ok(url.startsWith(OSV_BASE + '/'), `only OSV is contacted: ${url}`);
    assert.equal(init.headers.accept, 'application/json');
    assert.ok(init.timeout > 0 && init.maxBytes > 0, 'bounded request');
    assert.notEqual(init.allowPrivate, true, 'OSV requests never opt out of SSRF protection');
    if (url === `${OSV_BASE}/querybatch`) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['content-type'], 'application/json');
      const body = JSON.parse(init.body);
      assert.ok(Array.isArray(body.queries) && body.queries.length > 0);
      const results = body.queries.map((q) => {
        assert.deepEqual(Object.keys(q).sort(), ['package', 'version'], 'documented querybatch query shape');
        assert.deepEqual(Object.keys(q.package).sort(), ['ecosystem', 'name']);
        assert.ok(['npm', 'PyPI', 'Maven', 'Go', 'crates.io', 'NuGet'].includes(q.package.ecosystem), `OSV ecosystem name: ${q.package.ecosystem}`);
        return RECORDED_QUERIES[`${q.package.ecosystem}|${q.package.name}`] || {};
      });
      return jsonResponse(200, { results });
    }
    const m = /^https:\/\/api\.osv\.dev\/v1\/vulns\/([A-Za-z0-9-]+)$/.exec(url);
    assert.ok(m, `unexpected OSV url ${url}`);
    assert.ok(!init.method || init.method === 'GET');
    const f = join(FIX, `osv-vuln-${m[1]}.json`);
    if (!existsSync(f)) return jsonResponse(404, { code: 5, message: 'Bug not found.' });
    return jsonResponse(200, JSON.parse(readFileSync(f, 'utf8')));
  };
  return fetchImpl;
}

const silent = { log() {}, error() {} };

const inventories = () => [
  { id: 'self', name: 'CRUCIX self-scan', components: parseNpmLock(fixture('inventory-package-lock.json'), 'self') },
  { id: 'inv_0000000000000001', name: 'mission portal sbom', components: parseCycloneDX(fixture('inventory-cyclonedx.json')) },
  { id: 'inv_0000000000000002', name: 'edge gateway sbom', components: parseSPDX(fixture('inventory-spdx.json')) },
  { id: 'inv_0000000000000003', name: 'ml service', components: parseRequirements(fixture('inventory-requirements.txt')) },
  { id: 'inv_0000000000000004', name: 'edge appliances', components: parseCpeList(fixture('inventory-cpe-list.txt')) },
];

const find = (list, cve, name, inventoryId) => list.find(e => e.cveId === cve && e.component.name === name && (!inventoryId || e.component.inventoryId === inventoryId));

test('exposure keys and evidence URLs', () => {
  const c = { ecosystem: 'npm', name: 'Vite', version: '6.2.0' };
  const k = exposureKeyFor({ cveId: 'CVE-2025-31125', inventoryId: 'self', component: c });
  assert.match(k, /^exp_[a-f0-9]{24}$/);
  assert.equal(k, exposureKeyFor({ cveId: 'CVE-2025-31125', inventoryId: 'self', component: { ...c, name: 'vite' } }), 'name normalized');
  assert.notEqual(k, exposureKeyFor({ cveId: 'CVE-2025-31125', inventoryId: 'inv_x', component: c }));
  assert.notEqual(k, exposureKeyFor({ cveId: 'CVE-2025-31125', inventoryId: 'self', component: { ...c, version: '6.2.4' } }));
  assert.equal(kevUrl('CVE-2025-31125'), 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2025-31125');
  assert.equal(nvdUrl('CVE-2025-31125'), 'https://nvd.nist.gov/vuln/detail/CVE-2025-31125');
  assert.equal(osvUrl('GHSA-4r4m-qw57-chr8'), 'https://osv.dev/vulnerability/GHSA-4r4m-qw57-chr8');
  assert.equal(nvdUrl('<x>'), 'https://nvd.nist.gov/vuln/detail/%3Cx%3E');
});

test('kevNameMatch', () => {
  const byCve = Object.fromEntries(KEV.map(k => [k.cveID, k]));
  const cisco = byCve['CVE-2023-20198'], pan = byCve['CVE-2024-3400'], log4j = byCve['CVE-2021-44228'], jq = byCve['CVE-2020-11023'], vite = byCve['CVE-2025-31125'];
  const cpe = (s) => parseCpeList(s)[0];
  assert.equal(kevNameMatch(cisco, cpe('cpe:2.3:o:cisco:ios_xe:17.9.1:*:*:*:*:*:*:*')), true, 'same vendor, KEV product "IOS XE Web UI" contains cpe product ios_xe');
  assert.equal(kevNameMatch(cisco, cpe('cpe:2.3:o:cisco:asa:9.1:*:*:*:*:*:*:*')), false, 'same vendor, unrelated product');
  assert.equal(kevNameMatch(pan, cpe('cpe:2.3:o:paloaltonetworks:pan-os:10.2.7:*:*:*:*:*:*:*')), true);
  assert.equal(kevNameMatch(pan, cpe('cpe:2.3:o:cisco:pan-os:10.2.7:*:*:*:*:*:*:*')), false, 'vendor mismatch blocks a product-only hit');
  assert.equal(kevNameMatch(log4j, cpe('cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*')), true, 'Log4j2 stem matches log4j');
  assert.equal(kevNameMatch(jq, cpe('cpe:2.3:a:jquery:jquery:3.4.1:*:*:*:*:*:*:*')), true);
  assert.equal(kevNameMatch(log4j, { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1' }), true);
  assert.equal(kevNameMatch(jq, { ecosystem: 'npm', name: 'jquery', version: '3.4.1' }), true);
  assert.equal(kevNameMatch(jq, { ecosystem: 'npm', name: 'jquery-ui', version: '1.0' }), true, 'prefix stem → name-match tier only; OSV decides confirmation');
  assert.equal(kevNameMatch({ vendorProject: 'Vite', product: 'Vite' }, { ecosystem: 'npm', name: 'vitest', version: '1.0' }), false, 'stems shorter than 5 chars must match exactly');
  assert.equal(kevNameMatch(vite, { ecosystem: 'npm', name: 'vite', version: '6.2.0' }), false, 'KEV product "Vitejs" ≠ package "vite" — OSV decides this one');
  assert.equal(kevNameMatch(vite, { ecosystem: 'npm', name: 'vitejs', version: '1' }), true);
  assert.equal(kevNameMatch({ product: '' }, { name: 'x' }), false);
  assert.equal(kevNameMatch(cisco, { ecosystem: 'generic', name: '' }), false);
});

test('resolveExposures against recorded KEV subset + recorded OSV responses', async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cyberfix-osv-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const log = [];
  const resolver = createResolver({ fetchImpl: fixtureFetch(log), cacheDir, log: silent });
  const { exposures, stats } = await resolver.resolveExposures({ kev: KEV, inventories: inventories() });

  await t.test('every exposure carries the documented shape and a KEV → CVE → range → component chain', () => {
    assert.ok(exposures.length > 0);
    for (const e of exposures) {
      assert.match(e.exposureKey, /^exp_[a-f0-9]{24}$/);
      assert.match(e.cveId, /^CVE-\d{4}-\d+$/);
      assert.deepEqual(Object.keys(e.kev).sort(), ['dateAdded', 'dueDate', 'knownRansomwareCampaignUse', 'product', 'shortDescription', 'vendorProject', 'vulnerabilityName']);
      assert.ok(CONFIDENCE.includes(e.confidence));
      assert.ok(e.component.inventoryId && e.component.inventoryName);
      assert.ok(Array.isArray(e.evidence) && e.evidence.length >= 3);
      assert.deepEqual(e.evidence.slice(0, 2).map(x => x.step), ['kev', 'cve']);
      assert.equal(e.evidence.at(-1).step, 'component');
      for (const ev of e.evidence) { assert.match(ev.url, /^https:\/\//); assert.ok(ev.label); }
      if (e.confidence === 'confirmed') {
        assert.ok(e.affectedRange, 'confirmed exposures state the affected range');
        assert.ok(e.osvId, 'confirmed exposures cite the OSV record');
        assert.ok(e.evidence.some(x => x.step === 'range' && x.url === osvUrl(e.osvId)));
      }
    }
    assert.deepEqual(exposures.map(e => e.confidence), [...exposures.map(e => e.confidence)].sort((a, b) => CONFIDENCE.indexOf(a) - CONFIDENCE.indexOf(b)), 'sorted confirmed → probable → name-match');
  });

  await t.test('confirmed: vite 6.2.0 in self-scan and SBOM (GHSA-4r4m-qw57-chr8 range 6.2.0 ≤ v < 6.2.4)', () => {
    for (const inv of ['self', 'inv_0000000000000001']) {
      const e = find(exposures, 'CVE-2025-31125', 'vite', inv);
      assert.ok(e, `vite exposure in ${inv}`);
      assert.equal(e.confidence, 'confirmed');
      assert.equal(e.affectedRange, '>= 6.2.0, < 6.2.4');
      assert.equal(e.fixedVersion, '6.2.4');
      assert.equal(e.osvId, 'GHSA-4r4m-qw57-chr8');
      assert.equal(e.kev.vendorProject, 'Vite');
      assert.equal(e.kev.dueDate, KEV.find(k => k.cveID === 'CVE-2025-31125').dueDate);
      assert.equal(e.component.source, inv === 'self' ? 'self' : 'sbom');
      assert.deepEqual(e.evidence.filter(x => x.step === 'advisory').map(x => x.url), ['https://github.com/vitejs/vite/security/advisories/GHSA-4r4m-qw57-chr8'], 'vendor advisory kept, NVD/KEV refs not duplicated');
    }
    assert.notEqual(find(exposures, 'CVE-2025-31125', 'vite', 'self').exposureKey, find(exposures, 'CVE-2025-31125', 'vite', 'inv_0000000000000001').exposureKey);
  });

  await t.test('confirmed: jquery 3.4.1 (< 3.5.0), langflow 1.2.0 (< 1.3.0, ransomware Known), log4j-core 2.14.1 (2.13.0 ≤ v < 2.15.0)', () => {
    const jq = find(exposures, 'CVE-2020-11023', 'jquery', 'self');
    assert.equal(jq.confidence, 'confirmed');
    assert.equal(jq.affectedRange, '>= 1.0.3, < 3.5.0');
    assert.equal(jq.fixedVersion, '3.5.0');
    assert.equal(jq.osvId, 'GHSA-jpcq-cgw6-v4j6');
    assert.ok(find(exposures, 'CVE-2020-11023', 'jquery', 'inv_0000000000000002'), 'SPDX copy also flagged');

    const lf = find(exposures, 'CVE-2025-3248', 'langflow', 'inv_0000000000000003');
    assert.equal(lf.confidence, 'confirmed');
    assert.equal(lf.affectedRange, '< 1.3.0');
    assert.equal(lf.fixedVersion, '1.3.0');
    assert.equal(lf.kev.knownRansomwareCampaignUse, 'Known');
    assert.equal(lf.component.ecosystem, 'PyPI');

    const l4j = find(exposures, 'CVE-2021-44228', 'org.apache.logging.log4j:log4j-core', 'inv_0000000000000001');
    assert.equal(l4j.confidence, 'confirmed');
    assert.equal(l4j.affectedRange, '>= 2.13.0, < 2.15.0');
    assert.equal(l4j.fixedVersion, '2.15.0');
    assert.equal(l4j.osvId, 'GHSA-jfh8-c2jp-5v3q');
  });

  await t.test('clean components produce no exposure', () => {
    for (const name of ['express', 'esbuild', '@types/node', '@babel/core', 'requests', 'Django', 'serde', 'Newtonsoft.Json', 'golang.org/x/net', 'custom-agent']) {
      assert.equal(exposures.filter(e => e.component.name === name).length, 0, name);
    }
  });

  await t.test('name-match: CPE list / generic components matched on KEV vendor+product, never confirmed', () => {
    const pan = find(exposures, 'CVE-2024-3400', 'paloaltonetworks:pan-os', 'inv_0000000000000004');
    assert.equal(pan.confidence, 'name-match');
    assert.equal(pan.affectedRange, null);
    assert.equal(pan.fixedVersion, null);
    assert.equal(pan.osvId, null);
    assert.equal(pan.component.cpe, 'cpe:2.3:o:paloaltonetworks:pan-os:10.2.7:*:*:*:*:*:*:*');
    assert.ok(find(exposures, 'CVE-2024-3400', 'paloaltonetworks:pan-os', 'inv_0000000000000002'), 'SPDX cpe23Type ref too');
    assert.ok(find(exposures, 'CVE-2021-44228', 'apache:log4j', 'inv_0000000000000004'));
    assert.equal(find(exposures, 'CVE-2021-44228', 'apache:log4j').confidence, 'name-match');
    assert.ok(find(exposures, 'CVE-2020-11023', 'jquery:jquery', 'inv_0000000000000004'));
    assert.equal(exposures.filter(e => e.component.source === 'cpe-list' && e.confidence !== 'name-match').length, 0);
  });

  await t.test('stats + request discipline', () => {
    assert.equal(stats.kevEntries, KEV.length);
    assert.ok(stats.components > 20);
    assert.equal(stats.errors, 0);
    const batches = log.filter(r => r.url.endsWith('/querybatch'));
    assert.equal(batches.length, 1, 'one querybatch for the whole inventory');
    const queries = JSON.parse(batches[0].init.body).queries;
    assert.ok(queries.every(q => q.version), 'unversioned components are not sent to querybatch');
    assert.ok(!queries.some(q => q.package.ecosystem === 'generic'), 'generic/CPE components are not sent to OSV');
    assert.ok(queries.some(q => q.package.ecosystem === 'crates.io' && q.package.name === 'serde'));
    assert.ok(queries.some(q => q.package.ecosystem === 'NuGet'));
    assert.ok(queries.some(q => q.package.ecosystem === 'Go' && q.package.name === 'golang.org/x/net'));
    assert.ok(log.some(r => r.url.endsWith('/vulns/GHSA-4r4m-qw57-chr8')));
    assert.ok(stats.requests <= 1 + 80, 'bounded vuln fetches');
    assert.ok(readdirSync(cacheDir).length > 0, 'responses cached on disk');
  });

  await t.test('second run is served from the 24 h cache — zero fetches; expired cache refetches', async () => {
    const log2 = [];
    const again = createResolver({ fetchImpl: fixtureFetch(log2), cacheDir, log: silent });
    const r2 = await again.resolveExposures({ kev: KEV, inventories: inventories() });
    assert.equal(log2.length, 0);
    assert.deepEqual(r2.exposures.map(e => e.exposureKey).sort(), exposures.map(e => e.exposureKey).sort());
    assert.ok(r2.stats.cacheHits > 0);

    const log3 = [];
    const later = createResolver({ fetchImpl: fixtureFetch(log3), cacheDir, log: silent, now: () => Date.now() + 25 * 60 * 60 * 1000 });
    await later.resolveExposures({ kev: KEV, inventories: inventories() });
    assert.ok(log3.some(r => r.url.endsWith('/querybatch')), 'stale cache → refetched');
  });
});

test('resolver degrades without OSV', async (t) => {
  await t.test('network failure → no confirmed exposures, name matches still surface, errors counted', async () => {
    const resolver = createResolver({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, log: silent });
    const { exposures, stats } = await resolver.resolveExposures({ kev: KEV, inventories: inventories() });
    assert.ok(stats.errors > 0);
    assert.equal(exposures.filter(e => e.confidence === 'confirmed').length, 0);
    assert.ok(exposures.some(e => e.confidence === 'name-match' && e.component.name === 'paloaltonetworks:pan-os'));
    assert.ok(exposures.some(e => e.confidence === 'name-match' && e.component.name === 'jquery'), 'versioned package falls back to name-match when OSV is down');
  });
  await t.test('HTTP 5xx is an error, 404 is "no record"', async () => {
    const r5 = createResolver({ fetchImpl: async () => jsonResponse(503, {}), log: silent });
    assert.equal(await r5.getVuln('GHSA-4r4m-qw57-chr8'), undefined);
    assert.equal(r5.stats.errors, 1);
    const r4 = createResolver({ fetchImpl: async () => jsonResponse(404, {}), log: silent });
    assert.equal(await r4.getVuln('GHSA-4r4m-qw57-chr8'), null);
    assert.equal(r4.stats.notFound, 1);
    assert.equal(await r4.getVuln('../etc'), null, 'malformed ids are never sent upstream');
    assert.equal(r4.stats.requests, 1);
  });
  await t.test('KEV entries without a CVE id and empty inventories are ignored', async () => {
    const resolver = createResolver({ fetchImpl: async () => { throw new Error('should not be called'); }, log: silent });
    const { exposures, stats } = await resolver.resolveExposures({ kev: [{ cveID: 'nope' }, null, { product: 'x' }], inventories: [{ id: 'a', name: 'a', components: [] }] });
    assert.deepEqual(exposures, []);
    assert.equal(stats.kevEntries, 0);
    assert.equal(stats.requests, 0);
  });
});

test('matchRecord', async () => {
  const resolver = createResolver({ fetchImpl: async () => { throw new Error('offline'); }, log: silent });
  const vite = JSON.parse(fixture('osv-vuln-GHSA-4r4m-qw57-chr8.json'));
  const hit = resolver.matchRecord(vite, { ecosystem: 'npm', name: 'vite', version: '6.2.0' });
  assert.equal(hit.sawPackage, true);
  assert.equal(hit.affected, true);
  assert.equal(hit.fixedVersion, '6.2.4');
  const safe = resolver.matchRecord(vite, { ecosystem: 'npm', name: 'vite', version: '6.2.4' });
  assert.equal(safe.affected, false);
  assert.equal(safe.fixedVersion, '6.2.4', 'highest fix still reported for the evidence chain');
  const other = resolver.matchRecord(vite, { ecosystem: 'npm', name: 'vitest', version: '6.2.0' });
  assert.equal(other.sawPackage, false);
  assert.equal(other.affected, null);
  const eco = resolver.matchRecord(vite, { ecosystem: 'PyPI', name: 'vite', version: '6.2.0' });
  assert.equal(eco.sawPackage, false, 'ecosystem must match');
  const cveOnly = resolver.matchRecord(JSON.parse(fixture('osv-vuln-CVE-2025-31125.json')), { ecosystem: 'npm', name: 'vite', version: '6.2.0' });
  assert.equal(cveOnly.sawPackage, false, 'CVE record only carries GIT ranges — decision comes from the GHSA alias');
});
