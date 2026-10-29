// Checks for the stipple maths (src/stipple.ts), against docs/specs/engraved-stipple.md.
// Run: node --import tsx tests/stipple.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { AREA_CELL, HEAT_TOP } from '../src/heat';
import {
  boxClasses,
  buildMarks,
  candidate,
  DETAIL_BUDGET,
  detailCounts,
  ditherOf,
  INSET,
  prepareSquares,
  presenceFloor,
  REBAND_MIN,
  seedOf,
  squareOf,
  squarePx,
  type Squares,
} from '../src/stipple';

const ROOT = new URL('../', import.meta.url);
const species: { id: number; name: string; binned?: number }[] = JSON.parse(
  readFileSync(new URL('public/data/species.json', ROOT), 'utf8'),
).species;
const binned = species.filter((s) => s.binned);
const pointsOf = (id: number): number[][] => JSON.parse(readFileSync(new URL(`public/data/points/${id}.json`, ROOT), 'utf8'));
const rangeOf = (id: number): [number, number, number][] => {
  const u = new URL(`public/data/range/${id}.json`, ROOT);
  return existsSync(u) ? JSON.parse(readFileSync(u, 'utf8')) : [];
};
const all = (sq: Squares) => Uint32Array.from({ length: sq.count }, (_, j) => j);
const R = 100.6;

/** lat/lng back from the three-globe position stipple.ts writes */
function toLatLng(x: number, y: number, z: number) {
  const r = Math.hypot(x, y, z);
  const lat = 90 - (Math.acos(y / r) * 180) / Math.PI;
  let lng = 90 - (Math.atan2(z, x) * 180) / Math.PI;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return [lat, lng];
}

/** whether [lat, lng] lies in square (row, col), inset INSET of the side from each edge (eps for float32 positions) */
function insideInset(lat: number, lng: number, row: number, col: number, eps = 0) {
  const top = 90 - row * AREA_CELL;
  const west = -180 + col * AREA_CELL;
  const pad = INSET * AREA_CELL - eps;
  let dLng = lng - west;
  if (dLng < -180) dLng += 360;
  return lat <= top - pad && lat >= top - AREA_CELL + pad && dLng >= pad && dLng <= AREA_CELL - pad;
}

test('candidate i of a square is the same every time, and the same in the world and detail layers', () => {
  for (const [row, col] of [[0, 0], [255, 511], [511, 1023], [100, 7]]) {
    for (let i = 0; i < 300; i++) assert.deepEqual(candidate(row, col, i), candidate(row, col, i));
  }
  const sq = prepareSquares(pointsOf(binned[0].id), []);
  const world = buildMarks(sq, all(sq), sq.cls, () => 6, R);
  const idx = [0, 1, 2].filter((j) => j < sq.count);
  const detail = buildMarks(sq, idx, idx.map(() => 4), () => 40, R);
  idx.forEach((j, k) => {
    for (let i = 0; i < 6; i++) {
      const w = (j * 6 + i) * 3;
      const d = (k * 40 + i) * 3;
      assert.deepEqual([...world.position.slice(w, w + 3)], [...detail.position.slice(d, d + 3)]);
      assert.equal(world.info[(j * 6 + i) * 4 + 3], detail.info[(k * 40 + i) * 4 + 3], 'size factor');
    }
  });
});

test('the first N candidates of a square are the same at N and at N+M (prefix property)', () => {
  const sq = prepareSquares(pointsOf(binned[0].id), []);
  const idx = all(sq).slice(0, 50);
  const cls = Array.from(idx, (j) => sq.cls[j]);
  const a = buildMarks(sq, idx, cls, () => 7, R);
  const b = buildMarks(sq, idx, cls, () => 7 + 30, R);
  for (let k = 0; k < idx.length; k++)
    for (let i = 0; i < 7; i++) {
      const pa = (k * 7 + i) * 3;
      const pb = (k * 37 + i) * 3;
      assert.deepEqual([...a.position.slice(pa, pa + 3)], [...b.position.slice(pb, pb + 3)]);
    }
});

