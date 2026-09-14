// lib/cyberfix/versions.mjs — semver-ish / PEP 440-ish comparison and OSV range evaluation (pure functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSemverish, compareSemverish, parsePep440, comparePep440, compareVersions, versionInRange, describeRange,
} from '../lib/cyberfix/versions.mjs';

const sorted = (cmp, list) => [...list].sort(cmp);

test('semver-ish', async (t) => {
  await t.test('parses numerics, v-prefix, pre-release, build metadata', () => {
    assert.deepEqual(parseSemverish('1.2.3'), { nums: [1, 2, 3], pre: null });
    assert.deepEqual(parseSemverish('v2.0'), { nums: [2, 0], pre: null });
    assert.deepEqual(parseSemverish('1.0.0-beta.1'), { nums: [1, 0, 0], pre: ['beta', 1] });
    assert.deepEqual(parseSemverish('1.0.0-rc1'), { nums: [1, 0, 0], pre: ['rc1'] });
    assert.deepEqual(parseSemverish('2.0-beta9'), { nums: [2, 0], pre: ['beta9'] });
    assert.deepEqual(parseSemverish('1.2.3+build.7'), { nums: [1, 2, 3], pre: null });
    assert.equal(parseSemverish('abc'), null);
    assert.equal(parseSemverish(''), null);
    assert.equal(parseSemverish(null), null);
    assert.equal(parseSemverish('1.2.3-'), null);
  });
  await t.test('orders releases numerically (not lexically) and pre-releases below releases', () => {
    assert.equal(compareSemverish('6.2.0', '6.2.4'), -1);
    assert.equal(compareSemverish('6.10.0', '6.9.9'), 1);
    assert.equal(compareSemverish('3.4.1', '3.5.0'), -1);
    assert.equal(compareSemverish('1.0', '1.0.0'), 0);
    assert.equal(compareSemverish('v1.0.0', '1.0.0'), 0);
    assert.equal(compareSemverish('1.0.0-alpha', '1.0.0'), -1);
    assert.equal(compareSemverish('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.equal(compareSemverish('1.0.0-beta.2', '1.0.0-beta.11'), -1);
    assert.equal(compareSemverish('1.0.0-rc.1', '1.0.0-beta.9'), 1);
    assert.equal(compareSemverish('1.0.0+a', '1.0.0+b'), 0);
    assert.equal(compareSemverish('2.14.1', '2.15.0'), -1);
    assert.equal(compareSemverish('x', '1'), null);
    assert.deepEqual(sorted(compareSemverish, ['1.10.0', '1.2.0', '1.2.0-rc.1', '0.9', '1.2.0-alpha']), ['0.9', '1.2.0-alpha', '1.2.0-rc.1', '1.2.0', '1.10.0']);
  });
});

test('PEP 440', async (t) => {
  await t.test('parses epoch, release, pre/post/dev segments and local labels', () => {
    assert.deepEqual(parsePep440('1.2.0'), { epoch: 0, release: [1, 2, 0], pre: null, post: null, dev: null });
    assert.deepEqual(parsePep440('1.0a1'), { epoch: 0, release: [1, 0], pre: [0, 1], post: null, dev: null });
    assert.deepEqual(parsePep440('1.0.rc2'), { epoch: 0, release: [1, 0], pre: [2, 2], post: null, dev: null });
    assert.deepEqual(parsePep440('2.1.post1'), { epoch: 0, release: [2, 1], pre: null, post: 1, dev: null });
    assert.deepEqual(parsePep440('2.1-3'), { epoch: 0, release: [2, 1], pre: null, post: 3, dev: null });
    assert.deepEqual(parsePep440('3.0.dev2'), { epoch: 0, release: [3, 0], pre: null, post: null, dev: 2 });
    assert.deepEqual(parsePep440('1!1.0'), { epoch: 1, release: [1, 0], pre: null, post: null, dev: null });
    assert.deepEqual(parsePep440('1.0+ubuntu.1'), { epoch: 0, release: [1, 0], pre: null, post: null, dev: null });
    assert.equal(parsePep440('1.0-beta.1.x'), null);
    assert.equal(parsePep440('latest'), null);
  });
  await t.test('orders per PEP 440: dev < pre < final < post, epoch dominates', () => {
    assert.equal(comparePep440('1.2.0', '1.3.0'), -1);
    assert.equal(comparePep440('1.3', '1.3.0'), 0);
    assert.equal(comparePep440('1.0a1', '1.0b1'), -1);
    assert.equal(comparePep440('1.0b1', '1.0rc1'), -1);
    assert.equal(comparePep440('1.0rc1', '1.0'), -1);
    assert.equal(comparePep440('1.0', '1.0.post1'), -1);
    assert.equal(comparePep440('1.0.dev1', '1.0a1'), -1);
    assert.equal(comparePep440('1.0a1.dev1', '1.0a1'), -1);
    assert.equal(comparePep440('1.0.post1.dev1', '1.0.post1'), -1);
    assert.equal(comparePep440('1!0.1', '2.0'), 1);
    assert.equal(comparePep440('1.0+local', '1.0'), 0);
    assert.equal(comparePep440('2.31.0', '2.32.0'), -1);
    assert.deepEqual(sorted(comparePep440, ['1.0', '1.0.post1', '1.0rc1', '1.0.dev3', '1.0a2', '0.9.9']), ['0.9.9', '1.0.dev3', '1.0a2', '1.0rc1', '1.0', '1.0.post1']);
  });
  await t.test('compareVersions picks the comparator by ecosystem with fallback', () => {
    assert.equal(compareVersions('1.0a1', '1.0', 'PyPI'), -1);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0', 'npm'), -1);
    assert.equal(compareVersions('1!1.0', '2.0', 'npm'), 1, 'PEP 440 fallback when semver-ish cannot parse');
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0', 'PyPI'), -1, 'semver-ish fallback when PEP 440 cannot parse');
    assert.equal(compareVersions('2.0-beta9', '2.0', 'Maven'), -1);
    assert.equal(compareVersions('nope', '1.0', 'npm'), null);
  });
});

test('OSV range evaluation', async (t) => {
  const eco = (events) => ({ type: 'ECOSYSTEM', events });

  await t.test('introduced/fixed events: inside → affected with the enclosing pair', () => {
    const r = eco([{ introduced: '6.2.0' }, { fixed: '6.2.4' }]);
    assert.deepEqual(versionInRange('6.2.0', r, 'npm'), { affected: true, introduced: '6.2.0', fixed: '6.2.4', lastAffected: null });
    assert.deepEqual(versionInRange('6.2.3', r, 'npm'), { affected: true, introduced: '6.2.0', fixed: '6.2.4', lastAffected: null });
    assert.equal(versionInRange('6.2.4', r, 'npm').affected, false, 'fixed bound is exclusive');
    assert.equal(versionInRange('6.1.9', r, 'npm').affected, false, 'below introduced');
    assert.equal(versionInRange('7.0.0', r, 'npm').affected, false);
  });
  await t.test('introduced "0" means every version below fixed', () => {
    const r = eco([{ introduced: '0' }, { fixed: '4.5.11' }]);
    assert.equal(versionInRange('0.0.1', r, 'npm').affected, true);
    assert.equal(versionInRange('4.5.10', r, 'npm').affected, true);
    assert.equal(versionInRange('4.5.11', r, 'npm').affected, false);
    assert.equal(describeRange(versionInRange('1.0.0', r, 'npm')), '< 4.5.11');
  });
  await t.test('introduced without fixed → open-ended, "all versions" description', () => {
    const r = eco([{ introduced: '0' }]);
    const res = versionInRange('99.0.0', r, 'npm');
    assert.equal(res.affected, true);
    assert.equal(describeRange(res), 'all versions');
    assert.equal(describeRange(versionInRange('3.0', eco([{ introduced: '2.0' }]), 'npm')), '>= 2.0');
  });
  await t.test('last_affected is inclusive', () => {
    const r = eco([{ introduced: '1.0' }, { last_affected: '1.2.1.2-jre17' }]);
    assert.deepEqual(versionInRange('1.2.1.2-jre17', r, 'Maven'), { affected: true, introduced: '1.0', fixed: null, lastAffected: '1.2.1.2-jre17' });
    assert.equal(versionInRange('1.2.1.3', r, 'Maven').affected, false);
    assert.equal(describeRange(versionInRange('1.1', r, 'Maven')), '>= 1.0, <= 1.2.1.2-jre17');
  });
  await t.test('multiple introduced/fixed pairs in one range (log4j-core style)', () => {
    const r = eco([{ introduced: '2.0-beta9' }, { fixed: '2.3.1' }, { introduced: '2.4' }, { fixed: '2.12.2' }, { introduced: '2.13.0' }, { fixed: '2.15.0' }]);
    assert.equal(versionInRange('2.14.1', r, 'Maven').affected, true);
    assert.equal(versionInRange('2.14.1', r, 'Maven').fixed, '2.15.0');
    assert.equal(versionInRange('2.12.2', r, 'Maven').affected, false, 'in the gap between pairs');
    assert.equal(versionInRange('2.3.1', r, 'Maven').affected, false);
    assert.equal(versionInRange('2.0-beta9', r, 'Maven').affected, true);
    assert.equal(versionInRange('2.15.0', r, 'Maven').affected, false);
    assert.equal(versionInRange('2.17.1', r, 'Maven').affected, false);
  });
  await t.test('PEP 440 pins against PyPI ranges', () => {
    const r = eco([{ introduced: '0' }, { fixed: '1.3.0' }]);
    assert.equal(versionInRange('1.2.0', r, 'PyPI').affected, true);
    assert.equal(versionInRange('1.3.0rc1', r, 'PyPI').affected, true, 'rc sorts below the fix');
    assert.equal(versionInRange('1.3.0', r, 'PyPI').affected, false);
    assert.equal(versionInRange('1.3.0.post1', r, 'PyPI').affected, false);
    assert.equal(versionInRange('1!0.1', r, 'PyPI').affected, false, 'epoch beats release');
  });
  await t.test('GIT ranges and uncomparable versions are indeterminate (null), not false', () => {
    assert.deepEqual(versionInRange('6.2.0', { type: 'GIT', repo: 'x', events: [{ introduced: '0' }, { fixed: 'abc123' }] }, 'npm'), { affected: null });
    assert.equal(versionInRange('weird-build', eco([{ introduced: '1.0' }, { fixed: '2.0' }]), 'npm').affected, null);
    assert.equal(versionInRange('1.5', eco([{ introduced: '1.0' }, { fixed: 'not-a-version' }]), 'npm').affected, null);
    assert.deepEqual(versionInRange('1.0', null, 'npm'), { affected: null });
    assert.deepEqual(versionInRange('1.0', { events: 'nope' }, 'npm'), { affected: null });
    assert.equal(versionInRange('1.0', eco([null, 'x', { introduced: '0' }]), 'npm').affected, true, 'junk events skipped');
  });
  await t.test('describeRange', () => {
    assert.equal(describeRange({ introduced: '6.2.0', fixed: '6.2.4' }), '>= 6.2.0, < 6.2.4');
    assert.equal(describeRange({ introduced: '0', fixed: '3.5.0' }), '< 3.5.0');
    assert.equal(describeRange({ introduced: '0' }), 'all versions');
    assert.equal(describeRange(null), null);
  });
});
