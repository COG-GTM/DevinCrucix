// FleetLeaks (fleetleaks.com) — Russia shadow-fleet / sanctioned-vessel intelligence feed (Europe profile only).
// Public WordPress REST endpoints: /wp/v2/posts (intelligence feed) and /fl/v1/vessel-changes
// (flag / name / owner changes). robots.txt asks for a 30 s crawl delay, so each sweep makes ONE
// request, alternating between the two endpoints, and serves the other half from runs/fleetleaks.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getProfile } from '../../lib/profile.mjs';
import { matchRegion } from './rusnavy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', '..', 'runs', 'fleetleaks.json');
const BASE = 'https://fleetleaks.com/wp-json';
export const FEED_URL = 'https://fleetleaks.com/#/intelligence-feed/';
const UA = { 'User-Agent': 'CRUCIX-OSINT/1.0 (+private dashboard; 1 request per sweep)', Accept: 'application/json' };
const RELEVANT = /\b(russia|russian|shadow fleet|sanction|baltic|black sea|kerch|novorossiysk|primorsk|ust-luga|murmansk|gulf of finland|danish straits|english channel|north sea|tanker|dark fleet)\b/i;
const CATS = { 719: 'Incidents', 14: 'Maritime Sanctions', 780: 'Vessel Tracking' };
const decode = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8220;|&#8221;/g, '"').replace(/&#038;|&amp;/g, '&').replace(/&#8211;|&#8212;/g, '–').trim();

export function shapePosts(posts) {
  return (Array.isArray(posts) ? posts : []).map(p => {
    const title = decode(p.title?.rendered); const r = matchRegion(title);
    return { title, url: String(p.link || ''), date: p.date || '', categories: (p.categories || []).map(c => CATS[c]).filter(Boolean),
      ...(r ? { region: r.region, lat: r.lat, lng: r.lng } : {}) };
  }).filter(p => p.title && RELEVANT.test(p.title)).slice(0, 25);
}
export function shapeChanges(body) {
  return (Array.isArray(body?.items) ? body.items : []).slice(0, 25).map(c => ({
    vessel: c.current_name || c.vessel_name || '', imo: c.imo || '', change: c.change_type || '', from: c.old_value || '', to: c.new_value || '',
    effective: c.effective_date || '', detected: c.detected_at || '', url: String(c.vessel_url || ''),
  }));
}

function load() { try { return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}; } catch { return {}; } }
function save(c) { try { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(c)); } catch {} }

async function getJson(path) {
  const r = await fetch(BASE + path, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function briefing() {
  if (getProfile()?.id !== 'europe') return { status: 'skipped' };
  const cache = load();
  const next = cache.next === 'changes' ? 'changes' : 'posts';
  let error = '';
  try {
    if (next === 'posts') { cache.items = shapePosts(await getJson('/wp/v2/posts?per_page=40&_fields=date,title,link,categories')); cache.itemsAt = new Date().toISOString(); }
    else { cache.vesselChanges = shapeChanges(await getJson('/fl/v1/vessel-changes')); cache.changesAt = new Date().toISOString(); }
  } catch (e) { error = e.message; }
  cache.next = next === 'posts' ? 'changes' : 'posts';
  save(cache);
  const items = cache.items || []; const vesselChanges = cache.vesselChanges || [];
  if (!items.length && !vesselChanges.length && error) return { status: 'failed', error };
  return {
    source: 'FleetLeaks', timestamp: new Date().toISOString(), feedUrl: FEED_URL, items, vesselChanges,
    itemsAt: cache.itemsAt || '', changesAt: cache.changesAt || '', ...(error ? { note: `last request failed (${error}); serving cache` } : {}),
    signals: items.slice(0, 5).map(i => i.title),
  };
}

if (process.argv[1]?.endsWith('fleetleaks.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
