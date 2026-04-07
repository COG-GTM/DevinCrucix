// SpiderFoot — OSINT Automation & Reconnaissance
// Runs as a Docker container on the same VPS, connected internally to CRUCIX.
// Triggers scans on domains/entities flagged by other feeds.
// Results are surfaced in a dedicated SpiderFoot panel on the dashboard.

import { safeFetch } from '../utils/fetch.mjs';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://localhost:5001';

// Check if SpiderFoot is running
export async function isRunning() {
  try {
    const data = await safeFetch(`${SF_BASE}/scanlist`, { timeout: 5000 });
    return !data?.error;
  } catch {
    return false;
  }
}

// List all scans
export async function listScans() {
  return safeFetch(`${SF_BASE}/scanlist`, { timeout: 10000 });
}

// Start a new scan
export async function startScan(target, opts = {}) {
  const { scanName, modules } = opts;
  const params = new URLSearchParams({
    func: 'newscan',
    target,
    scanname: scanName || `Crucix-${target}-${Date.now()}`,
    usecase: 'all', // run all modules
  });
  if (modules) params.set('modules', modules);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${SF_BASE}/api?${params}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'User-Agent': 'Crucix/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `SpiderFoot scan start failed (HTTP ${res.status}): ${text.slice(0, 200)}` };
    }
    return await res.json().catch(() => ({ status: 'started', target }));
  } catch (e) {
    return { error: `SpiderFoot scan error: ${e.message}` };
  }
}

// Get scan results
export async function getScanResults(scanId, opts = {}) {
  const { eventType } = opts;
  const params = new URLSearchParams({ id: scanId });
  if (eventType) params.set('type', eventType);
  return safeFetch(`${SF_BASE}/scaneventresults?${params}`, { timeout: 15000 });
}

// Get scan status
export async function getScanStatus(scanId) {
  return safeFetch(`${SF_BASE}/scanstatus?id=${scanId}`, { timeout: 10000 });
}

// Get scan summary (event types and counts)
export async function getScanSummary(scanId) {
  return safeFetch(`${SF_BASE}/scansummary?id=${scanId}`, { timeout: 10000 });
}

// Briefing — check SpiderFoot status, list recent scans, surface key findings
export async function briefing() {
  const running = await isRunning();

  if (!running) {
    return {
      source: 'SpiderFoot',
      timestamp: new Date().toISOString(),
      status: 'offline',
      message: 'SpiderFoot container is not running. Deploy with: docker run -d -p 5001:5001 --name spiderfoot spiderfoot/spiderfoot',
      scans: [],
      findings: [],
    };
  }

  // Get list of scans
  const scanList = await listScans();
  const scans = Array.isArray(scanList) ? scanList : [];

  // Get summaries for recent scans (last 5)
  const recentScans = scans.slice(0, 5);
  const scanDetails = [];
  const allFindings = [];

  for (const scan of recentScans) {
    const scanId = scan[0] || scan.id;
    const scanName = scan[1] || scan.name || 'Unknown';
    const scanTarget = scan[2] || scan.target || '';
    const scanStatus = scan[5] || scan.status || 'unknown';
    const scanStarted = scan[3] || scan.started || '';

    let summary = [];
    try {
      const summaryData = await getScanSummary(scanId);
      if (Array.isArray(summaryData)) {
        summary = summaryData.map(s => ({
          type: s[0] || s.type,
          count: s[1] || s.count || 0,
        })).filter(s => s.count > 0).slice(0, 10);

        // Extract high-value findings
        const highValueTypes = [
          'EMAILADDR', 'PHONE_NUMBER', 'VULNERABILITY', 'MALICIOUS_ASN',
          'MALICIOUS_IPADDR', 'DARKNET_MENTION', 'AFFILIATE_DOMAIN',
          'LINKED_URL_MALICIOUS', 'BLACKLISTED_IPADDR', 'DEFACED_AFFILIATE',
        ];
        for (const hvt of highValueTypes) {
          const match = summary.find(s => s.type === hvt);
          if (match && match.count > 0) {
            allFindings.push({
              scanTarget,
              type: hvt,
              count: match.count,
              scanName,
            });
          }
        }
      }
    } catch (e) { /* summary optional */ }

    scanDetails.push({
      id: scanId,
      name: scanName,
      target: scanTarget,
      status: scanStatus,
      started: scanStarted,
      summary: summary.slice(0, 10),
    });
  }

  return {
    source: 'SpiderFoot',
    timestamp: new Date().toISOString(),
    status: 'online',
    sfUrl: SF_BASE,
    totalScans: scans.length,
    recentScans: scanDetails,
    findings: allFindings.slice(0, 20),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('spiderfoot.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
