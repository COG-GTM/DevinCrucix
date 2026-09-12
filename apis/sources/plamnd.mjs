// Taiwan Ministry of National Defense — daily "PLA activities in the waters and airspace around
// Taiwan" reports (https://www.mnd.gov.tw/en/news/PlaactList). One English post per day since
// late 2020, server-rendered HTML with a fixed-format sentence:
//
//   "11 sorties of PLA aircraft, 8 PLAN ships and 2 official ships operating around Taiwan were
//    detected as of 6 a.m. (UTC+8) today. 10 out of 11 sorties crossed the median line of the
//    Taiwan Strait and entered Taiwan's southwestern and eastern ADIZ."
//
// plus a daily track chart (JPG). MND publishes no API; its RSS is Chinese general press only.
//
// Access policy: mnd.gov.tw/robots.txt is `User-agent: *  Disallow: /` (only Googlebot is
// allowed), so with the default configuration this source refuses to fetch and reports
// "robots-disallowed" with a link-out to the official page. An operator can opt in with
// PLAMND_ROBOTS_OVERRIDE=1; the adapter then makes at most one list-page request per sweep and
// only fetches detail pages it has not seen before (MAX_NEW_DETAILS per sweep, 1 s apart), so the
// steady-state load is two requests a day. Parsed reports are persisted under runs/plamnd/ so the
// series accumulates locally rather than being re-crawled. Content is © ROC Ministry of National
// Defense; all strings are third-party and must be escaped by the frontend.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRobots } from '../utils/robots.mjs';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';
import { loadDatasets, timedFetch, rollupStatus, errorSummary, stripTags } from './cbpcommon.mjs';

export const SOURCE = 'PLAMND';
export const PIPELINE_VERSION = 'plamnd/1.0.0';
export const ORIGIN = 'https://www.mnd.gov.tw';
export const LIST_URL = `${ORIGIN}/en/news/PlaactList`;
export const ATTRIBUTION = 'Source: Ministry of National Defense, Republic of China (Taiwan) — daily "PLA activities in the waters and airspace around Taiwan" releases, mnd.gov.tw. Counts are as reported by MND for the 24 h ending 06:00 UTC+8; wording and categories change over time.';
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../runs/plamnd');
const STATE_FILE = 'state-plamnd.json';
const REPORTS_FILE = 'reports.json';

export const MAX_NEW_DETAILS = 3;   // detail pages fetched per sweep (backfill trickles in)
export const MAX_REPORTS = 400;     // ~13 months kept on disk
const SERIES_DAYS = 30;
const DETAIL_DELAY_MS = 1000;
const MAX_TEXT = 400;

export const DATASETS = {
  list: {
    id: 'list', kind: 'html', publisher: 'MND', title: 'PLA activities list page',
    pageUrl: LIST_URL, cacheFile: 'plaact-list.html',
    validate: html => (parseList(html).length ? null : 'no PLAAct entries found on list page'),
  },
};

