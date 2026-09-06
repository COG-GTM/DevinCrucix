// Border Watch — polite RSS/API ingestion of US-MX border news with full provenance.
//
// Thin slice of the border-news source-integration plan, adapted to CRUCIX's Node/JSON
// stack: a data-driven source registry (config/border-sources.json), conditional feed
// polling (ETag / If-Modified-Since, 304 = unchanged), text-of-record retrieval through
// each outlet's public WordPress REST API (falling back to the article page, never past a
// paywall), content hashes + pipeline version on every record, rule-based topic/place
// tagging that is clearly labelled as machine-generated, and a small mention-baseline
// spike detector that links back to the underlying articles.
//
// Nothing is summarised or editorialised at ingestion time; the outlet's own headline,
// feed description and body paragraphs are the record. Dashboards must HTML-escape.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseFeed, feedMeta } from '../utils/rss.mjs';
import { extractArticle, htmlToText, bodyParagraphs } from '../utils/article.mjs';
import { checkRobots, CRAWLER_UA } from '../utils/robots.mjs';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PIPELINE_VERSION = 'bordernews/1.0.0';
export const TAGGER_VERSION = 'crucix-rules/3';
export const DEFAULT_REGISTRY_FILE = join(__dirname, '../../config/border-sources.json');
export const DEFAULT_DATA_DIR = join(__dirname, '../../runs/border');

const FEED_TIMEOUT_MS = 12_000;
const ARTICLE_TIMEOUT_MS = 10_000;
const POLITE_DELAY_MS = 1_500;
const ENRICH_BUDGET_MS = 20_000; // wall-clock cap on article enrichment per sweep (feed polls excluded)
const MAX_ARTICLE_FETCH_PER_FEED = clampInt(process.env.BORDER_MAX_ARTICLE_FETCH, 0, 20, 5);
const FETCH_ARTICLES = process.env.BORDER_FETCH_ARTICLES !== 'false';
const RETENTION_DAYS = 90;
const MAX_STORE = 3_000;
const MAX_RAW_FILES = 400;
const MAX_TEXT_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 600;
const FEED_FULLTEXT_MIN_CHARS = 1_500; // a description this long is the post body (Blogger/Atom full-content feeds), not an excerpt
const RECENT_LIMIT = 40;

const REQUIRED_SOURCE_FIELDS = ['id', 'outlet', 'feedUrl', 'language', 'countryOfPublication', 'regionTag', 'reliability', 'discoveryDate'];
const FEED_TYPES = ['rss', 'atom', 'news-sitemap'];
export const RELIABILITY_GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'ungraded'];

// ---------------------------------------------------------------------------
// Controlled vocabularies — exported so the API layer can whitelist against them.
// ---------------------------------------------------------------------------

// Bilingual (EN/ES) rule sets: the registry mixes US English outlets with Mexican Spanish ones.
export const TOPICS = {
  violence: /\b(shooting|shot (dead|and killed)|killed|killing|homicide|murder(ed|s)?|gunfire|gunmen|gun battle|kidnapp?(ed|ing)|abduct(ed|ion)|massacre|bodies|ambush(ed)?|attack(ed|s)?|assault(ed)?|stabb(ed|ing)|behead|executed|extortion|femicide|clashes?|asesina(to|tos|do|dos|da|das|n|ron)|homicidios?|balaceras?|enfrentamientos?|ejecutad[oa]s?|secuestr(o|os|ad[oa]s?|an|aron)|masacre|cuerpos|ataques?|feminicidios?|extorsi[oó]n|tiroteos?|sicarios?|levant[oó]n|fosas? clandestinas?|violencia)\b/i,
  narcotics: /\b(fentanyl|cartels?|cocaine|meth(amphetamine)?|heroin|narcotics?|drug(s| smuggling| trafficking| seizure| load| bust)|CJNG|Sinaloa|Gulf Cartel|Jalisco New Generation|Zetas|Cartel del Noreste|La Línea|opioids?|fentanilo|c[aá]rte?les?|coca[ií]na|metanfetaminas?|hero[ií]na|narco(tr[aá]fico|menudeo|s)?|drogas?|estupefacientes|Cártel del Golfo|Cártel de Sinaloa)\b/i,
  enforcement: /\b(Border Patrol|CBP|ICE|Customs and Border Protection|Immigration and Customs Enforcement|apprehen(ded|sions?)|encounters?|deport(ed|ation|ations)|detain(ed|ee|ees)|detention|arrest(ed|s)?|checkpoint|ports? of entry|Operation Lone Star|National Guard|DPS|troopers?|seiz(ed|ure|ures)|border wall|buoys?|tunnels?|expulsions?|raids?|agents?|Homeland Security|DHS|Title 42|Title 8|Guardia Nacional|Patrulla Fronteriza|aduanas?|detenid[oa]s?|detenci[oó]n|deportad[oa]s?|deportaci[oó]n(es)?|operativos?|aseguramientos?|decomisos?|cateos?|Sedena|Semar|SSPC|FGR|fiscal[ií]a|garitas?|ret[eé]n(es)?|muro fronterizo|agentes?)\b/i,
  migration: /\b(migrants?|asylum(-seekers?)?|immigra(nts?|tion)|refugees?|crossings?|shelters?|humanitarian|parole|unaccompanied (minors?|children)|remittances?|caravans?|smuggl(ers?|ing)|coyotes?|deportees?|migrantes?|migraci[oó]n|migratori[oa]s?|asilo|refugiad[oa]s?|albergues?|caravanas?|polleros?|cruces? fronterizos?|repatriad[oa]s?|indocumentad[oa]s?|remesas?)\b/i,
  rail: /\b(railroads?|railways?|freight trains?|trains?|Union Pacific|BNSF|CPKC|Kansas City Southern|derail(ed|ment)|rail (bridge|yard|crossing)|ferrocarril(es)?|ferroviari[oa]s?|v[ií]as del tren|descarril(ó|amiento|o))\b/i,
  trade: /\b(tariffs?|trade|international bridge|commerce|maquilas?|maquiladoras?|exports?|imports?|USMCA|supply chain|trucking|truck crossings?|aranceles?|comercio|exportaci[oó]n(es)?|importaci[oó]n(es)?|T-MEC|cadena de suministro|transportistas?|puente internacional|cruces? comercial(es)?)\b/i,
  governance: /\b(mayor|governor|legislature|lawmakers?|Senate|Congress|court|judge|indict(ed|ment)|lawsuit|ruling|policy|executive order|county commissioners?|sheriff|alcaldes?a?|gobernador(a|es)?|congreso|senado|diputad[oa]s?|jue(z|za|ces)|tribunal(es)?|sentencia|decreto|ayuntamiento|cabildo)\b/i,
};
export const TOPIC_KEYS = Object.keys(TOPICS);

