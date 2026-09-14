// Metric catalog for standing requirements. Every metric is an extractor over one synthesized
// sweep (dashboard/inject.mjs output, or the compacted copy MemoryManager archives) that yields
// {dims, value} samples — one for the total and one per dimension value when the sweep carries a
// breakdown. Nothing here is hand-copied: the catalog served by /api/requirements/metrics and the
// list the compiler validates against are both derived from this table.
//
// kind: 'count' metrics get the Poisson floor (anomaly.py evaluate_region_series); 'level' metrics
// (tone) are compared on their plain standard deviation.

import { fold, loadGazetteer } from '../narco/gazetteer.mjs';

export const DIM_KEYS = ['state', 'country', 'theater'];
const HOUR = 3_600_000;
const MAX_EVIDENCE = 12;
const MAX_LABEL = 60;
const MAX_DIM_VALUES = 40;

const lbl = (v, n = MAX_LABEL) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const fin = (v) => (Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : null);
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const httpUrl = (u) => { try { const x = new URL(String(u || '')); return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString().slice(0, 2048) : null; } catch { return null; } };
const withinHours = (when, now, hours) => { const t = ts(when); return t !== null && t <= now + HOUR && t >= now - hours * HOUR; };
// Event dates are day-precision; a date string counts as "in the last N hours" when its day overlaps the window.
const dayWithinHours = (day, now, hours) => { const t = ts(String(day || '').slice(0, 10) + 'T12:00:00Z'); return t !== null && t >= now - (hours + 12) * HOUR && t <= now + 12 * HOUR; };

function canonState(name, gz) {
  const k = fold(lbl(name, 40));
  if (!k) return null;
  return gz.stateKey.get(k)?.shortName || null;
}

// {label -> value} breakdown → dimension samples, bounded so a runaway feed cannot fan out.
function dimSamples(dim, entries) {
  return entries
    .filter(([k, v]) => k && Number.isFinite(v))
    .slice(0, MAX_DIM_VALUES)
    .map(([k, v]) => ({ dims: { [dim]: lbl(k) }, value: v }));
}

function evidenceRow(row) {
  return {
    title: lbl(row.title, 160), url: httpUrl(row.url), ts: row.ts || null,
    source: lbl(row.source, 60), detail: lbl(row.detail, 160),
  };
}

// Narco events (lib/narco/view.mjs compactCluster) dated inside the window, keyed by canonical state.
function narcoEventsIn(d, now, hours, gz) {
  return (d?.narco?.events || []).filter(e => e && dayWithinHours(e.date, now, hours)).map(e => ({
    state: e.location?.country === 'MX' ? canonState(e.location.state, gz) : null, ev: e,
  }));
}
// Python border-ingest articles flagged as violence, published inside the window, mapped to a Mexican state.
function ingestViolenceIn(d, now, hours, gz) {
  return (d?.borderIngest?.articles || []).filter(a => a && a.isViolence && withinHours(a.publishedAt, now, hours)).map(a => {
    const st = (a.regions || []).map(r => (r.country === 'MX' ? canonState(r.name, gz) : null)).find(Boolean) || null;
    return { state: st, ev: a };
  });
}

const acledDeadliest = (d, country) => (d?.acled?.deadliestEvents || []).filter(e => !country || lbl(e.country) === country).slice(0, MAX_EVIDENCE)
  .map(e => evidenceRow({ title: `${e.type || 'Event'} · ${e.location || ''}, ${e.country || ''}`, ts: e.date, source: 'ACLED', detail: `${e.fatalities || 0} fatalities` }));

