// Time-travel data: for each animal, where GBIF records were logged in each era, so the app can show the range
// "through 2000", "through 2010" and so on. Writes public/data/time/<gbif key>.json.
//
// The main sample (build-data.ts) drops each record's year, so this samples again per era with GBIF's `year` filter.
// Each era keeps its true record count (from GBIF) next to a 2° cell sample, so the app can weight the eras against each
// other and add them up. Finished animals are cached in .cache/time/, so a rerun only fetches new ones.
// Run: npm run time
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';

const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';
const GBIF = 'https://api.gbif.org/v1';
const CELL = 2;
const PAGE = 300;
const MAX_PAGES = 2;
const ERAS: [number, number][] = [[1000, 1989], [1990, 1999], [2000, 2009], [2010, 2019]]; // 2020 on is the main range
const MIN_EARLY = 30; // fewer records than this before 2010 and the slider has nothing worth showing

// as in build-data.ts: subspecies GBIF files under a species that are not the animal we mean
const EXCLUDE_BY_SCI: Record<string, number[]> = {
  'Canis lupus': [6164210, 6164184],
  'Gorilla beringei': [4267322],
};

const CAPTIVE = new Set(['captive', 'managed', 'cultivated', 'released']);
const isCaptive = (o: any) => CAPTIVE.has(String(o.degreeOfEstablishment ?? '').toLowerCase()) || o.establishmentMeans === 'MANAGED';
const exists = (p: string) => access(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string, tries = 4): Promise<any> {
  if (process.env.DEBUG) console.log('GET', url.slice(-90));
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }).catch(() => null);
    if (!res) { await sleep(800); continue; }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(800 * (i + 1) * (res.status === 429 ? 3 : 1));
  }
  throw new Error('failed ' + url);
}

const occBase = (key: number) =>
  `${GBIF}/occurrence/search?taxonKey=${key}&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT&basisOfRecord=HUMAN_OBSERVATION&basisOfRecord=OBSERVATION&basisOfRecord=MACHINE_OBSERVATION&basisOfRecord=PRESERVED_SPECIMEN`;

type Cell = [number, number, number]; // lat, lng, records this cell stands for (sample count scaled up to the era's total)

async function eraCells(key: number, [from, to]: [number, number], exclude: Set<number>) {
  const base = `${occBase(key)}&year=${from},${to}`;
  const total: number = (await getJSON(`${base}&limit=0`))?.count ?? 0;
  if (!total) return { n: 0, cells: [] as Cell[] };
  const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE));
  const stride = Math.max(PAGE, Math.floor((Math.min(total, 8000) - PAGE) / Math.max(1, pages - 1)));
  const counts = new Map<string, number>();
  let kept = 0;
  for (let p = 0; p < pages; p++) {
    const r = await getJSON(`${base}&limit=${PAGE}&offset=${p * stride}`).catch(() => null);
    for (const o of r?.results ?? []) {
      if (typeof o.decimalLatitude !== 'number' || typeof o.decimalLongitude !== 'number' || isCaptive(o)) continue;
      if (exclude.has(o.taxonKey) || exclude.has(o.acceptedTaxonKey)) continue;
      const la = Math.floor(o.decimalLatitude / CELL) * CELL + CELL / 2;
      const lo = Math.floor(o.decimalLongitude / CELL) * CELL + CELL / 2;
      counts.set(`${la},${lo}`, (counts.get(`${la},${lo}`) ?? 0) + 1);
      kept++;
    }
  }
  if (!kept) return { n: 0, cells: [] as Cell[] };
  const scale = total / kept;
  const cells: Cell[] = [...counts.entries()].map(([k, v]) => {
    const [la, lo] = k.split(',').map(Number);
    return [la, lo, Math.max(1, Math.round(v * scale))];
  });
  return { n: total, cells };
}

await mkdir('public/data/time', { recursive: true });
await mkdir('.cache/time', { recursive: true });
const species: { id: number; sci: string }[] = JSON.parse(await readFile('public/data/species.json', 'utf8')).species;
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;

let done = 0, skipped = 0;
const queue = species.filter((s) => !only || only.has(s.id));
async function work() {
  for (let s = queue.shift(); s; s = queue.shift()) {
    const out = `public/data/time/${s.id}.json`;
    const cache = `.cache/time/${s.id}.json`;
    if (await exists(cache)) {
      if (await exists(out)) { done++; continue; }
      skipped++;
      continue;
    }
    try {
      const exclude = new Set(EXCLUDE_BY_SCI[s.sci] ?? []);
      const eras = [];
      for (const e of ERAS) {
        const r = await eraCells(s.id, e, exclude);
        eras.push({ to: e[1], n: r.n, cells: r.cells });
      }
      const early = eras.reduce((a, e) => a + e.n, 0);
      await writeFile(cache, '1');
      if (early < MIN_EARLY || eras.filter((e) => e.n > 0).length < 2) { skipped++; continue; }
      await writeFile(out, JSON.stringify({ eras }));
      done++;
    } catch (e) {
      console.warn('skip', s.sci, (e as Error).message.slice(0, 80));
      skipped++;
    }
    if ((done + skipped) % 20 === 0) console.log(`${done + skipped} / ${species.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, work));
console.log(`time files: ${done}, no slider: ${skipped}`);
