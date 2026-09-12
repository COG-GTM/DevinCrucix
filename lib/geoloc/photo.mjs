// Content-based photo geolocation via a vision-capable LLM. Operator-initiated only, and only
// used when the image carries no EXIF GPS fix. Everything the model returns is bounded and, for
// Mexico, snapped through the same gazetteer the narco pipeline uses; the result is always
// labelled a model assessment with an explicit uncertainty radius, never a sourced fact.

import { loadGazetteer, fold, haversineKm } from '../narco/gazetteer.mjs';
import { parseJSON } from '../narco/llm.mjs';

export const VISION_MIMES = { JPEG: 'image/jpeg', PNG: 'image/png', WebP: 'image/webp', GIF: 'image/gif' };
export const VISION_MAX_BYTES = 5 * 1024 * 1024; // provider-side per-image limit
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 5000;
const MAX_CLUES = 8;
const MAX_CLUE_CHARS = 200;
const MAX_HINT_CHARS = 200;
const CONFIDENCE_LABELS = ['low', 'medium', 'high'];

export const PHOTO_GEOLOC_SYSTEM = [
  'You are an imagery analyst estimating WHERE a photograph was taken from its visible content only:',
  'signage language and typography, licence plates, road markings, architecture, vegetation, terrain,',
  'business names, phone-number formats, utility poles, vehicles, uniforms, weather and shadows.',
  'Never claim certainty you do not have. If the image gives no usable cue, say so.',
  'Respond with ONE JSON object and nothing else:',
  '{"country": "ISO-3166 alpha-2 or null", "state": "state/province name or null", "city": "city or municipality name or null",',
  ' "lat": number or null, "lon": number or null, "radiusKm": number (radius within which you expect the true location, be honest),',
  ' "confidence": "low"|"medium"|"high", "clues": ["short visible cue -> what it implies", ...up to 8], "noEstimate": true only if nothing usable}',
].join('\n');

export function buildPhotoPrompt({ meta = null, hint = '' } = {}) {
  const lines = ['Estimate where this photograph was taken.'];
  const t = meta?.exif?.DateTimeOriginal || meta?.exif?.CreateDate;
  if (t) lines.push(`Capture time from metadata: ${String(t).slice(0, 40)}`);
  const cam = [meta?.exif?.Make, meta?.exif?.Model].filter(Boolean).join(' ');
  if (cam) lines.push(`Camera from metadata: ${cam.slice(0, 60)}`);
  const h = sanitizeHint(hint);
  if (h) lines.push(`Operator context (unverified, do not treat as ground truth): ${h}`);
  return lines.join('\n');
}

