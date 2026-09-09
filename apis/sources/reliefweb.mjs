// ReliefWeb — UN OCHA humanitarian crisis tracking
// API v2 requires an approved appname (v1 was decommissioned, HTTP 410).
// Register at https://apidoc.reliefweb.int/parameters#appname and set RELIEFWEB_APPNAME.
// Fallback chain: API v2 → public RSS feeds (updates + disasters) → HDX dataset search.

import { safeFetch } from '../utils/fetch.mjs';
import { parseFeed, stripTags } from '../utils/rss.mjs';
import { safeOutboundFetch } from '../../lib/safeOutboundFetch.mjs';

const BASE = 'https://api.reliefweb.int/v2';
const APPNAME = process.env.RELIEFWEB_APPNAME || '';
const UA = 'CRUCIX/2.0 (+https://github.com/COG-GTM/DevinCrucix)';

const RSS_UPDATES = 'https://reliefweb.int/updates/rss.xml';
const RSS_DISASTERS = 'https://reliefweb.int/disasters/rss.xml';
const HDX_BASE = 'https://data.humdata.org/api/3/action';

function classifyError(msg = '') {
  if (/HTTP 403/.test(msg)) return 'appname not approved (403)';
  if (/HTTP 406|bot activity/i.test(msg)) return 'blocked as bot (406)';
  if (/HTTP 410/.test(msg)) return 'API version decommissioned (410)';
  if (/HTTP 429/.test(msg)) return 'rate limited (429)';
  if (/abort/i.test(msg)) return 'timed out';
  const m = msg.match(/HTTP (\d{3})/);
  return m ? `HTTP ${m[1]}` : 'fetch failed';
}

// POST-based search (ReliefWeb API v2)
async function rwPost(endpoint, body) {
  const url = `${BASE}/${endpoint}?appname=${encodeURIComponent(APPNAME)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await safeOutboundFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    return { error: e.message, source: `${BASE}/${endpoint}` };
  }
}

export async function searchReports(opts = {}) {
  const { query = '', limit = 15 } = opts;
  const body = {
    limit,
    fields: { include: ['title', 'date.created', 'country.name', 'disaster_type.name', 'url_alias', 'source.name'] },
    sort: ['date.created:desc'],
  };
  if (query) body.query = { value: query };
  return rwPost('reports', body);
}

export async function getDisasters(opts = {}) {
  const { limit = 15 } = opts;
  return rwPost('disasters', {
    limit,
    fields: { include: ['name', 'date.created', 'country.name', 'type.name', 'status', 'url_alias'] },
    filter: { field: 'status', value: 'ongoing' },
    sort: ['date.created:desc'],
  });
}

// RSS item descriptions carry tagged metadata blocks such as
// <div class="tag country">Country: Nepal</div> / "Affected country: ..." / "Sources: A, B" / "Disaster type: Flood".
export function parseRssTags(rawDescription = '') {
  const out = {};
  const re = /<div class="tag ([a-z_-]+)">([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(rawDescription)) !== null) {
    const text = stripTags(m[2]);
    const value = text.includes(':') ? text.slice(text.indexOf(':') + 1).trim() : text;
    out[m[1].toLowerCase()] = value.split(/,\s*/).map(s => s.trim()).filter(Boolean);
  }
  const summary = stripTags(rawDescription.replace(/<div class="tag[\s\S]*?<\/div>/gi, '').replace(/<img[^>]*>/gi, ''))
    .replace(/^Please refer to the attached file\.?\s*/i, '');
  return { tags: out, summary: summary.slice(0, 300) };
}

export function reportsFromRss(xml, limit = 15) {
  return parseFeed(xml).slice(0, limit).map(it => {
    const { tags, summary } = parseRssTags(it.rawDescription);
    return {
      title: it.title,
      date: it.published,
      countries: tags.country || tags['affected-country'] || [],
      disasterType: tags['disaster-type'] || tags.disaster_type || [],
      source: tags.source || [],
      summary,
      url: it.link || null,
    };
  });
}

// GLIDE number hazard prefixes (https://glidenumber.net)
const GLIDE_TYPES = {
  CW: 'Cold Wave', CE: 'Complex Emergency', DR: 'Drought', EQ: 'Earthquake', EP: 'Epidemic',
  EC: 'Extratropical Cyclone', ET: 'Extreme Temperature', FA: 'Famine', FR: 'Fire', FF: 'Flash Flood',
  FL: 'Flood', HT: 'Heat Wave', IN: 'Insect Infestation', LS: 'Land Slide', MS: 'Mud Slide',
  OT: 'Other', ST: 'Severe Local Storm', SL: 'Slide', SN: 'Snow Avalanche', AC: 'Tech. Disaster',
  TO: 'Tornado', TC: 'Tropical Cyclone', TS: 'Tsunami', VO: 'Volcano', VW: 'Violent Wind', WV: 'Wave/Surge', WF: 'Wild Fire',
};

function typeFromGlide(glide = []) {
  return glide.map(g => GLIDE_TYPES[String(g).slice(0, 2).toUpperCase()]).filter(Boolean);
}

export function disastersFromRss(xml, limit = 15) {
  return parseFeed(xml).slice(0, limit).map(it => {
    const { tags } = parseRssTags(it.rawDescription);
    const type = tags['disaster-type'] || tags.disaster_type || tags.type || typeFromGlide(tags.glide);
    return {
      name: it.title,
      date: it.published,
      countries: tags.country || tags['affected-country'] || [],
      type,
      glide: tags.glide?.[0] || null,
      status: (tags.status && tags.status[0]) || 'ongoing',
      url: it.link || null,
    };
  });
}

async function fetchRss(url) {
  const data = await safeFetch(url, { timeout: 15000, retries: 0, headers: { 'User-Agent': UA } });
  if (data?.error) return { error: data.error };
  const text = data?.rawText;
  if (!text || !/<(rss|feed)[\s>]/i.test(text)) return { error: 'non-RSS response' };
  return { text };
}

// Fallback: search HDX (Humanitarian Data Exchange) for crisis datasets
async function hdxFallback(limit = 15) {
  const data = await safeFetch(
    `${HDX_BASE}/package_search?q=crisis+OR+disaster+OR+emergency&rows=${limit}&sort=metadata_modified+desc`,
    { headers: { 'User-Agent': UA } }
  );
  if (data?.result?.results) {
    return data.result.results.map(pkg => ({
      title: pkg.title,
      date: pkg.metadata_modified,
      source: pkg.dataset_source || pkg.organization?.title,
      countries: pkg.groups?.map(g => g.display_name),
      url: `https://data.humdata.org/dataset/${pkg.name}`,
    }));
  }
  return [];
}

