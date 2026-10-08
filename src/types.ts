export interface Credit {
  author: string;
  license: string;
  licenseUrl: string | null;
  page: string;
}

export interface Species {
  id: number;
  no: string;
  sci: string;
  name: string;
  group: string;
  family: string;
  status: string;
  desc: string;
  wiki: string | null;
  img: string | null;
  imgW: number | null;
  imgH: number | null;
  credit: Credit | null;
  iso: string[];
  countries: { iso: string; share: number }[];
  continents: string[];
  occurrences: number;
  /** rounding applied to published record points, in degrees (0.1 for threatened animals) */
  pointsRounding?: number;
  /** records GBIF flags as captive/managed, left out of everything */
  captiveExcluded?: number;
  sampled: number;
  datasets: { title: string; doi: string | null; license: string }[];
  /** states/provinces the sampled records fall in, largest share first */
  states: StateShare[];
  /** a short recording of its call, for animals with one on Commons (data/sounds.csv) */
  sound?: Sound;
}

export interface Sound {
  src: string;
  /** seconds */
  dur: number;
  /** what it is, finishing "Hear its ...": "roar", "song" */
  label: string;
  credit: Credit;
}

export interface StateShare {
  id: string;
  name: string;
  iso: string;
  /** share of the sampled records */
  share: number;
}

/** A state or province (Natural Earth admin-1), loaded per country when that country is opened. */
export interface StateFeature {
  type: 'Feature';
  properties: { id: string; name: string; iso: string; kind: string; countryName?: string };
  geometry: Country['geometry'];
  center?: { lat: number; lng: number };
  span?: number;
}

export interface CountryProps {
  iso: string;
  name: string;
  continent: string;
}

export interface Country {
  type: 'Feature';
  properties: CountryProps;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
  /** filled in at load: label anchor and angular size in degrees */
  center?: { lat: number; lng: number };
  span?: number;
}

/** [lat, lng, weight 0..1] */
export type Cell = [number, number, number];

export interface Pov {
  lat: number;
  lng: number;
  altitude: number;
}

export const STATUS_LABEL: Record<string, string> = {
  EX: 'Extinct',
  EW: 'Extinct in the wild',
  CR: 'Critically endangered',
  EN: 'Endangered',
  VU: 'Vulnerable',
  NT: 'Near threatened',
  LC: 'Least concern',
  DD: 'Data deficient',
  NE: 'Not evaluated',
};

/** What each status means, in plain words, shown under it on the animal's page. */
export const STATUS_NOTE: Record<string, string> = {
  EX: 'None are left anywhere.',
  EW: 'It now survives only in zoos and parks, not in the wild.',
  CR: 'In very great danger of dying out in the wild.',
  EN: 'In danger of dying out in the wild.',
  VU: 'At risk: it could become endangered.',
  NT: 'Not at risk yet, but could be soon.',
  LC: 'Not at risk: it is doing well in the wild.',
  DD: 'Scientists don’t have enough information yet to say how at risk it is.',
  NE: 'Scientists haven’t checked yet how at risk it is, so this doesn’t mean it is safe or in danger.',
};
