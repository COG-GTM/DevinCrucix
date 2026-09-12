// CBP Enforcement Statistics — official CSV downloads published by U.S. Customs and
// Border Protection (public domain, U.S. Government work).
//
//   Encounters by Area of Responsibility (sector / field office) and month:
//     discovery page  https://www.cbp.gov/document/stats/nationwide-encounters
//     file pattern    /sites/default/files/<YYYY-MM>/nationwide-encounters-fy23-fy26-<mon>-aor.csv
//   Drug seizures by AOR, drug type and month:
//     discovery page  https://www.cbp.gov/document/stats/nationwide-drug-seizures
//     file pattern    /sites/default/files/<YYYY-MM>/nationwide-drugs-fy23-fy26-<mon>.csv
//
// The exact file names change every month (the month suffix moves), so each sweep first reads
// the official document page and picks the newest CSV link, falling back to the last verified
// URL if the page is unreachable. Discovery, robots.txt, conditional download, disk cache and
// layout validation live in cbpcommon.mjs and are shared with the other CBP portal adapters
// (cbpseizures, cbpforce, cbpcustody). See that module for the WAF / Node-fetch caveat.

import {
  DEFAULT_DATA_DIR, ORIGIN, SERIES_MONTHS, ATTRIBUTION, SW_SECTORS, SW_FIELD_OFFICES,
  parseCsv, csvRecords, headerMatches, fiscalYear, periodOf, periodLabel, shiftPeriod, num, pctChange, round1, lastN, bump, top, titleCase, anchors,
  discoverCsvUrl, loadDatasets, errorSummary,
} from './cbpcommon.mjs';

export { DEFAULT_DATA_DIR, SW_SECTORS, parseCsv, csvRecords, headerMatches, fiscalYear, periodOf, shiftPeriod, discoverCsvUrl };
export const PIPELINE_VERSION = 'cbpstats/1.1.0';

// Verified 2026-09-06 (HTTP 200 via Node fetch). Used only when the discovery page cannot be read.
export const DATASETS = {
  encounters: {
    id: 'encounters',
    title: 'Encounters by Area of Responsibility',
    discoveryPage: `${ORIGIN}/document/stats/nationwide-encounters`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/nationwide-encounters-fy\d{2}-fy\d{2}-[a-z]{3}-aor[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv`,
    expectedHeader: ['Fiscal Year', 'Month Grouping', 'Month (abbv)', 'Component', 'Land Border Region', 'Area of Responsibility', 'AOR (Abbv)', 'Demographic', 'Citizenship', 'Title of Authority', 'Encounter Type', 'Encounter Count'],
    cacheFile: 'encounters-aor.csv',
  },
  drugs: {
    id: 'drugs',
    title: 'Drug Seizures by Area of Responsibility',
    discoveryPage: `${ORIGIN}/document/stats/nationwide-drug-seizures`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/nationwide-drugs-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/nationwide-drugs-fy23-fy26-jul.csv`,
    expectedHeader: ['FY', 'Month (abbv)', 'Component', 'Region', 'Land Filter', 'Area of Responsibility', 'Drug Type', 'Count of Event', 'Sum Qty (lbs)'],
    cacheFile: 'drugs.csv',
  },
};

// ---------------------------------------------------------------------------
// Aggregation — Southwest land border only.
// ---------------------------------------------------------------------------

export function summarizeEncounters(records) {
  const sw = records.filter(r => r['Land Border Region'] === 'Southwest Land Border');
  const periods = new Set();
  const total = new Map(); // period -> { total, usbp, ofo }
  const bySector = new Map(); // aor -> Map(period -> count)
  const latestBuckets = { demographic: new Map(), encounterType: new Map(), citizenship: new Map(), authority: new Map() };

  for (const r of sw) {
    const p = periodOf(r['Fiscal Year'], r['Month (abbv)']);
    if (!p) continue;
    const n = num(r['Encounter Count']);
    periods.add(p);
    const t = total.get(p) || { total: 0, usbp: 0, ofo: 0 };
    t.total += n;
    if (r.Component === 'U.S. Border Patrol') t.usbp += n; else t.ofo += n;
    total.set(p, t);
    const aor = r['Area of Responsibility'];
    if (!bySector.has(aor)) bySector.set(aor, new Map());
    const s = bySector.get(aor);
    s.set(p, (s.get(p) || 0) + n);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, prev, yoy } = anchors(sorted);
  const series = lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), ...total.get(p) }));

  for (const r of sw) {
    if (periodOf(r['Fiscal Year'], r['Month (abbv)']) !== latest) continue;
    const n = num(r['Encounter Count']);
    bump(latestBuckets.demographic, r.Demographic, n);
    bump(latestBuckets.encounterType, r['Encounter Type'], n);
    bump(latestBuckets.citizenship, r.Citizenship, n);
    bump(latestBuckets.authority, r['Title of Authority'], n);
  }

  const sectors = SW_SECTORS.map(def => {
    const s = bySector.get(def.aor) || new Map();
    const cur = s.get(latest) || 0;
    return {
      ...def,
      latest: cur,
      previous: prev ? (s.get(prev) || 0) : null,
      momPct: prev ? pctChange(cur, s.get(prev) || 0) : null,
      yoyPct: yoy ? pctChange(cur, s.get(yoy) || 0) : null,
      series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, count: s.get(p) || 0 })),
    };
  }).sort((a, b) => b.latest - a.latest);
  const fieldOffices = SW_FIELD_OFFICES.map(aor => ({ aor, latest: bySector.get(aor)?.get(latest) || 0 })).sort((a, b) => b.latest - a.latest);

  const cur = total.get(latest);
  return {
    region: 'Southwest Land Border',
    rows: sw.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: {
      period: latest, label: periodLabel(latest), ...cur,
      momPct: prev ? pctChange(cur.total, total.get(prev).total) : null,
      yoyPct: yoy ? pctChange(cur.total, total.get(yoy).total) : null,
    },
    series,
    sectors,
    fieldOffices,
    demographic: top(latestBuckets.demographic),
    encounterType: top(latestBuckets.encounterType),
    authority: top(latestBuckets.authority),
    citizenship: top(latestBuckets.citizenship, 10),
  };
}

