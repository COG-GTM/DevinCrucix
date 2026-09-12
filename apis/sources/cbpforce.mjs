// CBP Officer Safety — assaults on CBP personnel and CBP use-of-force incidents, four official
// CSVs from the CBP Public Data Portal (one row per incident × officer/agent or × type):
//
//   Assault incidents and officers/agents assaulted
//     discovery page  https://www.cbp.gov/document/stats/assault-incidents-and-officers/agents-assaulted
//     file pattern    /sites/default/files/<YYYY-MM>/assault-incidents-officer-agent-fy23-fy26-<mon>.csv
//   Assault types (what the subject used: rocks, vehicle, firearm, ...)
//     discovery page  https://www.cbp.gov/document/stats/assault-types
//     file pattern    /sites/default/files/<YYYY-MM>/assault-types-fy23-fy26-<mon>.csv
//   Use of force incidents and officers/agents using force
//     discovery page  https://www.cbp.gov/document/stats/use-force-incidents-and-officers/agents-using-force
//     file pattern    /sites/default/files/<YYYY-MM>/use-of-force-incidents-officer-agent-fy23-fy26-<mon>.csv
//   Use of force by type (less-lethal, firearm, vehicle/vessel, other)
//     discovery page  https://www.cbp.gov/document/stats/use-force-type
//     file pattern    /sites/default/files/<YYYY-MM>/use-of-force-types-fy23-fy26-<mon>.csv
//
// CBP counts an incident once per `Unique ID`; the incidents file repeats the ID per officer so
// incidents are the distinct-ID count and officers are the summed `Count of Officers/Agents`.
// These files label the border "Southern Border" (the seizure files say "Southwest Border").
// Sector names match SW_SECTORS so rock-throwing / vehicle assaults can be read against
// encounters and graded cartel events for the same sector.

import {
  ORIGIN, SERIES_MONTHS, ATTRIBUTION, SW_SECTORS,
  periodOf, periodLabel, num, pctChange, lastN, bump, top, anchors,
  loadDatasets, errorSummary,
} from './cbpcommon.mjs';

export const PIPELINE_VERSION = 'cbpforce/1.0.0';
const STATE_FILE = 'state-force.json';
const SOUTHERN = 'Southern Border';

