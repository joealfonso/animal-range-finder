import * as THREE from 'three';
import type { Cell } from './types';

// Record-density surface for one animal, drawn as stepped bands with thin contour lines (an isopleth map, like a
// printed atlas) on a transparent sphere just above the globe. It shows where wild records concentrate. It is not a
// population count.
//
// Two layers share the drawing code:
// - the world layer, a smoothed estimate from the animal's 2° GBIF cells, for the whole range;
// - the detail layer, for a zoomed-in view: redrawn from the individual records in view, with a tighter kernel and
//   finer pixels, and banded against the densest spot in view rather than in the whole range. Without it, zooming
//   into a country shows soft 2° blobs that miss the records, and places with a modest share of the records fall
//   under the faintest band and vanish.

const CUT = [0.08, 0.2, 0.36, 0.55, 0.75]; // band thresholds on the normalised density
const R = 100;

// tints of the one accent, light-to-dark ink on dark ground; index 0 is "no band"
export const HEAT_BANDS: [number, number, number, number][] = [
  [0, 0, 0, 0],
  [255, 90, 54, 0.16],
  [255, 90, 54, 0.3],
  [255, 104, 64, 0.42],
  [255, 128, 84, 0.54],
  [255, 160, 118, 0.66],
];
const CONTOUR: [number, number, number] = [255, 90, 54];
const CONTOUR_ALPHA = 0.7;

/** A lat/lng box. lng0..lng1 may run past ±180 when a box crosses the antimeridian. */
interface Box {
  lat0: number;
  lat1: number;
  lng0: number;
  lng1: number;
}
const WORLD: Box = { lat0: -90, lat1: 90, lng0: -180, lng1: 180 };

/**
 * A vector layer on a patch of sphere covering a lat/lng box: density is sampled on a node grid, then each band is
 * extracted as filled polygons (marching squares) with a contour line along its edge. Geometry, not pixels, so the
 * edges stay sharp at any zoom.
 */
