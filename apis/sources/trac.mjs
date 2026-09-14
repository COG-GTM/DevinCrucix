// TRAC Immigration — ICE detention Quick Facts (Transactional Records Access Clearinghouse,
// Syracuse University). The Quick Facts pages are Vue apps fed by four static JSON files that
// TRAC regenerates from each ICE detention-statistics release (roughly biweekly, lagging ICE by
// a few weeks):
//
//   pop_agen_table.json               detained population by arresting agency (ICE / CBP) and
//                                     criminal-history bucket (convicted / pending / no record)
//   book_in_agen_program_table.json   monthly book-ins by arresting agency (since FY2019)
//   facilities.json                   every facility holding ICE detainees: city/state/zip, type,
//                                     average daily population, guaranteed-minimum beds
//   atd_pop_table.json                Alternatives to Detention enrolment by AOR and technology
//
// Each file is a full history keyed by `download_date` (MM/DD/YYYY, the ICE release TRAC read),
// so only the newest snapshot is summarized and the rest is a time series. The files are fetched
// conditionally (ETag / Last-Modified) through the shared CBP loader and cached under runs/trac/;
// a TRAC outage degrades to "stale". Nothing is geocoded: the facilities layer is aggregated to
// state centroids so the browser payload stays a few KB regardless of how many facilities exist.
//
// Terms: TRAC data are © TRAC Reports, Inc. and are published for public use with attribution
// ("Source: TRAC, Syracuse University"); they are not U.S. Government works, so no public-domain
// claim is made. All strings below are third-party and must be escaped by the frontend.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatasets, errorSummary, pctChange } from './cbpcommon.mjs';

export const SOURCE = 'TRAC';
export const PIPELINE_VERSION = 'trac/1.0.0';
export const ORIGIN = 'https://tracreports.org';
export const SITE_URL = `${ORIGIN}/immigration/`;
export const QUICKFACTS_URL = `${ORIGIN}/immigration/quickfacts/`;
export const ATTRIBUTION = 'Source: TRAC (Transactional Records Access Clearinghouse), Syracuse University — tracreports.org. Data derived from ICE detention statistics releases; figures lag ICE publication and are subject to revision. © TRAC Reports, Inc.; not endorsed by TRAC.';
const STATE_FILE = 'state-trac.json';
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../runs/trac');

const POP_SNAPSHOTS = 26;   // ~one year of biweekly snapshots
const BOOKIN_MONTHS = 13;   // latest complete month plus the same month a year earlier
const TOP_FACILITIES = 15;
const TOP_AORS = 10;
const ATD_SNAPSHOTS = 13;
const MAX_STR = 120;

const isArrayOf = (v, keys) => Array.isArray(v) && v.length > 0 && keys.every(k => k in v[0]);
const validateRows = (keys, label) => v => (isArrayOf(v, keys) ? null : `unexpected ${label} layout: ${Array.isArray(v) ? Object.keys(v[0] || {}).join(',').slice(0, 160) : typeof v}`);

export const DATASETS = {
  population: {
    id: 'population', kind: 'json', publisher: 'TRAC', title: 'Detained population by agency and criminal history',
    pageUrl: `${ORIGIN}/immigration/detentionstats/pop_agen_table.json`, cacheFile: 'pop_agen_table.json',
    validate: validateRows(['date', 'ice_all', 'cbp_all', 'total_all', 'total_conv', 'total_pend', 'total_other'], 'population'),
  },
  bookins: {
    id: 'bookins', kind: 'json', publisher: 'TRAC', title: 'Monthly book-ins by arresting agency',
    pageUrl: `${ORIGIN}/immigration/detentionstats/book_in_agen_program_table.json`, cacheFile: 'book_in_agen_program_table.json',
    validate: validateRows(['download_date', 'period_date', 'ice', 'cbp', 'total', 'monstr'], 'book-ins'),
  },
  facilities: {
    id: 'facilities', kind: 'json', publisher: 'TRAC', title: 'Detention facilities (average daily population)',
    pageUrl: `${ORIGIN}/immigration/detentionstats/facilities.json`, cacheFile: 'facilities.json',
    validate: validateRows(['name', 'detention_facility_city', 'detention_facility_state', 'type_detailed', 'count', 'download_date'], 'facilities'),
  },
  atd: {
    id: 'atd', kind: 'json', publisher: 'TRAC', title: 'Alternatives to Detention by AOR and technology',
    pageUrl: `${ORIGIN}/immigration/detentionstats/atd_pop_table.json`, cacheFile: 'atd_pop_table.json',
    validate: validateRows(['aor', 'atd_technology', 'count_num', 'download_date'], 'ATD'),
  },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const str = (v, n = MAX_STR) => String(v ?? '').trim().slice(0, n);
const int = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return String(v ?? '').trim() === '' || !Number.isFinite(n) ? null : n;
};
const num1 = v => { const n = int(v); return n == null ? null : Math.round(n * 10) / 10; };

