// Data pipeline: data/species.csv -> public/data/species.json + public/data/range/<id>.json + public/img/<id>.webp
// Needs public/data/countries.json and public/data/states/ first (npm run assets).
// Sources: GBIF (taxonomy, IUCN category, occurrences), Wikipedia (summary), Wikimedia Commons (image + licence).
// Occurrences are counted, not sampled: an animal with up to CENSUS_MAX records is read record by record, a more common one
// is counted square by square with GBIF's ad-hoc density maps (scripts/lib/density.ts), which give the search's own counts. A sample of the search results
// followed whichever datasets GBIF listed first, so it said nothing reliable about where the records are.
// To add species: append a row to data/species.csv and run `npm run data`. Finished species are cached in .cache/.
// No API keys are needed. If one is ever added, read it from process.env and document it in .env.example.
import { tidy } from './lib/text';
import sharp from 'sharp';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fetchSquares, fetchCells, squaresOf, centreOf, squareOf, SQUARE_DEG, COLS } from './lib/density';

const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';
const GBIF = 'https://api.gbif.org/v1';
const CELL = 2; // degrees per density cell
const PAGE = 300;
// Records an animal can have and still be read one by one. GBIF's search stalls for any page that starts past offset 10,000
// (pages at 9,000 and 9,900 take 2 s, the one at 10,200 never answers), so this is also the most it can page through.
const CENSUS_MAX = 10000;
const BASIS = ['HUMAN_OBSERVATION', 'OBSERVATION', 'MACHINE_OBSERVATION', 'PRESERVED_SPECIMEN'];
const FILTERS = `hasGeospatialIssue=false&occurrenceStatus=PRESENT&${BASIS.map((b) => `basisOfRecord=${b}`).join('&')}`;

await mkdir('.cache', { recursive: true });
await mkdir('public/img', { recursive: true });
await mkdir('public/data/range', { recursive: true });
await mkdir('public/data/points', { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    if (process.env.DEBUG) console.log(new Date().toISOString().slice(17, 23), 'GET', url.slice(0, 120));
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (!res) { await sleep(800); continue; }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(800 * (i + 1) * (res.status === 429 ? 3 : 1));
  }
  throw new Error('failed ' + url);
}
const exists = (p: string) => access(p).then(() => true, () => false);

// Country geometry gives us ISO -> continent / name.
const countries = JSON.parse(await readFile('public/data/countries.json', 'utf8'));
const isoInfo = new Map<string, { name: string; continent: string }>();
for (const f of countries.features) isoInfo.set(f.properties.iso, { name: f.properties.name, continent: f.properties.continent });

const occBase = (keys: number[]) =>
  `${GBIF}/occurrence/search?${keys.map((k) => `taxonKey=${k}`).join('&')}&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT&${BASIS.map((b) => `basisOfRecord=${b}`).join('&')}`;

/** lat, lng, ISO country code (null when a binned count has none), and how many records the place stands for (default 1) */
type Pt = [number, number, string | null, number?];

// Subspecies GBIF files under a species that are not the animal we mean. Their records are left out of every count
// and the sample. Dogs (and the dingo) are filed under the wolf, and make up about half of its records.
const EXCLUDE: Record<string, number[]> = {
  'Canis lupus': [6164210 /* Canis lupus familiaris, dogs */, 6164184 /* Canis lupus dingo */],
  // the mountain gorilla is the other eastern gorilla subspecies; Grauer's gorilla lives in the lowlands of the DR Congo
  'Gorilla beringei': [4267322 /* Gorilla beringei graueri, Grauer's gorilla */],
};
// Species GBIF files separately that the animal here includes. IUCN, Wikipedia and most people treat the giraffe as one
// animal; GBIF's Giraffa camelopardalis is only the northern giraffe, and the other three hold two thirds of the records.
const INCLUDE: Record<string, number[]> = {
  'Giraffa camelopardalis': [9163257 /* G. tippelskirchi, Masai */, 8959277 /* G. giraffa, southern */, 8888736 /* G. reticulata, reticulated */],
};

