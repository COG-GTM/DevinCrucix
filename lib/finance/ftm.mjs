// FollowTheMoney-shaped records. Every source (ICIJ, OFAC, OpenSanctions, OpenCorporates, GLEIF) is mapped to
// the same { id, schema, caption, properties, source } envelope so the dashboard, scorer and trail store never
// branch on provenance — while `source` keeps each record attributable, licensed and un-merged.
import { roleGroup } from './schema.mjs';

export const SOURCES = {
  icij: {
    key: 'icij', name: 'ICIJ Offshore Leaks Database', short: 'ICIJ', tier: 'reported',
    license: 'ODbL 1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    url: 'https://offshoreleaks.icij.org/', attribution: 'International Consortium of Investigative Journalists (ICIJ) Offshore Leaks Database, ODbL.',
    disclaimer: 'There are legitimate uses for offshore companies and trusts. The inclusion of a person or entity in the ICIJ Offshore Leaks Database is not intended to suggest or imply that they have engaged in illegal or improper conduct. Many people and entities have the same or similar names. We suggest you confirm the identities of any individuals or entities included in the database based on addresses or other identifiable information.',
    storage: 'local SQLite/FTS5 index built from the ICIJ bulk CSV release',
  },
  ofac: {
    key: 'ofac', name: 'OFAC Specially Designated Nationals (SDN) list', short: 'OFAC SDN', tier: 'official',
    license: 'US Government work (public domain)', licenseUrl: 'https://www.usa.gov/government-works',
    url: 'https://sanctionssearch.ofac.treas.gov/', attribution: 'US Treasury Office of Foreign Assets Control, SDN list.', storage: 'local name index refreshed from SDN.XML',
  },
  opensanctions: {
    key: 'opensanctions', name: 'OpenSanctions', short: 'OpenSanctions', tier: 'official',
    license: 'CC BY-NC 4.0 (commercial use needs a licence)', licenseUrl: 'https://www.opensanctions.org/licensing/',
    url: 'https://www.opensanctions.org/', attribution: 'OpenSanctions (consolidated sanctions, PEP and crime-watch data).', storage: 'live API, not stored',
  },
  opencorporates: {
    key: 'opencorporates', name: 'OpenCorporates', short: 'OpenCorporates', tier: 'registry',
    license: 'OpenCorporates terms (free for non-commercial / open-data use)', licenseUrl: 'https://opencorporates.com/legal/terms',
    url: 'https://opencorporates.com/', attribution: 'OpenCorporates company registry aggregate.', storage: 'live API, cached ≤ 15 min, never bulk-stored',
  },
  gleif: {
    key: 'gleif', name: 'GLEIF Legal Entity Identifier (LEI) records', short: 'GLEIF LEI', tier: 'registry',
    license: 'CC0 1.0', licenseUrl: 'https://www.gleif.org/en/about/open-data', url: 'https://search.gleif.org/',
    attribution: 'Global Legal Entity Identifier Foundation (GLEIF), CC0.', storage: 'live API, not stored',
  },
};

export const EVIDENCE_TIERS = {
  official: 'Official record (OFAC / consolidated sanctions) — published by a government or an official aggregator',
  registry: 'Registry record (OpenCorporates / GLEIF) — filed by the company itself with a corporate registry',
  reported: 'Reported — leaked-record database published by investigative journalists (ICIJ); a lead, not a verdict',
};

const KIND_SCHEMA = { entity: 'Company', officer: 'LegalEntity', intermediary: 'LegalEntity', address: 'Address', other: 'LegalEntity' };

function splitList(s) { return String(s || '').split(';').map(x => x.trim()).filter(Boolean); }
export function icijUrl(kind, id) { return `https://offshoreleaks.icij.org/nodes/${id}`; }
export const icijRef = id => `icij:${id}`;
export const parseIcijRef = ref => { const m = /^icij:(\d{1,12})$/.exec(String(ref || '')); return m ? Number(m[1]) : null; };

/** ICIJ node row → FtM-shaped record. */
export function icijRecord(row, meta = {}) {
  if (!row) return null;
  const schema = KIND_SCHEMA[row.kind] || 'LegalEntity';
  const props = {
    name: [row.name], kind: [row.kind],
    ...(row.original_name && row.original_name !== row.name ? { previousName: [row.original_name] } : {}),
    ...(row.former_name ? { previousName: [...(row.original_name && row.original_name !== row.name ? [row.original_name] : []), row.former_name] } : {}),
    ...(row.jurisdiction_description ? { jurisdiction: [row.jurisdiction_description], jurisdictionCode: [row.jurisdiction] } : {}),
    ...(row.company_type ? { legalForm: [row.company_type] } : {}),
    ...(row.address ? { address: [row.address] } : {}),
    ...(row.incorporation_date ? { incorporationDate: [row.incorporation_date] } : {}),
    ...(row.inactivation_date ? { dissolutionDate: [row.inactivation_date] } : {}),
    ...(row.struck_off_date ? { struckOffDate: [row.struck_off_date] } : {}),
    ...(row.status ? { status: [row.status] } : {}),
    ...(row.service_provider ? { serviceProvider: [row.service_provider] } : {}),
    ...(row.other_type ? { legalForm: [row.other_type] } : {}),
    country: splitList(row.countries), countryCode: splitList(row.country_codes).map(c => c.toLowerCase()),
    sourceDataset: [row.source], ...(row.note ? { notes: [row.note] } : {}), ...(row.valid_until ? { validUntil: [row.valid_until] } : {}),
  };
  return {
    id: icijRef(row.id), schema, caption: row.name, properties: props,
    source: { ...sourceStamp('icij'), dataset: row.source, url: icijUrl(row.kind, row.id), release: meta.release || null, builtAt: meta.builtAt || null, mode: meta.mode || null },
  };
}

