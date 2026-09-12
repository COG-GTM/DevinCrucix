// CBP Custody & Enforcement — two official cbp.gov statistics pages that have no CSV export, so
// their HTML tables are the machine-readable path:
//
//   Custody and Transfer Statistics   https://www.cbp.gov/newsroom/stats/custody-and-transfer-statistics
//     USBP average daily subjects in custody by Southwest sector (monthly, current FY)
//     USBP Southwest apprehensions by processing disposition / transfer destination (monthly)
//     OFO Southwest detention capacity and in-custody count (monthly)
//   CBP Enforcement Statistics        https://www.cbp.gov/newsroom/stats/cbp-enforcement-statistics
//     total enforcement encounters by component and fiscal year
//     search-and-rescue totals (USBP Southwest, AMO nationwide) by fiscal year
//     criminal noncitizens / NCIC arrests by component and fiscal year
//     USBP apprehensions by gang affiliation by fiscal year
//     Terrorist Screening Data Set encounters at and between land ports of entry by fiscal year
//
// Tables carry no ids or captions, so each is located by the heading that precedes it and the
// column header row is validated before any number is read; a layout change fails the dataset
// (status "error", last good copy served as "stale") rather than shifting a column silently.
// Both pages are fetched conditionally (ETag / Last-Modified) and cached like the CSVs.

import {
  ORIGIN, ATTRIBUTION,
  num, pctChange, periodLabel,
  loadDatasets, errorSummary, htmlSections, tableAfterHeading, tablesAfterHeading,
} from './cbpcommon.mjs';

export const PIPELINE_VERSION = 'cbpcustody/1.0.0';
const STATE_FILE = 'state-custody.json';

const H = {
  usbpInCustody: /^USBP Average Daily Subjects In Custody by Southwest Border Sector/i,
  ofoInCustody: /^Field Operations - Southwest Border in Custody/i,
  dispositions: /^USBP Monthly Southwest Border Encounters by Processing Disposition/i,
  transfers: /^USBP Monthly Southwest Border Apprehensions by Transfer Destination/i,
  enforcement: /^Total CBP Enforcement Actions/i,
  rescues: /^Search and Rescue Efforts/i,
  ofoCriminal: /^Office of Field Operations$/i,
  usbpCriminal: /^U\.S\. Border Patrol$/i,
  gangs: /Apprehensions by Gang Affiliation/i,
  tsds: /^CBP TSDS Encounters at and Between Land Ports of Entry/i,
};

export const DATASETS = {
  custody: {
    id: 'custody',
    kind: 'html',
    title: 'Custody and Transfer Statistics',
    pageUrl: `${ORIGIN}/newsroom/stats/custody-and-transfer-statistics`,
    cacheFile: 'custody-and-transfer.html',
    validate: html => {
      const s = htmlSections(html);
      const t = tableAfterHeading(s, H.usbpInCustody);
      if (!t) return 'in-custody-by-sector table not found';
      if (t[0]?.[0] !== 'Sector' || !MONTH_COL.test(t[0]?.[1] || '')) return `unexpected in-custody header: ${(t[0] || []).join(',').slice(0, 120)}`;
      return null;
    },
  },
  enforcement: {
    id: 'enforcement',
    kind: 'html',
    title: 'CBP Enforcement Statistics',
    pageUrl: `${ORIGIN}/newsroom/stats/cbp-enforcement-statistics`,
    cacheFile: 'enforcement-statistics.html',
    validate: html => {
      const s = htmlSections(html);
      const t = tableAfterHeading(s, H.enforcement);
      if (!t) return 'enforcement table not found';
      if (t[0]?.[0] !== 'Enforcement' || !FY_COL.test(t[0]?.[1] || '')) return `unexpected enforcement header: ${(t[0] || []).join(',').slice(0, 120)}`;
      return null;
    },
  },
};

// ---------------------------------------------------------------------------
// Table shapes
// ---------------------------------------------------------------------------

const MONTH_COL = /^([A-Z][a-z]{2})-(\d{2})$/; // Oct-25
const FY_COL = /^FY(\d{2})(?:\s+thru\s+(\w+))?$/i; // FY24 | FY26 thru July
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function cell(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '—' || s === 'N/A') return null;
  const m = /^-?[\d,]+(?:\.\d+)?/.exec(s.replace(/^\$/, ''));
  return m ? num(m[0]) : null;
}

