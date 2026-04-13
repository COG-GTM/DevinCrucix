// Pentagon Pizza Index — DOUGHCON threat indicator
// Polls https://monitor-the-situation.com/api/pizza every 5 minutes
// Adapted from OSINT-War-Room backend/api/economy.py (MIT licensed)
// Tracks Domino's delivery wait times near the Pentagon as a proxy
// for late-night government activity surges.

import { safeFetch } from '../utils/fetch.mjs';

const PIZZA_API = 'https://monitor-the-situation.com/api/pizza';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _cache = null;
let _cacheTs = 0;
let _history = []; // rolling 24h sparkline data

// Map alert level string to DOUGHCON number (inverted: high activity = low DOUGHCON)
const LEVEL_MAP = { low: 4, elevated: 3, high: 2, critical: 1 };

// Configurable alert threshold (DOUGHCON level at or below triggers signal)
const ALERT_THRESHOLD = parseInt(process.env.PIZZA_ALERT_THRESHOLD) || 2;

export async function fetchPizzaIndex() {
  try {
    const raw = await safeFetch(PIZZA_API, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' },
    });

    if (raw.error) {
      console.log(`[Pizza] API error: ${raw.error}`);
      return _cache || { status: 'unavailable', error: raw.error };
    }

    const current = raw.current || {};
    const history = raw.history || [];
    const baselines = raw.baselines || {};

    const alertLevel = (current.alertLevel || current.alert_level || 'low').toLowerCase();
    const doughcon = LEVEL_MAP[alertLevel] || 4;
    const avgWait = current.avgDeliveryWait || current.avg_delivery_wait || 0;

    // Build sparkline from history (last 24 points)
    const graphPoints = history.slice(-24).map(h => ({
      ts: h.ts || '',
      avgWait: h.avgWait || h.avg_wait || 0,
      alertLevel: (h.alertLevel || h.alert_level || 'low').toLowerCase(),
    }));

    // Determine trend from last 3 data points
    let trend = 'stable';
    if (graphPoints.length >= 3) {
      const recent = graphPoints.slice(-3).map(p => p.avgWait);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const oldest = graphPoints.slice(-6, -3).map(p => p.avgWait);
      if (oldest.length > 0) {
        const oldAvg = oldest.reduce((a, b) => a + b, 0) / oldest.length;
        if (avg > oldAvg * 1.15) trend = 'rising';
        else if (avg < oldAvg * 0.85) trend = 'falling';
      }
    }

    // Compute stores open
    const stores = current.stores || [];
    const storesOpen = stores.filter(s => s.isOpen || s.is_open).length;

    const result = {
      source: 'PizzaIndex',
      timestamp: new Date().toISOString(),
      status: 'live',
      doughcon,
      alertLevel,
      avgWait: Math.round(avgWait * 10) / 10,
      storesOpen,
      totalStores: stores.length,
      trend,
      graph: graphPoints,
      apiTimestamp: raw.timestamp || '',
      baselines: {
        normalWait: baselines.normalWait || baselines.normal_wait || 0,
        elevatedWait: baselines.elevatedWait || baselines.elevated_wait || 0,
      },
    };

    // Generate signal if threshold breached
    const signals = [];
    if (doughcon <= ALERT_THRESHOLD) {
      signals.push({
        severity: doughcon === 1 ? 'critical' : 'high',
        signal: `DOUGHCON ${doughcon} — Pentagon-area pizza delivery times ${alertLevel}. Avg wait: ${result.avgWait} min.`,
      });
    }
    result.signals = signals;

    _cache = result;
    _cacheTs = Date.now();

    return result;
  } catch (err) {
    console.log(`[Pizza] Fetch error: ${err.message}`);
    if (_cache) return _cache;
    return {
      source: 'PizzaIndex',
      timestamp: new Date().toISOString(),
      status: 'unavailable',
      error: err.message,
      doughcon: null,
      alertLevel: 'unknown',
      graph: [],
      signals: [],
    };
  }
}

// Briefing function for sweep integration
export async function briefing() {
  return fetchPizzaIndex();
}

// Run standalone
if (process.argv[1]?.endsWith('pizzaindex.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
