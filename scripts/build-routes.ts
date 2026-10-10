// Adds `routes` to public/data/seasons/<id>.json: the path each hop of the Migration view follows from one month's place to the next.
// A straight great circle cuts across land for a whale and across the sea for a bear, so every hop is routed instead:
//   - the route stays in the animal's own medium (sea for a whale, land for a bear; birds may cross water, but at a cost),
//   - and it is pulled towards places where the animal has actually been recorded (public/data/points), so it follows
//     coasts, flyways and shelf seas rather than the shortest line.
// It is a best guess at the way between two known places, not a tracked journey: GBIF holds records, not individual tracks.
// Run after build-seasons.ts (npm run seasons does both). Needs public/data/species.json, countries.json and points/. No network.
// It also tidies the months (faint places dropped, shares renormalised) and moves any place that sits in the wrong medium
// (a whale's centroid over land) to the nearest right one, so the app can draw the months as they are stored.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { flowsBetween, hopKey, kmBetween, tidyMonths, type Medium, type Place, type Routes } from '../src/flows';
import type { Species } from '../src/types';

/** How each migrating animal gets about, by everyday name. A new migrating animal must be added here. */
const MEDIUM: Record<string, Medium> = {
  'Atlantic bluefin tuna': 'sea',
  'Common bottlenose dolphin': 'sea',
  Orca: 'sea',
  'Blue whale': 'sea',
  'Beluga whale': 'sea',
  'American lobster': 'sea',
  'Atlantic puffin': 'sea',
  'Brown bear': 'land',
  'Arctic fox': 'land',
  Osprey: 'air-land',
  'Andean condor': 'air-land',
  'Common cuckoo': 'air-land',
  'Barn swallow': 'air-land',
  'Painted lady': 'air',
};
const SPREAD: Record<Medium, number> = { sea: 2, land: 2.5, 'air-land': 4, air: 5 }; // degrees dots scatter around a place
const WRONG: Record<Medium, number> = { sea: 30, land: 30, 'air-land': 3, air: 1 }; // cost of crossing the medium an animal avoids
const PULL: Record<Medium, number> = { sea: 3, land: 3, 'air-land': 2, air: 1.5 }; // how strongly records bend the route (cost of an unrecorded cell is 1 + PULL)
const COAST = 1.5; // sea routes keep off the shore: cost of a cell next to land
const MIN_ROUTE_KM = 100; // shorter hops stay a straight line

// ---- the grid: 0.5 degree cells, wrapping round the world
const STEP = 0.5;
const W = 360 / STEP;
const H = 180 / STEP;
const rad = Math.PI / 180;
const cellX = (lng: number) => ((Math.floor((lng + 180) / STEP) % W) + W) % W;
const cellY = (lat: number) => Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / STEP)));
const cellLng = (x: number) => -180 + (x + 0.5) * STEP;
const cellLat = (y: number) => 90 - (y + 0.5) * STEP;
const cosRow = Float64Array.from({ length: H }, (_, y) => Math.max(0.02, Math.cos(cellLat(y) * rad)));
const KM = 111.19 * STEP;

/** Fills the cells whose centre lies inside any country (even-odd, holes included). Everything else is sea. */
async function landMask() {
  const mask = new Uint8Array(W * H);
  const fc = JSON.parse(await readFile('public/data/countries.json', 'utf8'));
  const fill = (rings: number[][][]) => {
    for (let y = 0; y < H; y++) {
      const lat = cellLat(y);
      const xs: number[] = [];
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [x1, y1] = ring[j];
          const [x2, y2] = ring[i];
          if (y1 > lat !== y2 > lat) xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.ceil((xs[i] + 180) / STEP - 0.5)); x <= Math.min(W - 1, Math.floor((xs[i + 1] + 180) / STEP - 0.5)); x++) mask[y * W + x] = 1;
      }
    }
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') fill(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) fill(poly);
  }
  return mask;
}