// Border gazetteer: US border counties by CBP sector plus Mexican border municipios.
// Aliases are matched on word boundaries; ambiguous bare names are avoided.
export const PLACES = [
  { key: 'san-diego-ca', name: 'San Diego County, CA', country: 'US', state: 'CA', sector: 'San Diego', lat: 32.72, lon: -117.16, aliases: ['San Diego', 'San Ysidro', 'Otay Mesa', 'Chula Vista'] },
  { key: 'imperial-ca', name: 'Imperial County, CA', country: 'US', state: 'CA', sector: 'El Centro', lat: 32.79, lon: -115.56, aliases: ['Imperial County', 'Calexico', 'El Centro'] },
  { key: 'yuma-az', name: 'Yuma County, AZ', country: 'US', state: 'AZ', sector: 'Yuma', lat: 32.69, lon: -114.63, aliases: ['Yuma', 'San Luis, Ariz'] },
  { key: 'pima-az', name: 'Pima County, AZ', country: 'US', state: 'AZ', sector: 'Tucson', lat: 32.22, lon: -110.97, aliases: ['Pima County', 'Tucson', 'Sasabe', 'Ajo, Ariz'] },
  { key: 'santa-cruz-az', name: 'Santa Cruz County, AZ', country: 'US', state: 'AZ', sector: 'Tucson', lat: 31.34, lon: -110.93, aliases: ['Santa Cruz County', 'Nogales, Ariz', 'Nogales, Arizona', 'Nogales'] },
  { key: 'cochise-az', name: 'Cochise County, AZ', country: 'US', state: 'AZ', sector: 'Tucson', lat: 31.34, lon: -109.55, aliases: ['Cochise County', 'Douglas, Ariz', 'Douglas, Arizona', 'Bisbee', 'Sierra Vista', 'Naco'] },
  { key: 'luna-nm', name: 'Luna County, NM', country: 'US', state: 'NM', sector: 'El Paso', lat: 32.27, lon: -107.76, aliases: ['Luna County', 'Deming', 'Columbus, N.M', 'Columbus, New Mexico'] },
  { key: 'dona-ana-nm', name: 'Doña Ana County, NM', country: 'US', state: 'NM', sector: 'El Paso', lat: 32.31, lon: -106.78, aliases: ['Doña Ana', 'Dona Ana', 'Las Cruces', 'Santa Teresa', 'Sunland Park'] },
  { key: 'el-paso-tx', name: 'El Paso County, TX', country: 'US', state: 'TX', sector: 'El Paso', lat: 31.76, lon: -106.49, aliases: ['El Paso', 'Fort Bliss', 'Tornillo', 'Socorro, Texas'] },
  { key: 'hudspeth-tx', name: 'Hudspeth County, TX', country: 'US', state: 'TX', sector: 'El Paso', lat: 31.45, lon: -105.38, aliases: ['Hudspeth County', 'Fort Hancock', 'Sierra Blanca'] },
  { key: 'culberson-tx', name: 'Culberson County, TX', country: 'US', state: 'TX', sector: 'Big Bend', lat: 31.04, lon: -104.83, aliases: ['Culberson County', 'Van Horn'] },
  { key: 'presidio-tx', name: 'Presidio County, TX', country: 'US', state: 'TX', sector: 'Big Bend', lat: 29.56, lon: -104.37, aliases: ['Presidio County', 'Presidio, Texas', 'Marfa'] },
  { key: 'brewster-tx', name: 'Brewster County, TX', country: 'US', state: 'TX', sector: 'Big Bend', lat: 29.33, lon: -103.21, aliases: ['Brewster County', 'Big Bend', 'Alpine, Texas', 'Terlingua'] },
  { key: 'terrell-tx', name: 'Terrell County, TX', country: 'US', state: 'TX', sector: 'Big Bend', lat: 30.13, lon: -102.07, aliases: ['Terrell County', 'Sanderson, Texas'] },
  { key: 'val-verde-tx', name: 'Val Verde County, TX', country: 'US', state: 'TX', sector: 'Del Rio', lat: 29.36, lon: -100.9, aliases: ['Val Verde County', 'Del Rio', 'Laughlin Air Force Base'] },
  { key: 'kinney-tx', name: 'Kinney County, TX', country: 'US', state: 'TX', sector: 'Del Rio', lat: 29.31, lon: -100.42, aliases: ['Kinney County', 'Brackettville'] },
  { key: 'maverick-tx', name: 'Maverick County, TX', country: 'US', state: 'TX', sector: 'Del Rio', lat: 28.71, lon: -100.5, aliases: ['Maverick County', 'Eagle Pass', 'Shelby Park'] },
  { key: 'webb-tx', name: 'Webb County, TX', country: 'US', state: 'TX', sector: 'Laredo', lat: 27.51, lon: -99.51, aliases: ['Webb County', 'Laredo'] },
  { key: 'zapata-tx', name: 'Zapata County, TX', country: 'US', state: 'TX', sector: 'Laredo', lat: 26.9, lon: -99.27, aliases: ['Zapata County', 'Zapata, Texas', 'Falcon Lake'] },
  { key: 'starr-tx', name: 'Starr County, TX', country: 'US', state: 'TX', sector: 'Rio Grande Valley', lat: 26.38, lon: -98.82, aliases: ['Starr County', 'Rio Grande City', 'Roma, Texas', 'La Grulla'] },
  { key: 'hidalgo-tx', name: 'Hidalgo County, TX', country: 'US', state: 'TX', sector: 'Rio Grande Valley', lat: 26.2, lon: -98.23, aliases: ['Hidalgo County', 'McAllen', 'Mission, Texas', 'Pharr', 'Edinburg', 'Weslaco', 'Donna, Texas', 'Rio Grande Valley'] },
  { key: 'cameron-tx', name: 'Cameron County, TX', country: 'US', state: 'TX', sector: 'Rio Grande Valley', lat: 25.9, lon: -97.5, aliases: ['Cameron County', 'Brownsville', 'Harlingen', 'Boca Chica', 'Port Isabel'] },
  { key: 'tijuana-bc', name: 'Tijuana, Baja California', country: 'MX', state: 'BC', sector: 'San Diego', lat: 32.51, lon: -117.04, aliases: ['Tijuana', 'Tecate'] },
  { key: 'mexicali-bc', name: 'Mexicali, Baja California', country: 'MX', state: 'BC', sector: 'El Centro', lat: 32.63, lon: -115.45, aliases: ['Mexicali'] },
  { key: 'san-luis-rio-colorado-son', name: 'San Luis Río Colorado, Sonora', country: 'MX', state: 'SON', sector: 'Yuma', lat: 32.46, lon: -114.77, aliases: ['San Luis Río Colorado', 'San Luis Rio Colorado'] },
  { key: 'nogales-son', name: 'Nogales, Sonora', country: 'MX', state: 'SON', sector: 'Tucson', lat: 31.31, lon: -110.94, aliases: ['Nogales, Sonora', 'Agua Prieta'] },
  { key: 'juarez-chih', name: 'Ciudad Juárez, Chihuahua', country: 'MX', state: 'CHIH', sector: 'El Paso', lat: 31.69, lon: -106.42, aliases: ['Ciudad Juárez', 'Ciudad Juarez', 'Juárez', 'Juarez'] },
  { key: 'ojinaga-chih', name: 'Ojinaga, Chihuahua', country: 'MX', state: 'CHIH', sector: 'Big Bend', lat: 29.56, lon: -104.41, aliases: ['Ojinaga'] },
  { key: 'acuna-coah', name: 'Ciudad Acuña, Coahuila', country: 'MX', state: 'COAH', sector: 'Del Rio', lat: 29.32, lon: -100.93, aliases: ['Ciudad Acuña', 'Ciudad Acuna', 'Acuña'] },
  { key: 'piedras-negras-coah', name: 'Piedras Negras, Coahuila', country: 'MX', state: 'COAH', sector: 'Del Rio', lat: 28.7, lon: -100.52, aliases: ['Piedras Negras'] },
  { key: 'nuevo-laredo-tamps', name: 'Nuevo Laredo, Tamaulipas', country: 'MX', state: 'TAMPS', sector: 'Laredo', lat: 27.48, lon: -99.51, aliases: ['Nuevo Laredo'] },
  { key: 'reynosa-tamps', name: 'Reynosa, Tamaulipas', country: 'MX', state: 'TAMPS', sector: 'Rio Grande Valley', lat: 26.08, lon: -98.29, aliases: ['Reynosa', 'Río Bravo, Tamaulipas'] },
  { key: 'matamoros-tamps', name: 'Matamoros, Tamaulipas', country: 'MX', state: 'TAMPS', sector: 'Rio Grande Valley', lat: 25.87, lon: -97.5, aliases: ['Matamoros'] },
  { key: 'miguel-aleman-tamps', name: 'Miguel Alemán, Tamaulipas', country: 'MX', state: 'TAMPS', sector: 'Rio Grande Valley', lat: 26.4, lon: -99.03, aliases: ['Miguel Alemán', 'Miguel Aleman', 'Camargo, Tamaulipas'] },
];
export const PLACE_KEYS = PLACES.map(p => p.key);
export const PLACE_BY_KEY = new Map(PLACES.map(p => [p.key, p]));

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// "Laredo" must not fire on "Nuevo Laredo"; "Nogales" (AZ) must not fire on "Nogales, Sonora".
const PLACE_MATCHERS = PLACES.map(p => ({
  key: p.key,
  res: p.aliases.map(a => new RegExp(`${a === 'Laredo' ? '(?<!Nuevo )' : ''}\\b${escapeRe(a)}${a === 'Nogales' ? '(?!, Sonora)' : ''}(?![\\w-])`, 'i')),
}));

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function sha256(s) { return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex'); }

export function loadRegistry(file = DEFAULT_REGISTRY_FILE) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return validateRegistry(parsed);
}

