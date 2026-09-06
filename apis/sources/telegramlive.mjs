// Telegram OSINT Channel Scraper — Background async polling
// Adapted from OSINT-War-Room backend/api/alerts.py (MIT licensed)
// Polls configured public Telegram channels every 30s via web preview
// No API key required — uses public web preview at https://t.me/s/{channelname}

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE = join(__dirname, '../../runs/telegram_live.json');

const DEFAULT_CHANNELS = process.env.TELEGRAM_OSINT_CHANNELS
  ? process.env.TELEGRAM_OSINT_CHANNELS.split(',').map(c => c.trim()).filter(Boolean)
  : ['ConflictsTracker', 'OSINTWarfare', 'monitor_the_situation', 'inaboringworld'];

// Telegram public channel usernames: 5–32 chars of [A-Za-z0-9_]. Enforced here (not only at the
// HTTP route) so no caller can push an arbitrary string into the t.me/s/{channel} URL.
export const TELEGRAM_CHANNEL_RE = /^[A-Za-z0-9_]{5,32}$/;
export const MAX_CHANNELS = 20;

const MIN_POLL_INTERVAL_MS = 15_000; // 15s min between polls per channel
const POLL_CYCLE_MS = 30_000;        // 30s between full poll cycles
const MAX_MESSAGES = 200;            // max stored messages

let _running = false;
let _channels = [...DEFAULT_CHANNELS];
let _messages = [];
let _seenHashes = new Set();
let _lastPollPerChannel = {};

// Simple content hash for deduplication
function hashText(text) {
  let hash = 0;
  const str = (text || '').substring(0, 200);
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

// Fetch raw HTML from Telegram web preview
async function fetchHTML(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeOutboundFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// Parse messages from Telegram web preview HTML
function parseWebPreview(html, channel) {
  if (!html) return [];

  const messages = [];
  const postRegex = /data-post="([^"]+)"([\s\S]*?)(?=data-post="|$)/gi;
  let match;

  while ((match = postRegex.exec(html)) !== null && messages.length < 20) {
    const postId = match[1];
    const block = match[2];

    // Extract message text
    const textMatch = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    let text = '';
    if (textMatch) {
      text = textMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#x0*27;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&nbsp;/g, ' ')
        .trim()
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    // Extract timestamp
    const timeMatch = block.match(/datetime="([^"]+)"/i);
    const timestamp = timeMatch ? timeMatch[1] : new Date().toISOString();

    // Extract message URL
    const urlMatch = block.match(/class="tgme_widget_message_date"[^>]*href="([^"]+)"/i);
    const msgUrl = urlMatch ? urlMatch[1] : `https://t.me/${channel}`;

    // Check for media
    const hasMedia = /tgme_widget_message_photo|tgme_widget_message_video/i.test(block);

    // Extract view count
    const viewsMatch = block.match(/class="tgme_widget_message_views"[^>]*>([\s\S]*?)<\/span>/i);
    let views = 0;
    if (viewsMatch) {
      const raw = viewsMatch[1].trim();
      if (raw.endsWith('K')) views = parseFloat(raw) * 1000;
      else if (raw.endsWith('M')) views = parseFloat(raw) * 1000000;
      else views = parseInt(raw, 10) || 0;
    }

    if (text || hasMedia) {
      messages.push({
        id: hashText(`${channel}:${postId}:${text}`),
        postId,
        url: msgUrl,
        source: 'telegram',
        channel,
        text: text.substring(0, 500),
        timestamp,
        hasMedia,
        views,
      });
    }
  }

  return messages;
}

// Scrape a single channel
async function scrapeChannel(channel) {
  // Rate limit per channel
  const lastPoll = _lastPollPerChannel[channel] || 0;
  if (Date.now() - lastPoll < MIN_POLL_INTERVAL_MS) {
    return [];
  }

  const url = `https://t.me/s/${channel}`;
  const html = await fetchHTML(url);
  _lastPollPerChannel[channel] = Date.now();

  if (!html) {
    console.log(`[TelegramLive] Failed to fetch ${channel}`);
    return [];
  }

  return parseWebPreview(html, channel);
}

