// Iron Command — Pacific Watch (https://www.ironcommand.co/watch).
//
// Iron Command publishes a public JSON snapshot of its "Argus" fusion layer: open-source reports
// clustered into events, graded on the NATO Admiralty reliability scale, plus chokepoint activity
// states and pre-declared standing-watch tripwires. It is a *derived* product — news fusion, not an
// aircraft / vessel / AIS sensor — delayed six hours and no key needed. Reuse terms are informal
// ("build on it, cite it — a link back to ironcommand.co is all we ask"); attribution + link-back are
// therefore mandatory wherever this data is shown.
//
// This adapter keeps only what CRUCIX does not already have: chokepoint states for the Taiwan
// theater, the tripwires, and the multi-source graded events in theater. Iron Command's daily
// Taiwan MND transcriptions are dropped (CRUCIX polls MND directly, see taiwanmnd.mjs) and its
// numbers never feed prcTension.
//
// Live schema (2026-09): generated_at, embargo_hours, window_hours, events[] {id, title, place, lat,
// lon, corroboration, reports, grade, disciplines[], sources[], source_count, region, first, last},
// chokepoints[] {name, key, lat, lon, events_7d, events_prior_7d, trend, state, spark[], basis},
// watch[] {description, last_fired, fired_7d}, last24h, stats, fib.

import { safeFetch } from '../utils/fetch.mjs';
import { cleanText, httpUrl, toIso, toCoord } from './iranwarlive.mjs';

export const SOURCE = 'IronCommand';
export const PROVIDER = 'Iron Command — Pacific Watch';
export const FEED_URL = 'https://www.ironcommand.co/api/pacific-watch';
export const SITE_URL = 'https://www.ironcommand.co/watch';
export const RSS_URL = 'https://www.ironcommand.co/watch/feed.xml';
export const METHODOLOGY_URL = 'https://www.ironcommand.co/methodology';
export const PLAN_TRACKER_URL = 'https://www.ironcommand.co/watch/plan';
export const LICENSE = 'Attribution + link-back (informal)';
export const ATTRIBUTION = 'Source: Iron Command Pacific Watch (ironcommand.co) \u2014 multi-source OSINT fusion, 6 h delayed';

export const DISCLAIMER = [
  'Derived context, not observation: Iron Command fuses open-source reporting into graded events. Grades are source reliability (NATO Admiralty A\u2013F), not confidence that an event happened.',
  'Chokepoint states are counts of fused events in a 7-day window versus the prior 7 days, not vessel or aircraft activity. Coordinates are place centroids.',
  'Public snapshot is delayed 6 hours. Iron Command\u2019s Taiwan MND daily transcriptions are dropped here because CRUCIX polls MND directly.',
  ATTRIBUTION,
];

const HEADERS = { 'User-Agent': 'Crucix/1.0 (+https://github.com/COG-GTM/DevinCrucix; OSINT dashboard)' };
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_EVENTS = 24;
export const MAX_SPARK = 14;
export const STALE_AFTER_H = 24;

// Taiwan-theater chokepoints, in display order. Anything else in the payload (Hormuz, Malacca,
// Korean peninsula) is out of theater and dropped.
export const THEATER_CHOKEPOINTS = ['taiwan-strait', 'miyako-strait', 'scarborough-shoal'];
const THEATER_REGIONS = new Set(THEATER_CHOKEPOINTS);
const THEATER_PLACES = /^(taiwan|taiwan strait|okinawa|japan|philippines|south china sea|east china sea|luzon|kinmen|matsu|penghu|scarborough shoal|second thomas shoal|spratly|paracel|senkaku|diaoyu|miyako|yonaguni|guam|palau|fujian|xiamen)$/i;
const TRIPWIRE_THEATER = /taiwan|scarborough|second thomas|first island chain|plan\b|pla\b|carrier|miyako|luzon|philippine|senkaku|east china sea|south china sea/i;

const STATES = new Set(['SPIKE', 'ELEVATED', 'NORMAL', 'QUIET']);
const TRENDS = new Set(['up', 'down', 'flat']);
const GRADES = new Set(['A', 'B', 'C', 'D', 'E', 'F']);

// Iron Command's own daily MND transcription — already covered by taiwanmnd.mjs.
const MND_DAILY = /Taiwan MND daily PLA report|Taiwan MND daily|MND daily PLA/i;
// Non-security clusters that the region tag alone lets through (weather, semiconductors, sport).
const NOISE = /weather|hot weather|rain|typhoon|temperature|chip R&D|semiconductor|TSMC|design software|stock|shares|earnings|IPO|tourism|baseball|basketball|football|concert|festival/i;
const SECURITY = /militar|defen[cs]e|missile|drill|exercise|warship|destroyer|frigate|carrier|sortie|fighter|F-15|F-16|bomber|\bnavy\b|naval|\barmy\b|troops|marines|coast guard|gr[ae]y[- ]zone|blockade|invasion|deterren|arms|weapon|radar|submarine|drone|UAV|airspace|incursion|intrusion|patrol|\bwar\b|conflict|security|intelligence|sanction|Pentagon|INDOPACOM|Fleet|PLA\b|PLAN\b|PLAAF|ADIZ|CCG|Self-Defen[cs]e|JSDF|hedgehog/i;

