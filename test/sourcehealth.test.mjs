// Source health classification — unit tests (no network)
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, classifySource, buildSourceHealth, envVarsFrom, shortError, isEmptyPayload } from '../lib/sourcehealth.mjs';

describe('classifySource', () => {
  it('reports a populated payload as live', () => {
    const r = classifySource('Safecast', { source: 'Safecast', sites: [{ site: 'Chernobyl' }], signals: [] }, { status: 'ok', ms: 900 });
    assert.equal(r.state, 'live');
    assert.equal(r.ms, 900);
  });

  it('maps missing-credential statuses to no_key and extracts env vars', () => {
    for (const status of ['no_key', 'no_credentials', 'no_api_key']) {
      const r = classifySource('ACLED', { status, message: 'Set ACLED_EMAIL + ACLED_API_KEY in .env. Register at https://developer.acleddata.com/' });
      assert.equal(r.state, 'no_key');
      assert.deepEqual(r.envVars, ['ACLED_EMAIL', 'ACLED_API_KEY']);
    }
  });

  it('treats an error payload that names a key as no_key, otherwise as error', () => {
    assert.equal(classifySource('FRED', { error: 'FRED_API_KEY not set', hint: 'Set FRED_API_KEY in .env' }).state, 'no_key');
    assert.equal(classifySource('FRED', { error: 'HTTP 500' }).state, 'error');
  });

  it('marks explicit offline / unavailable statuses as off', () => {
    assert.equal(classifySource('SpiderFoot', { status: 'offline' }).state, 'off');
    const r = classifySource('PizzaIndex', { status: 'unavailable', error: 'HTTP 404' });
    assert.equal(r.state, 'off');
    assert.equal(r.detail, 'HTTP 404');
  });

  it('maps empty/blocked statuses to degraded and an explicit error status to error even with data attached', () => {
    assert.equal(classifySource('BorderNews', { status: 'empty', feeds: [{ id: 'a' }] }).state, 'degraded');
    assert.equal(classifySource('BorderNews', { status: 'blocked', feeds: [{ id: 'a' }] }).state, 'degraded');
    const r = classifySource('BorderNews', { status: 'error', error: 'all feeds failed: ENOTFOUND', feeds: [{ id: 'a' }], registry: [{}] });
    assert.equal(r.state, 'error');
    assert.equal(r.reason, 'unreachable');
    assert.equal(classifySource('X', { status: 'error', message: 'HTTP 503', items: [1] }).state, 'error');
  });

  it('treats deferred composites as live/derived', () => {
    const r = classifySource('CII', { status: 'deferred', message: 'computed post-sweep' });
    assert.equal(r.state, 'live');
    assert.equal(r.kind, 'derived');
  });

  it('flags limited / fallback / stale payloads as degraded', () => {
    assert.equal(classifySource('Maritime', { status: 'limited', chokepoints: { hormuz: {} }, message: 'Set AISSTREAM_API_KEY' }).state, 'degraded');
    assert.equal(classifySource('ReliefWeb', { rwError: 'HTTP 406', rwNote: 'blocked', hdxDatasets: [{ id: 1 }] }).state, 'degraded');
    assert.equal(classifySource('X', { stale: true, items: [1] }).state, 'degraded');
    assert.equal(classifySource('Y', { error: 'HTTP 503', items: [1] }).state, 'degraded');
  });

  it('does not count an empty successful poll as live', () => {
    const r = classifySource('GDELT', { source: 'GDELT', totalArticles: 0, allArticles: [], geoPoints: [], timestamp: 'x' });
    assert.equal(r.state, 'degraded');
    assert.equal(r.reason, 'empty response');
  });

  it('reports a missing payload (timeout) as error', () => {
    const r = classifySource('Carriers', undefined, { status: 'error', ms: 60001 }, { name: 'Carriers', error: 'Source Carriers timed out after 60s' });
    assert.equal(r.state, 'error');
    assert.equal(r.reason, 'timed out');
  });
});

describe('helpers', () => {
  it('shortError never leaks the raw upstream message', () => {
    assert.equal(shortError('HTTP 429 Too Many Requests body=<html>secret</html>'), 'rate limited (429)');
    assert.equal(shortError('HTTP 403'), 'access denied (403)');
    assert.equal(shortError('HTTP 502 bad gateway'), 'upstream error (502)');
    assert.equal(shortError('getaddrinfo ENOTFOUND api.example.com'), 'unreachable');
    assert.equal(shortError('something with token=abc'), 'error');
  });

  it('envVarsFrom only matches credential-shaped identifiers', () => {
    assert.deepEqual(envVarsFrom('Set FIRMS_MAP_KEY for fire detection. Free at https://x'), ['FIRMS_MAP_KEY']);
    assert.deepEqual(envVarsFrom('HTTP 404 NOT_FOUND'), []);
  });

  it('isEmptyPayload ignores metadata-only keys', () => {
    assert.equal(isEmptyPayload({ source: 'A', timestamp: 't', items: [] }), true);
    assert.equal(isEmptyPayload({ source: 'A', items: [1] }), false);
    assert.equal(isEmptyPayload({ totalAlerts: 0, summary: { severe: 0 } }), false);
  });
});

describe('buildSourceHealth', () => {
  const raw = {
    crucix: { timestamp: '2026-09-05T00:00:00Z' },
    sources: {
      Safecast: { sites: [1] },
      ACLED: { status: 'no_credentials', message: 'Set ACLED_EMAIL + ACLED_API_KEY' },
      GDELT: { totalArticles: 0, allArticles: [] },
      SpiderFoot: { status: 'offline' },
    },
    timing: { Safecast: { status: 'ok', ms: 1 }, ACLED: { status: 'ok', ms: 1 }, GDELT: { status: 'ok', ms: 1 }, SpiderFoot: { status: 'ok', ms: 1 }, Carriers: { status: 'error', ms: 60000 } },
    errors: [{ name: 'Carriers', error: 'Source Carriers timed out after 60s' }],
  };

  it('counts every state and includes timed-out sources', () => {
    const h = buildSourceHealth(raw);
    assert.deepEqual(h.summary, { total: 5, live: 1, degraded: 1, no_key: 1, off: 1, error: 1, reporting: 2 });
    assert.equal(h.timestamp, '2026-09-05T00:00:00Z');
    assert.deepEqual(h.sources.map(s => s.name), ['Safecast', 'GDELT', 'ACLED', 'SpiderFoot', 'Carriers']);
  });

  it('summary counts sum to total across all STATES', () => {
    const h = buildSourceHealth(raw);
    assert.equal(STATES.reduce((n, s) => n + h.summary[s], 0), h.summary.total);
  });
});
