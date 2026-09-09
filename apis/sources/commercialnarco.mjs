// Commercial Mexico-security intelligence vendors (DataInt, Lantia Intelligence).
//
// Both platforms are login-gated with no public API or feed; their dashboards are not scraped. Each is
// a keyed slot so Source Health reports NO KEY honestly until the vendor grants API / export access and
// the credentials plus a documented endpoint are configured. With a credential present but no vendor
// endpoint on record the slot reports `not_configured` rather than pretending to be live.
//
//   status: no_key | not_configured

export const VENDORS = [
  {
    name: 'DataInt',
    label: 'DataInt (dataint.mx)',
    envKey: 'DATAINT_API_KEY',
    envUrl: 'DATAINT_API_URL',
    homepage: 'https://www.dataint.mx/en',
    provides: 'curated Mexico security-event alerts and municipal crime statistics',
    access: 'commercial licence — request API or bulk-export access from the vendor',
  },
  {
    name: 'Lantia',
    label: 'Lantia Intelligence',
    envKey: 'LANTIA_API_KEY',
    envUrl: 'LANTIA_API_URL',
    homepage: 'https://www.lantiaintelligence.com/',
    provides: 'cartel presence by municipality and organised-crime risk indices',
    access: 'commercial licence — request API or bulk-export access from the vendor',
  },
];

function slot(v, env = process.env) {
  const key = env[v.envKey];
  const url = env[v.envUrl];
  const base = {
    source: v.name,
    timestamp: new Date().toISOString(),
    vendor: v.label,
    homepage: v.homepage,
    provides: v.provides,
    access: v.access,
    commercial: true,
  };
  if (!key) {
    return { ...base, status: 'no_key', message: `Set ${v.envKey} (and ${v.envUrl}) in .env once ${v.label} grants API access` };
  }
  if (!url || !/^https:\/\//.test(url)) {
    return { ...base, status: 'not_configured', message: `${v.envKey} is set but ${v.envUrl} is missing — no vendor endpoint on record; dashboard is not scraped` };
  }
  return { ...base, status: 'not_configured', message: `${v.label} adapter pending vendor API contract; credentials present, no data pulled` };
}

export async function dataint() { return slot(VENDORS[0]); }
export async function lantia() { return slot(VENDORS[1]); }
export function slotFor(name, env) {
  const v = VENDORS.find(x => x.name === name);
  return v ? slot(v, env) : null;
}
