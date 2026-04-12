// Focal Point Detection — Cross-references news entities against map signals
// Identifies "main character" entities driving current events
// Clean-room implementation based on behavioral specification

import '../utils/env.mjs';

// === Curated Entity Registry (~60 entities) ===
const ENTITY_REGISTRY = [
  // Defense Companies
  { id: 'lockheed', name: 'Lockheed Martin', type: 'company', sector: 'defense', aliases: ['lockheed', 'lmt'], keywords: ['f-35', 'fighter', 'missile', 'defense contract'], related: ['pentagon', 'nato'] },
  { id: 'raytheon', name: 'Raytheon', type: 'company', sector: 'defense', aliases: ['raytheon', 'rtx'], keywords: ['patriot', 'missile defense', 'radar'], related: ['pentagon', 'nato'] },
  { id: 'northrop', name: 'Northrop Grumman', type: 'company', sector: 'defense', aliases: ['northrop', 'noc'], keywords: ['b-21', 'stealth', 'drone', 'cyber'], related: ['pentagon'] },
  { id: 'boeing-def', name: 'Boeing Defense', type: 'company', sector: 'defense', aliases: ['boeing'], keywords: ['f-15', 'tanker', 'helicopter', 'kc-46'], related: ['pentagon'] },
  { id: 'general-dynamics', name: 'General Dynamics', type: 'company', sector: 'defense', aliases: ['general dynamics', 'gd'], keywords: ['submarine', 'tank', 'abrams'], related: ['pentagon'] },
  { id: 'bae', name: 'BAE Systems', type: 'company', sector: 'defense', aliases: ['bae systems', 'bae'], keywords: ['typhoon', 'warship', 'electronic warfare'], related: ['nato', 'gb'] },

  // Tech Companies
  { id: 'nvidia', name: 'NVIDIA', type: 'company', sector: 'tech', aliases: ['nvidia', 'nvda'], keywords: ['gpu', 'ai chip', 'semiconductor', 'cuda'], related: ['cn', 'tw'] },
  { id: 'tsmc', name: 'TSMC', type: 'company', sector: 'tech', aliases: ['tsmc', 'taiwan semiconductor'], keywords: ['chip', 'foundry', 'semiconductor', 'fab'], related: ['tw', 'cn'] },
  { id: 'google', name: 'Google', type: 'company', sector: 'tech', aliases: ['google', 'alphabet', 'googl'], keywords: ['ai', 'search', 'cloud', 'android'], related: ['us'] },
  { id: 'microsoft', name: 'Microsoft', type: 'company', sector: 'tech', aliases: ['microsoft', 'msft'], keywords: ['azure', 'windows', 'ai', 'copilot'], related: ['us'] },
  { id: 'apple', name: 'Apple', type: 'company', sector: 'tech', aliases: ['apple', 'aapl'], keywords: ['iphone', 'ios', 'supply chain'], related: ['us', 'cn'] },

  // Energy Companies
  { id: 'saudi-aramco', name: 'Saudi Aramco', type: 'company', sector: 'energy', aliases: ['aramco', 'saudi aramco'], keywords: ['oil', 'crude', 'opec', 'petroleum'], related: ['sa', 'opec'] },
  { id: 'gazprom', name: 'Gazprom', type: 'company', sector: 'energy', aliases: ['gazprom'], keywords: ['gas', 'pipeline', 'nord stream', 'energy'], related: ['ru'] },
  { id: 'exxon', name: 'ExxonMobil', type: 'company', sector: 'energy', aliases: ['exxon', 'exxonmobil', 'xom'], keywords: ['oil', 'refinery', 'lng'], related: ['us'] },

  // Countries (24 CII countries)
  { id: 'us', name: 'United States', type: 'country', sector: 'government', aliases: ['united states', 'u.s.', 'america', 'usa'], keywords: ['congress', 'white house', 'pentagon', 'federal'], related: ['nato'] },
  { id: 've', name: 'Venezuela', type: 'country', sector: 'government', aliases: ['venezuela'], keywords: ['maduro', 'caracas', 'oil crisis'], related: ['cu', 'opec'] },
  { id: 'br', name: 'Brazil', type: 'country', sector: 'government', aliases: ['brazil'], keywords: ['lula', 'brasilia', 'amazon'], related: [] },
  { id: 'mx', name: 'Mexico', type: 'country', sector: 'government', aliases: ['mexico'], keywords: ['cartel', 'border', 'trade'], related: ['us'] },
  { id: 'cu', name: 'Cuba', type: 'country', sector: 'government', aliases: ['cuba'], keywords: ['havana', 'embargo'], related: ['ve', 'ru'] },
  { id: 'de', name: 'Germany', type: 'country', sector: 'government', aliases: ['germany'], keywords: ['berlin', 'bundestag', 'bundeswehr'], related: ['nato', 'eu'] },
  { id: 'fr', name: 'France', type: 'country', sector: 'government', aliases: ['france'], keywords: ['macron', 'paris', 'elysee'], related: ['nato', 'eu'] },
  { id: 'gb', name: 'United Kingdom', type: 'country', sector: 'government', aliases: ['united kingdom', 'britain', 'uk'], keywords: ['london', 'parliament', 'downing'], related: ['nato'] },
  { id: 'pl', name: 'Poland', type: 'country', sector: 'government', aliases: ['poland'], keywords: ['warsaw', 'nato flank'], related: ['nato', 'ua'] },
  { id: 'ru', name: 'Russia', type: 'country', sector: 'government', aliases: ['russia'], keywords: ['kremlin', 'putin', 'moscow'], related: ['ua', 'cn'] },
  { id: 'ua', name: 'Ukraine', type: 'country', sector: 'government', aliases: ['ukraine'], keywords: ['kyiv', 'zelensky', 'donbas', 'crimea'], related: ['ru', 'nato'] },
  { id: 'ir', name: 'Iran', type: 'country', sector: 'government', aliases: ['iran'], keywords: ['tehran', 'irgc', 'nuclear', 'khamenei'], related: ['il', 'ye'] },
  { id: 'il', name: 'Israel', type: 'country', sector: 'government', aliases: ['israel'], keywords: ['idf', 'netanyahu', 'gaza', 'hamas'], related: ['ir', 'ps'] },
  { id: 'sa', name: 'Saudi Arabia', type: 'country', sector: 'government', aliases: ['saudi arabia', 'saudi'], keywords: ['riyadh', 'mbs', 'aramco'], related: ['opec', 'ae'] },
  { id: 'ae', name: 'UAE', type: 'country', sector: 'government', aliases: ['uae', 'emirates'], keywords: ['abu dhabi', 'dubai'], related: ['sa'] },
  { id: 'tr', name: 'Turkey', type: 'country', sector: 'government', aliases: ['turkey', 'turkiye'], keywords: ['ankara', 'erdogan'], related: ['nato', 'sy'] },
  { id: 'sy', name: 'Syria', type: 'country', sector: 'government', aliases: ['syria'], keywords: ['damascus', 'assad'], related: ['ru', 'ir', 'tr'] },
  { id: 'ye', name: 'Yemen', type: 'country', sector: 'government', aliases: ['yemen'], keywords: ['houthi', 'sanaa', 'red sea'], related: ['ir', 'sa'] },
  { id: 'cn', name: 'China', type: 'country', sector: 'government', aliases: ['china'], keywords: ['beijing', 'xi jinping', 'pla', 'ccp', 'prc'], related: ['tw', 'ru'] },
  { id: 'tw', name: 'Taiwan', type: 'country', sector: 'government', aliases: ['taiwan'], keywords: ['taipei', 'strait'], related: ['cn', 'us'] },
  { id: 'kp', name: 'North Korea', type: 'country', sector: 'government', aliases: ['north korea', 'dprk'], keywords: ['pyongyang', 'kim jong', 'missile test'], related: ['cn', 'ru'] },
  { id: 'in', name: 'India', type: 'country', sector: 'government', aliases: ['india'], keywords: ['delhi', 'modi', 'kashmir'], related: ['pk', 'cn'] },
  { id: 'pk', name: 'Pakistan', type: 'country', sector: 'government', aliases: ['pakistan'], keywords: ['islamabad', 'karachi'], related: ['in', 'cn'] },
  { id: 'mm', name: 'Myanmar', type: 'country', sector: 'government', aliases: ['myanmar', 'burma'], keywords: ['junta', 'rohingya'], related: ['cn'] },

  // Leaders
  { id: 'putin', name: 'Vladimir Putin', type: 'leader', sector: 'government', aliases: ['putin'], keywords: ['russia', 'kremlin'], related: ['ru'] },
  { id: 'xi', name: 'Xi Jinping', type: 'leader', sector: 'government', aliases: ['xi jinping', 'xi'], keywords: ['china', 'ccp', 'pla'], related: ['cn'] },
  { id: 'zelensky', name: 'Volodymyr Zelensky', type: 'leader', sector: 'government', aliases: ['zelensky', 'zelenskyy'], keywords: ['ukraine', 'kyiv'], related: ['ua'] },
  { id: 'netanyahu', name: 'Benjamin Netanyahu', type: 'leader', sector: 'government', aliases: ['netanyahu', 'bibi'], keywords: ['israel', 'idf'], related: ['il'] },
  { id: 'kim', name: 'Kim Jong Un', type: 'leader', sector: 'government', aliases: ['kim jong un', 'kim jong'], keywords: ['north korea', 'nuclear'], related: ['kp'] },
  { id: 'erdogan', name: 'Recep Erdogan', type: 'leader', sector: 'government', aliases: ['erdogan'], keywords: ['turkey', 'ankara'], related: ['tr'] },

  // Organizations
  { id: 'nato', name: 'NATO', type: 'organization', sector: 'military', aliases: ['nato', 'north atlantic treaty'], keywords: ['alliance', 'article 5', 'defense'], related: ['us', 'gb', 'de', 'fr', 'pl'] },
  { id: 'eu', name: 'European Union', type: 'organization', sector: 'political', aliases: ['european union', 'eu'], keywords: ['brussels', 'commission', 'sanctions'], related: ['de', 'fr'] },
  { id: 'opec', name: 'OPEC', type: 'organization', sector: 'energy', aliases: ['opec', 'opec+'], keywords: ['oil', 'production cut', 'crude'], related: ['sa', 'ir', 've'] },
  { id: 'un', name: 'United Nations', type: 'organization', sector: 'political', aliases: ['united nations', 'un'], keywords: ['security council', 'general assembly', 'peacekeeping'], related: [] },
  { id: 'iaea', name: 'IAEA', type: 'organization', sector: 'nuclear', aliases: ['iaea', 'atomic energy'], keywords: ['nuclear', 'enrichment', 'inspection'], related: ['ir', 'kp'] },
  { id: 'hamas', name: 'Hamas', type: 'organization', sector: 'militant', aliases: ['hamas'], keywords: ['gaza', 'resistance', 'tunnel'], related: ['il', 'ir'] },
  { id: 'hezbollah', name: 'Hezbollah', type: 'organization', sector: 'militant', aliases: ['hezbollah', 'hizbollah'], keywords: ['lebanon', 'southern lebanon', 'nasrallah'], related: ['ir', 'il'] },
  { id: 'houthis', name: 'Houthis', type: 'organization', sector: 'militant', aliases: ['houthi', 'houthis', 'ansar allah'], keywords: ['yemen', 'red sea', 'shipping'], related: ['ye', 'ir'] },
  { id: 'wagner', name: 'Wagner Group', type: 'organization', sector: 'military', aliases: ['wagner', 'pmc wagner'], keywords: ['mercenary', 'africa', 'prigozhin'], related: ['ru'] },

  // Commodities
  { id: 'oil-crude', name: 'Crude Oil', type: 'commodity', sector: 'energy', aliases: ['crude oil', 'wti', 'brent'], keywords: ['oil price', 'barrel', 'petroleum', 'opec'], related: ['sa', 'ir', 'opec'] },
  { id: 'gold', name: 'Gold', type: 'commodity', sector: 'precious_metals', aliases: ['gold', 'xau'], keywords: ['safe haven', 'bullion', 'precious metal'], related: [] },
  { id: 'natural-gas', name: 'Natural Gas', type: 'commodity', sector: 'energy', aliases: ['natural gas', 'lng'], keywords: ['pipeline', 'heating', 'energy'], related: ['ru', 'us'] },
  { id: 'uranium', name: 'Uranium', type: 'commodity', sector: 'nuclear', aliases: ['uranium', 'yellowcake'], keywords: ['enrichment', 'nuclear fuel', 'reactor'], related: ['ir', 'kp'] },
];

