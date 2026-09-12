// /events stream contract: headers a proxy must not buffer or cache, an immediate `connected`
// frame carrying the heartbeat period, and heartbeat events while the stream is otherwise idle.
// The heartbeat period is shortened via env before server.mjs is (dynamically) imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SSE_HEARTBEAT_MS = '100';
const { app } = await import('../server.mjs');

test('/events SSE stream', async (t) => {
  let server, base;
  t.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  t.after(() => new Promise((r) => server.close(r)));

  const readFrames = async (res, count, timeoutMs = 3000) => {
    const frames = [];
    const reader = res.body.getReader();
    const deadline = setTimeout(() => reader.cancel(), timeoutMs);
    let pending = '';
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += Buffer.from(value).toString();
      let i;
      while ((i = pending.indexOf('\n\n')) >= 0) {
        frames.push(pending.slice(0, i));
        pending = pending.slice(i + 2);
      }
    }
    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
    return frames;
  };
  const payload = (frame) => JSON.parse(frame.replace(/^data: /, ''));

  await t.test('headers disable proxy buffering and caching', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    ac.abort();
  });

  await t.test('connected frame is immediate and advertises the heartbeat period', async () => {
    const res = await fetch(`${base}/events`);
    const [first] = await readFrames(res, 1);
    assert.deepEqual(payload(first), { type: 'connected', heartbeatMs: 100 });
  });

  await t.test('heartbeat events keep an idle stream busy', async () => {
    const res = await fetch(`${base}/events`);
    const started = Date.now();
    const frames = await readFrames(res, 4);
    assert.equal(frames.length, 4);
    for (const f of frames.slice(1)) assert.deepEqual(payload(f), { type: 'heartbeat' });
    assert.ok(Date.now() - started < 2000, 'three heartbeats at 100ms should arrive well under 2s');
  });

  await t.test('disconnected clients are dropped from the broadcast set', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    await readFrames(res, 1);
    ac.abort();
    // A new subscriber after the abort still gets heartbeats; a stale client must not break the loop.
    const res2 = await fetch(`${base}/events`);
    const frames = await readFrames(res2, 3);
    assert.equal(frames.length, 3);
  });
});
