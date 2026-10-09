import type { Species } from './types';

const slugify = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Each animal's page name, /animal/<slug>/: its common name, or the Latin name when two animals share one. Used by the app and by scripts/build-seo.ts so both agree. */
export function makeSlugs(species: Species[]): Map<number, string> {
  const slugs = new Map<number, string>();
  const taken = new Set<string>();
  for (const s of species) {
    let slug = slugify(s.name) || slugify(s.sci);
    if (taken.has(slug)) slug = slugify(`${s.name} ${s.sci}`);
    if (taken.has(slug)) slug = `${slug}-${s.id}`;
    taken.add(slug);
    slugs.set(s.id, slug);
  }
  return slugs;
}

/** One animal for each calendar day (UTC), the same for everyone, cycling through the whole catalogue before it repeats. */
export function animalOfTheDay(species: Species[], now = new Date()): Species {
  const day = Math.floor(now.getTime() / 86_400_000);
  const order = [...species].sort((a, b) => hash(a.id) - hash(b.id) || a.id - b.id);
  return order[day % order.length];
}

function hash(n: number) {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
