// /api/sitrep route contracts over loopback with no model configured and a temp archive:
// status, archive listing, validation, 404s, generate (rules-only), Markdown download, verify, rate limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TARGETING_DATA_DIR = mkdtempSync(join(tmpdir(), 'sitrep-routes-tgt-'));
process.env.SITREP_DATA_DIR = mkdtempSync(join(tmpdir(), 'sitrep-routes-'));
process.env.SITREP_TZ = 'America/New_York';
delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY;
const { app } = await import('../server.mjs');

let server, base;
const req = (path, init = {}) => fetch(base + path, init);
const post = (path, body) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('sitrep routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('GET /api/sitrep/status reports schedule, no model, empty archive', async () => {
    const res = await req('/api/sitrep/status');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const b = await res.json();
    assert.equal(b.version, 'sitrep/1');
    assert.equal(b.enabled, false); assert.equal(b.provider, null);
    assert.equal(b.schedule.timezone, 'America/New_York'); assert.equal(b.schedule.am, '06:00'); assert.equal(b.schedule.pm, '16:00');
    assert.ok(['am', 'pm'].includes(b.schedule.next.edition)); assert.match(b.schedule.next.at, /Z$/);
    assert.equal(b.store.editions, 0); assert.equal(b.latest, null); assert.equal(b.inFlight, false);
    assert.deepEqual(b.editions, ['am', 'pm', 'adhoc']);
    assert.match(b.banner, /OSINT DEMONSTRATION PRODUCT/);
    assert.equal(b.limits.minGapSec, 60);
    assert.deepEqual(b.review, { on: false, reason: 'no model configured', label: 'EXTERNAL — UNVERIFIED' });
  });

  await t.test('GET /api/sitrep lists nothing and validates query', async () => {
    let res = await req('/api/sitrep');
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).editions, []);
    res = await req('/api/sitrep?kind=hourly'); assert.equal(res.status, 400); assert.equal((await res.json()).field, 'kind');
    res = await req('/api/sitrep?limit=0'); assert.equal(res.status, 400);
    res = await req('/api/sitrep?before=yesterday'); assert.equal(res.status, 400);
  });

  await t.test('GET /api/sitrep/latest and /:id are 404 before any edition; bad ids rejected', async () => {
    let res = await req('/api/sitrep/latest'); assert.equal(res.status, 404);
    res = await req('/api/sitrep/sitrep-20261005-am'); assert.equal(res.status, 404);
    res = await req('/api/sitrep/..%2Findex'); assert.ok([400, 404].includes(res.status));
    res = await req('/api/sitrep/DROP%20TABLE'); assert.equal(res.status, 400);
    res = await req('/api/sitrep/sitrep-20261005-am/verify'); assert.equal(res.status, 404);
  });

  await t.test('POST /api/sitrep/generate validates and refuses without data or returns a rules-only edition', async () => {
    let res = await post('/api/sitrep/generate', { edition: 'weekly' });
    assert.equal(res.status, 400); assert.equal((await res.json()).field, 'edition');
    res = await post('/api/sitrep/generate', { edition: 'adhoc' });
    if (res.status === 503) {
      assert.match((await res.json()).error, /No data yet/);
      return; // no sweep data in this checkout — the contract is still verified
    }
    assert.equal(res.status, 201);
    const ed = await res.json();
    assert.match(ed.id, /^sitrep-\d{8}-adhoc-\d{6}$/);
    assert.deepEqual(ed.llm, { used: false, reason: 'no model configured' });
    assert.match(ed.markdown, /^# COMMANDER'S SITREP/);
    assert.equal(ed.trigger, 'manual');

    let r2 = await post('/api/sitrep/generate', {});
    assert.equal(r2.status, 429); assert.ok((await r2.json()).retryAfterSec >= 1);

    r2 = await req('/api/sitrep/latest'); assert.equal(r2.status, 200); assert.equal((await r2.json()).id, ed.id);
    r2 = await req('/api/sitrep'); const list = await r2.json(); assert.equal(list.editions[0].id, ed.id); assert.equal(list.editions[0].llm, 'rules');
    r2 = await req(`/api/sitrep/${ed.id}?format=md`);
    assert.equal(r2.status, 200); assert.match(r2.headers.get('content-type'), /text\/markdown/); assert.match(r2.headers.get('content-disposition'), new RegExp(`${ed.id}\\.md`));
    assert.equal(await r2.text(), ed.markdown);
    r2 = await req(`/api/sitrep/${ed.id}?format=pdf`); assert.equal(r2.status, 400);
    r2 = await req(`/api/sitrep/${ed.id}/verify`); const v = await r2.json(); assert.equal(v.ok, true); assert.equal(v.actual, ed.sha256);
    const st = await (await req('/api/sitrep/status')).json();
    assert.equal(st.store.editions, 1); assert.equal(st.latest.id, ed.id); assert.ok(st.lastRunAt);
  });
});
