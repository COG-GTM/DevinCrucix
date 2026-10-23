// Globe.gl (three-conic-polygon-geometry) follows the d3 convention: exterior rings wind clockwise
// in lon/lat, holes counter-clockwise. A counter-clockwise exterior is read as "everything but this
// patch" and paints the whole globe, so every upstream polygon is re-oriented before it is served.
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}
const orientRings = (rings) => rings.map((r, i) => {
  const cw = ringArea(r) < 0;
  return (i === 0 ? cw : !cw) ? r : r.slice().reverse();
});
export function orientGeometry(g) {
  if (!g) return g;
  if (g.type === 'Polygon') return { ...g, coordinates: orientRings(g.coordinates) };
  if (g.type === 'MultiPolygon') return { ...g, coordinates: g.coordinates.map(orientRings) };
  return g;
}
