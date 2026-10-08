import { summarizeSeismic } from '../apis/sources/seismic.mjs';
// Deployment profiles: one codebase, several focused CRUCIX deployments. CRUCIX_PROFILE=europe
// trims the sweep, tabs, map and delegation tracker to Russia / Ukraine / Europe. Unset = full app.

const EU_BOX = [[40, 72, -25, 60], [34, 40, -25, 45], [54, 78, 60, 180], [42, 54, 130, 180]]; // [latMin, latMax, lonMin, lonMax]: Europe + Caucasus, Turkey / Cyprus, Siberia north of Kazakhstan / Mongolia, Russian Far East (approximate)

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
    tabs: ['situation', 'sitrep', 'military', 'prcdel', 'cyber', 'macro', 'investigations', 'targeting', 'finance', 'requirements', 'sources'],
    tabLabels: { military: 'Military Movements', prcdel: 'RU Delegations' },
    // Ukraine War folds into Military Movements: one map (front + every military layer), both panel sets.
    mergeTabs: { military: ['ukraine'] },
    mapTabs: ['military'],
    tabHints: {
      military: 'Military Movements \u00b7 one map: DeepStateMAP front, attack axes, RU units / airfields, Russian Navy, USV strikes, air, GPS jamming, thermal, nuclear \u00b7 Ukraine War and Military panels together',
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

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const coord = o => {
  const lat = num(o.lat ?? o.latitude); const lon = num(o.lon ?? o.lng ?? o.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
};
const geoArray = a => Array.isArray(a) && a.length && a.every(x => x && typeof x === 'object' && !Array.isArray(x)) && a.some(x => coord(x));

// Drop geolocated rows outside the profile box, at any depth up to 4 (flat lists, and region
// objects carrying nested tracks / fires / points). A region whose nested observations were all
// out of theater is dropped. Rows without coordinates stay; the Ukraine payload is untouched.
export function applyProfileToData(data, profile = getProfile()) {
  if (!profile?.box || !data || typeof data !== 'object') return data;
  const keep = x => { const c = coord(x); return !c || inBox(c[0], c[1], profile.box); };
  const walk = (v, depth) => {
    if (depth > 4 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      const arr = geoArray(v) ? v.filter(keep) : v;
      return arr.flatMap(x => {
        if (!x || typeof x !== 'object' || Array.isArray(x) || coord(x)) return [x];
        let hadGeo = false, anyLeft = false;
        for (const [k, sub] of Object.entries(x)) if (geoArray(sub)) { hadGeo = true; x[k] = walk(sub, depth + 1); if (x[k].length) anyLeft = true; }
        return hadGeo && !anyLeft ? [] : [x];
      });
    }
    for (const [k, sub] of Object.entries(v)) if (sub && typeof sub === 'object') v[k] = walk(sub, depth + 1);
    return v;
  };
  for (const [k, v] of Object.entries(data)) {
    if (k === 'ukraine' || k === 'meta' || k === 'sourceHealth' || k === 'profile') continue;
    data[k] = walk(v, 1);
  }
  const sz = data.seismic;
  if (sz && Array.isArray(sz.events)) {
    const { suspectEvents, ...sum } = summarizeSeismic(sz.events);
    Object.assign(sz, sum, { suspectEvents });
  }
  data.profile = { id: profile.id, title: profile.title };
  return data;
}

// Client-side subset (tabs, labels, map region, chip text) injected into the dashboard HTML.
export function clientProfile(profile = getProfile()) {
  if (!profile) return null;
  const { id, title, region, watchChip, tabs, tabLabels, tabHints, mergeTabs, mapTabs, delegation, skipSources } = profile;
  return { id, title, region, watchChip, tabs, tabLabels, tabHints, mergeTabs, mapTabs, delegation, skipSources };
}
