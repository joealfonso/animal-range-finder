// Builds public/data/near.json, the index behind "What lives here": for every 1° cell that holds a sampled wild record,
// the animals recorded in it. The app reads it to find which animals to look at for a pin, then fetches only those
// animals' point files to measure the distance to the nearest record. Runs at the end of `npm run data`; it only reads
// what is already in public/, so it needs no network.
import { readFile, writeFile } from 'node:fs/promises';
import type { Species } from '../src/types';

const PUB = 'public';
const { species } = JSON.parse(await readFile(`${PUB}/data/species.json`, 'utf8')) as { species: Species[] };

// "lat,lng" of the cell's south-west corner -> animal ids (the index each animal has in species.json, to keep it small)
const cells = new Map<string, Set<number>>();
for (const [i, s] of species.entries()) {
  const pts: number[][] = JSON.parse(await readFile(`${PUB}/data/points/${s.id}.json`, 'utf8'));
  for (const [lat, lng] of pts) {
    // the app wraps longitude to -180..179 and caps latitude at 89, so a record on the edge lands in the cell it reads
    const k = `${Math.min(89, Math.floor(lat))},${Math.floor(lng) === 180 ? -180 : Math.floor(lng)}`;
    let set = cells.get(k);
    if (!set) cells.set(k, (set = new Set()));
    set.add(i);
  }
}

const out: Record<string, number[]> = {};
for (const [k, set] of [...cells].sort(([a], [b]) => a.localeCompare(b))) out[k] = [...set].sort((a, b) => a - b);
// ids listed in the file so the app can check it matches the species.json it loaded
await writeFile(`${PUB}/data/near.json`, JSON.stringify({ ids: species.map((s) => s.id), cells: out }));
console.log(`near.json: ${cells.size} cells, ${species.length} animals`);
