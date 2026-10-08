// Synthetic scenario generator for the Chinese Delegation Tracker. Every person, identifier and
// record produced here is FICTIONAL and marked synthetic:true. Each delegation (news-sourced or
// scenario) gets one fictional person of interest (POI) whose records follow the delegation's
// cities and dates, plus a supporting cast (co-traveler, local associates, family, drivers, event
// contacts). Coverage is deliberately partial: nobody appears in every dataset, so links have to
// be inferred through shared phones / IMSI / IMEI / passports / addresses / plates / PNRs.
//
// Test-only ranges: phones +CC 555-01xx-xxxx, IMSI MCC 001 (ITU test network), IMEI TAC prefix 00,
// e-mail @*.example.test, payment cards = public test PANs shown masked, passport photos are
// silhouette placeholders.

import { locale, NAMES } from './locales.mjs';
import { toMgrs } from './mgrs.mjs';
import { placeByCity } from './gazetteer.mjs';
import { getProfile } from '../profile.mjs';

const RU = getProfile()?.id === 'europe';
const NAME_STYLE = RU ? 'russian' : 'chinese';
const HOME_CC = RU ? '7' : '86';
const RU_FRONT_COS = ['Sevzapinvest Trading LLC', 'Ural Digital Systems JSC', 'Baltic Energy Consulting LLC', 'Rusexport Partner LLC', 'Neva Analytics Group LLC'];

export const DATASETS = ['travel', 'border', 'ss7', 'cdr', 'voter', 'vehicle'];
export const DATASET_LABELS = { travel: 'Travel reservations', border: 'Border crossings', ss7: 'SS7 registrations', cdr: 'Call detail records', voter: 'Voter registration', vehicle: 'Vehicle registration' };

export function hash32(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: arr => arr[Math.floor(next() * arr.length)], chance: p => next() < p };
}
const D = (r, n) => Array.from({ length: n }, () => r.int(0, 9)).join('');
const HEX = (r, n) => Array.from({ length: n }, () => '0123456789ABCDEF'[r.int(0, 15)]).join('');
const luhn = s => { let sum = 0; [...s].reverse().forEach((d, i) => { let x = +d; if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } sum += x; }); return String((10 - (sum % 10)) % 10); };
const digits = s => String(s || '').replace(/\D/g, '');
const DAY = 86400e3;
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

const msisdn = (r, cc) => `+${cc} 555 01${D(r, 2)} ${D(r, 4)}`;
const imsi = r => `00101${D(r, 10)}`;
const imei = r => { const b = `00${D(r, 6)}${D(r, 6)}`; return b + luhn(b); };
const EMAIL_DOMAINS = ['mail.example.test', 'inbox.example.test', 'corp.example.test', 'post.example.test'];
const translit = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '').toLowerCase();
const email = (r, given, family) => `${translit(given)}.${translit(family)}${r.int(1, 99)}@${r.pick(EMAIL_DOMAINS)}`;
const TEST_CARDS = [['VISA', '4111111111111111'], ['Mastercard', '5555555555554444'], ['UnionPay', '6200000000000005'], ['AMEX', '378282246310005'], ['VISA', '4012888888881881']];
const HOTELS = ['Grand Meridian', 'Royal Cedar', 'Golden Crescent', 'Silk Road Plaza', 'Harbour View', 'Imperial Lotus', 'Palm Court', 'Azure Tower', 'Jade Garden', 'Oasis Regency'];
const FRONT_COS = RU ? RU_FRONT_COS : ['Huaxin Hengtong Trading Co., Ltd.', 'Shenzhen Jinqiao Digital Technology Co., Ltd.', 'Beijing Yuanhang International Exchange Center', 'Zhongke Tianlu Engineering Consulting Co.', 'Hangzhou Lanhai Cross-Border Services Co.'];
const POI_ROLES = [
  ['Delegation logistics coordinator', 'P'], ['Listed interpreter', 'S'], ['Trade attaché (accompanying)', 'S'], ['Unlisted technical adviser', 'P'],
  ['Protocol officer', 'D'], ['Delegation security detail lead', 'S'], ['Media liaison', 'P'], ['Research fellow (think-tank cover)', 'P'],
];
const PASSPORT_KIND = RU ? { P: 'Foreign travel passport (ordinary)', S: 'Service passport', D: 'Diplomatic passport' } : { P: 'Ordinary (E-series)', S: 'Service (SE-series)', D: 'Diplomatic (DE-series)' };
const CARRIERS = { RU: ['SU', 'Aeroflot', 'Aeroflot Bonus'], CN: ['CA', 'Air China', 'Air China PhoenixMiles'], EG: ['MS', 'EgyptAir', 'EgyptAir Plus'], LB: ['ME', 'Middle East Airlines', 'MEA Cedar Miles'], PK: ['PK', 'PIA', 'PIA Awards+'],
  KE: ['KQ', 'Kenya Airways', 'Asante Rewards'], AE: ['EK', 'Emirates', 'Emirates Skywards'], QA: ['QR', 'Qatar Airways', 'Privilege Club'], TR: ['TK', 'Turkish Airlines', 'Miles&Smiles'],
  ET: ['ET', 'Ethiopian Airlines', 'ShebaMiles'], SA: ['SV', 'Saudia', 'AlFursan'], IN: ['AI', 'Air India', 'Maharaja Club'], US: ['UA', 'United', 'MileagePlus'] };