export function validateRegistry(parsed) {
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : null;
  if (!sources) throw new Error('border registry: "sources" must be an array');
  const ids = new Set();
  for (const s of sources) {
    for (const f of REQUIRED_SOURCE_FIELDS) if (!s[f] || typeof s[f] !== 'string') throw new Error(`border registry: source ${s.id || '?'} missing "${f}"`);
    if (!/^[a-z0-9-]{2,40}$/.test(s.id)) throw new Error(`border registry: invalid id "${s.id}"`);
    if (ids.has(s.id)) throw new Error(`border registry: duplicate id "${s.id}"`);
    ids.add(s.id);
    if (!RELIABILITY_GRADES.includes(s.reliability)) throw new Error(`border registry: source ${s.id} has unknown reliability "${s.reliability}"`);
    let u;
    try { u = new URL(s.feedUrl); } catch { throw new Error(`border registry: source ${s.id} feedUrl is not a URL`); }
    if (u.protocol !== 'https:') throw new Error(`border registry: source ${s.id} feedUrl must be https`);
    if (s.feedType !== undefined && !FEED_TYPES.includes(s.feedType)) throw new Error(`border registry: source ${s.id} has unknown feedType "${s.feedType}"`);
    for (const f of ['fetchArticles', 'requirePlaceTag', 'paywall']) if (s[f] !== undefined && typeof s[f] !== 'boolean') throw new Error(`border registry: source ${s.id} "${f}" must be boolean`);
    if (s.pathPrefixes !== undefined) {
      if (!Array.isArray(s.pathPrefixes) || !s.pathPrefixes.length || s.pathPrefixes.some(p => typeof p !== 'string' || !p.startsWith('/'))) throw new Error(`border registry: source ${s.id} "pathPrefixes" must be a non-empty array of "/..." paths`);
    }
  }
  return sources;
}

