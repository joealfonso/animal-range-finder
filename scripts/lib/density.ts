// Exact record counts per small square of the world, from GBIF's ad-hoc density maps (v2/map/occurrence/adhoc).
//
// Why: sampling a few pages of the occurrence search (the first ~8000 records in GBIF's own order, which clusters by
// dataset and date) gave maps that followed whichever datasets came first, not where the records are. The map API
// counts every record instead, so the squares below are the whole data set, not a sample of it.
//
// The API answers with Mapbox vector tiles. This file reads the little of that format it needs (no dependency): every
// cell is a polygon with a `total` property.
//
// How big a cell really is: GBIF adds records up into its own grid, and how fine that grid is depends on the zoom, not on
// `squareSize` (that only sets how big each cell is drawn, from its top-left corner). At zoom 2 most records are lumped
// into aligned 1.406° cells (checked: the mallard's 510,059 records in 50.6–52.0°N, 4.2–5.6°E all sit in one cell), so
// counts per 0.35° square were wrong: whole 1.4° blocks of squares held nothing and one held everything. At zoom 4 the
// cells are 0.35° x 0.18° or smaller and nest inside the squares below, and their sums match the occurrence search square
// by square (checked on 15 mallard squares in western Europe). Zoom 4 is 512 tiles, so only the tiles under a zoom 2 tile
// that has records are read.
//
// What was checked, and why this endpoint and not the plainer one (v2/map/occurrence/density):
// - the ad-hoc endpoint takes the same filters as the occurrence search and its totals equal the search's counts exactly
//   (wolf 209,969, alpine ibex 182,174, okapi 29); the density endpoint counted only records filed under the taxon itself,
//   so it lost records filed under synonyms (alpine ibex: 11% of them, 26 animals under 80%);
// - both silently ignore filters they don't know, so only filters tested here are used (basisOfRecord, hasCoordinate,
//   hasGeospatialIssue, occurrenceStatus, degreeOfEstablishment, month and year all change the count as they should);
// - detail grows with zoom (zoom 0 lumps a whole country into a cell), so the zoom here is not a free choice.

const GBIF = 'https://api.gbif.org';
const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';

/** The squares records are added up into, in degrees: 0.3516°, about 39 km at the equator. The map's own cells are smaller. */
export const SQUARE_DEG = 180 / 512;
/** Squares across the world, and from pole to pole. */
export const COLS = 360 / SQUARE_DEG;
export const ROWS = 180 / SQUARE_DEG;
const ZOOM = 4;
/** the coarse zoom read first, to skip the parts of the world with no records */
const SCOUT = 2;
const TILE_DEG = 180 / 2 ** ZOOM;

/** A square's id: its row and column together. */
export const squareId = (row: number, col: number) => row * COLS + col;
export const squareOf = (lat: number, lng: number) =>
  squareId(
    Math.min(ROWS - 1, Math.max(0, Math.floor((90 - lat) / SQUARE_DEG))),
    Math.min(COLS - 1, Math.max(0, Math.floor((lng + 180) / SQUARE_DEG))),
  );
export const centreOf = (id: number): [number, number] => {
  const row = Math.floor(id / COLS);
  const col = id % COLS;
  return [90 - (row + 0.5) * SQUARE_DEG, -180 + (col + 0.5) * SQUARE_DEG];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the part of the vector tile format we need
function reader(buf: Uint8Array) {
  let p = 0;
  const varint = () => {
    let r = 0;
    let mul = 1;
    for (;;) {
      const b = buf[p++];
      r += (b & 127) * mul;
      if (!(b & 128)) return r;
      mul *= 128;
    }
  };
  return {
    eof: () => p >= buf.length,
    varint,
    bytes() {
      const n = varint();
      const out = buf.subarray(p, p + n);
      p += n;
      return out;
    },
    skip(wire: number) {
      if (wire === 0) varint();
      else if (wire === 1) p += 8;
      else if (wire === 2) {
        const n = varint(); // read the length first: `p += varint()` would add to the position from before the read
        p += n;
      }
      else if (wire === 5) p += 4;
      else throw new Error(`unknown protobuf wire type ${wire}`);
    },
    f64() {
      const v = new DataView(buf.buffer, buf.byteOffset + p, 8).getFloat64(0, true);
      p += 8;
      return v;
    },
    f32() {
      const v = new DataView(buf.buffer, buf.byteOffset + p, 4).getFloat32(0, true);
      p += 4;
      return v;
    },
  };
}
const unzig = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/** Every cell in a tile: its top-left corner in px (of 4096 across the tile), which is where GBIF binned its records, and
 *  how many there are. (Its middle depends on `squareSize` and can fall in the next square.) */
export function readTile(buf: Uint8Array): { x: number; y: number; total: number }[] {
  const out: { x: number; y: number; total: number }[] = [];
  const tile = reader(buf);
  while (!tile.eof()) {
    const tag = tile.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      tile.skip(tag & 7);
      continue;
    }
    const layer = reader(tile.bytes());
    const keys: string[] = [];
    const values: number[] = [];
    const features: Uint8Array[] = [];
    while (!layer.eof()) {
      const t = layer.varint();
      const f = t >> 3;
      if (f === 2 && (t & 7) === 2) features.push(layer.bytes());
      else if (f === 3 && (t & 7) === 2) keys.push(new TextDecoder().decode(layer.bytes()));
      else if (f === 4 && (t & 7) === 2) {
        const v = reader(layer.bytes());
        let num = NaN;
        while (!v.eof()) {
          const vt = v.varint();
          const vf = vt >> 3;
          if (vf === 2) num = v.f32(); // float
          else if (vf === 3) num = v.f64(); // double
          else if (vf === 4 || vf === 5) num = v.varint(); // int, uint
          else if (vf === 6) num = unzig(v.varint()); // sint
          else v.skip(vt & 7);
        }
        values.push(num);
      } else layer.skip(t & 7);
    }
    const totalKey = keys.indexOf('total');
    if (totalKey < 0 && features.length) throw new Error('density tile has no "total" property');
    for (const fb of features) {
      const f = reader(fb);
      let tags: number[] = [];
      let geom: number[] = [];
      while (!f.eof()) {
        const t = f.varint();
        const fn = t >> 3;
        if ((fn === 2 || fn === 4) && (t & 7) === 2) {
          const arr = reader(f.bytes());
          const list: number[] = [];
          while (!arr.eof()) list.push(arr.varint());
          if (fn === 2) tags = list;
          else geom = list;
        } else f.skip(t & 7);
      }
      let total = NaN;
      for (let i = 0; i < tags.length; i += 2) if (tags[i] === totalKey) total = values[tags[i + 1]];
      // geometry: MoveTo(1) then LineTo(2) commands with zigzag deltas; the cell's corner is the least x and y of them
      let x = 0;
      let y = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      for (let i = 0; i < geom.length; ) {
        const cmd = geom[i] & 7;
        const n = geom[i] >> 3;
        i++;
        if (cmd === 7) continue;
        for (let k = 0; k < n; k++) {
          x += unzig(geom[i++]);
          y += unzig(geom[i++]);
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
        }
      }
      if (!Number.isFinite(total) || !Number.isFinite(x0)) throw new Error('density tile has a cell without a count or a position');
      out.push({ x: x0, y: y0, total });
    }
  }
  return out;
}

