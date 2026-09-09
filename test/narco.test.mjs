// Narco event pipeline: gazetteer resolution, cartel/faction matching, rule-based extraction,
// normalization, event-level dedup, corroboration grades, LLM output validation and the
// relevance gates. Fixture text only, no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadGazetteer, findPlaces, resolveLocation, stateName, fold } from '../lib/narco/gazetteer.mjs';
import { loadGroups, findGroups, maskGroupNames, buildGroupIndex } from '../lib/narco/groups.mjs';
import {
  classifyEvent, extractCounts, extractSeizures, extractPeople, extractCitedSources, parseNumber, toDay,
  EVENT_TYPES, EVENT_TYPE_IDS, EVENT_TYPE_LABELS,
} from '../lib/narco/extract.mjs';
import { normalizeEvent, sameIncident, clusterEvents, gradeConfidence, sourceKind, typeFamily, CONFIDENCE, EVENT_SCHEMA, CLUSTER_SCHEMA } from '../lib/narco/events.mjs';
import { validateLLMOutput, mergeLLM, needsLLM, parseJSON, llmEnrichRecords } from '../lib/narco/llm.mjs';
import { isNarcoRelevant, isNarcoEvent, borderDocs, dojDocs } from '../lib/narco/pipeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gz = loadGazetteer();
const groups = loadGroups();

const CAR_BOMB = 'Three Captured after CJNG Car Bomb in Ojocaliente, Zacatecas\n\nGunmen from the Cártel de Jalisco Nueva Generación killed four police officers and wounded two in Ojocaliente, Zacatecas on Tuesday. Authorities arrested three suspects and seized 12 kilos of methamphetamine and 3 rifles. Luis Enrique Barragán Chávez, alias "El Toro", 34, was identified as the leader. Source: El Universal. According to Milenio, the attack began at dawn.';

function doc(over = {}) {
  return {
    id: over.id || 'd1', sourceId: over.sourceId || 'borderlandbeat', outlet: over.outlet || 'Borderland Beat',
    sourceType: over.sourceType || 'citizen-aggregator', url: over.url || 'https://example.org/a',
    title: over.title ?? 'Three Captured after CJNG Car Bomb in Ojocaliente, Zacatecas',
    text: over.text ?? CAR_BOMB, summary: null, rawHtml: null,
    publishedAt: over.publishedAt ?? '2026-09-04T10:00:00Z', collectedAt: '2026-09-04T11:00:00Z',
    wireSource: over.wireSource || null, syndicated: Boolean(over.syndicated), language: 'en',
    ...(over.location !== undefined ? { location: over.location } : {}),
  };
}

describe('gazetteer', () => {
  it('is generated from GeoNames with counts that match the payload (drift check)', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'config/mx-gazetteer.json'), 'utf8'));
    assert.equal(raw.counts.states, raw.states.length);
    assert.equal(raw.counts.municipalities, raw.municipalities.length);
    assert.equal(raw.counts.places, raw.places.length);
    assert.equal(raw.states.length, 32);
    assert.ok(raw.municipalities.length > 2400);
    assert.match(raw.source?.url || raw.source || '', /geonames/i);
  });

  it('resolves "Ojocaliente, Zacatecas" to the municipality, not Aguascalientes city', () => {
    const loc = resolveLocation(findPlaces(CAR_BOMB, gz), gz);
    assert.equal(loc.state, 'Zacatecas');
    assert.equal(loc.municipality, 'Ojocaliente');
    assert.equal(loc.precision, 'municipality');
    assert.ok(Math.abs(loc.lat - 22.58) < 0.1);
  });

  it('uses common aliases (Juárez → Ciudad Juárez, Lázaro Cárdenas → Michoacán port with state context)', () => {
    const a = resolveLocation(findPlaces('A tunnel ran from Juárez into El Paso. Juárez police responded.', gz), gz);
    assert.equal(a.city, 'Ciudad Juárez');
    assert.equal(a.state, 'Chihuahua');
    const b = resolveLocation(findPlaces('Cocaine moved through the port of Lázaro Cárdenas, Michoacán.', gz), gz);
    assert.equal(b.state, 'Michoacán');
    assert.equal(b.city, 'Ciudad Lázaro Cárdenas');
  });

  it('does not read "New Mexico" or "Mexico City" as Estado de México', () => {
    const f = findPlaces('Agents in New Mexico arrested two men; the cartel is based in Mexico City.', gz);
    assert.ok(!f.states.some(s => s.adm1 === '15'));
    assert.ok(f.states.some(s => s.adm1 === '09'), 'Mexico City resolves to CDMX');
  });

  it('rejects surnames and generic words as places unless a locative cue precedes them', () => {
    const f = findPlaces('Omar García Harfuch and Ricardo López met with Alvarado about the case.', gz);
    assert.deepEqual(f.municipalities.map(m => m.name), []);
    assert.deepEqual(f.places.map(p => p.name), []);
    const g = findPlaces('The bodies were found in García, Nuevo León.', gz);
    assert.ok(g.municipalities.some(m => m.name === 'García') || g.places.some(p => p.name === 'García'));
  });

  it('keeps "Sabinas Hidalgo" as one municipality instead of Sabinas plus the state of Hidalgo', () => {
    const f = findPlaces('Guns were recovered in Sabinas Hidalgo, Nuevo León.', gz);
    assert.ok(!f.states.some(s => s.shortName === 'Hidalgo'));
    assert.ok(f.municipalities.some(m => m.name === 'Sabinas Hidalgo'));
  });

  it('falls back to the state when the only city named sits in an unmentioned state', () => {
    const loc = resolveLocation(findPlaces('Cartels in Sinaloa and Jalisco shifted production; a lab in Córdoba, Colombia was raided.', gz), gz);
    assert.equal(loc.precision, 'state');
    assert.equal(loc.state, 'Sinaloa');
  });

  it('returns null for text with no Mexican place and maps adm1 codes back to names', () => {
    assert.equal(resolveLocation(findPlaces('The Senate passed a budget bill on Tuesday.', gz), gz), null);
    assert.equal(stateName('32', gz), 'Zacatecas');
    assert.equal(fold('Michoacán de Ocampo'), 'michoacan de ocampo');
  });
});