export function isTheaterEvent(e) {
  const region = String(e?.region || '').toLowerCase();
  if (THEATER_REGIONS.has(region)) return true;
  return THEATER_PLACES.test(String(e?.place || '').trim());
}

export function isMndDuplicate(e) { return MND_DAILY.test(String(e?.title || '')); }

// Region-tagged clusters are kept unless the title is plainly non-security; clusters admitted on
// place name alone (region null) must carry a security term.
export function isRelevant(e) {
  const title = String(e?.title || '');
  if (NOISE.test(title)) return SECURITY.test(title);
  if (THEATER_REGIONS.has(String(e?.region || '').toLowerCase())) return true;
  return SECURITY.test(title);
}

function ageHours(iso, now) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (now - t) / 3600000 : null; }

export function toEvent(e) {
  const grade = String(e?.grade || '').toUpperCase();
  const sources = (Array.isArray(e?.sources) ? e.sources : []).slice(0, 12).map(s => cleanText(s, 60)).filter(Boolean);
  const disciplines = (Array.isArray(e?.disciplines) ? e.disciplines : []).slice(0, 6).map(d => cleanText(d, 12).toUpperCase()).filter(d => /^[A-Z]+$/.test(d));
  const id = Number.isInteger(e?.id) && e.id >= 0 ? e.id : null;
  return {
    id,
    title: cleanText(e?.title, 200),
    place: cleanText(e?.place, 60) || null,
    lat: toCoord(e?.lat, 90),
    lon: toCoord(e?.lon, 180),
    locationPrecision: 'centroid',
    grade: GRADES.has(grade) ? grade : null,
    corroboration: Number.isFinite(Number(e?.corroboration)) ? Math.max(0, Math.round(Number(e.corroboration))) : 0,
    reports: Number.isFinite(Number(e?.reports)) ? Math.max(0, Math.round(Number(e.reports))) : 0,
    sourceCount: Number.isFinite(Number(e?.source_count)) ? Math.max(0, Math.round(Number(e.source_count))) : sources.length,
    sources,
    disciplines,
    region: cleanText(e?.region, 24).toLowerCase() || null,
    first: toIso(e?.first),
    last: toIso(e?.last),
    url: id === null ? SITE_URL : `${SITE_URL}#e${id}`,
  };
}

export function toChokepoint(c) {
  const state = String(c?.state || '').toUpperCase();
  const trend = String(c?.trend || '').toLowerCase();
  return {
    key: cleanText(c?.key, 24).toLowerCase(),
    name: cleanText(c?.name, 40),
    lat: toCoord(c?.lat, 90),
    lon: toCoord(c?.lon, 180),
    events7d: Math.max(0, Math.round(Number(c?.events_7d) || 0)),
    eventsPrior7d: Math.max(0, Math.round(Number(c?.events_prior_7d) || 0)),
    trend: TRENDS.has(trend) ? trend : 'flat',
    state: STATES.has(state) ? state : 'UNKNOWN',
    spark: (Array.isArray(c?.spark) ? c.spark : []).slice(-MAX_SPARK).map(v => Math.max(0, Math.round(Number(v) || 0))),
    basis: cleanText(c?.basis, 24) || 'event-count',
  };
}

export function toTripwire(w) {
  return {
    description: cleanText(w?.description, 120),
    lastFired: /^\d{4}-\d{2}-\d{2}$/.test(String(w?.last_fired || '')) ? String(w.last_fired) : null,
    fired7d: Boolean(w?.fired_7d),
    theater: TRIPWIRE_THEATER.test(String(w?.description || '')),
  };
}