function heatLayer(W: number, H: number, radius: number, order: number) {
  const group = new THREE.Group();
  group.rotation.y = -Math.PI / 2; // three-globe faces the prime meridian along Z; match it so the map lines up
  group.visible = false;

  // the fill of each band is drawn as the whole region at or above its threshold; alphas are set so the stack
  // adds up to the band's own alpha
  const fillMats = HEAT_BANDS.slice(1).map((c, k) => {
    const prev = k === 0 ? 0 : HEAT_BANDS[k][3];
    const a = (c[3] - prev) / (1 - prev);
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255).convertSRGBToLinear(),
      transparent: true,
      opacity: a,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  });
  const lineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(CONTOUR[0] / 255, CONTOUR[1] / 255, CONTOUR[2] / 255).convertSRGBToLinear(),
    transparent: true,
    opacity: CONTOUR_ALPHA,
    depthWrite: false,
  });
  const fills = fillMats.map((m, k) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.renderOrder = order + k * 0.001;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
  lines.renderOrder = order + 0.01;
  lines.frustumCulled = false;
  group.add(lines);

  const NX = W + 1;
  const NY = H + 1;
  const density = new Float32Array(NX * NY);
  const rad = Math.PI / 180;

  /** Same mapping as THREE.SphereGeometry (phi from lng -180°, theta from the pole), so the group rotation matches. */
  function place(lat: number, lng: number, out: number[]) {
    const phi = (lng + 180) * rad;
    const theta = (90 - lat) * rad;
    const s = Math.sin(theta);
    out.push(-radius * Math.cos(phi) * s, radius * Math.cos(theta), radius * Math.sin(phi) * s);
  }

  /**
   * Kernel density of weighted points over the box, in degrees (longitude distances shrink with latitude), then
   * normalised and turned into bands. Returns false when nothing lands in the box.
   */
  function draw(b: Box, pts: ArrayLike<number>[], sigma: number, weightOf: (p: ArrayLike<number>) => number) {
    density.fill(0);
    const world = b.lng1 - b.lng0 >= 360;
    const pxLat = H / (b.lat1 - b.lat0);
    const pxLng = W / (b.lng1 - b.lng0);
    const reach = sigma * 3;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const midLng = (b.lng0 + b.lng1) / 2;

    for (const p of pts) {
      const lat = p[0];
      // the copy of the point nearest the box, so a box across the antimeridian gets points from both sides
      const lng = world ? p[1] : p[1] + 360 * Math.round((midLng - p[1]) / 360);
      if (lat + reach < b.lat0 || lat - reach > b.lat1) continue;
      const weight = weightOf(p);
      const y0 = Math.max(0, Math.floor((b.lat1 - (lat + reach)) * pxLat));
      const y1 = Math.min(H, Math.ceil((b.lat1 - (lat - reach)) * pxLat));
      for (let y = y0; y <= y1; y++) {
        const plat = b.lat1 - y / pxLat;
        const dLat = plat - lat;
        const cos = Math.max(0.05, Math.cos(plat * rad));
        const lngReach = Math.min(180, reach / cos);
        let x0 = Math.floor((lng - lngReach - b.lng0) * pxLng);
        let x1 = Math.ceil((lng + lngReach - b.lng0) * pxLng);
        if (!world) {
          x0 = Math.max(0, x0);
          x1 = Math.min(W, x1);
        }
        for (let xi = x0; xi <= x1; xi++) {
          const x = world ? ((xi % W) + W) % W : xi; // the world layer wraps across the antimeridian
          const dLng = (xi / pxLng + b.lng0 - lng) * cos;
          const d2 = dLat * dLat + dLng * dLng;
          if (d2 > reach * reach) continue;
          density[y * NX + x] += weight * Math.exp(-d2 * inv2s2);
        }
      }
    }
    if (world) for (let y = 0; y < NY; y++) density[y * NX + W] = density[y * NX];

    let max = 0;
    for (let i = 0; i < density.length; i++) if (density[i] > max) max = density[i];
    if (max <= 0) {
      for (const m of fills) m.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      return false;
    }
    // square root lifts the thin edges of a range so the low bands are visible
    for (let i = 0; i < density.length; i++) density[i] = Math.sqrt(density[i] / max);

    const dLat = (b.lat1 - b.lat0) / H;
    const dLng = (b.lng1 - b.lng0) / W;
    const latAt = (y: number) => b.lat1 - y * dLat;
    const lngAt = (x: number) => b.lng0 + x * dLng;
    const segs: number[] = [];

    fills.forEach((mesh, k) => {
      const c = CUT[k];
      const tris: number[] = [];
      const poly: number[][] = []; // [lat, lng] of the clipped cell, in walk order
      const kind: number[] = []; // 0 corner, 1 exit crossing (in→out), 2 entry crossing (out→in)
      const q: number[] = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = [
            density[y * NX + x],
            density[y * NX + x + 1],
            density[(y + 1) * NX + x + 1],
            density[(y + 1) * NX + x],
          ];
          const inside = [v[0] >= c, v[1] >= c, v[2] >= c, v[3] >= c];
          if (!inside[0] && !inside[1] && !inside[2] && !inside[3]) continue;
          const cl = [latAt(y), latAt(y), latAt(y + 1), latAt(y + 1)];
          const cg = [lngAt(x), lngAt(x + 1), lngAt(x + 1), lngAt(x)];
          poly.length = 0;
          kind.length = 0;
          for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            if (inside[i]) {
              poly.push([cl[i], cg[i]]);
              kind.push(0);
            }
            if (inside[i] !== inside[j]) {
              const t = (c - v[i]) / (v[j] - v[i]);
              poly.push([cl[i] + (cl[j] - cl[i]) * t, cg[i] + (cg[j] - cg[i]) * t]);
              kind.push(inside[i] ? 1 : 2);
            }
          }
          for (let i = 1; i + 1 < poly.length; i++) {
            for (const p of [poly[0], poly[i], poly[i + 1]]) place(p[0], p[1], tris);
          }
          // contour: each exit crossing joins the crossing that follows it (an entry), around the cell
          for (let i = 0; i < poly.length; i++) {
            if (kind[i] !== 1) continue;
            const n = poly[(i + 1) % poly.length];
            q.length = 0;
            place(poly[i][0], poly[i][1], q);
            place(n[0], n[1], q);
            for (const n of q) segs.push(n);
          }
        }
      }
      mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
      mesh.geometry = g;
    });

    lines.geometry.dispose();
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    lines.geometry = lg;
    return true;
  }

  return { mesh: group, draw };
}

/** The whole range from 2° cells: ~0.18° per pixel, smoothed over about one cell. */
export function createHeat(globeRadius = R, altitude = 0.0045) {
  const layer = heatLayer(360, 180, globeRadius * (1 + altitude), 0.5);
  return {
    mesh: layer.mesh,
    /** weights were stored as sqrt(count/max), so square them back */
    show(cells: Cell[]) {
      layer.draw(WORLD, cells, 2.2, (c) => c[2] * c[2]);
      layer.mesh.visible = cells.length > 0;
    },
    hide() {
      layer.mesh.visible = false;
    },
    setVisible(v: boolean) {
      layer.mesh.visible = v;
    },
  };
}

/**
 * The records in a zoomed-in view, redrawn each time the camera settles somewhere new. `halfSpan` is half the height
 * of the box in degrees of latitude; the box is wider in longitude so it covers the same ground. `sigma` is the
 * smoothing radius in degrees.
 */
export function createDetailHeat(globeRadius = R, altitude = 0.0052) {
  const layer = heatLayer(320, 320, globeRadius * (1 + altitude), 0.55);
  return {
    mesh: layer.mesh,
    draw(pts: number[][], lat: number, lng: number, halfSpan: number, sigma: number) {
      const lat0 = Math.max(-90, lat - halfSpan);
      const lat1 = Math.min(90, lat + halfSpan);
      const cos = Math.max(0.12, Math.cos((Math.min(89, Math.max(Math.abs(lat0), Math.abs(lat1))) * Math.PI) / 180));
      const halfLng = Math.min(180, halfSpan / cos);
      const box = { lat0, lat1, lng0: lng - halfLng, lng1: lng + halfLng };
      return layer.draw(box, pts, sigma, () => 1);
    },
    setVisible(v: boolean) {
      layer.mesh.visible = v;
    },
  };
}