/** 0..1 for how much an animal has been recorded in and around each cell, log-scaled so a few hotspots do not drown the rest. */
async function recordDensity(id: number) {
  const pts: number[][] = JSON.parse(await readFile(`public/data/points/${id}.json`, 'utf8'));
  let grid = new Float32Array(W * H);
  for (const [lat, lng] of pts) grid[cellY(lat) * W + cellX(lng)]++;
  for (let pass = 0; pass < 2; pass++) {
    // a box blur, three cells each way, so the pull reaches the sea beside a coastal record
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let dy = -3; dy <= 3; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -3; dx <= 3; dx++) s += grid[yy * W + ((x + dx + W) % W)];
        }
        out[y * W + x] = s;
      }
    }
    grid = out;
  }
  let max = 0;
  for (const v of grid) max = Math.max(max, v);
  const d = new Float32Array(W * H);
  const top = Math.log1p(max) || 1;
  for (let i = 0; i < d.length; i++) d[i] = Math.log1p(grid[i]) / top;
  return d;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    let i = this.k.length;
    this.k.push(key);
    this.v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const key = this.k.pop()!;
    const val = this.v.pop()!;
    const n = this.k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c];
        this.v[i] = this.v[c];
        i = c;
      }
      this.k[i] = key;
      this.v[i] = val;
    }
    return top;
  }
}

const mask = await landMask();

