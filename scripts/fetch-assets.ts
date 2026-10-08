// Downloads NASA textures + Natural Earth countries and writes optimised copies into public/.
// Run once: npm run assets
import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';

const NASA = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg';
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

await mkdir('public/tex', { recursive: true });
await mkdir('public/data', { recursive: true });

const buf = Buffer.from(await (await fetch(NASA)).arrayBuffer());
await sharp(buf).resize(4096, 2048).modulate({ saturation: 0.62, brightness: 0.92 }).jpeg({ quality: 82, mozjpeg: true }).toFile('public/tex/earth-4k.jpg');
await sharp(buf).resize(2048, 1024).modulate({ saturation: 0.62, brightness: 0.92 }).jpeg({ quality: 80, mozjpeg: true }).toFile('public/tex/earth-2k.jpg');
// Colour is muted so the globe stays quiet behind the interface.
// Relief map: luminance of the NASA topo/bathy image, softened so it reads as terrain, not noise.
await sharp(buf).resize(2048, 1024).greyscale().blur(0.8).jpeg({ quality: 80 }).toFile('public/tex/bump-2k.jpg');
console.log('textures ok');

const ne = await (await fetch(NE)).json();
const r = (n: number) => Math.round(n * 100) / 100;
const round = (c: any): any => (typeof c[0] === 'number' ? [r(c[0]), r(c[1])] : c.map(round));
const features = ne.features
  .filter((f: any) => f.properties.ISO_A2_EH && f.properties.ISO_A2_EH !== '-99' || f.properties.ADMIN)
  .map((f: any) => {
    const p = f.properties;
    const iso = p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ISO_A2 !== '-99' ? p.ISO_A2 : p.WB_A2;
    return {
      type: 'Feature',
      properties: { iso, name: p.NAME, continent: p.CONTINENT },
      geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
    };
  });
await writeFile('public/data/countries.json', JSON.stringify({ type: 'FeatureCollection', features }));
console.log('countries', features.length);
