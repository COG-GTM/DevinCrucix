// Space Weather — NOAA Space Weather Prediction Center
// Real-time solar activity: Kp geomagnetic index, solar flare tracking, CME alerts
// Ported from Osiris OSINT platform's space-weather API
// FREE — no API key required
// Relevant for GPS jamming correlation and space domain awareness

import { safeFetch } from '../utils/fetch.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let _cache = null;
let _cacheTs = 0;

const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const ALERTS_URL = 'https://services.swpc.noaa.gov/json/alerts.json';
const FLARE_URL = 'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json';

function classifyKp(kp) {
  if (kp >= 9) return { level: 'Extreme G5', color: '#8B0000', severity: 'critical' };
  if (kp >= 8) return { level: 'Severe G4', color: '#FF0000', severity: 'critical' };
  if (kp >= 7) return { level: 'Strong G3', color: '#FF4500', severity: 'high' };
  if (kp >= 6) return { level: 'Moderate G2', color: '#FF8C00', severity: 'elevated' };
  if (kp >= 5) return { level: 'Minor G1', color: '#FFD700', severity: 'elevated' };
  if (kp >= 4) return { level: 'Active', color: '#90EE90', severity: 'low' };
  return { level: 'Quiet', color: '#00E676', severity: 'nominal' };
}

export async function fetchSpaceWeather() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  const [kpResult, alertsResult, flaresResult] = await Promise.allSettled([
    safeFetch(KP_URL, { timeout: 10000 }),
    safeFetch(ALERTS_URL, { timeout: 10000 }),
    safeFetch(FLARE_URL, { timeout: 10000 }),
  ]);

  // Parse Kp index
  let currentKp = 0;
  let kpHistory = [];
  if (kpResult.status === 'fulfilled' && Array.isArray(kpResult.value)) {
    const kpData = kpResult.value;
    const recent = kpData.slice(-48); // last 48 one-minute readings
    if (recent.length > 0) {
      currentKp = parseFloat(recent[recent.length - 1]?.kp_index) || 0;
      // Sample every ~15 readings for sparkline (last ~48 points)
      kpHistory = recent.filter((_, i) => i % 1 === 0).map(r => ({
        ts: r.time_tag,
        kp: parseFloat(r.kp_index) || 0,
      })).slice(-24);
    }
  }

  const kpClass = classifyKp(currentKp);

  // Parse alerts (CME, geomagnetic storms, etc.)
  let recentAlerts = [];
  if (alertsResult.status === 'fulfilled' && Array.isArray(alertsResult.value)) {
    recentAlerts = alertsResult.value
      .slice(0, 10)
      .map(a => ({
        issueTime: a.issue_datetime || a.issue_time || '',
        message: (a.message || '').substring(0, 300),
        productId: a.product_id || '',
      }));
  }

  // Parse solar flares
  let recentFlares = [];
  if (flaresResult.status === 'fulfilled' && Array.isArray(flaresResult.value)) {
    recentFlares = flaresResult.value
      .slice(0, 10)
      .map(f => ({
        beginTime: f.begin_time || '',
        peakTime: f.max_time || '',
        endTime: f.end_time || '',
        classType: f.max_class || f.current_class || '',
        flux: f.max_xrlong || 0,
      }));
  }

  // Generate signals
  const signals = [];
  if (currentKp >= 5) {
    signals.push({
      severity: kpClass.severity,
      signal: `Geomagnetic storm: ${kpClass.level} (Kp=${currentKp}). GPS/HF radio degradation possible.`,
    });
  }
  for (const flare of recentFlares.slice(0, 3)) {
    if (flare.classType && flare.classType.startsWith('X')) {
      signals.push({
        severity: 'high',
        signal: `X-class solar flare detected: ${flare.classType} at ${flare.peakTime}. HF radio blackout likely.`,
      });
    } else if (flare.classType && flare.classType.startsWith('M')) {
      signals.push({
        severity: 'elevated',
        signal: `M-class solar flare: ${flare.classType} at ${flare.peakTime}. Minor radio degradation possible.`,
      });
    }
  }

  const result = {
    source: 'SpaceWeather',
    timestamp: new Date().toISOString(),
    status: 'live',
    kp: {
      current: currentKp,
      level: kpClass.level,
      color: kpClass.color,
      severity: kpClass.severity,
      history: kpHistory,
    },
    flares: recentFlares,
    alerts: recentAlerts,
    signals,
  };

  _cache = result;
  _cacheTs = Date.now();
  return result;
}

export async function briefing() {
  return fetchSpaceWeather();
}

if (process.argv[1]?.endsWith('spaceweather.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
