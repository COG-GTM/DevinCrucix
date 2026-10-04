// IODA alert normalisation — unit tests (no network)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlert, summarizeAlerts } from '../apis/sources/ioda.mjs';

const country = (code, name, over = {}) => ({ datasource: 'bgp', entity: { code, name, type: 'country' }, time: 1791000000, level: 'critical', condition: '< 0.5', value: 100, historyValue: 400, method: 'median', ...over });
const region = (cc, cn, rname, over = {}) => ({ datasource: 'ping-slash24', entity: { code: '297', name: rname, type: 'region', attrs: { country_code: cc, country_name: cn } }, time: 1791000600, level: 'normal', value: 371, historyValue: 372, ...over });

describe('normalizeAlert', () => {
  it('maps a country alert with the drop vs baseline', () => {
    const a = normalizeAlert(country('HT', 'Haiti'));
    assert.equal(a.type, 'country');
    assert.equal(a.countryCode, 'HT');
    assert.equal(a.level, 'critical');
    assert.equal(a.dropPct, 75);
    assert.equal(a.time, '2026-10-03T04:00:00.000Z');
  });
  it('maps a region alert to its parent country and rejects unknown entity types', () => {
    const r = normalizeAlert(region('BJ', 'Benin', 'Atlantique'));
    assert.equal(r.countryCode, 'BJ');
    assert.equal(r.entityName, 'Atlantique');
    assert.equal(r.level, 'normal');
    assert.equal(normalizeAlert({ entity: { type: 'asn', code: '3356' }, time: 1 }), null);
    assert.equal(normalizeAlert({ entity: { type: 'country', code: 'ZZZ' }, time: 1 }), null);
  });
});

describe('summarizeAlerts', () => {
  it('groups by country, counts critical alerts and grades severity', () => {
    const s = summarizeAlerts([
      country('HT', 'Haiti'), country('HT', 'Haiti', { datasource: 'ping-slash24', time: 1791003600 }),
      region('BJ', 'Benin', 'Atlantique'), region('BJ', 'Benin', 'Littoral', { level: 'critical', value: 10, historyValue: 100 }),
      region('VE', 'Venezuela', 'Zulia', { level: 'critical', value: 90, historyValue: 100 }),
    ]);
    assert.equal(s.alertCount, 5);
    assert.equal(s.criticalCount, 4);
    assert.equal(s.countries[0].code, 'HT');
    assert.equal(s.countries[0].severity, 'critical');
    assert.deepEqual(s.countries[0].datasources.sort(), ['bgp', 'ping-slash24']);
    const bj = s.countries.find(c => c.code === 'BJ');
    assert.equal(bj.severity, 'critical', 'regional critical with a >=50% drop is critical');
    assert.deepEqual(bj.regions.sort(), ['Atlantique', 'Littoral']);
    const ve = s.countries.find(c => c.code === 'VE');
    assert.equal(ve.severity, 'warning', 'regional critical with a small drop is a warning');
  });
  it('is empty-safe', () => {
    const s = summarizeAlerts(null);
    assert.equal(s.alertCount, 0);
    assert.deepEqual(s.countries, []);
  });
});