// IUCN categories GBIF has wrong or missing, set by hand and keyed by the scientific name shown in the app.
// GBIF holds the eastern gorilla's species-wide category (CR) but none for the mountain gorilla subspecies (EN since 2018),
// and lists the eland, giant otter, Malayan tapir, wild yak and Aldabra giant tortoise as not evaluated because their IUCN
// entries sit under an old genus name or an old assessment it doesn't match (LC, EN, EN, VU, VU).
// 'VAR' is not an IUCN category: GBIF's Galápagos tortoise is the extinct Floreana tortoise, but the photos, records and text
// are the living Galápagos tortoises, which IUCN now rates one species at a time (critically endangered to vulnerable).
// The Bactrian camel is the domestic animal, which IUCN has not rated; the wild camel is a separate species, critically endangered.
const STATUS_OVERRIDE: Record<string, string> = {
  'Gorilla beringei': 'EN',
  'Tragelaphus oryx': 'LC',
  'Pteronura brasiliensis': 'EN',
  'Tapirus indicus': 'EN',
  'Bos mutus': 'VU',
  'Aldabrachelys gigantea': 'VU',
  'Chelonoidis niger': 'VAR',
  'Camelus bactrianus': 'NE',
};

// Hand corrections for continents whose only records there are zoo or captive animals GBIF does not flag.
// data/continent-fixes.csv: scientific name, then the continents to drop, separated by semicolons.
const continentFixes = new Map<string, string[]>(
  (await readFile('data/continent-fixes.csv', 'utf8'))
    .trim().split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [sci, drop] = l.split(',');
      return [sci.trim(), drop.split(';').map((c) => c.trim())];
    }),
);

// Zoo, farm and released animals. GBIF flags many of them (degreeOfEstablishment); they are left out of every count.
const CAPTIVE = new Set(['captive', 'managed', 'cultivated', 'released']);
const isCaptive = (o: any) => CAPTIVE.has(String(o.degreeOfEstablishment ?? '').toLowerCase()) || o.establishmentMeans === 'MANAGED';

/** Every record of a search, a few pages at a time. A page that cannot be read stops the build: it must never read as "no records". */
async function eachRecord(url: string, each: (o: any) => void) {
  const seen = new Set<number>();
  const take = (r: any) => {
    for (const o of r.results ?? []) {
      if (seen.has(o.key)) continue; // the index moves while we page through it
      seen.add(o.key);
      each(o);
    }
  };
  const first = await getJSON(`${url}&limit=${PAGE}&offset=0`);
  if (!first) throw new Error(`could not read ${url}`);
  take(first);
  const pages = Math.ceil((first.count ?? 0) / PAGE);
  if ((pages - 1) * PAGE >= 10000) throw new Error(`more records than the search can page through: ${url}`);
  const offsets = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * PAGE);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let o = offsets.shift(); o !== undefined; o = offsets.shift()) {
        const r = await getJSON(`${url}&limit=${PAGE}&offset=${o}`);
        if (!r) throw new Error(`could not read ${url} at ${o}`);
        take(r);
      }
    }),
  );
}

const usable = (o: any) => typeof o.decimalLatitude === 'number' && typeof o.decimalLongitude === 'number';
const r3 = (n: number) => Math.round(n * 1000) / 1000;

interface Counted {
  /** wild records counted */
  total: number;
  captive: number;
  /** wild records per country code, every country (the shares come from this) */
  byCountry: Map<string, number>;
  /** places that hold records: single records when counted one by one, squares with a count when counted by area */
  places: Pt[];
  /** side of a place, degrees, when places are squares; null when they are single records */
  binned: number | null;
  /** records per square of the world, when counted by area: the heatmap's cells are summed from these */
  squares?: Map<number, number>;
  /** the same records at the map's own resolution (~0.1°), for placing them in states; absent when counted one by one */
  stateCells?: Pt[];
  /** wild Russian records, and how many of them are west of the Urals (0°E to 60°E) */
  ru: { total: number; west: number };
}

/** Animals with few records: every record, one by one. */
async function census(keys: number[], exclude: Set<number>): Promise<Counted> {
  const out: Counted = { total: 0, captive: 0, byCountry: new Map(), places: [], binned: null, ru: { total: 0, west: 0 } };
  await eachRecord(occBase(keys), (o) => {
    if (exclude.has(o.taxonKey) || exclude.has(o.acceptedTaxonKey) || !usable(o)) return;
    if (isCaptive(o)) return void out.captive++;
    const cc: string | null = o.countryCode ?? null;
    out.total++;
    if (cc) out.byCountry.set(cc, (out.byCountry.get(cc) ?? 0) + 1);
    if (cc === 'RU') {
      out.ru.total++;
      if (o.decimalLongitude >= 0 && o.decimalLongitude < 60) out.ru.west++;
    }
    out.places.push([r3(o.decimalLatitude), r3(o.decimalLongitude), cc]);
  });
  return out;
}

