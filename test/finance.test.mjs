// lib/finance — CSV streaming, name scoring, FtM mapping, trail validation/store and the Offshore Leaks
// query layer over the committed demo snapshot (no network, no full index needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvRows, csvObjects } from '../lib/finance/csv.mjs';
import { fold, foldCompany, scoreNames, scoreCandidate, matchBand } from '../lib/finance/match.mjs';
import { icijRecord, icijLink, ofacRecord, gleifRecord, SOURCES } from '../lib/finance/ftm.mjs';
import { roleGroup } from '../lib/finance/schema.mjs';
import { validateTrail, TrailStore } from '../lib/finance/trails.mjs';
import { parseSdn, OfacIndex } from '../lib/finance/sources/ofac.mjs';
import { OffshoreLeaks, ftsQuery, SNAPSHOT_GZ } from '../lib/finance/sources/offshoreleaks.mjs';
import { gunzipFile } from '../scripts/build-offshoreleaks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures/finance/sample.csv');

test('csv: streams quoted, multiline and escaped fields', async () => {
  const rows = []; for await (const r of csvRows(fixture)) rows.push(r);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], ['1', 'SMITH, JOHN', 'United Kingdom', 'Panama Papers', 'line one\nline two']);
  assert.equal(rows[2][1], 'Quote "Co" Ltd');
  const objs = []; for await (const o of csvObjects(fixture)) objs.push(o);
  assert.equal(objs[2].name, 'Plain Name'); assert.equal(objs[2].note, 'trailing'); assert.equal(objs[2].countries, '');
});

test('match: folding, legal-form stripping and transparent scores', () => {
  assert.equal(fold('Société Générale & Cie.'), 'societe generale and cie');
  assert.equal(foldCompany('Blairmore Holdings, Inc.'), 'blairmore');
  assert.deepEqual(scoreNames('Blairmore Holdings Inc', 'BLAIRMORE HOLDINGS, INC.'), { score: 1, matched: ['name:exact'] });
  assert.equal(scoreNames('Christodoulos G. Vassiliades', 'CHRISTODOULOS G. VASSILIADES & CO. LLC').score, 0.92);
  assert.equal(scoreNames('DE VREE, OLAV F.', 'Olav F. de Vree').score, 0.85);
  assert.ok(scoreNames('Rami Makhlouf', 'Rami MAKHLUF').score < 0.5, 'transliteration variants are not asserted as the same name');
  assert.ok(scoreNames('Alpha', 'Omega Holdings').score < 0.3);
  const c = scoreCandidate({ name: 'Petropars Ltd', countries: ['Iran'], schema: 'Company' }, { name: 'PETROPARS LIMITED', countries: ['IR'], schema: 'Company' });
  assert.equal(c.score, 0.97); assert.deepEqual(c.matched, ['name:core', 'country:ir']);
  const mismatch = scoreCandidate({ name: 'John Smith', schema: 'Person' }, { name: 'John Smith', schema: 'Company' });
  assert.equal(mismatch.score, 0.85); assert.ok(mismatch.matched.includes('type:mismatch'));
  assert.equal(matchBand(0.95), 'strong'); assert.equal(matchBand(0.8), 'possible'); assert.equal(matchBand(0.55), 'weak'); assert.equal(matchBand(0.2), 'none');
});