describe('cartel / faction groups', () => {
  it('config is internally consistent (parents exist, aliases unique, no alias equals a place name)', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'config/cartel-groups.json'), 'utf8'));
    assert.doesNotThrow(() => buildGroupIndex(raw));
    for (const [a] of groups.aliasKey) assert.ok(!gz.stateKey.has(a) && !gz.placeKey.has(a) && !gz.muniKey.has(a), `alias collides with place: ${a}`);
    assert.throws(() => buildGroupIndex({ groups: [{ id: 'x', parent: 'nope', aliases: ['zzz'] }] }), /unknown parent/);
    assert.throws(() => buildGroupIndex({ groups: [{ id: 'a', aliases: ['dup'] }, { id: 'b', aliases: ['dup'] }] }), /claimed by/);
  });

  it('matches whole phrases and infers the parent cartel from a faction', () => {
    const r = findGroups('Los Chapitos clashed with the Mayiza in Culiacán.', groups);
    assert.deepEqual(r.factions.map(f => f.id).sort(), ['sinaloa_chapitos', 'sinaloa_mayiza']);
    assert.equal(r.cartels[0].id, 'sinaloa');
    assert.equal(r.cartels[0].implied, true);
  });

  it('does not match bare over-broad tokens (cds, tda) or substrings', () => {
    const r = findGroups('The CDs were sold at the TDA meeting; la 25 is a bus route and the Sinaloan economy grew.', groups);
    assert.deepEqual(r.cartels, []);
    assert.deepEqual(r.factions, []);
  });

  it('naming a known leader implies the organization', () => {
    const r = findGroups('El Mencho remains at large.', groups);
    assert.ok(r.cartels.some(c => c.id === 'cjng'));
    assert.ok(r.leaders.some(l => l.groupId === 'cjng'));
  });

  it('maskGroupNames blanks group names so "Cártel de Sinaloa" is not a state mention', () => {
    const masked = maskGroupNames('The Cártel de Sinaloa operates in Sonora.', groups);
    assert.equal(masked.length, 'The Cártel de Sinaloa operates in Sonora.'.length);
    assert.ok(!/sinaloa/i.test(masked));
    assert.match(masked, /Sonora/);
  });
});