// TRAC dates are MM/DD/YYYY; normalize to ISO so sorting is lexical.
export function isoDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// '01JUL26' → '2026-07'
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
export function isoMonth(periodDate) {
  const m = /^\d{2}([A-Z]{3})(\d{2})$/.exec(String(periodDate || '').trim().toUpperCase());
  if (!m || !MON[m[1]]) return null;
  return `20${m[2]}-${MON[m[1]]}`;
}

const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const share = (part, whole) => (Number.isFinite(part) && Number.isFinite(whole) && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function latestDate(rows, key) {
  let best = null;
  for (const r of rows) { const d = isoDate(r[key]); if (d && (!best || d > best)) best = d; }
  return best;
}

// ---------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------

export function summarizePopulation(rows) {
  const snaps = rows.map(r => ({
    date: isoDate(r.date), total: int(r.total_all), ice: int(r.ice_all), cbp: int(r.cbp_all),
    convicted: int(r.total_conv), pending: int(r.total_pend), noRecord: int(r.total_other),
  })).filter(s => s.date && s.total != null).sort((a, b) => a.date.localeCompare(b.date));
  if (!snaps.length) return null;
  const latest = snaps[snaps.length - 1];
  const previous = snaps[snaps.length - 2] || null;
  const yearAgo = [...snaps].reverse().find(s => daysBetween(latest.date, s.date) >= 350) || null;
  return {
    asOf: latest.date,
    snapshots: snaps.length,
    latest: {
      ...latest,
      icePct: share(latest.ice, latest.total),
      convictedPct: share(latest.convicted, latest.total),
      pendingPct: share(latest.pending, latest.total),
      noRecordPct: share(latest.noRecord, latest.total),
      noConvictionPct: share((latest.pending ?? 0) + (latest.noRecord ?? 0), latest.total),
    },
    previous: previous ? { date: previous.date, total: previous.total, changePct: pctChange(latest.total, previous.total) } : null,
    yearAgo: yearAgo ? { date: yearAgo.date, total: yearAgo.total, changePct: pctChange(latest.total, yearAgo.total) } : null,
    series: snaps.slice(-POP_SNAPSHOTS),
  };
}

export function summarizeBookIns(rows) {
  const months = rows.map(r => ({
    month: isoMonth(r.period_date), label: str(r.monstr, 8), total: int(r.total), ice: int(r.ice), cbp: int(r.cbp),
    latestComplete: Number(r.f_latest_period) === 1, releasedOn: isoDate(r.download_date),
  })).filter(m => m.month).sort((a, b) => a.month.localeCompare(b.month));
  const reported = months.filter(m => m.total != null && m.total > 0 && (m.ice != null || m.cbp != null));
  if (!reported.length) return null;
  const flagged = reported.find(m => m.latestComplete);
  const latest = flagged || reported[reported.length - 1];
  const complete = reported.filter(m => m.month <= latest.month);
  const partial = reported.filter(m => m.month > latest.month).map(m => ({ month: m.month, label: m.label, total: m.total, ice: m.ice, cbp: m.cbp }));
  const yearAgo = complete.find(m => m.month === `${Number(latest.month.slice(0, 4)) - 1}${latest.month.slice(4)}`) || null;
  const prev = complete[complete.length - 2] || null;
  return {
    asOf: latestDate(rows, 'download_date'),
    latest: { month: latest.month, label: latest.label, total: latest.total, ice: latest.ice, cbp: latest.cbp, icePct: share(latest.ice, latest.total) },
    momPct: prev ? pctChange(latest.total, prev.total) : null,
    yoyPct: yearAgo ? pctChange(latest.total, yearAgo.total) : null,
    partial: partial.slice(0, 2),
    series: complete.slice(-BOOKIN_MONTHS).map(m => ({ month: m.month, label: m.label, total: m.total, ice: m.ice, cbp: m.cbp })),
  };
}

// Approximate geographic centres for the facilities layer (state-level aggregation only).
export const STATE_CENTROIDS = {
  AL: [32.8, -86.8], AK: [64.7, -152.3], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.5], CO: [39.0, -105.5],
  CT: [41.6, -72.7], DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3],
  ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3],
  LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3],
  MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
  OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.6], SC: [33.9, -80.9], SD: [44.4, -100.2],
  TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5],
  WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43.0, -107.6], PR: [18.2, -66.5], GU: [13.4, 144.8], VI: [18.3, -64.9],
  MP: [15.2, 145.8], AS: [-14.3, -170.7],
};

