import * as THREE from 'three';
import type { Cell } from './types';

// Record-density surface for one animal: a smoothed estimate from its 2° GBIF cells, drawn as stepped bands with
// thin contour lines (an isopleth map, like a printed atlas) on one transparent sphere just above the globe.
// It shows where wild records concentrate. It is not a population count.

const W = 2048; // ~0.18° per pixel, equirectangular (north up), same layout as the globe texture
const H = 1024;
const SIGMA = 2.2; // smoothing radius in degrees, about one cell
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

export function createHeat(globeRadius = R, altitude = 0.0045) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(globeRadius * (1 + altitude), 96, 64), mat);
  mesh.rotation.y = -Math.PI / 2; // three-globe faces the prime meridian along Z; match it so the map lines up
  mesh.renderOrder = 0.5; // under the border lines
  mesh.visible = false;

  const density = new Float32Array(W * H);
  const norm = new Float32Array(W * H);

  function draw(cells: Cell[]) {
    density.fill(0);
    const pxDeg = W / 360;
    const reach = SIGMA * 3;
    const inv2s2 = 1 / (2 * SIGMA * SIGMA);

    // kernel density: each cell spreads its weight over nearby pixels (weights were stored as sqrt(count/max))
    for (const [lat, lng, w] of cells) {
      const weight = w * w;
      const y0 = Math.max(0, Math.floor((90 - (lat + reach)) * pxDeg));
      const y1 = Math.min(H - 1, Math.ceil((90 - (lat - reach)) * pxDeg));
      for (let y = y0; y <= y1; y++) {
        const plat = 90 - (y + 0.5) / pxDeg;
        const dLat = plat - lat;
        const cos = Math.max(0.05, Math.cos((plat * Math.PI) / 180));
        const lngReach = Math.min(180, reach / cos);
        const x0 = Math.floor((lng - lngReach + 180) * pxDeg);
        const x1 = Math.ceil((lng + lngReach + 180) * pxDeg);
        for (let xi = x0; xi <= x1; xi++) {
          const x = ((xi % W) + W) % W; // wrap across the antimeridian
          let dLng = (xi + 0.5) / pxDeg - 180 - lng;
          dLng *= cos;
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
    } else {
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
          const gx = (norm[y * W + ((x + 1) % W)] - norm[y * W + ((x - 1 + W) % W)]) / 2;
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
          let b = lo[2] + (hi[2] - lo[2]) * t;
          let a = lo[3] + (hi[3] - lo[3]) * t;
          // one-pixel contour line on the edge, over the fill
          const line = Math.max(0, 1 - Math.abs(d - CUT[k]) / g) * CONTOUR_ALPHA;
          if (line > 0) {
            const na = line + a * (1 - line);
            r = (CONTOUR[0] * line + r * a * (1 - line)) / na;
            gg = (CONTOUR[1] * line + gg * a * (1 - line)) / na;
            b = (CONTOUR[2] * line + b * a * (1 - line)) / na;
            a = na;
          }
          data[o] = r;
          data[o + 1] = gg;
          data[o + 2] = b;
          data[o + 3] = Math.round(a * 255);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    tex.needsUpdate = true;
  }

  return {
    mesh,
    show(cells: Cell[]) {
      draw(cells);
      mesh.visible = cells.length > 0;
    },
    hide() {
      mesh.visible = false;
    },
    setVisible(v: boolean) {
      mesh.visible = v;
    },
  };
}
