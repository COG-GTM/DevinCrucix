// Knowledge-graph profiles: one InSight Crime corpus + graph per subject. `cjng` is the original Mexico /
// CJNG graph (root = the organisation); `co` and `ve` are country graphs (root = the country node) whose
// corpora come from InSight Crime's country and group tags and whose places resolve through the matching
// GeoNames gazetteer. Everything subject-specific lives here so corpus.mjs / graph.mjs stay generic.
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_GROUPS_FILE } from '../narco/groups.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS = join(__dirname, '../../runs/insightcrime');
const CONFIG = join(__dirname, '../../config');

// InSight Crime WordPress term ids (from the cached /wp-json/wp/v2/tags listing).
export const TAG_JALISCO_CARTEL = 676;
export const TAG_EL_MENCHO = 3426;
export const TAGS = Object.freeze({
  colombia: 547, colombiaGroups: 540, colombiaPersonalities: 579, farc: 556, eln: 627, gaitanistas: 573, exFarcMafia: 3360,
  secondMarquetalia: 3571, oficinaDeEnvigado: 615, rastrojos: 536, otoniel: 681, ivanMarquez: 801,
  venezuela: 570, venezuelaGroups: 612, venezuelaPersonalities: 902, trenDeAragua: 3507, colectivos: 3409, megabandas: 708,
  elKoki: 3549, wilexis: 3634, trenDelLlano: 4704,
});
const tagQuery = (name, id) => ({ name: `tag:${name}`, params: { tags: String(id) } });

// Words that mark a post as *about* CJNG rather than mentioning it in passing.
export const CJNG_RE = /\bCJNG\b|Jalisco (?:New Generation )?Cartel|C[aá]rtel (?:de )?Jalisco Nueva Generaci[oó]n|\bEl Mencho\b|Nemesio (?:Rub[eé]n )?Oseguera/gi;

