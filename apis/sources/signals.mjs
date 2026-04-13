// Signal Intelligence Engine — Correlation engine detecting patterns across data streams
// Implements 6 signal types with source tier ranking and propaganda risk flagging
// Clean-room implementation based on behavioral specification

import '../utils/env.mjs';

// === Source Tier Ranking (1=most authoritative to 4=least) ===
const SOURCE_TIERS = {
  // Tier 1: Most authoritative
  'Reuters': 1, 'AP': 1, 'AFP': 1, 'Bloomberg': 1, 'White House': 1, 'Pentagon': 1,
  // Tier 2: Major international
  'BBC': 2, 'Guardian': 2, 'NPR': 2, 'Al Jazeera': 2, 'CNBC': 2, 'FT': 2,
  'NYT': 2, 'France 24': 2, 'DW': 2,
  // Tier 3: Specialized/analytical
  'Defense One': 3, 'Bellingcat': 3, 'Foreign Policy': 3, 'INSIGHT CRIME': 3,
  // Tier 4: Aggregators
  'Hacker News': 4, 'The Verge': 4, 'Reddit': 4, 'Bluesky': 4,
};

// Source type categories for triangulation
const SOURCE_TYPES = {
  Wire: ['Reuters', 'AP', 'AFP', 'Bloomberg'],
  Gov: ['White House', 'Pentagon'],
  Intel: ['Bellingcat', 'Defense One', 'Foreign Policy'],
  Mainstream: ['BBC', 'NPR', 'NYT', 'Guardian', 'Al Jazeera', 'DW', 'France 24'],
  Market: ['CNBC', 'FT', 'Bloomberg'],
  Tech: ['Hacker News', 'The Verge'],
};

// Propaganda risk flagging
const PROPAGANDA_RISK = {
  high: ['Xinhua', 'TASS', 'RT', 'CGTN', 'PressTV'],
  medium: ['Al Jazeera', 'TRT World'],
};

// Dedup TTL by signal type (ms)
const DEDUP_TTL = {
  market: 6 * 60 * 60 * 1000,       // 6h
  prediction: 2 * 60 * 60 * 1000,   // 2h
  default: 30 * 60 * 1000,          // 30min
};

// Signal dedup cache
const signalCache = new Map();

function getSourceTier(source) {
  return SOURCE_TIERS[source] || 4;
}

function getSourceType(source) {
  for (const [type, sources] of Object.entries(SOURCE_TYPES)) {
    if (sources.includes(source)) return type;
  }
  return 'Other';
}

function getPropagandaRisk(source) {
  if (PROPAGANDA_RISK.high.includes(source)) return 'high';
  if (PROPAGANDA_RISK.medium.includes(source)) return 'medium';
  return 'none';
}

// Simple content hash for dedup
function contentHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// Check dedup cache
function isDuplicate(signalType, key) {
  const ttl = DEDUP_TTL[signalType] || DEDUP_TTL.default;
  const cached = signalCache.get(key);
  if (cached && (Date.now() - cached) < ttl) return true;
  signalCache.set(key, Date.now());
  return false;
}

// Prune expired dedup entries
function pruneCache() {
  const maxTTL = Math.max(...Object.values(DEDUP_TTL));
  const cutoff = Date.now() - maxTTL;
  for (const [key, ts] of signalCache) {
    if (ts < cutoff) signalCache.delete(key);
  }
}

