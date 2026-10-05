// Name-variant generation for Target Development (after Bellingcat's name-variant-search idea).
//
// A generated variant is a *search term*, never an alias: it widens the literal search over local
// stores so a target spelled "Soleimani" in one source and "Suleimani" in another is still found, and
// every mention it produces is flagged `generated` + `weak` so the analyst can see the match came from
// a spelling rule, not from a published a.k.a. Rules are deterministic; nothing is looked up online.

export const MAX_VARIANTS = 48;
export const KINDS = ['diacritics', 'transliteration', 'spelling', 'order', 'particle', 'hyphen'];

// --- Cyrillic → Latin (BGN/PCGN-ish plus the spellings people actually type) ---
const CYR = {
  а: ['a'], б: ['b'], в: ['v', 'w'], г: ['g', 'h'], д: ['d'], е: ['e', 'ye'], ё: ['e', 'yo', 'io'], ж: ['zh', 'j'], з: ['z'], и: ['i', 'y'], й: ['y', 'i', 'j'],
  к: ['k'], л: ['l'], м: ['m'], н: ['n'], о: ['o'], п: ['p'], р: ['r'], с: ['s'], т: ['t'], у: ['u'], ф: ['f'], х: ['kh', 'h'], ц: ['ts', 'c'],
  ч: ['ch', 'tch'], ш: ['sh'], щ: ['shch', 'sch'], ъ: [''], ы: ['y', 'i'], ь: ['', "'"], э: ['e'], ю: ['yu', 'iu', 'ju'], я: ['ya', 'ia', 'ja'],
  і: ['i'], ї: ['yi', 'i'], є: ['ye', 'ie'], ґ: ['g'],
};
const HAS_CYR = /[\u0400-\u04FF]/;

// --- Latin-side rewrite rules: [regex, replacements[]] applied one at a time per token ---
const RU_RULES = [
  [/ov$/i, ['off', 'ow']], [/ev$/i, ['eff', 'ew', 'yev']], [/yev$/i, ['ev']], [/sky$/i, ['skiy', 'ski', 'skii']], [/skiy$/i, ['sky', 'ski']], [/ski$/i, ['sky', 'skiy']],
  [/iy$/i, ['y', 'i']], [/yi$/i, ['y']], [/ich$/i, ['itch', 'ych']], [/kh/i, ['h']], [/^h/i, ['kh', 'g']], [/zh/i, ['j']], [/ks/i, ['x']], [/ts/i, ['tz', 'c']], [/yu/i, ['iu', 'ju']],
  [/ya/i, ['ia', 'ja']], [/^ye/i, ['e', 'je']], [/^e/i, ['ye']], [/shch/i, ['sch']], [/ii$/i, ['iy', 'y']], [/ei/i, ['ey']], [/ey/i, ['ei']], [/^v/i, ['w']], [/^w/i, ['v']], [/^g/i, ['h']],
];
const AR_RULES = [
  [/^al[- ]/i, ['el-', 'al ', 'el ', '']], [/^el[- ]/i, ['al-', 'el ', 'al ', '']], [/^abd\s*al[- ]?/i, ['abdul ', 'abdel ', 'abd el-', 'abd al-']], [/^abdul\s*/i, ['abdel ', 'abd al-', 'abd el-']], [/^abdel\s*/i, ['abdul ', 'abd el-', 'abd al-']],
  [/ou/i, ['u', 'o']], [/oo/i, ['u', 'ou']], [/ee/i, ['i']], [/ai/i, ['ay', 'ei']], [/ay/i, ['ai', 'ei']], [/ei/i, ['ai', 'ay']], [/^q/i, ['k', 'gh']], [/^k/i, ['q']], [/q/i, ['k']], [/^gh/i, ['q']], [/dh/i, ['d', 'z']], [/th/i, ['t', 's']],
  [/j/i, ['g', 'dj']], [/^g(?!h)/i, ['j']], [/ss/i, ['s']], [/mm/i, ['m']], [/^h/i, ['kh']], [/^kh/i, ['h']], [/i$/i, ['y', 'ee']], [/y$/i, ['i']], [/eh$/i, ['a', 'e']], [/a$/i, ['ah', 'eh']], [/ah$/i, ['a']], [/u$/i, ['ou', 'o']],
];
const ES_RULES = [
  [/z/i, ['s']], [/s(?=[aou])/i, ['z']], [/^v/i, ['b']], [/^b/i, ['v']], [/ll/i, ['y']], [/y(?=[aeiou])/i, ['ll']], [/^j/i, ['g']], [/^g(?=[ei])/i, ['j']], [/c(?=[ei])/i, ['s']], [/^x/i, ['j']], [/qu(?=[ei])/i, ['k']], [/ñ/i, ['n', 'ni']], [/rr/i, ['r']], [/^h/i, ['']],
];
const ZH_RULES = [ // pinyin ↔ Wade-Giles / Postal, applied per syllable-ish token
  [/^zh/i, ['ch']], [/^ch/i, ["ch'", 'zh']], [/^q/i, ["ch'"]], [/^x/i, ['hs']], [/^j/i, ['ch']], [/^z/i, ['ts']], [/^c/i, ["ts'"]], [/^r/i, ['j']], [/ong$/i, ['ung']], [/^b/i, ['p']], [/^d/i, ['t']], [/^g/i, ['k']], [/^k/i, ["k'"]],
];

