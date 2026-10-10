import * as THREE from 'three';
import { flowsBetween, hopKey, type Flow, type Place, type Routes } from './flows';

export type { Place, Routes };

// Seasonal movement for one animal: a flock of dots that follows where people recorded it each month, travelling from
// one month's places to the next along routes that stay in the animal's own medium (scripts/build-routes.ts: round the
// continents for a whale, over land for a bear). It is built from GBIF records (scripts/build-seasons.ts), so it shows
// where the records go, not tracked individuals, and the routes are a best guess at the way between them.

const DOTS = 260;
const MOVE = 0.62; // share of a month a dot spends travelling; the rest it stays put
const ARC_MIN_KM = 500; // shorter hops draw no line
const ARC_LIFT = 0.07; // how high a flier's path rises at its middle, as a share of the radius, for a trip half way round the world
const HOVER = 1.011;
const rad = Math.PI / 180;

/** A path over the globe: unit vectors with the angle travelled up to each, so a dot can sit at any share of the way. */
interface Path {
  xyz: Float32Array;
  cum: Float32Array;
  total: number;
}

const unit = (lat: number, lng: number, out: THREE.Vector3) => {
  // same formula as three-globe, so dots line up with the globe
  const phi = (90 - lat) * rad;
  const theta = (90 - lng) * rad;
  const s = Math.sin(phi);
  return out.set(s * Math.cos(theta), Math.cos(phi), s * Math.sin(theta));
};

function pathOf(points: ArrayLike<ArrayLike<number>>): Path {
  const n = points.length;
  const xyz = new Float32Array(n * 3);
  const cum = new Float32Array(n);
  const v = new THREE.Vector3();
  const prev = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    unit(points[i][0], points[i][1], v);
    xyz.set([v.x, v.y, v.z], i * 3);
    if (i) cum[i] = cum[i - 1] + Math.acos(Math.min(1, Math.max(-1, v.dot(prev))));
    prev.copy(v);
  }
  return { xyz, cum, total: cum[n - 1] };
}