export function robotsOverrideEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.PLAMND_ROBOTS_OVERRIDE || ''));
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const isoFromDots = s => {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(String(s || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const clean = s => stripTags(s).replace(/\s+/g, ' ').trim();
const int = s => (s == null ? null : Number(String(s).replace(/,/g, '')));

// List page: <a href="/en/News/PLAAct/87739" class="news_list"><div class="date ...">2026.09.11</div><h2 class="title ...">…</h2></a>
export function parseList(html) {
  const out = [];
  const re = /<a\s+href="(\/en\/News\/PLAAct\/(\d+))"[^>]*class="news_list"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of String(html || '').matchAll(re)) {
    const inner = m[3];
    const date = isoFromDots(clean(/<div[^>]*class="date[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(inner)?.[1]));
    const title = clean(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(inner)?.[1]).slice(0, 160);
    if (!date) continue;
    out.push({ id: m[2], date, title, url: ORIGIN + m[1] });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
}

// "6 a.m. Sep. 10 (Thu.) to 6 a.m. Sep. 11 (Fri.) (UTC+8)" — the report date supplies the year.
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function windowEndUtc(windowText, reportDate) {
  const m = /to\s+(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\s+([A-Za-z]{3,4})\.?\s+(\d{1,2})/i.exec(windowText || '');
  if (!m || !reportDate) return null;
  const mon = MON[m[3].toLowerCase()];
  if (!mon) return null;
  let hour = Number(m[1]) % 12;
  if (/^p/i.test(m[2])) hour += 12;
  let year = Number(reportDate.slice(0, 4));
  if (mon === 12 && reportDate.slice(5, 7) === '01') year -= 1; // window ends in the previous year
  const local = Date.UTC(year, mon - 1, Number(m[4]), hour);
  return new Date(local - 8 * 3600_000).toISOString(); // UTC+8 → UTC
}

const SECTORS = ['northern', 'northeastern', 'eastern', 'southeastern', 'southern', 'southwestern', 'western', 'northwestern', 'central'];

export function parseActivities(text) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/[’‘]/g, "'");
  const out = { aircraft: null, ships: null, officialShips: null, balloons: null, adizSorties: null, medianLine: null, adizSectors: [] };
  const air = /(\d+)\s+sorties?\s+of\s+PLA\s+aircraft/i.exec(t);
  if (air) out.aircraft = int(air[1]);
  else if (/no\s+PLA\s+aircraft/i.test(t)) out.aircraft = 0;
  const ships = /(\d+)\s+PLAN\s+(?:ships?|vessels?)/i.exec(t);
  if (ships) out.ships = int(ships[1]);
  else if (/no\s+PLAN\s+(?:ships?|vessels?)/i.test(t)) out.ships = 0;
  const official = /(\d+)\s+official\s+(?:ships?|vessels?)/i.exec(t);
  if (official) out.officialShips = int(official[1]);
  else if (out.ships != null) out.officialShips = 0;
  const balloons = /(\d+)\s+(?:PRC\s+|Chinese\s+)?balloons?/i.exec(t);
  if (balloons) out.balloons = int(balloons[1]);
  else if (out.aircraft != null) out.balloons = 0;
  const adiz = /(\d+)\s+out\s+of\s+(\d+)\s+(?:sorties\s+)?([^.]*?)ADIZ/i.exec(t);
  if (adiz) {
    out.adizSorties = int(adiz[1]);
    out.medianLine = /median\s+line/i.test(adiz[3]);
    out.adizSectors = SECTORS.filter(s => new RegExp(`\\b${s}\\b`, 'i').test(adiz[3]));
  } else if (out.aircraft === 0) {
    out.adizSorties = 0; out.medianLine = false;
  }
  return out;
}

export function parseDetail(html, entry = {}) {
  const src = String(html || '');
  const date = isoFromDots(clean(/<div[^>]*class="pageinfo"[^>]*>[\s\S]*?<span[^>]*class="body-2"[^>]*>([\s\S]*?)<\/span>/i.exec(src)?.[1])) || entry.date || null;
  const main = /<div[^>]*class="maincontent"[^>]*>([\s\S]*?)<div[^>]*class="keyword/i.exec(src)?.[1]
    ?? /<div[^>]*class="maincontent"[^>]*>([\s\S]*?)<\/div>/i.exec(src)?.[1] ?? '';
  const text = clean(main.replace(/<img[^>]*>/gi, ''));
  if (!date || !/PLA/i.test(text)) return null;
  const window = /1\.\s*Date:\s*(.*?)\s*2\.\s*PLA/i.exec(text)?.[1]?.trim() || null;
  const activity = /2\.\s*PLA activities:\s*(.*?)(?:\s*3\.\s|$)/i.exec(text)?.[1]?.trim() || text;
  const chart = /<img[^>]+src="(https:\/\/www\.mnd\.gov\.tw\/[^"]+\.(?:jpe?g|png))"/i.exec(main)?.[1] || null;
  const counts = parseActivities(activity);
  return {
    id: String(entry.id || /PLAAct\/(\d+)/.exec(src)?.[1] || ''),
    date,
    url: entry.url || (entry.id ? `${ORIGIN}/en/News/PLAAct/${entry.id}` : null),
    title: (entry.title || '').slice(0, 160),
    window: window ? window.slice(0, 120) : null,
    windowEndUtc: windowEndUtc(window, date),
    ...counts,
    chartUrl: chart,
    text: activity.slice(0, MAX_TEXT),
    parsed: counts.aircraft != null && counts.ships != null,
  };
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const sum = (arr, k) => arr.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
const avg1 = (arr, k) => (arr.length ? Math.round((sum(arr, k) / arr.length) * 10) / 10 : null);
const dayShift = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

export function summarize(reportsById) {
  const reports = Object.values(reportsById || {}).filter(r => r && r.date && r.parsed).sort((a, b) => b.date.localeCompare(a.date));
  if (!reports.length) return null;
  const latest = reports[0];
  const inWindow = (from, to) => reports.filter(r => r.date > from && r.date <= to);
  const last7 = inWindow(dayShift(latest.date, -7), latest.date);
  const prev7 = inWindow(dayShift(latest.date, -14), dayShift(latest.date, -7));
  const last30 = inWindow(dayShift(latest.date, -30), latest.date);
  const peak = last30.reduce((m, r) => (m == null || (r.aircraft ?? 0) > (m.aircraft ?? 0) ? r : m), null);
  const trend = (a, b) => (a.length && b.length ? Math.round((sum(a, 'aircraft') / a.length - sum(b, 'aircraft') / b.length) * 10) / 10 : null);
  return {
    asOf: latest.date,
    reports: reports.length,
    earliest: reports[reports.length - 1].date,
    latest,
    last7: { days: last7.length, aircraft: sum(last7, 'aircraft'), adizSorties: sum(last7, 'adizSorties'), ships: avg1(last7, 'ships'), officialShips: avg1(last7, 'officialShips'), balloons: sum(last7, 'balloons'), aircraftPerDay: avg1(last7, 'aircraft') },
    last30: { days: last30.length, aircraft: sum(last30, 'aircraft'), adizSorties: sum(last30, 'adizSorties'), ships: avg1(last30, 'ships'), officialShips: avg1(last30, 'officialShips'), balloons: sum(last30, 'balloons'), aircraftPerDay: avg1(last30, 'aircraft'), medianLineDays: last30.filter(r => r.medianLine).length },
    aircraftPerDayDelta7: trend(last7, prev7),
    peak: peak ? { date: peak.date, aircraft: peak.aircraft, adizSorties: peak.adizSorties, url: peak.url } : null,
    series: last30.slice(0, SERIES_DAYS).reverse().map(r => ({
      date: r.date, aircraft: r.aircraft, adizSorties: r.adizSorties, ships: r.ships, officialShips: r.officialShips, balloons: r.balloons, medianLine: r.medianLine,
    })),
  };
}

// ---------------------------------------------------------------------------
// briefing
// ---------------------------------------------------------------------------

function readStore(p) {
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return j && typeof j.reports === 'object' ? j : { reports: {} }; } catch { return { reports: {} }; }
}

function pruneStore(store) {
  const ids = Object.keys(store.reports).sort((a, b) => (store.reports[b].date || '').localeCompare(store.reports[a].date || ''));
  for (const id of ids.slice(MAX_REPORTS)) delete store.reports[id];
}

export async function briefing(opts = {}) {
  const fetchImpl = opts.fetch || safeOutboundFetch;
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const ignoreRobots = opts.ignoreRobots ?? robotsOverrideEnabled(opts.env);
  const maxDetails = opts.maxDetails ?? MAX_NEW_DETAILS;
  const delayMs = opts.delayMs ?? DETAIL_DELAY_MS;
  const persist = opts.persist !== false;

  const { loaded, metas, now } = await loadDatasets([DATASETS.list], { ...opts, fetch: fetchImpl, dataDir, stateFile: STATE_FILE, ignoreRobots });
  const list = loaded[0].text ? parseList(loaded[0].text) : [];

  const storePath = join(dataDir, REPORTS_FILE);
  const store = readStore(storePath);
  const pending = list.filter(e => !store.reports[e.id]);
  const detailMeta = {
    id: 'reports', title: 'Daily PLA activity reports', kind: 'html', url: LIST_URL, discoveryPage: LIST_URL, discovered: list.length > 0,
    status: 'error', httpStatus: null, reason: null, notes: [], fetchedAt: null, lastModified: null, etag: null,
  };
  if (ignoreRobots) detailMeta.notes.push('robots.txt override enabled by operator');

  let fetched = 0;
  let failed = 0;
  const robots = pending.length && !ignoreRobots ? await checkRobots(pending[0].url, { fetch: fetchImpl }) : { allowed: true };
  if (!robots.allowed) {
    detailMeta.reason = 'robots-disallowed';
  } else {
    for (const entry of pending.slice(0, maxDetails)) {
      if (fetched + failed > 0 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      try {
        const res = await timedFetch(fetchImpl, entry.url, { Accept: 'text/html' });
        detailMeta.httpStatus = res.status;
        if (!res.ok) { failed++; detailMeta.reason = `HTTP ${res.status}`; continue; }
        const report = parseDetail(await res.text(), entry);
        if (!report) { failed++; detailMeta.reason = 'detail page layout not recognised'; continue; }
        store.reports[entry.id] = report;
        fetched++;
        detailMeta.fetchedAt = new Date(now).toISOString();
      } catch (e) {
        failed++;
        detailMeta.reason = /abort/i.test(e?.name || e?.message) ? 'detail page timed out' : 'detail page unreachable';
      }
    }
  }
  pruneStore(store);
  if (persist && fetched) {
    try { mkdirSync(dataDir, { recursive: true }); writeFileSync(storePath, JSON.stringify(store, null, 1)); } catch { /* best-effort cache */ }
  }

  const have = Object.keys(store.reports).length;
  const remaining = pending.length - fetched;
  if (fetched) detailMeta.notes.push(`fetched ${fetched} new report${fetched === 1 ? '' : 's'}`);
  if (remaining > 0 && robots.allowed && !failed) detailMeta.notes.push(`${remaining} report${remaining === 1 ? '' : 's'} queued for later sweeps`);
  if (!have) detailMeta.status = 'error';
  else if (failed || !robots.allowed) detailMeta.status = 'stale';
  else detailMeta.status = fetched ? 'ok' : 'not_modified';
  if (detailMeta.status !== 'error') detailMeta.reason = detailMeta.reason && (failed || !robots.allowed) ? detailMeta.reason : null;
  if (!have && !detailMeta.reason) detailMeta.reason = list.length ? 'no reports fetched yet' : 'list page unavailable';

  const allMetas = [...metas, { ...detailMeta, rows: have }];
  // robots.txt gating with nothing cached is a policy state, not an outage: report it as `blocked`
  // (degraded in source health) so it never counts as a failed source.
  let status = rollupStatus(allMetas);
  if (status === 'error' && allMetas[0].reason === 'robots-disallowed') status = 'blocked';
  const out = {
    source: SOURCE,
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: ATTRIBUTION,
    siteUrl: LIST_URL,
    robotsOverride: ignoreRobots,
    datasets: allMetas,
    listing: list.slice(0, 10),
    activity: summarize(store.reports),
  };
  const err = errorSummary(allMetas);
  if (status === 'blocked') out.message = `mnd.gov.tw robots.txt disallows crawlers; set PLAMND_ROBOTS_OVERRIDE=1 to opt in (${err})`;
  else if (err) out.error = err;
  return out;
}
