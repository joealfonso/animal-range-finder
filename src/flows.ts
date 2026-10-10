// Pure maths shared by the migration view (src/migration.ts) and the route build (scripts/build-routes.ts). The build
// stores a route for each hop these functions produce, so both sides must compute exactly the same hops.

/** lat, lng, share of that month's records */
export type Place = [number, number, number];

export interface Flow {
  a: number;
  b: number;
  w: number;
  km: number;
}

const rad = Math.PI / 180;

export function kmBetween(p: ArrayLike<number>, q: ArrayLike<number>) {
  const d = Math.sin(((q[0] - p[0]) * rad) / 2) ** 2 + Math.cos(p[0] * rad) * Math.cos(q[0] * rad) * Math.sin(((q[1] - p[1]) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(d)));
}

/** Where each month's records go next: nearest places first, so a place that stays put stays put. */
export function flowsBetween(from: Place[], to: Place[]): Flow[] {
  const ra = from.map((p) => p[2]);
  const rb = to.map((p) => p[2]);
  const pairs: Flow[] = [];
  from.forEach((p, a) => to.forEach((q, b) => pairs.push({ a, b, w: 0, km: kmBetween(p, q) })));
  pairs.sort((x, y) => x.km - y.km);
  const out: Flow[] = [];
  for (const f of pairs) {
    const m = Math.min(ra[f.a], rb[f.b]);
    if (m <= 1e-6) continue;
    ra[f.a] -= m;
    rb[f.b] -= m;
    out.push({ ...f, w: m });
  }
  return out;
}

/** Drops the faint places (a stray record far from the rest reads as a long hop to nowhere) and makes each month add up to 1 again. */
export function tidyMonths(months: Place[][]): Place[][] {
  return months.map((m) => {
    const keep = m.filter((p) => p[2] >= 0.04);
    const sum = keep.reduce((t, p) => t + p[2], 0);
    return sum ? keep.map((p) => [p[0], p[1], Math.round((p[2] / sum) * 10000) / 10000] as Place) : m;
  });
}

/** The key a hop's route is stored under: month it leaves, place it leaves, place it reaches. */
export const hopKey = (k: number, a: number, b: number) => `${k}:${a}:${b}`;

/** How an animal gets about, which decides what a route may cross. */
export type Medium = 'sea' | 'land' | 'air' | 'air-land';

/** What the build stores next to an animal's months. */
export interface Routes {
  medium: Medium;
  /** how far dots scatter around a place, degrees */
  spread: number;
  /** hop key to waypoints, lat/lng; the app runs a great circle between neighbours */
  hops: Record<string, [number, number][]>;
}
