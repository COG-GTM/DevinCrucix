// AI usage by region — country choropleth from the Anthropic Economic Index (per-capita usage index,
// 1.0 = world average), US-state points, and live Cloudflare Radar rank of chatgpt.com / claude.ai per
// country. Country polygons come from /geo/world-110m.geojson (joined on ISO-2).
let AI_WORLD = null;
CRUCIX_MAP.registerLayer({
  id: 'aiusage',
  label: 'AI usage · regions',
  color: '#00e5ff',
  description: 'Country shading = Anthropic Economic Index per-capita AI usage tier (cyan = leading → purple = emerging). Points = US states. Click a country for live Cloudflare Radar AI rankings.',
  on: true,
  refreshMs: 0,
  async fetch() {
    const [d, world] = await Promise.all([CRUCIX_LAYER_UTIL.api('/api/map/aiusage'), AI_WORLD || fetch('/geo/world-110m.geojson').then(r => { if (!r.ok) throw new Error(`geo HTTP ${r.status}`); return r.json(); })]);
    AI_WORLD = world;
    const byA2 = new Map((d.countries || []).map(c => [c.a2, c]));
    const polygons = [];
    for (const f of world.features || []) {
      const c = byA2.get(f.properties.a2);
      if (!c) continue;
      const live = c.live ? ` · Radar today: chatgpt.com #${c.live.ranks['chatgpt.com'] ?? '>1000'}, claude.ai #${c.live.ranks['claude.ai'] ?? '>1000'}${c.live.services?.length ? ` · top GenAI: ${c.live.services.slice(0, 3).join(', ')}` : ''}` : '';
      polygons.push({
        geometry: f.geometry, fill: c.fill, stroke: c.live && c.live.score >= 60 ? 'rgba(0,229,255,0.9)' : 'rgba(255,255,255,0.25)',
        head: `${c.name} · AI usage index ${c.index.toFixed(2)} (#${c.rank})`,
        text: `${c.tier} · ${c.sharePct !== null ? `${c.sharePct.toFixed(2)}% of global Claude.ai usage` : ''}${c.useCases?.length ? ` · ${c.useCases.map(u => `${u.name} ${u.pct}%`).join(', ')}` : ''}${live}`,
        meta: `Anthropic Economic Index (${d.indexWindow}; share ${d.shareWindow})${c.live ? ' · Cloudflare Radar domain ranking' : ''}`,
        kind: 'aiusage', a2: c.a2,
      });
    }
    const points = (d.states || []).map(s => ({
      lat: s.lat, lng: s.lng, size: 0.18 + Math.min(0.5, s.index / 6), alt: 0.012, color: s.index >= 2 ? '#00e5ff' : s.index >= 1 ? '#40c4ff' : 'rgba(120,144,156,0.8)',
      head: `${s.name} · index ${s.index.toFixed(2)} (#${s.rank} of US states)`, text: `${s.tier} · ${s.sharePct?.toFixed(2)}% of US Claude.ai usage`, meta: 'Anthropic Economic Index · US state', kind: 'aiusage-state',
    }));
    const top = (d.countries || []).slice(0, 10).map(c => c.name).join(', ');
    this.description = `${CRUCIX_LAYER_UTIL.statusLine(d)} · ${polygons.length} countries shaded · top: ${top}`;
    return { polygons, points };
  },
});
