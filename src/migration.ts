import * as THREE from 'three';

// Seasonal movement for one animal: a flock of dots that follows where people recorded it each month, travelling along
// thin arcs from one month's places to the next. It is built from GBIF records (scripts/build-seasons.ts), so it shows
// where the records go, not tracked individuals.

/** lat, lng, share of that month's records */
export type Place = [number, number, number];

const DOTS = 260;
const MOVE = 0.62; // share of a month a dot spends travelling; the rest it stays put
const ARC_MIN_KM = 500; // shorter hops get no arc
const ARC_LIFT = 0.07; // arc height at its middle, as a share of the radius, for a hop half way round the world
const HOVER = 1.011;
const rad = Math.PI / 180;

interface Flow {
  a: number;
  b: number;
  w: number;
  km: number;
}

const unit = (lat: number, lng: number, out: THREE.Vector3) => {
  // same formula as three-globe, so dots line up with the globe
  const phi = (90 - lat) * rad;
  const theta = (90 - lng) * rad;
  const s = Math.sin(phi);
  return out.set(s * Math.cos(theta), Math.cos(phi), s * Math.sin(theta));
};

function kmBetween(p: Place, q: Place) {
  const d = Math.sin(((q[0] - p[0]) * rad) / 2) ** 2 + Math.cos(p[0] * rad) * Math.cos(q[0] * rad) * Math.sin(((q[1] - p[1]) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(d)));
}

/** Where each month's records go next: nearest places first, so a place that stays put stays put. */
function flowsBetween(from: Place[], to: Place[]): Flow[] {
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
  let flows: Flow[][] = []; // flows[k]: month k to month k+1 (the last wraps to the first)
  let stop: Uint8Array[] = []; // stop[d][k]: the place dot d is at in month k; stop[d][12] is where it started
  let off: Float32Array = new Float32Array(0); // [dot][month] jitter, lat/lng degrees
  let delay: Float32Array = new Float32Array(0); // [dot][transition], 0..1 of the slack in a month
  let n = 0;
  let pos: Float32Array = new Float32Array(0);

  // arcs for the current hop: a pool of lines, reused
  const arcs: THREE.Line[] = [];
  const ARC_STEPS = 40;
  const arcMat = new THREE.LineBasicMaterial({ color: 0xff7a52, transparent: true, opacity: 0.0, depthWrite: false });
  let arcMonth = -1;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  /** Point u (0..1) along the arc from one place to the next, lifted off the globe in the middle. */
  function onArc(p: Place, q: Place, u: number, out: THREE.Vector3, ja = 0, jb = 0, jc = 0, jd = 0) {
    unit(p[0] + ja, p[1] + jb, a);
    unit(q[0] + jc, q[1] + jd, b);
    const ang = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
    const so = Math.sin(ang);
    if (so < 1e-4) return out.copy(a).multiplyScalar(R * HOVER);
    const wa = Math.sin((1 - u) * ang) / so;
    const wb = Math.sin(u * ang) / so;
    out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb).normalize();
    const lift = HOVER + ARC_LIFT * (ang / Math.PI) * Math.sin(Math.PI * u);
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
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let s = 0; s <= ARC_STEPS; s++) {
        onArc(months[k][f.a], months[(k + 1) % 12][f.b], s / ARC_STEPS, tmp);
        attr.setXYZ(s, tmp.x, tmp.y, tmp.z);
      }
      attr.needsUpdate = true;
    });
  }

  const ease = (x: number) => x * x * (3 - 2 * x);

  return {
    group,
    /** null clears it */
    show(data: Place[][] | null, seed = 1) {
      months = data ?? [];
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
      for (let i = 0; i < off.length; i++) off[i] = (rand() - 0.5) * 5; // scatter within a place, degrees
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
        const from = months[k][stop[i][k]];
        const to = months[(k + 1) % 12][stop[i][k + 1]];
        const o = (i * 13 + k) * 2;
        const o2 = (i * 13 + k + 1) * 2;
        const u = ease(Math.min(1, Math.max(0, (f - delay[i * 12 + k] * slack) / MOVE)));
        // the scatter blends from this place's offset to the next place's offset as the dot travels
        onArc(from, to, u, tmp, off[o] * (1 - u), off[o + 1] * (1 - u), off[o2] * u, off[o2 + 1] * u);
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