/** One cell of the map: where its records are (just inside its north-west corner), and how many there are. */
export type Cell = { lat: number; lng: number; n: number };

/**
 * The records matching a search, cell by cell (a cell is 0.35° x 0.18° or smaller, inside one square). `taxonKeys` are searched together, as the
 * occurrence search does; `filters` is the rest of the search as a query string (without a leading &). Throws if GBIF can't
 * be reached: a failed request must never read as "no records".
 */
export async function fetchCells(taxonKeys: number[], filters: string): Promise<Cell[]> {
  const taxa = taxonKeys.map((k) => `taxonKey=${k}`).join('&');
  const tile = async (z: number, x: number, y: number) => {
    const url = `${GBIF}/v2/map/occurrence/adhoc/${z}/${x}/${y}.mvt?srs=EPSG:4326&bin=square&squareSize=8&${taxa}&hasCoordinate=true&${filters}`;
    let buf: Uint8Array | null = null;
    for (let i = 0; i < 6 && !buf; i++) {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) }).catch(() => null);
      if (res?.status === 204) buf = new Uint8Array(0);
      else if (res?.ok) buf = new Uint8Array(await res.arrayBuffer());
      // a tile with nothing in it is sometimes a 400 with this message instead of a 204; any other 400 is a real error
      else if (res?.status === 400 && (await res.text()).includes('missing the expected layer')) buf = new Uint8Array(0);
      else await sleep(1000 * (i + 1) * (res?.status === 429 ? 3 : 1));
    }
    if (!buf) throw new Error(`density tile failed: ${url}`);
    return buf.length ? readTile(buf) : [];
  };
  const inFour = async <T>(work: T[], each: (t: T) => Promise<void>) =>
    Promise.all(Array.from({ length: 4 }, async () => {
      for (let t = work.shift(); t !== undefined; t = work.shift()) await each(t);
    }));
  const grid = (z: number) => Array.from({ length: 2 ** z * 2 ** (z + 1) }, (_, i) => [i % 2 ** (z + 1), Math.floor(i / 2 ** (z + 1))] as const);

  // the zoom 4 tiles under each zoom 2 tile that has any records
  const k = 2 ** (ZOOM - SCOUT);
  const work: (readonly [number, number])[] = [];
  await inFour(grid(SCOUT), async ([x, y]) => {
    if ((await tile(SCOUT, x, y)).length) for (let i = 0; i < k * k; i++) work.push([x * k + (i % k), y * k + Math.floor(i / k)]);
  });
  const cells: Cell[] = [];
  await inFour(work, async ([x, y]) => {
    // half a px in from the corner, so a corner on a square's edge can't round into the square beside it
    for (const c of await tile(ZOOM, x, y))
      cells.push({ lat: 90 - (y * TILE_DEG + ((c.y + 0.5) * TILE_DEG) / 4096), lng: -180 + (x * TILE_DEG + ((c.x + 0.5) * TILE_DEG) / 4096), n: c.total });
  });
  return cells;
}

/** The same, added up per square of the world (0.35°). */
export const squaresOf = (cells: Cell[]) => {
  const squares = new Map<number, number>();
  for (const c of cells) {
    const id = squareOf(c.lat, c.lng);
    squares.set(id, (squares.get(id) ?? 0) + c.n);
  }
  return squares;
};
export const fetchSquares = async (taxonKeys: number[], filters: string) => squaresOf(await fetchCells(taxonKeys, filters));