// === Signal Type 1: Convergence (3+ source types report same story within 30 min) ===
function detectConvergenceSignals(newsItems) {
  const signals = [];
  const storyGroups = new Map();

  // Group news by simplified key (first 30 chars lowercase)
  for (const item of newsItems) {
    const title = (item.title || item.headline || '').toLowerCase().trim();
    if (title.length < 10) continue;

    // Simple story grouping by keyword overlap
    const words = new Set(title.split(/\s+/).filter(w => w.length > 3));
    let matched = false;

    for (const [groupKey, group] of storyGroups) {
      const groupWords = group.words;
      const overlap = [...words].filter(w => groupWords.has(w)).length;
      const similarity = overlap / Math.max(words.size, groupWords.size);
      if (similarity > 0.3) {
        group.items.push(item);
        for (const w of words) groupWords.add(w);
        matched = true;
        break;
      }
    }

    if (!matched) {
      storyGroups.set(title.substring(0, 40), { words, items: [item] });
    }
  }

  // Find groups with 3+ distinct source types
  for (const [key, group] of storyGroups) {
    const sourceTypes = new Set(group.items.map(i => getSourceType(i.source)));
    if (sourceTypes.size >= 3) {
      const hash = contentHash(key);
      if (isDuplicate('default', `conv-${hash}`)) continue;

      const bestTier = Math.min(...group.items.map(i => getSourceTier(i.source)));
      const confidence = Math.min(95, 60 + sourceTypes.size * 8 + (4 - bestTier) * 5);

      signals.push({
        type: 'Convergence',
        confidence,
        title: group.items[0].title || group.items[0].headline || key,
        sources: [...new Set(group.items.map(i => i.source))],
        sourceTypes: Array.from(sourceTypes),
        sourceCount: group.items.length,
        whyItMatters: `${sourceTypes.size} independent source types are reporting the same story, indicating high-confidence intelligence.`,
        actionableInsight: `Cross-validated by ${Array.from(sourceTypes).join(', ')} sources. Treat as confirmed intelligence.`,
        timestamp: new Date().toISOString(),
        propagandaFlags: group.items
          .filter(i => getPropagandaRisk(i.source) !== 'none')
          .map(i => ({ source: i.source, risk: getPropagandaRisk(i.source) })),
      });
    }
  }

  return signals;
}

// === Signal Type 2: Triangulation (Wire + Government + Intel sources align) ===
function detectTriangulation(newsItems) {
  const signals = [];
  const storyGroups = new Map();

  for (const item of newsItems) {
    const title = (item.title || item.headline || '').toLowerCase().trim();
    if (title.length < 10) continue;

    const words = new Set(title.split(/\s+/).filter(w => w.length > 3));
    let matched = false;

    for (const [groupKey, group] of storyGroups) {
      const overlap = [...words].filter(w => group.words.has(w)).length;
      if (overlap / Math.max(words.size, group.words.size) > 0.35) {
        group.items.push(item);
        matched = true;
        break;
      }
    }

    if (!matched) {
      storyGroups.set(title.substring(0, 40), { words, items: [item] });
    }
  }

  for (const [key, group] of storyGroups) {
    const types = new Set(group.items.map(i => getSourceType(i.source)));
    if (types.has('Wire') && types.has('Gov') && types.has('Intel')) {
      const hash = contentHash(key);
      if (isDuplicate('default', `tri-${hash}`)) continue;

      signals.push({
        type: 'Triangulation',
        confidence: 88,
        title: group.items[0].title || group.items[0].headline || key,
        sources: [...new Set(group.items.map(i => i.source))],
        sourceTypes: ['Wire', 'Gov', 'Intel'],
        whyItMatters: 'Wire services, government sources, and intelligence analysts all confirm the same narrative — highest reliability signal.',
        actionableInsight: 'Triple-sourced intelligence. This is actionable with high confidence.',
        timestamp: new Date().toISOString(),
        propagandaFlags: [],
      });
    }
  }

  return signals;
}