export function sanitizeHint(s) {
  return String(s || '').replace(/[^\p{L}\p{N} .,;:'’()/-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_HINT_CHARS);
}

function cleanClue(c) {
  if (typeof c !== 'string') return null;
  const s = c.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CLUE_CHARS);
  return s.length >= 3 ? s : null;
}

function num(v, lo, hi) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function confidenceOf(v) {
  if (typeof v === 'string' && CONFIDENCE_LABELS.includes(v.toLowerCase())) return v.toLowerCase();
  const n = num(v, 0, 1);
  if (n == null) return 'low';
  return n >= 0.7 ? 'high' : n >= 0.4 ? 'medium' : 'low';
}

function precisionFor(radiusKm) {
  if (radiusKm <= 5) return 'neighbourhood';
  if (radiusKm <= 30) return 'city';
  if (radiusKm <= 150) return 'region';
  if (radiusKm <= 1000) return 'country';
  return 'continent';
}

/**
 * Validate and bound a raw model answer. Returns null when the model produced no usable estimate.
 * Mexico answers are snapped to the gazetteer: a named state/city must resolve or it is dropped,
 * and when the model's own coordinates sit outside the snapped place's radius the named place wins,
 * confidence drops to low and the disagreement is reported in `conflict` for the operator.
 */
export function validatePhotoGeoloc(out, { gz = loadGazetteer() } = {}) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  if (out.noEstimate === true) return null;
  const v = { country: null, state: null, city: null, lat: null, lon: null, radiusKm: null, confidence: 'low', clues: [], snapped: false, precision: null, conflict: null };

  if (typeof out.country === 'string' && /^[A-Za-z]{2}$/.test(out.country.trim())) v.country = out.country.trim().toUpperCase();
  const lat = num(out.lat, -90, 90), lon = num(out.lon, -180, 180);
  if (lat != null && lon != null && (lat || lon)) { v.lat = lat; v.lon = lon; }
  let radius = num(out.radiusKm, 0, 1e6);
  v.confidence = confidenceOf(out.confidence);
  if (Array.isArray(out.clues)) v.clues = out.clues.map(cleanClue).filter(Boolean).slice(0, MAX_CLUES);

  // Coordinates inside Mexico imply MX even if the model left country blank.
  const inMx = v.lat != null && v.lat >= 14.5 && v.lat <= 32.8 && v.lon >= -118.5 && v.lon <= -86.5;
  if (!v.country && inMx) v.country = 'MX';

  if (v.country === 'MX') {
    const st = typeof out.state === 'string' ? gz.stateKey.get(fold(out.state)) : null;
    let place = null;
    if (typeof out.city === 'string') {
      const k = fold(out.city);
      const rows = [...(gz.placeKey.get(k) || []), ...(gz.muniKey.get(k) || [])];
      place = (st && rows.find(r => r.adm1 === st.adm1))
        || (v.lat != null && rows.length ? rows.reduce((b, r) => (!b || haversineKm(v.lat, v.lon, r.lat, r.lon) < haversineKm(v.lat, v.lon, b.lat, b.lon) ? r : b), null) : null)
        || (rows.length === 1 ? rows[0] : null);
    }
    const anchor = place || st || null;
    if (place) { v.city = place.name; v.state = gz.stateByAdm1.get(place.adm1)?.shortName || null; }
    else if (st) v.state = st.shortName;
    if (anchor) {
      v.snapped = true;
      const floor = place ? 5 : 100;
      if (radius == null) radius = floor;
      if (v.lat == null) { v.lat = anchor.lat; v.lon = anchor.lon; }
      else {
        const d = haversineKm(v.lat, v.lon, anchor.lat, anchor.lon);
        if (d > Math.max(radius, floor)) {
          v.conflict = `model coordinates lie ${Math.round(d)} km from ${anchor.name || anchor.shortName}; named place used`;
          v.confidence = 'low';
          v.lat = anchor.lat; v.lon = anchor.lon;
        }
      }
      radius = Math.max(radius, floor);
    }
  } else if (typeof out.state === 'string') {
    v.state = cleanClue(out.state)?.slice(0, 60) || null;
    if (typeof out.city === 'string') v.city = cleanClue(out.city)?.slice(0, 60) || null;
  }

  if (v.lat == null) return null;
  if (radius == null) radius = v.confidence === 'high' ? 25 : v.confidence === 'medium' ? 100 : 500;
  v.radiusKm = Math.round(Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, radius)));
  v.lat = Math.round(v.lat * 1e4) / 1e4;
  v.lon = Math.round(v.lon * 1e4) / 1e4;
  v.precision = precisionFor(v.radiusKm);
  return v;
}

/** Why the model path is unavailable for this provider/image, or null when it can run. */
export function photoGeolocAvailability(provider, { format, bytes } = {}) {
  if (!provider) return { available: false, reason: 'no-model', detail: 'No LLM provider configured (LLM_PROVIDER / LLM_API_KEY)' };
  if (!provider.isConfigured) return { available: false, reason: 'no-key', detail: `${provider.name} provider has no API key` };
  if (!provider.supportsVision) return { available: false, reason: 'no-vision', detail: `${provider.name} provider cannot read images` };
  if (format !== undefined && !VISION_MIMES[format]) return { available: false, reason: 'unsupported-format', detail: 'Model path accepts JPEG, PNG, WebP or GIF' };
  if (bytes !== undefined && bytes > VISION_MAX_BYTES) return { available: false, reason: 'too-large', detail: `Image exceeds ${VISION_MAX_BYTES / 1024 / 1024} MB model limit` };
  return { available: true, reason: null, detail: `${provider.name} · ${provider.model || 'default model'}` };
}

/**
 * Run the model on one in-memory image. Never throws for provider errors — returns a status the
 * UI can render honestly. `format` is the parseImageMetadata() format string.
 */
export async function geolocatePhoto(provider, buf, { format, meta = null, hint = '', gz, timeout = 60_000 } = {}) {
  const avail = photoGeolocAvailability(provider, { format, bytes: buf?.length ?? 0 });
  if (!avail.available) return { status: 'unavailable', reason: avail.reason, detail: avail.detail, assessment: null };
  const image = { mime: VISION_MIMES[format], base64: buf.toString('base64') };
  let res;
  try {
    res = await provider.completeVision(PHOTO_GEOLOC_SYSTEM, buildPhotoPrompt({ meta, hint }), image, { maxTokens: 1024, timeout });
  } catch (err) {
    console.error('[geoloc] vision call failed:', err?.message || err);
    return { status: 'error', reason: 'model-error', detail: 'Model request failed', assessment: null };
  }
  const assessment = validatePhotoGeoloc(parseJSON(res?.text), { gz });
  return {
    status: assessment ? 'ok' : 'no-estimate',
    reason: assessment ? null : 'no-estimate',
    detail: assessment ? null : 'Model found no usable geographic cue',
    model: `${provider.name}/${res?.model || provider.model || ''}`.replace(/\/$/, ''),
    usage: res?.usage || null,
    assessment,
  };
}