// Entity ID to country code mapping (for entities that ARE countries)
const ENTITY_TO_COUNTRY = {};
for (const e of ENTITY_REGISTRY) {
  if (e.type === 'country') {
    ENTITY_TO_COUNTRY[e.id] = e.id.toUpperCase();
  }
}

// Country code to entity mapping
const COUNTRY_CODE_TO_ENTITY = {};
for (const e of ENTITY_REGISTRY) {
  if (e.type === 'country') {
    COUNTRY_CODE_TO_ENTITY[e.id.toUpperCase()] = e;
  }
}

// Signal type icons
const SIGNAL_ICONS = {
  military_flight: '\u2708\uFE0F',
  military_vessel: '\u2693',
  protest: '\uD83D\uDCE2',
  internet_outage: '\uD83C\uDF10',
  convergence: '\uD83D\uDEA8',
  earthquake: '\uD83C\uDF0D',
};

// Extract entities from headlines
function extractEntities(headlines) {
  const entityMentions = new Map();

  for (const h of headlines) {
    const lower = (h.title || h.headline || '').toLowerCase();
    if (lower.length < 5) continue;

    for (const entity of ENTITY_REGISTRY) {
      let found = false;
      for (const alias of entity.aliases) {
        if (lower.includes(alias.toLowerCase())) {
          found = true;
          break;
        }
      }
      // Also check keywords
      if (!found) {
        for (const kw of (entity.keywords || [])) {
          if (lower.includes(kw.toLowerCase())) {
            found = true;
            break;
          }
        }
      }

      if (found) {
        if (!entityMentions.has(entity.id)) {
          entityMentions.set(entity.id, {
            entity,
            mentions: 0,
            headlines: [],
            sources: new Set(),
            newsVelocity: 0,
          });
        }
        const m = entityMentions.get(entity.id);
        m.mentions++;
        m.headlines.push(h);
        if (h.source) m.sources.add(h.source);
      }
    }
  }

  // Compute news velocity (mentions per 2h window, simplified)
  for (const [id, m] of entityMentions) {
    m.newsVelocity = Math.min(10, m.mentions / 2);
  }

  return entityMentions;
}

