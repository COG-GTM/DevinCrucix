#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { collectQuick as yfinanceQuick } from './apis/sources/yfinance.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { geolocatePhoto, photoGeolocAvailability, sanitizeHint } from './lib/geoloc/photo.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { installAuthGate } from './lib/authgate.mjs';
import { securityHeaders } from './lib/securityHeaders.mjs';
import { buildSituation } from './lib/situation.mjs';
import { buildTaiwanGeo } from './lib/taiwanview.mjs';

// Phase 4: Analytical Features
import { computeCII } from './apis/sources/cii.mjs';
import { trimCii } from './lib/ukraineview.mjs';
import { computeConvergence } from './apis/sources/convergence.mjs';
import { computeSignals } from './apis/sources/signals.mjs';
import { computeFocalPoints } from './apis/sources/focalpoints.mjs';
import { generateWorldBrief, generateCountryBrief } from './apis/sources/summarizer.mjs';
import { classifyAll } from './apis/sources/threatclassifier.mjs';

// Phase 5: New Features
import { startTelegramLive, getTelegramFeed, getTelegramChannels, setTelegramChannels, TELEGRAM_CHANNEL_RE } from './apis/sources/telegramlive.mjs';
import { computeDefcon } from './apis/sources/defcon.mjs';

// Phase 6: Osiris-Ported Features
import { getRegionDossier } from './apis/sources/regiondossier.mjs';
import { classifyTarget, investigate, keyedSourceStatus, TARGET_HINTS, TARGET_TYPES } from './apis/sources/investigate.mjs';
import { parseImageMetadata, PLATFORMS } from './apis/sources/osint.mjs';
import { briefing as typosquatBriefing, getWatchlist as typosquatWatchlist } from './apis/sources/typosquat.mjs';
import { queryArticles as borderArticles, loadRegistry as borderRegistry, TOPIC_KEYS as BORDER_TOPICS, PLACE_BY_KEY as BORDER_PLACES } from './apis/sources/bordernews.mjs';

// Phase 7: Seismic Event Monitor
import { collectSeismic } from './apis/sources/seismic.mjs';
import { ingestGet, PROXY_PARAM_RE } from './apis/sources/borderingest.mjs';
import { str, num, oneOf, strArray, bounded, validateQuery, validateBody, validateParams } from './lib/validate.mjs';
import { computeNarcoEvents, loadNarcoEvents } from './lib/narco/pipeline.mjs';
import { buildNarcoView, compactCluster } from './lib/narco/view.mjs';
import { queryReleases as dojReleases, DISTRICTS as DOJ_DISTRICTS, CATEGORY_IDS as DOJ_CATEGORIES } from './apis/sources/doj.mjs';
import { loadIndex as ofacNarcoIndex, matchNames as ofacMatchNames } from './apis/sources/ofacnarco.mjs';
import { CONFIDENCE as NARCO_GRADES } from './lib/narco/events.mjs';
import { EVENT_TYPE_LABELS as NARCO_TYPES } from './lib/narco/extract.mjs';
import { refreshCorpus as refreshCjngCorpus } from './lib/cjng/corpus.mjs';
import { TargetStore, validateNomination, summarizeTarget, TARGET_TYPES as TGT_TYPES, BASIS_KINDS as TGT_BASIS, DECISIONS as TGT_DECISIONS, TARGET_ID_RE, LINK_ID_RE, PROPOSAL_ID_RE } from './lib/targeting/store.mjs';
import { developTarget, compactPackage, EVIDENCE_TIERS, CLAIM_STATES } from './lib/targeting/index.mjs';
import { buildSourceContext } from './lib/targeting/sources.mjs';
import { renderDossier } from './lib/targeting/dossier.mjs';
import { buildCjngGraph, loadGraph as loadCjngGraph, saveGraph as saveCjngGraph, summarizeGraph as summarizeCjngGraph, filterGraph as filterCjngGraph, NODE_TYPES as CJNG_NODE_TYPES, RELATIONS as CJNG_RELATIONS } from './lib/cjng/graph.mjs';
import { createCyberfix, InventoryError as CyberfixInventoryError, DevinApiError as CyberfixDevinError, INVENTORY_KINDS as CYBERFIX_KINDS, MAX_INVENTORY_BYTES as CYBERFIX_MAX_BYTES } from './lib/cyberfix/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let frontGeo = null;       // DeepStateMAP geometry from the last sweep (served separately from /api/data)
let cartelGeo = null;      // Cartel-map KML geometry from the last sweep
let iranGeo = null;        // Iran War Live geocoded events (kinetic + ground) from the last sweep (served separately from /api/data)
let taiwanGeo = null;      // China / Taiwan theater geometry (MND ADIZ sectors, CGA area circles, GCA points) from the last sweep
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
let marketRefreshInProgress = false;
let seismicData = null;      // Seismic Event Monitor state (refreshed independently)
let narcoData = loadNarcoEvents(); // Full narco event clusters from the last post-sweep computation (runs/narco/events.json)
let cjngGraph = loadCjngGraph();   // CJNG knowledge graph built from InSight Crime's public API (runs/insightcrime/cjng/graph.json, else committed snapshot)
let cjngRefresh = { status: cjngGraph ? (cjngGraph.snapshot ? 'snapshot' : 'cached') : 'pending', lastAttempt: null, lastSuccess: cjngGraph?.computedAt || null, error: null, inProgress: false };
const CJNG_REFRESH_HOURS = Math.min(168, Math.max(1, Number(process.env.CJNG_GRAPH_REFRESH_HOURS) || 12));
const CJNG_REFRESH_ENABLED = process.env.CJNG_GRAPH_REFRESH !== 'false';
function narcoView(result, sources, opts) {
  const v = buildNarcoView(result, sources, opts);
  v.cjng = summarizeCjngGraph(cjngGraph, cjngRefresh);
  return v;
}
const startTime = Date.now();
const sseClients = new Set();
const MARKET_REFRESH_SECONDS = parseInt(process.env.MARKET_REFRESH_SECONDS) || 60;
// Heartbeat events keep the stream busy so proxies (Fly, corporate) never see an idle
// connection between broadcasts, and let the browser detect a half-open stream.
const SSE_HEARTBEAT_MS = parseInt(process.env.SSE_HEARTBEAT_MS) || 20000;

