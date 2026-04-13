// CISA KEV Cyber Threat Layer — Enhanced vulnerability visualization
// Extends existing cisa-kev.mjs with globe-ready data: vendor HQ centroids,
// threat type categorization, PRC relevance flagging, severity badges.
// Adapted from OSINT-War-Room backend/api/radar.py GET /api/radar/cyber (MIT licensed)
// Data source: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json (free, no key)

import { safeFetch } from '../utils/fetch.mjs';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let _cache = null;
let _cacheTs = 0;

// Vendor HQ country centroids for globe rendering
const VENDOR_CENTROIDS = {
  'Microsoft': { lat: 47.6, lng: -122.3, country: 'US' },
  'Apple': { lat: 37.3, lng: -122.0, country: 'US' },
  'Google': { lat: 37.4, lng: -122.1, country: 'US' },
  'Adobe': { lat: 37.3, lng: -121.9, country: 'US' },
  'Cisco': { lat: 37.4, lng: -121.9, country: 'US' },
  'Oracle': { lat: 37.5, lng: -122.3, country: 'US' },
  'VMware': { lat: 37.4, lng: -122.1, country: 'US' },
  'Fortinet': { lat: 37.4, lng: -122.0, country: 'US' },
  'Palo Alto Networks': { lat: 37.4, lng: -122.1, country: 'US' },
  'Ivanti': { lat: 40.3, lng: -111.7, country: 'US' },
  'Citrix': { lat: 26.4, lng: -80.1, country: 'US' },
  'SonicWall': { lat: 37.0, lng: -121.6, country: 'US' },
  'Atlassian': { lat: -33.9, lng: 151.2, country: 'AU' },
  'SAP': { lat: 49.3, lng: 8.6, country: 'DE' },
  'Siemens': { lat: 48.1, lng: 11.6, country: 'DE' },
  'Samsung': { lat: 37.3, lng: 127.0, country: 'KR' },
  'Huawei': { lat: 22.6, lng: 114.1, country: 'CN' },
  'ZTE': { lat: 22.5, lng: 114.1, country: 'CN' },
  'Hikvision': { lat: 30.3, lng: 120.2, country: 'CN' },
  'Dahua': { lat: 30.3, lng: 120.2, country: 'CN' },
  'TP-Link': { lat: 22.5, lng: 114.1, country: 'CN' },
  'D-Link': { lat: 25.0, lng: 121.5, country: 'TW' },
  'ASUS': { lat: 25.0, lng: 121.5, country: 'TW' },
  'Zyxel': { lat: 24.8, lng: 121.0, country: 'TW' },
  'Trend Micro': { lat: 35.7, lng: 139.7, country: 'JP' },
  'Sophos': { lat: 51.7, lng: -1.3, country: 'GB' },
  'Arm': { lat: 52.2, lng: 0.1, country: 'GB' },
  'Linux': { lat: 60.2, lng: 24.9, country: 'FI' },
  'Qualcomm': { lat: 32.9, lng: -117.2, country: 'US' },
  'Intel': { lat: 37.4, lng: -121.9, country: 'US' },
  'Mozilla': { lat: 37.4, lng: -122.1, country: 'US' },
  'Apache': { lat: 39.0, lng: -77.0, country: 'US' }, // Apache Software Foundation
  'Zimbra': { lat: 37.4, lng: -122.1, country: 'US' },
  'Zoho': { lat: 13.1, lng: 80.3, country: 'IN' },
  'Mitel': { lat: 45.5, lng: -75.7, country: 'CA' },
  'Progress': { lat: 42.4, lng: -71.1, country: 'US' },
  'BeyondTrust': { lat: 33.5, lng: -86.8, country: 'US' },
  'ConnectWise': { lat: 27.9, lng: -82.5, country: 'US' },
  'Barracuda Networks': { lat: 37.4, lng: -122.0, country: 'US' },
  'SolarWinds': { lat: 30.3, lng: -97.7, country: 'US' },
  'Veritas': { lat: 37.4, lng: -122.1, country: 'US' },
};

// Default US centroid for unknown vendors
const DEFAULT_CENTROID = { lat: 39.0, lng: -98.0, country: 'US' };

// Threat type keyword matching
const THREAT_CATEGORIES = {
  ransomware: ['ransomware', 'ransom', 'encrypt', 'locker'],
  rce: ['remote code execution', 'rce', 'arbitrary code', 'code execution'],
  exploit: ['exploit', 'zero-day', '0-day', 'actively exploited'],
  ddos: ['denial of service', 'ddos', 'dos attack'],
  malware: ['malware', 'trojan', 'backdoor', 'rootkit', 'worm'],
  breach: ['data breach', 'data leak', 'exfiltration', 'unauthorized access'],
  privilege_escalation: ['privilege escalation', 'elevation of privilege', 'local privilege'],
  injection: ['sql injection', 'command injection', 'code injection', 'xss', 'cross-site'],
};

// PRC-related keywords for relevance flagging
const PRC_KEYWORDS = [
  'china', 'chinese', 'prc', 'beijing', 'huawei', 'zte', 'hikvision',
  'dahua', 'tp-link', 'apt1', 'apt10', 'apt27', 'apt40', 'apt41',
  'hafnium', 'volt typhoon', 'salt typhoon', 'silk typhoon',
  'mustang panda', 'winnti', 'stone panda', 'cicada',
];

