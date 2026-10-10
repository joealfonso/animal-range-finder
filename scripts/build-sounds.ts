// Adds a short recording of each animal's call to public/data/species.json and writes public/sound/<gbif key>.mp3.
// The recordings are picked by hand in data/sounds.csv (scientific name, source, label), because a search for "tiger"
// on Commons finds jazz and court arguments long before it finds a tiger. The source is a Wikimedia Commons file name
// or an iNaturalist observation URL (its first freely licensed recording is used). Each file is kept only if
// its licence is CC0, CC BY, CC BY-SA or public domain, like the photos. The loudest stretch of up to 12 seconds is cut
// out, faded and levelled, so a long field recording plays the call itself and every animal plays at the same volume.
// Each source is checked against the animal before it is kept: an iNaturalist observation must be research grade and
// identified as this species, and a Commons file must name the animal (or its genus or common name) in its title,
// description or categories. A name can still sit on the wrong sound, so the labels are not proof, but a clip of another
// animal (the magpie's was a black woodpecker) or of an unconfirmed identification no longer gets through.
// Runs after build-data in `npm run data`. Needs ffmpeg on the PATH (brew install ffmpeg). Finished clips are cached
// in .cache/sounds/, so a rerun only fetches rows that are new or point at a different file.
import { readFile, writeFile, mkdir, access, readdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Species, Sound } from '../src/types';

const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';
const PUB = 'public';
const CLIP = 12; // seconds, at most
const RATE = 8000; // samples per second when measuring loudness

await mkdir('.cache/sounds/raw', { recursive: true });
await mkdir(`${PUB}/sound`, { recursive: true });
const exists = (p: string) => access(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Commons rate-limits file downloads hard (429), so back off and honour Retry-After. */
async function download(url: string) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) }).catch(() => null);
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
    if (res && res.status !== 429 && res.status < 500) throw new Error(`download failed (${res.status})`);
    await sleep(Math.max(Number(res?.headers.get('retry-after') ?? 0) * 1000, 5000 * 2 ** i));
  }
  throw new Error('download failed (rate limited)');
}
const clean = (s: string) => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const okLicense = (l: string) => /^(CC0|CC BY(?!-N)(?!.*-ND)|CC BY-SA|Public domain|PD|No restrictions)/i.test(l) && !/NC|ND/i.test(l);

/** Runs ffmpeg and returns what it writes to stdout. */
function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`ffmpeg could not start (${e.message}); install it with: brew install ffmpeg`)));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim().slice(0, 300)}`))));
  });
}

/** Where the loudest CLIP seconds start, and how long the recording is. Loudness is measured above 250 Hz, so wind and
 * handling rumble in a field recording do not outweigh the call. */
async function loudest(file: string) {
  const pcm = await ffmpeg(['-i', file, '-af', 'highpass=f=250', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-']);
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const dur = x.length / RATE;
  if (dur <= CLIP) return { start: 0, dur };
  const step = RATE / 4; // quarter-second blocks
  const energy: number[] = [];
  for (let i = 0; i + step <= x.length; i += step) {
    let e = 0;
    for (let j = i; j < i + step; j++) e += x[j] * x[j];
    energy.push(e);
  }
  const span = CLIP * 4;
  let sum = energy.slice(0, span).reduce((a, b) => a + b, 0);
  let best = sum;
  let at = 0;
  for (let i = span; i < energy.length; i++) {
    sum += energy[i] - energy[i - span];
    if (sum > best) (best = sum), (at = i - span + 1);
  }
  return { start: at / 4, dur };
}

type Source = { url: string; ext: string; credit: Sound['credit']; about: string };

/** A Wikimedia Commons file, by its name. */
async function fromCommons(file: string): Promise<Source> {
  const info = await fetch(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=extmetadata%7Curl&titles=${encodeURIComponent('File:' + file)}`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) },
  ).then((r) => r.json());
  const ii: any = (Object.values(info?.query?.pages ?? {})[0] as any)?.imageinfo?.[0];
  if (!ii) throw new Error(`no Commons file "${file}"`);
  const md = ii.extmetadata;
  return {
    url: ii.url,
    ext: file.slice(file.lastIndexOf('.')),
    about: `${file} ${clean(md?.ImageDescription?.value ?? '')} ${clean(md?.Categories?.value ?? '')} ${clean(md?.ObjectName?.value ?? '')}`,
    credit: {
      author: clean(md?.Artist?.value ?? '') || 'Unknown',
      license: clean(md?.LicenseShortName?.value ?? ''),
      licenseUrl: md?.LicenseUrl?.value ?? null,
      page: ii.descriptionurl,
    },
  };
}