export function buildResult(raw, fetchedAt = new Date().toISOString()) {
  const now = Date.parse(fetchedAt) || Date.now();
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawEvents = Array.isArray(payload.events) ? payload.events : [];
  const rawChoke = Array.isArray(payload.chokepoints) ? payload.chokepoints : [];
  const rawWatch = Array.isArray(payload.watch) ? payload.watch : [];
  const generatedAt = toIso(payload.generated_at);
  const generatedAgeH = ageHours(generatedAt, now);

  const chokepoints = rawChoke.map(toChokepoint).filter(c => THEATER_REGIONS.has(c.key));
  chokepoints.sort((a, b) => THEATER_CHOKEPOINTS.indexOf(a.key) - THEATER_CHOKEPOINTS.indexOf(b.key));

  const tripwires = rawWatch.map(toTripwire).filter(w => w.description);

  let mndDuplicates = 0, offTopic = 0;
  const kept = [];
  const seen = new Set();
  for (const e of rawEvents) {
    if (!e || typeof e !== 'object' || !isTheaterEvent(e)) continue;
    if (isMndDuplicate(e)) { mndDuplicates++; continue; }
    if (!isRelevant(e)) { offTopic++; continue; }
    const ev = toEvent(e);
    if (!ev.title) continue;
    const key = ev.id !== null ? `id:${ev.id}` : ev.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(ev);
  }
  kept.sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  const events = kept.slice(0, MAX_EVENTS);
  const byGrade = {};
  for (const e of events) byGrade[e.grade || '?'] = (byGrade[e.grade || '?'] || 0) + 1;

  const problems = [];
  if (!rawEvents.length && !rawChoke.length) problems.push('snapshot had no events and no chokepoints');
  if (rawChoke.length && !chokepoints.length) problems.push(`none of ${rawChoke.length} chokepoints matched the Taiwan theater keys`);
  if (mndDuplicates) problems.push(`${mndDuplicates} MND daily-report cluster${mndDuplicates === 1 ? '' : 's'} dropped (CRUCIX polls MND directly)`);
  if (offTopic) problems.push(`${offTopic} in-theater cluster${offTopic === 1 ? '' : 's'} dropped as non-security`);
  if (generatedAgeH !== null && generatedAgeH > STALE_AFTER_H) problems.push(`snapshot generated ${generatedAgeH.toFixed(1)} h ago`);
  const unknownStates = chokepoints.filter(c => c.state === 'UNKNOWN').length;
  if (unknownStates) problems.push(`${unknownStates} chokepoint state value${unknownStates === 1 ? '' : 's'} not in the known vocabulary`);

  let status;
  if (!rawEvents.length && !rawChoke.length) status = 'unavailable';
  else if (!chokepoints.length && !events.length) status = 'empty';
  else if (generatedAgeH !== null && generatedAgeH > STALE_AFTER_H) status = 'stale';
  else if (!chokepoints.length || unknownStates) status = 'limited';
  else status = 'live';

  return {
    source: SOURCE,
    timestamp: fetchedAt,
    fetchedAt,
    status,
    error: status === 'unavailable' ? (problems[0] || 'feed unavailable') : null,
    provider: PROVIDER,
    siteUrl: SITE_URL,
    feedUrl: FEED_URL,
    rssUrl: RSS_URL,
    methodologyUrl: METHODOLOGY_URL,
    planTrackerUrl: PLAN_TRACKER_URL,
    license: LICENSE,
    attribution: ATTRIBUTION,
    generatedAt,
    generatedAgeH: generatedAgeH === null ? null : +generatedAgeH.toFixed(1),
    embargoHours: Number.isFinite(Number(payload.embargo_hours)) ? Number(payload.embargo_hours) : null,
    windowHours: Number.isFinite(Number(payload.window_hours)) ? Number(payload.window_hours) : null,
    feedEvents: rawEvents.length,
    feedChokepoints: rawChoke.length,
    chokepoints,
    tripwires,
    events,
    stats: {
      shown: events.length,
      theaterEvents: kept.length,
      mndDuplicates,
      offTopic,
      byGrade,
      spike: chokepoints.filter(c => c.state === 'SPIKE').length,
      elevated: chokepoints.filter(c => c.state === 'ELEVATED').length,
      tripwiresFired7d: tripwires.filter(w => w.fired7d).length,
      feeds: Math.max(0, Math.round(Number(payload.stats?.feeds) || 0)),
      items7d: Math.max(0, Math.round(Number(payload.stats?.items_7d) || 0)),
    },
    problems: problems.slice(0, 6),
    disclaimer: DISCLAIMER,
  };
}

let _cache = null;
let _cacheTs = 0;

function staleCopy() {
  const ageH = (Date.now() - _cacheTs) / 3600000;
  return { ..._cache, stale: true, status: ageH > STALE_AFTER_H ? 'stale' : 'limited', cacheAgeH: +ageH.toFixed(1), error: `serving cached copy (${ageH.toFixed(1)} h old): upstream fetch failed` };
}

export async function fetchIronCommand() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  try {
    const r = await safeFetch(FEED_URL, { timeout: 20000, headers: { ...HEADERS, Accept: 'application/json' } });
    if (r?.error) throw new Error(r.error);
    if (typeof r?.rawText === 'string') {
      if (r.rawText.length > MAX_JSON_BYTES) throw new Error('feed body too large');
      throw new Error('feed body was not JSON');
    }
    const result = buildResult(r);
    if (result.status === 'unavailable') {
      console.log(`[IronCommand] ${result.error}`);
      return _cache ? staleCopy() : result;
    }
    _cache = result;
    _cacheTs = now;
    return result;
  } catch (err) {
    console.log(`[IronCommand] fetch error: ${err.message}`);
    if (_cache) return staleCopy();
    return { ...buildResult(null), error: err.message };
  }
}

export function _resetCacheForTests() { _cache = null; _cacheTs = 0; }

export async function briefing() {
  return fetchIronCommand();
}

export default briefing;
