/**
 * "The catalogue in numbers": a dashboard counted from species.json. It describes the animals in this catalogue, not
 * animals in general, and says so. Every bar is a button that filters the globe (or opens an animal).
 */
import { barList, columns, compact, groupPlural, isThreatened, pct } from './charts';
import { esc, nf } from './html';
import { STATUS_LABEL, STATUS_NOTE, type Species } from './types';

export interface OverviewDeps {
  root: HTMLElement;
  species: Species[];
  reduced: boolean;
  /** the continents the Where filter offers, with their short names */
  continents: Record<string, string>;
  statusOrder: string[];
  onStatus(code: string): void;
  onContinent(name: string): void;
  onGroup(name: string): void;
  onOpen(s: Species): void;
  onPlay(): void;
}

export function createOverview(d: OverviewDeps) {
  const { root, species } = d;
  let built = false;

  /** All the numbers in one place, so the text and the charts can't disagree. */
  function stats() {
    const total = species.length;
    const records = species.reduce((n, s) => n + s.occurrences, 0);
    const threatened = species.filter(isThreatened).length;
    const countries = new Set(species.flatMap((s) => s.iso)).size;

    const byStatus = d.statusOrder
      .map((c) => [c, species.filter((s) => s.status === c).length] as const)
      .filter(([, n]) => n > 0);

    const groups = new Map<string, number>();
    for (const s of species) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
    const byGroup = [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const byContinent = Object.keys(d.continents)
      .map((c) => {
        const here = species.filter((s) => s.continents.includes(c));
        return { name: c, n: here.length, hot: here.filter(isThreatened).length };
      })
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n);

    const ranked = [...species].sort((a, b) => b.occurrences - a.occurrences);
    const spread = species.map((s) => s.countries.length);
    return { total, records, threatened, countries, byStatus, byGroup, byContinent, ranked, spread };
  }

  function build() {
    const st = stats();
    const { total } = st;

    // ---- status
    const statusRows = st.byStatus
      .map(
        ([c, n]) =>
          `<li><button type="button" data-act="status:${c}" title="${esc(STATUS_NOTE[c] ?? '')}"><i class="swatch" style="--c:var(--st-${c})"></i><b>${c}</b><span class="lbl">${esc(STATUS_LABEL[c])}</span><span class="n">${n}</span><span class="p">${pct(n / total)}</span></button></li>`,
      )
      .join('');
    const strip = st.byStatus.map(([c, n]) => `<i style="flex:${n};--c:var(--st-${c})" title="${esc(STATUS_LABEL[c])}: ${n}"></i>`).join('');

    // ---- kinds
    const [g1, g2] = st.byGroup;
    const groupLine = g2
      ? `${groupPlural(g1[0])} and ${groupPlural(g2[0]).toLowerCase()} make up ${pct((g1[1] + g2[1]) / total)} of the catalogue.`
      : '';
    const groupRows = barList(
      st.byGroup.map(([g, n]) => ({ id: g, label: groupPlural(g), value: n, end: String(n) })),
      'group',
      g1[1],
    );

    // ---- continents
    const big = st.byContinent.filter((c) => c.n >= 20);
    const worst = [...big].sort((a, b) => b.hot / b.n - a.hot / a.n)[0];
    const best = [...big].sort((a, b) => a.hot / a.n - b.hot / b.n)[0];
    const continentLine =
      worst && best && worst !== best
        ? `${d.continents[worst.name]} has the highest share of threatened animals here (${pct(worst.hot / worst.n)}); ${d.continents[best.name]} the lowest (${pct(best.hot / best.n)}).`
        : '';
    const continentRows = barList(
      st.byContinent.map((c) => ({
        id: c.name,
        label: c.name,
        value: c.n,
        hot: c.hot,
        end: `${c.hot} / ${c.n}`,
        title: `${c.hot} of the ${c.n} animals recorded in ${c.name} are threatened`,
      })),
      'continent',
      st.byContinent[0].n,
    );

    // ---- most and least recorded
    const TOP = 8;
    const top = st.ranked.slice(0, TOP);
    const bottom = st.ranked.slice(-4).reverse();
    const lead = st.ranked.slice(0, 10);
    const leadGroups = new Map<string, number>();
    for (const s of lead) leadGroups.set(s.group, (leadGroups.get(s.group) ?? 0) + 1);
    const [leadGroup, leadN] = [...leadGroups].sort((a, b) => b[1] - a[1])[0];
    const recordLine =
      leadN === lead.length
        ? `All ten of the most recorded animals are ${groupPlural(leadGroup).toLowerCase()}.`
        : `${leadN} of the ten most recorded animals are ${groupPlural(leadGroup).toLowerCase()}.`;
    const peak = st.ranked[0].occurrences;
    const recRow = (s: Species) => ({ id: String(s.id), label: s.name, value: s.occurrences, end: compact(s.occurrences), title: `${nf.format(s.occurrences)} records` });

    // ---- homebodies and wanderers
    const one = st.spread.filter((n) => n === 1).length;
    const most = Math.max(...st.spread);
    const widest = species.filter((s) => s.countries.length === most);

    const tile = (n: number, label: string, fmt = 'int') =>
      `<div class="tile"><b data-count="${n}" data-fmt="${fmt}">${fmt === 'compact' ? compact(n) : nf.format(n)}</b><span>${label}</span></div>`;

    root.innerHTML = `
      <button class="credits-close" id="numbers-close" type="button">Close <span aria-hidden="true">Esc</span></button>
      <h2>The catalogue <em>in numbers</em></h2>
      <p class="lede">Counted from the catalogue itself. These are the ${nf.format(total)} animals here, not all animals, and every figure follows where people record wildlife. Press any bar to see those animals on the globe.</p>
      <div class="tiles">
        ${tile(total, 'animals')}
        ${tile(st.records, 'wild records on GBIF', 'compact')}
        ${tile(st.threatened, `threatened (${pct(st.threatened / total)})`)}
        ${tile(st.countries, 'countries with records')}
      </div>
      <div class="cards">
        <section class="card">
          <h3>How at risk are they?</h3>
          <p class="take"><strong>${pct(st.threatened / total)}</strong> of the catalogue is threatened: ${st.threatened} animals are critically endangered, endangered or vulnerable.</p>
          <div class="strip" aria-hidden="true">${strip}</div>
          <ul class="legend-rows">${statusRows}</ul>
          <p class="note">IUCN Red List status as republished by GBIF. It can lag the Red List.</p>
        </section>
        <section class="card">
          <h3>What kind of animals?</h3>
          <p class="take">${esc(groupLine)}</p>
          ${groupRows}
        </section>
        <section class="card">
          <h3>Where are the threatened ones?</h3>
          <p class="take">${esc(continentLine)}</p>
          ${continentRows}
          <p class="note"><i class="swatch" style="--c:var(--accent)"></i> threatened · <i class="swatch" style="--c:var(--bar)"></i> the rest. An animal counts on every continent it is recorded on.</p>
        </section>
        <section class="card">
          <h3>Who gets recorded most?</h3>
          <p class="take">${esc(recordLine)} Records follow observers, so this shows who is watched, not who is most common.</p>
          ${barList(top.map(recRow), 'open', peak)}
          <p class="sub">And the least recorded</p>
          ${barList(bottom.map(recRow), 'open', peak)}
        </section>
        <section class="card wide">
          <h3>Homebodies and wanderers</h3>
          <p class="take"><strong>${one}</strong> animals are recorded in just one country. ${
            widest.length === 1
              ? `The ${esc(widest[0].name)} is recorded in the most, ${most}.`
              : `${esc(widest[0].name)} and ${widest.length > 2 ? `${widest.length - 1} others` : esc(widest[1].name)} lead with ${most}.`
          }</p>
          ${columns(st.spread, (k) => `${k} ${k === 1 ? 'country' : 'countries'}`)}
          <p class="note">Animals by the number of countries that hold at least a fair share of their records. Taller means more animals.</p>
        </section>
        <section class="card wide play">
          <h3>Think you know where they live?</h3>
          <p class="take">Ten quick rounds. Name an animal from the shading on its range, say who is more recorded, and guess who is in trouble.</p>
          <button type="button" class="cta" data-act="play:">Play the range quiz →</button>
        </section>
      </div>`;
    built = true;
  }

  /** Numbers in the tiles run up from zero, unless the visitor asked for less motion. */
  function countUp() {
    if (d.reduced) return;
    const els = [...root.querySelectorAll<HTMLElement>('[data-count]')];
    const start = performance.now();
    const dur = 900;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - (1 - t) ** 3;
      for (const el of els) {
        const n = Number(el.dataset.count);
        const v = Math.round(n * e);
        el.textContent = el.dataset.fmt === 'compact' ? compact(v) : nf.format(v);
      }
      if (t < 1 && !root.hidden) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#numbers-close')) return void close();
    const b = t.closest<HTMLElement>('[data-act]');
    if (!b) return;
    const [act, ...rest] = b.dataset.act!.split(':');
    const id = rest.join(':');
    close(false);
    if (act === 'status') d.onStatus(id);
    else if (act === 'continent') d.onContinent(id);
    else if (act === 'group') d.onGroup(id);
    else if (act === 'play') d.onPlay();
    else if (act === 'open') {
      const s = species.find((x) => String(x.id) === id);
      if (s) d.onOpen(s);
    }
  });

  let onClose: (() => void) | null = null;
  function open(whenClosed: () => void) {
    if (!built) build();
    onClose = whenClosed;
    root.hidden = false;
    root.scrollTop = 0;
    root.classList.remove('grow');
    void root.offsetWidth; // restart the bars' growing
    root.classList.add('grow');
    countUp();
    root.querySelector<HTMLElement>('#numbers-close')?.focus();
  }
  /** `refocus`: give focus back to what opened it (not wanted when a click inside already sent the visitor elsewhere) */
  function close(refocus = true) {
    if (root.hidden) return;
    root.hidden = true;
    if (refocus) onClose?.();
    onClose = null;
  }

  return { open, close, isOpen: () => !root.hidden };
}