const CO_ALIASES = {
  'otoniel': 'Dairo Antonio Úsuga David', 'dairo antonio usuga': 'Dairo Antonio Úsuga David', 'dairo antonio usuga david': 'Dairo Antonio Úsuga David', 'dairo usuga': 'Dairo Antonio Úsuga David',
  'ivan mordisco': 'Néstor Gregorio Vera Fernández', 'nestor gregorio vera fernandez': 'Néstor Gregorio Vera Fernández', 'nestor gregorio vera': 'Néstor Gregorio Vera Fernández',
  'ivan marquez': 'Luciano Marín Arango', 'luciano marin arango': 'Luciano Marín Arango', 'luciano marin': 'Luciano Marín Arango',
  'jesus santrich': 'Seuxis Paucias Hernández Solarte', 'seuxis paucias hernandez solarte': 'Seuxis Paucias Hernández Solarte', 'seuxis pausias hernandez solarte': 'Seuxis Paucias Hernández Solarte', 'seuxis hernandez': 'Seuxis Paucias Hernández Solarte',
  'timochenko': 'Rodrigo Londoño Echeverri', 'timoleon jimenez': 'Rodrigo Londoño Echeverri', 'rodrigo londono echeverri': 'Rodrigo Londoño Echeverri', 'rodrigo londono': 'Rodrigo Londoño Echeverri',
  'gabino': 'Nicolás Rodríguez Bautista', 'nicolas rodriguez bautista': 'Nicolás Rodríguez Bautista',
  'antonio garcia': 'Eliécer Herlinto Chamorro Acosta', 'eliecer herlinto chamorro': 'Eliécer Herlinto Chamorro Acosta', 'eliecer chamorro': 'Eliécer Herlinto Chamorro Acosta',
  'pablito': 'Gustavo Aníbal Giraldo Quinchía', 'gustavo anibal giraldo': 'Gustavo Aníbal Giraldo Quinchía', 'gustavo giraldo quinchia': 'Gustavo Aníbal Giraldo Quinchía',
  'pablo beltran': 'Israel Ramírez Pineda', 'israel ramirez pineda': 'Israel Ramírez Pineda',
  'chiquito malo': 'Jobanis de Jesús Ávila Villadiego', 'jobanis de jesus avila villadiego': 'Jobanis de Jesús Ávila Villadiego', 'jobanis avila': 'Jobanis de Jesús Ávila Villadiego',
  'gonzalito': 'Wílmer Antonio Giraldo Quiroz', 'wilmer antonio giraldo quiroz': 'Wílmer Antonio Giraldo Quiroz', 'wilmer giraldo quiroz': 'Wílmer Antonio Giraldo Quiroz',
  'calarca': 'Alexánder Díaz Mendoza', 'alexander diaz mendoza': 'Alexánder Díaz Mendoza',
  'el paisa': 'Hernán Darío Velásquez Saldarriaga', 'hernan dario velasquez': 'Hernán Darío Velásquez Saldarriaga',
  'romana': 'Henry Castellanos Garzón', 'henry castellanos garzon': 'Henry Castellanos Garzón',
  'don berna': 'Diego Fernando Murillo Bejarano', 'diego fernando murillo bejarano': 'Diego Fernando Murillo Bejarano', 'diego murillo bejarano': 'Diego Fernando Murillo Bejarano',
  'don mario': 'Daniel Rendón Herrera', 'daniel rendon herrera': 'Daniel Rendón Herrera',
  'el mono jojoy': 'Víctor Julio Suárez Rojas', 'mono jojoy': 'Víctor Julio Suárez Rojas', 'jorge briceno': 'Víctor Julio Suárez Rojas',
  'alfonso cano': 'Guillermo León Sáenz Vargas', 'guillermo leon saenz': 'Guillermo León Sáenz Vargas',
  'pablo escobar': 'Pablo Escobar Gaviria', 'pablo escobar gaviria': 'Pablo Escobar Gaviria',
  'salvatore mancuso': 'Salvatore Mancuso Gómez', 'salvatore mancuso gomez': 'Salvatore Mancuso Gómez',
};
const CO_NICKS = ['otoniel', 'ivan mordisco', 'ivan marquez', 'jesus santrich', 'timochenko', 'gabino', 'chiquito malo', 'gonzalito', 'calarca', 'el paisa', 'romana', 'don berna', 'don mario', 'el mono jojoy', 'mono jojoy', 'alfonso cano', 'pablito', 'pablo beltran', 'antonio garcia'];
const VE_ALIASES = {
  'jesus santrich': 'Seuxis Paucias Hernández Solarte', 'seuxis paucias hernandez solarte': 'Seuxis Paucias Hernández Solarte', 'seuxis pausias hernandez solarte': 'Seuxis Paucias Hernández Solarte',
  'nino guerrero': 'Héctor Rusthenford Guerrero Flores', 'hector rusthenford guerrero flores': 'Héctor Rusthenford Guerrero Flores', 'hector guerrero flores': 'Héctor Rusthenford Guerrero Flores', 'hector guerrero': 'Héctor Rusthenford Guerrero Flores',
  'larry changa': 'Larry Amaury Álvarez Núñez', 'larry amaury alvarez nunez': 'Larry Amaury Álvarez Núñez', 'larry alvarez': 'Larry Amaury Álvarez Núñez',
  'johan petrica': 'Yohan José Romero', 'yohan jose romero': 'Yohan José Romero',
  'el koki': 'Carlos Luis Revete', 'carlos luis revete': 'Carlos Luis Revete', 'carlos revete': 'Carlos Luis Revete',
  'wilexis': 'Wilexis Alexander Acevedo Monasterios', 'wilexis acevedo': 'Wilexis Alexander Acevedo Monasterios', 'wilexis alexander acevedo monasterios': 'Wilexis Alexander Acevedo Monasterios',
  'el vampi': 'Carlos Calderón Martínez', 'carlos calderon martinez': 'Carlos Calderón Martínez',
  'el garbis': 'Garbis Ochoa Ruiz', 'garbis ochoa ruiz': 'Garbis Ochoa Ruiz',
  'el conejo': 'Teófilo Rodríguez Cazorla', 'teofilo rodriguez cazorla': 'Teófilo Rodríguez Cazorla',
  'el picure': 'José Antonio Tovar Colina', 'jose antonio tovar colina': 'José Antonio Tovar Colina',
  ...Object.fromEntries(['otoniel', 'ivan mordisco', 'ivan marquez', 'jesus santrich', 'timochenko', 'gabino', 'antonio garcia', 'pablito', 'pablo beltran', 'chiquito malo'].map(k => [k, CO_ALIASES[k]])),
};
const VE_NICKS = ['nino guerrero', 'larry changa', 'johan petrica', 'el koki', 'wilexis', 'el vampi', 'el garbis', 'el picure', 'otoniel', 'ivan mordisco', 'ivan marquez', 'jesus santrich', 'timochenko', 'gabino', 'pablito', 'antonio garcia'];

