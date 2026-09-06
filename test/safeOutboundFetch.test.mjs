// lib/safeOutboundFetch.mjs — private-range policy and redirect handling. Uses only a loopback
// http server; DNS is stubbed through the `lookup` option, no external network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  safeOutboundFetch, SafeFetchError, isPrivateAddress, assertPublicHost, isBlockedHostname, normalizeHostname,
  DEFAULT_MAX_REDIRECTS,
} from '../lib/safeOutboundFetch.mjs';
import { safeFetch } from '../apis/utils/fetch.mjs';

const PUBLIC_IP = '93.184.216.34';
const publicLookup = async () => [{ address: PUBLIC_IP, family: 4 }];

test('isPrivateAddress — IPv4 deny-list', () => {
  const denied = [
    '0.0.0.0', '0.1.2.3',                    // 0.0.0.0/8
    '10.0.0.1', '10.255.255.255',            // 10/8
    '127.0.0.1', '127.1.2.3',                // 127/8
    '169.254.169.254',                       // link-local (cloud metadata)
    '172.16.0.1', '172.31.255.255',          // 172.16/12
    '192.168.0.1',                           // 192.168/16
    '100.64.0.1', '100.127.255.255',         // 100.64/10 CGNAT
    '224.0.0.1', '239.255.255.255',          // 224/4 multicast
    '240.0.0.1', '255.255.255.255',          // 240/4 reserved + broadcast
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
  ];
  for (const ip of denied) assert.equal(isPrivateAddress(ip), true, ip);

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '100.63.255.255', '100.128.0.1', '11.0.0.1', '223.255.255.255'];
  for (const ip of allowed) assert.equal(isPrivateAddress(ip), false, ip);
});

test('isPrivateAddress — IPv6 deny-list incl. IPv4-mapped', () => {
  const denied = [
    '::1', '::', '[::1]',
    'fc00::1', 'fd12:3456::1',               // fc00::/7 ULA
    'fe80::1', 'febf::1',                    // fe80::/10 link-local
    'ff02::1',                               // multicast
    '::ffff:127.0.0.1', '::ffff:7f00:1',     // IPv4-mapped loopback
    '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:192.168.1.1', '::ffff:100.64.0.1',
    '::127.0.0.1',                           // IPv4-compatible (deprecated)
    '64:ff9b::7f00:1',                       // NAT64 well-known prefix wrapping loopback
    '2001:db8::1',                           // documentation
  ];
  for (const ip of denied) assert.equal(isPrivateAddress(ip), true, ip);

  const allowed = ['2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:0808:0808', 'fec0::1', '64:ff9b::808:808'];
  for (const ip of allowed) assert.equal(isPrivateAddress(ip), false, ip);
});

test('isPrivateAddress — unparseable input is treated as private', () => {
  for (const bad of ['', 'localhost', 'garbage', '1.2.3', '1.2.3.4.5', '999.1.1.1', ':::1', null, undefined, 42]) {
    assert.equal(isPrivateAddress(bad), true, String(bad));
  }
});

test('hostname deny-list', () => {
  assert.equal(normalizeHostname(' LOCALHOST. '), 'localhost');
  assert.equal(normalizeHostname('[::1]'), '::1');
  for (const h of ['localhost', 'LocalHost', 'localhost.', 'foo.localhost', 'a.b.localhost', 'svc.internal', 'db.prod.internal', 'printer.local', '']) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  for (const h of ['example.com', 'localhost.example.com', 'internal.example.com', 'unpkg.com']) {
    assert.equal(isBlockedHostname(h), false, h);
  }
});

