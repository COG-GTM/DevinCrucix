// Oil tankers — live AIS positions (aisstream.io, ship types 80–89) over the oil chokepoints,
// OFAC-sanctioned hulls in red, AIS gaps in gray. Without AISSTREAM_API_KEY only the chokepoint rings show.
CRUCIX_MAP.registerLayer({
  id: 'tankers',
  label: 'Oil tankers · AIS',
  color: '#00e5a0',
  description: 'Green = under way, yellow = anchored/moored, gray = AIS gap > 45 min, red = OFAC-sanctioned hull. Rings = chokepoints with tanker counts.',
  on: true,
  refreshMs: 30000,
  async fetch() {
    const d = await CRUCIX_LAYER_UTIL.api('/api/map/tankers');
    const s = d.summary || {};
    this.description = d.status === 'no_key' ? `NO KEY · set AISSTREAM_API_KEY (free) for live tankers · showing ${s.chokepoints?.length || 0} chokepoints`
      : `${CRUCIX_LAYER_UTIL.statusLine(d)} · ${(s.underway || 0) + (s.stopped || 0) + (s.gap || 0)} tankers · ${s.sanctioned || 0} sanctioned · ${s.gap || 0} AIS gaps`;
    return { points: d.points || [], rings: d.rings || [], labels: d.labels || [] };
  },
});
