// CBP Seizures — three official CSVs from the CBP Public Data Portal that sit next to the
// nationwide drug-seizure file already ingested by cbpstats.mjs:
//
//   AMO drug seizures (Air and Marine Operations, by branch / region / drug type / month)
//     discovery page  https://www.cbp.gov/document/stats/amo-drug-seizures
//     file pattern    /sites/default/files/<YYYY-MM>/amo-drug-seizures-fy23-fy26-<mon>.csv
//   Currency and other monetary instrument seizures (OFO + USBP, by AOR / direction / month)
//     discovery page  https://www.cbp.gov/document/stats/currency-and-other-monetary-instrument-seizures
//     file pattern    /sites/default/files/<YYYY-MM>/currency-seizures-fy23-fy26-<mon>[_n].csv
//   Weapons and ammunition seizures (one row per event × category; direction, mode, AOR)
//     discovery page  https://www.cbp.gov/document/stats/weapons-and-ammunition-seizures
//     file pattern    /sites/default/files/<YYYY-MM>/weapons-ammunition-seizures-fy23-fy26-<mon>.csv
//
// Analytic intent: AMO is the maritime/air interdiction picture (cocaine off Puerto Rico and the
// Gulf, marijuana loads over the Southwest), currency is the bulk-cash leg of the same logistics
// chain, and OUTBOUND weapons/ammunition at Southwest ports are the guns going south to the
// cartels. All three are summarized nationwide with a Southwest-border cut so they can be read
// against encounters and drug seizures for the same sector / field office.
//
// Discovery, robots.txt, conditional download, disk cache and header validation are shared with
// the other CBP adapters in cbpcommon.mjs.

import {
  ORIGIN, SERIES_MONTHS, ATTRIBUTION,
  periodOf, periodLabel, num, pctChange, round1, lastN, bump, top, titleCase, anchors,
  loadDatasets, errorSummary,
} from './cbpcommon.mjs';

export const PIPELINE_VERSION = 'cbpseizures/1.0.0';
const STATE_FILE = 'state-seizures.json';

