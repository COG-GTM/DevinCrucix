// Country Home Page registry: one JSON per country under config/countries/ plus the checked-in
// ADM1 polygons under config/geo/. Everything a country page needs (feeds, places, groups, source
// policy, link-outs, viewport) is declared there so adding a country is a config change.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNTRY_DIR = join(__dirname, '../config/countries');
const GEO_DIR = join(__dirname, '../config/geo');

const configs = new Map();
for (const f of readdirSync(COUNTRY_DIR).filter(n => n.endsWith('.json')).sort()) {
  const cfg = JSON.parse(readFileSync(join(COUNTRY_DIR, f), 'utf8'));
  if (!/^[a-z]{2}$/.test(cfg.id || '')) throw new Error(`country config ${f}: id must be a two-letter code`);
  configs.set(cfg.id, Object.freeze(cfg));
}

export const COUNTRY_IDS = Object.freeze([...configs.keys()]);

export function isCountryId(cc) {
  return typeof cc === 'string' && configs.has(cc);
}

export function countryConfig(cc) {
  const cfg = configs.get(cc);
  if (!cfg) throw new Error(`unknown country id: ${String(cc).slice(0, 8)}`);
  return cfg;
}

const geoCache = new Map();
export function countryAdm1(cc) {
  const cfg = countryConfig(cc);
  if (!cfg.geo?.file) return null;
  if (!geoCache.has(cc)) {
    try {
      geoCache.set(cc, JSON.parse(readFileSync(join(GEO_DIR, cfg.geo.file), 'utf8')));
    } catch (err) {
      console.log(`[country] ${cc}: ADM1 geometry unavailable: ${err.message}`);
      geoCache.set(cc, null);
    }
  }
  return geoCache.get(cc);
}

// Accent-insensitive lower-case normalisation used for place / group matching.
export function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Builds a matcher over config aliases: returns the list of place / group entries mentioned in text.
export function aliasMatcher(entries, { minLen = 4 } = {}) {
  const compiled = (entries || []).map(e => {
    const aliases = Array.isArray(e.aliases) ? e.aliases : [e.name || e];
    const alts = aliases.map(a => fold(a).trim()).filter(a => a.length >= Math.min(minLen, 3)).map(escapeRe);
    return alts.length ? { entry: e, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'u') } : null;
  }).filter(Boolean);
  return (text) => {
    const t = fold(text);
    const hits = [];
    for (const c of compiled) if (c.re.test(t)) hits.push(c.entry);
    return hits;
  };
}