test('every binned animal: every mark lies inside its own square, inset 4%, and no mark is in a square without records', () => {
  assert.ok(binned.length > 0);
  let marks = 0;
  for (const s of binned) {
    const raw = pointsOf(s.id);
    const sq = prepareSquares(raw, []);
    const has = new Set(raw.map((p) => {
      const { row, col } = squareOf(p[0], p[1]);
      return row * 1024 + col;
    }));
    assert.equal(sq.count, has.size, `${s.name}: one square per distinct lattice square`);
    // candidates beyond the world layer's 6, as the detail layer uses, in exact maths
    for (let j = 0; j < sq.count; j++) {
      assert.ok(has.has(sq.row[j] * 1024 + sq.col[j]), `${s.name}: square without records`);
      for (let i = 0; i < 64; i++) {
        const [lat, lng] = candidate(sq.row[j], sq.col[j], i);
        assert.ok(insideInset(lat, lng, sq.row[j], sq.col[j]), `${s.name}: candidate ${i} of (${sq.row[j]}, ${sq.col[j]}) outside its inset square`);
      }
    }
    // the world layer as built, from its float32 positions
    const m = buildMarks(sq, all(sq), sq.cls, () => 6, R);
    for (let k = 0; k < m.count; k++) {
      const j = Math.floor(k / 6);
      const [lat, lng] = toLatLng(m.position[k * 3], m.position[k * 3 + 1], m.position[k * 3 + 2]);
      assert.ok(insideInset(lat, lng, sq.row[j], sq.col[j], 1e-4), `${s.name}: built mark outside its inset square`);
      const back = squareOf(lat, lng);
      assert.ok(has.has(back.row * 1024 + back.col), `${s.name}: built mark in a square without records`);
    }
    marks += m.count;
  }
  console.log(`  checked ${binned.length} binned animals, ${marks} world marks`);
});

test('seeds come from integer lattice indices: nearby floats in one square give one seed', () => {
  const a = squareOf(12.34999, -71.2);
  const b = squareOf(12.35001, -71.2);
  assert.deepEqual(a, b);
  assert.equal(seedOf(a.row, a.col), seedOf(b.row, b.col));
  // either side of a published centre, as rounding in the file would put it
  const c = -90 + 300.5 * AREA_CELL;
  assert.deepEqual(squareOf(c - 0.001, 10), squareOf(c + 0.001, 10));
  // different squares get different seeds
  assert.notEqual(seedOf(10, 10), seedOf(10, 11));
  assert.notEqual(seedOf(10, 10), seedOf(11, 10));
});

// the class rule of createCellDots as it was before this change (git 92382b3, src/heat.ts), for comparison
function referenceClasses(raw: number[][]) {
  const snap = (v: number, origin: number) => origin + (Math.round((v - origin) / AREA_CELL - 0.5) + 0.5) * AREA_CELL;
  const seen = new Map<string, number[]>();
  for (const p of raw) {
    const lat = snap(p[0], -90);
    const lng = snap(p[1], -180);
    const k = `${lat},${lng}`;
    const hit = seen.get(k);
    if (hit) hit[2] = (hit[2] ?? 0) + (p[2] ?? 0);
    else seen.set(k, p.length > 2 ? [lat, lng, p[2]] : [lat, lng]);
  }
  const points = [...seen.values()];
  const w = points.map((p) => p[2] ?? 1);
  const sorted = [...w].sort((a, b) => a - b);
  const breaks = HEAT_TOP.map((t) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - t)))]);
  const out = new Map<string, number>();
  points.forEach((p, i) => {
    let k = 0;
    while (k < breaks.length && w[i] >= breaks[k] && (k === 0 || breaks[k] > breaks[k - 1])) k++;
    const { row, col } = squareOf(p[0], p[1]);
    out.set(`${row},${col}`, k);
  });
  return out;
}

test('whole-range class breaks match createCellDots on the same input', () => {
  for (const s of binned) {
    const raw = pointsOf(s.id);
    const ref = referenceClasses(raw);
    const sq = prepareSquares(raw, rangeOf(s.id));
    assert.equal(sq.count, ref.size, s.name);
    for (let j = 0; j < sq.count; j++) assert.equal(sq.cls[j], ref.get(`${sq.row[j]},${sq.col[j]}`), `${s.name} (${sq.row[j]}, ${sq.col[j]})`);
  }
});

test('files without counts fall back to the 2° surface', () => {
  const s = binned[0];
  const cells = rangeOf(s.id);
  const sq = prepareSquares(pointsOf(s.id).map((p) => [p[0], p[1]]), cells);
  assert.ok(sq.count > 0);
  assert.ok([...sq.weight].some((w) => w !== 1), 'weights come from the surface, not a flat 1');
});

/** a synthetic animal: squares at the given (row, col), with weights */
function synth(cells: [number, number, number][]): Squares {
  const raw = cells.map(([row, col, w]) => [90 - (row + 0.5) * AREA_CELL, -180 + (col + 0.5) * AREA_CELL, w]);
  return prepareSquares(raw, []);
}

