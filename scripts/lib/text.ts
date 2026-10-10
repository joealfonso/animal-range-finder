// Cleaning for Wikipedia text. Its plain-text extracts keep the gaps that templates leave behind: "6.9 t ;" where a
// converted unit was, "( )" where a pronunciation was, and "[1]" citation marks.
const sentenceSplitter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Tidies the leftovers of Wikipedia templates in an extract. Safe to run twice. */
export function tidy(s: string) {
  return s
    .replace(/\[(?:\d+|[a-z]|citation needed|note \d+)\]/gi, '')
    .replace(/\(\s*(?:[;,:]\s*)*\)/g, '') // empty brackets
    .replace(/\(\s*[;,]\s*/g, '(') // "( ; born" -> "(born"
    .replace(/\s+([;,.:!?])/g, '$1') // "6.9 t ;" -> "6.9 t;"
    .replace(/([;,])\1+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

export const sentencesOf = (text: string) => [...sentenceSplitter.segment(text)].map((x) => x.segment.trim()).filter(Boolean);

/** Whole sentences from the start of `text`, stopping before `max` characters (always at least `min` sentences). */
export function takeSentences(text: string, max: number, min = 1) {
  const out: string[] = [];
  let len = 0;
  for (const s of sentencesOf(text)) {
    if (out.length >= min && len + s.length + 1 > max) break;
    out.push(s);
    len += s.length + 1;
  }
  return out.join(' ');
}

/** A sentence that stands on its own: starts with a capital or digit, ends with . ! or ?, with brackets balanced. */
export function wholeSentence(s: string) {
  return /^[A-Z0-9“"‘']/.test(s) && /[.!?”"')]$/.test(s) && (s.match(/\(/g)?.length ?? 0) === (s.match(/\)/g)?.length ?? 0);
}
