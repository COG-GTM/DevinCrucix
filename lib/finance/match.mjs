// Name normalisation and transparent cross-source scoring. Scores are leads: every candidate carries the
// matched fields that produced its score so the analyst (not the code) decides identity.

const LEGAL_SUFFIXES = /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|l\.?l\.?c|plc|s\.?a|sa|s\.?a\.?r\.?l|sarl|s\.?l|sl|gmbh|ag|bv|b\.?v|nv|n\.?v|oy|ab|as|a\/s|pty|pte|llp|lp|holdings?|international|intl|group|trust|foundation|fund|enterprises?|trading|investments?|services?|overseas|global|limitada|ltda|anstalt|stiftung|se|kk|the)\b/g;

export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Folded name with legal-form suffixes removed; empty strings fall back to the plain fold. */
export function foldCompany(s) {
  const f = fold(s);
  const core = f.replace(LEGAL_SUFFIXES, ' ').replace(/\b(and|of|de|del|la|el|y|the)\b/g, ' ').replace(/\b[a-z]\b/g, ' ').replace(/\s+/g, ' ').trim();
  return core || f;
}

export function tokens(s) { return fold(s).split(' ').filter(t => t.length > 1); }

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Person-name order variance: "DE VREE, OLAV" vs "Olav de Vree". */
function sortedKey(s) { return tokens(s).sort().join(' '); }

/**
 * Score two names in [0, 1] with the reasons. exact folded match → 1; same core (suffix-stripped) → 0.92;
 * same token multiset → 0.85; otherwise token Jaccard scaled to ≤ 0.8.
 */
export function scoreNames(a, b) {
  const fa = fold(a), fb = fold(b);
  if (!fa || !fb) return { score: 0, matched: [] };
  if (fa === fb) return { score: 1, matched: ['name:exact'] };
  const ca = foldCompany(a), cb = foldCompany(b);
  if (ca && ca === cb) return { score: 0.92, matched: ['name:core'] };
  if (sortedKey(a) === sortedKey(b)) return { score: 0.85, matched: ['name:tokens'] };
  const j = jaccard(tokens(ca), tokens(cb));
  if (j >= 0.5) return { score: Math.round(j * 0.8 * 100) / 100, matched: ['name:partial'] };
  if (ca.length >= 6 && (cb.startsWith(ca) || ca.startsWith(cb))) return { score: 0.6, matched: ['name:prefix'] };
  return { score: Math.round(j * 0.5 * 100) / 100, matched: j ? ['name:weak'] : [] };
}

const COUNTRY_ALIASES = { 'british virgin islands': 'vg', bvi: 'vg', 'virgin islands, british': 'vg', panama: 'pa', bahamas: 'bs', 'cayman islands': 'ky', seychelles: 'sc', samoa: 'ws', 'hong kong': 'hk', singapore: 'sg', 'united kingdom': 'gb', uk: 'gb', 'united states': 'us', usa: 'us', switzerland: 'ch', cyprus: 'cy', malta: 'mt', bermuda: 'bm', jersey: 'je', guernsey: 'gg', 'isle of man': 'im', niue: 'nu', nevis: 'kn', 'saint kitts and nevis': 'kn', aruba: 'aw', barbados: 'bb', 'united arab emirates': 'ae', uae: 'ae', russia: 'ru', 'russian federation': 'ru', china: 'cn', syria: 'sy', iran: 'ir', venezuela: 've', mexico: 'mx', colombia: 'co', brazil: 'br', argentina: 'ar' };
export function countryCode(s) {
  const f = fold(s);
  if (!f) return null;
  if (/^[a-z]{2}$/.test(f)) return f;
  return COUNTRY_ALIASES[f] || null;
}
export function countryCodes(list) {
  const out = new Set();
  for (const v of Array.isArray(list) ? list : String(list || '').split(/[;,]/)) { const c = countryCode(v); if (c) out.add(c); }
  return out;
}

/**
 * Cross-source candidate score: name score, boosted when jurisdictions / countries overlap and lightly
 * penalised when the record types disagree (person vs company). Returns { score, matched }.
 */
export function scoreCandidate(subject, candidate) {
  const base = scoreNames(subject.name, candidate.name);
  let score = base.score; const matched = [...base.matched];
  if (score <= 0) return { score: 0, matched };
  const sc = countryCodes([...(subject.countries || []), subject.jurisdiction]);
  const cc = countryCodes([...(candidate.countries || []), candidate.jurisdiction]);
  if (sc.size && cc.size) {
    const shared = [...sc].filter(c => cc.has(c));
    if (shared.length) { score = Math.min(1, score + 0.05); matched.push(`country:${shared.join('/')}`); }
  }
  if (subject.schema && candidate.schema && subject.schema !== candidate.schema) {
    const person = s => s === 'Person';
    if (person(subject.schema) !== person(candidate.schema)) { score = Math.max(0, score - 0.15); matched.push('type:mismatch'); }
  }
  return { score: Math.round(score * 100) / 100, matched };
}

export function matchBand(score) {
  if (score >= 0.92) return 'strong';
  if (score >= 0.75) return 'possible';
  if (score >= 0.5) return 'weak';
  return 'none';
}
