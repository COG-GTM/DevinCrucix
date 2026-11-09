// Layers loaded by map.html, in order. Each entry is a file in this folder that
// calls CRUCIX_MAP.registerLayer({...}). See _template.js for the layer contract.
// _shared.js must stay first: it defines CRUCIX_LAYER_UTIL used by the others.
window.CRUCIX_LAYER_FILES = [
  '_shared.js',
  'aviation.js',
  'traffic.js',
  'nofly.js',
  'tankers.js',
  'festivals.js',
  'aiusage.js',
];
