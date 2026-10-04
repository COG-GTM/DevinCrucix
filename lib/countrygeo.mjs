// Department + municipality names (as printed by Colombian / Venezuelan sources) → a point and the
// ADM1 ISO code, via the GeoNames country gazetteers. Used by the Defensoría SAT and Indepaz
// adapters so their rows can be drawn on the country map. Resolution is exact-name only (folded,
// whole string) — no fuzzy matching, so an unknown spelling yields no point rather than a wrong one.

import { fold, loadCountryGazetteer } from './narco/gazetteer.mjs';
import { countryConfig, countryAdm1 } from './countryconfig.mjs';

const normDept = (s) => fold(String(s || '').replace(/\s+/g, ' ').trim()).replace(/^departamento (?:de |del )?/, '').replace(/,? ?d\.? ?c\.?$/, '').trim();
const normMuni = (s) => fold(String(s || '').replace(/\s+/g, ' ').trim()).replace(/,? ?d\.? ?c\.?$/, '').trim();

// GeoNames ADM1 code → ISO 3166-2: via the DANE prefix of any municipality in that department
// (config/countries/co.json admCodes) when the config has one, else by folded name against the
// checked-in ADM1 polygon file (Venezuela).
const isoCache = new Map();
function adm1Iso(cc, gz, st) {
  const k = `${cc}:${st.adm1}`;
  if (isoCache.has(k)) return isoCache.get(k);
  let iso = null;
  const cfg = countryConfig(cc);
  if (Object.keys(cfg.admCodes || {}).length) {
    const m = (gz.muniKey ? [...gz.muniKey.values()].flat() : []).find(x => x.adm1 === st.adm1 && x.adm2);
    iso = m ? cfg.admCodes[String(m.adm2).slice(0, 2)] || null : null;
  } else {
    const keys = new Set([st.key, ...(st.keys || [])]);
    const u = (countryAdm1(cc)?.units || []).find(x => keys.has(normDept(x.name)));
    iso = u?.iso || null;
  }
  isoCache.set(k, iso);
  return iso;
}

const lc = (cc) => String(cc || '').toLowerCase();

export function resolveDepartment(cc, dept) {
  cc = lc(cc);
  const gz = loadCountryGazetteer(cc);
  const key = normDept(dept);
  if (!key) return null;
  const st = gz.stateKey.get(key) || gz.stateKey.get(key.replace(/^(?:la|el|los|las) /, ''));
  if (!st) return null;
  return { adm1: st.adm1, name: st.shortName, iso: adm1Iso(cc, gz, st), lat: st.lat, lon: st.lon };
}

// Returns { lat, lon, precision: 'municipality' | 'department', department, municipality, iso } or null.
export function geocodeMunicipio(cc, dept, muni) {
  cc = lc(cc);
  const gz = loadCountryGazetteer(cc);
  const st = resolveDepartment(cc, dept);
  const mk = normMuni(muni);
  if (mk) {
    const rows = (gz.muniKey.get(mk) || []).filter(m => !st || m.adm1 === st.adm1);
    const m = rows[0] || (!st ? null : (gz.placeKey.get(mk) || []).find(p => p.adm1 === st.adm1));
    if (m && Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
      const state = st || (gz.stateByAdm1.get(m.adm1) ? { adm1: m.adm1, name: gz.stateByAdm1.get(m.adm1).shortName, iso: adm1Iso(cc, gz, gz.stateByAdm1.get(m.adm1)) } : null);
      return { lat: +Number(m.lat).toFixed(4), lon: +Number(m.lon).toFixed(4), precision: 'municipality', department: state?.name || null, iso: state?.iso || null, municipality: m.name.replace(/\s+/g, ' ').trim() };
    }
  }
  if (st && Number.isFinite(st.lat) && Number.isFinite(st.lon)) return { lat: +Number(st.lat).toFixed(4), lon: +Number(st.lon).toFixed(4), precision: 'department', department: st.name, iso: st.iso, municipality: null };
  return null;
}