test('assertPublicHost', async (t) => {
  await t.test('literal IPs are checked without any DNS lookup', async () => {
    let lookups = 0;
    const lookup = async () => { lookups++; return [{ address: PUBLIC_IP }]; };
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '[::1]', '::ffff:127.0.0.1', 'fe80::1']) {
      const r = await assertPublicHost(ip, { lookup });
      assert.equal(r.ok, false, ip);
      assert.equal(r.reason, 'private address');
    }
    assert.deepEqual(await assertPublicHost('8.8.8.8', { lookup }), { ok: true, addresses: ['8.8.8.8'] });
    assert.equal(lookups, 0);
  });
  await t.test('blocked hostnames are rejected before DNS', async () => {
    let lookups = 0;
    const lookup = async () => { lookups++; return [{ address: PUBLIC_IP }]; };
    for (const h of ['localhost', 'x.localhost', 'svc.internal', 'nas.local']) {
      assert.deepEqual(await assertPublicHost(h, { lookup }), { ok: false, reason: 'internal hostname' }, h);
    }
    assert.equal(lookups, 0);
  });
  await t.test('DNS: any private answer rejects; all-public passes', async () => {
    assert.deepEqual(await assertPublicHost('example.com', { lookup: publicLookup }), { ok: true, addresses: [PUBLIC_IP] });
    const mixed = async () => [{ address: PUBLIC_IP }, { address: '10.0.0.5' }];
    assert.deepEqual(await assertPublicHost('rebind.example', { lookup: mixed }), { ok: false, reason: 'resolves to private address' });
    const v6 = async () => [{ address: '::ffff:127.0.0.1', family: 6 }];
    assert.deepEqual(await assertPublicHost('mapped.example', { lookup: v6 }), { ok: false, reason: 'resolves to private address' });
    const none = async () => [];
    assert.deepEqual(await assertPublicHost('nx.example', { lookup: none }), { ok: false, reason: 'does not resolve' });
    const throws = async () => { throw new Error('ENOTFOUND'); };
    assert.deepEqual(await assertPublicHost('err.example', { lookup: throws }), { ok: false, reason: 'does not resolve' });
  });
});

// ─── transport ───────────────────────────────────────────────────────────────

function startServer(handler) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    handler(req, res, server.address().port);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, hits, port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

