// Photo geolocation (vision-model pivot) — validator, availability and provider wrapper; no network, no real model.
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGazetteer } from '../lib/narco/gazetteer.mjs';
import { LLMProvider } from '../lib/llm/provider.mjs';
import {
  validatePhotoGeoloc, photoGeolocAvailability, geolocatePhoto, buildPhotoPrompt, sanitizeHint,
  MIN_RADIUS_KM, MAX_RADIUS_KM, VISION_MAX_BYTES,
} from '../lib/geoloc/photo.mjs';

const gz = loadGazetteer();

class FakeVision extends LLMProvider {
  constructor(answer, { configured = true, vision = true, fail = false } = {}) {
    super({ apiKey: configured ? 'k' : '', model: 'fake-v' });
    this.name = 'fake'; this.model = 'fake-v'; this.answer = answer; this.configured = configured; this.vision = vision; this.fail = fail; this.calls = [];
  }
  get isConfigured() { return this.configured; }
  get supportsVision() { return this.vision; }
  async completeVision(sys, user, image, opts) {
    this.calls.push({ sys, user, image, opts });
    if (this.fail) throw new Error('boom 401 secret-key-abc');
    return { text: typeof this.answer === 'string' ? this.answer : JSON.stringify(this.answer), model: 'fake-v', usage: {} };
  }
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

describe('validatePhotoGeoloc', () => {
  it('rejects non-objects and explicit no-estimate answers', () => {
    assert.equal(validatePhotoGeoloc(null, { gz }), null);
    assert.equal(validatePhotoGeoloc('Culiacán', { gz }), null);
    assert.equal(validatePhotoGeoloc([1, 2], { gz }), null);
    assert.equal(validatePhotoGeoloc({ noEstimate: true, lat: 24.8, lon: -107.4 }, { gz }), null);
    assert.equal(validatePhotoGeoloc({ country: 'MX', state: 'Sinaloa' }, { gz })?.lat, gz.stateKey.get('sinaloa').lat, 'state-only answer anchors on the state centroid');
    assert.equal(validatePhotoGeoloc({ country: 'US', clues: ['a sign'] }, { gz }), null, 'no coordinates and no MX anchor -> nothing to assert');
  });

  it('snaps a Mexico answer to the gazetteer and keeps the model radius when consistent', () => {
    const v = validatePhotoGeoloc({ country: 'mx', state: 'Sinaloa', city: 'Culiacán', lat: 24.81, lon: -107.39, radiusKm: 12, confidence: 'medium', clues: ['Sinaloa plate format -> Sinaloa', '<b>x</b>'] }, { gz });
    assert.equal(v.country, 'MX');
    assert.equal(v.state, 'Sinaloa');
    assert.equal(v.city, 'Culiacán');
    assert.equal(v.snapped, true);
    assert.equal(v.radiusKm, 12);
    assert.equal(v.precision, 'city');
    assert.equal(v.confidence, 'medium');
    assert.equal(v.conflict, null);
    assert.ok(v.clues.every(c => !/[<>]/.test(c)), 'clues are stripped of markup');
    assert.ok(Math.abs(v.lat - 24.81) < 0.05 && Math.abs(v.lon + 107.39) < 0.05, 'model coordinates kept when inside the place radius');
  });

  it('flags an internally inconsistent answer instead of silently widening to a continent', () => {
    const v = validatePhotoGeoloc({ country: 'MX', city: 'Culiacán', lat: 19.4, lon: -99.1, radiusKm: 10, confidence: 'high' }, { gz });
    assert.equal(v.city, 'Culiacán');
    assert.match(v.conflict, /\d+ km from Culiacán/);
    assert.equal(v.confidence, 'low', 'confidence demoted on conflict');
    assert.equal(v.radiusKm, 10, 'radius is not inflated to cover the stray coordinates');
    assert.ok(Math.abs(v.lat - 24.8) < 0.2, 'named place wins');
  });

  it('drops unknown Mexican places but keeps a bare coordinate estimate', () => {
    const v = validatePhotoGeoloc({ country: 'MX', state: 'Narnia', city: 'Mordor', lat: 25.6, lon: -100.3, radiusKm: 40, confidence: 'low' }, { gz });
    assert.equal(v.state, null);
    assert.equal(v.city, null);
    assert.equal(v.snapped, false);
    assert.equal(v.radiusKm, 40);
    assert.equal(v.precision, 'region');
  });

  it('infers MX from coordinates, bounds radius and confidence, and defaults radius from confidence', () => {
    const v = validatePhotoGeoloc({ lat: 32.5, lon: -117.0, radiusKm: 0.001, confidence: 'certain' }, { gz });
    assert.equal(v.country, 'MX');
    assert.equal(v.radiusKm, MIN_RADIUS_KM);
    assert.equal(v.confidence, 'low', 'unknown confidence label falls back to low');
    assert.equal(validatePhotoGeoloc({ country: 'US', lat: 40, lon: -74, radiusKm: 20000 }, { gz }).radiusKm, MAX_RADIUS_KM);
    assert.equal(validatePhotoGeoloc({ country: 'US', lat: 40, lon: -74, radiusKm: 1e9, confidence: 'medium' }, { gz }).radiusKm, 100, 'absurd radius is ignored, confidence default applies');
    assert.equal(validatePhotoGeoloc({ country: 'US', lat: 40, lon: -74, confidence: 'high' }, { gz }).radiusKm, 25);
    assert.equal(validatePhotoGeoloc({ country: 'US', lat: 40, lon: -74, confidence: 'low' }, { gz }).radiusKm, 500);
    assert.equal(validatePhotoGeoloc({ country: 'US', lat: 'x', lon: -74 }, { gz }), null);
    assert.equal(validatePhotoGeoloc({ country: 'US', lat: 0, lon: 0 }, { gz }), null, 'null island is not an estimate');
  });
});

describe('photoGeolocAvailability / prompt / hint', () => {
  it('reports honest no-model / no-key / no-vision / format / size states', () => {
    assert.equal(photoGeolocAvailability(null).reason, 'no-model');
    assert.equal(photoGeolocAvailability(new FakeVision({}, { configured: false })).reason, 'no-key');
    assert.equal(photoGeolocAvailability(new FakeVision({}, { vision: false })).reason, 'no-vision');
    assert.equal(photoGeolocAvailability(new FakeVision({}), { format: 'PDF' }).reason, 'unsupported-format');
    assert.equal(photoGeolocAvailability(new FakeVision({}), { format: 'JPEG', bytes: VISION_MAX_BYTES + 1 }).reason, 'too-large');
    const ok = photoGeolocAvailability(new FakeVision({}), { format: 'JPEG', bytes: 1000 });
    assert.equal(ok.available, true);
    assert.match(ok.detail, /fake/);
  });

  it('strips markup and bounds the operator hint, and labels it as unverified in the prompt', () => {
    assert.equal(sanitizeHint('  posted by <script>x</script> a Sinaloa account; Aug 2026 '), 'posted by scriptx/script a Sinaloa account; Aug 2026');
    assert.ok(sanitizeHint('a'.repeat(1000)).length <= 200);
    const p = buildPhotoPrompt({ meta: { exif: { Make: 'Apple', Model: 'iPhone 14' }, width: 4032, height: 3024 }, hint: 'Sinaloa' });
    assert.match(p, /Apple/);
    assert.match(p, /Sinaloa/);
    assert.match(p, /unverified/i);
    assert.doesNotMatch(buildPhotoPrompt({}), /hint/i);
  });
});

describe('geolocatePhoto', () => {
  it('returns unavailable without calling the model when no vision provider is configured', async () => {
    const r = await geolocatePhoto(null, JPEG, { format: 'JPEG', gz });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'no-model');
    assert.equal(r.assessment, null);
    const p = new FakeVision({}, { vision: false });
    assert.equal((await geolocatePhoto(p, JPEG, { format: 'JPEG', gz })).reason, 'no-vision');
    assert.equal(p.calls.length, 0);
  });

  it('sends the image once as base64 and returns a validated assessment', async () => {
    const p = new FakeVision('```json\n{"country":"MX","state":"Chihuahua","city":"Ciudad Juárez","lat":31.69,"lon":-106.42,"radiusKm":8,"confidence":"medium","clues":["CHIH plates -> Chihuahua"]}\n```');
    const r = await geolocatePhoto(p, JPEG, { format: 'JPEG', gz, hint: 'border crossing' });
    assert.equal(r.status, 'ok');
    assert.equal(r.model, 'fake/fake-v');
    assert.equal(r.assessment.city, 'Ciudad Juárez');
    assert.equal(r.assessment.state, 'Chihuahua');
    assert.equal(r.assessment.radiusKm, 8);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].image.mime, 'image/jpeg');
    assert.equal(p.calls[0].image.base64, JPEG.toString('base64'));
    assert.match(p.calls[0].user, /border crossing/);
  });

  it('reports no-estimate for unusable answers and a generic error (no secrets) when the provider throws', async () => {
    assert.equal((await geolocatePhoto(new FakeVision({ noEstimate: true }), JPEG, { format: 'JPEG', gz })).status, 'no-estimate');
    assert.equal((await geolocatePhoto(new FakeVision('not json at all'), JPEG, { format: 'JPEG', gz })).status, 'no-estimate');
    const err = await geolocatePhoto(new FakeVision({}, { fail: true }), JPEG, { format: 'JPEG', gz });
    assert.equal(err.status, 'error');
    assert.doesNotMatch(JSON.stringify(err), /secret-key-abc/);
  });
});