// The two ways a record counts as captive (isCaptive above), as search filters. A record can be both, so the records
// that are both are taken off once, not twice.
const CAPTIVE_DEGREE = ['captive', 'managed', 'cultivated', 'released'].map((d) => `degreeOfEstablishment=${d}`).join('&');
const CAPTIVE_MEANS = 'establishmentMeans=MANAGED';
const addTo = <K>(m: Map<K, number>, k: K, n: number) => m.set(k, (m.get(k) ?? 0) + n);

/** The captive and managed records of these taxa, per square and per country, counted through the same map as everything else
 *  so the squares line up exactly (a record's own coordinates and the map's cells are a little apart). */
async function captiveOf(keys: number[]) {
  const squares = new Map<number, number>();
  const countries = new Map<string, number>();
  for (const [q, sign] of [[CAPTIVE_DEGREE, 1], [CAPTIVE_MEANS, 1], [`${CAPTIVE_DEGREE}&${CAPTIVE_MEANS}`, -1]] as const) {
    if (!((await getJSON(`${occBase(keys)}&${q}&limit=0`))?.count ?? 0)) continue;
    for (const [id, n] of await fetchSquares(keys, `${FILTERS}&${q}`)) addTo(squares, id, sign * n);
    const f = await getJSON(`${occBase(keys)}&${q}&limit=0&facet=country&facetLimit=300`);
    for (const c of f?.facets?.[0]?.counts ?? []) addTo(countries, c.name as string, sign * c.count);
  }
  return { squares, countries };
}

// The map's own grid cells are 1.4° (four squares) across. Records of different searches (all of a species, its dogs, its
// captive animals) only line up exactly at that size: a record can fall in one 0.35° square in one search and the next
// in another. So captive records and excluded subspecies are taken off per 1.4° block, and the squares inside a block keep
// the shape the whole animal's records have there, scaled to what is left.
const BLOCK = 4;
const blockOf = (id: number) => Math.floor(Math.floor(id / COLS) / BLOCK) * (COLS / BLOCK) + Math.floor((id % COLS) / BLOCK);
const blocksOf = (m: Map<number, number>) => {
  const out = new Map<number, number>();
  for (const [id, n] of m) addTo(out, blockOf(id), n);
  return out;
};
const sumOf = (m: Map<any, number>) => [...m.values()].reduce((a, n) => a + n, 0);

/** Common animals: GBIF counts the records in every square of the world; captive records and excluded subspecies come off by hand. */
async function byArea(keys: number[], excludeKeys: number[]): Promise<Counted> {
  const cells = await fetchCells(keys, FILTERS);
  const squares = squaresOf(cells);
  const head = await getJSON(`${occBase(keys)}&limit=0&facet=country&facetLimit=300`);
  const byCountry = new Map<string, number>((head?.facets?.[0]?.counts ?? []).map((c: any) => [c.name, c.count]));
  const countryMap = (r: any) => new Map<string, number>((r?.facets?.[0]?.counts ?? []).map((c: any) => [c.name, c.count]));
  const take = (m: Map<any, number>, from: Map<any, number>) => {
    for (const [k, n] of from) m.set(k, Math.max(0, (m.get(k) ?? 0) - n));
  };

  // what comes off, per block and per country: the excluded subspecies whole (their captive records with them) ...
  const removed = new Map<number, number>();
  let expected: number = head?.count ?? 0;
  for (const ex of excludeKeys) {
    for (const [b, n] of blocksOf(await fetchSquares([ex], FILTERS))) addTo(removed, b, n);
    const r = await getJSON(`${occBase([ex])}&limit=0&facet=country&facetLimit=300`);
    take(byCountry, countryMap(r));
    expected -= r?.count ?? 0;
  }
  // ... and the captive records of the rest, which are those of everything minus those of the excluded subspecies
  const cap = await captiveOf(keys);
  const capBlocks = blocksOf(cap.squares);
  for (const ex of excludeKeys) {
    const capEx = await captiveOf([ex]);
    take(capBlocks, blocksOf(capEx.squares));
    take(cap.countries, capEx.countries);
  }
  for (const [b, n] of capBlocks) addTo(removed, b, Math.max(0, n));
  take(byCountry, cap.countries);
  const captive = sumOf(capBlocks);
  expected -= captive;

  const all = blocksOf(squares);
  const keep = (b: number) => Math.max(0, (all.get(b) ?? 0) - (removed.get(b) ?? 0)) / (all.get(b) || 1);
  for (const [id, n] of squares) squares.set(id, n * keep(blockOf(id)));
  const stateCells: Pt[] = cells.map((c) => [c.lat, c.lng, null, c.n * keep(blockOf(squareOf(c.lat, c.lng)))]);
  // the squares must add up to what GBIF's own counts say is left
  const left = sumOf(squares);
  if (Math.abs(left - expected) > Math.max(5, expected * 0.001)) throw new Error(`counted ${Math.round(left)} records by area but GBIF's counts leave ${expected}`);

  const ruOf = async (extra: string) => ((await getJSON(`${occBase(keys)}&country=RU${extra}&limit=0`))?.count ?? 0) as number;
  const ru = { total: byCountry.get('RU') ?? 0, west: Math.min(byCountry.get('RU') ?? 0, await ruOf('&decimalLongitude=0,60')) };

  // 2 x 2 squares make one place, about 0.7° across; a lone record in a place is left out, as stray records are in the heatmap
  const side = SQUARE_DEG * 2;
  const bins = new Map<number, number>();
  let total = 0;
  for (const [id, n] of squares) {
    if (n <= 0) continue;
    total += n;
    const b = Math.floor(Math.floor(id / COLS) / 2) * (COLS / 2) + Math.floor((id % COLS) / 2);
    bins.set(b, (bins.get(b) ?? 0) + n);
  }
  const places: Pt[] = [];
  for (const [b, n] of bins) {
    if (n < 2) continue;
    places.push([Math.round((90 - (Math.floor(b / (COLS / 2)) + 0.5) * side) * 100) / 100, Math.round((-180 + ((b % (COLS / 2)) + 0.5) * side) * 100) / 100, null, n]);
  }
  return { total: Math.round(total), captive: Math.round(captive), byCountry, places, binned: Math.round(side * 100) / 100, squares, stateCells, ru };
}

