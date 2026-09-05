// Situation strip — rule-based headline judgments computed post-sweep.
// No LLM: every headline is derived from a named rule over data the dashboard
// already has, and carries the source, as-of time, and the tab/panel that
// holds the evidence. Designed to answer "what is this dashboard telling me?"
// in five lines or fewer.

export const SEVERITIES = ['critical', 'high', 'elevated', 'info'];
export const TABS = ['situation', 'military', 'cyber', 'macro', 'regional', 'investigations', 'sources'];
export const MAX_HEADLINES = 5;

const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

const str = (v, n = 140) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(v) ? v : 0);
const list = (v) => (Array.isArray(v) ? v : []);

function headline(rule, severity, title, why, source, tab, panel, extra = {}) {
  return {
    rule,
    severity: SEVERITIES.includes(severity) ? severity : 'info',
    title: str(title, 140),
    why: str(why, 220),
    source: str(source, 60),
    tab: TABS.includes(tab) ? tab : 'situation',
    panel: str(panel, 60),
    ...extra,
  };
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100);
}

// PRC tension is the same composite the dashboard used to compute inline:
// Chinese military aircraft in the Taiwan Strait / South China Sea, PRC-tagged
// GDELT headlines, and Chinese ISR airframes tracked by ADS-B.
export function prcTension(V2) {
  const air = list(V2?.air);
  const strait = air.find(a => a.region === 'Taiwan Strait') || {};
  const scs = air.find(a => a.region === 'South China Sea') || {};
  const straitCn = num((list(strait.top).find(t => t[0] === 'China') || [])[1]);
  const scsTotal = num(scs.total);
  const gdeltPrc = list(V2?.gdelt?.topTitles).filter(t =>
    /china|chinese|beijing|prc|taiwan|south china sea|xi jinping/i.test(typeof t === 'string' ? t : t?.title || '')).length;
  const isr = list(V2?.adsbMilitary?.categories?.isr).filter(a => String(a.country || '').toLowerCase().includes('china')).length;
  const score = Math.min(100, Math.round((straitCn + scsTotal) * 1.5 + gdeltPrc * 8 + isr * 15));
  const level = score >= 70 ? 'ELEVATED' : score >= 40 ? 'HEIGHTENED' : score >= 15 ? 'NORMAL' : 'REDUCED';
  return { score, level, straitCn, scsTotal, gdeltPrc, isr };
}

