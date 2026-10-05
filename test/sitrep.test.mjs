// lib/sitrep — SOUTHCOM context pack, draft prompt / parse, rules-only fallback, Markdown render,
// the edition store and the AM / PM schedule. Fake providers only; nothing leaves the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSitrepPack, renderSitrepPack, draftSystemPrompt, parseDraft, rulesOnlySitrep, renderMarkdown, generateSitrep, editionId, fixBaselineClaim, flagUnsupportedChanges, SAME_FIGURE,
  annotateSentences, repairSystemPrompt, UNCITED, REPAIR_THRESHOLD,
  DOMAINS, MAX_ACTIVITY, MAX_WATCH, BANNER, SITREP_VERSION,
} from '../lib/sitrep/index.mjs';
import { SITREP_SECTION_IDS, ASK_SECTION_ORDER, AOR_COUNTRIES } from '../lib/sitrep/context.mjs';
import { SitrepStore, sha256, MAX_EDITIONS } from '../lib/sitrep/store.mjs';
import { dueEdition, nextSlot, zonedTime, localDateKey, localParts, parseTimes, isValidTimeZone, CATCH_UP_MS } from '../lib/sitrep/schedule.mjs';

const STATE = {
  lastSweepTime: '2026-10-05T10:00:00.000Z',
  data: {
    situation: { asOf: '2026-10-05T10:02:00.000Z', rulesFired: 1, counts: { high: 1 }, headlines: [{ severity: 'high', title: 'Border Watch spike: Reynosa', why: '3.1x baseline', source: 'BorderNews', tab: 'cartels' }] },
    defcon: { level: 4, label: 'ABOVE NORMAL', score: 32, components: { gdelt: { score: 40, weight: 0.3, detail: '12 conflict events' } } },
    delta: { summary: { totalChanges: 2, criticalChanges: 0, direction: 'escalating', signalBreakdown: { new: 2 } }, signals: { new: [{ text: 'New IODA alert Venezuela', reason: 'IODA' }] } },
    cii: { countries: [{ name: 'Venezuela', code: 'VE', score: 71, level: 'High', trend: 'up', trendDelta: 3 }, { name: 'Ukraine', code: 'UA', score: 90, level: 'Critical', trend: 'flat' }, { name: 'Haiti', code: 'HT', score: 80, level: 'Critical', trend: 'up' }] },
    acled: { totalEvents: 300, topCountries: { Colombia: 40, Ukraine: 120 }, deadliestEvents: [{ date: '2026-10-04', country: 'Colombia', location: 'Cauca', type: 'Battles', fatalities: 6 }, { date: '2026-10-04', country: 'Ukraine', location: 'Kharkiv', type: 'Explosions', fatalities: 9 }] },
    air: [{ region: 'Caribbean', key: 'caribbean', total: 212, noCallsign: 9, highAlt: 60, top: [['United States', 150], ['Panama', 20]], provenance: { byConfidence: { corroborated: 20, single: 180, stale: 12 }, meanScore: 61 }, tracks: [{ callsign: 'RCH123', icao24: 'ae1234', country: 'United States', alt: 9000, military: true, prov: { confidence: 'corroborated' } }] }, { region: 'Ukraine Region', key: 'ukraine', total: 5, top: [] }],
    chokepoints: [{ label: 'Panama Canal', note: '5% of world trade' }, { label: 'Strait of Hormuz', note: '20% of world oil' }],
    carriers: { carriers: [{ hull: 'CVN-69', name: 'USS Eisenhower', lat: 15.2, lng: -75.1, estimated: true, desc: 'Caribbean deployment', source: 'OSINT' }, { hull: 'CVN-70', name: 'USS Vinson', lat: 20, lng: 130, estimated: true, desc: 'Pacific', source: 'OSINT' }] },
    gpsJamming: { zones: [{ region: 'Caribbean', pctLabel: '12%', severity: 'low', degraded: 3, total: 25 }] },
    ioda: { alertCount: 3, windowHours: 24, criticalCount: 1, countries: [{ name: 'Venezuela', code: 'VE', severity: 'critical', alerts: 2, maxDropPct: 40 }, { name: 'Iran', code: 'IR', severity: 'normal', alerts: 1 }] },
    insightCrime: { articles: [{ title: 'Cocaine routes shift to Ecuador', date: '2026-10-04', categories: ['Ecuador'] }], sanctionsHits: [{ entity: 'Clan del Golfo', program: 'SDNTK', matchType: 'exact' }] },
    country: {
      co: { status: 'live', name: 'Colombia', sourceRows: [{ name: 'ColombiaNews', status: 'live' }], hero: { tiles: [{ key: 'theft', kind: 'official', label: 'Hurto a personas · Bogotá · 2026-08', value: 9123, sub: '+4% vs 2026-07' }] }, news: { articles: [{ title: 'Clan del Golfo attacks police post in Antioquia', published: '2026-10-05T03:00:00Z', feed: 'El Tiempo' }] }, sat: { ytd: { year: 2026, alerts: 31 } }, indepaz: { masacres: { years: [{ year: 2026, massacres: 60, victims: 190 }] } } },
      ve: { status: 'limited', name: 'Venezuela', sourceRows: [{ name: 'OVCS', status: 'live' }], hero: { tiles: [] }, news: { articles: [{ title: 'Caracas blackout enters second day', published: '2026-10-05T01:00:00Z', feed: 'Efecto Cocuyo' }] }, ovcs: { latest: { month: '2026-09', protests: 410, perDay: 13.7 } } },
    },
    meta: { health: { live: 40, degraded: 2 }, sources: [{ name: 'OpenSky', status: 'degraded', error: 'timeout' }] },
    telegramLive: { recentMessages: [{ timestamp: '2026-10-05T09:00:00Z', channel: 'intelslava', text: 'Unconfirmed report of seizure off La Guajira' }] },
  },
  narco: { windowDays: 30, totals: { current: 3, byGrade: { C: 3 }, byType: { seizure: 2, arrest: 1 }, byState: { Sinaloa: 3 }, byCartel: { cjng: 2 }, sanctionsMatches: 2 }, events: [{ date: '2026-10-04', type: 'seizure', typeLabel: 'Seizure', location: { city: 'Culiacán', state: 'Sinaloa' }, cartels: [{ id: 'cjng', short: 'CJNG' }], grade: 'C', headline: 'Fentanyl seizure in Culiacán' }] },
  graph: null, requirements: { rules: [{ id: 'r1', name: 'Venezuela outage', text: 'Alert on IODA critical in VE', severity: 'high', latest: { fired: true } }], firedCount: 1 },
  targets: [], contacts: { total: 400, military: 12, byConfidence: { corroborated: 40, single: 340, stale: 20 } },
};

