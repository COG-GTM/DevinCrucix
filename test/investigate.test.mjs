// Investigate pivot + typosquat — unit tests (no network)
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTarget, keyedSourceStatus } from '../apis/sources/investigate.mjs';
import { generatePermutations, getWatchlist } from '../apis/sources/typosquat.mjs';

describe('classifyTarget', () => {
  it('classifies and normalizes domains', () => {
    assert.deepEqual(classifyTarget('Example.COM'), { type: 'domain', value: 'example.com' });
    assert.deepEqual(classifyTarget('https://www.example.com/'), { type: 'domain', value: 'example.com' });
    assert.deepEqual(classifyTarget('https://www.example.com/path?q=1', 'domain'), { type: 'domain', value: 'example.com' });
    assert.deepEqual(classifyTarget('sub.example.co.uk'), { type: 'domain', value: 'sub.example.co.uk' });
  });

  it('classifies URLs with a path or query as url selectors', () => {
    assert.deepEqual(classifyTarget('https://www.example.com/path?q=1'), { type: 'url', value: 'https://www.example.com/path?q=1' });
    assert.equal(classifyTarget('https://1.2.3.4/').type, 'ip');
  });

  it('classifies emails, @handles, phones and wallets', () => {
    assert.deepEqual(classifyTarget('Alice@Example.com'), { type: 'email', value: 'alice@example.com' });
    assert.deepEqual(classifyTarget('@torvalds'), { type: 'username', value: 'torvalds' });
    assert.equal(classifyTarget('torvalds'), null);
    assert.deepEqual(classifyTarget('torvalds', 'username'), { type: 'username', value: 'torvalds' });
    assert.equal(classifyTarget('+1 202 555 0143').type, 'phone');
    assert.equal(classifyTarget('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').type, 'btc');
    assert.equal(classifyTarget('0xdAC17F958D2ee523a2206206994597C13D831ec7').type, 'eth');
  });

  it('classifies IPv4 and IPv6', () => {
    assert.deepEqual(classifyTarget('8.8.8.8'), { type: 'ip', value: '8.8.8.8' });
    assert.deepEqual(classifyTarget('2606:4700::1111'), { type: 'ip', value: '2606:4700::1111' });
  });

  it('classifies MD5/SHA1/SHA256 hashes', () => {
    assert.equal(classifyTarget('d41d8cd98f00b204e9800998ecf8427e').type, 'hash');
    assert.equal(classifyTarget('da39a3ee5e6b4b0d3255bfef95601890afd80709').type, 'hash');
    assert.equal(classifyTarget('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855').value.length, 64);
  });

  it('accepts company names only with the explicit hint', () => {
    assert.equal(classifyTarget('Lockheed Martin'), null);
    assert.deepEqual(classifyTarget('Lockheed Martin', 'company'), { type: 'company', value: 'Lockheed Martin' });
    assert.equal(classifyTarget('<script>alert(1)</script>', 'company'), null);
    assert.equal(classifyTarget('a'.repeat(81), 'company'), null);
  });

  it('rejects malformed or oversized input', () => {
    assert.equal(classifyTarget(''), null);
    assert.equal(classifyTarget('not a target!!'), null);
    assert.equal(classifyTarget('localhost'), null);
    assert.equal(classifyTarget('a'.repeat(300) + '.com'), null);
    assert.equal(classifyTarget('-bad.com'), null);
    assert.equal(classifyTarget(null), null);
  });
});

describe('keyedSourceStatus', () => {
  it('reports each keyed provider as a boolean', () => {
    const s = keyedSourceStatus();
    assert.deepEqual(Object.keys(s).sort(), ['github', 'hibp', 'numverify', 'opencorporates', 'opensanctions', 'shodan', 'virustotal']);
    for (const v of Object.values(s)) assert.equal(typeof v, 'boolean');
  });
});

describe('generatePermutations', () => {
  it('produces bounded, unique, valid look-alikes that exclude the original', () => {
    const perms = generatePermutations('example.com');
    assert.ok(perms.length > 20 && perms.length <= 150, `got ${perms.length}`);
    const domains = perms.map(p => p.domain);
    assert.equal(new Set(domains).size, domains.length);
    assert.ok(!domains.includes('example.com'));
    for (const p of perms) {
      assert.match(p.domain, /^[a-z0-9.-]+\.[a-z]{2,}$/);
      assert.equal(typeof p.technique, 'string');
    }
  });

  it('covers the core DNS-Twist technique families', () => {
    const techniques = new Set(generatePermutations('treasury.gov').map(p => p.technique));
    for (const t of ['tld-swap', 'homoglyph', 'omission', 'transposition', 'hyphenation', 'addition']) {
      assert.ok(techniques.has(t), `missing ${t}`);
    }
  });

  it('respects the cap', () => {
    assert.ok(generatePermutations('example.com', 10).length <= 10);
  });
});

describe('getWatchlist', () => {
  it('returns lowercase valid domains', () => {
    for (const d of getWatchlist()) assert.match(d, /^[a-z0-9.-]+\.[a-z]{2,}$/);
  });
});
