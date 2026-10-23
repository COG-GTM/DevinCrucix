// Aviation — live military aircraft (adsb.lol / adsb.fi, 20 s), FAA airport ground stops / delays /
// closures (nasstatus.faa.gov, 2 min) and GPS-interference cells from the last sweep.
CRUCIX_MAP.registerLayer({
  id: 'aviation',
  label: 'Aviation · military + airport status',
  color: '#ff9100',
  description: 'Military ADS-B contacts (orange), FAA airport delays / ground stops (yellow→red dots), GPS-jamming cells. Key-free.',
  on: true,
  refreshMs: 20000,
  async fetch() {
    const d = await CRUCIX_LAYER_UTIL.api('/api/map/aviation');
    const s = d.summary || {};
    this.description = `${CRUCIX_LAYER_UTIL.statusLine(d)} · ${s.military || 0} military · ${s.airports || 0} airports with delays · ${s.jammingCells || 0} jamming cells`;
    return { points: d.points || [], polygons: d.polygons || [] };
  },
});