/** Everything the range depends on: the counts, the places, countries, states and citations. */
async function occurrencePart(key: number, excludeKeys: number[] = [], includeKeys: number[] = []) {
  const keys = [key, ...includeKeys];
  const all: number = (await getJSON(`${occBase(keys)}&limit=0`))?.count ?? 0;
  const c = all <= CENSUS_MAX ? await census(keys, new Set(excludeKeys)) : await byArea(keys, excludeKeys);
  const total = [...c.byCountry.values()].reduce((a, b) => a + b, 0);
  if (c.total < 20) throw new Error(`only ${c.total} wild occurrences`);
  if (c.places.length < 10 && c.binned === null) throw new Error('too few wild records');
  await writeCells(key, c);

  // Countries with at least 1.5% of wild records (kills stray/outlier noise), capped.
  const cc = [...c.byCountry.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((x) => x.count / total >= 0.015 && isoInfo.has(x.name))
    .sort((a, b) => b.count - a.count)
    .slice(0, 14);
  if (!cc.length) throw new Error('no countries');
  const iso = cc.map((x) => x.name);

  // the datasets that hold the most records, for citation (not counting the excluded subspecies' records)
  const datasets = [];
  const perDataset = new Map<string, number>();
  const facetOf = async (k: number[], limit: number) => (await getJSON(`${occBase(k)}&limit=0&facet=datasetKey&facetLimit=${limit}`))?.facets?.[0]?.counts ?? [];
  for (const d of await facetOf(keys, excludeKeys.length ? 100 : 3)) perDataset.set(d.name, d.count);
  for (const ex of excludeKeys) for (const d of await facetOf([ex], 1000)) perDataset.has(d.name) && perDataset.set(d.name, perDataset.get(d.name)! - d.count);
  const top = [...perDataset].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [datasetKey] of top) {
    const ds = await getJSON(`${GBIF}/dataset/${datasetKey}`);
    if (ds) datasets.push({ title: ds.title, doi: ds.doi ?? null, license: String(ds.license ?? '').replace(/^.*licenses\/(.*?)\/.*$/, (_: string, l: string) => l.toUpperCase()) });
  }

  return {
    v: 3,
    excludedTaxa: excludeKeys, // cache only: rebuild the range part if this list changes
    includedTaxa: includeKeys,
    iso,
    countries: cc.map((x) => ({ iso: x.name, share: Math.round((x.count / total) * 1000) / 1000 })),
    continents: [...new Set(iso.map((x: string) => isoInfo.get(x)!.continent))],
    occurrences: c.total,
    captiveExcluded: c.captive,
    ...(c.binned ? { binned: c.binned } : {}),
    datasets,
    states: await assignStates(c.stateCells ?? c.places, iso),
    ru: c.ru,
    points: c.places, // cache only, stripped from the published JSON
  };
}

