// CJNG knowledge graph: entities and typed relations extracted from InSight Crime's CJNG reporting.
//
// Input is the corpus written by ./corpus.mjs. Every article is run through the existing narco extractors
// (cartel/faction gazetteer, person-name extractor, Mexican place gazetteer, event classifier), then each
// sentence that names two entities is tested against relation cue patterns. A typed edge (leader_of,
// rival_of, operates_in, ...) is only created when a cue word appears in the same sentence as both
// entities; otherwise the pair falls back to a plain `mentioned_with` co-mention edge. Every edge keeps
// verbatim evidence sentences with the article id and date, so nothing in the graph is unsourced.
//
// This is machine extraction from published journalism: relations are "as reported by InSight Crime",
// not verified ground truth, and the rule set will miss relations phrased in ways the cues do not cover.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fold, findPlaces, loadGazetteer, stateName } from '../narco/gazetteer.mjs';
import { findGroups, loadGroups, maskGroupNames } from '../narco/groups.mjs';
import { classifyEvent, extractCounts, extractPeople, EVENT_TYPE_LABELS } from '../narco/extract.mjs';
import { GIVEN_NAMES, SURNAMES_SET } from '../narco/names.mjs';
import { DEFAULT_DATA_DIR, isCjngFocused } from './corpus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const GRAPH_SCHEMA = 'cjng-graph/1';
export const EXTRACTOR_VERSION = 'cjng-rules/1';
export const ROOT_ORG = 'cjng';
export const ROOT_NODE = `org:${ROOT_ORG}`;
export const SNAPSHOT_FILE = join(__dirname, '../../config/cjng-graph-snapshot.json.gz');

const MAX_NODES = 400;
const MAX_EDGES = 1500;
const MAX_EVIDENCE = 3;
const MAX_SENTENCE = 300;
const MAX_LABEL = 120;
const MAX_ARTICLES = 800;
const MAX_PERSON_EVENTS = 12;
const MIN_PERSON_ARTICLES = 2;   // a person named in a single article with no typed relation is noise

export const RELATIONS = {
  leader_of: { label: 'leader of', directed: true, typed: true },
  member_of: { label: 'member / operative of', directed: true, typed: true },
  family_of: { label: 'family of', directed: false, typed: true },
  rival_of: { label: 'rival of / fights', directed: false, typed: true },
  allied_with: { label: 'allied with / works with', directed: false, typed: true },
  lineage: { label: 'splinter / offshoot / origin', directed: false, typed: true },
  operates_in: { label: 'operates in / presence', directed: true, typed: true },
  linked_topic: { label: 'reported alongside (InSight Crime tag)', directed: true, typed: false },
  mentioned_with: { label: 'co-mentioned in the same sentence', directed: false, typed: false },
};
export const NODE_TYPES = ['org', 'faction', 'person', 'place', 'country', 'topic'];

// --- relation cues (English + the Spanish terms InSight Crime leaves untranslated) ---
const LEADER_RE = /\b(?:leaders?|leadership|head(?:s|ed)?|boss(?:es)?|founders?|founded|co-?founder|commanders?|kingpin|led by|runs|ran|in charge|second[- ]in[- ]command|number two|right[- ]hand|top (?:leader|boss|commander|lieutenant)|plaza boss|regional (?:leader|boss|chief)|jefe|l[ií]der|cabecilla|capo|top (?:brass|figure))\b/i;
const MEMBER_RE = /\b(?:members?|operatives?|operators?|sicarios?|hitm[ae]n|gunm[ae]n|cells?|lieutenants?|financial (?:operator|chief)|money launderer|accountant|associates?|linked to|ties? to|tied to|affiliated|works? for|working for|worked for|on behalf of|belong(?:s|ed|ing)? to|recruit(?:ed|s)?|enforcer|spokesm[ae]n|logistics|emissary|representative|pilot|chemist|cook|armed wing|hired)\b/i;
const FAMILY_RE = /\b(?:brothers?|sisters?|sons?|daughters?|wife|husband|nephews?|nieces?|father|mother|cousins?|in-law|brother-in-law|sister-in-law|son-in-law|father-in-law|girlfriend|boyfriend|relatives?|family|married|widow)\b/i;
const RIVAL_RE = /\b(?:rivals?|rivalry|compet\w+|war(?:s|ring)?|fight(?:s|ing)?|battl\w+|clash\w*|turf|disput\w+|conflicts?|feud\w*|enem\w+|confront\w+|struggl\w+|attack\w*|ambush\w*|against|versus|vs\.?|expel\w*|push\w* out|wrest\w*|incursions?|invad\w+|contest\w+|kill(?:ed|ing)? (?:members|gunmen|sicarios)|fractur\w+|split with|broke with|betray\w+|hunt\w+|dislodg\w+|challeng\w+)\b/i;
const ALLY_RE = /\b(?:alli\w+|alliance|partner\w*|coalition|joined forces|umbrella|cooperat\w+|collaborat\w+|working (?:with|together|alongside)|work with|backed by|back(?:s|ed|ing)|support\w* (?:from|by|of)|supported|proxy|proxies|outsourc\w+|subcontract\w+|franchis\w+|absorb\w+|merg\w+|pact|truce|agreement|supplier|supplies|suppl(?:y|ied) (?:to|from)|buys? from|sells? to|provid\w+ (?:cocaine|drugs|weapons|protection)|financ\w+ by|protection|armed wing|sub-?group|arm of|wing of|under (?:the )?(?:command|control|umbrella|protection)|answers? to|report\w* to|serves? as)\b/i;
const LINEAGE_RE = /\b(?:splinter\w*|offshoot|breakaway|broke (?:away|off) from|split(?:ting)? (?:from|off)|emerged from|born (?:out )?of|grew out of|remnants? of|successor|formerly|former (?:members?|arm|wing|allies?|cell|partner)|armed wing of|evolv\w+ (?:from|out of)|roots? in|descend\w+|predecessor|renamed|rebrand\w+|once part of|spun off|spin-?off|dissident)\b/i;
const PRESENCE_RE = /\b(?:presence|control(?:s|led|ling)?|operat(?:e|es|ed|ing|ions?)|stronghold|territor\w+|dominat\w+|dominan\w+|expan\w+|based|base of|bases|plaza|hubs?|foothold|took over|take over|taking over|moved into|moving into|arriv\w+|enter(?:ed|ing|s)?|incursions?|fief\w*|bastion|home (?:state|turf|base)|birthplace|headquarter\w*|cent(?:er|re) of operations|corridor|routes?|active in|hold\w* sway|influence|disput\w+|fight\w* (?:for|over)|battl\w+ (?:for|over)|extort\w+|traffick\w+ (?:through|in|from|into)|smuggl\w+ (?:through|in|from|into)|lab(?:s|oratories)? in|produc\w+ in|recruit\w+ in|ports? of|border with|main (?:market|route)|strong in|weak in|absen\w+|lost (?:control|ground)|gain\w+ (?:control|ground)|push\w+ into|spread\w* (?:to|into|across))\b/i;