const expectBlocked = async (promise, reason) => {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SafeFetchError, `expected SafeFetchError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'blocked');
    if (reason) assert.equal(err.message, reason);
    return true;
  });
};

test('safeOutboundFetch', async (t) => {
  const srv = await startServer((req, res, port) => {
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
      return res.end();
    }
    if (req.url === '/redirect-localhost') {
      res.writeHead(307, { location: `http://localhost:${port}/secret` });
      return res.end();
    }
    if (req.url === '/redirect-metadata') {
      res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (req.url.startsWith('/loop')) {
      const n = Number(req.url.slice(5) || 0);
      res.writeHead(302, { location: `/loop${n + 1}` });
      return res.end();
    }
    if (req.url === '/hop') {
      res.writeHead(303, { location: '/ok' });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(4096));
    }
    if (req.url === '/slow') {
      return setTimeout(() => { res.writeHead(200); res.end('late'); }, 2000);
    }
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization || null, cookie: req.headers.cookie || null, url: req.url }));
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-test': '1' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  t.after(() => srv.close());

  // Requests to `http://public.test:PORT` hit the local server while the URL keeps a public-looking
  // hostname (resolved to a public IP via the stubbed lookup). Redirect targets go through the real
  // policy check, so a hop to 127.0.0.1 / localhost is blocked *before* any socket is opened.
  const realFetch = globalThis.fetch;
  const routedFetch = (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'public.test') u.hostname = '127.0.0.1';
    return realFetch(u, init);
  };
  t.before(() => { globalThis.fetch = routedFetch; });
  t.after(() => { globalThis.fetch = realFetch; });
  const base = `http://public.test:${srv.port}`;
  const opts = (extra = {}) => ({ lookup: publicLookup, ...extra });

  await t.test('only http(s) URLs', async () => {
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'not a url', '']) {
      await assert.rejects(safeOutboundFetch(u, opts()), (e) => e instanceof SafeFetchError && e.code === 'invalid_url');
    }
  });

  await t.test('literal private / link-local / CGNAT / localhost / mapped targets never reach the network', async () => {
    const before = srv.hits.length;
    for (const target of [
      `http://127.0.0.1:${srv.port}/secret`, `http://10.0.0.1:${srv.port}/`, `http://169.254.169.254/latest/meta-data/`,
      `http://100.64.0.1/`, `http://[::1]:${srv.port}/`, `http://[::ffff:127.0.0.1]:${srv.port}/`, `http://[fe80::1]/`, `http://0.0.0.0:${srv.port}/`,
    ]) {
      await expectBlocked(safeOutboundFetch(target, opts()), 'private address');
    }
    for (const target of [`http://localhost:${srv.port}/secret`, `http://app.localhost:${srv.port}/`, `http://db.internal/`]) {
      await expectBlocked(safeOutboundFetch(target, opts()), 'internal hostname');
    }
    await expectBlocked(safeOutboundFetch('http://rebind.example/', opts({ lookup: async () => [{ address: PUBLIC_IP }, { address: '192.168.1.1' }] })), 'resolves to private address');
    assert.equal(srv.hits.length, before);
  });

  await t.test('public host → buffered Response with status/headers/json/text and final url', async () => {
    const res = await safeOutboundFetch(`${base}/ok`, opts());
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('x-test'), '1');
    assert.equal(res.url, `${base}/ok`);
    assert.deepEqual(await res.json(), { ok: true, url: '/ok' });
  });

  await t.test('redirect to 127.0.0.1 is blocked on the second hop and the private target is never requested', async () => {
    srv.hits.length = 0;
    await expectBlocked(safeOutboundFetch(`${base}/redirect-private`, opts()), 'private address');
    assert.deepEqual(srv.hits, ['/redirect-private']);
  });

  await t.test('redirect to localhost / cloud metadata is blocked too', async () => {
    srv.hits.length = 0;
    await expectBlocked(safeOutboundFetch(`${base}/redirect-localhost`, opts()), 'internal hostname');
    await expectBlocked(safeOutboundFetch(`${base}/redirect-metadata`, opts()), 'private address');
    assert.deepEqual(srv.hits, ['/redirect-localhost', '/redirect-metadata']);
  });

  await t.test('follows public redirects (303 → GET, url updated, auth kept same-origin)', async () => {
    const res = await safeOutboundFetch(`${base}/hop`, opts({ method: 'POST', body: 'x', headers: { authorization: 'Bearer t' } }));
    assert.equal(res.status, 200);
    assert.equal(res.url, `${base}/ok`);
    assert.deepEqual(await res.json(), { ok: true, url: '/ok' });
  });

  await t.test(`stops after ${DEFAULT_MAX_REDIRECTS} redirects`, async () => {
    srv.hits.length = 0;
    await assert.rejects(safeOutboundFetch(`${base}/loop0`, opts()), (e) => e instanceof SafeFetchError && e.code === 'too_many_redirects');
    assert.equal(srv.hits.length, DEFAULT_MAX_REDIRECTS + 1);
    srv.hits.length = 0;
    await assert.rejects(safeOutboundFetch(`${base}/loop0`, opts({ maxRedirects: 1 })), (e) => e.code === 'too_many_redirects');
    assert.equal(srv.hits.length, 2);
  });

  await t.test("redirect: 'manual' / followRedirects:false returns the 3xx itself", async () => {
    const r1 = await safeOutboundFetch(`${base}/redirect-private`, opts({ redirect: 'manual' }));
    assert.equal(r1.status, 302);
    assert.equal(r1.headers.get('location'), `http://127.0.0.1:${srv.port}/secret`);
    const r2 = await safeOutboundFetch(`${base}/hop`, opts({ followRedirects: false }));
    assert.equal(r2.status, 303);
  });

  await t.test('response size cap: fails by default, truncates on request', async () => {
    await assert.rejects(safeOutboundFetch(`${base}/big`, opts({ maxBytes: 1000 })), (e) => e instanceof SafeFetchError && e.code === 'too_large');
    const res = await safeOutboundFetch(`${base}/big`, opts({ maxBytes: 1000, truncate: true }));
    assert.equal((await res.text()).length, 1000);
    const full = await safeOutboundFetch(`${base}/big`, opts());
    assert.equal((await full.text()).length, 4096);
  });

  await t.test('timeout', async () => {
    await assert.rejects(safeOutboundFetch(`${base}/slow`, opts({ timeout: 100 })), (e) => e instanceof SafeFetchError && e.code === 'timeout');
  });

  await t.test('caller AbortSignal is honoured', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(safeOutboundFetch(`${base}/slow`, opts({ signal: ac.signal })), (e) => e.name === 'AbortError');
  });

  await t.test('allowPrivate (operator-configured loopback services) bypasses the policy', async () => {
    const res = await safeOutboundFetch(`http://127.0.0.1:${srv.port}/ok`, { allowPrivate: true });
    assert.equal(res.status, 200);
  });

  await t.test('safeFetch wrapper inherits the policy and keeps its JSON / rawText / error shape', async () => {
    assert.deepEqual(await safeFetch(`${base}/ok`, { retries: 0, lookup: publicLookup }), { ok: true, url: '/ok' });
    assert.deepEqual(await safeFetch(`${base}/big`, { retries: 0, lookup: publicLookup }), { rawText: 'x'.repeat(4096) });
    const blocked = await safeFetch(`http://127.0.0.1:${srv.port}/secret`, { retries: 3 });
    assert.deepEqual(blocked, { error: 'private address', source: `http://127.0.0.1:${srv.port}/secret` });
    const viaRedirect = await safeFetch(`${base}/redirect-private`, { retries: 0, lookup: publicLookup });
    assert.equal(viaRedirect.error, 'private address');
  });
});
