// Cross-checks every animal's conservation status against Wikidata's IUCN status for the same Wikipedia article.
// GBIF republishes the IUCN category by name, and a renamed species or a split one can come back as "not evaluated" or
// as another animal's status (the giant otter, the Galápagos tortoise, the Indian flying fox). Run it after adding or
// rebuilding animals: `npm run audit`. It needs the network, so it is not part of CI, and Wikidata can lag the Red
// List too, so a mismatch is something to look into, not proof. Where it is GBIF that is wrong, set the right category in
// STATUS_OVERRIDE in scripts/build-data.ts (animals already there are skipped here). Exits 1 if any mismatch is left.
import { readFile } from 'node:fs/promises';
import type { Species } from '../src/types';

const UA = 'animal-range-finder/0.1 (status audit; https://github.com/joealfonso/animal-range-finder)';
const getJSON = (url: string): Promise<any> => fetch(url, { headers: { 'User-Agent': UA } }).then((r) => r.json());

// Wikidata items for IUCN categories (Endangered has two)
const CATEGORY: Record<string, string> = {
  Q211005: 'LC', Q719675: 'NT', Q278113: 'VU', Q11394: 'EN', Q96377276: 'EN', Q219127: 'CR',
  Q237350: 'EX', Q239509: 'EW', Q3245245: 'DD',
};

// Mismatches that are checked and fine, keyed by the scientific name shown in the app, with why.
const KNOWN: Record<string, string> = {
  'Damaliscus lunatus': 'Wikipedia’s topi article is the subspecies (VU); the animal here is the whole species, rated LC',
  'Apis mellifera': 'Wikipedia cites the European regional assessment (DD); there is no global one, so NE stands',
};

const { species } = JSON.parse(await readFile('public/data/species.json', 'utf8')) as { species: Species[] };
const overrides = new Set(
  [...(await readFile('scripts/build-data.ts', 'utf8')).matchAll(/^\s+'([^']+)':\s*'[A-Z]+',?$/gm)].map((m) => m[1]),
);
const titleOf = (s: Species) => decodeURIComponent((s.wiki ?? '').split('/wiki/')[1] ?? '').replace(/_/g, ' ');

// Wikipedia article -> Wikidata item (50 titles per request)
const item = new Map<number, string | undefined>();
for (let i = 0; i < species.length; i += 50) {
  const batch = species.slice(i, i + 50);
  const r = await getJSON(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(batch.map(titleOf).join('|'))}`,
  );
  const moved = new Map<string, string>([...(r.query.normalized ?? []), ...(r.query.redirects ?? [])].map((m: any) => [m.from, m.to]));
  const byTitle = new Map<string, string | undefined>(Object.values<any>(r.query.pages).map((p) => [p.title, p.pageprops?.wikibase_item]));
  for (const s of batch) {
    let t = titleOf(s);
    for (let k = 0; k < 3 && moved.has(t); k++) t = moved.get(t)!;
    item.set(s.id, byTitle.get(t));
  }
}

// Wikidata item -> its IUCN categories (an item can list an old and a new one)
const wanted = [...new Set([...item.values()].filter((q): q is string => !!q))];
const categories = new Map<string, string[]>();
for (let i = 0; i < wanted.length; i += 50) {
  const r = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${wanted.slice(i, i + 50).join('|')}`);
  for (const [q, e] of Object.entries<any>(r.entities)) {
    const cats = (e.claims?.P141 ?? [])
      .filter((c: any) => c.rank !== 'deprecated')
      .map((c: any) => CATEGORY[c.mainsnak?.datavalue?.value?.id] ?? c.mainsnak?.datavalue?.value?.id);
    categories.set(q, [...new Set<string>(cats)]);
  }
}

const mismatches: string[] = [];
let agree = 0, silent = 0, handSet = 0, known = 0;
for (const s of species) {
  const wd = categories.get(item.get(s.id) ?? '') ?? [];
  if (overrides.has(s.sci)) handSet++;
  else if (!wd.length) silent++;
  else if (wd.includes(s.status)) agree++;
  else if (KNOWN[s.sci]) known++;
  else mismatches.push(`  ${s.name.padEnd(30)} app ${s.status.padEnd(3)} Wikidata ${wd.join(' / ')}   ${s.wiki ?? ''}`);
}
console.log(`${species.length} animals: ${agree} agree, ${handSet} set by hand, ${known} known differences, ${silent} with no Wikidata status, ${mismatches.length} mismatched`);
if (mismatches.length) {
  console.log('\nCheck each against the IUCN assessment cited in its Wikipedia infobox:\n' + mismatches.join('\n'));
  process.exitCode = 1;
}
