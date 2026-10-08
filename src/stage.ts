import Globe from 'globe.gl';
import * as THREE from 'three';
import { createStars } from './stars';
import { pickAt, toPickable, type Pickable } from './geo';
import type { Cell, Country, Pov, StateFeature } from './types';

const BASE = import.meta.env.BASE_URL;
const R = 100; // globe.gl world radius
const ACCENT = new THREE.Color('#ff5a36');
const INK = new THREE.Color('#ece8e0');

export interface StageOptions {
  small: boolean;
  reduced: boolean;
}

export interface Stage {
  pov(): Pov;
  flyTo(p: Pov, ms: number): void;
  setRangeCountries(iso: string[], active: string | null): void;
  setFilterCountry(iso: string | null): void;
  /** Show one country's states as their own selectable shapes (null hides them). */
  setStates(states: StateFeature[] | null): void;
  /** active: the chosen state; marked: states where the open animal was recorded */
  setStateMarks(active: string | null, marked: Set<string>): void;
  /** How close we are: dots shrink and fade as you drill from the whole range to a country to a state. */
  setRangeDetail(level: 'range' | 'country' | 'state'): void;
  showRange(cells: Cell[]): void;
  clearRange(): void;
  project(lat: number, lng: number): { x: number; y: number; visible: boolean };
  shiftTo(x: number, y: number, ms: number): void;
  stopAutoRotate(): void;
  onCountryClick(cb: (iso: string) => void): void;
  onStateClick(cb: (id: string) => void): void;
  onMove(cb: (p: Pov) => void): void;
  /** called every frame; `moved` is false when the camera has not changed since the last frame */
  onFrame(cb: (moved: boolean) => void): void;
  resize(): void;
}

/** Same formula as three-globe, so our own geometry lines up with its globe. */
function toXYZ(lat: number, lng: number, out: number[]) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const s = Math.sin(phi);
  out.push(R * s * Math.cos(theta), R * Math.cos(phi), R * s * Math.sin(theta));
}

/** Border rings as line segments on the globe, with long edges split so they follow the curve. */
function ringSegments(geometry: Country['geometry']): Float32Array {
  const polys = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
  const out: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  for (const poly of polys)
    for (const ring of poly)
      for (let i = 0; i < ring.length - 1; i++) {
        const [lng1, lat1] = ring[i];
        const [lng2, lat2] = ring[i + 1];
        const d = Math.max(Math.abs(lng2 - lng1), Math.abs(lat2 - lat1));
        if (d > 90) continue; // seam at the antimeridian, not a real edge
        const n = Math.max(1, Math.ceil(d / 1.5));
        for (let k = 0; k < n; k++) {
          a.length = 0;
          b.length = 0;
          toXYZ(lat1 + ((lat2 - lat1) * k) / n, lng1 + ((lng2 - lng1) * k) / n, a);
          toXYZ(lat1 + ((lat2 - lat1) * (k + 1)) / n, lng1 + ((lng2 - lng1) * (k + 1)) / n, b);
          out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      }
  return new Float32Array(out);
}

/** One draw call for any number of outlines: concatenated segments, scaled just above the surface. */
function lineLayer(color: THREE.Color, opacity: number, altitude: number, order: number) {
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false });
  const obj = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
  obj.scale.setScalar(1 + altitude);
  obj.renderOrder = order;
  obj.frustumCulled = false;
  obj.visible = false;
  return {
    obj,
    set(parts: Float32Array[]) {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const buf = new Float32Array(total);
      let o = 0;
      for (const p of parts) {
        buf.set(p, o);
        o += p.length;
      }
      obj.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(buf, 3));
      obj.geometry = g;
      obj.visible = total > 0;
    },
  };
}