const RULES = [
  function defcon(V2) {
    const d = V2.defcon || {};
    const level = Number(d.level);
    if (!Number.isFinite(level) || level >= 5) return [];
    const sev = level <= 2 ? 'critical' : level === 3 ? 'high' : 'elevated';
    const comps = Object.entries(d.components || {})
      .filter(([, v]) => Number.isFinite(v?.score ?? v))
      .sort((a, b) => num(b[1]?.score ?? b[1]) - num(a[1]?.score ?? a[1]))
      .slice(0, 3)
      .map(([k, v]) => `${k} ${fmtNum(v?.score ?? v)}`);
    return [headline('defcon', sev,
      `DEFCON ${level} — ${d.label || 'readiness elevated'}`,
      comps.length ? `Composite score ${fmtNum(d.score)}; drivers: ${comps.join(', ')}.` : `Composite score ${fmtNum(d.score)}.`,
      'DEFCON (derived)', 'situation', 'right-core')];
  },

  function deltaCritical(V2) {
    const s = V2.delta?.signals || {};
    const out = [];
    for (const e of list(s.escalated).filter(x => x.severity === 'critical').slice(0, 2)) {
      const pct = Number.isFinite(e.pctChange) ? ` (${e.pctChange > 0 ? '+' : ''}${Math.round(e.pctChange)}%)` : '';
      out.push(headline('delta', 'high',
        `${e.label || e.key} ${fmtNum(e.from)} → ${fmtNum(e.to)}${pct}`,
        'Largest move since the previous sweep; see What Changed for the full list.',
        'Sweep Delta', 'situation', 'right-delta'));
    }
    for (const n of list(s.new).filter(x => x.severity === 'critical' || x.tier === 'FLASH').slice(0, 2)) {
      out.push(headline('flash', 'critical', n.reason || n.label || n.key,
        n.detail || 'Flash-tier alert raised by a source this sweep.',
        'Sweep Delta', 'situation', 'right-delta'));
    }
    return out;
  },

  function radiation(V2) {
    const anomalies = list(V2.nuke).filter(n => n && n.anom);
    if (!anomalies.length) return [];
    const top = anomalies[0];
    return [headline('radiation', 'critical',
      `Radiation anomaly: ${top.site || top.name || 'sensor'} ${fmtNum(top.cpm)} CPM`,
      `${anomalies.length} Safecast site${anomalies.length > 1 ? 's' : ''} above local baseline.`,
      'Safecast', 'military', 'nuke-panel')];
  },

  function prc(V2) {
    const t = prcTension(V2);
    if (t.level !== 'ELEVATED' && t.level !== 'HEIGHTENED') return [];
    return [headline('prc', t.level === 'ELEVATED' ? 'high' : 'elevated',
      `PRC tension ${t.level} (${t.score}/100)`,
      `${t.straitCn} PLA aircraft Taiwan Strait · ${t.scsTotal} South China Sea tracks · ${t.gdeltPrc} PRC headlines · ${t.isr} ISR airframes.`,
      'OpenSky · GDELT · ADS-B', 'military', 'prc-panel', { prc: t })];
  },

  function focal(V2) {
    const crit = list(V2.focalPoints?.focalPoints).filter(f => f.urgency === 'Critical');
    if (!crit.length) return [];
    const top = crit[0];
    return [headline('focal', 'high',
      `Focal point: ${top.name} (${top.type || 'entity'})`,
      top.narrative || `${crit.length} critical focal point${crit.length > 1 ? 's' : ''} from cross-source mention clustering.`,
      'Focal Points (derived)', 'situation', 'right-focal')];
  },

  function instability(V2) {
    const cii = V2.cii || {};
    const crit = list(cii.countries).filter(c => c.level === 'Critical');
    if (!crit.length) return [];
    const names = crit.slice(0, 3).map(c => c.name).join(', ');
    return [headline('cii', 'high',
      `${crit.length} countr${crit.length > 1 ? 'ies' : 'y'} at Critical instability: ${names}`,
      cii.warmingUp
        ? `CII is still learning baselines (${num(cii.warmupProgress)}% warm-up); treat as provisional.`
        : 'Country Instability Index combines conflict, protest, tone and thermal components.',
      'CII (derived)', 'situation', 'right-cii')];
  },

  function convergence(V2) {
    const zones = list(V2.convergence?.zones).filter(z => z.alertLevel === 'Critical' || z.alertLevel === 'High');
    if (!zones.length) return [];
    const top = zones[0];
    return [headline('convergence', 'elevated',
      `${zones.length} multi-source convergence zone${zones.length > 1 ? 's' : ''}`,
      `Top: ${num(top.typeCount)} event types / ${num(top.totalEvents)} events near ${fmtNum(top.lat)}, ${fmtNum(top.lng)}.`,
      'Convergence (derived)', 'situation', 'right-signals')];
  },

  function borderSpikes(V2) {
    const spikes = list(V2.borderNews?.spikes);
    if (!spikes.length) return [];
    const s = spikes[0];
    const ratio = Number.isFinite(s.ratio) ? `${fmtNum(s.ratio)}×` : `${s.count24h} vs ${fmtNum(s.baselineDailyMean)}/day`;
    return [headline('border', 'high',
      `Border Watch spike: ${s.placeName || s.place} · ${s.topic} (${ratio} baseline)`,
      `${spikes.length} place/topic pair${spikes.length > 1 ? 's' : ''} above the 30-day daily mean in the last 24 h.`,
      'Border Watch', 'regional', 'border-panel')];
  },

  function kev(V2) {
    const ck = V2.cyberKev || {};
    const recent = num(ck.recentCount);
    if (!recent && !num(ck.ransomwareCount)) return [];
    const bits = [];
    if (num(ck.ransomwareCount)) bits.push(`${ck.ransomwareCount} ransomware-linked`);
    if (num(ck.prcRelevantCount)) bits.push(`${ck.prcRelevantCount} PRC-relevant`);
    return [headline('kev', recent >= 5 ? 'elevated' : 'info',
      `${recent} CISA KEV addition${recent === 1 ? '' : 's'} in the last 7 days`,
      bits.length ? `${bits.join(' · ')} in the current catalog window.` : 'Known-exploited vulnerabilities added to the CISA catalog.',
      'CISA KEV', 'cyber', 'right-kev')];
  },

  function spaceWeather(V2) {
    const kp = V2.spaceWeather?.kp || {};
    if (!kp.severity || kp.severity === 'nominal') return [];
    return [headline('kp', kp.severity === 'severe' ? 'high' : 'elevated',
      `Geomagnetic ${kp.level || 'storm'} (Kp ${fmtNum(kp.current)})`,
      'HF comms and GNSS accuracy may be degraded at high latitudes.',
      'NOAA SWPC', 'military', 'space-panel')];
  },

  function typosquat(V2) {
    const ts = V2.typosquat || {};
    if (!num(ts.newCount)) return [];
    return [headline('typosquat', 'elevated',
      `${ts.newCount} new look-alike domain${ts.newCount === 1 ? '' : 's'} registered`,
      `Against ${list(ts.watchlist).length} watched domains; pivot each in INVESTIGATIONS.`,
      'Typosquat Watch', 'investigations', 'right-typosquat')];
  },

  function coverage(V2) {
    const sh = V2.sourceHealth?.summary;
    if (!sh || !num(sh.total)) return [];
    const dark = num(sh.no_key) + num(sh.off) + num(sh.error);
    if (!num(sh.error) && dark / sh.total < 0.25) return [];
    const failed = list(V2.sourceHealth?.sources).filter(s => s.state === 'error').map(s => s.name).slice(0, 4);
    return [headline('coverage', num(sh.error) ? 'elevated' : 'info',
      `${dark} of ${sh.total} sources not reporting`,
      failed.length
        ? `Failed this sweep: ${failed.join(', ')}. ${num(sh.no_key)} need a key, ${num(sh.off)} off.`
        : `${num(sh.no_key)} need an API key, ${num(sh.off)} are off; zeros in their panels mean "no data", not "quiet".`,
      'Source Health', 'sources', 'sourceHealthPanel')];
  },
];

export function buildSituation(V2, now = new Date()) {
  const raw = [];
  for (const rule of RULES) {
    try { raw.push(...rule(V2 || {})); } catch { /* one bad rule must not blank the strip */ }
  }
  raw.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const headlines = raw.slice(0, MAX_HEADLINES);
  const sh = V2?.sourceHealth?.summary || {};
  const quiet = !headlines.some(h => h.severity !== 'info');
  if (quiet) {
    headlines.unshift(headline('baseline', 'info',
      'No rule fired above baseline this sweep',
      `${num(sh.live)} sources live, ${num(sh.degraded)} degraded. Monitoring continues on the normal cadence.`,
      'CRUCIX rules', 'situation', 'right-delta'));
  }
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, raw.filter(h => h.severity === s).length]));
  return {
    asOf: (now instanceof Date ? now : new Date(now)).toISOString(),
    quiet,
    rulesFired: raw.length,
    counts,
    headlines: headlines.slice(0, MAX_HEADLINES),
    prc: prcTension(V2 || {}),
  };
}