const fakeProvider = (text, { fail = false } = {}) => ({
  isConfigured: true, name: 'fake', model: 'fake-1', supportsWebSearch: false,
  calls: [],
  async complete(system, user, opts) { this.calls.push({ system, user, opts }); if (fail) throw new Error('boom 503'); return { text, model: 'fake-1', usage: { inputTokens: 1000, outputTokens: 400 } }; },
});

const GOOD = JSON.stringify({
  bluf: 'Venezuela instability is rising [aor] with a two-day Caracas blackout [venezuela][outages]. Colombia saw a Clan del Golfo attack in Antioquia [colombia]. Fabricated claim [nosuch].',
  activity: [
    { domain: 'Political / security (Colombia, Venezuela, AOR)', text: 'Blackout reported by independent wires [venezuela]; IODA shows a 40% drop [outages].' },
    { domain: 'Maritime & air', text: '212 aircraft in the Caribbean box, provenance mostly single-source [caribbeanair]; USS Eisenhower OSINT-estimated in the Caribbean [maritime].' },
    { domain: 'Not a domain', text: 'Something [sanctions].' },
    { domain: 'Counter-narcotics & transnational crime', text: 'x [narco]' }, { domain: 'Cyber & information', text: 'y [telegram]' }, { domain: 'Humanitarian / instability', text: 'z [aor]' }, { domain: 'Sanctions & enforcement', text: 'w [sanctions]' }, { domain: 'Extra', text: 'dropped [aor]' },
  ],
  changes: 'Baseline edition; no previous SITREP. New IODA alert since the last sweep [delta].',
  watch: ['Caracas power restoration [outages]', 'Clan del Golfo follow-on attacks [colombia]', 'a', 'b', 'c', 'd', 'e', 'f'],
  assessment: 'Assessment (moderate confidence): outage likely persists 24 h [outages][venezuela].',
  integrity: 'Telegram seizure report is single-source and unverified [telegram]; OpenSky degraded [sources].',
});