// ["Sector","Oct-25",...] + rows -> monthly series; the latest period is the last column that
// has at least one published value (future months are "-").
export function parseMonthlyTable(rows) {
  if (!rows?.length) return null;
  const header = rows[0];
  const periods = header.slice(1).map(h => {
    const m = MONTH_COL.exec(h);
    return m && MON[m[1]] ? `20${m[2]}-${String(MON[m[1]]).padStart(2, '0')}` : null;
  });
  if (periods.some(p => !p)) return null;
  const body = rows.slice(1).filter(r => r.length === header.length).map(r => ({ key: r[0], values: r.slice(1).map(cell) }));
  let li = -1;
  body.forEach(r => r.values.forEach((v, i) => { if (v !== null && i > li) li = i; }));
  if (li < 0) return null;
  const latest = periods[li];
  const prev = li > 0 ? periods[li - 1] : null;
  return {
    label: header[0],
    periods,
    latest, latestLabel: periodLabel(latest), prev,
    rows: body.map(r => ({
      key: r.key,
      latest: r.values[li],
      previous: prev ? r.values[li - 1] : null,
      momPct: prev && r.values[li] !== null ? pctChange(r.values[li], r.values[li - 1] || 0) : null,
      series: periods.slice(0, li + 1).map((p, i) => ({ period: p, value: r.values[i] })),
    })),
  };
}

// ["Enforcement","FY17",...,"FY26 thru July"] + rows -> fiscal-year columns; the last column is
// usually a partial year and is flagged so it is never compared 1:1 with a full year.
export function parseFiscalYearTable(rows) {
  if (!rows?.length) return null;
  const header = rows[0];
  const columns = header.slice(1).map(h => {
    const m = FY_COL.exec(h);
    return m ? { label: h, fy: 2000 + Number(m[1]), partial: Boolean(m[2]), thru: m[2] || null } : null;
  });
  if (!columns.length || columns.some(c => !c)) return null;
  const body = [];
  let section = null;
  for (const r of rows.slice(1)) {
    if (r.length === 1) { section = r[0]; continue; } // sub-heading row spanning the table
    if (r.length !== header.length) continue;
    body.push({ key: r[0], section, values: r.slice(1).map(cell) });
  }
  const last = columns.length - 1;
  const full = columns.map((c, i) => (c.partial ? -1 : i)).filter(i => i >= 0).pop();
  return {
    label: header[0],
    columns,
    latest: columns[last],
    lastFull: full !== undefined ? columns[full] : null,
    rows: body.map(r => ({
      key: r.key, section: r.section,
      latest: r.values[last],
      lastFull: full !== undefined ? r.values[full] : null,
      priorFull: full !== undefined && full > 0 ? r.values[full - 1] : null,
      values: r.values,
    })),
  };
}

// ---------------------------------------------------------------------------
// Page summaries
// ---------------------------------------------------------------------------

export function summarizeCustody(html) {
  const s = htmlSections(html);
  const inCustody = parseMonthlyTable(tableAfterHeading(s, H.usbpInCustody));
  const dispositions = parseMonthlyTable(tableAfterHeading(s, H.dispositions));
  const transfers = parseMonthlyTable(tableAfterHeading(s, H.transfers));
  const ofoRows = tableAfterHeading(s, H.ofoInCustody);
  if (!inCustody) return null;

  const total = inCustody.rows.find(r => /^total$/i.test(r.key)) || null;
  const sectors = inCustody.rows.filter(r => r !== total).map(r => ({
    sector: r.key === 'Rio Grande' ? 'Rio Grande Valley' : r.key,
    latest: r.latest, previous: r.previous, momPct: r.momPct,
    series: r.series.map(x => ({ period: x.period, count: x.value })),
  })).sort((a, b) => (b.latest || 0) - (a.latest || 0));

  let ofo = null;
  if (ofoRows?.length >= 3 && ofoRows[0][0] === 'Detention Capacity') {
    // capacity is pre-filled for the whole year; the "%" row ("57 (6.32%)") marks published months
    const ofoMonthly = parseMonthlyTable(ofoRows);
    const cap = ofoMonthly?.rows.find(r => /capacity/i.test(r.key));
    const pctRow = ofoRows.find(r => r[0] === '%');
    const parsePct = raw => /^([\d,]+)\s*\(([\d.]+)%\)/.exec(String(raw || '').trim());
    if (ofoMonthly && cap && pctRow) {
      let li = -1;
      pctRow.slice(1).forEach((v, i) => { if (parsePct(v)) li = i; });
      const m = li >= 0 ? parsePct(pctRow[li + 1]) : null;
      if (m) ofo = { period: ofoMonthly.periods[li], label: periodLabel(ofoMonthly.periods[li]), capacity: cap.series[li]?.value ?? cap.latest, inCustody: num(m[1]), pct: Number(m[2]) };
    }
  }

  const dispTotal = dispositions?.rows.find(r => /^total/i.test(r.key)) || null;
  const trTotal = transfers?.rows.find(r => /^total/i.test(r.key)) || null;
  return {
    region: 'Southwest Border',
    period: inCustody.latest, label: inCustody.latestLabel,
    inCustody: {
      total: total ? { latest: total.latest, previous: total.previous, momPct: total.momPct, series: total.series.map(x => ({ period: x.period, label: periodLabel(x.period), count: x.value })) } : null,
      sectors,
    },
    dispositions: dispositions ? {
      period: dispositions.latest, label: dispositions.latestLabel,
      total: dispTotal ? { latest: dispTotal.latest, momPct: dispTotal.momPct } : null,
      rows: dispositions.rows.filter(r => r !== dispTotal && r.latest).map(r => ({ key: r.key, latest: r.latest, momPct: r.momPct, share: dispTotal?.latest ? Math.round((r.latest / dispTotal.latest) * 1000) / 10 : null })).sort((a, b) => b.latest - a.latest),
    } : null,
    transfers: transfers ? {
      period: transfers.latest, label: transfers.latestLabel,
      total: trTotal ? { latest: trTotal.latest, momPct: trTotal.momPct } : null,
      rows: transfers.rows.filter(r => r !== trTotal && r.latest).map(r => ({ key: r.key, latest: r.latest, momPct: r.momPct })).sort((a, b) => b.latest - a.latest),
    } : null,
    ofo,
  };
}