test('ftm: records keep source attribution and never merge', () => {
  const rec = icijRecord({ id: 10034912, kind: 'entity', name: 'BLAIRMORE HOLDINGS, INC.', jurisdiction: 'PMA', jurisdiction_description: 'Panama', address: 'Nassau', incorporation_date: '04-MAY-1982', status: 'Active', service_provider: 'Mossack Fonseca', countries: 'Bahamas', country_codes: 'BHS', source: 'Panama Papers', note: 'current through 2015' }, { release: '2026-09-09', mode: 'full' });
  assert.equal(rec.id, 'icij:10034912'); assert.equal(rec.schema, 'Company');
  assert.deepEqual(rec.properties.jurisdiction, ['Panama']); assert.deepEqual(rec.properties.countryCode, ['bhs']);
  assert.equal(rec.source.key, 'icij'); assert.equal(rec.source.license, 'ODbL 1.0'); assert.equal(rec.source.dataset, 'Panama Papers'); assert.match(rec.source.url, /offshoreleaks\.icij\.org\/nodes\/10034912$/);
  assert.equal(rec.source.tier, 'reported');
  const l = icijLink({ src: 1, dst: 2, rel: 'officer_of', link: 'shareholder of', status: null, start_date: null, end_date: null, source: 'Panama Papers' });
  assert.equal(l.role, 'ownership'); assert.equal(l.state, 'reported'); assert.equal(l.from, 'icij:1');
  assert.equal(roleGroup('officer_of', 'director of'), 'control'); assert.equal(roleGroup('registered_address', null), 'address'); assert.equal(roleGroup('same_name_as', null), 'identity'); assert.equal(roleGroup('intermediary_of', null), 'service');
  const o = ofacRecord({ uid: 123, name: 'ACME TRADING', type: 'Entity', programs: ['IRAN'], akas: [{ name: 'ACME' }], countries: ['Iran'] });
  assert.equal(o.id, 'ofac:123'); assert.equal(o.schema, 'LegalEntity'); assert.equal(o.source.tier, 'official'); assert.deepEqual(o.properties.alias, ['ACME']);
  const g = gleifRecord({ attributes: { lei: '213800Y5N6OWXSHHG907', entity: { legalName: { name: 'X LLC' }, otherNames: [{ name: 'Y' }], legalAddress: { addressLines: ['1 St'], city: 'Nicosia', country: 'CY' }, jurisdiction: 'CY', status: 'ACTIVE' }, registration: { status: 'ISSUED' } } });
  assert.equal(g.id, 'lei:213800Y5N6OWXSHHG907'); assert.equal(g.source.license, 'CC0 1.0'); assert.deepEqual(g.properties.country, ['cy']);
  assert.ok(SOURCES.icij.disclaimer.startsWith('There are legitimate uses for offshore companies and trusts.'));
});

test('ofac: full SDN parse keeps every program', () => {
  const xml = `<sdnList><publshInformation><Publish_Date>10/02/2026</Publish_Date></publshInformation>
    <sdnEntry><uid>42</uid><lastName>ACME TRADING S.A.</lastName><sdnType>Entity</sdnType><programList><program>IRAN</program><program>SDGT</program></programList>
      <akaList><aka><type>a.k.a.</type><category>strong</category><lastName>ACME TRADE</lastName></aka></akaList><addressList><address><country>Panama</country></address></addressList><remarks>test</remarks></sdnEntry>
    <sdnEntry><uid>43</uid><firstName>Rami</firstName><lastName>MAKHLUF</lastName><sdnType>Individual</sdnType><programList><program>SYRIA</program></programList><nationalityList><nationality><country>Syria</country></nationality></nationalityList></sdnEntry></sdnList>`;
  const idx = parseSdn(xml);
  assert.equal(idx.count, 2); assert.equal(idx.publishDate, '10/02/2026');
  assert.deepEqual(idx.entries[0].programs, ['IRAN', 'SDGT']); assert.deepEqual(idx.entries[0].countries, ['Panama']); assert.equal(idx.entries[1].name, 'Rami MAKHLUF');
  const o = new OfacIndex({ file: join(mkdtempSync(join(tmpdir(), 'fin-ofac-')), 'none.json') });
  assert.equal(o.screen('Acme Trading').status, 'unavailable');
  o.index = idx; o.prepare();
  const r = o.screen('Acme Trading S.A.', { countries: ['Panama'] });
  assert.equal(r.hits.length, 1); assert.equal(r.hits[0].score, 1); assert.equal(r.hits[0].band, 'strong'); assert.ok(r.hits[0].matched.includes('country:pa')); assert.equal(r.hits[0].record.id, 'ofac:42');
  assert.equal(o.screen('Rami Makhlouf', { schema: 'Person' }).hits.length, 0, 'no fuzzy transliteration match without an alias');
  assert.equal(o.screen('Rami MAKHLUF', { schema: 'Person' }).hits[0].record.schema, 'Person');
});

