// /api/prcdel/* — Chinese Delegation Tracker (open-source headlines) + SYNTHETIC scenario overlay.
// The OSINT collection is cached (runs/prcdel-osint.json, 30 min TTL). The scenario file ships in
// config/synthetic/scenario.json; GUI edits are saved to runs/synthetic-scenario.json (persistent
// volume) and take precedence.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { TrackerCache, buildTracker, findConcurrent } from './tracker.mjs';
import { generateSynthetic, buildScenarioDelegations, buildScenarioEvents, pivot, DATASETS } from './synthetic.mjs';

const MAX_SCENARIO_BYTES = 64 * 1024;
const clampWindow = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(14, Math.round(n))) : null; };

export function validateScenario(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('scenario must be a JSON object');
  if (s.delegations != null && !Array.isArray(s.delegations)) throw new Error('delegations must be an array');
  if (s.events != null && !Array.isArray(s.events)) throw new Error('events must be an array');
  if ((s.delegations || []).length > 12) throw new Error('at most 12 scenario delegations');
  for (const d of s.delegations || []) {
    if (!d || typeof d.id !== 'string' || !/^[a-z0-9-]{2,40}$/i.test(d.id)) throw new Error('each delegation needs an id (letters, digits, dashes)');
    if (!Array.isArray(d.stops) || !d.stops.length || d.stops.length > 10) throw new Error(`${d.id}: 1–10 stops required`);
    for (const st of d.stops) if (!st || typeof st.city !== 'string') throw new Error(`${d.id}: every stop needs a city`);
  }
  if (s.coverage != null) for (const [k, v] of Object.entries(s.coverage)) if (!DATASETS.includes(k) || !(v >= 0 && v <= 1)) throw new Error(`coverage.${k} must be 0–1 for one of ${DATASETS.join(', ')}`);
  return s;
}

export function createPrcDelService({ root, runsDir, collect } = {}) {
  const defaultPath = join(root, 'config/synthetic/scenario.json');
  const overridePath = join(runsDir, 'synthetic-scenario.json');
  const cache = new TrackerCache({ path: join(runsDir, 'prcdel-osint.json'), curatedPath: join(root, 'config/prcdel/curated.json'), ...(collect ? { collect } : {}) });
  let memo = null;

  const scenario = () => {
    for (const p of [overridePath, defaultPath]) if (existsSync(p)) { try { return { scenario: JSON.parse(readFileSync(p, 'utf8')), custom: p === overridePath }; } catch {} }
    return { scenario: {}, custom: false };
  };

  async function payload({ windowDays, synthetic = true, force = false } = {}) {
    const raw = await cache.get({ force });
    const { scenario: sc, custom } = scenario();
    const win = windowDays ?? clampWindow(sc.windowDays) ?? 3;
    const key = `${raw?.generatedAt}|${win}|${synthetic}|${JSON.stringify(sc).length}|${custom}|${new Date().toISOString().slice(0, 10)}`;
    if (memo?.key === key) return memo.value;
    const live = buildTracker(raw || { stops: [], events: [] }, { windowDays: win });
    let syn = null; let delegations = live.delegations; let events = live.events;
    if (synthetic) {
      const synDelegations = buildScenarioDelegations(sc);
      const synEvents = buildScenarioEvents(sc, synDelegations);
      events = [...synEvents, ...live.events];
      delegations = [...synDelegations, ...live.delegations];
      findConcurrent(delegations, events, win);
      syn = generateSynthetic({ scenario: sc, delegations: live.delegations.slice(0, Number(sc.maxLiveDelegations ?? 10)), events, synDelegations, synEvents });
    }
    const overlaps = delegations.flatMap(d => d.stops.flatMap(s => s.concurrent || []));
    const value = { generatedAt: live.generatedAt, windowDays: win, days: live.days, disclaimer: live.disclaimer, errors: live.errors,
      delegations, events, overlaps, scenarioCustom: custom,
      counts: { delegations: delegations.length, osintDelegations: live.delegations.length, stops: delegations.reduce((n, d) => n + d.stops.length, 0), events: events.length, overlaps: overlaps.length },
      synthetic: syn };
    memo = { key, value };
    return value;
  }

  function register(app) {
    app.get('/api/prcdel', async (req, res) => {
      try {
        const windowDays = req.query.window != null ? clampWindow(req.query.window) : undefined;
        res.json(await payload({ windowDays: windowDays ?? undefined, synthetic: req.query.synthetic !== '0' }));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/prcdel/refresh', async (req, res) => {
      try { memo = null; const p = await payload({ force: true }); res.json({ ok: true, generatedAt: p.generatedAt, counts: p.counts }); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/prcdel/pivot', async (req, res) => {
      try {
        const p = await payload({ windowDays: req.query.window != null ? clampWindow(req.query.window) : undefined });
        const syn = p.synthetic;
        let seeds;
        if (req.query.person) {
          const person = syn.persons.find(x => x.id === req.query.person);
          if (!person) return res.status(404).json({ error: 'unknown person' });
          seeds = person.knownSelectors || [{ t: 'name', v: person.name }];
        } else if (req.query.t && req.query.v) {
          if (!/^(name|passport|phone|imsi|imei|email|address|plate|pnr|familyId|nationalId|rewards|visa)$/.test(req.query.t)) return res.status(400).json({ error: 'bad selector type' });
          seeds = [{ t: req.query.t, v: String(req.query.v).slice(0, 200) }];
        } else return res.status(400).json({ error: 'person or t+v required' });
        const hops = clampWindow(req.query.hops) ?? 3;
        res.json(pivot(syn, seeds, { maxHops: Math.min(hops, 4) }));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/prcdel/scenario', (req, res) => { const s = scenario(); res.json({ custom: s.custom, scenario: s.scenario }); });
    app.put('/api/prcdel/scenario', (req, res) => {
      try {
        if (JSON.stringify(req.body || {}).length > MAX_SCENARIO_BYTES) return res.status(413).json({ error: 'scenario too large' });
        const s = validateScenario(req.body);
        mkdirSync(runsDir, { recursive: true });
        writeFileSync(overridePath, JSON.stringify(s, null, 2));
        memo = null;
        res.json({ ok: true, custom: true });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/prcdel/scenario', (req, res) => { if (existsSync(overridePath)) rmSync(overridePath); memo = null; res.json({ ok: true, custom: false }); });
    app.get('/api/prcdel/export', async (req, res) => {
      try {
        const p = await payload({});
        res.set('Content-Disposition', `attachment; filename="crucix-synthetic-${new Date().toISOString().slice(0, 10)}.json"`);
        res.json({ notice: p.synthetic.notice, generatedAt: p.synthetic.generatedAt, seed: p.synthetic.seed, persons: p.synthetic.persons, datasets: p.synthetic.datasets, towers: p.synthetic.towers });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  return { register, payload, cache, warm: () => cache.get().catch(() => {}) };
}
