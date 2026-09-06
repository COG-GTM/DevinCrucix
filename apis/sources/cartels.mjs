// Mexican cartel areas of influence from the community-maintained Google My Maps project
// "Active Cartels In Mexico 2026" (@MexicoCartelMap), exported as KML.
//
// This is crowd-sourced OSINT by a single maintainer. The map's own disclaimer says it is
// "definitely not 100% accurate"; CRUCIX treats it as an observational layer, never as
// verified ground truth, and keeps the disclaimer attached to every payload.
//
// Descriptions/names are third-party text (and may contain HTML). They are stripped to plain
// text here; the dashboard must still HTML-escape them before insertion.

import { safeFetch } from '../utils/fetch.mjs';
import { decodeEntities, stripTags } from '../utils/rss.mjs';
import { simplifyRing, polygonAreaKm2 } from './frontlines.mjs';

export const CARTEL_MAP_ID = '1fssgCzO1J6TnXS2SqlbutbaxbPQFo3I';
export const CARTEL_MAP_URL = `https://www.google.com/maps/d/viewer?mid=${CARTEL_MAP_ID}`;
const KML_URL = `https://www.google.com/maps/d/kml?mid=${CARTEL_MAP_ID}&forcekml=1`;
export const PROVIDER = 'Active Cartels In Mexico (@MexicoCartelMap)';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // the map changes a few times a week at most
const STALE_AFTER_MS = 48 * 60 * 60 * 1000; // serve cached geometry past this only as `stale`
const MAX_KML_BYTES = 8 * 1024 * 1024;
const MAX_DESC_CHARS = 600;
const MAX_NAME_CHARS = 220;
const SIMPLIFY_TOLERANCE_DEG = 0.003; // ~300 m; drawn at country scale
const MAX_RECENT = 25;

let _cache = null;
let _cacheTs = 0;

// KML folder -> CRUCIX layer key
const FOLDER_LAYER = [
  [/^cartel influence/i, 'influence'],
  [/activity \/ crimes/i, 'activity'],
  [/government|military operations/i, 'gov_ops'],
  [/safehouse/i, 'safehouses'],
  [/active wars/i, 'wars'],
  [/truce/i, 'truces'],
  [/allianc/i, 'alliances'],
  [/stronghold/i, 'strongholds'],
  [/activity in the u\.?s/i, 'us_activity'],
];
export const LAYER_LABELS = {
  influence: 'Areas of influence',
  activity: 'Recent activity / crimes',
  gov_ops: 'Government / military ops',
  safehouses: 'Alleged safehouses',
  wars: 'Active wars',
  truces: 'Active truces',
  alliances: 'Alleged alliances',
  strongholds: 'Strongholds',
  us_activity: 'Activity in the U.S.',
  other: 'Other',
};

