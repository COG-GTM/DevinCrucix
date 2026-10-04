// Internet disruption — IODA (Georgia Tech Internet Intelligence Lab), free, no key.
// Country- and region-level outage alerts from BGP, active probing and telescope data.
//   https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.ioda.inetintel.cc.gatech.edu/v2/outages';
const WINDOW_HOURS = 24;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function normalizeAlert(a) {
  const e = a?.entity || {};
  const attrs = e.attrs || {};
  const type = e.type === 'region' ? 'region' : e.type === 'country' ? 'country' : null;
  if (!type || !Number.isFinite(a.time)) return null;
  const countryCode = String(type === 'country' ? e.code : attrs.country_code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  const value = Number(a.value), hist = Number(a.historyValue);
  const dropPct = Number.isFinite(value) && Number.isFinite(hist) && hist > 0 ? Math.round(Math.max(0, (hist - value) / hist) * 100) : null;
  return {
    type, countryCode,
    countryName: clip(type === 'country' ? e.name : attrs.country_name, 60) || countryCode,
    entityName: clip(e.name, 60),
    datasource: clip(a.datasource, 24),
    level: a.level === 'critical' ? 'critical' : a.level === 'warning' ? 'warning' : 'normal',
    time: new Date(a.time * 1000).toISOString(),
    dropPct,
  };
}

export function summarizeAlerts(rawAlerts, { now = Date.now() } = {}) {
  const alerts = (Array.isArray(rawAlerts) ? rawAlerts : []).map(normalizeAlert).filter(Boolean).sort((a, b) => b.time.localeCompare(a.time));
  const byCountry = new Map();
  for (const a of alerts) {
    const c = byCountry.get(a.countryCode) || { code: a.countryCode, name: a.countryName, alerts: 0, critical: 0, regions: new Set(), datasources: new Set(), latest: a.time, maxDropPct: 0, countryLevel: false };
    c.alerts++;
    if (a.level === 'critical') c.critical++;
    if (a.type === 'region') c.regions.add(a.entityName); else c.countryLevel = true;
    c.datasources.add(a.datasource);
    if (a.time > c.latest) c.latest = a.time;
    if (a.dropPct != null && a.dropPct > c.maxDropPct) c.maxDropPct = a.dropPct;
    byCountry.set(a.countryCode, c);
  }
  const countries = [...byCountry.values()].map(c => ({
    ...c, regions: [...c.regions].slice(0, 6), datasources: [...c.datasources],
    severity: c.critical > 0 && (c.countryLevel || c.maxDropPct >= 50) ? 'critical' : c.critical > 0 ? 'warning' : 'normal',
  })).sort((a, b) => (b.critical - a.critical) || (b.maxDropPct - a.maxDropPct) || (b.alerts - a.alerts));
  return {
    windowHours: WINDOW_HOURS,
    asOf: new Date(now).toISOString(),
    alertCount: alerts.length,
    criticalCount: alerts.filter(a => a.level === 'critical').length,
    countries,
    alerts: alerts.slice(0, 80),
  };
}

export async function briefing() {
  const until = Math.floor(Date.now() / 1000);
  const from = until - WINDOW_HOURS * 3600;
  const [country, region] = await Promise.all([
    safeFetch(`${BASE}/alerts?from=${from}&until=${until}&entityType=country&limit=200`, { timeout: 20000, retries: 1 }),
    safeFetch(`${BASE}/alerts?from=${from}&until=${until}&entityType=region&limit=300`, { timeout: 20000, retries: 0 }),
  ]);
  const cData = Array.isArray(country?.data) ? country.data : null;
  const rData = Array.isArray(region?.data) ? region.data : [];
  if (!cData) return { source: 'IODA', timestamp: new Date().toISOString(), status: 'error', error: country?.error || 'unexpected payload' };
  const summary = summarizeAlerts([...cData, ...rData]);
  const signals = summary.countries.filter(c => c.severity === 'critical').slice(0, 3).map(c => ({
    type: 'internet_outage', severity: 'high', confidence: 0.75,
    title: `Internet disruption: ${c.name}`,
    detail: `${c.critical} critical IODA alert${c.critical === 1 ? '' : 's'} in ${summary.windowHours}h` + (c.maxDropPct ? ` · up to ${c.maxDropPct}% below baseline` : '') + (c.regions.length ? ` · ${c.regions.slice(0, 3).join(', ')}` : ''),
  }));
  return {
    source: 'IODA', timestamp: new Date().toISOString(), status: 'live',
    attribution: 'IODA — Georgia Tech Internet Intelligence Lab',
    ...summary, signals,
  };
}
