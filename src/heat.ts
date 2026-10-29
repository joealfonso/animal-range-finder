import * as THREE from 'three';
import type { Cell } from './types';

// Record-density surface for one animal, drawn as stepped bands with thin contour lines (an isopleth map, like a
// printed atlas) on a transparent sphere just above the globe. It shows where wild records concentrate. It is not a
// population count.
//
// Two layers share the drawing code:
// - the world layer, a smoothed estimate from the animal's 2° GBIF cells, for the whole range;
// - the detail layer, for a zoomed-in view: redrawn from the individual records in view, with a tighter kernel and
//   finer pixels, and banded against the records in view rather than in the whole range. Without it, zooming
//   into a country shows soft 2° blobs that miss the records, and places with a modest share of the records fall
//   under the faintest band and vanish.
//
// Bands are quantiles of the range's own area, not fixed fractions of its peak. Cut at fractions of the peak, a wide
// range that is recorded fairly evenly (a mallard, a raven) sums to near the peak almost everywhere and comes out as
// one flat top band: the map says only "here". Cut by area, the top band is always the most-recorded 3% of the
// range, the next the 10%, and so on, whatever the shape of the counts. The outer band is the whole range, down to a
// fixed floor so a place with a single record still shows.

/** the share of the range's area each band above the first covers: top half, top quarter, top 10%, top 3% */
export const HEAT_TOP = [0.5, 0.25, 0.1, 0.03];
const R = 100;

