import { AREA_CELL, HEAT_TOP } from './heat';
import type { Cell } from './types';

// The Points view for animals counted by area, drawn as stipple, like the shading on an engraved map: many fine marks
// of a fixed size on screen, spread evenly inside each square that has records, packed closer where it has more. The
// marks never grow with zoom. As a square grows on screen more of its marks show (the shader in createStipple picks
// how many), and zoomed in the grades are re-cut against the squares in view.
//
// This file is the maths only, with no three.js, so it can be run and checked on its own.
//
// Honesty: a mark's centre always lies inside a square with records, inset from its edges, and marks are spread
// evenly, because the data has no finer positions for these animals than the square.

/**
 * target spacing between marks in CSS px, per class from the faintest to the top. With a 4.5 px mark they cover about
 * 15%, 22%, 32%, 45% and 60% of the ground in a run of squares with records, at any zoom: the top reads as near-solid
 * stipple, the faintest as a clear dusting.
 */
export const SPACING = [10.3, 8.5, 7.05, 5.94, 5.15];
/** the mark's sprite size in CSS px: big enough that its dark rim covers whole pixels at a device pixel ratio of 1 */
export const MARK_PX = 4.5;
/** the mark's ink core, as a share of the sprite; the dark rim runs from there to the sprite's edge */
export const MARK_CORE = 0.27;
/** marks keep this share of a square's side clear of each edge, so rounding can't push one into an empty neighbour */
export const INSET = 0.04;
/** candidate marks per square in the world layer, and the most marks the world and detail layers may hold */
export const WORLD_MARKS = 6;
export const WORLD_BUDGET = 400_000;
export const DETAIL_BUDGET = 250_000;
/** at least this many squares before the grades are cut from the squares in view (3% of 30 is about one square) */
export const REBAND_MIN = 30;
const MAX_MARKS = 256;
/** headroom for zooming in to 0.8x the drawn altitude before the detail is redrawn: 1/0.8 squared */
const HEADROOM = 1.6;

const ROWS = 512;
const COLS = 1024;
const rad = Math.PI / 180;

/** murmur3's finaliser: a stable, well-mixed 32-bit hash of a 32-bit integer */
function mix(h: number) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A square's lattice indices: row counts down from the north pole, col east from -180°. */
export function squareOf(lat: number, lng: number) {
  // the nearest square centre, as the published points are centres that may have been rounded in the file
  const m = Math.round((lat + 90) / AREA_CELL - 0.5);
  const c = Math.round((lng + 180) / AREA_CELL - 0.5);
  return { row: Math.min(ROWS - 1, Math.max(0, ROWS - 1 - m)), col: ((c % COLS) + COLS) % COLS };
}

