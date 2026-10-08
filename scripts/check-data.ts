// Checks the built data in public/ before it ships: every animal has the files the app fetches for it, links are
// http(s), no text could be read as HTML, and the countries and states it names exist. The app gets a real 404 for a
// missing file (no single-page fallback), so a gap here would show up as an animal that silently fails to load.
// Run: npm run check (also runs in CI on every pull request). Exits 1 and lists every problem if anything is off.
import { readFile, access } from 'node:fs/promises';
import { STATUS_LABEL, type Species } from '../src/types';

const PUB = process.argv[2] ?? 'public'; // another folder can be passed, e.g. to test the check itself
const problems: string[] = [];
const fail = (where: string, what: string) => problems.push(`${where}: ${what}`);
const exists = (p: string) => access(p).then(() => true, () => false);
const readJSON = async (p: string): Promise<any> => JSON.parse(await readFile(p, 'utf8'));

const isUrl = (u: unknown) => typeof u === 'string' && /^https?:\/\//i.test(u);
const isNum = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const inLatLng = (lat: unknown, lng: unknown) => isNum(lat) && isNum(lng) && Math.abs(lat as number) <= 90 && Math.abs(lng as number) <= 180;

const { species } = (await readJSON(`${PUB}/data/species.json`)) as { species: Species[] };
const countries = await readJSON(`${PUB}/data/countries.json`);
const countryIsos = new Set<string>(countries.features.map((f: any) => f.properties.iso));
const stateIndex: Record<string, number> = await readJSON(`${PUB}/data/states/index.json`);

// every country listed as having states has its file, and we keep the ids for the species checks below
const stateIds = new Map<string, Set<string>>();
for (const iso of Object.keys(stateIndex)) {
  const p = `${PUB}/data/states/${iso}.json`;
  if (!(await exists(p))) {
    fail('states/index.json', `lists ${iso} but ${p} is missing`);
    continue;
  }
  stateIds.set(iso, new Set((await readJSON(p)).features.map((f: any) => f.properties.id)));
}

if (!Array.isArray(species) || !species.length) fail('species.json', 'no species');
const seenIds = new Set<number>();
const seenNos = new Set<string>();

for (const s of species) {
  const at = `${s.name ?? '?'} (${s.id})`;

  if (!Number.isInteger(s.id)) fail(at, 'id is not a whole number');
  if (seenIds.has(s.id)) fail(at, 'duplicate id');
  seenIds.add(s.id);
  if (seenNos.has(s.no)) fail(at, `duplicate catalogue number ${s.no}`);
  seenNos.add(s.no);
  for (const k of ['name', 'sci', 'desc', 'group', 'family'] as const) if (typeof s[k] !== 'string' || !s[k]) fail(at, `missing ${k}`);
  if (!STATUS_LABEL[s.status]) fail(at, `unknown status ${s.status}`);
  if (!s.continents?.length) fail(at, 'no continents');

  // anything that ends up in the page must be plain text
  const text = JSON.stringify(s);
  if (/[<>]/.test(text)) fail(at, 'contains < or >, which the page could read as HTML');

  // links the plate renders
  if (s.wiki !== null && !isUrl(s.wiki)) fail(at, `wiki link is not http(s): ${s.wiki}`);
  if (s.credit) {
    if (!isUrl(s.credit.page)) fail(at, `photo page link is not http(s): ${s.credit.page}`);
    if (s.credit.licenseUrl !== null && !isUrl(s.credit.licenseUrl)) fail(at, `licence link is not http(s): ${s.credit.licenseUrl}`);
  }

  // files the app fetches when the animal is opened
  if (s.img) {
    if (!(await exists(`${PUB}/${s.img}`))) fail(at, `photo ${s.img} is missing`);
    if (!isNum(s.imgW) || !isNum(s.imgH)) fail(at, 'photo has no width/height');
  }
  const rangePath = `${PUB}/data/range/${s.id}.json`;
  if (!(await exists(rangePath))) fail(at, `${rangePath} is missing`);
  else {
    const cells = await readJSON(rangePath);
    if (!Array.isArray(cells) || !cells.length) fail(at, 'range has no cells');
    else if (!cells.every((c: any) => Array.isArray(c) && inLatLng(c[0], c[1]) && isNum(c[2]))) fail(at, 'range has a malformed cell');
  }
  const pointsPath = `${PUB}/data/points/${s.id}.json`;
  if (!(await exists(pointsPath))) fail(at, `${pointsPath} is missing`);
  else {
    const pts = await readJSON(pointsPath);
    if (!Array.isArray(pts)) fail(at, 'points file is not a list');
    else if (!pts.every((p: any) => Array.isArray(p) && inLatLng(p[0], p[1]))) fail(at, 'points has a malformed point');
  }

  // places it names have to exist, or the globe and the range list can't show them
  for (const iso of s.iso) if (!countryIsos.has(iso)) fail(at, `country ${iso} is not in countries.json`);
  for (const st of s.states ?? []) {
    const ids = stateIds.get(st.iso);
    if (!ids) fail(at, `state ${st.name} is in ${st.iso}, which has no states file`);
    else if (!ids.has(st.id)) fail(at, `state ${st.name} (${st.id}) is not in states/${st.iso}.json`);
  }
}

if (problems.length) {
  console.error(`Data check failed, ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`Data check passed: ${species.length} species, ${stateIds.size} countries with states.`);