// Canonical organizations. Order matters: factions before their parent, specific before generic.
// `color` is CRUCIX's own palette, chosen to stay close to the map legend so the two agree.
export const ORGS = [
  { id: 'cjng', label: 'CJNG (Jalisco Nueva Generación)', short: 'CJNG', color: '#ff5252', re: /jalisco nueva generaci|\bcjng\b|cuatro letras|matazetas|fuerzas especiales mencho/i },
  { id: 'sinaloa_chapitos', label: 'Sinaloa — Los Chapitos / La Chapiza', short: 'Chapitos', color: '#26c6da', re: /chapiza|chapitos/i },
  { id: 'sinaloa_mayiza', label: 'Sinaloa — La Mayiza / MF', short: 'Mayiza', color: '#9575cd', re: /mayiza|mayitos|\bmz\b|\bmf\b|gente de ren[eé]|gente nueva|los rusos|salgueiros/i },
  { id: 'sinaloa', label: 'Sinaloa Cartel (unspecified faction)', short: 'Sinaloa', color: '#7e57c2', re: /c[aá]rtel de sinaloa|sinaloa cartel/i },
  { id: 'cdn', label: 'Cártel del Noreste (CDN)', short: 'CDN', color: '#eeeeee', re: /noreste|\bcdn\b|northeast cartel|tropa del infierno/i },
  { id: 'golfo_metros', label: 'Gulf Cartel — Metros', short: 'CDG Metros', color: '#4fc3f7', re: /metros/i },
  { id: 'golfo_escorpiones', label: 'Gulf Cartel — Matamoros / Escorpiones', short: 'CDG Matamoros', color: '#3949ab', re: /matamoros|escorpi|ciclones/i },
  { id: 'golfo_rojos', label: 'Gulf Cartel — Los Rojos (Tampico)', short: 'CDG Rojos', color: '#ad1457', re: /rojos tampico/i },
  { id: 'golfo', label: 'Gulf Cartel (other factions)', short: 'CDG', color: '#5c6bc0', re: /c[aá]rtel del golfo|gulf cartel|\bcdg\b/i },
  { id: 'juarez', label: 'Cártel de Juárez / La Línea / NCDJ', short: 'La Línea', color: '#66bb6a', re: /ju[aá]rez|la l[ií]nea|ncdj/i },
  { id: 'caborca', label: 'Caborca Cartel (Caro Quintero)', short: 'Caborca', color: '#a1887f', re: /caborca|caro quintero/i },
  { id: 'cis_salazar', label: 'Cártel Independiente de Sonora / Los Salazar', short: 'Los Salazar', color: '#fbc02d', re: /independiente de sonora|salazar|paredes|fantasmas/i },
  { id: 'templarios', label: 'Caballeros Templarios', short: 'Templarios', color: '#6d4c41', re: /templari|knight'?s templar|gente del tena/i },
  { id: 'carteles_unidos', label: 'Cárteles Unidos / Tepalcatepec / La Resistencia', short: 'Cárteles Unidos', color: '#f9a825', re: /c[aá]rteles unidos|united cartels|tepalcatepec|resistencia|los reyes|\br5\b|los wichos|el abuelo/i },
  { id: 'nfm', label: 'Nueva Familia Michoacana / Los Viagras', short: 'NFM', color: '#ef6c00', re: /familia michoacana|viagras|\bnfm\b|\blnfm\b/i },
  { id: 'csrl', label: 'Cártel Santa Rosa de Lima', short: 'CSRL', color: '#7cb342', re: /santa rosa|\bcsrl\b|csrdl|marriza/i },
  { id: 'blo', label: 'Beltrán Leyva Organization', short: 'BLO', color: '#fdd835', re: /beltr[aá]n|\bblo\b/i },
  { id: 'zve', label: 'Zetas Vieja Escuela', short: 'ZVE', color: '#a52714', re: /vieja escuela|old school zetas|vieja guardia|\bzve\b/i },
  { id: 'zetas', label: 'Los Zetas (remnants)', short: 'Zetas', color: '#8d6e63', re: /\bzetas\b/i },
  { id: 'barredora', label: 'La Barredora', short: 'Barredora', color: '#c0ca33', re: /barredora/i },
  { id: 'ardillos', label: 'Los Ardillos', short: 'Ardillos', color: '#ab47bc', re: /ardillos/i },
  { id: 'rojos', label: 'Los Rojos', short: 'Los Rojos', color: '#c2185b', re: /los rojos/i },
  { id: 'tlacos', label: 'Los Tlacos / Cártel de la Sierra', short: 'Tlacos', color: '#827717', re: /tlacos|c[aá]rtel de la sierra|\bcdls\b/i },
  { id: 'guerreros_unidos', label: 'Guerreros Unidos', short: 'Guerreros Unidos', color: '#2e7d32', re: /guerreros unidos/i },
  { id: 'caf', label: 'Arellano Félix Organization (CAF)', short: 'CAF', color: '#90a4ae', re: /arellano|\bcaf\b|\bafo\b|tijuana cartel/i },
  { id: 'grupo_sombra', label: 'Grupo Sombra / Mafia Veracruzana', short: 'Grupo Sombra', color: '#0288d1', re: /grupo sombra|mafia veracruzana|fegs/i },
  { id: 'zicuiran', label: 'Cártel de Zicuirán / El Migueladas', short: 'Zicuirán', color: '#80cbc4', re: /zicuir|migueladas/i },
  { id: 'chamula', label: 'Cártel de Chamula', short: 'Chamula', color: '#87ceac', re: /chamula/i },
  { id: 'correa', label: 'Los Correa', short: 'Los Correa', color: '#00838f', re: /los correa/i },
  { id: 'union_leon', label: 'Unión León', short: 'Unión León', color: '#a1c2fa', re: /uni[oó]n le[oó]n/i },
  { id: 'alemanes', label: 'Los Alemanes', short: 'Alemanes', color: '#c5e1a5', re: /alemanes/i },
];
const ORG_BY_ID = new Map(ORGS.map(o => [o.id, o]));
export const ANALYSIS_ORG = { id: 'analysis', label: 'Disputed / analysis area', short: 'Disputed', color: '#9e9e9e' };
export const UNKNOWN_ORG = { id: 'other', label: 'Other / unattributed', short: 'Other', color: '#bdbdbd' };

// Only event-style layers carry a meaningful "when"; influence polygons mention historical dates in prose.
const DATED_LAYERS = new Set(['activity', 'gov_ops', 'wars', 'truces']);

const ANALYSIS_RE = /^(situation in|.*analysis$|disputed|divided|war (in|between)|low cartel activity|caborca area|chihuahua capital|ciudad ju[aá]rez$)/i;

// ---------- text helpers ----------

export function cleanText(raw, max) {
  const s = stripTags(decodeEntities(String(raw || '')))
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

// First non-image http(s) link (embedded <img> tags are pictures, not the entry's source).
export function firstUrl(raw) {
  const text = decodeEntities(String(raw || '')).replace(/<img\b[^>]*>/gi, ' ');
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const u = m[0].replace(/[.,;)]+$/, '');
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(u)) continue;
    return u.length <= 300 ? u : null;
  }
  return null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

