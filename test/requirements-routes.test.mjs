// /api/requirements/* and /api/history/series route contracts — imports the Express app (no listen /
// sweep at import time) and drives it over a loopback port. No LLM key, no external network: the
// compile route must fall back to the deterministic parser. Rules created here are deleted again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../server.mjs';
import { METRIC_KEYS } from '../lib/requirements/metrics.mjs';
import { ID_RE } from '../lib/requirements/compile.mjs';

let server, base;
const req = (path, init = {}) => fetch(base + path, init);
const json = (method) => (path, body) => req(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postJson = json('POST');

const noLeak = (body) => { const s = JSON.stringify(body); assert.ok(!/stack|node_modules|at .*\.mjs/.test(s), `leaks internals: ${s.slice(0, 200)}`); };

test('requirements routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('GET /api/requirements lists seeded rules with latest evaluation slots and history stats', async () => {
    const res = await req('/api/requirements');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.rules) && body.rules.length >= 3, 'seeded on first run');
    for (const r of body.rules) {
      assert.match(r.id, ID_RE);
      assert.ok(METRIC_KEYS.includes(r.metric));
      assert.ok('latest' in r);
      assert.equal(typeof r.enabled, 'boolean');
    }
    assert.equal(typeof body.firedCount, 'number');
    assert.equal(body.llm, false, 'no LLM key in tests');
    assert.equal(typeof body.history, 'object');
  });

  await t.test('GET /api/requirements/metrics is derived from the catalog (bidirectional sync)', async () => {
    const res = await req('/api/requirements/metrics');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.metrics.map(m => m.key).sort(), [...METRIC_KEYS].sort());
    for (const m of body.metrics) {
      assert.equal(typeof m.label, 'string');
      assert.ok(['count', 'level'].includes(m.kind));
      assert.ok(Array.isArray(m.dims));
      assert.deepEqual(Object.keys(m.dimValues).sort(), [...m.dims].sort());
    }
    assert.deepEqual(body.windows, ['overnight', '24h', '7d', '30d']);
    assert.deepEqual(body.baselines, ['24h', '7d', '30d', '90d']);
    assert.deepEqual(body.comparisons, ['z', 'pct', 'abs']);
    assert.deepEqual(body.directions, ['up', 'down', 'either']);
    assert.ok(body.states.includes('Tamaulipas') && body.states.includes('Nuevo León'));
    assert.ok(body.countries.includes('Ukraine'));
    assert.ok(body.theaters.includes('Baltic Region'));
  });

  await t.test('POST /api/requirements compiles with the deterministic parser and stores nothing', async () => {
    const before = (await (await req('/api/requirements')).json()).rules.length;
    const res = await postJson('/api/requirements', { text: 'Flag overnight spikes in violence in Tamaulipas / Nuevo León vs the trailing month' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.compiledBy, 'rules');
    assert.equal(body.rule.metric, 'border_violence_events');
    assert.deepEqual(body.rule.dims, { state: ['Tamaulipas', 'Nuevo León'] });
    assert.equal(body.rule.window, 'overnight');
    assert.equal(body.rule.baseline, '30d');
    assert.equal(body.rule.direction, 'up');
    const after = (await (await req('/api/requirements')).json()).rules.length;
    assert.equal(after, before, 'compile is a preview, not a save');
  });

  await t.test('POST /api/requirements rejects bad bodies with 400 + generic error', async () => {
    const cases = [
      [{}, 'text'],
      [{ text: 'ab' }, 'text'],
      [{ text: 'x'.repeat(2001) }, 'text'],
      [{ text: 12 }, 'text'],
      [{ text: 'violence in Tamaulipas', severity: 'apocalyptic' }, 'severity'],
      [{ text: 'violence in Tamaulipas', name: 'n'.repeat(500) }, 'name'],
    ];
    for (const [body, field] of cases) {
      const res = await postJson('/api/requirements', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      const out = await res.json();
      assert.equal(out.error, 'invalid request');
      assert.equal(out.field, field);
      assert.ok(!JSON.stringify(out).includes('apocalyptic'));
      noLeak(out);
    }
    const notJson = await req('/api/requirements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(notJson.status, 400);
  });

  await t.test('POST /api/requirements/save validates every field (whitelists), 400 on anything off-list', async () => {
    const good = {
      text: 'kev additions 24h vs 30d', name: 'KEV additions', metric: 'kev_additions', dims: {}, window: '24h', baseline: '30d',
      comparison: 'z', threshold: 2, direction: 'up', severity: 'elevated', compiledBy: 'rules',
    };
    const bad = [
      [{ ...good, metric: 'rm_rf' }, 'metric'],
      [{ ...good, metric: undefined }, 'metric'],
      [{ ...good, window: '1y' }, 'window'],
      [{ ...good, baseline: '24h' }, 'baseline'],            // baseline must be >= 2x observation
      [{ ...good, comparison: 'gt' }, 'comparison'],
      [{ ...good, direction: 'sideways' }, 'direction'],
      [{ ...good, severity: 'meh' }, 'severity'],
      [{ ...good, threshold: -1 }, 'threshold'],
      [{ ...good, threshold: 'two' }, 'threshold'],
      [{ ...good, threshold: 50 }, 'threshold'],              // z bound 0.5–10
      [{ ...good, dims: { planet: 'Mars' } }, 'dims'],
      [{ ...good, dims: 'Tamaulipas' }, 'dims'],
      [{ ...good, dims: { state: 'Tamaulipas' } }, 'dims'],   // kev_additions has no state dimension
      [{ ...good, metric: 'border_violence_events', dims: { state: 'Narnia' } }, 'dims'],
      [{ ...good, metric: 'conflict_fatalities', dims: { country: '<script>' } }, 'dims'],
      [{ ...good, name: undefined }, 'name'],
      [{ ...good, name: 'n'.repeat(500) }, 'name'],
      [{ ...good, compiledBy: 'seed' }, 'compiledBy'],
      [{ ...good, owner: 'o'.repeat(61) }, 'owner'],
    ];
    for (const [body, field] of bad) {
      const res = await postJson('/api/requirements/save', body);
      assert.equal(res.status, 400, `${field}: ${JSON.stringify(body).slice(0, 80)}`);
      const out = await res.json();
      assert.equal(out.error, 'invalid request', field);
      assert.ok(out.field === field || out.field.startsWith(field + '.'), `${field}: got ${out.field}`);
      assert.ok(!/Narnia|Mars|rm_rf|<script>/.test(JSON.stringify(out)), 'never echoes the rejected value');
      noLeak(out);
    }
    const list = (await (await req('/api/requirements')).json()).rules;
    assert.ok(!list.some(r => r.name === 'KEV additions'), 'nothing rejected was stored');
  });

  await t.test('save → enable/disable → findings → delete round trip with audit-safe ids', async () => {
    const good = {
      text: 'kev additions 24h vs 30d', name: 'KEV additions (route test)', metric: 'kev_additions', dims: {}, window: '24h', baseline: '30d',
      comparison: 'z', threshold: 2, direction: 'up', severity: 'elevated', compiledBy: 'rules', id: 'req_client_chosen_id',
    };
    const created = await postJson('/api/requirements/save', good);
    assert.equal(created.status, 201);
    const { rule } = await created.json();
    assert.match(rule.id, ID_RE);
    assert.notEqual(rule.id, 'req_client_chosen_id');
    assert.equal(rule.enabled, true);
    try {
      const dis = await postJson(`/api/requirements/${rule.id}/disable`, {});
      assert.equal(dis.status, 200);
      assert.equal((await dis.json()).rule.enabled, false);
      const en = await postJson(`/api/requirements/${rule.id}/enable`, {});
      assert.equal((await en.json()).rule.enabled, true);

      const f = await req(`/api/requirements/${rule.id}/findings?limit=5`);
      assert.equal(f.status, 200);
      const fb = await f.json();
      assert.equal(fb.rule.id, rule.id);
      assert.ok(Array.isArray(fb.findings));
      assert.ok('latest' in fb);

      for (const q of ['limit=0', 'limit=501', 'limit=abc', 'limit=-1', 'limit=1.5']) {
        const r = await req(`/api/requirements/${rule.id}/findings?${q}`);
        assert.equal(r.status, 400, q);
        assert.deepEqual(await r.json(), { error: 'invalid request', field: 'limit' });
      }
      for (const badId of ['abc', 'req_', 'req_XYZ', 'req_' + 'a'.repeat(17), 'req_' + 'a'.repeat(9), '..%2F..', 'req_abcdef1234-5', 'req_ABCDEF123456']) {
        const r = await req(`/api/requirements/${badId}/findings`);
        assert.equal(r.status, 400, badId);
        assert.deepEqual(await r.json(), { error: 'invalid request', field: 'id' });
        const e = await postJson(`/api/requirements/${badId}/enable`, {});
        assert.equal(e.status, 400, badId);
      }
      const missing = await req('/api/requirements/req_000000000000/findings');
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'not found' });
      const missingEnable = await postJson('/api/requirements/req_000000000000/enable', {});
      assert.equal(missingEnable.status, 404);
      const unknownAction = await postJson(`/api/requirements/${rule.id}/explode`, {});
      assert.equal(unknownAction.status, 404);
    } finally {
      const del = await req(`/api/requirements/${rule.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.deepEqual(await del.json(), { ok: true });
    }
    const again = await req(`/api/requirements/${rule.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    const badDel = await req('/api/requirements/not-an-id', { method: 'DELETE' });
    assert.equal(badDel.status, 400);
    const list = (await (await req('/api/requirements')).json()).rules;
    assert.ok(!list.some(r => r.id === rule.id));
  });

  await t.test('GET /api/history/series validates metric / dims / window', async () => {
    const ok = await req('/api/history/series?metric=kev_total&window=7d');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.metric, 'kev_total');
    assert.equal(body.window, '7d');
    assert.deepEqual(body.dims, {});
    assert.ok(Array.isArray(body.samples));
    assert.ok('observed' in body.baseline && 'sparse' in body.baseline && 'z' in body.baseline);
    const dims = await req('/api/history/series?metric=border_violence_events&dims=state:Tamaulipas&window=30d');
    assert.equal(dims.status, 200);
    assert.deepEqual((await dims.json()).dims, { state: 'Tamaulipas' });
    const dflt = await req('/api/history/series?metric=urgent_posts');
    assert.equal((await dflt.json()).window, '30d');

    const bad = [
      ['', 'metric'],
      ['metric=rm_rf', 'metric'],
      ['metric=kev_total&window=1y', 'window'],
      ['metric=kev_total&window=overnight', 'window'],
      ['metric=kev_total&dims=Tamaulipas', 'dims'],
      ['metric=kev_total&dims=planet:Mars', 'dims'],
      ['metric=kev_total&dims=state:' + 'a'.repeat(61), 'dims'],
      ['metric=kev_total&dims=state:a', 'dims'],
      ['metric=kev_total&dims=state:x,state:y,state:z,state:w', 'dims'],
      ['metric=kev_total&metric=urgent_posts', 'metric'],
    ];
    for (const [q, field] of bad) {
      const res = await req(`/api/history/series?${q}`);
      assert.equal(res.status, 400, q);
      const out = await res.json();
      assert.equal(out.error, 'invalid request', q);
      assert.equal(out.field, field, q);
      assert.ok(!/Mars|rm_rf/.test(JSON.stringify(out)));
      noLeak(out);
    }
  });
});
