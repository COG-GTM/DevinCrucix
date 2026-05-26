// DEFCON Threat Meter — Composite global tension score
// Adapted from OSINT-War-Room frontend/js/map.js threat meter logic (MIT licensed)
// Computes a 0-100 tension score from multiple data streams and maps to DEFCON 1-5.

// Weight allocation:
// - GDELT conflict events 24h:       30%
// - Average CII score:               25%
// - Active convergence zones:         20%
// - Active high-confidence signals:   15%
// - Polymarket avg geopolitical risk: 10%

const DEFCON_LEVELS = [
  { level: 5, min: 0,  max: 20, color: '#00ff41', label: 'NORMAL READINESS' },
  { level: 4, min: 21, max: 40, color: '#00bfff', label: 'INCREASED READINESS' },
  { level: 3, min: 41, max: 60, color: '#ffff00', label: 'ROUND THE CLOCK READINESS' },
  { level: 2, min: 61, max: 80, color: '#ff8c00', label: 'FURTHER INCREASED READINESS' },
  { level: 1, min: 81, max: 100, color: '#ff0040', label: 'MAXIMUM READINESS' },
];

/**
 * Compute composite tension score from available data sources
 * @param {object} sources - Raw sweep source data
 * @param {object} analyticalData - Post-sweep computed data (CII, convergence, signals, polymarket)
 * @returns {object} DEFCON result with level, score, components, and metadata
 */
export function computeDefcon(sources, analyticalData = {}) {
  const components = {};
  let totalWeight = 0;
  let weightedSum = 0;

  // Component 1: GDELT conflict events (30% weight) — always available
  const gdeltData = sources.GDELT || {};
  const gdeltConflicts = (gdeltData.conflicts || []).length;
  const gdeltTotal = (gdeltData.totalArticles || 0);
  // Normalize: 0 conflicts = 0, 50+ conflicts = 100
  const gdeltScore = Math.min(100, Math.round((gdeltConflicts / 50) * 100));
  components.gdelt = {
    score: gdeltScore,
    weight: 0.30,
    detail: `${gdeltConflicts} conflict events, ${gdeltTotal} total articles`,
    available: true,
  };
  weightedSum += gdeltScore * 0.30;
  totalWeight += 0.30;

  // Component 2: Average CII score (25% weight)
  const ciiData = analyticalData.cii || {};
  const ciiCountries = ciiData.countries || [];
  if (ciiCountries.length > 0) {
    const avgCII = Math.round(ciiCountries.reduce((sum, c) => sum + (c.score || 0), 0) / ciiCountries.length);
    components.cii = {
      score: avgCII,
      weight: 0.25,
      detail: `Avg instability: ${avgCII}/100 across ${ciiCountries.length} countries`,
      available: true,
    };
    weightedSum += avgCII * 0.25;
    totalWeight += 0.25;
  } else {
    components.cii = { score: 0, weight: 0.25, detail: 'CII not available', available: false };
    // Redistribute weight to GDELT
    weightedSum += gdeltScore * 0.25;
    totalWeight += 0.25;
  }

  // Component 3: Active convergence zones (20% weight)
  const convData = analyticalData.convergence || {};
  const convZones = convData.totalZones || 0;
  if (convZones > 0 || convData.zones) {
    // Normalize: 0 zones = 0, 10+ zones = 100
    const convScore = Math.min(100, Math.round((convZones / 10) * 100));
    components.convergence = {
      score: convScore,
      weight: 0.20,
      detail: `${convZones} active convergence zones`,
      available: true,
    };
    weightedSum += convScore * 0.20;
    totalWeight += 0.20;
  } else {
    components.convergence = { score: 0, weight: 0.20, detail: 'Convergence not available', available: false };
    weightedSum += gdeltScore * 0.20;
    totalWeight += 0.20;
  }

  // Component 4: Active high-confidence signals (15% weight)
  const sigData = analyticalData.signals || {};
  const allSignals = sigData.signals || [];
  const highConfSignals = allSignals.filter(s => (s.confidence || 0) >= 70);
  if (allSignals.length > 0 || sigData.totalSignals != null) {
    // Normalize: 0 high-conf signals = 0, 10+ = 100
    const sigScore = Math.min(100, Math.round((highConfSignals.length / 10) * 100));
    components.signals = {
      score: sigScore,
      weight: 0.15,
      detail: `${highConfSignals.length} high-confidence signals (≥70%)`,
      available: true,
    };
    weightedSum += sigScore * 0.15;
    totalWeight += 0.15;
  } else {
    components.signals = { score: 0, weight: 0.15, detail: 'Signals not available', available: false };
    weightedSum += gdeltScore * 0.15;
    totalWeight += 0.15;
  }

  // Component 5: Polymarket avg geopolitical risk (10% weight)
  const polyData = analyticalData.polymarket || {};
  const avgGeoRisk = polyData.avgGeoRisk;
  if (avgGeoRisk != null && polyData.status !== 'unavailable') {
    components.polymarket = {
      score: avgGeoRisk,
      weight: 0.10,
      detail: `Avg geopolitical probability: ${avgGeoRisk}%`,
      available: true,
    };
    weightedSum += avgGeoRisk * 0.10;
    totalWeight += 0.10;
  } else {
    components.polymarket = { score: 0, weight: 0.10, detail: 'Polymarket not available', available: false };
    weightedSum += gdeltScore * 0.10;
    totalWeight += 0.10;
  }

  // Final composite score
  const compositeScore = Math.round(weightedSum / totalWeight * 100) / 100;
  const finalScore = Math.min(100, Math.max(0, Math.round(compositeScore)));

  // Map to DEFCON level
  const defconLevel = DEFCON_LEVELS.find(d => finalScore >= d.min && finalScore <= d.max)
    || DEFCON_LEVELS[0];

  // Count available vs unavailable components
  const availableCount = Object.values(components).filter(c => c.available).length;

  return {
    source: 'DEFCON',
    timestamp: new Date().toISOString(),
    level: defconLevel.level,
    score: finalScore,
    color: defconLevel.color,
    label: defconLevel.label,
    pulse: defconLevel.level <= 2, // Pulsing animation at levels 2 and 1
    components,
    availableSources: availableCount,
    totalSources: 5,
    fallbackMode: availableCount <= 1, // GDELT-only
  };
}

// Briefing function (stub — computed post-sweep like CII)
export async function briefing() {
  return {
    source: 'DEFCON',
    timestamp: new Date().toISOString(),
    status: 'deferred',
    note: 'DEFCON is computed post-sweep from aggregated source data',
  };
}

// Run standalone
if (process.argv[1]?.endsWith('defcon.mjs')) {
  console.log('DEFCON module — computed post-sweep, no standalone data.');
  console.log(JSON.stringify(computeDefcon({}, {}), null, 2));
}