describe('rule-based extraction', () => {
  it('event taxonomy: labels cover every id exactly once', () => {
    assert.deepEqual(Object.keys(EVENT_TYPE_LABELS).sort(), [...EVENT_TYPE_IDS].sort());
    assert.equal(new Set(EVENT_TYPE_IDS).size, EVENT_TYPES.length);
  });

  it('classifies by headline first and promotes 5+ dead to massacre', () => {
    assert.equal(classifyEvent(CAR_BOMB, extractCounts(CAR_BOMB), 'Three Captured after CJNG Car Bomb').primary, 'arrest');
    assert.equal(classifyEvent('Police later arrested two men.', {}, 'Twelve Bodies Found in Clandestine Grave').primary, 'massacre');
    assert.equal(classifyEvent('Gunmen killed nine people at a wake.', { killed: 9 }).primary, 'massacre');
    assert.equal(classifyEvent('He pleaded guilty and was sentenced; agents arrested him last year.').primary, 'prosecution');
    assert.equal(classifyEvent('Smugglers moved fentanyl; agents seized 40 pounds.').primary, 'seizure');
    assert.equal(classifyEvent('Local elections were held.').primary, 'other');
  });

  it('does not read "bodies" in a non-violent sense as a homicide', () => {
    const toys = 'Toxic metals accumulate in children\u2019s bodies over time, the UTEP researchers said.';
    assert.equal(classifyEvent(toys).primary, 'other');
    assert.ok(!classifyEvent(toys).types.includes('homicide'));
    assert.ok(['massacre', 'homicide'].includes(classifyEvent('Three bodies were found in a ravine outside Culiac\u00e1n.').primary));
    assert.equal(classifyEvent('Two bodies were left on the roadside.').primary, 'homicide');
  });

  it('extracts casualty / arrest counts with word numbers and plausibility bounds', () => {
    assert.deepEqual(extractCounts(CAR_BOMB), { killed: 4, wounded: 2, arrested: 3 });
    assert.equal(parseNumber('a dozen'), 12);
    assert.equal(parseNumber('doce'), 12);
    const huge = extractCounts('Officials said 90000 people were killed in the operation.');
    assert.ok(huge.killed == null || huge.killed < 90000);
  });

  it('extracts seizures with unit conversion', () => {
    const s = extractSeizures('Agents seized 12 kilos of methamphetamine, 2,000 fentanyl pills and 3 rifles.');
    assert.equal(s.drugs.find(d => d.substance === 'methamphetamine').kg, 12);
    assert.ok(s.drugs.some(d => /fentanyl/.test(d.substance)));
    assert.equal(s.weapons, 3);
    const lb = extractSeizures('found 220 pounds of cocaine');
    assert.ok(Math.abs(lb.drugs[0].kg - 99.8) < 0.5);
  });

  it('does not report fees, payments or prices as cash seizures, nor money as weapon counts', () => {
    const fee = extractSeizures('Migrants paid a $30,000 smuggling fee to be moved through the tunnel; he received a $3,000 firearm payment from the organization.');
    assert.equal(fee.cash, undefined, `no seizure context: ${JSON.stringify(fee.cash)}`);
    assert.equal(fee.weapons, undefined, `"$3,000 firearm" is not 3,000 firearms: ${fee.weapons}`);
    const seized = extractSeizures('Agents seized $1.2 million in cash and 14 firearms from the stash house.');
    assert.deepEqual(seized.cash, [{ amount: 1_200_000, currency: 'USD' }]);
    assert.equal(seized.weapons, 14);
    const laundered = extractSeizures('The network laundered more than $5 million in drug proceeds through shell companies.');
    assert.deepEqual(laundered.cash, [{ amount: 5_000_000, currency: 'USD' }]);
    const valued = extractSeizures('More than 2.4 tons of methamphetamine and chemical precursors were seized, with an estimated value of $360 million.');
    assert.equal(valued.cash, undefined, `street value is not cash: ${JSON.stringify(valued.cash)}`);
    assert.equal(valued.drugs[0].kg, 2400);
    const stats = extractSeizures('U.S. units took down approximately 100 suspected cartel drones and 40 vehicles crossed the river. Mexico says 30,000 guns a year come from Texas. Cartels produce 2.4 tons of methamphetamine annually.');
    assert.deepEqual(stats, {}, `bare counts are statistics, not seizures: ${JSON.stringify(stats)}`);
    const cumulative = extractSeizures('Marines seized 210 firearms, 12 vehicles and 40 kilos of methamphetamine at the ranch. More than 30,000 firearms have been confiscated during President Sheinbaum\u2019s administration, and 200 tons of drugs have been seized since 2024; 1,500 vehicles were recovered nationwide so far this year.');
    assert.equal(cumulative.weapons, 210, `administration-wide total is not this seizure: ${JSON.stringify(cumulative)}`);
    assert.equal(cumulative.vehicles, 12);
    assert.deepEqual(cumulative.drugs.map(d => d.kg), [40]);
    const convoy = extractSeizures('Soldiers secured 6 armored vehicles and an arsenal of 14 rifles after the clash; the men were arrested with 3 kilos of cocaine.');
    assert.equal(convoy.vehicles, 6);
    assert.equal(convoy.weapons, 14);
    assert.equal(convoy.drugs[0].kg, 3);
    const grams = extractSeizures('Officers recovered 20 grams of fentanyl and 2 grams of methamphetamine.');
    assert.equal(grams.drugs.find(d => d.substance === 'fentanyl').kg, 0.02);
    assert.equal(grams.drugs.find(d => d.substance === 'methamphetamine').kg, 0.002);
  });

  it('extracts people with aliases and rejects institutions, headlines and bylines', () => {
    const p = extractPeople(CAR_BOMB);
    assert.deepEqual(p.people.map(x => x.name), ['Luis Enrique Barragán Chávez']);
    assert.deepEqual(p.nicknames, ['El Toro']);
    const bad = extractPeople('Car Bomb Destroys Police Headquarters. The Naval Academy and Grand Canyon National Park were cited. Homeland Security Task Force agents responded. By Sol Prendido for Borderland Beat.');
    assert.deepEqual(bad.people, []);
    const hy = extractPeople('Luis Carlos Davalos-Lopez, 41, pleaded guilty. Defendant Maria Del Rosario Navarro-Sanchez was also charged.');
    assert.ok(hy.people.some(x => x.name === 'Luis Carlos Davalos-Lopez'));
    assert.ok(hy.people.some(x => x.name === 'Maria Del Rosario Navarro-Sanchez'));
    assert.ok(!extractPeople('Ovidio Ovidio was there.').people.length);
  });

  it('captures cited original sources, including Spanish attribution forms, case-insensitively', () => {
    const c = extractCitedSources('Source: El Universal. According to Milenio, it began at dawn. De acuerdo con Proceso, hubo tres detenidos. Fuente: Reforma');
    const names = c.map(x => x.name);
    for (const n of ['El Universal', 'Milenio', 'Proceso', 'Reforma']) assert.ok(names.includes(n), n);
    assert.ok(c.every(x => ['explicit', 'attribution', 'link'].includes(x.kind)));
    assert.equal(toDay('2026-09-04T10:00:00Z'), '2026-09-04');
    assert.equal(toDay('garbage'), null);
  });
});