function sourceSummaryLine() {
  const meta = currentData?.meta || {};
  const h = meta.health;
  if (!h) return `${meta.sourcesOk || 0}/${meta.sourcesQueried || 0} OK`;
  return `${h.live} live · ${h.degraded} degraded · ${h.no_key} no key · ${h.off} off · ${h.error} failed (${h.total} total)`;
}

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter(config.telegram);
const discordAlerter = new DiscordAlerter(config.discord || {});

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *CRUCIX STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourceSummaryLine()}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [
      `📋 *CRUCIX BRIEF*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    // Delta direction
    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: *${delta.summary.direction.toUpperCase()}* | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical`);
      sections.push('');
    }

    // Key metrics
    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
      sections.push(`   NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    // OSINT
    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      // Top 2 urgent
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    // Top ideas
    if (ideas.length > 0) {
      sections.push(`💡 *Top Ideas:*`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ CRUCIX STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourceSummaryLine()}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [`**📋 CRUCIX BRIEF**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: **${delta.summary.direction.toUpperCase()}** | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical\n`);
    }

    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
      sections.push(`   NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**💡 Top Ideas:**`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(securityHeaders());
const authGateEnabled = installAuthGate(app);
if (authGateEnabled) console.log('[Crucix] Password gate enabled (CRUCIX_PASSWORD set)');
app.use(express.json());
// Live JSON must not be replayed from the browser HTTP cache on back/forward navigation; routes that
// want a cache window set their own Cache-Control afterwards.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');

    // Never ship an inject.mjs seed in server mode; the page renders only live data.
    html = html.replace(/^let D = \{.*\};\s*$/m, 'let D = null;');

    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.type('html').send(html);
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData);
});

// API: Border Watch (synthesized from the Python ingestion service during the sweep)
app.get('/api/border', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.borderIngest || { status: 'offline', anomalies: [], regions: [], articles: [], baselines: [] });
});

// API: read-only proxy to the Python ingestion service. Only allow-listed GET paths/params are
// forwarded (see apis/sources/borderingest.mjs); the service's POST endpoints stay loopback-only.
const INGEST_PARAM = (v) => str(v, { max: 64, pattern: PROXY_PARAM_RE });
app.get(/^\/api\/ingest(\/.*)?$/, validateParams({ 0: (v) => str(v, { max: 200, pattern: /^\/[A-Za-z0-9_\/-]*$/ }) }), validateQuery({
  limit: INGEST_PARAM, since: INGEST_PARAM, region: INGEST_PARAM, violence: INGEST_PARAM,
  language: INGEST_PARAM, source: INGEST_PARAM, paywalled: INGEST_PARAM, series: INGEST_PARAM,
}), async (req, res) => {
  const upstreamPath = req.validated.params[0] || '/health';
  const { status, body, detail } = await ingestGet(upstreamPath, req.validated.query);
  if (detail) console.error(`[Crucix] ingest proxy ${upstreamPath}: ${detail}`);
  res.status(status).set('Cache-Control', 'no-store').json(body);
});

// API: carrier strike groups
app.get('/api/carriers', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.carriers || { totalCarriers: 0, carriers: [] });
});

// API: GPS jamming zones
app.get('/api/gps-jamming', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.gpsJamming || { totalZones: 0, zones: [] });
});

// API: CCTV mesh cameras
app.get('/api/cctv', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.cctvMesh || { totalCameras: 0, cameras: [] });
});

// === Phase 4: Analytical Feature API Endpoints ===

// API: Country Instability Index
app.get('/api/cii', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.cii || { totalCountries: 0, countries: [] });
});

// API: Geographic Convergence
app.get('/api/convergence', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.convergence || { totalZones: 0, zones: [] });
});

// API: Signal Intelligence
app.get('/api/signals', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.signals || { totalSignals: 0, signals: [] });
});

// API: Focal Points
app.get('/api/focal-points', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.focalPoints || { totalFocalPoints: 0, focalPoints: [] });
});

// API: AI Summarization (world brief)
const LANGUAGE = (v) => str(v, { max: 8, pattern: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/ });
app.post('/api/summarize', validateBody({ language: LANGUAGE }), async (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  try {
    const allHeadlines = (currentData.newsFeed || []).map(n => ({
      title: n.headline || n.title || '', source: n.source || 'Unknown', timestamp: n.timestamp,
    }));
    const result = await generateWorldBrief(allHeadlines, currentData.cii, currentData.focalPoints, req.validated.body);
    res.json(result);
  } catch (err) {
    console.error('[Crucix] Summarize error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// API: Country brief
app.get('/api/country-brief/:code', validateParams({ code: (v) => str(v, { max: 3, pattern: /^[A-Za-z]{2,3}$/, required: true }) }), validateQuery({ language: LANGUAGE }), async (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  try {
    const allHeadlines = (currentData.newsFeed || []).map(n => ({
      title: n.headline || n.title || '', source: n.source || 'Unknown', timestamp: n.timestamp,
    }));
    const result = await generateCountryBrief(
      req.validated.params.code, allHeadlines, currentData.cii, currentData.focalPoints, currentData.signals, req.validated.query,
    );
    res.json(result);
  } catch (err) {
    console.error('[Crucix] Country brief error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === Phase 5: Feature API Endpoints ===

// API: Pentagon Pizza Index
app.get('/api/pizza-index', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.pizzaIndex || { status: 'unavailable', doughcon: null });
});

// API: CISA KEV Cyber Threat Layer
app.get('/api/cyber/kev', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.cyberKev || { totalVulnerabilities: 0, vulnerabilities: [] });
});

// API: Telegram OSINT Live Feed
app.get('/api/telegram/feed', (req, res) => {
  res.json(getTelegramFeed());
});

// API: Telegram channels list
app.get('/api/telegram/channels', (req, res) => {
  res.json(getTelegramChannels());
});

// API: Update Telegram channels
app.post('/api/telegram/channels', validateBody({
  channels: (v) => strArray(v, { min: 1, max: 20, itemMin: 5, itemMax: 32, pattern: TELEGRAM_CHANNEL_RE, required: true }),
}), (req, res) => {
  const result = setTelegramChannels(req.validated.body.channels);
  if (result.error) return res.status(400).json({ error: 'invalid request', field: 'channels' });
  res.json(result);
});

// API: Polymarket Geopolitical Odds
app.get('/api/prediction-markets', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.polymarket || { totalGeoMarkets: 0, markets: [] });
});

// API: DEFCON Threat Meter
app.get('/api/defcon', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.defcon || { level: 5, score: 0, color: '#00ff41' });
});

// === Phase 6: Osiris-Ported Feature API Endpoints ===

// API: Nuclear Facilities
app.get('/api/nuclear', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.nuclear || { totalFacilities: 0, facilities: [] });
});

// API: Space Weather
app.get('/api/space-weather', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.spaceWeather || { kp: { current: 0, level: 'Quiet' }, flares: [], alerts: [] });
});

// API: Ukraine Frontlines (DeepStateMAP) — summary in /api/data, geometry on demand
app.get('/api/frontlines', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.frontlines || { status: 'unavailable' });
});

app.get('/api/frontlines/geo', (req, res) => {
  if (!frontGeo) return res.status(404).json({ error: 'No frontline geometry yet' });
  res.set('Cache-Control', 'private, max-age=300');
  res.json(frontGeo);
});

// API: Cartels (crowd-sourced Mexico influence map) — summary + START 2020 baseline; geometry on demand
app.get('/api/cartels', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.cartels || { status: 'unavailable' });
});

app.get('/api/cartels/geo', (req, res) => {
  if (!cartelGeo) return res.status(404).json({ error: 'No cartel geometry yet' });
  res.set('Cache-Control', 'private, max-age=600');
  res.json(cartelGeo);
});

// API: Iran War Live (LLM-extracted Iran-theater aggregator) — summary in /api/data, geocoded events on demand
app.get('/api/iranwar', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.iranwar || { status: 'unavailable' });
});

app.get('/api/iranwar/geo', (req, res) => {
  if (!iranGeo) return res.status(404).json({ error: 'No Iran War Live geometry yet' });
  res.set('Cache-Control', 'private, max-age=300');
  res.json(iranGeo);
});

// API: China / Taiwan — MND daily PLA bulletin, CGA grey-zone incidents, headlines, GCA strip, markets
// (summary in /api/data); area/sector geometry on demand for the theater map
app.get('/api/taiwan', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.taiwan || { status: 'unavailable' });
});

app.get('/api/taiwan/geo', (req, res) => {
  if (!taiwanGeo) return res.status(404).json({ error: 'No China / Taiwan geometry yet' });
  res.set('Cache-Control', 'private, max-age=300');
  res.json(taiwanGeo);
});

// API: Homeland / Narco — normalized cartel / border-crime events (Border Watch feeds + DOJ), graded by
// independent corroboration and cross-matched against the OFAC SDN narco-program index.
const NARCO_ID_RE = /^[a-z0-9_-]{1,40}$/;
// Whitelist of query keys per filtered route: any key not listed is rejected, not ignored.
function onlyQueryKeys(req, allowed) {
  return Object.keys(req.query).every(k => allowed.includes(k));
}
function narcoPick(req, name, allowed) {
  const v = req.query[name];
  if (v === undefined) return null;
  return typeof v === 'string' && v.length <= 64 && allowed(v) ? v : undefined;
}
function narcoInt(req, name, dflt, min, max, digits) {
  const raw = req.query[name] === undefined ? String(dflt) : req.query[name];
  const n = typeof raw === 'string' && new RegExp(`^\\d{1,${digits}}$`).test(raw) ? Number(raw) : NaN;
  return n >= min && n <= max ? n : NaN;
}
app.get('/api/narco', (req, res) => {
  if (!onlyQueryKeys(req, [])) return res.status(400).json({ error: 'Invalid request' });
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.narco || { status: 'unavailable' });
});
app.get('/api/narco/events', (req, res) => {
  if (!onlyQueryKeys(req, ['grade', 'type', 'cartel', 'state', 'days', 'limit'])) return res.status(400).json({ error: 'Invalid request' });
  const grade = narcoPick(req, 'grade', v => Object.hasOwn(NARCO_GRADES, v));
  const type = narcoPick(req, 'type', v => Object.hasOwn(NARCO_TYPES, v));
  const cartel = narcoPick(req, 'cartel', v => NARCO_ID_RE.test(v));
  const state = narcoPick(req, 'state', v => /^[A-Za-z\u00C0-\u017F .'-]{2,40}$/.test(v));
  const days = narcoInt(req, 'days', 30, 1, 90, 2);
  const limit = narcoInt(req, 'limit', 100, 1, 200, 3);
  if ([grade, type, cartel, state].includes(undefined) || Number.isNaN(days) || Number.isNaN(limit)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (!narcoData) return res.json({ status: 'pending', count: 0, events: [] });
  const cut = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const currentCut = new Date(new Date(narcoData.computedAt).getTime() - (narcoData.currentDays || 30) * 86_400_000).toISOString().slice(0, 10);
  const stateLc = state ? state.toLowerCase() : null;
  const events = (narcoData.clusters || [])
    .filter(c => c.date && c.date >= cut)
    .filter(c => !grade || c.confidence?.grade === grade)
    .filter(c => !type || c.eventType === type || (c.eventTypes || []).includes(type))
    .filter(c => !cartel || [...(c.cartels || []), ...(c.factions || [])].some(g => g.orgId === cartel))
    .filter(c => !stateLc || String(c.location?.state || '').toLowerCase() === stateLc);
  res.json({ status: 'live', computedAt: narcoData.computedAt, filters: { grade, type, cartel, state, days }, count: events.length, events: events.slice(0, limit).map(c => compactCluster(c, currentCut)) });
});
app.get('/api/narco/events/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!onlyQueryKeys(req, []) || !/^cl_[a-f0-9]{20}$/.test(id)) return res.status(400).json({ error: 'Invalid request' });
  const c = (narcoData?.clusters || []).find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Event not found' });
  res.json(c);
});
// CJNG knowledge graph (InSight Crime public API -> lib/cjng). Filters are allowlisted; the full graph is bounded at build time.
const CJNG_LIST_RE = /^[a-z_]{1,20}(?:,[a-z_]{1,20}){0,9}$/;
app.get('/api/narco/graph', (req, res) => {
  if (!onlyQueryKeys(req, ['type', 'rel', 'min'])) return res.status(400).json({ error: 'Invalid request' });
  const type = narcoPick(req, 'type', v => CJNG_LIST_RE.test(v) && v.split(',').every(t => CJNG_NODE_TYPES.includes(t)));
  const rel = narcoPick(req, 'rel', v => CJNG_LIST_RE.test(v) && v.split(',').every(t => Object.hasOwn(CJNG_RELATIONS, t)));
  const min = narcoInt(req, 'min', 1, 1, 999, 3);
  if (type === undefined || rel === undefined || Number.isNaN(min)) return res.status(400).json({ error: 'Invalid request' });
  if (!cjngGraph) return res.json({ status: cjngRefresh.status, refresh: cjngRefresh, nodes: [], edges: [], articles: [] });
  const g = filterCjngGraph(cjngGraph, { types: type ? type.split(',') : null, rels: rel ? rel.split(',') : null, minArticles: min });
  res.json({ status: cjngGraph.snapshot ? 'snapshot' : 'live', refresh: cjngRefresh, ...g });
});

app.get('/api/narco/doj', (req, res) => {
  if (!onlyQueryKeys(req, ['district', 'category', 'days', 'limit'])) return res.status(400).json({ error: 'Invalid request' });
  const district = narcoPick(req, 'district', v => DOJ_DISTRICTS.some(d => d.code === v));
  const category = narcoPick(req, 'category', v => DOJ_CATEGORIES.includes(v));
  const days = narcoInt(req, 'days', 30, 1, 90, 2);
  const limit = narcoInt(req, 'limit', 100, 1, 200, 3);
  if ([district, category].includes(undefined) || Number.isNaN(days) || Number.isNaN(limit)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    res.json(dojReleases({ district, category, days, limit }));
  } catch (err) {
    console.error('[Crucix] DOJ releases error:', err);
    res.status(500).json({ error: 'DOJ releases unavailable' });
  }
});
// Name check against the OFAC narco-program index (same conservative matcher the pipeline uses).
app.get('/api/narco/sanctions', (req, res) => {
  const raw = req.query.name;
  if (!onlyQueryKeys(req, ['name']) || typeof raw !== 'string' || raw.length < 3 || raw.length > 120 || !/^[A-Za-z\u00C0-\u017F .,'-]+$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const index = ofacNarcoIndex();
  if (!index) return res.status(503).json({ error: 'Sanctions index not loaded yet' });
  res.json({ query: raw, publishDate: index.publishDate || null, matches: ofacMatchNames([raw], index).slice(0, 10) });
});

// === Target Development (FIND / FIX over public reporting) ===
// Nomination -> develop (mentions, selectors, correlation, text geolocation, pattern) -> analyst review of
// links and graph proposals -> sourced dossier. The store is the only writer; the verified CJNG graph is never
// mutated — accepted proposals live in an overlay returned by /api/targeting/graph-overlay.
const targetStore = new TargetStore(process.env.TARGETING_DATA_DIR ? { dataDir: process.env.TARGETING_DATA_DIR } : {});
const targetDevelopInFlight = new Set();
const TGT_ID = (v) => str(v, { max: 16, pattern: TARGET_ID_RE, required: true });
function targetAudit(event, req, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ip: req.ip, ...details }));
}
function targetingCapabilities() {
  return {
    types: TGT_TYPES, basisKinds: TGT_BASIS, decisions: TGT_DECISIONS, tiers: EVIDENCE_TIERS, claimStates: CLAIM_STATES,
    llm: llmProvider?.isConfigured ? { configured: true, provider: llmProvider.name, model: llmProvider.model } : { configured: false, reason: 'set LLM_PROVIDER + LLM_API_KEY (anthropic / openai) to enable model-assisted correlation' },
  };
}
app.get('/api/targeting', (req, res) => {
  if (!onlyQueryKeys(req, [])) return res.status(400).json({ error: 'Invalid request' });
  const targets = targetStore.list();
  res.json({ capabilities: targetingCapabilities(), count: targets.length, targets });
});
app.post('/api/targeting/targets', (req, res) => {
  const body = req.body;
  const allowed = ['label', 'type', 'aliases', 'basis', 'requirement', 'priority'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).every(k => allowed.includes(k))) return res.status(400).json({ error: 'invalid request', field: 'body' });
  const v = validateNomination(body);
  if (!v.ok) { targetAudit('targeting_validation_failure', req, { field: v.field }); return res.status(400).json({ error: 'invalid request', field: v.field }); }
  const r = targetStore.nominate(v.value);
  if (r.error === 'capacity') return res.status(409).json({ error: 'Target capacity reached; close a target first' });
  if (r.error === 'duplicate') return res.status(409).json({ error: 'Target already nominated', id: r.target.id });
  targetAudit('targeting_nominate', req, { id: r.target.id, type: r.target.type, basis: r.target.basis.kind });
  res.status(201).json({ target: summarizeTarget(r.target) });
});
app.get('/api/targeting/targets/:id', validateParams({ id: TGT_ID }), (req, res) => {
  if (!onlyQueryKeys(req, [])) return res.status(400).json({ error: 'Invalid request' });
  const t = targetStore.get(req.validated.params.id);
  if (!t) return res.status(404).json({ error: 'Target not found' });
  res.json({ ...summarizeTarget(t), decisions: t.decisions, graphProposals: t.graphProposals, exports: t.exports, package: compactPackage(t.package), developing: targetDevelopInFlight.has(t.id) });
});
app.post('/api/targeting/targets/:id/develop', validateParams({ id: TGT_ID }), async (req, res) => {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return res.status(400).json({ error: 'invalid request', field: 'body' });
  const t = targetStore.get(req.validated.params.id);
  if (!t) return res.status(404).json({ error: 'Target not found' });
  if (t.status === 'closed') return res.status(409).json({ error: 'Target is closed' });
  if (targetDevelopInFlight.has(t.id)) return res.status(409).json({ error: 'Development already running' });
  if (investigateRateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests; wait a minute' });
  targetDevelopInFlight.add(t.id);
  targetAudit('targeting_develop_start', req, { id: t.id, llm: Boolean(llmProvider?.isConfigured) });
  try {
    const ctx = buildSourceContext({ graph: cjngGraph, narcoData, telegramFeed: getTelegramFeed() });
    const pkg = await developTarget(llmProvider, t, ctx);
    const saved = targetStore.setPackage(t.id, pkg);
    targetAudit('targeting_develop_done', req, { id: t.id, ms: pkg.durationMs, mentions: pkg.stats.mentions, links: pkg.links.length, proposals: saved.graphProposals.length, llm: pkg.llm.used ? pkg.llm.model : null });
    res.json({ ...summarizeTarget(saved), decisions: saved.decisions, graphProposals: saved.graphProposals, package: compactPackage(saved.package) });
  } catch (err) {
    console.error('[Crucix] Target development error:', err);
    targetAudit('targeting_develop_error', req, { id: t.id });
    res.status(500).json({ error: 'Target development failed' });
  } finally {
    targetDevelopInFlight.delete(t.id);
  }
});
const TGT_DECISION_BODY = validateBody({ decision: (v) => oneOf(v, TGT_DECISIONS, { required: true }) });
app.post('/api/targeting/targets/:id/links/:linkId', validateParams({ id: TGT_ID, linkId: (v) => str(v, { max: 16, pattern: LINK_ID_RE, required: true }) }), TGT_DECISION_BODY, (req, res) => {
  if (!Object.keys(req.body || {}).every(k => k === 'decision')) return res.status(400).json({ error: 'invalid request', field: 'body' });
  const { id, linkId } = req.validated.params;
  const r = targetStore.decideLink(id, linkId, req.validated.body.decision);
  if (!r) return res.status(404).json({ error: 'Link not found' });
  targetAudit('targeting_link_decision', req, { id, linkId, decision: req.validated.body.decision });
  res.json({ link: r.link, target: summarizeTarget(r.target) });
});
app.post('/api/targeting/targets/:id/proposals/:proposalId', validateParams({ id: TGT_ID, proposalId: (v) => str(v, { max: 16, pattern: PROPOSAL_ID_RE, required: true }) }), TGT_DECISION_BODY, (req, res) => {
  if (!Object.keys(req.body || {}).every(k => k === 'decision')) return res.status(400).json({ error: 'invalid request', field: 'body' });
  const { id, proposalId } = req.validated.params;
  const r = targetStore.decideProposal(id, proposalId, req.validated.body.decision);
  if (!r) return res.status(404).json({ error: 'Proposal not found' });
  targetAudit('targeting_proposal_decision', req, { id, proposalId, decision: req.validated.body.decision });
  res.json({ proposal: r.proposal, target: summarizeTarget(r.target) });
});
app.post('/api/targeting/targets/:id/close', validateParams({ id: TGT_ID }), (req, res) => {
  const t = targetStore.close(req.validated.params.id);
  if (!t) return res.status(404).json({ error: 'Target not found' });
  targetAudit('targeting_close', req, { id: t.id });
  res.json({ target: summarizeTarget(t) });
});
app.delete('/api/targeting/targets/:id', validateParams({ id: TGT_ID }), (req, res) => {
  if (!targetStore.remove(req.validated.params.id)) return res.status(404).json({ error: 'Target not found' });
  targetAudit('targeting_delete', req, { id: req.validated.params.id });
  res.json({ ok: true });
});
app.get('/api/targeting/targets/:id/dossier.md', validateParams({ id: TGT_ID }), (req, res) => {
  if (!onlyQueryKeys(req, [])) return res.status(400).json({ error: 'Invalid request' });
  const t = targetStore.get(req.validated.params.id);
  if (!t) return res.status(404).json({ error: 'Target not found' });
  if (!t.package) return res.status(409).json({ error: 'Target not developed yet' });
  try {
    const md = renderDossier(t);
    targetStore.recordExport(t.id, 'markdown');
    targetAudit('targeting_export', req, { id: t.id, format: 'markdown', bytes: md.length });
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="crucix-target-${t.id}.md"`);
    res.send(md);
  } catch (err) {
    console.error('[Crucix] Dossier render error:', err);
    res.status(500).json({ error: 'Dossier export failed' });
  }
});
app.get('/api/targeting/graph-overlay', (req, res) => {
  if (!onlyQueryKeys(req, [])) return res.status(400).json({ error: 'Invalid request' });
  res.json(targetStore.acceptedGraphOverlay());
});