/** seeded from the integer indices, never from floats, so the same square always gets the same marks */
export const seedOf = (row: number, col: number) => mix(((row * COLS + col) ^ 0x2545f491) >>> 0);
const hashOf = (seed: number, i: number) => mix((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);

/**
 * Point i of the R2 sequence for a seed, in the unit square. Any prefix of it is evenly spread, so showing the first
 * N marks of a square always looks like stipple, and showing one more adds a mark without moving the others.
 */
export function r2(seed: number, i: number): [number, number] {
  const x = offsetX(seed) + i * G1;
  const y = offsetY(seed) + i * G2;
  return [x - Math.floor(x), y - Math.floor(y)];
}
const G1 = 0.7548776662;
const G2 = 0.569840291;
const offsetX = (seed: number) => mix(seed ^ 0x27d4eb2f) / 2 ** 32;
const offsetY = (seed: number) => mix(seed ^ 0x165667b1) / 2 ** 32;

/** a mark's size factor, 0.9 to 1.1: the hand-pulled look of an engraving, saying nothing about the data */
export const jitterOf = (seed: number, i: number) => 0.9 + (0.2 * hashOf(seed, i)) / 2 ** 32;

/**
 * A square's threshold in [0, 1): mark i shows once the expected count passes i plus this. Where squares are smaller
 * than the marks (zoomed out), that lights an evenly spread share of the squares, so a run of them reads as a tone;
 * it is the R2 sequence again, over the lattice, so lit squares never clump.
 */
export function ditherOf(row: number, col: number) {
  const v = 0.5 + row * G1 + col * G2;
  return v - Math.floor(v);
}

/** Candidate mark i of a square, as [lat, lng] inside the square, inset from its edges. */
export function candidate(row: number, col: number, i: number): [number, number] {
  const [x, y] = r2(seedOf(row, col), i);
  const span = 1 - 2 * INSET;
  return [90 - (row + INSET + y * span) * AREA_CELL, -180 + (col + INSET + x * span) * AREA_CELL];
}

/** The squares of one animal, merged and graded. */
export interface Squares {
  count: number;
  row: Int32Array;
  col: Int32Array;
  /** the centre of each square */
  lat: Float64Array;
  lng: Float64Array;
  weight: Float64Array;
  /** class 0 (every square with records) to 4 (the busiest 3%), from the whole range */
  cls: Uint8Array;
  /** the least marks the square shows at any zoom (see presenceFloor) */
  floor: Float32Array;
}

/**
 * Class breaks: the weights at the top 50%, 25%, 10% and 3% of the squares, counted unweighted. A class only exists
 * if its break rises above the one below, so ties collapse classes instead of inventing a top class.
 */
export function classBreaks(w: ArrayLike<number>) {
  const sorted = Array.from(w).sort((a, b) => a - b);
  return HEAT_TOP.map((t) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - t)))]);
}
export function classOf(w: number, breaks: number[]) {
  let k = 0;
  while (k < breaks.length && w >= breaks[k] && (k === 0 || breaks[k] > breaks[k - 1])) k++;
  return k;
}

/** the 2° heatmap surface at a spot (the same kernel as createHeat): the weight for older files without counts */
function smoothed(cells: Cell[]) {
  const SIGMA = 2.2;
  const byCell = new Map<string, Cell[]>();
  const key = (la: number, lo: number) => `${Math.floor(la / 2)},${Math.floor((((lo + 180) % 360) + 360) % 360 / 2)}`;
  for (const c of cells) {
    const k = key(c[0], c[1]);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k)!.push(c);
  }
  return (lat: number, lng: number) => {
    let v = 0;
    const cos = Math.max(0.05, Math.cos(lat * rad));
    const span = Math.min(90, Math.ceil(3 / cos) + 1);
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -span; dx <= span; dx++) {
        for (const c of byCell.get(key(lat + dy * 2, lng + dx * 2)) ?? []) {
          const dLng = ((((c[1] - lng) % 360) + 540) % 360) - 180;
          const d2 = (c[0] - lat) ** 2 + (dLng * cos) ** 2;
          if (d2 < 49) v += c[2] * Math.exp(-d2 / (2 * SIGMA * SIGMA));
        }
      }
    return v;
  };
}

/**
 * Snap the published points onto the lattice (merging duplicates by summing their counts), weigh each square by its
 * own count, or by the 2° surface when the file has no counts, and grade them against the whole range.
 */
