// States and provinces (admin-1) from Natural Earth, simplified with shared borders kept intact,
// then split into one small file per country: public/data/states/<ISO>.json (loaded only when a country is opened).
// Run: npm run states
import mapshaper from 'mapshaper';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const OUT = 'public/data/states';

// The globe treats a ring's direction as meaning: outer rings must run clockwise (as in the Natural Earth
// country file) or it fills the whole sphere *except* the shape. Normalise: outer clockwise, holes anticlockwise.
type Ring = number[][];
const signedArea = (r: Ring) => r.reduce((a, p, i) => (i ? a + (r[i - 1][0] * p[1] - p[0] * r[i - 1][1]) : a), 0);
const orient = (r: Ring, clockwise: boolean) => ((signedArea(r) < 0) === clockwise ? r : [...r].reverse());
const fixPoly = (poly: Ring[]) => poly.map((ring, i) => orient(ring, i === 0));
function fixWinding(g: any) {
  if (g.type === 'Polygon') g.coordinates = fixPoly(g.coordinates);
  else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map(fixPoly);
  return g;
}
const TMP = '.cache/states-tmp';

await mkdir('.cache', { recursive: true });
const raw = await (await fetch(NE)).text();
await writeFile('.cache/ne_admin1.geojson', raw);
console.log('downloaded', (raw.length / 1e6).toFixed(1), 'MB');

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
await mapshaper.runCommands(
  `-i .cache/ne_admin1.geojson ` +
    `-filter "/^[A-Z]{2}$/.test(iso_a2)" ` +
    `-each "id=adm1_code, iso=iso_a2, kind=type_en || 'Region'" ` +
    `-filter-fields id,name,iso,kind ` +
    `-simplify 7% keep-shapes ` +
    `-split iso ` +
    `-o ${TMP}/ format=geojson precision=0.01`,
);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const index: Record<string, number> = {};
for (const f of await readdir(TMP)) {
  const fc = JSON.parse(await readFile(`${TMP}/${f}`, 'utf8'));
  const feats = fc.features.filter((x: any) => x.geometry && x.properties.name);
  for (const f of feats) fixWinding(f.geometry);
  if (feats.length < 2) continue; // a country that is its own only region has nothing to open
  const iso = feats[0].properties.iso;
  await writeFile(`${OUT}/${iso}.json`, JSON.stringify({ type: 'FeatureCollection', features: feats }));
  index[iso] = feats.length;
}
await writeFile(`${OUT}/index.json`, JSON.stringify(index));
await rm(TMP, { recursive: true, force: true });
console.log('countries with states:', Object.keys(index).length, 'regions:', Object.values(index).reduce((a, b) => a + b, 0));