test('buildSitrepPack: SOUTHCOM sections first, AOR filtering, Ask sections in reading order, theaters excluded', () => {
  const pack = buildSitrepPack(STATE);
  const ids = pack.sections.map(s => s.id);
  assert.ok(ids.indexOf('colombia') < ids.indexOf('situation'), 'AOR sections precede Ask sections');
  for (const id of ['colombia', 'venezuela', 'aor', 'conflict', 'caribbeanair', 'maritime', 'sanctions', 'outages', 'situation', 'defcon', 'delta', 'narco', 'telegram', 'sources']) assert.ok(ids.includes(id), `has ${id}`);
  assert.ok(!ids.includes('ukraine') && !ids.includes('iranwar') && !ids.includes('taiwan') && !ids.includes('macro') && !ids.includes('ioda'), 'theater / market / global-outage sections excluded');
  assert.ok(!ids.includes('previous'), 'no previous edition → no section');
  const by = id => pack.sections.find(s => s.id === id).text;
  assert.match(by('aor'), /Venezuela 71/); assert.match(by('aor'), /Haiti 80/); assert.doesNotMatch(by('aor'), /Ukraine/);
  assert.match(by('conflict'), /Colombia 40/); assert.doesNotMatch(by('conflict'), /Kharkiv/);
  assert.match(by('caribbeanair'), /212 aircraft of all types in box \(airliners, cargo, GA and military together; 1 tracks flagged military\)/); assert.match(by('caribbeanair'), /corroborated 20/); assert.match(by('caribbeanair'), /400 fused contacts/); assert.match(by('caribbeanair'), /RCH123/);
  assert.match(by('maritime'), /Panama Canal/); assert.doesNotMatch(by('maritime'), /Hormuz/); assert.match(by('maritime'), /Eisenhower/); assert.doesNotMatch(by('maritime'), /Vinson/); assert.match(by('maritime'), /GPS degradation Caribbean/);
  assert.match(by('outages'), /Venezuela \(VE\): critical/); assert.doesNotMatch(by('outages'), /Iran/);
  assert.match(by('colombia'), /Hurto a personas.*\[official\]/); assert.match(by('colombia'), /El Tiempo: Clan del Golfo/); assert.match(by('colombia'), /SAT alerts 2026: 31/); assert.match(by('colombia'), /massacres 2026: 60/);
  assert.match(by('venezuela'), /OVCS protests 2026-09: 410/);
  assert.match(by('sanctions'), /Clan del Golfo.*SDNTK/); assert.match(by('sanctions'), /2 cartel-event clusters/);
  assert.equal(pack.asOf, STATE.data.situation.asOf);
  assert.ok(pack.sections.every(s => SITREP_SECTION_IDS.includes(s.id)));
  assert.match(renderSitrepPack(pack), /^### \[colombia\]/);
  const askPos = ASK_SECTION_ORDER.filter(id => ids.includes(id)).map(id => ids.indexOf(id));
  assert.deepEqual(askPos, [...askPos].sort((a, b) => a - b), 'Ask sections keep reading order');
});

test('buildSitrepPack: previous edition section, budget drops whole sections but never situation/defcon/previous', () => {
  const previous = { id: 'sitrep-20261004-pm', edition: 'pm', generatedAt: '2026-10-04T20:00:00Z', bluf: 'Prior BLUF text', watch: ['old watch item'], assessment: 'old assessment' };
  const pack = buildSitrepPack(STATE, { previous, maxChars: 300 });
  const ids = pack.sections.map(s => s.id);
  assert.deepEqual(ids.filter(id => ['previous', 'situation', 'defcon'].includes(id)).sort(), ['defcon', 'previous', 'situation']);
  assert.ok(pack.omitted.includes('colombia') && pack.omitted.includes('narco'), 'optional sections omitted when over budget');
  assert.match(pack.sections.find(s => s.id === 'previous').text, /sitrep-20261004-pm.*\n.*Prior BLUF text\nwatch: old watch item/);
  assert.deepEqual(buildSitrepPack({ data: null }).sections, []);
  assert.ok(AOR_COUNTRIES.includes('Panama') && !AOR_COUNTRIES.includes('Mexico'));
});

test('previous edition: prompt says NOT a baseline with the exact id, age in minutes; baseline claims are replaced deterministically', async () => {
  const previous = { id: 'sitrep-20261005-adhoc-140429', edition: 'adhoc', generatedAt: '2026-10-05T14:04:29Z', ageMinutes: 2, bluf: 'Prior BLUF', watch: [], assessment: 'prior' };
  const pack = buildSitrepPack(STATE, { previous });
  assert.deepEqual(pack.previous, { id: 'sitrep-20261005-adhoc-140429', label: 'ad hoc edition', generatedAt: '2026-10-05T14:04:29Z', ageMinutes: 2 });
  assert.match(pack.sections.find(s => s.id === 'previous').text, /\(2 minutes before this edition\)\. .*This edition is NOT a baseline\./);
  const p = draftSystemPrompt(pack, { edition: 'am' });
  assert.match(p, /a \[previous\] section IS present — ad hoc edition sitrep-20261005-adhoc-140429, generated 2026-10-05T14:04:29Z \(2 minutes before this edition\)\. This edition is NOT a baseline/);
  assert.match(p, /Open "changes" with "Versus ad hoc edition sitrep-20261005-adhoc-140429:"/);
  assert.doesNotMatch(p, /if no previous edition, say this is the baseline/);
  const p0 = draftSystemPrompt(buildSitrepPack(STATE), { edition: 'am' });
  assert.match(p0, /there is NO \[previous\] section — this is the baseline edition/);
  assert.equal(buildSitrepPack(STATE).previous, null);

  const fx = fixBaselineClaim('This edition is the baseline with no previous SITREP for direct comparison [situation]. Venezuela outages persist [outages]. No prior SITREP is available [delta].', pack.previous);
  assert.equal(fx.fixed, true);
  assert.equal(fx.text, 'Versus ad hoc edition sitrep-20261005-adhoc-140429 (generated 2026-10-05T14:04:29Z, 2 minutes before this edition) [previous]. Venezuela outages persist [outages].');
  assert.deepEqual(fixBaselineClaim('Versus the previous edition, unchanged [previous].', pack.previous), { text: 'Versus the previous edition, unchanged [previous].', fixed: false });
  assert.equal(fixBaselineClaim('Baseline edition [delta].', null).fixed, false, 'no previous → a baseline claim is correct');

  const draft = JSON.stringify({ ...JSON.parse(GOOD), changes: 'This edition is the baseline; no prior SITREP available except the ad hoc edition last hour ago [previous]. IODA alert unchanged [delta].' });
  const ed = await generateSitrep({ provider: fakeProvider(draft), state: STATE, edition: 'am', previous: { ...previous, ageMinutes: undefined }, now: new Date('2026-10-05T14:06:29Z') });
  assert.equal(ed.llm.used, true);
  assert.match(ed.changes, /^Versus ad hoc edition sitrep-20261005-adhoc-140429 \(generated 2026-10-05T14:04:29Z, 2 minutes before this edition\) \[previous\]\. IODA alert unchanged \[delta\]\.$/);
  assert.equal(ed.grounding.baselineFixed, true);
  assert.ok(ed.citations.some(c => c.id === 'previous'));
  assert.match(ed.markdown, /model called this edition a baseline despite a previous edition/);
  const okDraft = JSON.stringify({ ...JSON.parse(GOOD), changes: 'Versus ad hoc edition sitrep-20261005-adhoc-140429: IODA alert unchanged [previous][delta].' });
  const ok = await generateSitrep({ provider: fakeProvider(okDraft), state: STATE, edition: 'am', previous, now: new Date('2026-10-05T14:06:29Z') });
  assert.equal(ok.grounding.baselineFixed, undefined);
  assert.doesNotMatch(ok.markdown, /called this edition a baseline/);
});

test('same-figure trend claims: flagged when the previous edition already reported the figure; previous context carries activity + changes', async () => {
  const prevText = 'Venezuela outages at 28% of networks [outages]. 510 aircraft in the box [caribbeanair]. CII 61/100 [aor].';
  const r = flagUnsupportedChanges('Venezuela outages increased from previous levels to 28% outages, marking a worsening condition [outages]. Aircraft rose from 480 to 510 [caribbeanair]. CII unchanged at 61/100 [aor]. New IODA alert [delta]. Detentions climbed to 12 [venezuela].', prevText);
  assert.equal(r.flagged, 1);
  assert.match(r.text, /marking a worsening condition \[SAME FIGURE AS PREVIOUS\]\[outages\]\. Aircraft rose from 480 to 510 \[caribbeanair\]\. CII unchanged at 61\/100 \[aor\]\. New IODA alert \[delta\]\. Detentions climbed to 12 \[venezuela\]\.$/);
  assert.deepEqual(flagUnsupportedChanges('x increased to 28% [a].', ''), { text: 'x increased to 28% [a].', flagged: 0 });
  assert.equal(flagUnsupportedChanges('Outages at 28% [a].', prevText).flagged, 0, 'no trend word → no flag');
  assert.equal(flagUnsupportedChanges('Outages increased to 2,800 users [a].', 'previous saw 2800 users').flagged, 1, 'comma-normalised match');
  assert.equal(flagUnsupportedChanges('Versus AM edition sitrep-20261005-am (generated 2026-10-05T10:00:00Z, 4 minutes before): outages rose to 28% [a].', prevText).flagged, 1, 'edition ids, timestamps and minutes-ago are not figures');

  const previous = { id: 'sitrep-20261005-am', edition: 'am', generatedAt: '2026-10-05T10:00:00Z', bluf: 'Prior BLUF [situation].', activity: [{ domain: 'Cyber & information', text: 'Venezuela outages at 28% of networks [outages].' }], changes: 'Baseline [delta].', watch: ['w1 [delta]'], assessment: 'prior [situation]' };
  const pack = buildSitrepPack(STATE, { previous });
  assert.match(pack.sections.find(s => s.id === 'previous').text, /activity — Cyber & information: Venezuela outages at 28% of networks \[outages\]\.\nchanges: Baseline \[delta\]\./);
  const p = draftSystemPrompt(pack, { edition: 'pm' });
  assert.match(p, /quote BOTH figures: "from X \(previous edition\) to Y"/);
  const draft = JSON.stringify({ ...JSON.parse(GOOD), changes: 'Versus AM edition sitrep-20261005-am: Venezuela outages increased to 28%, a worsening condition [situation]. New IODA alert since the last sweep [delta].' });
  const ed = await generateSitrep({ provider: fakeProvider(draft), state: STATE, edition: 'pm', previous, now: new Date('2026-10-05T20:00:00Z') });
  assert.equal(ed.grounding.sameFigure, 1);
  assert.ok(ed.changes.endsWith(`a worsening condition ${SAME_FIGURE}[situation]. New IODA alert since the last sweep [delta].`), ed.changes);
  assert.match(ed.markdown, /1 change sentence\(s\) claim a trend on a figure the previous edition already reported — marked \[SAME FIGURE AS PREVIOUS\]/);
});

test('draftSystemPrompt carries the rules, the schema and the rendered pack', () => {
  const pack = buildSitrepPack(STATE);
  const p = draftSystemPrompt(pack, { edition: 'pm' });
  assert.match(p, /PM edition/); assert.match(p, /Mexico and the US-Mexico border .* are NORTHCOM/); assert.match(p, /EVERY sentence in EVERY field/); assert.match(p, /Never call the total "military aircraft"/); assert.match(p, /Only cite ids that appear in the context/);
  assert.match(p, /"bluf": string/); assert.match(p, /### \[venezuela\]/);
  for (const d of DOMAINS) assert.ok(p.includes(d));
});

test('parseDraft keeps only pack-backed citations, caps lists and normalises domains', () => {
  const pack = buildSitrepPack(STATE);
  const d = parseDraft(GOOD, pack);
  assert.ok(d);
  assert.doesNotMatch(d.bluf, /\[nosuch\]/, 'unknown citation struck');
  assert.match(d.bluf, /\[aor\]/);
  assert.match(d.bluf, /Fabricated claim \[UNCITED\]\./, 'sentence left without a citation is marked');
  assert.equal(d.grounding.uncited, 7, '1 bluf sentence + 6 bare watch items');
  assert.ok(d.grounding.sentences > 20);
  assert.equal(d.activity.length, MAX_ACTIVITY);
  assert.equal(d.activity[2].domain, 'Not a domain');
  assert.equal(d.watch.length, MAX_WATCH);
  const ids = d.citations.map(c => c.id).sort();
  for (const id of ['aor', 'venezuela', 'outages', 'colombia', 'caribbeanair', 'maritime', 'delta', 'telegram', 'sources']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('nosuch'));
  assert.ok(d.citations.every(c => c.tab && c.label));
  assert.equal(parseDraft('not json at all', pack), null);
  assert.equal(parseDraft('{"activity":[]}', pack), null);
  const fenced = parseDraft('```json\n' + GOOD + '\n```', pack);
  assert.equal(fenced.bluf, d.bluf);
});

test('rulesOnlySitrep is a structured data digest that cites the pack', () => {
  const pack = buildSitrepPack(STATE);
  const r = rulesOnlySitrep(pack);
  assert.match(r.bluf, /^Data SITREP \(no model configured/); assert.match(r.bluf, /\[situation\]/);
  assert.equal(r.activity.length, 5);
  assert.match(r.activity[1].text, /\[colombia\]/); assert.match(r.activity[2].text, /\[caribbeanair\]/);
  assert.match(r.changes, /^\[delta\]/);
  assert.match(r.assessment, /No model is configured/);
  assert.ok(r.citations.length === pack.sections.length);
  const empty = rulesOnlySitrep({ sections: [], omitted: [] });
  assert.match(empty.bluf, /No sweep data is loaded yet/);
  assert.match(empty.changes, /Baseline edition/);
  const noSit = rulesOnlySitrep({ sections: pack.sections.filter(s => s.id !== 'situation'), omitted: [] });
  assert.match(noSit.bluf, /Situation headline section unavailable/);
});

test('generateSitrep: model path, fallbacks, ids, Markdown and hash', async () => {
  const now = new Date('2026-10-05T10:05:00Z'); // 06:05 EDT
  const prov = fakeProvider(GOOD);
  const ed = await generateSitrep({ provider: prov, state: STATE, edition: 'am', now, slotKey: '2026-10-05-am', trigger: 'schedule' });
  assert.equal(ed.version, SITREP_VERSION);
  assert.equal(ed.id, 'sitrep-20261005-am'); assert.equal(ed.dateKey, '2026-10-05'); assert.equal(ed.slotKey, '2026-10-05-am'); assert.equal(ed.trigger, 'schedule');
  assert.deepEqual(ed.llm, { used: true, reason: null }); assert.equal(ed.model, 'fake-1'); assert.equal(ed.usage.outputTokens, 400);
  assert.equal(ed.previousId, null); assert.equal(ed.external, null); assert.equal(ed.banner, BANNER);
  assert.ok(ed.words > 50); assert.ok(ed.context.sections.includes('colombia'));
  assert.equal(prov.calls.length, 2, 'draft + citation repair pass (fixture draft has > 15 % uncited sentences)');
  assert.equal(prov.calls[0].opts.maxTokens, 1800); assert.match(prov.calls[0].user, /AM edition/);
  assert.match(prov.calls[1].system, /^You are fixing a Commander's SITREP draft/); assert.match(prov.calls[1].system, /\[venezuela\] /); assert.match(prov.calls[1].user, /^Draft to fix:\n\{/);
  assert.equal(ed.usage.inputTokens, 1000, 'repair that does not improve is discarded, usage not added');
  assert.equal(ed.grounding.repaired, undefined); assert.match(ed.markdown, /Grounding: \d+\/\d+ sentences cite a CRUCIX section; 7 marked \[UNCITED\]/);
  assert.equal(ed.sha256, sha256(ed.markdown));
  assert.match(ed.markdown, /^# COMMANDER'S SITREP — SOUTHCOM AOR \(OSINT\)\n\*\*AM edition\*\* · 05 OCT 2026 0605 EDT/);
  assert.match(ed.markdown, /## 1\. BLUF\n.*\[aor\]/); assert.match(ed.markdown, /- \*\*Maritime & air\.\*\* 212 aircraft/); assert.match(ed.markdown, /## 4\. Indicators & warnings/);
  assert.match(ed.markdown, /Generation: fake-1 · 1000 in \/ 400 out tokens/); assert.doesNotMatch(ed.markdown, /## 7\./, 'no external block without the review pass');

  const prev = ed;
  const ed2 = await generateSitrep({ provider: fakeProvider('garbage'), state: STATE, edition: 'pm', previous: prev, now: new Date('2026-10-05T20:00:00Z') });
  assert.equal(ed2.id, 'sitrep-20261005-pm'); assert.equal(ed2.previousId, 'sitrep-20261005-am');
  assert.deepEqual(ed2.llm, { used: false, reason: 'unparseable model response' }); assert.equal(ed2.model, 'fake-1');
  assert.match(ed2.bluf, /unparseable draft/); assert.ok(ed2.context.sections.includes('previous'));

  const ed3 = await generateSitrep({ provider: fakeProvider('', { fail: true }), state: STATE, edition: 'adhoc', now: new Date('2026-10-05T20:30:15Z') });
  assert.equal(ed3.id, 'sitrep-20261005-adhoc-163015'); assert.match(ed3.llm.reason, /^provider error: boom 503/); assert.match(ed3.markdown, /rules-only \(provider error/);

  const ed4 = await generateSitrep({ provider: null, state: STATE, edition: 'am', now });
  assert.deepEqual(ed4.llm, { used: false, reason: 'no model configured' }); assert.equal(ed4.model, null);
  assert.equal(editionId(now, 'adhoc', 'UTC'), 'sitrep-20261005-adhoc-100500');
  await assert.rejects(generateSitrep({ provider: null, state: STATE, edition: 'weekly' }), /unknown edition/);
  const md = renderMarkdown({ ...ed, external: { label: 'EXTERNAL — UNVERIFIED', findings: [{ text: 'Outside item', url: 'https://example.com/a' }] } });
  assert.match(md, /## 7\. EXTERNAL — UNVERIFIED\n- Outside item \(https:\/\/example.com\/a\)/);
});

test('SitrepStore: save / list / latest / previous / verify / rebuild / cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sitrep-store-'));
  const store = new SitrepStore({ dir });
  assert.deepEqual(store.stats(), { editions: 0, byKind: {}, newest: null, oldest: null, max: MAX_EDITIONS });
  assert.equal(store.latest(), null); assert.equal(store.previous('2026-10-05T00:00:00Z'), null);
  const a = await generateSitrep({ provider: null, state: STATE, edition: 'am', now: new Date('2026-10-05T10:05:00Z'), slotKey: '2026-10-05-am' });
  const b = await generateSitrep({ provider: fakeProvider(GOOD), state: STATE, edition: 'pm', previous: a, now: new Date('2026-10-05T20:05:00Z'), slotKey: '2026-10-05-pm' });
  store.save(a); const sb = store.save(b);
  assert.equal(sb.llm, 'model'); assert.equal(sb.citations > 0, true); assert.ok(sb.bluf.length <= 280);
  assert.ok(store.hasSlot('2026-10-05-am') && store.hasSlot('2026-10-05-pm') && !store.hasSlot('2026-10-06-am'));
  assert.deepEqual(store.list().map(e => e.id), ['sitrep-20261005-pm', 'sitrep-20261005-am']);
  assert.deepEqual(store.list({ kind: 'am' }).map(e => e.id), ['sitrep-20261005-am']);
  assert.deepEqual(store.list({ before: '2026-10-05T15:00:00Z' }).map(e => e.id), ['sitrep-20261005-am']);
  assert.equal(store.latest().id, 'sitrep-20261005-pm');
  assert.equal(store.previous('2026-10-05T20:00:00Z').id, 'sitrep-20261005-am');
  assert.equal(store.previous('2026-10-06T00:00:00Z').id, 'sitrep-20261005-pm');
  assert.equal(store.get('sitrep-20261005-am').markdown, a.markdown);
  assert.equal(store.get('sitrep-20261005-xx'), null);
  assert.deepEqual(store.verify('sitrep-20261005-pm'), { id: 'sitrep-20261005-pm', stored: b.sha256, actual: b.sha256, ok: true });
  assert.throws(() => store.save({ id: '../x' }), /invalid edition id/);
  // Index rebuild from files when index.json is missing
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(dir, 'index.json'));
  const re = new SitrepStore({ dir });
  assert.deepEqual(re.list().map(e => e.id), ['sitrep-20261005-pm', 'sitrep-20261005-am']);
  assert.equal(re.stats().byKind.pm, 1);
  // Retention cap drops the oldest files
  for (let i = 0; i < MAX_EDITIONS + 3; i++) re.save({ ...a, id: `sitrep-2026${String(i).padStart(4, '0')}-am`, generatedAt: `2027-01-01T00:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}Z` });
  assert.equal(re.stats().editions, MAX_EDITIONS);
  assert.equal(readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').length, MAX_EDITIONS);
});

test('schedule: zoned times, due slots with catch-up window, next slot', () => {
  assert.ok(isValidTimeZone('America/New_York') && !isValidTimeZone('Mars/Olympus'));
  assert.deepEqual(parseTimes({ am: '25:00', pm: '15:30' }), { am: '06:00', pm: '15:30' });
  assert.equal(zonedTime('2026-10-05', '06:00').toISOString(), '2026-10-05T10:00:00.000Z', 'EDT');
  assert.equal(zonedTime('2026-12-05', '06:00').toISOString(), '2026-12-05T11:00:00.000Z', 'EST');
  assert.equal(zonedTime('2026-11-01', '06:00').toISOString(), '2026-11-01T11:00:00.000Z', 'DST ends 02:00 that morning');
  assert.equal(localDateKey(new Date('2026-10-05T03:30:00Z')), '2026-10-04');
  assert.deepEqual(localParts(new Date('2026-10-05T10:00:00Z'), 'UTC'), { y: 2026, m: 10, d: 5, hh: 10, mm: 0, ss: 0 });

  const none = new Set();
  assert.equal(dueEdition(new Date('2026-10-05T09:59:00Z'), { done: k => none.has(k) }), null, 'before 0600 ET nothing due');
  let d = dueEdition(new Date('2026-10-05T10:00:30Z'), { done: k => none.has(k) });
  assert.equal(d.edition, 'am'); assert.equal(d.slotKey, '2026-10-05-am');
  const done = new Set(['2026-10-05-am']);
  assert.equal(dueEdition(new Date('2026-10-05T12:00:00Z'), { done: k => done.has(k) }), null, 'already produced');
  d = dueEdition(new Date('2026-10-05T15:00:00Z'), { done: k => none.has(k) });
  assert.equal(d.edition, 'am', 'server came up late: AM still inside the catch-up window');
  assert.equal(dueEdition(new Date('2026-10-05T16:30:00Z'), { done: k => none.has(k) }), null, 'AM slot expired after catch-up; PM not yet due');
  d = dueEdition(new Date('2026-10-05T20:10:00Z'), { done: k => none.has(k) });
  assert.equal(d.edition, 'pm'); assert.equal(d.slotKey, '2026-10-05-pm');
  d = dueEdition(new Date('2026-10-06T01:30:00Z'), { done: k => none.has(k) });
  assert.equal(d && d.slotKey, '2026-10-05-pm', 'yesterday (local) PM still catches up across UTC midnight');
  assert.equal(CATCH_UP_MS, 6 * 3600_000);

  const n = nextSlot(new Date('2026-10-05T12:00:00Z'));
  assert.equal(n.edition, 'pm'); assert.equal(n.at.toISOString(), '2026-10-05T20:00:00.000Z');
  const n2 = nextSlot(new Date('2026-10-05T21:00:00Z'));
  assert.equal(n2.slotKey, '2026-10-06-am'); assert.equal(n2.at.toISOString(), '2026-10-06T10:00:00.000Z');
  const utc = nextSlot(new Date('2026-10-05T05:00:00Z'), { tz: 'UTC', times: { am: '05:30', pm: '17:00' } });
  assert.equal(utc.at.toISOString(), '2026-10-05T05:30:00.000Z');
});

test('annotateSentences: NORTHCOM tag for Mexico / border sentences, UNCITED marker, citations preserved', () => {
  const a = annotateSentences('Enforcement spiked in Ciudad Juárez [border]. Caracas blackout continues [venezuela][outages]. The commander should expect more.');
  assert.equal(a.text, 'Enforcement spiked in Ciudad Juárez (NORTHCOM context) [border]. Caracas blackout continues [venezuela][outages]. The commander should expect more [UNCITED].');
  assert.equal(a.uncited, 1); assert.equal(a.total, 3);
  const b = annotateSentences('CBP seizures rose (NORTHCOM context) [cbp].');
  assert.equal(b.text, 'CBP seizures rose (NORTHCOM context) [cbp].', 'already tagged → unchanged');
  assert.equal(annotateSentences('Flows via Sinaloa [narco]').text, 'Flows via Sinaloa (NORTHCOM context) [narco].');
  assert.deepEqual(annotateSentences(''), { text: '', uncited: 0, total: 0 });
  assert.equal(UNCITED, '[UNCITED]'); assert.equal(REPAIR_THRESHOLD, 0.15);
});

test('generateSitrep: repair pass replaces the draft when it reduces uncited sentences and adds its tokens', async () => {
  const bad = JSON.stringify({ bluf: 'Venezuela is unstable. Colombia saw an attack. Caribbean traffic rose.', activity: [], changes: 'Baseline.', watch: [], assessment: 'Likely worse.', integrity: 'Thin.' });
  const fixed = JSON.stringify({ bluf: 'Venezuela is unstable [aor]. Colombia saw an attack [colombia]. Caribbean traffic rose [caribbeanair].', activity: [], changes: 'Baseline [delta].', watch: [], assessment: 'Likely worse [aor].', integrity: 'Thin [sources].' });
  let n = 0;
  const prov = { isConfigured: true, name: 'fake', calls: [], async complete(sys, user, opts) { this.calls.push(sys); n++; return { text: n === 1 ? bad : fixed, model: 'fake-1', usage: { inputTokens: 100, outputTokens: 50 } }; } };
  const ed = await generateSitrep({ provider: prov, state: STATE, edition: 'adhoc', now: new Date('2026-10-05T12:00:00Z') });
  assert.equal(prov.calls.length, 2);
  assert.deepEqual(ed.grounding, { sentences: 6, uncited: 0, repaired: true, before: 6 });
  assert.deepEqual(ed.usage, { inputTokens: 200, outputTokens: 100 });
  assert.match(ed.bluf, /^Venezuela is unstable \[aor\]\./); assert.doesNotMatch(ed.markdown, /UNCITED/);
  assert.match(ed.markdown, /citation repair pass applied \(6 → 0 uncited\)/);
  assert.match(repairSystemPrompt(buildSitrepPack(STATE)), /\[colombia\] Colombia/);
  // repair call failing keeps the marked first draft
  let m = 0;
  const prov2 = { isConfigured: true, name: 'fake', async complete() { m++; if (m === 2) throw new Error('timeout'); return { text: bad, model: 'fake-1', usage: { inputTokens: 100, outputTokens: 50 } }; } };
  const ed2 = await generateSitrep({ provider: prov2, state: STATE, edition: 'adhoc', now: new Date('2026-10-05T12:00:00Z') });
  assert.equal(m, 2); assert.equal(ed2.llm.used, true); assert.equal(ed2.grounding.uncited, 6); assert.match(ed2.bluf, /Venezuela is unstable \[UNCITED\]\./);
});