// Fallback URLs verified 2026-09-11 (HTTP 200 via Node fetch); used only when the discovery page cannot be read.
export const DATASETS = {
  amo: {
    id: 'amo',
    title: 'AMO Drug Seizures',
    discoveryPage: `${ORIGIN}/document/stats/amo-drug-seizures`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/amo-drug-seizures-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/amo-drug-seizures-fy23-fy26-jul.csv`,
    expectedHeader: ['FY', 'Month (abbv)', 'Component', 'Region', 'Land Filter', 'Branch', 'Drug Type', 'Count of Event', 'Sum Qty (lbs)'],
    cacheFile: 'amo-drugs.csv',
  },
  currency: {
    id: 'currency',
    title: 'Currency and Other Monetary Instrument Seizures',
    discoveryPage: `${ORIGIN}/document/stats/currency-and-other-monetary-instrument-seizures`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/currency-seizures-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/currency-seizures-fy23-fy26-jul.csv`,
    expectedHeader: ['Fiscal Year', 'Month (abbv)', 'Component', 'Region', 'Land Filter', 'Area of Responsibility', 'Inbound/Outbound', 'Count of Seizure Events', 'Currency Seizures Amount (USD)'],
    cacheFile: 'currency.csv',
  },
  weapons: {
    id: 'weapons',
    title: 'Weapons and Ammunition Seizures',
    discoveryPage: `${ORIGIN}/document/stats/weapons-and-ammunition-seizures`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/weapons-ammunition-seizures-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/weapons-ammunition-seizures-fy23-fy26-jul.csv`,
    expectedHeader: ['Fiscal Year', 'Month (abbv)', 'Component', 'Region', 'Area of Responsibility', 'Inbound/Outbound', 'Mode of Transportation', 'Seizure Type', 'Category', 'Event ID', 'Quantity Seized'],
    cacheFile: 'weapons.csv',
  },
};

const SW = 'Southwest Border';

// ---------------------------------------------------------------------------
// AMO drug seizures — nationwide, with region and branch cuts
// ---------------------------------------------------------------------------

export function summarizeAmo(records) {
  const periods = new Set();
  const totals = new Map(); // period -> { events, lbs, swLbs }
  const byType = new Map(); // drug -> Map(period -> { events, lbs })
  for (const r of records) {
    const p = periodOf(r.FY, r['Month (abbv)']);
    if (!p) continue;
    periods.add(p);
    const ev = num(r['Count of Event']);
    const lbs = num(r['Sum Qty (lbs)']);
    const t = totals.get(p) || { events: 0, lbs: 0, swLbs: 0 };
    t.events += ev; t.lbs += lbs; if (r.Region === SW) t.swLbs += lbs;
    totals.set(p, t);
    const type = r['Drug Type'];
    if (!byType.has(type)) byType.set(type, new Map());
    const m = byType.get(type);
    const c = m.get(p) || { events: 0, lbs: 0 };
    c.events += ev; c.lbs += lbs; m.set(p, c);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, prev, yoy } = anchors(sorted);

  const regions = new Map(); // region -> { events, lbs }
  const branches = new Map(); // branch -> { events, lbs }
  for (const r of records) {
    if (periodOf(r.FY, r['Month (abbv)']) !== latest) continue;
    const ev = num(r['Count of Event']);
    const lbs = num(r['Sum Qty (lbs)']);
    const reg = regions.get(r.Region) || { region: r.Region, events: 0, lbs: 0 };
    reg.events += ev; reg.lbs += lbs; regions.set(r.Region, reg);
    const b = branches.get(r.Branch) || { branch: r.Branch, region: r.Region, events: 0, lbs: 0 };
    b.events += ev; b.lbs += lbs; branches.set(r.Branch, b);
  }

  const drugs = [...byType.entries()].map(([type, m]) => {
    const cur = m.get(latest) || { events: 0, lbs: 0 };
    const pv = prev ? (m.get(prev) || { lbs: 0 }) : null;
    const yy = yoy ? (m.get(yoy) || { lbs: 0 }) : null;
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
    region: 'Nationwide (AMO)',
    rows: records.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: {
      period: latest, label: periodLabel(latest), events: cur.events, lbs: round1(cur.lbs), swLbs: round1(cur.swLbs),
      momLbsPct: prev ? pctChange(cur.lbs, totals.get(prev).lbs) : null,
      yoyLbsPct: yoy ? pctChange(cur.lbs, totals.get(yoy).lbs) : null,
    },
    series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), events: totals.get(p).events, lbs: round1(totals.get(p).lbs), swLbs: round1(totals.get(p).swLbs) })),
    drugs,
    regions: [...regions.values()].map(a => ({ ...a, lbs: round1(a.lbs) })).sort((a, b) => b.lbs - a.lbs),
    branches: [...branches.values()].map(a => ({ ...a, lbs: round1(a.lbs) })).sort((a, b) => b.lbs - a.lbs).slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Currency seizures — nationwide USD + events, Southwest cut, direction and AOR
// ---------------------------------------------------------------------------

export function summarizeCurrency(records) {
  const periods = new Set();
  const totals = new Map(); // period -> { events, usd, swEvents, swUsd }
  for (const r of records) {
    const p = periodOf(r['Fiscal Year'], r['Month (abbv)']);
    if (!p) continue;
    periods.add(p);
    const ev = num(r['Count of Seizure Events']);
    const usd = num(r['Currency Seizures Amount (USD)']);
    const t = totals.get(p) || { events: 0, usd: 0, swEvents: 0, swUsd: 0 };
    t.events += ev; t.usd += usd;
    if (r.Region === SW) { t.swEvents += ev; t.swUsd += usd; }
    totals.set(p, t);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, prev, yoy } = anchors(sorted);

  const direction = new Map(); // Inbound / Outbound / Other -> usd
  const directionEvents = new Map();
  const byAor = new Map();
  const components = new Map();
  for (const r of records) {
    if (periodOf(r['Fiscal Year'], r['Month (abbv)']) !== latest) continue;
    const ev = num(r['Count of Seizure Events']);
    const usd = num(r['Currency Seizures Amount (USD)']);
    bump(direction, r['Inbound/Outbound'], usd);
    bump(directionEvents, r['Inbound/Outbound'], ev);
    bump(components, r.Component, usd);
    const aor = titleCase(r['Area of Responsibility']);
    const a = byAor.get(aor) || { aor, region: r.Region, events: 0, usd: 0 };
    a.events += ev; a.usd += usd; byAor.set(aor, a);
  }

  const cur = totals.get(latest);
  const rnd = x => Math.round(x);
  return {
    region: 'Nationwide',
    rows: records.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: {
      period: latest, label: periodLabel(latest), events: cur.events, usd: rnd(cur.usd), swEvents: cur.swEvents, swUsd: rnd(cur.swUsd),
      momUsdPct: prev ? pctChange(cur.usd, totals.get(prev).usd) : null,
      yoyUsdPct: yoy ? pctChange(cur.usd, totals.get(yoy).usd) : null,
    },
    series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), events: totals.get(p).events, usd: rnd(totals.get(p).usd), swUsd: rnd(totals.get(p).swUsd) })),
    direction: top(direction).map(d => ({ key: d.key, usd: rnd(d.count), events: directionEvents.get(d.key) || 0 })),
    components: top(components).map(c => ({ key: c.key, usd: rnd(c.count) })),
    byAor: [...byAor.values()].map(a => ({ ...a, usd: rnd(a.usd) })).sort((a, b) => b.usd - a.usd).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Weapons and ammunition — distinct events per month, quantities by type/category, direction
// ---------------------------------------------------------------------------

export function summarizeWeapons(records) {
  const periods = new Set();
  const eventIds = new Map(); // period -> Set(eventId)
  const swEventIds = new Map();
  const qty = new Map(); // period -> { weapons, ammoParts }
  const key = r => `${r['Fiscal Year']}|${r['Month (abbv)']}`;
  const periodCache = new Map();
  const periodFor = r => {
    const k = key(r);
    if (!periodCache.has(k)) periodCache.set(k, periodOf(r['Fiscal Year'], r['Month (abbv)']));
    return periodCache.get(k);
  };
  for (const r of records) {
    const p = periodFor(r);
    if (!p) continue;
    periods.add(p);
    if (!eventIds.has(p)) { eventIds.set(p, new Set()); swEventIds.set(p, new Set()); qty.set(p, { weapons: 0, ammoParts: 0 }); }
    eventIds.get(p).add(r['Event ID']);
    if (r.Region === SW) swEventIds.get(p).add(r['Event ID']);
    const q = qty.get(p);
    if (r['Seizure Type'] === 'Weapons') q.weapons += num(r['Quantity Seized']); else q.ammoParts += num(r['Quantity Seized']);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, prev, yoy } = anchors(sorted);

  const direction = new Map(); // INBOUND / OUTBOUND / OTHER -> Set(eventId)
  const categories = new Map(); // category -> qty
  const modes = new Map(); // mode -> Set(eventId)
  const byAor = new Map(); // aor -> { events:Set, weapons, ammoParts, outbound:Set }
  for (const r of records) {
    if (periodFor(r) !== latest) continue;
    const id = r['Event ID'];
    const dir = titleCase(r['Inbound/Outbound']);
    if (!direction.has(dir)) direction.set(dir, new Set());
    direction.get(dir).add(id);
    if (!modes.has(r['Mode of Transportation'])) modes.set(r['Mode of Transportation'], new Set());
    modes.get(r['Mode of Transportation']).add(id);
    bump(categories, r.Category, num(r['Quantity Seized']));
    const aor = r['Area of Responsibility'];
    const a = byAor.get(aor) || { aor, region: r.Region, component: r.Component, events: new Set(), outbound: new Set(), weapons: 0, ammoParts: 0 };
    a.events.add(id);
    if (dir === 'Outbound') a.outbound.add(id);
    if (r['Seizure Type'] === 'Weapons') a.weapons += num(r['Quantity Seized']); else a.ammoParts += num(r['Quantity Seized']);
    byAor.set(aor, a);
  }

  const events = p => eventIds.get(p)?.size || 0;
  const cur = qty.get(latest);
  return {
    region: 'Nationwide',
    rows: records.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: {
      period: latest, label: periodLabel(latest), events: events(latest), swEvents: swEventIds.get(latest)?.size || 0,
      weapons: Math.round(cur.weapons), ammoParts: Math.round(cur.ammoParts),
      momEventsPct: prev ? pctChange(events(latest), events(prev)) : null,
      yoyEventsPct: yoy ? pctChange(events(latest), events(yoy)) : null,
      outboundEvents: direction.get('Outbound')?.size || 0,
    },
    series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), events: events(p), swEvents: swEventIds.get(p)?.size || 0, weapons: Math.round(qty.get(p).weapons), ammoParts: Math.round(qty.get(p).ammoParts) })),
    direction: [...direction.entries()].map(([k, s]) => ({ key: k, events: s.size })).sort((a, b) => b.events - a.events),
    modes: [...modes.entries()].map(([k, s]) => ({ key: k, events: s.size })).sort((a, b) => b.events - a.events),
    categories: top(categories).map(c => ({ key: c.key, qty: Math.round(c.count) })),
    byAor: [...byAor.values()].map(a => ({ aor: a.aor, region: a.region, component: a.component, events: a.events.size, outboundEvents: a.outbound.size, weapons: Math.round(a.weapons), ammoParts: Math.round(a.ammoParts) }))
      .sort((a, b) => b.events - a.events).slice(0, 10),
    swByAor: [...byAor.values()].filter(a => a.region === SW).map(a => ({ aor: a.aor, component: a.component, events: a.events.size, outboundEvents: a.outbound.size, weapons: Math.round(a.weapons), ammoParts: Math.round(a.ammoParts) }))
      .sort((a, b) => b.events - a.events).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Briefing entry point
// ---------------------------------------------------------------------------

export async function briefing(opts = {}) {
  const { loaded, metas, status, now } = await loadDatasets([DATASETS.amo, DATASETS.currency, DATASETS.weapons], { ...opts, stateFile: STATE_FILE });
  const [amo, cur, wpn] = loaded;
  const out = {
    source: 'CBPSeizures',
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: ATTRIBUTION,
    datasets: metas,
    amo: amo.records.length ? summarizeAmo(amo.records) : null,
    currency: cur.records.length ? summarizeCurrency(cur.records) : null,
    weapons: wpn.records.length ? summarizeWeapons(wpn.records) : null,
  };
  const err = errorSummary(metas);
  if (err) out.error = err;
  return out;
}