// Registry-level scope filter for national outlets: keep only items under the listed URL paths.
export function matchesPathPrefixes(url, prefixes) {
  if (!prefixes?.length) return true;
  let p;
  try { p = new URL(url).pathname; } catch { return false; }
  return prefixes.some(prefix => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|source|ocid|ito|ns_\w+|republication-pixel)$/i;
export function normalizeUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (s.endsWith('?')) s = s.slice(0, -1);
  return s;
}

// Collapse headline variants ("EL PASO, Texas (Border Report) — ..." vs plain) to a key
// good enough to cluster the same wire story across outlets.
export function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^[a-z\s.,'’-]+\([^)]*\)\s*[—–-]\s*/i, '')
    .replace(/^[a-z\s.,'’-]+[—–]\s*/i, '')
    .replace(/[’'"“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 2)
    .join(' ');
}

export function wpPostId(guid) {
  const m = /[?&]p=(\d{1,12})\b/.exec(String(guid || ''));
  return m ? m[1] : null;
}

export function tagTopics(text) {
  const src = String(text || '');
  const out = [];
  for (const [topic, re] of Object.entries(TOPICS)) {
    const m = re.exec(src);
    if (m) out.push({ topic, evidence: m[0] });
  }
  return out;
}

export function tagPlaces(text) {
  const src = String(text || '');
  const out = [];
  for (const pm of PLACE_MATCHERS) {
    for (const re of pm.res) {
      const m = re.exec(src);
      if (m) { out.push({ key: pm.key, evidence: m[0] }); break; }
    }
  }
  return out;
}

export function conditionalHeaders(feedState) {
  const h = { 'User-Agent': CRAWLER_UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' };
  if (feedState?.etag) h['If-None-Match'] = feedState.etag;
  if (feedState?.lastModified) h['If-Modified-Since'] = feedState.lastModified;
  return h;
}

// Build the immutable-ish record for one feed item. `text` is filled in later by enrichArticle.
export function normalizeItem(item, source, collectedAt) {
  const url = normalizeUrl(item.link) || null;
  const guid = String(item.guid || '').slice(0, 300) || null;
  const identity = guid || url || `${source.id}|${item.title}`;
  const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const descText = String(item.description || '').replace(/\s+/g, ' ').trim();
  const summary = descText.slice(0, MAX_SUMMARY_CHARS);
  const text = descText.length >= FEED_FULLTEXT_MIN_CHARS ? descText.slice(0, MAX_TEXT_CHARS) : null;
  return {
    id: sha256(`${source.id}|${identity}`).slice(0, 16),
    sourceId: source.id,
    outlet: source.outlet,
    language: source.language,
    countryOfPublication: source.countryOfPublication,
    regionTag: source.regionTag,
    reliability: source.reliability,
    sourceType: source.sourceType || 'news-outlet',
    title,
    url,
    canonicalUrl: url,
    guid,
    publishedAt: item.published || null,
    collectedAt,
    summary,
    categories: (item.categories || []).map(c => String(c).slice(0, 80)).slice(0, 12),
    text,
    textChars: text ? text.length : 0,
    extraction: { method: text ? 'feed-content' : 'feed-description', fetchStatus: 'not attempted', fetchedAt: null, rawSnapshot: null },
    pipelineVersion: PIPELINE_VERSION,
    contentHash: sha256(text || `${title}\n${summary}`),
    paywalled: Boolean(source.paywall) || false,
    syndicated: false,
    wireSource: null,
    clusterId: null,
    tags: { topics: [], places: [], tool: TAGGER_VERSION },
  };
}

// Wire-style dateline: "McALLEN, Texas (Border Report) — ..." / "EL PASO — ...". It names the bureau, not
// necessarily the story's location, so it is removed before place tagging (an in-body mention still tags).
const DATELINE_RE = /^\s*[A-Z][A-Za-z.'\u00C0-\u017F-]*(?:\s+[A-Z][A-Za-z.'\u00C0-\u017F-]*){0,3}(?:,\s*[A-Za-z. ]{2,30})?\s*(?:\([^)]{2,40}\))?\s*[\u2014\u2013-]{1,2}\s*/;
export function stripDateline(text) {
  const src = String(text || '');
  const m = DATELINE_RE.exec(src);
  if (!m) return src;
  const lead = m[0];
  // Only treat it as a dateline when the leading place token is upper-cased (McALLEN, EL PASO, WASHINGTON).
  const place = lead.replace(/\(.*$/, '').replace(/[\u2014\u2013-]+\s*$/, '').split(',')[0].trim();
  const letters = place.replace(/[^A-Za-z\u00C0-\u017F]/g, '');
  const upper = letters.replace(/[^A-Z\u00C0-\u00DE]/g, '').length;
  return letters.length >= 3 && upper / letters.length >= 0.7 ? src.slice(lead.length) : src;
}

export function applyTags(rec) {
  const topicCorpus = [rec.title, rec.summary, rec.text || '', (rec.categories || []).join(' ')].join('\n');
  const placeCorpus = [rec.title, stripDateline(rec.summary), stripDateline(rec.text || ''), (rec.categories || []).join(' ')].join('\n');
  rec.tags = {
    topics: tagTopics(topicCorpus).map(t => t.topic),
    places: tagPlaces(placeCorpus).map(p => p.key),
    tool: TAGGER_VERSION,
  };
  return rec;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }

export function markSyndication(rec) {
  const feedHost = hostOf(rec.url);
  const canonHost = hostOf(rec.canonicalUrl);
  if (canonHost && feedHost && canonHost !== feedHost && !canonHost.endsWith(`.${feedHost}`) && !feedHost.endsWith(`.${canonHost}`)) {
    rec.syndicated = true;
    rec.wireSource = canonHost;
  }
  return rec;
}

// Merge new records into the store: dedupe on id, refresh mutable fields, assign clusters.
export function mergeIntoStore(store, records) {
  const byId = new Map(store.map(r => [r.id, r]));
  const byCanonical = new Map(store.filter(r => r.canonicalUrl).map(r => [r.canonicalUrl, r]));
  const byTitle = new Map();
  for (const r of store) { const k = titleKey(r.title); if (k && !byTitle.has(k)) byTitle.set(k, r); }
  let added = 0, updated = 0;
  for (const rec of records) {
    const existing = byId.get(rec.id) || (rec.canonicalUrl && byCanonical.get(rec.canonicalUrl) && byCanonical.get(rec.canonicalUrl).sourceId === rec.sourceId ? byCanonical.get(rec.canonicalUrl) : null);
    if (existing) {
      if (existing.contentHash !== rec.contentHash || (!existing.text && rec.text)) {
        Object.assign(existing, rec, { id: existing.id, collectedAt: existing.collectedAt, updatedAt: rec.collectedAt, clusterId: existing.clusterId });
        updated++;
      }
      continue;
    }
    const tk = titleKey(rec.title);
    const twin = tk ? byTitle.get(tk) : null;
    rec.clusterId = twin ? (twin.clusterId || twin.id) : rec.id;
    if (twin && !twin.clusterId) twin.clusterId = twin.id;
    store.push(rec);
    byId.set(rec.id, rec);
    if (rec.canonicalUrl) byCanonical.set(rec.canonicalUrl, rec);
    if (tk && !byTitle.has(tk)) byTitle.set(tk, rec);
    added++;
  }
  return { added, updated };
}

export function pruneStore(store, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const kept = store.filter(r => new Date(r.publishedAt || r.collectedAt).getTime() >= cutoff);
  kept.sort((a, b) => new Date(b.publishedAt || b.collectedAt) - new Date(a.publishedAt || a.collectedAt));
  return kept.slice(0, MAX_STORE);
}

const MIN_BASELINE_DAYS = 3;

// How many days of history precede the 24h comparison window. Spikes are meaningless
// on a cold store (everything looks new), so detection waits for MIN_BASELINE_DAYS.
export function baselineCoverage(store, now = Date.now()) {
  let oldest = Infinity;
  for (const r of store) {
    const t = new Date(r.publishedAt || r.collectedAt).getTime();
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  const days = Number.isFinite(oldest) ? Math.max(0, (now - 86_400_000 - oldest) / 86_400_000) : 0;
  return { days: Number(Math.min(days, 30).toFixed(1)), ready: days >= MIN_BASELINE_DAYS, minDays: MIN_BASELINE_DAYS };
}

// Mention-baseline spike detection per (place, topic): last 24h count vs trailing
// 30-day daily mean (excluding the last 24h). Every flag links its evidence articles.
export function detectSpikes(store, now = Date.now(), { minCount = 3, ratio = 3 } = {}) {
  const coverage = baselineCoverage(store, now);
  if (!coverage.ready) return [];
  const baselineDays = Math.max(1, Math.min(30, coverage.days));
  const dayMs = 86_400_000;
  const recentCut = now - dayMs;
  const baseCut = now - 31 * dayMs;
  const recent = new Map(); // key -> [ids]
  const base = new Map();   // key -> count
  for (const r of store) {
    const t = new Date(r.publishedAt || r.collectedAt).getTime();
    if (!Number.isFinite(t) || t < baseCut || t > now + dayMs) continue;
    const topics = r.tags?.topics?.length ? r.tags.topics : ['any'];
    for (const p of r.tags?.places || []) {
      for (const topic of topics) {
        const k = `${p}|${topic}`;
        if (t >= recentCut) { if (!recent.has(k)) recent.set(k, []); recent.get(k).push(r.id); }
        else base.set(k, (base.get(k) || 0) + 1);
      }
    }
  }
  const flags = [];
  for (const [k, ids] of recent) {
    const count = ids.length;
    if (count < minCount) continue;
    const mean = (base.get(k) || 0) / baselineDays;
    if (mean > 0 && count < mean * ratio) continue;
    const [placeKey, topic] = k.split('|');
    const place = PLACE_BY_KEY.get(placeKey);
    flags.push({
      place: placeKey, placeName: place?.name || placeKey, sector: place?.sector || null, lat: place?.lat, lon: place?.lon,
      topic, count24h: count, baselineDays, baselineDailyMean: Number(mean.toFixed(2)),
      ratio: mean > 0 ? Number((count / mean).toFixed(1)) : null,
      articleIds: ids.slice(0, 10),
      rule: `count24h>=${minCount} && count24h>=${ratio}x trailing ${baselineDays}d daily mean`,
    });
  }
  flags.sort((a, b) => (b.ratio ?? Infinity) - (a.ratio ?? Infinity) || b.count24h - a.count24h);
  return flags;
}

export function summarizeStore(store, now = Date.now(), windowDays = 30) {
  const cut = now - windowDays * 86_400_000;
  const topicCounts = Object.fromEntries(TOPIC_KEYS.map(k => [k, 0]));
  const placeCounts = new Map();
  const outletCounts = {};
  let inWindow = 0;
  for (const r of store) {
    const t = new Date(r.publishedAt || r.collectedAt).getTime();
    if (!Number.isFinite(t) || t < cut) continue;
    inWindow++;
    outletCounts[r.outlet] = (outletCounts[r.outlet] || 0) + 1;
    for (const tp of r.tags?.topics || []) if (tp in topicCounts) topicCounts[tp]++;
    for (const pk of r.tags?.places || []) placeCounts.set(pk, (placeCounts.get(pk) || 0) + 1);
  }
  const places = [...placeCounts].map(([key, count]) => {
    const p = PLACE_BY_KEY.get(key);
    return { key, name: p?.name || key, country: p?.country, sector: p?.sector, lat: p?.lat, lon: p?.lon, count };
  }).sort((a, b) => b.count - a.count);
  return { windowDays, articlesInWindow: inWindow, topicCounts, places, outletCounts };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function readJson(file, dflt) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt; } catch { return dflt; }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
}

function saveRaw(dataDir, hash, ext, body) {
  const dir = join(dataDir, 'raw');
  mkdirSync(dir, { recursive: true });
  const name = `${hash}.${ext}`;
  const file = join(dir, name);
  if (!existsSync(file)) writeFileSync(file, body);
  // bounded on-disk footprint: drop the oldest snapshots beyond the cap
  try {
    const files = readdirSync(dir).map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { f } of files.slice(0, Math.max(0, files.length - MAX_RAW_FILES))) unlinkSync(join(dir, f));
  } catch { /* best effort */ }
  return `raw/${name}`;
}

const _lastHit = new Map();
async function politeWait(host, delayMs) {
  const last = _lastHit.get(host) || 0;
  const wait = last + delayMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastHit.set(host, Date.now());
}

async function timedFetch(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
  } finally { clearTimeout(timer); }
}

export function classifyHttp(status) {
  if (status === 304) return 'not_modified';
  if (status === 401 || status === 403 || status === 406 || status === 429 || status === 451) return 'blocked';
  if (status >= 200 && status < 300) return 'ok';
  return 'error';
}

// Poll one feed with conditional headers. Never throws.
export async function pollFeed(source, feedState, fetchImpl = safeOutboundFetch, { politeDelayMs = POLITE_DELAY_MS } = {}) {
  const host = hostOf(source.feedUrl);
  const polledAt = new Date().toISOString();
  try {
    await politeWait(host, politeDelayMs);
    const res = await timedFetch(fetchImpl, source.feedUrl, conditionalHeaders(feedState), FEED_TIMEOUT_MS);
    const kind = classifyHttp(res.status);
    if (kind === 'not_modified') return { status: 'not_modified', httpStatus: 304, items: [], etag: feedState?.etag || null, lastModified: feedState?.lastModified || null, polledAt };
    if (kind !== 'ok') return { status: kind, httpStatus: res.status, items: [], etag: feedState?.etag || null, lastModified: feedState?.lastModified || null, polledAt, reason: `HTTP ${res.status}` };
    const body = await res.text();
    const items = parseFeed(body);
    const meta = feedMeta(body);
    if (!items.length) return { status: 'empty', httpStatus: res.status, items: [], etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), polledAt, reason: /<(rss|feed|urlset)\b/i.test(body) ? 'feed has no items' : 'not a feed', feedTitle: meta.title, bytes: body.length };
    return { status: 'ok', httpStatus: res.status, items, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), polledAt, feedTitle: meta.title, feedUpdated: meta.updated, bytes: body.length };
  } catch (e) {
    return { status: 'error', httpStatus: null, items: [], etag: feedState?.etag || null, lastModified: feedState?.lastModified || null, polledAt, reason: /abort/i.test(e?.name || e?.message) ? 'timed out' : (e?.message || 'fetch failed').slice(0, 120) };
  }
}

