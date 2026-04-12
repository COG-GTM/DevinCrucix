// AI Summarization Chain — Tiered LLM summarization for intelligence briefs
// Provider chain: Ollama → Groq → OpenRouter (fallback)
// Clean-room implementation based on behavioral specification

import '../utils/env.mjs';
import { classifyAll } from './threatclassifier.mjs';

// === LLM Provider Chain ===

// Groq provider (cloud inference, Llama 3.1 8B)
async function callGroq(systemPrompt, userMessage, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model || 'llama-3.1-8b-instant',
        temperature: 0.3,
        max_tokens: opts.maxTokens || 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 30000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Groq API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      provider: 'groq',
      model: data.model || 'llama-3.1-8b-instant',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  } catch (e) {
    console.error('[Summarizer] Groq failed:', e.message);
    return null;
  }
}

// Ollama provider (local LLM, auto-discover model)
async function callOllama(systemPrompt, userMessage, opts = {}) {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');

  try {
    // Auto-discover available model
    let model = process.env.OLLAMA_MODEL || opts.model;
    if (!model) {
      try {
        const tagRes = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (tagRes.ok) {
          const tags = await tagRes.json();
          const models = tags.models || [];
          if (models.length > 0) {
            model = models[0].name;
          }
        }
      } catch {
        // Ollama not available
        return null;
      }
    }
    if (!model) return null;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 120000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Ollama API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      provider: 'ollama',
      model: data.model || model,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  } catch (e) {
    console.error('[Summarizer] Ollama failed:', e.message);
    return null;
  }
}

// OpenRouter provider (multi-model fallback)
async function callOpenRouter(systemPrompt, userMessage, opts = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/crucix',
        'X-Title': 'Crucix Intelligence',
      },
      body: JSON.stringify({
        model: opts.model || 'meta-llama/llama-3.1-8b-instruct:free',
        max_tokens: opts.maxTokens || 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenRouter API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      provider: 'openrouter',
      model: data.model || 'meta-llama/llama-3.1-8b-instruct:free',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  } catch (e) {
    console.error('[Summarizer] OpenRouter failed:', e.message);
    return null;
  }
}

// Try providers in chain: Ollama → Groq → OpenRouter
async function callLLMChain(systemPrompt, userMessage, opts = {}) {
  // 1. Try Ollama first (local, free)
  let result = await callOllama(systemPrompt, userMessage, opts);
  if (result?.text) return result;

  // 2. Try Groq (fast cloud)
  result = await callGroq(systemPrompt, userMessage, opts);
  if (result?.text) return result;

  // 3. Try OpenRouter (fallback)
  result = await callOpenRouter(systemPrompt, userMessage, opts);
  if (result?.text) return result;

  return null;
}

// === Pre-processing ===

// Jaccard similarity for deduplication
function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// Deduplicate headlines using Jaccard similarity (>60% overlap)
function deduplicateHeadlines(headlines) {
  const deduped = [];
  for (const h of headlines) {
    const title = h.title || h.headline || '';
    if (title.length < 10) continue;

    let isDupe = false;
    for (const existing of deduped) {
      const existingTitle = existing.title || existing.headline || '';
      if (jaccardSimilarity(title, existingTitle) > 0.6) {
        isDupe = true;
        // Keep the one with more detail (longer title)
        if (title.length > existingTitle.length) {
          existing.title = title;
          existing.headline = title;
        }
        break;
      }
    }
    if (!isDupe) {
      deduped.push({ ...h });
    }
  }
  return deduped;
}

// Military/conflict boost keywords
const BOOST_KEYWORDS = [
  'military', 'conflict', 'war', 'attack', 'missile', 'bomb', 'strike', 'troops',
  'invasion', 'defense', 'nuclear', 'weapon', 'casualty', 'killed', 'humanitarian',
  'crisis', 'emergency', 'escalation', 'sanctions', 'blockade', 'coup', 'protest',
  'riot', 'unrest', 'insurgent', 'terrorist', 'intelligence', 'espionage', 'cyber',
];