// Load persisted state
function loadState() {
  try {
    if (existsSync(DB_FILE)) {
      const db = JSON.parse(readFileSync(DB_FILE, 'utf8'));
      _messages = db.messages || [];
      _channels = db.channels || [...DEFAULT_CHANNELS];
      _seenHashes = new Set(_messages.map(m => m.id));
    }
  } catch {
    // Start fresh
  }
}

// Save state to disk
function saveState() {
  try {
    writeFileSync(DB_FILE, JSON.stringify({
      channels: _channels,
      messages: _messages.slice(0, MAX_MESSAGES),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.log(`[TelegramLive] Save error: ${err.message}`);
  }
}

// Background polling loop
async function pollLoop() {
  while (_running) {
    for (const channel of _channels) {
      if (!_running) break;
      try {
        const newMessages = await scrapeChannel(channel);
        let added = 0;
        for (const msg of newMessages) {
          if (!_seenHashes.has(msg.id)) {
            _messages.unshift(msg);
            _seenHashes.add(msg.id);
            added++;
          }
        }
        // Trim to max
        if (_messages.length > MAX_MESSAGES) {
          const removed = _messages.splice(MAX_MESSAGES);
          for (const m of removed) _seenHashes.delete(m.id);
        }
        if (added > 0) {
          console.log(`[TelegramLive] ${channel}: +${added} new messages`);
          saveState();
        }
      } catch (err) {
        console.log(`[TelegramLive] Error scraping ${channel}: ${err.message}`);
      }
      // Small delay between channels to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    }

    // Wait for next cycle
    await new Promise(r => setTimeout(r, POLL_CYCLE_MS));
  }
}

// Start background scraper
export function startTelegramLive() {
  if (_running) return;
  _running = true;
  loadState();
  console.log(`[TelegramLive] Starting background scraper for ${_channels.length} channels`);
  pollLoop().catch(err => {
    console.error(`[TelegramLive] Poll loop crashed: ${err.message}`);
    _running = false;
  });
}

// Stop background scraper
export function stopTelegramLive() {
  _running = false;
}

// Sanitize URL to only allow http/https schemes
function sanitizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return url;
  } catch { /* invalid URL */ }
  return '';
}

// Get current feed
export function getTelegramFeed() {
  return {
    status: _running ? 'live' : 'stopped',
    channels: _channels,
    totalMessages: _messages.length,
    messages: _messages.slice(0, 50).map(m => ({ ...m, url: sanitizeUrl(m.url) })),
    updatedAt: new Date().toISOString(),
  };
}

// Get channel list
export function getTelegramChannels() {
  return { channels: _channels };
}

// Update channel list
export function setTelegramChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > MAX_CHANNELS) {
    return { error: `channels must be an array of 1–${MAX_CHANNELS} channel names` };
  }
  const cleaned = channels.map(c => (typeof c === 'string' ? c.trim() : ''));
  if (!cleaned.every(c => TELEGRAM_CHANNEL_RE.test(c))) {
    return { error: 'channels must be Telegram usernames (5–32 letters, digits or underscores)' };
  }
  _channels = cleaned;
  saveState();
  console.log(`[TelegramLive] Channels updated: ${_channels.join(', ')}`);
  return { status: 'ok', channels: _channels };
}

// Briefing function for sweep integration
export async function briefing() {
  return {
    source: 'TelegramLive',
    timestamp: new Date().toISOString(),
    status: _running ? 'live' : 'stopped',
    totalMessages: _messages.length,
    channels: _channels.length,
    recentMessages: _messages.slice(0, 15).map(m => ({
      channel: m.channel,
      text: (m.text || '').substring(0, 200),
      timestamp: m.timestamp,
      views: m.views,
      hasMedia: m.hasMedia,
      url: m.url,
    })),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('telegramlive.mjs')) {
  startTelegramLive();
  // Keep running for demo
  await new Promise(r => setTimeout(r, 60000));
  stopTelegramLive();
}
