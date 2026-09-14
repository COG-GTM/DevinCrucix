// /api/cyberfix/* route contracts — imports the Express app and drives it over loopback. Only requests
// that are rejected by validation (or answered from local state) are sent, so nothing here triggers a
// KEV / OSV / Devin call. Asserts generic client errors, no echo of upload bytes, and security headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../server.mjs';
import { DISABLED_REASON } from '../lib/cyberfix/devin.mjs';
import { INVENTORY_KINDS, MAX_INVENTORY_BYTES } from '../lib/cyberfix/inventory.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cyberfix');
let server, base;
const req = (path, init = {}) => fetch(base + path, init);
const postJson = (path, body) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const upload = (qs, bytes) => req(`/api/cyberfix/inventory${qs}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
const SENTINEL = 'ZZ_RAW_UPLOAD_SENTINEL_ZZ';

test('cyberfix routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('GET /api/cyberfix → summary shape with capability flags; disabled reason verbatim when no key', async () => {
    const res = await req('/api/cyberfix');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = await res.json();
    assert.ok(['pending', 'ok', 'error'].includes(body.status));
    assert.deepEqual(Object.keys(body.capabilities).sort(), ['devin', 'maxUploadBytes', 'osv', 'uploadKinds']);
    assert.deepEqual(body.capabilities.uploadKinds, INVENTORY_KINDS);
    assert.equal(body.capabilities.maxUploadBytes, MAX_INVENTORY_BYTES);
    assert.equal(typeof body.capabilities.devin.enabled, 'boolean');
    if (!process.env.DEVIN_API_KEY) {
      assert.equal(body.capabilities.devin.enabled, false);
      assert.equal(body.capabilities.devin.reason, DISABLED_REASON);
    }
    assert.ok(Array.isArray(body.inventories) && body.inventories.some(i => i.id === 'self'), 'self-scan inventory always listed');
    assert.ok(Array.isArray(body.exposures) && Array.isArray(body.remediations));
    for (const k of ['confirmed', 'probable', 'name-match', 'total', 'new', 'resolved', 'remediations', 'prOpen']) assert.equal(typeof body.counts[k], 'number', k);
    assert.ok(!JSON.stringify(body).includes('DEVIN_API_KEY=') && !/Bearer /.test(JSON.stringify(body)));
  });

  await t.test('POST /api/cyberfix/inventory rejects bad kind / name before reading the body', async () => {
    const cases = [
      ['?name=ok', 'kind'], ['?kind=banana&name=ok', 'kind'], ['?kind=CYCLONEDX&name=ok', 'kind'], ['?kind=cyclonedx&kind=spdx&name=ok', 'kind'],
      ['?kind=cyclonedx', 'name'], ['?kind=cyclonedx&name=', 'name'], ['?kind=cyclonedx&name=..%2Fetc', 'name'], ['?kind=cyclonedx&name=%3Cscript%3E', 'name'],
      [`?kind=cyclonedx&name=${'a'.repeat(81)}`, 'name'], ['?kind=cyclonedx&name=a%3Bb', 'name'],
    ];
    for (const [qs, field] of cases) {
      const res = await upload(qs, Buffer.from(SENTINEL));
      assert.equal(res.status, 400, qs);
      const body = await res.json();
      assert.equal(body.error, 'invalid request', qs);
      assert.equal(body.field, field, qs);
      assert.ok(!JSON.stringify(body).includes('banana') && !JSON.stringify(body).includes(SENTINEL));
    }
  });

  // The mutating routes share a 20-requests/minute/IP budget; the parser-level matrix (every kind × every
  // malformed shape) lives in cyberfix-inventory.test.mjs, so this only proves the route contract per kind.
  await t.test('POST /api/cyberfix/inventory: malformed content for every kind → generic 400, no echo, nothing persisted', async () => {
    const before = (await (await req('/api/cyberfix')).json()).inventories.length;
    const bad = {
      cyclonedx: [`{"bomFormat":"SPDX","${SENTINEL}":1}`, '{'],
      spdx: [`{"components":[{"name":"${SENTINEL}"}]}`, '[]'],
      'npm-lock': [`{"lockfileVersion":1,"dependencies":{"${SENTINEL}":{}}}`, 'null'],
      requirements: [`{"${SENTINEL}":1}`, '\u0000\u0001'],
      cpe: [`${SENTINEL}\nnot-a-cpe\n`, '<xml/>'],
    };
    for (const kind of INVENTORY_KINDS) {
      for (const bytes of bad[kind]) {
        const res = await upload(`?kind=${kind}&name=t`, Buffer.from(bytes));
        assert.equal(res.status, 400, `${kind}: ${JSON.stringify(bytes)}`);
        const body = await res.json();
        assert.ok(['Invalid inventory', 'Invalid request'].includes(body.error), body.error);
        assert.ok(!JSON.stringify(body).includes(SENTINEL));
      }
    }
    const empty = await upload('?kind=cyclonedx&name=t', Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: 'Invalid request' });
    assert.equal((await (await req('/api/cyberfix')).json()).inventories.length, before, 'rejected uploads never persisted');
  });

  await t.test('POST /api/cyberfix/inventory: oversized body → 4xx JSON, not a stack trace', async () => {
    const res = await upload('?kind=cyclonedx&name=big', Buffer.alloc(MAX_INVENTORY_BYTES + 1024, 0x20));
    assert.ok([400, 413].includes(res.status), String(res.status));
    const text = await res.text();
    assert.ok(!/PayloadTooLargeError|at .*node_modules/.test(text), 'no framework error leak');
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(!text.includes(SENTINEL));
  });

  await t.test('DELETE /api/cyberfix/inventory/:id: invalid id → 400 (never hits disk), unknown well-formed id → 404, self is not deletable', async () => {
    for (const id of ['self', 'inv_x', 'inv_ZZZZZZZZZZZZZZZZ', 'inv_0123456789abcdef0', '..%2F..%2Fetc', 'inv_0123456789abcde%2E']) {
      const res = await req(`/api/cyberfix/inventory/${id}`, { method: 'DELETE' });
      assert.equal(res.status, 400, id);
      assert.deepEqual(await res.json(), { error: 'invalid request', field: 'id' });
    }
    const res = await req('/api/cyberfix/inventory/inv_0123456789abcdef', { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });

  await t.test('POST /api/cyberfix/remediate: body validation, unknown exposure, disabled-key 409 with verbatim reason', async () => {
    for (const body of [{}, { exposureKey: 'nope' }, { exposureKey: 'exp_XYZ' }, { exposureKey: 'exp_0123456789abcdef0123456' }, { exposureKey: ['exp_0123456789abcdef01234567'] }, { exposureKey: 'exp_0123456789abcdef01234567; drop' }, { exposureKey: 1 }]) {
      const res = await postJson('/api/cyberfix/remediate', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: 'invalid request', field: 'exposureKey' });
    }
    const notJson = await postJson('/api/cyberfix/remediate', '{not json');
    assert.equal(notJson.status, 400);
    assert.match(notJson.headers.get('content-type'), /application\/json/);
    const wellFormed = await postJson('/api/cyberfix/remediate', { exposureKey: 'exp_0123456789abcdef01234567' });
    const b = await wellFormed.json();
    if (!process.env.DEVIN_API_KEY) {
      assert.equal(wellFormed.status, 409);
      assert.deepEqual(b, { error: DISABLED_REASON });
    } else {
      assert.equal(wellFormed.status, 404);
      assert.deepEqual(b, { error: 'Not found' });
    }
  });

  await t.test('POST /api/cyberfix/remediations/:id/refresh: invalid session id → 400, unknown → 404', async () => {
    for (const id of ['a', 'has%20space', 'x'.repeat(129), '..%2F..', 'id%3Bevil']) {
      const res = await req(`/api/cyberfix/remediations/${id}/refresh`, { method: 'POST' });
      assert.equal(res.status, 400, id);
      assert.deepEqual(await res.json(), { error: 'invalid request', field: 'id' });
    }
    const res = await req('/api/cyberfix/remediations/devin-does-not-exist/refresh', { method: 'POST' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });

  await t.test('method / path hygiene: GET on mutating routes → JSON 404, no HTML', async () => {
    for (const path of ['/api/cyberfix/rescan', '/api/cyberfix/remediate', '/api/cyberfix/inventory', '/api/cyberfix/remediations/abcd/refresh']) {
      const res = await req(path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
  });

  await t.test('fixture SBOM passes query validation up to the body stage (shape check only — not persisted here)', () => {
    // Guard against the fixture drifting away from what the parser accepts; the persisted-upload path is
    // covered by cyberfix-index.test.mjs against a temp root so the repo's runs/ never gets test data.
    const doc = JSON.parse(readFileSync(join(FIX, 'inventory-cyclonedx.json'), 'utf8'));
    assert.equal(doc.bomFormat, 'CycloneDX');
    assert.ok(Array.isArray(doc.components) && doc.components.length > 0);
  });
});