// Fallback URLs verified 2026-09-11 (HTTP 200 via Node fetch); used only when the discovery page cannot be read.
export const DATASETS = {
  assaults: {
    id: 'assaults',
    title: 'Assault Incidents and Officers/Agents Assaulted',
    discoveryPage: `${ORIGIN}/document/stats/assault-incidents-and-officers/agents-assaulted`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/assault-incidents-officer-agent-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/assault-incidents-officer-agent-fy23-fy26-jul.csv`,
    expectedHeader: ['Fiscal Year', 'Month (abbv)', 'Component', 'Region', 'Area of Responsibility', 'Unique ID', 'Count of Officers/Agents'],
    cacheFile: 'assault-incidents.csv',
  },
  assaultTypes: {
    id: 'assaultTypes',
    title: 'Assault Types',
    discoveryPage: `${ORIGIN}/document/stats/assault-types`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/assault-types-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/assault-types-fy23-fy26-jul.csv`,
    expectedHeader: ['Fiscal Year', 'Month (abbv)', 'Component', 'Region', 'Area of Responsibility', 'Assault Type Used by Subject', 'Unique ID'],
    cacheFile: 'assault-types.csv',
  },
  uof: {
    id: 'uof',
    title: 'Use of Force Incidents and Officers/Agents Using Force',
    discoveryPage: `${ORIGIN}/document/stats/use-force-incidents-and-officers/agents-using-force`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/use-of-force-incidents-officer-agent-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/use-of-force-incidents-officer-agent-fy23-fy26-jul.csv`,
    expectedHeader: ['Fiscal Year', 'Month (abbv)', 'Component', 'Region', 'Area of Responsibility', 'Unique ID', 'Count of Officers/Agents'],
    cacheFile: 'use-of-force-incidents.csv',
  },
  uofTypes: {
    id: 'uofTypes',
    title: 'Use of Force by Type',
    discoveryPage: `${ORIGIN}/document/stats/use-force-type`,
    linkPattern: /\/sites\/default\/files\/(\d{4}-\d{2})\/use-of-force-types-fy\d{2}-fy\d{2}-[a-z]{3}[^"'\s]*\.csv/gi,
    fallbackUrl: `${ORIGIN}/sites/default/files/2026-08/use-of-force-types-fy23-fy26-jul.csv`,
    expectedHeader: ['Fiscal Year', 'Month (abbv)', 'Component', 'Region', 'Area of Responsibility', 'Force Type', 'Unique ID'],
    cacheFile: 'use-of-force-types.csv',
  },
};

// Incidents (distinct Unique ID) and officers/agents per month, nationwide + Southern Border,
// with a per-sector table for the Southwest and a component split for the latest month.
export function summarizeIncidents(records) {
  const periods = new Set();
  const ids = new Map(); // period -> Set
  const sIds = new Map(); // period -> Set (Southern Border)
  const officers = new Map(); // period -> { all, southern }
  const bySector = new Map(); // aor -> Map(period -> Set)
  for (const r of records) {
    const p = periodOf(r['Fiscal Year'], r['Month (abbv)']);
    if (!p) continue;
    periods.add(p);
    if (!ids.has(p)) { ids.set(p, new Set()); sIds.set(p, new Set()); officers.set(p, { all: 0, southern: 0 }); }
    const id = r['Unique ID'];
    const n = num(r['Count of Officers/Agents']);
    ids.get(p).add(id);
    officers.get(p).all += n;
    if (r.Region === SOUTHERN) { sIds.get(p).add(id); officers.get(p).southern += n; }
    const aor = r['Area of Responsibility'];
    if (!bySector.has(aor)) bySector.set(aor, new Map());
    const s = bySector.get(aor);
    if (!s.has(p)) s.set(p, new Set());
    s.get(p).add(id);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, prev, yoy } = anchors(sorted);
  const inc = p => ids.get(p)?.size || 0;
  const sInc = p => sIds.get(p)?.size || 0;

  const components = new Map();
  const compIds = new Map();
  for (const r of records) {
    if (periodOf(r['Fiscal Year'], r['Month (abbv)']) !== latest) continue;
    if (!compIds.has(r.Component)) compIds.set(r.Component, new Set());
    compIds.get(r.Component).add(r['Unique ID']);
    bump(components, r.Component, num(r['Count of Officers/Agents']));
  }
  const sectors = SW_SECTORS.map(def => {
    const s = bySector.get(def.aor) || new Map();
    const c = s.get(latest)?.size || 0;
    return {
      ...def,
      latest: c,
      previous: prev ? (s.get(prev)?.size || 0) : null,
      yoyPct: yoy ? pctChange(c, s.get(yoy)?.size || 0) : null,
      fytd: fytdCount(s, latest),
      series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, count: s.get(p)?.size || 0 })),
    };
  }).sort((a, b) => b.latest - a.latest || b.fytd - a.fytd);

  return {
    rows: records.length,
    coverage: { first: sorted[0], last: latest, months: sorted.length },
    latest: {
      period: latest, label: periodLabel(latest),
      incidents: inc(latest), officers: officers.get(latest).all,
      southernIncidents: sInc(latest), southernOfficers: officers.get(latest).southern,
      momPct: prev ? pctChange(inc(latest), inc(prev)) : null,
      yoyPct: yoy ? pctChange(inc(latest), inc(yoy)) : null,
    },
    fytd: { incidents: sumFytd(sorted, latest, inc), officers: sumFytd(sorted, latest, p => officers.get(p).all) },
    series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, label: periodLabel(p), incidents: inc(p), southern: sInc(p), officers: officers.get(p).all })),
    components: [...compIds.entries()].map(([key, s]) => ({ key, incidents: s.size, officers: components.get(key) || 0 })).sort((a, b) => b.incidents - a.incidents),
    sectors,
  };
}

// Latest-month and fiscal-year-to-date breakdown by type (distinct Unique ID per type).
export function summarizeTypes(records, typeColumn) {
  const periods = new Set();
  const byType = new Map(); // type -> Map(period -> Set)
  for (const r of records) {
    const p = periodOf(r['Fiscal Year'], r['Month (abbv)']);
    if (!p) continue;
    periods.add(p);
    const t = r[typeColumn];
    if (!byType.has(t)) byType.set(t, new Map());
    const m = byType.get(t);
    if (!m.has(p)) m.set(p, new Set());
    m.get(p).add(r['Unique ID']);
  }
  const sorted = [...periods].sort();
  if (!sorted.length) return null;
  const { latest, yoy } = anchors(sorted);
  const types = [...byType.entries()].map(([type, m]) => {
    const cur = m.get(latest)?.size || 0;
    return {
      type,
      latest: cur,
      yoyPct: yoy ? pctChange(cur, m.get(yoy)?.size || 0) : null,
      fytd: fytdCount(m, latest),
      series: lastN(sorted, SERIES_MONTHS).map(p => ({ period: p, count: m.get(p)?.size || 0 })),
    };
  }).sort((a, b) => b.latest - a.latest || b.fytd - a.fytd);
  return { rows: records.length, coverage: { first: sorted[0], last: latest, months: sorted.length }, latest: { period: latest, label: periodLabel(latest) }, types };
}

// Fiscal year runs Oct..Sep: every period from the October before `latest` through `latest`.
function fiscalStart(period) {
  const [y, m] = period.split('-').map(Number);
  return `${m >= 10 ? y : y - 1}-10`;
}
function fytdCount(map, latest) {
  const start = fiscalStart(latest);
  let n = 0;
  for (const [p, set] of map) if (p >= start && p <= latest) n += set.size;
  return n;
}
function sumFytd(sorted, latest, fn) {
  const start = fiscalStart(latest);
  return sorted.filter(p => p >= start && p <= latest).reduce((a, p) => a + fn(p), 0);
}

export async function briefing(opts = {}) {
  const { loaded, metas, status, now } = await loadDatasets([DATASETS.assaults, DATASETS.assaultTypes, DATASETS.uof, DATASETS.uofTypes], { ...opts, stateFile: STATE_FILE });
  const [asl, aslT, uof, uofT] = loaded;
  const out = {
    source: 'CBPForce',
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: ATTRIBUTION,
    datasets: metas,
    assaults: asl.records.length ? summarizeIncidents(asl.records) : null,
    assaultTypes: aslT.records.length ? summarizeTypes(aslT.records, 'Assault Type Used by Subject') : null,
    useOfForce: uof.records.length ? summarizeIncidents(uof.records) : null,
    forceTypes: uofT.records.length ? summarizeTypes(uofT.records, 'Force Type') : null,
  };
  const err = errorSummary(metas);
  if (err) out.error = err;
  return out;
}