describe('normalized events', () => {
  it('builds a schema-versioned record with location, groups, people, counts, seizures and cited sources', () => {
    const rec = normalizeEvent(doc(), { gz, groups });
    assert.equal(rec.schema, EVENT_SCHEMA);
    assert.match(rec.id, /^ev_[0-9a-f]{20}$/);
    assert.equal(rec.sourceKind, 'aggregator');
    assert.equal(rec.eventDate, '2026-09-04');
    assert.equal(rec.eventType, 'arrest');
    assert.equal(rec.location.municipality, 'Ojocaliente');
    assert.deepEqual(rec.cartels.map(c => c.id), ['cjng']);
    assert.ok(!rec.placeMentions.states.includes('Jalisco'), 'group name must not count as a state mention');
    assert.equal(rec.people[0].name, 'Luis Enrique Barragán Chávez');
    assert.deepEqual(rec.counts, { killed: 4, wounded: 2, arrested: 3 });
    assert.equal(rec.seizures.weapons, 3);
    assert.equal(rec.citedSources.length, 2);
    assert.equal(rec.url, 'https://example.org/a');
    assert.equal(rec.extractor.method, 'rules');
  });

  it('does not geocode surname-like place names inside a person\u2019s name', () => {
    const text = 'A smuggling boat capsized off Imperial Beach. Prosecutors named Luis Humberto Mazariegos De Leon and Hector Gomez Lopez among the dead; the vessel had left from Mexico.';
    const rec = normalizeEvent(doc({ sourceType: 'news-outlet', title: 'Panga boat captain sentenced after deadly smuggling incident', text }), { gz, groups });
    assert.ok(rec.people.some(p => p.name === 'Luis Humberto Mazariegos De Leon'));
    assert.ok(!rec.placeMentions.places.some(p => /le[o\u00f3]n/i.test(p)), `Le\u00f3n must not be a place mention: ${rec.placeMentions.places}`);
    assert.notEqual(rec.location?.state, 'Guanajuato');
    const inLeon = normalizeEvent(doc({ sourceType: 'news-outlet', title: 'Gunmen kill four in Le\u00f3n', text: 'Four men were shot dead in Le\u00f3n, Guanajuato, on Friday.' }), { gz, groups });
    assert.equal(inLeon.location?.state, 'Guanajuato');
  });

  it('does not put an overseas incident in Sinaloa because the article names the cartels', () => {
    const text = 'Nigerian authorities dismantled three methamphetamine laboratories outside Lagos. UNODC says West Africa is now a production hub, with Nigeria, Kenya and South Africa feeding markets in Europe and Asia. Specifically, links were found between some of these laboratories and the Sinaloa and Jalisco New Generation cartels.';
    const found = findPlaces(maskGroupNames(text, groups), gz);
    assert.deepEqual(found.states, [], `no Mexican state should be found: ${JSON.stringify(found.states)}`);
    assert.ok(found.foreign >= 3);
    const rec = normalizeEvent(doc({ sourceType: 'citizen-aggregator', title: 'Africa: The Shifted Meth Route', text }), { gz, groups });
    assert.equal(rec.location, null);
    assert.ok(rec.cartels.some(c => /sinaloa/i.test(c.name)) && rec.cartels.some(c => /jalisco|cjng/i.test(c.name)));
    // A Mexican state named once inside an otherwise foreign article is not the scene either.
    const passing = resolveLocation(findPlaces('Police in Bogota, Colombia, said the cocaine had come from Colombia via Ecuador and was bound for Europe; one suspect had ties to Sinaloa.', gz), gz);
    assert.equal(passing, null);
    // An Ecuador sanctions piece that mentions a Mexican port once is not a Michoacán event.
    const abroad = resolveLocation(findPlaces('OFAC targeted an Ecuador-based cocaine network. Ecuador sits between Colombia and Peru; Ecuador\u2019s ports ship to Europe and Asia, and Ecuador\u2019s Los Choneros work with Mexican groups. Mexican forces also ran an operation in Michoac\u00e1n, home to the port of L\u00e1zaro C\u00e1rdenas.', gz), gz);
    assert.equal(abroad, null, JSON.stringify(abroad));
    // But a real Sinaloa event that mentions another country stays put.
    const real = resolveLocation(findPlaces('Gunmen killed five in Culiacan, Sinaloa; the victims were Colombian nationals.', gz), gz);
    assert.equal(real?.state, 'Sinaloa');
  });

  it('does not pin an event on the endpoints of a named highway', () => {
    const text = 'Agents detained the three individuals in Sabinas Hidalgo, in the border state of Nuevo Leon. The operation was carried out on the notorious Nuevo Laredo\u2013Monterrey highway and resulted in the seizure of 210 firearms.';
    const loc = resolveLocation(findPlaces(text, gz), gz);
    assert.equal(loc?.municipality, 'Sabinas Hidalgo', JSON.stringify(loc));
    assert.equal(loc?.state, 'Nuevo Le\u00f3n');
    const es = resolveLocation(findPlaces('Fue asegurado en la carretera Monterrey-Nuevo Laredo, a la altura de Ci\u00e9nega de Flores, Nuevo Le\u00f3n.', gz), gz);
    assert.equal(es?.municipality, 'Ci\u00e9nega de Flores', JSON.stringify(es));
    // A city that is the scene is still a city.
    assert.equal(resolveLocation(findPlaces('Three men were shot in Monterrey, Nuevo Leon, on Monday.', gz), gz)?.city, 'Monterrey');
  });

  it('bounds field sizes and keeps a pre-resolved location', () => {
    const rec = normalizeEvent(doc({ title: 'x'.repeat(1000), location: { country: 'US', precision: 'district', lat: 1, lon: 2, state: 'TX' } }), { gz, groups });
    assert.equal(rec.title.length, 300);
    assert.equal(rec.location.country, 'US');
    assert.equal(sourceKind('government'), 'official');
    assert.equal(sourceKind('news-outlet'), 'media');
    assert.equal(typeFamily('massacre'), 'violence');
    assert.equal(typeFamily('nonsense'), 'other');
  });
});

