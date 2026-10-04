// ransomware.live normalisation — unit tests (no network)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVictim, summarizeVictims, indexGroups, dedupeVictims, monthsForWindow } from '../apis/sources/ransomware.mjs';

const NOW = Date.parse('2026-10-04T00:00:00Z');
const v = (over = {}) => ({ victim: 'Acme Corp', domain: 'acme.example', group: 'Qilin', activity: 'Healthcare', country: 'us', discovered: '2026-10-03 12:00:00.000000', url: `https://www.ransomware.live/id/${over.victim || 'acme'}`, ...over });

describe('normalizeVictim', () => {
  it('lower-cases the group, upper-cases ISO-2 country and computes age', () => {
    const n = normalizeVictim(v(), NOW);
    assert.equal(n.group, 'qilin');
    assert.equal(n.country, 'US');
    assert.equal(n.sector, 'Healthcare');
    assert.equal(n.ageHours, 12);
    assert.equal(n.discovered, '2026-10-03T12:00:00.000Z');
  });
  it('drops unparseable dates and non ISO-2 countries, keeps only http(s) urls', () => {
    assert.equal(normalizeVictim(v({ discovered: 'yesterday', attackdate: null }), NOW), null);
    assert.equal(normalizeVictim(v({ country: 'United States' }), NOW).country, null);
    assert.equal(normalizeVictim(v({ url: 'javascript:alert(1)' }), NOW).url, null);
  });
});

describe('summarizeVictims', () => {
  const list = [
    v(), v({ victim: 'B', group: 'qilin', activity: 'Manufacturing', country: 'DE', discovered: '2026-10-03 20:00:00' }),
    v({ victim: 'C', group: 'Akira', activity: 'Healthcare', country: 'US', discovered: '2026-09-30 00:00:00' }),
    v({ victim: 'Old', group: 'lockbit3', discovered: '2026-09-20 00:00:00', url: 'https://x/old' }),
  ];
  it('keeps only the 7-day window and tallies group / sector / country', () => {
    const s = summarizeVictims(list, { now: NOW });
    assert.equal(s.total, 3);
    assert.equal(s.last24h, 2);
    assert.deepEqual(s.groups.map(g => [g.name, g.count]), [['qilin', 2], ['akira', 1]]);
    assert.deepEqual(s.sectors[0], { name: 'Healthcare', count: 2 });
    assert.deepEqual(s.countries[0], { code: 'US', count: 2 });
    assert.equal(s.victims[0].victim, 'B', 'newest first');
    assert.equal(s.feedCovered, true, 'oldest post is older than the window');
  });
  it('attaches group metadata when provided', () => {
    const groups = indexGroups([{ name: 'Qilin', description: 'RaaS', added_date: '2022-10-01', tools: [{ Exfil: ['rclone', 'MEGAsync'] }, 'Mimikatz'], ttps: [{ tactic_name: 'Initial Access', techniques: [{ technique_id: 'T1078', technique_name: 'Valid Accounts' }] }] }]);
    const s = summarizeVictims(list, { now: NOW, groupsByName: groups });
    assert.deepEqual(s.groups[0].tools, ['rclone', 'MEGAsync', 'Mimikatz']);
    assert.deepEqual(s.groups[0].ttps, ['T1078 Valid Accounts']);
    assert.equal(s.groups[0].description, 'RaaS');
    assert.deepEqual(s.groups[1].tools, []);
  });
  it('dedupes the same post seen in the recent feed and the month archive', () => {
    const a = normalizeVictim(v(), NOW), b = normalizeVictim(v(), NOW);
    assert.equal(dedupeVictims([a, b]).length, 1);
    assert.equal(summarizeVictims([v(), v()], { now: NOW }).total, 1);
  });
});

describe('monthsForWindow', () => {
  it('returns the current month, plus the previous one when the window crosses it', () => {
    assert.deepEqual(monthsForWindow(NOW), [[2026, 10], [2026, 9]]);
    assert.deepEqual(monthsForWindow(Date.parse('2026-10-20T00:00:00Z')), [[2026, 10]]);
  });
});
