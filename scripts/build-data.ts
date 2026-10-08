// Data pipeline: data/species.csv -> public/data/species.json + public/data/range/<id>.json + public/img/<id>.webp
// Needs public/data/countries.json and public/data/states/ first (npm run assets).
// Sources: GBIF (taxonomy, IUCN category, occurrences), Wikipedia (summary), Wikimedia Commons (image + licence).
// To add species: append a row to data/species.csv and run `npm run data`. Finished species are cached in .cache/.
// No API keys are needed. If one is ever added, read it from process.env and document it in .env.example.
import sharp from 'sharp';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';

const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';
const GBIF = 'https://api.gbif.org/v1';
const CELL = 2; // degrees per density cell
const PAGE = 300;
const MAX_PAGES = 4;

await mkdir('.cache', { recursive: true });
await mkdir('public/img', { recursive: true });
await mkdir('public/data/range', { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    if (process.env.DEBUG) console.log(new Date().toISOString().slice(17, 23), 'GET', url.slice(0, 120));
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }).catch(() => null);
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

const occBase = (key: number) =>
  `${GBIF}/occurrence/search?taxonKey=${key}&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT&basisOfRecord=HUMAN_OBSERVATION&basisOfRecord=OBSERVATION&basisOfRecord=MACHINE_OBSERVATION&basisOfRecord=PRESERVED_SPECIMEN`;

type Pt = [number, number, string | null]; // lat, lng, ISO country code

// Zoo, farm and released animals. GBIF flags many of them (degreeOfEstablishment); they are left out of every count.
const CAPTIVE = new Set(['captive', 'managed', 'cultivated', 'released']);
const isCaptive = (o: any) => CAPTIVE.has(String(o.degreeOfEstablishment ?? '').toLowerCase()) || o.establishmentMeans === 'MANAGED';

/** A spread-out sample of wild, georeferenced records, plus which datasets they came from (for citation). */
async function samplePoints(key: number, total: number) {
  const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE));
  const stride = Math.max(PAGE, Math.floor((Math.min(total, 8000) - PAGE) / Math.max(1, pages - 1))); // deep offsets are very slow on GBIF
  const pts: Pt[] = [];
  const datasets = new Map<string, number>();
  for (let p = 0; p < pages; p++) {
    const r = await getJSON(`${occBase(key)}&limit=${PAGE}&offset=${p * stride}`).catch(() => null);
    for (const o of r?.results ?? []) {
      if (typeof o.decimalLatitude !== 'number' || typeof o.decimalLongitude !== 'number' || isCaptive(o)) continue;
      pts.push([Math.round(o.decimalLatitude * 1000) / 1000, Math.round(o.decimalLongitude * 1000) / 1000, o.countryCode ?? null]);
      if (o.datasetKey) datasets.set(o.datasetKey, (datasets.get(o.datasetKey) ?? 0) + 1);
    }
  }
  return { pts, datasets };
}

