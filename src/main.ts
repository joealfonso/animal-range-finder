import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

import { createStage } from './stage';
import { createSearch, type Filters } from './search';
import { HEAT_BANDS } from './heat';
import { annotateCountry, countryPov, pickAt, rangePov, toPickable } from './geo';
import { CLOSE_KM, NEAR_KM, createNear, type NearHit } from './near';
import { STATUS_LABEL, type Cell, type Country, type Pov, type Species, type StateFeature } from './types';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
/** An outbound link, or just its text if the stored URL is not http(s), so bad data can never become a javascript: link. */
const extLink = (url: string, html: string) =>
  /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${html}</a>` : html;
const nf = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many: string) => `${nf.format(n)} ${n === 1 ? one : many}`;
const fmtKm = (km: number) => (km < 1 ? 'under 1 km' : `${nf.format(Math.round(km))} km`);
/** The name as it would appear mid-sentence: "lion", but "American alligator". Taken from how the description writes it. */
function midSentence(name: string, desc: string) {
  const re = new RegExp(`[^.!?]\\s(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
  const m = desc.match(re);
  if (m) return m[1];
  if (/^\S+['’]s\b/.test(name)) return name; // named after someone: "Przewalski's horse"
  return name.charAt(0).toLowerCase() + name.slice(1);
}

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = matchMedia('(max-width: 800px)').matches || (navigator.hardwareConcurrency ?? 8) <= 2;
const wide = () => window.innerWidth > 900;
/**
 * On phones the sheet covers the lower half, so the globe is lifted into the space above it. With a pin down and no
 * sheet, it is lifted further so the pin (at the centre) sits above the animal list instead of behind it.
 */
const offset = (plateOpen: boolean, pinned = false): [number, number] =>
  wide() ? [plateOpen ? 40 : 0, 0] : [0, Math.round(window.innerHeight * (plateOpen ? 0.27 : pinned ? 0.33 : 0.2))];

const CONTINENT_SHORT: Record<string, string> = {
  Africa: 'Africa',
  Asia: 'Asia',
  Europe: 'Europe',
  'North America': 'N. America',
  'South America': 'S. America',
  Oceania: 'Oceania',
  Antarctica: 'Antarctica',
};
const STATUS_ORDER = ['CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'NE'];
/** Where the camera goes when a continent is picked under "Where": roughly centred, with the whole continent in view. */
const CONTINENT_POV: Record<string, Pov> = {
  Africa: { lat: 2, lng: 18, altitude: 1.75 },
  Asia: { lat: 34, lng: 95, altitude: 2 },
  Europe: { lat: 52, lng: 14, altitude: 1.15 },
  'North America': { lat: 42, lng: -100, altitude: 1.8 },
  'South America': { lat: -18, lng: -60, altitude: 1.7 },
  Oceania: { lat: -24, lng: 145, altitude: 1.6 },
  Antarctica: { lat: -78, lng: 20, altitude: 1.9 },
};

async function boot() {
  const [speciesRes, countryRes, stateIndex] = await Promise.all([
    fetch(`${BASE}data/species.json`).then((r) => r.json()),
    fetch(`${BASE}data/countries.json`).then((r) => r.json()),
    fetch(`${BASE}data/states/index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<Record<string, number>>,
  ]);
  const species: Species[] = speciesRes.species;
  for (const s of species) s.states ??= [];
  const countries: Country[] = countryRes.features;
  countries.forEach(annotateCountry);
  const byIso = new Map(countries.map((c) => [c.properties.iso, c]));
  const isoName = (iso: string) => byIso.get(iso)?.properties.name ?? iso;
  const byId = new Map(species.map((s) => [s.id, s]));

  const stage = createStage($('globe'), countries, { small, reduced });
  const run = createSearch(species, isoName);

  // ---------- state ----------
  const filters: Filters = { continent: null, status: null, country: null, state: null };
  let list: Species[] = species;
  let activeIdx = 0;
  let selected: Species | null = null;
  let activeCountry: string | null = null;
  let activeState: string | null = null; // a state inside activeCountry, while an animal is open
  // The place you were looking at when you opened the animal from a filtered list. Esc there closes the animal
  // and leaves you where you were, instead of stepping out through country and range.
  let placeEntry: { iso: string; state: string | null } | null = null;
  let statusKeyOpen = false; // the panel explaining the status codes, opened from the Status row
  // how the range is drawn; remembered per browser, heatmap by default
  let rangeMode: 'heat' | 'points' = 'heat';
  let shownPoints = 0;
  try {
    const saved = localStorage.getItem('arf.rangeMode');
    if (saved === 'points' || saved === 'dots') rangeMode = 'points'; // "dots" was the old name
  } catch {
    // storage blocked: keep the default
  }
  stage.setRangeMode(rangeMode);
  // Where the camera was before we moved it, one for each layer Back can undo.
  let animalHome: Pov | null = null;
  let filterHome: Pov | null = null;
  let animalPov: (Pov & { spread: number }) | null = null;
  let flightToken = 0;
  // Per-frame label/leader work only runs when the camera moved or one of these says something changed.
  let frameDirty = true;
  let blockersDirty = true; // the text panels around the globe moved or changed size
  let cache = new Map<number, Cell[]>();
  // "What lives here": a point (a dropped pin, or where the visitor is) and the animals with a sampled record near it.
  // hits is null while the distances are being measured. The point stays in the page: it is never put in the URL or sent.
  // continent: the pin's, to spot animals recorded far from where they live (null out at sea)
  let near: {
    lat: number;
    lng: number;
    label: string;
    you: boolean;
    continent: string | null;
    hits: Map<number, NearHit> | null;
  } | null = null;
  let nearToken = 0;
  let pinArmed = false; // the next click on the globe drops the pin
  let nearNote = ''; // why it could not run (location refused...), shown in the Place row

  // ---------- elements ----------
  const q = $<HTMLInputElement>('q');
  const results = $<HTMLUListElement>('results');
  const empty = $('empty');
  const plate = $('plate');
  const filtersEl = $('filters');
  const readout = $('readout');
  const creditsEl = $('credits');
  const creditsBtn = $<HTMLButtonElement>('credits-btn');
  const pins = $('pins');
  const leaderSvg = document.getElementById('leader') as unknown as SVGSVGElement;
  const leaderLine = document.getElementById('leader-line') as unknown as SVGPathElement;
  const leaderDot = document.getElementById('leader-dot') as unknown as SVGCircleElement;
  const leaderRing = document.getElementById('leader-ring') as unknown as SVGCircleElement;
  const tally = document.createElement('output');
  tally.className = 'tally';
  q.closest('label')!.insertBefore(tally, q.nextSibling);
  $('count').textContent = String(species.length);

  // ---------- index ----------
  function renderIndex() {
    results.innerHTML = list
      .map(
        (s, i) => `<li role="option" id="opt-${s.id}" data-i="${i}" aria-selected="${selected?.id === s.id}"
            class="${i === activeIdx ? 'is-active' : ''}${selected?.id === s.id ? ' is-open' : ''}">
          <span class="no">${s.no}</span>
          <span class="nm">${esc(s.name)}</span>
          <span class="st" title="${STATUS_LABEL[s.status] ?? ''}">${s.status}</span>
          <span class="la">${esc(s.sci)}${nearKm(s)}</span>
        </li>`,
      )
      .join('');
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = emptyMessage();
    tally.textContent = `${list.length}/${species.length}`;
    q.setAttribute('aria-activedescendant', list[activeIdx] ? `opt-${list[activeIdx].id}` : '');
  }

  function nearKm(s: Species) {
    const hit = near?.hits?.get(s.id);
    return hit ? `<span class="km"> · ${fmtKm(hit.km)}</span>${offRange(s) ? '<span class="off"> · unusual here</span>' : ''}` : '';
  }

  /**
   * The pin is on a continent the animal isn't listed on (same continents as the "Where" filter): few of its records
   * come from here. Often a zoo, park or escaped animal GBIF doesn't flag (a ring-tailed lemur in France), but
   * continents follow where records are, so it can also be a real but rarely recorded part of its range.
   */
  function offRange(s: Species) {
    return !!near?.continent && !s.continents.includes(near.continent);
  }

  /** Why the list is empty. A place with no animals is a gap in the sampled records, not a search the user got wrong. */
  function emptyMessage() {
    if (near) {
      if (!near.hits) return 'Measuring how far each animal’s nearest wild record is…';
      if (!near.hits.size)
        return `No animal in the catalogue has a sampled wild record within ${NEAR_KM} km of ${near.you ? 'you' : 'this pin'}. Out at sea, or somewhere few people record wildlife, that is expected. Drop the pin somewhere else, or clear it with ✕ below.`;
      return 'None of the animals near here match that. Try fewer filters.';
    }
    const placeOnly = run('', { continent: null, status: null, country: filters.country, state: filters.state });
    if (filters.state && !placeOnly.length)
      return `No sampled records place an animal in ${stateName(filters.state)}. States come from a sample of each animal's records, so smaller ones are often empty. Pick another state, or clear it with ✕ below.`;
    if (filters.country && !placeOnly.length)
      return `No animal in the catalogue has enough records in ${isoName(filters.country)} to list it there. Pick another country, or clear it with ✕ below.`;
    return 'Nothing in the catalogue matches that. Try a Latin name, a country, or fewer filters.';
  }

  function setActive(i: number, scroll = true) {
    if (!list.length) return;
    activeIdx = (i + list.length) % list.length;
    results.querySelector('.is-active')?.classList.remove('is-active');
    const el = results.children[activeIdx] as HTMLElement;
    el.classList.add('is-active');
    q.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function refresh() {
    list = run(q.value, filters);
    if (near) {
      const hits = near.hits;
      list = hits ? list.filter((s) => hits.has(s.id)).sort((a, b) => hits.get(a.id)!.km - hits.get(b.id)!.km) : [];
    }
    activeIdx = 0;
    renderIndex();
    renderFilters();
  }

  // ---------- filters ----------
  function renderFilters() {
    blockersDirty = true;
    const continents = [...new Set(species.flatMap((s) => s.continents))].filter((c) => CONTINENT_SHORT[c]);
    const statuses = STATUS_ORDER.filter((c) => species.some((s) => s.status === c));
    const btn = (kind: string, value: string | null, label: string, on: boolean, title = '') =>
      `<button type="button" data-kind="${kind}" data-value="${value ?? ''}" aria-pressed="${on}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
    filtersEl.innerHTML = `
      <div class="frow"><span class="flabel">Where</span>${btn('continent', null, 'All', !filters.continent)}${continents
        .map((c) => btn('continent', c, CONTINENT_SHORT[c], filters.continent === c))
        .join('')}</div>
      <div class="frow"><span class="flabel">Status</span>${btn('status', null, 'All', !filters.status)}${statuses
        .map((c) => btn('status', c, c, filters.status === c, STATUS_LABEL[c]))
        .join('')}<button type="button" class="info" data-kind="key" aria-expanded="${statusKeyOpen}" aria-controls="status-key"
          aria-label="What the status codes mean" title="What the status codes mean">i</button></div>
      <div class="frow place${filters.country || near || pinArmed ? ' is-set' : ''}"><span class="flabel">Place</span>${
        near
          ? btn('near', null, `${near.you ? 'Near you' : near.label ? `Pin in ${near.label}` : 'Pin at sea'} ✕`, true) +
            `<span class="hint">${near.hits ? `${plural(near.hits.size, 'animal', 'animals')} recorded within ${NEAR_KM} km` : 'measuring…'}</span>`
          : pinArmed
            ? `<span class="hint">click anywhere on the globe</span>${btn('pin-cancel', null, 'Cancel', false)}`
            : filters.country
          ? btn('country', null, `${isoName(filters.country)} ✕`, true) +
            (filters.state
              ? `<span class="crumb" aria-hidden="true">›</span>${btn('state', null, `${stateName(filters.state)} ✕`, true)}`
              : stateIndex[filters.country]
                ? '<span class="hint">now pick a state on the globe</span>'
                : '')
          : `${btn('locate', null, 'Near me', false, 'Animals recorded near you. Your location stays in this page.')}${btn('pin', null, 'Drop a pin', false, 'Animals recorded near any spot you click')}${nearNote ? `<span class="hint is-note">${esc(nearNote)}</span>` : '<span class="hint">or click a country, then a state</span>'}`
      }</div>
      <div class="status-key" id="status-key" role="note"${statusKeyOpen ? '' : ' hidden'}>
        <dl>${statuses.map((c) => `<div><dt>${c}</dt><dd>${STATUS_LABEL[c]}</dd></div>`).join('')}</dl>
        <p>Conservation status from the IUCN Red List, as republished by GBIF. CR, EN and VU are the threatened categories.</p>
      </div>`;
  }

  function setStatusKey(open: boolean) {
    statusKeyOpen = open;
    renderFilters();
    filtersEl.querySelector<HTMLElement>('button[data-kind="key"]')?.focus();
  }

  filtersEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.kind === 'key') return setStatusKey(!statusKeyOpen);
    if (b.dataset.kind === 'near') return clearNear();
    if (b.dataset.kind === 'locate') return locate();
    if (b.dataset.kind === 'pin') return armPin(true);
    if (b.dataset.kind === 'pin-cancel') return armPin(false);
    const kind = b.dataset.kind as keyof Filters;
    const value = b.dataset.value || null;
    if (kind === 'continent' && value && filters.continent !== value) return pickContinent(value);
    if (kind === 'country') {
      clearCountryFilter();
      return;
    }
    if (kind === 'state') {
      clearStateFilter();
      return;
    }
    filters[kind] = filters[kind] === value ? null : value;
    refresh();
    const again = filtersEl.querySelector<HTMLElement>(`button[data-kind="${kind}"][data-value="${value ?? ''}"]`);
    again?.focus();
  });

  // ---------- states ----------
  // One country at a time is "open": its states are drawn as their own shapes and can be picked.
  const stateCache = new Map<string, StateFeature[]>();
  const stateById = new Map<string, StateFeature>();
  async function loadStates(iso: string): Promise<StateFeature[]> {
    if (!stateIndex[iso]) return [];
    const hit = stateCache.get(iso);
    if (hit) return hit;
    const fc = await fetch(`${BASE}data/states/${iso}.json`).then((r) => r.json());
    const feats: StateFeature[] = fc.features;
    for (const f of feats) {
      annotateCountry(f);
      f.properties.countryName = isoName(iso);
      stateById.set(f.properties.id, f);
    }
    stateCache.set(iso, feats);
    return feats;
  }
  const stateName = (id: string) => stateById.get(id)?.properties.name ?? selected?.states.find((x) => x.id === id)?.name ?? id;

  let openIso: string | null = null;
  async function syncOpenCountry() {
    const want = selected ? activeCountry : filters.country;
    if (want !== openIso) {
      openIso = want;
      const feats = want ? await loadStates(want) : [];
      if (openIso !== want) return; // superseded while loading
      stage.setStates(feats.length ? feats : null);
    }
    const marked = new Set(selected && openIso ? selected.states.filter((x) => x.iso === openIso).map((x) => x.id) : []);
    stage.setStateMarks(selected ? activeState : filters.state, marked);
    stage.setRangeDetail(selected && activeState ? 'state' : selected && activeCountry ? 'country' : 'range');
  }

  // ---------- camera ----------
  function fly(target: Pov, ms: number) {
    stage.flyTo(target, ms);
  }

  /** Rotate first, then dive: the move reads as "go there", then "look closer". */
  function flyTwoStage(target: Pov) {
    const token = ++flightToken;
    const cur = stage.pov();
    const rotateAlt = Math.max(cur.altitude, Math.min(2.2, target.altitude + 0.9));
    fly({ lat: target.lat, lng: target.lng, altitude: rotateAlt }, 1200);
    if (reduced) return fly(target, 0);
    window.setTimeout(() => {
      if (token === flightToken) fly(target, 1500);
    }, 950);
  }


  // ---------- selecting animals ----------
  const pointCache = new Map<number, number[][]>();
  async function loadPoints(s: Species): Promise<number[][]> {
    const hit = pointCache.get(s.id);
    if (hit) return hit;
    const pts: number[][] = await fetch(`${BASE}data/points/${s.id}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    pointCache.set(s.id, pts);
    return pts;
  }

  async function loadRange(s: Species): Promise<Cell[]> {
    const hit = cache.get(s.id);
    if (hit) return hit;
    const cells: Cell[] = await fetch(`${BASE}data/range/${s.id}.json`).then((r) => r.json());
    cache.set(s.id, cells);
    return cells;
  }

  /**
   * opts.placeChanged: the place filter just moved under an open animal, so take the new place, not the animal's.
   * opts.stay: the caller is already flying the camera somewhere, so don't fly to the animal's range.
   */
  async function select(s: Species, opts: { placeChanged?: boolean; stay?: boolean } = {}) {
    // Zoomed into a place? Stay there: from a country/state filter, or while another animal is open at a place.
    const fromFilter = (!selected || opts.placeChanged) && filters.country ? { iso: filters.country, state: filters.state } : null;
    const keep = fromFilter ?? (selected && activeCountry ? { iso: activeCountry, state: activeState } : null);
    const atPin = !!near && !keep; // opened from the list of animals near a pin: stay at the pin
    if (!selected) animalHome = stage.pov();
    if (fromFilter) placeEntry = fromFilter;
    else if (!keep || !placeEntry || keep.iso !== placeEntry.iso || keep.state !== placeEntry.state) placeEntry = null;
    stage.stopAutoRotate();
    selected = s;
    shownPoints = 0;
    activeCountry = keep?.iso ?? null;
    activeState = keep?.state ?? null;
    const idx = list.findIndex((x) => x.id === s.id);
    if (idx >= 0) activeIdx = idx;
    history.replaceState(null, '', `#${s.id}`);
    stage.setRangeCountries(s.iso, activeCountry);
    syncOpenCountry();
    renderIndex();
    renderPlate();
    buildPins(s);
    document.body.classList.add('has-plate');
    stage.shiftTo(...offset(true), 700);

    const [cells, pts] = await Promise.all([loadRange(s), loadPoints(s)]);
    if (selected?.id !== s.id) return;
    stage.showRange(cells, pts);
    shownPoints = pts.length;
    if (rangeMode === 'points') renderPlate(); // the legend counts the points
    animalPov = rangePov(cells);
    if (!keep && !opts.stay && !atPin) flyTwoStage(animalPov);
  }

  /** From a country or state, zoom out to everywhere the open animal lives. */
  function showFullRange() {
    if (!selected || !animalPov) return;
    activeCountry = null;
    activeState = null;
    placeEntry = null;
    stage.setRangeCountries(selected.iso, null);
    syncOpenCountry();
    renderPlate();
    flyTwoStage(animalPov);
  }

  function deselect() {
    flightToken++;
    selected = null;
    activeCountry = null;
    activeState = null;
    placeEntry = null;
    animalPov = null;
    stage.clearRange();
    stage.setRangeCountries([], null);
    syncOpenCountry();
    pins.innerHTML = '';
    plate.hidden = true;
    plate.innerHTML = '';
    blockersDirty = true;
    document.body.classList.remove('has-plate');
    hideLeader();
    stage.shiftTo(...offset(false, !!near), 600);
    history.replaceState(null, '', location.pathname + location.search);
    renderIndex();
    if (animalHome) fly(animalHome, 1500);
    animalHome = null;
  }

  function zoomCountry(iso: string) {
    const c = byIso.get(iso);
    if (!c || !selected) return;
    flightToken++;
    activeCountry = iso;
    activeState = null;
    frameDirty = true;
    stage.setRangeCountries(selected.iso, iso);
    syncOpenCountry();
    fly(countryPov(c), 1300);
    renderPlate();
  }

  /** Zoom to one state of the open country. With an animal open this reads its records there; otherwise it filters the catalogue. */
  function zoomState(id: string) {
    const f = stateById.get(id);
    if (!f) return;
    flightToken++;
    if (selected) {
      activeState = id;
      renderPlate();
    } else {
      filters.state = id;
      refresh();
    }
    syncOpenCountry();
    fly(countryPov(f), 1200);
  }

  /**
   * Browsing by place with an animal open: picking a different country or state on the globe moves the place filter
   * there and opens the first animal listed for it, so the list and the open animal always match the place.
   */
  function movePlace(iso: string, state: string | null) {
    const target = state ? stateById.get(state) : byIso.get(iso);
    if (!target) return;
    flightToken++;
    if (iso !== filters.country) stage.setFilterCountry(iso);
    filters.country = iso;
    filters.state = state;
    refresh();
    const pov = countryPov(target);
    if (list[0]) {
      select(list[0], { placeChanged: true });
      animalHome = pov; // Esc from here closes the animal and stays at this place
    } else {
      animalHome = null; // nothing lives here: close the animal without flying back to where it was opened
      deselect();
    }
    fly(pov, state ? 1200 : 1300);
  }

  /**
   * Picking a continent under "Where": fly to it and open the first animal listed for it, with the camera staying on
   * the continent. A country or state filter is dropped, since the view is now the whole continent.
   */
  function pickContinent(name: string) {
    filters.continent = name;
    if (near) dropNear();
    if (filters.country) {
      filters.country = null;
      filters.state = null;
      filterHome = null;
      stage.setFilterCountry(null);
    }
    refresh();
    flightToken++;
    stage.stopAutoRotate();
    const pov = CONTINENT_POV[name];
    activeCountry = null; // so the animal opens across its whole range, not zoomed into a country
    activeState = null;
    if (list[0]) {
      select(list[0], { stay: !!pov });
      if (pov) animalHome = pov; // Esc closes the animal and stays on the continent
    } else if (selected) {
      animalHome = null; // nothing listed: close the animal without flying back to where it was opened
      deselect();
    } else syncOpenCountry();
    if (pov) fly(pov, 1500);
    filtersEl.querySelector<HTMLElement>(`button[data-kind="continent"][data-value="${CSS.escape(name)}"]`)?.focus();
  }

  function clearCountryFilter() {
    filters.country = null;
    filters.state = null;
    stage.setFilterCountry(null);
    syncOpenCountry();
    if (!selected && filterHome) fly(filterHome, 1300);
    filterHome = null;
    refresh();
  }

  function clearStateFilter() {
    filters.state = null;
    syncOpenCountry();
    const c = filters.country ? byIso.get(filters.country) : null;
    if (!selected && c) fly(countryPov(c), 1200);
    refresh();
  }

  function back(): boolean {
    if (!creditsEl.hidden) {
      closeCredits();
      return true;
    }
    if (statusKeyOpen) {
      setStatusKey(false);
      return true;
    }
    if (pinArmed) {
      armPin(false);
      return true;
    }
    if (selected && placeEntry && activeCountry === placeEntry.iso && activeState === placeEntry.state) {
      deselect(); // opened from this place: close and stay here
      return true;
    }
    if (activeState && selected && activeCountry) {
      activeState = null;
      syncOpenCountry();
      fly(countryPov(byIso.get(activeCountry)!), 1200);
      renderPlate();
      return true;
    }
    if (activeCountry && selected && animalPov) {
      activeCountry = null;
      stage.setRangeCountries(selected.iso, null);
      syncOpenCountry();
      fly(animalPov, 1300);
      renderPlate();
      return true;
    }
    if (selected) {
      deselect();
      return true;
    }
    if (near) {
      clearNear();
      return true;
    }
    if (filters.state) {
      clearStateFilter();
      return true;
    }
    if (filters.country) {
      clearCountryFilter();
      return true;
    }
    return false;
  }

  stage.onCountryClick((iso) => {
    if (selected) {
      if (filters.country && iso !== filters.country) return movePlace(iso, null);
      // any country, not just the range: the plate says how many records come from it, even none
      if (iso !== activeCountry) zoomCountry(iso);
      return;
    }
    if (filters.country === iso) return;
    if (near) dropNear(); // a country replaces the pin; filterHome still holds the view from before the pin
    if (!filters.country && !filterHome) filterHome = stage.pov();
    filters.country = iso;
    filters.state = null;
    stage.stopAutoRotate();
    stage.setFilterCountry(iso);
    syncOpenCountry();
    const c = byIso.get(iso);
    if (c) fly(countryPov(c), 1300);
    refresh();
  });

  // grabbing the globe also cancels the second half of a two-stage fly-in
  stage.onUserControl(() => flightToken++);

  stage.onStateClick((id) => {
    const f = stateById.get(id);
    if (selected && filters.country && f && id !== filters.state) return movePlace(f.properties.iso, id);
    const current = selected ? activeState : filters.state;
    if (id === current) return;
    zoomState(id);
  });

  // ---------- plate ----------
  function scale(status: string) {
    const rungs = ['LC', 'NT', 'VU', 'EN', 'CR'];
    if (!rungs.includes(status)) return '';
    return `<span class="scale" aria-hidden="true">${rungs.map((r) => `<i class="${r === status ? 'on' : ''}">${r}</i>`).join('')}</span>`;
  }

  function renderPlate() {
    const s = selected;
    if (!s) return;
    frameDirty = blockersDirty = true;
    const focusedIso = (document.activeElement as HTMLElement | null)?.dataset?.iso;
    const focusedState = (document.activeElement as HTMLElement | null)?.dataset?.state;
    const c = s.credit;
    // Photos are never cropped. Wide ones run across the top of the plate; upright ones sit beside the name.
    const w = s.imgW ?? 640;
    const h = s.imgH ?? 480;
    const wide = w / h >= 1.15;
    const photo = s.img
      ? `<figure class="photo">
           <img src="${BASE}${s.img}" alt="${esc(s.name)}, ${esc(s.sci)}" width="${w}" height="${h}" decoding="async" />
           ${
             c
               ? `<figcaption>Photo ${esc(c.author)}, ${extLink(c.licenseUrl ?? c.page, esc(c.license))}, ${extLink(c.page, 'Commons')}</figcaption>`
               : ''
           }
         </figure>`
      : '';
    const active = activeCountry ? s.countries.find((x) => x.iso === activeCountry) : null;
    const inCountry = activeCountry ? s.states.filter((x) => x.iso === activeCountry) : [];
    const stateHit = activeState ? s.states.find((x) => x.id === activeState) : null;
    const lower = esc(midSentence(s.name, s.desc));
    const SHOW = 14;
    // the per-state list only makes sense inside the animal's range; elsewhere the note says it is (nearly) absent
    const statesBlock = activeCountry && s.iso.includes(activeCountry)
      ? inCountry.length
        ? `<p class="sub">In ${esc(isoName(activeCountry))}</p><ul class="range-list states">${inCountry
            .slice(0, SHOW)
            .map(
              (x) =>
                `<li><button type="button" data-state="${esc(x.id)}" aria-pressed="${x.id === activeState}">${esc(x.name)}</button></li>`,
            )
            .join('')}${inCountry.length > SHOW ? `<li class="more">and ${inCountry.length - SHOW} more</li>` : ''}</ul>`
        : `<p class="note">No sampled records place it in a particular state of ${esc(isoName(activeCountry))}.</p>`
      : '';
    // where Esc goes from here: back to the list you came from, or one level out
    const atEntry = !!placeEntry && placeEntry.iso === activeCountry && placeEntry.state === activeState;
    const escHint = atEntry ? 'Esc closes it and keeps you here.' : `Esc pulls back to ${esc(isoName(activeCountry ?? ''))}.`;
    const note = activeState
      ? stateHit
        ? `${Math.round(stateHit.share * 1000) / 10}% of the sampled ${lower} records are from ${esc(stateHit.name)}. ${escHint}`
        : `None of the sampled ${lower} records are from ${esc(stateName(activeState))}. ${escHint}`
      : active
        ? `${Math.round(active.share * 100)}% of ${lower} records are from ${esc(isoName(active.iso))}. Pick a state below or on the globe${atEntry ? '; Esc closes it and keeps you here.' : ', or press Esc to pull back.'}`
        : activeCountry
          ? `Few or no wild ${lower} records come from ${esc(isoName(activeCountry))}.`
          : 'Choose a country, or click one outlined on the globe, to look closer.';
    const fullRange = activeCountry
      ? `<p class="note"><button type="button" class="textlink" data-action="full-range">See its whole range</button></p>`
      : '';
    plate.innerHTML = `
      <div class="plate-bar">
        <button class="back" type="button" id="back">← Back <kbd>Esc</kbd></button>
        <span class="modes" role="group" aria-label="Show the range as">
          <button type="button" data-mode="heat" aria-pressed="${rangeMode === 'heat'}">Heatmap</button>
          <button type="button" data-mode="points" aria-pressed="${rangeMode === 'points'}">Points</button>
        </span>
      </div>
      <p class="plate-no">No. ${s.no} · ${esc(s.group)} · ${esc(s.family)}</p>
      <div class="plate-head${s.img && wide ? ' is-wide' : ''}">
        ${photo}
        <div class="titles">
          <h2>${esc(s.name)}</h2>
          <p class="sci">${esc(s.sci)}</p>
          <p class="status">${scale(s.status)}<span>${STATUS_LABEL[s.status] ?? s.status}</span></p>
        </div>
      </div>
      <p class="desc">${esc(s.desc)}</p>
      <dl class="facts">
        ${nearFact(s)}
        <div><dt>Range</dt><dd><ul class="range-list">${s.countries
          .map(
            (x) =>
              `<li><button type="button" data-iso="${x.iso}" aria-pressed="${x.iso === activeCountry}">${esc(isoName(x.iso))}</button></li>`,
          )
          .join('')}</ul>
          ${statesBlock}
          <p class="note">${note}</p>${fullRange}</dd></div>
        <div><dt>Records</dt><dd>${nf.format(s.occurrences)} georeferenced observations on GBIF</dd></div>
        <div><dt>Map</dt><dd>
          ${
            rangeMode === 'heat'
              ? `<span class="legend" aria-hidden="true">${HEAT_BANDS.slice(1)
                  .map(([r, g, b, a]) => `<i style="background:rgba(${r},${g},${b},${a})"></i>`)
                  .join('')}</span>
                 <span class="legend-ends" aria-hidden="true"><span>fewer records</span><span>more</span></span>
                 <p class="note">Where wild records are densest. Zoomed out it is smoothed over about 2°; zoomed in it is redrawn from the individual records, with the shading relative to what is in view. It follows where people look as well as where the animal lives, so treat it as a guide, not a population count.</p>`
              : `<p class="legend-point"><i aria-hidden="true"></i>One wild record${shownPoints ? ` · ${nf.format(shownPoints)} shown` : ''}</p>
                 <p class="note">Each point is a record from the GBIF sample, rounded to ${
                   s.pointsRounding === 0.1
                     ? 'about 11 km, because this animal is threatened and exact locations can help poachers'
                     : 'about 1 km'
                 }. Repeat sightings at the same spot show as one point.</p>`
          }
        </dd></div>
      </dl>
      <p class="prov">Where it lives is drawn from GBIF occurrence records (a sample of ${nf.format(s.sampled)}, grouped into 2° cells), not an expert range map. ${s.captiveExcluded ? `${plural(s.captiveExcluded, 'record', 'records')} GBIF flags as captive or managed ${s.captiveExcluded === 1 ? 'is' : 'are'} left out; ` : ''}unflagged zoo animals can still slip through, so edges are approximate. Data from ${s.datasets
        .map((d) => (d.doi ? `<a href="https://doi.org/${esc(d.doi.replace(/^doi:/, ''))}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)))
        .join('; ')}. Conservation category: IUCN Red List via GBIF. ${
        s.wiki ? `Text: ${extLink(s.wiki, 'Wikipedia')}, CC BY-SA 4.0.` : ''
      }</p>`;
    plate.hidden = false;
    if (focusedIso) plate.querySelector<HTMLElement>(`button[data-iso="${focusedIso}"]`)?.focus();
    if (focusedState) plate.querySelector<HTMLElement>(`button[data-state="${CSS.escape(focusedState)}"]`)?.focus();
  }

  /** With a pin down: how close this animal's nearest sampled record is to it. */
  function nearFact(s: Species) {
    const hit = near?.hits?.get(s.id);
    if (!near || !hit) return '';
    const where = near.you ? 'you' : 'your pin';
    return `<div class="near-fact"><dt>Near</dt><dd><strong>${fmtKm(hit.km)}</strong> from ${where} to its nearest sampled wild record${
      hit.close ? `, with ${plural(hit.close, 'record', 'records')} within ${CLOSE_KM} km` : ''
    }.<p class="note">${
      offRange(s)
        ? `Few of its sampled records come from ${esc(near.continent!)}. Records like these are often zoo, park or escaped animals that GBIF doesn’t flag, or a part of its range that people rarely record. `
        : ''
    }${
      s.pointsRounding === 0.1 ? 'Records of this threatened animal are rounded to about 11 km, so the distance is too. ' : ''
    }A sample of records, not every sighting: it could well be closer.</p></dd></div>`;
  }

  plate.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#back')) return void back();
    if (t.closest('[data-action="full-range"]')) return void showFullRange();
    const mb = t.closest<HTMLElement>('button[data-mode]');
    if (mb) {
      rangeMode = mb.dataset.mode === 'points' ? 'points' : 'heat';
      try {
        localStorage.setItem('arf.rangeMode', rangeMode);
      } catch {
        // storage blocked: the choice just won't be remembered
      }
      stage.setRangeMode(rangeMode);
      renderPlate();
      plate.querySelector<HTMLElement>(`button[data-mode="${rangeMode}"]`)?.focus();
      return;
    }
    const sb = t.closest<HTMLElement>('button[data-state]');
    if (sb?.dataset.state) {
      if (sb.dataset.state === activeState) back();
      else loadStates(activeCountry!).then(() => zoomState(sb.dataset.state!));
      return;
    }
    const b = t.closest<HTMLElement>('button[data-iso]');
    if (b?.dataset.iso) {
      if (b.dataset.iso === activeCountry) back();
      else zoomCountry(b.dataset.iso);
    }
  });

  // ---------- pins + leader line ----------
  type Pin = { el: HTMLElement; iso: string };
  let pinList: Pin[] = [];
  const statePin = document.createElement('span');
  statePin.className = 'pin hot';
  function buildPins(s: Species) {
    pins.innerHTML = '';
    pins.appendChild(statePin);
    pinList = [];
    for (const iso of s.iso) {
      const c = byIso.get(iso);
      if (!c) continue;
      const el = document.createElement('span');
      el.className = 'pin';
      el.dataset.name = c.properties.name;
      pins.appendChild(el);
      pinList.push({ el, iso });
    }
  }

  function hideLeader() {
    leaderSvg.classList.remove('on');
  }

  let leaderShownFor = -1;
  // Where the text around the globe sits. Measuring it every frame forces layout, so it is cached and refreshed
  // only when the page changes shape (resize, plate rendered, panels toggled).
  let blockers: DOMRect[] = [];
  const markLayout = () => (blockersDirty = true);
  window.addEventListener('resize', markLayout);
  plate.addEventListener('scroll', markLayout, { passive: true });

  stage.onFrame((moved) => {
    if (!selected) return;
    if (!moved && !frameDirty && !blockersDirty) return;
    frameDirty = false;
    if (blockersDirty) {
      blockersDirty = false;
      blockers = [plate, results.parentElement!, q.closest('.finder')!, document.querySelector('.mast')!, creditsBtn]
        .filter((el) => !(el as HTMLElement).hidden && getComputedStyle(el).display !== 'none')
        .map((el) => el.getBoundingClientRect());
    }
    // country labels, kept out from under the text around the globe
    const covered = (x: number, y: number) =>
      blockers.some((r) => x > r.left - 40 && x < r.right + 40 && y > r.top - 12 && y < r.bottom + 12);
    const alt = stage.pov().altitude;
    for (const p of pinList) {
      const c = byIso.get(p.iso)!;
      const pt = stage.project(c.center!.lat, c.center!.lng);
      const show =
        pt.visible && !covered(pt.x, pt.y) && (activeCountry ? p.iso === activeCountry || alt > 1.1 : true);
      p.el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
      p.el.classList.toggle('on', show);
      p.el.classList.toggle('hot', p.iso === activeCountry && !activeState);
      if (activeState && p.iso === activeCountry) p.el.classList.remove('on');
    }
    const st = activeState ? stateById.get(activeState) : null;
    if (st) {
      const sp = stage.project(st.center!.lat, st.center!.lng);
      statePin.dataset.name = st.properties.name;
      statePin.style.transform = `translate(${sp.x.toFixed(1)}px, ${sp.y.toFixed(1)}px)`;
      statePin.classList.toggle('on', sp.visible && !covered(sp.x, sp.y));
    } else statePin.classList.remove('on');
    // leader from the range centre to the plate
    if (!animalPov || !wide()) return hideLeader();
    const st2 = activeState ? stateById.get(activeState) : null;
    const target = st2 ? st2.center! : activeCountry ? byIso.get(activeCountry)!.center! : animalPov;
    const pt = stage.project(target.lat, target.lng);
    const anchor = plate.querySelector('.titles, .plate-head');
    if (!anchor || plate.hidden) return hideLeader();
    const r = anchor.getBoundingClientRect();
    const ax = r.left - 22;
    const ay = r.top + 30;
    if (!pt.visible || pt.x > ax - 30) return hideLeader();
    const bendX = Math.min(ax - 10, pt.x + 46);
    leaderLine.setAttribute('d', `M${pt.x.toFixed(1)} ${pt.y.toFixed(1)} L${bendX.toFixed(1)} ${ay.toFixed(1)} L${ax.toFixed(1)} ${ay.toFixed(1)}`);
    leaderDot.setAttribute('cx', pt.x.toFixed(1));
    leaderDot.setAttribute('cy', pt.y.toFixed(1));
    leaderRing.setAttribute('cx', pt.x.toFixed(1));
    leaderRing.setAttribute('cy', pt.y.toFixed(1));
    if (leaderShownFor !== selected.id) {
      leaderShownFor = selected.id;
      leaderSvg.classList.remove('on');
      void leaderSvg.getBoundingClientRect();
    }
    leaderSvg.classList.add('on');
  });

  // ---------- what lives here ----------
  const findNear = createNear(BASE, byId, loadPoints);
  const pickCountries = countries.map(toPickable);
  const here = document.createElement('div');
  here.className = 'here';
  here.setAttribute('aria-hidden', 'true');
  document.body.appendChild(here);

  function armPin(on: boolean) {
    pinArmed = on;
    nearNote = '';
    stage.setPinMode(on);
    renderFilters();
    filtersEl.querySelector<HTMLElement>(`button[data-kind="${on ? 'pin-cancel' : 'pin'}"]`)?.focus();
  }

  async function setNear(lat: number, lng: number, you: boolean) {
    if (pinArmed) {
      pinArmed = false;
      stage.setPinMode(false);
    }
    if (selected) {
      animalHome = null; // close the animal where we are; the camera is about to fly to the pin
      deselect();
    }
    if (filters.country) {
      filters.country = null;
      filters.state = null;
      stage.setFilterCountry(null);
      syncOpenCountry();
    }
    if (!filterHome) filterHome = stage.pov(); // Esc clears the pin and comes back here
    const token = ++nearToken;
    const place = pickAt(pickCountries, lat, lng);
    // Natural Earth files all of Russia under Europe; the catalogue splits it at the Urals (60°E), so do the same
    const continent = !place || /^Seven seas/.test(place.properties.continent)
      ? null
      : place.properties.iso === 'RU'
        ? lng >= 60 ? 'Asia' : 'Europe'
        : place.properties.continent;
    const point = { lat, lng, you, continent, label: place?.properties.name ?? '', hits: null as Map<number, NearHit> | null };
    near = point;
    nearNote = '';
    flightToken++;
    stage.stopAutoRotate();
    fly({ lat, lng, altitude: 0.34 }, 1400);
    stage.shiftTo(...offset(false, true), 600);
    refresh();
    try {
      point.hits = await findNear(lat, lng);
    } catch (err) {
      console.error(err);
      if (token !== nearToken) return;
      dropNear();
      nearNote = 'The list of nearby animals could not be loaded.';
      return refresh();
    }
    if (token === nearToken) refresh();
  }

  /** Forget the pin without moving the camera (something else is taking over the view). */
  function dropNear() {
    nearToken++;
    near = null;
    if (!selected) stage.shiftTo(...offset(false), 600); // phones: the globe no longer needs lifting above the list
  }

  function clearNear() {
    dropNear();
    if (!selected && filterHome) fly(filterHome, 1300);
    filterHome = null;
    refresh();
    filtersEl.querySelector<HTMLElement>('button[data-kind="pin"]')?.focus();
  }

  function locate() {
    if (!('geolocation' in navigator)) {
      nearNote = 'This browser can’t share a location. Drop a pin instead.';
      return renderFilters();
    }
    nearNote = 'finding you…';
    renderFilters();
    navigator.geolocation.getCurrentPosition(
      (p) => setNear(p.coords.latitude, p.coords.longitude, true),
      (err) => {
        nearNote =
          err.code === err.PERMISSION_DENIED
            ? 'Location is off for this page. Drop a pin instead.'
            : 'Couldn’t find your location. Drop a pin instead.';
        renderFilters();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 },
    );
  }

  stage.onPinDrop((lat, lng) => setNear(lat, lng, false));
  stage.onFrame(() => {
    if (!near) return void here.classList.remove('on');
    const pt = stage.project(near.lat, near.lng);
    here.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
    here.classList.toggle('on', pt.visible);
  });

  // ---------- readout ----------
  let readoutQueued = false;
  stage.onMove((p) => {
    if (readoutQueued) return;
    readoutQueued = true;
    requestAnimationFrame(() => {
      readoutQueued = false;
      const ns = p.lat >= 0 ? 'N' : 'S';
      const ew = p.lng >= 0 ? 'E' : 'W';
      readout.textContent = `LAT ${Math.abs(p.lat).toFixed(1).padStart(4, '0')}°${ns}  LON ${Math.abs(p.lng).toFixed(1).padStart(5, '0')}°${ew}  ALT ${p.altitude.toFixed(2)}R`;
    });
  });

  // ---------- credits ----------
  function openCredits() {
    creditsEl.hidden = false;
    blockersDirty = true;
    creditsBtn.setAttribute('aria-expanded', 'true');
    $('credits-close').focus();
  }
  function closeCredits() {
    creditsEl.hidden = true;
    blockersDirty = true;
    creditsBtn.setAttribute('aria-expanded', 'false');
    creditsBtn.focus();
  }
  creditsBtn.addEventListener('click', () => (creditsEl.hidden ? openCredits() : closeCredits()));
  $('credits-close').addEventListener('click', closeCredits);

  // ---------- input ----------
  q.addEventListener('input', refresh);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive(activeIdx + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive(activeIdx - 1));
    else if (e.key === 'Enter' && list[activeIdx]) (e.preventDefault(), select(list[activeIdx]));
    else if (e.key === 'Escape') {
      if (q.value && !selected) {
        q.value = '';
        refresh();
        e.stopPropagation();
      }
    }
  });
  results.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li');
    if (li) select(list[Number(li.dataset.i)]);
  });
  results.addEventListener('mousemove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li');
    if (li && Number(li.dataset.i) !== activeIdx) setActive(Number(li.dataset.i), false);
  });

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      q.focus();
      q.select();
    } else if (e.key === 'Escape') {
      if (back()) e.preventDefault();
      else q.blur();
    }
  });
  window.addEventListener('resize', () => {
    stage.resize();
    stage.shiftTo(...offset(!!selected, !!near), 0);
  });

  // ---------- go ----------
  stage.shiftTo(...offset(false), 0);
  refresh();
  const fromHash = byId.get(Number(location.hash.slice(1)));
  if (fromHash) select(fromHash);
  document.body.classList.add('ready');
}

boot().catch((err) => {
  console.error(err);
  document.body.classList.add('failed');
  const p = document.createElement('p');
  p.className = 'fatal';
  p.textContent = 'The catalogue could not be loaded. Run npm run data, then reload.';
  document.body.appendChild(p);
});
