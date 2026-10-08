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
