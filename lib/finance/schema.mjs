// SQLite schema shared by the index builder (scripts/build-offshoreleaks.mjs) and the query layer
// (lib/finance/sources/offshoreleaks.mjs). Bump SCHEMA when a column or FTS tokenizer changes so stale
// indexes are rebuilt instead of mis-read.
export const SCHEMA = 'crucix-offshoreleaks/1';

export const NODE_KINDS = ['entity', 'officer', 'intermediary', 'address', 'other'];

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  original_name TEXT, former_name TEXT,
  jurisdiction TEXT, jurisdiction_description TEXT,
  company_type TEXT, address TEXT,
  incorporation_date TEXT, inactivation_date TEXT, struck_off_date TEXT, dorm_date TEXT,
  status TEXT, service_provider TEXT,
  countries TEXT, country_codes TEXT,
  source TEXT NOT NULL, valid_until TEXT, note TEXT,
  other_type TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  src INTEGER NOT NULL, dst INTEGER NOT NULL,
  rel TEXT NOT NULL, link TEXT,
  status TEXT, start_date TEXT, end_date TEXT,
  source TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, address, content='nodes', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
`;

export const INDEX_DDL = `
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS nodes_fold ON nodes(name_fold);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);
`;

// Relationship labels, as published by ICIJ, grouped into the roles the dashboard reasons about.
export const ROLE_GROUPS = {
  ownership: ['shareholder of', 'owner of', 'beneficiary of', 'ultimate beneficial owner', 'beneficial owner of', 'settlor of', 'protector of', 'trustee of', 'nominee shareholder of', 'nominee beneficiary of', 'nominee beneficial owner of', 'underlying'],
  control: ['director of', 'director', 'managing director of', 'president of', 'vice-president of', 'secretary of', 'treasurer of', 'legal representative of', 'judicial representative of', 'is signatory for', 'authorized signatory of', 'authorised person / signatory of', 'nominee director of', 'power of attorney of', 'nominee protector of', 'nominee trust settlor of', 'officer of'],
  service: ['intermediary of', 'records & registers of', 'auditor of', 'liquidator of', 'correspondent addr. of', 'registered agent of', 'resident director of', 'resident agent of'],
  address: ['registered address'],
  identity: ['same_name_as', 'same_as', 'same_id_as', 'similar', 'same_company_as', 'similar_company_as', 'probably_same_officer_as', 'same_intermediary_as', 'same name and registration date as', 'same address as'],
  other: ['connected_to', 'related entity'],
};

export function roleGroup(rel, link) {
  const l = String(link || rel || '').toLowerCase().trim();
  const r = String(rel || '').toLowerCase().trim();
  if (r === 'registered_address') return 'address';
  if (r === 'intermediary_of') return 'service';
  for (const [g, labels] of Object.entries(ROLE_GROUPS)) if (labels.includes(l) || labels.includes(r)) return g;
  if (/beneficia|shareholder|owner|settlor|protector|trustee/.test(l)) return 'ownership';
  if (/director|president|secretary|treasurer|signator|representative|attorney|officer|manager/.test(l)) return 'control';
  if (/auditor|liquidator|agent|register|nominee/.test(l)) return 'service';
  if (/same|similar/.test(r)) return 'identity';
  return 'other';
}