// API: Region Dossier (on-demand, not from sweep)
const LAT = (v) => num(v, { min: -90, max: 90, required: true });
const LON = (v) => num(v, { min: -180, max: 180 });
app.get('/api/region-dossier', validateQuery({ lat: LAT, lng: LON, lon: LON }), async (req, res) => {
  const { lat, lng, lon } = req.validated.query;
  const longitude = lng ?? lon;
  if (longitude === undefined) return res.status(400).json({ error: 'invalid request', field: 'lng' });
  try {
    const dossier = await getRegionDossier(lat, longitude);
    res.json(dossier);
  } catch (err) {
    console.error('[Crucix] Region dossier error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// API: Investigate pivot — on-demand OSINT enrichment for a selector
// (domain / IP / hash / company / email / username / phone / URL / BTC / ETH).
// Per-client token bucket: investigations fan out to many third-party APIs.
const INV_RATE = { windowMs: 60_000, max: 20 };
const _invBuckets = new Map();
function investigateRateLimited(ip) {
  const now = Date.now();
  const b = _invBuckets.get(ip) || { start: now, n: 0 };
  if (now - b.start > INV_RATE.windowMs) { b.start = now; b.n = 0; }
  b.n++;
  _invBuckets.set(ip, b);
  if (_invBuckets.size > 5000) for (const [k, v] of _invBuckets) if (now - v.start > INV_RATE.windowMs) _invBuckets.delete(k);
  return b.n > INV_RATE.max;
}

// Selector hint: whitelisted against TARGET_HINTS from investigate.mjs. The dashboard sends `type`;
// `kind` is accepted as an alias. Omitted → 'auto'.
const HINT = (v) => oneOf(v, TARGET_HINTS);
app.get('/api/investigate', validateQuery({ target: (v) => str(v, { max: 255, required: true }), type: HINT, kind: HINT }), async (req, res) => {
  const raw = req.validated.query.target;
  const hint = req.validated.query.type ?? req.validated.query.kind ?? 'auto';
  if (investigateRateLimited(req.ip)) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'investigate_rate_limited', ip: req.ip }));
    return res.status(429).json({ error: 'Too many investigations; wait a minute' });
  }
  const target = classifyTarget(raw, hint === 'auto' ? undefined : hint);
  if (!target) {
    return res.status(400).json({ error: 'Selector not recognized. Supported: domain, URL, IPv4/IPv6, MD5/SHA1/SHA256 hash, email, @username, +phone, BTC/ETH address, or company name (choose CO.)' });
  }
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'investigate', ip: req.ip, type: target.type, target: target.value }));
  try {
    res.json(await investigate(target));
  } catch (err) {
    console.error('[Crucix] Investigate error:', err);
    res.status(500).json({ error: 'Investigation failed' });
  }
});