export function summarizeEnforcement(html) {
  const s = htmlSections(html);
  const enforcement = parseFiscalYearTable(tableAfterHeading(s, H.enforcement));
  if (!enforcement) return null;
  const rescues = parseFiscalYearTable(tableAfterHeading(s, H.rescues));
  const ofoCriminal = parseFiscalYearTable(tableAfterHeading(s, H.ofoCriminal));
  const usbpCriminal = parseFiscalYearTable(tableAfterHeading(s, H.usbpCriminal));
  const gangs = parseFiscalYearTable(tableAfterHeading(s, H.gangs));
  const tsdsTables = tablesAfterHeading(s, H.tsds).map(parseFiscalYearTable).filter(Boolean);

  const fyRows = t => (t ? t.rows.map(r => ({ key: r.key, latest: r.latest, lastFull: r.lastFull, priorFull: r.priorFull, yoyFullPct: r.priorFull ? pctChange(r.lastFull || 0, r.priorFull) : null })) : []);
  const tsds = tsdsTables.map(t => {
    const pct = t.rows.find(r => /^percentage/i.test(r.key)) || null; // "0.0928%" cells parse to 0.0928
    return {
      label: t.rows[0]?.section || t.label,
      latest: t.latest, lastFull: t.lastFull,
      rows: t.rows.filter(r => r !== pct).map(r => ({ key: r.key, latest: r.latest, lastFull: r.lastFull, priorFull: r.priorFull })),
      pctOfEncounters: pct ? { latest: pct.latest, lastFull: pct.lastFull } : null,
    };
  });

  return {
    asOf: enforcement.latest, lastFull: enforcement.lastFull,
    enforcement: { columns: enforcement.columns, rows: fyRows(enforcement) },
    rescues: rescues ? { columns: rescues.columns, rows: fyRows(rescues) } : null,
    criminalNoncitizens: {
      ofo: ofoCriminal ? fyRows(ofoCriminal) : null,
      usbp: usbpCriminal ? fyRows(usbpCriminal) : null,
    },
    gangs: gangs ? {
      latest: gangs.latest, lastFull: gangs.lastFull,
      rows: fyRows(gangs).filter(r => !/^total/i.test(r.key)).sort((a, b) => (a.key === 'Other') - (b.key === 'Other') || (b.latest || 0) - (a.latest || 0)),
      total: fyRows(gangs).find(r => /^total/i.test(r.key)) || null,
    } : null,
    tsds,
  };
}

export async function briefing(opts = {}) {
  const { loaded, metas, status, now } = await loadDatasets([DATASETS.custody, DATASETS.enforcement], { ...opts, stateFile: STATE_FILE });
  const [cus, enf] = loaded;
  const out = {
    source: 'CBPCustody',
    timestamp: new Date(now).toISOString(),
    status,
    pipelineVersion: PIPELINE_VERSION,
    attribution: ATTRIBUTION,
    datasets: metas,
    custody: cus.text ? summarizeCustody(cus.text) : null,
    enforcement: enf.text ? summarizeEnforcement(enf.text) : null,
  };
  const err = errorSummary(metas);
  if (err) out.error = err;
  return out;
}
