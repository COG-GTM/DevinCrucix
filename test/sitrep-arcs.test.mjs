// lib/sitrep/arcs + arc scheduling + SitrepStore.range — weekly / monthly narrative arcs written from the archive only.
// Fake providers and a temp archive; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SitrepStore, sha256 } from '../lib/sitrep/store.mjs';
import { generateSitrep } from '../lib/sitrep/index.mjs';
import { arcTime, arcKindsForDate, dueArc, nextArc, ARC_CATCH_UP_MS } from '../lib/sitrep/schedule.mjs';
import {
  ARC_KINDS, ARC_VERSION, MIN_SOURCES, MAX_ARC_ITEMS, TRAJECTORIES, arcId, arcWindow, selectSources, computeStats, buildArcPack, renderStats,
  arcSystemPrompt, parseArc, rulesOnlyArc, renderArcMarkdown, generateArc,
} from '../lib/sitrep/arcs.mjs';

const TZ = 'America/New_York';
const NOW = new Date('2026-10-05T10:30:00.000Z'); // Monday 06:30 EDT
const STATE = { lastSweepTime: '2026-10-05T10:00:00Z', data: { situation: { asOf: '2026-10-05T10:02:00Z', headlines: [{ severity: 'high', title: 'Caracas blackout', why: 'IODA', source: 'IODA', tab: 'cyber' }] } } };

// Rules-only dailies at `hoursAgo`, with scheduled slot keys so missed-slot detection has something to chew on.
async function seed(store, specs) {
  const out = [];
  for (const sp of specs) {
    const now = new Date(NOW.getTime() - sp.hoursAgo * 3600_000);
    const ed = await generateSitrep({ provider: null, state: STATE, edition: sp.edition || 'am', now, tz: TZ, slotKey: sp.slotKey || null });
    if (sp.bluf) ed.bluf = sp.bluf;
    if (sp.watch) ed.watch = sp.watch;
    if (sp.external) ed.external = sp.external;
    if (sp.llm) { ed.llm = sp.llm; ed.grounding = sp.grounding || { sentences: 10, uncited: 1 }; }
    store.save(ed); out.push(ed);
  }
  return out;
}
const tmpStore = () => new SitrepStore({ dir: mkdtempSync(join(tmpdir(), 'sitrep-arcs-')) });

test('arc schedule: 30 min after the AM edition, Mondays weekly, 1st monthly, catch-up window, no duplicates', () => {
  assert.equal(arcTime({ am: '06:00', pm: '16:00' }), '06:30');
  assert.equal(arcTime({ am: '23:45', pm: '16:00' }), '00:15');
  assert.deepEqual(arcKindsForDate('2026-10-05', TZ), ['weekly']);     // Monday
  assert.deepEqual(arcKindsForDate('2026-10-06', TZ), []);
  assert.deepEqual(arcKindsForDate('2026-11-01', TZ), ['monthly']);    // Sunday the 1st
  assert.deepEqual(arcKindsForDate('2026-06-01', TZ), ['weekly', 'monthly']); // Monday the 1st
  const due = dueArc(new Date('2026-10-05T10:31:00Z'), { tz: TZ });
  assert.equal(due.kind, 'weekly'); assert.equal(due.dateKey, '2026-10-05'); assert.match(due.slotKey, /2026-10-05.*weekly/); assert.equal(due.at.toISOString(), '2026-10-05T10:30:00.000Z');
  assert.equal(dueArc(new Date('2026-10-05T10:29:00Z'), { tz: TZ }), null, 'not yet');
  assert.equal(dueArc(new Date('2026-10-05T10:31:00Z'), { tz: TZ, done: (k) => k === due.slotKey }), null, 'already written');
  assert.equal(dueArc(new Date(due.at.getTime() + ARC_CATCH_UP_MS + 60_000), { tz: TZ }), null, 'outside the catch-up window');
  assert.equal(dueArc(new Date(due.at.getTime() + ARC_CATCH_UP_MS - 60_000), { tz: TZ })?.kind, 'weekly', 'inside the catch-up window');
  assert.equal(dueArc(new Date('2026-10-06T12:00:00Z'), { tz: TZ }), null, 'Tuesday, nothing due');
  // Monday the 1st: both are due; monthly wins the tie, weekly follows once monthly is done.
  const both = new Date('2026-06-01T10:31:00Z');
  assert.equal(dueArc(both, { tz: TZ }).kind, 'monthly');
  assert.equal(dueArc(both, { tz: TZ, done: (k) => /monthly/.test(k) }).kind, 'weekly');
  const nx = nextArc(new Date('2026-10-05T10:31:00Z'), { tz: TZ });
  assert.equal(nx.weekly.at.toISOString(), '2026-10-12T10:30:00.000Z'); assert.equal(nx.monthly.dateKey, '2026-11-01');
  assert.equal(nx.monthly.at.toISOString(), '2026-11-01T11:30:00.000Z'); // EST after DST ends 01 Nov 2026
});