export function createStage(el: HTMLElement, countries: Country[], opts: StageOptions): Stage {
  const { small, reduced } = opts;
  let dpr = Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.5);

  let hoverIso: string | null = null;
  let hoverState: string | null = null;
  let rangeIso: string[] = [];
  let activeIso: string | null = null;
  let filterIso: string | null = null;
  let states: StateFeature[] = [];
  let activeState: string | null = null;
  let markedStates = new Set<string>();
  let clickCb: (iso: string) => void = () => {};
  let stateClickCb: (id: string) => void = () => {};
  let moveCb: (p: Pov) => void = () => {};
  const frameCbs: ((moved: boolean) => void)[] = [];

  const globe = new Globe(el, {
    animateIn: false,
    rendererConfig: { antialias: !small, alpha: true, powerPreference: 'high-performance' },
  })
    .backgroundColor('rgba(0,0,0,0)')
    .width(window.innerWidth)
    .height(window.innerHeight)
    .globeImageUrl(`${BASE}tex/${small ? 'earth-2k' : 'earth-4k'}.jpg`)
    .bumpImageUrl(`${BASE}tex/bump-2k.jpg`)
    .showAtmosphere(true)
    .atmosphereColor('#7f93ab')
    .atmosphereAltitude(0.13)
    .showGraticules(true)
    // Hover and clicks are worked out from lat/lng below, so the library does not raycast every shape on each mouse move.
    .enablePointerInteraction(false);

  if (import.meta.env.DEV) (window as any).__globe = globe; // inspection from devtools only

  const renderer = globe.renderer();
  renderer.setPixelRatio(dpr);

  // Material: matte, a little relief, no plastic shine.
  const mat = globe.globeMaterial() as THREE.MeshPhongMaterial;
  mat.bumpScale = 3.2;
  mat.shininess = 4;
  mat.specular = new THREE.Color('#10141a');
  mat.color = new THREE.Color('#c9cfd8');

  // Light: a soft key from upper-left that travels with the camera, plus low ambient.
  const camera = globe.camera() as THREE.PerspectiveCamera;
  camera.far = 6000;
  camera.updateProjectionMatrix();
  const scene = globe.scene();
  scene.add(camera);
  const key = new THREE.DirectionalLight(0xfff1e0, 2.1);
  key.position.set(-120, 90, 160);
  camera.add(key);
  globe.lights([new THREE.AmbientLight(0x8d98ab, 1.15)]);

  // Sky
  const stars = createStars(small ? 1800 : 4200, dpr);
  scene.add(stars.group);

  // ---- borders: a handful of merged line layers instead of one mesh per country
  const segCache = new Map<string, Float32Array>();
  const segs = (k: string, g: Country['geometry']) => {
    let s = segCache.get(k);
    if (!s) segCache.set(k, (s = ringSegments(g)));
    return s;
  };
  const byIso = new Map(countries.map((c) => [c.properties.iso, c]));
  const countrySegs = (iso: string) => {
    const c = byIso.get(iso);
    return c ? segs('c:' + iso, c.geometry) : new Float32Array();
  };
  const stateSegs = (f: StateFeature) => segs('s:' + f.properties.id, f.geometry);

  const layers = {
    base: lineLayer(INK, 0.16, 0.0035, 1),
    range: lineLayer(ACCENT, 0.5, 0.005, 2),
    states: lineLayer(INK, 0.3, 0.006, 3),
    marked: lineLayer(ACCENT, 0.5, 0.007, 4),
    hover: lineLayer(INK, 0.85, 0.008, 5),
    active: lineLayer(ACCENT, 1, 0.009, 6),
  };
  for (const l of Object.values(layers)) scene.add(l.obj);
  layers.base.set(countries.map((c) => countrySegs(c.properties.iso)));

  const pickCountries: Pickable<Country>[] = countries.map(toPickable);
  let pickStates: Pickable<StateFeature>[] = [];
  let stateMap = new Map<string, StateFeature>();

  // Fills: only the one or two shapes that are actually chosen get a filled polygon.
  globe
    .polygonCapColor((d: any) =>
      'id' in d.properties ? 'rgba(255,90,54,0.22)' : 'rgba(255,90,54,0.14)',
    )
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor(() => null as unknown as string)
    .polygonAltitude(0.004)
    .polygonsTransitionDuration(0);

  let lastFills = '';
  function paint() {
    layers.range.set(rangeIso.filter((i) => i !== activeIso).map(countrySegs));
    layers.marked.set([...markedStates].filter((id) => id !== activeState && stateMap.has(id)).map((id) => stateSegs(stateMap.get(id)!)));
    const hoverParts: Float32Array[] = [];
    if (hoverState && hoverState !== activeState && stateMap.has(hoverState)) hoverParts.push(stateSegs(stateMap.get(hoverState)!));
    else if (hoverIso && hoverIso !== activeIso && hoverIso !== filterIso) hoverParts.push(countrySegs(hoverIso));
    layers.hover.set(hoverParts);
    const activeParts: Float32Array[] = [];
    for (const iso of new Set([activeIso, filterIso])) if (iso) activeParts.push(countrySegs(iso));
    if (activeState && stateMap.has(activeState)) activeParts.push(stateSegs(stateMap.get(activeState)!));
    layers.active.set(activeParts);

    // only touch the polygon layer when the chosen shapes actually change (it re-triangulates)
    // once a country's states are showing, its own fill would be near-invisible but costs one mesh per island
    const fills: object[] = [];
    if (!states.length) for (const iso of new Set([activeIso, filterIso])) if (iso && byIso.has(iso)) fills.push(byIso.get(iso)!);
    if (activeState && stateMap.has(activeState)) fills.push(stateMap.get(activeState)!);
    const sig = `${activeIso}|${filterIso}|${activeState}|${states.length > 0}`;
    if (sig !== lastFills) {
      lastFills = sig;
      globe.polygonsData(fills);
    }
  }

  // ---- range: every 2° cell is one flat disc, all in a single instanced draw call
  const dim = new THREE.Color('#5a2418');
  const hot = new THREE.Color('#ff5a36');
  const DETAIL = { range: { size: 1, alpha: 0.86 }, country: { size: 0.7, alpha: 0.78 }, state: { size: 0.32, alpha: 0.7 } };
  let detail = DETAIL.range;
  let rangeCells: Cell[] = [];
  const discGeo = new THREE.CircleGeometry(1, small ? 16 : 28);
  const discMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: detail.alpha, depthWrite: false, side: THREE.DoubleSide });
  let discs: THREE.InstancedMesh | null = null;
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tmp: number[] = [];
  const col = new THREE.Color();

  function layoutDiscs() {
    if (!discs) return;
    rangeCells.forEach(([lat, lng, w], i) => {
      tmp.length = 0;
      toXYZ(lat, lng, tmp);
      nrm.set(tmp[0], tmp[1], tmp[2]).normalize();
      pos.copy(nrm).multiplyScalar(R * 1.0065);
      quat.setFromUnitVectors(zAxis, nrm);
      const r = (((0.42 + 0.5 * Math.sqrt(w)) * detail.size * Math.PI) / 180) * R;
      scl.set(r, r, 1);
      discs!.setMatrixAt(i, m4.compose(pos, quat, scl));
    });
    discs.instanceMatrix.needsUpdate = true;
    discMat.opacity = detail.alpha;
  }

  function buildDiscs(cells: Cell[]) {
    if (discs) {
      scene.remove(discs);
      discs.dispose();
      discs = null;
    }
    rangeCells = cells;
    if (!cells.length) return;
    discs = new THREE.InstancedMesh(discGeo, discMat, cells.length);
    discs.renderOrder = 7;
    discs.frustumCulled = false;
    cells.forEach(([, , w], i) => discs!.setColorAt(i, col.copy(dim).lerp(hot, 0.35 + 0.65 * w)));
    layoutDiscs();
    scene.add(discs);
  }

  // ---- pointer: hover and click from lat/lng (cheap point-in-polygon), with our own tooltip
  const tip = document.createElement('div');
  tip.className = 'tip-float';
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);
  const canvas = renderer.domElement;

  function pickAtScreen(clientX: number, clientY: number) {
    const r = canvas.getBoundingClientRect();
    const ll = globe.toGlobeCoords(clientX - r.left, clientY - r.top);
    if (!ll) return null;
    if (pickStates.length) {
      const s = pickAt(pickStates, ll.lat, ll.lng);
      if (s) return { state: s };
    }
    const c = pickAt(pickCountries, ll.lat, ll.lng);
    return c ? { country: c } : null;
  }

  let pointer: { x: number; y: number } | null = null;
  let hoverQueued = false;
  let dragging = false;
  let down: { x: number; y: number; t: number } | null = null;

  function updateHover() {
    hoverQueued = false;
    if (!pointer || dragging) return;
    const hit = pickAtScreen(pointer.x, pointer.y);
    const nextState = hit?.state?.properties.id ?? null;
    const nextIso = hit?.country?.properties.iso ?? null;
    if (nextState !== hoverState || nextIso !== hoverIso) {
      hoverState = nextState;
      hoverIso = nextIso;
      paint();
    }
    canvas.style.cursor = hit ? 'pointer' : '';
    if (hit) {
      const p = hit.state?.properties;
      tip.innerHTML = p
        ? `<span class="tip">${p.name}<small>${p.kind}, ${p.countryName ?? p.iso}</small></span>`
        : `<span class="tip">${hit.country!.properties.name}</span>`;
      tip.classList.add('on');
      // keep it on screen: flip to the left of the cursor near the right edge
      const w = tip.offsetWidth;
      const x = pointer.x + 14 + w > window.innerWidth - 8 ? pointer.x - 14 - w : pointer.x + 14;
      tip.style.transform = `translate(${Math.max(8, x)}px, ${pointer.y + 16}px)`;
    } else tip.classList.remove('on');
  }

  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) dragging = true;
    if (dragging) tip.classList.remove('on');
    if (!hoverQueued) {
      hoverQueued = true;
      requestAnimationFrame(updateHover);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    tip.classList.remove('on');
    if (hoverIso || hoverState) {
      hoverIso = hoverState = null;
      paint();
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    dragging = false;
  });
  canvas.addEventListener('pointerup', (e) => {
    const wasClick = down && !dragging && performance.now() - down.t < 600;
    down = null;
    dragging = false;
    if (!wasClick) return;
    tip.classList.remove('on');
    const hit = pickAtScreen(e.clientX, e.clientY);
    if (hit?.state) stateClickCb(hit.state.properties.id);
    else if (hit?.country) clickCb(hit.country.properties.iso);
  });

  // ---- controls
  const controls = globe.controls() as any;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.28;
  controls.minDistance = 118;
  controls.maxDistance = 520;
  controls.zoomSpeed = 0.7;
  controls.addEventListener('start', () => (controls.autoRotate = false));
  controls.addEventListener('change', () => moveCb(globe.pointOfView()));

  globe.pointOfView({ lat: 18, lng: 20, altitude: small ? 3.4 : 2.45 }, 0);

  // Shifting the view window moves the globe off-centre without moving the camera,
  // so the range sits clear of the plate on the right.
  let shift = { x: 0, y: 0 };
  let shiftRaf = 0;
  function applyShift() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (Math.abs(shift.x) < 0.5 && Math.abs(shift.y) < 0.5) camera.clearViewOffset();
    else camera.setViewOffset(w, h, shift.x, shift.y, w, h);
    camera.updateProjectionMatrix();
  }

  // ---- frame loop, with a guard that lowers resolution if frames stay slow
  const t0 = performance.now();
  const lastCam = new THREE.Matrix4();
  let slowFrames = 0;
  let lastT = t0;
  const loop = (now: number) => {
    stars.update(camera, (now - t0) / 1000, reduced);
    camera.updateMatrixWorld();
    const moved = !lastCam.equals(camera.matrixWorld);
    if (moved) lastCam.copy(camera.matrixWorld);
    for (const cb of frameCbs) cb(moved);
    // the globe turned under a still pointer (auto-rotate, a fly-to): what is under it may have changed
    if (moved && pointer && !hoverQueued && !dragging) {
      hoverQueued = true;
      requestAnimationFrame(updateHover);
    }

    const dt = now - lastT;
    lastT = now;
    if (!document.hidden && dt < 200) {
      slowFrames = dt > 24 ? slowFrames + 1 : Math.max(0, slowFrames - 2);
      if (slowFrames > 90 && dpr > 1) {
        dpr = Math.max(1, dpr - 0.25);
        renderer.setPixelRatio(dpr);
        globe.width(window.innerWidth).height(window.innerHeight);
        applyShift();
        slowFrames = 0;
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const v = new THREE.Vector3();
  const stage: Stage = {
    pov: () => globe.pointOfView(),
    flyTo(p, ms) {
      controls.autoRotate = false;
      tip.classList.remove('on');
      globe.pointOfView(p, reduced ? 0 : ms);
    },
    setRangeCountries(iso, active) {
      rangeIso = iso;
      activeIso = active;
      paint();
    },
    setFilterCountry(iso) {
      filterIso = iso;
      paint();
    },
    setStates(next) {
      states = next ?? [];
      pickStates = states.map(toPickable);
      stateMap = new Map(states.map((s) => [s.properties.id, s]));
      layers.states.set(states.map(stateSegs));
      hoverState = null;
      paint();
    },
    setStateMarks(active, marked) {
      activeState = active;
      markedStates = marked;
      paint();
    },
    setRangeDetail(level) {
      if (detail === DETAIL[level]) return;
      detail = DETAIL[level];
      layoutDiscs();
    },
    showRange(cells) {
      buildDiscs(cells);
    },
    clearRange() {
      buildDiscs([]);
    },
    project(lat, lng) {
      const c = globe.getCoords(lat, lng, 0.004);
      v.set(c.x, c.y, c.z);
      const visible = v.dot(camera.position) > R * R * 1.02;
      const s = globe.getScreenCoords(lat, lng, 0.004);
      return { x: s.x, y: s.y, visible };
    },
    shiftTo(x, y, ms) {
      cancelAnimationFrame(shiftRaf);
      const from = { ...shift };
      if (reduced || ms <= 0) {
        shift = { x, y };
        applyShift();
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        shift = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
        applyShift();
        if (k < 1) shiftRaf = requestAnimationFrame(step);
      };
      shiftRaf = requestAnimationFrame(step);
    },
    stopAutoRotate() {
      controls.autoRotate = false;
    },
    onCountryClick: (cb) => (clickCb = cb),
    onStateClick: (cb) => (stateClickCb = cb),
    onMove: (cb) => (moveCb = cb),
    onFrame: (cb) => frameCbs.push(cb),
    resize() {
      globe.width(window.innerWidth).height(window.innerHeight);
      applyShift();
    },
  };
  return stage;
}
