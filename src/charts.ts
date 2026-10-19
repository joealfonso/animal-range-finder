/**
 * Small charts drawn as HTML and SVG strings, so they take the page's own type and colours and need no library.
 * Every number comes straight from the catalogue (species.json); nothing here estimates or smooths.
 */
import { esc, nf } from './html';
import type { Species } from './types';

export const THREATENED = ['CR', 'EN', 'VU'];
export const isThreatened = (s: Species) => THREATENED.includes(s.status);

/** A share of records as text: "62%", "3.4%", "<0.1%". */
export function pct(share: number): string {
  const p = share * 100;
  if (p >= 99.5) return '100%';
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 0.1) return `${Math.round(p * 10) / 10}%`;
  return '<0.1%';
}

/** 1,200 → "1.2K", 29,733,102 → "29.7M". */
export function compact(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** "1st", "22nd", "113th". */
export function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${nf.format(n)}th`;
  return `${nf.format(n)}${['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10]}`;
}

/** A group as a plural: "Mammals", "Fish", "Sea urchins". */
export const groupPlural = (g: string) => (/fish$/i.test(g) ? g : `${g}s`);

export interface ShareItem {
  key: string;
  label: string;
  /** share of the animal's records, 0..1 */
  share: number;
  introduced?: boolean;
}

/**
 * Where an animal's records come from, one row per place. Each bar is drawn against a full track, so its length is the
 * share of *all* the animal's records: an animal spread thinly over many places shows short bars, which is true.
 */
export function shareBars(items: ShareItem[], attr: 'iso' | 'state', active: string | null): string {
  return `<ul class="bars">${items
    .map(
      (x) =>
        `<li class="bar-row${x.introduced ? ' is-introduced' : ''}"><button type="button" data-${attr}="${esc(x.key)}" aria-pressed="${x.key === active}" title="${esc(x.label)}: ${pct(x.share)} of its records"><span class="bar-name">${esc(x.label)}${x.introduced ? '<span class="tag">introduced</span>' : ''}</span><span class="bar-track"><i class="bar-fill" style="--w:${Math.max(x.share * 100, 1.2).toFixed(1)}%"></i></span><span class="bar-pct">${pct(x.share)}</span></button></li>`,
    )
    .join('')}</ul>`;
}

/**
 * How many records every animal in the catalogue has, on a log scale (a few birds have millions, a few rare animals a
 * handful), with this animal's bin lit. Counts are of animals per bin, so the shape shows how lopsided recording is.
 */
export function recordHistogram(all: number[], mine: number, name: string): string {
  const PER = 3; // bins per factor of ten
  const W = 300;
  const base = 50;
  const maxH = 38;
  const logs = all.map(Math.log10);
  const lo = Math.floor(Math.min(...logs));
  const hi = Math.ceil(Math.max(...logs));
  const n = (hi - lo) * PER;
  const bin = (v: number) => Math.min(n - 1, Math.floor((Math.log10(v) - lo) * PER));
  const counts = new Array<number>(n).fill(0);
  for (const v of all) counts[bin(v)]++;
  const peak = Math.max(...counts);
  const bw = W / n;
  const mb = bin(mine);
  const height = (c: number) => (c ? Math.max(3, (c / peak) * maxH) : 0);
  const rects = counts
    .map((c, i) =>
      c
        ? `<rect class="${i === mb ? 'on' : ''}" x="${(i * bw + 0.75).toFixed(1)}" y="${(base - height(c)).toFixed(1)}" width="${(bw - 1.5).toFixed(1)}" height="${height(c).toFixed(1)}"><title>${c} ${c === 1 ? 'animal has' : 'animals have'} about ${compact(Math.round(10 ** (lo + i / PER)))} to ${compact(Math.round(10 ** (lo + (i + 1) / PER)))} records</title></rect>`
        : '',
    )
    .join('');
  const ticks: string[] = [];
  for (let d = lo; d <= hi; d++) {
    const x = (d - lo) * PER * bw;
    ticks.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${base}" y2="${base + 4}"/>`);
    if (d >= 2 && d % 2 === 0) ticks.push(`<text x="${x.toFixed(1)}" y="${base + 15}" text-anchor="middle">${compact(10 ** d)}</text>`);
  }
  const mx = mb * bw + bw / 2;
  const my = base - height(counts[mb]) - 3;
  return `<svg class="hist" viewBox="0 0 ${W} 68" role="img" aria-label="${esc(name)} sits among all ${all.length} animals, whose record counts run from ${nf.format(Math.min(...all))} to ${nf.format(Math.max(...all))}">
      <line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"/>${rects}${ticks.join('')}
      <path class="mark" d="M${(mx - 4.5).toFixed(1)} ${(my - 7).toFixed(1)} L${(mx + 4.5).toFixed(1)} ${(my - 7).toFixed(1)} L${mx.toFixed(1)} ${my.toFixed(1)}Z"/>
    </svg>`;
}

export interface BarRow {
  id: string;
  label: string;
  /** the full bar */
  value: number;
  /** the part of the bar drawn in the accent (for example, the threatened ones) */
  hot?: number;
  /** text at the end of the row */
  end: string;
  title?: string;
}

/** Rows of label · bar · number, each a button the page can act on (`act` + ":" + id goes in data-act). */
export function barList(rows: BarRow[], act: string, max: number): string {
  const w = (v: number) => `${((v / max) * 100).toFixed(1)}%`;
  return `<ul class="bars">${rows
    .map((r) => {
      const hot = r.hot ?? 0;
      return `<li class="bar-row"><button type="button" data-act="${act}:${esc(r.id)}"${r.title ? ` title="${esc(r.title)}"` : ''}><span class="bar-name">${esc(r.label)}</span><span class="bar-track">${
        hot ? `<i class="bar-fill hot" style="--w:${w(hot)}"></i>` : ''
      }<i class="bar-fill" style="--w:${w(r.value - hot)}"></i></span><span class="bar-pct">${esc(r.end)}</span></button></li>`;
    })
    .join('')}</ul>`;
}

/** One bar per value 1..max, tallest first normalised: how many animals fall at each whole number. */
export function columns(values: number[], unit: (k: number) => string): string {
  const max = Math.max(...values);
  const counts = new Array<number>(max + 1).fill(0);
  for (const v of values) counts[v]++;
  const peak = Math.max(...counts);
  return `<div class="cols" role="img" aria-label="Number of animals by number of countries they are recorded in">${counts
    .slice(1)
    .map(
      (c, i) =>
        `<span class="col" title="${c} ${c === 1 ? 'animal is' : 'animals are'} recorded in ${unit(i + 1)}"><b>${c}</b><i style="--h:${((c / peak) * 100).toFixed(1)}%"></i><em>${i + 1}</em></span>`,
    )
    .join('')}</div>`;
}