// Aggregate signals by country
function aggregateSignalsByCountry(convergenceData, ciiData, adsbData, maritimeData) {
  const countrySignals = {};

  // From convergence zones
  const zones = convergenceData?.zones || [];
  for (const z of zones) {
    // Map zone to nearest CII country
    const countries = ciiData?.countries || [];
    for (const c of countries) {
      const dist = Math.sqrt(Math.pow(z.lat - c.lat, 2) + Math.pow(z.lng - c.lng, 2));
      if (dist < 10) { // within ~10 degrees
        if (!countrySignals[c.code]) countrySignals[c.code] = { types: new Set(), signals: [], count: 0, highSeverity: 0 };
        for (const et of z.eventTypes) {
          countrySignals[c.code].types.add(et);
        }
        countrySignals[c.code].signals.push({ type: 'convergence', score: z.score });
        countrySignals[c.code].count += z.totalEvents;
        if (z.alertLevel === 'Critical') countrySignals[c.code].highSeverity++;
      }
    }
  }

  // From CII data directly
  const countries = ciiData?.countries || [];
  for (const c of countries) {
    if (!countrySignals[c.code]) countrySignals[c.code] = { types: new Set(), signals: [], count: 0, highSeverity: 0 };

    if (c.components.security > 30) {
      countrySignals[c.code].types.add('military_flight');
      countrySignals[c.code].signals.push({ type: 'military_flight', score: c.components.security });
    }
    if (c.components.unrest > 30) {
      countrySignals[c.code].types.add('protest');
      countrySignals[c.code].signals.push({ type: 'protest', score: c.components.unrest });
    }
    if (c.level === 'Critical' || c.level === 'High') {
      countrySignals[c.code].highSeverity++;
    }
  }

  return countrySignals;
}

