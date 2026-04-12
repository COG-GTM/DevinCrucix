// Threat Classifier — Keyword-based threat classification for headlines
// ~120 threat keywords organized by severity and 14 categories
// Clean-room implementation based on behavioral specification

// Severity levels
const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };

// 14 threat categories with keyword lists (word-boundary matching)
const THREAT_KEYWORDS = {
  conflict: {
    critical: ['war declared', 'nuclear strike', 'nuclear attack', 'invasion', 'ground offensive', 'mass casualty', 'genocide'],
    high: ['airstrike', 'air strike', 'bombardment', 'shelling', 'artillery', 'missile strike', 'drone strike', 'combat', 'killed in action', 'battle'],
    medium: ['skirmish', 'ceasefire violation', 'escalation', 'military operation', 'armed clash', 'firefight'],
    low: ['ceasefire', 'peace talks', 'de-escalation', 'withdrawal'],
    info: ['military exercise', 'joint drill', 'defense review'],
  },
  protest: {
    critical: ['mass uprising', 'revolution', 'coup attempt', 'martial law'],
    high: ['violent protest', 'riot', 'crackdown', 'tear gas', 'rubber bullets', 'killed in protest', 'state of emergency'],
    medium: ['protest', 'demonstration', 'march', 'rally', 'unrest', 'civil disobedience'],
    low: ['strike action', 'walkout', 'petition'],
    info: ['peaceful protest', 'vigil', 'memorial'],
  },
  disaster: {
    critical: ['magnitude 7', 'magnitude 8', 'magnitude 9', 'category 5', 'tsunami warning', 'nuclear meltdown'],
    high: ['earthquake', 'tsunami', 'hurricane', 'typhoon', 'cyclone', 'volcanic eruption', 'wildfire', 'flood'],
    medium: ['tropical storm', 'landslide', 'drought', 'heat wave', 'severe weather'],
    low: ['aftershock', 'weather warning', 'flood watch'],
    info: ['earthquake drill', 'disaster preparedness'],
  },
  diplomatic: {
    critical: ['embassy attack', 'ambassador killed', 'diplomatic expulsion', 'sanctions war'],
    high: ['sanctions', 'trade war', 'embargo', 'diplomatic crisis', 'severed relations', 'recalled ambassador'],
    medium: ['diplomatic tension', 'trade dispute', 'tariff', 'summit', 'bilateral talks'],
    low: ['trade agreement', 'diplomatic meeting', 'state visit'],
    info: ['UN resolution', 'treaty signed', 'diplomatic statement'],
  },
  economic: {
    critical: ['market crash', 'bank collapse', 'currency collapse', 'sovereign default', 'hyperinflation'],
    high: ['recession', 'bank run', 'stock crash', 'debt crisis', 'financial crisis', 'market plunge'],
    medium: ['interest rate hike', 'inflation surge', 'unemployment rise', 'gdp contraction', 'market correction'],
    low: ['market volatility', 'earnings miss', 'downgrade', 'credit warning'],
    info: ['gdp growth', 'jobs report', 'trade surplus', 'rate decision'],
  },
  terrorism: {
    critical: ['terrorist attack', 'suicide bombing', 'mass shooting', 'hostage crisis', 'bomb detonation'],
    high: ['bombing', 'terror plot', 'car bomb', 'attack claimed', 'isis attack', 'al qaeda'],
    medium: ['terror threat', 'security alert', 'threat level raised', 'suspicious package'],
    low: ['terror suspect arrested', 'plot foiled', 'security operation'],
    info: ['counter-terrorism', 'intelligence operation'],
  },
  cyber: {
    critical: ['critical infrastructure hack', 'power grid attack', 'nuclear facility breach', 'state-sponsored cyberattack'],
    high: ['ransomware attack', 'data breach', 'cyberattack', 'ddos attack', 'critical vulnerability', 'zero-day exploit'],
    medium: ['phishing campaign', 'malware', 'cyber espionage', 'security vulnerability', 'hack'],
    low: ['security patch', 'vulnerability disclosed', 'bug bounty'],
    info: ['cybersecurity report', 'security update', 'threat assessment'],
  },
  health: {
    critical: ['pandemic declared', 'outbreak emergency', 'quarantine', 'mass infection'],
    high: ['epidemic', 'outbreak', 'new variant', 'hospital overwhelmed', 'death toll rising'],
    medium: ['disease spread', 'infection rate', 'vaccine shortage', 'health emergency'],
    low: ['health advisory', 'travel warning', 'vaccination campaign'],
    info: ['clinical trial', 'health report', 'who update'],
  },
  environmental: {
    critical: ['environmental disaster', 'oil spill', 'toxic spill', 'nuclear contamination'],
    high: ['deforestation crisis', 'water crisis', 'pollution crisis', 'species extinction'],
    medium: ['climate change', 'emissions', 'environmental damage', 'ocean acidification'],
    low: ['environmental policy', 'conservation', 'renewable energy'],
    info: ['climate report', 'environmental study', 'sustainability'],
  },
  military: {
    critical: ['nuclear weapon', 'icbm launch', 'nuclear test', 'first strike'],
    high: ['military buildup', 'troop deployment', 'naval blockade', 'no-fly zone', 'military mobilization', 'aircraft carrier deployed'],
    medium: ['arms deal', 'weapons shipment', 'military aid', 'defense spending', 'military base'],
    low: ['military parade', 'defense budget', 'arms control'],
    info: ['military technology', 'defense industry', 'procurement'],
  },
  crime: {
    critical: ['cartel massacre', 'mass murder', 'assassination'],
    high: ['kidnapping', 'drug bust', 'organized crime', 'murder', 'trafficking', 'narco violence'],
    medium: ['robbery', 'fraud', 'corruption', 'money laundering', 'arrest'],
    low: ['investigation', 'trial', 'sentencing', 'indictment'],
    info: ['crime statistics', 'police report', 'law enforcement'],
  },
  infrastructure: {
    critical: ['power grid failure', 'dam collapse', 'bridge collapse', 'pipeline explosion'],
    high: ['blackout', 'internet outage', 'infrastructure attack', 'supply chain disruption', 'port shutdown'],
    medium: ['infrastructure damage', 'road closure', 'service disruption', 'pipeline leak'],
    low: ['infrastructure investment', 'maintenance', 'repair'],
    info: ['infrastructure plan', 'construction project'],
  },
  tech: {
    critical: ['ai weapon', 'autonomous weapon'],
    high: ['ai regulation', 'chip ban', 'export control', 'tech sanctions', 'data sovereignty'],
    medium: ['ai development', 'chip shortage', 'tech competition', 'digital currency'],
    low: ['product launch', 'tech investment', 'startup funding'],
    info: ['tech conference', 'innovation', 'research'],
  },
  general: {
    critical: [],
    high: ['breaking news', 'urgent', 'flash', 'developing'],
    medium: ['alert', 'warning', 'advisory'],
    low: ['update', 'report', 'analysis'],
    info: ['announcement', 'statement', 'press release'],
  },
};

