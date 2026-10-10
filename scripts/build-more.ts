// Writes public/data/more/<gbif key>.json: the longer text behind each animal's "Read more". It comes from the animal's
// own Wikipedia article (CC BY-SA 4.0, credited on the page): the rest of the introduction, then a few sentences each from
// the sections on what it looks like, how it behaves, what it eats, where it lives and how it breeds. Nothing is
// paraphrased or added; whole sentences are cut from the article, so a wrong sentence there is wrong here too.
// Also tidies the short description in species.json (see lib/text.ts). Needs the network; pages are cached in
// .cache/wiki-full/, so a rerun only fetches animals that are new. `npm run more` runs it.
import { readFile, writeFile, mkdir, access, readdir, unlink } from 'node:fs/promises';
import type { Species } from '../src/types';
import { sentencesOf, takeSentences, tidy, wholeSentence } from './lib/text';

const UA = 'animal-range-finder/0.1 (static data build; https://github.com/joealfonso/animal-range-finder)';
const PUB = 'public';
const LEAD_MAX = 800; // characters of introduction after the short description
const SECTION_MAX = 480; // characters per section
const TOTAL_MAX = 2600;

await mkdir('.cache/wiki-full', { recursive: true });
await mkdir(`${PUB}/data/more`, { recursive: true });
const exists = (p: string) => access(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function article(title: string): Promise<string> {
  const cache = `.cache/wiki-full/${title.replace(/[^\w-]/g, '_')}.txt`;
  if (await exists(cache)) return readFile(cache, 'utf8');
  for (let i = 0; i < 8; i++) {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(title)}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) },
    ).catch(() => null);
    if (res?.ok) {
      const j: any = await res.json();
      const text = (Object.values(j.query.pages)[0] as any)?.extract;
      if (typeof text !== 'string') throw new Error('no article text');
      await writeFile(cache, text);
      await sleep(400);
      return text;
    }
    if (res && res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
    await sleep(Math.max(Number(res?.headers.get('retry-after') ?? 0) * 1000, 4000 * 2 ** i));
  }
  throw new Error('Wikipedia rate limited');
}

type Sec = { level: number; h: string; body: string };
/** Splits "lead\n\n\n== Heading ==\nbody ..." into the lead and its headed sections. */
function split(text: string) {
  const parts = text.split(/\n*(={2,5})\s*([^=\n]+?)\s*\1\s*\n/);
  const lead = parts[0].trim();
  const secs: Sec[] = [];
  for (let i = 1; i < parts.length; i += 3) secs.push({ level: parts[i].length, h: parts[i + 1].trim(), body: (parts[i + 2] ?? '').trim() });
  return { lead, secs };
}

// what the page gets, in this order: the first heading in the article that matches
const WANTED: [string, RegExp][] = [
  ['Appearance', /^(description|appearance|characteristics|physical (description|characteristics)|anatomy( and (morphology|physiology))?|morphology|physiology|size|body|plumage|morphology and anatomy)$/i],
  ['Behaviour', /^(behaviou?r|behaviou?r and ecology|ecology( and behaviou?r)?|social (behaviou?r|structure|organi[sz]ation)|behavio(u)?ral ecology|vocali[sz]ations?|communication|movement|locomotion|activity)$/i],
  ['Diet', /^(diet|feeding|food|diet and feeding|feeding (ecology|habits|behaviou?r)|foraging|diet and hunting|hunting)$/i],
  ['Habitat', /^(habitat|habitat and distribution|distribution and habitat|distribution and ecology|ecology and distribution|geographic range|range|distribution|habitat and ecology)$/i],
  ['Life cycle', /^(reproduction|life ?cycle|breeding|life history|reproduction and (life cycle|development)|reproduction and life history|mating|development|reproduction and lifespan)$/i],
];

/** A section's own words; a heading with only subsections speaks through its first subsection. */
function textOf(secs: Sec[], i: number) {
  let body = secs[i].body;
  for (let j = i + 1; !body && j < secs.length && secs[j].level > secs[i].level; j++) body = secs[j].body;
  return body;
}

// Plain-text extracts flatten lists and spec boxes into bare lines ("Weight: 25 g", a run of species names), so only
// lines that read as prose are kept: a full stop at the end, some length, and no "Label: value" fields.
const prose = (l: string) => l.length > 40 && /[.!?]["”)]?$/.test(l) && !/\b(Length|Weight|Mass|Height|Wingspan|Size|Range|Habitat|Diet|Status):\s/.test(l);
const clean = (t: string) => tidy(t.split('\n').map((l) => l.trim()).filter((l) => !/^(\*|\||\{|=)/.test(l) && prose(l)).join(' '));

const data = JSON.parse(await readFile(`${PUB}/data/species.json`, 'utf8')) as { generated: string; species: Species[] };
const wanted = new Set<string>();
const failed: string[] = [];
let fewer = 0;
for (const s of data.species) {
  s.desc = tidy(s.desc);
  delete s.more;
  try {
    const title = decodeURIComponent(s.wiki!.split('/wiki/')[1]);
    const { lead, secs } = split(await article(title));
    const shown = sentencesOf(s.desc).length;
    // the introduction minus what the short description already shows
    const rest = sentencesOf(clean(lead)).slice(shown).join(' ');
    const intro = takeSentences(rest, LEAD_MAX, 0);
    const sections: { h: string; t: string }[] = [];
    let total = intro.length;
    for (const [h, re] of WANTED) {
      const i = secs.findIndex((x) => re.test(x.h) && textOf(secs, secs.indexOf(x)));
      if (i < 0) continue;
      const t = takeSentences(clean(textOf(secs, i)), SECTION_MAX, 1);
      const ok = sentencesOf(t).every(wholeSentence);
      if (!t || !ok || total + t.length > TOTAL_MAX) continue;
      sections.push({ h, t });
      total += t.length;
    }
    if (!intro && !sections.length) {
      fewer++;
      continue; // a short article: nothing more worth showing
    }
    await writeFile(`${PUB}/data/more/${s.id}.json`, JSON.stringify({ intro: intro || undefined, sections }));
    wanted.add(`${s.id}.json`);
    s.more = true;
  } catch (e: any) {
    failed.push(`${s.sci}: ${e.message}`);
    console.log('skip', s.sci, '-', e.message);
  }
}
for (const f of await readdir(`${PUB}/data/more`)) if (!wanted.has(f)) await unlink(`${PUB}/data/more/${f}`);
await writeFile(`${PUB}/data/species.json`, JSON.stringify(data));
console.log(`${wanted.size} animals have more text, ${fewer} have nothing beyond the short description, ${failed.length} failed`);
