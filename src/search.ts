import Fuse from 'fuse.js';
import type { Species } from './types';

export interface Filters {
  continent: string | null;
  status: string | null;
  country: string | null;
  /** state/province id, only meaningful together with country */
  state: string | null;
}

interface Doc {
  s: Species;
  countryNames: string[];
  stateNames: string[];
}

export function createSearch(species: Species[], isoName: (iso: string) => string) {
  const docs: Doc[] = species.map((s) => ({ s, countryNames: s.iso.map(isoName), stateNames: (s.states ?? []).map((x) => x.name) }));
  const fuse = new Fuse(docs, {
    keys: [
      { name: 's.name', weight: 3 },
      { name: 's.sci', weight: 2.2 },
      { name: 'countryNames', weight: 1.2 },
      { name: 'stateNames', weight: 0.9 },
      { name: 's.family', weight: 0.6 },
      { name: 's.group', weight: 0.6 },
      { name: 's.continents', weight: 0.5 },
    ],
    threshold: 0.2,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  return function run(q: string, f: Filters): Species[] {
    const text = q.trim();
    let list = text ? fuse.search(text).map((r) => r.item.s) : species;
    if (f.continent) list = list.filter((s) => s.continents.includes(f.continent!));
    if (f.status) list = list.filter((s) => s.status === f.status);
    if (f.country) list = list.filter((s) => s.iso.includes(f.country!) || (s.states ?? []).some((x) => x.iso === f.country));
    if (f.state) list = list.filter((s) => (s.states ?? []).some((x) => x.id === f.state));
    return list;
  };
}
