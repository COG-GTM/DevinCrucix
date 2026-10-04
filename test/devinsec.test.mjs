// Devin Security bridge — unit tests with an injected fetch (no network)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DevinSecurity, DevinNotConfigured, DevinApiError, readConfig, publicStatus, parseRepos, buildScanBrief, compactScan, compactFinding } from '../lib/devinsec.mjs';

const ENV = { DEVIN_API_KEY: 'tok_secret', DEVIN_ORG_ID: 'org-abc123def456', CRUCIX_SCAN_REPOS: 'COG-GTM/DevinCrucix, acme/web' };

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const r = handler(url, init); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) }; };
  f.calls = calls;
  return f;
}

describe('config', () => {
  it('reports exactly what is missing and never exposes the token', () => {
    const c = readConfig({});
    assert.equal(c.configured, false);
    assert.deepEqual(c.missing, ['DEVIN_API_KEY', 'DEVIN_ORG_ID', 'CRUCIX_SCAN_REPOS']);
    const p = publicStatus(ENV);
    assert.equal(p.configured, true);
    assert.equal(p.orgId, 'org-abc1…');
    assert.ok(!JSON.stringify(p).includes('tok_secret'));
    assert.deepEqual(parseRepos(ENV.CRUCIX_SCAN_REPOS), ['COG-GTM/DevinCrucix', 'acme/web']);
    assert.deepEqual(parseRepos('not a repo, ../x, ok/repo'), ['ok/repo']);
  });
});

describe('DevinSecurity unconfigured', () => {
  it('throws DevinNotConfigured (503) for every action without touching the network', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const d = new DevinSecurity({ env: {}, fetchImpl: f });
    for (const call of [() => d.startScan({ repo: 'a/b' }), () => d.listScans(), () => d.listFindings({ scanId: 'scan_1' }), () => d.remediate({ scanId: 'scan_1', findingId: 'fnd_1' })]) {
      await assert.rejects(call, (e) => e instanceof DevinNotConfigured && e.status === 503 && e.missing.length === 3);
    }
    assert.equal(f.calls.length, 0);
  });
});

describe('DevinSecurity configured', () => {
  it('starts a security scan on an allow-listed repo with a bearer token', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { scan_id: 'scan_123', repo_name: 'acme/web', status: 'pending', scan_type: 'security', effort: 'deep', url: 'https://app.devin.ai/code-scans/scan_123', created_at: 1791000000 } }));
    const d = new DevinSecurity({ env: ENV, fetchImpl: f });
    const scan = await d.startScan({ repo: 'acme/web', effort: 'deep' });
    assert.equal(scan.scanId, 'scan_123');
    assert.equal(scan.status, 'pending');
    assert.equal(scan.createdAt, '2026-10-03T04:00:00.000Z');
    const { url, init } = f.calls[0];
    assert.equal(url, 'https://api.devin.ai/v3/organizations/org-abc123def456/code-scans');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer tok_secret');
    assert.deepEqual(JSON.parse(init.body), { repo_name: 'acme/web', scan_type: 'security', effort: 'deep', interactive: false });
  });
  it('refuses repos outside CRUCIX_SCAN_REPOS and bad effort values before calling out', async () => {
    const f = fakeFetch(() => ({ status: 201, body: {} }));
    const d = new DevinSecurity({ env: ENV, fetchImpl: f });
    await assert.rejects(d.startScan({ repo: 'evil/repo' }), /not in CRUCIX_SCAN_REPOS/);
    await assert.rejects(d.startScan({ repo: 'acme/web', effort: 'max' }), /effort/);
    assert.equal(f.calls.length, 0);
  });
  it('lists scans / findings and maps upstream errors to DevinApiError', async () => {
    const f = fakeFetch((url) => url.includes('/findings') ? { status: 200, body: { items: [{ finding_id: 'fnd_1', scan_id: 'scan_1', repo_name: 'acme/web', title: 'SQLi in search', severity: 'high', status: 'open', created_at: 1791000000 }] } } : { status: 200, body: { items: [{ scan_id: 'scan_1', repo_name: 'acme/web', status: 'completed', url: 'u' }] } });
    const d = new DevinSecurity({ env: ENV, fetchImpl: f });
    const scans = await d.listScans({ repo: 'acme/web' });
    assert.equal(scans[0].scanId, 'scan_1');
    assert.match(f.calls[0].url, /code-scans\/scans\?repo_name=acme%2Fweb&first=20$/);
    const findings = await d.listFindings({ scanId: 'scan_1' });
    assert.equal(findings[0].title, 'SQLi in search');
    assert.match(f.calls[1].url, /code-scans\/findings\?scan_id=scan_1&first=100$/);
    const bad = new DevinSecurity({ env: ENV, fetchImpl: fakeFetch(() => ({ status: 409, body: { detail: 'backlog full' } })) });
    await assert.rejects(bad.listScans(), (e) => e instanceof DevinApiError && e.status === 409 && e.detail === 'backlog full');
  });
  it('remediate returns the session link', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { finding_id: 'fnd_1', session_id: 'devin-abc' } }));
    const d = new DevinSecurity({ env: ENV, fetchImpl: f });
    const out = await d.remediate({ scanId: 'scan_1', findingId: 'fnd_1' });
    assert.equal(out.sessionUrl, 'https://app.devin.ai/sessions/abc');
    assert.match(f.calls[0].url, /code-scans\/scan_1\/findings\/fnd_1\/remediate$/);
  });
});

describe('buildScanBrief', () => {
  it('summarises live KEV + ransomware data and is safe on an empty sweep', () => {
    const b = buildScanBrief({
      cyberKev: { deltaDays: 30, byVendor: [{ vendor: 'Citrix', products: ['NetScaler ADC'] }], dueSoon: [{ cveID: 'CVE-2026-1', vendor: 'Citrix', product: 'NetScaler ADC', dueDate: '2026-10-05' }] },
      ransomware: { windowDays: 7, groups: [{ name: 'qilin', count: 9, sectors: ['Healthcare'], tools: ['rclone'] }] },
    }, { now: Date.parse('2026-10-04T00:00:00Z') });
    assert.match(b.text, /Citrix \(NetScaler ADC\)/);
    assert.match(b.text, /qilin \(9 victims; Healthcare\)/);
    assert.match(b.text, /rclone/);
    assert.match(b.text, /cannot be patched from a repository scan/);
    assert.match(buildScanBrief({}).text, /KEV data unavailable/);
  });
  it('compact* tolerate missing fields', () => {
    assert.equal(compactScan().scanId, null);
    assert.equal(compactFinding({ status: 'weird' }).status, 'weird');
  });
});