test('arcWindow / arcId / SitrepStore.range', async () => {
  const w = arcWindow('weekly', NOW, TZ);
  assert.equal(w.days, 7); assert.equal(w.startKey, '2026-09-28'); assert.equal(w.endKey, '2026-10-05'); assert.equal(w.end, NOW.toISOString());
  assert.equal(arcWindow('monthly', NOW, TZ).days, 30);
  assert.equal(arcId(NOW, 'weekly', TZ, true), 'sitrep-20261005-weekly');
  assert.equal(arcId(NOW, 'monthly', TZ, false), 'sitrep-20261005-monthly-063000');
  const store = tmpStore();
  await seed(store, [{ hoursAgo: 10 * 24 }, { hoursAgo: 3 * 24, edition: 'pm' }, { hoursAgo: 2 }]);
  const r = store.range({ sinceIso: w.start, untilIso: w.end });
  assert.equal(r.length, 2, 'the 10-day-old edition is outside the weekly window');
  assert.ok(r[0].generatedAt < r[1].generatedAt, 'oldest → newest');
  assert.equal(store.range({ sinceIso: arcWindow('monthly', NOW, TZ).start }).length, 3);
  assert.equal(store.range({ sinceIso: w.start, kinds: ['weekly'] }).length, 0);
  assert.equal(store.range({ sinceIso: w.start, limit: 1 }).length, 1);
});

