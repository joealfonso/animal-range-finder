# Animal Range Finder

Animals on an interactive 3D globe. Vite + TypeScript + three.js via globe.gl. Static data, no backend.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

The built data is committed under `public/`, so the app runs without any network access.

## Adding animals

Append a row to `data/species.csv` (`scientific name, Wikipedia article title`, and optionally the everyday name) and run:

```bash
npm run data
```

For each new species the script:

1. matches the name in GBIF and reads its IUCN Red List category,
2. reads the opening of the Wikipedia article, and names the animal after its title unless the row gives an everyday name (add one whenever the article is titled in Latin, as with `Aurelia aurita,Aurelia aurita,Moon jellyfish`, so the app always shows and searches the common name),
3. finds the article's lead photo on Wikimedia Commons and keeps it only if it is CC0, CC BY, CC BY-SA or public domain (author and licence are stored and shown in the UI). Photos are resized but never cropped, so the animal is never cut off,
4. samples georeferenced GBIF occurrences (leaving out records GBIF flags as captive or managed), bins them into 2° cells for the range layer, takes country counts to list where it lives, and places each sampled record inside a state or province,
5. writes `public/data/species.json`, `public/data/range/<gbif key>.json` and `public/img/<gbif key>.webp`.

It then runs `scripts/build-near.ts`, which indexes every sampled record by 1° cell into `public/data/near.json`. That index powers **What lives here** (Place → Near me / Drop a pin): the app looks up the cells around the pin, fetches only those animals' point files, and lists every animal with a sampled record within 300 km, nearest first. The location is used only in the browser. It is never put in the URL or sent anywhere.

Finished species are cached in `.cache/`, so a rerun only fetches new rows. Species with no match, too few records or no summary are skipped and listed in `.cache/_failed.txt`.

Then `scripts/build-sounds.ts` adds each animal's call. Recordings are picked by hand in `data/sounds.csv` (scientific name, source, and a label that finishes "Hear its ..."), because searching Commons by animal name mostly finds music, pronunciations and spoken articles. The source is a Wikimedia Commons file name or an iNaturalist observation URL, whose first CC0 / CC BY / CC BY-SA recording is used. The script keeps a file only under the same licences as the photos, cuts out the loudest 12 seconds (measured above 250 Hz so wind noise doesn't win), levels the volume and writes `public/sound/<gbif key>.mp3`. It needs [ffmpeg](https://ffmpeg.org/) on the PATH. `npm run sounds` reruns just this step. Animals without a row simply have no play button; many (fish, snakes, octopuses) make no sound people would know them by.

Then run `npm run check`. It confirms every animal has its range, points and photo files, that links are http(s), that no text contains HTML, and that every country and state it names exists. CI runs the same check and the production build on every pull request.

`npm run assets` re-creates the globe textures, country borders and per-country state files (NASA, Natural Earth). `npm run states` rebuilds only the state files.

## API keys

None are needed. GBIF, Wikipedia and Wikimedia Commons are keyless. If a keyed source is added, read it from `process.env` in `scripts/`, list the variable in `.env.example`, and keep `.env` out of git (it is already ignored).

## Sources

NASA Visible Earth (Blue Marble, public domain) · Natural Earth (public domain) · GBIF occurrences (CC0 / CC BY per dataset) · Wikipedia text (CC BY-SA 4.0) · Wikimedia Commons photos and sounds, iNaturalist sounds (per-file licence, credited in the UI) · Instrument Serif and IBM Plex Mono (SIL OFL 1.1). The same list is in the app under "Sources & credits".

## Honest limits

- A range here is a density of GBIF observation records, not an expert-drawn range map. It follows where people observe, so it is thinner in places with few observers. Records GBIF flags as captive or managed are removed, but zoo or escaped animals the data does not flag can remain.
- States come from a sample of records, so a state with only a handful of records may be missing, and a state is only listed inside the animal's range countries.
- Conservation status is the IUCN category as republished by GBIF and may lag the Red List. `STATUS_OVERRIDE` in `scripts/build-data.ts` sets a few by hand where GBIF has none (the mountain gorilla, a subspecies) or doesn't match the assessment (the eland, giant otter, Malayan tapir, wild yak and Aldabra giant tortoise, which GBIF shows as not evaluated). The Galápagos tortoise is marked "Varies by species" (`VAR`, not an IUCN category): GBIF's *Chelonoidis niger* is the extinct Floreana tortoise, but the photos and records are the living Galápagos tortoises, which IUCN now rates one species at a time. Check a new animal's status against its Wikipedia infobox, which cites the IUCN assessment, and look out for names GBIF files under another species (GBIF's *Pteropus giganteus* is the large flying fox, so the Indian flying fox is built from *Pteropus medius*).
- Continents come from the countries holding at least 1.5% of an animal's records, with Russia split at the Urals. Where the only records on a continent are zoo animals GBIF doesn't flag, `data/continent-fixes.csv` drops that continent by hand.
- GBIF files some animals we don't mean under a species: dogs and dingoes under the wolf, for example. `EXCLUDE` in `scripts/build-data.ts` leaves those subspecies out. GBIF also doesn't separate the wild Bactrian camel from the domestic one, so the catalogue lists the Bactrian camel as a whole.
- "What lives here" measures to the nearest *sampled* record, so a real animal may well be closer. When the pin is on a continent the animal isn't listed on, the list marks it "unusual here": often an unflagged zoo or escaped animal (a ring-tailed lemur in France, a black rhino by Denver), but sometimes a real part of its range that few people record.
- The range sample is capped per species (a few hundred to about 1,200 records) to keep the build fast.