const ARABIC_GROUPS = [
  ['mohammed', 'muhammad', 'mohamed', 'mohammad', 'muhammed', 'mohamad', 'mehmet', 'mahomet'],
  ['hussein', 'husayn', 'hussain', 'hossein', 'huseyin', 'husain'],
  ['ahmed', 'ahmad', 'ahmet'], ['ali', 'aly'], ['omar', 'umar', 'omer'], ['osama', 'usama', 'oussama'], ['yusuf', 'yousef', 'youssef', 'yusef', 'yousuf', 'yusuf'],
  ['khaled', 'khalid', 'khalil'], ['qasem', 'qassem', 'ghasem', 'kassem', 'qasim', 'kasim'], ['soleimani', 'suleimani', 'sulaimani', 'soleymani'], ['suleiman', 'sulayman', 'solomon', 'suleyman'],
  ['ismail', "isma'il", 'esmail', 'ismael'], ['ibrahim', 'ebrahim', 'ibraheem'], ['hassan', 'hasan', 'hassane'], ['hamza', 'hamzah'], ['abdullah', 'abdallah', 'abdulla'], ['abu', 'abou'], ['bin', 'ibn', 'ben'],
  ['sheikh', 'shaykh', 'sheik', 'shaikh'], ['hajj', 'haj', 'hadj', 'hajji'], ['mahmoud', 'mahmud', 'mahmood'], ['nasrallah', 'nasrullah'], ['haniyeh', 'haniya', 'haniyah'], ['sinwar', 'sanwar'], ['mohsen', 'mohsin', 'muhsin'],
  ['reza', 'ridha', 'rida'], ['mustafa', 'mostafa', 'moustafa'], ['tariq', 'tarek', 'tarik'], ['saeed', 'said', 'sayeed', 'saed'], ['rashid', 'rasheed', 'rachid'], ['walid', 'waleed', 'oualid'], ['yahya', 'yehia', 'yahia'],
];
const SPANISH_GROUPS = [
  ['jimenez', 'gimenez'], ['zavala', 'zabala'], ['ceballos', 'cevallos', 'zeballos'], ['chavez', 'chaves'], ['gonzalez', 'gonzales'], ['vazquez', 'vasquez'], ['valdez', 'valdes'], ['cortez', 'cortes'], ['ramirez', 'ramires'],
  ['elias', 'helias'], ['ximena', 'jimena'], ['mexico', 'mejico'], ['nemesio', 'nemecio'], ['guzman', 'gusman'], ['zambada', 'sambada'], ['cardenas', 'cardenaz'], ['beltran', 'veltran'],
];
const PARTICLES = new Set(['de', 'del', 'de la', 'de los', 'de las', 'van', 'von', 'der', 'den', 'di', 'da', 'dos', 'das', 'do', 'al', 'el', 'la', 'bin', 'ibn', 'abu', 'y', 'e']);

export function stripDiacritics(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ł/g, 'l').replace(/đ/g, 'd'); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function capWords(s) { return s.split(' ').map(w => w.split('-').map(cap).join('-')).join(' '); }

/** Cartesian transliteration of a Cyrillic token into at most `limit` Latin spellings (first option = primary). */
export function transliterateCyrillic(token, limit = 6) {
  let outs = [''];
  for (const ch of token.toLowerCase()) {
    const opts = CYR[ch] || [ch];
    const next = [];
    for (const o of outs) for (const alt of opts) { next.push(o + alt); if (next.length >= limit * 4) break; }
    outs = next;
  }
  const seen = new Set();
  return outs.filter(o => { if (seen.has(o)) return false; seen.add(o); return true; }).slice(0, limit);
}

function scriptHint(name, type) {
  const f = name.toLowerCase();
  if (HAS_CYR.test(name)) return 'ru';
  if (/\b(al|el|abu|bin|ibn|abd|abdul|abdel|sheikh|hajj|haj)\b|q|kh|aa|ee|ou/.test(f) && !/[ñ]/.test(f)) return 'ar';
  if (/[ñáéíóúü]|\b(de|del|la|los|las|y)\b|ez\b|[aeiou]z\b|ll/.test(f)) return 'es';
  if (/^(x|zh|q|j)/.test(f) || /\b(xi|li|wang|zhang|chen|liu|yang|huang|zhao|wu|zhou|xu|sun|ma|zhu|hu|guo|he|lin|luo|gao|zheng|liang|xie|song|tang|deng|han|cao|feng|zeng|peng|xiao|jiang|yuan|wei|yu|fu|shen|ye|lu|jin|pan|du|dai|ren|qian)\b/.test(f)) return 'zh';
  if (/(ov|ev|sky|skiy|ski|ich|enko|yuk|chuk|uk|ik|ov|in|ova|eva|aya)\b/.test(f)) return 'ru';
  return null;
}