function fromApi(reports, disasters) {
  const latestReports = (reports?.data || []).map(r => ({
    title: r.fields?.title,
    date: r.fields?.date?.created,
    countries: r.fields?.country?.map(c => c.name),
    disasterType: r.fields?.disaster_type?.map(d => d.name),
    source: r.fields?.source?.map(s => s.name),
    url: r.fields?.url_alias ? `https://reliefweb.int${r.fields.url_alias}` : null,
  }));
  const activeDisasters = (disasters?.data || []).map(d => ({
    name: d.fields?.name,
    date: d.fields?.date?.created,
    countries: d.fields?.country?.map(c => c.name),
    type: d.fields?.type?.map(t => t.name),
    status: d.fields?.status,
    url: d.fields?.url_alias ? `https://reliefweb.int${d.fields.url_alias}` : null,
  }));
  return { latestReports, activeDisasters };
}

// Briefing — latest humanitarian reports + active disasters
export async function briefing() {
  const timestamp = new Date().toISOString();
  const attempts = [];

  if (APPNAME) {
    const [reports, disasters] = await Promise.all([searchReports({ limit: 15 }), getDisasters({ limit: 15 })]);
    const apiError = reports?.error || disasters?.error;
    if (!apiError) {
      const { latestReports, activeDisasters } = fromApi(reports, disasters);
      if (latestReports.length || activeDisasters.length) {
        return { source: 'ReliefWeb (UN OCHA)', timestamp, method: 'api_v2', latestReports, activeDisasters };
      }
      attempts.push('api v2: empty response');
    } else {
      attempts.push(`api v2: ${classifyError(apiError)}`);
    }
  } else {
    attempts.push('api v2: skipped (RELIEFWEB_APPNAME not set)');
  }

  const [upd, dis] = await Promise.all([fetchRss(RSS_UPDATES), fetchRss(RSS_DISASTERS)]);
  const latestReports = upd.text ? reportsFromRss(upd.text) : [];
  const activeDisasters = dis.text ? disastersFromRss(dis.text) : [];
  if (upd.error) attempts.push(`rss updates: ${classifyError(upd.error)}`);
  if (dis.error) attempts.push(`rss disasters: ${classifyError(dis.error)}`);

  if (latestReports.length || activeDisasters.length) {
    const partial = !!(upd.error || dis.error);
    return {
      source: 'ReliefWeb (UN OCHA) — public RSS',
      timestamp,
      method: 'rss',
      status: partial ? 'partial' : undefined,
      latestReports,
      activeDisasters,
      note: partial
        ? `One ReliefWeb feed unavailable (${attempts.slice(-1)[0]}). Set RELIEFWEB_APPNAME for the full API.`
        : 'Public RSS feeds (no appname). Set RELIEFWEB_APPNAME for full API access.',
    };
  }

  const hdxDatasets = await hdxFallback(15);
  return {
    source: 'HDX (Humanitarian Data Exchange) — ReliefWeb fallback',
    timestamp,
    method: 'hdx',
    status: hdxDatasets.length ? 'fallback' : 'unavailable',
    rwError: attempts.join('; '),
    rwNote: 'ReliefWeb API v2 requires an approved appname. Register at https://apidoc.reliefweb.int/parameters#appname and set RELIEFWEB_APPNAME.',
    envVars: ['RELIEFWEB_APPNAME'],
    hdxDatasets,
  };
}

if (process.argv[1]?.endsWith('reliefweb.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
