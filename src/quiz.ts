/**
 * A ten-round quiz drawn from the catalogue: name an animal from the shading of its range, say which of two animals has
 * more records, and say whether an animal is threatened. Every answer is read from species.json, so the game can only be
 * as wrong as the data, which the app already shows.
 */
import { isThreatened, pct } from './charts';
import { esc, nf } from './html';
import { STATUS_LABEL, STATUS_NOTE, type Species } from './types';

export interface QuizDeps {
  root: HTMLElement;
  species: Species[];
  base: string;
  isoName(iso: string): string;
  /** draw this animal's range on the globe and bring it into view, without naming it */
  showRange(s: Species): void;
  clearRange(): void;
  /** leave the quiz and open this animal */
  openAnimal(s: Species): void;
  /** the quiz was closed (Esc, Leave, or opening an animal) */
  onClose(): void;
}

type Q =
  | { kind: 'range'; answer: Species; options: Species[] }
  | { kind: 'more'; a: Species; b: Species }
  | { kind: 'risk'; animal: Species };

const ROUNDS = 10;
const ORDER: Q['kind'][] = ['range', 'more', 'risk', 'range', 'range', 'more', 'risk', 'range', 'more', 'risk'];
const BEST_KEY = 'arf.quizBest';

const shuffle = <T>(a: T[]): T[] => {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export function createQuiz(d: QuizDeps) {
  const { root } = d;
  const withPhoto = d.species.filter((s) => s.img);
  const rated = withPhoto.filter((s) => ['LC', 'NT', 'VU', 'EN', 'CR'].includes(s.status));

  let open = false;
  let round = 0;
  let score = 0;
  let streak = 0;
  let bestStreak = 0;
  let questions: Q[] = [];
  let results: boolean[] = [];
  let answered = false;
  let best = 0;
  try {
    best = Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    // storage blocked: the best score just isn't kept
  }

  const overlap = (a: Species, b: Species) => a.iso.filter((i) => b.iso.includes(i)).length;

  function makeRange(used: Set<number>): Q {
    // an animal whose range is small enough to be a fair clue
    const pool = withPhoto.filter((s) => !used.has(s.id) && s.iso.length <= 8);
    const answer = pick(pool);
    const others = withPhoto.filter((s) => s.id !== answer.id && !used.has(s.id));
    // wrong answers live somewhere else, so the shading alone is enough to tell them apart; same kind of animal first
    const clear = shuffle(others.filter((s) => overlap(answer, s) === 0));
    const sameKind = clear.filter((s) => s.group === answer.group);
    let options = [...sameKind, ...clear.filter((s) => s.group !== answer.group)].slice(0, 3);
    if (options.length < 3) {
      const fill = others.filter((s) => !options.includes(s)).sort((a, b) => overlap(answer, a) - overlap(answer, b));
      options = [...options, ...fill].slice(0, 3);
    }
    return { kind: 'range', answer, options: shuffle([answer, ...options]) };
  }

  function makeMore(used: Set<number>): Q {
    const pool = withPhoto.filter((s) => !used.has(s.id));
    for (let i = 0; i < 200; i++) {
      const a = pick(pool);
      const b = pick(pool);
      // far enough apart that the answer is clear
      if (a !== b && Math.max(a.occurrences, b.occurrences) >= 3 * Math.min(a.occurrences, b.occurrences)) return { kind: 'more', a, b };
    }
    const [a, b] = shuffle(pool);
    return { kind: 'more', a, b };
  }

  function makeRisk(used: Set<number>): Q {
    const wantThreatened = Math.random() < 0.5;
    const pool = rated.filter((s) => !used.has(s.id) && isThreatened(s) === wantThreatened);
    return { kind: 'risk', animal: pick(pool) };
  }

  function start() {
    const used = new Set<number>();
    questions = ORDER.map((kind) => {
      const q = kind === 'range' ? makeRange(used) : kind === 'more' ? makeMore(used) : makeRisk(used);
      if (q.kind === 'range') used.add(q.answer.id);
      else if (q.kind === 'more') (used.add(q.a.id), used.add(q.b.id));
      else used.add(q.animal.id);
      return q;
    });
    round = 0;
    score = 0;
    streak = 0;
    bestStreak = 0;
    results = [];
    showRound();
  }

  const img = (s: Species) =>
    s.img ? `<img src="${d.base}${s.img}" alt="" width="${s.imgW ?? 640}" height="${s.imgH ?? 480}" decoding="async" />` : '';
  const progress = () =>
    `<span class="quiz-ticks" aria-hidden="true">${Array.from({ length: ROUNDS }, (_, i) => `<i class="${i < results.length ? (results[i] ? 'ok' : 'no') : i === round ? 'now' : ''}"></i>`).join('')}</span>`;
  const bar = () => `<div class="plate-bar">
      <button class="back" type="button" data-q="leave">← Leave quiz <kbd>Esc</kbd></button>
      <span class="quiz-score">Score <b>${score}</b>${streak > 1 ? ` · Streak <b>${streak}</b>` : ''}</span>
    </div>`;

  function intro() {
    root.innerHTML = `<div class="plate-bar"><button class="back" type="button" data-q="leave">← Close <kbd>Esc</kbd></button></div>
      <p class="plate-no">Quiz · ${ROUNDS} rounds</p>
      <h2 class="quiz-title">Where do they <em>live?</em></h2>
      <p class="desc">Three kinds of question, all answered by the catalogue. Read the shading on the globe, guess who gets recorded more, and say who is in trouble. Keys <kbd>1</kbd> to <kbd>4</kbd> answer, <kbd>Enter</kbd> goes on.</p>
      ${best ? `<p class="note">Your best score: <strong class="accent">${best} of ${ROUNDS}</strong></p>` : ''}
      <p><button type="button" class="cta" data-q="start">Start →</button></p>`;
    root.hidden = false;
  }

  function showRound() {
    answered = false;
    const q = questions[round];
    let body = '';
    if (q.kind === 'range') {
      d.showRange(q.answer);
      body = `<h2 class="quiz-q">Whose range is this?</h2>
        <p class="quiz-sub">The shading on the globe is where people have recorded one of these animals. Turn the globe to look.</p>
        <div class="choices">${q.options.map((s, i) => `<button type="button" class="choice" data-i="${i}"><kbd>${i + 1}</kbd>${img(s)}<span>${esc(s.name)}</span></button>`).join('')}</div>`;
    } else {
      d.clearRange();
      if (q.kind === 'more') {
        body = `<h2 class="quiz-q">Which has more records on GBIF?</h2>
          <p class="quiz-sub">A record is one logged sighting. More records means more people have watched and logged it.</p>
          <div class="choices two">${[q.a, q.b].map((s, i) => `<button type="button" class="choice" data-i="${i}"><kbd>${i + 1}</kbd>${img(s)}<span>${esc(s.name)}</span></button>`).join('')}</div>`;
      } else {
        const s = q.animal;
        body = `<h2 class="quiz-q">Is the ${esc(s.name)} threatened with extinction?</h2>
          <p class="quiz-sub">Threatened means critically endangered, endangered or vulnerable on the IUCN Red List.</p>
          <figure class="quiz-photo">${img(s)}</figure>
          <div class="choices two"><button type="button" class="choice plain" data-i="0"><kbd>1</kbd><span>Yes, threatened</span></button><button type="button" class="choice plain" data-i="1"><kbd>2</kbd><span>No, not threatened</span></button></div>`;
      }
    }
    root.innerHTML = `${bar()}
      <p class="plate-no">Round ${round + 1} of ${ROUNDS} ${progress()}</p>
      ${body}
      <div class="quiz-reveal" aria-live="polite"></div>`;
    root.scrollTop = 0;
  }

  /** The line that explains the answer, in the page's own numbers. */
  function explain(q: Q) {
    if (q.kind === 'range') {
      const a = q.answer;
      const top = a.countries
        .filter((c) => !c.introduced)
        .slice(0, 2)
        .map((c) => `${esc(d.isoName(c.iso))} (${pct(c.share)})`)
        .join(' and ');
      return `<p><strong>${esc(a.name)}.</strong> Most of its records are from ${top || esc(d.isoName(a.countries[0].iso))}.</p>`;
    }
    if (q.kind === 'more') {
      const hi = q.a.occurrences >= q.b.occurrences ? q.a : q.b;
      const lo = hi === q.a ? q.b : q.a;
      return `<p><strong>${esc(hi.name)}: ${nf.format(hi.occurrences)} records</strong>, against ${nf.format(lo.occurrences)} for ${esc(lo.name)}, about ${nf.format(Math.round(hi.occurrences / lo.occurrences))} times as many. Records follow where people watch, so this measures attention, not how many animals there are.</p>`;
    }
    const s = q.animal;
    return `<p><strong>${STATUS_LABEL[s.status]}.</strong> ${esc(STATUS_NOTE[s.status] ?? '')}</p>`;
  }

  function answer(i: number) {
    if (answered) return;
    const q = questions[round];
    let right = false;
    let correctIdx = 0;
    if (q.kind === 'range') {
      correctIdx = q.options.indexOf(q.answer);
      right = i === correctIdx;
    } else if (q.kind === 'more') {
      correctIdx = q.a.occurrences >= q.b.occurrences ? 0 : 1;
      right = i === correctIdx;
    } else {
      correctIdx = isThreatened(q.animal) ? 0 : 1;
      right = i === correctIdx;
    }
    answered = true;
    results.push(right);
    if (right) (score++, streak++, (bestStreak = Math.max(bestStreak, streak)));
    else streak = 0;
    root.querySelectorAll<HTMLButtonElement>('.choice').forEach((b, k) => {
      b.disabled = true;
      b.classList.toggle('right', k === correctIdx);
      b.classList.toggle('wrong', k === i && !right);
    });
    root.querySelector('.plate-no .quiz-ticks')!.outerHTML = progress();
    root.querySelector('.quiz-score')!.innerHTML = `Score <b>${score}</b>${streak > 1 ? ` · Streak <b>${streak}</b>` : ''}`;
    const subject = q.kind === 'range' ? q.answer : q.kind === 'risk' ? q.animal : null;
    const last = round === ROUNDS - 1;
    root.querySelector('.quiz-reveal')!.innerHTML = `<p class="verdict ${right ? 'ok' : 'no'}">${right ? 'Right.' : 'Not quite.'}</p>
      ${explain(q)}
      <p class="quiz-actions"><button type="button" class="cta" data-q="next">${last ? 'See my score' : 'Next'} →</button>${
        subject ? `<button type="button" class="textlink" data-q="see">See ${esc(subject.name)} on the globe</button>` : ''
      }</p>`;
    root.querySelector<HTMLElement>('[data-q="next"]')?.focus();
  }

  function finish() {
    d.clearRange();
    const newBest = score > best;
    if (newBest) {
      best = score;
      try {
        localStorage.setItem(BEST_KEY, String(best));
      } catch {
        // storage blocked
      }
    }
    const line =
      score >= 9 ? 'Field biologist.' : score >= 7 ? 'You know your way around the globe.' : score >= 4 ? 'A good start: the globe has more to show you.' : 'Plenty to discover: pick an animal and look at where it lives.';
    root.innerHTML = `<div class="plate-bar"><button class="back" type="button" data-q="leave">← Close <kbd>Esc</kbd></button></div>
      <p class="plate-no">Quiz finished</p>
      <p class="quiz-big"><b>${score}</b> of ${ROUNDS}</p>
      <p class="quiz-ticks big" aria-label="${results.map((r) => (r ? 'right' : 'wrong')).join(', ')}">${results.map((r) => `<i class="${r ? 'ok' : 'no'}"></i>`).join('')}</p>
      <p class="desc">${line}${bestStreak > 2 ? ` Best streak: ${bestStreak} in a row.` : ''}</p>
      <p class="note">${newBest && score > 0 ? 'A new best score.' : `Your best score: ${best} of ${ROUNDS}.`}</p>
      <p class="quiz-actions"><button type="button" class="cta" data-q="start">Play again →</button></p>`;
  }

  function next() {
    if (round === ROUNDS - 1) return finish();
    round++;
    showRound();
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-q]')?.dataset.q;
    if (act === 'leave') return void close();
    if (act === 'start') return start();
    if (act === 'next') return next();
    if (act === 'see') {
      const q = questions[round];
      const s = q.kind === 'range' ? q.answer : q.kind === 'risk' ? q.animal : null;
      if (s) (close(), d.openAnimal(s));
      return;
    }
    const c = t.closest<HTMLElement>('.choice');
    if (c) answer(Number(c.dataset.i));
  });

  window.addEventListener('keydown', (e) => {
    if (!open || root.hidden || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
    if (/^[1-4]$/.test(e.key) && root.querySelector('.choice:not(:disabled)')) {
      const n = Number(e.key) - 1;
      if (root.querySelector(`.choice[data-i="${n}"]`)) answer(n);
    } else if (e.key === 'Enter' && answered && !(e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      next();
    }
  });

  function show() {
    open = true;
    intro();
  }
  function close() {
    if (!open) return;
    open = false;
    d.clearRange();
    root.hidden = true;
    root.innerHTML = '';
    d.onClose();
  }

  return { open: show, close, isOpen: () => open };
}
