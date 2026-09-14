// /api/targeting route contracts — drives the Express app over loopback against an isolated store
// directory. No external network: development runs over whatever local stores exist (none in CI),
// so assertions are on shape and analyst-review state, never on mention counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'tgt-routes-'));
process.env.TARGETING_DATA_DIR = dataDir;
const { app } = await import('../server.mjs');

let server, base;
const req = (path, init = {}) => fetch(base + path, init);
const json = (method, path, body) => req(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const NOMINATION = {
  label: 'Nemesio Oseguera Cervantes', type: 'person', aliases: ['El Mencho'],
  basis: { kind: 'source-url', ref: 'https://www.justice.gov/opa/pr/x' },
  requirement: 'Current whereabouts, publicly named associates and lieutenants, and any change in status.', priority: 1,
};

test('targeting routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  let id;

  await t.test('GET /api/targeting exposes capabilities and an empty isolated store', async () => {
    const res = await req('/api/targeting');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.targets, []);
    assert.deepEqual(body.capabilities.types, ['person', 'org', 'facility', 'vehicle', 'vessel', 'aircraft']);
    assert.deepEqual(body.capabilities.decisions, ['accept', 'reject', 'reset']);
    assert.equal(typeof body.capabilities.llm.configured, 'boolean');
    assert.ok(!JSON.stringify(body).includes(process.env.LLM_API_KEY || '\u0000never'), 'no secret material in capabilities');
    assert.equal((await req('/api/targeting?x=1')).status, 400);
  });

  await t.test('POST /api/targeting/targets validates with generic errors and rejects unknown fields', async () => {
    const cases = [
      [{ ...NOMINATION, extra: 1 }, 'body'],
      [[NOMINATION], 'body'],
      [{ ...NOMINATION, type: 'human' }, 'type'],
      [{ ...NOMINATION, label: '<script>alert(1)</script>' }, 'label'],
      [{ ...NOMINATION, basis: { kind: 'source-url', ref: 'http://insecure.example/x' } }, 'basis.ref'],
      [{ ...NOMINATION, basis: { kind: 'twitter', ref: 'x' } }, 'basis'],
      [{ ...NOMINATION, requirement: 'short' }, 'requirement'],
      [{ ...NOMINATION, priority: 9 }, 'priority'],
      [{ ...NOMINATION, aliases: 'El Mencho' }, 'aliases'],
    ];
    for (const [body, field] of cases) {
      const res = await json('POST', '/api/targeting/targets', body);
      assert.equal(res.status, 400, field);
      const out = await res.json();
      assert.equal(out.error, 'invalid request');
      assert.equal(out.field, field);
      assert.ok(!JSON.stringify(out).includes('script'), 'input is never echoed');
    }
  });

  await t.test('nominate → 201, duplicate → 409, read back without the package', async () => {
    const res = await json('POST', '/api/targeting/targets', NOMINATION);
    assert.equal(res.status, 201);
    const { target } = await res.json();
    assert.match(target.id, /^tgt_[a-f0-9]{12}$/);
    assert.equal(target.status, 'nominated');
    assert.deepEqual(target.aliases, ['El Mencho']);
    assert.equal('package' in target, false);
    id = target.id;

    const dup = await json('POST', '/api/targeting/targets', NOMINATION);
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).id, id);

    const get = await req(`/api/targeting/targets/${id}`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.id, id);
    assert.equal(body.package, null);
    assert.deepEqual(body.graphProposals, []);
    assert.equal(body.developing, false);

    // Store and audit are JSON files under the isolated directory.
    assert.ok(existsSync(join(dataDir, 'targets.json')));
    const audit = readFileSync(join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(audit.some(e => e.component === 'targeting' && e.action === 'target.nominate' && e.targetId === id));
  });

  await t.test('path ids are pattern-checked; unknown ids are generic 404s', async () => {
    for (const p of ['/api/targeting/targets/abc', '/api/targeting/targets/tgt_ZZZZZZZZZZZZ', `/api/targeting/targets/${'a'.repeat(40)}`]) {
      const res = await req(p);
      assert.equal(res.status, 400, p);
      assert.equal((await res.json()).error, 'invalid request');
    }
    assert.equal((await req('/api/targeting/targets/tgt_000000000000')).status, 404);
    assert.equal((await json('POST', '/api/targeting/targets/tgt_000000000000/develop')).status, 404);
    assert.equal((await json('POST', '/api/targeting/targets/tgt_000000000000/close')).status, 404);
    assert.equal((await req('/api/targeting/targets/tgt_000000000000', { method: 'DELETE' })).status, 404);
    assert.equal((await req('/api/targeting/targets/tgt_000000000000/dossier.md')).status, 404);
    assert.equal((await json('POST', `/api/targeting/targets/${id}/links/lnk_000000000000`, { decision: 'accept' })).status, 404);
    assert.equal((await json('POST', `/api/targeting/targets/${id}/proposals/gp_000000000000`, { decision: 'accept' })).status, 404);
    assert.equal((await json('POST', `/api/targeting/targets/${id}/links/not-a-link`, { decision: 'accept' })).status, 400);
    assert.equal((await json('POST', `/api/targeting/targets/${id}/proposals/gp_x`, { decision: 'accept' })).status, 400);
  });

  await t.test('dossier before development is a 409; develop body must be empty', async () => {
    assert.equal((await req(`/api/targeting/targets/${id}/dossier.md`)).status, 409);
    const bad = await json('POST', `/api/targeting/targets/${id}/develop`, { force: true });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid request', field: 'body' });
  });

  await t.test('develop → package with review state; nothing is accepted without an analyst', async () => {
    const res = await json('POST', `/api/targeting/targets/${id}/develop`);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.status, 'developed');
    assert.equal(body.package.schema, 'crucix-target-package/1');
    assert.equal(typeof body.package.coverage, 'object');
    for (const c of Object.values(body.package.coverage)) assert.equal(typeof c.available, 'boolean');
    assert.equal(body.package.llm.used, Boolean(body.package.llm.model));
    assert.ok(Array.isArray(body.package.links));
    assert.ok(Array.isArray(body.graphProposals));
    for (const gp of body.graphProposals) assert.equal(gp.status, 'proposed');
    for (const l of body.package.links) {
      assert.equal(l.decision, null);
      assert.ok(Array.isArray(l.evidence) && l.evidence.length >= 1, 'every link carries source evidence');
    }
    assert.equal(body.package.graphProposals, undefined, 'proposals live on the target, not the package');
    assert.deepEqual(await (await req('/api/targeting/graph-overlay')).json(), []);
    const list = await (await req('/api/targeting')).json();
    const row = list.targets.find(x => x.id === id);
    assert.equal(row.status, 'developed');
    assert.equal(row.stats.links, body.package.links.length, 'deck summary carries the package stats');
    assert.equal(row.stats.pendingLinks, body.package.links.length);
    assert.equal(row.stats.proposals, body.graphProposals.length);
  });

  await t.test('decisions are allowlisted and update the overlay only on accept', async () => {
    const before = await (await req(`/api/targeting/targets/${id}`)).json();
    const badDecision = await json('POST', `/api/targeting/targets/${id}/proposals/gp_000000000000`, { decision: 'approve' });
    assert.equal(badDecision.status, 400);
    assert.equal((await badDecision.json()).field, 'decision');
    const extraField = await json('POST', `/api/targeting/targets/${id}/proposals/gp_000000000000`, { decision: 'accept', note: 'x' });
    assert.equal(extraField.status, 400);

    const gp = before.graphProposals[0];
    const link = before.package.links[0];
    if (!gp || !link) return; // no local stores in this environment: lifecycle is covered by test/targeting.test.mjs

    const acc = await json('POST', `/api/targeting/targets/${id}/proposals/${gp.id}`, { decision: 'accept' });
    assert.equal(acc.status, 200);
    assert.equal((await acc.json()).proposal.status, 'accepted');
    const overlay = await (await req('/api/targeting/graph-overlay')).json();
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].id, gp.id);
    assert.equal(overlay[0].targetId, id);

    const rej = await json('POST', `/api/targeting/targets/${id}/links/${link.id}`, { decision: 'reject' });
    assert.equal(rej.status, 200);
    assert.equal((await rej.json()).link.decision, 'reject');
    const after = await (await req(`/api/targeting/targets/${id}`)).json();
    assert.equal(after.decisions[link.id].decision, 'reject');
    // Rejecting the link the proposal came from pulls it back out of the overlay.
    if (gp.linkId === link.id) assert.deepEqual(await (await req('/api/targeting/graph-overlay')).json(), []);

    const reset = await json('POST', `/api/targeting/targets/${id}/proposals/${gp.id}`, { decision: 'reset' });
    assert.equal((await reset.json()).proposal.status, 'proposed');
  });

  await t.test('dossier export is sourced Markdown with the review caveat and records the export', async () => {
    const res = await req(`/api/targeting/targets/${id}/dossier.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    assert.match(res.headers.get('content-disposition'), new RegExp(`crucix-target-${id}\\.md`));
    const md = await res.text();
    assert.match(md, /^# Target development package/m);
    assert.match(md, /Nemesio Oseguera Cervantes/);
    assert.match(md, /Nothing here is verified ground truth/);
    assert.match(md, /Cognition/);
    const t2 = await (await req(`/api/targeting/targets/${id}`)).json();
    assert.equal(t2.exports, 1);
  });

  await t.test('close blocks development, delete removes, both 404 afterwards', async () => {
    const closed = await json('POST', `/api/targeting/targets/${id}/close`);
    assert.equal(closed.status, 200);
    assert.equal((await closed.json()).target.status, 'closed');
    assert.equal((await json('POST', `/api/targeting/targets/${id}/develop`)).status, 409);
    // A closed target no longer blocks the same nomination.
    const again = await json('POST', '/api/targeting/targets', NOMINATION);
    assert.equal(again.status, 201);
    const id2 = (await again.json()).target.id;
    assert.notEqual(id2, id);
    for (const x of [id, id2]) {
      assert.equal((await req(`/api/targeting/targets/${x}`, { method: 'DELETE' })).status, 200);
      assert.equal((await req(`/api/targeting/targets/${x}`)).status, 404);
    }
    assert.equal((await (await req('/api/targeting')).json()).count, 0);
  });
});
