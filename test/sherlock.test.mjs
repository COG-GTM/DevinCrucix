import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifest, manifestInfo, normalizeSite, usernameAllowed, buildRequest, evaluate, runManifest, registrableHost, categorize,
} from '../lib/sherlock.mjs';

const okRes = (status, body = '', extra = {}) => ({ ok: true, status, body, headers: new Headers(), url: extra.url || '', ...extra });
const failRes = (error = 'unreachable') => ({ ok: false, status: 0, body: '', error, headers: new Headers() });

function fixtureDir(sites, { health } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sherlock-'));
  writeFileSync(join(dir, 'data.json'), JSON.stringify(sites));
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ source: 'fixture', commit: 'abc', license: 'MIT', fetchedAt: '2026-01-01' }));
  if (health) writeFileSync(join(dir, 'health.json'), JSON.stringify(health));
  return dir;
}

const SITES = {
  MsgSite: { errorMsg: 'User not found', errorType: 'message', url: 'https://msg.example/{}', urlMain: 'https://msg.example/', username_claimed: 'alice' },
  CodeSite: { errorCode: 404, errorType: 'status_code', url: 'https://code.example/u/{}', urlMain: 'https://code.example/', regexCheck: '^[a-z]{3,10}$', username_claimed: 'alice' },
  RedirSite: { errorType: 'response_url', errorUrl: 'https://redir.example/login', url: 'https://redir.example/{}', urlMain: 'https://redir.example/', username_claimed: 'alice' },
  PostSite: { errorType: 'message', errorMsg: ['"exists":false'], url: 'https://post.example/{}', urlMain: 'https://post.example/', urlProbe: 'https://post.example/api/check', request_method: 'POST', request_payload: { name: '{}' }, headers: { 'X-Api': '1' }, username_claimed: 'alice' },
  Adult: { errorType: 'status_code', url: 'https://adult.example/{}', urlMain: 'https://adult.example/', isNSFW: true, username_claimed: 'alice' },
  Broken: { errorType: 'bogus', url: 'https://broken.example/{}', urlMain: 'https://broken.example/' },
};

test('loadManifest normalizes entries, flags NSFW, reports invalid and disabled', () => {
  const dir = fixtureDir(SITES, { health: { checkedAt: '2026-01-02T00:00:00Z', disabled: { CodeSite: { reason: 'claimed example not found', at: '2026-01-02T00:00:00Z' } } } });
  const m = loadManifest({ dir, force: true });
  assert.equal(m.sites.length, 5);
  assert.deepEqual(m.invalid, ['Broken']);
  assert.ok(m.sites.find(s => s.name === 'Adult').nsfw);
  assert.ok(m.sites.find(s => s.name === 'CodeSite').disabled);
  const info = manifestInfo({ dir });
  assert.equal(info.sites, 5); assert.equal(info.nsfw, 1); assert.equal(info.disabled, 1); assert.equal(info.invalid, 1);
  assert.equal(info.license, 'MIT'); assert.equal(info.commit, 'abc');
});

test('normalizeSite coerces scalars to arrays and lower-cases hosts', () => {
  const s = normalizeSite('MsgSite', SITES.MsgSite);
  assert.deepEqual(s.errorMsg, ['User not found']);
  assert.equal(s.method, 'GET');
  assert.equal(s.host, 'msg.example');
  const c = normalizeSite('CodeSite', SITES.CodeSite);
  assert.deepEqual(c.errorCode, [404]);
  assert.ok(c.regex instanceof RegExp);
});

test('usernameAllowed honours regexCheck', () => {
  const s = normalizeSite('CodeSite', SITES.CodeSite);
  assert.equal(usernameAllowed(s, 'alice'), true);
  assert.equal(usernameAllowed(s, 'Alice-1'), false);
  assert.equal(usernameAllowed(normalizeSite('MsgSite', SITES.MsgSite), 'anything_goes'), true);
});

test('buildRequest interpolates url, urlProbe, payload and headers', () => {
  const r = buildRequest(normalizeSite('PostSite', SITES.PostSite), 'alice');
  assert.equal(r.url, 'https://post.example/api/check');
  assert.equal(r.profileUrl, 'https://post.example/alice');
  assert.equal(r.method, 'POST');
  assert.equal(JSON.parse(r.body).name, 'alice');
  assert.equal(r.headers['X-Api'], '1');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.ok(/User-Agent/.test(Object.keys(r.headers).join()));
  const g = buildRequest(normalizeSite('MsgSite', SITES.MsgSite), 'a b');
  assert.equal(g.url, 'https://msg.example/a%20b');
  assert.equal(g.followRedirects, true);
  assert.equal(buildRequest(normalizeSite('RedirSite', SITES.RedirSite), 'alice').followRedirects, false);
});

test('evaluate: message detector', () => {
  const s = normalizeSite('MsgSite', SITES.MsgSite);
  assert.equal(evaluate(s, okRes(200, '<h1>alice</h1>')).status, 'found');
  assert.equal(evaluate(s, okRes(200, 'Sorry, User not found')).status, 'not_found');
  assert.equal(evaluate(s, failRes('timed out')).status, 'error');
  assert.equal(evaluate(s, failRes('timed out')).error, 'timed out');
});

