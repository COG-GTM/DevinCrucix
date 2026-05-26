// Nuclear Facilities — Global Critical Infrastructure Layer
// Comprehensive dataset of nuclear power plants worldwide with coordinates,
// reactor counts, capacity, operator, and status.
// Data aggregated from IAEA PRIS, Wikipedia, and Osiris OSINT platform.
// FREE — no API key required (static dataset + optional live enrichment)

import { safeFetch } from '../utils/fetch.mjs';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (data changes rarely)
let _cache = null;
let _cacheTs = 0;

// Global nuclear power plant dataset — coordinates, capacity, reactor count, operator
const FACILITIES = [
  // ── Ukraine ──
  { name: 'Zaporizhzhia NPP', country: 'UA', lat: 47.507, lng: 34.585, reactors: 6, capacityMW: 5700, operator: 'Energoatom', status: 'occupied', risk: 'critical' },
  { name: 'Rivne NPP', country: 'UA', lat: 51.324, lng: 25.895, reactors: 4, capacityMW: 2835, operator: 'Energoatom', status: 'operational' },
  { name: 'South Ukraine NPP', country: 'UA', lat: 47.817, lng: 31.217, reactors: 3, capacityMW: 3000, operator: 'Energoatom', status: 'operational' },
  { name: 'Khmelnytskyi NPP', country: 'UA', lat: 50.301, lng: 26.649, reactors: 2, capacityMW: 2000, operator: 'Energoatom', status: 'operational' },

  // ── Russia ──
  { name: 'Kursk NPP', country: 'RU', lat: 51.672, lng: 35.608, reactors: 4, capacityMW: 4000, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Leningrad NPP', country: 'RU', lat: 59.834, lng: 29.051, reactors: 4, capacityMW: 4200, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Novovoronezh NPP', country: 'RU', lat: 51.273, lng: 39.217, reactors: 6, capacityMW: 3710, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Kalinin NPP', country: 'RU', lat: 57.782, lng: 35.095, reactors: 4, capacityMW: 4000, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Balakovo NPP', country: 'RU', lat: 52.093, lng: 47.961, reactors: 4, capacityMW: 4000, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Rostov NPP', country: 'RU', lat: 47.393, lng: 42.093, reactors: 4, capacityMW: 4030, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Kola NPP', country: 'RU', lat: 67.463, lng: 32.476, reactors: 4, capacityMW: 1760, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Beloyarsk NPP', country: 'RU', lat: 56.844, lng: 61.321, reactors: 2, capacityMW: 1485, operator: 'Rosenergoatom', status: 'operational' },
  { name: 'Smolensk NPP', country: 'RU', lat: 54.155, lng: 33.245, reactors: 3, capacityMW: 3000, operator: 'Rosenergoatom', status: 'operational' },

  // ── France (largest in Europe) ──
  { name: 'Gravelines NPP', country: 'FR', lat: 51.015, lng: 2.107, reactors: 6, capacityMW: 5460, operator: 'EDF', status: 'operational' },
  { name: 'Paluel NPP', country: 'FR', lat: 49.859, lng: 0.633, reactors: 4, capacityMW: 5320, operator: 'EDF', status: 'operational' },
  { name: 'Cattenom NPP', country: 'FR', lat: 49.407, lng: 6.219, reactors: 4, capacityMW: 5200, operator: 'EDF', status: 'operational' },
  { name: 'Saint-Alban NPP', country: 'FR', lat: 45.405, lng: 4.754, reactors: 2, capacityMW: 2670, operator: 'EDF', status: 'operational' },
  { name: 'Tricastin NPP', country: 'FR', lat: 44.332, lng: 4.731, reactors: 4, capacityMW: 3660, operator: 'EDF', status: 'operational' },
  { name: 'Flamanville NPP', country: 'FR', lat: 49.537, lng: -1.881, reactors: 3, capacityMW: 3960, operator: 'EDF', status: 'operational' },
  { name: 'Bugey NPP', country: 'FR', lat: 45.798, lng: 5.270, reactors: 4, capacityMW: 3580, operator: 'EDF', status: 'operational' },
  { name: 'Chinon NPP', country: 'FR', lat: 47.230, lng: 0.169, reactors: 4, capacityMW: 3620, operator: 'EDF', status: 'operational' },
  { name: 'Cruas NPP', country: 'FR', lat: 44.633, lng: 4.757, reactors: 4, capacityMW: 3660, operator: 'EDF', status: 'operational' },
  { name: 'Dampierre NPP', country: 'FR', lat: 47.732, lng: 2.518, reactors: 4, capacityMW: 3600, operator: 'EDF', status: 'operational' },
  { name: 'Golfech NPP', country: 'FR', lat: 44.107, lng: 0.845, reactors: 2, capacityMW: 2620, operator: 'EDF', status: 'operational' },
  { name: 'Civaux NPP', country: 'FR', lat: 46.445, lng: 0.660, reactors: 2, capacityMW: 2990, operator: 'EDF', status: 'operational' },

  // ── United States ──
  { name: 'Palo Verde NGS', country: 'US', lat: 33.388, lng: -112.862, reactors: 3, capacityMW: 3937, operator: 'Arizona Public Service', status: 'operational' },
  { name: 'South Texas Project', country: 'US', lat: 28.795, lng: -96.048, reactors: 2, capacityMW: 2710, operator: 'STP Nuclear Operating', status: 'operational' },
  { name: 'Vogtle Electric', country: 'US', lat: 33.142, lng: -81.764, reactors: 4, capacityMW: 4540, operator: 'Southern Nuclear', status: 'operational' },
  { name: 'Braidwood Station', country: 'US', lat: 41.241, lng: -88.228, reactors: 2, capacityMW: 2386, operator: 'Constellation Energy', status: 'operational' },
  { name: 'Byron Station', country: 'US', lat: 42.075, lng: -89.281, reactors: 2, capacityMW: 2346, operator: 'Constellation Energy', status: 'operational' },
  { name: 'Calvert Cliffs', country: 'US', lat: 38.432, lng: -76.441, reactors: 2, capacityMW: 1756, operator: 'Constellation Energy', status: 'operational' },
  { name: 'Limerick Station', country: 'US', lat: 40.224, lng: -75.589, reactors: 2, capacityMW: 2264, operator: 'Constellation Energy', status: 'operational' },
  { name: 'Peach Bottom', country: 'US', lat: 39.759, lng: -76.269, reactors: 2, capacityMW: 2770, operator: 'Constellation Energy', status: 'operational' },
  { name: 'Diablo Canyon', country: 'US', lat: 35.211, lng: -120.854, reactors: 2, capacityMW: 2256, operator: 'Pacific Gas & Electric', status: 'operational' },
  { name: 'Watts Bar', country: 'US', lat: 35.604, lng: -84.793, reactors: 2, capacityMW: 2330, operator: 'TVA', status: 'operational' },
  { name: 'Browns Ferry', country: 'US', lat: 34.704, lng: -87.119, reactors: 3, capacityMW: 3494, operator: 'TVA', status: 'operational' },

  // ── China (rapidly expanding) ──
  { name: 'Daya Bay NPP', country: 'CN', lat: 22.597, lng: 114.546, reactors: 6, capacityMW: 6120, operator: 'CGN', status: 'operational' },
  { name: 'Tianwan NPP', country: 'CN', lat: 34.687, lng: 119.459, reactors: 8, capacityMW: 8060, operator: 'CNNC', status: 'operational' },
  { name: 'Hongyanhe NPP', country: 'CN', lat: 39.793, lng: 121.478, reactors: 6, capacityMW: 6710, operator: 'CGN', status: 'operational' },
  { name: 'Fuqing NPP', country: 'CN', lat: 25.444, lng: 119.434, reactors: 6, capacityMW: 6620, operator: 'CNNC', status: 'operational' },
  { name: 'Yangjiang NPP', country: 'CN', lat: 21.713, lng: 112.257, reactors: 6, capacityMW: 6516, operator: 'CGN', status: 'operational' },
  { name: 'Taishan NPP', country: 'CN', lat: 21.918, lng: 112.983, reactors: 2, capacityMW: 3520, operator: 'CGN/EDF', status: 'operational' },
  { name: 'Haiyang NPP', country: 'CN', lat: 36.688, lng: 121.153, reactors: 2, capacityMW: 2500, operator: 'SPIC', status: 'operational' },
  { name: 'Sanmen NPP', country: 'CN', lat: 29.095, lng: 121.432, reactors: 2, capacityMW: 2500, operator: 'CNNC', status: 'operational' },

  // ── United Kingdom ──
  { name: 'Hinkley Point C', country: 'GB', lat: 51.208, lng: -3.130, reactors: 2, capacityMW: 3260, operator: 'EDF Energy', status: 'under construction' },
  { name: 'Sizewell B', country: 'GB', lat: 52.216, lng: 1.619, reactors: 1, capacityMW: 1198, operator: 'EDF Energy', status: 'operational' },
  { name: 'Torness', country: 'GB', lat: 55.970, lng: -2.395, reactors: 2, capacityMW: 1185, operator: 'EDF Energy', status: 'decommissioning' },
  { name: 'Heysham 2', country: 'GB', lat: 54.029, lng: -2.912, reactors: 2, capacityMW: 1230, operator: 'EDF Energy', status: 'operational' },

  // ── Japan ──
  { name: 'Kashiwazaki-Kariwa', country: 'JP', lat: 37.427, lng: 138.597, reactors: 7, capacityMW: 8212, operator: 'TEPCO', status: 'restart pending' },
  { name: 'Ohi NPP', country: 'JP', lat: 35.541, lng: 135.657, reactors: 4, capacityMW: 4710, operator: 'Kansai Electric', status: 'operational' },
  { name: 'Takahama NPP', country: 'JP', lat: 35.523, lng: 135.514, reactors: 4, capacityMW: 3392, operator: 'Kansai Electric', status: 'operational' },
  { name: 'Sendai NPP', country: 'JP', lat: 31.836, lng: 130.189, reactors: 2, capacityMW: 1780, operator: 'Kyushu Electric', status: 'operational' },
  { name: 'Genkai NPP', country: 'JP', lat: 33.513, lng: 129.837, reactors: 4, capacityMW: 3478, operator: 'Kyushu Electric', status: 'operational' },

  // ── South Korea ──
  { name: 'Hanbit (Yeonggwang)', country: 'KR', lat: 35.412, lng: 126.416, reactors: 6, capacityMW: 5875, operator: 'KHNP', status: 'operational' },
  { name: 'Hanul (Ulchin)', country: 'KR', lat: 37.092, lng: 129.383, reactors: 6, capacityMW: 6190, operator: 'KHNP', status: 'operational' },
  { name: 'Kori / Shin-Kori', country: 'KR', lat: 35.320, lng: 129.295, reactors: 7, capacityMW: 7411, operator: 'KHNP', status: 'operational' },
  { name: 'Wolsong', country: 'KR', lat: 35.712, lng: 129.476, reactors: 4, capacityMW: 2779, operator: 'KHNP', status: 'operational' },

  // ── India ──
  { name: 'Kudankulam NPP', country: 'IN', lat: 8.166, lng: 77.712, reactors: 2, capacityMW: 2000, operator: 'NPCIL', status: 'operational' },
  { name: 'Tarapur MAPS', country: 'IN', lat: 19.835, lng: 72.634, reactors: 4, capacityMW: 1400, operator: 'NPCIL', status: 'operational' },
  { name: 'Rawatbhata RAPS', country: 'IN', lat: 24.881, lng: 75.586, reactors: 6, capacityMW: 1180, operator: 'NPCIL', status: 'operational' },
  { name: 'Kakrapar KAPS', country: 'IN', lat: 21.236, lng: 73.351, reactors: 4, capacityMW: 1480, operator: 'NPCIL', status: 'operational' },

  // ── Other ──
  { name: 'Barakah NPP', country: 'AE', lat: 23.960, lng: 52.260, reactors: 4, capacityMW: 5380, operator: 'ENEC/Nawah', status: 'operational' },
  { name: 'Akkuyu NPP', country: 'TR', lat: 36.142, lng: 33.536, reactors: 4, capacityMW: 4800, operator: 'Rosatom/Akkuyu', status: 'under construction' },
  { name: 'Cernavodă NPP', country: 'RO', lat: 44.319, lng: 28.058, reactors: 2, capacityMW: 1310, operator: 'Nuclearelectrica', status: 'operational' },
  { name: 'Mochovce NPP', country: 'SK', lat: 48.278, lng: 18.440, reactors: 4, capacityMW: 1960, operator: 'Slovenské elektrárne', status: 'operational' },
  { name: 'Temelin NPP', country: 'CZ', lat: 49.181, lng: 14.375, reactors: 2, capacityMW: 2160, operator: 'ČEZ', status: 'operational' },
  { name: 'Dukovany NPP', country: 'CZ', lat: 49.086, lng: 16.149, reactors: 4, capacityMW: 2040, operator: 'ČEZ', status: 'operational' },
  { name: 'Paks NPP', country: 'HU', lat: 46.573, lng: 18.852, reactors: 4, capacityMW: 2000, operator: 'MVM Paks', status: 'operational' },
  { name: 'Olkiluoto NPP', country: 'FI', lat: 61.235, lng: 21.447, reactors: 3, capacityMW: 4390, operator: 'TVO', status: 'operational' },
  { name: 'Loviisa NPP', country: 'FI', lat: 60.373, lng: 26.356, reactors: 2, capacityMW: 1010, operator: 'Fortum', status: 'operational' },
  { name: 'Ringhals NPP', country: 'SE', lat: 57.264, lng: 12.113, reactors: 3, capacityMW: 3718, operator: 'Vattenfall', status: 'operational' },
  { name: 'Forsmark NPP', country: 'SE', lat: 60.408, lng: 18.168, reactors: 3, capacityMW: 3275, operator: 'Vattenfall', status: 'operational' },
  { name: 'Oskarshamn NPP', country: 'SE', lat: 57.415, lng: 16.666, reactors: 1, capacityMW: 1450, operator: 'OKG', status: 'operational' },
  { name: 'Bruce Power', country: 'CA', lat: 44.327, lng: -81.593, reactors: 8, capacityMW: 6384, operator: 'Bruce Power', status: 'operational' },
  { name: 'Darlington NGS', country: 'CA', lat: 43.872, lng: -78.717, reactors: 4, capacityMW: 3512, operator: 'Ontario Power', status: 'operational' },
  { name: 'Pickering NGS', country: 'CA', lat: 43.814, lng: -79.065, reactors: 6, capacityMW: 3100, operator: 'Ontario Power', status: 'operational' },
  { name: 'Angra NPP', country: 'BR', lat: -23.008, lng: -44.457, reactors: 2, capacityMW: 1884, operator: 'Eletronuclear', status: 'operational' },
  { name: 'Atucha NPP', country: 'AR', lat: -33.966, lng: -59.209, reactors: 2, capacityMW: 1045, operator: 'Nucleoeléctrica Argentina', status: 'operational' },
  { name: 'Koeberg NPP', country: 'ZA', lat: -33.677, lng: 18.435, reactors: 2, capacityMW: 1860, operator: 'Eskom', status: 'operational' },
  { name: 'Bushehr NPP', country: 'IR', lat: 28.831, lng: 50.887, reactors: 1, capacityMW: 1000, operator: 'AEOI', status: 'operational' },
  { name: 'KANUPP', country: 'PK', lat: 24.842, lng: 66.780, reactors: 3, capacityMW: 1690, operator: 'PAEC', status: 'operational' },
  { name: 'Chashma NPP', country: 'PK', lat: 32.382, lng: 71.470, reactors: 4, capacityMW: 1330, operator: 'PAEC', status: 'operational' },
];

export async function fetchNuclearFacilities() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  const facilities = FACILITIES.map(f => ({
    ...f,
    id: `nuke-${f.country}-${f.name.replace(/\s+/g, '-').toLowerCase()}`,
  }));

  // Compute summary stats
  const byCountry = {};
  let totalReactors = 0;
  let totalCapacity = 0;
  const statusCounts = {};

  for (const f of facilities) {
    if (!byCountry[f.country]) byCountry[f.country] = { count: 0, reactors: 0, capacityMW: 0 };
    byCountry[f.country].count++;
    byCountry[f.country].reactors += f.reactors;
    byCountry[f.country].capacityMW += f.capacityMW;
    totalReactors += f.reactors;
    totalCapacity += f.capacityMW;
    statusCounts[f.status] = (statusCounts[f.status] || 0) + 1;
  }

  // Generate signals for high-risk facilities
  const signals = [];
  const criticalFacilities = facilities.filter(f => f.risk === 'critical' || f.status === 'occupied');
  for (const f of criticalFacilities) {
    signals.push({
      severity: 'critical',
      signal: `${f.name} (${f.country}) — Status: ${f.status}. ${f.reactors} reactors, ${f.capacityMW}MW capacity at risk.`,
    });
  }

  const result = {
    source: 'NuclearFacilities',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalFacilities: facilities.length,
    totalReactors,
    totalCapacityMW: totalCapacity,
    byCountry,
    statusCounts,
    facilities,
    signals,
  };

  _cache = result;
  _cacheTs = Date.now();
  return result;
}

export async function briefing() {
  return fetchNuclearFacilities();
}

if (process.argv[1]?.endsWith('nuclear.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
