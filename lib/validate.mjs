// Whitelist request validation shared by every HTTP route.
// Helpers take the raw value and return the normalized value or throw ValidationError;
// the Express middlewares turn that into a generic `400 {error:'invalid request', field}`
// (the offending value is never echoed back or logged).

export class ValidationError extends Error {
  constructor(field, reason) {
    super('invalid request');
    this.name = 'ValidationError';
    this.field = field;
    this.reason = reason;
  }
}

const fail = (reason) => { throw new ValidationError(undefined, reason); };
const isMissing = (v) => v === undefined || v === null || v === '';

// Bounded string. Query values may arrive as arrays (`?a=1&a=2`) — those are rejected.
export function str(v, { max = 255, min = 1, pattern, required = false, trim = true } = {}) {
  if (isMissing(v)) return required ? fail('required') : undefined;
  if (typeof v !== 'string') fail('type');
  const s = trim ? v.trim() : v;
  if (s.length > max) fail('max');
  if (s.length < min) fail('min');
  if (pattern && !pattern.test(s)) fail('pattern');
  return s;
}

// Bounded number; accepts a number or a plain decimal string (no exponents / Infinity / NaN).
const NUM_RE = /^-?\d{1,15}(\.\d{1,10})?$/;
export function num(v, { min = -Infinity, max = Infinity, int = false, required = false } = {}) {
  if (isMissing(v)) return required ? fail('required') : undefined;
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && NUM_RE.test(v.trim())) n = Number(v.trim());
  else fail('type');
  if (!Number.isFinite(n)) fail('type');
  if (int && !Number.isInteger(n)) fail('int');
  if (n < min || n > max) fail('range');
  return n;
}

export function bool(v, { required = false } = {}) {
  if (isMissing(v)) return required ? fail('required') : undefined;
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return fail('type');
}

// Exact membership in an allow-list (Array of strings, or Set / Map keyed by string).
export function oneOf(v, allowed, { required = false } = {}) {
  if (isMissing(v)) return required ? fail('required') : undefined;
  if (typeof v !== 'string') fail('type');
  const ok = (allowed instanceof Set || allowed instanceof Map) ? allowed.has(v) : Array.isArray(allowed) && allowed.includes(v);
  return ok ? v : fail('enum');
}

// Array of bounded strings.
export function strArray(v, { min = 1, max = 20, itemMax = 255, itemMin = 1, pattern, required = false } = {}) {
  if (isMissing(v)) return required ? fail('required') : undefined;
  if (!Array.isArray(v)) fail('type');
  if (v.length < min) fail('min');
  if (v.length > max) fail('max');
  return v.map(item => str(item, { max: itemMax, min: itemMin, pattern, required: true, trim: true }));
}

// Positive integer bound used for `limit` / `hours` / `days` / `count` style parameters.
export function bounded(v, max, { min = 1, required = false } = {}) {
  return num(v, { min, max, int: true, required });
}

// ─── Express glue ───────────────────────────────────────────────────────────

function logFailure(req, source, field, reason) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(), event: 'validation_failure',
    ip: req.ip, method: req.method, path: req.path, source, field, reason,
  }));
}

// schema: { fieldName: (rawValue) => normalizedValue }. Validated values are collected on
// req.validated[source]; handlers must read from there, never from req.query / req.body.
function validator(source, schema) {
  const fields = Object.entries(schema);
  return function validate(req, res, next) {
    const input = req[source];
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const [field, check] of fields) {
      try {
        const value = check(src[field]);
        if (value !== undefined) out[field] = value;
      } catch (err) {
        if (!(err instanceof ValidationError)) return next(err);
        logFailure(req, source, field, err.reason);
        return res.status(400).json({ error: 'invalid request', field });
      }
    }
    req.validated = { ...(req.validated || {}), [source]: out };
    next();
  };
}

export const validateQuery = (schema) => validator('query', schema);
export const validateBody = (schema) => validator('body', schema);
export const validateParams = (schema) => validator('params', schema);
