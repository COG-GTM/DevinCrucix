// WGS84 lat/lon → UTM → MGRS (1 m precision). Standard Krüger series (Snyder, USGS PP 1395);
// valid for -80°…84°. Norway/Svalbard zone exceptions included.

const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
const BANDS = 'CDEFGHJKLMNPQRSTUVWXX';
const SET_COL = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_ODD = 'ABCDEFGHJKLMNPQRSTUV', ROW_EVEN = 'FGHJKLMNPQRSTUVABCDE';

export function utmZone(lat, lon) {
  let z = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
  if (lat >= 72 && lat < 84) { if (lon >= 0 && lon < 9) z = 31; else if (lon >= 9 && lon < 21) z = 33; else if (lon >= 21 && lon < 33) z = 35; else if (lon >= 33 && lon < 42) z = 37; }
  return z;
}

export function toUtm(lat, lon) {
  const zone = utmZone(lat, lon);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(φ) ** 2);
  const T = Math.tan(φ) ** 2, C = ep2 * Math.cos(φ) ** 2, A = Math.cos(φ) * (λ - lon0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * φ - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * φ)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * φ) - (35 * e2 ** 3 / 3072) * Math.sin(6 * φ));
  const easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let northing = k0 * (M + N * Math.tan(φ) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) northing += 10000000;
  return { zone, easting, northing, hemisphere: lat < 0 ? 'S' : 'N' };
}

export function toMgrs(lat, lon, digits = 5) {
  if (!(lat >= -80 && lat <= 84)) return null;
  const { zone, easting, northing } = toUtm(lat, lon);
  const band = BANDS[Math.min(Math.floor((lat + 80) / 8), 20)];
  const set = (zone - 1) % 3;
  const col = SET_COL[set][Math.floor(easting / 100000) - 1];
  const rowLetters = zone % 2 ? ROW_ODD : ROW_EVEN;
  const row = rowLetters[Math.floor(northing / 100000) % 20];
  const div = 10 ** (5 - digits);
  const e = String(Math.floor((easting % 100000) / div)).padStart(digits, '0');
  const n = String(Math.floor((northing % 100000) / div)).padStart(digits, '0');
  return `${zone}${band} ${col}${row} ${e} ${n}`;
}