export function summarizeFacilities(rows) {
  const asOf = latestDate(rows, 'download_date');
  if (!asOf) return null;
  const snap = rows.filter(r => isoDate(r.download_date) === asOf);
  const totalRow = snap.find(r => /^total$/i.test(str(r.name)) && !str(r.detention_facility_state));
  const facilities = snap
    .filter(r => r !== totalRow && str(r.name))
    .map(r => ({
      name: str(r.name, 80), city: str(r.detention_facility_city, 40), state: str(r.detention_facility_state, 2).toUpperCase(),
      type: str(r.type_detailed, 12) || 'UNKNOWN', count: int(r.count) ?? 0, guaranteedMin: int(r.guaranteed_min_num),
    }));
  const sum = (arr, k) => arr.reduce((a, f) => a + (f[k] ?? 0), 0);
  const group = (key) => {
    const m = new Map();
    for (const f of facilities) {
      const k = f[key] || 'UNKNOWN';
      const g = m.get(k) || { [key]: k, facilities: 0, detainees: 0, guaranteedMin: 0 };
      g.facilities += 1; g.detainees += f.count; g.guaranteedMin += f.guaranteedMin ?? 0;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.detainees - a.detainees);
  };
  const byState = group('state').map(g => {
    const c = STATE_CENTROIDS[g.state];
    return { ...g, lat: c ? c[0] : null, lon: c ? c[1] : null, sharePct: share(g.detainees, sum(facilities, 'count')) };
  });
  return {
    asOf,
    total: int(totalRow?.count) ?? sum(facilities, 'count'),
    guaranteedMin: int(totalRow?.guaranteed_min_num) ?? sum(facilities, 'guaranteedMin'),
    facilities: facilities.length,
    withGuaranteedMin: facilities.filter(f => (f.guaranteedMin ?? 0) > 0).length,
    byType: group('type'),
    byState,
    top: [...facilities].sort((a, b) => b.count - a.count).slice(0, TOP_FACILITIES),
  };
}

export function summarizeAtd(rows) {
  const dates = [...new Set(rows.map(r => isoDate(r.download_date)).filter(Boolean))].sort();
  if (!dates.length) return null;
  const asOf = dates[dates.length - 1];
  const snap = rows.filter(r => isoDate(r.download_date) === asOf);
  const totalRow = snap.find(r => !str(r.aor) && /^total$/i.test(str(r.atd_technology)));
  const perAor = snap.filter(r => str(r.aor) && !/^(all|total)$/i.test(str(r.atd_technology)));
  const tech = new Map();
  for (const r of perAor) {
    const k = str(r.atd_technology, 24);
    tech.set(k, (tech.get(k) || 0) + (int(r.count_num) ?? 0));
  }
  const total = int(totalRow?.count_num) ?? [...tech.values()].reduce((a, b) => a + b, 0);
  const aors = snap.filter(r => str(r.aor) && /^all$/i.test(str(r.atd_technology)))
    .map(r => ({ aor: str(r.aor, 40), count: int(r.count_num) ?? 0, avgDays: num1(r.alip_num) }))
    .sort((a, b) => b.count - a.count);
  const series = dates.slice(-ATD_SNAPSHOTS).map(d => {
    const t = rows.find(r => isoDate(r.download_date) === d && !str(r.aor) && /^total$/i.test(str(r.atd_technology)));
    return { date: d, total: int(t?.count_num) };
  }).filter(s => s.total != null);
  return {
    asOf, total, avgDays: num1(totalRow?.alip_num),
    yearAgo: (() => { const y = [...series].reverse().find(s => daysBetween(asOf, s.date) >= 350); return y ? { date: y.date, total: y.total, changePct: pctChange(total, y.total) } : null; })(),
    byTech: [...tech.entries()].map(([technology, count]) => ({ technology, count, sharePct: share(count, total) })).sort((a, b) => b.count - a.count),
    topAors: aors.slice(0, TOP_AORS),
    aors: aors.length,
    series,
  };
}

// ---------------------------------------------------------------------------
// briefing
// ---------------------------------------------------------------------------

export async function briefing(opts = {}) {
  const { loaded, metas, status, now } = await loadDatasets(
    [DATASETS.population, DATASETS.bookins, DATASETS.facilities, DATASETS.atd],
    { ...opts, dataDir: opts.dataDir || DEFAULT_DATA_DIR, stateFile: STATE_FILE }
  );
  const [pop, book, fac, atd] = loaded;
  const out = {
    source: SOURCE,
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: ATTRIBUTION,
    siteUrl: QUICKFACTS_URL,
    datasets: metas,
    population: pop.records.length ? summarizePopulation(pop.records) : null,
    bookIns: book.records.length ? summarizeBookIns(book.records) : null,
    facilities: fac.records.length ? summarizeFacilities(fac.records) : null,
    atd: atd.records.length ? summarizeAtd(atd.records) : null,
  };
  const err = errorSummary(metas);
  if (err) out.error = err;
  return out;
}