const VEHICLES = [['Toyota', 'Corolla'], ['Toyota', 'Land Cruiser'], ['Toyota', 'Hilux'], ['Hyundai', 'Elantra'], ['Hyundai', 'Tucson'], ['Kia', 'Sportage'], ['Nissan', 'Sunny'], ['Mercedes-Benz', 'E 200'],
  ['BMW', '520i'], ['Chery', 'Tiggo 7'], ['BYD', 'Atto 3'], ['Geely', 'Coolray'], ['MG', 'ZS'], ['Haval', 'H6'], ['Suzuki', 'Swift'], ['Honda', 'Civic'], ['Volkswagen', 'Passat'], ['Lexus', 'LX 600']];
const COLORS = ['White', 'Black', 'Silver', 'Grey', 'Dark Blue', 'Maroon', 'Beige', 'Champagne'];
const IATA = { Cairo: 'CAI', Beirut: 'BEY', Islamabad: 'ISB', Karachi: 'KHI', Lahore: 'LHE', Nairobi: 'NBO', Riyadh: 'RUH', Jeddah: 'JED', Dubai: 'DXB', 'Abu Dhabi': 'AUH', Doha: 'DOH', Tehran: 'IKA',
  Baghdad: 'BGW', Amman: 'AMM', Istanbul: 'IST', Ankara: 'ESB', 'Addis Ababa': 'ADD', Lagos: 'LOS', Abuja: 'ABV', Accra: 'ACC', 'New Delhi': 'DEL', Dhaka: 'DAC', Kathmandu: 'KTM', Colombo: 'CMB',
  Tashkent: 'TAS', Astana: 'NQZ', Almaty: 'ALA', Jakarta: 'CGK', 'Kuala Lumpur': 'KUL', 'Phnom Penh': 'KTI', Belgrade: 'BEG', Budapest: 'BUD', Brasilia: 'BSB', 'Sao Paulo': 'GRU', Washington: 'IAD',
  Tripoli: 'MJI', Baku: 'GYD', Moscow: 'SVO', Vladivostok: 'VVO', Tokyo: 'NRT', Kampala: 'EBB', Pretoria: 'JNB', Johannesburg: 'JNB', Kyiv: 'KBP', Beijing: 'PEK',
  Chisinau: 'RMO', Tbilisi: 'TBS', Yerevan: 'EVN', Bratislava: 'BTS', Istanbul: 'IST', Ankara: 'ESB', Vienna: 'VIE', Sofia: 'SOF', Minsk: 'MSQ', Warsaw: 'WAW',
  Berlin: 'BER', Paris: 'CDG', London: 'LHR', Rome: 'FCO', Athens: 'ATH', Bucharest: 'OTP', Riga: 'RIX', Vilnius: 'VNO', Tallinn: 'TLL', Helsinki: 'HEL', Prague: 'PRG',
  Sarajevo: 'SJJ', Podgorica: 'TGD', Skopje: 'SKP', Tirana: 'TIA', Zagreb: 'ZAG', Ljubljana: 'LJU', 'St Petersburg': 'LED' };
const iata = c => IATA[c] || c.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();

const HOME = RU ? { city: 'Moscow', country: 'Russia', iso2: 'RU', lat: 55.76, lon: 37.62 } : { city: 'Beijing', country: 'China', iso2: 'CN', lat: 39.9, lon: 116.4 };