// Best-effort date mention: "09/01/2026", "2026-01-09", "May 6 2025", "As of May 2024".
export function mentionedDate(text) {
  const s = String(text || '');
  let m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);
  if (m) return isoDate(+m[3], +m[1] - 1, +m[2]);
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return isoDate(+m[1], +m[2] - 1, +m[3]);
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
  if (m) return isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i.exec(s);
  if (m) return isoDate(+m[2], MONTHS[m[1].toLowerCase()], 1);
  return null;
}

function isoDate(y, mo, d) {
  if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo, d));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// KML colors are aabbggrr.
export function kmlColor(abgr) {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(abgr || '').trim());
  if (!m) return null;
  return { hex: `#${m[4]}${m[3]}${m[2]}`.toLowerCase(), alpha: parseInt(m[1], 16) / 255 };
}

export function classifyOrg(name, layer) {
  const n = String(name || '');
  if (ANALYSIS_RE.test(n.trim()) && (layer === 'influence' || layer === 'strongholds' || layer === 'wars')) return ANALYSIS_ORG;
  for (const o of ORGS) if (o.re.test(n)) return o;
  return UNKNOWN_ORG;
}

// All organizations named in a string (for wars/alliances that involve several).
export function orgsMentioned(name) {
  const n = String(name || '');
  const out = [];
  for (const o of ORGS) if (o.re.test(n) && !out.includes(o.id)) out.push(o.id);
  // a generic parent is redundant once one of its factions matched
  const drop = new Set();
  if (out.some(id => id.startsWith('sinaloa_'))) drop.add('sinaloa');
  if (out.some(id => id.startsWith('golfo_'))) drop.add('golfo');
  if (out.includes('zve')) drop.add('zetas');
  return out.filter(id => !drop.has(id));
}