// Compute focal scores
function computeFocalScores(entityMentions, countrySignals, ciiData) {
  const focalPoints = [];

  for (const [entityId, mentionData] of entityMentions) {
    const entity = mentionData.entity;

    // Determine the country code for this entity
    let countryCode = null;
    if (entity.type === 'country') {
      countryCode = entity.id.toUpperCase();
    } else if (entity.related && entity.related.length > 0) {
      // Use first related country
      for (const rel of entity.related) {
        if (COUNTRY_CODE_TO_ENTITY[rel.toUpperCase()]) {
          countryCode = rel.toUpperCase();
          break;
        }
      }
    }

    // NewsScore (0-40)
    const base = Math.min(20, mentionData.mentions * 4);
    const velocity = Math.min(10, mentionData.newsVelocity * 2);
    const avgConfidence = mentionData.sources.size >= 3 ? 0.8 : mentionData.sources.size >= 2 ? 0.6 : 0.4;
    const confidenceScore = avgConfidence * 10;
    const newsScore = Math.min(40, base + velocity + confidenceScore);

    // SignalScore (0-40)
    const cs = countryCode ? (countrySignals[countryCode] || {}) : {};
    const signalTypesCount = cs.types ? cs.types.size : 0;
    const signalCount = cs.count || 0;
    const highSev = cs.highSeverity || 0;

    const typesScore = signalTypesCount * 10;
    const countScore = Math.min(15, signalCount * 3);
    const severityScore = highSev * 5;
    const signalScore = Math.min(40, typesScore + countScore + severityScore);

    // CorrelationBonus (0-20)
    let correlationBonus = 0;
    // +10 if entity appears in both news AND signals
    if (mentionData.mentions > 0 && signalTypesCount > 0) correlationBonus += 10;
    // +5 if entity keywords match signal types
    if (entity.keywords) {
      const signalTypeStrs = cs.types ? Array.from(cs.types) : [];
      const kwMatch = entity.keywords.some(kw =>
        signalTypeStrs.some(st => st.includes(kw) || kw.includes(st))
      );
      if (kwMatch) correlationBonus += 5;
    }
    // +5 if related entities have signals
    if (entity.related) {
      const relHasSignals = entity.related.some(rel =>
        countrySignals[rel.toUpperCase()] && (countrySignals[rel.toUpperCase()].count || 0) > 0
      );
      if (relHasSignals) correlationBonus += 5;
    }
    correlationBonus = Math.min(20, correlationBonus);

    const totalScore = Math.round(newsScore + signalScore + correlationBonus);

    // Urgency
    let urgency;
    if (totalScore > 70 || signalTypesCount >= 3) urgency = 'Critical';
    else if (totalScore > 50 || signalTypesCount >= 2) urgency = 'Elevated';
    else urgency = 'Watch';

    // Signal type icons
    const signalIcons = cs.types
      ? Array.from(cs.types).map(t => ({ type: t, icon: SIGNAL_ICONS[t] || '' }))
      : [];

    // Get CII data for this country
    const ciiCountry = countryCode
      ? (ciiData?.countries || []).find(c => c.code === countryCode)
      : null;

    // Build narrative summary
    const narrativeParts = [];
    if (mentionData.mentions > 3) narrativeParts.push(`${entity.name} featured in ${mentionData.mentions} headlines across ${mentionData.sources.size} sources`);
    if (signalTypesCount > 0) narrativeParts.push(`${signalTypesCount} active signal types in associated region`);
    if (ciiCountry && ciiCountry.level !== 'Low' && ciiCountry.level !== 'Normal') {
      narrativeParts.push(`CII: ${ciiCountry.level} (${ciiCountry.score})`);
    }

    focalPoints.push({
      entityId: entity.id,
      name: entity.name,
      type: entity.type,
      sector: entity.sector,
      countryCode,
      score: totalScore,
      urgency,
      components: {
        newsScore: Math.round(newsScore),
        signalScore: Math.round(signalScore),
        correlationBonus,
      },
      mentions: mentionData.mentions,
      newsVelocity: mentionData.newsVelocity,
      topHeadlines: mentionData.headlines.slice(0, 5).map(h => h.title || h.headline || ''),
      sources: Array.from(mentionData.sources),
      signalTypes: signalIcons,
      narrative: narrativeParts.join('. ') || `${entity.name} is being monitored.`,
      lat: ciiCountry?.lat || null,
      lng: ciiCountry?.lng || null,
    });
  }

  // Sort by score descending
  focalPoints.sort((a, b) => b.score - a.score);

  return focalPoints;
}

