import Fuse from 'fuse.js';
import type { Species } from './types';

export interface Filters {
  continent: string | null;
  status: string | null;
  country: string | null;
  /** state/province id, only meaningful together with country */
  state: string | null;
}

/**
 * Everyday words for each family, so "pig" finds the wild boar and "cat" finds the tiger. Words that are already in
 * every animal's name (bear, penguin, deer...) are left out. A new animal picks these up from its family.
 */
const KINDS: Record<string, string[]> = {
  // mammals
  Felidae: ['cat', 'big cat', 'wild cat'],
  Canidae: ['dog', 'canine'],
  Suidae: ['pig', 'hog', 'swine', 'hoofed'],
  Hominidae: ['ape', 'great ape', 'primate'],
  Hylobatidae: ['ape', 'primate'],
  Cercopithecidae: ['monkey', 'primate'],
  Atelidae: ['monkey', 'primate'],
  Lemuridae: ['lemur', 'primate'],
  Indriidae: ['lemur', 'primate'],
  Daubentoniidae: ['lemur', 'primate'],
  Ursidae: ['bear'],
  Bovidae: ['bovid', 'hoofed'],
  Cervidae: ['deer', 'hoofed'],
  Antilocapridae: ['antelope', 'hoofed'],
  Equidae: ['horse', 'hoofed'],
  Camelidae: ['camel', 'hoofed'],
  Giraffidae: ['giraffe', 'hoofed'],
  Rhinocerotidae: ['rhino', 'hoofed'],
  Hippopotamidae: ['hippo', 'hoofed'],
  Tapiridae: ['hoofed'],
  Elephantidae: ['elephant'],
  Mustelidae: ['weasel', 'mustelid'],
  Procyonidae: ['raccoon'],
  Herpestidae: ['mongoose'],
  Hyaenidae: ['hyena'],
  Macropodidae: ['kangaroo', 'marsupial'],
  Phascolarctidae: ['marsupial'],
  Vombatidae: ['marsupial'],
  Dasyuridae: ['marsupial'],
  Didelphidae: ['marsupial'],
  Ornithorhynchidae: ['monotreme'],
  Tachyglossidae: ['monotreme'],
  Delphinidae: ['dolphin', 'whale', 'cetacean'],
  Balaenopteridae: ['whale', 'cetacean'],
  Physeteridae: ['whale', 'cetacean'],
  Monodontidae: ['whale', 'cetacean'],
  Phocidae: ['seal', 'pinniped'],
  Otariidae: ['seal', 'pinniped'],
  Odobenidae: ['seal', 'pinniped'],
  Trichechidae: ['sea cow'],
  Dugongidae: ['sea cow'],
  Pteropodidae: ['bat'],
  Caviidae: ['rodent'],
  Castoridae: ['rodent'],
  Erethizontidae: ['rodent'],
  // birds
  Accipitridae: ['bird of prey', 'raptor'],
  Falconidae: ['bird of prey', 'raptor'],
  Cathartidae: ['vulture', 'bird of prey', 'raptor'],
  Strigidae: ['owl', 'bird of prey'],
  Tytonidae: ['owl', 'bird of prey'],
  Psittacidae: ['parrot'],
  Anatidae: ['waterfowl'],
  Struthionidae: ['flightless bird', 'ratite'],
  Dromaiidae: ['flightless bird', 'ratite'],
  Casuariidae: ['flightless bird', 'ratite'],
  Apterygidae: ['flightless bird', 'ratite'],
  Spheniscidae: ['flightless bird'],
  Trochilidae: ['hummingbird'],
  Corvidae: ['crow'],
  Columbidae: ['pigeon', 'dove'],
  Laridae: ['gull', 'seagull'],
  Picidae: ['woodpecker'],
  Psittaculidae: ['parrot'],
  Cacatuidae: ['parrot', 'cockatoo'],
  Alcedinidae: ['kingfisher'],
  // reptiles, amphibians
  Pythonidae: ['snake'],
  Boidae: ['snake'],
  Elapidae: ['snake'],
  Viperidae: ['snake', 'viper'],
  Crocodylidae: ['crocodile', 'crocodilian'],
  Alligatoridae: ['crocodilian'],
  Gavialidae: ['crocodile', 'crocodilian'],
  Testudinidae: ['turtle'],
  Iguanidae: ['lizard'],
  Chamaeleonidae: ['lizard'],
  Varanidae: ['lizard', 'monitor'],
  Ambystomatidae: ['salamander'],
  Dendrobatidae: ['frog'],
  // fish and the rest
  Lamnidae: ['shark'],
  Rhincodontidae: ['shark'],
  Sphyrnidae: ['shark'],
  Myliobatidae: ['ray'],
  Scombridae: ['tuna'],
  Coenobitidae: ['crab'],
  Apidae: ['bee'],
  Nymphalidae: ['butterfly'],
  // jellyfish and starfish: the man o' war and sea stars don't say so in their names
  Physaliidae: ['jellyfish', 'jelly'],
  Ulmaridae: ['jelly'],
  Cyaneidae: ['jelly'],
  Chirodropidae: ['jelly', 'box jelly'],
  Pelagiidae: ['jelly', 'sea nettle'],
  Rhizostomatidae: ['jelly'],
  Oceaniidae: ['jelly'],
  Asteriidae: ['starfish', 'sea star'],
  Acanthasteridae: ['sea star'],
  Ophidiasteridae: ['starfish'],
};

