import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orbitFromElements } from '../apis/sources/space.mjs';

// CelesTrak GP (OMM) JSON has no PERIOD / APOAPSIS / PERIAPSIS fields; they are derived from
// MEAN_MOTION + ECCENTRICITY.
describe('space: orbit from OMM elements', () => {
  it('derives ISS period and altitude from mean motion and eccentricity', () => {
    const iss = orbitFromElements({ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, MEAN_MOTION: 15.49018229, ECCENTRICITY: 0.00049836 });
    assert.ok(Math.abs(iss.period - 92.96) < 0.1, `period ${iss.period}`);
    assert.ok(iss.perigee > 400 && iss.perigee < 430, `perigee ${iss.perigee}`);
    assert.ok(iss.apogee > iss.perigee && iss.apogee < 440, `apogee ${iss.apogee}`);
  });

  it('returns nulls (never NaN) when the elements are missing or invalid', () => {
    for (const sat of [{}, { MEAN_MOTION: 0, ECCENTRICITY: 0 }, { MEAN_MOTION: 'x', ECCENTRICITY: 0.1 }, { MEAN_MOTION: 15, ECCENTRICITY: 1 }]) {
      assert.deepEqual(orbitFromElements(sat), { period: null, apogee: null, perigee: null });
    }
  });
});