/**
 * Bins the places into 2° cells for the range layer. The weight is how many records the cell holds on a log scale
 * (a cell with a hundred times the records is not a hundred times as dark), so a range reads as far as people have
 * recorded the animal and not only where they record it most. A cell never gets less than 0.1 so it can still show.
 */
async function writeCells(key: number, c: Counted) {
  const CELL = 2;
  const cells = new Map<string, number>();
  const add = (lat: number, lng: number, n: number) => {
    const k = `${Math.floor(lat / CELL) * CELL + CELL / 2},${Math.floor(lng / CELL) * CELL + CELL / 2}`;
    cells.set(k, (cells.get(k) ?? 0) + n);
  };
  if (c.squares) {
    // the heatmap's 2° cells are summed from the squares themselves, not from the places, so they stay exact
    for (const [id, n] of c.squares) if (n > 0) add(...centreOf(id), n);
  } else {
    for (const p of c.places) add(p[0], p[1], p[3] ?? 1);
  }
  const minCount = c.total > 400 ? 2 : 1; // drop lone outliers when we have enough data
  let max = 0;
  for (const v of cells.values()) max = Math.max(max, v);
  const rangeCells = [...cells.entries()]
    .filter(([, v]) => v >= minCount)
    .map(([k, v]) => {
      const [la, lo] = k.split(',').map(Number);
      return [la, lo, Math.round(Math.max(0.1, Math.log1p(v) / Math.log1p(max)) * 100) / 100];
    });
  await writeFile(`public/data/range/${key}.json`, JSON.stringify(rangeCells));
}

// ---- states: which admin-1 regions the records fall in (point in polygon, Natural Earth borders)
type Ring = number[][];
interface StateShape { id: string; name: string; iso: string; polys: Ring[][]; box: [number, number, number, number] }
const stateCache = new Map<string, StateShape[]>();
async function statesOf(iso: string): Promise<StateShape[]> {
  if (stateCache.has(iso)) return stateCache.get(iso)!;
  let list: StateShape[] = [];
  try {
    const fc = JSON.parse(await readFile(`public/data/states/${iso}.json`, 'utf8'));
    list = fc.features.map((f: any) => {
      const polys: Ring[][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      for (const poly of polys) for (const [x, y] of poly[0]) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { id: f.properties.id, name: f.properties.name, iso, polys, box: [x0, y0, x1, y1] };
    });
  } catch {
    // no state file for this country
  }
  stateCache.set(iso, list);
  return list;
}
const inRing = (x: number, y: number, ring: Ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolys = (x: number, y: number, polys: Ring[][]) =>
  polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole)));

// A record just outside the borders (the state outlines are simplified for the globe, and sea records, coasts and small
// islands fall outside them) counts for the nearest state, if one is within this many degrees (about 45 km).
const SNAP = 0.4;
/** Distance in degrees (east-west shrunk by `k` for latitude) from a point to the nearest edge of a polygon's outer ring. */
function edgeDistance(x: number, y: number, ring: Ring, k: number) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = (bx - ax) * k;
    const dy = by - ay;
    const ex = (x - ax) * k;
    const ey = y - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, (ex * dx + ey * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(dx * t - ex, dy * t - ey));
  }
  return best;
}

/**
 * States only count inside the animal's range countries, so zoo and stray records don't put pandas in Berlin. A place
 * counts as many times as the records it stands for, and one with no country code is tried against every range country.
 */