// Business/entertainment demote keywords
const DEMOTE_KEYWORDS = [
  'celebrity', 'entertainment', 'sports', 'movie', 'tv show', 'album', 'concert',
  'fashion', 'recipe', 'lifestyle', 'gaming', 'box office', 'award show', 'gossip',
  'reality tv', 'streaming', 'podcast', 'influencer',
];

// Score headlines for relevance
function scoreHeadline(headline) {
  const lower = (headline.title || headline.headline || '').toLowerCase();
  let score = 50; // base score

  for (const kw of BOOST_KEYWORDS) {
    if (lower.includes(kw)) score += 10;
  }
  for (const kw of DEMOTE_KEYWORDS) {
    if (lower.includes(kw)) score -= 20;
  }

  // Boost urgent items
  if (headline.urgent) score += 15;

  return Math.max(0, Math.min(100, score));
}

// === System Prompt ===
const SYSTEM_PROMPT = `You are a senior intelligence analyst. Produce a concise situation brief from the following headlines. Prioritize military conflicts, humanitarian crises, and geopolitical escalation. Include source attribution. Be direct and analytical.`;

const COUNTRY_BRIEF_PROMPT = `You are a senior intelligence analyst producing a country-specific situation dossier. Analyze the provided data including instability scores, active signals, and relevant headlines. Provide:
1. Current situation assessment (2-3 sentences)
2. Key developments with source attribution
3. Risk factors and potential escalation paths
4. Recommended monitoring priorities
Be direct, analytical, and cite sources using [n] notation.`;

// === Caching ===
const briefCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(mode, language, contentHash) {
  return `${mode}:${language}:${contentHash}`;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

function getCached(key) {
  const entry = briefCache.get(key);
  if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
    return entry.data;
  }
  if (entry) briefCache.delete(key);
  return null;
}

function setCache(key, data) {
  briefCache.set(key, { data, timestamp: Date.now() });
  // Prune old entries
  if (briefCache.size > 100) {
    const cutoff = Date.now() - CACHE_TTL;
    for (const [k, v] of briefCache) {
      if (v.timestamp < cutoff) briefCache.delete(k);
    }
  }
}

// === Country headline filtering ===
// Negative-match: exclude headline if another country's alias appears earlier than target country's alias
function filterHeadlinesForCountry(headlines, targetAliases, allCountryAliases) {
  return headlines.filter(h => {
    const lower = (h.title || h.headline || '').toLowerCase();

    // Find position of target country mention
    let targetPos = Infinity;
    for (const alias of targetAliases) {
      const pos = lower.indexOf(alias.toLowerCase());
      if (pos >= 0 && pos < targetPos) targetPos = pos;
    }
    if (targetPos === Infinity) return false; // target not mentioned

    // Check if another country appears earlier
    for (const [code, aliases] of Object.entries(allCountryAliases)) {
      if (aliases === targetAliases) continue; // skip self
      for (const alias of aliases) {
        const pos = lower.indexOf(alias.toLowerCase());
        if (pos >= 0 && pos < targetPos) return false; // another country appears first
      }
    }

    return true;
  });
}

// Country aliases for negative-match filtering
const COUNTRY_ALIASES = {
  US: ['united states', 'u.s.', 'america', 'usa'],
  VE: ['venezuela'], BR: ['brazil'], MX: ['mexico'], CU: ['cuba'],
  DE: ['germany'], FR: ['france'], GB: ['britain', 'united kingdom', 'uk'],
  PL: ['poland'], RU: ['russia'], UA: ['ukraine'], IR: ['iran'],
  IL: ['israel'], SA: ['saudi'], AE: ['emirates', 'uae'],
  TR: ['turkey', 'turkiye'], SY: ['syria'], YE: ['yemen'],
  CN: ['china'], TW: ['taiwan'], KP: ['north korea'],
  IN: ['india'], PK: ['pakistan'], MM: ['myanmar', 'burma'],
};

// === Main API Functions ===