// iNaturalist licence codes; its current licences are the 4.0 versions
const INAT: Record<string, [string, string]> = {
  cc0: ['CC0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  'cc-by': ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  'cc-by-sa': ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
};

/** The first freely licensed recording on an iNaturalist observation, by the observation's URL. */
async function fromINat(url: string): Promise<Source> {
  const obsId = url.match(/observations\/(\d+)/)?.[1];
  if (!obsId) throw new Error(`not an iNaturalist observation: ${url}`);
  const r = await fetch(`https://api.inaturalist.org/v1/observations/${obsId}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(25000),
  }).then((res) => res.json());
  const o = r?.results?.[0];
  if (o?.quality_grade !== 'research') throw new Error(`observation ${obsId} is "${o?.quality_grade}", not research grade`);
  const snd = o?.sounds?.find((x: any) => INAT[x.license_code] && x.file_url);
  if (!snd) throw new Error(`observation ${obsId} has no recording we can redistribute`);
  const file = String(snd.file_url).split('?')[0];
  const [license, licenseUrl] = INAT[snd.license_code];
  return {
    url: snd.file_url,
    ext: file.slice(file.lastIndexOf('.')),
    about: o.taxon?.name ?? '',
    credit: { author: clean(o.user?.name || o.user?.login || '') || 'Unknown', license, licenseUrl, page: `https://www.inaturalist.org/observations/${obsId}` },
  };
}

/** Checked by hand: the file names the animal in a way the check cannot read (a Dutch word, a synonym). */
const NAME_OK = new Set(['Phoca vitulina', 'Dryophytes cinereus']);

function checkAbout(sci: string, name: string, about: string, inat: boolean) {
  if (inat) {
    if (!about.toLowerCase().startsWith(sci.toLowerCase())) throw new Error(`the observation is identified as "${about}", not ${sci}`);
    return;
  }
  const hay = about.toLowerCase();
  const words = [sci.toLowerCase(), sci.split(' ')[0].toLowerCase(), ...name.toLowerCase().split(/[\s-]+/).filter((w) => w.length > 3)];
  if (!words.some((w) => hay.includes(w)) && !NAME_OK.has(sci)) throw new Error('the file does not mention this animal; check it, then add it to NAME_OK');
  if (/pronunciation|spoken|read aloud|lingua libre/.test(hay)) throw new Error('the file is a spoken word, not the animal');
}

async function build(sci: string, name: string, file: string, id: number): Promise<Omit<Sound, 'label'>> {
  const inat = /^https?:\/\/(www\.)?inaturalist\.org\//.test(file);
  const src = inat ? await fromINat(file) : await fromCommons(file);
  checkAbout(sci, name, src.about, inat);
  if (!okLicense(src.credit.license)) throw new Error(`licence "${src.credit.license}" is not one we can redistribute`);

  const raw = `.cache/sounds/raw/${id}${src.ext}`;
  if (!(await exists(raw))) {
    await writeFile(raw, await download(src.url));
    await sleep(1500);
  }
  const { start, dur } = await loudest(raw);
  const len = Math.min(CLIP, dur - start);
  const fade = Math.min(0.8, len / 4);
  await ffmpeg([
    '-y', '-ss', String(start), '-t', String(len), '-i', raw,
    '-af', `afade=t=in:d=0.05,afade=t=out:st=${(len - fade).toFixed(2)}:d=${fade.toFixed(2)},loudnorm=I=-18:TP=-1.5`,
    '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '80k', `${PUB}/sound/${id}.mp3`,
  ]);
  console.log('ok  ', sci, `${len.toFixed(1)}s from ${start.toFixed(1)}s of ${dur.toFixed(1)}s`);
  return { src: `sound/${id}.mp3`, dur: Math.round(len * 10) / 10, credit: src.credit };
}

// a quoted field may hold commas: Commons file names often do
const parse = (l: string) => [...l.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].slice(0, 3).map((m) => (m[2] ?? m[1]).trim());
const rows = (await readFile('data/sounds.csv', 'utf8'))
  .trim().split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('#'))
  .map(parse);

const data = JSON.parse(await readFile(`${PUB}/data/species.json`, 'utf8')) as { generated: string; species: Species[] };
const bySci = new Map(data.species.map((s) => [s.sci, s]));
const kept = new Set<string>();
const failed: string[] = [];
// a sound whose row was removed (or whose source fails the checks) must not stay on the animal
for (const s of data.species) delete s.sound;
for (const [sci, file, label] of rows) {
  const s = bySci.get(sci);
  if (!s) {
    failed.push(`${sci}: not in species.json`);
    continue;
  }
  const cacheFile = `.cache/sounds/${s.id}.json`;
  try {
    let rec = (await exists(cacheFile)) ? JSON.parse(await readFile(cacheFile, 'utf8')) : null;
    if (!rec || rec.file !== file || !(await exists(`${PUB}/sound/${s.id}.mp3`))) {
      rec = { file, ...(await build(sci, s.name, file, s.id)) };
      await writeFile(cacheFile, JSON.stringify(rec));
    }
    const { file: _, ...sound } = rec;
    s.sound = { ...sound, label: label || 'call' };
    kept.add(`${s.id}.mp3`);
  } catch (e: any) {
    failed.push(`${sci}: ${e.message}`);
    console.log('skip', sci, '-', e.message);
    kept.add(`${s.id}.mp3`); // a failed fetch keeps its old file for the next run; the animal has no sound until it passes
  }
}

// a clip whose row was removed would otherwise ship unused
for (const f of await readdir(`${PUB}/sound`)) if (!kept.has(f)) await unlink(`${PUB}/sound/${f}`);
await writeFile(`${PUB}/data/species.json`, JSON.stringify(data));
console.log(`\n${kept.size} sounds written, ${failed.length} skipped`);
await writeFile('.cache/_failed_sounds.txt', failed.join('\n'));
