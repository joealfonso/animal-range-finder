// Clears the map of places on continents an animal isn't listed for: the dots in public/data/points/ and the 2° cells
// in public/data/range/. Most of them are zoo, farm and pet animals GBIF doesn't flag as captive (bison in Hungary,
// tigers in Germany), and the animal's continents and countries already leave them out, so the map shouldn't show them.
// The trade: a continent is listed only when one of its countries holds 1.5% of the records, so real range on a
// continent whose countries are each under that goes too (the turkey vulture's South America, the polar bear's
// Svalbard). The map matches the list. A place in no country (the open sea) stays. Runs after build-data in `npm run data`; it only reads what is
// already in public/, so it needs no network. Safe to rerun.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Species } from '../src/types';

const PUB = 'public';
const { species } = JSON.parse(await readFile(`${PUB}/data/species.json`, 'utf8')) as { species: Species[] };
const countries = JSON.parse(await readFile(`${PUB}/data/countries.json`, 'utf8'));

type Ring = number[][];
interface Shape { iso: string; continent: string; poly: Ring[]; box: [number, number, number, number] }
const shapes: Shape[] = [];
for (const f of countries.features) {
  const polys: Ring[][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const [x, y] of poly[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    shapes.push({ iso: f.properties.iso, continent: f.properties.continent, poly, box: [x0, y0, x1, y1] });
  }
}

function inRing(x: number, y: number, r: Ring) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The continent a place is on, or null in the open sea. Natural Earth files all of Russia under Europe, so it is split
 * at the Urals (60°E) as build-data does. It also files overseas parts under their country (French Guiana, Réunion
 * and the Dutch Caribbean are "Europe"), so a European country's place far outside Europe takes the continent it is on.
 */
const memo = new Map<string, string | null>();
function continentAt(lat: number, lng: number): string | null {
  const k = `${lat},${lng}`;
  if (memo.has(k)) return memo.get(k)!;
  let out: string | null = null;
  for (const s of shapes) {
    const [x0, y0, x1, y1] = s.box;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    if (!inRing(lng, lat, s.poly[0]) || s.poly.slice(1).some((h) => inRing(lng, lat, h))) continue;
    out = s.continent;
    if (s.iso === 'RU') out = lng >= 0 && lng < 60 ? 'Europe' : 'Asia'; // as build-data: Chukotka over the date line is Asia
    else if (out === 'Europe' && (lat < 27 || lng < -32 || lng > 70)) {
      if (lng < -100 || lng > 130) out = 'Oceania';
      else if (lng < -32) out = lat >= 12 ? 'North America' : 'South America';
      else if (lng > 70) out = 'Asia';
      else out = 'Africa';
    }
    break;
  }
  memo.set(k, out);
  return out;
}

const CELL = 2; // build-data's range cells
const cellOf = (lat: number, lng: number) => `${Math.floor(lat / CELL) * CELL + CELL / 2},${Math.floor(lng / CELL) * CELL + CELL / 2}`;

// The clip always starts from the files as build-data wrote them, kept in .cache/clip/, so running it again gives the
// same result, and a continent that comes back (a row taken out of data/continent-fixes.csv) gets its cells back with
// its dots. That matters for the range: build-data writes it only when it fetches the animal again. A published file
// that differs from the last clip is new from build-data and becomes the source.
await mkdir('.cache/clip', { recursive: true });
async function source(kind: 'points' | 'range', id: number): Promise<number[][]> {
  const pub = await readFile(`${PUB}/data/${kind}/${id}.json`, 'utf8');
  const raw = `.cache/clip/${kind}-${id}.json`;
  const last = await readFile(`.cache/clip/${kind}-${id}.clipped.json`, 'utf8').catch(() => null);
  if (last === pub) return JSON.parse(await readFile(raw, 'utf8'));
  await writeFile(raw, pub);
  return JSON.parse(pub);
}
async function publish(kind: 'points' | 'range', id: number, data: number[][]) {
  const json = JSON.stringify(data);
  await writeFile(`${PUB}/data/${kind}/${id}.json`, json);
  await writeFile(`.cache/clip/${kind}-${id}.clipped.json`, json);
}

let dotsOut = 0, cellsOut = 0, touched = 0;
for (const s of species) {
  const listed = new Set(s.continents);
  const pts = await source('points', s.id);
  const keptCells = new Set<string>();
  const droppedCells = new Set<string>();
  const kept = pts.filter((p) => {
    const c = continentAt(p[0], p[1]);
    const keep = c === null || listed.has(c);
    (keep ? keptCells : droppedCells).add(cellOf(p[0], p[1]));
    return keep;
  });
  // a cell goes only when every place in it went, so a cell on a coast or a border keeps the records it shares. A cell
  // with no dot in it (its records were rounded or merged away) is judged by its centre.
  const cells = await source('range', s.id);
  const keptRange = cells.filter(([la, lo]) => {
    const k = `${la},${lo}`;
    if (keptCells.has(k)) return true;
    if (droppedCells.has(k)) return false;
    const c = continentAt(la, lo);
    return c === null || listed.has(c);
  });
  if (!kept.length || !keptRange.length) throw new Error(`${s.name}: clipping to ${s.continents.join(', ')} leaves nothing`);
  // build-data weighs a cell log(records) / log(the top cell's records): when the top cell went, the weights are
  // rescaled to the new top, which is the same sum done again. A cell at the 0.1 floor stays there: its true weight
  // was below 0.1, so dividing it would overstate it.
  const top = Math.max(...keptRange.map((c) => c[2]));
  if (top < 1) for (const c of keptRange) if (c[2] > 0.1) c[2] = Math.round(Math.max(0.1, c[2] / top) * 100) / 100;
  if (kept.length < pts.length || keptRange.length < cells.length) touched++;
  dotsOut += pts.length - kept.length;
  cellsOut += cells.length - keptRange.length;
  await publish('points', s.id, kept);
  await publish('range', s.id, keptRange);
}
console.log(`clip-continents: ${touched} animals, ${dotsOut} dots and ${cellsOut} range cells off their continents removed`);