// Generate world brief
export async function generateWorldBrief(allHeadlines, ciiData, focalPointsData, opts = {}) {
  const language = opts.language || 'en';

  // Pre-process: deduplicate
  const deduped = deduplicateHeadlines(allHeadlines);

  // Score and sort
  const scored = deduped.map(h => ({ ...h, relevanceScore: scoreHeadline(h) }));
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Take top headlines for LLM
  const topHeadlines = scored.slice(0, 30);
  const contentStr = topHeadlines.map(h => `- ${h.title || h.headline} [${h.source || 'Unknown'}]`).join('\n');

  // Check cache
  const hash = simpleHash(contentStr);
  const key = cacheKey('world', language, hash);
  const cached = getCached(key);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  // Build context with focal points and CII
  let context = '';
  if (focalPointsData?.focalPoints?.length > 0) {
    const topFocal = focalPointsData.focalPoints.slice(0, 5);
    context += '\n\nActive Focal Points:\n' + topFocal.map(f => `- ${f.name} (${f.urgency}): score ${f.score}`).join('\n');
  }
  if (ciiData?.countries?.length > 0) {
    const topCII = ciiData.countries.filter(c => c.level === 'Critical' || c.level === 'High').slice(0, 5);
    if (topCII.length > 0) {
      context += '\n\nCountry Instability (Critical/High):\n' + topCII.map(c => `- ${c.name}: CII ${c.score} (${c.level}, ${c.trend})`).join('\n');
    }
  }

  const userMessage = `Headlines:\n${contentStr}${context}\n\nProduce a concise intelligence brief covering the most significant developments.`;

  // Try LLM chain
  const llmResult = await callLLMChain(SYSTEM_PROMPT, userMessage);

  // Threat classify all headlines
  const threatData = classifyAll(topHeadlines);

  const result = {
    brief: llmResult?.text || generateFallbackBrief(topHeadlines),
    provider: llmResult?.provider || 'fallback',
    model: llmResult?.model || 'rule-based',
    usage: llmResult?.usage || { inputTokens: 0, outputTokens: 0 },
    headlineCount: topHeadlines.length,
    dedupedFrom: allHeadlines.length,
    threats: threatData,
    timestamp: new Date().toISOString(),
    fromCache: false,
  };

  setCache(key, result);
  return result;
}

// Fallback brief when no LLM is available
function generateFallbackBrief(headlines) {
  const classified = classifyAll(headlines);
  const critical = classified.classifications.filter(c => c.severity === 'critical');
  const high = classified.classifications.filter(c => c.severity === 'high');

  const parts = ['## Intelligence Brief (Auto-Generated)\n'];

  if (critical.length > 0) {
    parts.push('### Critical Developments');
    for (const c of critical.slice(0, 5)) {
      parts.push(`- **${c.primaryCategory.toUpperCase()}**: ${c.headline}`);
    }
    parts.push('');
  }

  if (high.length > 0) {
    parts.push('### High Priority');
    for (const h of high.slice(0, 5)) {
      parts.push(`- **${h.primaryCategory.toUpperCase()}**: ${h.headline}`);
    }
    parts.push('');
  }

  parts.push(`\n_${headlines.length} headlines analyzed. ${critical.length} critical, ${high.length} high priority._`);
  return parts.join('\n');
}

