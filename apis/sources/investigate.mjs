// Investigate — on-demand OSINT enrichment pivot (not part of the sweep)
// Given a domain, IP, file hash, or company name, runs an enrichment chain and
// returns a structured dossier. Keyless sources always run; keyed sources
// (VirusTotal, Shodan, OpenCorporates) activate when their env var is set.
//
// Keyless:  RDAP WHOIS (rdap.org) · DNS over HTTPS (Cloudflare) · Certificate
//           Transparency (crt.sh) · Shodan InternetDB · typosquat probe
// Keyed:    VIRUSTOTAL_API_KEY · SHODAN_API_KEY · OPENCORPORATES_API_TOKEN

import { isIP } from 'net';
import { safeFetch } from '../utils/fetch.mjs';
import { generatePermutations, resolveMany } from './typosquat.mjs';
import {
  EMAIL_RE, USERNAME_RE, PHONE_RE, URL_RE, BTC_RE, ETH_RE,
  geolocate, wayback, otx, urlscan, torExitCheck, httpFingerprint,
  investigateEmail, investigateUsername, investigatePhone, investigateUrl, investigateWallet, osintKeyedStatus,
} from './osint.mjs';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 200;
const _cache = new Map(); // key -> { ts, dossier }

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HASH_RE = /^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const COMPANY_RE = /^[a-zA-Z0-9 .,&'()-]{2,80}$/;

const DOH = 'https://cloudflare-dns.com/dns-query';
const DNS_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT'];

// Log the upstream failure, return only a generic status-class message to the client.
function providerError(source, raw) {
  console.error(`[Investigate] ${source}: ${String(raw).slice(0, 300)}`);
  const m = /HTTP (\d{3})/.exec(String(raw));
  const code = m ? Number(m[1]) : 0;
  if (code === 401 || code === 403) return 'authentication rejected';
  if (code === 429) return 'rate limited';
  if (code >= 500) return 'upstream error';
  if (/timeout|aborted/i.test(String(raw))) return 'timed out';
  return 'unavailable';
}

export const TARGET_TYPES = ['domain', 'ip', 'hash', 'company', 'email', 'username', 'phone', 'url', 'btc', 'eth'];
export const TARGET_HINTS = new Set(['auto', 'company', 'username', 'phone', 'domain', 'url']);

// Whitelist classification: every accepted value matches exactly one bounded pattern.
// `hint` disambiguates selectors that are ambiguous on their own (company names,
// bare usernames vs domains, phone numbers vs hashes).
export function classifyTarget(raw, hint) {
  const s = String(raw || '').trim();
  if (!s || s.length > 2048) return null;
  const lower = s.toLowerCase();
  if (hint === 'company') return COMPANY_RE.test(s) ? { type: 'company', value: s } : null;
  if (hint === 'username') return USERNAME_RE.test(s) && s.length <= 39 ? { type: 'username', value: s } : null;
  if (hint === 'phone') return PHONE_RE.test(s) && s.replace(/\D/g, '').length >= 7 ? { type: 'phone', value: s } : null;
  if (hint === 'url') return URL_RE.test(s) ? { type: 'url', value: s } : null;
  if (/^https?:\/\//i.test(s)) {
    if (!URL_RE.test(s)) return null;
    let u; try { u = new URL(s); } catch { return null; }
    // A bare origin is really a domain question; anything with a path or query is a URL question.
    if (hint !== 'domain' && (u.pathname !== '/' || u.search || u.username)) return { type: 'url', value: s };
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (isIP(host)) return { type: 'ip', value: host };
    return DOMAIN_RE.test(host) ? { type: 'domain', value: host } : null;
  }
  if (s.length > 253) return null;
  if (EMAIL_RE.test(lower)) return { type: 'email', value: lower };
  if (isIP(lower)) return { type: 'ip', value: lower };
  if (ETH_RE.test(s)) return { type: 'eth', value: s };
  if (BTC_RE.test(s) && !/^[0-9]+$/.test(s)) return { type: 'btc', value: s };
  if (HASH_RE.test(lower)) return { type: 'hash', value: lower };
  if (/^\+[0-9][0-9 .()-]{6,}$/.test(s) && PHONE_RE.test(s)) return { type: 'phone', value: s };
  const noScheme = lower.replace(/^www\./, '').split(/[/?#]/)[0];
  if (DOMAIN_RE.test(noScheme)) return { type: 'domain', value: noScheme };
  if (/^@?[a-z0-9][a-z0-9._-]{1,38}$/i.test(s) && !/^[0-9.]+$/.test(s)) return { type: 'username', value: s.replace(/^@/, '') };
  return null;
}

// ─── Keyless sources ────────────────────────────────────────────────────────

async function dohQuery(name, type) {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const data = await safeFetch(url, { timeout: 8000, retries: 0, headers: { Accept: 'application/dns-json' } });
  if (data.error) return { type, error: providerError(`DoH ${type} ${name}`, data.error), records: [] };
  return {
    type,
    status: data.Status,
    records: (data.Answer || []).map(a => String(a.data).replace(/^"|"$/g, '')),
  };
}

async function dnsRecords(domain) {
  const results = await Promise.all(DNS_TYPES.map(t => dohQuery(domain, t)));
  const dmarc = await dohQuery(`_dmarc.${domain}`, 'TXT');
  const out = {};
  for (const r of results) out[r.type] = r.records;
  const txt = out.TXT || [];
  return {
    ...out,
    spf: txt.find(t => /^v=spf1/i.test(t)) || null,
    dmarc: dmarc.records.find(t => /^v=DMARC1/i.test(t)) || null,
  };
}

async function reverseDns(ip) {
  if (isIP(ip) !== 4) return [];
  const rev = ip.split('.').reverse().join('.') + '.in-addr.arpa';
  const r = await dohQuery(rev, 'PTR');
  return r.records;
}

function rdapEvent(events, action) {
  return (events || []).find(e => e.eventAction === action)?.eventDate || null;
}

function rdapEntityName(entity) {
  const vcard = entity?.vcardArray?.[1] || [];
  const fn = vcard.find(v => v[0] === 'fn')?.[3];
  const org = vcard.find(v => v[0] === 'org')?.[3];
  return fn || org || entity?.handle || null;
}

async function rdapDomain(domain) {
  const data = await safeFetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { timeout: 12000, retries: 0, headers: { Accept: 'application/rdap+json' } });
  if (data.error) return { error: providerError('RDAP domain', data.error) };
  const entities = data.entities || [];
  const byRole = (role) => entities.find(e => (e.roles || []).includes(role));
  return {
    handle: data.handle || null,
    status: data.status || [],
    registered: rdapEvent(data.events, 'registration'),
    expires: rdapEvent(data.events, 'expiration'),
    updated: rdapEvent(data.events, 'last changed'),
    registrar: rdapEntityName(byRole('registrar')),
    registrant: rdapEntityName(byRole('registrant')),
    nameservers: (data.nameservers || []).map(n => n.ldhName).filter(Boolean),
    dnssec: data.secureDNS?.delegationSigned ?? null,
  };
}

async function rdapIp(ip) {
  const data = await safeFetch(`https://rdap.org/ip/${ip}`, { timeout: 12000, retries: 0, headers: { Accept: 'application/rdap+json' } });
  if (data.error) return { error: providerError('RDAP ip', data.error) };
  const entities = data.entities || [];
  return {
    name: data.name || null,
    handle: data.handle || null,
    range: data.startAddress && data.endAddress ? `${data.startAddress} - ${data.endAddress}` : null,
    country: data.country || null,
    type: data.type || null,
    org: rdapEntityName(entities.find(e => (e.roles || []).includes('registrant')) || entities[0]),
    registered: rdapEvent(data.events, 'registration'),
    updated: rdapEvent(data.events, 'last changed'),
  };
}

async function certTransparency(domain) {
  const data = await safeFetch(`https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`, { timeout: 20000, retries: 0 });
  if (data.error) return { error: providerError('crt.sh', data.error), subdomains: [], certificates: [] };
  const rows = Array.isArray(data) ? data : [];
  const names = new Set();
  for (const r of rows) {
    for (const n of String(r.name_value || '').split('\n')) {
      const clean = n.trim().toLowerCase();
      if (clean && !clean.startsWith('*.') && !clean.includes('@') && (clean === domain || clean.endsWith('.' + domain))) names.add(clean);
    }
  }
  const seenCert = new Set();
  const certs = rows
    .sort((a, b) => new Date(b.not_before) - new Date(a.not_before))
    .filter(r => { const k = `${r.common_name}|${r.not_before}|${r.issuer_name}`; if (seenCert.has(k)) return false; seenCert.add(k); return true; })
    .slice(0, 10)
    .map(r => ({ issuer: String(r.issuer_name || '').replace(/^.*O=([^,]+).*$/, '$1'), commonName: r.common_name, notBefore: r.not_before, notAfter: r.not_after }));
  return { totalCerts: rows.length, subdomains: [...names].sort().slice(0, 60), certificates: certs };
}

async function internetDb(ip) {
  const data = await safeFetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, { timeout: 10000, retries: 0 });
  if (data.error) return /HTTP 404/.test(data.error) ? { ip, ports: [], vulns: [], hostnames: [], tags: [], cpes: [] } : { ip, error: providerError('InternetDB', data.error) };
  return { ip, ports: data.ports || [], vulns: data.vulns || [], hostnames: data.hostnames || [], tags: data.tags || [], cpes: data.cpes || [] };
}

// ─── Keyed sources ──────────────────────────────────────────────────────────

async function virusTotal(kind, value) {
  const key = process.env.VIRUSTOTAL_API_KEY;
  if (!key) return { status: 'no_key' };
  const path = { domain: 'domains', ip: 'ip_addresses', hash: 'files' }[kind];
  const data = await safeFetch(`https://www.virustotal.com/api/v3/${path}/${encodeURIComponent(value)}`, { timeout: 15000, retries: 0, headers: { 'x-apikey': key } });
  if (data.error) return { status: 'error', error: /HTTP 404/.test(data.error) ? 'Not found in VirusTotal' : providerError('VirusTotal', data.error) };
  const a = data.data?.attributes || {};
  const stats = a.last_analysis_stats || {};
  return {
    status: 'ok',
    malicious: stats.malicious || 0,
    suspicious: stats.suspicious || 0,
    harmless: stats.harmless || 0,
    undetected: stats.undetected || 0,
    reputation: a.reputation ?? null,
    categories: Object.values(a.categories || {}).slice(0, 5),
    tags: (a.tags || []).slice(0, 8),
    // file-specific
    names: (a.names || []).slice(0, 5),
    typeDescription: a.type_description || null,
    threatLabel: a.popular_threat_classification?.suggested_threat_label || null,
    firstSeen: a.first_submission_date ? new Date(a.first_submission_date * 1000).toISOString() : null,
    link: `https://www.virustotal.com/gui/${kind === 'hash' ? 'file' : kind === 'ip' ? 'ip-address' : 'domain'}/${value}`,
  };
}

async function shodanHost(ip) {
  const key = process.env.SHODAN_API_KEY;
  if (!key) return { status: 'no_key' };
  const data = await safeFetch(`https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}`, { timeout: 15000, retries: 0 });
  if (data.error) return { status: 'error', error: /HTTP 404/.test(data.error) ? 'No Shodan record' : providerError('Shodan', data.error.replaceAll(key, '***')) };
  return {
    status: 'ok',
    org: data.org || null, isp: data.isp || null, asn: data.asn || null,
    country: data.country_name || null, city: data.city || null,
    os: data.os || null,
    ports: data.ports || [],
    vulns: data.vulns || [],
    services: (data.data || []).slice(0, 12).map(s => ({ port: s.port, transport: s.transport, product: s.product || null, version: s.version || null })),
    lastUpdate: data.last_update || null,
  };
}

async function openCorporates(name) {
  const token = process.env.OPENCORPORATES_API_TOKEN;
  if (!token) return { status: 'no_key' };
  const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&per_page=10&api_token=${encodeURIComponent(token)}`;
  const data = await safeFetch(url, { timeout: 15000, retries: 0 });
  if (data.error) return { status: 'error', error: providerError('OpenCorporates', data.error.replaceAll(token, '***')) };
  const companies = (data.results?.companies || []).map(c => c.company).map(c => ({
    name: c.name, number: c.company_number, jurisdiction: c.jurisdiction_code,
    status: c.current_status || null, incorporated: c.incorporation_date || null, dissolved: c.dissolution_date || null,
    address: c.registered_address_in_full || null, type: c.company_type || null,
    url: c.opencorporates_url,
  }));
  return { status: 'ok', total: data.results?.total_count || companies.length, companies, keyed: !!token };
}

// ─── Risk scoring ───────────────────────────────────────────────────────────

function scoreDossier(d) {
  const flags = [];
  let score = 0;
  const vt = d.virustotal;
  if (vt?.status === 'ok') {
    if (vt.malicious >= 5) { score += 40; flags.push(`${vt.malicious} AV engines flag malicious`); }
    else if (vt.malicious > 0) { score += 20; flags.push(`${vt.malicious} AV engine(s) flag malicious`); }
    if (vt.threatLabel) { score += 20; flags.push(`Threat label: ${vt.threatLabel}`); }
  }
  const whois = d.whois;
  if (whois?.registered) {
    const ageDays = (Date.now() - new Date(whois.registered).getTime()) / 86400000;
    if (ageDays < 30) { score += 25; flags.push(`Domain registered ${Math.round(ageDays)}d ago`); }
    else if (ageDays < 180) { score += 10; flags.push(`Domain younger than 6 months`); }
  }
  if (d.dns && d.dns.MX?.length && !d.dns.spf) { score += 5; flags.push('Mail-enabled domain without SPF'); }
  if (d.dns && d.dns.MX?.length && !d.dns.dmarc) { score += 5; flags.push('No DMARC policy'); }
  const vulnCount = (d.hosts || []).reduce((s, h) => s + (h.vulns?.length || 0), 0);
  if (vulnCount > 0) { score += Math.min(25, vulnCount * 3); flags.push(`${vulnCount} known CVE(s) on exposed hosts`); }
  const riskyPorts = new Set([21, 23, 445, 3389, 5900, 6379, 9200, 27017]);
  const exposed = (d.hosts || []).flatMap(h => (h.ports || []).filter(p => riskyPorts.has(p)));
  if (exposed.length) { score += Math.min(15, exposed.length * 5); flags.push(`Sensitive services exposed: ${[...new Set(exposed)].join(', ')}`); }
  if (d.typosquats?.registered?.length) { score += 5; flags.push(`${d.typosquats.registered.length} registered look-alike domain(s)`); }
  if (d.otx?.pulseCount > 0 && !d.otx.whitelisted) { score += Math.min(25, 5 + d.otx.pulseCount); flags.push(`Appears in ${d.otx.pulseCount} OTX threat pulse(s)${d.otx.malwareFamilies?.length ? ': ' + d.otx.malwareFamilies.slice(0, 3).join(', ') : ''}`); }
  else if (d.otx?.pulseCount > 0) flags.push(`${d.otx.pulseCount} OTX pulse(s) but indicator is OTX-whitelisted (${d.otx.validation?.find(v => /whitelist/i.test(v)) || 'likely benign'})`);
  if (d.tor?.isTorExit) { score += 15; flags.push('Tor exit node'); }
  if (d.web?.securityHeaders?.grade === 'F' && d.web?.status) { score += 3; flags.push('No HTTP security headers'); }
  if (!d.otx?.whitelisted && d.urlscan?.scans?.some(s => (s.tags || []).some(t => /phish|malicious|threat/i.test(t)))) { score += 15; flags.push('Tagged phishing/malicious in urlscan.io submissions'); }
  // Email
  if (d.type === 'email') {
    if (!d.deliverable) { score += 20; flags.push('Domain has no MX records: address cannot receive mail'); }
    if (d.disposable) { score += 30; flags.push('Disposable / throwaway mail provider'); }
    if (d.breaches?.status === 'ok' && d.breaches.total > 0) { score += Math.min(30, 10 + d.breaches.total * 3); flags.push(`Present in ${d.breaches.total} known data breach(es)`); }
    if (d.mx?.length && !d.spf) { score += 5; flags.push('Sender domain has no SPF'); }
    if (d.mx?.length && !d.dmarc) { score += 5; flags.push('Sender domain has no DMARC (spoofable)'); }
    if (d.domainHistory && d.domainHistory.archived === false) { score += 5; flags.push('Domain has no Wayback history'); }
  }
  if (d.type === 'username') {
    if (d.foundCount === 0) flags.push('Handle not found on any checked platform');
    if (d.github?.commitEmails?.length) flags.push(`${d.github.commitEmails.length} email address(es) leaked via public commits`);
    if (d.foundCount >= 8) flags.push(`Handle reused across ${d.foundCount} platforms (strong cross-platform identity)`);
  }
  if (d.type === 'phone') {
    if (!d.valid) { score += 20; flags.push('Number does not parse as a valid E.164 number'); }
    for (const f of d.flags || []) flags.push(f);
    if (d.lineType === 'premium-rate') score += 20;
    if (d.numverify?.status === 'ok' && d.numverify.valid === false) { score += 30; flags.push('Carrier lookup reports number invalid'); }
  }
  if (d.type === 'url') {
    score = Math.max(score, d.phishScore || 0);
    for (const f of d.heuristics || []) flags.push(f);
    if (d.redirects >= 3) { score += 10; flags.push(`${d.redirects} redirect hops`); }
  }
  if (d.type === 'btc' || d.type === 'eth') {
    if (d.ofac?.sanctioned) { score = 100; flags.push('ADDRESS IS ON THE OFAC SDN LIST'); }
    if (d.opensanctions?.status === 'ok' && d.opensanctions.matches?.length) { score = 100; flags.push(`Sanctions match: ${d.opensanctions.matches[0].caption}`); }
    if (d.txCount === 0) flags.push('Address has never transacted');
  }
  score = Math.min(100, score);
  const level = score >= 60 ? 'critical' : score >= 35 ? 'high' : score >= 15 ? 'elevated' : 'low';
  return { score, level, flags };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

async function investigateDomain(domain) {
  const [whois, dns, ct, vt, typo] = await Promise.all([
    rdapDomain(domain),
    dnsRecords(domain),
    certTransparency(domain),
    virusTotal('domain', domain),
    (async () => {
      const perms = generatePermutations(domain, 60);
      const registered = await resolveMany(perms);
      return { checked: perms.length, registered };
    })(),
  ]);
  const ips = [...new Set((dns.A || []).length ? dns.A : (dns.AAAA || []))].slice(0, 4);
  const [hosts, history, threat, scans, web] = await Promise.all([
    Promise.all(ips.map(async ip => {
      const [idb, ipWhois, shodan, geo, tor] = await Promise.all([internetDb(ip), rdapIp(ip), shodanHost(ip), geolocate(ip), torExitCheck(ip)]);
      return { ...idb, network: ipWhois, shodan, geo, tor };
    })),
    wayback(domain), otx('domain', domain), urlscan(domain), ips.length ? httpFingerprint(`https://${domain}/`) : Promise.resolve(null),
  ]);
  return { whois, dns, certificates: ct, virustotal: vt, typosquats: typo, hosts, history, otx: threat, urlscan: scans, web, tor: hosts.find(h => h.tor?.isTorExit)?.tor || null };
}