export function sourceStamp(key) {
  const s = SOURCES[key];
  return { key: s.key, name: s.name, short: s.short, tier: s.tier, tierLabel: EVIDENCE_TIERS[s.tier], license: s.license, licenseUrl: s.licenseUrl, attribution: s.attribution, retrievedAt: new Date().toISOString() };
}

/** ICIJ edge row → FtM-ish link. Direction follows ICIJ: start node → end node, e.g. officer → entity. */
export function icijLink(e) {
  const label = e.link || e.rel.replace(/_/g, ' ');
  return {
    id: `icij:${e.src}>${e.dst}:${e.rel}:${(e.link || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    from: icijRef(e.src), to: icijRef(e.dst), rel: e.rel, label, role: roleGroup(e.rel, e.link),
    status: e.status || null, startDate: e.start_date || null, endDate: e.end_date || null,
    state: 'reported', source: { key: 'icij', dataset: e.source || null, tier: 'reported' },
  };
}

/** OFAC SDN index entry → record. */
export function ofacRecord(e) {
  const schema = /individual/i.test(e.type) ? 'Person' : /vessel/i.test(e.type) ? 'Vessel' : /aircraft/i.test(e.type) ? 'Airplane' : 'LegalEntity';
  return {
    id: `ofac:${e.uid}`, schema, caption: e.name,
    properties: { name: [e.name], alias: (e.akas || []).map(a => a.name), program: e.programs || [], country: e.countries || [], sdnType: [e.type], ...(e.remarks ? { notes: [e.remarks] } : {}) },
    source: { ...sourceStamp('ofac'), dataset: 'SDN', url: `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${e.uid}`, listedAt: e.listedAt || null },
  };
}

/** OpenSanctions API entity → record (keeps their id/schema/datasets). */
export function opensanctionsRecord(e) {
  const p = e.properties || {};
  return {
    id: `os:${e.id}`, schema: e.schema || 'LegalEntity', caption: e.caption || p.name?.[0] || '',
    properties: { name: p.name || [e.caption].filter(Boolean), alias: p.alias || [], country: p.country || [], topics: e.topics || [], datasets: e.datasets || [], ...(p.birthDate ? { birthDate: p.birthDate } : {}), ...(p.incorporationDate ? { incorporationDate: p.incorporationDate } : {}), ...(p.registrationNumber ? { registrationNumber: p.registrationNumber } : {}), ...(p.address ? { address: p.address } : {}) },
    score: typeof e.score === 'number' ? e.score : null, matchFeatures: e.features || null,
    source: { ...sourceStamp('opensanctions'), dataset: (e.datasets || [])[0] || null, url: `https://www.opensanctions.org/entities/${encodeURIComponent(e.id)}/`, firstSeen: e.first_seen || null, lastSeen: e.last_seen || null },
  };
}

/** OpenCorporates company → record. */
export function opencorporatesRecord(c) {
  return {
    id: `oc:${c.jurisdiction_code}/${c.company_number}`, schema: 'Company', caption: c.name,
    properties: { name: [c.name], jurisdictionCode: [c.jurisdiction_code], registrationNumber: [c.company_number], ...(c.company_type ? { legalForm: [c.company_type] } : {}), ...(c.incorporation_date ? { incorporationDate: [c.incorporation_date] } : {}), ...(c.dissolution_date ? { dissolutionDate: [c.dissolution_date] } : {}), ...(c.current_status ? { status: [c.current_status] } : {}), ...(c.registered_address_in_full ? { address: [c.registered_address_in_full] } : {}), ...(c.previous_names?.length ? { previousName: c.previous_names.map(p => p.company_name).filter(Boolean) } : {}), country: [c.jurisdiction_code?.slice(0, 2)].filter(Boolean) },
    source: { ...sourceStamp('opencorporates'), dataset: c.jurisdiction_code || null, url: c.opencorporates_url || null, registryUrl: c.registry_url || null },
  };
}

/** GLEIF LEI record → record. */
export function gleifRecord(r) {
  const a = r.attributes || {}; const en = a.entity || {}; const reg = a.registration || {};
  const addr = en.legalAddress ? [...(en.legalAddress.addressLines || []), en.legalAddress.city, en.legalAddress.postalCode, en.legalAddress.country].filter(Boolean).join(', ') : null;
  return {
    id: `lei:${a.lei}`, schema: 'Company', caption: en.legalName?.name || a.lei,
    properties: { name: [en.legalName?.name].filter(Boolean), leiCode: [a.lei], alias: (en.otherNames || []).map(n => n.name).filter(Boolean), jurisdictionCode: [en.jurisdiction].filter(Boolean), ...(en.legalForm?.id ? { legalForm: [en.legalForm.id] } : {}), ...(en.status ? { status: [en.status] } : {}), ...(addr ? { address: [addr] } : {}), ...(reg.status ? { registrationStatus: [reg.status] } : {}), ...(reg.lastUpdateDate ? { modifiedAt: [reg.lastUpdateDate] } : {}), ...(en.registeredAs ? { registrationNumber: [en.registeredAs] } : {}), country: [en.legalAddress?.country?.toLowerCase()].filter(Boolean) },
    source: { ...sourceStamp('gleif'), dataset: 'LEI golden copy', url: `https://search.gleif.org/#/record/${encodeURIComponent(a.lei)}` },
  };
}

export function recordCountries(rec) { return [...(rec.properties?.country || []), ...(rec.properties?.countryCode || []), ...(rec.properties?.jurisdictionCode || []), ...(rec.properties?.jurisdiction || [])]; }
