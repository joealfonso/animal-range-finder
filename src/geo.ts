import type { Cell, Country, Pov, StateFeature } from './types';

const rad = Math.PI / 180;
const deg = 180 / Math.PI;

type Vec = [number, number, number];
const toVec = (lat: number, lng: number): Vec => [
  Math.cos(lat * rad) * Math.cos(lng * rad),
  Math.cos(lat * rad) * Math.sin(lng * rad),
  Math.sin(lat * rad),
];
const fromVec = ([x, y, z]: Vec) => {
  const n = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(z / n) * deg, lng: Math.atan2(y, x) * deg };
};
const angle = (a: Vec, b: Vec) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * deg;

/** Label anchor and rough angular size of a country, from its largest polygon. */
export function annotateCountry(c: Country | StateFeature) {
  const polys = (c.geometry.type === 'Polygon' ? [c.geometry.coordinates] : c.geometry.coordinates) as number[][][][];
  let best: { area: number; box: [number, number, number, number] } | null = null;
  for (const poly of polys) {
    const ring = poly[0];
    let minX = 999, maxX = -999, minY = 999, maxY = -999;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area > best.area) best = { area, box: [minX, minY, maxX, maxY] };
  }
  const [minX, minY, maxX, maxY] = best!.box;
  c.center = { lat: (minY + maxY) / 2, lng: (minX + maxX) / 2 };
  c.span = Math.max(maxX - minX, (maxY - minY) * 1.2);
}

export function countryPov(c: Country | StateFeature): Pov {
  const span = c.span ?? 6;
  return { lat: c.center!.lat, lng: c.center!.lng, altitude: Math.min(1.7, Math.max(0.22, 0.16 + span * 0.026)) };
}

/** Weighted centre of an occurrence-density grid plus how widely it spreads. */
export function rangePov(cells: Cell[]): Pov & { spread: number } {
  let sx = 0, sy = 0, sz = 0;
  for (const [la, lo, w] of cells) {
    const v = toVec(la, lo);
    sx += v[0] * w;
    sy += v[1] * w;
    sz += v[2] * w;
  }
  const c = fromVec([sx, sy, sz]);
  const cv = toVec(c.lat, c.lng);
  const dists = cells.map(([la, lo, w]) => ({ d: angle(cv, toVec(la, lo)), w })).sort((a, b) => a.d - b.d);
  const total = dists.reduce((t, x) => t + x.w, 0);
  let acc = 0;
  let spread = 0;
  for (const x of dists) {
    acc += x.w;
    spread = x.d;
    if (acc >= total * 0.82) break;
  }
  const altitude = spread > 75 ? 2.5 : Math.min(2.3, Math.max(0.85, 0.75 + spread * 0.034));
  return { lat: c.lat, lng: c.lng, altitude, spread };
}

// ---- point in polygon, for picking a country or state under the cursor without raycasting meshes
type Ring = number[][];
type Shape = { geometry: { type: string; coordinates: any } };

const inRing = (x: number, y: number, ring: Ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export interface Pickable<T> {
  item: T;
  polys: Ring[][];
  box: [number, number, number, number];
}

export function toPickable<T extends Shape>(item: T): Pickable<T> {
  const polys: Ring[][] = item.geometry.type === 'Polygon' ? [item.geometry.coordinates] : item.geometry.coordinates;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const poly of polys)
    for (const [x, y] of poly[0]) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return { item, polys, box: [x0, y0, x1, y1] };
}

export function pickAt<T>(list: Pickable<T>[], lat: number, lng: number): T | null {
  for (const p of list) {
    const [x0, y0, x1, y1] = p.box;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    for (const poly of p.polys) {
      if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lng, lat, h))) return p.item;
    }
  }
  return null;
}
