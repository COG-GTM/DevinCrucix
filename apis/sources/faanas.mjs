// FAA National Airspace System status — airport ground stops, ground delay programs, arrival /
// departure delays and closures. Key-free XML: https://nasstatus.faa.gov/api/airport-status-information
// Airports are placed with config/geo/airports-major.json (large US/CA airports by IATA code).
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { safeFetch } from '../utils/fetch.mjs';

export const NAS_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const AIRPORTS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../config/geo/airports-major.json'), 'utf8'));

export const NAS_KINDS = {
  ground_stop: { label: 'Ground stop', color: '#ff1744', rank: 4 },
  closure: { label: 'Airport closure', color: '#d500f9', rank: 3 },
  ground_delay: { label: 'Ground delay program', color: '#ff9100', rank: 2 },
  restricted: { label: 'Restricted ops (GA / PPR only)', color: '#b0bec5', rank: 1.5 },
  delay: { label: 'Arrival / departure delay', color: '#ffea00', rank: 1 },
};
// Closure NOTAMs that only bar some operators ("AP CLSD TO NON SKED TRANSIENT GA ACFT EXC PPR") are not
// airport closures — commercial traffic continues. The phrase must name the barred class right after
// CLSD (TO); a bare EXC ("AP CLSD EXC EMERG ACFT") is still a full closure.
export const LIMITED_CLOSURE_RE = /\bCLSD\s+(?:TO\s+)?(?:ALL\s+)?(?:NON\s?SKED|TRANSIENT|GA)\b/i;

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1].trim() : ''; };
const all = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map(m => m[1]);
const attr = (xml, name, a) => xml.match(new RegExp(`<${name}[^>]*\\b${a}="([^"]*)"`, 'i'))?.[1] || '';
const unesc = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

// XML → [{ airport, kind, reason, avg, max, min, trend, start, end }]
export function parseNas(xml) {
  const s = String(xml || '');
  const events = [];
  for (const g of all(s, 'Ground_Stop')) events.push({ airport: tag(g, 'ARPT'), kind: 'ground_stop', reason: unesc(tag(g, 'Reason')), end: tag(g, 'End_Time') });
  for (const g of all(s, 'Ground_Delay')) events.push({ airport: tag(g, 'ARPT'), kind: 'ground_delay', reason: unesc(tag(g, 'Reason')), avg: tag(g, 'Avg'), max: tag(g, 'Max') });
  for (const g of all(s, 'Delay')) {
    const ad = g.match(/<Arrival_Departure[\s\S]*?<\/Arrival_Departure>/i)?.[0] || '';
    events.push({ airport: tag(g, 'ARPT'), kind: 'delay', reason: unesc(tag(g, 'Reason')), direction: attr(ad, 'Arrival_Departure', 'Type'), min: tag(ad, 'Min'), max: tag(ad, 'Max'), trend: tag(ad, 'Trend') });
  }
  for (const g of all(s, 'Airport')) {
    if (!/<ARPT>/i.test(g)) continue;
    const reason = unesc(tag(g, 'Reason')).slice(0, 240);
    events.push({ airport: tag(g, 'ARPT'), kind: LIMITED_CLOSURE_RE.test(reason) ? 'restricted' : 'closure', reason, start: tag(g, 'Start'), end: tag(g, 'Reopen') });
  }
  return { updateTime: tag(s, 'Update_Time'), events: events.filter(e => e.airport) };
}

// Events → one point per airport (worst event wins the colour), plus airports we could not place.
export function nasPoints(events = []) {
  const byAirport = new Map();
  for (const e of events) { const l = byAirport.get(e.airport) || []; l.push(e); byAirport.set(e.airport, l); }
  const points = [], unplaced = [];
  for (const [code, evs] of byAirport) {
    const a = AIRPORTS[code];
    evs.sort((x, y) => NAS_KINDS[y.kind].rank - NAS_KINDS[x.kind].rank);
    const worst = evs[0];
    const lines = evs.map(e => e.kind === 'ground_delay' ? `GDP avg ${e.avg} (max ${e.max}) — ${e.reason}`
      : e.kind === 'ground_stop' ? `GROUND STOP until ${e.end || '?'} — ${e.reason}`
      : e.kind === 'delay' ? `${e.direction || 'Delay'} ${e.min}–${e.max} ${e.trend ? `(${e.trend.toLowerCase()})` : ''} — ${e.reason}`
      : e.kind === 'restricted' ? `Restricted ops ${e.start || ''} → ${e.end || ''} — ${e.reason}`
      : `Closed ${e.start || ''} → ${e.end || ''} — ${e.reason}`);
    if (!a) { unplaced.push({ code, kind: worst.kind, summary: lines[0] }); continue; }
    points.push({
      lat: a.lat, lng: a.lng, size: 0.45 + 0.15 * NAS_KINDS[worst.kind].rank, alt: 0.015, color: NAS_KINDS[worst.kind].color,
      head: `${code} · ${NAS_KINDS[worst.kind].label}`, text: lines.join(' | '), meta: `${a.name} · ${a.city} · FAA NAS status`,
      kind: 'nas', airport: code, severity: worst.kind,
    });
  }
  return { points, unplaced };
}

export async function fetchNas({ fetchImpl = safeFetch } = {}) {
  const r = await fetchImpl(NAS_URL, { timeout: 15000, headers: { Accept: 'application/xml' } });
  if (r?.error) throw new Error(`NAS status: ${r.error}`);
  const xml = typeof r === 'string' ? r : r.rawText || '';
  const parsed = parseNas(xml);
  return { ...parsed, ...nasPoints(parsed.events) };
}