test('re-banding happens only when the box holds at least 30 squares', () => {
  // 200 squares; weights rise along the row, so a box of the 30 weakest re-cut differs from the whole range
  const sq = synth(Array.from({ length: 200 }, (_, i) => [200, 100 + i, i + 2] as [number, number, number]));
  const weakest = (n: number) => Array.from({ length: n }, (_, j) => j);
  const below = weakest(REBAND_MIN - 1);
  assert.deepEqual(boxClasses(sq, below), below.map((j) => sq.cls[j]), 'under 30: whole-range classes');
  assert.ok(below.every((j) => sq.cls[j] === 0));
  const at = weakest(REBAND_MIN);
  const recut = boxClasses(sq, at);
  assert.notDeepEqual(recut, at.map((j) => sq.cls[j]), 'at 30: re-cut from the box');
  assert.equal(Math.max(...recut), 4, 'the busiest of the box get the top class');
});

test('presence floor: 1 with at most 2 squares in the 5x5 neighbourhood, else 2 shared between them; 1 for all under 30', () => {
  // a dense 6x6 block, a pair, and a loner, 42 squares
  const cells: [number, number][] = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) cells.push([100 + r, 100 + c]);
  cells.push([300, 300], [300, 302]); // a pair two apart: each sees 2
  cells.push([400, 500]); // alone
  cells.push([300, 600], [301, 601], [302, 602]); // three in a 5x5: each sees 3
  const f = presenceFloor(cells.map((c) => c[0]), cells.map((c) => c[1]));
  const at = (r: number, c: number) => f[cells.findIndex(([a, b]) => a === r && b === c)];
  assert.equal(at(100, 100), Math.fround(2 / 9)); // a corner of the block sees 3x3 of it
  assert.equal(at(102, 102), Math.fround(2 / 25));
  assert.equal(at(300, 300), 1);
  assert.equal(at(300, 302), 1);
  assert.equal(at(400, 500), 1);
  assert.equal(at(300, 600), Math.fround(2 / 3));
  // across the antimeridian, columns wrap
  const wrap = presenceFloor([10, 10, 10, ...Array(30).fill(200)], [1023, 0, 1, ...Array.from({ length: 30 }, (_, i) => i * 10)]);
  assert.deepEqual([...wrap.slice(0, 3)], [2 / 3, 2 / 3, 2 / 3].map(Math.fround));
  // under 30 squares: every one
  const few = presenceFloor(Array(29).fill(5), Array.from({ length: 29 }, (_, i) => i));
  assert.ok(few.every((v) => v === 1));
});

test('over the detail budget, spacingScale brings the estimate to at most 250,000 and keeps class order', () => {
  const s = binned.reduce((a, b) => (pointsOf(a.id).length >= pointsOf(b.id).length ? a : b));
  const sq = prepareSquares(pointsOf(s.id), []);
  const lat = Array.from(sq.lat);
  const cls = Array.from(sq.cls);
  // every square at the closest zoom on a tall screen: far over the budget
  const px = squarePx(1440, 50, 0.18);
  const plan = detailCounts(lat, cls, px);
  assert.ok(plan.spacingScale > 1, 'scaled');
  assert.ok(plan.total <= DETAIL_BUDGET, `total ${plan.total}`);
  assert.equal(plan.total, plan.n.reduce((a, b) => a + b, 0));
  // at one latitude, a higher class never gets fewer candidates
  const at = (k: number) => detailCounts([0, 0, 0, 0, 0], [0, 1, 2, 3, 4], px, 50).n[k];
  for (let k = 1; k < 5; k++) assert.ok(at(k) >= at(k - 1));
  // under the budget nothing is scaled
  assert.equal(detailCounts([0, 10], [0, 4], squarePx(900, 50, 0.5)).spacingScale, 1);
});

test('dither: under one mark per square, an even share of a run of squares lights, close to the expected count', () => {
  for (const lambda of [0.05, 0.15, 0.33, 0.5, 0.8]) {
    let lit = 0;
    for (let r = 200; r < 220; r++) for (let c = 500; c < 520; c++) if (ditherOf(r, c) < lambda) lit++;
    assert.ok(Math.abs(lit / 400 - lambda) < 0.03, `lambda ${lambda}: ${lit / 400}`);
    // and in every 5x5 block of it, not clumped in one corner
    for (let r = 200; r < 220; r += 5)
      for (let c = 500; c < 520; c += 5) {
        let n = 0;
        for (let dr = 0; dr < 5; dr++) for (let dc = 0; dc < 5; dc++) if (ditherOf(r + dr, c + dc) < lambda) n++;
        assert.ok(Math.abs(n - 25 * lambda) <= 2.5, `lambda ${lambda}, block (${r}, ${c}): ${n}`);
      }
  }
});
