// Dossier export — Markdown, every claim footnoted with its source URL and analyst state.
import { RELATIONS } from '../cjng/graph.mjs';
import { SOURCES } from './find.mjs';

const md = s => String(s ?? '').replace(/[\\`*_{}[\]<>|]/g, m => '\\' + m).replace(/\s+/g, ' ').trim();
const link = (url, label) => url && /^https?:\/\//.test(url) ? `[${md(label || url)}](${url})` : md(label || '');
const pct = n => `${Math.round((n || 0) * 100)}%`;

export function renderDossier(target, { now = Date.now() } = {}) {
  const p = target.package;
  const L = [];
  L.push(`# Target development package — ${md(target.label)}`);
  L.push('');
  L.push(`CRUCIX · Cognition AI · generated ${new Date(now).toISOString()} · package ${p ? p.computedAt : 'not developed'}`);
  L.push('');
  L.push('> Public-source targeting record. Every statement below is attributed to a published source and carries its analyst state: **reported** (as the source says), **proposed** (correlation by rules/model, awaiting review), **accepted** or **rejected** (analyst decision). Nothing here is verified ground truth.');
  L.push('');
  L.push('## 1. Nomination');
  L.push(`| Field | Value |`);
  L.push(`|---|---|`);
  L.push(`| Target | ${md(target.label)} (${md(target.type)}) |`);
  L.push(`| Aliases on record | ${target.aliases?.length ? target.aliases.map(md).join(', ') : '—'} |`);
  L.push(`| Basis | ${md(target.basis.kind)} · ${target.basis.kind === 'source-url' ? link(target.basis.ref, target.basis.ref) : md(target.basis.ref)} |`);
  L.push(`| Requirement | ${md(target.requirement)} |`);
  L.push(`| Priority | P${target.priority} |`);
  L.push(`| Nominated | ${target.createdAt} · ${md(target.nominatedBy)} |`);
  L.push(`| Status | ${md(target.status)} |`);
  L.push('');
  if (!p) { L.push('_Package not yet developed._'); return L.join('\n'); }

  const s = p.stats;
  L.push('## 2. Coverage');
  L.push(`${s.mentions} verbatim mentions across ${s.documents} documents · ${s.selectors} published selectors · ${s.candidates} correlation candidates · ${s.observations} place-time observations · span ${s.span.first || '—'} → ${s.span.last || '—'}.`);
  L.push('');
  L.push('| Source | Tier | Scanned | Hits |');
  L.push('|---|---|---|---|');
  for (const [k, c] of Object.entries(p.coverage || {})) L.push(`| ${md(SOURCES[k]?.label || k)} | ${md(SOURCES[k]?.tier || '')} | ${c.available ? (c.scanned ?? (c.anchors ? c.anchors.length + ' anchor(s)' : '—')) : 'not loaded'} | ${c.hits ?? c.matched ?? c.articles ?? 0} |`);
  L.push('');
  L.push(`Model adjudication: ${p.llm?.used ? `**${md(p.llm.model)}** assessed ${p.llm.assessed} candidates (${p.llm.rejected || 0} replies rejected by validation)` : `not used — ${md(p.llm?.reason || 'rules only')}`}. Model geolocation pass: ${p.llm?.fix?.used ? `${p.llm.fix.applied} sentence(s) disambiguated` : md(p.llm?.fix?.reason || 'not used')}.`);
  L.push('');

  L.push('## 3. Identity — personas and selectors');
  const personas = p.links.filter(l => l.kind === 'persona');
  if (personas.length) {
    L.push('| Persona | State | Confidence | Basis | Evidence |');
    L.push('|---|---|---|---|---|');
    for (const l of personas) L.push(`| ${md(l.label)} | ${state(l)} | ${pct(l.assessment?.confidence)} | ${md(l.assessment?.rationale || l.rules?.reason)} | ${(l.evidence[0] ? `“${md(l.evidence[0].sentence).slice(0, 160)}” ${link(l.evidence[0].url, l.evidence[0].source)}` : '—')} |`);
  } else L.push('_No personas proposed._');
  L.push('');
  if (p.selectors.length) {
    L.push('| Selector | Kind | Source | Context |');
    L.push('|---|---|---|---|');
    for (const x of p.selectors) L.push(`| \`${md(x.value)}\` | ${md(x.kind)} | ${link(x.url, SOURCES[x.source]?.label || x.source)}${x.date ? ' · ' + x.date : ''} | ${md(x.evidence).slice(0, 160)} |`);
  } else L.push('_No published selectors found in the scanned documents._');
  L.push('');

  L.push('## 4. Network — associates and background');
  for (const role of ['associate', 'background']) {
    const rows = p.links.filter(l => l.kind !== 'persona' && (l.assessment?.role || l.rules?.role) === role);
    L.push(`### ${role === 'associate' ? 'Associates' : 'Background'} (${rows.length})`);
    if (!rows.length) { L.push('_None._'); L.push(''); continue; }
    L.push('| Entity | Relation | State | Confidence | Docs | Basis | Evidence |');
    L.push('|---|---|---|---|---|---|---|');
    for (const l of rows) {
      const rel = l.assessment?.relation || l.rules?.relation;
      L.push(`| ${md(l.label)} (${md(l.type)}) | ${md(RELATIONS[rel]?.label || rel || '—')} | ${state(l)} | ${pct(l.assessment?.confidence)} | ${l.docs} | ${md(l.assessment?.rationale || l.rules?.reason)} | ${(l.evidence[0] ? `“${md(l.evidence[0].sentence).slice(0, 160)}” ${link(l.evidence[0].url, l.evidence[0].source)}` : '—')} |`);
    }
    L.push('');
  }

  L.push('## 5. Location — last known and footprint');
  const lk = p.fix?.lastKnown;
  if (lk) {
    L.push(`**Last known (public record):** ${md(lk.place)} · ${lk.date} (${lk.ageDays} days ago) · ±${lk.radiusKm} km (${md(lk.precision)}) · confidence ${md(lk.confidence)} · basis: ${md(lk.basis)} presence.`);
    L.push(`> “${md(lk.sentence)}” — ${link(lk.url, SOURCES[lk.source]?.label || lk.source)}`);
    if (lk.caveat) L.push(`> Caveat: ${md(lk.caveat)}.`);
  } else L.push('_No dated sentence places the target anywhere in the scanned sources._');
  L.push('');
  if (p.fix?.footprint?.length) {
    L.push('| Place | Observations | Stated presence | First | Last |');
    L.push('|---|---|---|---|---|');
    for (const f of p.fix.footprint.slice(0, 15)) L.push(`| ${md(f.place)}${f.state && f.state !== f.place ? ', ' + md(f.state) : ''} | ${f.count} | ${f.stated} | ${f.first} | ${f.last} |`);
    L.push('');
  }
  L.push(`_${md(p.fix?.caveat)}_`);
  L.push('');

  L.push('## 6. Pattern of activity');
  const ag = p.pattern.aggregates, dv = p.pattern.deviations;
  L.push(`Reporting tempo, last 30 days: **${dv.observed}** dated mentions vs. own baseline ${dv.baselineMean}/month (z = ${dv.z}).`);
  if (dv.flags.length) for (const f of dv.flags) L.push(`- **${md(f.kind)}** — ${md(f.text)}${f.url ? ' ' + link(f.url, 'source') : ''}`);
  L.push('');
  if (ag.statuses.length) {
    L.push('### Status events (as reported)');
    for (const st of ag.statuses) L.push(`- ${st.date} · **${md(st.status)}** — “${md(st.sentence).slice(0, 200)}” ${link(st.url, SOURCES[st.source]?.label || st.source)}`);
    L.push('');
  }
  if (ag.byState.length) L.push(`States named with the target: ${ag.byState.map(x => `${md(x.state)} (${x.n})`).join(', ')}.`);
  if (ag.gaps.length) L.push(`Reporting gaps ≥ 3 months: ${ag.gaps.map(g => `${g.from} → ${g.to}`).join('; ')}.`);
  L.push('');
  L.push('### Timeline (most recent 40)');
  for (const e of p.pattern.timeline.slice(0, 40)) L.push(`- ${e.date} · ${md(SOURCES[e.source]?.label || e.source)}${e.place ? ' · ' + md(e.place) : ''}${e.status ? ' · **' + md(e.status) + '**' : ''} — “${md(e.sentence).slice(0, 220)}” ${link(e.url, 'source')}`);
  L.push('');

  L.push('## 7. Knowledge-graph proposals');
  const gps = target.graphProposals || [];
  if (!gps.length) L.push('_None._');
  else {
    L.push('| Proposal | Kind | State | Confidence | By |');
    L.push('|---|---|---|---|---|');
    for (const g of gps) L.push(`| ${md(g.label)} | ${md(g.kind)} | ${md(g.status)} | ${pct(g.confidence)} | ${md(g.by)}${g.model ? ' · ' + md(g.model) : ''} |`);
  }
  L.push('');
  L.push('---');
  L.push('Produced by CRUCIX Target Development (Cognition AI). Sources: US Department of Justice press releases, OFAC SDN list, InSight Crime, border/Mexico press feeds, public Telegram channel previews. Unverified-tier material is labelled and excluded from location.');
  return L.join('\n');
}

function state(l) {
  if (l.decision === 'accept') return 'accepted';
  if (l.decision === 'reject') return 'rejected';
  return l.relConfidence === 'typed' || l.relConfidence === 'ofac-aka' ? 'reported · proposed' : 'proposed';
}
