// Region Dossier — Right-click country intelligence brief
// Reverse geocode coordinates → country data → Wikipedia summary → head of state
// Ported from Osiris OSINT platform's region-dossier API
// FREE — no API key required (uses Nominatim, RestCountries, Wikipedia, Wikidata)
// Designed for interactive "click anywhere on globe → get intelligence brief" UX

import { safeFetch } from '../utils/fetch.mjs';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const RESTCOUNTRIES_URL = 'https://restcountries.com/v3.1/alpha';
const WIKIPEDIA_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const WIKIDATA_URL = 'https://query.wikidata.org/sparql';

// Rate limiter: Nominatim requires max 1 req/sec
let _lastNominatimCall = 0;

async function rateLimitedGeocode(lat, lng) {
  const now = Date.now();
  const elapsed = now - _lastNominatimCall;
  if (elapsed < 1100) {
    await new Promise(r => setTimeout(r, 1100 - elapsed));
  }
  _lastNominatimCall = Date.now();

  const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lng}&format=json&zoom=5&accept-language=en`;
  return safeFetch(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'CRUCIX Intelligence Engine/1.0' },
  });
}

async function fetchCountryData(code) {
  const url = `${RESTCOUNTRIES_URL}/${code}`;
  return safeFetch(url, { timeout: 8000 });
}

async function fetchWikiSummary(countryName) {
  const slug = countryName.replace(/\s+/g, '_');
  const url = `${WIKIPEDIA_URL}/${encodeURIComponent(slug)}`;
  return safeFetch(url, { timeout: 8000 });
}

async function fetchHeadOfState(countryName) {
  const query = `
    SELECT ?leader ?leaderLabel ?posLabel WHERE {
      ?country rdfs:label "${countryName}"@en .
      ?country wdt:P31 wd:Q6256 .
      ?country wdt:P35 ?leader .
      ?leader wdt:P39 ?pos .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
    }
    LIMIT 1
  `;
  const url = `${WIKIDATA_URL}?query=${encodeURIComponent(query)}&format=json`;
  return safeFetch(url, { timeout: 10000 });
}

export async function getRegionDossier(lat, lng) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    return { error: 'Invalid coordinates', status: 'error' };
  }

  // Step 1: Reverse geocode
  const geocode = await rateLimitedGeocode(lat, lng);
  if (geocode.error) {
    return {
      source: 'RegionDossier',
      status: 'partial',
      lat, lng,
      error: `Geocode failed: ${geocode.error}`,
      location: null,
    };
  }

  const countryCode = geocode.address?.country_code?.toUpperCase() || '';
  const countryName = geocode.address?.country || '';
  const displayName = geocode.display_name || '';

  // Steps 2-4: Parallel fetch country data, Wikipedia, head of state
  const [countryResult, wikiResult, hosResult] = await Promise.allSettled([
    countryCode ? fetchCountryData(countryCode) : Promise.resolve(null),
    countryName ? fetchWikiSummary(countryName) : Promise.resolve(null),
    countryName ? fetchHeadOfState(countryName) : Promise.resolve(null),
  ]);

  // Parse country data
  let countryInfo = null;
  if (countryResult.status === 'fulfilled' && countryResult.value) {
    const c = Array.isArray(countryResult.value) ? countryResult.value[0] : countryResult.value;
    if (c && !c.error) {
      countryInfo = {
        name: c.name?.common || countryName,
        officialName: c.name?.official || '',
        capital: c.capital?.[0] || '',
        region: c.region || '',
        subregion: c.subregion || '',
        population: c.population || 0,
        area: c.area || 0,
        languages: c.languages ? Object.values(c.languages).join(', ') : '',
        currencies: c.currencies ? Object.entries(c.currencies).map(([k, v]) => `${v.name} (${k})`).join(', ') : '',
        flag: c.flag || '',
        flagUrl: c.flags?.png || '',
        timezones: c.timezones || [],
        borders: c.borders || [],
        un: c.unMember || false,
        landlocked: c.landlocked || false,
        drivingSide: c.car?.side || '',
      };
    }
  }

  // Parse Wikipedia summary
  let wikiSummary = null;
  if (wikiResult.status === 'fulfilled' && wikiResult.value && !wikiResult.value.error) {
    const w = wikiResult.value;
    wikiSummary = {
      title: w.title || '',
      extract: (w.extract || '').substring(0, 500),
      thumbnail: w.thumbnail?.source || '',
      url: w.content_urls?.desktop?.page || '',
    };
  }

  // Parse head of state
  let headOfState = null;
  if (hosResult.status === 'fulfilled' && hosResult.value && !hosResult.value.error) {
    const bindings = hosResult.value?.results?.bindings || [];
    if (bindings.length > 0) {
      headOfState = {
        name: bindings[0].leaderLabel?.value || '',
        position: bindings[0].posLabel?.value || '',
      };
    }
  }

  return {
    source: 'RegionDossier',
    timestamp: new Date().toISOString(),
    status: 'live',
    lat, lng,
    location: {
      displayName,
      countryCode,
      countryName,
      state: geocode.address?.state || '',
      city: geocode.address?.city || geocode.address?.town || geocode.address?.village || '',
    },
    country: countryInfo,
    wikipedia: wikiSummary,
    headOfState,
  };
}

export async function briefing() {
  return {
    source: 'RegionDossier',
    status: 'ready',
    timestamp: new Date().toISOString(),
    description: 'On-demand endpoint — query via /api/region-dossier?lat=X&lng=Y',
  };
}

if (process.argv[1]?.endsWith('regiondossier.mjs')) {
  // Test with Washington DC
  const data = await getRegionDossier(38.9, -77.0);
  console.log(JSON.stringify(data, null, 2));
}