async function assignStates(places: Pt[], rangeIso: string[]) {
  const allowed = new Set(rangeIso);
  const counts = new Map<string, { s: StateShape; n: number }>();
  let total = 0;
  for (const [lat, lng, cc, w = 1] of places) {
    total += w;
    const isos = cc ? (allowed.has(cc) ? [cc] : []) : rangeIso;
    let hit: StateShape | undefined;
    for (const iso of isos) {
      for (const st of await statesOf(iso)) {
        const [x0, y0, x1, y1] = st.box;
        if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
        if (inPolys(lng, lat, st.polys)) {
          hit = st;
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) {
      const k = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      let near = SNAP;
      for (const iso of isos)
        for (const st of await statesOf(iso)) {
          const [x0, y0, x1, y1] = st.box;
          if (lng < x0 - SNAP / k || lng > x1 + SNAP / k || lat < y0 - SNAP || lat > y1 + SNAP) continue;
          for (const poly of st.polys) {
            const d = edgeDistance(lng, lat, poly[0], k);
            if (d < near) {
              near = d;
              hit = st;
            }
          }
        }
    }
    if (!hit) continue;
    const row = counts.get(hit.id) ?? { s: hit, n: 0 };
    row.n += w;
    counts.set(hit.id, row);
  }
  // a state needs a few records, and a small share, before it is listed: one stray record is not enough
  const minCount = Math.max(total > 400 ? 2 : 1, Math.ceil(total * 0.0015));
  return [...counts.values()]
    .filter((c) => c.n >= minCount)
    .sort((a, b) => b.n - a.n)
    .map((c) => ({ id: c.s.id, name: c.s.name, iso: c.s.iso, share: Math.round((c.n / total) * 1000) / 1000 }));
}

const IUCN: Record<string, string> = {
  EXTINCT: 'EX', EXTINCT_IN_THE_WILD: 'EW', CRITICALLY_ENDANGERED: 'CR', ENDANGERED: 'EN', VULNERABLE: 'VU',
  NEAR_THREATENED: 'NT', LEAST_CONCERN: 'LC', DATA_DEFICIENT: 'DD', NOT_EVALUATED: 'NE',
};
const GROUPS: Record<string, string> = {
  Mammalia: 'Mammal', Aves: 'Bird', Reptilia: 'Reptile', Amphibia: 'Amphibian', Insecta: 'Insect',
  Actinopterygii: 'Fish', Elasmobranchii: 'Fish', Chondrichthyes: 'Fish', Sarcopterygii: 'Fish',
  Cephalopoda: 'Mollusc', Malacostraca: 'Crustacean', Testudines: 'Reptile', Crocodylia: 'Reptile',
  Squamata: 'Reptile', Sphenodontia: 'Reptile', Coelacanthi: 'Fish', Holocephali: 'Fish', Gastropoda: 'Mollusc', Bivalvia: 'Mollusc',
  Scyphozoa: 'Jellyfish', Cubozoa: 'Jellyfish', Hydrozoa: 'Jellyfish', Asteroidea: 'Starfish',
  Arachnida: 'Spider', Clitellata: 'Worm', Echinoidea: 'Sea urchin',
};
const PHYLUM: Record<string, string> = { Mollusca: 'Mollusc', Arthropoda: 'Arthropod', Chordata: 'Fish' }; // chordates with no recognised class here are bony fishes (tetrapod classes are mapped above)
/** Saves the whole photo (no cropping, so the animal is never cut off) and returns its size. */
async function saveImage(url: string, key: number) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const info = await sharp(buf)
    .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 76 })
    .toFile(`public/img/${key}.webp`);
  return { w: info.width, h: info.height };
}

async function commonsThumb(file: string) {
  const info = await getJSON(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=${encodeURIComponent('File:' + file)}&prop=imageinfo&iiprop=extmetadata%7Curl&iiurlwidth=900`,
  );
  const page: any = info && Object.values(info.query.pages)[0];
  return page?.imageinfo?.[0];
}

const clean = (s: string) => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const okLicense = (l: string) => /^(CC0|CC BY(?!-N)(?!.*-ND)|CC BY-SA|Public domain|PD|No restrictions)/i.test(l) && !/NC|ND/i.test(l);

async function build(row: { scientific: string; wikipedia: string; name: string }) {
  const sci = row.scientific;
  const m = await getJSON(`${GBIF}/species/match?kingdom=Animalia&name=${encodeURIComponent(sci)}`);
  if (!m || !m.usageKey || m.matchType === 'NONE') throw new Error('no GBIF match');
  // a name GBIF doesn't know falls back to its genus or family, which would map every relative as this animal
  if (m.matchType === 'HIGHERRANK') throw new Error(`GBIF only matched the ${String(m.rank).toLowerCase()} ${m.canonicalName}`);
  const key: number = m.speciesKey ?? m.usageKey;

  const iucn = await getJSON(`${GBIF}/species/${key}/iucnRedListCategory`);
  const status = IUCN[iucn?.category] ?? 'NE';

  // Wikipedia summary
  const wiki = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(row.wikipedia.replace(/ /g, '_'))}`);
  if (!wiki?.extract) throw new Error('no wikipedia summary');
  // a plain regex split dropped text at decimals ("7.0 oz") and left descriptions starting mid-sentence
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(wiki.extract)].map((x) => x.segment);
  const desc = tidy(sentences.slice(0, 3).join('').trim());

  // Photo with a licence we can redistribute
  let img: string | null = null;
  let imgSize: { w: number; h: number } | null = null;
  let imgSrc: string | null = null;
  let credit: any = null;
  const src: string | undefined = wiki.originalimage?.source;
  const fileMatch = src && src.match(/\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/);
  if (fileMatch) {
    const ii = await commonsThumb(decodeURIComponent(fileMatch[1]));
    const md = ii?.extmetadata;
    const lic = clean(md?.LicenseShortName?.value ?? '');
    if (ii && okLicense(lic)) {
      imgSize = await saveImage(ii.thumburl, key);
      if (imgSize) {
        img = `img/${key}.webp`;
        imgSrc = ii.thumburl;
        credit = {
          author: clean(md?.Artist?.value ?? 'Unknown'),
          license: lic,
          licenseUrl: md?.LicenseUrl?.value ?? null,
          page: ii.descriptionurl,
        };
      }
    }
  }

  const occ = await occurrencePart(key, EXCLUDE[sci], INCLUDE[sci]);

  return {
    id: key,
    sci: m.canonicalName ?? sci,
    name: row.name || (wiki.title as string),
    group: GROUPS[m.class] ?? PHYLUM[m.phylum] ?? m.class ?? 'Animal',
    family: m.family ?? '',
    status,
    desc,
    wiki: wiki.content_urls?.desktop?.page ?? null,
    img,
    imgW: imgSize?.w ?? null,
    imgH: imgSize?.h ?? null,
    imgSrc,
    credit,
    ...occ,
  };
}