// === Signal Type 3: Velocity Spike (mention rate doubles, 6+ sources/hour) ===
function detectVelocitySpike(newsItems) {
  const signals = [];

  // Count mentions by topic keyword in recent window
  const topicCounts = new Map();
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  for (const item of newsItems) {
    const title = (item.title || item.headline || '').toLowerCase();
    const ts = item.timestamp ? new Date(item.timestamp).getTime() : now;
    if (now - ts > 2 * oneHour) continue; // only last 2 hours

    // Extract key topic words
    const words = title.split(/\s+/).filter(w => w.length > 4);
    for (const word of words) {
      if (!topicCounts.has(word)) topicCounts.set(word, { recent: 0, older: 0, sources: new Set() });
      const entry = topicCounts.get(word);
      if (now - ts <= oneHour) {
        entry.recent++;
        entry.sources.add(item.source);
      } else {
        entry.older++;
      }
    }
  }

  for (const [topic, counts] of topicCounts) {
    if (counts.recent >= 6 && counts.sources.size >= 3 && counts.recent > counts.older * 2) {
      const hash = contentHash(topic);
      if (isDuplicate('default', `vel-${hash}`)) continue;

      signals.push({
        type: 'Velocity Spike',
        confidence: Math.min(90, 65 + counts.sources.size * 3),
        title: `Velocity spike: "${topic}" — ${counts.recent} mentions in last hour`,
        topic,
        mentionRate: counts.recent,
        sourceCount: counts.sources.size,
        sources: Array.from(counts.sources),
        whyItMatters: `Topic mention rate has doubled with ${counts.sources.size} independent sources reporting in the last hour.`,
        actionableInsight: `Rapidly developing situation around "${topic}". Monitor for escalation.`,
        timestamp: new Date().toISOString(),
        propagandaFlags: [],
      });
    }
  }

  return signals;
}

// === Signal Type 4: Geographic Convergence (from Feature 2) ===
function detectGeoConvergence(convergenceData) {
  const signals = [];
  const zones = convergenceData?.zones || [];

  for (const zone of zones) {
    if (zone.alertLevel === 'Critical' || zone.alertLevel === 'High') {
      const hash = contentHash(`${zone.gridLat},${zone.gridLng}`);
      if (isDuplicate('default', `geo-${hash}`)) continue;

      signals.push({
        type: 'Geographic Convergence',
        confidence: Math.min(92, 60 + zone.typeCount * 8),
        title: `Multi-domain convergence at ${zone.lat.toFixed(1)}°, ${zone.lng.toFixed(1)}°`,
        lat: zone.lat,
        lng: zone.lng,
        eventTypes: zone.eventTypes,
        typeCount: zone.typeCount,
        totalEvents: zone.totalEvents,
        score: zone.score,
        whyItMatters: `${zone.typeCount} different event types (${zone.eventTypes.join(', ')}) are converging in the same geographic area.`,
        actionableInsight: `Geographic convergence zone detected. Multiple independent data streams confirm activity in this area.`,
        timestamp: new Date().toISOString(),
        propagandaFlags: [],
      });
    }
  }

  return signals;
}

// === Signal Type 5: Hotspot Escalation (multi-component score exceeds threshold + rising trend) ===
function detectHotspotEscalation(ciiData) {
  const signals = [];
  const countries = ciiData?.countries || [];

  for (const c of countries) {
    if (c.score >= 70 && c.trend === 'Rising') {
      const hash = contentHash(`esc-${c.code}`);
      if (isDuplicate('default', `esc-${hash}`)) continue;

      signals.push({
        type: 'Hotspot Escalation',
        confidence: Math.min(90, 65 + Math.floor(c.score / 10)),
        title: `${c.name} instability escalating — CII ${c.score} (${c.level}), trend Rising`,
        countryCode: c.code,
        countryName: c.name,
        score: c.score,
        level: c.level,
        trend: c.trend,
        lat: c.lat,
        lng: c.lng,
        whyItMatters: `${c.name} has exceeded the instability threshold with a rising trend across multiple components.`,
        actionableInsight: `Monitor ${c.name} for further escalation. Consider contingency planning for regional impact.`,
        timestamp: new Date().toISOString(),
        propagandaFlags: [],
      });
    }
  }

  return signals;
}