app.get('/api/investigate/status', (req, res) => {
  res.json({ keyed: keyedSourceStatus(), types: TARGET_TYPES, platformProbes: PLATFORMS.length, typosquatWatchlist: typosquatWatchlist() });
});

// API: Image / document metadata — parsed in-process, nothing is written to disk or forwarded upstream.
const META_MAX_BYTES = 12 * 1024 * 1024;
app.post('/api/investigate/metadata', express.raw({ type: () => true, limit: META_MAX_BYTES }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 16) return res.status(400).json({ error: 'Invalid request' });
  if (investigateRateLimited(req.ip)) return res.status(429).json({ error: 'Too many investigations; wait a minute' });
  const name = String(req.get('x-file-name') || '').replace(/[^\w. -]/g, '').slice(0, 120);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'investigate_metadata', ip: req.ip, bytes: req.body.length }));
  try {
    const meta = parseImageMetadata(req.body);
    // The model path is offered (not run) here; the operator triggers it explicitly and only when EXIF has no fix.
    const geoloc = meta.gps ? { available: false, reason: 'exif-gps', detail: 'EXIF GPS fix present; model estimate not needed' }
      : photoGeolocAvailability(llmProvider, { format: meta.format, bytes: req.body.length });
    res.json({ name, ...meta, geoloc });
  } catch (err) {
    console.error('[Crucix] Metadata parse error:', err);
    res.status(500).json({ error: 'Metadata extraction failed' });
  }
});

// API: Content-based photo geolocation — operator-initiated vision-model estimate for images with no EXIF fix.
// The image stays in memory and goes only to the configured LLM provider; the answer is bounded and
// gazetteer-snapped in lib/geoloc/photo.mjs and always flagged as a model assessment.
app.post('/api/investigate/geolocate', express.raw({ type: () => true, limit: META_MAX_BYTES }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 16) return res.status(400).json({ error: 'Invalid request' });
  if (investigateRateLimited(req.ip)) return res.status(429).json({ error: 'Too many investigations; wait a minute' });
  const name = String(req.get('x-file-name') || '').replace(/[^\w. -]/g, '').slice(0, 120);
  const hint = sanitizeHint(req.get('x-geo-hint'));
  try {
    const meta = parseImageMetadata(req.body);
    const result = await geolocatePhoto(llmProvider, req.body, { format: meta.format, meta, hint });
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'investigate_geolocate', ip: req.ip, bytes: req.body.length, status: result.status, model: result.model || null }));
    res.json({ name, sha256: meta.sha256, format: meta.format, exifGps: meta.gps, ...result });
  } catch (err) {
    console.error('[Crucix] Geolocate error:', err);
    res.status(500).json({ error: 'Geolocation failed' });
  }
});

