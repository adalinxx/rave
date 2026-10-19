// Places are found by where they are: a place is listed under the geohash
// of its point, one character per key segment, so the places in any cell are
// one prefix scan (`index/geo/d/r/5/…`). Geohash: base 32, bits alternate
// longitude then latitude, each halving the range.

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
/** How finely a place is listed: 6 characters is a cell about 1.2 km × 0.6 km. */
export const PRECISION = 6;

/** The geohash of a point, `precision` characters long. */
export function encode(lat, lon, precision = PRECISION) {
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  let hash = "";
  let bits = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lonRange : latRange;
    const mid = (range[0] + range[1]) / 2;
    const x = even ? lon : lat;
    value <<= 1;
    if (x >= mid) {
      value |= 1;
      range[0] = mid;
    } else range[1] = mid;
    even = !even;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

/** The cell a geohash names: `{ south, west, north, east }`. */
export function bounds(hash) {
  const lat = [-90, 90];
  const lon = [-180, 180];
  let even = true;
  for (const ch of hash) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new Error(`not a geohash: ${hash}`);
    for (let bit = 4; bit >= 0; bit--) {
      const range = even ? lon : lat;
      const mid = (range[0] + range[1]) / 2;
      if ((value >> bit) & 1) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return { south: lat[0], west: lon[0], north: lat[1], east: lon[1] };
}

/** A cell's size in degrees at `precision`: `{ lat, lon }`. */
function cellSize(precision) {
  const bits = precision * 5;
  return { lat: 180 / 2 ** Math.floor(bits / 2), lon: 360 / 2 ** Math.ceil(bits / 2) };
}

/**
 * The geohash cells, as few as fit in `max`, that cover a box
 * `{ south, west, north, east }`: the finest precision (at most PRECISION)
 * whose cells number `max` or fewer. Undefined when even 1-character cells
 * would number more (the box is most of the world) — or when it needs fewer
 * characters than `min`, so a view too wide is refused rather than scanned.
 */
export function cover(box, { max = 16, min = 3 } = {}) {
  const south = Math.max(-90, box.south);
  const north = Math.min(90, box.north);
  // A box crossing the antimeridian is read as two.
  if (box.east < box.west) {
    const left = cover({ ...box, east: 180 }, { max, min });
    const right = cover({ ...box, west: -180 }, { max, min });
    return left && right ? [...left, ...right] : undefined;
  }
  const west = Math.max(-180, box.west);
  const east = Math.min(180, box.east);
  for (let precision = PRECISION; precision >= min; precision--) {
    const size = cellSize(precision);
    const rows = Math.floor((north + 90) / size.lat) - Math.floor((south + 90) / size.lat) + 1;
    const cols = Math.floor((Math.min(east, 179.999999) + 180) / size.lon) - Math.floor((west + 180) / size.lon) + 1;
    if (rows * cols > max) continue;
    const cells = new Set();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lat = Math.min(89.999999, south + r * size.lat);
        const lon = Math.min(179.999999, west + c * size.lon);
        cells.add(encode(lat, lon, precision));
      }
    }
    // The last row and column may start past the box's corner cell; add it.
    cells.add(encode(Math.min(89.999999, north), Math.min(179.999999, east), precision));
    return [...cells].sort();
  }
  return undefined;
}

/** Metres between two points (haversine on a 6,371 km sphere). */
export function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The geohash cells within `metres` of a point, at PRECISION: a place's neighbours are listed there. */
export function around(point, metres) {
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.max(0.01, Math.cos((point.lat * Math.PI) / 180)));
  return cover(
    { south: point.lat - dLat, west: point.lon - dLon, north: point.lat + dLat, east: point.lon + dLon },
    { max: 64, min: 1 },
  );
}