export function summarizeDrugs(records) {
  const sw = records.filter(r => r.Region === 'Southwest Border');
  const periods = new Set();
  const byType = new Map(); // drug -> Map(period -> { events, lbs })
  const totals = new Map(); // period -> { events, lbs }
  const byAor = new Map(); // aor -> { events, lbs } for latest month (filled after)

  for (const r of sw) {
    const p = periodOf(r.FY, r['Month (abbv)']);
    if (!p) continue;
    periods.add(p);
    const ev = num(r['Count of Event']);
    const lbs = num(r['Sum Qty (lbs)']);
    const t = totals.get(p) || { events: 0, lbs: 0 };
    t.events += ev; t.lbs += lbs; totals.set(p, t);
    const type = r['Drug Type'];
    if (!byType.has(type)) byType.set(type, new Map());
    const m = byType.get(type);
    const c = m.get(p) || { events: 0, lbs: 0 };
    c.events += ev; c.lbs += lbs; m.set(p, c);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, prev, yoy } = anchors(sorted);

  for (const r of sw) {
    if (periodOf(r.FY, r['Month (abbv)']) !== latest) continue;
    const aor = titleCase(r['Area of Responsibility']);
    const c = byAor.get(aor) || { aor, events: 0, lbs: 0 };
    c.events += num(r['Count of Event']); c.lbs += num(r['Sum Qty (lbs)']);
    byAor.set(aor, c);
  }

  const drugs = [...byType.entries()].map(([type, m]) => {
    const cur = m.get(latest) || { events: 0, lbs: 0 };
    const pv = prev ? (m.get(prev) || { events: 0, lbs: 0 }) : null;
    const yy = yoy ? (m.get(yoy) || { events: 0, lbs: 0 }) : null;
    return {
      type,
      latest: { events: cur.events, lbs: round1(cur.lbs) },
      momLbsPct: pv ? pctChange(cur.lbs, pv.lbs) : null,
      yoyLbsPct: yy ? pctChange(cur.lbs, yy.lbs) : null,
      series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, lbs: round1(m.get(p)?.lbs || 0), events: m.get(p)?.events || 0 })),
    };
  }).sort((a, b) => b.latest.lbs - a.latest.lbs);

  const cur = totals.get(latest);
  return {
    region: 'Southwest Border',
    rows: sw.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: { period: latest, label: periodLabel(latest), events: cur.events, lbs: round1(cur.lbs), momLbsPct: prev ? pctChange(cur.lbs, totals.get(prev).lbs) : null, yoyLbsPct: yoy ? pctChange(cur.lbs, totals.get(yoy).lbs) : null },
    series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), events: totals.get(p).events, lbs: round1(totals.get(p).lbs) })),
    drugs,
    byAor: [...byAor.values()].map(a => ({ ...a, lbs: round1(a.lbs) })).sort((a, b) => b.lbs - a.lbs),
  };
}

// ---------------------------------------------------------------------------
// Briefing entry point
// ---------------------------------------------------------------------------

export async function briefing(opts = {}) {
  const { loaded, metas, status, now } = await loadDatasets([DATASETS.encounters, DATASETS.drugs], opts);
  const [enc, drg] = loaded;
  const encounters = enc.records.length ? summarizeEncounters(enc.records) : null;
  const drugs = drg.records.length ? summarizeDrugs(drg.records) : null;

  const out = {
    source: 'CBPStats',
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: ATTRIBUTION,
    datasets: metas,
    encounters,
    drugs,
  };
  const err = errorSummary(metas);
  if (err) out.error = err;
  return out;
}
