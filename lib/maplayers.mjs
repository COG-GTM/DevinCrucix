// Map layer registry — decides which globe layers are on by default each sweep.
// A layer is `signal` when its own rule says something notable is present,
// `data` when it merely has markers to draw, and `none` when the feed produced
// nothing (the reason comes from source health). Defaults = the signal layers
// (capped), plus `pinned` layers whenever they have something to draw, padded
// with the highest-ranked data layers so the map is never empty. Everything
// else is a toggle. The dashboard reads `types` to filter
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
    // Polygons + points are fetched from /api/frontlines/geo when the layer is on;
    // this rule only needs the summary in V2.frontlines.
    id: 'front', label: 'Ukraine Front', color: '#ff6e40', rank: 3.5,
    types: ['front-poly', 'front-attack', 'front-change'], sources: ['Frontlines'],
    eval(V2) {
      const f = V2.frontlines || {};
      if (f.status !== 'live' || !num(f.featureCount)) return { count: 0, signal: false, why: '' };
      const h = f.history || {};
      const count = num(Object.values(f.polyCats || {}).reduce((s, v) => s + num(v), 0)) + num(f.attackDirections);
      const bits = [`${num(f.occupiedKm2).toLocaleString('en-US')} km² occupied`];
      if (num(h.recent7d)) bits.push(`${h.recent7d} updates/7d (${num(h.advances7d)} adv · ${num(h.regains7d)} regain)`);
      if (num(f.attackDirections)) bits.push(`${f.attackDirections} attack axes`);
      return { count, signal: num(h.recent7d) > 0, why: bits.join(' · ') };
    },
  },
  {
    id: 'front-orbat', label: 'RU Units / Airfields', color: '#ffab91', rank: 12.5,
    types: ['front-unit', 'front-airfield'], sources: ['Frontlines'],
    eval(V2) {
      const f = V2.frontlines || {};
      if (f.status !== 'live') return { count: 0, signal: false, why: '' };
      const count = num(f.units) + num(f.airfields);
      return { count, signal: false, why: count ? `${num(f.units)} unit markers · ${num(f.airfields)} airfields (DeepState placement)` : '' };
    },
  },
  {
    // Influence polygons + pins come from /api/cartels/geo when the layer is on. Crowd-sourced,
    // so it never counts as `signal` and never turns itself on by default.
    id: 'cartels', label: 'Cartel Influence (MX)', color: '#ff5252', rank: 9.5,
    types: ['cartel-poly', 'cartel-pin'], sources: ['Cartels'],
    eval(V2) {
      const c = V2.cartels || {};
      if (c.status !== 'live' || !num(c.featureCount)) return { count: 0, signal: false, why: '' };
      const lc = c.layerCounts || {};
      const bits = [`${num(lc.influence)} influence areas · ${num(c.orgCount)} orgs`];
      if (num(lc.wars)) bits.push(`${lc.wars} active wars`);
      if (num(c.activityLast30d)) bits.push(`${c.activityLast30d} dated entries/30d`);
      if (c.stale) bits.push('cached copy');
      return { count: num(c.polygonCount) + num(c.pointCount), signal: false, why: bits.join(' · ') };
    },
  },
  {
    // Geocoded events come from /api/iranwar/geo when the layer is on. LLM-extracted from news wires
    // with city-level coordinates, so it is `data`, never `signal`, and never turns itself on by default.
    id: 'iran-kinetic', label: 'Iran Theater · Kinetic', color: '#ff5a36', rank: 9.7,
    types: ['iwl-strike', 'iwl-intercept'], sources: ['IranWarLive'],
    eval(V2) {
      const w = V2.iranwar || {};
      const c = w.counts || {};
      if (w.status !== 'live' || !num(c.theaterEvents)) return { count: 0, signal: false, why: '' };
      const k = c.byKind48h || {};
      const bits = [`${num(c.events48h)} events/48 h · ${num(c.casualties48h)} reported casualties`];
      if (num(k.missile) || num(k.drone)) bits.push(`${num(k.missile)} missile · ${num(k.drone)} drone · ${num(k.intercept)} intercept`);
      if (w.stale) bits.push('cached copy');
      return { count: num(c.theaterEvents), signal: false, why: bits.join(' · ') };
    },
  },
  {
    id: 'iran-ground', label: 'Iran Theater · Ground Ops', color: '#ffb74d', rank: 9.8,
    types: ['iwl-ground'], sources: ['IranWarLive'],
    eval(V2) {
      const w = V2.iranwar || {};
      const c = w.counts || {};
      if (w.status !== 'live' || !num(c.ground)) return { count: 0, signal: false, why: '' };
      const ctl = Object.entries(c.groundControl || {}).sort((a, b) => num(b[1]) - num(a[1])).slice(0, 3).map(([k, v]) => `${k} ${num(v)}`);
      return { count: num(c.ground), signal: false, why: `${num(c.ground48h)} rows/48 h${ctl.length ? ' · control: ' + ctl.join(', ') : ''}` };
    },
  },
  {
    // MND daily bulletin: ADIZ sector badges (SW / N / E / central / SE), each showing that the sector
    // was named in the day's bulletin. Government-published aggregate counts, not tracks — `data`.
    id: 'mnd-adiz', label: 'Taiwan ADIZ · MND Daily', color: '#ff9f43', rank: 9.85,
    types: ['mnd-adiz'], sources: ['TaiwanMND'],
    eval(V2) {
      const m = V2.taiwan?.mnd || {};
      const b = m.bulletin;
      if (!b || m.status === 'unavailable') return { count: 0, signal: false, why: '' };
      const bits = [`${num(b.aircraft)} aircraft · ${num(b.adizEntries)} ADIZ entries · ${num(b.planShips)} PLAN ships (${b.publishedDate || 'n/a'})`];
      if (b.sectors?.length) bits.push(`sectors: ${b.sectors.join(', ')}`);
      if (m.stale) bits.push('cached copy');
      return { count: (m.sectors || []).filter(s => s.named).length, signal: false, why: bits.join(' · ') };
    },
  },
  {
    // Coast Guard grey-zone incidents from /api/taiwan/geo: one circle per release on the area centroid
    // (Kinmen, Matsu, Dongsha…) with the stated radius. Never a vessel position.
    id: 'cga-incidents', label: 'Grey Zone · Taiwan CGA', color: '#29b6f6', rank: 9.86,
    types: ['cga-incident'], sources: ['TaiwanCGA'],
    eval(V2) {
      const c = V2.taiwan?.cga || {};
      const s = c.stats || {};
      if (c.status === 'unavailable' || !num(s.total)) return { count: 0, signal: false, why: '' };
      const placed = (c.incidents || []).filter(i => i.area).length;
      const bits = [`${num(s.last30d)} releases/30 d · ${num(s.ccgIntrusions30d)} CCG intrusions · ${num(s.distinctHulls30d)} distinct hulls`];
      if (c.stale) bits.push('cached copy');
      return { count: placed, signal: false, why: bits.join(' · ') };
    },
  },
  {
    // Global Conflict Awareness observational strip: only named / regional points are drawn; the
    // country-centroid majority is kept off the map. OSINT aggregation, attributed, never `signal`.
    id: 'gca-taiwan', label: 'GCA Taiwan · Observational', color: '#b39ddb', rank: 9.87,
    types: ['gca-taiwan'], sources: ['GCATaiwan'],
    eval(V2) {
      const g = V2.taiwan?.gca || {};
      const s = g.stats || {};
      if (g.status === 'unavailable' || !num(s.shown)) return { count: 0, signal: false, why: '' };
      const bits = [`${num(s.shown)} on-topic of ${num(g.feedRecords)} feed records · ${num(s.placed)} placed · ${num(s.countryLevel)} country-level (not drawn)`];
      if (g.stale) bits.push('cached copy');
      return { count: num(s.placed), signal: false, why: bits.join(' · ') };
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
    id: 'carriers', label: 'Carrier Groups', color: '#4fc3f7', rank: 5, pinned: true,
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
    // Refreshed on its own 5-minute cadence (server.mjs), attached to the sweep payload as V2.seismic.
    id: 'seismic', label: 'Seismic (USGS)', color: '#ffb74d', rank: 6.5,
    types: ['seismic', 'seismic-site'], sources: [],
    eval(V2) {
      const s = V2.seismic || {};
      if (s.status !== 'live') return { count: 0, signal: false, why: '' };
      const ev = list(s.events).filter(e => Number.isFinite(e?.lat) && Number.isFinite(e?.lng));
      const suspect = num(s.suspectCount), major = num(s.significantCount);
      const bits = [];
      if (suspect) bits.push(`${suspect} shallow event${suspect > 1 ? 's' : ''} near a nuclear test site`);
      if (major) bits.push(`${major} M5+`);
      if (!bits.length && ev.length) bits.push(`max M${s.maxMagnitude ?? '--'} · 24h`);
      return { count: ev.length, signal: suspect > 0, why: bits.join(' · ') };
    },
  },
  {
    id: 'air', label: 'Air Activity', color: '#64f0c8', rank: 7, pinned: true,
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
      types: layer.types.slice(), arcs: Boolean(layer.arcs), pinned: Boolean(layer.pinned),
      state, count,
      why: state === 'none' ? noneWhy(V, layer) : String(r.why || ''),
      on: false,
    };
  }).sort((a, b) => a.rank - b.rank);

  const on = new Set(rows.filter(r => r.state === 'signal').slice(0, MAX_DEFAULT_LAYERS).map(r => r.id));
  for (const r of rows) if (r.pinned && r.state !== 'none') on.add(r.id);
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