export function prepareSquares(raw: number[][], cells: Cell[]): Squares {
  const seen = new Map<number, number>();
  const rows: number[] = [];
  const cols: number[] = [];
  const counts: (number | undefined)[] = [];
  let hasCount = false;
  for (const p of raw) {
    const { row, col } = squareOf(p[0], p[1]);
    const id = row * COLS + col;
    if (p.length > 2) hasCount = true;
    const hit = seen.get(id);
    if (hit !== undefined) counts[hit] = (counts[hit] ?? 0) + (p[2] ?? 0);
    else {
      seen.set(id, rows.length);
      rows.push(row);
      cols.push(col);
      counts.push(p.length > 2 ? p[2] : undefined);
    }
  }
  const n = rows.length;
  const sq: Squares = {
    count: n,
    row: Int32Array.from(rows),
    col: Int32Array.from(cols),
    lat: new Float64Array(n),
    lng: new Float64Array(n),
    weight: new Float64Array(n),
    cls: new Uint8Array(n),
    floor: presenceFloor(rows, cols),
  };
  for (let j = 0; j < n; j++) {
    sq.lat[j] = 90 - (rows[j] + 0.5) * AREA_CELL;
    sq.lng[j] = -180 + (cols[j] + 0.5) * AREA_CELL;
  }
  const at = hasCount ? null : smoothed(cells);
  for (let j = 0; j < n; j++) sq.weight[j] = at ? at(sq.lat[j], sq.lng[j]) : counts[j] ?? 1;
  const breaks = classBreaks(sq.weight);
  for (let j = 0; j < n; j++) sq.cls[j] = classOf(sq.weight[j], breaks);
  return sq;
}

/**
 * The least marks a square shows at any zoom: 2 shared between the squares with records in its 5x5 neighbourhood
 * (itself included), at most 1 each. So a lone record still shows when zoomed out, and a thin patch of range keeps
 * about two marks per neighbourhood, enough to see its shape from the whole globe, where squares are smaller than a
 * mark. Zoomed in, the density takes over. Every square gets 1 when the animal has under REBAND_MIN of them.
 */
export function presenceFloor(rows: ArrayLike<number>, cols: ArrayLike<number>) {
  const n = rows.length;
  const out = new Float32Array(n);
  if (n < REBAND_MIN) return out.fill(1);
  const has = new Set<number>();
  for (let j = 0; j < n; j++) has.add(rows[j] * COLS + cols[j]);
  for (let j = 0; j < n; j++) {
    let near = 0;
    for (let dr = -2; dr <= 2; dr++) {
      const r = rows[j] + dr;
      if (r < 0 || r >= ROWS) continue;
      for (let dc = -2; dc <= 2; dc++) if (has.has(r * COLS + (((cols[j] + dc) % COLS) + COLS) % COLS)) near++;
    }
    out[j] = Math.min(1, 2 / near);
  }
  return out;
}

/** candidate marks per square in the world layer: WORLD_MARKS, fewer (but at least 2) if that would pass the budget */
export const worldMarks = (squares: number) =>
  squares * WORLD_MARKS > WORLD_BUDGET ? Math.max(2, Math.floor(WORLD_BUDGET / squares)) : WORLD_MARKS;

/** a square's side on screen, in CSS px, at the centre of the view: the camera is `altitude` globe radii above it */
export const squarePx = (viewportH: number, fovDeg: number, altitude: number) =>
  (viewportH * AREA_CELL * rad) / (2 * Math.tan((fovDeg * rad) / 2) * altitude);

/** expected marks in a square: its area on screen over the area each mark of its class gets */
export const lambdaOf = (px: number, lat: number, facing: number, cls: number, spacingScale = 1) =>
  (px * px * Math.cos(lat * rad) * facing) / (SPACING[cls] * spacingScale) ** 2;

/** The squares near a view centre: a box `halfSpan` degrees of latitude high (wider in longitude, as the heat detail) plus one square. */
export function squaresInBox(sq: Squares, lat: number, lng: number, halfSpan: number) {
  const lat0 = Math.max(-90, lat - halfSpan);
  const lat1 = Math.min(90, lat + halfSpan);
  const cos = Math.max(0.12, Math.cos(Math.min(89, Math.max(Math.abs(lat0), Math.abs(lat1))) * rad));
  const halfLng = Math.min(180, halfSpan / cos) + AREA_CELL;
  const out: number[] = [];
  for (let j = 0; j < sq.count; j++) {
    if (sq.lat[j] < lat0 - AREA_CELL || sq.lat[j] > lat1 + AREA_CELL) continue;
    const dLng = ((((sq.lng[j] - lng) % 360) + 540) % 360) - 180;
    if (Math.abs(dLng) <= halfLng) out.push(j);
  }
  return out;
}