export const METRICS = [
  {
    key: 'conflict_events', label: 'Conflict events (ACLED)', kind: 'count', unit: 'events', source: 'ACLED',
    dims: ['country', 'theater'], describe: 'ACLED events in the feed period; by ACLED region (theater) and top country when present',
    extract: (d) => [
      { dims: {}, value: fin(d?.acled?.totalEvents) ?? 0 },
      ...dimSamples('theater', Object.entries(d?.acled?.byRegion || {}).map(([k, v]) => [k, fin(v?.count)])),
      ...dimSamples('country', Object.entries(d?.acled?.topCountries || {}).map(([k, v]) => [k, fin(v?.count)])),
    ],
    evidence: (d, dims) => acledDeadliest(d, dims.country),
  },
  {
    key: 'conflict_fatalities', label: 'Conflict fatalities (ACLED)', kind: 'count', unit: 'fatalities', source: 'ACLED',
    dims: ['country', 'theater'], describe: 'ACLED reported fatalities; by ACLED region (theater) and top country when present',
    extract: (d) => [
      { dims: {}, value: fin(d?.acled?.totalFatalities) ?? 0 },
      ...dimSamples('theater', Object.entries(d?.acled?.byRegion || {}).map(([k, v]) => [k, fin(v?.fatalities)])),
      ...dimSamples('country', Object.entries(d?.acled?.topCountries || {}).map(([k, v]) => [k, fin(v?.fatalities)])),
    ],
    evidence: (d, dims) => acledDeadliest(d, dims.country),
  },
  {
    key: 'border_violence_events', label: 'Border / cartel violence events', kind: 'count', unit: 'events', source: 'Narco · BorderIngest',
    dims: ['state'], describe: 'Graded cartel / border-crime events plus violence-flagged border articles dated in the last 24 h, by Mexican state',
    extract: (d, { now, gz }) => {
      const rows = [...narcoEventsIn(d, now, 24, gz), ...ingestViolenceIn(d, now, 24, gz)];
      const byState = new Map();
      for (const r of rows) if (r.state) byState.set(r.state, (byState.get(r.state) || 0) + 1);
      return [{ dims: {}, value: rows.length }, ...dimSamples('state', [...byState.entries()])];
    },
    evidence: (d, dims, { now, gz }) => {
      const rows = [...narcoEventsIn(d, now, 48, gz), ...ingestViolenceIn(d, now, 48, gz)].filter(r => !dims.state || r.state === dims.state);
      return rows.slice(0, MAX_EVIDENCE).map(({ ev }) => evidenceRow(ev.typeLabel !== undefined
        ? { title: ev.title, url: ev.sources?.[0]?.url, ts: ev.date, source: ev.sources?.[0]?.outlet || 'Narco events', detail: `${ev.typeLabel || ''}${ev.counts?.killed ? ` · ${ev.counts.killed} killed` : ''} · grade ${ev.confidence?.grade || '?'}` }
        : { title: ev.title, url: ev.url, ts: ev.publishedAt, source: ev.outlet || 'Border ingest', detail: (ev.violenceTerms || []).join(', ') }));
    },
  },
  {
    key: 'urgent_posts', label: 'Urgent OSINT posts', kind: 'count', unit: 'posts', source: 'Telegram',
    dims: [], describe: 'Telegram posts the sweep flagged as urgent',
    extract: (d) => [{ dims: {}, value: (d?.tg?.urgent || []).length }],
    evidence: (d) => (d?.tg?.urgent || []).slice(0, MAX_EVIDENCE).map(p => evidenceRow({ title: p.text, ts: p.date, source: p.channel || p.chat || 'Telegram' })),
  },
  {
    key: 'thermal_total', label: 'Thermal detections (FIRMS)', kind: 'count', unit: 'detections', source: 'FIRMS',
    dims: ['theater'], describe: 'FIRMS thermal anomalies per monitored region',
    extract: (d) => [
      { dims: {}, value: (d?.thermal || []).reduce((s, t) => s + (fin(t?.det) || 0), 0) },
      ...dimSamples('theater', (d?.thermal || []).map(t => [t?.region, fin(t?.det)])),
    ],
    evidence: (d, dims) => (d?.thermal || []).filter(t => !dims.theater || lbl(t.region) === dims.theater).slice(0, MAX_EVIDENCE)
      .map(t => evidenceRow({ title: `${t.region}: ${t.det} detections`, source: 'FIRMS', detail: `${t.night || 0} night · ${t.hc || 0} high confidence` })),
  },
  {
    key: 'air_total', label: 'Air activity (tracked aircraft)', kind: 'count', unit: 'aircraft', source: 'OpenSky · ADS-B',
    dims: ['theater'], describe: 'Aircraft tracked per theater box',
    extract: (d) => [
      { dims: {}, value: (d?.air || []).reduce((s, a) => s + (fin(a?.total) || 0), 0) },
      ...dimSamples('theater', (d?.air || []).map(a => [a?.region, fin(a?.total)])),
    ],
    evidence: (d, dims) => (d?.air || []).filter(a => !dims.theater || lbl(a.region) === dims.theater).slice(0, MAX_EVIDENCE)
      .map(a => evidenceRow({ title: `${a.region}: ${a.total} aircraft`, source: 'Air', detail: (a.top || []).slice(0, 4).map(t => Array.isArray(t) ? `${t[0]} ${t[1]}` : '').filter(Boolean).join(' · ') })),
  },
  {
    key: 'kev_total', label: 'CISA KEV catalog size', kind: 'count', unit: 'CVEs', source: 'CyberKEV',
    dims: [], describe: 'Known Exploited Vulnerabilities in the catalog',
    extract: (d) => [{ dims: {}, value: fin(d?.cyberKev?.totalVulnerabilities) ?? 0 }],
    evidence: (d) => (d?.cyberKev?.vulnerabilities || []).slice(0, MAX_EVIDENCE).map(v => evidenceRow({ title: `${v.cveID} · ${v.vendor} ${v.product}`, url: v.nvdUrl, ts: v.dateAdded, source: 'CISA KEV', detail: v.name })),
  },
  {
    key: 'kev_additions', label: 'KEV additions (24 h)', kind: 'count', unit: 'CVEs', source: 'CyberKEV',
    dims: [], describe: 'CVEs whose KEV dateAdded falls in the last 24 h',
    extract: (d, { now }) => [{ dims: {}, value: (d?.cyberKev?.vulnerabilities || []).filter(v => dayWithinHours(v?.dateAdded, now, 24)).length }],
    evidence: (d, dims, { now }) => (d?.cyberKev?.vulnerabilities || []).filter(v => dayWithinHours(v?.dateAdded, now, 72)).slice(0, MAX_EVIDENCE)
      .map(v => evidenceRow({ title: `${v.cveID} · ${v.vendor} ${v.product}`, url: v.nvdUrl, ts: v.dateAdded, source: 'CISA KEV', detail: `${v.ransomware ? 'ransomware · ' : ''}${v.name || ''}` })),
  },
  {
    key: 'gdelt_tone', label: 'GDELT tone', kind: 'level', unit: 'tone', source: 'GDELT',
    dims: ['theater'], describe: 'GDELT average document tone per monitored region (negative = more negative coverage)',
    extract: (d) => {
      const rows = (d?.gdelt?.toneScores || []).filter(t => Number.isFinite(fin(t?.currentTone)));
      const mean = rows.length ? rows.reduce((s, t) => s + fin(t.currentTone), 0) / rows.length : null;
      return [...(mean === null ? [] : [{ dims: {}, value: Math.round(mean * 100) / 100 }]), ...dimSamples('theater', rows.map(t => [t.region, fin(t.currentTone)]))];
    },
    evidence: (d) => (d?.gdelt?.priorityAlerts || []).slice(0, MAX_EVIDENCE).map(a => evidenceRow({ title: typeof a === 'string' ? a : a?.title || a?.headline, url: a?.url, source: 'GDELT' })),
  },
  {
    key: 'border_news_articles', label: 'Border Watch articles (new this sweep)', kind: 'count', unit: 'articles', source: 'BorderNews',
    dims: [], describe: 'Registry-feed articles first seen this sweep',
    extract: (d) => [{ dims: {}, value: fin(d?.borderNews?.newThisSweep) ?? 0 }],
    evidence: (d) => (d?.borderNews?.articles || []).slice(0, MAX_EVIDENCE).map(a => evidenceRow({ title: a.title, url: a.url, ts: a.publishedAt, source: a.outlet, detail: (a.topics || []).join(', ') })),
  },
  {
    key: 'border_spikes', label: 'Border Watch place spikes', kind: 'count', unit: 'spikes', source: 'BorderNews',
    dims: [], describe: 'Places whose 24 h article count the Border Watch baseline flagged',
    extract: (d) => [{ dims: {}, value: (d?.borderNews?.spikes || []).length }],
    evidence: (d) => (d?.borderNews?.spikes || []).slice(0, MAX_EVIDENCE).map(s => evidenceRow({ title: `${s.placeName || s.place}: ${s.count24h} in 24 h`, source: 'BorderNews', detail: `${s.topic || ''} · baseline ${s.baselineDailyMean}/day · ${s.rule || ''}` })),
  },
  {
    key: 'who_alerts', label: 'WHO disease outbreak alerts', kind: 'count', unit: 'alerts', source: 'WHO',
    dims: [], describe: 'WHO Disease Outbreak News items in the feed',
    extract: (d) => [{ dims: {}, value: (d?.who || []).length }],
    evidence: (d) => (d?.who || []).slice(0, MAX_EVIDENCE).map(w => evidenceRow({ title: w.title, url: w.url || w.link, ts: w.date, source: 'WHO' })),
  },
  {
    key: 'seismic_events', label: 'Seismic events (24 h, M2.5+)', kind: 'count', unit: 'events', source: 'USGS',
    dims: [], describe: 'USGS events in the last 24 h',
    extract: (d) => [{ dims: {}, value: fin(d?.seismic?.totalEvents) ?? 0 }],
    evidence: (d) => (d?.seismic?.events || []).slice(0, MAX_EVIDENCE).map(e => evidenceRow({ title: `M${e.mag} · ${e.place}`, url: e.url, ts: e.time, source: 'USGS', detail: `${e.depthKm} km` })),
  },
  {
    key: 'iranwar_events_48h', label: 'Iran-theater kinetic events (48 h)', kind: 'count', unit: 'events', source: 'IranWarLive',
    dims: [], describe: 'IranWarLive kinetic events in the trailing 48 h',
    extract: (d) => [{ dims: {}, value: fin(d?.iranwar?.counts?.events48h) ?? 0 }],
    evidence: (d) => (d?.iranwar?.events || []).slice(0, MAX_EVIDENCE).map(e => evidenceRow({ title: e.title || e.summary, url: e.url, ts: e.time || e.date, source: 'IranWarLive', detail: e.type })),
  },
  {
    key: 'news_count', label: 'World news items', kind: 'count', unit: 'items', source: 'RSS',
    dims: [], describe: 'Geolocated RSS items in the sweep',
    extract: (d) => [{ dims: {}, value: fin(d?.news?.length ?? d?.news?.count) ?? 0 }],
    evidence: (d) => (Array.isArray(d?.news) ? d.news : []).slice(0, MAX_EVIDENCE).map(n => evidenceRow({ title: n.title || n.headline, url: n.url || n.link, ts: n.timestamp || n.date, source: n.source })),
  },
];