// API: Typosquat Watch — look-alike domains registered against the watchlist
app.get('/api/typosquat', async (req, res) => {
  if (currentData?.typosquat?.status === 'live') return res.json(currentData.typosquat);
  try {
    res.json(await typosquatBriefing());
  } catch (err) {
    console.error('[Crucix] Typosquat error:', err);
    res.status(500).json({ error: 'Typosquat watch unavailable' });
  }
});

// API: Border Watch — stored articles filtered by whitelisted place / topic / outlet keys
let borderSourceIds = null;
function borderSourceIdSet() {
  if (!borderSourceIds) {
    try { borderSourceIds = new Set(borderRegistry().map(s => s.id)); } catch { borderSourceIds = new Set(); }
  }
  return borderSourceIds;
}
app.get('/api/border/articles', validateQuery({
  place: (v) => oneOf(v, BORDER_PLACES),
  topic: (v) => oneOf(v, BORDER_TOPICS),
  outlet: (v) => oneOf(v, borderSourceIdSet()),
  days: (v) => bounded(v, 90),
  limit: (v) => bounded(v, 200),
}), (req, res) => {
  const { place = null, topic = null, outlet = null, days = 30, limit = 100 } = req.validated.query;
  try {
    res.json(borderArticles({ place, topic, outlet, days, limit }));
  } catch (err) {
    console.error('[Crucix] Border articles error:', err);
    res.status(500).json({ error: 'Border articles unavailable' });
  }
});

// API: Seismic Event Monitor (USGS live feed + nuclear-test discrimination)
app.get('/api/seismic', (req, res) => {
  res.json(seismicData || { status: 'pending', totalEvents: 0, events: [] });
});

// API: Satellite Tracking (SGP4)
app.get('/api/satellites', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.satTracking || { totalTracked: 0, satellites: [] });
});

// API: Live News Streams
app.get('/api/live-news', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.liveNews || { totalStreams: 0, streams: [] });
});

// API: Threat classification
app.get('/api/threat-classify', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  const headlines = (currentData.newsFeed || []).map(n => n.headline || n.title || '');
  const result = classifyAll(headlines);
  res.json(result);
});

// === Standing requirements (PIRs) with long-range baselines — lib/requirements/* ===
// Imports are hoisted by the module loader; they sit here so the whole feature is one contiguous block.
import { HistoryStore, computeBaseline, WINDOWS as RQ_WINDOWS, WINDOW_HOURS as RQ_WINDOW_HOURS } from './lib/requirements/history.mjs';
import { catalog as rqCatalog, METRIC_KEYS as RQ_METRIC_KEYS, DIM_KEYS as RQ_DIM_KEYS } from './lib/requirements/metrics.mjs';
import { compileRequirement, ID_RE as RQ_ID_RE, OBS_WINDOWS as RQ_OBS_WINDOWS, BASELINE_WINDOWS as RQ_BASELINE_WINDOWS, COMPARISONS as RQ_COMPARISONS, DIRECTIONS as RQ_DIRECTIONS, MAX_TEXT as RQ_MAX_TEXT, MAX_NAME as RQ_MAX_NAME, MAX_DIM_VALUES_PER_KEY as RQ_MAX_DIM_VALUES, COUNTRIES as RQ_COUNTRIES, THEATERS as RQ_THEATERS } from './lib/requirements/compile.mjs';
import { RequirementsStore } from './lib/requirements/evaluate.mjs';
import { SEVERITIES as RQ_SEVERITIES } from './lib/situation.mjs';
import { ValidationError as RqValidationError } from './lib/validate.mjs';
import { loadGazetteer as rqGazetteer } from './lib/narco/gazetteer.mjs';

const rqHistory = new HistoryStore(RUNS_DIR);
try {
  const bf = rqHistory.backfill();
  if (bf.runs) console.log(`[Requirements] History backfilled from ${bf.files} cold archive file(s): ${bf.runs} runs, ${bf.samples} samples`);
} catch (err) {
  console.error('[Requirements] History backfill failed (non-fatal):', err.message);
}
const rqStore = new RequirementsStore(RUNS_DIR);
if (rqStore.seeded) console.log(`[Requirements] Seeded ${rqStore.rules.length} default standing requirements`);

const rqAudit = (event, req, extra = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ip: req.ip, ...extra }));
const rqDimValues = (metric, dim) => rqHistory.dimValues(metric, dim);

// Called once per sweep right after buildSituation(): append this sweep's metric samples to the
// history store, evaluate every enabled requirement, and merge fired headlines into the strip.
async function requirementsAfterSweep(synthesized, { record = true } = {}) {
  try {
    if (record) rqHistory.record(synthesized);
    const r = rqStore.evaluateAll({ history: rqHistory, sweep: synthesized, computeBaseline });
    synthesized.requirements = { firedCount: r.firedCount, evaluated: r.results.length, asOf: new Date().toISOString() };
    for (const f of r.newFirings) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'requirement_fired', ruleId: f.ruleId, severity: f.severity, observed: f.observed, baselineMean: f.baselineMean, z: f.z }));
    }
  } catch (err) {
    console.error('[Requirements] Post-sweep evaluation failed (non-fatal):', err.message);
  }
}

// dims: {state?, country?, theater?} — each a bounded string or a short array of them. Membership in
// the gazetteer / allow-lists is checked by validateRule() inside the store.
const RQ_DIM_VALUE = (v) => str(v, { max: 60, min: 2, required: true });
function rqDims(v) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new RqValidationError(undefined, 'type');
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!RQ_DIM_KEYS.includes(k)) throw new RqValidationError(undefined, 'enum');
    if (val === undefined || val === null || val === '') continue;
    out[k] = Array.isArray(val) ? strArray(val, { min: 1, max: RQ_MAX_DIM_VALUES, itemMax: 60, itemMin: 2, required: true }) : RQ_DIM_VALUE(val);
  }
  return out;
}
// "state:Tamaulipas,country:Ukraine" query form → dims object
const RQ_DIMS_QUERY_RE = /^[a-z]+:[^,:]{2,60}(,[a-z]+:[^,:]{2,60}){0,2}$/u;
function rqParseDimsQuery(s) {
  const out = {};
  for (const part of String(s || '').split(',').filter(Boolean)) {
    const [k, ...rest] = part.split(':');
    if (!RQ_DIM_KEYS.includes(k)) return null;
    out[k] = rest.join(':').trim();
  }
  return out;
}

