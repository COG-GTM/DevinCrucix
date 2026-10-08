// Ukraine War Unmanned Systems Tracker (unmannedsystemstracker.com, robots: Allow /) — Europe profile only.
// The site embeds its USV strike log (EMBEDDED_USV) and headline killboard cards (EMBEDDED_KB) as JS
// object literals in the page; fields are extracted with regexes (third-party JS is never executed).
import { getProfile } from '../../lib/profile.mjs';
import { matchRegion } from './rusnavy.mjs';

export const SITE_URL = 'https://unmannedsystemstracker.com/#usv';
const UA = { 'User-Agent': 'CRUCIX-OSINT/1.0 (+private dashboard; 1 request per sweep)' };

function fields(obj) {
  const o = {};
  for (const m of obj.matchAll(/(\w+):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) o[m[1]] = (m[2] ?? m[3] ?? '').replace(/\\(['"\\])/g, '$1');
  return o;
}
function block(html, name) {
  const i = html.indexOf(`const ${name}=[`); if (i < 0) return [];
  const j = html.indexOf('\n];', i); return [...html.slice(i, j < 0 ? undefined : j).matchAll(/\{[^{}]*\}/g)].map(m => fields(m[0]));
}

export function parseUnmanned(html) {
  const usv = block(html, 'EMBEDDED_USV').filter(e => e.date).map(e => {
    const r = matchRegion(`${e.loc || ''} ${e.target || ''}`);
    return { date: e.date, target: e.target || '', type: e.type || '', model: e.model || '', loc: e.loc || '', damage: e.damage || '',
      notes: String(e.notes || '').slice(0, 240), url: e.src || '', ...(r ? { lat: r.lat, lng: r.lng } : {}) };
  }).sort((a, b) => b.date.localeCompare(a.date));
  const cards = block(html, 'EMBEDDED_KB').filter(k => k.section === 'card' && k.label).map(k => ({ label: k.label, value: k.value || '', sub: k.sub || '' })).slice(0, 6);
  return { usv, cards };
}

export async function briefing() {
  if (getProfile()?.id !== 'europe') return { status: 'skipped' };
  const r = await fetch('https://unmannedsystemstracker.com/', { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return { status: 'failed', error: `HTTP ${r.status}` };
  const { usv, cards } = parseUnmanned(await r.text());
  if (!usv.length) return { status: 'failed', error: 'USV table not found (page layout changed?)' };
  return { source: 'Unmanned Systems Tracker', timestamp: new Date().toISOString(), siteUrl: SITE_URL, totalUsv: usv.length, usv, cards,
    signals: usv.slice(0, 5).map(e => `${e.date} ${e.model} → ${e.target} (${e.loc}): ${e.damage}`) };
}

if (process.argv[1]?.endsWith('unmanned.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
