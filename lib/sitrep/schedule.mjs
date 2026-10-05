// lib/sitrep/schedule — when the AM / PM editions are due, in the commander's local time zone.
// Pure functions over Date + Intl so the server tick and the tests share one definition of "due".
export const DEFAULT_TIMEZONE = 'America/New_York';
export const DEFAULT_TIMES = { am: '06:00', pm: '16:00' };
// A missed slot (server asleep, redeploy) is still produced if we come up within this window;
// after it the slot is skipped rather than publishing a stale "morning" brief in the evening.
export const CATCH_UP_MS = 6 * 3600_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTimes(times = {}) {
  const out = { ...DEFAULT_TIMES };
  for (const k of ['am', 'pm']) if (TIME_RE.test(String(times[k] || ''))) out[k] = times[k];
  return out;
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return fmtCache.get(tz);
}

// Wall-clock parts of an instant in a time zone.
export function localParts(date, tz = DEFAULT_TIMEZONE) {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === 24 ? 0 : p.hour, mm: p.minute, ss: p.second };
}

export function localDateKey(date, tz = DEFAULT_TIMEZONE) {
  const { y, m, d } = localParts(date, tz);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The UTC instant for a wall-clock time in tz on the given local date (DST-safe via one correction pass).
export function zonedTime(dateKey, hhmm, tz = DEFAULT_TIMEZONE) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const have = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    const want = Date.UTC(y, m - 1, d, hh, mm, 0);
    if (have === want) break;
    guess += want - have;
  }
  return new Date(guess);
}

export function slotKey(dateKey, edition) { return `${dateKey}-${edition}`; }

// Which scheduled edition (if any) is due right now. `done(slotKey)` says whether that slot already
// has a stored edition. Checks today and yesterday so a slot just before local midnight is not lost.
export function dueEdition(now, { tz = DEFAULT_TIMEZONE, times = DEFAULT_TIMES, done = () => false, catchUpMs = CATCH_UP_MS } = {}) {
  const t = parseTimes(times);
  const nowMs = now.getTime();
  const days = [localDateKey(new Date(nowMs - 86400_000), tz), localDateKey(now, tz)];
  let pick = null;
  for (const dateKey of days) {
    for (const edition of ['am', 'pm']) {
      const at = zonedTime(dateKey, t[edition], tz);
      const age = nowMs - at.getTime();
      if (age < 0 || age > catchUpMs) continue;
      const key = slotKey(dateKey, edition);
      if (done(key)) continue;
      if (!pick || at > pick.at) pick = { edition, dateKey, slotKey: key, at };
    }
  }
  return pick;
}

// Next scheduled slot after `now` (for the status card).
export function nextSlot(now, { tz = DEFAULT_TIMEZONE, times = DEFAULT_TIMES } = {}) {
  const t = parseTimes(times);
  const nowMs = now.getTime();
  let best = null;
  for (const off of [0, 1, 2]) {
    const dateKey = localDateKey(new Date(nowMs + off * 86400_000), tz);
    for (const edition of ['am', 'pm']) {
      const at = zonedTime(dateKey, t[edition], tz);
      if (at.getTime() > nowMs && (!best || at < best.at)) best = { edition, dateKey, slotKey: slotKey(dateKey, edition), at };
    }
  }
  return best;
}
