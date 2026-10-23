// Civil traffic — every ADS-B contact within 150 nm of the map centre, loaded only when the camera
// is zoomed in (altitude < 1.2) so the globe is not buried under ~10k aircraft.
CRUCIX_MAP.registerLayer({
  id: 'traffic',
  label: 'Aviation · civil traffic (zoomed in)',
  color: '#40c4ff',
  description: 'All aircraft within 150 nm of the map centre when zoomed in. Blue = airborne by altitude, gray = on ground. Key-free (adsb.lol).',
  on: false,
  refreshMs: 15000,
  async fetch() {
    const pov = CRUCIX_LAYER_UTIL.pov();
    if (!pov || pov.altitude > 1.2) { this.description = 'Zoom in (scroll) on an area to load civil traffic around the map centre.'; return { points: [] }; }
    const d = await CRUCIX_LAYER_UTIL.api(`/api/map/traffic?lat=${pov.lat.toFixed(2)}&lon=${pov.lng.toFixed(2)}&dist=150`);
    const s = d.summary || {};
    this.description = `${CRUCIX_LAYER_UTIL.statusLine(d)} · ${s.total || 0} aircraft (${s.airborne || 0} airborne, ${s.military || 0} military)${s.emergencies?.length ? ` · EMERGENCY ${s.emergencies.join(', ')}` : ''}`;
    return { points: d.points || [] };
  },
});
