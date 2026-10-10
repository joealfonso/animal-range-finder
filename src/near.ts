import type { Species } from './types';

// "What lives here": which animals have a wild record near a point, and how near the closest recorded place is.
// near.json (built by scripts/build-near.ts) says which animals have records in each 1° cell, so only those animals'
// point files are fetched and measured. Everything runs in the browser; the point never leaves the page.

/** How far from the pin a record still counts, in km. */
export const NEAR_KM = 300;
/** Recorded places within this distance are counted for the "N recorded places within" line, in km. */
export const CLOSE_KM = 50;

export interface NearHit {
  /** distance to the nearest recorded place, km */
  km: number;
  /** recorded places within CLOSE_KM */
  close: number;
}

interface NearIndex {
  ids: number[];
  cells: Record<string, number[]>;
}

const EARTH_KM = 6371;
const rad = Math.PI / 180;
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function createNear(base: string, byId: Map<number, Species>, loadPoints: (s: Species) => Promise<number[][]>) {
  let index: Promise<NearIndex> | null = null;
  const loadIndex = () =>
    (index ??= fetch(`${base}data/near.json`).then((r) => {
      if (!r.ok) throw new Error(`near.json: ${r.status}`);
      return r.json();
    }));

  /** Animals with a record in any 1° cell that could hold a point within NEAR_KM. */
  function candidates(ix: NearIndex, lat: number, lng: number): Species[] {
    const dLat = NEAR_KM / 111 + 1;
    const lat0 = Math.max(-90, Math.floor(lat - dLat));
    const lat1 = Math.min(89, Math.floor(lat + dLat));
    // longitude degrees shrink toward the poles; past ~80° just take every cell in the band
    const cos = Math.cos(Math.min(89, Math.max(Math.abs(lat0), Math.abs(lat1 + 1))) * rad);
    const dLng = cos > 0.17 ? NEAR_KM / (111 * cos) + 1 : 180;
    const x0 = Math.floor(lng - dLng);
    const x1 = Math.min(Math.floor(lng + dLng), x0 + 359);
    const out = new Set<number>();
    for (let y = lat0; y <= lat1; y++)
      for (let xi = x0; xi <= x1; xi++) {
        const x = ((((xi + 180) % 360) + 360) % 360) - 180; // wrap across the antimeridian
        for (const i of ix.cells[`${y},${x}`] ?? []) out.add(ix.ids[i]);
      }
    return [...out].map((id) => byId.get(id)).filter((s): s is Species => !!s);
  }

  /** Every animal with a recorded place within NEAR_KM of the point, keyed by id. */
  return async function near(lat: number, lng: number): Promise<Map<number, NearHit>> {
    const ix = await loadIndex();
    const list = candidates(ix, lat, lng);
    const hits = new Map<number, NearHit>();
    await Promise.all(
      list.map(async (s) => {
        const pts = await loadPoints(s);
        let km = Infinity;
        let close = 0;
        for (const [la, lo] of pts) {
          const d = haversineKm(lat, lng, la, lo);
          if (d < km) km = d;
          if (d <= CLOSE_KM) close++;
        }
        if (km <= NEAR_KM) hits.set(s.id, { km, close });
      }),
    );
    return hits;
  };
}