export const METRIC_KEYS = METRICS.map(m => m.key);
export const METRIC_BY_KEY = new Map(METRICS.map(m => [m.key, m]));

// Sweep → [{metric, dims, value}] for every metric, tolerant of partial / degraded payloads.
export function extractSamples(sweep, { now = Date.now(), gz = loadGazetteer() } = {}) {
  const out = [];
  const ctx = { now, gz };
  for (const m of METRICS) {
    let rows = [];
    try { rows = m.extract(sweep || {}, ctx) || []; } catch { rows = []; }
    for (const r of rows) {
      if (!r || !Number.isFinite(r.value)) continue;
      const dims = {};
      for (const k of DIM_KEYS) if (r.dims && typeof r.dims[k] === 'string' && r.dims[k]) dims[k] = r.dims[k];
      out.push({ metric: m.key, dims, value: r.value });
    }
  }
  return out;
}

// Evidence rows for one metric / dimension slice out of the current sweep.
export function extractEvidence(metricKey, sweep, dims = {}, { now = Date.now(), gz = loadGazetteer(), max = MAX_EVIDENCE } = {}) {
  const m = METRIC_BY_KEY.get(metricKey);
  if (!m || typeof m.evidence !== 'function') return [];
  try {
    return (m.evidence(sweep || {}, dims || {}, { now, gz }) || []).filter(r => r && r.title).slice(0, max);
  } catch { return []; }
}

// Public catalog shape (what /api/requirements/metrics serves and the compiler validates against).
export function catalog() {
  return METRICS.map(m => ({ key: m.key, label: m.label, kind: m.kind, unit: m.unit, source: m.source, dims: [...m.dims], describe: m.describe }));
}
