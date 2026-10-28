// Writes public/thumb/<gbif key>.webp, a small square crop of each photo in public/img/, for the rows of the animal list.
// Works from the photos already on disk (no network), so it runs after build-data and skips thumbs that are up to date.
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import sharp from 'sharp';

const SIZE = 96; // shown at 44px, so sharp on 2x screens

mkdirSync('public/thumb', { recursive: true });
let made = 0;
for (const f of readdirSync('public/img')) {
  if (!f.endsWith('.webp')) continue;
  const src = `public/img/${f}`;
  const out = `public/thumb/${f}`;
  const done = statSync(out, { throwIfNoEntry: false });
  if (done && done.mtimeMs >= statSync(src).mtimeMs) continue;
  await sharp(src).resize(SIZE, SIZE, { fit: 'cover', position: 'attention' }).webp({ quality: 70 }).toFile(out);
  made++;
}
console.log(`thumbs: ${made} written`);
