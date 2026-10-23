// Music festivals — Ticketmaster events (music · festival) live now and in the next 72 h, plus major
// recurring festivals from Wikidata as a dim background. Live = schedule-derived.
CRUCIX_MAP.registerLayer({
  id: 'festivals',
  label: 'Music festivals · live + next 72 h',
  color: '#ff4081',
  description: 'Bright pink + pulse = on right now, pink = starts within 72 h, white = major recurring festival (Wikidata). Ticketmaster key optional.',
  on: true,
  refreshMs: 600000,
  async fetch() {
    const d = await CRUCIX_LAYER_UTIL.api('/api/map/festivals');
    const s = d.summary || {};
    this.description = d.status === 'no_key' ? `NO KEY · set TICKETMASTER_API_KEY (free) for live events · showing ${s.major || 0} major festivals (Wikidata)`
      : `${CRUCIX_LAYER_UTIL.statusLine(d)} · ${s.live || 0} live now · ${s.upcoming || 0} in next 72 h · ${s.major || 0} major festivals`;
    return { points: d.points || [], rings: d.rings || [] };
  },
});
