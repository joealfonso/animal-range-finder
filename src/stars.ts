import * as THREE from 'three';

// A procedural sky: seeded so it is the same every visit, with a denser band
// (a loose nod to the galactic plane) and a few bright stars with diffraction spikes.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStars(count: number, pixelRatio: number) {
  const rand = rng(1984);
  const R = 1800;
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const bright = new Float32Array(count);
  const color = new Float32Array(count * 3);
  const tilt = new THREE.Euler(0.9, 0.3, 0.5);
  const warm = new THREE.Color('#ffd9b8');
  const cool = new THREE.Color('#bcd2ff');
  const white = new THREE.Color('#f4f1ea');
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const inBand = rand() < 0.38;
    if (inBand) {
      const a = rand() * Math.PI * 2;
      const g = (rand() + rand() + rand() - 1.5) * 0.28; // soft band thickness
      v.set(Math.cos(a), g, Math.sin(a)).normalize().applyEuler(tilt);
    } else {
      const u = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      v.set(s * Math.cos(a), u, s * Math.sin(a));
    }
    pos.set([v.x * R, v.y * R, v.z * R], i * 3);
    const m = Math.pow(rand(), 5.5); // most stars faint, a few bright
    const big = i < 22;
    size[i] = big ? 15 + rand() * 8 : 1.6 + m * 3.6;
    bright[i] = big ? 1 : 0.5 + m * 0.5;
    phase[i] = rand();
    const c = rand() < 0.2 ? warm : rand() < 0.4 ? cool : white;
    color.set([c.r, c.g, c.b], i * 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('bright', new THREE.BufferAttribute(bright, 1));
  geo.setAttribute('tint', new THREE.BufferAttribute(color, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // depth-tested so the planet hides every star behind it (transparent objects draw after the opaque globe)
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 }, scale: { value: pixelRatio } },
    vertexShader: /* glsl */ `
      attribute float size; attribute float phase; attribute float bright; attribute vec3 tint;
      uniform float time; uniform float scale;
      varying float vB; varying float vBig; varying vec3 vC;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        float tw = 0.82 + 0.18 * sin(time * (0.5 + phase * 1.6) + phase * 60.0);
        vB = bright * tw; vBig = step(10.0, size); vC = tint;
        gl_PointSize = size * scale;
      }`,
    fragmentShader: /* glsl */ `
      varying float vB; varying float vBig; varying vec3 vC;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p) * (1.0 + vBig * 5.0);
        float core = pow(smoothstep(0.5, 0.0, d), 2.4);
        float spike = vBig * 0.9 * (exp(-abs(p.x) * 90.0) * exp(-abs(p.y) * 7.0) + exp(-abs(p.y) * 90.0) * exp(-abs(p.x) * 7.0));
        float a = clamp(core + spike, 0.0, 1.0) * vB;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vC, a);
      }`,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  const group = new THREE.Group();
  group.add(points);

  const ident = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const drift = new THREE.Quaternion();
  const axis = new THREE.Vector3(0.2, 1, 0).normalize();
  return {
    group,
    /** most of the sky stays fixed to the world, so dragging gives a little parallax rather than a full spin */
    update(camera: THREE.Camera, t: number, reduced: boolean) {
      mat.uniforms.time.value = reduced ? 0 : t;
      q.copy(ident).slerp(camera.quaternion, 0.88);
      if (!reduced) q.multiply(drift.setFromAxisAngle(axis, t * 0.0016));
      group.quaternion.copy(q);
    },
  };
}