const rows = (await readFile(process.env.SPECIES_CSV ?? 'data/species.csv', 'utf8'))
  .trim().split('\n').slice(1).map((l) => {
    // the optional third column is the everyday name, for animals whose Wikipedia article is titled in Latin
    const [scientific, wikipedia, name] = l.split(',').map((x) => (x ?? '').trim());
    return { scientific, wikipedia, name: name ?? '' };
  });

// REUSE_PUBLISHED=1 starts each animal from its record in public/data/species.json when it has no cache file: the text, photo,
// sound and credits are kept and only the counts are rebuilt. Use it in a fresh checkout, where .cache/ is missing and a
// plain run would fetch every animal's photo again.
const published = new Map<string, any>();
if (process.env.REUSE_PUBLISHED) {
  for (const r of JSON.parse(await readFile('public/data/species.json', 'utf8')).species) published.set(r.sci, { ...r, v: 0 });
}

const out: any[] = [];
const failed: string[] = [];
let i = 0;
async function worker() {
  while (i < rows.length) {
    const row = rows[i++];
    const cacheFile = `.cache/${row.scientific.replace(/\W+/g, '_')}.json`;
    try {
      const reuse = published.get(row.scientific);
      if ((await exists(cacheFile)) || reuse) {
        const rec = reuse && !(await exists(cacheFile)) ? reuse : JSON.parse(await readFile(cacheFile, 'utf8'));
        if (rec.img && !rec.imgW) {
          // cached before photos were kept whole: fetch it again from the same Commons file
          let url = rec.imgSrc;
          if (!url) {
            const file = decodeURIComponent(String(rec.credit?.page ?? '').split('/File:')[1] ?? '');
            url = file ? (await commonsThumb(file))?.thumburl : null;
          }
          const size = url ? await saveImage(url, rec.id) : null;
          if (size) {
            Object.assign(rec, { imgW: size.w, imgH: size.h, imgSrc: url });
            await writeFile(cacheFile, JSON.stringify(rec));
            console.log('img ', row.scientific, `${size.w}x${size.h}`);
          } else console.log('img?', row.scientific, 'could not refetch photo');
        }
        if (rec.v !== 3 || String(rec.excludedTaxa ?? []) !== String(EXCLUDE[row.scientific] ?? []) || String(rec.includedTaxa ?? []) !== String(INCLUDE[row.scientific] ?? [])) {
          // cached before the records were counted (or with other subspecies in or out): rebuild the range part only
          Object.assign(rec, await occurrencePart(rec.id, EXCLUDE[row.scientific], INCLUDE[row.scientific]));
          delete rec.sampled; // the old sample size; everything is counted now
          await writeFile(cacheFile, JSON.stringify(rec));
          console.log('occ ', row.scientific, `${rec.occurrences} wild, ${rec.captiveExcluded} captive left out${rec.binned ? `, counted by area` : ''}`);
        }
        // animals read record by record keep their records in the cache, so their states are placed again here, offline
        if (!rec.binned && rec.points?.length) rec.states = await assignStates(rec.points, rec.iso);
        if (row.name) rec.name = row.name;
        out.push(rec);
        continue;
      }
      const rec = await build(row);
      await writeFile(cacheFile, JSON.stringify(rec));
      out.push(rec);
      console.log('ok  ', row.scientific, rec.status, rec.img ? '' : '(no free photo)');
    } catch (e: any) {
      failed.push(`${row.scientific}: ${e.message}`);
      console.log('skip', row.scientific, '-', e.message);
    }
  }
}
await Promise.all(Array.from({ length: Number(process.env.WORKERS ?? 6) }, worker));