describe('dedup, clustering and corroboration', () => {
  const bb = normalizeEvent(doc(), { gz, groups });
  const media = normalizeEvent(doc({
    id: 'd2', sourceId: 'elpasomatters', outlet: 'El Paso Matters', sourceType: 'news-outlet', url: 'https://example.org/b',
    title: 'Four police killed in Ojocaliente car bombing; three arrested',
    text: 'Four police officers were killed when a car bomb exploded outside the municipal police headquarters in Ojocaliente, Zacatecas. Three suspects were arrested. Luis Enrique Barragán Chávez was named as the leader.',
    publishedAt: '2026-09-05T02:00:00Z',
  }), { gz, groups });
  const gov = normalizeEvent(doc({
    id: 'd3', sourceId: 'doj', outlet: 'DOJ · Western District of Texas', sourceType: 'government', url: 'https://www.justice.gov/x',
    title: 'Mexican National Pleads Guilty to Alien Smuggling Conspiracy Involving Tunnel',
    text: 'EL PASO – A Mexican national pleaded guilty to a smuggling conspiracy that used a tunnel from Ciudad Juárez, Chihuahua into El Paso.',
    publishedAt: '2026-09-04T16:00:00Z',
  }), { gz, groups });
  const unrelated = normalizeEvent(doc({
    id: 'd4', title: 'Four killed in Culiacán shootout', text: 'Four gunmen were killed in a shootout with soldiers in Culiacán, Sinaloa.', publishedAt: '2026-09-04T12:00:00Z',
  }), { gz, groups });

  it('recognizes the same incident across outlets and rejects different ones', () => {
    assert.equal(sameIncident(bb, media), true);
    assert.equal(sameIncident(bb, unrelated), false);
    assert.equal(sameIncident(bb, gov), false);
  });

  it('clusters greedily and grades confidence by independent corroboration', () => {
    const clusters = clusterEvents([bb, media, gov, unrelated]);
    assert.equal(clusters.length, 3);
    for (const c of clusters) assert.equal(c.schema, CLUSTER_SCHEMA);
    const bomb = clusters.find(c => c.records.length === 2);
    assert.equal(bomb.confidence.grade, 'B');
    assert.equal(bomb.confidence.independentSources, 2);
    assert.equal(bomb.counts.killed, 4);
    assert.equal(bomb.location.municipality, 'Ojocaliente');
    assert.ok(bomb.records.every(r => r.url));
    const doj = clusters.find(c => c.records[0].sourceId === 'doj');
    assert.equal(doj.confidence.grade, 'A');
    const single = clusters.find(c => c.records[0].id === unrelated.id);
    assert.equal(single.confidence.grade, 'D');
  });

  it('grades E for undated/unlocated, C for single media, and lifts D→C with 2+ cited outlets', () => {
    assert.equal(gradeConfidence([normalizeEvent(doc({ text: 'Nothing here.', title: 'Statement', publishedAt: null }), { gz, groups })]).grade, 'E');
    assert.equal(gradeConfidence([media]).grade, 'C');
    assert.equal(gradeConfidence([bb]).grade, 'C', 'BB post cites El Universal and Milenio');
    const noCites = normalizeEvent(doc({ text: CAR_BOMB.replace(/Source: El Universal\. According to Milenio, /, '') }), { gz, groups });
    assert.equal(gradeConfidence([noCites]).grade, 'D');
    assert.equal(Object.keys(CONFIDENCE).join(''), 'ABCDE');
  });

  it('syndicated wire copies do not count as independent sources', () => {
    const a = normalizeEvent(doc({ id: 'w1', sourceId: 'outlet1', sourceType: 'news-outlet', wireSource: 'AP', title: media.title, text: 'Four police officers were killed by a car bomb in Ojocaliente, Zacatecas; three were arrested.', publishedAt: '2026-09-04T12:00:00Z' }), { gz, groups });
    const b = normalizeEvent(doc({ id: 'w2', sourceId: 'outlet2', sourceType: 'news-outlet', wireSource: 'AP', title: media.title, text: 'Four police officers were killed by a car bomb in Ojocaliente, Zacatecas; three were arrested.', publishedAt: '2026-09-04T13:00:00Z' }), { gz, groups });
    const g = gradeConfidence([a, b]);
    assert.equal(g.independentSources, 1);
    assert.equal(g.grade, 'C');
  });
});