// Main focal point computation (called post-sweep)
export function computeFocalPoints(sourceData, convergenceData, ciiData) {
  // Gather all headlines
  const allHeadlines = [];

  const gdeltData = sourceData.GDELT || {};
  for (const a of (gdeltData.allArticles || gdeltData.articles || [])) {
    allHeadlines.push({ title: a.title || '', source: 'GDELT', timestamp: a.date });
  }

  const tgData = sourceData.Telegram || {};
  for (const p of (tgData.urgentPosts || [])) {
    allHeadlines.push({ title: p.text || '', source: 'Telegram', timestamp: p.date, urgent: true });
  }
  for (const p of (tgData.topPosts || [])) {
    allHeadlines.push({ title: p.text || '', source: 'Telegram', timestamp: p.date });
  }

  // ACLED events
  const acledData = sourceData.ACLED || {};
  for (const e of (acledData.deadliestEvents || [])) {
    allHeadlines.push({
      title: `${e.type || 'Event'} in ${e.country || 'Unknown'}: ${e.location || ''}`,
      source: 'ACLED',
    });
  }

  // Step 1: Extract entities
  const entityMentions = extractEntities(allHeadlines);

  // Step 2: Aggregate signals by country
  const adsbData = sourceData['ADS-B'] || {};
  const maritimeData = sourceData.Maritime || {};
  const countrySignals = aggregateSignalsByCountry(convergenceData, ciiData, adsbData, maritimeData);

  // Steps 3-4: Cross-reference and score
  const focalPoints = computeFocalScores(entityMentions, countrySignals, ciiData);

  return {
    source: 'FocalPoints',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalFocalPoints: focalPoints.length,
    focalPoints,
    urgencyBreakdown: {
      critical: focalPoints.filter(f => f.urgency === 'Critical').length,
      elevated: focalPoints.filter(f => f.urgency === 'Elevated').length,
      watch: focalPoints.filter(f => f.urgency === 'Watch').length,
    },
    signals: focalPoints
      .filter(f => f.urgency === 'Critical')
      .slice(0, 5)
      .map(f => `${f.name} (${f.urgency}): score ${f.score}, ${f.mentions} mentions`),
  };
}

// Briefing stub
export async function briefing() {
  return {
    source: 'FocalPoints',
    timestamp: new Date().toISOString(),
    status: 'deferred',
    message: 'Focal points computed post-sweep from aggregated source data',
  };
}

if (process.argv[1]?.endsWith('focalpoints.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