async function investigateIp(ip) {
  const [idb, network, ptr, vt, shodan, geo, tor, threat] = await Promise.all([
    internetDb(ip), rdapIp(ip), reverseDns(ip), virusTotal('ip', ip), shodanHost(ip), geolocate(ip), torExitCheck(ip), otx('ip', ip),
  ]);
  return { hosts: [{ ...idb, network, shodan, geo, tor }], reverseDns: ptr, virustotal: vt, geo, tor, otx: threat };
}

const HASH_ALGO = { 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256' };
async function investigateHash(hash) {
  const [vt, threat] = await Promise.all([virusTotal('hash', hash), otx('hash', hash)]);
  return { algorithm: HASH_ALGO[hash.length] || 'unknown', virustotal: vt, otx: threat };
}

async function investigateCompany(name) {
  return { corporate: await openCorporates(name) };
}

export function keyedSourceStatus() {
  return {
    virustotal: !!process.env.VIRUSTOTAL_API_KEY,
    shodan: !!process.env.SHODAN_API_KEY,
    opencorporates: !!process.env.OPENCORPORATES_API_TOKEN,
    ...osintKeyedStatus(),
  };
}

export async function investigate(target) {
  const key = `${target.type}:${target.value}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return { ...cached.dossier, cached: true };

  const start = Date.now();
  const runner = {
    domain: investigateDomain, ip: investigateIp, hash: investigateHash, company: investigateCompany,
    email: investigateEmail, username: investigateUsername, phone: investigatePhone, url: investigateUrl,
    btc: v => investigateWallet('btc', v), eth: v => investigateWallet('eth', v),
  }[target.type];
  const result = await runner(target.value);
  const dossier = {
    target: target.value,
    type: target.type,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    keyed: keyedSourceStatus(),
    ...result,
  };
  dossier.risk = scoreDossier(dossier);

  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { ts: Date.now(), dossier });
  return dossier;
}

// Standalone test: node apis/sources/investigate.mjs example.com
if (process.argv[1]?.endsWith('investigate.mjs')) {
  const target = classifyTarget(process.argv[2] || 'example.com', process.argv[3]);
  if (!target) { console.error('Invalid target'); process.exit(1); }
  investigate(target).then(d => console.log(JSON.stringify(d, null, 2)));
}
