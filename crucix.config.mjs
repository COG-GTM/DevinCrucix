// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

export default {
  port: parseInt(process.env.PORT) || 3117,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,

  llm: {
    provider: process.env.LLM_PROVIDER || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama | grok
    apiKey: process.env.LLM_API_KEY || null,
    model: process.env.LLM_MODEL || null,
    baseUrl: process.env.OLLAMA_BASE_URL || null,
  },

  // Ask CRUCIX drawer (on-click only; uses the llm provider above).
  ask: {
    ratePerMin: Number(process.env.ASK_RATE_PER_MIN) || 10,          // per-IP questions per minute
    maxContextChars: Number(process.env.ASK_MAX_CONTEXT_CHARS) || 14000, // grounded context budget (~3.5k tokens)
    external: process.env.ASK_EXTERNAL !== 'false',                   // allow the explicit web-search fallback
  },

  // Commander's SITREP (SOUTHCOM AOR): twice-daily editions drafted by the LLM layer from the live
  // CRUCIX state, archived under runs/sitreps/. Edition times are wall-clock in `timezone`.
  sitrep: {
    schedule: process.env.SITREP_SCHEDULE !== 'false',                 // set false to disable the AM/PM scheduler (Generate now still works)
    timezone: process.env.SITREP_TZ || 'America/New_York',
    am: process.env.SITREP_AM || '06:00',
    pm: process.env.SITREP_PM || '16:00',
    maxContextChars: Number(process.env.SITREP_MAX_CONTEXT_CHARS) || 24000, // draft context budget (~6k tokens)
    dataDir: process.env.SITREP_DATA_DIR || null,                      // default runs/sitreps
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: parseInt(process.env.TELEGRAM_POLL_INTERVAL) || 5000,
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null, // Server ID (for instant slash command registration)
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  // Delta engine thresholds — override defaults from lib/delta/engine.mjs
  // Set to null to use built-in defaults
  delta: {
    thresholds: {
      numeric: {
        // Example overrides (uncomment to customize):
        // vix: 3,       // more sensitive to VIX moves
        // wti: 5,       // less sensitive to oil moves
      },
      count: {
        // urgent_posts: 3,     // need ±3 urgent posts to flag
        // thermal_total: 1000, // need ±1000 thermal detections
      },
    },
  },
};
