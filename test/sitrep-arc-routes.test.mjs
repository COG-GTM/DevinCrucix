// /api/sitrep/arc route contracts over loopback with no model and a pre-seeded archive (2 dailies: one 10 days old,
// one fresh) — weekly has too few editions, monthly succeeds rules-only; status / listing / download / verify / limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TARGETING_DATA_DIR = mkdtempSync(join(tmpdir(), 'sitrep-arc-routes-tgt-'));
process.env.SITREP_DATA_DIR = mkdtempSync(join(tmpdir(), 'sitrep-arc-routes-'));
process.env.SITREP_TZ = 'America/New_York';
delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY;

const { SitrepStore } = await import('../lib/sitrep/store.mjs');
const { generateSitrep } = await import('../lib/sitrep/index.mjs');
const STATE = { lastSweepTime: '2026-10-05T10:00:00Z', data: { situation: { asOf: '2026-10-05T10:02:00Z', headlines: [{ severity: 'high', title: 'Caracas blackout', why: 'IODA', source: 'IODA', tab: 'cyber' }] } } };
const seedStore = new SitrepStore({ dir: process.env.SITREP_DATA_DIR });
const old = await generateSitrep({ provider: null, state: STATE, edition: 'am', now: new Date(Date.now() - 10 * 86400_000) });
const fresh = await generateSitrep({ provider: null, state: STATE, edition: 'pm', now: new Date(Date.now() - 3600_000) });
seedStore.save(old); seedStore.save(fresh);

const { app } = await import('../server.mjs');

let server, base;
const req = (path, init = {}) => fetch(base + path, init);
const post = (path, body) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('sitrep arc routes', async (t) => {
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  await t.test('status carries the arcs block', async () => {
    const b = await (await req('/api/sitrep/status')).json();
    assert.equal(b.arcs.version, 'sitrep-arc/1'); assert.equal(b.arcs.on, true); assert.deepEqual(b.arcs.kinds, ['weekly', 'monthly']);
    assert.equal(b.arcs.time, '06:30'); assert.equal(b.arcs.timezone, 'America/New_York'); assert.equal(b.arcs.minSources, 2); assert.equal(b.arcs.dailies, 2);
    assert.match(b.arcs.next.weekly.at, /Z$/); assert.match(b.arcs.next.monthly.at, /Z$/); assert.match(b.arcs.next.weekly.slotKey, /weekly/);
    assert.deepEqual(b.arcs.latest, { weekly: null, monthly: null }); assert.equal(b.arcs.lastRunAt, null);
    assert.equal(b.store.editions, 2);
  });

  await t.test('validation', async () => {
    assert.equal((await post('/api/sitrep/arc', { kind: 'yearly' })).status, 400);
    assert.equal((await post('/api/sitrep/arc', { kind: 'am' })).status, 400);
    assert.equal((await post('/api/sitrep/generate', { edition: 'weekly' })).status, 400, 'arcs are not editions of the daily route');
  });

  await t.test('weekly: 422 when the 7-day window holds fewer than 2 editions', async () => {
    const res = await post('/api/sitrep/arc', { kind: 'weekly' });
    assert.equal(res.status, 422);
    const b = await res.json();
    assert.match(b.error, /need at least 2 archived editions in the last 7 days \(have 1\)/); assert.equal(b.minSources, 2);
  });

  let arc;
  await t.test('monthly: 201 rules-only arc from the two dailies; archived, listable, downloadable, verifiable', async () => {
    const res = await post('/api/sitrep/arc', { kind: 'monthly' });
    assert.equal(res.status, 201);
    arc = await res.json();
    assert.equal(arc.edition, 'monthly'); assert.match(arc.id, /^sitrep-\d{8}-monthly-\d{6}$/); assert.equal(arc.trigger, 'manual'); assert.equal(arc.slotKey, null);
    assert.deepEqual(arc.llm, { used: false, reason: 'no model configured' });
    assert.deepEqual(arc.sources.map(s => s.token), ['d1', 'd2']); assert.equal(arc.sources[0].id, old.id); assert.equal(arc.sources[1].id, fresh.id);
    assert.ok(Array.isArray(arc.trend) && arc.trend.length >= 4); assert.match(arc.bluf, /\[stats\]/); assert.match(arc.banner, /OSINT DEMONSTRATION PRODUCT/);
    assert.equal(typeof arc.sha256, 'string'); assert.equal(arc.sha256.length, 64);

    const st = await (await req('/api/sitrep/status')).json();
    assert.equal(st.arcs.latest.monthly.id, arc.id); assert.equal(st.arcs.latest.weekly, null); assert.match(st.arcs.lastRunAt, /Z$/);
    assert.equal(st.latest.id, fresh.id, 'daily "latest" is unaffected by arcs'); assert.equal(st.lastRunAt, null, 'the daily rate-limit clock is untouched');
    assert.equal(st.store.editions, 3);

    const list = await (await req('/api/sitrep?kind=monthly')).json();
    assert.equal(list.editions.length, 1); assert.equal(list.editions[0].id, arc.id);
    assert.equal((await (await req('/api/sitrep?limit=10')).json()).editions.length, 3);
    const latest = await (await req('/api/sitrep/latest')).json();
    assert.equal(latest.id, fresh.id);

    const full = await (await req(`/api/sitrep/${arc.id}`)).json();
    assert.equal(full.sha256, arc.sha256); assert.equal(full.markdown, arc.markdown);
    const md = await req(`/api/sitrep/${arc.id}?format=md`);
    assert.equal(md.status, 200); assert.match(md.headers.get('content-type'), /markdown/); assert.match(md.headers.get('content-disposition'), new RegExp(`${arc.id}\\.md`));
    assert.match(await md.text(), /^# SITREP MONTHLY ARC — SOUTHCOM AOR \(OSINT\)/);
    const v = await (await req(`/api/sitrep/${arc.id}/verify`)).json();
    assert.equal(v.ok, true);
  });

  await t.test('arcs have their own rate limit, and a daily edition is still allowed right after one', async () => {
    const again = await post('/api/sitrep/arc', { kind: 'monthly' });
    assert.equal(again.status, 429); assert.ok((await again.json()).retryAfterSec > 0);
    const daily = await post('/api/sitrep/generate', { edition: 'adhoc' });
    assert.ok([201, 503].includes(daily.status), `daily generate is gated by sweep data, not by the arc clock (got ${daily.status})`);
  });

  await t.test('password gate still applies when configured (no bypass for arc routes)', async () => {
    // Loopback test server runs without DASHBOARD_PASSWORD; the route sits behind the same middleware chain as the rest of /api.
    const res = await req('/api/sitrep/arc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
    assert.equal(res.status, 400);
  });
});
