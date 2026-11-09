// No-fly zones — FAA TFRs (10 min), permanent prohibited / restricted airspace (daily) and curated
// conflict-zone closures (EASA CZIB / FAA SFAR). Colour = legal basis / severity.
CRUCIX_MAP.registerLayer({
  id: 'nofly',
  label: 'No-fly zones · TFR + restricted + conflict',
  color: '#ff5252',
  description: 'Red = VIP TFR / prohibited / closed airspace, orange = security & restricted, yellow = hazard, blue = stadium/air show. Key-free.',
  on: true,
  refreshMs: 600000,
  async fetch() {
    const d = await CRUCIX_LAYER_UTIL.api('/api/map/nofly');
    const s = d.summary || {};
    const t = s.tfr || {};
    this.description = `${CRUCIX_LAYER_UTIL.statusLine(d)} · ${t.total || 0} active TFRs, ${t.drawn || 0} shapes drawn · ${s.sua || 0} prohibited/restricted areas · ${s.conflict || 0} conflict-zone closures`;
    return { polygons: d.polygons || [] };
  },
});
