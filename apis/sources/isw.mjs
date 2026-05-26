// ISW — Institute for the Study of War (understandingwar.org)
// Daily battlefield assessments, theater maps, and conflict analysis
// Source: WordPress REST API (public, no key required)
// Covers: Russia/Ukraine, Middle East/Iran, China/Taiwan, Adversary Entente

import { safeFetch } from '../utils/fetch.mjs';

const ISW_API = 'https://understandingwar.org/wp-json/wp/v2';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let _cache = null;
let _cacheTs = 0;

const THEATER_PATTERNS = [
  { pattern: /russia|ukraine|kremlin|offensive|frontline|fortress/i, theater: 'Russia & Ukraine', region: 'ukraine' },
  { pattern: /iran|middle.?east|hormuz|houthi|yemen|proxy|proxies/i, theater: 'Middle East', region: 'middleEast' },
  { pattern: /china|taiwan|pla|indo.?pacific|south.china.sea/i, theater: 'China & Taiwan', region: 'asiaPacific' },
  { pattern: /adversary|entente|north.korea|dprk/i, theater: 'Adversary Entente', region: 'world' },
  { pattern: /cognitive|warfare|disinformation|propaganda/i, theater: 'Cognitive Warfare', region: 'world' },
];

function classifyTheater(title) {
  for (const { pattern, theater, region } of THEATER_PATTERNS) {
    if (pattern.test(title)) return { theater, region };
  }
  return { theater: 'General', region: 'world' };
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&nbsp;/g, ' ').replace(/\n+/g, ' ').trim();
}

function classifyType(title) {
  if (/assessment|update/i.test(title)) return 'assessment';
  if (/special report/i.test(title)) return 'special_report';
  if (/warning|alert/i.test(title)) return 'warning';
  return 'analysis';
}

export async function fetchISW() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    // Fetch latest assessments and map posts in parallel
    const [postsRaw, mapsRaw] = await Promise.all([
      safeFetch(`${ISW_API}/posts?per_page=15&_fields=id,title,date,link,excerpt,categories`, {
        timeout: 12000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'CRUCIX Intelligence Engine' },
      }),
      safeFetch(`${ISW_API}/map?per_page=10&_fields=id,title,date,link,featured_media`, {
        timeout: 12000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'CRUCIX Intelligence Engine' },
      }),
    ]);

    const posts = Array.isArray(postsRaw) ? postsRaw : [];
    const maps = Array.isArray(mapsRaw) ? mapsRaw : [];

    // Process assessments
    const assessments = posts.map(p => {
      const title = stripHtml(p.title?.rendered || '');
      const excerpt = stripHtml(p.excerpt?.rendered || '').substring(0, 300);
      const { theater, region } = classifyTheater(title);
      return {
        id: `isw-${p.id}`,
        title,
        excerpt,
        date: p.date,
        link: p.link,
        theater,
        region,
        type: classifyType(title),
      };
    });

    // Process maps
    const battleMaps = maps.map(m => {
      const title = stripHtml(m.title?.rendered || '');
      const { theater, region } = classifyTheater(title);
      return {
        id: `isw-map-${m.id}`,
        title,
        date: m.date,
        link: m.link,
        theater,
        region,
        featuredMedia: m.featured_media || null,
      };
    });

    // Theater summary
    const theaterCounts = {};
    assessments.forEach(a => {
      theaterCounts[a.theater] = (theaterCounts[a.theater] || 0) + 1;
    });

    // Signals: identify urgent/special reports
    const signals = assessments
      .filter(a => a.type === 'special_report' || a.type === 'warning')
      .map(a => ({
        type: a.type,
        title: a.title,
        theater: a.theater,
        date: a.date,
        link: a.link,
      }));

    const result = {
      source: 'ISW',
      status: assessments.length > 0 ? 'ok' : 'no_data',
      totalAssessments: assessments.length,
      totalMaps: battleMaps.length,
      assessments,
      battleMaps: battleMaps.slice(0, 6),
      theaterCounts,
      signals,
      lastUpdate: assessments[0]?.date || null,
      attribution: 'Institute for the Study of War (understandingwar.org)',
    };

    _cache = result;
    _cacheTs = Date.now();
    return result;

  } catch (err) {
    console.log(`[ISW] Error: ${err.message}`);
    return _cache || {
      source: 'ISW',
      status: 'error',
      error: err.message,
      totalAssessments: 0,
      totalMaps: 0,
      assessments: [],
      battleMaps: [],
      theaterCounts: {},
      signals: [],
    };
  }
}

export async function briefing() {
  return fetchISW();
}
