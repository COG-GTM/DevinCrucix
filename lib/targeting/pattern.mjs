// Pattern of activity — the target's public footprint over time.
//
// Timeline entries are the dated mentions (with place when the FIX pass found one) plus status events
// the knowledge graph extracted (arrested / killed / sanctioned / extradited ...). Aggregates are plain
// counts: by month, by weekday, by state, by source. "Deviations" compare the last 30 days of reporting
// against the target's own trailing-12-month monthly baseline, the same z-score idea the border anomaly
// engine uses. This is reporting tempo about the target, not the target's movements.
export const MAX_TIMELINE = 300;
export const BASELINE_MONTHS = 12;
export const STATUS_KINDS = ['arrested', 'killed', 'sanctioned', 'extradited', 'indicted', 'charged', 'convicted', 'sentenced', 'released', 'escaped'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function monthKey(d) { return d.slice(0, 7); }
function addMonths(ym, n) { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); }

export function buildTimeline(mentions, observations = []) {
  const obsByMention = new Map(observations.map(o => [o.mentionId, o]));
  const entries = [];
  const seen = new Set();
  for (const m of mentions) {
    if (!m.date) continue;
    const key = `${m.source}|${m.docId}|${m.sentence.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = obsByMention.get(m.id);
    entries.push({
      date: m.date, source: m.source, title: m.title || null, url: m.url || null, sentence: m.sentence,
      kind: m.eventKind && STATUS_KINDS.includes(m.eventKind) ? 'status' : m.eventKind || m.eventType ? 'event' : 'mention',
      status: m.eventKind && STATUS_KINDS.includes(m.eventKind) ? m.eventKind : null,
      place: o ? (o.state && o.place !== o.state ? `${o.place}, ${o.state}` : o.place) : null,
      lat: o ? o.lat : null, lon: o ? o.lon : null, radiusKm: o ? o.radiusKm : null, presence: o ? o.presence : null,
      grade: m.grade || null, weak: Boolean(m.weak),
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || (b.kind === 'status') - (a.kind === 'status'));
  return entries.slice(0, MAX_TIMELINE);
}

export function aggregate(timeline, { now = Date.now() } = {}) {
  const byMonth = {}, byWeekday = Object.fromEntries(WEEKDAYS.map(d => [d, 0])), byState = {}, bySource = {}, statuses = [];
  for (const e of timeline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    byMonth[monthKey(e.date)] = (byMonth[monthKey(e.date)] || 0) + 1;
    const t = Date.parse(e.date);
    if (Number.isFinite(t)) byWeekday[WEEKDAYS[new Date(t).getUTCDay()]]++;
    if (e.place) { const st = e.place.includes(', ') ? e.place.split(', ').pop() : e.place; byState[st] = (byState[st] || 0) + 1; }
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    if (e.status) statuses.push({ date: e.date, status: e.status, sentence: e.sentence, url: e.url, source: e.source });
  }
  const months = Object.keys(byMonth).sort();
  const first = timeline.length ? timeline[timeline.length - 1].date : null;
  const last = timeline.length ? timeline[0].date : null;
  // Continuous month series from first to the current month so gaps show as zeros.
  const nowYm = new Date(now).toISOString().slice(0, 7);
  const series = [];
  if (months.length) {
    for (let ym = months[0]; ym <= nowYm && series.length < 240; ym = addMonths(ym, 1)) series.push({ month: ym, n: byMonth[ym] || 0 });
  }
  return {
    span: { first, last, entries: timeline.length },
    byMonth: series,
    byWeekday: WEEKDAYS.map(d => ({ day: d, n: byWeekday[d] })),
    byState: Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([state, n]) => ({ state, n })),
    bySource: Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([source, n]) => ({ source, n })),
    statuses: dedupeStatuses(statuses).slice(0, 20),
    gaps: gaps(series),
  };
}

function dedupeStatuses(list) {
  const out = [];
  for (const s of list.sort((a, b) => b.date.localeCompare(a.date))) {
    if (out.some(o => o.status === s.status && Math.abs(Date.parse(o.date) - Date.parse(s.date)) < 14 * 86_400_000)) continue;
    out.push(s);
  }
  return out;
}

/** Runs of >= 3 consecutive months with no reporting, inside the target's span. */
export function gaps(series) {
  const out = [];
  let start = null, n = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i].n === 0) { if (start === null) start = series[i].month; n++; }
    else { if (n >= 3) out.push({ from: start, to: series[i - 1].month, months: n }); start = null; n = 0; }
  }
  return out.slice(0, 10);
}

/**
 * Compare the trailing 30 days with the target's own monthly baseline over the preceding 12 months.
 * Same statistics the border anomaly engine uses (mean/sd with a Poisson floor for sparse series).
 */
export function deviations(timeline, { now = Date.now() } = {}) {
  const cut30 = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
  const cutBase = new Date(now - (30 + BASELINE_MONTHS * 30) * 86_400_000).toISOString().slice(0, 10);
  const recent = timeline.filter(e => e.date >= cut30);
  const base = timeline.filter(e => e.date >= cutBase && e.date < cut30);
  const buckets = new Array(BASELINE_MONTHS).fill(0);
  for (const e of base) {
    const ageDays = (Date.parse(cut30) - Date.parse(e.date)) / 86_400_000;
    const i = Math.min(BASELINE_MONTHS - 1, Math.floor(ageDays / 30));
    buckets[i]++;
  }
  const mean = buckets.reduce((s, x) => s + x, 0) / BASELINE_MONTHS;
  const variance = buckets.reduce((s, x) => s + (x - mean) ** 2, 0) / BASELINE_MONTHS;
  const sd = Math.max(Math.sqrt(variance), Math.sqrt(Math.max(mean, 1)));
  const observed = recent.length;
  const z = (observed - mean) / sd;
  const flags = [];
  if (observed >= 3 && z >= 2) flags.push({ kind: 'tempo-spike', text: `${observed} dated mentions in the last 30 days vs ${mean.toFixed(1)}/month baseline (z=${z.toFixed(1)})` });
  if (mean >= 2 && observed === 0) flags.push({ kind: 'went-quiet', text: `no dated mentions in the last 30 days vs ${mean.toFixed(1)}/month baseline` });
  // New geography: a state that appears in the last 30 days but never in the baseline.
  const baseStates = new Set(base.map(e => e.place && e.place.split(', ').pop()).filter(Boolean));
  for (const st of new Set(recent.map(e => e.place && e.place.split(', ').pop()).filter(Boolean))) {
    if (!baseStates.has(st) && base.length >= 5) flags.push({ kind: 'new-geography', text: `${st} named with the target for the first time in ${BASELINE_MONTHS} months` });
  }
  for (const e of recent) if (e.status) flags.push({ kind: 'status-change', text: `${e.status} · ${e.date}`, url: e.url });
  return { window: { from: cut30, days: 30 }, observed, baselineMean: Math.round(mean * 10) / 10, baselineSd: Math.round(sd * 10) / 10, z: Math.round(z * 10) / 10, flags: flags.slice(0, 8) };
}

export function patternOfActivity(mentions, observations, opts = {}) {
  const timeline = buildTimeline(mentions, observations);
  return { timeline, aggregates: aggregate(timeline, opts), deviations: deviations(timeline, opts) };
}