/** Routing for one animal: how costly each cell is to cross, and the searches built on that. */
function router(medium: Medium, density: Float32Array) {
  const cost = new Float32Array(W * H);
  const near = new Uint8Array(W * H); // cells within `margin` cells of the other medium, for keeping off shores
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const land = mask[i] === 1;
      let wrong = 1;
      if (medium === 'sea' && land) wrong = WRONG.sea;
      else if (medium === 'land' && !land) wrong = WRONG.land;
      else if (medium === 'air-land' && !land) wrong = WRONG['air-land'];
      let c = wrong * (1 + PULL[medium] * (1 - density[i]));
      if (Math.abs(cellLat(y)) > 80) c *= 1 + (Math.abs(cellLat(y)) - 80) / 2; // the rows by the poles are barely wide: crossing them east to west is not a shortcut
      if (medium === 'sea' && !land) {
        for (let dy = -1; dy <= 1 && !near[i]; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          if (yy >= 0 && yy < H && mask[yy * W + ((x + dx + W) % W)] === 1) { near[i] = 1; break; }
        }
        if (near[i]) c *= COAST;
      }
      cost[i] = c;
    }
  }

  /** Is this cell the right kind of place to be? (Air has no wrong place.) */
  const right = (i: number) => (medium === 'sea' ? mask[i] === 0 : medium === 'land' ? mask[i] === 1 : true);
  /** The same, and at least two cells from the shore, for sea animals. */
  const roomy = (x: number, y: number) => {
    if (!right(y * W + x)) return false;
    if (medium !== 'sea') return true;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy;
      if (yy >= 0 && yy < H && mask[yy * W + ((x + dx + W) % W)] === 1) return false;
    }
    return true;
  };

  /** Moves a place that sits in the wrong medium (or hard against the shore) to the nearest good cell. */
  function snap(lat: number, lng: number): [number, number] {
    if (medium === 'air' || medium === 'air-land') return [lat, lng];
    const x0 = cellX(lng);
    const y0 = cellY(lat);
    if (roomy(x0, y0)) return [lat, lng];
    let fallback: [number, number] | null = null;
    for (let r = 1; r <= 60; r++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = (x0 + dx + W) % W;
          const d = kmBetween([lat, lng], [cellLat(y), cellLng(x)]);
          if (d >= bestD) continue;
          if (roomy(x, y)) { best = [cellLat(y), cellLng(x)]; bestD = d; }
          else if (!fallback && right(y * W + x)) fallback = [cellLat(y), cellLng(x)];
        }
      }
      if (best) return best;
      if (fallback && r >= 6) return fallback; // nothing with room to spare close by: take the nearest right cell
    }
    return fallback ?? [lat, lng];
  }

  const atCell = (lat: number, lng: number) => cost[cellY(lat) * W + cellX(lng)];

  // ---- costs along straight lines
  const xyz = (lat: number, lng: number): [number, number, number] => [Math.cos(lat * rad) * Math.cos(lng * rad), Math.cos(lat * rad) * Math.sin(lng * rad), Math.sin(lat * rad)];
  /** Cost of the great circle from one point to another, sampled every ~0.25 degrees. */
  function lineCost(p: number[], q: number[]) {
    const a = xyz(p[0], p[1]);
    const b = xyz(q[0], q[1]);
    const ang = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const n = Math.max(1, Math.ceil((ang / rad) / 0.25));
    const so = Math.sin(ang);
    const km = ang * 6371;
    let sum = 0;
    for (let s = 0; s < n; s++) {
      const u = (s + 0.5) / n;
      const wa = so < 1e-6 ? 1 - u : Math.sin((1 - u) * ang) / so;
      const wb = so < 1e-6 ? u : Math.sin(u * ang) / so;
      const x = a[0] * wa + b[0] * wb;
      const y = a[1] * wa + b[1] * wb;
      const z = a[2] * wa + b[2] * wb;
      sum += atCell(Math.atan2(z, Math.hypot(x, y)) / rad, Math.atan2(y, x) / rad);
    }
    return (sum / n) * km;
  }

  // ---- search
  const g = new Float32Array(W * H);
  const seen = new Int32Array(W * H);
  const from = new Int32Array(W * H);
  let stamp = 0;

  /** Cheapest chain of cells from one cell to another, as [lat, lng] cell centres. */
  function search(a: [number, number], b: [number, number]): [number, number][] | null {
    stamp++;
    const start = cellY(a[0]) * W + cellX(a[1]);
    const goal = cellY(b[0]) * W + cellX(b[1]);
    const gy = Math.floor(goal / W);
    const heap = new Heap();
    g[start] = 0;
    seen[start] = stamp;
    from[start] = -1;
    heap.push(0, start);
    const done = new Set<number>();
    while (heap.size) {
      const i = heap.pop();
      if (done.has(i)) continue;
      done.add(i);
      if (i === goal) break;
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = yy * W + ((x + dx + W) % W);
          const ex = dx * KM * (cosRow[y] + cosRow[yy]) / 2;
          const km = Math.hypot(ex, dy * KM);
          const ng = g[i] + km * (cost[i] + cost[j]) / 2;
          if (seen[j] !== stamp || ng < g[j]) {
            seen[j] = stamp;
            g[j] = ng;
            from[j] = i;
            heap.push(ng + kmBetween([cellLat(yy), cellLng(j % W)], [cellLat(gy), cellLng(goal % W)]), j);
          }
        }
      }
    }
    if (seen[goal] !== stamp) return null;
    const out: [number, number][] = [];
    for (let i = goal; i >= 0; i = from[i]) out.push([cellLat(Math.floor(i / W)), cellLng(i % W)]);
    return out.reverse();
  }

  /** Pulls corners out of a grid path wherever a straight line is about as cheap as the route it replaces. */
  function straighten(path: [number, number][]) {
    const pre = [0];
    for (let i = 1; i < path.length; i++) pre.push(pre[i - 1] + lineCost(path[i - 1], path[i]));
    const out: [number, number][] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = Math.min(path.length - 1, i + 80);
      for (; j > i + 1; j--) if (lineCost(path[i], path[j]) <= (pre[j] - pre[i]) * 1.04) break;
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  const total = (pts: number[][]) => pts.slice(1).reduce((s, p, i) => s + lineCost(pts[i], p), 0);

  /** Rounds off the corners (Chaikin), as far as the curve stays about as cheap as the corners it replaces. */
  function smooth(pts: [number, number][]) {
    if (pts.length < 3) return pts;
    // unwrap longitudes so a path over the date line is one continuous run
    const run = pts.map((p) => [...p] as [number, number]);
    for (let i = 1; i < run.length; i++) while (run[i][1] - run[i - 1][1] > 180) run[i][1] -= 360;
    for (let i = 1; i < run.length; i++) while (run[i][1] - run[i - 1][1] < -180) run[i][1] += 360;
    const base = total(run);
    let cur = run;
    let best = run;
    for (let it = 0; it < 3; it++) {
      const next: [number, number][] = [cur[0]];
      for (let i = 0; i < cur.length - 1; i++) {
        const p = cur[i];
        const q = cur[i + 1];
        next.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
      }
      next.push(cur[cur.length - 1]);
      if (total(next) > base * 1.04) break;
      cur = next;
      best = next;
    }
    return best.map(([lat, lng]) => [lat, ((lng + 540) % 360) - 180] as [number, number]);
  }

  /** The route between two places, or null when a straight line will do. */
  function route(p: Place, q: Place): [number, number][] | null {
    const path = search([p[0], p[1]], [q[0], q[1]]);
    if (!path) return null;
    const pts = smooth(straighten(path));
    pts[0] = [p[0], p[1]];
    pts[pts.length - 1] = [q[0], q[1]];
    return pts;
  }

  /** Share of a route that runs through the medium the animal avoids. */
  function wrongShare(pts: number[][]) {
    let bad = 0;
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = xyz(pts[i - 1][0], pts[i - 1][1]);
      const b = xyz(pts[i][0], pts[i][1]);
      const ang = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
      const n = Math.max(1, Math.ceil(ang / rad / 0.25));
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        const so = Math.sin(ang) || 1;
        const wa = Math.sin((1 - u) * ang) / so;
        const wb = Math.sin(u * ang) / so;
        const x = a[0] * wa + b[0] * wb, y = a[1] * wa + b[1] * wb, z = a[2] * wa + b[2] * wb;
        const c = cellY(Math.atan2(z, Math.hypot(x, y)) / rad) * W + cellX(Math.atan2(y, x) / rad);
        if (!right(c) && medium !== 'air-land') bad++;
        else if (medium === 'air-land' && mask[c] === 0) bad++;
        len++;
      }
    }
    return len ? bad / len : 0;
  }

  return { snap, route, wrongShare };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