// Extra "not a person" terms for the person extractor: places, institutions and group fragments common in
// each country's reporting that are not already caught by the shared list in graph.mjs.
const CO_NOT_PERSON = ['clan del golfo', 'gulf clan', 'segunda marquetalia', 'second marquetalia', 'estado mayor', 'bogot[aá]', 'medell[ií]n', 'cali', 'c[uú]cuta', 'catatumbo', 'cauca', 'nari[nñ]o', 'antioquia', 'choc[oó]', 'arauca', 'buenaventura', 'tumaco', 'colombia', 'ur[aá]ba', 'bajo cauca', 'magdalena medio', 'putumayo', 'caquet[aá]', 'guaviare', 'meta', 'vichada', 'norte de santander', 'santander', 'valle del cauca', 'c[oó]rdoba', 'la guajira', 'cesar', 'bol[ií]var', 'sucre', 'tolima', 'huila', 'quind[ií]o', 'risaralda', 'caldas', 'boyac[aá]', 'cundinamarca', 'casanare', 'amazonas', 'vaup[eé]s', 'guain[ií]a', 'san andr[eé]s', 'ej[eé]rcito', 'polic[ií]a', 'armada', 'fiscal', 'defensor[ií]a', 'procuradur[ií]a', 'jep', 'justicia', 'paz total', 'total peace'];
const VE_NOT_PERSON = ['caracas', 'maracaibo', 'valencia', 'barquisimeto', 'zulia', 'aragua', 'tocor[oó]n', 'bol[ií]var', 'apure', 't[aá]chira', 'miranda', 'petare', 'cota 905', 'tren de', 'venezuela', 'carabobo', 'lara', 'falc[oó]n', 'sucre', 'anzo[aá]tegui', 'monagas', 'gu[aá]rico', 'barinas', 'portuguesa', 'trujillo', 'm[eé]rida', 'yaracuy', 'cojedes', 'nueva esparta', 'vargas', 'la guaira', 'delta amacuro', 'amazonas', 'arco minero', 'orinoco', 'faes', 'sebin', 'dgcim', 'cicpc', 'fanb', 'guardia nacional', 'pdvsa', 'chavismo', 'psuv', 'colectivo', 'socialist party', 'partido socialista', 'national assembly', 'asamblea nacional', 'supreme court'];

