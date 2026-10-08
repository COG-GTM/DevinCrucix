// CRUCIX_PROFILE=europe: profile helpers in-process; profile-gated modules in a child process
// (they read the profile at import time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getProfile, inBox, applyProfileToData, clientProfile } from '../lib/profile.mjs';

const runEurope = code => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CRUCIX_PROFILE: 'europe' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('profile lookup: empty id is the full app, europe is case-insensitive', () => {
  assert.equal(getProfile(''), null);
  assert.equal(getProfile('EUROPE').id, 'europe');
  assert.equal(clientProfile(null), null);
  const c = clientProfile(getProfile('europe'));
  assert.equal(c.region, 'europe');
  assert.ok(c.tabs.includes('ukraine') && c.tabs.includes('prcdel'));
  for (const t of ['cartels', 'iranwar', 'taiwan', 'colombia', 'venezuela']) assert.ok(!c.tabs.includes(t), t);
  assert.ok(Array.isArray(c.skipSources) && c.skipSources.includes('InSightCrime'));
});

test('theater box keeps Europe, Russia and Ukraine and drops other regions', () => {
  const { box } = getProfile('europe');
  for (const [lat, lon] of [[50.45, 30.52], [55.76, 37.62], [52.23, 21.01], [41.71, 44.79], [43.13, 131.9]]) assert.ok(inBox(lat, lon, box), `${lat},${lon}`);
  for (const [lat, lon] of [[30.04, 31.24], [25.03, 121.56], [4.71, -74.07], [38.9, -77.04], [35.69, 51.39], [41.31, 69.24], [51.17, 71.45], [43.24, 76.89], [47.92, 106.92]]) assert.ok(!inBox(lat, lon, box), `${lat},${lon}`);
});

test('applyProfileToData filters geolocated rows, keeps rows without coordinates and the Ukraine payload', () => {
  const data = {
    news: [{ title: 'Kyiv', lat: 50.45, lon: 30.52 }, { title: 'Taipei', lat: 25.03, lon: 121.56 }, { title: 'no geo' }],
    thermal: { fires: [{ lat: 48.5, lng: 35 }, { lat: -10, lng: 20 }] },
    ukraine: [{ lat: 0, lon: 0 }],
    markets: [{ symbol: 'X' }],
  };
  const out = applyProfileToData(data, getProfile('europe'));
  assert.deepEqual(out.news.map(n => n.title), ['Kyiv', 'no geo']);
  assert.equal(out.thermal.fires.length, 1);
  assert.equal(out.ukraine.length, 1);
  assert.equal(out.markets.length, 1);
  assert.equal(out.profile.id, 'europe');
  const full = { news: [{ lat: 25, lon: 121 }] };
  assert.equal(applyProfileToData(full, null).news.length, 1);
});

test('europe sweep skips out-of-theater sources without reporting them as failed', () => {
  const r = runEurope(`import { runSource } from './apis/briefing.mjs';
    const a = await runSource('TaiwanMND', async () => { throw new Error('should not run'); });
    const b = await runSource('GDELT', async () => ({ ok: 1 }));
    console.log(JSON.stringify({ a, b: b.status }));`);
  assert.equal(r.a.status, 'skipped');
  assert.equal(r.b, 'ok');
});

test('europe tracker parses Russian delegations in Europe and ignores PRC / inbound-to-Russia headlines', () => {
  const r = runEurope(`import { isDelegationHeadline, extractMeetings, leaderOf, groupDelegations, DELEGATION_QUERIES } from './lib/prcdel/tracker.mjs';
    const h = 'Serbian President Vucic meets Russian delegation led by Lavrov in Belgrade';
    const g = groupDelegations([
      { city: 'Belgrade', country: 'Serbia', iso2: 'RS', lat: 44.8, lon: 20.46, date: '2026-10-01', category: 'Diplomatic', leader: 'Sergei Lavrov' },
      { city: 'Moscow', country: 'Russia', iso2: 'RU', lat: 55.76, lon: 37.62, date: '2026-10-02', category: 'Diplomatic', leader: 'Sergei Lavrov' },
      { city: 'Cairo', country: 'Egypt', iso2: 'EG', lat: 30.04, lon: 31.24, date: '2026-10-03', category: 'Diplomatic', leader: 'Sergei Lavrov' }]);
    console.log(JSON.stringify({ ok: isDelegationHeadline(h), meetings: extractMeetings(h), leader: leaderOf(h),
      prc: isDelegationHeadline('Chinese delegation visits Cairo, meets ministers'), inbound: isDelegationHeadline('Hungarian delegation visits Moscow for talks'),
      stops: g.flatMap(d => d.stops.map(s => s.city)), q: DELEGATION_QUERIES.join(' ') }));`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.meetings, ['Serbian President Vucic']);
  assert.equal(r.leader, 'Sergei Lavrov');
  assert.equal(r.prc, false);
  assert.equal(r.inbound, false);
  assert.deepEqual(r.stops, ['Belgrade']);
  assert.match(r.q, /Russian delegation/);
  assert.doesNotMatch(r.q, /Chinese/);
});