test('trails: validation, claim states, decisions and license-aware export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-trails-'));
  const store = new TrailStore({ dataDir: dir });
  assert.equal(validateTrail({ title: 'x', nodes: [] }).ok, false);
  assert.equal(validateTrail({ title: 'Trail', nodes: [{ id: 'bogus', caption: 'A' }] }).field, 'nodes');
  const body = {
    title: 'Debono fuel network', notes: 'demo',
    nodes: [
      { id: 'icij:56027574', caption: 'GORDON DEBONO', schema: 'LegalEntity', properties: { country: ['Malta'], kind: ['officer'] }, source: { key: 'icij', tier: 'reported', dataset: 'Paradise Papers - Malta corporate registry', url: 'https://offshoreleaks.icij.org/nodes/56027574', license: 'ODbL 1.0' } },
      { id: 'ofac:23193', caption: 'Gordon DEBONO', schema: 'Person', properties: { program: ['LIBYA3'] }, source: { key: 'ofac', tier: 'official', url: 'javascript:alert(1)' } },
      { id: 'os:Q123', caption: 'Gordon Debono', schema: 'Person', properties: { topics: ['sanction'] }, source: { key: 'opensanctions', tier: 'official', url: 'https://www.opensanctions.org/entities/Q123/' } },
    ],
    links: [
      { from: 'icij:56027574', to: 'ofac:23193', label: 'possible same', score: 1, matched: ['name:exact', 'country:mt'] },
      { from: 'icij:56027574', to: 'os:Q123', label: 'possible same', score: 0.8, state: 'reported', source: { key: 'icij' } },
    ],
  };
  const v = validateTrail(body);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.value.nodes[1].source.url, null, 'unsafe URLs are dropped');
  assert.equal(v.value.links[0].state, 'proposed'); assert.match(v.value.links[0].id, /^tl_/);
  const created = store.create(v.value, { ip: 't' });
  assert.ok(created.ok); const id = created.trail.id;
  assert.equal(store.list()[0].pending, 1);
  const linkId = created.trail.links[0].id;
  assert.equal(store.decide(id, linkId, 'accept').link.state, 'accepted');
  assert.equal(store.decide(id, created.trail.links[1].id, 'reject').ok, false, 'reported links cannot be adjudicated');
  assert.equal(store.decide(id, linkId, 'reset').link.state, 'proposed');
  store.decide(id, linkId, 'accept');
  const replaced = store.replace(id, { ...v.value, links: v.value.links.map((l, i) => ({ ...l, id: created.trail.links[i].id })) });
  assert.equal(replaced.trail.links[0].state, 'accepted', 'decisions survive a re-save');
  const out = store.exportJson(id);
  assert.equal(out.nodes[0].properties.country[0], 'Malta', 'ODbL record exported in full');
  assert.equal(out.nodes[2].properties, undefined, 'CC BY-NC record exported as reference only');
  assert.match(out.disclaimer, /Leads, not verdicts/);
  assert.ok(existsSync(join(dir, 'audit.jsonl')));
  assert.ok(store.remove(id).ok); assert.equal(store.list().length, 0);
});

test('offshoreleaks: demo snapshot search / profile / graph are bounded and attributed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-idx-'));
  const file = join(dir, 'demo.sqlite');
  await gunzipFile(SNAPSHOT_GZ, file);
  const idx = new OffshoreLeaks(file);
  const st = idx.status();
  assert.equal(st.mode, 'snapshot'); assert.ok(st.nodes > 500); assert.equal(st.release, '2026-09-09');
  assert.equal(ftsQuery('Blairmore Holdings'), '"blairmore" "holdings"*');
  const s = idx.search('Blairmore Holdings');
  assert.equal(s.results[0].id, 'icij:10034912'); assert.equal(s.results[0].source.dataset, 'Panama Papers'); assert.ok(s.results[0].degree >= 2);
  assert.equal(idx.search('Debono', { kind: 'officer' }).results.every(r => r.properties.kind[0] === 'officer'), true);
  assert.equal(idx.search('x').total, 0);
  const n = idx.neighbors(56027574);
  assert.ok(n.degree >= 30); assert.ok(n.byRole.ownership?.length || n.byRole.control?.length); assert.ok(n.links.every(l => l.state === 'reported'));
  const g = idx.graph(56027574, { depth: 2, fan: 10, maxNodes: 40 });
  assert.ok(g.nodes.length <= 40); assert.ok(g.truncated); assert.equal(g.root, 'icij:56027574'); assert.ok(g.links.every(l => l.role !== 'identity'));
  assert.equal(idx.graph(1), null);
  idx.close();
});