export const PROFILES = Object.freeze({
  cjng: {
    key: 'cjng', label: 'CJNG', title: 'CJNG Knowledge Graph', subject: 'CJNG', country: 'MX', countryName: 'Mexico',
    dataDir: join(RUNS, 'cjng'), snapshotFile: join(CONFIG, 'cjng-graph-snapshot.json.gz'),
    corpusSchema: 'insightcrime-cjng-corpus/1', graphSchema: 'cjng-graph/1',
    queries: [tagQuery('jalisco-cartel', TAG_JALISCO_CARTEL), tagQuery('el-mencho', TAG_EL_MENCHO), { name: 'search:CJNG', params: { search: 'CJNG' } }],
    focusTags: [TAG_JALISCO_CARTEL, TAG_EL_MENCHO], focusRe: CJNG_RE, maxTextChars: 60_000, maxArticles: Infinity,
    root: { kind: 'org', id: 'cjng' }, groupsFile: DEFAULT_GROUPS_FILE,
    personAliases: {}, unambiguousNicks: [], notPersonTerms: [], skipTags: [],
    corpusNote: 'every InSight Crime post tagged Jalisco Cartel or El Mencho plus full-text matches for “CJNG”',
    focusNote: 'CJNG is the focus (tag or ≥3 mentions)',
  },
  co: {
    key: 'co', label: 'Colombia', title: 'Colombia Knowledge Graph', subject: 'Colombia', country: 'CO', countryName: 'Colombia',
    dataDir: join(RUNS, 'co'), snapshotFile: join(CONFIG, 'co-graph-snapshot.json.gz'),
    corpusSchema: 'insightcrime-co-corpus/1', graphSchema: 'insightcrime-graph/1',
    queries: [tagQuery('colombia', TAGS.colombia), tagQuery('colombia-groups', TAGS.colombiaGroups), tagQuery('colombia-personalities', TAGS.colombiaPersonalities), tagQuery('eln', TAGS.eln), tagQuery('gaitanistas', TAGS.gaitanistas), tagQuery('ex-farc-mafia', TAGS.exFarcMafia), tagQuery('second-marquetalia', TAGS.secondMarquetalia), tagQuery('oficina-de-envigado', TAGS.oficinaDeEnvigado), tagQuery('farc', TAGS.farc)],
    focusTags: [TAGS.colombia, TAGS.colombiaGroups, TAGS.colombiaPersonalities, TAGS.eln, TAGS.gaitanistas, TAGS.exFarcMafia, TAGS.secondMarquetalia, TAGS.oficinaDeEnvigado, TAGS.farc],
    focusRe: /\bColombia\b|\bColombian\b/gi, maxTextChars: 25_000, maxArticles: 800,
    root: { kind: 'country', id: 'CO' }, groupsFile: join(CONFIG, 'co-groups.json'),
    personAliases: CO_ALIASES, unambiguousNicks: CO_NICKS, notPersonTerms: CO_NOT_PERSON,
    skipTags: ['colombia', 'colombia groups', 'colombia personalities', 'andean region', 'andes', 'south america', 'latin america'],
    corpusNote: 'every InSight Crime post tagged Colombia, Colombia Groups / Personalities, ELN, Gaitanistas, Ex-FARC Mafia, Second Marquetalia, Oficina de Envigado or FARC',
    focusNote: 'Colombia is the focus (tag or ≥3 mentions); the most recent 800 articles are graphed',
  },
  ve: {
    key: 've', label: 'Venezuela', title: 'Venezuela Knowledge Graph', subject: 'Venezuela', country: 'VE', countryName: 'Venezuela',
    dataDir: join(RUNS, 've'), snapshotFile: join(CONFIG, 've-graph-snapshot.json.gz'),
    corpusSchema: 'insightcrime-ve-corpus/1', graphSchema: 'insightcrime-graph/1',
    queries: [tagQuery('venezuela', TAGS.venezuela), tagQuery('venezuela-groups', TAGS.venezuelaGroups), tagQuery('venezuela-personalities', TAGS.venezuelaPersonalities), tagQuery('tren-de-aragua', TAGS.trenDeAragua), tagQuery('colectivos', TAGS.colectivos), tagQuery('megabandas', TAGS.megabandas), tagQuery('el-koki', TAGS.elKoki), tagQuery('wilexis', TAGS.wilexis), tagQuery('tren-del-llano', TAGS.trenDelLlano)],
    focusTags: [TAGS.venezuela, TAGS.venezuelaGroups, TAGS.venezuelaPersonalities, TAGS.trenDeAragua, TAGS.colectivos, TAGS.megabandas, TAGS.elKoki, TAGS.wilexis, TAGS.trenDelLlano],
    focusRe: /\bVenezuela\b|\bVenezuelan\b/gi, maxTextChars: 25_000, maxArticles: 800,
    root: { kind: 'country', id: 'VE' }, groupsFile: join(CONFIG, 've-groups.json'),
    personAliases: VE_ALIASES, unambiguousNicks: VE_NICKS, notPersonTerms: VE_NOT_PERSON,
    skipTags: ['venezuela', 'venezuela groups', 'venezuela personalities', 'andean region', 'caribbean', 'south america', 'latin america'],
    corpusNote: 'every InSight Crime post tagged Venezuela, Venezuela Groups / Personalities, Tren de Aragua, Colectivos, Megabandas, El Koki, Wilexis or Tren del Llano',
    focusNote: 'Venezuela is the focus (tag or ≥3 mentions); the most recent 800 articles are graphed',
  },
});
export const PROFILE_KEYS = Object.freeze(Object.keys(PROFILES));
export const DEFAULT_PROFILE = PROFILES.cjng;
// Country Home Page id (lowercase ISO) -> graph profile key.
export const COUNTRY_PROFILES = Object.freeze({ co: 'co', ve: 've' });

export function getProfile(key) {
  const p = PROFILES[String(key || 'cjng').toLowerCase()];
  if (!p) throw new Error(`unknown graph profile ${key}`);
  return p;
}
export function rootNodeId(profile = DEFAULT_PROFILE) {
  return profile.root.kind === 'org' ? `org:${profile.root.id}` : `country:${profile.root.id}`;
}
