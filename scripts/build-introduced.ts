// Marks the countries where an animal is introduced (data/introduced.csv) in public/data/species.json, by adding
// `introduced: true` to that country in the animal's `countries`. Runs after build-data in `npm run data`; it only
// reads what is already in public/ and data/, so it needs no network. Safe to rerun: it clears the marks first.
// A row naming an animal that isn't in species.json, or a country outside its range, stops the build so the file
// can't drift out of step with the data.
import { readFile, writeFile } from 'node:fs/promises';
import type { Species } from '../src/types';

const PUB = 'public';
const data = JSON.parse(await readFile(`${PUB}/data/species.json`, 'utf8')) as { generated: string; species: Species[] };

const rows = (await readFile('data/introduced.csv', 'utf8'))
  .trim().split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [sci, countries] = l.split(',');
    return { sci: sci.trim(), countries: countries.split(';').map((c) => c.trim()) };
  });

for (const s of data.species) for (const c of s.countries) delete c.introduced;

const problems: string[] = [];
let marked = 0;
for (const r of rows) {
  const s = data.species.find((x) => x.sci === r.sci);
  if (!s) {
    problems.push(`${r.sci}: not in species.json`);
    continue;
  }
  for (const iso of r.countries) {
    const c = s.countries.find((x) => x.iso === iso);
    if (!c) {
      problems.push(`${s.name} (${r.sci}): ${iso} is not one of its range countries (${s.countries.map((x) => x.iso).join(' ')})`);
      continue;
    }
    c.introduced = true;
    marked++;
  }
}
if (problems.length) {
  console.error(`data/introduced.csv does not match the data:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

await writeFile(`${PUB}/data/species.json`, JSON.stringify(data));
console.log(`introduced: ${marked} countries marked across ${rows.length} animals`);
