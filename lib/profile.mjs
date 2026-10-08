// Deployment profiles: one codebase, several focused CRUCIX deployments. CRUCIX_PROFILE=europe
// trims the sweep, tabs, map and delegation tracker to Russia / Ukraine / Europe. Unset = full app.

const EU_BOX = [[40, 72, -25, 60], [34, 40, -25, 45], [41, 78, 60, 180]]; // [latMin, latMax, lonMin, lonMax]: Europe + Caucasus, Turkey / Cyprus, Russia east of the Urals (approximate)

const PROFILES = {
  europe: {
    id: 'europe',
    title: 'Russia / Ukraine / Europe',
    region: 'europe',
    watchChip: 'RUSSIA WATCH',
    // Sweep sources whose coverage is outside the theater (Americas, Iran, Taiwan, US domestic).
    skipSources: ['InSightCrime', 'BorderNews', 'Cartels', 'IranWarLive', 'TaiwanMND', 'TaiwanCGA', 'TaiwanNews', 'GCATaiwan', 'TaiwanMarkets',
      'ColombiaOpenData', 'ColombiaNews', 'VenezuelaNews', 'OVCS', 'DefensoriaSAT', 'Indepaz', 'BorderIngest', 'CBPStats', 'CBPSeizures', 'CBPForce',
      'CBPCustody', 'DOJ', 'OFACNarco', 'DataInt', 'Lantia', 'USAspending', 'NOAA', 'EPA', 'BLS', 'UnusualWhales', 'PizzaIndex'],
    tabs: ['situation', 'sitrep', 'military', 'ukraine', 'prcdel', 'cyber', 'macro', 'investigations', 'targeting', 'finance', 'requirements', 'sources'],
    tabLabels: { prcdel: 'RU Delegations' },
    tabHints: {
      sitrep: 'Commander\u2019s SITREP \u00b7 EUCOM AOR (Europe, Russia, Ukraine, Caucasus, Turkey) \u00b7 AM / PM editions drafted by the model from CRUCIX feeds, every claim cites a feed section \u00b7 OSINT demo product',
      prcdel: 'Russian Delegation Tracker \u00b7 open-source reporting of Russian delegations in Europe mapped by date and place \u00b7 reported meetings \u00b7 concurrent Russia-linked events (RT / Sputnik, Rossotrudnichestvo / Russian House, Rosatom, Gazprom\u2026) \u00b7 SYNTHETIC overlay: one fictional person of interest per delegation across travel / border / SS7 / CDR / voter / vehicle records',
    },
    box: EU_BOX,
    scenario: 'config/synthetic/scenario.europe.json',
    delegation: { tracker: 'Russian Delegation Tracker', actor: 'Russian', linked: 'Russia-linked', origin: { city: 'Moscow', lon: 37.62, lat: 55.76 } },
  },
};

export function getProfile(id = process.env.CRUCIX_PROFILE) {
  return PROFILES[String(id || '').toLowerCase()] || null;
}

export function inBox(lat, lon, box) {
  return box.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);
}

const coord = o => {
  const lat = Number(o.lat ?? o.latitude); const lon = Number(o.lon ?? o.lng ?? o.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
};
const geoArray = a => Array.isArray(a) && a.length && a.every(x => x && typeof x === 'object' && !Array.isArray(x)) && a.some(x => coord(x));

// Drop geolocated rows outside the profile box from top-level arrays (and one level down).
// Rows without coordinates stay; the Ukraine tab's own payload is left untouched.
export function applyProfileToData(data, profile = getProfile()) {
  if (!profile?.box || !data || typeof data !== 'object') return data;
  const keep = x => { const c = coord(x); return !c || inBox(c[0], c[1], profile.box); };
  for (const [k, v] of Object.entries(data)) {
    if (k === 'ukraine' || k === 'meta' || k === 'sourceHealth') continue;
    if (geoArray(v)) data[k] = v.filter(keep);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (geoArray(v2)) v[k2] = v2.filter(keep);
    }
  }
  data.profile = { id: profile.id, title: profile.title };
  return data;
}

// Client-side subset (tabs, labels, map region, chip text) injected into the dashboard HTML.
export function clientProfile(profile = getProfile()) {
  if (!profile) return null;
  const { id, title, region, watchChip, tabs, tabLabels, tabHints, delegation } = profile;
  return { id, title, region, watchChip, tabs, tabLabels, tabHints, delegation };
}