// Person status events, read from the sentence that names the person.
const PERSON_EVENTS = [
  ['killed', /\b(?:was |were |been |being )?(?:killed|shot dead|shot and killed|gunned down|murdered|assassinated|slain|died|death of|found dead|executed|beheaded)\b/i],
  ['arrested', /\b(?:arrest(?:ed|s)?|captur(?:ed|e)|detain(?:ed|s)?|apprehend(?:ed|s)?|taken into custody|in custody|surrender(?:ed|s)?|recaptur\w+|nabbed)\b/i],
  ['extradited', /\b(?:extradit(?:ed|ion|e)|handed over to (?:the )?(?:US|U\.S\.|United States)|transferred to (?:the )?(?:US|U\.S\.|United States))\b/i],
  ['sanctioned', /\b(?:sanction(?:ed|s)?|OFAC|designat(?:ed|ion)|Kingpin Act|blacklist\w*|Treasury Department|frozen assets|asset freeze)\b/i],
  ['charged', /\b(?:indict(?:ed|ment)?|charg(?:ed|es)|convict(?:ed|ion)|sentenc(?:ed|e)|pleaded|pled guilty|trial|prosecut\w+|wanted|reward of|reward for|most wanted|warrant)\b/i],
  ['escaped', /\b(?:escap(?:ed|e)|fled|on the run|fugitive|at large|released|freed|walked free|prison break)\b/i],
];

const COUNTRIES = [
  ['US', 'United States', /\b(?:United States|U\.S\.A?|US(?=[\s,.;:)])|American authorities|Washington|Texas|California|Arizona|Chicago|Los Angeles|Houston|New York|Atlanta|San Diego|Nevada|Georgia|Kentucky)\b/],
  ['CO', 'Colombia', /\bColombia\b/], ['EC', 'Ecuador', /\bEcuador\b/], ['GT', 'Guatemala', /\bGuatemala\b/], ['HN', 'Honduras', /\bHonduras\b/],
  ['SV', 'El Salvador', /\bEl Salvador\b/], ['NI', 'Nicaragua', /\bNicaragua\b/], ['CR', 'Costa Rica', /\bCosta Rica\b/], ['PA', 'Panama', /\bPanama\b/],
  ['PE', 'Peru', /\bPeru\b/], ['BO', 'Bolivia', /\bBolivia\b/], ['CL', 'Chile', /\bChile\b/], ['AR', 'Argentina', /\bArgentina\b/], ['BR', 'Brazil', /\bBrazil\b/],
  ['VE', 'Venezuela', /\bVenezuela\b/], ['PY', 'Paraguay', /\bParaguay\b/], ['UY', 'Uruguay', /\bUruguay\b/], ['DO', 'Dominican Republic', /\bDominican Republic\b/],
  ['CA', 'Canada', /\bCanada\b/], ['ES', 'Spain', /\bSpain\b/], ['NL', 'Netherlands', /\bNetherlands|Rotterdam\b/], ['BE', 'Belgium', /\bBelgium|Antwerp\b/],
  ['IT', 'Italy', /\bItaly|'Ndrangheta\b/], ['DE', 'Germany', /\bGermany\b/], ['TR', 'Turkey', /\bTurkey\b/], ['CN', 'China', /\bChina|Chinese\b/],
  ['HK', 'Hong Kong', /\bHong Kong\b/], ['IN', 'India', /\bIndia\b/], ['JP', 'Japan', /\bJapan\b/], ['AU', 'Australia', /\bAustralia\b/],
  ['NZ', 'New Zealand', /\bNew Zealand\b/], ['PH', 'Philippines', /\bPhilippines\b/], ['AE', 'United Arab Emirates', /\bDubai|United Arab Emirates\b/],
  ['GB', 'United Kingdom', /\bUnited Kingdom|Britain|London\b/], ['CU', 'Cuba', /\bCuba\b/], ['HT', 'Haiti', /\bHaiti\b/],
];

