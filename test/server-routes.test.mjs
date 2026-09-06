// server.mjs route contracts — imports the Express app (no listen / sweep at import time) and
// drives it over a loopback port. No external network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../server.mjs';
import { CONTENT_SECURITY_POLICY } from '../lib/securityHeaders.mjs';

let server, base;

const req = (path, init = {}) => fetch(base + path, init);
const postJson = (path, body) => req(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('server routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('unknown /api/* → JSON 404, no HTML "Cannot GET"', async () => {
    for (const path of ['/api/x', '/api/nope/deeper?q=1', '/api/']) {
      const res = await req(path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
    const post = await postJson('/api/nope', {});
    assert.equal(post.status, 404);
    assert.deepEqual(await post.json(), { error: 'not found' });
  });

  await t.test('/api/investigate rejects unknown selector kinds', async () => {
    for (const q of ['kind=banana', 'type=banana', 'kind=ip', 'type=DOMAIN']) {
      const res = await req(`/api/investigate?target=example.com&${q}`);
      assert.equal(res.status, 400, q);
      const body = await res.json();
      assert.equal(body.error, 'invalid request');
      assert.ok(['kind', 'type'].includes(body.field));
      assert.ok(!JSON.stringify(body).includes('banana'));
    }
    const missing = await req('/api/investigate');
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: 'invalid request', field: 'target' });
    const long = await req(`/api/investigate?target=${'a'.repeat(256)}`);
    assert.equal(long.status, 400);
    assert.deepEqual(await long.json(), { error: 'invalid request', field: 'target' });
    const arr = await req('/api/investigate?target=a.com&target=b.com');
    assert.equal(arr.status, 400);
  });

  await t.test('/api/region-dossier rejects out-of-range / missing coordinates', async () => {
    const cases = [
      ['lat=91&lng=0', 'lat'], ['lat=-90.5&lng=0', 'lat'], ['lat=abc&lng=0', 'lat'], ['lng=0', 'lat'],
      ['lat=0&lng=181', 'lng'], ['lat=0&lng=-180.1', 'lng'], ['lat=0&lon=200', 'lon'], ['lat=0', 'lng'],
      ['lat=1e1&lng=0', 'lat'],
    ];
    for (const [q, field] of cases) {
      const res = await req(`/api/region-dossier?${q}`);
      assert.equal(res.status, 400, q);
      assert.deepEqual(await res.json(), { error: 'invalid request', field }, q);
    }
  });

  await t.test('POST /api/telegram/channels rejects bad channel lists', async () => {
    const bad = [
      {}, { channels: 'reuters' }, { channels: [] }, { channels: ['abcd'] }, { channels: ['a'.repeat(33)] },
      { channels: ['bbc-news'] }, { channels: ['@reuters'] }, { channels: ['reuters', 42] },
      { channels: Array.from({ length: 21 }, (_, i) => `chan_${i}`) },
    ];
    for (const body of bad) {
      const res = await postJson('/api/telegram/channels', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: 'invalid request', field: 'channels' });
    }
    const notJson = await req('/api/telegram/channels', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'reuters' });
    assert.equal(notJson.status, 400);
  });

  await t.test('other validated routes return generic 400s', async () => {
    const res = await req('/api/country-brief/usa1');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid request', field: 'code' });
    const lang = await postJson('/api/summarize', { language: 'x'.repeat(300) });
    assert.equal(lang.status, 400);
    assert.deepEqual(await lang.json(), { error: 'invalid request', field: 'language' });
  });

  await t.test('/api/health is 200 with the minimal shape and security headers (no CRUCIX_PASSWORD)', async () => {
    const res = await req('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const k of ['status', 'uptime', 'lastSweep', 'sourcesOk', 'sourcesQueried']) assert.ok(k in body, k);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');

    const h = res.headers;
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('referrer-policy'), 'no-referrer');
    assert.equal(h.get('permissions-policy'), 'geolocation=(), camera=(), microphone=()');
    assert.equal(h.get('content-security-policy'), CONTENT_SECURITY_POLICY);
    assert.equal(h.get('x-powered-by'), null);
    assert.equal(h.get('strict-transport-security'), null, 'HSTS only on https');

    const csp = h.get('content-security-policy');
    assert.match(csp, /(^|; )default-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
  });

  await t.test('HSTS is emitted when the proxy reports https', async () => {
    const res = await req('/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  });

  await t.test('security headers are present on static, 404 and 400 responses too', async () => {
    for (const path of ['/', '/api/x', '/api/investigate?kind=banana&target=x']) {
      const res = await req(path);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    }
    // Express's final handler overrides CSP with the stricter `default-src 'none'` on non-API 404s.
    const res = await req('/does-not-exist.txt');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
  });
});
