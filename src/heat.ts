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

/** A canvas texture on a patch of sphere covering `box`, plus the buffers to draw density bands into it. */
function heatLayer(W: number, H: number, radius: number, order: number) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.rotation.y = -Math.PI / 2; // three-globe faces the prime meridian along Z; match it so the map lines up
  mesh.renderOrder = order; // under the border lines
  mesh.visible = false;

  const density = new Float32Array(W * H);
  const norm = new Float32Array(W * H);
  const rad = Math.PI / 180;
  let box: Box | null = null;

  /** Equirectangular patch, north at the top of the canvas: phi runs with longitude from -180°, theta from the pole. */
  function setBox(b: Box) {
    box = b;
    mesh.geometry.dispose();
    const lngSpan = b.lng1 - b.lng0;
    const latSpan = b.lat1 - b.lat0;
    mesh.geometry = new THREE.SphereGeometry(
      radius,
      Math.max(8, Math.ceil(lngSpan / 3.75)),
      Math.max(6, Math.ceil(latSpan / 2.8)),
      (b.lng0 + 180) * rad,
      lngSpan * rad,
      (90 - b.lat1) * rad,
      latSpan * rad,
    );
  }

  /**
   * Kernel density of weighted points over the box, in degrees (longitude distances shrink with latitude), then
   * normalised and drawn as bands. Returns false when nothing lands in the box.
   */
  function draw(b: Box, pts: ArrayLike<number>[], sigma: number, weightOf: (p: ArrayLike<number>) => number) {
    if (!box || box.lat0 !== b.lat0 || box.lat1 !== b.lat1 || box.lng0 !== b.lng0 || box.lng1 !== b.lng1) setBox(b);
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
      const y1 = Math.min(H - 1, Math.ceil((b.lat1 - (lat - reach)) * pxLat));
      for (let y = y0; y <= y1; y++) {
        const plat = b.lat1 - (y + 0.5) / pxLat;
        const dLat = plat - lat;
        const cos = Math.max(0.05, Math.cos(plat * rad));
        const lngReach = Math.min(180, reach / cos);
        let x0 = Math.floor((lng - lngReach - b.lng0) * pxLng);
        let x1 = Math.ceil((lng + lngReach - b.lng0) * pxLng);
        if (!world) {
          x0 = Math.max(0, x0);
          x1 = Math.min(W - 1, x1);
        }
        for (let xi = x0; xi <= x1; xi++) {
          const x = world ? ((xi % W) + W) % W : xi; // the world layer wraps across the antimeridian
          const dLng = ((xi + 0.5) / pxLng + b.lng0 - lng) * cos;
          const d2 = dLat * dLat + dLng * dLng;
          if (d2 > reach * reach) continue;
          density[y * W + x] += weight * Math.exp(-d2 * inv2s2);
        }
      }
    }

    let max = 0;
    for (let i = 0; i < density.length; i++) if (density[i] > max) max = density[i];
    const data = img.data;
    if (max <= 0) {
      data.fill(0);
      ctx.putImageData(img, 0, 0);
      tex.needsUpdate = true;
      return false;
    }
    // square root lifts the thin edges of a range so the low bands are visible
    for (let i = 0; i < density.length; i++) norm[i] = Math.sqrt(density[i] / max);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = norm[i];
        const o = i * 4;
        if (d < CUT[0] * 0.6) {
          data[o + 3] = 0;
          continue;
        }
        // how fast density changes here, in units per pixel: sets the width of one pixel at each band edge,
        // so band edges and contours come out anti-aliased instead of stair-stepped
        const xl = world ? (x - 1 + W) % W : Math.max(0, x - 1);
        const xr = world ? (x + 1) % W : Math.min(W - 1, x + 1);
        const gx = (norm[y * W + xr] - norm[y * W + xl]) / 2;
        const gy = (y > 0 && y < H - 1 ? norm[i + W] - norm[i - W] : 0) / 2;
        const g = Math.sqrt(gx * gx + gy * gy) + 1e-5;
        // nearest band edge
        let k = 0;
        for (let j = 1; j < CUT.length; j++) if (Math.abs(d - CUT[j]) < Math.abs(d - CUT[k])) k = j;
        const t = Math.min(1, Math.max(0, (d - CUT[k]) / g + 0.5));
        const lo = HEAT_BANDS[k];
        const hi = HEAT_BANDS[k + 1];
        let r = lo[0] + (hi[0] - lo[0]) * t;
        let gg = lo[1] + (hi[1] - lo[1]) * t;
        let bl = lo[2] + (hi[2] - lo[2]) * t;
        let a = lo[3] + (hi[3] - lo[3]) * t;
        // one-pixel contour line on the edge, over the fill
        const line = Math.max(0, 1 - Math.abs(d - CUT[k]) / g) * CONTOUR_ALPHA;
        if (line > 0) {
          const na = line + a * (1 - line);
          r = (CONTOUR[0] * line + r * a * (1 - line)) / na;
          gg = (CONTOUR[1] * line + gg * a * (1 - line)) / na;
          bl = (CONTOUR[2] * line + bl * a * (1 - line)) / na;
          a = na;
        }
        data[o] = r;
        data[o + 1] = gg;
        data[o + 2] = bl;
        data[o + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    tex.needsUpdate = true;
    return true;
  }

  return { mesh, draw };
}

/** The whole range from 2° cells: ~0.18° per pixel, smoothed over about one cell. */
export function createHeat(globeRadius = R, altitude = 0.0045) {
  const layer = heatLayer(2048, 1024, globeRadius * (1 + altitude), 0.5);
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
  const layer = heatLayer(1024, 1024, globeRadius * (1 + altitude), 0.55);
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
