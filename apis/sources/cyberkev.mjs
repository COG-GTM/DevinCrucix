// CISA KEV — Known Exploited Vulnerabilities as a *delta*: what CISA added in the last 7 / 30
// days, which vendors/products it concentrates on, and what BOD 22-01 says must be fixed by when.
// No invented severity: KEV has no CVSS field, so none is shown. Ransomware linkage is CISA's own
// `knownRansomwareCampaignUse`; PRC relevance is a keyword hint, labelled as such.
// Data source: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json (free, no key)

import { safeFetch } from '../utils/fetch.mjs';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DAY = 86400000;
export const DELTA_DAYS = 30;
export const DUE_SOON_DAYS = 14;

let _cache = null;
let _cacheTs = 0;

// Vendor HQ centroids kept for the Situation globe layer (vendor origin, not victim location).
const VENDOR_CENTROIDS = {
  'Microsoft': { lat: 47.6, lng: -122.3, country: 'US' }, 'Apple': { lat: 37.3, lng: -122.0, country: 'US' },
  'Google': { lat: 37.4, lng: -122.1, country: 'US' }, 'Adobe': { lat: 37.3, lng: -121.9, country: 'US' },
  'Cisco': { lat: 37.4, lng: -121.9, country: 'US' }, 'Oracle': { lat: 37.5, lng: -122.3, country: 'US' },
  'VMware': { lat: 37.4, lng: -122.1, country: 'US' }, 'Fortinet': { lat: 37.4, lng: -122.0, country: 'US' },
  'Palo Alto Networks': { lat: 37.4, lng: -122.1, country: 'US' }, 'Ivanti': { lat: 40.3, lng: -111.7, country: 'US' },
  'Citrix': { lat: 26.4, lng: -80.1, country: 'US' }, 'SonicWall': { lat: 37.0, lng: -121.6, country: 'US' },
  'Atlassian': { lat: -33.9, lng: 151.2, country: 'AU' }, 'SAP': { lat: 49.3, lng: 8.6, country: 'DE' },
  'Siemens': { lat: 48.1, lng: 11.6, country: 'DE' }, 'Samsung': { lat: 37.3, lng: 127.0, country: 'KR' },
  'Huawei': { lat: 22.6, lng: 114.1, country: 'CN' }, 'ZTE': { lat: 22.5, lng: 114.1, country: 'CN' },
  'Hikvision': { lat: 30.3, lng: 120.2, country: 'CN' }, 'Dahua': { lat: 30.3, lng: 120.2, country: 'CN' },
  'TP-Link': { lat: 22.5, lng: 114.1, country: 'CN' }, 'D-Link': { lat: 25.0, lng: 121.5, country: 'TW' },
  'ASUS': { lat: 25.0, lng: 121.5, country: 'TW' }, 'Zyxel': { lat: 24.8, lng: 121.0, country: 'TW' },
  'Trend Micro': { lat: 35.7, lng: 139.7, country: 'JP' }, 'Sophos': { lat: 51.7, lng: -1.3, country: 'GB' },
  'Arm': { lat: 52.2, lng: 0.1, country: 'GB' }, 'Linux': { lat: 60.2, lng: 24.9, country: 'FI' },
  'Qualcomm': { lat: 32.9, lng: -117.2, country: 'US' }, 'Intel': { lat: 37.4, lng: -121.9, country: 'US' },
  'Mozilla': { lat: 37.4, lng: -122.1, country: 'US' }, 'Apache': { lat: 39.0, lng: -77.0, country: 'US' },
  'Zimbra': { lat: 37.4, lng: -122.1, country: 'US' }, 'Zoho': { lat: 13.1, lng: 80.3, country: 'IN' },
  'Mitel': { lat: 45.5, lng: -75.7, country: 'CA' }, 'Progress': { lat: 42.4, lng: -71.1, country: 'US' },
  'BeyondTrust': { lat: 33.5, lng: -86.8, country: 'US' }, 'ConnectWise': { lat: 27.9, lng: -82.5, country: 'US' },
  'Barracuda Networks': { lat: 37.4, lng: -122.0, country: 'US' }, 'SolarWinds': { lat: 30.3, lng: -97.7, country: 'US' },
  'Veritas': { lat: 37.4, lng: -122.1, country: 'US' },
};
const DEFAULT_CENTROID = { lat: 39.0, lng: -98.0, country: 'US' };

