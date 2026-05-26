#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { collectQuick as yfinanceQuick } from './apis/sources/yfinance.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';

// Phase 4: Analytical Features
import { computeCII } from './apis/sources/cii.mjs';
import { computeConvergence } from './apis/sources/convergence.mjs';
import { computeSignals } from './apis/sources/signals.mjs';
import { computeFocalPoints } from './apis/sources/focalpoints.mjs';
import { generateWorldBrief, generateCountryBrief } from './apis/sources/summarizer.mjs';
import { classifyAll } from './apis/sources/threatclassifier.mjs';

// Phase 5: New Features
import { startTelegramLive, getTelegramFeed, getTelegramChannels, setTelegramChannels } from './apis/sources/telegramlive.mjs';
import { computeDefcon } from './apis/sources/defcon.mjs';

// Phase 6: Osiris-Ported Features
import { getRegionDossier } from './apis/sources/regiondossier.mjs';

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
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
let marketRefreshInProgress = false;
const startTime = Date.now();
const sseClients = new Set();
const MARKET_REFRESH_SECONDS = parseInt(process.env.MARKET_REFRESH_SECONDS) || 60;

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
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
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
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
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
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
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
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
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
app.use(express.json());
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');
    
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
app.post('/api/summarize', async (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  try {
    const allHeadlines = (currentData.newsFeed || []).map(n => ({
      title: n.headline || n.title || '', source: n.source || 'Unknown', timestamp: n.timestamp,
    }));
    const result = await generateWorldBrief(allHeadlines, currentData.cii, currentData.focalPoints, req.body || {});
    res.json(result);
  } catch (err) {
    console.error('[Crucix] Summarize error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Country brief
app.get('/api/country-brief/:code', async (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  try {
    const allHeadlines = (currentData.newsFeed || []).map(n => ({
      title: n.headline || n.title || '', source: n.source || 'Unknown', timestamp: n.timestamp,
    }));
    const result = await generateCountryBrief(
      req.params.code, allHeadlines, currentData.cii, currentData.focalPoints, currentData.signals, req.query || {},
    );
    res.json(result);
  } catch (err) {
    console.error('[Crucix] Country brief error:', err.message);
    res.status(500).json({ error: err.message });
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
app.post('/api/telegram/channels', (req, res) => {
  const { channels } = req.body || {};
  const result = setTelegramChannels(channels);
  if (result.error) return res.status(400).json(result);
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

// API: Ukraine Frontlines
app.get('/api/frontlines', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData.frontlines || { status: 'unavailable', geojson: null });
});

// API: Region Dossier (on-demand, not from sweep)
app.get('/api/region-dossier', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Missing lat/lng query parameters' });
  }
  try {
    const dossier = await getRegionDossier(lat, lng);
    res.json(dossier);
  } catch (err) {
    console.error('[Crucix] Region dossier error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    marketRefreshSeconds: MARKET_REFRESH_SECONDS,
    language: currentLanguage,
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
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

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

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

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

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
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
  ║          Local Palantir · 51 Sources         ║
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
      const data = await synthesize(existing);
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
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});
