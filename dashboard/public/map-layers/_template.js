// Copy this file to <id>.js, fill it in, then add '<id>.js' to manifest.js.
// Everything is frontend-only: a layer fetches from an existing /api/* route
// and returns Globe.gl datasets. No server changes needed.
// Fetch same-origin only: the server's CSP connect-src (lib/securityHeaders.mjs
// CONNECT_HOSTS) blocks browser requests to other hosts. To plot an external
// feed, proxy it through an existing /api/* route or allowlist the host there.
// id: [a-z0-9_-], color: hex / rgb() / hsl() (anything else falls back to blue).
// Points, polygons, arcs, labels and paths are click-to-inspect; rings are decorative (Globe.gl has no ring click).
CRUCIX_MAP.registerLayer({
  id: 'template',                 // unique, used in the URL hash (#layers=a,b)
  label: 'Template layer',        // shown in the Layers menu and legend
  color: '#5aa9ff',               // legend dot; items may override per feature
  description: 'One line on what this layer shows and where it comes from.',
  on: false,                      // start enabled?
  refreshMs: 0,                   // 0 = fetch once; otherwise re-fetch every N ms

  // Return any subset of the six Globe.gl datasets. Items are plain objects:
  //   points:   { lat, lng, size, alt, color, head, text, meta }
  //   arcs:     { startLat, startLng, endLat, endLng, color, stroke, label }
  //   rings:    { lat, lng, maxR, speed, period, color }
  //   labels:   { lat, lng, text, size, color }
  //   polygons: { geometry (GeoJSON), fill, stroke, head, text, meta }
  //   paths:    { pts: [[lat,lng],...], color, stroke }
  async fetch() {
    const r = await fetch('/api/nuclear');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return {
      points: (d.facilities || []).map(f => ({
        lat: f.lat, lng: f.lng, size: 0.35,
        head: f.name, text: `${f.reactors} reactors · ${f.capacityMW} MW · ${f.status}`, meta: `${f.country} · ${f.operator || ''}`,
      })),
    };
  },
});