/** The classes of the squares in a box: re-cut from the box when it holds at least REBAND_MIN, else the whole range's. */
export function boxClasses(sq: Squares, idx: number[]) {
  if (idx.length < REBAND_MIN) return idx.map((j) => sq.cls[j]);
  const breaks = classBreaks(idx.map((j) => sq.weight[j]));
  return idx.map((j) => classOf(sq.weight[j], breaks));
}

/**
 * How many candidates each square of the detail layer gets, for squares `px` CSS px across at the view centre:
 * enough for zooming in to 0.8x before the redraw. Over the budget, every grade is lightened by the same factor
 * (spacingScale), so their order and relative tone hold and no area is dropped while another is kept.
 */
export function detailCounts(lat: ArrayLike<number>, cls: ArrayLike<number>, px: number, budget = DETAIL_BUDGET) {
  const n = new Uint16Array(cls.length);
  const fill = (scale: number) => {
    let total = 0;
    for (let j = 0; j < cls.length; j++) {
      n[j] = Math.min(MAX_MARKS, Math.ceil(lambdaOf(px, lat[j], 1, cls[j], scale) * HEADROOM) + 1);
      total += n[j];
    }
    return total;
  };
  let spacingScale = 1;
  let total = fill(1);
  if (total > budget) {
    spacingScale = Math.sqrt(total / budget);
    total = fill(spacingScale);
    // the +1 and rounding up per square can leave it a little over; nudge until it fits
    for (let tries = 0; total > budget && tries < 200; tries++) total = fill((spacingScale *= 1.02));
  }
  return { n, total, spacingScale };
}

/** Same formula as three-globe (and toXYZ in stage.ts), so the marks line up with its globe. */
function toXYZ(lat: number, lng: number, r: number, out: Float32Array, o: number) {
  const phi = (90 - lat) * rad;
  const theta = (90 - lng) * rad;
  const s = Math.sin(phi);
  out[o] = r * s * Math.cos(theta);
  out[o + 1] = r * Math.cos(phi);
  out[o + 2] = r * s * Math.sin(theta);
}

/**
 * The vertex buffers for a layer: for each listed square, its first n candidates. `info` per mark is
 * (candidate index, class, presence floor, size factor); `dither` is its square's threshold.
 */
export function buildMarks(sq: Squares, idx: ArrayLike<number>, cls: ArrayLike<number>, n: (k: number) => number, radius: number) {
  let total = 0;
  for (let k = 0; k < idx.length; k++) total += n(k);
  const position = new Float32Array(total * 3);
  const info = new Float32Array(total * 4);
  const dither = new Float32Array(total);
  const span = 1 - 2 * INSET;
  let m = 0;
  for (let k = 0; k < idx.length; k++) {
    const j = idx[k];
    const row = sq.row[j];
    const col = sq.col[j];
    const seed = seedOf(row, col);
    const count = n(k);
    const ox = offsetX(seed);
    const oy = offsetY(seed);
    const h = ditherOf(row, col);
    for (let i = 0; i < count; i++, m++) {
      // r2(seed, i), inlined: this loop runs up to DETAIL_BUDGET times when the camera settles
      let x = ox + i * G1;
      let y = oy + i * G2;
      x -= Math.floor(x);
      y -= Math.floor(y);
      toXYZ(90 - (row + INSET + y * span) * AREA_CELL, -180 + (col + INSET + x * span) * AREA_CELL, radius, position, m * 3);
      info[m * 4] = i;
      info[m * 4 + 1] = cls[k];
      info[m * 4 + 2] = sq.floor[j];
      info[m * 4 + 3] = jitterOf(seed, i);
      dither[m] = h;
    }
  }
  return { position, info, dither, count: total };
}
