// Helpers shared by the layer pack (loaded first via manifest.js).
window.CRUCIX_LAYER_UTIL = {
  // Fetch a /api/map/<layer> envelope; throws a readable error on HTTP failure.
  async api(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail || ''; } catch {} throw new Error(`HTTP ${r.status}${d ? ` · ${d}` : ''}`); }
    return r.json();
  },
  // One-line status for the Layers rail: "LIVE · 12s ago" / "STALE" / "NO KEY — …".
  statusLine(env) {
    const tag = { live: 'LIVE', stale: 'STALE', degraded: 'PARTIAL', no_key: 'NO KEY' }[env.status] || env.status;
    const age = Number.isFinite(env.ageSec) ? (env.ageSec < 90 ? `${env.ageSec}s ago` : `${Math.round(env.ageSec / 60)} min ago`) : '';
    const note = (env.notes || [])[0] || '';
    return [tag, age, note].filter(Boolean).join(' · ');
  },
  // Globe.gl camera position, or null before the globe exists.
  pov() { try { return typeof globe !== 'undefined' && globe ? globe.pointOfView() : null; } catch { return null; } },
};