// GET /api/requirements — rules with the latest evaluation for each
app.get('/api/requirements', (req, res) => {
  try {
    res.json({ ...rqStore.snapshot(), llm: !!llmProvider?.isConfigured, asOf: currentData?.requirements?.asOf || null, sweepAt: lastSweepTime, history: rqHistory.stats() });
  } catch (err) {
    console.error('[Requirements] list failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// GET /api/requirements/metrics — catalog derived from lib/requirements/metrics.mjs (never hand-copied)
app.get('/api/requirements/metrics', (req, res) => {
  try {
    const gz = rqGazetteer();
    res.json({
      metrics: rqCatalog().map(m => ({ ...m, dimValues: Object.fromEntries(m.dims.map(d => [d, rqHistory.dimValues(m.key, d)])) })),
      dims: RQ_DIM_KEYS, windows: RQ_OBS_WINDOWS, baselines: RQ_BASELINE_WINDOWS, comparisons: RQ_COMPARISONS, directions: RQ_DIRECTIONS, severities: RQ_SEVERITIES,
      states: gz.states.map(s => s.shortName), countries: RQ_COUNTRIES, theaters: RQ_THEATERS,
      llm: !!llmProvider?.isConfigured,
    });
  } catch (err) {
    console.error('[Requirements] metrics failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// POST /api/requirements — compile natural language into a rule for confirmation (nothing is stored)
app.post('/api/requirements', validateBody({
  text: (v) => str(v, { max: RQ_MAX_TEXT, min: 3, required: true }),
  name: (v) => str(v, { max: RQ_MAX_NAME }),
  severity: (v) => oneOf(v, RQ_SEVERITIES),
}), async (req, res) => {
  const { text, name, severity } = req.validated.body;
  try {
    const r = await compileRequirement(text, { provider: llmProvider, name, severity, dimValues: rqDimValues });
    rqAudit('requirement_compiled', req, { ok: r.ok, compiledBy: r.compiledBy, fallbackReason: r.fallbackReason, metric: r.rule?.metric || null });
    res.json({ ok: r.ok, rule: r.rule, compiledBy: r.compiledBy, fallbackReason: r.fallbackReason, errors: r.errors.map(e => ({ field: e.field, reason: e.reason })) });
  } catch (err) {
    console.error('[Requirements] compile failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// POST /api/requirements/save — store a (possibly analyst-edited) compiled rule after strict validation
app.post('/api/requirements/save', validateBody({
  text: (v) => str(v, { max: RQ_MAX_TEXT, min: 3, required: true }),
  name: (v) => str(v, { max: RQ_MAX_NAME, required: true }),
  metric: (v) => oneOf(v, RQ_METRIC_KEYS, { required: true }),
  dims: rqDims,
  window: (v) => oneOf(v, RQ_OBS_WINDOWS, { required: true }),
  baseline: (v) => oneOf(v, RQ_BASELINE_WINDOWS, { required: true }),
  comparison: (v) => oneOf(v, RQ_COMPARISONS, { required: true }),
  threshold: (v) => num(v, { min: 0, max: 10_000_000, required: true }),
  direction: (v) => oneOf(v, RQ_DIRECTIONS, { required: true }),
  severity: (v) => oneOf(v, RQ_SEVERITIES, { required: true }),
  owner: (v) => str(v, { max: 60 }),
  compiledBy: (v) => oneOf(v, ['llm', 'rules']),
}), (req, res) => {
  try {
    const r = rqStore.add(req.validated.body);
    if (!r.ok) {
      rqAudit('validation_failure', req, { method: req.method, path: req.path, source: 'body', field: r.errors[0]?.field, reason: r.errors[0]?.reason });
      return res.status(400).json({ error: 'invalid request', field: r.errors[0]?.field, errors: r.errors });
    }
    rqAudit('requirement_created', req, { ruleId: r.rule.id, metric: r.rule.metric, window: r.rule.window, baseline: r.rule.baseline, compiledBy: r.rule.compiledBy });
    if (currentData) requirementsAfterSweep(currentData, { record: false }).then(() => broadcast({ type: 'update', data: currentData }));
    res.status(201).json({ ok: true, rule: r.rule });
  } catch (err) {
    console.error('[Requirements] save failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});

const RQ_ID = (v) => str(v, { max: 24, pattern: RQ_ID_RE, required: true });
for (const action of ['enable', 'disable']) {
  app.post(`/api/requirements/:id/${action}`, validateParams({ id: RQ_ID }), (req, res) => {
    try {
      const rule = rqStore.setEnabled(req.validated.params.id, action === 'enable');
      if (!rule) return res.status(404).json({ error: 'not found' });
      rqAudit(`requirement_${action}d`, req, { ruleId: rule.id });
      if (currentData) requirementsAfterSweep(currentData, { record: false }).then(() => broadcast({ type: 'update', data: currentData }));
      res.json({ ok: true, rule });
    } catch (err) {
      console.error(`[Requirements] ${action} failed:`, err.message);
      res.status(500).json({ error: 'An error occurred' });
    }
  });
}

app.delete('/api/requirements/:id', validateParams({ id: RQ_ID }), (req, res) => {
  try {
    if (!rqStore.remove(req.validated.params.id)) return res.status(404).json({ error: 'not found' });
    rqAudit('requirement_deleted', req, { ruleId: req.validated.params.id });
    if (currentData) requirementsAfterSweep(currentData, { record: false }).then(() => broadcast({ type: 'update', data: currentData }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[Requirements] delete failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// GET /api/requirements/:id/findings?limit= — historical firings (newest first) plus the latest evaluation
app.get('/api/requirements/:id/findings', validateParams({ id: RQ_ID }), validateQuery({ limit: (v) => bounded(v, 500) }), (req, res) => {
  try {
    const rule = rqStore.get(req.validated.params.id);
    if (!rule) return res.status(404).json({ error: 'not found' });
    res.json({ rule, latest: rqStore.latestFor(rule.id), findings: rqStore.findingsFor(rule.id, req.validated.query.limit ?? 20) });
  } catch (err) {
    console.error('[Requirements] findings failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// GET /api/history/series?metric=&dims=state:Tamaulipas&window=30d — raw samples + baseline for one slice
app.get('/api/history/series', validateQuery({
  metric: (v) => oneOf(v, RQ_METRIC_KEYS, { required: true }),
  dims: (v) => str(v, { max: 200, pattern: RQ_DIMS_QUERY_RE }),
  window: (v) => oneOf(v, RQ_WINDOWS),
}), (req, res) => {
  try {
    const { metric, window = '30d' } = req.validated.query;
    const dims = rqParseDimsQuery(req.validated.query.dims);
    if (!dims) return res.status(400).json({ error: 'invalid request', field: 'dims' });
    const baseline = rqHistory.baseline(metric, dims, { window });
    const samples = rqHistory.window(metric, dims, RQ_WINDOW_HOURS[window] || 720);
    res.json({ metric, dims, window, count: samples.length, samples: samples.slice(-2000).map(s => ({ ts: s.ts, value: s.value })), baseline });
  } catch (err) {
    console.error('[Requirements] series failed:', err.message);
    res.status(500).json({ error: 'An error occurred' });
  }
});
// === end standing requirements ===

// === CYBERFIX: KEV × inventory exposure → Devin remediation (lib/cyberfix/) ===================================
// Runs after every completed sweep (each sweep refreshes the KEV source), attaches the summary to
// currentData.cyberfix, rebuilds the Situation strip and pushes the update to connected browsers. All
// mutating routes are audit-logged; clients never see raw upload bytes or upstream (OSV / Devin) bodies.
const cyberfix = createCyberfix();
let cyberfixSweepSeen = null;
let cyberfixMutations = new Map();
function cyberfixRateLimited(ip) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const hits = (cyberfixMutations.get(key) || []).filter(t => now - t < 60000);
  hits.push(now);
  cyberfixMutations.set(key, hits);
  if (cyberfixMutations.size > 500) cyberfixMutations = new Map([...cyberfixMutations].filter(([, v]) => v.some(t => now - t < 60000)));
  return hits.length > 20;
}
function cyberfixAttach() {
  if (!currentData) return;
  currentData.cyberfix = cyberfix.summary();
  try { currentData.situation = buildSituation(currentData); } catch (err) { console.error('[Cyberfix] situation rebuild failed:', err?.message || err); }
  broadcast({ type: 'update', data: currentData });
}
async function cyberfixRun(trigger) {
  try {
    await cyberfix.run({ trigger, kevFallback: currentData?.cyberKev?.vulnerabilities || [] });
  } catch (err) {
    console.error('[Cyberfix] run failed:', err?.message || err);
  }
  cyberfixAttach();
}
setInterval(() => {
  if (!currentData || sweepInProgress || !lastSweepTime || lastSweepTime === cyberfixSweepSeen) return;
  cyberfixSweepSeen = lastSweepTime;
  cyberfixRun('sweep');
}, 15000).unref();
cyberfix.resumePolling();
const CYBERFIX_ID = (v) => str(v, { max: 24, required: true, pattern: /^inv_[a-f0-9]{16}$/ });
const CYBERFIX_SESSION = (v) => str(v, { max: 128, required: true, pattern: /^[A-Za-z0-9_-]{4,128}$/ });
const CYBERFIX_EXPOSURE = (v) => str(v, { max: 40, required: true, pattern: /^exp_[a-f0-9]{24}$/ });

app.get('/api/cyberfix', (req, res) => {
  res.json(cyberfix.summary());
});

app.post('/api/cyberfix/inventory',
  validateQuery({
    kind: (v) => oneOf(v, CYBERFIX_KINDS, { required: true }),
    name: (v) => str(v, { max: 80, required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/ }),
  }),
  express.raw({ type: () => true, limit: CYBERFIX_MAX_BYTES }),
  async (req, res) => {
    if (cyberfixRateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests; wait a minute' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 2 || req.body.length > CYBERFIX_MAX_BYTES) return res.status(400).json({ error: 'Invalid request' });
    const { kind, name } = req.validated.query;
    try {
      const inv = cyberfix.addInventory({ kind, name, bytes: req.body });
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_inventory_upload', ip: req.ip, id: inv.id, kind, bytes: req.body.length, components: inv.componentCount }));
      cyberfixRun('upload').catch(() => {});
      res.status(201).json({ ok: true, inventory: inv });
    } catch (err) {
      if (err instanceof CyberfixInventoryError) {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_inventory_rejected', ip: req.ip, kind, bytes: req.body.length, reason: err.reason }));
        return res.status(400).json({ error: 'Invalid inventory' });
      }
      console.error('[Cyberfix] inventory upload error:', err?.stack || err?.message || err);
      res.status(500).json({ error: 'An error occurred' });
    }
  });

app.delete('/api/cyberfix/inventory/:id', validateParams({ id: CYBERFIX_ID }), (req, res) => {
  if (cyberfixRateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests; wait a minute' });
  const { id } = req.validated.params;
  try {
    const removed = cyberfix.removeInventory(id);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_inventory_delete', ip: req.ip, id, removed }));
    if (!removed) return res.status(404).json({ error: 'Not found' });
    cyberfixRun('delete').catch(() => {});
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[Cyberfix] inventory delete error:', err?.stack || err?.message || err);
    res.status(500).json({ error: 'An error occurred' });
  }
});

app.post('/api/cyberfix/rescan', async (req, res) => {
  if (cyberfixRateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests; wait a minute' });
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_rescan', ip: req.ip }));
  try {
    await cyberfixRun('rescan');
    res.json(cyberfix.summary());
  } catch (err) {
    console.error('[Cyberfix] rescan error:', err?.stack || err?.message || err);
    res.status(500).json({ error: 'An error occurred' });
  }
});

app.post('/api/cyberfix/remediate', validateBody({ exposureKey: CYBERFIX_EXPOSURE }), async (req, res) => {
  if (cyberfixRateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests; wait a minute' });
  const { exposureKey } = req.validated.body;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_remediate_request', ip: req.ip, exposureKey }));
  try {
    const result = await cyberfix.remediate(exposureKey, { ip: req.ip });
    if (!result) return res.status(404).json({ error: 'Not found' });
    cyberfixAttach();
    res.status(result.created ? 201 : 200).json({ ok: true, created: result.created, remediation: result.remediation });
  } catch (err) {
    if (err instanceof CyberfixDevinError && err.status === 0) return res.status(409).json({ error: err.message });
    console.error('[Cyberfix] remediate error:', err?.stack || err?.message || err);
    res.status(502).json({ error: 'An error occurred' });
  }
});

app.post('/api/cyberfix/remediations/:id/refresh', validateParams({ id: CYBERFIX_SESSION }), async (req, res) => {
  if (cyberfixRateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests; wait a minute' });
  const { id } = req.validated.params;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'cyberfix_remediation_refresh', ip: req.ip, sessionId: id }));
  try {
    const rec = await cyberfix.refreshRemediation(id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    cyberfixAttach();
    res.json({ ok: true, remediation: rec });
  } catch (err) {
    console.error('[Cyberfix] refresh error:', err?.stack || err?.message || err);
    res.status(500).json({ error: 'An error occurred' });
  }
});
// === END CYBERFIX ===========================================================================================

// API: health check. Always HTTP 200 (Fly health checks kill the machine on 503). The endpoint is
// public, so unauthenticated callers only get the minimal body; configuration detail requires a session.
app.get('/api/health', (req, res) => {
  const minimal = {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesQueried: currentData?.meta?.sourcesQueried || 0,
  };
  if (authGateEnabled && req.authenticated !== true) return res.json(minimal);
  res.json({
    ...minimal,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    sourceHealth: currentData?.meta?.health || null,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    marketRefreshSeconds: MARKET_REFRESH_SECONDS,
    language: currentLanguage,
    ingest: {
      status: currentData?.borderIngest?.status || 'unknown',
      sourcesEnabled: currentData?.borderIngest?.sources?.enabled || 0,
      sourcesDegraded: currentData?.borderIngest?.sources?.degraded?.length || 0,
      lastSweepAt: currentData?.borderIngest?.lastSweepAt || null,
    },
  });
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// SSE: live updates
let sseHeartbeat = null;
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
  res.write(`data: {"type":"connected","heartbeatMs":${SSE_HEARTBEAT_MS}}\n\n`);
  sseClients.add(res);
  if (!sseHeartbeat) sseHeartbeat = setInterval(() => broadcast({ type: 'heartbeat' }), SSE_HEARTBEAT_MS).unref();
  const drop = () => dropSseClient(res);
  req.on('close', drop);
  res.on('error', drop);
});

function dropSseClient(res) {
  sseClients.delete(res);
  if (sseClients.size === 0 && sseHeartbeat) { clearInterval(sseHeartbeat); sseHeartbeat = null; }
}

function broadcast(data) {
  const frame = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (client.destroyed || client.writableEnded) { dropSseClient(client); continue; }
    try { client.write(frame); } catch { dropSseClient(client); }
  }
}

// Unknown /api/* → JSON 404 (never Express's HTML "Cannot GET").
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Final error handler: detail stays in the server log, the client gets a generic body.
// Body-parser errors (malformed JSON, oversize payload) carry a 4xx `status`.
app.use((err, req, res, _next) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), event: status === 500 ? 'unhandled_route_error' : 'request_rejected',
    ip: req.ip, method: req.method, path: req.path, status, error: err?.stack || err?.message || String(err),
  }));
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status === 500 ? 'internal error' : 'invalid request' });
});

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();
    if (rawData.sources?.Frontlines?.geo) frontGeo = rawData.sources.Frontlines.geo;
    if (rawData.sources?.Cartels?.geo) cartelGeo = rawData.sources.Cartels.geo;
    if (rawData.sources?.IranWarLive?.geo) iranGeo = rawData.sources.IranWarLive.geo;
    taiwanGeo = buildTaiwanGeo(rawData.sources || {});

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 3b. Phase 4: Compute analytical features post-sweep
    try {
      console.log('[Crucix] Computing Phase 4 analytical features...');

      // Step 1: Convergence detection (uses raw source data)
      const convergenceResult = computeConvergence(rawData.sources || {});
      synthesized.convergence = convergenceResult;

      // Step 2: CII (uses raw source data, no focal points yet)
      const ciiResult = computeCII(rawData.sources || {}, null);
      synthesized.cii = ciiResult;

      // Step 3: Focal points (uses raw sources + convergence + CII)
      const focalResult = computeFocalPoints(rawData.sources || {}, convergenceResult, ciiResult);
      synthesized.focalPoints = focalResult;

      // Step 4: Re-compute CII with focal point boosts
      const criticalFocals = (focalResult.focalPoints || []).filter(f => f.urgency === 'Critical');
      if (criticalFocals.length > 0) {
        const ciiWithBoosts = computeCII(rawData.sources || {}, criticalFocals);
        synthesized.cii = ciiWithBoosts;
      }

      // CII is a stub at synthesize() time; refresh the Ukraine tab's UA / RU rows from the post-sweep scores.
      if (synthesized.ukraine?.cii) {
        const prior = synthesized.ukraine.cii.health || {};
        synthesized.ukraine.cii = trimCii({ CII: synthesized.cii }, [{ name: 'CII', state: prior.state, reason: prior.reason }]);
      }

      // Step 5: Signals (uses raw sources + convergence + CII)
      const signalsResult = computeSignals(rawData.sources || {}, convergenceResult, synthesized.cii);
      synthesized.signals = signalsResult;

      console.log(`[Crucix] Phase 4: CII ${ciiResult.totalCountries} countries | Convergence ${convergenceResult.totalZones} zones | Signals ${signalsResult.totalSignals} | Focal ${focalResult.totalFocalPoints}`);

      // Step 6: DEFCON Threat Meter (uses all components)
      try {
        const defconResult = computeDefcon(
          rawData.sources || {},
          {
            cii: synthesized.cii,
            convergence: synthesized.convergence,
            signals: synthesized.signals,
            polymarket: synthesized.polymarket,
          }
        );
        synthesized.defcon = defconResult;
        console.log(`[Crucix] Phase 5: DEFCON ${defconResult.level} (score ${defconResult.score})`);
      } catch (defconErr) {
        console.error('[Crucix] DEFCON computation failed (non-fatal):', defconErr.message);
        synthesized.defcon = { level: 5, score: 0, color: '#00ff41', label: 'NORMAL READINESS', pulse: false, components: {}, fallbackMode: true };
      }
    } catch (phase4Err) {
      console.error('[Crucix] Phase 4 analytics failed (non-fatal):', phase4Err.message);
      synthesized.cii = synthesized.cii || { totalCountries: 0, countries: [] };
      synthesized.convergence = synthesized.convergence || { totalZones: 0, zones: [] };
      synthesized.signals = synthesized.signals || { totalSignals: 0, signals: [] };
      synthesized.focalPoints = synthesized.focalPoints || { totalFocalPoints: 0, focalPoints: [] };
      synthesized.defcon = synthesized.defcon || { level: 5, score: 0, color: '#00ff41', label: 'NORMAL READINESS', pulse: false, components: {}, fallbackMode: true };
    }

    // 3c. Homeland / Narco events: normalize, dedupe, grade and sanctions-match post-sweep (non-fatal)
    try {
      const narcoResult = await computeNarcoEvents({ llmProvider });
      narcoData = narcoResult;
      synthesized.narco = narcoView(narcoResult, rawData.sources || {});
      console.log(`[Crucix] Narco: ${narcoResult.totals.clusters} events (${narcoResult.totals.current} current) from ${narcoResult.records} records | ${narcoResult.totals.sanctionsMatches} sanctions matches | ${narcoResult.durationMs}ms`);
    } catch (narcoErr) {
      console.error('[Crucix] Narco event pipeline failed (non-fatal):', narcoErr.message);
      synthesized.narco = narcoView(narcoData, rawData.sources || {}, { error: 'event pipeline failed this sweep' });
    }

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;
    synthesized.seismic = seismicData;
    synthesized.situation = buildSituation(synthesized);
    await requirementsAfterSweep(synthesized);

    // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Crucix] Generating LLM trade ideas...');
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) {
          synthesized.ideas = llmIdeas;
          synthesized.ideasSource = 'llm';
          console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
        } else {
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
        }
      } catch (llmErr) {
        console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${sourceSummaryLine()}`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err?.stack || err?.message || err);
    broadcast({ type: 'error', message: 'sweep failed' });
  } finally {
    sweepInProgress = false;
  }
}

// === Fast Market Refresh (between sweeps) ===
async function runMarketRefresh() {
  // Skip if a full sweep is running (it will fetch fresh market data anyway)
  if (sweepInProgress || marketRefreshInProgress || !currentData) return;

  marketRefreshInProgress = true;
  try {
    const marketData = await yfinanceQuick();
    if (!marketData || marketData.summary.ok === 0) return;

    // Merge new prices into existing market data, preserving symbols that failed this refresh
    const prev = currentData.markets || {};

    function mergeCategory(newItems, prevItems, preserveHistory) {
      const merged = (newItems || []).map(q => {
        const old = (prevItems || []).find(p => p.symbol === q.symbol);
        const entry = { symbol: q.symbol, name: q.name, price: q.price, change: q.change, changePct: q.changePct };
        if (preserveHistory) entry.history = old?.history || [];
        return entry;
      });
      // Append any previously-good symbols that were absent from the new data
      const newSymbols = new Set(merged.map(m => m.symbol));
      for (const old of (prevItems || [])) {
        if (!newSymbols.has(old.symbol)) merged.push(old);
      }
      return merged;
    }

    const markets = {
      indexes: mergeCategory(marketData.indexes, prev.indexes, true),
      rates: mergeCategory(marketData.rates, prev.rates, false),
      commodities: mergeCategory(marketData.commodities, prev.commodities, true),
      crypto: mergeCategory(marketData.crypto, prev.crypto, false),
      vix: marketData.quotes['^VIX'] ? {
        value: marketData.quotes['^VIX'].price,
        change: marketData.quotes['^VIX'].change,
        changePct: marketData.quotes['^VIX'].changePct,
      } : prev.vix || null,
      timestamp: marketData.summary.timestamp,
    };

    currentData.markets = markets;

    // Push market-only update to all connected browsers
    broadcast({ type: 'market_update', markets, timestamp: marketData.summary.timestamp });
  } catch (err) {
    // Non-fatal — full sweep will catch up
    console.error('[Crucix] Market refresh failed (non-fatal):', err.message);
  } finally {
    marketRefreshInProgress = false;
  }
}

// === Startup ===
async function start() {
  const port = config.port;

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║           CRUCIX INTELLIGENCE ENGINE         ║
  ║       Local Palantir · Multi-Source OSINT    ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(4 - String(port).length)}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 24 : 23)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 23)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Crucix]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Crucix] Or change PORT in .env\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Start Telegram OSINT background scraper
    startTelegramLive();
    console.log('[Crucix] Telegram OSINT live scraper started');

    // Auto-open browser
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "http://localhost:${port}"`, (err) => {
      if (err) console.log('[Crucix] Could not auto-open browser:', err.message);
    });

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      if (existing.sources?.Frontlines?.geo) frontGeo = existing.sources.Frontlines.geo;
      if (existing.sources?.Cartels?.geo) cartelGeo = existing.sources.Cartels.geo;
      if (existing.sources?.IranWarLive?.geo) iranGeo = existing.sources.IranWarLive.geo;
      taiwanGeo = buildTaiwanGeo(existing.sources || {});
      const data = await synthesize(existing);
      data.narco = narcoView(narcoData, existing.sources || {});
      data.delta = memory.getLastDelta() || null;
      data.seismic = seismicData;
      data.situation = buildSituation(data);
      await requirementsAfterSweep(data, { record: false });
      currentData = data;
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Crucix] No existing data found — first sweep required');
    }

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);

    // Schedule fast market-only refresh (every 60s by default)
    console.log(`[Crucix] Market ticker refresh: every ${MARKET_REFRESH_SECONDS}s`);
    setInterval(runMarketRefresh, MARKET_REFRESH_SECONDS * 1000);

    // Seismic Event Monitor — refresh every 5 minutes, independent of the sweep. The result is
    // attached to the sweep payload (and the map-layer ranking re-run) so the dashboard sees it
    // on /api/data and SSE without waiting for the next full sweep.
    const refreshSeismic = async () => {
      try {
        seismicData = await collectSeismic();
        if (seismicData?.suspectCount > 0) {
          console.log(`[Seismic] ${seismicData.suspectCount} SUSPECT event(s) near nuclear test sites`);
        } else {
          console.log(`[Seismic] ${seismicData?.totalEvents || 0} events (max M${seismicData?.maxMagnitude ?? '--'})`);
        }
        if (currentData) {
          currentData.seismic = seismicData;
          currentData.situation = buildSituation(currentData);
          broadcast({ type: 'update', data: currentData });
        }
      } catch (err) {
        console.error('[Seismic] Refresh failed:', err.message);
      }
    };
    refreshSeismic();
    setInterval(refreshSeismic, 5 * 60 * 1000);

    // CJNG knowledge graph — incremental InSight Crime corpus refresh + graph rebuild, independent of the
    // sweep (a dozen polite API requests). First run is delayed so it does not compete with the initial sweep.
    const refreshCjng = async () => {
      if (cjngRefresh.inProgress) return;
      cjngRefresh = { ...cjngRefresh, inProgress: true, lastAttempt: new Date().toISOString() };
      try {
        const corpus = await refreshCjngCorpus({ delayMs: 2500, log: m => console.log(`[CJNG] ${m}`) });
        const graph = buildCjngGraph(corpus);
        saveCjngGraph(graph);
        cjngGraph = graph;
        cjngRefresh = { status: 'live', lastAttempt: cjngRefresh.lastAttempt, lastSuccess: graph.computedAt, error: corpus.stats?.errors?.length ? `partial: ${corpus.stats.errors.length} query error(s)` : null, inProgress: false };
        console.log(`[CJNG] graph: ${graph.totals.nodes} nodes · ${graph.totals.edges} edges from ${graph.totals.articles} articles (${corpus.stats?.added || 0} new, ${corpus.stats?.updated || 0} updated)`);
      } catch (err) {
        console.error('[CJNG] refresh failed (non-fatal):', err.message);
        cjngRefresh = { ...cjngRefresh, status: cjngGraph ? cjngRefresh.status : 'error', error: 'refresh failed', inProgress: false };
      }
      if (currentData?.narco) {
        currentData.narco.cjng = summarizeCjngGraph(cjngGraph, cjngRefresh);
        broadcast({ type: 'update', data: currentData });
      }
    };
    if (CJNG_REFRESH_ENABLED) {
      console.log(`[CJNG] graph refresh: every ${CJNG_REFRESH_HOURS}h (${cjngGraph ? `${cjngGraph.totals.nodes} nodes loaded${cjngGraph.snapshot ? ' from snapshot' : ''}` : 'no graph yet'})`);
      setTimeout(refreshCjng, 90 * 1000).unref();
      setInterval(refreshCjng, CJNG_REFRESH_HOURS * 3600 * 1000).unref();
    } else {
      console.log('[CJNG] graph refresh disabled (CJNG_GRAPH_REFRESH=false)');
    }
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

// Only listen + sweep when run directly (`node server.mjs`); importing the module (tests) just builds the app.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch(err => {
    console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
    process.exit(1);
  });
}

export { app };
