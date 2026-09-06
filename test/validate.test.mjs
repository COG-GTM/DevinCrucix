// lib/validate.mjs — whitelist request validation helpers + Express glue (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ValidationError, str, num, bool, oneOf, strArray, bounded,
  validateQuery, validateBody, validateParams,
} from '../lib/validate.mjs';
import { TARGET_HINTS } from '../apis/sources/investigate.mjs';
import { TELEGRAM_CHANNEL_RE, MAX_CHANNELS, setTelegramChannels, getTelegramChannels } from '../apis/sources/telegramlive.mjs';

const rejects = (fn, reason) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.constructor?.name}`);
    assert.equal(err.message, 'invalid request');
    if (reason) assert.equal(err.reason, reason);
    return true;
  });
};

test('str', async (t) => {
  await t.test('accepts and trims bounded strings', () => {
    assert.equal(str('  hello '), 'hello');
    assert.equal(str('x', { trim: false }), 'x');
    assert.equal(str(undefined), undefined);
    assert.equal(str(''), undefined);
    assert.equal(str(null), undefined);
  });
  await t.test('defaults to max 255', () => {
    assert.equal(str('a'.repeat(255)).length, 255);
    rejects(() => str('a'.repeat(256)), 'max');
  });
  await t.test('rejects non-strings (array-valued query params), short values, pattern misses', () => {
    rejects(() => str(['a', 'b']), 'type');
    rejects(() => str(42), 'type');
    rejects(() => str({}), 'type');
    rejects(() => str('ab', { min: 3 }), 'min');
    rejects(() => str('a b', { pattern: /^[a-z]+$/ }), 'pattern');
    assert.equal(str('abc', { pattern: /^[a-z]+$/ }), 'abc');
  });
  await t.test('required', () => {
    rejects(() => str(undefined, { required: true }), 'required');
    rejects(() => str('   ', { required: true }), 'min');
  });
});

test('num', async (t) => {
  await t.test('accepts numbers and plain decimal strings', () => {
    assert.equal(num(5), 5);
    assert.equal(num('5'), 5);
    assert.equal(num(' -12.5 '), -12.5);
    assert.equal(num(undefined), undefined);
  });
  await t.test('rejects garbage, exponents, hex, Infinity, NaN', () => {
    rejects(() => num('abc'), 'type');
    rejects(() => num('1e5'), 'type');
    rejects(() => num('0x10'), 'type');
    rejects(() => num('Infinity'), 'type');
    rejects(() => num(NaN), 'type');
    rejects(() => num(Infinity), 'type');
    rejects(() => num(['1']), 'type');
    rejects(() => num({}), 'type');
  });
  await t.test('range and int', () => {
    assert.equal(num('10', { min: 1, max: 10 }), 10);
    rejects(() => num('11', { min: 1, max: 10 }), 'range');
    rejects(() => num('0', { min: 1 }), 'range');
    rejects(() => num('1.5', { int: true }), 'int');
    assert.equal(num('7', { int: true }), 7);
    rejects(() => num(undefined, { required: true }), 'required');
  });
});

test('bool', () => {
  assert.equal(bool('true'), true);
  assert.equal(bool('1'), true);
  assert.equal(bool(false), false);
  assert.equal(bool('0'), false);
  assert.equal(bool(undefined), undefined);
  rejects(() => bool('yes'), 'type');
  rejects(() => bool(undefined, { required: true }), 'required');
});

test('oneOf', () => {
  assert.equal(oneOf('a', ['a', 'b']), 'a');
  assert.equal(oneOf('b', new Set(['a', 'b'])), 'b');
  assert.equal(oneOf('k', new Map([['k', 1]])), 'k');
  assert.equal(oneOf(undefined, ['a']), undefined);
  rejects(() => oneOf('c', ['a', 'b']), 'enum');
  rejects(() => oneOf('A', ['a']), 'enum');
  rejects(() => oneOf(['a'], ['a']), 'type');
  rejects(() => oneOf('constructor', {}), 'enum');
  rejects(() => oneOf(undefined, ['a'], { required: true }), 'required');
});

test('strArray', () => {
  assert.deepEqual(strArray([' a ', 'b']), ['a', 'b']);
  assert.equal(strArray(undefined), undefined);
  rejects(() => strArray('a'), 'type');
  rejects(() => strArray([]), 'min');
  rejects(() => strArray(['a', 'b', 'c'], { max: 2 }), 'max');
  rejects(() => strArray(['a', 1]), 'type');
  rejects(() => strArray(['a', '']), 'required');
  rejects(() => strArray(['a', '  ']), 'min');
  rejects(() => strArray(['abcd'], { itemMax: 3 }), 'max');
  rejects(() => strArray(['a-b'], { pattern: /^[a-z]+$/ }), 'pattern');
  rejects(() => strArray(undefined, { required: true }), 'required');
});

test('bounded', () => {
  assert.equal(bounded('1', 500), 1);
  assert.equal(bounded('500', 500), 500);
  assert.equal(bounded(undefined, 500), undefined);
  rejects(() => bounded('0', 500), 'range');
  rejects(() => bounded('501', 500), 'range');
  rejects(() => bounded('-1', 500), 'range');
  rejects(() => bounded('2.5', 500), 'int');
  rejects(() => bounded('10', 500, { min: 20 }), 'range');
});

test('investigate selector whitelist (TARGET_HINTS)', () => {
  assert.ok(TARGET_HINTS instanceof Set);
  assert.ok(TARGET_HINTS.has('auto'));
  for (const hint of TARGET_HINTS) assert.equal(oneOf(hint, TARGET_HINTS), hint);
  rejects(() => oneOf('banana', TARGET_HINTS), 'enum');
  rejects(() => oneOf('ip', TARGET_HINTS), 'enum');           // resolved type, not a caller-selectable hint
  rejects(() => oneOf('DOMAIN', TARGET_HINTS), 'enum');
  assert.equal(oneOf(undefined, TARGET_HINTS), undefined);   // omitted → route defaults to 'auto'
});

test('telegram channel rule', async (t) => {
  const channelList = (v) => strArray(v, { min: 1, max: MAX_CHANNELS, itemMin: 5, itemMax: 32, pattern: TELEGRAM_CHANNEL_RE, required: true });

  await t.test('regex: 5–32 letters, digits, underscores', () => {
    for (const ok of ['abcde', 'Ab_12', 'a'.repeat(32), 'Reuters', 'bbc_news_2024']) assert.ok(TELEGRAM_CHANNEL_RE.test(ok), ok);
    for (const bad of ['abcd', 'a'.repeat(33), 'bbc-news', '@reuters', 'has space', 'ünïcode', '', 'a/b', 'a.b']) assert.ok(!TELEGRAM_CHANNEL_RE.test(bad), bad);
  });
  await t.test('strArray composes count + item rules', () => {
    assert.deepEqual(channelList(['reuters', ' bbcnews ']), ['reuters', 'bbcnews']);
    rejects(() => channelList([]), 'min');
    rejects(() => channelList(Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => `chan${i}`)), 'max');
    rejects(() => channelList(['bbc-news']), 'pattern');
    rejects(() => channelList(['abcd']), 'min');
    rejects(() => channelList(['a'.repeat(33)]), 'max');
    rejects(() => channelList('reuters'), 'type');
    rejects(() => channelList(undefined), 'required');
  });
  await t.test('setTelegramChannels() enforces the same rule for non-HTTP callers', () => {
    assert.ok(setTelegramChannels([]).error);
    assert.ok(setTelegramChannels('reuters').error);
    assert.ok(setTelegramChannels(['bbc-news']).error);
    assert.ok(setTelegramChannels(['abcd']).error);
    assert.ok(setTelegramChannels([42]).error);
    assert.ok(setTelegramChannels(Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => `chan${i}`)).error);
    const before = getTelegramChannels();
    try {
      const ok = setTelegramChannels([' reuters ', 'bbcnews']);
      assert.equal(ok.error, undefined);
      assert.deepEqual(ok.channels, ['reuters', 'bbcnews']);
    } finally {
      if (Array.isArray(before) && before.length) setTelegramChannels(before);
    }
  });
});

test('lat/lon bounds', () => {
  const lat = (v) => num(v, { min: -90, max: 90, required: true });
  const lon = (v) => num(v, { min: -180, max: 180 });
  assert.equal(lat('-90'), -90);
  assert.equal(lat('90'), 90);
  assert.equal(lat('48.8566'), 48.8566);
  rejects(() => lat('90.0001'), 'range');
  rejects(() => lat('-91'), 'range');
  rejects(() => lat('north'), 'type');
  rejects(() => lat(undefined), 'required');
  assert.equal(lon('-180'), -180);
  assert.equal(lon('180'), 180);
  rejects(() => lon('180.5'), 'range');
  rejects(() => lon('-181'), 'range');
  assert.equal(lon(undefined), undefined);
});

// ─── Express glue ───────────────────────────────────────────────────────────

function fakeReq(source, input) {
  return { [source]: input, ip: '127.0.0.1', method: 'GET', path: '/test' };
}
function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function run(mw, req) {
  const res = fakeRes();
  let nextArg = null, called = false;
  mw(req, res, (err) => { called = true; nextArg = err; });
  return { res, nextCalled: called, nextArg };
}

test('validateQuery / validateBody / validateParams', async (t) => {
  const origLog = console.log;
  const logs = [];
  t.before(() => { console.log = (line) => logs.push(line); });
  t.after(() => { console.log = origLog; });

  await t.test('collects normalized values on req.validated[source] and calls next()', () => {
    const mw = validateQuery({ limit: (v) => bounded(v, 100), q: (v) => str(v, { max: 10 }) });
    const req = fakeReq('query', { limit: '5', q: ' hi ', extra: 'ignored' });
    const { nextCalled, nextArg } = run(mw, req);
    assert.equal(nextCalled, true);
    assert.equal(nextArg, undefined);
    assert.deepEqual(req.validated.query, { limit: 5, q: 'hi' });
  });

  await t.test('responds 400 with the field name and never echoes the value', () => {
    logs.length = 0;
    const mw = validateBody({ channels: (v) => strArray(v, { pattern: /^[a-z]+$/ }) });
    const req = fakeReq('body', { channels: ['SECRET_VALUE_123'] });
    const { res, nextCalled } = run(mw, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'invalid request', field: 'channels' });
    assert.ok(!JSON.stringify(res.body).includes('SECRET_VALUE_123'));
    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]);
    assert.equal(entry.event, 'validation_failure');
    assert.equal(entry.field, 'channels');
    assert.equal(entry.reason, 'pattern');
    assert.ok(!logs[0].includes('SECRET_VALUE_123'));
  });

  await t.test('tolerates missing / non-object input and required fields fail', () => {
    const mw = validateBody({ name: (v) => str(v, { required: true }) });
    const { res } = run(mw, fakeReq('body', undefined));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'invalid request', field: 'name' });
    const { res: res2 } = run(mw, fakeReq('body', 'not an object'));
    assert.equal(res2.statusCode, 400);
  });

  await t.test('validateParams and stacking sources', () => {
    const p = validateParams({ code: (v) => str(v, { pattern: /^[A-Z]{2}$/, required: true }) });
    const q = validateQuery({ language: (v) => str(v, { max: 8 }) });
    const req = { params: { code: 'US' }, query: { language: 'en' }, ip: '::1', method: 'GET', path: '/x' };
    run(p, req);
    run(q, req);
    assert.deepEqual(req.validated, { params: { code: 'US' }, query: { language: 'en' } });
    const { res } = run(p, { params: { code: 'usa' }, ip: '::1', method: 'GET', path: '/x' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.field, 'code');
  });

  await t.test('non-validation exceptions are forwarded to next(err)', () => {
    const boom = new Error('boom');
    const mw = validateQuery({ x: () => { throw boom; } });
    const { nextCalled, nextArg, res } = run(mw, fakeReq('query', { x: '1' }));
    assert.equal(nextCalled, true);
    assert.equal(nextArg, boom);
    assert.equal(res.statusCode, 200);
  });
});