describe('LLM gap-filling (validated, deterministic fields win)', () => {
  it('validates model output against the gazetteer / group aliases / enum and drops unknowns', () => {
    const v = validateLLMOutput({
      eventType: 'homicide', state: 'Zacatecas', city: 'Ojocaliente', cartels: ['CJNG', 'Cartel of Mars'],
      people: ['Juan Pérez', 'x', '<script>alert(1)</script>'], killed: 4, wounded: -1, eventDate: '2026-09-01',
    }, { gz, groups });
    assert.equal(v.eventType, 'homicide');
    assert.equal(v.state.name, 'Zacatecas');
    assert.equal(v.city.name, 'Ojocaliente');
    assert.deepEqual(v.cartelIds, ['cjng']);
    assert.deepEqual(v.people, ['Juan Pérez']);
    assert.equal(v.counts?.killed ?? v.killed, 4);
    assert.equal(validateLLMOutput({ eventType: 'alien_invasion', state: 'Narnia', cartels: ['Cartel of Mars'] }, { gz, groups }), null);
    assert.equal(validateLLMOutput('not an object', { gz, groups }), null);
    assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
    assert.equal(parseJSON('nope'), null);
  });

  it('merges only into gaps and records the rules+llm method', () => {
    const rec = normalizeEvent(doc({ text: 'A statement was issued by the group.', title: 'Statement' }), { gz, groups });
    assert.equal(needsLLM(rec), true);
    const merged = mergeLLM(rec, validateLLMOutput({ eventType: 'extortion', state: 'Zacatecas', cartels: ['CJNG'], killed: 2 }, { gz, groups }), { gz, groups });
    assert.equal(merged.eventType, 'extortion');
    assert.equal(merged.location.state, 'Zacatecas');
    assert.deepEqual(merged.cartels.map(c => c.id), ['cjng']);
    assert.equal(merged.extractor.method, 'rules+llm');
    const full = normalizeEvent(doc(), { gz, groups });
    const kept = mergeLLM(full, validateLLMOutput({ eventType: 'extortion', state: 'Sonora', killed: 99 }, { gz, groups }), { gz, groups });
    assert.equal(kept.eventType, 'arrest', 'rule-based type wins');
    assert.equal(kept.location.state, 'Zacatecas', 'rule-based location wins');
    assert.equal(kept.counts.killed, 4, 'rule-based counts win');
  });

  it('is a no-op when disabled or without a provider', async () => {
    const recs = [normalizeEvent(doc(), { gz, groups })];
    const off = await llmEnrichRecords(null, recs, new Map(), { enabled: true, gz, groups });
    assert.equal(off.used, 0);
    assert.deepEqual(off.records, recs);
    const dis = await llmEnrichRecords({ complete: async () => { throw new Error('must not be called'); } }, recs, new Map(), { enabled: false, gz, groups });
    assert.equal(dis.used, 0);
  });
});