// Generate country-specific brief
export async function generateCountryBrief(countryCode, allHeadlines, ciiData, focalPointsData, signalsData, opts = {}) {
  const code = countryCode.toUpperCase();
  const language = opts.language || 'en';

  // Get CII data for this country
  const ciiCountry = (ciiData?.countries || []).find(c => c.code === code);
  if (!ciiCountry) {
    return { error: `Country ${code} not found in CII data`, code };
  }

  // Filter headlines for this country using negative-match
  const targetAliases = COUNTRY_ALIASES[code] || [ciiCountry.name.toLowerCase()];
  const filtered = filterHeadlinesForCountry(allHeadlines, targetAliases, COUNTRY_ALIASES);
  const top8 = filtered.slice(0, 8);

  // Get focal points for this country
  const countryFocals = (focalPointsData?.focalPoints || []).filter(f =>
    f.countryCode === code || (f.entity?.related || []).includes(code.toLowerCase())
  );

  // Get signals for this country
  const countrySignals = (signalsData?.signals || []).filter(s =>
    s.countryCode === code || (s.title || '').toLowerCase().includes(ciiCountry.name.toLowerCase())
  );

  // Build context
  const headlineStr = top8.map((h, i) => `[${i + 1}] ${h.title || h.headline} — ${h.source || 'Unknown'}`).join('\n');

  const contextParts = [
    `Country: ${ciiCountry.name} (${code})`,
    `CII Score: ${ciiCountry.score}/100 (${ciiCountry.level})`,
    `Trend: ${ciiCountry.trend} (delta: ${ciiCountry.trendDelta > 0 ? '+' : ''}${ciiCountry.trendDelta})`,
    `Components: Unrest ${ciiCountry.components.unrest}, Security ${ciiCountry.components.security}, Information ${ciiCountry.components.information}`,
    `Boosts: ${JSON.stringify(ciiCountry.boosts)}`,
  ];

  if (countryFocals.length > 0) {
    contextParts.push(`\nFocal Points: ${countryFocals.map(f => `${f.name} (${f.urgency})`).join(', ')}`);
  }
  if (countrySignals.length > 0) {
    contextParts.push(`\nActive Signals: ${countrySignals.map(s => `${s.type}: ${s.title}`).join(', ')}`);
  }

  const contentStr = `${contextParts.join('\n')}\n\nRelevant Headlines:\n${headlineStr}`;

  // Check cache
  const hash = simpleHash(contentStr);
  const key = cacheKey(`country-${code}`, language, hash);
  const cached = getCached(key);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  // Try LLM chain
  const llmResult = await callLLMChain(COUNTRY_BRIEF_PROMPT, contentStr);

  // Threat classify country headlines
  const threatData = classifyAll(top8);

  const result = {
    code,
    name: ciiCountry.name,
    cii: {
      score: ciiCountry.score,
      level: ciiCountry.level,
      color: ciiCountry.color,
      trend: ciiCountry.trend,
      trendDelta: ciiCountry.trendDelta,
      components: ciiCountry.components,
      boosts: ciiCountry.boosts,
    },
    brief: llmResult?.text || generateCountryFallback(ciiCountry, top8, countryFocals),
    provider: llmResult?.provider || 'fallback',
    model: llmResult?.model || 'rule-based',
    headlines: top8.map((h, i) => ({
      index: i + 1,
      title: h.title || h.headline || '',
      source: h.source || 'Unknown',
      timestamp: h.timestamp || h.date || null,
      threat: classifyAll([h]).classifications[0] || null,
    })),
    focalPoints: countryFocals.slice(0, 5),
    signals: countrySignals.slice(0, 5),
    threats: threatData,
    timestamp: new Date().toISOString(),
    fromCache: false,
  };

  setCache(key, result);
  return result;
}

// Fallback country brief
function generateCountryFallback(ciiCountry, headlines, focals) {
  const parts = [
    `## ${ciiCountry.name} Situation Assessment`,
    '',
    `**Instability Index:** ${ciiCountry.score}/100 (${ciiCountry.level}, ${ciiCountry.trend})`,
    `**Components:** Unrest ${ciiCountry.components.unrest}% | Security ${ciiCountry.components.security}% | Information ${ciiCountry.components.information}%`,
    '',
  ];

  if (headlines.length > 0) {
    parts.push('### Key Headlines');
    for (const h of headlines.slice(0, 5)) {
      parts.push(`- ${h.title || h.headline} [${h.source || 'Unknown'}]`);
    }
    parts.push('');
  }

  if (focals.length > 0) {
    parts.push('### Focal Entities');
    for (const f of focals.slice(0, 3)) {
      parts.push(`- **${f.name}** (${f.urgency}): ${f.narrative || ''}`);
    }
  }

  return parts.join('\n');
}

// Briefing stub for orchestrator
export async function briefing() {
  return {
    source: 'Summarizer',
    timestamp: new Date().toISOString(),
    status: 'ready',
    providers: {
      ollama: !!process.env.OLLAMA_BASE_URL || 'auto-discover',
      groq: !!process.env.GROQ_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
    },
    message: 'Summarization chain ready. Briefs generated on demand via API endpoints.',
  };
}

if (process.argv[1]?.endsWith('summarizer.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
