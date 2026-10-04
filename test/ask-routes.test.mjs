// /api/ask route contracts over loopback with no model configured: status, validation, rules-only
// grounded fallback, external refusal and the per-IP rate limit. No external network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TARGETING_DATA_DIR = mkdtempSync(join(tmpdir(), 'ask-routes-'));
process.env.ASK_RATE_PER_MIN = '4';
delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY;
const { app } = await import('../server.mjs');

let server, base;
const req = (path, init = {}) => fetch(base + path, init);
const post = (body) => req('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('ask routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('GET /api/ask/status reports a disabled model and the limits', async () => {
    const res = await req('/api/ask/status');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const b = await res.json();
    assert.equal(b.enabled, false);
    assert.equal(b.external, false);
    assert.equal(b.provider, null);
    assert.equal(b.externalLabel, 'EXTERNAL — UNVERIFIED');
    assert.deepEqual(Object.keys(b.limits).sort(), ['contextChars', 'historyTurns', 'perMinute', 'questionChars']);
    assert.equal(b.limits.perMinute, 4);
  });

  await t.test('POST /api/ask validates the body', async () => {
    let res = await post({ question: 'hi' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, 'question');
    res = await post({ question: 'what changed', mode: 'wild' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, 'mode');
  });

  await t.test('POST /api/ask grounded without a model returns the rules-only card', async () => {
    const res = await post({ question: 'what is the defcon level?' });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.mode, 'grounded');
    assert.equal(b.llm.used, false);
    assert.equal(b.llm.reason, 'no provider');
    assert.equal(b.suggestExternal, false);
    assert.equal(b.externalAvailable, false);
    assert.ok(typeof b.answer === 'string' && b.answer.length > 0);
    assert.ok(Array.isArray(b.citations));
    assert.ok(Array.isArray(b.context.sections));
  });

  await t.test('POST /api/ask external is refused with 409 when no provider supports it, then the limit trips', async () => {
    const res = await post({ question: 'what happened in Lima today?', mode: 'external' });
    assert.equal(res.status, 409);
    const b = await res.json();
    assert.equal(b.reason, 'no model configured');
    const fifth = await post({ question: 'one more question please' });
    assert.equal(fifth.status, 429);
    assert.equal((await fifth.json()).retryAfterSec, 60);
  });
});