/** Everything the range depends on: counts with captive records removed, the sample, countries and citations. */
async function occurrencePart(key: number) {
  const head = await getJSON(`${occBase(key)}&limit=0&facet=country&facetLimit=60`);
  const all: number = head?.count ?? 0;
  const cap = await getJSON(`${occBase(key)}&degreeOfEstablishment=captive&degreeOfEstablishment=managed&limit=0&facet=country&facetLimit=60`);
  const captive: number = cap?.count ?? 0;
  const total = all - captive;
  if (total < 20) throw new Error(`only ${total} wild occurrences`);
  const capBy = new Map<string, number>((cap?.facets?.[0]?.counts ?? []).map((c: any) => [c.name, c.count]));
  const byCountry = (head.facets?.[0]?.counts ?? [])
    .map((c: any) => ({ name: c.name as string, count: c.count - (capBy.get(c.name) ?? 0) }))
    .filter((c: any) => c.count > 0)
    .sort((a: any, b: any) => b.count - a.count);

  const { pts, datasets: dsCounts } = await samplePoints(key, all);
  if (pts.length < 10) throw new Error('too few wild records in sample');
  await writeCells(key, pts);

  // Countries with at least 1.5% of wild records (kills stray/outlier noise), capped.
  const cc = byCountry.filter((c: any) => c.count / total >= 0.015 && isoInfo.has(c.name)).slice(0, 14);
  if (!cc.length) throw new Error('no countries');
  const iso = cc.map((c: any) => c.name);

  const datasets = [];
  for (const [dk] of [...dsCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const ds = await getJSON(`${GBIF}/dataset/${dk}`);
    if (ds) datasets.push({ title: ds.title, doi: ds.doi ?? null, license: String(ds.license ?? '').replace(/^.*licenses\/(.*?)\/.*$/, (_: string, l: string) => l.toUpperCase()) });
  }

  return {
    v: 2,
    iso,
    countries: cc.map((c: any) => ({ iso: c.name, share: Math.round((c.count / total) * 1000) / 1000 })),
    continents: [...new Set(iso.map((c: string) => isoInfo.get(c)!.continent))],
    occurrences: total,
    captiveExcluded: captive,
    sampled: pts.length,
    datasets,
    points: pts, // cache only, stripped from the published JSON
  };
}

/** Bins the sample into 2° cells for the range layer. */
async function writeCells(key: number, pts: Pt[]) {
  const cells = new Map<string, number>();
  for (const [lat, lng] of pts) {
    const la = Math.floor(lat / CELL) * CELL + CELL / 2;
    const lo = Math.floor(lng / CELL) * CELL + CELL / 2;
    cells.set(`${la},${lo}`, (cells.get(`${la},${lo}`) ?? 0) + 1);
  }
  const minCount = pts.length > 400 ? 2 : 1; // drop lone outliers when we have enough data
  let max = 0;
  for (const v of cells.values()) max = Math.max(max, v);
  const rangeCells = [...cells.entries()]
    .filter(([, v]) => v >= minCount)
    .map(([k, v]) => {
      const [la, lo] = k.split(',').map(Number);
      return [la, lo, Math.round(Math.sqrt(v / max) * 100) / 100];
    });
  await writeFile(`public/data/range/${key}.json`, JSON.stringify(rangeCells));
}

// ---- states: which admin-1 regions each sampled record falls in (point in polygon, Natural Earth borders)
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

/** States only count inside the animal's range countries, so zoo and stray records don't put pandas in Berlin. */
async function assignStates(pts: Pt[], rangeIso: string[]) {
  const allowed = new Set(rangeIso);
  const counts = new Map<string, { s: StateShape; n: number }>();
  for (const [lat, lng, cc] of pts) {
    if (!cc || !allowed.has(cc)) continue;
    for (const st of await statesOf(cc)) {
      const [x0, y0, x1, y1] = st.box;
      if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
      if (inPolys(lng, lat, st.polys)) {
        const hit = counts.get(st.id) ?? { s: st, n: 0 };
        hit.n++;
        counts.set(st.id, hit);
        break;
      }
    }
  }
  const minCount = pts.length > 400 ? 2 : 1; // one stray record is not enough to list a state
  return [...counts.values()]
    .filter((c) => c.n >= minCount)
    .sort((a, b) => b.n - a.n)
    .map((c) => ({ id: c.s.id, name: c.s.name, iso: c.s.iso, share: Math.round((c.n / pts.length) * 1000) / 1000 }));
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

async function build(row: { scientific: string; wikipedia: string }) {
  const sci = row.scientific;
  const m = await getJSON(`${GBIF}/species/match?kingdom=Animalia&name=${encodeURIComponent(sci)}`);
  if (!m || !m.usageKey || m.matchType === 'NONE') throw new Error('no GBIF match');
  const key: number = m.speciesKey ?? m.usageKey;

  const iucn = await getJSON(`${GBIF}/species/${key}/iucnRedListCategory`);
  const status = IUCN[iucn?.category] ?? 'NE';

  // Wikipedia summary
  const wiki = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(row.wikipedia.replace(/ /g, '_'))}`);
  if (!wiki?.extract) throw new Error('no wikipedia summary');
  const sentences = wiki.extract.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [wiki.extract];
  const desc = sentences.slice(0, 3).join('').trim();

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

  const occ = await occurrencePart(key);

  return {
    id: key,
    sci: m.canonicalName ?? sci,
    name: wiki.title as string,
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
    const [scientific, ...w] = l.split(',');
    return { scientific: scientific.trim(), wikipedia: w.join(',').trim() };
  });

const out: any[] = [];
const failed: string[] = [];
let i = 0;
async function worker() {
  while (i < rows.length) {
    const row = rows[i++];
    const cacheFile = `.cache/${row.scientific.replace(/\W+/g, '_')}.json`;
    try {
      if (await exists(cacheFile)) {
        const rec = JSON.parse(await readFile(cacheFile, 'utf8'));
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
        if (rec.v !== 2) {
          // cached before captive records were filtered out: rebuild the range part only
          Object.assign(rec, await occurrencePart(rec.id));
          await writeFile(cacheFile, JSON.stringify(rec));
          console.log('occ ', row.scientific, `${rec.occurrences} wild, ${rec.captiveExcluded} captive left out`);
        }
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
await Promise.all(Array.from({ length: 6 }, worker));

// cached records may predate newer group mappings
for (const s of out) s.group = GROUPS[s.group] ?? (s.group === 'Animal' ? 'Fish' : s.group);
for (const s of out) s.states = await assignStates(s.points, s.iso);
out.sort((a, b) => a.name.localeCompare(b.name));
out.forEach((s, n) => (s.no = String(n + 1).padStart(3, '0')));
const published = out.map(({ points, imgSrc, ...rest }) => rest);
await writeFile('public/data/species.json', JSON.stringify({ generated: new Date().toISOString(), species: published }));
console.log(`\n${out.length} species written, ${failed.length} skipped`);
await writeFile('.cache/_failed.txt', failed.join('\n')); // empty when nothing was skipped