describe('relevance gates', () => {
  it('keeps cartel/border-security coverage and drops culture, weather and US-only stories', () => {
    assert.equal(isNarcoRelevant({ sourceType: 'news-outlet', title: 'Hundreds of cartel-bound guns were smuggled in from Texas', text: 'Mexican officials in Monterrey...' }), true);
    assert.equal(isNarcoRelevant({ sourceType: 'news-outlet', title: 'Border Biennial invited regional artists', text: 'Artists from Ciudad Juárez and El Paso showed work.' }), false);
    assert.equal(isNarcoRelevant({ sourceType: 'news-outlet', title: 'Officer charged in Minneapolis shooting', text: 'A federal officer was charged after a shooting.' }), false);
    assert.equal(isNarcoRelevant({ sourceType: 'news-outlet', title: 'Toxic metals found in many toys sold near El Paso border', text: 'Toys bought in El Paso and Ciudad Ju\u00e1rez contain lead that accumulates in children\u2019s bodies.' }), false);
    assert.equal(isNarcoRelevant({ sourceType: 'news-outlet', title: 'Three bodies found in Ciudad Ju\u00e1rez', text: 'Three bodies were found dumped on the outskirts of Ciudad Ju\u00e1rez.' }), true);
    assert.equal(isNarcoRelevant({ sourceType: 'citizen-aggregator', title: 'The F-Z Nueva Generación Issues A New Communique', text: 'Gunmen posted a video.' }), true);
    assert.equal(isNarcoRelevant({ sourceType: 'citizen-aggregator', title: 'Open thread', text: 'Weekend music picks.' }), false);
  });

  it('a single fatal shooting reported by the citizen aggregator is one homicide with one killed', () => {
    const text = 'A man, approximately 50 years old, died after being shot on the streets of the Quintas Quijote neighborhood; he sustained at least one gunshot wound to the head.\n\nThe incident took place at the intersection of Voltaria and Dornajo streets, where the man was found with a gunshot wound. Following the attack, his relatives acted quickly and decided to transport him to a hospital themselves.\n\nThe injured man was taken in a private vehicle to a hospital located on Periférico de la Juventud, where he was admitted to the emergency room for medical treatment. However, despite the medical team\'s efforts, he passed away while receiving care.\n\nThe Quintas Quijote neighborhood of Chihuahua, Chihuahua\n\nSource: El Heraldo de Chihuahua';
    const a = { sourceId: 'borderlandbeat', sourceType: 'citizen-aggregator', title: 'Man Dies After Being Shot in the Quintas Quijote Neighborhood', text };
    assert.equal(isNarcoRelevant(a), true);
    const rec = normalizeEvent(doc(a), { gz, groups });
    assert.equal(isNarcoEvent(rec), true);
    assert.equal(rec.location?.state, 'Chihuahua');
    assert.equal(rec.counts.killed, 1);
    assert.equal(rec.counts.kidnapped ?? null, null);
    assert.deepEqual(rec.seizures, {});
    assert.equal(rec.eventType, 'homicide');
  });

  it('second gate requires a Mexican location or a named group for mainstream outlets only', () => {
    const rec = normalizeEvent(doc({ sourceId: 'borderreport', sourceType: 'news-outlet', title: 'Agents rescued 8 migrants from locked train car', text: 'Border Patrol agents in Eagle Pass rescued eight migrants from a locked rail car.' }), { gz, groups });
    assert.equal(isNarcoEvent(rec), false);
    assert.equal(isNarcoEvent({ ...rec, sourceId: 'doj' }), true, 'migrant smuggling release is in scope');
    assert.equal(isNarcoEvent({ ...rec, sourceType: 'citizen-aggregator' }), true);
    const doj = (title, excerpt, categories) => ({ ...rec, sourceId: 'doj', title, excerpt, cartels: [], location: { country: 'US' }, provenance: { kind: 'prosecution', categories } });
    assert.equal(isNarcoEvent(doj('Man Sentenced for Smuggling Controlled Goods to Russia', 'Export-controlled electronics were shipped via third countries.', ['smugglers'])), false);
    assert.equal(isNarcoEvent(doj('Man Charged with Smuggling Banned Pesticides', 'Pesticides were brought across the border for resale.', ['smugglers'])), false);
    assert.equal(isNarcoEvent(doj('Man Charged with Smuggling Pesticides', 'Agents also found methamphetamine in the vehicle.', ['smugglers'])), true);
    assert.equal(isNarcoEvent(doj('Alien smuggler sentenced', 'Conspiracy spanning 15 months.', ['smugglers', 'human_smuggling'])), true);
    assert.equal(isNarcoEvent({ ...rec, cartels: [{ id: 'cdn' }] }), true);
    assert.equal(isNarcoEvent(normalizeEvent(doc({ sourceType: 'news-outlet' }), { gz, groups })), true);
  });

  it('borderDocs / dojDocs carry provenance and anchor DOJ releases to the district seat', () => {
    const docs = borderDocs([{ id: 'a1', sourceId: 'borderlandbeat', outlet: 'Borderland Beat', sourceType: 'citizen-aggregator', title: 'CJNG gunmen killed in Jalisco', text: 'x', canonicalUrl: 'https://www.borderlandbeat.com/1', publishedAt: '2026-09-01T00:00:00Z', tags: { topics: ['cartels'] } }, { id: 'a2', sourceId: 'x', title: 'Weather', text: 'Sunny' }], { gz, groups });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].url, 'https://www.borderlandbeat.com/1');
    assert.equal(docs[0].extra.kind, 'article');
    const dd = dojDocs([{ id: 'r1', url: 'https://www.justice.gov/usao-wdtx/pr/x', title: 'T', body: 'B', teaser: 't', publishedAt: '2026-09-04T00:00:00Z', collectedAt: '2026-09-04T01:00:00Z', district: { code: 'TXWD', name: 'Western District of Texas' }, categories: ['tunnel'], topics: [], dateline: { city: 'El Paso' } }]);
    assert.equal(dd[0].sourceType, 'government');
    assert.equal(dd[0].fallbackLocation.state, 'TX');
    assert.equal(dd[0].fallbackLocation.city, 'El Paso');
    assert.equal(dd[0].extra.kind, 'prosecution');
  });

  it('DOJ releases keep an enforcement primary type; violence cues stay secondary', () => {
    const [d] = dojDocs([{ id: 'r2', url: 'https://www.justice.gov/usao-sdtx/pr/y', title: 'Alien smuggler lands decades in prison for conspiracy that left three dead', body: 'A smuggler was sentenced to 30 years after a crash left three migrants dead near McAllen.', teaser: null, publishedAt: '2026-09-04T00:00:00Z', collectedAt: '2026-09-04T01:00:00Z', district: { code: 'TXSD', name: 'Southern District of Texas' }, categories: ['smugglers', 'human_smuggling'], topics: [], dateline: { city: 'McAllen' } }]);
    const rec = normalizeEvent({ ...d, location: d.fallbackLocation }, { gz, groups });
    assert.ok(['prosecution', 'smuggling', 'arrest'].includes(rec.eventType), `enforcement primary, got ${rec.eventType}`);
    assert.equal(typeFamily(rec.eventType), 'enforcement');
    assert.ok(rec.eventTypes.includes('homicide'), `violence cue retained: ${rec.eventTypes}`);
  });
});