test('selectSources / computeStats / buildArcPack: tokens, deterministic trend lines, shrink-then-drop under budget', async () => {
  const store = tmpStore();
  const dailies = await seed(store, [
    { hoursAgo: 6 * 24, edition: 'am', slotKey: '2026-09-29-am', bluf: 'Venezuela blackout widens; Colombia ELN truce holds [situation].', llm: { used: true, reason: null }, grounding: { sentences: 20, uncited: 2 } },
    { hoursAgo: 5 * 24, edition: 'pm', slotKey: '2026-09-30-pm', bluf: 'Venezuela blackout persists [situation].', external: { status: 'ok', findings: [{ kind: 'missing', text: 'x', url: 'https://a.example/x' }, { kind: 'contradicts', text: 'y', url: 'https://a.example/y' }] } },
    { hoursAgo: 2 * 24, edition: 'am', slotKey: '2026-10-03-am', bluf: 'Venezuela restoration begins; Colombia quiet [situation].' },
    { hoursAgo: 1, edition: 'adhoc' },
  ]);
  const w = arcWindow('weekly', NOW, TZ);
  const sel = selectSources(store, 'weekly', w);
  assert.equal(sel.dailies.length, 4); assert.deepEqual(sel.weeklies, []);
  const st = computeStats(sel.dailies, [], w, TZ);
  assert.equal(st.editions, 4); assert.deepEqual(st.byKind, { am: 2, pm: 1, adhoc: 1 }); assert.equal(st.model, 1); assert.equal(st.rulesOnly, 3);
  assert.equal(st.citedPct, 90); assert.equal(st.external.reviewed, 1); assert.equal(st.external.missing, 1); assert.equal(st.external.contradicts, 1);
  assert.ok(st.missedCount > 0 && st.missedSlots.includes('2026-10-01-am') && !st.missedSlots.includes('2026-09-29-am'), 'days fully inside the window without an AM/PM edition are missed slots');
  const ven = st.themes.find(t => t.term === 'Venezuela');
  assert.deepEqual({ ...ven }, { term: 'Venezuela', editions: 3, of: 4, first: 'd1', last: 'd3' });
  assert.equal(st.themes.find(t => t.term === 'Colombia').editions, 2);
  const lines = renderStats(st);
  assert.match(lines[0], /^4 source edition\(s\) in the window \(2 am, 1 pm, 1 adhoc\); 1 model-drafted, 3 rules-only\./);
  assert.match(lines.join('\n'), /Grounding across editions: 90% of 20 sentences/); assert.match(lines.join('\n'), /Venezuela 3\/4 \[d1→d3\]/);

  const pack = buildArcPack({ dailies: sel.dailies, weeklies: [], kind: 'weekly', window: w, tz: TZ });
  assert.deepEqual(pack.sources.map(s => s.token), ['d1', 'd2', 'd3', 'd4']);
  assert.equal(pack.sources[0].id, dailies[0].id); assert.equal(pack.sources[0].sha256, dailies[0].sha256); assert.equal(pack.sources[0].llm, 'model'); assert.equal(pack.sources[1].llm, 'rules');
  assert.match(pack.text, /### \[d1\] AM edition sitrep-20260929-am — 29 SEP 2026 0630 · model/);
  assert.match(pack.text, /EXTERNAL \(web search, UNVERIFIED\): missing: x \| contradicts: y/);
  assert.deepEqual(pack.omitted, []); assert.equal(pack.scale, 1);
  // Tiny budget: shrink first, then drop the OLDEST dailies but never below MIN_SOURCES.
  const small = buildArcPack({ dailies: sel.dailies, weeklies: [], kind: 'weekly', window: w, tz: TZ, maxChars: 600 });
  assert.ok(small.scale < 1); assert.equal(small.sources.length, MIN_SOURCES); assert.deepEqual(small.omitted, [dailies[0].id, dailies[1].id]);
  assert.deepEqual(small.sources.map(s => s.token), ['d3', 'd4'], 'tokens stay stable so citations keep meaning');
  // Monthly: weeklies come first as [w1]…
  const weekly = { id: 'sitrep-20260928-weekly', edition: 'weekly', generatedAt: new Date(NOW.getTime() - 7 * 86400_000).toISOString(), bluf: 'Last week [d1].', arc: [{ theme: 'Venezuela', trajectory: 'escalating', text: 'Blackout spread [d2][d5].' }], outlook: 'More [d5].', llm: { used: true }, sha256: 'abc' };
  store.save(weekly);
  const mw = arcWindow('monthly', NOW, TZ); const msel = selectSources(store, 'monthly', mw);
  assert.equal(msel.weeklies.length, 1);
  const mp = buildArcPack({ dailies: msel.dailies, weeklies: msel.weeklies, kind: 'monthly', window: mw, tz: TZ });
  assert.deepEqual(mp.sources.map(s => s.token), ['w1', 'd1', 'd2', 'd3', 'd4']);
  assert.match(mp.text, /### \[w1\] weekly arc sitrep-20260928-weekly[\s\S]*ARC escalating — Venezuela: Blackout spread\.\nOUTLOOK: More\./);
  assert.deepEqual(mp.stats.byKind, { weekly: 1, am: 2, pm: 1, adhoc: 1 });
});

test('arcSystemPrompt / parseArc / rulesOnlyArc: every sentence cites a token, unknown tokens stripped, trajectories bounded', async () => {
  const store = tmpStore();
  await seed(store, [{ hoursAgo: 48, bluf: 'Venezuela a [situation].' }, { hoursAgo: 24, bluf: 'Venezuela b [situation].' }, { hoursAgo: 1, bluf: 'Venezuela c [situation].' }]);
  const w = arcWindow('weekly', NOW, TZ); const sel = selectSources(store, 'weekly', w);
  const pack = buildArcPack({ dailies: sel.dailies, weeklies: [], kind: 'weekly', window: w, tz: TZ });
  const p = arcSystemPrompt(pack);
  assert.match(p, /Weekly arc of the Commander's SITREP/); assert.match(p, /ONLY material is the archived SITREP editions/); assert.match(p, /\(NORTHCOM context\)/);
  assert.match(p, /CRUCIX-COMPUTED TREND LINES \(deterministic, cite as \[stats\]\)/); assert.match(p, /ARCHIVED EDITIONS \(3\)/); assert.match(p, /### \[d3\]/);
  assert.match(p, new RegExp(JSON.stringify(TRAJECTORIES).replace(/[[\]"]/g, '\\$&')));
  const draft = JSON.stringify({
    bluf: 'Blackout dominated the week [d1][d3]. Fabricated claim without citation. Juárez traffic shifted [d2].',
    arc: [
      { theme: 'Venezuela power', trajectory: 'escalating', text: 'Spread over three editions [d1][d2][d3]. Trend lines agree [stats].' },
      { theme: 'Bad token', trajectory: 'exploding', text: 'Cited a token that does not exist [d9][d2].' },
      ...Array.from({ length: 8 }, (_, i) => ({ theme: `T${i}`, trajectory: 'steady', text: `Filler ${i} [d1].` })),
    ],
    fizzled: 'Colombia truce watch did not develop [d1].', outlook: 'Likely continued outages; confidence moderate [d3][stats].', integrity: 'Two of three editions were rules-only [stats].',
  });
  const r = parseArc(draft, pack);
  assert.equal(r.bluf, 'Blackout dominated the week [d1][d3]. Fabricated claim without citation [UNCITED]. Juárez traffic shifted [d2].');
  assert.equal(r.arc.length, MAX_ARC_ITEMS);
  assert.deepEqual(r.arc[1], { theme: 'Bad token', trajectory: 'steady', text: 'Cited a token that does not exist [d2].' });
  assert.equal(r.grounding.uncited, 1);
  assert.equal(r.grounding.spanFlagged, 0);
  assert.match(r.integrity, /CRUCIX check: \d+ of \d+ model sentences cite an edition or the trend lines, 1 marked \[UNCITED\]; editions span 47 h \[stats\]\.$/);
  assert.match(p, /editions span only 47 h/);
  const ids = r.citations.map(c => c.id).sort();
  assert.deepEqual(ids, ['d1', 'd2', 'd3', 'stats']);
  assert.equal(r.citations.find(c => c.id === 'd2').editionId, pack.sources[1].id);
  assert.equal(r.citations.find(c => c.id === 'stats').editionId, null);
  assert.equal(parseArc('not json', pack), null); assert.equal(parseArc(JSON.stringify({ arc: [] }), pack), null);
  const ro = rulesOnlyArc(pack, 'no model configured');
  assert.match(ro.bluf, /^Data arc for the week \(no model configured; no model narrative\)\. 3 source edition\(s\).*\[stats\] Editions run from sitrep-\S+ to sitrep-\S+ \[d1\]\[d3\]\.$/);
  assert.ok(ro.arc.every(a => a.trajectory === 'steady' && /\[stats\]/.test(a.text)));
  assert.equal(ro.arc[0].theme, 'Venezuela');
  assert.ok(ro.citations.some(c => c.id === 'stats') && ro.citations.some(c => c.id === 'd1'));
});

test('generateArc: too few editions, rules-only, model path, provider failure, unparseable; Markdown + SHA-256; ids', async () => {
  const store = tmpStore();
  await seed(store, [{ hoursAgo: 1 }]);
  await assert.rejects(generateArc({ provider: null, store, kind: 'weekly', now: NOW, tz: TZ }), (e) => e.code === 'TOO_FEW' && /need at least 2 archived editions in the last 7 days \(have 1\)/.test(e.message));
  await assert.rejects(generateArc({ provider: null, store, kind: 'yearly', now: NOW, tz: TZ }), /unknown arc kind/);
  await seed(store, [{ hoursAgo: 30, edition: 'pm', bluf: 'Venezuela x [situation].' }, { hoursAgo: 20, bluf: 'Venezuela y [situation].' }]);

  const ro = await generateArc({ provider: null, store, kind: 'weekly', now: NOW, tz: TZ, slotKey: '2026-10-05-weekly', trigger: 'schedule' });
  assert.equal(ro.version, ARC_VERSION); assert.equal(ro.id, 'sitrep-20261005-weekly'); assert.equal(ro.edition, 'weekly'); assert.equal(ro.slotKey, '2026-10-05-weekly'); assert.equal(ro.trigger, 'schedule');
  assert.deepEqual(ro.llm, { used: false, reason: 'no model configured' }); assert.equal(ro.sources.length, 3); assert.equal(ro.context.editions, 3);
  assert.equal(ro.trend.length >= 4, true); assert.equal(ro.sha256, sha256(ro.markdown)); assert.ok(ro.words > 40);
  assert.match(ro.markdown, /^# SITREP WEEKLY ARC — SOUTHCOM AOR \(OSINT\)/); assert.match(ro.markdown, /## 4\. Trend lines \(CRUCIX-computed\) \[stats\]/); assert.match(ro.markdown, /Editions cited:\n- \[d1\] PM edition sitrep-/);
  assert.match(ro.markdown, /Generation: rules-only \(no model configured\)/);
  store.save(ro);
  assert.equal(store.latest().edition, 'am', 'latest() stays daily-only by default');
  assert.equal(store.latest({ kinds: ['weekly'] }).id, ro.id);

  const good = JSON.stringify({ bluf: 'The week in brief [d1][d3].', arc: [{ theme: 'Venezuela', trajectory: 'steady', text: 'Held [d1][d2][d3].' }], fizzled: 'Nothing fizzled [stats].', outlook: 'Steady; confidence low [stats].', integrity: 'All rules-only editions [stats].' });
  const calls = [];
  const provider = (text, fail) => ({ isConfigured: true, name: 'fake', model: 'fake-1', async complete(sys, user, opts) { calls.push({ sys, user, opts }); if (fail) throw new Error('boom 503'); return { text, model: 'fake-1', usage: { inputTokens: 3000, outputTokens: 500 } }; } });
  const md = await generateArc({ provider: provider(good), store, kind: 'weekly', now: NOW, tz: TZ });
  assert.equal(md.id, 'sitrep-20261005-weekly-063000'); assert.deepEqual(md.llm, { used: true, reason: null }); assert.equal(md.model, 'fake-1'); assert.equal(md.usage.outputTokens, 500);
  assert.equal(md.bluf, 'The week in brief [d1][d3].'); assert.deepEqual(md.grounding, { sentences: 5, uncited: 0, spanFlagged: 0, trajectoryFlagged: 0 });
  assert.equal(calls[0].opts.maxTokens, 2200); assert.match(calls[0].user, /Write the Weekly arc now\./); assert.match(calls[0].sys, /ARCHIVED EDITIONS \(3\)/);
  assert.match(md.markdown, /Grounding: 5\/5 sentences cite an archived edition or the trend lines/); assert.match(md.markdown, /Generation: fake-1 · 3000 in \/ 500 out tokens/);
  assert.equal(md.sha256, sha256(md.markdown));
  const fail = await generateArc({ provider: provider(good, true), store, kind: 'weekly', now: NOW, tz: TZ });
  assert.equal(fail.llm.used, false); assert.match(fail.llm.reason, /^provider error: boom 503/); assert.match(fail.bluf, /^Data arc for the week \(provider error;/);
  const junk = await generateArc({ provider: provider('nope'), store, kind: 'weekly', now: NOW, tz: TZ });
  assert.deepEqual(junk.llm, { used: false, reason: 'unparseable model response' }); assert.equal(junk.model, 'fake-1');

  // Monthly: reads the stored weekly as [w1] plus the dailies.
  const mo = await generateArc({ provider: null, store, kind: 'monthly', now: new Date(NOW.getTime() + 60_000), tz: TZ });
  assert.equal(mo.edition, 'monthly'); assert.deepEqual(mo.sources.map(s => s.token), ['w1', 'd1', 'd2', 'd3']); assert.equal(mo.window.days, 30);
  assert.match(mo.markdown, /\[w1\] weekly arc sitrep-20261005-weekly/);
  assert.deepEqual(ARC_KINDS, ['weekly', 'monthly']);
});


test('parseArc guards: period-wide claims over a sub-day span, "emerged" themes already in the first edition', async () => {
  const store = tmpStore();
  await seed(store, [{ hoursAgo: 0.1, bluf: 'PRC-linked vessel activity near Venezuela [situation]. DEFCON composite 50 [defcon].' }, { hoursAgo: 0.05, edition: 'pm', bluf: 'PRC-linked vessel activity continues [situation].' }]);
  const w = arcWindow('weekly', NOW, TZ); const sel = selectSources(store, 'weekly', w);
  const pack = buildArcPack({ dailies: sel.dailies, weeklies: [], kind: 'weekly', window: w, tz: TZ });
  assert.ok(pack.stats.spanHours < 1); assert.equal(pack.first.token, 'd1'); assert.match(pack.first.text, /prc-linked/);
  assert.match(arcSystemPrompt(pack), /span only \d+ min/);
  assert.match(renderStats(pack.stats)[1], /Source editions span \d+ min of the 7-day window/);
  const r = parseArc(JSON.stringify({
    bluf: 'DEFCON composite held at 50 throughout the week [d1][d2]. Two editions on file [stats].',
    arc: [
      { theme: 'PRC-linked vessel activity', trajectory: 'emerged', text: 'Reported in both editions [d1][d2].' },
      { theme: 'Caribbean cyber outage', trajectory: 'emerged', text: 'First appears in the second edition [d2].' },
    ],
    fizzled: 'Nothing was flagged early enough to fizzle [d1].', outlook: 'Assessment: steady; confidence low because the editions are minutes apart [stats].', integrity: 'There are no uncited claims [stats].',
  }), pack);
  assert.equal(r.bluf, 'DEFCON composite held at 50 throughout the week [BEYOND EDITION SPAN][d1][d2]. Two editions on file [stats].');
  assert.equal(r.grounding.spanFlagged, 1);
  assert.equal(r.arc[0].text, 'Reported in both editions [d1][d2]. [ALREADY IN d1]');
  assert.equal(r.arc[1].text, 'First appears in the second edition [d2].');
  assert.equal(r.grounding.trajectoryFlagged, 1);
  assert.match(r.integrity, /^There are no uncited claims \[stats\]\. CRUCIX check: 7 of 7 model sentences cite an edition or the trend lines, 0 marked \[UNCITED\], 1 marked \[BEYOND EDITION SPAN\], 1 "emerged" theme\(s\) already present in d1; editions span \d+ min \[stats\]\.$/);
  const ro = rulesOnlyArc(pack);
  assert.match(ro.integrity, /Source editions span \d+ min/);
});
