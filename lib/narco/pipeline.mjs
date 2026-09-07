// Narco event pipeline: Border Watch articles + DOJ prosecutions -> normalized events -> incident clusters
// with corroboration grades and OFAC SDN matches. Runs post-sweep in the server; pure functions here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadGazetteer, stateName } from './gazetteer.mjs';
import { loadGroups } from './groups.mjs';
import { normalizeEvent, clusterEvents, CONFIDENCE } from './events.mjs';
import { llmEnrichRecords } from './llm.mjs';
import { EVENT_TYPE_LABELS } from './extract.mjs';
import { DEFAULT_DATA_DIR as BORDER_DIR } from '../../apis/sources/bordernews.mjs';
import { DEFAULT_DATA_DIR as DOJ_DIR, loadReleases, DISTRICTS } from '../../apis/sources/doj.mjs';
import { DEFAULT_DATA_DIR as OFAC_DIR, loadIndex, buildNameIndex, matchNames, groupDesignations } from '../../apis/sources/ofacnarco.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = join(__dirname, '../../runs/narco');
export const PIPELINE_SCHEMA = 'narco-pipeline/1';
const WINDOW_DAYS = 90;
const CURRENT_DAYS = 30;
const MAX_CLUSTERS = 400;

function readJson(file, dflt) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt; } catch { return dflt; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

// Organised-crime / border-security vocabulary; an article needs one of these on top of a Mexico cue.
const CRIME_RE = /\b(?:cartel|c[aá]rtel(?:es)?|sicario|narco\w*|fentanyl|fentanilo|metanfetamina|methamphetamine|cocaine|coca[ií]na|hero[ií]n|traffick\w*|smuggl\w*|tunnel|t[uú]nel|extortion|extorsi[oó]n|kidnap\w*|secuestr\w*|homicid\w*|massacre|masacre|shootout|gunmen|gunfight|enfrentamiento|ejecutad\w*|asesinad\w*|cuerpos? (?:sin vida|desmembrad\w*|calcinad\w*|hallad\w*|encontrad\w*|abandonad\w*)|(?:dead |\d+ |several |multiple |dozens? of |dismembered |burned )bodies|bodies (?:were |was )?(?:found|dumped|discovered|recovered|left)|indict\w*|sentenced|pleaded guilty|prosecut\w*|extradit\w*|sanction\w*|OFAC|money laundering|lavado|weapons|firearms|armas|seizure|aseguramiento|decomiso|arrest\w*|detenid\w*|captur\w*|CJNG|CDS|CDN|Zetas|Chapitos|Mayos|Mencho|fuerzas? armadas?|Guardia Nacional|Sedena|SEMAR|FGR|Fiscal[ií]a|blockade|bloqueo|narcobloqueo|drug lab|laboratorio)\b/i;
const MEXICO_RE = /\bm[eé]xic|\bcartel|\bc[aá]rtel|\bsicario|\bnarco|\bcjng\b|\bsinaloa\b|\bju[aá]rez\b|\btijuana\b|\breynosa\b|\bmatamoros\b|\bnuevo laredo\b|\bnogales\b|\bmichoac[aá]n\b|\bjalisco\b|\bzacatecas\b|\btamaulipas\b|\bchihuahua\b|\bsonora\b|\bguanajuato\b|\bculiac[aá]n\b|\bmexicali\b/i;

const NARCO_SIGNAL_RE = /\b(?:cartel|narco\w*|fentanyl|methamphetamine|cocaine|heroin|marijuana|narcotic\w*|drug\w*|alien smuggl\w*|human smuggl\w*|migrant\w*|bulk cash|tunnel)\b/i;

// Border Watch article -> pipeline document. Only Mexico-relevant items with an organised-crime or
// border-security angle become events; the rest of the border press (US politics, local government,
// culture) is left to the Border Watch panel. Citizen-aggregator posts are cartel coverage by charter.
export function isNarcoRelevant(a) {
  const body = `${a.title || ''}\n${a.text || a.summary || ''}`;
  const crime = CRIME_RE.test(body);
  if (a.sourceType === 'citizen-aggregator') return crime;
  return crime && MEXICO_RE.test(body);
}

// Second gate on the normalized record: mainstream border coverage must resolve to Mexico or name a group;
// DOJ releases and citizen-aggregator posts are in scope by construction.
export function isNarcoEvent(rec) {
  if (rec.sourceId === 'doj') {
    // A release matched only as generic "smuggling" (export controls, pesticides, wildlife) is a DOJ-panel
    // item, not a narco event, unless the text itself carries a drug/cartel/Mexico signal.
    const cats = rec.provenance?.categories || [];
    if (cats.some(c => c !== 'smugglers')) return true;
    return rec.cartels.length > 0 || rec.location?.country === 'MX' || NARCO_SIGNAL_RE.test(`${rec.title}\n${rec.excerpt || ''}`);
  }
  if (rec.sourceType === 'citizen-aggregator') return true;
  return rec.location?.country === 'MX' || rec.cartels.length > 0 || rec.factions.length > 0;
}

export function borderDocs(articles, { gz, groups }) {
  const out = [];
  for (const a of Array.isArray(articles) ? articles : []) {
    if (!isNarcoRelevant(a)) continue;
    out.push({
      id: a.id, sourceId: a.sourceId, outlet: a.outlet, sourceType: a.sourceType || 'news-outlet', url: a.canonicalUrl || a.url || null,
      title: a.title, text: a.text || null, summary: a.summary || null, rawHtml: null, publishedAt: a.publishedAt || a.collectedAt || null,
      collectedAt: a.collectedAt || null, wireSource: a.wireSource || null, syndicated: Boolean(a.syndicated), language: a.language || 'en',
      extra: { kind: 'article', reliability: a.reliability || null, topics: a.tags?.topics || [] },
    });
  }
  void gz; void groups;
  return out;
}

// DOJ release -> pipeline document. Anchored to the district seat when no Mexican place is named.
export function dojDocs(releases) {
  return (releases || []).map(r => {
    const d = DISTRICTS.find(x => x.code === r.district.code);
    return {
      id: r.id, sourceId: 'doj', outlet: `DOJ · ${r.district.name}`, sourceType: 'government', url: r.url,
      title: r.title, text: r.body || null, summary: r.teaser || null, rawHtml: null, publishedAt: r.publishedAt, collectedAt: r.collectedAt,
      wireSource: null, syndicated: false, language: 'en',
      fallbackLocation: d ? { country: 'US', precision: 'district', name: d.seat, adm1: null, state: d.state, city: r.dateline?.city || null, lat: d.lat, lon: d.lon } : null,
      extra: { kind: 'prosecution', district: r.district, categories: r.categories, topics: r.topics, number: r.number },
    };
  });
}

function attachSanctions(clusters, ofacIndex) {
  if (!ofacIndex) return { clusters, matches: 0 };
  const nameIdx = buildNameIndex(ofacIndex);
  const desig = groupDesignations(ofacIndex);
  let matches = 0;
  const out = clusters.map(c => {
    const people = matchNames(c.people.map(p => p.name), ofacIndex, nameIdx);
    const groups = [...new Set([...c.cartels, ...c.factions].map(g => g.orgId))].flatMap(id => (desig[id] || []).map(e => ({ orgId: id, ...e })));
    matches += people.length;
    return { ...c, sanctions: { people, groups: groups.slice(0, 8) } };
  });
  return { clusters: out, matches };
}

function tally(list, key) {
  const m = {};
  for (const x of list) { const k = key(x); if (k == null) continue; m[k] = (m[k] || 0) + 1; }
  return m;
}

export async function computeNarcoEvents({
  borderDataDir = BORDER_DIR, dojDataDir = DOJ_DIR, ofacDataDir = OFAC_DIR, outDir = DEFAULT_OUT_DIR,
  now = Date.now(), persist = true, llmProvider = null, llmEnabled, gz = loadGazetteer(), groups = loadGroups(),
} = {}) {
  const started = Date.now();
  const cut = now - WINDOW_DAYS * 86_400_000;
  const articles = readJson(join(borderDataDir, 'articles.json'), []);
  const docs = [
    ...borderDocs(articles, { gz, groups }),
    ...dojDocs(loadReleases({ dataDir: dojDataDir, days: WINDOW_DAYS, now })),
  ].filter(d => { const t = new Date(d.publishedAt || d.collectedAt || 0).getTime(); return Number.isFinite(t) && t >= cut; });

  const docsById = new Map(docs.map(d => [d.id, d]));
  let records = docs.map(d => {
    const rec = normalizeEvent(d, { gz, groups });
    if (!rec.location && d.fallbackLocation) rec.location = d.fallbackLocation;
    return rec;
  }).filter(isNarcoEvent);
  const llm = await llmEnrichRecords(llmProvider, records, docsById, { ...(llmEnabled === undefined ? {} : { enabled: llmEnabled }), gz, groups });
  records = llm.records;

  const ofacIndex = loadIndex(ofacDataDir);
  const clustered = attachSanctions(clusterEvents(records), ofacIndex);
  const clusters = clustered.clusters.slice(0, MAX_CLUSTERS);
  const currentCut = new Date(now - CURRENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const current = clusters.filter(c => c.date && c.date >= currentCut);

  const out = {
    schema: PIPELINE_SCHEMA,
    computedAt: new Date(now).toISOString(),
    durationMs: Date.now() - started,
    windowDays: WINDOW_DAYS,
    currentDays: CURRENT_DAYS,
    inputs: {
      articles: Array.isArray(articles) ? articles.length : 0,
      mexicoRelevantArticles: docs.filter(d => d.sourceId !== 'doj').length,
      dojReleases: docs.filter(d => d.sourceId === 'doj').length,
      ofacIndexed: ofacIndex ? ofacIndex.entries.length : 0,
      ofacPublishDate: ofacIndex?.publishDate || null,
    },
    llm: { used: llm.used, errors: llm.errors, skipped: llm.skipped || null },
    records: records.length,
    clusters,
    totals: {
      clusters: clusters.length,
      current: current.length,
      historical: clusters.length - current.length,
      byGrade: tally(clusters, c => c.confidence.grade),
      byType: tally(clusters, c => c.eventType),
      byState: tally(clusters, c => (c.location?.adm1 ? stateName(c.location.adm1, gz) : (c.location?.country === 'US' ? `US · ${c.location.state}` : null))),
      byCartel: tally(clusters.flatMap(c => c.cartels), g => g.orgId),
      sanctionsMatches: clustered.matches,
      mapped: clusters.filter(c => c.location?.lat != null).length,
    },
    legend: { confidence: CONFIDENCE, eventTypes: EVENT_TYPE_LABELS },
  };
  if (persist) writeJson(join(outDir, 'events.json'), out);
  return out;
}

export function loadNarcoEvents(outDir = DEFAULT_OUT_DIR) {
  const d = readJson(join(outDir, 'events.json'), null);
  return d && d.schema === PIPELINE_SCHEMA ? d : null;
}
