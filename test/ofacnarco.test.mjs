// OFAC SDN narco index: program scope, entity/individual parsing, conservative name matching,
// conditional refresh with stale fallback. Uses a recorded SDN.XML sample; no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSDN, parseEntry, buildNameIndex, matchName, matchNames, summarizeIndex, groupDesignations, sdnSearchUrl, loadIndex, briefing,
  NARCO_PROGRAMS, TERROR_PROGRAMS, INDEX_SCHEMA, SDN_XML_URL,
} from '../apis/sources/ofacnarco.mjs';

const XML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ofac/sdn-sample.xml'), 'utf8');
const NOW = Date.parse('2026-09-05T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'ofac-'));
const LM = 'Fri, 04 Sep 2026 20:00:00 GMT';

function xmlFetch({ lastModified = LM, status = 200, body = XML } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push(init.method || 'GET');
    return {
      ok: status < 400, status,
      headers: { get: h => (h.toLowerCase() === 'last-modified' ? lastModified : null) },
      text: async () => body,
    };
  };
  f.calls = calls;
  return f;
}

describe('SDN parsing', () => {
  const idx = parseSDN(XML);
  const sample = [...XML.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)].map(m => m[1]);

  it('keeps only narco-program entries plus Mexico-linked FTO/SDGT entries', () => {
    assert.equal(sample.length, 12);
    assert.equal(idx.entries.length, 9);
    assert.equal(parseEntry(sample[0]), null, 'CUBA-program airline is out of scope');
    for (const e of idx.entries) {
      assert.ok(e.narcoPrograms.length || (e.terrorPrograms.length && e.mexico), e.name);
      assert.ok(e.programs.every(p => typeof p === 'string'));
    }
    assert.deepEqual(NARCO_PROGRAMS, ['SDNTK', 'SDNT', 'ILLICIT-DRUGS-EO14059', 'TCO']);
    assert.deepEqual(TERROR_PROGRAMS, ['FTO', 'SDGT']);
  });

  it('preserves entity/individual type, aliases, countries and provenance metadata', () => {
    const s = summarizeIndex(idx);
    assert.equal(s.entries, 9);
    assert.equal(s.individuals, 5);
    assert.equal(s.entities, 4);
    assert.equal(s.individuals + s.entities, s.entries);
    assert.equal(s.publishDate, '09/04/2026');
    assert.equal(s.recordCount, 19329);
    const chapo = idx.entries.find(e => e.uid === 6861);
    assert.equal(chapo.type, 'Individual');
    assert.equal(chapo.name, 'Joaquin GUZMAN LOERA');
    assert.ok(chapo.akas.length > 5);
    assert.ok(chapo.akas.every(a => a.name && ['strong', 'weak'].includes(a.category)));
    assert.ok(chapo.countries.includes('Mexico'));
    assert.ok(chapo.remarks == null || chapo.remarks.length <= 400);
  });

  it('maps listed organisations to cartel groups conservatively', () => {
    const d = groupDesignations(idx);
    assert.deepEqual(Object.keys(d).sort(), ['cdn', 'cjng', 'sinaloa', 'zetas']);
    assert.ok(d.sinaloa.some(x => x.name === 'SINALOA CARTEL' && x.programs.includes('FTO')));
    const chapitos = idx.entries.filter(e => /GUZMAN SALAZAR/.test(e.name));
    assert.equal(chapitos.length, 2);
    for (const c of chapitos) assert.ok(c.groups.includes('sinaloa_chapitos'));
    assert.deepEqual(idx.entries.find(e => e.uid === 12278).groups, [], 'front company with no alias match stays unmapped');
  });
});

