import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

import { createStage } from './stage';
import { createSearch, type Filters } from './search';
import { annotateCountry, countryPov, rangePov } from './geo';
import { STATUS_LABEL, type Cell, type Country, type Pov, type Species, type StateFeature } from './types';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const nf = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many: string) => `${nf.format(n)} ${n === 1 ? one : many}`;
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
/** On phones the sheet covers the lower half, so the globe is lifted into the space above it. */
const offset = (plateOpen: boolean): [number, number] =>
  wide() ? [plateOpen ? 40 : 0, 0] : [0, Math.round(window.innerHeight * (plateOpen ? 0.27 : 0.2))];

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
  // Where the camera was before we moved it, one for each layer Back can undo.
  let animalHome: Pov | null = null;
  let filterHome: Pov | null = null;
  let animalPov: (Pov & { spread: number }) | null = null;
  let flightToken = 0;
  // Per-frame label/leader work only runs when the camera moved or one of these says something changed.
  let frameDirty = true;
  let blockersDirty = true; // the text panels around the globe moved or changed size
  let cache = new Map<number, Cell[]>();

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
          <span class="la">${esc(s.sci)}</span>
        </li>`,
      )
      .join('');
    empty.hidden = list.length > 0;
    tally.textContent = `${list.length}/${species.length}`;
    q.setAttribute('aria-activedescendant', list[activeIdx] ? `opt-${list[activeIdx].id}` : '');
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
    activeIdx = 0;
    renderIndex();
    renderFilters();
  }

  // ---------- filters ----------
  function renderFilters() {
    blockersDirty = true;
    const continents = [...new Set(species.flatMap((s) => s.continents))].filter((c) => CONTINENT_SHORT[c]);
    const statuses = STATUS_ORDER.filter((c) => species.some((s) => s.status === c));
    const btn = (kind: string, value: string | null, label: string, on: boolean) =>
      `<button type="button" data-kind="${kind}" data-value="${value ?? ''}" aria-pressed="${on}">${esc(label)}</button>`;
    filtersEl.innerHTML = `
      <div class="frow"><span class="flabel">Where</span>${btn('continent', null, 'All', !filters.continent)}${continents
        .map((c) => btn('continent', c, CONTINENT_SHORT[c], filters.continent === c))
        .join('')}</div>
      <div class="frow"><span class="flabel">Status</span>${btn('status', null, 'All', !filters.status)}${statuses
        .map((c) => btn('status', c, c, filters.status === c))
        .join('')}</div>
      <div class="frow place${filters.country ? ' is-set' : ''}"><span class="flabel">Place</span>${
        filters.country
          ? btn('country', null, `${isoName(filters.country)} ✕`, true) +
            (filters.state
              ? `<span class="crumb" aria-hidden="true">›</span>${btn('state', null, `${stateName(filters.state)} ✕`, true)}`
              : stateIndex[filters.country]
                ? '<span class="hint">now pick a state on the globe</span>'
                : '')
          : '<span class="hint">click a country on the globe, then a state</span>'
      }</div>`;
  }

  filtersEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const kind = b.dataset.kind as keyof Filters;
    const value = b.dataset.value || null;
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
  async function loadRange(s: Species): Promise<Cell[]> {
    const hit = cache.get(s.id);
    if (hit) return hit;
    const cells: Cell[] = await fetch(`${BASE}data/range/${s.id}.json`).then((r) => r.json());
    cache.set(s.id, cells);
    return cells;
  }

  async function select(s: Species) {
    // Zoomed into a place? Stay there: from a country/state filter, or while another animal is open at a place.
    const fromFilter = !selected && filters.country ? { iso: filters.country, state: filters.state } : null;
    const keep = fromFilter ?? (selected && activeCountry ? { iso: activeCountry, state: activeState } : null);
    if (!selected) animalHome = stage.pov();
    if (fromFilter) placeEntry = fromFilter;
    else if (!keep || !placeEntry || keep.iso !== placeEntry.iso || keep.state !== placeEntry.state) placeEntry = null;
    stage.stopAutoRotate();
    selected = s;
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

    const cells = await loadRange(s);
    if (selected?.id !== s.id) return;
    stage.showRange(cells);
    animalPov = rangePov(cells);
    if (!keep) flyTwoStage(animalPov);
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
    stage.shiftTo(...offset(false), 600);
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
      // any country, not just the range: the plate says how many records come from it, even none
      if (iso !== activeCountry) zoomCountry(iso);
      return;
    }
    if (filters.country === iso) return;
    if (!filters.country) filterHome = stage.pov();
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
               ? `<figcaption>Photo ${esc(c.author)}, <a href="${esc(c.licenseUrl ?? c.page)}" target="_blank" rel="noopener">${esc(c.license)}</a>, <a href="${esc(c.page)}" target="_blank" rel="noopener">Commons</a></figcaption>`
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
      <button class="back" type="button" id="back">← Back <kbd>Esc</kbd></button>
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
        <div><dt>Range</dt><dd><ul class="range-list">${s.countries
          .map(
            (x) =>
              `<li><button type="button" data-iso="${x.iso}" aria-pressed="${x.iso === activeCountry}">${esc(isoName(x.iso))}</button></li>`,
          )
          .join('')}</ul>
          ${statesBlock}
          <p class="note">${note}</p>${fullRange}</dd></div>
        <div><dt>Records</dt><dd>${nf.format(s.occurrences)} georeferenced observations on GBIF</dd></div>
      </dl>
      <p class="prov">Where it lives is drawn from GBIF occurrence records (a sample of ${nf.format(s.sampled)}, each dot is a 2° cell sized by how many records fall in it), not an expert range map. ${s.captiveExcluded ? `${plural(s.captiveExcluded, 'record', 'records')} GBIF flags as captive or managed ${s.captiveExcluded === 1 ? 'is' : 'are'} left out; ` : ''}unflagged zoo animals can still slip through, so edges are approximate. Data from ${s.datasets
        .map((d) => (d.doi ? `<a href="https://doi.org/${esc(d.doi.replace(/^doi:/, ''))}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)))
        .join('; ')}. Conservation category: IUCN Red List via GBIF. ${
        s.wiki ? `Text: <a href="${esc(s.wiki)}" target="_blank" rel="noopener">Wikipedia</a>, CC BY-SA 4.0.` : ''
      }</p>`;
    plate.hidden = false;
    if (focusedIso) plate.querySelector<HTMLElement>(`button[data-iso="${focusedIso}"]`)?.focus();
    if (focusedState) plate.querySelector<HTMLElement>(`button[data-state="${CSS.escape(focusedState)}"]`)?.focus();
  }

  plate.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#back')) return void back();
    if (t.closest('[data-action="full-range"]')) return void showFullRange();
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
    stage.shiftTo(...offset(!!selected), 0);
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