// Known aliases collapsed to one person node. Only nicknames InSight Crime consistently ties to one person.
const PERSON_ALIASES = {
  'el mencho': 'Nemesio Oseguera Cervantes', 'nemesio oseguera': 'Nemesio Oseguera Cervantes', 'nemesio ruben oseguera cervantes': 'Nemesio Oseguera Cervantes',
  'nemesio ruben oseguera': 'Nemesio Oseguera Cervantes', 'ruben oseguera cervantes': 'Nemesio Oseguera Cervantes',
  'el menchito': 'Rubén Oseguera González', 'ruben oseguera gonzalez': 'Rubén Oseguera González', 'ruben oseguera': 'Rubén Oseguera González',
  'la jefa': 'Rosalinda González Valencia', 'rosalinda gonzalez': 'Rosalinda González Valencia', 'rosalinda gonzalez valencia': 'Rosalinda González Valencia',
  'el cuini': 'Abigael González Valencia', 'abigael gonzalez valencia': 'Abigael González Valencia', 'abigael gonzalez': 'Abigael González Valencia',
  'el chapo': 'Joaquín Guzmán Loera', 'joaquin guzman loera': 'Joaquín Guzmán Loera', 'joaquin guzman': 'Joaquín Guzmán Loera', 'joaquin el chapo guzman': 'Joaquín Guzmán Loera',
  'el mayo': 'Ismael Zambada García', 'ismael zambada garcia': 'Ismael Zambada García', 'ismael zambada': 'Ismael Zambada García', 'ismael el mayo zambada': 'Ismael Zambada García',
  'el marro': 'José Antonio Yépez Ortiz', 'jose antonio yepez ortiz': 'José Antonio Yépez Ortiz', 'jose antonio yepez': 'José Antonio Yépez Ortiz',
  'el lobo': 'Julio Alberto Castillo Rodríguez', 'el 03': 'Audias Flores Silva', 'el jardinero': 'Audias Flores Silva', 'audias flores silva': 'Audias Flores Silva',
  'el rr': 'Ricardo Ruiz Velasco', 'ricardo ruiz velasco': 'Ricardo Ruiz Velasco', 'el doble r': 'Ricardo Ruiz Velasco',
  'la tuta': 'Servando Gómez Martínez', 'servando gomez martinez': 'Servando Gómez Martínez', 'servando gomez': 'Servando Gómez Martínez',
  'el abuelo': 'Juan José Farías Álvarez', 'juan jose farias alvarez': 'Juan José Farías Álvarez', 'juan jose farias': 'Juan José Farías Álvarez',
  'el mayito flaco': 'Ismael Zambada Sicairos', 'ismael zambada sicairos': 'Ismael Zambada Sicairos',
  'ivan archivaldo guzman salazar': 'Iván Archivaldo Guzmán Salazar', 'ivan archivaldo guzman': 'Iván Archivaldo Guzmán Salazar',
  'ovidio guzman lopez': 'Ovidio Guzmán López', 'ovidio guzman': 'Ovidio Guzmán López', 'el raton': 'Ovidio Guzmán López',
  'el guano': 'Aureliano Guzmán Loera', 'aureliano guzman loera': 'Aureliano Guzmán Loera',
  'el azul': 'Juan José Esparragoza Moreno', 'juan jose esparragoza moreno': 'Juan José Esparragoza Moreno',
  'nacho coronel': 'Ignacio Coronel Villarreal', 'ignacio coronel villarreal': 'Ignacio Coronel Villarreal', 'ignacio coronel': 'Ignacio Coronel Villarreal', 'ignacio nacho coronel': 'Ignacio Coronel Villarreal',
  'el chapito': 'Erick Valencia Salazar', 'erick valencia salazar': 'Erick Valencia Salazar', 'erick valencia': 'Erick Valencia Salazar', 'el 85': 'Erick Valencia Salazar',
  'el 20': 'Carlos Enrique Sánchez Martínez', 'el cholo': 'Carlos Enrique Sánchez Martínez', 'carlos enrique sanchez martinez': 'Carlos Enrique Sánchez Martínez',
  'el 15': 'Johnny Hurtado Olascoaga', 'el pez': 'Johnny Hurtado Olascoaga', 'johnny hurtado olascoaga': 'Johnny Hurtado Olascoaga',
  'el fresa': 'José Alfredo Hurtado Olascoaga', 'jose alfredo hurtado olascoaga': 'José Alfredo Hurtado Olascoaga',
  'el chueco': 'José Noriel Portillo Gil', 'jose noriel portillo gil': 'José Noriel Portillo Gil',
  'el gordo': 'Gerardo González Valencia', 'gerardo gonzalez valencia': 'Gerardo González Valencia',
  'el sapo': 'José González Valencia', 'jose gonzalez valencia': 'José González Valencia',
  'el tony montana': 'Martín Arzola Ortega', 'martin arzola ortega': 'Martín Arzola Ortega',
  // spelling variants that appear in the corpus
  'nemesio osegura cervantes': 'Nemesio Oseguera Cervantes', 'nemesio oseguera cervants': 'Nemesio Oseguera Cervantes', 'nemesio oseguerra cervantes': 'Nemesio Oseguera Cervantes',
  'nemesio oceguera cervantes': 'Nemesio Oseguera Cervantes', 'nemesio oseguera ramos': 'Nemesio Oseguera Cervantes', 'ricardo ruiz velazco': 'Ricardo Ruiz Velasco', 'gonzalo mendoza gaytan': 'Gonzalo Mendoza Gaitán',
};
// Nicknames that InSight Crime uses for exactly one person; any other "El …" nickname is only merged into a
// canonical person when that person's surname also appears in the article.
const UNAMBIGUOUS_NICKS = new Set(['el mencho', 'el menchito', 'el cuini', 'el chapo', 'el mayo', 'el marro', 'la tuta', 'el abuelo', 'el mayito flaco', 'el azul', 'el jardinero', 'el rr', 'el doble r', 'el tony montana', 'el chueco', 'el fresa', 'la jefa', 'nacho coronel', 'el chapito']);
const TYPED_WINDOW = 140;   // max folded-character distance between two entities for a typed relation

// Words that the person extractor sometimes returns but that are institutions, places or headline furniture.
const NOT_PERSON_RE = /\b(?:cartel|c[aá]rtel|nueva generaci[oó]n|new generation|jalisco|michoac[aá]n|sinaloa|guanajuato|zacatecas|tamaulipas|guerrero|veracruz|chihuahua|tijuana|guadalajara|puerto vallarta|santa rosa|lima|los angeles|san diego|new york|el paso|washington|police|army|navy|marines|attorney|department|justice|treasury|state|federal|national|guard|security|commission|university|institute|foundation|court|congress|senate|ministry|office|bureau|agency|drug enforcement|homeland|customs|border|patrol|insight crime|autodefensas|self-?defense|cuerpo|batall[oó]n|fuerzas? especiales|grupo|los|las|nuevo|santa|san|puerto|ciudad|city|county|street|avenue|highway|river|lake|valley|mountain|sierra|costa|tierra caliente|new york times|times|press|news|radio|tv|report|reporte|reuters|associated|bloomberg|milenio|reforma|proceso|universal|excelsior|jornada|aristegui|animal pol[ií]tico|plaza|la familia|caballeros templarios|knights templar|los viagras|c[aá]rteles unidos|united cartels|gente nueva|los zetas|zetas|golfo|gulf|norte|noreste|beltr[aá]n leyva|guerreros unidos|c[aá]rtel de|mexico|m[eé]xico|mexican|american|colombian|latin america|central america|north|south|east|west|el pa[ií]s|ministerio|secretar[ií]a|fiscal[ií]a|gobierno|presidente|world cup|day of the dead|operator|question|sticky|financial|leader|boss|capo|alias|don|se\u00f1or|senor|ops|profile|man|woman|threat|assessment|deadly|rise|fall|analysis|gamechangers|game changers|casa|rancho|bolsa|banco|bank|casino|hotel|restaurant|christmas|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|holy week|coca|cola|fentanyl|methamphetamine|cocaine|marijuana|heroin|real madrid|fc|club)\b/i;
const NICKNAME_RE = /^(?:El|La|Los|Las)\s+\S+(?:\s+\S+)?$/;