describe('SDN name matching', () => {
  const idx = parseSDN(XML);
  const ni = buildNameIndex(idx);

  it('matches full names and organisation names exactly, accent- and case-insensitively', () => {
    assert.equal(matchName('Joaquín Guzmán Loera', idx, ni).strength, 'exact');
    assert.equal(matchName('Cártel del Noreste', idx, ni).entry.uid, 11438);
    assert.equal(matchName('Jose de Jesus Amezcua Contreras', idx, ni).strength, 'exact');
  });

  it('rejects lone tokens, near-names and unrelated people', () => {
    assert.equal(matchName('Guzman', idx, ni), null);
    assert.equal(matchName('El Chapo', idx, ni), null, 'two-token weak nickname without surname is not enough');
    assert.equal(matchName('Juan Pérez', idx, ni), null);
    assert.equal(matchName('Rubén Oseguera González', idx, ni), null, 'shares 2 of 3 tokens only');
    assert.equal(matchName('Sinaloa', idx, ni), null);
  });

  it('matchNames returns bounded public records with an OFAC search URL', () => {
    const out = matchNames(['Joaquín Guzmán Loera', { name: 'Nobody Here' }, 'Cartel de Jalisco Nueva Generación'], idx, ni);
    assert.deepEqual(out.map(m => m.uid), [6861, 17671]);
    for (const m of out) {
      assert.match(m.url, /^https:\/\/sanctionssearch\.ofac\.treas\.gov\/\?q=/);
      assert.ok(Array.isArray(m.programs) && m.programs.length);
      assert.ok(['exact', 'partial'].includes(m.strength));
    }
    assert.equal(sdnSearchUrl('a"b<c>'), 'https://sanctionssearch.ofac.treas.gov/?q=a%22b%3Cc%3E');
  });
});

describe('OFAC briefing refresh cycle', () => {
  it('first run downloads, persists a schema-tagged index and reports live', async () => {
    const dir = tmp();
    try {
      const f = xmlFetch();
      const b = await briefing({ fetch: f, dataDir: dir, now: NOW });
      assert.equal(b.source, 'OFACNarco');
      assert.equal(b.status, 'live');
      assert.equal(b.refresh.action, 'refreshed');
      assert.equal(b.listUrl, SDN_XML_URL);
      assert.equal(b.summary.entries, 9);
      assert.equal(b.refresh.listLastModified, LM);
      assert.ok(existsSync(join(dir, 'index.json')));
      assert.equal(loadIndex(dir).schema, INDEX_SCHEMA);
      assert.ok(Object.keys(b.designatedGroups).includes('cjng'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('within the refresh window it serves the cache; past it, an unchanged Last-Modified skips the download', async () => {
    const dir = tmp();
    try {
      await briefing({ fetch: xmlFetch(), dataDir: dir, now: NOW });
      const cached = xmlFetch();
      const c = await briefing({ fetch: cached, dataDir: dir, now: NOW + 3_600_000, refreshHours: 24 });
      assert.equal(c.refresh.action, 'cached');
      assert.equal(cached.calls.length, 0);
      const head = xmlFetch();
      const u = await briefing({ fetch: head, dataDir: dir, now: NOW + 25 * 3_600_000, refreshHours: 24 });
      assert.equal(u.refresh.action, 'unchanged');
      assert.deepEqual(head.calls, ['HEAD']);
      assert.equal(u.status, 'live');
      const changed = xmlFetch({ lastModified: 'Sat, 05 Sep 2026 20:00:00 GMT' });
      const r = await briefing({ fetch: changed, dataDir: dir, now: NOW + 50 * 3_600_000, refreshHours: 24 });
      assert.equal(r.refresh.action, 'refreshed');
      assert.deepEqual(changed.calls, ['HEAD', 'GET']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('falls back to the stored index when the refresh fails, and errors only with no index at all', async () => {
    const dir = tmp();
    try {
      const e = await briefing({ fetch: xmlFetch({ status: 503 }), dataDir: dir, now: NOW });
      assert.equal(e.status, 'error');
      assert.match(e.error, /HTTP 503/);
      assert.equal(e.summary, null);
      assert.deepEqual(e.designatedGroups, {});

      await briefing({ fetch: xmlFetch(), dataDir: dir, now: NOW });
      const s = await briefing({ fetch: async () => { throw new Error('ENOTFOUND host'); }, dataDir: dir, now: NOW + 48 * 3_600_000 });
      assert.equal(s.status, 'stale');
      assert.equal(s.stale, true);
      assert.equal(s.summary.entries, 9);
      assert.ok(!/ENOTFOUND/.test(JSON.stringify(s)));

      const junk = await briefing({ fetch: xmlFetch({ body: '<html>blocked</html>', lastModified: 'x' }), dataDir: dir, now: NOW + 96 * 3_600_000, force: true });
      assert.equal(junk.status, 'stale');
      assert.match(junk.error, /unexpected payload/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