function categorizeThreat(vuln) {
  const text = `${vuln.vulnerabilityName || ''} ${vuln.shortDescription || ''}`.toLowerCase();
  const categories = [];
  for (const [cat, keywords] of Object.entries(THREAT_CATEGORIES)) {
    if (keywords.some(kw => text.includes(kw))) {
      categories.push(cat);
    }
  }
  return categories.length > 0 ? categories : ['exploit'];
}

function isPrcRelevant(vuln) {
  const text = `${vuln.vendorProject || ''} ${vuln.product || ''} ${vuln.shortDescription || ''}`.toLowerCase();
  return PRC_KEYWORDS.some(kw => text.includes(kw));
}

function getSeverity(vuln) {
  const isRansomware = vuln.knownRansomwareCampaignUse === 'Known';
  const desc = (vuln.shortDescription || '').toLowerCase();
  const isRCE = desc.includes('remote code execution') || desc.includes('arbitrary code');

  if (isRansomware && isRCE) return 'critical';
  if (isRansomware) return 'high';
  if (isRCE) return 'high';
  if (desc.includes('privilege escalation')) return 'medium';
  return 'medium';
}

function getVendorLocation(vendor) {
  if (!vendor) return DEFAULT_CENTROID;
  // Try exact match first
  if (VENDOR_CENTROIDS[vendor]) return VENDOR_CENTROIDS[vendor];
  // Try partial match
  const lower = vendor.toLowerCase();
  for (const [name, loc] of Object.entries(VENDOR_CENTROIDS)) {
    if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) {
      return loc;
    }
  }
  return DEFAULT_CENTROID;
}

export async function briefing() {
  // Return cache if fresh
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  const data = await safeFetch(KEV_URL, { timeout: 20000 });

  if (data.error) {
    console.log(`[CyberKEV] Fetch error: ${data.error}`);
    if (_cache) return _cache;
    return {
      source: 'CyberKEV',
      timestamp: new Date().toISOString(),
      status: 'unavailable',
      error: data.error,
      totalVulnerabilities: 0,
      vulnerabilities: [],
      globeMarkers: [],
      signals: [],
    };
  }

  const vulns = data.vulnerabilities || [];

  // Sort by dateAdded descending, take most recent 50
  const sorted = [...vulns].sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
  const recent = sorted.slice(0, 50);

  // Build enriched vulnerability entries
  const enriched = recent.map(v => {
    const loc = getVendorLocation(v.vendorProject);
    const categories = categorizeThreat(v);
    const prcRelevant = isPrcRelevant(v);
    const severity = getSeverity(v);

    return {
      cveID: v.cveID,
      vendor: v.vendorProject || 'Unknown',
      product: v.product || 'Unknown',
      name: v.vulnerabilityName || v.cveID,
      dateAdded: v.dateAdded,
      dueDate: v.dueDate,
      description: (v.shortDescription || '').substring(0, 300),
      ransomware: v.knownRansomwareCampaignUse === 'Known',
      categories,
      severity,
      prcRelevant,
      lat: loc.lat + (Math.random() - 0.5) * 0.5, // jitter to avoid overlap
      lng: loc.lng + (Math.random() - 0.5) * 0.5,
      vendorCountry: loc.country,
      nvdUrl: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
    };
  });

  // Globe markers grouped by vendor country
  const byCountry = {};
  for (const v of enriched) {
    const key = v.vendorCountry || 'US';
    if (!byCountry[key]) byCountry[key] = { count: 0, lat: v.lat, lng: v.lng };
    byCountry[key].count++;
  }
  const globeMarkers = Object.entries(byCountry).map(([country, data]) => ({
    country, count: data.count, lat: data.lat, lng: data.lng,
  }));

  // Category breakdown
  const categoryBreakdown = {};
  for (const v of enriched) {
    for (const cat of v.categories) {
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
    }
  }

  // Signals
  const signals = [];
  const prcVulns = enriched.filter(v => v.prcRelevant);
  if (prcVulns.length > 0) {
    signals.push({
      severity: 'high',
      signal: `${prcVulns.length} CVEs flagged as PRC-relevant (Chinese vendors or APT groups)`,
    });
  }
  const ransomwareVulns = enriched.filter(v => v.ransomware);
  if (ransomwareVulns.length > 3) {
    signals.push({
      severity: 'critical',
      signal: `${ransomwareVulns.length} actively exploited CVEs linked to ransomware campaigns`,
    });
  }

  // Recent 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
  const recentWeek = enriched.filter(v => new Date(v.dateAdded) >= sevenDaysAgo);
  if (recentWeek.length > 5) {
    signals.push({
      severity: 'high',
      signal: `${recentWeek.length} new KEV entries in last 7 days — elevated exploit activity`,
    });
  }

  const result = {
    source: 'CyberKEV',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalVulnerabilities: vulns.length,
    recentCount: enriched.length,
    vulnerabilities: enriched,
    globeMarkers,
    categoryBreakdown,
    prcRelevantCount: prcVulns.length,
    ransomwareCount: ransomwareVulns.length,
    signals,
  };

  _cache = result;
  _cacheTs = Date.now();

  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('cyberkev.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
