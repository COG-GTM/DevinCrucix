// lib/cyberfix/inventory.mjs — SBOM / lockfile / requirements / CPE parsers + persistence (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  InventoryError, INVENTORY_KINDS, ECOSYSTEMS, SOURCES, MAX_COMPONENTS, MAX_INVENTORY_BYTES,
  parsePurl, parseCpe, parseCycloneDX, parseSPDX, parseNpmLock, parseRequirements, parseCpeList,
  parseInventory, parsePyprojectDependencies, loadSelfInventory, normalizePackageName,
  saveInventory, deleteInventory, loadUploadedInventories, summarizeInventory, validInventoryId, validInventoryName,
} from '../lib/cyberfix/inventory.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cyberfix');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rejects = (fn, reason) => assert.throws(fn, (err) => {
  assert.ok(err instanceof InventoryError, `expected InventoryError, got ${err?.constructor?.name}: ${err?.message}`);
  assert.equal(err.message, 'invalid inventory', 'client-facing message stays generic');
  if (reason) assert.equal(err.reason, reason);
  return true;
});

const shapeOk = (c) => {
  assert.ok(ECOSYSTEMS.includes(c.ecosystem), `ecosystem ${c.ecosystem}`);
  assert.equal(typeof c.name, 'string');
  assert.ok(c.version === null || typeof c.version === 'string');
  assert.ok(SOURCES.includes(c.source), `source ${c.source}`);
  if (c.purl !== undefined) assert.match(c.purl, /^pkg:/);
  if (c.cpe !== undefined) assert.match(c.cpe, /^cpe:2\.3:/);
};

test('constants', () => {
  assert.deepEqual(INVENTORY_KINDS, ['cyclonedx', 'spdx', 'npm-lock', 'requirements', 'cpe']);
  assert.deepEqual(ECOSYSTEMS, ['npm', 'PyPI', 'Maven', 'Go', 'cargo', 'nuget', 'generic']);
  assert.ok(MAX_COMPONENTS >= 1000 && MAX_INVENTORY_BYTES <= 10 * 1024 * 1024);
});

test('purl / cpe primitives', async (t) => {
  await t.test('purl → ecosystem/name/version for every supported type', () => {
    assert.deepEqual(parsePurl('pkg:npm/vite@6.2.0'), { ecosystem: 'npm', name: 'vite', version: '6.2.0', purl: 'pkg:npm/vite@6.2.0' });
    assert.equal(parsePurl('pkg:npm/%40babel/core@7.24.0').name, '@babel/core');
    assert.deepEqual(parsePurl('pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1?type=jar'),
      { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1', purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1?type=jar' });
    assert.equal(parsePurl('pkg:pypi/Django@4.2.7').ecosystem, 'PyPI');
    assert.equal(parsePurl('pkg:golang/golang.org/x/net@0.23.0').name, 'golang.org/x/net');
    assert.equal(parsePurl('pkg:cargo/serde@1.0.197').ecosystem, 'cargo');
    assert.equal(parsePurl('pkg:nuget/Newtonsoft.Json@13.0.3').ecosystem, 'nuget');
    assert.equal(parsePurl('pkg:deb/debian/openssl@3.0.11#subpath').ecosystem, 'generic');
    assert.equal(parsePurl('pkg:npm/leftpad').version, null);
    assert.equal(parsePurl('npm/vite@6.2.0'), null);
    assert.equal(parsePurl(''), null);
  });
  await t.test('CPE 2.3 formatted strings', () => {
    const c = parseCpe('cpe:2.3:o:cisco:ios_xe:17.9.1:*:*:*:*:*:*:*');
    assert.equal(c.ecosystem, 'generic');
    assert.equal(c.name, 'cisco:ios_xe');
    assert.equal(c.version, '17.9.1');
    assert.equal(c.vendor, 'cisco');
    assert.equal(c.product, 'ios_xe');
    assert.equal(parseCpe('cpe:2.3:o:cisco:ios_xe:*:*:*:*:*:*:*:*').version, null);
    assert.equal(parseCpe('cpe:2.3:a:*:log4j:2.14.1:*:*:*:*:*:*:*').name, 'log4j');
    assert.equal(parseCpe('cpe:2.3:a:apache:*:2.14.1'), null);
    assert.equal(parseCpe('cpe:/a:apache:log4j:2.14.1'), null);
    assert.equal(parseCpe('cpe:2.3:a:x'), null);
  });
  await t.test('normalizePackageName folds per ecosystem', () => {
    assert.equal(normalizePackageName('Django', 'PyPI'), 'django');
    assert.equal(normalizePackageName('zope.interface', 'PyPI'), 'zope-interface');
    assert.equal(normalizePackageName('Ruamel_YAML', 'PyPI'), 'ruamel-yaml');
    assert.equal(normalizePackageName('Vite', 'npm'), 'vite');
    assert.equal(normalizePackageName('Newtonsoft.Json', 'nuget'), 'newtonsoft.json');
    assert.equal(normalizePackageName('org.apache.logging.log4j:Log4j-Core', 'Maven'), 'org.apache.logging.log4j:Log4j-Core');
  });
});

