// Deterministic (rule-based) extraction for narco event records: event type, casualty / arrest /
// seizure counts, named people and nicknames, and the original sources an article cites.
// Everything here is text-in → structured-out with no network; the LLM pass (llm.mjs) only fills
// gaps this module leaves.

import { fold } from './gazetteer.mjs';
import { STOP_WORDS, PERSON_CUE_BEFORE, PERSON_CUE_AFTER, lexiconScore } from './names.mjs';

export const EXTRACTOR_VERSION = 'narco-rules/1';

// Ordered by specificity: the first family whose pattern hits becomes the primary type, later ones are secondary.
export const EVENT_TYPES = [
  { id: 'tunnel', label: 'Cross-border tunnel', re: /\btunnel|\bt[uú]nel/i },
  { id: 'massacre', label: 'Massacre / mass killing', re: /\bmassacre|\bmasacre|mass (?:killing|grave)|fosa[s]? clandestina|clandestine grave|\bbodies (?:were )?(?:found|dumped|discovered)|\bcuerpos? (?:sin vida|desmembrad|calcinad|hallad|encontrad|abandonad)/i },
  { id: 'attack_on_authorities', label: 'Attack on security forces', re: /\b(?:police|officers?|soldiers?|troops|marines|national guard|guardia nacional|sedena|ej[eé]rcito|polic[ií]as?|militares?|agents?)\b[^.]{0,80}\b(?:ambush|attacked|killed|shot|murdered|gunned|emboscad|asesinad|atacad)|\b(?:ambush|attack on|ataque a|emboscada)[^.]{0,40}\b(?:police|soldiers|national guard|guardia nacional|polic[ií]a|militares|convoy)/i },
  { id: 'armed_clash', label: 'Armed clash / shootout', re: /\bshoot-?out|\bgun ?(?:fight|battle)|\bfirefight|\bclash(?:es|ed)?\b|\benfrentamiento|\bbalacera|\btiroteo|exchange of (?:gun)?fire|armed confrontation/i },
  { id: 'homicide', label: 'Homicide / execution', re: /\b(?:kill(?:s|ed|ing)?|murder(?:s|ed)?|slain|execut(?:es|ed|ion)|shot (?:dead|to death)|gunned down|found dead|dismembered|beheaded|decapitad|asesinad[oa]s?|ejecutad[oa]s?|homicid|dead bodies?|(?:\d+|several|multiple|dozens? of|dismembered|burned) bodies|bodies (?:were |was )?(?:found|dumped|discovered|recovered|left)|body (?:was )?found|left \w+ dead)\b/i },
  { id: 'kidnapping', label: 'Kidnapping / disappearance', re: /\bkidnap|\babduct|\bdisappear|\bmissing (?:persons?|people|men|women|students)|\bsecuestr|\bdesaparecid|\blevant[oó]n|\bhostage/i },
  { id: 'extortion', label: 'Extortion', re: /\bextor[st]i|derecho de piso|cobro de piso|\bprotection (?:money|racket)/i },
  { id: 'blockade', label: 'Narco-blockade / arson', re: /narco-?bloqueo|\bblockades?\b|burn(?:ed|ing) (?:vehicles|buses|cars|businesses|stores)|\bquema de (?:veh[ií]culos|negocios)|\barson/i },
  { id: 'displacement', label: 'Forced displacement', re: /\bdisplaced|\bdesplazad|forced to flee|\bfled their homes/i },
  { id: 'prison', label: 'Prison incident', re: /\bprison (?:riot|break|escape|fight|brawl)|\bmot[ií]n|\bfuga (?:de|del) (?:penal|reo)|\binmates? (?:killed|escaped|riot)/i },
  { id: 'sanctions', label: 'Sanctions designation', re: /\bofac\b|\bsanction|\btreasury (?:department )?(?:designat|target)|\bdesignated (?:as )?(?:a )?(?:foreign terrorist|sdgt|fto)|\bblocked property/i },
  { id: 'extradition', label: 'Extradition / transfer to U.S.', re: /\bextradit|\bextradici|\bexpelled to the (?:united states|u\.s\.)|transferred to (?:u\.s\.|american) custody|\bentregad[oa]s? a (?:estados unidos|eeuu|eua)/i },
  { id: 'prosecution', label: 'Prosecution / sentencing', re: /\b(?:indict|arraign|charged(?: with)?|charges|pleaded? guilty|plea agreement|sentenced?s?|convicted|conviction|trial|jury|federal court|district court|u\.s\. attorney|attorney's office|grand jury|complaint (?:was )?(?:filed|unsealed)|unsealed)\b|\bsentenciad|\bvinculad[oa]s? a proceso|\bfiscal[ií]a/i },
  { id: 'arrest', label: 'Arrest / capture', re: /\barrest|\bdetain|\bdetenid|\bcaptur|\bapprehend|\btaken into custody|\bin custody|\baseguramiento de (?:personas|presuntos)/i },
  { id: 'seizure', label: 'Seizure / interdiction', re: /\bseiz|\bconfiscat|\bdecomis|\basegur[oa]|\binterdict|\bintercept|\bstash house|\bnarcolaborator|\bclandestine lab|\bdrug lab|\bfound (?:\d+|\w+) (?:pounds|kilos|kilograms)/i },
  { id: 'smuggling', label: 'Smuggling / trafficking', re: /\bsmuggl|\btraffick|\bcontraband|\bnarcotics|\bmigrants?\b|\bhuman smuggling|\balien smuggling|\btr[aá]fico de|\bpolleros?|\bcoyotes?\b/i },
];
export const EVENT_TYPE_IDS = EVENT_TYPES.map(t => t.id);
export const EVENT_TYPE_LABELS = Object.fromEntries(EVENT_TYPES.map(t => [t.id, t.label]));

// The headline names the event; body-only hits are secondary types (background, prior incidents).
export function classifyEvent(text, counts = {}, title = '') {
  const s = String(text || '');
  const headline = EVENT_TYPES.filter(t => t.re.test(String(title || ''))).map(t => t.id);
  const bodyTypes = EVENT_TYPES.filter(t => t.re.test(s)).map(t => t.id);
  const types = [...new Set([...headline, ...bodyTypes])];
  let primary = types[0] || 'other';
  if (types.includes('prosecution') && primary === 'arrest') primary = 'prosecution';
  if (types.includes('seizure') && primary === 'smuggling') primary = 'seizure';
  if ((primary === 'homicide' || primary === 'armed_clash') && (counts.killed || 0) >= 5) {
    primary = 'massacre';
    if (!types.includes('massacre')) types.unshift('massacre');
  }
  return { primary, types };
}

// ---------- counts ----------

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  a: 1, an: 1, dozen: 12, 'a dozen': 12, 'two dozen': 24, 'half a dozen': 6,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100,
};
const NUM_RE_SRC = `(\\d{1,3}(?:[,.]\\d{3})*(?:\\.\\d+)?|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')})`;

export function parseNumber(tok) {
  const t = fold(tok);
  if (t in NUM_WORDS) return NUM_WORDS[t];
  const n = Number(String(tok).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Each pattern: [regex with the number in group 1, max plausible value]
const COUNT_PATTERNS = {
  killed: [
    new RegExp(`${NUM_RE_SRC}\\s+(?:people|persons|men|women|civilians|victims|migrants|gunmen|suspects|members|sicarios|police(?: officers)?|officers|soldiers|students|bodies|corpses)?\\s*(?:were |was |had been |found |left )?(?:killed|dead|murdered|executed|slain|shot dead|shot to death|gunned down|massacred|found dead)`, 'gi'),
    new RegExp(`(?:killed|murdered|executed|left|leaving|claimed the lives of|death toll (?:of|rose to|reached))\\s+(?:at least |some |about |more than |over |up to |nearly )?${NUM_RE_SRC}\\s+(?:people|persons|men|women|dead|civilians|victims|migrants|members|officers|soldiers|police)`, 'gi'),
    new RegExp(`${NUM_RE_SRC}\\s+(?:bodies|corpses|cuerpos|cad[aá]veres|muertos|asesinados|ejecutados|fallecidos)`, 'gi'),
    new RegExp(`(?:remains of|bodies of)\\s+(?:at least |some |about |more than |over )?${NUM_RE_SRC}\\s+(?:people|persons|men|women|victims|migrants)`, 'gi'),
  ],
  wounded: [
    new RegExp(`${NUM_RE_SRC}\\s+(?:people|persons|men|women|others|civilians|officers|soldiers|police(?: officers)?|bystanders)?\\s*(?:were |was )?(?:wounded|injured|hurt|heridos|lesionados)`, 'gi'),
    new RegExp(`(?:wounded|injured|injuring|wounding)\\s+(?:at least |some |about |more than |over )?${NUM_RE_SRC}`, 'gi'),
  ],
  arrested: [
    new RegExp(`${NUM_RE_SRC}\\s+(?:people|persons|men|women|suspects|individuals|members|alleged|suspected|defendants|gunmen|sicarios|migrants|smugglers|cartel members|police officers|officers|others)?\\s*(?:were |was |have been |had been )?(?:arrested|detained|captured|apprehended|taken into custody|charged|indicted|detenidos|capturados|arrestados|aprehendidos)`, 'gi'),
    new RegExp(`(?:arrest(?:ed|s) of|detention of|arrested|detained|captured|apprehended|indicted|charged)\\s+(?:at least |some |about |more than |over )?${NUM_RE_SRC}\\s+(?:people|persons|men|women|suspects|individuals|members|defendants|alleged|suspected|migrants|smugglers|others)`, 'gi'),
  ],
  kidnapped: [
    new RegExp(`${NUM_RE_SRC}\\s+(?:people|persons|men|women|migrants|students|workers|miners|farmers|others)?\\s*(?:were |was |have been |had been |remain |are )?(?:kidnapped|abducted|missing|disappeared|taken|secuestrados|desaparecidos|levantados)`, 'gi'),
    new RegExp(`(?:kidnapping|abduction|disappearance) of\\s+(?:at least |some |about |more than |over )?${NUM_RE_SRC}\\s+(?:people|persons|men|women|migrants|students|workers|miners)`, 'gi'),
  ],
};
const COUNT_MAX = { killed: 5000, wounded: 5000, arrested: 5000, kidnapped: 5000 };

function bestCount(text, patterns, max) {
  let best = null;
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseNumber(m[1]);
      if (n == null || n < 1 || n > max) continue;
      if (best == null || n > best) best = n;
    }
  }
  return best;
}

export function extractCounts(text) {
  const s = String(text || '');
  const out = {};
  for (const [k, pats] of Object.entries(COUNT_PATTERNS)) {
    const n = bestCount(s, pats, COUNT_MAX[k]);
    if (n != null) out[k] = n;
  }
  return out;
}

// ---------- seizures ----------

const DRUGS = {
  fentanyl: /fentanyl|fentanilo/i, methamphetamine: /meth(?:amphetamine)?|metanfetamina|cristal\b|crystal/i, cocaine: /cocaine|coca[ií]na/i, heroin: /heroin|hero[ií]na/i,
  marijuana: /marijuana|marihuana|cannabis|mariguana/i, 'synthetic pills': /pills|tablets|pastillas|comprimidos/i, precursor: /precursor/i,
};
// Numbers preceded by a currency sign or embedded in a larger number are amounts, not counts.
const NOT_MONEY = '(?<![\\$\\d.,])(?<!US\\$)(?<!USD\\s?)';
const QTY_RE = new RegExp(`${NOT_MONEY}(\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*(?:million\\s+)?(kilograms?|kilos?|kg|pounds?|lbs?|tons?|tonnes?|toneladas?|kilogramos?|libras|grams?|gramos|liters?|litros|gallons?|doses|dosis|pills|tablets|pastillas)\\s+(?:of\\s+|de\\s+)?([A-Za-z\\u00C0-\\u017F ]{3,40}?)(?=[,.;)]|$|\\s+(?:and|with|worth|valued|hidden|were|was|in|that|estimated)\\b)`, 'gi');
const PILLS_RE = /(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?\s*million)\s+(?:fentanyl[- ]laced\s+|counterfeit\s+|fake\s+)?(?:fentanyl\s+)?(pills|tablets|pastillas)/gi;
const WEAPONS_RE = new RegExp(`${NOT_MONEY}${NUM_RE_SRC}\\s+(?:(?:assault |long |high-powered |automatic )?(?:rifles?|weapons?|firearms?|guns?|handguns?|pistols?|grenades?|magazines?|armas(?: largas| de fuego)?|fusiles|granadas|cargadores))\\b(?!\\s+(?:payment|fee|purchase|deal|charge|offen[cs]e|conviction))`, 'gi');
const CASH_RE = /(?:US\$|\$|USD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(million|billion|thousand|mil|millones)?(?:\s*(?:dollars|d[oó]lares|USD|pesos|MXN))?|(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(million|millones|mil)\s+(dollars|d[oó]lares|pesos)/gi;
const VEHICLES_RE = new RegExp(`${NOT_MONEY}${NUM_RE_SRC}\\s+(?:armored |stolen |tactical |monster )?(?:vehicles?|trucks?|cars?|veh[ií]culos|camionetas)`, 'gi');
// A quantity is a seizure only when its sentence says the goods were taken / found / trafficked;
// bare mentions ("100 drones were downed", "30,000 guns a year cross the border") are statistics.
const SEIZE_CTX_SRC = 'seiz\\w*|confiscat\\w*|recover\\w*|forfeit\\w*|found|discover\\w*|hidden|conceal\\w*|stash\\w*|secur\\w*|incaut\\w*|asegur\\w*|decomis\\w*|arsenal';
const SEIZE_CTX_RE = new RegExp(`\\b(?:${SEIZE_CTX_SRC})\\b`, 'i');
const DRUG_CTX_RE = new RegExp(`\\b(?:${SEIZE_CTX_SRC}|traffick\\w*|smuggl\\w*|transport\\w*|carr(?:y|ied|ying)|possess\\w*|distribut\\w*|s(?:old|ell\\w*)|deliver\\w*|import\\w*|conspir\\w*|laced|contain\\w*|intercept\\w*|interdict\\w*|arrest\\w*|charged|convicted|sentenced|pleaded|indict\\w*)\\b`, 'i');
// Money additionally counts when it was laundered / described as proceeds, and never when the figure
// itself is a fee, payment, fine, bounty or price.
const CASH_CTX_RE = new RegExp(`\\b(?:${SEIZE_CTX_SRC}|bulk cash|launder\\w*|dinero en efectivo|in cash|in currency|cash proceeds|drug proceeds)\\b`, 'i');
const CASH_NOT_RE = /^\s*(?:\w+\s+){0,2}?(?:fee|fees|payment|payments|paid|pay|price|bounty|reward|fine|fines|restitution|salary|salaries|bribe|bribes|per (?:person|migrant|head|kilo|pound|month|week)|a (?:person|migrant|head|kilo|pound|month|week)|each)\b/i;
function sentenceAt(s, idx) {
  const start = Math.max(s.lastIndexOf('. ', idx), s.lastIndexOf('\n', idx), s.lastIndexOf('; ', idx)) + 1;
  const endCandidates = [s.indexOf('. ', idx), s.indexOf('\n', idx), s.indexOf('; ', idx)].filter(i => i >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : s.length;
  return s.slice(start, end);
}

function unitToKg(qty, unit) {
  const u = fold(unit);
  if (/^(kilogram|kilo|kg|kilogramo)/.test(u)) return qty;
  if (/^(pound|lb|libra)/.test(u)) return qty * 0.45359237;
  if (/^(ton|tonne|tonelada)/.test(u)) return qty * 1000;
  if (/^(gram|gramo)/.test(u)) return qty / 1000;
  return null;
}

export function extractSeizures(text) {
  const s = String(text || '');
  const drugs = [];
  let m;
  QTY_RE.lastIndex = 0;
  while ((m = QTY_RE.exec(s)) !== null) {
    const qty = parseNumber(m[1]);
    if (qty == null || qty <= 0 || !DRUG_CTX_RE.test(sentenceAt(s, m.index))) continue;
    const million = /million/i.test(m[0].slice(0, m[0].indexOf(m[2])));
    const substance = Object.keys(DRUGS).find(k => DRUGS[k].test(m[3]));
    if (!substance) continue;
    const q = million ? qty * 1e6 : qty;
    const kg = unitToKg(q, m[2]);
    drugs.push({ substance, qty: q, unit: fold(m[2]).replace(/s$/, ''), ...(kg != null ? { kg: Number(kg.toFixed(3)) } : {}) });
  }
  PILLS_RE.lastIndex = 0;
  while ((m = PILLS_RE.exec(s)) !== null) {
    const raw = m[1];
    const qty = /million/i.test(raw) ? Number(raw.replace(/[^\d.]/g, '')) * 1e6 : parseNumber(raw);
    if (!qty || drugs.some(d => d.unit === 'pill' && d.qty === qty) || !DRUG_CTX_RE.test(sentenceAt(s, m.index))) continue;
    drugs.push({ substance: /fentanyl/i.test(m[0]) ? 'fentanyl' : 'synthetic pills', qty, unit: 'pill' });
  }
  let weapons = null;
  WEAPONS_RE.lastIndex = 0;
  while ((m = WEAPONS_RE.exec(s)) !== null) {
    const n = parseNumber(m[1]);
    if (n && n <= 100000 && SEIZE_CTX_RE.test(sentenceAt(s, m.index)) && (weapons == null || n > weapons)) weapons = n;
  }
  let vehicles = null;
  VEHICLES_RE.lastIndex = 0;
  while ((m = VEHICLES_RE.exec(s)) !== null) {
    const n = parseNumber(m[1]);
    if (n && n <= 10000 && SEIZE_CTX_RE.test(sentenceAt(s, m.index)) && (vehicles == null || n > vehicles)) vehicles = n;
  }
  const cash = [];
  CASH_RE.lastIndex = 0;
  while ((m = CASH_RE.exec(s)) !== null) {
    const num = parseNumber(m[1] || m[3]);
    if (num == null) continue;
    const scale = fold(m[2] || m[4] || '');
    const mult = /^(million|millones)$/.test(scale) ? 1e6 : scale === 'billion' ? 1e9 : /^(thousand|mil)$/.test(scale) ? 1e3 : 1;
    const currency = /pesos|mxn/i.test(m[0]) ? 'MXN' : 'USD';
    const amount = num * mult;
    if (amount < 1000 || amount > 1e11) continue;
    if (CASH_NOT_RE.test(s.slice(m.index + m[0].length, m.index + m[0].length + 40)) || !CASH_CTX_RE.test(sentenceAt(s, m.index))) continue;
    if (!cash.some(c => c.amount === amount && c.currency === currency)) cash.push({ amount, currency });
  }
  const out = {};
  if (drugs.length) out.drugs = drugs.slice(0, 12);
  if (weapons != null) out.weapons = weapons;
  if (vehicles != null) out.vehicles = vehicles;
  if (cash.length) out.cash = cash.slice(0, 6);
  return out;
}

// ---------- people ----------

const CAP0 = '[A-Z\\u00C0-\\u00DE][a-z\\u00DF-\\u00FF\\u0100-\\u017F\'’]+';
const CAP = `${CAP0}(?:-${CAP0})?`;
const PARTICLE = '(?:de|del|la|las|los|y|e|da|di|van|von|el)';
const NAME_RE = new RegExp(`\\b(${CAP}(?:\\s+(?:${PARTICLE}\\s+)?${CAP}){1,4})\\b`, 'g');
const NICK_RE = new RegExp(`(?:alias|a\\.k\\.a\\.|aka|also known as|known as|apodad[oa]|conocid[oa] como|\\(a\\))\\s*[\"“'‘]?((?:El|La|Los|Las)\\s+${CAP}(?:\\s+${CAP})?|${CAP}(?:\\s+${CAP})?)[\"”'’]?|[\"“]((?:El|La)\\s+${CAP}(?:\\s+${CAP})?)[\"”]`, 'g');
const TITLE_RE = /^(?:Mr|Mrs|Ms|Dr|Gen|Gov|Sen|Rep|Judge|President|Governor|Senator|Attorney|Secretary|Sheriff|Chief|Agent|Officer|Deputy|Director|Commissioner|Assistant|Special|Acting|U\.S\.|US|United States|New|Los|Las|San|Santa|El|La|Rio|Río|Ciudad|Cd|Puerto|Villa|Fort|Lake|Mount|Saint|St)$/;
// Capitalized tokens that are never part of a personal name (institutions, places, calendar words, section labels).
const ORG_WORDS = /^(?:Cartel|C[aá]rtel|C[aá]rteles|Carteles|Department|Departamento|District|Court|Office|Oficina|Police|Polic[ií]a|Guard|Guardia|Army|Ej[eé]rcito|Navy|Marina|Patrol|Customs|Border|Frontera|Agency|Agencia|Bureau|Task|Force|County|Condado|City|Ciudad|State|Estado|University|Universidad|Hospital|Press|News|Times|Tribune|Journal|Post|Herald|Diario|Noticias|Radio|Television|TV|Network|Report|Matters|Desk|Beat|Center|Centre|School|Church|Iglesia|Highway|Street|Avenue|Avenida|Bridge|Puente|Airport|Aeropuerto|Prison|Prisi[oó]n|Penal|Federal|National|Nacional|International|Internacional|Republic|Rep[uú]blica|Government|Gobierno|Ministry|Secretar[ií]a|Fiscal[ií]a|Attorney|Congress|Senate|Senado|House|Chamber|Assembly|Committee|Commission|Comisi[oó]n|Institute|Instituto|Foundation|Fundaci[oó]n|Association|Asociaci[oó]n|Group|Grupo|Company|Corporation|Inc|LLC|Bank|Banco|Sector|Station|Estaci[oó]n|Facility|Detention|Immigration|Enforcement|Homeland|Security|Justice|Justicia|Defense|Defensa|Treasury|Tesoro|Drug|Narcotics|Fentanyl|Cocaine|Methamphetamine|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo|Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre|Christmas|Easter|Holy|Week|Day|Year|Operation|Operaci[oó]n|Plan|Project|Program|Act|Law|Ley|Code|Article|Section|Chapter|Title|Phase|Zone|Zona|Region|Regi[oó]n|Valley|Valle|Sierra|Desert|Desierto|River|Gulf|Golfo|Pacific|Pac[ií]fico|Atlantic|Caribbean|Caribe|North|South|East|West|Norte|Sur|Este|Oeste|Central|Nueva|Nuevo|New|Generaci[oó]n|Generation|Familia|Family|Unidos|United|Zetas|Templarios|Viagras|Chapitos|Mayiza|Photo|Image|Video|Source|Fuente|Sources|Fuentes|Editor|Reporter|Staff|Correspondent|Translated|Translation|Reprinted|Republished|Courtesy|Copyright|Rights|Reserved|Read|More|Click|Here|Subscribe|Follow|Share|Comment|Comments|Reply|Update|Updated|Breaking|Exclusive|Opinion|Analysis|Editorial|Column|Series|Part|Story|Stories|Articles|Page|Home|About|Contact|Privacy|Terms|Policy|Politics|Business|Sports|Culture|Society|Health|Science|Technology|World|Nation|Local|Metro|Crime|Courts|Education|Environment|Energy|Money|Markets|Economy|Trade|Wall|Fence|Checkpoint|Port|Entry|Crossing|Migrants|Migrant|Asylum|Refugee|Refugees|Deportation|Deported|Detained|Arrest|Arrested|Custody|Charged|Indicted|Sentenced|Convicted|Guilty|Trial|Jury|Verdict|Appeal|Prosecutor|Prosecutors|Defendant|Defendants|Victim|Victims|Witness|Witnesses|Suspect|Suspects|Gunman|Gunmen|Shooter|Shooting|Killing|Murder|Homicide|Massacre|Kidnapping|Extortion|Trafficking|Smuggling|Laundering|Corruption|Bribery|Gang|Mafia|Mob|Organized|Criminal|Organization|Organizaci[oó]n|Cell|Faction|Facci[oó]n|Plaza|Boss|Leader|Lieutenant|Commander|Capo|Kingpin|Hitman|Sicario|Sicarios|Halcones|Estacas|Special|Forces|Fuerzas|Especiales|Elite|Tropa|Infierno|Escorpiones|Ciclones|Metros|Rojos|L[ií]nea|Aztecas|Mexicles|Artistas|Asesinos|Mexican|Mexicana|Mexicano|American|Americans|Estados|America|Washington|Governor|Gobernador|President|Presidente|Secretary|Secretario|Senator|Senador|Mayor|Alcalde|General|Colonel|Coronel|Captain|Capit[aá]n|Sergeant|Sargento|Judge|Juez|Justice|Magistrate|Attorney|Fiscal|Agent|Agente|Officer|Oficial|Chief|Jefe|Director|Deputy|Assistant|Acting|Interim|Former|Late|Alleged|Suspected|Reputed|Notorious|Infamous|Fugitive|Wanted|Missing|Dead|Slain|Killed|Murdered|Executed|Kidnapped|Arrested|Detained|Captured|Extradited|Convicted|Sentenced)$/;
const MAX_PEOPLE = 12;

const PARTICLE_RE = new RegExp(`^${PARTICLE}$`, 'i');
// Bylines and section labels that precede article text on aggregator posts.
const BYLINE_RE = /["“]?[A-Z][\w’'-]+(?:\s+[A-Z][\w’'-]+){0,2}["”]?\s+for\s+Borderland\s+Beat\b|\bBy\s+[A-Z][\w’'-]+(?:\s+[A-Z][\w’'-]+){0,2}\b/g;

// A phrase is a person when it is lexically name-like (two or more tokens from the name lexicon) or
// when the surrounding text marks it as one (age, title, alias, or a verb that takes a person).
// Title-Case headline fragments fail both tests.
function acceptName(phrase, tokens, isKnown, before, after) {
  if (tokens.length < 2 || tokens.length > 5) return false;
  if (TITLE_RE.test(tokens[0])) return false;
  const nonParticle = tokens.filter(t => !PARTICLE_RE.test(t));
  if (nonParticle.length < 2) return false;
  if (nonParticle.some(tok => ORG_WORDS.test(tok))) return false;
  const folded = nonParticle.map(fold);
  if (folded.some(t => STOP_WORDS.has(t))) return false;
  if (new Set(folded).size !== folded.length) return false;
  if (isKnown(phrase)) return false;
  const score = lexiconScore(folded);
  if (score >= 2) return true;
  const cued = PERSON_CUE_BEFORE.test(before) || PERSON_CUE_AFTER.test(after);
  return cued && (score >= 1 || nonParticle.length >= 2);
}

// Blank out extracted person names (same-length, offsets preserved) so surname-like place names
// ("De Leon", "Guerrero") inside a name are not geocoded.
export function maskPeopleNames(text, people) {
  let s = String(text || '');
  for (const p of people || []) {
    const name = String(p?.name || '').trim();
    if (!name.includes(' ')) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'gi');
    s = s.replace(re, m => ' '.repeat(m.length));
  }
  return s;
}

// `isKnown(phrase)` lets the caller veto phrases that are gazetteer places or group aliases.
export function extractPeople(text, { isKnown = () => false } = {}) {
  const s = String(text || '').replace(/\s+/g, ' ').replace(BYLINE_RE, ' ');
  const people = new Map();
  let m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(s)) !== null && people.size < MAX_PEOPLE * 3) {
    let phrase = m[1].replace(/[’']s$/, '');
    let tokens = phrase.split(/\s+/);
    let start = m.index;
    // "Defendant Maria Navarro", "Agent John Smith": drop leading role words, keep the name.
    while (tokens.length > 2 && (TITLE_RE.test(tokens[0]) || ORG_WORDS.test(tokens[0]))) {
      start += tokens[0].length + 1;
      tokens = tokens.slice(1);
      phrase = tokens.join(' ');
    }
    const before = s.slice(Math.max(0, start - 60), start);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (!acceptName(phrase, tokens, isKnown, before, after)) continue;
    // Sentence-initial two-word phrases ("Mexican Authorities") are usually not names.
    if (tokens.length === 2 && (m.index === 0 || /[.!?]\s$/.test(before.slice(-2)))) continue;
    const key = fold(phrase);
    const cur = people.get(key) || { name: phrase, mentions: 0, first: start };
    cur.mentions++;
    people.set(key, cur);
  }
  // Collapse "Iván Archivaldo Guzmán" into "Iván Archivaldo Guzmán Salazar" when one is a prefix of the other.
  const arr = [...people.values()].sort((a, b) => b.name.length - a.name.length);
  const kept = [];
  for (const p of arr) {
    const k = fold(p.name);
    const longer = kept.find(q => fold(q.name).startsWith(k + ' ') || fold(q.name).endsWith(' ' + k));
    if (longer) { longer.mentions += p.mentions; longer.first = Math.min(longer.first, p.first); continue; }
    kept.push(p);
  }
  const nicknames = [];
  NICK_RE.lastIndex = 0;
  while ((m = NICK_RE.exec(s)) !== null) {
    const nick = (m[1] || m[2]).trim();
    if (nick.length > 40 || ORG_WORDS.test(nick.replace(/^(El|La|Los|Las)\s+/, '')) && !/^(El|La)\s/.test(nick)) continue;
    if (!nicknames.includes(nick)) nicknames.push(nick);
    // Attach to the nearest preceding person mention.
    const near = kept.filter(p => p.first < m.index).sort((a, b) => (m.index - a.first) - (m.index - b.first))[0];
    if (near && !near.alias) near.alias = nick;
  }
  return {
    people: kept.sort((a, b) => b.mentions - a.mentions || a.first - b.first).slice(0, MAX_PEOPLE).map(p => ({ name: p.name, mentions: p.mentions, ...(p.alias ? { alias: p.alias } : {}) })),
    nicknames: nicknames.slice(0, MAX_PEOPLE),
  };
}

// ---------- cited sources ----------

const KNOWN_OUTLETS = [
  'Proceso', 'Reforma', 'El Universal', 'Milenio', 'Zeta', 'Zeta Tijuana', 'Riodoce', 'Río Doce', 'Ríodoce', 'La Jornada', 'El Norte', 'Infobae', 'El Diario de Juárez', 'El Diario',
  'Animal Político', 'Excélsior', 'El Sol de México', 'El Sol de Sinaloa', 'El Sol de Tijuana', 'El Financiero', 'Aristegui Noticias', 'La Silla Rota', 'SinEmbargo', 'Debate', 'El Debate',
  'Noroeste', 'Línea Directa', 'El Imparcial', 'Expreso', 'El Heraldo de México', 'La Voz de la Frontera', 'El Mañana', 'Hoy Tamaulipas', 'Valor por Tamaulipas', 'Código Rojo', 'La Prensa',
  'Vanguardia', 'El Siglo de Torreón', 'La Opinión', 'Quadratín', 'Cambio de Michoacán', 'El Sur', 'Periódico Correo', 'Zócalo', 'Telediario', 'N+', 'Televisa', 'TV Azteca', 'Azteca Noticias',
  'Reuters', 'Associated Press', 'AP', 'AFP', 'EFE', 'Bloomberg', 'The New York Times', 'New York Times', 'Washington Post', 'Los Angeles Times', 'Wall Street Journal', 'The Guardian', 'BBC',
  'CNN', 'Univision', 'Telemundo', 'Vice', 'Vice News', 'InSight Crime', 'Insight Crime', 'Borderland Beat', 'Border Report', 'Texas Tribune', 'El Paso Matters', 'El Paso Times', 'KJZZ', 'Fronteras Desk',
  'San Diego Union-Tribune', 'Arizona Daily Star', 'Arizona Republic', 'Nogales International', 'Laredo Morning Times', 'The Monitor', 'Brownsville Herald', 'Houston Chronicle', 'San Antonio Express-News',
  'Department of Justice', 'DOJ', 'U.S. Attorney\'s Office', 'DEA', 'FBI', 'CBP', 'ICE', 'HSI', 'Treasury', 'OFAC', 'FGR', 'Fiscalía General de la República', 'Sedena', 'SEDENA', 'Guardia Nacional', 'Semar', 'SEMAR', 'SSPC',
  'Fiscalía', 'Gobierno de México', 'Presidencia',
];
const OUTLET_RE = new RegExp(`\\b(${KNOWN_OUTLETS.map(o => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
const SOURCE_LINE_RE = /(?:^|\n|\s)(?:Sources?|Fuentes?|Source articles?|Via)\s*:\s*([^\n]{2,300})/gi;
const ATTRIB_RE = /\b(?:[Aa]ccording to|[Aa]s reported by|[Rr]eported by|[Cc]iting|[Cc]ited by|[Vv]ia|[Ss]eg[uú]n|[Dd]e acuerdo con|[Ii]nformaci[oó]n de)\s+(?:the\s+|a\s+|el\s+|la\s+)?([A-Z][A-Za-z\u00C0-\u017F.'’+-]*(?:\s+(?:de|del|la|of|the|&|y)\s+)?(?:\s?[A-Z][A-Za-z\u00C0-\u017F.'’+-]*){0,3})/g;
const ATTRIB_STOP = /^(?:police|authorities|officials|prosecutors|investigators|the|a|an|local|state|federal|mexican|u\.s\.|us|sources|witnesses|residents|reports|court|documents|records|data|an|its|his|her|their|our|one|two|three|several|some|many|most|all)\b/i;

export function extractCitedSources(text, rawHtml = null) {
  const s = String(text || '');
  const out = new Map();
  const add = (name, kind, url = null) => {
    const clean = String(name || '').replace(/\s+/g, ' ').replace(/[,.;:]+$/, '').trim().slice(0, 80);
    if (clean.length < 2) return;
    const key = fold(clean);
    if (!key || ATTRIB_STOP.test(clean)) return;
    const cur = out.get(key) || { name: clean, kind, ...(url ? { url } : {}) };
    if (url && !cur.url) cur.url = url;
    if (kind === 'explicit') cur.kind = 'explicit';
    out.set(key, cur);
  };
  let m;
  SOURCE_LINE_RE.lastIndex = 0;
  while ((m = SOURCE_LINE_RE.exec(s)) !== null) {
    const line = m[1];
    OUTLET_RE.lastIndex = 0;
    let hit = false, o;
    while ((o = OUTLET_RE.exec(line)) !== null) { add(o[1], 'explicit'); hit = true; }
    if (!hit) {
      for (const part of line.split(/[,;|/]| and | y /)) {
        const p = part.replace(/https?:\/\/\S+/g, '').trim();
        if (p && p.length <= 60 && /^[A-Z\u00C0-\u00DE]/.test(p)) add(p, 'explicit');
      }
    }
  }
  ATTRIB_RE.lastIndex = 0;
  while ((m = ATTRIB_RE.exec(s)) !== null) {
    const cand = m[1].trim();
    OUTLET_RE.lastIndex = 0;
    const o = OUTLET_RE.exec(cand);
    if (o) add(o[1], 'attribution');
  }
  // Outlet names anywhere in the body count as attribution only if the article did not already credit them.
  OUTLET_RE.lastIndex = 0;
  while ((m = OUTLET_RE.exec(s)) !== null) {
    if (!out.has(fold(m[1]))) add(m[1], 'mention');
  }
  if (rawHtml) {
    const hrefRe = /href\s*=\s*["'](https?:\/\/[^"'\s<>]{8,300})["']/gi;
    while ((m = hrefRe.exec(String(rawHtml))) !== null) {
      let host;
      try { host = new URL(m[1]).hostname.replace(/^www\./, ''); } catch { continue; }
      if (/blogger|blogspot|google|facebook|twitter|x\.com|youtube|instagram|whatsapp|telegram|t\.me|tiktok|feedburner|gravatar|wp\.com/i.test(host)) continue;
      add(host, 'link', m[1]);
    }
  }
  return [...out.values()].slice(0, 12);
}

// ---------- date ----------

export function toDay(iso) {
  const t = new Date(iso || '').getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