/** Lower case, accents dropped ("Grévy's" → "grevys"), split into words. */
const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The query word, plus its singular for plurals: "cats" → cat, "foxes" → fox. */
const forms = (w: string) => [w, ...(w.length > 3 && w.endsWith('es') ? [w.slice(0, -2)] : []), ...(w.length > 3 && w.endsWith('s') ? [w.slice(0, -1)] : [])];

/**
 * How a typed word may match a field. Names and kind words take any word start and plurals. Latin names and places
 * need the whole word unless the typed word is long enough, so "cat" doesn't find Santa Catarina or Cathartidae and
 * "camel" doesn't find the ostrich (Struthio camelus).
 */
type Match = 'loose' | 'latin' | 'place';
const PREFIX_FROM: Record<Match, number> = { loose: 1, latin: 6, place: 4 };

interface Doc {
  s: Species;
  fields: { words: string[]; weight: number; match: Match }[];
  countryNames: string[];
  stateNames: string[];
}

export function createSearch(species: Species[], isoName: (iso: string) => string) {
  const docs: Doc[] = species.map((s) => {
    const countryNames = s.iso.map(isoName);
    const stateNames = (s.states ?? []).map((x) => x.name);
    return {
      s,
      countryNames,
      stateNames,
      // where a word is found decides the order: the name first, then what kind of animal it is, then places
      fields: [
        { words: words(s.name), weight: 6, match: 'loose' },
        { words: (KINDS[s.family] ?? []).flatMap(words), weight: 5, match: 'loose' },
        { words: [...words(s.group), ...words(s.sci), ...words(s.family)], weight: 4, match: 'latin' },
        { words: countryNames.flatMap(words), weight: 3, match: 'place' },
        { words: [...stateNames.flatMap(words), ...s.continents.flatMap(words)], weight: 2, match: 'place' },
      ],
    };
  });

  // Typo fallback, only used when no word matches: "leapord", "girafe". Names only: across places it finds noise.
  const fuse = new Fuse(docs, {
    keys: [
      { name: 's.name', weight: 3 },
      { name: 's.sci', weight: 1 },
    ],
    threshold: 0.34,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 4,
  });

  /** Fuzzy matches, keeping only those about as close as the best one, so "hipo" doesn't bring a cobra along. */
  function byTypo(text: string): Species[] {
    const hits = fuse.search(text);
    const best = hits[0]?.score ?? 0;
    return hits.filter((h) => (h.score ?? 1) <= best + 0.1).map((h) => h.item.s);
  }

  /**
   * Every word typed has to start a word somewhere in the animal: "snow leo" finds the snow leopard, "cat" finds cats
   * but not "Meerkat". An exact name ranks first, then names starting with the query, then by where the words matched.
   */
  function byWords(text: string): Species[] {
    const qs = words(text);
    const whole = words(text).join(' ');
    const scored: { s: Species; score: number; i: number }[] = [];
    docs.forEach((d, i) => {
      let score = 0;
      for (const q of qs) {
        let best = 0;
        for (const f of d.fields) {
          const tries = f.match === 'loose' ? forms(q) : [q];
          const prefixOk = q.length >= PREFIX_FROM[f.match];
          for (const w of f.words) {
            for (const form of tries) {
              if (w === form) best = Math.max(best, f.weight + 0.5);
              else if (prefixOk && w.startsWith(form)) best = Math.max(best, f.weight);
            }
          }
        }
        if (!best) return; // one word with no match rules the animal out
        score += best;
      }
      const name = words(d.s.name).join(' ');
      if (name === whole) score += 20;
      else if (name.startsWith(whole)) score += 10;
      scored.push({ s: d.s, score, i });
    });
    return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.s);
  }

  return function run(q: string, f: Filters): Species[] {
    const text = q.trim();
    let list = species;
    if (text) {
      list = byWords(text);
      if (!list.length && text.length >= 4) list = byTypo(text);
    }
    if (f.continent) list = list.filter((s) => s.continents.includes(f.continent!));
    if (f.status) list = list.filter((s) => s.status === f.status);
    if (f.country) list = list.filter((s) => s.iso.includes(f.country!) || (s.states ?? []).some((x) => x.iso === f.country));
    if (f.state) list = list.filter((s) => (s.states ?? []).some((x) => x.id === f.state));
    return list;
  };
}