test('CycloneDX', async (t) => {
  await t.test('parses components[].purl / cpe / name and dedupes', () => {
    const list = parseCycloneDX(fixture('inventory-cyclonedx.json'));
    list.forEach(shapeOk);
    assert.ok(list.every(c => c.source === 'sbom'));
    const byName = Object.fromEntries(list.map(c => [c.name, c]));
    assert.deepEqual(new Set(list.map(c => c.ecosystem)), new Set(['npm', 'Maven', 'PyPI', 'cargo', 'nuget', 'Go', 'generic']));
    assert.equal(byName.vite.version, '6.2.0');
    assert.equal(list.filter(c => c.name === 'vite').length, 1, 'duplicate vite entry collapsed');
    assert.equal(byName['@babel/core'].ecosystem, 'npm');
    assert.equal(byName['org.apache.logging.log4j:log4j-core'].ecosystem, 'Maven');
    assert.equal(byName['cisco:ios_xe'].cpe, 'cpe:2.3:o:cisco:ios_xe:17.9.1:*:*:*:*:*:*:*');
    assert.equal(byName['cisco:ios_xe'].version, '17.9.1');
    assert.equal(byName['unversioned-lib'].version, null);
    assert.equal(byName['unversioned-lib'].ecosystem, 'generic');
    assert.equal(list.length, 9);
  });
  await t.test('rejects malformed documents', () => {
    rejects(() => parseCycloneDX('{not json'), 'not json');
    rejects(() => parseCycloneDX('[]'), 'not an object');
    rejects(() => parseCycloneDX('"str"'), 'not an object');
    rejects(() => parseCycloneDX('{"bomFormat":"SPDX","components":[]}'), 'not cyclonedx');
    rejects(() => parseCycloneDX('{"bomFormat":"CycloneDX"}'), 'not cyclonedx');
    rejects(() => parseCycloneDX('{"bomFormat":"CycloneDX","components":{}}'), 'not cyclonedx');
    const many = { bomFormat: 'CycloneDX', components: Array.from({ length: MAX_COMPONENTS + 1 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' })) };
    rejects(() => parseCycloneDX(JSON.stringify(many)), 'too many components');
  });
  await t.test('drops components whose names carry control characters or HTML', () => {
    const doc = { bomFormat: 'CycloneDX', components: [{ name: '<script>alert(1)</script>', version: '1' }, { name: 'ok', version: '1.0' }, { name: 'bad\u0000name', version: '1' }] };
    const list = parseCycloneDX(JSON.stringify(doc));
    assert.deepEqual(list.map(c => c.name), ['ok', 'badname']);
  });
});

test('SPDX', async (t) => {
  await t.test('parses packages[] via purl / cpe23Type externalRefs, falls back to name + versionInfo', () => {
    const list = parseSPDX(fixture('inventory-spdx.json'));
    list.forEach(shapeOk);
    assert.ok(list.every(c => c.source === 'sbom'));
    const byName = Object.fromEntries(list.map(c => [c.name, c]));
    assert.equal(byName.jquery.ecosystem, 'npm');
    assert.equal(byName.jquery.version, '3.4.1');
    assert.equal(byName.requests.ecosystem, 'PyPI');
    assert.equal(byName['paloaltonetworks:pan-os'].cpe, 'cpe:2.3:o:paloaltonetworks:pan-os:10.2.7:*:*:*:*:*:*:*');
    assert.equal(byName['paloaltonetworks:pan-os'].version, '10.2.7');
    assert.deepEqual(byName['custom-agent'], { ecosystem: 'generic', name: 'custom-agent', version: '0.9.0', source: 'sbom' });
    assert.equal(list.length, 4, 'nameless package dropped');
  });
  await t.test('rejects malformed documents', () => {
    rejects(() => parseSPDX('{}'), 'not spdx');
    rejects(() => parseSPDX('{"spdxVersion":"SPDX-2.3"}'), 'not spdx');
    rejects(() => parseSPDX('{"spdxVersion":2.3,"packages":[]}'), 'not spdx');
    rejects(() => parseSPDX(fixture('inventory-cyclonedx.json')), 'not spdx');
    rejects(() => parseSPDX('null'), 'not an object');
  });
});

test('package-lock.json', async (t) => {
  await t.test('v3 packages map → npm components; root, links and workspace paths skipped', () => {
    const list = parseNpmLock(fixture('inventory-package-lock.json'));
    list.forEach(shapeOk);
    assert.ok(list.every(c => c.ecosystem === 'npm' && c.source === 'lockfile'));
    const names = list.map(c => `${c.name}@${c.version}`).sort();
    assert.deepEqual(names, ['@types/node@22.5.0', 'esbuild@0.25.0', 'express@5.1.0', 'jquery@3.4.1', 'vite@6.2.0']);
    assert.equal(list.find(c => c.name === 'vite').purl, 'pkg:npm/vite@6.2.0');
  });
  await t.test('self source label passes through', () => {
    const list = parseNpmLock(fixture('inventory-package-lock.json'), 'self');
    assert.ok(list.every(c => c.source === 'self'));
  });
  await t.test('rejects lockfileVersion 1, missing packages, non-JSON', () => {
    rejects(() => parseNpmLock('{"lockfileVersion":1,"dependencies":{"a":{"version":"1"}}}'), 'not npm lockfile v2/v3');
    rejects(() => parseNpmLock('{"lockfileVersion":3}'), 'not npm lockfile v2/v3');
    rejects(() => parseNpmLock('{"lockfileVersion":3,"packages":[]}'), 'not npm lockfile v2/v3');
    rejects(() => parseNpmLock('garbage'), 'not json');
    const packages = {};
    for (let i = 0; i <= MAX_COMPONENTS; i++) packages[`node_modules/p${i}`] = { version: '1.0.0' };
    rejects(() => parseNpmLock(JSON.stringify({ lockfileVersion: 3, packages })), 'too many components');
  });
});

test('requirements.txt', async (t) => {
  await t.test('exact pins get a version + purl; ranges stay name-only or lower-bound; options, URLs, paths skipped', () => {
    const list = parseRequirements(fixture('inventory-requirements.txt'));
    list.forEach(shapeOk);
    assert.ok(list.every(c => c.ecosystem === 'PyPI' && c.source === 'lockfile'));
    const byName = Object.fromEntries(list.map(c => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['Django', 'langflow', 'numpy', 'pyyaml', 'requests', 'uvicorn']);
    assert.equal(byName.langflow.version, '1.2.0');
    assert.equal(byName.langflow.purl, 'pkg:pypi/langflow@1.2.0');
    assert.equal(byName.requests.version, '2.31.0', 'environment marker stripped');
    assert.equal(byName.Django.version, '4.2.7', 'inline comment stripped');
    assert.equal(byName.uvicorn.version, '0.29.0', 'extras stripped');
    assert.equal(byName.numpy.version, '1.26');
    assert.equal(byName.numpy.versionBasis, 'lower-bound');
    assert.equal(byName.pyyaml.versionBasis, 'lower-bound');
    assert.equal(byName.langflow.versionBasis, undefined);
  });
  await t.test('rejects binary, empty and unparsable lines', () => {
    rejects(() => parseRequirements('a==1\u0000b'), 'not text');
    rejects(() => parseRequirements('# only a comment\n\n'), 'no requirements');
    rejects(() => parseRequirements('==1.0'), 'bad requirement line');
    rejects(() => parseRequirements('<script>'), 'bad requirement line');
    rejects(() => parseRequirements(Array.from({ length: MAX_COMPONENTS + 2 }, (_, i) => `p${i}==1`).join('\n')), 'too many components');
  });
});

test('CPE list', async (t) => {
  await t.test('one CPE per line, comments skipped, duplicates by version kept apart', () => {
    const list = parseCpeList(fixture('inventory-cpe-list.txt'));
    list.forEach(shapeOk);
    assert.ok(list.every(c => c.ecosystem === 'generic' && c.source === 'cpe-list' && c.cpe));
    assert.equal(list.length, 5);
    const ios = list.filter(c => c.name === 'cisco:ios_xe');
    assert.deepEqual(ios.map(c => c.version), ['17.9.1', null]);
    assert.equal(list.find(c => c.name === 'apache:log4j').product, 'log4j');
  });
  await t.test('rejects non-CPE lines and empty input', () => {
    rejects(() => parseCpeList(''), 'empty');
    rejects(() => parseCpeList('# nothing\n'), 'empty');
    rejects(() => parseCpeList('cpe:2.3:o:cisco:ios_xe:17.9.1:*:*:*:*:*:*:*\nvite@6.2.0'), 'bad cpe line');
    rejects(() => parseCpeList('cpe:/o:cisco:ios'), 'bad cpe line');
    rejects(() => parseCpeList('x\u0000'), 'not text');
  });
});

test('parseInventory(kind, buffer) gate', async (t) => {
  await t.test('dispatches every kind and enforces size bounds', () => {
    assert.equal(parseInventory('cyclonedx', Buffer.from(fixture('inventory-cyclonedx.json'))).length, 9);
    assert.equal(parseInventory('spdx', Buffer.from(fixture('inventory-spdx.json'))).length, 4);
    assert.equal(parseInventory('npm-lock', Buffer.from(fixture('inventory-package-lock.json'))).length, 5);
    assert.equal(parseInventory('requirements', Buffer.from(fixture('inventory-requirements.txt'))).length, 6);
    assert.equal(parseInventory('cpe', Buffer.from(fixture('inventory-cpe-list.txt'))).length, 5);
  });
  await t.test('unsupported kind, empty, oversized, invalid UTF-8, zero components → InventoryError', () => {
    rejects(() => parseInventory('docker', Buffer.from('{}')), 'unsupported kind');
    rejects(() => parseInventory('__proto__', Buffer.from('{}')), 'unsupported kind');
    rejects(() => parseInventory('cpe', Buffer.alloc(0)), 'bad size');
    rejects(() => parseInventory('cpe', Buffer.alloc(MAX_INVENTORY_BYTES + 1, 0x20)), 'bad size');
    rejects(() => parseInventory('cyclonedx', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])), 'not utf8');
    rejects(() => parseInventory('npm-lock', Buffer.from('{"lockfileVersion":3,"packages":{"":{"name":"x"}}}')), 'no components');
    rejects(() => parseInventory('cyclonedx', Buffer.from('{"bomFormat":"CycloneDX","components":[]}')), 'no components');
  });
});

test('self-scan', async (t) => {
  await t.test('pyproject [project].dependencies → PyPI components tagged self', () => {
    const deps = parsePyprojectDependencies('[project]\nname = "x"\ndependencies = [\n  "fastapi==0.110.0",\n  \'httpx>=0.27\',\n  "pydantic[email]==2.6.4",\n]\n[tool.x]\nfoo = ["bar"]');
    assert.deepEqual(deps.map(d => [d.name, d.version, d.source, d.versionBasis]), [
      ['fastapi', '0.110.0', 'self', undefined], ['httpx', '0.27', 'self', 'lower-bound'], ['pydantic', '2.6.4', 'self', undefined],
    ]);
    assert.deepEqual(parsePyprojectDependencies('[project]\nname="x"'), []);
    assert.deepEqual(parsePyprojectDependencies(''), []);
  });
  await t.test('loadSelfInventory reads this repo lockfile + ingest pins, every component source=self', () => {
    const self = loadSelfInventory(REPO_ROOT);
    assert.equal(self.id, 'self');
    assert.equal(self.kind, 'self');
    assert.ok(self.files.includes('package-lock.json'));
    assert.ok(self.components.length > 0);
    self.components.forEach(shapeOk);
    assert.ok(self.components.every(c => c.source === 'self'));
    assert.ok(self.components.some(c => c.ecosystem === 'npm' && c.name === 'express'));
    if (self.files.includes('ingest/pyproject.toml')) assert.ok(self.components.some(c => c.ecosystem === 'PyPI'));
    const s = summarizeInventory(self);
    assert.equal(s.componentCount, self.components.length);
    assert.equal(s.byEcosystem.npm, self.components.filter(c => c.ecosystem === 'npm').length);
  });
  await t.test('missing root → empty self inventory, no throw', () => {
    const self = loadSelfInventory(join(tmpdir(), 'definitely-missing-crucix-root'));
    assert.deepEqual(self.components, []);
    assert.deepEqual(self.files, []);
  });
});

test('persistence under runs/cyberfix/inventories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cyberfix-inv-'));
  const logs = [];
  const origLog = console.log;
  t.before(() => { console.log = (line) => logs.push(line); });
  t.after(() => { console.log = origLog; rmSync(root, { recursive: true, force: true }); });

  await t.test('save → load → delete round trip with JSON audit lines', () => {
    const components = parseCpeList(fixture('inventory-cpe-list.txt'));
    const rec = saveInventory({ kind: 'cpe', name: 'edge appliances', components }, root);
    assert.ok(validInventoryId(rec.id));
    assert.equal(rec.name, 'edge appliances');
    assert.equal(rec.componentCount, 5);
    assert.ok(existsSync(join(root, 'runs', 'cyberfix', 'inventories', `${rec.id}.json`)));
    const saved = JSON.parse(logs.find(l => l.includes('cyberfix_inventory_saved')));
    assert.equal(saved.id, rec.id);
    assert.equal(saved.kind, 'cpe');
    assert.ok(saved.timestamp);
    assert.ok(!JSON.stringify(logs).includes('cpe:2.3'), 'audit log does not echo upload contents');

    const loaded = loadUploadedInventories(root);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, rec.id);
    assert.deepEqual(loaded[0].components, components);

    assert.equal(deleteInventory(rec.id, root), true);
    assert.equal(deleteInventory(rec.id, root), false);
    assert.equal(deleteInventory('../../etc/passwd', root), false);
    assert.equal(deleteInventory('inv_zz', root), false);
    assert.ok(logs.some(l => l.includes('cyberfix_inventory_deleted')));
    assert.deepEqual(loadUploadedInventories(root), []);
    assert.deepEqual(readdirSync(join(root, 'runs', 'cyberfix', 'inventories')), []);
  });
  await t.test('invalid display names fall back to a kind label; corrupt files are ignored on load', () => {
    const rec = saveInventory({ kind: 'spdx', name: '<b>x</b>', components: [{ ecosystem: 'generic', name: 'a', version: null, source: 'sbom' }] }, root);
    assert.equal(rec.name, 'spdx upload');
    assert.equal(validInventoryName('<b>x</b>'), false);
    assert.equal(validInventoryName('portal lock'), true);
    assert.equal(validInventoryName(' leading'), false);
    assert.equal(validInventoryName('a'.repeat(81)), false);
    deleteInventory(rec.id, root);
  });
});