test('europe synthetic scenario: Russian fictional POIs routed through European cities, partial coverage, test identifiers', () => {
  const r = runEurope(`import { readFileSync } from 'node:fs';
    import { generateSynthetic } from './lib/prcdel/synthetic.mjs';
    const sc = JSON.parse(readFileSync('config/synthetic/scenario.europe.json', 'utf8'));
    const s = generateSynthetic({ scenario: sc, now: Date.parse('2026-10-06T00:00:00Z') });
    const pois = s.persons.filter(p => p.isPOI);
    const cities = [...new Set(s.delegations.flatMap(d => d.stops.map(x => x.city)))];
    const ds = Object.keys(s.datasets);
    const has = p => ds.filter(k => JSON.stringify(s.datasets[k]).includes(p.passport?.number || p.phones[0]));
    console.log(JSON.stringify({ pois: pois.map(p => ({ nat: p.nationality, phone: p.phones[0], synthetic: p.synthetic, label: p.delegationLabel })), cities,
      events: s.events.map(e => e.host), coverage: pois.map(p => has(p).length), n: ds.length, allSyn: s.persons.every(p => p.synthetic) }));`);
  assert.equal(r.pois.length, 2);
  for (const p of r.pois) { assert.equal(p.nat, 'RU'); assert.match(p.phone, /^\+7 555 01/); assert.equal(p.synthetic, true); assert.match(p.label, /SYNTHETIC/); }
  for (const c of ['Budapest', 'Belgrade', 'Vienna', 'Chisinau', 'Tbilisi']) assert.ok(r.cities.includes(c), c);
  for (const c of ['Cairo', 'Beirut', 'Islamabad', 'Riyadh']) assert.ok(!r.cities.includes(c), c);
  assert.ok(r.events.includes('RT / Sputnik') && r.events.includes('Rosatom'));
  assert.equal(r.allSyn, true);
  assert.ok(r.coverage.some(c => c < r.n), 'every POI must be missing from at least one dataset');
});

test('europe SITREP is EUCOM-framed and drops SOUTHCOM-only sections', () => {
  const r = runEurope(`import { COMMAND, AOR_COUNTRIES, ASK_SECTION_ORDER, SITREP_BUILDERS } from './lib/sitrep/context.mjs';
    import { DOMAINS } from './lib/sitrep/index.mjs';
    console.log(JSON.stringify({ c: COMMAND.short, aor: AOR_COUNTRIES, ask: ASK_SECTION_ORDER, b: SITREP_BUILDERS.map(b => b.id + ' ' + b.label), d: DOMAINS }));`);
  assert.equal(r.c, 'EUCOM');
  assert.ok(r.aor.includes('Ukraine') && !r.aor.includes('Colombia'));
  assert.ok(r.ask.includes('ukraine') && !r.ask.includes('narco'));
  assert.ok(!r.b.some(x => /colombia|venezuela|caribbean|SOUTHCOM/i.test(x)));
  assert.ok(r.d.some(x => /Ukraine/.test(x)));
});

test('applyProfileToData keeps unlocated rows and filters nested region observations', () => {
  const data = {
    acled: [{ lat: 50, lon: 30 }, { lat: null, lon: null }, { lat: 4, lon: -74 }],
    air: [{ region: 'Taiwan Strait', tracks: [{ lat: 25, lon: 121 }] }, { region: 'Baltic', tracks: [{ lat: 56, lon: 20 }, { lat: 25, lon: 121 }] }],
    thermal: [{ region: 'Ukraine', fires: [{ lat: 48, lon: 37 }] }, { region: 'Brazil', fires: [{ lat: -10, lon: -50 }] }],
  };
  const out = applyProfileToData(data, getProfile('europe'));
  assert.equal(out.acled.length, 2);
  assert.deepEqual(out.air.map(r => r.region), ['Baltic']);
  assert.equal(out.air[0].tracks.length, 1);
  assert.deepEqual(out.thermal.map(r => r.region), ['Ukraine']);
});

test('europe tracker picks the in-theater destination after a Moscow origin and drops Central Asia', () => {
  const r = runEurope(`import { parseDelegationItem } from './lib/prcdel/tracker.mjs';
    const a = parseDelegationItem({ title: 'Russian delegation from Moscow visits Belgrade for talks - Outlet', published: '2026-10-01T10:00:00Z', link: 'u' });
    const b = parseDelegationItem({ title: 'Russian delegation visits Tashkent for talks - Outlet', published: '2026-10-01T10:00:00Z', link: 'u' });
    console.log(JSON.stringify({ a: a && a.city, b }));`);
  assert.equal(r.a, 'Belgrade');
  assert.equal(r.b, null);
});

test('europe rules-only SITREP leads with the Ukraine section', () => {
  const r = runEurope(`import { DOMAINS } from './lib/sitrep/index.mjs';
    import * as m from './lib/sitrep/index.mjs';
    console.log(JSON.stringify({ d0: DOMAINS[0], src: String(m.rulesOnlySitrep || '') .includes("ids: ['ukraine'") }));`);
  assert.equal(r.d0, 'Russia–Ukraine war');
  assert.equal(r.src, true);
});

test('europe buildTracker drops cached / curated out-of-theater events', () => {
  const r = runEurope(`import { buildTracker } from './lib/prcdel/tracker.mjs';
    const out = buildTracker({ stops: [], events: [
      { city: 'Kathmandu', country: 'Nepal', iso2: 'NP', lat: 27.7, lon: 85.3, date: '2026-09-09' },
      { city: 'Belgrade', country: 'Serbia', iso2: 'RS', lat: 44.8, lon: 20.46, date: '2026-09-09' } ] });
    console.log(JSON.stringify(out.events.map(e => e.city)));`);
  assert.deepEqual(r, ['Belgrade']);
});

test('europe tracker does not turn Ukraine-as-topic into a Kyiv stop', () => {
  const r = runEurope(`import { parseDelegationItem } from './lib/prcdel/tracker.mjs';
    const a = parseDelegationItem({ title: 'Russian delegation says Moscow ready for peace talks on Ukraine - Outlet', published: '2026-10-01T10:00:00Z', link: 'u' });
    console.log(JSON.stringify(a));`);
  assert.equal(r, null);
});