// === Signal Type 6: Military Surge (transport/fighter activity 2× baseline) ===
function detectMilitarySurge(adsbData, openSkyData) {
  const signals = [];

  // Check for unusual military activity levels
  const hotspots = openSkyData?.hotspots || [];
  const baseline = 10; // baseline military aircraft per region

  for (const h of hotspots) {
    const count = h.totalAircraft || 0;
    if (count >= baseline * 2) {
      const hash = contentHash(`surge-${h.region}`);
      if (isDuplicate('default', `surge-${hash}`)) continue;

      signals.push({
        type: 'Military Surge',
        confidence: Math.min(85, 60 + Math.floor(count / 5)),
        title: `Military surge in ${h.region}: ${count} aircraft (${Math.round(count / baseline)}× baseline)`,
        region: h.region,
        aircraftCount: count,
        baselineMultiple: Math.round(count / baseline * 10) / 10,
        whyItMatters: `Military air traffic in ${h.region} is ${Math.round(count / baseline)}× the normal baseline, indicating heightened operational tempo.`,
        actionableInsight: `Elevated military posture in ${h.region}. Cross-reference with diplomatic and conflict signals.`,
        timestamp: new Date().toISOString(),
        propagandaFlags: [],
      });
    }
  }

  // Also check ADS-B categories for surges
  const categories = adsbData?.categories || {};
  const catThresholds = { reconnaissance: 5, bombers: 3, tankers: 8 };
  for (const [cat, threshold] of Object.entries(catThresholds)) {
    const count = (categories[cat] || []).length;
    if (count >= threshold * 2) {
      const hash = contentHash(`surge-cat-${cat}`);
      if (isDuplicate('default', `surge-${hash}`)) continue;

      signals.push({
        type: 'Military Surge',
        confidence: Math.min(82, 60 + count * 2),
        title: `${cat.charAt(0).toUpperCase() + cat.slice(1)} surge: ${count} active (${Math.round(count / threshold)}× baseline)`,
        category: cat,
        count,
        baselineMultiple: Math.round(count / threshold * 10) / 10,
        whyItMatters: `${cat} activity is well above normal levels, suggesting heightened military readiness.`,
        actionableInsight: `Monitor for correlation with geopolitical developments. ${cat} surge often precedes operational activity.`,
        timestamp: new Date().toISOString(),
        propagandaFlags: [],
      });
    }
  }

  return signals;
}

// Main signal computation (called post-sweep)
export function computeSignals(sourceData, convergenceData, ciiData) {
  pruneCache();

  // Gather all news items
  const allNews = [];

  // GDELT articles
  const gdeltData = sourceData.GDELT || {};
  for (const a of (gdeltData.allArticles || gdeltData.articles || [])) {
    allNews.push({ title: a.title || '', source: 'GDELT', timestamp: a.date || new Date().toISOString() });
  }

  // RSS/newsFeed items would be added by the synthesizer
  // We use what we have from source data

  // Telegram posts
  const tgData = sourceData.Telegram || {};
  for (const p of (tgData.urgentPosts || [])) {
    allNews.push({ title: p.text || '', source: 'Telegram', timestamp: p.date, urgent: true });
  }

  // Detect all signal types
  const convergenceSignals = detectConvergenceSignals(allNews);
  const triangulationSignals = detectTriangulation(allNews);
  const velocitySignals = detectVelocitySpike(allNews);
  const geoSignals = detectGeoConvergence(convergenceData);
  const escalationSignals = detectHotspotEscalation(ciiData);

  const adsbData = sourceData['ADS-B'] || {};
  const openSkyData = sourceData.OpenSky || {};
  const surgeSignals = detectMilitarySurge(adsbData, openSkyData);

  // Combine all signals
  const allSignals = [
    ...convergenceSignals,
    ...triangulationSignals,
    ...velocitySignals,
    ...geoSignals,
    ...escalationSignals,
    ...surgeSignals,
  ];

  // Sort by confidence descending
  allSignals.sort((a, b) => b.confidence - a.confidence);

  return {
    source: 'Signals',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalSignals: allSignals.length,
    signals: allSignals,
    byType: {
      convergence: convergenceSignals.length,
      triangulation: triangulationSignals.length,
      velocitySpike: velocitySignals.length,
      geoConvergence: geoSignals.length,
      hotspotEscalation: escalationSignals.length,
      militarySurge: surgeSignals.length,
    },
  };
}

// Briefing stub
export async function briefing() {
  return {
    source: 'Signals',
    timestamp: new Date().toISOString(),
    status: 'deferred',
    message: 'Signal intelligence computed post-sweep from aggregated source data',
  };
}

if (process.argv[1]?.endsWith('signals.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