// Retrieve the text-of-record for one item: public WP REST API first (an API, not
// scraping), then the article page. Respects robots.txt; marks paywalls; never bypasses.
export async function enrichArticle(rec, source, fetchImpl = fetch, { dataDir = null, politeDelayMs = POLITE_DELAY_MS } = {}) {
  const fetchedAt = new Date().toISOString();
  const finish = (method, fetchStatus, extra = {}) => {
    rec.extraction = { method, fetchStatus, fetchedAt, rawSnapshot: extra.rawSnapshot || null, ...(extra.httpStatus ? { httpStatus: extra.httpStatus } : {}) };
    if (rec.text) {
      rec.textChars = rec.text.length;
      rec.contentHash = sha256(rec.text);
      if (fetchStatus === 'ok') rec.paywalled = false;
    }
    markSyndication(rec);
    return rec;
  };

  const postId = source.articleApi === 'wp-rest' ? wpPostId(rec.guid) : null;
  const apiBase = source.articleApiBase || (rec.url ? new URL(rec.url).origin : null) || new URL(source.feedUrl).origin;
  if (postId && apiBase) {
    const apiUrl = `${apiBase}/wp-json/wp/v2/posts/${postId}?_fields=id,date_gmt,modified_gmt,link,title,excerpt,content,yoast_head_json.canonical`;
    const robots = await checkRobots(apiUrl, { fetch: fetchImpl });
    if (!robots.allowed) return finish('feed-description', 'robots-disallowed');
    try {
      await politeWait(hostOf(apiUrl), Math.max(politeDelayMs, (robots.crawlDelay || 0) * 1000));
      const res = await timedFetch(fetchImpl, apiUrl, { 'User-Agent': CRAWLER_UA, Accept: 'application/json' }, ARTICLE_TIMEOUT_MS);
      if (res.ok) {
        const body = await res.text();
        let post;
        try { post = JSON.parse(body); } catch { post = null; }
        const rendered = post?.content?.rendered;
        if (post && typeof rendered === 'string' && rendered.trim()) {
          const paragraphs = bodyParagraphs(htmlToText(rendered), { minLen: 1 });
          rec.text = paragraphs.join('\n\n').slice(0, MAX_TEXT_CHARS);
          if (post.link) rec.canonicalUrl = normalizeUrl(post.link) || rec.canonicalUrl;
          if (post.yoast_head_json?.canonical) rec.canonicalUrl = normalizeUrl(post.yoast_head_json.canonical) || rec.canonicalUrl;
          if (post.content?.protected === true) { rec.paywalled = true; }
          if (post.date_gmt && !rec.publishedAt) rec.publishedAt = new Date(post.date_gmt + 'Z').toISOString();
          const raw = dataDir ? saveRaw(dataDir, sha256(body), 'json', body) : null;
          return finish('wp-rest', 'ok', { rawSnapshot: raw, httpStatus: res.status });
        }
      }
      if (classifyHttp(res.status) === 'blocked') return finish('feed-description', `blocked (${res.status})`, { httpStatus: res.status });
    } catch (e) {
      if (/abort/i.test(e?.name || '')) return finish('feed-description', 'timed out');
    }
  }

  if (!rec.url) return finish('feed-description', 'no url');
  const robots = await checkRobots(rec.url, { fetch: fetchImpl });
  if (!robots.allowed) return finish('feed-description', 'robots-disallowed');
  try {
    await politeWait(hostOf(rec.url), Math.max(politeDelayMs, (robots.crawlDelay || 0) * 1000));
    const res = await timedFetch(fetchImpl, rec.url, { 'User-Agent': CRAWLER_UA, Accept: 'text/html,application/xhtml+xml' }, ARTICLE_TIMEOUT_MS);
    const kind = classifyHttp(res.status);
    if (kind !== 'ok') return finish('feed-description', kind === 'blocked' ? `blocked (${res.status})` : `HTTP ${res.status}`, { httpStatus: res.status });
    const html = await res.text();
    const finalUrl = normalizeUrl(res.url) || rec.url;
    const art = extractArticle(html);
    rec.canonicalUrl = normalizeUrl(art.canonical) || finalUrl;
    if (art.paywalled) {
      rec.paywalled = true;
      return finish('feed-description', 'paywalled', { httpStatus: res.status });
    }
    if (art.text && art.text.length >= 200) {
      rec.text = art.text.slice(0, MAX_TEXT_CHARS);
      const raw = dataDir ? saveRaw(dataDir, sha256(html), 'html', html) : null;
      return finish(`page:${art.method}`, 'ok', { rawSnapshot: raw, httpStatus: res.status });
    }
    return finish('feed-description', 'no extractable body', { httpStatus: res.status });
  } catch (e) {
    return finish('feed-description', /abort/i.test(e?.name || '') ? 'timed out' : 'fetch failed');
  }
}