// Weakness classes (keyword hints from CISA's short description — not CWE).
const THREAT_CATEGORIES = {
  rce: ['remote code execution', 'rce', 'arbitrary code', 'code execution', 'command injection', 'os command'],
  auth_bypass: ['authentication bypass', 'bypass authentication', 'improper authentication', 'missing authentication', 'authorization bypass'],
  privilege_escalation: ['privilege escalation', 'elevation of privilege', 'local privilege'],
  injection: ['sql injection', 'code injection', 'xss', 'cross-site scripting', 'template injection'],
  deserialization: ['deserialization', 'unserialize'],
  path_traversal: ['path traversal', 'directory traversal', 'arbitrary file', 'file upload', 'file read', 'file write'],
  memory: ['buffer overflow', 'use-after-free', 'use after free', 'out-of-bounds', 'heap', 'memory corruption', 'type confusion', 'integer overflow'],
  ssrf: ['server-side request forgery', 'ssrf'],
  dos: ['denial of service', 'ddos'],
};

// Edge / network appliances a repo scan cannot fix — the UI labels these "confirm exposure, not patchable here".
const APPLIANCE_RE = /\b(netscaler|adc|gateway|fortios|fortigate|fortiproxy|pulse|ivanti|connect secure|policy secure|asa\b|firepower|ios xe|ios xr|nx-os|pan-os|globalprotect|sonicwall|sonicos|big-ip|f5|zyxel|draytek|mikrotik|routeros|firewall|vpn|router|switch|ipmi|idrac|ilo|camera|dvr|nvr|hikvision|dahua|exchange server|sharepoint server|vcenter|esxi|moveit|goanywhere)\b/i;

const PRC_KEYWORDS = ['china', 'chinese', 'prc', 'beijing', 'huawei', 'zte', 'hikvision', 'dahua', 'tp-link', 'apt1', 'apt10', 'apt27', 'apt40', 'apt41', 'hafnium', 'volt typhoon', 'salt typhoon', 'silk typhoon', 'mustang panda', 'winnti', 'stone panda', 'cicada'];

function categorize(v) {
  const text = `${v.vulnerabilityName || ''} ${v.shortDescription || ''}`.toLowerCase();
  const out = Object.entries(THREAT_CATEGORIES).filter(([, kws]) => kws.some(k => text.includes(k))).map(([c]) => c);
  return out.length ? out : ['other'];
}
function isPrcRelevant(v) {
  const text = `${v.vendorProject || ''} ${v.product || ''} ${v.shortDescription || ''}`.toLowerCase();
  return PRC_KEYWORDS.some(kw => text.includes(kw));
}
function vendorLocation(vendor) {
  if (!vendor) return DEFAULT_CENTROID;
  if (VENDOR_CENTROIDS[vendor]) return VENDOR_CENTROIDS[vendor];
  const lower = vendor.toLowerCase();
  for (const [name, loc] of Object.entries(VENDOR_CENTROIDS)) if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) return loc;
  return DEFAULT_CENTROID;
}
const dayOf = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const daysBetween = (a, b) => Math.ceil((b - a) / DAY);

export function enrich(v, now = Date.now()) {
  const loc = vendorLocation(v.vendorProject);
  const added = dayOf(v.dateAdded), due = dayOf(v.dueDate);
  const product = v.product || 'Unknown';
  return {
    cveID: v.cveID, vendor: v.vendorProject || 'Unknown', product, name: v.vulnerabilityName || v.cveID,
    dateAdded: v.dateAdded, dueDate: v.dueDate,
    ageDays: added != null ? Math.max(0, Math.floor((now - added) / DAY)) : null,
    dueInDays: due != null ? daysBetween(now, due) : null,
    description: (v.shortDescription || '').substring(0, 300),
    requiredAction: (v.requiredAction || '').substring(0, 200),
    ransomware: v.knownRansomwareCampaignUse === 'Known',
    categories: categorize(v),
    appliance: APPLIANCE_RE.test(`${v.vendorProject || ''} ${product}`),
    prcRelevant: isPrcRelevant(v),
    cwes: Array.isArray(v.cwes) ? v.cwes.slice(0, 4) : [],
    lat: loc.lat, lng: loc.lng, vendorCountry: loc.country,
    nvdUrl: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
  };
}