function readJson(file, dflt) {
  try {
    if (!existsSync(file)) return dflt;
    const raw = readFileSync(file);
    return JSON.parse(file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
  } catch { return dflt; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}
const str = (s, n = MAX_LABEL) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const day = iso => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

// Split paragraph text into sentences; abbreviations common in this corpus are protected first.
export function splitSentences(text) {
  const t = String(text || '')
    .replace(/\b(U\.S|Mr|Mrs|Ms|Dr|Gen|Lt|Col|Sgt|Jr|Sr|St|vs|No|Inc|Corp|a\.k\.a|e\.g|i\.e)\./gi, m => m.replace(/\./g, '\u2024'))
    .replace(/\s+/g, ' ');
  return t.split(/(?<=[.!?…]["”’)]?)\s+(?=[A-Z"“‘(\d])|\n+/).map(s => s.replace(/\u2024/g, '.').trim()).filter(isProse);
}
// Drops navigation furniture (related-post lists, date strips, headline runs) that survives HTML stripping.
const DATE_TOKEN_RE = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g;
export function isProse(s) {
  if (s.length < 20 || s.length > 1200) return false;
  if ((s.match(DATE_TOKEN_RE) || []).length >= 2) return false;
  if (!/[.!?…]["”’)]?$/.test(s)) return false;
  return /\b(?:is|was|were|are|has|had|have|be|been|said|says|led|leads|killed|arrested|the|of|in|to|and|a|an|de|del|la|el)\b/i.test(s);
}

// Resolve a name or nickname to its canonical person. Returns null for a nickname that cannot be resolved
// in this article (generic nicknames are shared by many people across the corpus).
function canonicalPerson(name, bodyFold = '') {
  const k = fold(name);
  const canon = PERSON_ALIASES[k];
  if (canon) {
    if (!NICKNAME_RE.test(name) || UNAMBIGUOUS_NICKS.has(k)) return canon;
    const surname = fold(canon).split(' ').slice(-2).join(' ');
    return bodyFold.includes(surname) || bodyFold.includes(fold(canon)) ? canon : null;
  }
  return NICKNAME_RE.test(name) ? null : name;
}

// Editorial / site-navigation tags and the two countries every article carries.
const SKIP_TAGS = new Set(['mexico', 'usa', 'united states', 'featured', 'infographics', 'gamechangers', 'mexico groups', 'insight crime', 'investigations', 'news analysis', 'news', 'brief', 'briefs', 'top story', 'multimedia', 'video', 'podcast', 'weekly']);
const ORG_TAG_RE = /\b(?:cartel|c[aá]rtel|mafia|clan|org|organization|gang|pandilla|mara|ms-?13|barrio 18|pcc|eln|farc|comando|cv\b|tren de aragua|autodefensas|urabe|gaitanistas|choneros|lobos|tiguerones|red command|comando vermelho|primeiro comando|zetas|familia|templar|viagras|unidos|sombra|tepito|noreste|golfo|sinaloa|beltran|juarez|tijuana|arellano|colima|milenio|caballeros|linea|chapitos|mayiza|cuinis|puros|escorpiones|metros|rojos|ardillos|tlacos|guerreros|barredora|caborca|salazar|cjng|cds|cdg|cdn|blo|caf|csrl|nfm|lnfm|zve|tda|fem)\b/i;

// Classify an InSight Crime tag into a node type using the same lexica the extractors use.
export function classifyTag(name, { gz, groups }) {
  const k = fold(name);
  if (!k || SKIP_TAGS.has(k)) return 'skip';
  if (groups.aliasKey.has(k) || groups.leaderKey.has(k) || PERSON_ALIASES[k]) return groups.leaderKey.has(k) || PERSON_ALIASES[k] ? 'person' : 'org';
  if (gz.stateKey.has(k) || gz.placeKey.has(k) || gz.muniKey.has(k)) return 'place';
  if (COUNTRIES.some(c => fold(c[1]) === k)) return 'country';
  const toks = k.split(/\s+/).filter(t => !/^(?:de|del|la|el|los|las|y|da|di|van|von)$/.test(t));
  if (NICKNAME_RE.test(name) && toks.length <= 3) return 'person';
  if (toks.length >= 2 && toks.length <= 5 && !NOT_PERSON_RE.test(name)) {
    const lex = toks.filter(t => GIVEN_NAMES.has(t) || SURNAMES_SET.has(t)).length;
    if (lex >= 1 && /^[A-ZÁÉÍÓÚÑ]/.test(name) && toks.every(t => !/^(?:cartel|gang|clan|group|front|bloc|network|mafia|police|army|ministry|law|policy|trade|trafficking|violence|crime|elites?)$/.test(t))) return 'person';
  }
  if (ORG_TAG_RE.test(name) && !/\b(?:peace|policy|process|talks|elections?|reform|law)\b/i.test(name)) return 'org-tag';
  return 'topic';
}

function pick(re, s) { const m = s.match(re); return m ? m[0] : null; }
function countRe(re, s) { return (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length; }

// Text between two entity positions (plus a short margin) in the folded sentence: cues must fall here.
function cueSpan(fs, p1, p2) { const lo = Math.min(p1, p2), hi = Math.max(p1, p2); return fs.slice(Math.max(0, lo - 40), hi + 60); }
// Shorter sentences with the cue close to the entities make better evidence.
function evidenceScore(sentence, typed) { return (typed ? 1000 : 0) - Math.min(sentence.length, 600); }

function orgRelation(sentence) {
  const r = countRe(RIVAL_RE, sentence), a = countRe(ALLY_RE, sentence), l = countRe(LINEAGE_RE, sentence);
  if (l && l >= Math.max(r, a)) return 'lineage';
  if (r > a) return 'rival_of';
  if (a > r) return 'allied_with';
  return null;
}
// Officials, politicians and journalists named next to a cartel are targets or sources, not members.
const OFFICIAL_RE = /\b(?:president|governor|mayor|police chief|attorney general|prosecutor|secretary|senator|congressm[ae]n|deputy|minister|commissioner|ambassador|journalist|reporter|activist|candidate|judge|general|admiral|colonel|official|spokes(?:man|woman|person)|director|analyst|researcher|professor|author|priest|bishop|lawyer|attorney|agent|sheriff|officer)\b/i;
function personRelation(sentence) {
  if (OFFICIAL_RE.test(sentence)) return null;
  if (LEADER_RE.test(sentence)) return 'leader_of';
  if (MEMBER_RE.test(sentence)) return 'member_of';
  return null;
}

class Builder {
  constructor({ gz, groups }) {
    this.gz = gz; this.groups = groups;
    this.nodes = new Map();   // id -> node
    this.edges = new Map();   // key -> edge
    this.articles = [];
  }
  node(id, type, label, meta = {}) {
    let n = this.nodes.get(id);
    if (!n) { n = { id, type, label: str(label), articleIds: new Set(), mentions: 0, first: null, last: null, meta }; this.nodes.set(id, n); }
    return n;
  }
  touch(n, art, mentions = 1) {
    n.articleIds.add(art.id);
    n.mentions += mentions;
    const d = day(art.date);
    if (d) { if (!n.first || d < n.first) n.first = d; if (!n.last || d > n.last) n.last = d; }
  }
  edge(a, b, type, art, sentence, score = 0) {
    if (a === b) return;
    const rel = RELATIONS[type];
    const [s, t] = rel.directed ? [a, b] : [a, b].sort();
    const key = `${s}|${type}|${t}`;
    let e = this.edges.get(key);
    if (!e) { e = { source: s, target: t, type, articleIds: new Set(), mentions: 0, first: null, last: null, evidence: [] }; this.edges.set(key, e); }
    e.articleIds.add(art.id);
    e.mentions++;
    const d = day(art.date);
    if (d) { if (!e.first || d < e.first) e.first = d; if (!e.last || d > e.last) e.last = d; }
    if (sentence && !e.evidence.some(x => x.a === art.id)) e.evidence.push({ a: art.id, d, s: str(sentence, MAX_SENTENCE), score });
  }
}

function orgNode(b, g, art) {
  const cfg = b.groups.byId.get(g.id);
  const n = b.node(`org:${g.id}`, cfg?.type === 'faction' ? 'faction' : 'org', cfg?.short || cfg?.name || g.name, {
    orgId: cfg?.orgId || g.orgId || 'other', groupType: cfg?.type || 'cartel', parent: cfg?.parent ? `org:${cfg.parent}` : null, fullName: str(cfg?.name || g.name),
  });
  if (art) b.touch(n, art, g.mentions || 1);
  return n;
}

// Place descriptors from a gazetteer scan; nodes are created only when `art` is given (article level).
function placeRefs(b, found, art) {
  const out = [];
  for (const s of found.states.slice(0, 6)) {
    const id = `place:MX-${s.adm1}`;
    out.push({ id, label: s.name || stateName(s.adm1, b.gz), meta: { country: 'MX', adm1: s.adm1, level: 'state', lat: s.lat ?? null, lon: s.lon ?? null }, mentions: s.mentions || 1, pos: s.first ?? 0 });
  }
  for (const p of [...found.places.slice(0, 6), ...found.municipalities.slice(0, 4)]) {
    const st = stateName(p.adm1, b.gz);
    if (!st) continue;
    out.push({ id: `place:MX-${p.adm1}/${fold(p.name).replace(/\s+/g, '-')}`, label: `${p.name}, ${st}`, meta: { country: 'MX', adm1: p.adm1, level: p.pop !== undefined ? 'city' : 'municipality', parent: `place:MX-${p.adm1}`, lat: p.lat ?? null, lon: p.lon ?? null }, mentions: p.mentions || 1, pos: p.first ?? 0 });
  }
  if (art) for (const r of out) b.touch(b.node(r.id, 'place', r.label, r.meta), art, r.mentions);
  return out;
}

function countryRefs(b, text, art) {
  const out = [];
  for (const [iso, name, re] of COUNTRIES) {
    const g = new RegExp(re.source, 'g');
    let m, n = 0, pos = -1;
    while ((m = g.exec(text)) !== null) { n++; if (pos < 0) pos = m.index; }
    if (!n) continue;
    out.push({ id: `country:${iso}`, label: name, meta: { iso }, mentions: n, pos });
  }
  if (art) for (const r of out) b.touch(b.node(r.id, 'country', r.label, r.meta), art, r.mentions);
  return out;
}

// Org alias positions inside a folded sentence: [{ id, pos }]
function orgPositions(b, foldedSentence) {
  const out = new Map();
  b.groups.aliasRe.lastIndex = 0;
  let m;
  while ((m = b.groups.aliasRe.exec(foldedSentence)) !== null) {
    const g = b.groups.aliasKey.get(m[1]);
    if (!out.has(g.id)) out.set(g.id, m.index);
  }
  return [...out.entries()].map(([id, pos]) => ({ id: `org:${id}`, pos }));
}

function personKey(canon) { return `person:${fold(canon).replace(/\s+/g, '-')}`; }

function acceptPerson(name) {
  const toks = fold(name).split(/\s+/);
  if (toks.length < 2 || toks.length > 5) return false;
  if (/[’'"“”]/.test(name)) return false;
  if (NOT_PERSON_RE.test(name)) return false;
  if (toks.every(t => GIVEN_NAMES.has(t) && !SURNAMES_SET.has(t))) return false;   // "Miguel Ángel" alone is not a person
  return true;
}

// Cross-article merge: "Peña Nieto" -> "Enrique Peña Nieto" (and "Ops Nemesio Oseguera Cervantes" -> the
// canonical name) when exactly one other person name extends or is extended by it. The node with fewer
// supporting articles is folded into the better-supported one.
function mergePersons(b) {
  const persons = [...b.nodes.values()].filter(n => n.type === 'person').sort((x, y) => x.articleIds.size - y.articleIds.size || x.label.length - y.label.length);
  const extendsName = (a, c) => a.startsWith(c + ' ') || a.endsWith(' ' + c);
  const remap = new Map();
  for (const p of persons) {
    if (remap.has(p.id)) continue;
    const k = fold(p.label);
    const cands = persons.filter(q => q !== p && !remap.has(q.id) && q.articleIds.size >= p.articleIds.size && (extendsName(fold(q.label), k) || extendsName(k, fold(q.label))));
    if (cands.length !== 1) continue;
    const t = cands[0];
    remap.set(p.id, t.id);
    for (const a of p.articleIds) t.articleIds.add(a);
    t.mentions += p.mentions;
    if (p.first && (!t.first || p.first < t.first)) t.first = p.first;
    if (p.last && (!t.last || p.last > t.last)) t.last = p.last;
    t.meta.aliases.add(p.label);
    for (const a of p.meta.aliases) t.meta.aliases.add(a);
    if (!t.meta.groupId && p.meta.groupId) t.meta.groupId = p.meta.groupId;
    t.meta.events.push(...p.meta.events);
    b.nodes.delete(p.id);
  }
  if (!remap.size) return;
  const resolve = id => { let cur = id; while (remap.has(cur)) cur = remap.get(cur); return cur; };
  const merged = new Map();
  for (const e of b.edges.values()) {
    const source = resolve(e.source), target = resolve(e.target);
    if (source === target) continue;
    const [s, t] = RELATIONS[e.type].directed ? [source, target] : [source, target].sort();
    const key = `${s}|${e.type}|${t}`;
    const cur = merged.get(key);
    if (!cur) { merged.set(key, { ...e, source: s, target: t }); continue; }
    for (const a of e.articleIds) cur.articleIds.add(a);
    cur.mentions += e.mentions;
    if (e.first && (!cur.first || e.first < cur.first)) cur.first = e.first;
    if (e.last && (!cur.last || e.last > cur.last)) cur.last = e.last;
    for (const ev of e.evidence) if (!cur.evidence.some(x => x.a === ev.a)) cur.evidence.push(ev);
  }
  b.edges = merged;
}

// One article -> nodes, per-sentence relations, status events, article summary row.
function processArticle(b, art, tagIndex) {
  const body = `${art.title}\n${art.text || art.excerpt || ''}`;
  const bodyFold = fold(body);
  const grp = findGroups(body, b.groups);
  const orgs = [...grp.cartels, ...grp.factions].filter(g => !g.implied || g.id === ROOT_ORG);
  const isKnown = phrase => { const k = fold(phrase); return b.gz.stateKey.has(k) || b.gz.placeKey.has(k) || b.gz.muniKey.has(k) || b.groups.aliasKey.has(k); };
  const ppl = extractPeople(body, { isKnown });
  const people = new Map();
  const addPerson = (name, mentions, groupId) => {
    const canon = canonicalPerson(name, bodyFold);
    if (!canon || !acceptPerson(canon)) return;
    const key = personKey(canon);
    const cur = people.get(key) || { key, name: canon, mentions: 0, aliases: new Set(), groupId: null };
    cur.mentions += mentions;
    if (fold(name) !== fold(canon)) cur.aliases.add(name);
    if (groupId) cur.groupId = groupId;
    people.set(key, cur);
  };
  for (const p of ppl.people) { addPerson(p.name, p.mentions, p.groupId || null); if (p.alias) addPerson(p.alias, 0, null); }
  for (const l of grp.leaders) addPerson(l.name, 1, l.groupId);
  for (const nick of ppl.nicknames) if (PERSON_ALIASES[fold(nick)]) addPerson(nick, 1, null);
  for (const tid of art.tags || []) { const t = tagIndex.get(tid); if (t && t.type === 'person') addPerson(t.name, 1, null); }
  // Collapse "Nemesio Oseguera" into "Nemesio Oseguera Cervantes" when both survive as separate keys.
  for (const p of [...people.values()].sort((x, y) => fold(x.name).length - fold(y.name).length)) {
    const k = fold(p.name);
    const longer = [...people.values()].find(q => q !== p && (fold(q.name).startsWith(k + ' ') || fold(q.name).endsWith(' ' + k)));
    if (longer) { longer.mentions += p.mentions; for (const a of p.aliases) longer.aliases.add(a); longer.aliases.add(p.name); people.delete(p.key); }
  }

  const masked = maskGroupNames(body, b.groups);
  const found = findPlaces(masked, b.gz);
  const counts = extractCounts(body);
  const cls = classifyEvent(body, counts, art.title);

  // Nodes touched by this article.
  for (const g of orgs) orgNode(b, g, art);
  for (const p of people.values()) {
    const n = b.node(p.key, 'person', p.name, { aliases: new Set(), groupId: null, events: [] });
    for (const a of p.aliases) n.meta.aliases.add(a);
    if (p.groupId && !n.meta.groupId) n.meta.groupId = p.groupId;
    b.touch(n, art, p.mentions);
  }
  const places = placeRefs(b, found, art);
  const countries = countryRefs(b, body, art);
  for (const tid of art.tags || []) {
    const t = tagIndex.get(tid);
    if (!t || (t.type !== 'topic' && t.type !== 'org-tag')) continue;
    const slug = t.slug || fold(t.name).replace(/\s+/g, '-');
    // Groups the gazetteer already knows are matched from the text; a tag for one of them must not create a duplicate node.
    if (t.type === 'org-tag' && b.groups.aliasKey.has(fold(t.name))) continue;
    const n = t.type === 'org-tag'
      ? b.node(`org:tag-${slug}`, 'org', t.name, { orgId: 'other', groupType: 'tag', parent: null, fullName: str(t.name) })
      : b.node(`topic:${slug}`, 'topic', t.name, { tagId: tid });
    b.touch(n, art, 1);
    for (const g of orgs) if (g.id === ROOT_ORG || b.groups.byId.get(g.id)?.parent === ROOT_ORG) b.edge(`org:${g.id}`, n.id, 'linked_topic', art, null);
  }

  // Sentence-level relations. A typed relation needs a cue word in the sentence *and* the two entities
  // within TYPED_WINDOW folded characters of each other; the nearest org wins when several are named.
  const personList = [...people.values()].map(p => ({ ...p, needles: [fold(p.name), ...[...p.aliases].map(fold)].filter(x => x.length >= 4) }));
  const nearest = (pos, cands) => cands.reduce((best, c) => (best === null || Math.abs(c.pos - pos) < Math.abs(best.pos - pos) ? c : best), null);
  for (const sent of splitSentences(body)) {
    const fs = fold(sent);
    const sOrgs = orgPositions(b, fs);
    if (!sOrgs.length) continue;
    const sPeople = personList.map(p => { const pos = p.needles.map(nd => fs.indexOf(nd)).filter(i => i >= 0).sort((x, y) => x - y)[0]; return pos === undefined ? null : { ...p, pos }; }).filter(Boolean);
    const sPlaces = placeRefs(b, findPlaces(maskGroupNames(sent, b.groups), b.gz), null).filter(r => b.nodes.has(r.id));
    const sCountries = countryRefs(b, sent, null).filter(r => b.nodes.has(r.id));
    // org–org
    for (let i = 0; i < sOrgs.length; i++) for (let j = i + 1; j < sOrgs.length; j++) {
      const close = Math.abs(sOrgs[i].pos - sOrgs[j].pos) <= TYPED_WINDOW * 1.5;
      const rel = close ? orgRelation(cueSpan(fs, sOrgs[i].pos, sOrgs[j].pos)) : null;
      b.edge(sOrgs[i].id, sOrgs[j].id, rel || 'mentioned_with', art, sent, evidenceScore(sent, Boolean(rel)));
    }
    // org–person
    for (const p of sPeople) {
      const near = nearest(p.pos, sOrgs);
      const pRel = Math.abs(near.pos - p.pos) <= TYPED_WINDOW ? personRelation(cueSpan(fs, near.pos, p.pos)) : null;
      for (const o of sOrgs) {
        const typed = pRel && o === near;
        b.edge(p.key, o.id, typed ? pRel : 'mentioned_with', art, sent, evidenceScore(sent, typed));
      }
      const pn = b.nodes.get(p.key);
      if (pn && pn.meta.events.length < MAX_PERSON_EVENTS) {
        const around = fs.slice(Math.max(0, p.pos - 50), p.pos + 90);
        for (const [kind, re] of PERSON_EVENTS) {
          if (!re.test(around)) continue;
          if (pn.meta.events.some(e => e.kind === kind && e.a === art.id)) continue;
          pn.meta.events.push({ kind, a: art.id, d: day(art.date), s: str(sent, MAX_SENTENCE) });
          break;
        }
      }
    }
    // person–person (family only; plain co-mentions between people are too noisy to keep)
    if (sPeople.length > 1) {
      for (let i = 0; i < sPeople.length; i++) for (let j = i + 1; j < sPeople.length; j++) {
        const lo = Math.min(sPeople[i].pos, sPeople[j].pos), hi = Math.max(sPeople[i].pos, sPeople[j].pos);
        if (hi - lo <= 90 && FAMILY_RE.test(fs.slice(lo, hi + 40))) b.edge(sPeople[i].key, sPeople[j].key, 'family_of', art, sent, evidenceScore(sent, true));
      }
    }
    // org–place / org–country
    for (const r of [...sPlaces, ...sCountries]) {
      const near = nearest(r.pos, sOrgs);
      const presence = Math.abs(near.pos - r.pos) <= TYPED_WINDOW && PRESENCE_RE.test(cueSpan(fs, near.pos, r.pos));
      for (const o of sOrgs) {
        const typed = presence && o === near;
        b.edge(o.id, r.id, typed ? 'operates_in' : 'mentioned_with', art, sent, evidenceScore(sent, typed));
      }
    }
  }

  b.articles.push({
    id: art.id, title: str(art.title, 200), link: art.link, date: day(art.date), tagged: Boolean(art.tagged), focus: art.focus,
    eventType: cls.primary, words: art.words || 0,
    orgs: orgs.slice(0, 8).map(g => `org:${g.id}`),
    people: [...people.values()].sort((x, y) => y.mentions - x.mentions).slice(0, 6).map(p => p.key),
    places: places.slice(0, 6).map(p => p.id),
    countries: countries.sort((x, y) => y.mentions - x.mentions).slice(0, 4).map(c => c.id),
    excerpt: str(art.excerpt, 280) || null,
  });
}

function finalize(b, corpus, focused, now) {
  // CJNG family: the root org, its factions, and people with a typed membership/leadership edge to them.
  const family = new Set([ROOT_NODE, ...[...b.nodes.values()].filter(n => n.type === 'faction' && n.meta.parent === ROOT_NODE).map(n => n.id)]);
  for (const e of b.edges.values()) {
    if ((e.type === 'leader_of' || e.type === 'member_of') && family.has(e.target) && e.source.startsWith('person:')) family.add(e.source);
  }
  const hop1 = new Set(family);
  for (const e of b.edges.values()) { if (family.has(e.source)) hop1.add(e.target); if (family.has(e.target)) hop1.add(e.source); }

  // Keep edges that touch the family, or connect two nodes that both touch the family.
  let edges = [...b.edges.values()].filter(e => (family.has(e.source) || family.has(e.target)) || (hop1.has(e.source) && hop1.has(e.target) && RELATIONS[e.type].typed));
  // Persons: need a typed relation or repeated co-mention with CJNG to stay.
  const personSupport = new Map();
  for (const e of edges) for (const id of [e.source, e.target]) {
    if (!id.startsWith('person:')) continue;
    const other = id === e.source ? e.target : e.source;
    const cur = personSupport.get(id) || { typed: 0, articles: new Set() };
    if (RELATIONS[e.type].typed && (family.has(other) || hop1.has(other))) cur.typed++;
    for (const a of e.articleIds) cur.articles.add(a);
    personSupport.set(id, cur);
  }
  const keepPerson = id => { const s = personSupport.get(id); return s && (s.typed > 0 || s.articles.size >= MIN_PERSON_ARTICLES); };
  edges = edges.filter(e => [e.source, e.target].every(id => !id.startsWith('person:') || keepPerson(id)));
  // Drop co-mention edges that duplicate a typed edge between the same pair.
  const typedPairs = new Set(edges.filter(e => RELATIONS[e.type].typed).map(e => [e.source, e.target].sort().join('|')));
  edges = edges.filter(e => e.type !== 'mentioned_with' || !typedPairs.has([e.source, e.target].sort().join('|')));
  // Rank: typed first, then by article support.
  edges.sort((x, y) => (RELATIONS[y.type].typed - RELATIONS[x.type].typed) || (y.articleIds.size - x.articleIds.size) || (y.mentions - x.mentions));
  edges = edges.slice(0, MAX_EDGES);

  const used = new Set(edges.flatMap(e => [e.source, e.target]));
  used.add(ROOT_NODE);
  let nodes = [...b.nodes.values()].filter(n => used.has(n.id));
  nodes.sort((x, y) => (x.id === ROOT_NODE ? -1 : y.id === ROOT_NODE ? 1 : 0) || (y.articleIds.size - x.articleIds.size) || (y.mentions - x.mentions));
  if (nodes.length > MAX_NODES) {
    nodes = nodes.slice(0, MAX_NODES);
    const keep = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => keep.has(e.source) && keep.has(e.target));
  }
  const degree = new Map();
  for (const e of edges) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); }

  const articleById = new Map(b.articles.map(a => [a.id, a]));
  const outNodes = nodes.map(n => ({
    id: n.id, type: n.type, label: n.label, articles: n.articleIds.size, mentions: n.mentions, degree: degree.get(n.id) || 0,
    first: n.first, last: n.last, family: family.has(n.id),
    meta: n.type === 'person'
      ? { aliases: [...n.meta.aliases].slice(0, 6).map(a => str(a, 60)), groupId: n.meta.groupId, events: n.meta.events.filter(e => articleById.has(e.a)).sort((x, y) => String(y.d).localeCompare(String(x.d))).slice(0, MAX_PERSON_EVENTS) }
      : n.meta,
  }));
  const outEdges = edges.map(e => ({
    id: `${e.source}|${e.type}|${e.target}`.replace(/[^A-Za-z0-9|:_/.-]/g, '_').slice(0, 300),
    source: e.source, target: e.target, type: e.type, articles: e.articleIds.size, mentions: e.mentions, first: e.first, last: e.last,
    confidence: RELATIONS[e.type].typed ? 'typed' : 'co-mention',
    evidence: e.evidence.sort((x, y) => (y.score - x.score) || String(y.d).localeCompare(String(x.d))).slice(0, MAX_EVIDENCE).map(({ a, d, s }) => ({ a, d, s })),
  }));

  const byYear = {};
  for (const a of b.articles) {
    const y = a.date ? a.date.slice(0, 4) : 'undated';
    const row = byYear[y] || (byYear[y] = { articles: 0, byType: {} });
    row.articles++;
    row.byType[a.eventType] = (row.byType[a.eventType] || 0) + 1;
  }
  const tally = (list, key) => { const m = {}; for (const x of list) { const k = key(x); if (k) m[k] = (m[k] || 0) + 1; } return m; };
  const articles = b.articles.sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, MAX_ARTICLES);
  return {
    schema: GRAPH_SCHEMA,
    extractor: EXTRACTOR_VERSION,
    computedAt: new Date(now).toISOString(),
    source: { name: 'InSight Crime', site: 'https://insightcrime.org', api: corpus.api || null, queries: corpus.queries || [], fetchedAt: corpus.fetchedAt || null, corpusArticles: corpus.totals?.articles || 0, corpusWords: corpus.totals?.words || 0 },
    root: ROOT_NODE,
    span: articles.length ? { from: articles[articles.length - 1].date, to: articles[0].date } : null,
    totals: {
      articles: articles.length, peripheral: (corpus.totals?.articles || 0) - focused, words: focused ? b.articles.reduce((s, a) => s + a.words, 0) : 0,
      nodes: outNodes.length, edges: outEdges.length, typedEdges: outEdges.filter(e => e.confidence === 'typed').length,
      byNodeType: tally(outNodes, n => n.type), byRelation: tally(outEdges, e => e.type), byEventType: tally(articles, a => a.eventType),
      family: family.size, byYear,
    },
    legend: { relations: RELATIONS, nodeTypes: NODE_TYPES, eventTypes: EVENT_TYPE_LABELS },
    nodes: outNodes,
    edges: outEdges,
    articles,
    caveat: 'Machine-extracted from InSight Crime articles (public WordPress API). Relations are as reported in the cited sentence, not verified ground truth; rule-based cues miss relations phrased differently. Article text is not redistributed - only bounded evidence sentences with links to the original.',
  };
}

export function buildCjngGraph(corpus, { gz = loadGazetteer(), groups = loadGroups(), now = Date.now() } = {}) {
  const b = new Builder({ gz, groups });
  const tagIndex = new Map();
  for (const [id, t] of Object.entries(corpus?.tags || {})) {
    if (!t || typeof t.name !== 'string') continue;
    tagIndex.set(Number(id), { name: str(t.name, 80), slug: str(t.slug, 80), type: classifyTag(t.name, { gz, groups }) });
  }
  const focused = (corpus?.articles || []).filter(isCjngFocused);
  for (const art of focused) processArticle(b, art, tagIndex);
  mergePersons(b);
  // Root always exists so an empty corpus still yields a well-formed graph.
  const root = groups.byId.get(ROOT_ORG);
  if (root) orgNode(b, { id: root.id, name: root.name, mentions: 0 }, null);
  return finalize(b, corpus || {}, focused.length, now);
}

export function saveGraph(graph, dataDir = DEFAULT_DATA_DIR) { writeJson(join(dataDir, 'graph.json'), graph); }

// Runtime copy first (runs/), then the committed snapshot so a fresh checkout renders before the first refresh.
export function loadGraph(dataDir = DEFAULT_DATA_DIR, snapshotFile = SNAPSHOT_FILE) {
  for (const file of [join(dataDir, 'graph.json'), snapshotFile]) {
    const g = readJson(file, null);
    if (g && g.schema === GRAPH_SCHEMA && Array.isArray(g.nodes) && Array.isArray(g.edges)) return { ...g, snapshot: file === snapshotFile };
  }
  return null;
}
export function saveSnapshot(graph, file = SNAPSHOT_FILE) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, gzipSync(JSON.stringify(graph), { level: 9 })); }

// API view: optional node-type / relation / minimum-article filters; the root org is always kept.
export function filterGraph(graph, { types = null, rels = null, minArticles = 1 } = {}) {
  if (!graph) return null;
  const typeSet = types && types.length ? new Set(types) : null;
  const relSet = rels && rels.length ? new Set(rels) : null;
  let nodes = graph.nodes.filter(n => n.id === ROOT_NODE || ((!typeSet || typeSet.has(n.type)) && n.articles >= minArticles));
  const keep = new Set(nodes.map(n => n.id));
  const edges = graph.edges.filter(e => keep.has(e.source) && keep.has(e.target) && (!relSet || relSet.has(e.type)));
  const used = new Set(edges.flatMap(e => [e.source, e.target]));
  used.add(ROOT_NODE);
  nodes = nodes.filter(n => used.has(n.id));
  const { articles: _a, ...rest } = graph;
  return { ...rest, nodes, edges, articles: graph.articles, filtered: { types: typeSet ? [...typeSet] : null, rels: relSet ? [...relSet] : null, minArticles, nodes: nodes.length, edges: edges.length } };
}

// Client payload: enough for the panel header and chips; the full graph is fetched on demand.
export function summarizeGraph(graph, health = {}) {
  if (!graph) return { status: 'pending', totals: null };
  const top = type => graph.nodes.filter(n => n.type === type && n.id !== ROOT_NODE).slice(0, 8).map(n => ({ id: n.id, label: n.label, articles: n.articles, degree: n.degree }));
  return {
    status: graph.snapshot ? 'snapshot' : 'live',
    computedAt: graph.computedAt, fetchedAt: graph.source?.fetchedAt || null, span: graph.span, totals: graph.totals,
    corpusArticles: graph.source?.corpusArticles || null,
    top: { people: top('person'), orgs: [...graph.nodes.filter(n => (n.type === 'org' || n.type === 'faction') && n.id !== ROOT_NODE)].slice(0, 8).map(n => ({ id: n.id, label: n.label, articles: n.articles, degree: n.degree })), places: top('place'), topics: top('topic') },
    refresh: health,
    caveat: graph.caveat,
  };
}