// cached records may predate newer group mappings
for (const s of out) s.group = GROUPS[s.group] ?? (s.group === 'Animal' ? 'Fish' : s.group);
for (const s of out) s.status = STATUS_OVERRIDE[s.sci] ?? s.status;

// Continents. Natural Earth files all of Russia under Europe, so Russian records are split at the Urals (60°E):
// a Siberian tiger is in Asia. Each side counts if it holds at least 1.5% of the records, like a country does.
const continentOf = new Map<string, string>(countries.features.map((f: any) => [f.properties.iso, f.properties.continent]));
for (const s of out) {
  const set = new Set<string>(s.iso.filter((c: string) => c !== 'RU').map((c: string) => continentOf.get(c)!));
  if (s.iso.includes('RU')) {
    const { total, west } = s.ru;
    if (west / s.occurrences >= 0.015) set.add('Europe');
    if ((total - west) / s.occurrences >= 0.015) set.add('Asia');
    if (!total) set.add('Europe'); // no Russian records to place it: keep what the country file says
  }
  const dropped = continentFixes.get(s.sci) ?? [];
  for (const c of dropped) set.delete(c);
  s.continents = [...set];
  if (dropped.length) {
    // a continent dropped by hand takes its countries and states with it, so a zoo in Germany doesn't list Germany as
    // the giant panda's range (Russia stays while either of its sides does)
    const keep = (iso: string) => (iso === 'RU' ? set.has('Europe') || set.has('Asia') : set.has(continentOf.get(iso)!));
    s.countries = s.countries.filter((c: any) => keep(c.iso));
    s.iso = s.iso.filter(keep);
    s.states = s.states.filter((x: any) => keep(x.iso));
  }
}

// Individual wild records for the "Points" view. Locations are rounded: ~1 km normally, ~11 km for critically
// endangered and endangered animals, so the map never pinpoints where a threatened animal can be found. 'VAR' (the
// Galápagos tortoises) counts: most of its species are critically endangered or endangered.
// The white rhino and Indian rhino (horn) and the ground pangolin (scales) are not listed as endangered but are poached hard, so they
// are rounded like the threatened animals. Animals counted by area are already shown as squares about 0.7° (75 km) across.
const SENSITIVE = new Set(['CR', 'EN', 'EW', 'VAR']);
const POACHED = new Set(['Ceratotherium simum', 'Rhinoceros unicornis', 'Smutsia temminckii']);
for (const s of out) {
  const step = SENSITIVE.has(s.status) || POACHED.has(s.sci) ? 10 : 100; // 0.1° or 0.01°
  const seen = new Set<string>();
  const pts: number[][] = [];
  for (const [lat, lng] of s.points as Pt[]) {
    const p = s.binned ? [lat, lng] : [Math.round(lat * step) / step, Math.round(lng * step) / step];
    const k = p.join();
    if (seen.has(k)) continue; // rounding merges repeat sightings at the same spot
    seen.add(k);
    pts.push(p);
  }
  s.pointsRounding = s.binned ?? (step === 10 ? 0.1 : 0.01);
  await writeFile(`public/data/points/${s.id}.json`, JSON.stringify(pts));
}
out.sort((a, b) => a.name.localeCompare(b.name));
out.forEach((s, n) => (s.no = String(n + 1).padStart(3, '0')));
// a dataset title like "aguas someras (<50m)" would trip the check for HTML in the text: show the same signs safely
for (const s of out) for (const d of s.datasets) d.title = d.title.replace(/</g, '＜').replace(/>/g, '＞');
const shipped = out.map(({ points, imgSrc, excludedTaxa, includedTaxa, ru, ...rest }) => rest);
await writeFile('public/data/species.json', JSON.stringify({ generated: new Date().toISOString(), species: shipped }));
console.log(`\n${out.length} species written, ${failed.length} skipped`);
await writeFile('.cache/_failed.txt', failed.join('\n')); // empty when nothing was skipped