// ---------- minimal KML reader (no DOM in Node; the schema we need is tiny) ----------

const TAG_RE = (tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');

function innerOf(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1] : null;
}

function textOf(xml, tag) {
  const inner = innerOf(xml, tag);
  if (inner == null) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return (cdata ? cdata[1] : inner).trim();
}

function* blocks(xml, tag) {
  for (const m of xml.matchAll(TAG_RE(tag))) yield { xml: m[0], inner: m[1], attrs: m[0].slice(0, m[0].indexOf('>')) };
}

function idAttr(openTag) {
  const m = /\sid="([^"]+)"/.exec(openTag);
  return m ? m[1] : null;
}

function parseCoords(text) {
  const out = [];
  for (const tok of String(text || '').trim().split(/\s+/)) {
    const p = tok.split(',');
    const lon = Number(p[0]), lat = Number(p[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push([lon, lat]);
  }
  return out;
}

function parseStyles(xml) {
  const styles = new Map();
  for (const b of blocks(xml, 'Style')) {
    const id = idAttr(b.attrs);
    if (!id) continue;
    const st = {};
    const poly = innerOf(b.inner, 'PolyStyle');
    const line = innerOf(b.inner, 'LineStyle');
    const icon = innerOf(b.inner, 'IconStyle');
    if (poly) st.fill = kmlColor(textOf(poly, 'color'));
    if (line) { st.stroke = kmlColor(textOf(line, 'color')); st.width = Number(textOf(line, 'width')) || null; }
    if (icon) st.icon = kmlColor(textOf(icon, 'color'));
    styles.set(id, st);
  }
  const maps = new Map();
  for (const b of blocks(xml, 'StyleMap')) {
    const id = idAttr(b.attrs);
    if (!id) continue;
    let normal = null;
    for (const p of blocks(b.inner, 'Pair')) {
      if ((textOf(p.inner, 'key') || '') === 'normal') normal = (textOf(p.inner, 'styleUrl') || '').replace(/^#/, '');
    }
    if (normal) maps.set(id, normal);
  }
  return (styleUrl) => {
    let key = String(styleUrl || '').replace(/^#/, '');
    if (maps.has(key)) key = maps.get(key);
    return styles.get(key) || {};
  };
}

function parseGeometry(pmXml) {
  const polygons = [], lines = [], points = [];
  for (const pg of blocks(pmXml, 'Polygon')) {
    const outer = innerOf(pg.inner, 'outerBoundaryIs');
    const ring = parseCoords(outer ? textOf(outer, 'coordinates') : null);
    if (ring.length < 4) continue;
    const holes = [];
    for (const ib of blocks(pg.inner, 'innerBoundaryIs')) {
      const h = parseCoords(textOf(ib.inner, 'coordinates'));
      if (h.length >= 4) holes.push(h);
    }
    polygons.push([ring, ...holes]);
  }
  for (const ls of blocks(pmXml, 'LineString')) {
    const c = parseCoords(textOf(ls.inner, 'coordinates'));
    if (c.length >= 2) lines.push(c);
  }
  for (const pt of blocks(pmXml, 'Point')) {
    const c = parseCoords(textOf(pt.inner, 'coordinates'));
    if (c.length) points.push(c[0]);
  }
  return { polygons, lines, points };
}

function centroidOf(ring) {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return { lat: y / ring.length, lon: x / ring.length };
}

function layerFor(folderName) {
  for (const [re, key] of FOLDER_LAYER) if (re.test(folderName || '')) return key;
  return 'other';
}

// Parse the whole KML document into normalized geometry + a lightweight summary.
export function parseKml(xml) {
  const text = String(xml || '');
  const docInner = innerOf(text, 'Document') || text;
  const docName = cleanText(textOf(docInner.replace(/<Folder[\s\S]*$/i, ''), 'name') || '', 120) || 'Active Cartels In Mexico';
  const docDescRaw = textOf(docInner.replace(/<Folder[\s\S]*$/i, ''), 'description') || '';
  const styleOf = parseStyles(text);

  const disclaimer = extractDisclaimer(docDescRaw);
  const legend = extractLegend(docDescRaw);

  const polygons = [], points = [], lines = [];
  const layerCounts = {};
  let skipped = 0, id = 0;

  for (const folder of blocks(text, 'Folder')) {
    const folderName = cleanText(textOf(folder.inner, 'name') || '', 80);
    const layer = layerFor(folderName);
    for (const pm of blocks(folder.inner, 'Placemark')) {
      const rawName = textOf(pm.inner, 'name') || '';
      const rawDesc = textOf(pm.inner, 'description') || '';
      const name = cleanText(rawName, MAX_NAME_CHARS);
      const desc = cleanText(rawDesc, MAX_DESC_CHARS);
      const style = styleOf(textOf(pm.inner, 'styleUrl'));
      const geom = parseGeometry(pm.inner);
      const org = classifyOrg(rawName, layer);
      const involved = orgsMentioned(rawName).length ? orgsMentioned(rawName) : orgsMentioned(rawDesc.slice(0, 400));
      const base = {
        id: `c${++id}`,
        layer,
        name,
        desc,
        link: firstUrl(rawDesc) || firstUrl(rawName),
        hasImage: /<img\b/i.test(rawDesc),
        date: DATED_LAYERS.has(layer) ? mentionedDate(`${rawName} ${rawDesc}`) : null,
        org: org.id,
        involved,
      };
      let any = false;
      for (const rings of geom.polygons) {
        const simplified = rings.map(r => simplifyRing(r, SIMPLIFY_TOLERANCE_DEG));
        const areaKm2 = Math.round(polygonAreaKm2(rings));
        polygons.push({ ...base, rings: simplified, areaKm2, centroid: centroidOf(rings[0]),
          fill: style.fill?.hex || null, fillAlpha: style.fill ? +style.fill.alpha.toFixed(2) : null, stroke: style.stroke?.hex || null });
        any = true;
      }
      for (const path of geom.lines) {
        lines.push({ ...base, path: simplifyRing(path, SIMPLIFY_TOLERANCE_DEG), color: style.stroke?.hex || null, width: style.width });
        any = true;
      }
      for (const [lon, lat] of geom.points) {
        points.push({ ...base, lat, lon, color: style.icon?.hex || null });
        any = true;
      }
      if (any) layerCounts[layer] = (layerCounts[layer] || 0) + 1;
      else skipped++;
    }
  }
  return { docName, disclaimer, legend, polygons, points, lines, layerCounts, skipped };
}

// Description paragraphs are separated by <br>; split before stripping so they stay separate.
function descLines(rawDesc) {
  return decodeEntities(String(rawDesc || '')).split(/<br\s*\/?>/i).map(s => stripTags(s)).filter(Boolean);
}

function extractDisclaimer(rawDesc) {
  const keep = descLines(rawDesc).filter(l => /not 100% accurate|created by one single individual|as of .* controlled about/i.test(l));
  return keep.map(l => l.length > 300 ? l.slice(0, 299) + '…' : l);
}

function extractLegend(rawDesc) {
  const out = [];
  for (const line of descLines(rawDesc)) {
    const m = /^\s*([A-Za-z ]{3,20})\s*-\s*(.{3,120})$/.exec(line.trim());
    if (m && !/^(follow|any donation|big thanks)/i.test(m[1])) out.push({ swatch: m[1].trim(), text: cleanText(m[2], 120) });
  }
  return out.slice(0, 24);
}

// ---------- summary ----------

export function summarize(parsed, now = Date.now()) {
  const byOrg = new Map();
  const bump = (orgId, key, n = 1) => {
    if (!byOrg.has(orgId)) {
      const o = ORG_BY_ID.get(orgId) || (orgId === 'analysis' ? ANALYSIS_ORG : UNKNOWN_ORG);
      byOrg.set(orgId, { id: o.id, label: o.label, short: o.short, color: o.color, polygons: 0, areaKm2: 0, pins: 0, wars: 0, strongholds: 0, activity: 0 });
    }
    byOrg.get(orgId)[key] += n;
  };
  for (const p of parsed.polygons) {
    if (p.layer === 'influence' && p.org !== 'analysis' && p.org !== 'other') { bump(p.org, 'polygons'); bump(p.org, 'areaKm2', p.areaKm2); }
    else if (p.layer === 'influence') bump(p.org, 'polygons');
  }
  for (const pt of parsed.points) {
    if (pt.layer === 'wars') for (const id of pt.involved) bump(id, 'wars');
    if (pt.layer === 'strongholds' && pt.org !== 'other' && pt.org !== 'analysis') bump(pt.org, 'strongholds');
    if (pt.layer === 'activity') for (const id of pt.involved) bump(id, 'activity');
    if (pt.org !== 'other' && pt.org !== 'analysis') bump(pt.org, 'pins');
  }
  const orgs = [...byOrg.values()].filter(o => o.id !== 'analysis' && o.id !== 'other')
    .sort((a, b) => (b.areaKm2 - a.areaKm2) || (b.pins - a.pins));

  const dated = parsed.points.filter(p => p.date && (p.layer === 'activity' || p.layer === 'gov_ops' || p.layer === 'wars'))
    .sort((a, b) => b.date.localeCompare(a.date));
  const seen = new Set();
  const recent = dated.filter(p => { const k = `${p.date}|${p.name.slice(0, 80)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_RECENT).map(p => ({ id: p.id, date: p.date, layer: p.layer, name: p.name.slice(0, 200), lat: p.lat, lon: p.lon, org: p.org, involved: p.involved, link: p.link }));
  const latestMention = dated[0]?.date || null;
  const latestMs = latestMention ? Date.parse(latestMention) : NaN;
  const last30d = dated.filter(p => Number.isFinite(latestMs) && (now - Date.parse(p.date)) <= 30 * 86400000).length;

  const influenceKm2 = parsed.polygons.filter(p => p.layer === 'influence' && p.org !== 'analysis' && p.org !== 'other')
    .reduce((s, p) => s + p.areaKm2, 0);
  const disputedKm2 = parsed.polygons.filter(p => p.org === 'analysis').reduce((s, p) => s + p.areaKm2, 0);

  const wars = parsed.points.filter(p => p.layer === 'wars').map(p => ({ id: p.id, name: p.name.slice(0, 200), lat: p.lat, lon: p.lon, involved: p.involved, date: p.date, link: p.link }));
  const truces = parsed.points.filter(p => p.layer === 'truces').map(p => ({ id: p.id, name: p.name.slice(0, 240), lat: p.lat, lon: p.lon, involved: p.involved, link: p.link }));
  const alliances = parsed.lines.filter(l => l.layer === 'alliances').map(l => ({ id: l.id, name: l.name.slice(0, 200), desc: l.desc.slice(0, 300), involved: l.involved, color: l.color }));
  const usActivity = parsed.points.filter(p => p.layer === 'us_activity').map(p => ({ id: p.id, name: p.name.slice(0, 120), lat: p.lat, lon: p.lon, involved: p.involved }));

  return {
    docName: parsed.docName,
    disclaimer: parsed.disclaimer,
    legend: parsed.legend,
    layerCounts: parsed.layerCounts,
    featureCount: parsed.polygons.length + parsed.points.length + parsed.lines.length,
    polygonCount: parsed.polygons.length,
    pointCount: parsed.points.length,
    lineCount: parsed.lines.length,
    skipped: parsed.skipped,
    influenceKm2: Math.round(influenceKm2),
    disputedKm2: Math.round(disputedKm2),
    orgCount: orgs.length,
    orgs,
    wars,
    truces,
    alliances,
    usActivity,
    recent,
    latestMention,
    activityLast30d: last30d,
  };
}

function signalsFor(summary, now = Date.now()) {
  const out = [];
  if (summary.latestMention) {
    const ageD = (now - Date.parse(summary.latestMention)) / 86400000;
    if (ageD >= 0 && ageD <= 7) out.push({ kind: 'fresh', text: `Cartel map has ${summary.activityLast30d} dated entries in the last 30 days (latest ${summary.latestMention})` });
  }
  if (summary.wars.length >= 30) out.push({ kind: 'wars', text: `${summary.wars.length} active inter-cartel wars mapped` });
  return out;
}

export function buildResult(xml, now = Date.now()) {
  const parsed = parseKml(xml);
  if (!parsed.polygons.length && !parsed.points.length) {
    return { ...unavailable('KML parsed but contained no placemarks'), status: 'empty' };
  }
  const summary = summarize(parsed, now);
  return {
    source: 'Cartels',
    timestamp: new Date(now).toISOString(),
    status: 'live',
    provider: PROVIDER,
    siteUrl: CARTEL_MAP_URL,
    mapId: CARTEL_MAP_ID,
    fetchedAt: new Date(now).toISOString(),
    caveat: 'Crowd-sourced, single-maintainer OSINT map. Boundaries are the maintainer\'s assessment of influence, not verified control of territory.',
    ...summary,
    signals: signalsFor(summary, now),
    geo: {
      mapId: CARTEL_MAP_ID,
      fetchedAt: new Date(now).toISOString(),
      polygons: parsed.polygons,
      points: parsed.points,
      lines: parsed.lines,
    },
  };
}

function unavailable(error) {
  return {
    source: 'Cartels',
    timestamp: new Date().toISOString(),
    status: 'unavailable',
    error,
    provider: PROVIDER,
    siteUrl: CARTEL_MAP_URL,
    mapId: CARTEL_MAP_ID,
  };
}

function staleCopy() {
  const ageMs = Date.now() - _cacheTs;
  return { ..._cache, stale: true, status: ageMs > STALE_AFTER_MS ? 'stale' : 'live', cacheAgeH: +(ageMs / 3600000).toFixed(1) };
}

export async function fetchCartels() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    const raw = await safeFetch(KML_URL, {
      timeout: 25000,
      headers: { 'Accept': 'application/vnd.google-earth.kml+xml, application/xml, text/xml, */*', 'User-Agent': 'Mozilla/5.0 (CRUCIX Intelligence Engine)' },
    });
    if (raw?.error) {
      console.log(`[Cartels] KML fetch error: ${raw.error}`);
      return _cache ? staleCopy() : unavailable(raw.error);
    }
    const xml = typeof raw === 'string' ? raw : raw?.rawText;
    if (typeof xml !== 'string' || !/<kml[\s>]/i.test(xml)) {
      console.log('[Cartels] response was not KML');
      return _cache ? staleCopy() : unavailable('Response was not KML');
    }
    if (xml.length > MAX_KML_BYTES) {
      console.log(`[Cartels] KML too large (${xml.length} bytes)`);
      return _cache ? staleCopy() : unavailable('KML exceeded size limit');
    }
    const result = buildResult(xml);
    if (result.status !== 'live') {
      console.log(`[Cartels] ${result.error}`);
      return _cache ? staleCopy() : result;
    }
    console.log(`[Cartels] ${result.docName} · ${result.polygonCount} polygons · ${result.pointCount} points · ${result.orgCount} orgs · latest ${result.latestMention}`);
    _cache = result;
    _cacheTs = Date.now();
    return result;
  } catch (err) {
    console.log(`[Cartels] Fetch error: ${err.message}`);
    return _cache ? staleCopy() : unavailable(err.message);
  }
}

export function cachedCartelGeo() {
  return _cache?.geo || null;
}

export async function briefing() {
  return fetchCartels();
}