// tints of the one accent, light-to-dark ink on dark ground; index 0 is "no band". The top bands lean to yellow
// as well as getting more opaque, so they still separate over snow and desert, where lightness alone washes out.
export const HEAT_BANDS: [number, number, number, number][] = [
  [0, 0, 0, 0],
  [255, 90, 54, 0.2],
  [255, 96, 58, 0.34],
  [255, 118, 70, 0.48],
  [255, 156, 92, 0.62],
  [255, 206, 130, 0.78],
];
const CONTOUR: [number, number, number] = [255, 90, 54];
// the range's edge is drawn firmly; the edges inside it faintly, so a wide range isn't a mesh of lines
const EDGE_ALPHA = 0.75;
const INNER_ALPHA = 0.28;

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
  const lineMat = (opacity: number) =>
    new THREE.LineBasicMaterial({
      color: new THREE.Color(CONTOUR[0] / 255, CONTOUR[1] / 255, CONTOUR[2] / 255).convertSRGBToLinear(),
      transparent: true,
      opacity,
      depthWrite: false,
    });
  const fills = fillMats.map((m, k) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.renderOrder = order + k * 0.001;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  });
  const [edge, inner] = [EDGE_ALPHA, INNER_ALPHA].map((a) => {
    const l = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(a));
    l.renderOrder = order + 0.01;
    l.frustumCulled = false;
    group.add(l);
    return l;
  });
  const setLines = (l: THREE.LineSegments, segs: number[]) => {
    l.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    l.geometry = g;
  };

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
   * Kernel density of weighted points over the box, in degrees (longitude distances shrink with latitude), then cut
   * into bands: the first at `floor` (in the same units as the weights: a lone point of weight w peaks at w), the rest
   * at the area quantiles in HEAT_TOP. Returns false when nothing lands in the box.
   */
  function draw(b: Box, pts: ArrayLike<number>[], sigma: number, weightOf: (p: ArrayLike<number>) => number, floor: number) {
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

    const dLat = (b.lat1 - b.lat0) / H;
    const dLng = (b.lng1 - b.lng0) / W;
    const latAt = (y: number) => b.lat1 - y * dLat;
    const lngAt = (x: number) => b.lng0 + x * dLng;

    // the nodes inside the range, each weighted by the ground it stands for (a node near the pole covers little)
    const vals: number[] = [];
    const area: number[] = [];
    for (let y = 0; y < NY; y++) {
      const a = Math.max(0.01, Math.cos(latAt(y) * rad));
      for (let x = 0; x < (world ? W : NX); x++) {
        const v = density[y * NX + x];
        if (v >= floor) {
          vals.push(v);
          area.push(a);
        }
      }
    }
    if (!vals.length) {
      for (const m of fills) m.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      setLines(edge, []);
      setLines(inner, []);
      return false;
    }
    const rank = vals.map((_, i) => i).sort((i, j) => vals[i] - vals[j]);
    let total = 0;
    for (const a of area) total += a;
    const cuts = [floor];
    let acc = 0;
    let at = 0;
    for (const top of HEAT_TOP) {
      while (at < rank.length - 1 && acc + area[rank[at]] <= total * (1 - top)) acc += area[rank[at++]];
      // a flat range (one record everywhere) has equal quantiles: keep the cuts rising so a band can't swallow the next
      cuts.push(Math.max(vals[rank[at]], cuts[cuts.length - 1] * 1.0001));
    }

    const edgeSegs: number[] = [];
    const innerSegs: number[] = [];

    fills.forEach((mesh, k) => {
      const c = cuts[k];
      const segs = k === 0 ? edgeSegs : innerSegs;
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

    setLines(edge, edgeSegs);
    setLines(inner, innerSegs);
    return true;
  }

  return { mesh: group, draw };
}

/** The whole range from 2° cells: ~0.18° per pixel, smoothed over about one cell. */
export function createHeat(globeRadius = R, altitude = 0.0045) {
  const layer = heatLayer(360, 180, globeRadius * (1 + altitude), 0.5);
  return {
    mesh: layer.mesh,
    /**
     * weights are stored as log(1 + count) / log(1 + max), at least 0.1 (scripts/build-data.ts): the log keeps a few
     * heavily watched cells from drowning the rest. The floor is half the faintest cell's peak, so a lone cell shows.
     */
    show(cells: Cell[]) {
      layer.draw(WORLD, cells, 2.2, (c) => c[2], 0.05);
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
      // a record weighs 1, so a lone record shows out to ~1.5 sigma around it
      return layer.draw(box, pts, sigma, () => 1, 0.3);
    },
    setVisible(v: boolean) {
      layer.mesh.visible = v;
    },
  };
}

/**
 * The squares animals counted by area are published as (SQUARE_DEG in scripts/lib/density.ts, the published `binned`):
 * 0.35°, about 39 km. Points are snapped back onto them, so rounding in the file can't shift a square.
 */
export const AREA_CELL = 180 / 512;

/**
 * The stipple marks for animals counted by area (the maths, the spacing per class and the mark size are in
 * stipple.ts). Marks are screen-space points of a fixed CSS size; per frame the shader works out how many marks each
 * square should show from how big it is on screen, so zooming adds marks one by one, fading each in, with no work on
 * the CPU. Three layers share the look: the world layer and two detail layers, so an old detail can fade out while
 * the new one fades in.
 */
export function createStipple(spacing: number[], markPx: number, core: number, order = 0.6) {
  // sRGB values straight to the screen, as the plate's legend uses them
  const ink = (r: number, g: number, b: number) => new THREE.Vector3(r / 255, g / 255, b / 255);
  const shared = {
    pxScale: { value: 1 }, // CSS px per world unit at a depth of one unit
    dpr: { value: 1 },
    markPx: { value: markPx },
    side: { value: (R * AREA_CELL * Math.PI) / 180 }, // a square's side on the ground, in world units
    spacing: { value: spacing },
    inks: { value: HEAT_BANDS.slice(1).map(([r, g, b]) => ink(r, g, b)) },
    rim: { value: ink(0x1c, 0x09, 0x04) },
    core: { value: core },
  };
  const vertexShader = /* glsl */ `
    uniform float pxScale; uniform float dpr; uniform float markPx; uniform float side;
    uniform float spacing[5]; uniform vec3 inks[5]; uniform float spacingScale;
    attribute vec4 info; // candidate index, class, presence floor, size factor
    attribute float dither; // the square's threshold, so where it gets under one mark an even share of squares light
    varying vec3 vInk; varying float vAlpha; varying float vAA;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      // in world space: the mesh is turned a quarter about y, and cameraPosition is a world position
      vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
      vec3 n = normalize(wp);
      // thinned towards the limb, or foreshortened squares crowd their marks and the edge reads as more records
      float facing = max(0.0, dot(n, normalize(cameraPosition - wp)));
      float px = pxScale * side / -mv.z;
      float cosLat = sqrt(max(0.0, 1.0 - n.y * n.y));
      int k = int(info.y + 0.5);
      float s = spacing[k] * spacingScale;
      // a mark on the far side, lifted just off the ground, would peek out past the globe's outline: none there.
      // The floor thins with facing too, or squares holding one mark each crowd together at the limb as a bright rim.
      float lambda = facing > 0.0 ? max(px * px * cosLat * facing / (s * s), info.z * facing) : 0.0;
      // mark i shows once lambda passes i plus the square's threshold, fading in over a fifth of a mark
      vAlpha = clamp((lambda - info.x - dither) * 5.0, 0.0, 1.0);
      vInk = inks[k];
      float size = markPx * dpr * info.w;
      vAA = 0.5 / size; // half a device pixel, so the rim stays whole at the edge
      gl_PointSize = vAlpha > 0.0 ? size : 0.0;
      gl_Position = vAlpha > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
    }`;
  // a core in the class's ink and a dark rim out to the sprite's edge, so a mark keeps at least 3:1 against snow and
  // desert (the rim) and against forest (the core). The core's edge is hard: blurred over a pixel, a mark this small
  // would be all blend and no rim.
  const fragmentShader = /* glsl */ `
    uniform vec3 rim; uniform float core; uniform float opacity;
    varying vec3 vInk; varying float vAlpha; varying float vAA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float t = step(core, d);
      float a = mix(1.0, 0.95, t) * (1.0 - smoothstep(0.5 - vAA, 0.5, d)) * vAlpha * opacity;
      if (a < 0.01) discard;
      gl_FragColor = vec4(mix(vInk, rim, t), a);
    }`;

  const layer = (o: number) => {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...shared, opacity: { value: 0 }, spacingScale: { value: 1 } },
      vertexShader,
      fragmentShader,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = o;
    points.frustumCulled = false;
    points.visible = false;
    return {
      points,
      mat,
      set(m: { position: Float32Array; info: Float32Array; dither: Float32Array }, spacingScale = 1) {
        points.geometry.dispose();
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
        g.setAttribute('info', new THREE.BufferAttribute(m.info, 4));
        g.setAttribute('dither', new THREE.BufferAttribute(m.dither, 1));
        points.geometry = g;
        mat.uniforms.spacingScale.value = spacingScale;
      },
    };
  };

  return {
    world: layer(order),
    details: [layer(order + 0.001), layer(order + 0.002)],
    /** the canvas height in CSS px and the camera's vertical field of view */
    setView(heightPx: number, fovDeg: number) {
      shared.pxScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    },
    setDpr(dpr: number) {
      shared.dpr.value = dpr;
    },
  };
}
