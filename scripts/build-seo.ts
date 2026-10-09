// Writes the pages search engines can read into dist/ after `vite build`: one static page per animal at
// /animal/<slug>/, an A–Z index at /animal/, and sitemap.xml. The globe itself is JavaScript and lives at one URL, so
// without these Google has a single near-empty page to index. Each page carries real text, a canonical URL and
// structured data, and links into the globe at /#<id>.
// Run: npm run build (this runs after vite build). Pass another folder to write somewhere else.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { STATUS_LABEL, STATUS_NOTE, type Species } from '../src/types';

const SITE = 'https://animalrangefinder.com';
const DIST = process.argv[2] ?? 'dist';
const { species, generated } = JSON.parse(await readFile('public/data/species.json', 'utf8')) as {
  species: Species[];
  generated: string;
};
const countries = JSON.parse(await readFile('public/data/countries.json', 'utf8'));
const countryName = new Map<string, string>(countries.features.map((f: any) => [f.properties.iso, f.properties.name]));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const json = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
const slugify = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// common name, or the Latin name when two animals share a common name
const slugs = new Map<number, string>();
const taken = new Set<string>();
for (const s of species) {
  let slug = slugify(s.name) || slugify(s.sci);
  if (taken.has(slug)) slug = slugify(`${s.name} ${s.sci}`);
  if (taken.has(slug)) slug = `${slug}-${s.id}`;
  taken.add(slug);
  slugs.set(s.id, slug);
}
const urlOf = (s: Species) => `${SITE}/animal/${slugs.get(s.id)}/`;

const list = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const firstSentence = (t: string) => (t.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? t).slice(0, 200);

function shell(opts: { title: string; description: string; url: string; image?: string; body: string; ld: unknown[] }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(opts.title)}</title>
    <meta name="description" content="${esc(opts.description)}" />
    <link rel="canonical" href="${opts.url}" />
    <meta name="theme-color" content="#06070a" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Animal Range Finder" />
    <meta property="og:title" content="${esc(opts.title)}" />
    <meta property="og:description" content="${esc(opts.description)}" />
    <meta property="og:url" content="${opts.url}" />
    <meta property="og:image" content="${opts.image ?? `${SITE}/og.jpg`}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/seo.css" />
${opts.ld.map((o) => `    <script type="application/ld+json">${json(o)}</script>`).join('\n')}
  </head>
  <body>
    <header class="top"><a href="/">Animal <em>Range</em> Finder</a><a href="/animal/">All animals</a></header>
    <main>
${opts.body}
    </main>
    <footer class="foot">Ranges come from <a href="https://www.gbif.org/">GBIF</a> occurrence records; descriptions from <a href="https://www.wikipedia.org/">Wikipedia</a> (CC BY-SA 4.0). <a href="/">See every animal on the globe</a>.</footer>
  </body>
</html>
`;
}

function animalPage(s: Species) {
  const url = urlOf(s);
  const label = STATUS_LABEL[s.status] ?? s.status;
  const native = s.countries.filter((c) => !c.introduced).map((c) => countryName.get(c.iso) ?? c.iso);
  const intro = s.countries.filter((c) => c.introduced).map((c) => countryName.get(c.iso) ?? c.iso);
  const states = s.states.slice(0, 6).map((x) => x.name);
  const where = [
    native.length ? `<p>Recorded in ${esc(list(native))}${s.continents.length ? ` (${esc(list(s.continents))})` : ''}.</p>` : '',
    intro.length ? `<p>Introduced, not native, in ${esc(list(intro))}.</p>` : '',
    states.length ? `<p>Most records fall in ${esc(list(states))}.</p>` : '',
  ].join('\n        ');
  const title = `${s.name} (${s.sci}): range map and where it lives | Animal Range Finder`;
  const description = `Where does the ${s.name} live? ${firstSentence(s.desc)} See its range on an interactive globe.`;
  const img = s.img ? `${SITE}/${s.img}` : undefined;
  const body = `      <article>
        <p class="crumb"><a href="/animal/">Animals</a> / ${esc(s.group)}</p>
        <h1>${esc(s.name)}</h1>
        <p class="sci"><i>${esc(s.sci)}</i> · ${esc(s.family)}</p>
${s.img ? `        <figure><img src="/${esc(s.img)}" width="${s.imgW ?? ''}" height="${s.imgH ?? ''}" alt="${esc(s.name)}" />${
          s.credit ? `<figcaption>Photo: ${esc(s.credit.author)}, <a href="${esc(s.credit.page)}">${esc(s.credit.license)}</a></figcaption>` : ''
        }</figure>\n` : ''}        <p>${esc(s.desc)}</p>
        <h2>Where the ${esc(s.name)} lives</h2>
        ${where}
        <p><a class="cta" href="/#${s.id}">See the ${esc(s.name)}’s range on the globe</a></p>
        <h2>Conservation status</h2>
        <p><b>${esc(label)}</b> (${esc(s.status)}).${STATUS_NOTE[s.status] ? ' ' + esc(STATUS_NOTE[s.status]) : ''} Categories are the IUCN Red List as republished by GBIF.</p>
        <h2>Sources</h2>
        <p>The range is a density of ${s.occurrences.toLocaleString('en-US')} georeferenced GBIF records, not an expert-drawn map.${
          s.wiki ? ` Description from <a href="${esc(s.wiki)}">Wikipedia</a>.` : ''
        }</p>
      </article>`;
  return shell({
    title,
    description,
    url,
    image: img,
    body,
    ld: [
      {
        '@context': 'https://schema.org',
        '@type': 'Taxon',
        name: s.name,
        alternateName: s.sci,
        description: s.desc,
        url,
        ...(img ? { image: img } : {}),
        ...(s.wiki ? { sameAs: [s.wiki] } : {}),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Animal Range Finder', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Animals', item: `${SITE}/animal/` },
          { '@type': 'ListItem', position: 3, name: s.name, item: url },
        ],
      },
    ],
  });
}

function indexPage() {
  const sorted = [...species].sort((a, b) => a.name.localeCompare(b.name));
  const groups = [...new Set(sorted.map((s) => s.group))].sort();
  const body = `      <h1>Every animal on Animal Range Finder</h1>
      <p>${species.length} animals, each with a range map built from GBIF occurrence records. Pick one to read where it lives, or <a href="/">open the globe</a>.</p>
${groups
  .map(
    (g) => `      <h2>${esc(g)}</h2>
      <ul class="all">
${sorted.filter((s) => s.group === g).map((s) => `        <li><a href="/animal/${slugs.get(s.id)}/">${esc(s.name)}</a> <i>${esc(s.sci)}</i></li>`).join('\n')}
      </ul>`,
  )
  .join('\n')}`;
  return shell({
    title: 'All animals and where they live | Animal Range Finder',
    description: `Browse ${species.length} animals and see where each one lives, from GBIF occurrence records, on an interactive globe.`,
    url: `${SITE}/animal/`,
    body,
    ld: [],
  });
}

const write = async (path: string, text: string) => {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, text);
};

for (const s of species) await write(`${DIST}/animal/${slugs.get(s.id)}/index.html`, animalPage(s));
await write(`${DIST}/animal/index.html`, indexPage());

const day = generated.slice(0, 10);
const urls = [`${SITE}/`, `${SITE}/animal/`, ...species.map(urlOf)];
await write(
  `${DIST}/sitemap.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u}</loc><lastmod>${day}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
console.log(`seo: ${species.length} animal pages, index and sitemap.xml in ${DIST}/`);
