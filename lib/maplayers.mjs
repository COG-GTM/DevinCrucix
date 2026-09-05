// Map layer registry — decides which globe layers are on by default each sweep.
// A layer is `signal` when its own rule says something notable is present,
// `data` when it merely has markers to draw, and `none` when the feed produced
// nothing (the reason comes from source health). Defaults = the signal layers
// (capped), padded with the highest-ranked data layers so the map is never
// empty. Everything else is a toggle. The dashboard reads `types` to filter
// markers and `color`/`label` to draw the legend, so the legend can only list
// layers that can actually be plotted.

export const MAX_DEFAULT_LAYERS = 5;
export const MIN_DEFAULT_LAYERS = 3;
export const LAYER_STATES = ['signal', 'data', 'none'];

const num = (v) => (Number.isFinite(v) ? v : 0);
const list = (v) => (Array.isArray(v) ? v : []);
const geo = (a) => list(a).filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon ?? p?.lng));

// rank = order used when padding defaults and when laying out the toggle strip.
export const LAYERS = [
  {
    id: 'prc', label: 'PRC Activity', color: '#f44336', rank: 1,
    types: ['prc-activity', 'prc-military'], sources: ['OpenSky', 'ADS-B'],
    eval(V2, ctx) {
      const p = ctx.prc || {};
      const count = num(p.straitCn) + num(p.scsTotal) + num(p.isr);
      const signal = p.level === 'ELEVATED' || p.level === 'HEIGHTENED' || num(p.isr) > 0;
      return { count, signal, why: count ? `${p.level || 'NORMAL'} · score ${num(p.score)}/100` : '' };
    },
  },
  {
    id: 'military', label: 'Military ADS-B', color: '#00ffc8', rank: 2,
    types: ['military-isr', 'military-bomber', 'military-tanker', 'military-vip'], sources: ['ADS-B'],
    eval(V2) {
      const c = V2.adsbMilitary?.categories || {};
      const recon = geo(c.reconnaissance).length, bombers = geo(c.bombers).length;
      const tankers = geo(c.tankers).length, vip = geo(c.vipTransport).length;
      const count = recon + bombers + tankers + vip;
      const bits = [];
      if (recon) bits.push(`${recon} ISR`);
      if (bombers) bits.push(`${bombers} bomber`);
      if (tankers) bits.push(`${tankers} tanker`);
      if (vip) bits.push(`${vip} VIP`);
      return { count, signal: recon + bombers + vip > 0, why: bits.join(' · ') };
    },
  },
  {
    id: 'gps', label: 'GPS Jamming', color: '#ef5350', rank: 3,
    types: ['gps-jamming'], sources: ['GPSJamming'],
    eval(V2) {
      const zones = geo(V2.gpsJamming?.zones);
      const hot = zones.filter(z => z.severity === 'high' || z.severity === 'medium').length;
      return { count: zones.length, signal: hot > 0, why: zones.length ? `${hot} medium/high zones` : '' };
    },
  },
  {
    id: 'conflict', label: 'Conflict Events', color: '#ff7850', rank: 4,
    types: ['acled'], sources: ['ACLED'],
    eval(V2) {
      const ev = geo(V2.acled?.deadliestEvents);
      const fatal = ev.reduce((s, e) => s + num(e.fatalities), 0);
      return { count: ev.length, signal: ev.length > 0, why: ev.length ? `${fatal.toLocaleString('en-US')} fatalities` : '' };
    },
  },
  {
    id: 'carriers', label: 'Carrier Groups', color: '#4fc3f7', rank: 5,
    types: ['carrier'], sources: ['Carriers'],
    eval(V2) {
      const c = geo(V2.carriers?.carriers);
      const fresh = c.filter(x => /gdelt/i.test(String(x.source || ''))).length;
      return { count: c.length, signal: fresh > 0, why: c.length ? (fresh ? `${fresh} geolocated this sweep` : 'estimated positions') : '' };
    },
  },
  {
    id: 'nuke', label: 'Radiation', color: '#ffe082', rank: 6,
    types: ['nuke', 'radiation'], sources: ['Safecast', 'EPA'],
    eval(V2) {
      const sites = list(V2.nuke), stations = geo(V2.epa?.stations);
      const anom = sites.filter(n => n.anom).length;
      return { count: sites.length + stations.length, signal: anom > 0, why: anom ? `${anom} site anomaly` : (sites.length ? 'all monitors normal' : '') };
    },
  },
  {
    id: 'air', label: 'Air Activity', color: '#64f0c8', rank: 7,
    types: ['air'], arcs: true, sources: ['OpenSky', 'ADS-B'],
    eval(V2) {
      const air = list(V2.air);
      const total = air.reduce((s, a) => s + num(a.total), 0);
      const dark = air.filter(a => num(a.total) >= 20 && num(a.noCallsign) / a.total >= 0.15);
      return { count: total, signal: dark.length > 0, why: dark.length ? `${dark.map(a => a.region).join(', ')}: ≥15% no callsign` : (total ? `${air.filter(a => num(a.total) > 0).length} theaters` : '') };
    },
  },
  {
    id: 'thermal', label: 'Thermal / Fire', color: '#ff5f63', rank: 8,
    types: ['thermal'], sources: ['FIRMS'],
    eval(V2) {
      const fires = list(V2.thermal).flatMap(t => geo(t.fires));
      const hot = fires.filter(f => num(f.frp) >= 100).length;
      return { count: fires.length, signal: hot > 0, why: fires.length ? `${hot} ≥100 MW` : '' };
    },
  },
  {
    id: 'osint', label: 'OSINT Events', color: '#ffb84c', rank: 9,
    types: ['osint'], sources: ['Telegram'],
    eval(V2) {
      const urgent = list(V2.tg?.urgent).length;
      return { count: urgent, signal: urgent > 0, why: urgent ? `${urgent} urgent posts` : '' };
    },
  },
  {
    id: 'narco', label: 'Narco Intel', color: '#ff4081', rank: 10,
    types: ['narco-intel'], sources: ['InSightCrime'],
    eval(V2) {
      const n = list(V2.insightCrime?.articles).length;
      return { count: n, signal: false, why: n ? `${n} articles` : '' };
    },
  },
  {
    id: 'gdelt', label: 'GDELT Events', color: '#6495ed', rank: 11,
    types: ['gdelt', 'gdelt-cluster'], sources: ['GDELT'],
    eval(V2) {
      const pts = geo(V2.gdelt?.geoPoints), clusters = list(V2.gdelt?.geoClusters).filter(c => num(c.count) >= 3);
      return { count: pts.length + clusters.length, signal: false, why: pts.length ? `${clusters.length} clusters` : '' };
    },
  },
  {
    id: 'maritime', label: 'Chokepoints', color: '#b388ff', rank: 12,
    types: ['maritime'], sources: ['Maritime'],
    eval(V2) {
      const n = geo(V2.chokepoints).length;
      return { count: n, signal: false, why: n ? 'reference points' : '' };
    },
  },
  {
    id: 'health', label: 'Health / Weather', color: '#69f0ae', rank: 13,
    types: ['health', 'weather'], sources: ['WHO', 'NOAA'],
    eval(V2) {
      const who = list(V2.who).length, alerts = geo(V2.noaa?.alerts);
      const severe = alerts.filter(a => /extreme|severe/i.test(String(a.severity || ''))).length;
      return { count: who + alerts.length, signal: severe > 0, why: severe ? `${severe} severe/extreme NWS alerts` : (who ? `${who} WHO items` : '') };
    },
  },
  {
    id: 'space', label: 'Space Stations', color: '#ffffff', rank: 14,
    types: ['space'], sources: ['Space'],
    eval(V2) {
      const n = geo(V2.space?.stationPositions).length;
      return { count: n, signal: false, why: n ? 'orbital estimates' : '' };
    },
  },
  {
    id: 'news', label: 'World News', color: '#81d4fa', rank: 15,
    types: ['news'], sources: ['RSS'],
    eval(V2) {
      const n = geo(V2.news).length;
      return { count: n, signal: false, why: n ? 'geolocated headlines' : '' };
    },
  },
  {
    id: 'sensors', label: 'SDR / CCTV', color: '#44ccff', rank: 16,
    types: ['sdr', 'cctv'], sources: ['KiwiSDR', 'CCTV'],
    eval(V2) {
      const sdr = list(V2.sdr?.zones).reduce((s, z) => s + geo(z.receivers).length, 0);
      const cctv = geo(V2.cctvMesh?.cameras).length;
      return { count: sdr + cctv, signal: false, why: sdr + cctv ? 'coverage, not events' : '' };
    },
  },
  {
    id: 'market', label: 'Market Intel', color: '#00e5ff', rank: 17,
    types: ['market-intel'], sources: ['UnusualWhales'],
    eval(V2) {
      const n = geo(V2.unusualWhales?.globeMarkers).length;
      return { count: n, signal: false, why: n ? 'company HQ markers' : '' };
    },
  },
];

