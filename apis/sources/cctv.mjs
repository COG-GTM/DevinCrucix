// CCTV Mesh — Public Traffic Camera Aggregator
// Ingests live public traffic camera feeds from four government APIs:
// 1. Transport for London JamCams (no key needed)
// 2. NYC DOT (no key needed)
// 3. Austin TxDOT (no key needed)
// 4. Singapore LTA (free API key required)
// Camera metadata stored in SQLite DB, refreshed every 5 minutes.
// Adapted from Shadowbroker cctv_pipeline.py for CRUCIX architecture.

import { safeFetch } from '../utils/fetch.mjs';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..', '..', 'runs');
const DB_PATH = join(DB_DIR, 'cctv.db');

// We use better-sqlite3 if available, otherwise fall back to in-memory store
let db = null;
let useInMemory = false;
let inMemoryStore = [];

function initDb() {
  if (db) return;
  try {
    // Try to use better-sqlite3 (synchronous SQLite for Node.js)
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cameras (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        name TEXT,
        direction TEXT,
        feed_url TEXT,
        feed_type TEXT DEFAULT 'image',
        last_updated TEXT DEFAULT (datetime('now'))
      )
    `);
    console.log('[CCTV] SQLite database initialized at', DB_PATH);
  } catch {
    console.log('[CCTV] better-sqlite3 not available, using in-memory store');
    useInMemory = true;
  }
}

function upsertCamera(cam) {
  if (useInMemory) {
    const idx = inMemoryStore.findIndex(c => c.id === cam.id);
    if (idx >= 0) {
      inMemoryStore[idx] = { ...cam, last_updated: new Date().toISOString() };
    } else {
      inMemoryStore.push({ ...cam, last_updated: new Date().toISOString() });
    }
    return;
  }
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cameras (id, source, lat, lon, name, direction, feed_url, feed_type, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(cam.id, cam.source, cam.lat, cam.lon, cam.name || null,
             cam.direction || null, cam.feed_url || null, cam.feed_type || 'image');
  } catch (e) {
    console.log('[CCTV] DB upsert error:', e.message);
  }
}

function getAllCameras() {
  if (useInMemory) return inMemoryStore;
  try {
    return db.prepare('SELECT * FROM cameras ORDER BY source, name').all();
  } catch (e) {
    console.log('[CCTV] DB read error:', e.message);
    return [];
  }
}

// --- Media type detection ---
function detectMediaType(url) {
  if (!url) return 'image';
  const lower = url.toLowerCase();
  if (['.mp4', '.webm', '.ogg'].some(ext => lower.includes(ext))) return 'video';
  if (['.mjpg', '.mjpeg', 'mjpg', 'axis-cgi/mjpg', 'mode=motion'].some(kw => lower.includes(kw))) return 'mjpeg';
  if (lower.includes('.m3u8') || lower.includes('hls')) return 'hls';
  if (['embed', 'maps/embed', 'iframe'].some(kw => lower.includes(kw))) return 'embed';
  return 'image';
}

// --- Source 1: Transport for London JamCams ---
async function ingestTflJamcams() {
  const cameras = [];
  try {
    const url = 'https://api.tfl.gov.uk/Place/Type/JamCam';
    const data = await safeFetch(url, { timeout: 12000, retries: 1 });
    if (!data || data.error || !Array.isArray(data)) {
      console.log('[CCTV:TfL] No data or error:', data?.error || 'empty response');
      return cameras;
    }
    for (const cam of data) {
      const lat = cam.lat;
      const lon = cam.lon;
      if (!lat || !lon) continue;
      // TfL provides image URLs in additionalProperties
      let feedUrl = '';
      if (Array.isArray(cam.additionalProperties)) {
        const imgProp = cam.additionalProperties.find(p => p.key === 'imageUrl');
        if (imgProp) feedUrl = imgProp.value;
      }
      if (!feedUrl && cam.id) {
        feedUrl = `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${cam.id}.jpg`;
      }
      cameras.push({
        id: `tfl_${cam.id || cam.commonName}`,
        source: 'TfL London',
        lat, lon,
        name: cam.commonName || cam.id || 'London JamCam',
        direction: null,
        feed_url: feedUrl,
        feed_type: detectMediaType(feedUrl),
      });
    }
    console.log(`[CCTV:TfL] ${cameras.length} cameras ingested`);
  } catch (e) {
    console.log('[CCTV:TfL] Ingest failed:', e.message);
  }
  return cameras;
}

// --- Source 2: NYC DOT Traffic Cameras ---
async function ingestNycDot() {
  const cameras = [];
  try {
    const url = 'https://webcams.nyctmc.org/api/cameras/';
    const data = await safeFetch(url, { timeout: 12000, retries: 1 });
    if (!data || data.error) {
      console.log('[CCTV:NYC] No data or error:', data?.error || 'empty response');
      return cameras;
    }
    const cams = Array.isArray(data) ? data : (data.cameras || []);
    for (const cam of cams) {
      const lat = cam.latitude ?? cam.lat;
      const lon = cam.longitude ?? cam.lon ?? cam.lng;
      if (!lat || !lon) continue;
      const feedUrl = cam.imageUrl || cam.url || cam.streamUrl || '';
      cameras.push({
        id: `nyc_${cam.id || cam.cameraID || cam.name}`,
        source: 'NYC DOT',
        lat, lon,
        name: cam.name || cam.location || 'NYC Traffic Cam',
        direction: cam.direction || null,
        feed_url: feedUrl,
        feed_type: detectMediaType(feedUrl),
      });
    }
    console.log(`[CCTV:NYC] ${cameras.length} cameras ingested`);
  } catch (e) {
    console.log('[CCTV:NYC] Ingest failed:', e.message);
  }
  return cameras;
}

// --- Source 3: Austin TxDOT ---
async function ingestAustinTxdot() {
  const cameras = [];
  try {
    const url = 'https://its.txdot.gov/data/cctv_extended.json';
    const data = await safeFetch(url, { timeout: 12000, retries: 1 });
    if (!data || data.error) {
      // Try alternative endpoint
      const alt = await safeFetch('https://its.txdot.gov/data/cctv.json', { timeout: 12000, retries: 1 });
      if (!alt || alt.error) {
        console.log('[CCTV:TxDOT] No data from either endpoint');
        return cameras;
      }
      return processAustinData(alt);
    }
    return processAustinData(data);
  } catch (e) {
    console.log('[CCTV:TxDOT] Ingest failed:', e.message);
  }
  return cameras;
}

function processAustinData(data) {
  const cameras = [];
  const cams = Array.isArray(data) ? data : (data.cctv_extended_details || data.features || []);
  for (const cam of cams) {
    const props = cam.properties || cam;
    const lat = props.latitude ?? props.lat ?? (cam.geometry?.coordinates?.[1]);
    const lon = props.longitude ?? props.lon ?? props.lng ?? (cam.geometry?.coordinates?.[0]);
    if (!lat || !lon) continue;
    const feedUrl = props.url || props.imageUrl || props.streamUrl || '';
    cameras.push({
      id: `txdot_${props.id || props.cameraId || props.name || Math.random().toString(36).slice(2, 8)}`,
      source: 'TxDOT Austin',
      lat, lon,
      name: props.name || props.location || 'TxDOT Camera',
      direction: props.direction || null,
      feed_url: feedUrl,
      feed_type: detectMediaType(feedUrl),
    });
  }
  console.log(`[CCTV:TxDOT] ${cameras.length} cameras ingested`);
  return cameras;
}

// --- Source 4: Singapore LTA ---
async function ingestSingaporeLta() {
  const cameras = [];
  const apiKey = process.env.LTA_API_KEY || process.env.SINGAPORE_LTA_KEY || '';
  if (!apiKey) {
    console.log('[CCTV:SG] LTA_API_KEY not set, skipping Singapore cameras');
    return cameras;
  }
  try {
    const url = 'https://datamall2.mytransport.sg/ltaodataservice/Traffic/Camera';
    const data = await safeFetch(url, {
      timeout: 12000,
      retries: 1,
      headers: { AccountKey: apiKey, accept: 'application/json' },
    });
    if (!data || data.error) {
      console.log('[CCTV:SG] No data or error:', data?.error || 'empty response');
      return cameras;
    }
    const cams = data.value || data.Value || (Array.isArray(data) ? data : []);
    for (const cam of cams) {
      const lat = cam.Latitude ?? cam.latitude;
      const lon = cam.Longitude ?? cam.longitude;
      if (!lat || !lon) continue;
      const feedUrl = cam.ImageLink || cam.imageLink || '';
      cameras.push({
        id: `sg_${cam.CameraID || cam.cameraId || Math.random().toString(36).slice(2, 8)}`,
        source: 'Singapore LTA',
        lat, lon,
        name: `Singapore Cam ${cam.CameraID || ''}`.trim(),
        direction: null,
        feed_url: feedUrl,
        feed_type: detectMediaType(feedUrl),
      });
    }
    console.log(`[CCTV:SG] ${cameras.length} cameras ingested`);
  } catch (e) {
    console.log('[CCTV:SG] Ingest failed:', e.message);
  }
  return cameras;
}

// --- Main briefing function ---
export async function briefing() {
  console.log('[CCTV] Starting camera mesh ingest...');
  initDb();

  // Run all four ingestors in parallel with per-source timeouts
  const [tfl, nyc, txdot, sg] = await Promise.allSettled([
    ingestTflJamcams(),
    ingestNycDot(),
    ingestAustinTxdot(),
    ingestSingaporeLta(),
  ]);

  const sourceResults = {
    tfl: tfl.status === 'fulfilled' ? tfl.value : [],
    nyc: nyc.status === 'fulfilled' ? nyc.value : [],
    txdot: txdot.status === 'fulfilled' ? txdot.value : [],
    sg: sg.status === 'fulfilled' ? sg.value : [],
  };

  // Upsert all cameras to DB/store
  let totalIngested = 0;
  for (const [, cams] of Object.entries(sourceResults)) {
    for (const cam of cams) {
      upsertCamera(cam);
      totalIngested++;
    }
  }

  // Read all cameras back from store
  const allCameras = getAllCameras();

  const sourceCounts = {};
  for (const cam of allCameras) {
    sourceCounts[cam.source] = (sourceCounts[cam.source] || 0) + 1;
  }

  console.log(`[CCTV] ${allCameras.length} total cameras. By source: ${JSON.stringify(sourceCounts)}`);

  return {
    source: 'CCTV Mesh',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalCameras: allCameras.length,
    cameras: allCameras.map(c => ({
      id: c.id,
      source: c.source,
      lat: c.lat,
      lng: c.lon ?? c.lng,
      name: c.name || '',
      direction: c.direction || '',
      feedUrl: c.feed_url || '',
      feedType: c.feed_type || 'image',
      lastUpdated: c.last_updated || new Date().toISOString(),
    })),
    sourceCounts,
    sourceErrors: {
      tfl: tfl.status === 'rejected' ? tfl.reason?.message : null,
      nyc: nyc.status === 'rejected' ? nyc.reason?.message : null,
      txdot: txdot.status === 'rejected' ? txdot.reason?.message : null,
      sg: sg.status === 'rejected' ? sg.reason?.message : null,
    },
    signals: totalIngested > 0
      ? [`${totalIngested} traffic cameras ingested from ${Object.keys(sourceCounts).length} sources`]
      : ['No cameras available — all sources unreachable'],
  };
}

// Run standalone
if (process.argv[1]?.endsWith('cctv.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