function applyRules(token, rules, max = 10) {
  const out = [];
  for (const [re, reps] of rules) {
    if (!re.test(token)) continue;
    for (const r of reps) { const v = token.replace(re, r); if (v && v !== token) out.push(v); if (out.length >= max) return out; }
  }
  return out;
}

/**
 * Generate search variants for a target label.
 * @returns [{ variant, kind, from }] — bounded, deduped (case-insensitive), never containing the label or known aliases.
 */
export function nameVariants(label, aliases = [], { type = 'person', max = MAX_VARIANTS } = {}) {
  const base = String(label || '').replace(/\s+/g, ' ').trim();
  if (!base) return [];
  // Exact spellings the analyst already has; a diacritics-only variant is still worth showing (sources
  // drop accents constantly), every other kind must differ after folding.
  const knownExact = new Set([base, ...aliases].map(s => String(s).toLowerCase().trim()));
  const out = [];
  const seen = new Set();
  const add = (v, kind, from) => {
    const s = String(v || '').replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').trim();
    if (s.length < 3 || s.length > 80) return;
    const k = stripDiacritics(s).toLowerCase();
    if (knownExact.has(s.toLowerCase()) || seen.has(k) || (kind !== 'diacritics' && knownExact.has(k))) return;
    seen.add(k);
    if (out.length < max) out.push({ variant: s, kind, from: from || base });
  };

  const names = [base, ...aliases.map(a => String(a || '').trim()).filter(Boolean)];
  for (const name of names) {
    const hint = scriptHint(name, type);
    // 1. diacritics
    const flat = stripDiacritics(name);
    if (flat !== name) add(flat, 'diacritics', name);
    // 2. Cyrillic → Latin
    if (HAS_CYR.test(name)) {
      const toks = name.split(' ');
      const per = toks.map(t => HAS_CYR.test(t) ? transliterateCyrillic(t, 4) : [t.toLowerCase()]);
      const combos = per.reduce((acc, opts) => acc.flatMap(a => opts.map(o => (a ? a + ' ' : '') + o)), ['']).slice(0, 8);
      for (const c of combos) add(capWords(c), 'transliteration', name);
      continue; // Latin-side rules below act on Latin names
    }
    const toks = flat.split(' ').filter(Boolean);
    const lower = toks.map(t => t.toLowerCase());
    // 3. group tables (Arabic given names, Spanish surname spellings)
    for (const groups of [ARABIC_GROUPS, SPANISH_GROUPS]) {
      for (let i = 0; i < lower.length; i++) {
        const g = groups.find(gr => gr.includes(lower[i].replace(/[-']/g, '')));
        if (!g) continue;
        for (const alt of g) if (alt !== lower[i]) { const t2 = toks.slice(); t2[i] = cap(alt); add(t2.join(' '), 'transliteration', name); }
      }
    }
    // 4. per-token rewrite rules by script hint (one token changed at a time)
    const rules = hint === 'ru' ? RU_RULES : hint === 'ar' ? AR_RULES : hint === 'es' ? ES_RULES : hint === 'zh' ? ZH_RULES : null;
    if (rules) {
      for (let i = 0; i < toks.length; i++) {
        if (PARTICLES.has(lower[i]) && hint !== 'ar') continue;
        for (const alt of applyRules(lower[i], rules, 6)) { const t2 = toks.slice(); t2[i] = capWords(alt); add(t2.join(' '), hint === 'es' ? 'spelling' : 'transliteration', name); }
      }
    }
    // 5. order / particles / hyphen (multi-token names only)
    const content = toks.filter(t => !PARTICLES.has(t.toLowerCase()));
    if (toks.length >= 2) {
      if (content.length >= 2) {
        add(`${content[content.length - 1]}, ${content.slice(0, -1).join(' ')}`, 'order', name);
        add(`${content[content.length - 1]} ${content.slice(0, -1).join(' ')}`, 'order', name);
        if (content.length >= 3) { add(`${content[0]} ${content[content.length - 1]}`, 'order', name); add(`${content[0]} ${content[1]}`, 'order', name); }
        if (hint === 'zh' && content.length === 2) { add(`${content[1]} ${content[0]}`, 'order', name); add(`${content[0]} ${content[1].slice(0, Math.ceil(content[1].length / 2))}-${content[1].slice(Math.ceil(content[1].length / 2)).toLowerCase()}`, 'hyphen', name); }
      }
      if (content.length !== toks.length && content.length >= 2) add(content.join(' '), 'particle', name);
      if (/-/.test(flat)) { add(flat.replace(/-/g, ' '), 'hyphen', name); add(flat.replace(/-/g, ''), 'hyphen', name); }
      else if (toks.length === 2 && lower.every(t => t.length <= 6)) add(toks.join('-'), 'hyphen', name);
    }
    // 6. Spanish nickname particles: "El Mencho" → "Mencho" handled by aliasMatchers; "Jr." / "Sr." stripped
    if (/\b(jr|sr)\.?$/i.test(flat)) add(flat.replace(/\s*\b(jr|sr)\.?$/i, ''), 'particle', name);
  }
  return out.slice(0, max);
}
