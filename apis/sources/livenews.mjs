// Live News Video Embeds — Geolocated global broadcast streams
// 25+ verified YouTube live streams from major broadcasters worldwide
// Ported from Osiris OSINT platform's LiveAlerts component
// FREE — no API key required (YouTube embed URLs)
// Each broadcaster has verified coordinates of their HQ/studio

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (streams rarely change)
let _cache = null;
let _cacheTs = 0;

// Curated list of verified live news streams with geolocated broadcaster positions
const LIVE_STREAMS = [
  // ── United States ──
  { name: 'NBC News NOW', country: 'US', lat: 40.7590, lng: -73.9795, url: 'https://www.youtube.com/embed/dBC0MYfJhPk?autoplay=1&mute=1', network: 'NBC', category: 'mainstream' },
  { name: 'CBS News 24/7', country: 'US', lat: 40.7636, lng: -73.9730, url: 'https://www.youtube.com/embed/nz-LBgFNziw?autoplay=1&mute=1', network: 'CBS', category: 'mainstream' },
  { name: 'ABC News Live', country: 'US', lat: 40.7730, lng: -73.9814, url: 'https://www.youtube.com/embed/GfVz7IU7RUk?autoplay=1&mute=1', network: 'ABC', category: 'mainstream' },
  { name: 'Fox News Live', country: 'US', lat: 40.7587, lng: -73.9787, url: 'https://www.youtube.com/embed/2MUpP6Gu6I4?autoplay=1&mute=1', network: 'Fox', category: 'mainstream' },
  { name: 'Bloomberg TV', country: 'US', lat: 40.7615, lng: -73.9760, url: 'https://www.youtube.com/embed/dp8PhLsUcFE?autoplay=1&mute=1', network: 'Bloomberg', category: 'financial' },
  { name: 'C-SPAN', country: 'US', lat: 38.8951, lng: -77.0364, url: 'https://www.youtube.com/embed/jBDWFJ8OQp0?autoplay=1&mute=1', network: 'C-SPAN', category: 'government' },
  { name: 'PBS NewsHour', country: 'US', lat: 38.8913, lng: -77.0200, url: 'https://www.youtube.com/embed/pT-Fq6ysQME?autoplay=1&mute=1', network: 'PBS', category: 'mainstream' },
  { name: 'Newsmax', country: 'US', lat: 40.7484, lng: -73.9856, url: 'https://www.youtube.com/embed/oMwD_GDKeR8?autoplay=1&mute=1', network: 'Newsmax', category: 'mainstream' },

  // ── United Kingdom ──
  { name: 'Sky News', country: 'GB', lat: 51.4975, lng: -0.1357, url: 'https://www.youtube.com/embed/9Auq9mYxFEE?autoplay=1&mute=1', network: 'Sky', category: 'mainstream' },
  { name: 'BBC News 24', country: 'GB', lat: 51.5181, lng: -0.1441, url: 'https://www.youtube.com/embed/p_-FBB5bFTs?autoplay=1&mute=1', network: 'BBC', category: 'mainstream' },

  // ── Europe ──
  { name: 'France 24 English', country: 'FR', lat: 48.8326, lng: 2.4204, url: 'https://www.youtube.com/embed/IVNMmpwSA3U?autoplay=1&mute=1', network: 'France 24', category: 'international' },
  { name: 'DW News', country: 'DE', lat: 50.7169, lng: 7.1411, url: 'https://www.youtube.com/embed/1fJP6tNuEK4?autoplay=1&mute=1', network: 'DW', category: 'international' },
  { name: 'Euronews', country: 'FR', lat: 45.7826, lng: 4.8658, url: 'https://www.youtube.com/embed/85mSGnfP2NY?autoplay=1&mute=1', network: 'Euronews', category: 'international' },

  // ── Middle East ──
  { name: 'Al Jazeera English', country: 'QA', lat: 25.3152, lng: 51.4917, url: 'https://www.youtube.com/embed/gCNeDWCI0vo?autoplay=1&mute=1', network: 'Al Jazeera', category: 'international' },
  { name: 'TRT World', country: 'TR', lat: 41.0550, lng: 29.0100, url: 'https://www.youtube.com/embed/TV8-dvnq5Rk?autoplay=1&mute=1', network: 'TRT', category: 'international' },
  { name: 'i24NEWS', country: 'IL', lat: 32.0640, lng: 34.7722, url: 'https://www.youtube.com/embed/i7y2hHAT3c0?autoplay=1&mute=1', network: 'i24', category: 'international' },

  // ── Asia-Pacific ──
  { name: 'NHK World Japan', country: 'JP', lat: 35.6654, lng: 139.7298, url: 'https://www.youtube.com/embed/f0ldm52rm0s?autoplay=1&mute=1', network: 'NHK', category: 'international' },
  { name: 'CNA (Channel NewsAsia)', country: 'SG', lat: 1.2966, lng: 103.7764, url: 'https://www.youtube.com/embed/cKU-0ItMm0E?autoplay=1&mute=1', network: 'CNA', category: 'international' },
  { name: 'WION', country: 'IN', lat: 28.5274, lng: 77.0689, url: 'https://www.youtube.com/embed/qF37Rk4k-GE?autoplay=1&mute=1', network: 'WION', category: 'international' },
  { name: 'Arirang TV', country: 'KR', lat: 37.5665, lng: 126.9780, url: 'https://www.youtube.com/embed/2U9VPjxB2aY?autoplay=1&mute=1', network: 'Arirang', category: 'international' },
  { name: 'ABC News Australia', country: 'AU', lat: -33.8404, lng: 151.2068, url: 'https://www.youtube.com/embed/L2WJrccMmwI?autoplay=1&mute=1', network: 'ABC AU', category: 'mainstream' },

  // ── Africa ──
  { name: 'eNCA South Africa', country: 'ZA', lat: -26.1076, lng: 28.0567, url: 'https://www.youtube.com/embed/wa0e3jIkF_A?autoplay=1&mute=1', network: 'eNCA', category: 'regional' },
  { name: 'Channels TV Nigeria', country: 'NG', lat: 6.4474, lng: 3.4163, url: 'https://www.youtube.com/embed/2y6BoZ7DpSI?autoplay=1&mute=1', network: 'Channels', category: 'regional' },
  { name: 'KTN News Kenya', country: 'KE', lat: -1.2920, lng: 36.8219, url: 'https://www.youtube.com/embed/kXd_dK-uHXg?autoplay=1&mute=1', network: 'KTN', category: 'regional' },

  // ── Americas ──
  { name: 'CBC News Canada', country: 'CA', lat: 43.6441, lng: -79.3863, url: 'https://www.youtube.com/embed/I7VTWXhYpYI?autoplay=1&mute=1', network: 'CBC', category: 'mainstream' },
  { name: 'Globo News Brazil', country: 'BR', lat: -22.8532, lng: -43.3151, url: 'https://www.youtube.com/embed/3NWFV4UFPRA?autoplay=1&mute=1', network: 'Globo', category: 'regional' },
];

export async function fetchLiveNews() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  const streams = LIVE_STREAMS.map((s, i) => ({
    id: `live-${s.country.toLowerCase()}-${i}`,
    ...s,
  }));

  // Summarize by region
  const byCountry = {};
  const byCategory = {};
  for (const s of streams) {
    byCountry[s.country] = (byCountry[s.country] || 0) + 1;
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  }

  const result = {
    source: 'LiveNews',
    timestamp: new Date().toISOString(),
    status: 'live',
    totalStreams: streams.length,
    byCountry,
    byCategory,
    streams,
    signals: [],
  };

  _cache = result;
  _cacheTs = Date.now();
  return result;
}

export async function briefing() {
  return fetchLiveNews();
}

if (process.argv[1]?.endsWith('livenews.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
