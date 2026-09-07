// ADS-B Exchange v2 (RapidAPI "Community API") — shared client.
// https://rapidapi.com/adsbx/api/adsbexchange-com1
//
// One place for the key lookup, the request headers, and the monthly-quota
// budget so every caller (theater sampling, military watch) meters the same
// way. The Community tier is 10,000 requests/month; the default daily budget
// (300) keeps a 15-minute sweep cadence under that with headroom.

import { safeFetch } from '../utils/fetch.mjs';

export const ADSBX_HOST = 'adsbexchange-com1.p.rapidapi.com';
const BASE = `https://${ADSBX_HOST}/v2`;
const DEFAULT_DAILY_BUDGET = 300;
const COOLDOWN_MS = 60 * 60_000;

const state = { day: '', used: 0, cooldownUntil: 0, lastError: null };

export function resetAdsbxState() {
  Object.assign(state, { day: '', used: 0, cooldownUntil: 0, lastError: null });
}

export function adsbxKey(env = process.env) {
  const key = (env.ADSBX_RAPIDAPI_KEY || '').trim();
  return /^[A-Za-z0-9_-]{16,128}$/.test(key) ? key : null;
}

export function adsbxConfigured(env = process.env) {
  return Boolean(adsbxKey(env));
}

export function adsbxDailyBudget(env = process.env) {
  const n = Number(env.ADSBX_DAILY_BUDGET);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_BUDGET;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rollDay() {
  const d = today();
  if (state.day !== d) { state.day = d; state.used = 0; }
}

// Requests still allowed today (0 when unconfigured, exhausted, or cooling down).
export function adsbxRemaining(env = process.env) {
  if (!adsbxKey(env)) return 0;
  if (Date.now() < state.cooldownUntil) return 0;
  rollDay();
  return Math.max(0, adsbxDailyBudget(env) - state.used);
}

export function adsbxStatus(env = process.env) {
  rollDay();
  return {
    configured: adsbxConfigured(env),
    usedToday: state.used,
    dailyBudget: adsbxDailyBudget(env),
    coolingDown: Date.now() < state.cooldownUntil,
    lastError: state.lastError,
  };
}

async function adsbxGet(path, { timeout = 20000, env = process.env } = {}) {
  const key = adsbxKey(env);
  if (!key) return { error: 'ADS-B Exchange key not configured (ADSBX_RAPIDAPI_KEY)' };
  if (Date.now() < state.cooldownUntil) return { error: 'ADS-B Exchange cooling down after rate limit', rateLimited: true };
  rollDay();
  if (state.used >= adsbxDailyBudget(env)) return { error: 'ADS-B Exchange daily budget exhausted', budget: true };

  state.used++;
  const data = await safeFetch(`${BASE}${path}`, {
    timeout, retries: 0,
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': ADSBX_HOST, Accept: 'application/json' },
  });
  if (data?.error) {
    state.lastError = data.error;
    if (/HTTP 429/.test(data.error)) { state.cooldownUntil = Date.now() + COOLDOWN_MS; return { error: 'HTTP 429: ADS-B Exchange rate limited', rateLimited: true }; }
    if (/HTTP 40[13]/.test(data.error)) { state.cooldownUntil = Date.now() + COOLDOWN_MS; return { error: `ADS-B Exchange auth rejected (${data.error.slice(0, 8)})`, auth: true }; }
    return { error: data.error };
  }
  state.lastError = null;
  return data;
}

// readsb-style aircraft JSON ({ ac: [...] }) within `distNm` (max 250) of a point.
export async function adsbxPoint(lat, lon, distNm = 250, opts = {}) {
  const d = Math.max(1, Math.min(250, Math.round(distNm)));
  return adsbxGet(`/lat/${(+lat).toFixed(3)}/lon/${(+lon).toFixed(3)}/dist/${d}/`, opts);
}

// All aircraft flagged military by the aggregator.
export async function adsbxMilitary(opts = {}) {
  return adsbxGet('/mil/', opts);
}