export function summarize(vulns, { now = Date.now() } = {}) {
  const all = (Array.isArray(vulns) ? vulns : []).map(v => enrich(v, now)).sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)) || a.cveID.localeCompare(b.cveID));
  const within = d => all.filter(v => v.ageDays != null && v.ageDays < d);
  const last7 = within(7), last30 = within(DELTA_DAYS);
  const byVendorMap = new Map();
  for (const v of last30) {
    const e = byVendorMap.get(v.vendor) || { vendor: v.vendor, count: 0, products: [], ransomware: 0, appliance: 0 };
    e.count++; if (v.ransomware) e.ransomware++; if (v.appliance) e.appliance++;
    if (!e.products.includes(v.product)) e.products.push(v.product);
    byVendorMap.set(v.vendor, e);
  }
  const byVendor = [...byVendorMap.values()].sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor)).map(e => ({ ...e, products: e.products.slice(0, 6) }));
  const categoryBreakdown = {};
  for (const v of last30) for (const c of v.categories) categoryBreakdown[c] = (categoryBreakdown[c] || 0) + 1;
  const dueSoon = all.filter(v => v.dueInDays != null && v.dueInDays >= 0 && v.dueInDays <= DUE_SOON_DAYS).sort((a, b) => a.dueInDays - b.dueInDays).slice(0, 25);
  const byCountry = {};
  for (const v of last30) { const k = v.vendorCountry; byCountry[k] = byCountry[k] || { count: 0, lat: v.lat, lng: v.lng }; byCountry[k].count++; }
  const globeMarkers = Object.entries(byCountry).map(([country, d]) => ({ country, count: d.count, lat: d.lat, lng: d.lng }));
  const signals = [];
  if (last7.length >= 5) signals.push({ severity: 'high', signal: `${last7.length} new CISA KEV entries in the last 7 days` });
  const rw7 = last7.filter(v => v.ransomware);
  if (rw7.length) signals.push({ severity: 'critical', signal: `${rw7.length} KEV addition${rw7.length === 1 ? '' : 's'} this week with known ransomware use` });
  const prc30 = last30.filter(v => v.prcRelevant);
  if (prc30.length) signals.push({ severity: 'high', signal: `${prc30.length} KEV additions in 30 days touch PRC vendors or PRC-attributed campaigns (keyword hint)` });
  return {
    totalVulnerabilities: all.length,
    deltaDays: DELTA_DAYS, dueSoonDays: DUE_SOON_DAYS,
    added7d: last7.length, added30d: last30.length,
    recentCount: last7.length,
    ransomwareCount: last30.filter(v => v.ransomware).length,
    prcRelevantCount: prc30.length,
    applianceCount: last30.filter(v => v.appliance).length,
    vulnerabilities: last30.slice(0, 60),
    dueSoon,
    byVendor,
    categoryBreakdown,
    globeMarkers,
    signals,
  };
}

export async function briefing() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;
  const data = await safeFetch(KEV_URL, { timeout: 20000 });
  if (data.error || !Array.isArray(data.vulnerabilities)) {
    console.log(`[CyberKEV] Fetch error: ${data.error || 'unexpected payload'}`);
    if (_cache) return _cache;
    return { source: 'CyberKEV', timestamp: new Date().toISOString(), status: 'unavailable', error: data.error || 'unexpected payload', totalVulnerabilities: 0, vulnerabilities: [], globeMarkers: [], signals: [] };
  }
  const result = {
    source: 'CyberKEV', timestamp: new Date().toISOString(), status: 'live',
    catalogVersion: data.catalogVersion || null, dateReleased: data.dateReleased || null,
    ...summarize(data.vulnerabilities),
  };
  _cache = result;
  _cacheTs = Date.now();
  return result;
}

if (process.argv[1]?.endsWith('cyberkev.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