function makeName(r, style, sex) {
  const pool = NAMES[style] || NAMES.western;
  const given = r.pick(sex === 'F' ? pool.female : pool.male);
  let family = r.pick(pool.family);
  if (style === 'russian' && sex === 'F' && /(ov|ev|in)$/.test(family)) family += 'a';
  return { given, family, full: style === 'chinese' ? `${family.toUpperCase()} ${given}` : `${given} ${family}` };
}
const dob = (r, lo = 1965, hi = 1998) => `${r.int(lo, hi)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;

function prcPassport(r, kind = 'P') { if (RU) return kind === 'D' ? `20 ${D(r, 7)}` : kind === 'S' ? `10 ${D(r, 7)}` : `7${r.int(0, 9)} ${D(r, 7)}`; return kind === 'D' ? `DE${D(r, 7)}` : kind === 'S' ? `SE${D(r, 7)}` : `E${String.fromCharCode(65 + r.int(0, 25))}${D(r, 7)}`; }

// ── Scenario context: cell towers, venues, addresses per stop city ───────────────────────────
function towersFor(r, stop, idx, ctx) {
  const key = `${stop.city}|${stop.country}`;
  if (ctx.towers.has(key)) return ctx.towers.get(key);
  const tac = r.int(1000, 65000);
  const mk = (site, dLat, dLon) => {
    const lat = +(stop.lat + dLat).toFixed(5), lon = +(stop.lon + dLon).toFixed(5);
    const t = { id: `CELL-${stop.iso2}-${tac}-${r.int(10000, 99999)}`, site, city: stop.city, country: stop.country, iso2: stop.iso2, plmn: `001-${String(idx % 100).padStart(2, '0')}`,
      tac, eci: r.int(1e6, 268435455), lat, lon, mgrs: toMgrs(lat, lon), azimuth: r.int(0, 359), synthetic: true };
    ctx.towerList.push(t); return t;
  };
  const j = () => (r.next() - 0.5) * 0.04;
  const set = {
    airport: mk(`${stop.city} International Airport — terminal sector`, 0.09 + j(), 0.11 + j()),
    hotel: mk(`${stop.city} ${r.pick(HOTELS)} Hotel rooftop`, j(), j()),
    venue: mk(`${stop.city} government district`, 0.015 + j(), -0.02 + j()),
    event: mk(`${stop.city} convention / event district`, -0.03 + j(), 0.035 + j()),
    resA: mk(`${stop.city} residential sector A`, 0.05 + j(), -0.06 + j()),
    resB: mk(`${stop.city} residential sector B`, -0.06 + j(), -0.04 + j()),
  };
  set.hotelName = set.hotel.site.replace(/ rooftop$/, '');
  set.tac = tac;
  ctx.towers.set(key, set);
  return set;
}

function address(r, L, stop) { return `${r.int(2, 180)} ${r.pick(L.streets)}, ${r.pick(['District 1', 'District 3', 'Sector 5', 'Old Town', 'New Town', 'Garden City', 'Downtown', 'Heights'])}, ${stop.city}, ${stop.country}`; }

// ── Main entry ───────────────────────────────────────────────────────────────────────────────
// delegations: [{ id, label, source, stops:[{city,country,iso2,lat,lon,date,meetings,concurrent}] }]
// events: [{ id, city, country, date, host, headline }] (for venue co-location)
export function generateSynthetic({ scenario = {}, delegations = [], events = [], synDelegations: synDelIn, synEvents: synEvIn, now = Date.now() } = {}) {
  const seed = Number(scenario.seed ?? 20261006);
  const cov = { travel: 0.6, border: 0.7, ss7: 0.85, cdr: 0.8, voter: 0.75, vehicle: 0.55, ...(scenario.coverage || {}) };
  const maxStops = Number(scenario.maxStopsPerPerson ?? 6);
  const ctx = { towers: new Map(), towerList: [] };
  const persons = []; const ds = Object.fromEntries(DATASETS.map(k => [k, []]));
  const seq = Object.fromEntries(DATASETS.map(k => [k, 0]));
  const PFX = { travel: 'TRV', border: 'BRD', ss7: 'SS7', cdr: 'CDR', voter: 'VTR', vehicle: 'VEH' };
  const add = (k, rec) => { rec.id = `${PFX[k]}-${String(++seq[k]).padStart(5, '0')}`; rec.synthetic = true; ds[k].push(rec); return rec; };

  const synDelegations = synDelIn || buildScenarioDelegations(scenario, now);
  const synEvents = synEvIn || buildScenarioEvents(scenario, synDelegations, now);
  const allDel = [...synDelegations, ...delegations];
  const allEvents = [...synEvents, ...events];

  allDel.forEach((del, di) => {
    const r = rng(seed ^ hash32(del.id));
    const stops = (del.stops || []).filter(s => Number.isFinite(s.lat)).slice(-maxStops).map((s, i, arr) => {
      const next = arr[i + 1];
      const nights = Math.max(1, Math.min(3, next ? Math.round((Date.parse(next.date) - Date.parse(s.date)) / DAY) || 1 : s.nights || 2));
      return { ...s, nights };
    });
    if (!stops.length) return;
    const pid = n => `${del.id}-p${n}`;
    let pn = 0;
    const person = (o) => { const p = { id: pid(++pn), delegationId: del.id, delegationLabel: del.label, synthetic: true, phones: [], imsis: [], imeis: [], emails: [], ...o }; persons.push(p); return p; };

    // POI and co-traveler (PRC nationals)
    const [role, pk] = r.pick(POI_ROLES);
    const sex = r.chance(0.35) ? 'F' : 'M';
    const poiName = makeName(r, NAME_STYLE, sex);
    const poi = person({ isPOI: true, role, name: poiName.full, given: poiName.given, family: poiName.family, sex, dob: dob(r, 1972, 1994), nationality: HOME.iso2,
      passport: { number: prcPassport(r, pk), kind: PASSPORT_KIND[pk], issued: `${r.int(2018, 2024)}-0${r.int(1, 9)}-1${r.int(0, 9)}`, authority: RU ? 'GUVM, MVD of Russia' : 'Exit & Entry Administration, MPS' } });
    poi.phones.push(msisdn(r, HOME_CC)); poi.imsis.push(imsi(r)); poi.imeis.push(imei(r)); poi.emails.push(email(r, poi.given, poi.family));
    poi.rewards = { program: CARRIERS[HOME.iso2][2], number: `${CARRIERS[HOME.iso2][0]}${D(r, 9)}` };
    const ctSex = r.chance(0.5) ? 'F' : 'M'; const ctName = { ...makeName(r, NAME_STYLE, ctSex), sex: ctSex };
    const co = person({ role: 'Co-traveler (booking holder)', name: ctName.full, given: ctName.given, family: ctName.family, sex: ctName.sex, dob: dob(r), nationality: HOME.iso2,
      passport: { number: prcPassport(r, 'P'), kind: PASSPORT_KIND.P }, employer: r.pick(FRONT_COS) });
    co.phones.push(msisdn(r, HOME_CC)); co.imsis.push(imsi(r)); co.imeis.push(imei(r)); co.emails.push(email(r, co.given, co.family));
    co.rewards = { program: CARRIERS[HOME.iso2][2], number: `${CARRIERS[HOME.iso2][0]}${D(r, 9)}` };
    const familyAtHome = [makeName(r, NAME_STYLE, sex === 'F' ? 'M' : 'F').full, makeName(r, NAME_STYLE, 'M').full.replace(/^\S+/, poi.family.toUpperCase())];

    // Travel mode for the POI: own booking / listed on co-traveler's PNR / absent (charter)
    const travelMode = scenario.travelMode?.[del.id] || r.pick(['own', 'cotraveler', 'cotraveler', 'absent']);
    const card = r.pick(TEST_CARDS);
    const payerIsCompany = r.chance(0.5);

    const poiLocalSims = [];
    const track = [];
    const ss7 = (p, tower, t, o = {}) => {
      const rec = add('ss7', { ts: iso(t), event: o.event || r.pick(['UpdateLocation', 'UpdateLocation', 'ProvideSubscriberInfo', 'SendRoutingInfoForSM', 'AnyTimeInterrogation']),
        msisdn: o.msisdn || p.phones[0], imsi: o.imsi || p.imsis[0], imei: o.imei || p.imeis[0], tmsi: HEX(r, 8), roaming: (o.imsiHome || p.nationality) !== tower.iso2,
        homeNetwork: o.imsiHome || p.nationality, servingCountry: tower.country, plmn: tower.plmn, tac: tower.tac, cellId: tower.id, eci: tower.eci, site: tower.site, city: tower.city,
        lat: tower.lat, lon: tower.lon, mgrs: tower.mgrs, vlrGt: `+${locale(tower.iso2).cc} 555 0100 ${String(tower.tac).slice(-3)}`, _truth: p.id });
      if (p === poi) track.push({ ts: rec.ts, lat: rec.lat, lon: rec.lon, label: `${tower.site} · ${o.imsi && o.imsi !== poi.imsis[0] ? 'local SIM' : 'home SIM'}`, recordId: rec.id, kind: 'ss7' });
      return rec;
    };
    const cdr = (a, b, tower, t, o = {}) => add('cdr', { start: iso(t), durationSec: o.sms ? 0 : r.int(18, 900), type: o.sms ? 'SMS' : r.pick(['Voice', 'Voice', 'Voice', 'VoLTE']),
      aParty: { msisdn: o.aMsisdn || a.phones[0], imsi: o.aImsi || a.imsis[0], imei: o.aImei || a.imeis[0], registeredName: o.aReg || a.name },
      bParty: { msisdn: o.bMsisdn || b.phones[0], registeredName: o.bReg || b.name }, cellId: tower.id, tac: tower.tac, site: tower.site, city: tower.city, country: tower.country,
      lat: tower.lat, lon: tower.lon, mgrs: tower.mgrs, _truth: a.id, _truthB: b.id });

    // Bookings (one multi-city PNR)
    const legs = [];
    let prev = HOME;
    for (const s of stops) { legs.push({ from: prev, to: s, date: s.date }); prev = s; }
    legs.push({ from: prev, to: HOME, date: addDays(stops.at(-1).date, stops.at(-1).nights) });
    const segments = legs.map(l => { const c = CARRIERS[l.to.iso2 === HOME.iso2 ? l.from.iso2 : l.to.iso2] || CARRIERS[HOME.iso2]; const dep = Date.parse(l.date) + r.int(1, 14) * 3600e3; return { carrier: c[1], flight: `${c[0]}${r.int(100, 989)}`, from: iata(l.from.city), to: iata(l.to.city), depart: iso(dep), arrive: iso(dep + r.int(2, 9) * 3600e3), class: r.pick(['J', 'C', 'Y', 'W']) }; });
    if (travelMode !== 'absent' && r.chance(cov.travel + 0.3)) {
      const pnr = `${HEX(r, 3).replace(/[0-9]/g, 'X')}${String.fromCharCode(65 + r.int(0, 25))}${D(r, 2)}`;
      const pax = [];
      const paxOf = (p, contactOf = p, withRewards = true) => ({ name: p.name, passport: p.passport.number, nationality: p.nationality, dob: p.dob, phone: contactOf.phones[0], email: contactOf.emails[0], rewards: withRewards ? p.rewards : null, seat: `${r.int(2, 40)}${'ACDFHK'[r.int(0, 5)]}` });
      if (travelMode === 'own') pax.push(paxOf(poi), paxOf(co));
      else pax.push(paxOf(co), paxOf(poi, co, false));
      add('travel', { pnr, bookedAt: iso(Date.parse(stops[0].date) - r.int(4, 21) * DAY), agency: r.pick(['Corporate travel desk', 'Ctrip/Trip.com corporate', 'Embassy travel office', 'Online (direct)']),
        segments, passengers: pax, cotravelers: pax.map(p => p.name), bookingContact: { phone: pax[0].phone, email: pax[0].email },
        payment: { method: card[0], masked: `${card[0]} •••• ${card[1].slice(-4)}`, testPan: true, cardholder: payerIsCompany ? co.employer : co.name, billingAddress: payerIsCompany ? (RU ? `${r.int(1, 99)} Tverskaya St, Moscow` : `${r.int(1, 99)} Jianguo Rd, Chaoyang District, Beijing, China`) : (RU ? `${r.int(1, 120)} Leninsky Prospekt, Moscow, Russia` : `${r.int(1, 300)} ${r.pick(['Zhongshan Rd', 'Renmin Rd', 'Jiefang Rd'])}, ${r.pick(['Shenzhen', 'Beijing', 'Hangzhou'])}, China`), amount: r.int(3800, 16500), currency: 'USD' },
        _truth: travelMode === 'own' ? poi.id : co.id, _truthAlso: [poi.id, co.id] });
    }
    // The POI books one leg alone (own name, own phone) in some scenarios even when not on the PNR
    if (travelMode === 'absent' && stops.length > 1 && r.chance(0.5)) {
      const l = segments[r.int(1, segments.length - 2)] || segments[0];
      add('travel', { pnr: `${String.fromCharCode(65 + r.int(0, 25))}${HEX(r, 5)}`, bookedAt: iso(Date.parse(stops[0].date) + DAY), agency: 'Online (direct)', segments: [l],
        passengers: [{ name: poi.name, passport: poi.passport.number, nationality: HOME.iso2, dob: poi.dob, phone: poi.phones[0], email: poi.emails[0], rewards: poi.rewards, seat: `${r.int(2, 40)}C` }], cotravelers: [poi.name],
        bookingContact: { phone: poi.phones[0], email: poi.emails[0] }, payment: { method: RU ? 'Mir' : 'UnionPay', masked: RU ? 'Mir •••• 0004' : 'UnionPay •••• 0005', testPan: true, cardholder: poi.name, billingAddress: `${HOME.city}, ${HOME.country}`, amount: r.int(400, 1800), currency: 'USD' }, _truth: poi.id });
    }

    stops.forEach((s, si) => {
      const L = locale(s.iso2);
      const tw = towersFor(r, s, di * 10 + si, ctx);
      const arrive = Date.parse(s.date) + r.int(9, 15) * 3600e3;
      const depart = Date.parse(addDays(s.date, s.nights)) + r.int(6, 11) * 3600e3;
      const meetT = Date.parse(addDays(s.date, Math.min(1, s.nights - 1) || 0)) + r.int(9, 12) * 3600e3 + (s.nights === 1 ? 5 * 3600e3 : 0);
      const evRef = (s.concurrent || []).map(c => allEvents.find(e => e.id === c.eventId)).find(Boolean);
      const evT = evRef ? Math.min(Math.max(Date.parse(evRef.date) + 15 * 3600e3, arrive + 3 * 3600e3), depart - 2 * 3600e3) : null;

      // Local associate + family (voter-roll heavy), driver, optional event contact
      const aSex = r.chance(0.7) ? 'M' : 'F';
      const an = makeName(r, L.style, aSex);
      const fatherGiven = r.pick(NAMES[L.style]?.male || NAMES.western.male);
      const motherName = makeName(r, L.style, 'F');
      const familyId = L.voter.familyRegistry ? `${r.int(1, 999)} / ${r.pick(['Achrafieh', 'Mazraa', 'Ras Beirut', 'Baabda', 'Jbeil', 'Zahle', 'Saida', 'Tyre'])}` : null;
      const homeAddr = address(r, L, s);
      const assoc = person({ role: `Local associate (${s.city})`, name: an.full, given: an.given, family: an.family, sex: aSex, dob: dob(r), nationality: s.iso2, nationalId: L.id(r),
        father: `${fatherGiven} ${an.family}`, mother: `${motherName.given} ${motherName.family}`, familyId, address: homeAddr, city: s.city });
      assoc.phones.push(msisdn(r, L.cc)); assoc.imsis.push(imsi(r)); assoc.imeis.push(imei(r)); assoc.emails.push(email(r, an.given, an.family));
      const sibSex = r.chance(0.5) ? 'M' : 'F';
      const sib = person({ role: `Sibling of local associate (${s.city})`, name: `${r.pick(NAMES[L.style]?.[sibSex === 'F' ? 'female' : 'male'] || NAMES.western.male)} ${an.family}`, family: an.family, sex: sibSex, dob: dob(r), nationality: s.iso2,
        nationalId: L.id(r), father: assoc.father, mother: assoc.mother, familyId, address: r.chance(0.6) ? homeAddr : address(r, L, s), city: s.city });
      sib.phones.push(msisdn(r, L.cc)); sib.imsis.push(imsi(r)); sib.imeis.push(imei(r));
      const dn = makeName(r, L.style, 'M');
      const driver = person({ role: `Driver / fixer (${s.city})`, name: dn.full, given: dn.given, family: dn.family, sex: 'M', dob: dob(r, 1970, 2000), nationality: s.iso2, nationalId: L.id(r), address: address(r, L, s), city: s.city });
      driver.phones.push(msisdn(r, L.cc)); driver.imsis.push(imsi(r)); driver.imeis.push(imei(r));
      let evContact = null;
      if (evRef) {
        const enSex = r.chance(0.5) ? 'F' : 'M'; const en = { ...makeName(r, L.style, enSex), sex: enSex };
        evContact = person({ role: `Event contact — ${evRef.host} (${s.city})`, name: en.full, given: en.given, family: en.family, sex: en.sex, nationality: s.iso2, city: s.city, employer: `${evRef.host} local partner (fictional)` });
        evContact.phones.push(msisdn(r, L.cc)); evContact.imsis.push(imsi(r)); evContact.imeis.push(imei(r)); evContact.emails.push(email(r, en.given, en.family));
      }

      // POI local SIM (registered in the associate's name) from the 2nd stop on: IMSI→IMEI correlation
      let localSim = null;
      if (si >= 1 || stops.length === 1) {
        localSim = { msisdn: msisdn(r, L.cc), imsi: imsi(r), registeredName: assoc.name, registeredId: assoc.nationalId.number, country: s.iso2 };
        poiLocalSims.push(localSim); poi.phones.push(localSim.msisdn); poi.imsis.push(localSim.imsi);
      }
      // Handset swap on the 3rd stop: home IMSI now on a second IMEI
      if (si === 2) poi.imeis.push(imei(r));
      const poiImei = poi.imeis.at(-1);

      // Border crossings (POI almost always; co-traveler partial)
      const visa = (p, stay, host) => {
        const exempt = /Diplomatic|Service/.test(p.passport?.kind || '') && r.chance(0.6);
        return exempt ? { number: null, type: `Visa-exempt (${p.passport.kind.split(' ')[0].toLowerCase()} passport)`, application: null }
          : { number: `${s.iso2}${D(r, 8)}`, type: r.pick(['Business (single entry)', 'Official delegation', 'Business (multiple entry)', 'e-Visa — business']), issued: addDays(s.date, -r.int(5, 25)), validUntil: addDays(s.date, r.int(30, 90)),
            application: { applicant: p.name, passport: p.passport.number, familyMembers: p === poi ? familyAtHome : [], addressStaying: stay, inviter: host, purpose: r.pick(['Trade & investment talks', 'Official delegation', 'Conference attendance', 'Technical cooperation']), durationDays: s.nights + r.int(0, 3), phone: p.phones[0], email: p.emails[0] } };
      };
      const stay = r.chance(0.35) ? assoc.address : `${tw.hotelName}, ${s.city}, ${s.country}`;
      const host = r.pick([`${s.country} Ministry of Trade & Industry (scenario)`, `${s.country}–China Business Council (scenario)`, `${co.employer} — ${s.city} office`, `${s.country} Chamber of Commerce (scenario)`]);
      const border = (p, dir, t, vi) => add('border', { ts: iso(t), direction: dir, country: s.country, iso2: s.iso2, port: `${s.city} International Airport (${iata(s.city)})`, name: p.name, sex: p.sex, dob: p.dob,
        passport: { number: p.passport.number, nationality: p.nationality, kind: p.passport.kind, photo: 'silhouette-placeholder' }, flight: segments[si + (dir === 'EXIT' ? 1 : 0)]?.flight || null,
        visa: vi, _truth: p.id });
      if (r.chance(si === stops.length - 1 ? 0.97 : 0.9)) {
        const v = visa(poi, stay, host);
        border(poi, 'ENTRY', arrive, v);
        if (r.chance(0.8)) border(poi, 'EXIT', depart, v);
        track.push({ ts: iso(arrive), lat: tw.airport.lat, lon: tw.airport.lon, label: `Border entry · ${s.city}`, kind: 'border' });
      }
      if (r.chance(cov.border)) { const v = visa(co, `${tw.hotelName}, ${s.city}, ${s.country}`, host); border(co, 'ENTRY', arrive + r.int(0, 2) * 600e3, v); if (r.chance(0.6)) border(co, 'EXIT', depart, v); }

      // SS7: POI at airport, hotel nights, meeting venue, event venue
      const sims = [{ imsi: poi.imsis[0], msisdn: poi.phones[0], home: HOME.iso2 }];
      if (localSim) sims.push({ imsi: localSim.imsi, msisdn: localSim.msisdn, home: s.iso2 });
      ss7(poi, tw.airport, arrive + 20 * 60e3, { event: 'UpdateLocation', imei: poiImei });
      for (let n = 0; n < s.nights; n++) {
        const sim = localSim && n > 0 ? sims[1] : sims[0];
        ss7(poi, tw.hotel, Date.parse(addDays(s.date, n)) + r.int(21, 23) * 3600e3, { imsi: sim.imsi, msisdn: sim.msisdn, imsiHome: sim.home, imei: poiImei });
      }
      if (localSim) ss7(poi, tw.hotel, arrive + 3 * 3600e3, { event: 'UpdateLocation', imsi: localSim.imsi, msisdn: localSim.msisdn, imsiHome: s.iso2, imei: poiImei });
      ss7(poi, tw.venue, meetT + 15 * 60e3, { imei: poiImei });
      if (evT) ss7(poi, tw.event, evT, { imsi: sims.at(-1).imsi, msisdn: sims.at(-1).msisdn, imsiHome: sims.at(-1).home, imei: poiImei });
      ss7(poi, tw.airport, depart - 90 * 60e3, { imei: poiImei });
      if (r.chance(cov.ss7)) { ss7(co, tw.airport, arrive + 25 * 60e3, { event: 'UpdateLocation' }); ss7(co, tw.hotel, Date.parse(s.date) + 22 * 3600e3); }

      // SS7: locals
      if (r.chance(cov.ss7)) { ss7(assoc, tw.resA, Date.parse(s.date) + 7 * 3600e3); ss7(assoc, tw.venue, meetT + 5 * 60e3); ss7(assoc, tw.hotel, arrive + 4 * 3600e3); }
      if (r.chance(cov.ss7)) { ss7(driver, tw.airport, arrive - 30 * 60e3); ss7(driver, tw.hotel, arrive + 70 * 60e3); ss7(driver, tw.airport, depart - 100 * 60e3); }
      if (r.chance(cov.ss7 * 0.6)) ss7(sib, tw.resA, Date.parse(s.date) + 20 * 3600e3);
      if (evContact) { ss7(evContact, tw.event, evT - 40 * 60e3); ss7(evContact, tw.event, evT + 30 * 60e3); }

      // CDRs
      const poiSim = sims.at(-1);
      const poiOpts = { aMsisdn: poiSim.msisdn, aImsi: poiSim.imsi, aImei: poiImei, aReg: localSim && poiSim === sims[1] ? assoc.name : poi.name };
      if (r.chance(cov.cdr)) {
        cdr(poi, assoc, tw.hotel, arrive + 2 * 3600e3, poiOpts);
        cdr(assoc, poi, tw.resA, meetT - 2 * 3600e3, { bMsisdn: poiSim.msisdn, bReg: poiOpts.aReg });
        cdr(assoc, driver, tw.resA, arrive - 3 * 3600e3);
        cdr(poi, co, tw.hotel, Date.parse(s.date) + 23 * 3600e3, { aImei: poiImei });
      }
      if (r.chance(cov.cdr * 0.8)) cdr(driver, poi, tw.airport, arrive - 10 * 60e3, { bMsisdn: poi.phones[0], sms: true });
      if (r.chance(cov.cdr * 0.6)) cdr(assoc, sib, tw.resA, Date.parse(s.date) + 19 * 3600e3);
      if (evContact) { cdr(evContact, poi, tw.event, evT - 60 * 60e3, { bMsisdn: poiSim.msisdn, bReg: poiOpts.aReg }); cdr(poi, evContact, tw.event, evT + 45 * 60e3, poiOpts); }

      // Voter rolls (citizens only; associate and/or sibling)
      const voter = (p) => add('voter', { country: s.country, iso2: s.iso2, authority: L.voter.authority, fullName: p.name, givenName: p.given || p.name.split(' ')[0], familyName: p.family,
        ...(L.voter.fatherMother ? { fatherName: p.father, motherName: p.mother } : {}), ...(L.voter.husbandOrFather ? { fatherOrHusbandName: p.father } : {}), ...(L.voter.grandfather ? { grandfatherName: `${r.pick(NAMES[L.style].male)} ${p.family}` } : {}),
        ...(L.voter.familyRegistry ? { familyRegistryNo: p.familyId, registryNote: 'Sijil (family register) number shared by all members of the family' } : {}),
        idDocument: p.nationalId, ...(r.chance(0.3) ? { driversLicense: `DL-${s.iso2}-${D(r, 8)}` } : {}), dob: p.dob, sex: p.sex, address: p.address, phone: p.phones[0], email: p.emails[0] || null,
        constituency: `${s.city} ${r.int(1, 12)}`, pollingStation: `${s.city} Public School No. ${r.int(1, 60)}`, _truth: p.id });
      if (r.chance(cov.voter)) voter(assoc);
      if (r.chance(cov.voter)) voter(sib);

      // Vehicles: associate's car is sometimes registered to the sibling at the shared address
      const vehicle = (owner, o = {}) => { const [make, model] = r.pick(VEHICLES); return add('vehicle', { country: s.country, iso2: s.iso2, plate: L.plate(r), make, model, color: r.pick(COLORS), year: r.int(2012, 2025),
        vin: `SYN${HEX(r, 14)}`, owner: o.owner || owner.name, ownerId: o.ownerId || owner.nationalId?.number || null, registrationAddress: o.address || owner.address, registered: `${r.int(2016, 2025)}-0${r.int(1, 9)}-1${r.int(0, 9)}`,
        usedBy: o.usedBy || null, _truth: o.truth || owner.id }); };
      if (r.chance(cov.vehicle)) { if (r.chance(0.4)) vehicle(sib, { truth: assoc.id }); else vehicle(assoc); }
      if (r.chance(cov.vehicle + 0.2)) vehicle(driver, r.chance(0.5) ? { owner: `${s.city} Executive Limousine Co. (fictional)`, ownerId: `CR-${D(r, 7)}`, address: `${tw.hotelName}, ${s.city}, ${s.country}`, truth: driver.id } : {});
    });

    poi.localSims = poiLocalSims;
    poi.track = track.sort((a, b) => a.ts.localeCompare(b.ts));
    poi.route = stops.map(s => ({ city: s.city, country: s.country, date: s.date, nights: s.nights }));
    poi.knownSelectors = [{ t: 'name', v: poi.name }, { t: 'passport', v: poi.passport.number }];
    del.poiId = poi.id;
  });

  // Ground-truth coverage per person (for the answer key)
  const idx = Object.fromEntries(persons.map(p => [p.id, Object.fromEntries(DATASETS.map(k => [k, 0]))]));
  for (const k of DATASETS) for (const rec of ds[k]) for (const t of [rec._truth, rec._truthB, ...(rec._truthAlso || [])]) if (t && idx[t]) idx[t][k]++;
  for (const p of persons) { p.coverage = idx[p.id]; p.absentFrom = DATASETS.filter(k => !idx[p.id][k]); }

  return { generatedAt: new Date(now).toISOString(), seed, synthetic: true, delegations: synDelegations, events: synEvents, persons, datasets: ds, towers: ctx.towerList,
    counts: Object.fromEntries(DATASETS.map(k => [k, ds[k].length])), labels: DATASET_LABELS,
    notice: 'SYNTHETIC — every person, identifier and record here is fictional, generated for scenario-building. Phones use the 555-01xx test block, IMSIs the ITU test MCC 001, IMEIs a 00 TAC, e-mails *.example.test, cards are public test numbers.' };
}

function startDate(spec, now) {
  if (spec.date) return spec.date;
  return new Date(now + Number(spec.offsetDays ?? -14) * DAY).toISOString().slice(0, 10);
}

export function buildScenarioDelegations(scenario, now = Date.now()) {
  return (scenario.delegations || []).map(d => {
    let date = startDate(d, now);
    const stops = (d.stops || []).map((s, i) => {
      const p = placeByCity(s.city) || (Number.isFinite(s.lat) ? { city: s.city, country: s.country, iso2: s.iso2, lat: s.lat, lon: s.lon } : null);
      if (!p) return null;
      const stop = { id: `${d.id}-${i + 1}`, seq: i + 1, date: s.date || date, nights: s.nights || 2, ...p, precision: 'city', meetings: s.meetings || [],
        sources: [{ headline: `SYNTHETIC scenario stop — ${d.label}`, outlet: 'Scenario file', url: '', date: s.date || date }], synthetic: true };
      date = addDays(stop.date, stop.nights);
      return stop;
    }).filter(Boolean);
    return { id: d.id, label: d.label, leader: d.leader || null, category: d.category || 'Economic / Trade', source: 'synthetic', synthetic: true, stops,
      countries: [...new Set(stops.map(s => s.country))], first: stops[0]?.date, last: stops.at(-1)?.date };
  });
}

export function buildScenarioEvents(scenario, synDelegations, now = Date.now()) {
  const out = [];
  for (const e of scenario.events || []) {
    const p = placeByCity(e.city);
    if (!p) continue;
    let date = e.date;
    if (!date && e.delegation) { const s = synDelegations.find(d => d.id === e.delegation)?.stops.find(x => x.city === p.city); if (s) date = addDays(s.date, Number(e.dayOffset ?? 1)); }
    if (!date) date = startDate(e, now);
    out.push({ id: `syn-ev-${out.length + 1}`, kind: 'event', source: 'synthetic', synthetic: true, date, ...p, precision: 'city', host: e.host, headline: e.title, outlet: 'Scenario file', url: '', venue: e.venue || null });
  }
  return out;
}

// ── Selector pivot (cross-dataset inference) ─────────────────────────────────────────────────
const norm = (t, v) => (t === 'phone' || t === 'imsi' || t === 'imei') ? digits(v) : String(v || '').trim().toLowerCase();
export function selectorsOf(kind, r) {
  const s = [];
  const push = (t, v) => { if (v) s.push({ t, v: String(v) }); };
  if (kind === 'travel') {
    push('pnr', r.pnr); push('phone', r.bookingContact?.phone); push('email', r.bookingContact?.email); push('name', r.payment?.cardholder);
    for (const p of r.passengers || []) { push('name', p.name); push('passport', p.passport); push('phone', p.phone); push('email', p.email); push('rewards', p.rewards?.number); }
  } else if (kind === 'border') {
    push('name', r.name); push('passport', r.passport?.number); push('visa', r.visa?.number);
    const a = r.visa?.application; if (a) { push('address', a.addressStaying); push('phone', a.phone); push('email', a.email); for (const f of a.familyMembers || []) push('name', f); }
  } else if (kind === 'ss7') { push('phone', r.msisdn); push('imsi', r.imsi); push('imei', r.imei); }
  else if (kind === 'cdr') { push('phone', r.aParty?.msisdn); push('imsi', r.aParty?.imsi); push('imei', r.aParty?.imei); push('name', r.aParty?.registeredName); push('phone', r.bParty?.msisdn); push('name', r.bParty?.registeredName); }
  else if (kind === 'voter') { push('name', r.fullName); push('nationalId', r.idDocument?.number); push('address', r.address); push('phone', r.phone); push('email', r.email); push('familyId', r.familyRegistryNo); push('name', r.fatherName); push('name', r.motherName); }
  else if (kind === 'vehicle') { push('name', r.owner); push('nationalId', r.ownerId); push('address', r.registrationAddress); push('plate', r.plate); }
  return s.map(x => ({ ...x, k: `${x.t}:${norm(x.t, x.v)}` }));
}

// BFS from seed selectors over shared identifiers. Selector values seen in more than `commonCap`
// records (hotel addresses, company cardholders, airport-wide values) are reported but not expanded.
// Parent/registry names on a voter record don't expand (they describe someone else).
export function pivot(syn, seeds, { maxHops = 3, commonCap = 14 } = {}) {
  const recs = [];
  for (const k of DATASETS) for (const r of syn.datasets[k] || []) recs.push({ kind: k, rec: r, sel: selectorsOf(k, r) });
  const freq = new Map();
  for (const x of recs) for (const k of new Set(x.sel.map(s => s.k))) freq.set(k, (freq.get(k) || 0) + 1);
  const known = new Map(seeds.map(s => [`${s.t}:${norm(s.t, s.v)}`, { t: s.t, v: s.v, hop: 0, via: null }]));
  const hit = new Map();
  let frontier = [...known.keys()];
  for (let hop = 0; hop <= maxHops && frontier.length; hop++) {
    const fset = new Set(frontier); const next = [];
    for (const x of recs) {
      if (hit.has(x.rec.id)) continue;
      const m = x.sel.find(s => fset.has(s.k));
      if (!m) continue;
      hit.set(x.rec.id, { kind: x.kind, id: x.rec.id, hop, via: { t: m.t, v: m.v } });
      if (hop === maxHops) continue;
      for (const s of x.sel) {
        if (known.has(s.k)) continue;
        if (x.kind === 'voter' && s.t === 'name' && norm('name', s.v) !== norm('name', x.rec.fullName)) continue;
        const common = (freq.get(s.k) || 0) > commonCap;
        known.set(s.k, { t: s.t, v: s.v, hop: hop + 1, via: { record: x.rec.id, kind: x.kind }, common });
        if (!common) next.push(s.k);
      }
    }
    frontier = next;
  }
  const records = [...hit.values()].sort((a, b) => a.hop - b.hop || a.kind.localeCompare(b.kind));
  const byKind = Object.fromEntries(DATASETS.map(k => [k, records.filter(r => r.kind === k).length]));
  return { seeds, records, selectors: [...known.values()].sort((a, b) => a.hop - b.hop), byKind, notFound: DATASETS.filter(k => !byKind[k]) };
}