test('evaluate: status_code detector treats listed codes and non-2xx as absent', () => {
  const s = normalizeSite('CodeSite', SITES.CodeSite);
  assert.equal(evaluate(s, okRes(200)).status, 'found');
  assert.equal(evaluate(s, okRes(404)).status, 'not_found');
  assert.equal(evaluate(s, okRes(302)).status, 'not_found');
  assert.equal(evaluate(s, okRes(500)).status, 'not_found');
});

test('evaluate: response_url detector — 2xx without redirect is a hit', () => {
  const s = normalizeSite('RedirSite', SITES.RedirSite);
  assert.equal(evaluate(s, okRes(200)).status, 'found');
  assert.equal(evaluate(s, okRes(302)).status, 'not_found');
});

test('evaluate: WAF challenge pages are reported as waf, not found', () => {
  const s = normalizeSite('MsgSite', SITES.MsgSite);
  const r = evaluate(s, okRes(200, '<title>Just a moment...</title>'));
  assert.equal(r.status, 'waf');
});

test('runManifest: bounded pool, exclusions, NSFW gate, disabled gate, illegal usernames, progress', async () => {
  const dir = fixtureDir(SITES, { health: { checkedAt: null, disabled: { RedirSite: { reason: 'stale' } } } });
  loadManifest({ dir, force: true });
  const calls = [];
  let inflight = 0, peak = 0;
  const probe = async (url, opts) => {
    inflight++; peak = Math.max(peak, inflight);
    calls.push({ url, method: opts.method, body: opts.body, redirect: opts.redirect });
    await new Promise(r => setTimeout(r, 5));
    inflight--;
    if (url.startsWith('https://msg.example/')) return okRes(200, 'profile page');
    if (url.startsWith('https://post.example/')) return okRes(200, '{"exists":true}');
    return okRes(404);
  };
  const progress = [];
  const out = await runManifest('Alice-1', { probe, pool: 2, manifestDir: dir, exclude: new Set(['adult.example']), onProgress: p => progress.push(p) });
  // CodeSite: regex rejects 'Alice-1' -> illegal, no request. RedirSite disabled. Adult excluded by host AND nsfw.
  assert.equal(out.total, 3);
  assert.deepEqual(out.skipped, { nsfw: 1, disabled: 1, curated: 0 });
  const byName = Object.fromEntries(out.results.map(r => [r.platform, r]));
  assert.equal(byName.MsgSite.status, 'found');
  assert.equal(byName.MsgSite.confidence, 'message');
  assert.equal(byName.MsgSite.source, 'sherlock');
  assert.equal(byName.MsgSite.url, 'https://msg.example/Alice-1');
  assert.equal(byName.PostSite.status, 'found');
  assert.equal(byName.CodeSite.status, 'illegal');
  assert.equal(byName.RedirSite, undefined);
  assert.equal(calls.length, 2);
  assert.ok(peak <= 2);
  const post = calls.find(c => c.url === 'https://post.example/api/check');
  assert.equal(post.method, 'POST');
  assert.equal(JSON.parse(post.body).name, 'Alice-1');
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).done, 3);
  assert.equal(progress.at(-1).total, 3);
});

test('runManifest: includeNsfw and includeDisabled widen the run; every request goes through the supplied probe', async () => {
  const dir = fixtureDir(SITES, { health: { checkedAt: null, disabled: { RedirSite: { reason: 'stale' } } } });
  loadManifest({ dir, force: true });
  const urls = [];
  const probe = async (url) => { urls.push(url); return okRes(200, 'ok'); };
  const out = await runManifest('alice', { probe, manifestDir: dir, includeNsfw: true, includeDisabled: true });
  assert.equal(out.total, 5);
  assert.ok(urls.includes('https://adult.example/alice'));
  assert.ok(urls.includes('https://redir.example/alice'));
  assert.ok(out.results.find(r => r.platform === 'Adult').nsfw);
  assert.equal(out.results.find(r => r.platform === 'RedirSite').confidence, 'response_url');
});

test('runManifest requires a probe (no implicit network client)', async () => {
  await assert.rejects(() => runManifest('alice', {}), TypeError);
});

test('registrableHost and categorize', () => {
  assert.equal(registrableHost('https://www.github.com/x'), 'github.com');
  assert.equal(registrableHost('https://forum.example.co.uk/u/x'), 'example.co.uk');
  assert.equal(registrableHost('not a url'), null);
  assert.equal(categorize('Pornhub', 'pornhub.com', { nsfw: true }), 'adult');
  assert.equal(categorize('GitHub', 'github.com', {}), 'dev');
  assert.equal(categorize('Steam', 'steamcommunity.com', {}), 'gaming');
});

test('vendored manifest loads cleanly: all entries valid, every url has a template or probe', () => {
  const m = loadManifest({ force: true });
  assert.ok(m.sites.length > 400);
  assert.deepEqual(m.invalid, []);
  for (const s of m.sites) {
    assert.ok(s.probeUrl.includes('{}') || s.method === 'POST', `${s.name} has no username slot`);
    assert.ok(['message', 'status_code', 'response_url'].includes(s.errorType), s.name);
    assert.ok(s.host, s.name);
  }
});