// Severity weights for scoring
const SEVERITY_WEIGHTS = { critical: 100, high: 75, medium: 50, low: 25, info: 10 };

// Create word boundary regex for a keyword
function kwRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

// Pre-compile all regexes
const COMPILED_KEYWORDS = {};
for (const [category, severities] of Object.entries(THREAT_KEYWORDS)) {
  COMPILED_KEYWORDS[category] = {};
  for (const [severity, keywords] of Object.entries(severities)) {
    COMPILED_KEYWORDS[category][severity] = keywords.map(kw => ({
      keyword: kw,
      regex: kwRegex(kw),
    }));
  }
}

// Classify a single headline
export function classifyHeadline(headline) {
  const text = (headline || '').toLowerCase();
  if (text.length < 5) return null;

  const matches = [];
  let highestSeverity = SEVERITY.INFO;
  let highestWeight = 0;

  for (const [category, severities] of Object.entries(COMPILED_KEYWORDS)) {
    for (const [severity, entries] of Object.entries(severities)) {
      for (const { keyword, regex } of entries) {
        if (regex.test(text)) {
          const weight = SEVERITY_WEIGHTS[severity];
          matches.push({ category, severity, keyword, weight });
          if (weight > highestWeight) {
            highestWeight = weight;
            highestSeverity = severity;
          }
        }
      }
    }
  }

  if (matches.length === 0) return null;

  // Determine primary category (highest weight match)
  const primaryMatch = matches.sort((a, b) => b.weight - a.weight)[0];

  // All matched categories
  const categories = [...new Set(matches.map(m => m.category))];

  return {
    headline,
    severity: highestSeverity,
    severityScore: highestWeight,
    primaryCategory: primaryMatch.category,
    categories,
    matchedKeywords: matches.slice(0, 5).map(m => m.keyword),
    matchCount: matches.length,
  };
}

// Classify an array of headlines
export function classifyAll(headlines) {
  const results = [];
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const categoryCounts = {};

  for (const h of headlines) {
    const title = typeof h === 'string' ? h : (h.title || h.headline || '');
    const result = classifyHeadline(title);
    if (result) {
      results.push(result);
      severityCounts[result.severity]++;
      for (const cat of result.categories) {
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
    }
  }

  // Sort by severity score descending
  results.sort((a, b) => b.severityScore - a.severityScore);

  return {
    source: 'ThreatClassifier',
    timestamp: new Date().toISOString(),
    totalClassified: results.length,
    totalHeadlines: headlines.length,
    classifications: results,
    severityCounts,
    categoryCounts,
    topThreats: results.filter(r => r.severity === 'critical' || r.severity === 'high').slice(0, 10),
  };
}
