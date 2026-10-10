// Builds public/data/seasons/<id>.json, the data behind the "Migration" view: where each animal was recorded in each month.
// For every animal it samples wild GBIF records month by month and boils each month down to a few weighted places.
// Animals whose records barely move across the year get no file (the view is simply not offered for them).
// Needs public/data/species.json first (npm run data). No API keys. SPECIES=Sci name,Other name limits the run.
// It reads the records' month, which the range build does not keep. It is not tracking data: it shows where people
// recorded the animal each month, so it follows observers as well as animals.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import type { Species } from '../src/types';

const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';
const GBIF = 'https://api.gbif.org/v1';
const PAGE = 300;
const MIN_MONTH = 30; // records a month needs to count
const MIN_MONTHS = 10; // months that must have enough records
const MIN_MOVE_KM = 3500; // the year's records must shift at least this far for it to count as migration
const MAX_JUMP = 0.4; // the average hop from one month to the next may be at most this share of the year's biggest change
const CELL = 6; // degrees; records this close share one place
const KEEP = 12; // places kept per month

await mkdir('public/data/seasons', { recursive: true });
await mkdir('.cache/seasons', { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }).catch(() => null);
    if (!res) { await sleep(800); continue; }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(800 * (i + 1) * (res.status === 429 ? 3 : 1));
  }
  return null;
}
const exists = (p: string) => access(p).then(() => true, () => false);

const CAPTIVE = new Set(['captive', 'managed', 'cultivated', 'released']);
const isCaptive = (o: any) => CAPTIVE.has(String(o.degreeOfEstablishment ?? '').toLowerCase()) || o.establishmentMeans === 'MANAGED';
const occ = (key: number, month: number) =>
  `${GBIF}/occurrence/search?taxonKey=${key}&month=${month}&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT&basisOfRecord=HUMAN_OBSERVATION&basisOfRecord=OBSERVATION&basisOfRecord=MACHINE_OBSERVATION`;

const rad = Math.PI / 180;
function km(a: number[], b: number[]) {
  const d = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(d)));
}

type Place = [number, number, number]; // lat, lng, share of that month's records

function places(pts: number[][]): Place[] {
  const cells = new Map<string, { n: number; x: number; y: number; z: number }>();
  for (const [lat, lng] of pts) {
    const k = `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
    const c = cells.get(k) ?? cells.set(k, { n: 0, x: 0, y: 0, z: 0 }).get(k)!;
    c.n++;
    c.x += Math.cos(lat * rad) * Math.cos(lng * rad);
    c.y += Math.cos(lat * rad) * Math.sin(lng * rad);
    c.z += Math.sin(lat * rad);
  }
  const top = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, KEEP);
  const sum = top.reduce((s, c) => s + c.n, 0);
  return top.map((c) => [
    Math.round(Math.atan2(c.z, Math.hypot(c.x, c.y)) / rad * 10) / 10,
    Math.round(Math.atan2(c.y, c.x) / rad * 10) / 10,
    Math.round((c.n / sum) * 1000) / 1000,
  ]);
}

/** Mean distance the records' weight has to travel to turn one month's picture into another's, greedy nearest first. */
function shift(a: Place[], b: Place[]) {
  const ra = a.map((p) => p[2]);
  const rb = b.map((p) => p[2]);
  const pairs: [number, number, number][] = [];
  a.forEach((p, i) => b.forEach((q, j) => pairs.push([km(p, q), i, j])));
  pairs.sort((x, y) => x[0] - y[0]);
  let moved = 0;
  for (const [d, i, j] of pairs) {
    const m = Math.min(ra[i], rb[j]);
    if (m <= 0) continue;
    ra[i] -= m;
    rb[j] -= m;
    moved += m * d;
  }
  return moved;
}

const { species } = JSON.parse(await readFile('public/data/species.json', 'utf8')) as { species: Species[] };
const only = process.env.SPECIES ? new Set(process.env.SPECIES.split(',').map((s) => s.trim())) : null;
let made = 0;
let skipped = 0;

async function one(s: Species) {
  const cache = `.cache/seasons/${s.id}.json`;
  let months: Place[][] | null = null;
  let counts: number[] = [];
  if (await exists(cache)) ({ months, counts } = JSON.parse(await readFile(cache, 'utf8')));
  else {
    months = [];
    for (let m = 1; m <= 12; m++) {
      // one page a month keeps the run short; a random offset keeps it from always being the same dataset's records
      let r = await getJSON(`${occ(s.id, m)}&limit=${PAGE}&offset=${Math.floor(Math.random() * 12) * PAGE}`);
      if (!r?.results?.length) r = await getJSON(`${occ(s.id, m)}&limit=${PAGE}`);
      const pts: number[][] = [];
      for (const o of r?.results ?? []) {
        if (typeof o.decimalLatitude === 'number' && typeof o.decimalLongitude === 'number' && !isCaptive(o)) pts.push([o.decimalLatitude, o.decimalLongitude]);
      }
      counts.push(pts.length);
      months.push(places(pts));
    }
    await writeFile(cache, JSON.stringify({ months, counts }));
  }
  if (counts.filter((n) => n >= MIN_MONTH).length < MIN_MONTHS) return `${s.name}: too few records by month`;
  // the biggest change between any two months, and the change between neighbouring months
  let far = 0;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) if (counts[i] >= MIN_MONTH && counts[j] >= MIN_MONTH) far = Math.max(far, shift(months[i], months[j]));
  if (far < MIN_MOVE_KM) return `${s.name}: stays put (${Math.round(far)} km)`;
  // a real seasonal move is smooth: neighbouring months look alike. Month-to-month jumps as big as the year's biggest
  // change mean the sample is just noisy (a few busy hotspots, or a different set of observers each month)
  let adj = 0;
  let pairs = 0;
  for (let i = 0; i < 12; i++) {
    const j = (i + 1) % 12;
    if (counts[i] >= MIN_MONTH && counts[j] >= MIN_MONTH) {
      adj += shift(months[i], months[j]);
      pairs++;
    }
  }
  if (!pairs || adj / pairs > far * MAX_JUMP) return `${s.name}: too jumpy (${Math.round(far)} km, ${Math.round(adj / Math.max(1, pairs))} km a month)`;
  await writeFile(`public/data/seasons/${s.id}.json`, JSON.stringify({ months, moveKm: Math.round(far) }));
  made++;
  return `${s.name}: migrates, ${Math.round(far)} km`;
}

const todo = species.filter((s) => !only || only.has(s.sci));
const queue = [...todo];
const workers = Array.from({ length: 10 }, async () => {
  for (let s = queue.shift(); s; s = queue.shift()) {
    const msg = await one(s).catch((e) => `${s.name}: failed ${e}`);
    if (!msg.includes('migrates')) skipped++;
    console.log(msg);
  }
});
await Promise.all(workers);
console.log(`seasons: ${made} animals migrate, ${skipped} do not or lack data`);