const { species } = JSON.parse(await readFile('public/data/species.json', 'utf8')) as { species: Species[] };
const only = process.env.SPECIES ? new Set(process.env.SPECIES.split(',').map((s) => s.trim())) : null;
const files = (await readdir('public/data/seasons')).filter((f) => f.endsWith('.json'));
let hops = 0;
for (const f of files) {
  const id = Number(f.replace('.json', ''));
  const s = species.find((x) => x.id === id);
  if (!s) throw new Error(`${f}: no animal with that id in species.json`);
  if (only && !only.has(s.sci)) continue;
  const medium = MEDIUM[s.name];
  if (!medium) throw new Error(`${s.name}: say how it travels (sea, land, air or air-land) in MEDIUM in scripts/build-routes.ts`);
  const file = JSON.parse(await readFile(`public/data/seasons/${f}`, 'utf8'));
  const R = router(medium, await recordDensity(id));
  const months = tidyMonths(file.months as Place[][]).map((m) =>
    m.map((p) => {
      const [lat, lng] = R.snap(p[0], p[1]);
      return [r1(lat), r1(lng), p[2]] as Place;
    }),
  );
  const out: Routes = { medium, spread: SPREAD[medium], hops: {} };
  let n = 0;
  let wrong = 0;
  let worst = 0;
  months.forEach((m, k) => {
    const next = months[(k + 1) % 12];
    // December's last hop sends every dot back to where it started, so any pair of places can be asked for
    const hopsFor: { a: number; b: number; km: number }[] =
      k === 11 ? m.flatMap((p, a) => next.map((q, b) => ({ a, b, km: kmBetween(p, q) }))) : flowsBetween(m, next);
    for (const flow of hopsFor) {
      if (flow.a === flow.b && k !== 11) continue;
      if (flow.km < MIN_ROUTE_KM) continue;
      const pts = R.route(m[flow.a], next[flow.b]);
      if (!pts) continue;
      out.hops[hopKey(k, flow.a, flow.b)] = pts.map(([lat, lng]) => [r1(lat), r1(lng)]);
      n++;
      const w = R.wrongShare(pts);
      wrong += w;
      worst = Math.max(worst, w);
    }
  });
  await writeFile(`public/data/seasons/${f}`, JSON.stringify({ ...file, months, routes: out }));
  hops += n;
  console.log(`${s.name}: ${medium}, ${n} routes, avg ${Math.round((wrong / Math.max(1, n)) * 100)}% / worst ${Math.round(worst * 100)}% in the wrong medium`);
}
console.log(`routes: ${hops} hops routed`);