export const LAYER_IDS = LAYERS.map(l => l.id);

const SH_ORDER = ['error', 'off', 'no_key', 'degraded', 'live'];
function worstHealth(V2, names) {
  const all = list(V2?.sourceHealth?.sources);
  let worst = null;
  for (const n of names) {
    const s = all.find(x => x.name === n);
    if (s && (!worst || SH_ORDER.indexOf(s.state) < SH_ORDER.indexOf(worst.state))) worst = s;
  }
  return worst;
}

function noneWhy(V2, layer) {
  const s = worstHealth(V2, layer.sources || []);
  if (!s || s.state === 'live') return 'nothing to plot this sweep';
  if (s.state === 'no_key') return list(s.envVars).length ? `needs ${s.envVars.join(' + ')}` : 'needs API key';
  const label = { degraded: 'degraded', off: 'off', error: 'failed' }[s.state] || s.state;
  const reason = String(s.reason || '').trim();
  return `${s.name} ${label}${reason ? `: ${reason}` : ''}`;
}

// Returns every layer with its state for this sweep plus the default on/off decision.
export function evaluateLayers(V2, ctx = {}) {
  const V = V2 || {};
  const rows = LAYERS.map(layer => {
    let r = { count: 0, signal: false, why: '' };
    try { r = layer.eval(V, ctx) || r; } catch { /* a bad feed shape must not blank the map */ }
    const count = num(r.count);
    const state = count > 0 ? (r.signal ? 'signal' : 'data') : 'none';
    return {
      id: layer.id, label: layer.label, color: layer.color, rank: layer.rank,
      types: layer.types.slice(), arcs: Boolean(layer.arcs),
      state, count,
      why: state === 'none' ? noneWhy(V, layer) : String(r.why || ''),
      on: false,
    };
  }).sort((a, b) => a.rank - b.rank);

  const on = new Set(rows.filter(r => r.state === 'signal').slice(0, MAX_DEFAULT_LAYERS).map(r => r.id));
  for (const r of rows) {
    if (on.size >= MIN_DEFAULT_LAYERS) break;
    if (r.state === 'data') on.add(r.id);
  }
  for (const r of rows) r.on = on.has(r.id);
  return {
    layers: rows,
    defaults: rows.filter(r => r.on).map(r => r.id),
    signal: rows.filter(r => r.state === 'signal').length,
    plottable: rows.filter(r => r.state !== 'none').length,
  };
}
