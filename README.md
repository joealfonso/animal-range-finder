# Fauna Mundi

Animals on an interactive 3D globe. Vite + TypeScript + three.js via globe.gl. Static data, no backend.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

The built data is committed under `public/`, so the app runs without any network access.

## Adding animals

Append a row to `data/species.csv` (`scientific name, Wikipedia article title`) and run:

```bash
npm run data
```

For each new species the script:

1. matches the name in GBIF and reads its IUCN Red List category,
2. reads the opening of the Wikipedia article,
3. finds the article's lead photo on Wikimedia Commons and keeps it only if it is CC0, CC BY, CC BY-SA or public domain (author and licence are stored and shown in the UI). Photos are resized but never cropped, so the animal is never cut off,
4. samples georeferenced GBIF occurrences (leaving out records GBIF flags as captive or managed), bins them into 2° cells for the range layer, takes country counts to list where it lives, and places each sampled record inside a state or province,
5. writes `public/data/species.json`, `public/data/range/<gbif key>.json` and `public/img/<gbif key>.webp`.

Finished species are cached in `.cache/`, so a rerun only fetches new rows. Species with no match, too few records or no summary are skipped and listed in `.cache/_failed.txt`.

`npm run assets` re-creates the globe textures, country borders and per-country state files (NASA, Natural Earth). `npm run states` rebuilds only the state files.

## API keys

None are needed. GBIF, Wikipedia and Wikimedia Commons are keyless. If a keyed source is added, read it from `process.env` in `scripts/`, list the variable in `.env.example`, and keep `.env` out of git (it is already ignored).

## Sources

NASA Visible Earth (Blue Marble, public domain) · Natural Earth (public domain) · GBIF occurrences (CC0 / CC BY per dataset) · Wikipedia text (CC BY-SA 4.0) · Wikimedia Commons photos (per-file licence, credited in the UI) · Instrument Serif and IBM Plex Mono (SIL OFL 1.1). The same list is in the app under "Sources & credits".

## Honest limits

- A range here is a density of GBIF observation records, not an expert-drawn range map. It follows where people observe, so it is thinner in places with few observers. Records GBIF flags as captive or managed are removed, but zoo or escaped animals the data does not flag can remain.
- States come from a sample of records, so a state with only a handful of records may be missing, and a state is only listed inside the animal's range countries.
- Conservation status is the IUCN category as republished by GBIF and may lag the Red List.
- The range sample is capped per species (a few hundred to about 1,200 records) to keep the build fast.