// Redact bulky fields for the sweep payload; the store on disk keeps full text.
function publicRecord(r) {
  const { text, ...rest } = r;
  return { ...rest, excerpt: text ? text.slice(0, 280) : null };
}

// ---------------------------------------------------------------------------
// Sweep entry point
// ---------------------------------------------------------------------------

export async function briefing(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const now = opts.now || Date.now();
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const persist = opts.persist !== false;
  const fetchArticles = opts.fetchArticles ?? FETCH_ARTICLES;
  const maxFetch = opts.maxArticleFetch ?? MAX_ARTICLE_FETCH_PER_FEED;
  const politeDelayMs = opts.politeDelayMs ?? POLITE_DELAY_MS;
  const enrichBudgetMs = opts.enrichBudgetMs ?? ENRICH_BUDGET_MS;
  const startedAt = Date.now();
  const collectedAt = new Date(now).toISOString();

  let registry;
  try { registry = opts.registry || loadRegistry(opts.registryFile); }
  catch (e) {
    return { source: 'BorderNews', timestamp: collectedAt, status: 'error', error: `registry invalid: ${e.message}`, pipelineVersion: PIPELINE_VERSION };
  }

  const state = readJson(join(dataDir, 'state.json'), { feeds: {} });
  let store = readJson(join(dataDir, 'articles.json'), []);
  if (!Array.isArray(store)) store = [];
  let retagged = 0;
  for (const rec of store) {
    if (rec?.tags?.tool !== TAGGER_VERSION) { applyTags(rec); retagged++; }
  }

  const feedReports = [];
  const newRecords = [];

  await Promise.all(registry.map(async (source) => {
    const prev = state.feeds[source.id] || {};
    const poll = await pollFeed(source, prev, fetchImpl, { politeDelayMs });
    const report = {
      id: source.id, outlet: source.outlet, feedUrl: source.feedUrl, reliability: source.reliability,
      status: poll.status, httpStatus: poll.httpStatus, reason: poll.reason || null,
      feedType: source.feedType || 'rss', fetchArticles: source.fetchArticles !== false, items: poll.items.length, newItems: 0, filteredOut: 0, etag: poll.etag || null, lastModified: poll.lastModified || null,
      lastPolled: poll.polledAt, lastChanged: poll.status === 'ok' ? poll.polledAt : (prev.lastChanged || null),
      articleFetch: { attempted: 0, ok: 0, blocked: 0, robotsDisallowed: 0, paywalled: 0, skipped: 0, backlog: 0, other: 0 },
    };
    state.feeds[source.id] = { etag: report.etag, lastModified: report.lastModified, lastPolled: report.lastPolled, lastStatus: report.status, lastChanged: report.lastChanged, feedTitle: poll.feedTitle || prev.feedTitle || null };

    let fetched = 0;
    const enrich = async (rec) => {
      fetched++;
      report.articleFetch.attempted++;
      await enrichArticle(rec, source, fetchImpl, { dataDir: persist ? dataDir : null, politeDelayMs });
      const fs = rec.extraction.fetchStatus;
      if (fs === 'ok') report.articleFetch.ok++;
      else if (fs.startsWith('blocked')) report.articleFetch.blocked++;
      else if (fs === 'robots-disallowed') report.articleFetch.robotsDisallowed++;
      else if (fs === 'paywalled') report.articleFetch.paywalled++;
      else report.articleFetch.other++;
      applyTags(rec);
      markSyndication(rec);
    };
    const sourceFetch = fetchArticles && source.fetchArticles !== false;
    const canFetch = () => sourceFetch && fetched < maxFetch && (Date.now() - startedAt) < enrichBudgetMs;

    if (poll.status === 'ok') {
      const knownIds = new Set(store.map(r => r.id));
      const fresh = [];
      for (const item of poll.items) {
        if (!matchesPathPrefixes(item.link, source.pathPrefixes)) { report.filteredOut++; continue; }
        const rec = normalizeItem(item, source, collectedAt);
        if (knownIds.has(rec.id)) continue;
        // National outlets opt in to a place gate: only headlines/keywords naming a border place are kept.
        if (source.requirePlaceTag && !applyTags(rec).tags.places.length) { report.filteredOut++; continue; }
        fresh.push(rec);
      }
      report.newItems = fresh.length;
      for (const rec of fresh) {
        if (rec.text) {
          rec.extraction.fetchStatus = 'not needed (full text in feed)';
          applyTags(rec);
          markSyndication(rec);
        } else if (canFetch()) {
          await enrich(rec);
        } else {
          rec.extraction.fetchStatus = !fetchArticles ? 'disabled (BORDER_FETCH_ARTICLES=false)' : !sourceFetch ? 'disabled (source policy: feed metadata only)' : 'skipped (per-sweep cap)';
          if (sourceFetch) report.articleFetch.skipped++;
          applyTags(rec);
          markSyndication(rec);
        }
        newRecords.push(rec);
      }
    }

    // Catch-up: records skipped by an earlier sweep's cap are enriched with the spare
    // budget of this one, so the backlog drains over successive polls.
    if (poll.status === 'ok' || poll.status === 'not_modified' || poll.status === 'empty') {
      const backlog = store.filter(r => r.sourceId === source.id && r.extraction?.fetchStatus?.startsWith('skipped'));
      for (const rec of backlog) {
        if (!canFetch()) break;
        await enrich(rec);
        report.articleFetch.backlog++;
        rec.updatedAt = collectedAt;
      }
    }
    feedReports.push(report);
  }));

  const merge = mergeIntoStore(store, newRecords);
  store = pruneStore(store, now);
  if (persist) {
    writeJson(join(dataDir, 'articles.json'), store);
    writeJson(join(dataDir, 'state.json'), state);
  }

  const summary = summarizeStore(store, now, 30);
  const baseline = baselineCoverage(store, now);
  const spikes = detectSpikes(store, now);
  const okFeeds = feedReports.filter(f => ['ok', 'not_modified', 'empty'].includes(f.status)).length;
  const failedFeeds = feedReports.filter(f => f.status === 'error' || f.status === 'blocked');

  let status = 'live';
  let error;
  if (feedReports.length && okFeeds === 0) {
    status = store.length ? 'stale' : 'error';
    if (!store.length) error = `all feeds failed: ${failedFeeds.map(f => `${f.outlet} ${f.reason}`).join('; ')}`;
  } else if (failedFeeds.length) {
    status = 'partial';
  } else if (!store.length) {
    status = 'empty';
  }

  feedReports.sort((a, b) => a.outlet.localeCompare(b.outlet));
  const recent = [...store].sort((a, b) => new Date(b.publishedAt || b.collectedAt) - new Date(a.publishedAt || a.collectedAt)).slice(0, RECENT_LIMIT).map(publicRecord);

  return {
    source: 'BorderNews',
    timestamp: collectedAt,
    status,
    ...(error ? { error } : {}),
    ...(status === 'stale' ? { stale: true, note: `no feed reachable this sweep; showing ${store.length} stored articles` } : {}),
    pipelineVersion: PIPELINE_VERSION,
    taggerVersion: TAGGER_VERSION,
    feeds: feedReports,
    totalArticles: store.length,
    newThisSweep: merge.added,
    updatedThisSweep: merge.updated,
    retaggedThisSweep: retagged,
    articles: recent,
    summary,
    baseline,
    spikes,
    registry: registry.map(s => ({ id: s.id, outlet: s.outlet, feedUrl: s.feedUrl, feedType: s.feedType || 'rss', language: s.language, countryOfPublication: s.countryOfPublication, regionTag: s.regionTag, reliability: s.reliability, discoveryDate: s.discoveryDate, paywall: Boolean(s.paywall), fetchArticles: s.fetchArticles !== false, requirePlaceTag: Boolean(s.requirePlaceTag) })),
  };
}

// Query stored articles (used by /api/border/articles). Filters are pre-validated by the caller.
export function queryArticles({ place = null, topic = null, days = 30, outlet = null, limit = 100 } = {}, { dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  const store = readJson(join(dataDir, 'articles.json'), []);
  const cut = now - days * 86_400_000;
  const out = [];
  for (const r of Array.isArray(store) ? store : []) {
    const t = new Date(r.publishedAt || r.collectedAt).getTime();
    if (!Number.isFinite(t) || t < cut) continue;
    if (place && !(r.tags?.places || []).includes(place)) continue;
    if (topic && !(r.tags?.topics || []).includes(topic)) continue;
    if (outlet && r.sourceId !== outlet) continue;
    out.push(publicRecord(r));
  }
  out.sort((a, b) => new Date(b.publishedAt || b.collectedAt) - new Date(a.publishedAt || a.collectedAt));
  return { count: out.length, filters: { place, topic, days, outlet }, articles: out.slice(0, limit) };
}

export function resetForTests() { _lastHit.clear(); }