/** Counts that add up to n, in proportion to the weights. */
function split(weights: number[], n: number) {
  const sum = weights.reduce((s, w) => s + w, 0) || 1;
  const exact = weights.map((w) => (w / sum) * n);
  const out = exact.map(Math.floor);
  let left = n - out.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((x, y) => y[0] - x[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
  return out;
}

/** A small seeded random, so the same animal always flocks the same way. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function createMigration(R: number, dpr: number) {
  const group = new THREE.Group();
  group.visible = false;

  const dotGeo = new THREE.BufferGeometry();
  const dotMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { size: { value: 4.6 * dpr } },
    vertexShader: /* glsl */ `
      uniform float size;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size;
      }`,
    fragmentShader: /* glsl */ `
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.4, d);
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(vec3(1.0, 0.42, 0.26), vec3(0.11, 0.035, 0.016), smoothstep(0.26, 0.4, d)), a * 0.95);
      }`,
  });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.renderOrder = 9;
  dots.frustumCulled = false;
  group.add(dots);

  // ---- per animal
  let months: Place[][] = [];
  let medium: Routes['medium'] = 'air';
  let spread = 5; // degrees dots scatter around a place
  let flows: Flow[][] = []; // flows[k]: month k to month k+1 (the last wraps to the first)
  let routes: Record<string, [number, number][]> = {};
  const paths = new Map<string, Path>(); // one per hop, built the first time it is needed
  let stop: Uint8Array[] = []; // stop[d][k]: the place dot d is at in month k; stop[d][12] is where it started
  let off: Float32Array = new Float32Array(0); // [dot][month] jitter, lat/lng degrees
  let delay: Float32Array = new Float32Array(0); // [dot][transition], 0..1 of the slack in a month
  let n = 0;
  let pos: Float32Array = new Float32Array(0);

  // arcs for the current hop: a pool of lines, reused
  const arcs: THREE.Line[] = [];
  const ARC_STEPS = 80;
  const arcMat = new THREE.LineBasicMaterial({ color: 0xff7a52, transparent: true, opacity: 0.0, depthWrite: false });
  let arcMonth = -1;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const east = new THREE.Vector3();
  const north = new THREE.Vector3();

  /** The way from a place in one month to a place in the next: its stored route, or a straight run when there is none. */
  function pathFor(k: number, a: number, b: number): Path {
    const key = hopKey(k, a, b);
    let p = paths.get(key);
    if (!p) {
      const q = months[(k + 1) % 12][b];
      p = pathOf(routes[key] ?? [months[k][a], q]);
      paths.set(key, p);
    }
    return p;
  }

  /** Point u (0..1) along a path, lifted off the globe in the middle for fliers, then moved sideways by (dLat, dLng) degrees. */
  function onPath(p: Path, u: number, out: THREE.Vector3, dLat = 0, dLng = 0) {
    const n = p.cum.length;
    const s = u * p.total;
    let i = 0;
    while (i < n - 2 && p.cum[i + 1] < s) i++;
    const x = p.xyz;
    a.set(x[i * 3], x[i * 3 + 1], x[i * 3 + 2]);
    b.set(x[i * 3 + 3], x[i * 3 + 4], x[i * 3 + 5]);
    const seg = p.cum[i + 1] - p.cum[i];
    const f = seg > 1e-6 ? Math.min(1, Math.max(0, (s - p.cum[i]) / seg)) : 0;
    const so = Math.sin(seg);
    if (so < 1e-4) out.copy(a);
    else out.set(0, 0, 0).addScaledVector(a, Math.sin((1 - f) * seg) / so).addScaledVector(b, Math.sin(f * seg) / so);
    out.normalize();
    if (dLat || dLng) {
      east.set(out.z, 0, -out.x);
      if (east.lengthSq() < 1e-8) east.set(1, 0, 0); // at a pole every way is north
      east.normalize();
      north.crossVectors(out, east);
      out.addScaledVector(east, dLng * rad).addScaledVector(north, dLat * rad).normalize();
    }
    const lift = medium === 'air' || medium === 'air-land' ? HOVER + ARC_LIFT * (p.total / Math.PI) * Math.sin(Math.PI * u) : HOVER;
    return out.multiplyScalar(R * lift);
  }

  function setArcs(k: number) {
    if (k === arcMonth) return;
    arcMonth = k;
    const hops = flows[k].filter((f) => f.km >= ARC_MIN_KM && f.a !== f.b);
    while (arcs.length < hops.length) {
      const line = new THREE.Line(new THREE.BufferGeometry(), arcMat);
      line.renderOrder = 8;
      line.frustumCulled = false;
      line.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ARC_STEPS + 1) * 3), 3));
      arcs.push(line);
      group.add(line);
    }
    arcs.forEach((line, i) => {
      const f = hops[i];
      line.visible = !!f;
      if (!f) return;
      const path = pathFor(k, f.a, f.b);
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let s = 0; s <= ARC_STEPS; s++) {
        onPath(path, s / ARC_STEPS, tmp);
        attr.setXYZ(s, tmp.x, tmp.y, tmp.z);
      }
      attr.needsUpdate = true;
    });
  }

  const ease = (x: number) => x * x * (3 - 2 * x);

  return {
    group,
    /** null clears it */
    show(data: Place[][] | null, seed = 1, route?: Routes | null) {
      months = data ?? [];
      medium = route?.medium ?? 'air';
      spread = route?.spread ?? 5;
      routes = route?.hops ?? {};
      paths.clear();
      group.visible = false;
      if (!data) {
        n = 0;
        return;
      }
      flows = months.map((m, k) => flowsBetween(m, months[(k + 1) % 12]));
      n = DOTS;
      const rand = rng(seed);
      // start the dots in month 0's places, then send each along that month's flows to the next, and so on round the year
      stop = Array.from({ length: n }, () => new Uint8Array(13));
      const counts = split(months[0].map((p) => p[2]), n);
      let d = 0;
      counts.forEach((c, place) => {
        for (let i = 0; i < c; i++) stop[d++][0] = place;
      });
      for (let k = 0; k < 12; k++) {
        const last = k === 11;
        const here = new Map<number, number[]>();
        stop.forEach((s, i) => (here.get(s[k]) ?? here.set(s[k], []).get(s[k])!).push(i));
        for (const [place, ids] of here) {
          if (last) {
            // the last hop brings every dot home, so the year loops without a jump
            for (const i of ids) stop[i][12] = stop[i][0];
            continue;
          }
          const out = flows[k].filter((f) => f.a === place);
          const share = out.length ? split(out.map((f) => f.w), ids.length) : [];
          ids.sort(() => rand() - 0.5);
          let at = 0;
          out.forEach((f, j) => {
            for (let i = 0; i < share[j]; i++) stop[ids[at++]][k + 1] = f.b;
          });
          while (at < ids.length) stop[ids[at++]][k + 1] = place; // rounding left over: stays
        }
      }
      off = new Float32Array(n * 13 * 2);
      for (let i = 0; i < off.length; i++) off[i] = (rand() - 0.5) * spread; // scatter within a place, degrees
      delay = new Float32Array(n * 12);
      for (let i = 0; i < delay.length; i++) delay[i] = rand();
      for (let i = 0; i < n; i++) {
        // the year loops: month 12's scatter is month 0's
        off[(i * 13 + 12) * 2] = off[i * 13 * 2];
        off[(i * 13 + 12) * 2 + 1] = off[i * 13 * 2 + 1];
      }
      pos = new Float32Array(n * 3);
      dotGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      arcMonth = -1;
      group.visible = true;
    },
    /** t: months since the start of the year, 0 up to 12 */
    setTime(t: number) {
      if (!n) return;
      const k = Math.min(11, Math.floor(t));
      const f = t - k;
      setArcs(k);
      // arcs show while dots are on the move, fading in and out around it
      arcMat.opacity = 0.5 * Math.sin(Math.PI * Math.min(1, f / (MOVE + 0.2))) ** 0.6;
      const slack = 1 - MOVE;
      for (let i = 0; i < n; i++) {
        const path = pathFor(k, stop[i][k], stop[i][k + 1]);
        const o = (i * 13 + k) * 2;
        const o2 = (i * 13 + k + 1) * 2;
        const u = ease(Math.min(1, Math.max(0, (f - delay[i * 12 + k] * slack) / MOVE)));
        // the scatter blends from this place's offset to the next place's offset as the dot travels
        onPath(path, u, tmp, off[o] * (1 - u) + off[o2] * u, off[o + 1] * (1 - u) + off[o2 + 1] * u);
        pos[i * 3] = tmp.x;
        pos[i * 3 + 1] = tmp.y;
        pos[i * 3 + 2] = tmp.z;
      }
      (dotGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    },
    setDpr(d: number) {
      dotMat.uniforms.size.value = 4.6 * d;
    },
    setVisible(v: boolean) {
      group.visible = v && n > 0;
    },
  };
}
