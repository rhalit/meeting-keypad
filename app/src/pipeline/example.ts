// The "In this meeting" example on a live term's card: only the sentence(s) with the heard words.

/** Lowercase letters and digits only, words separated by one space. */
export const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const plainWords = (s: string) => plain(s).split(" ").filter(Boolean);

/**
 * Index of the first word of `needle` as a contiguous run of plain words in `hay`, searching from
 * `from`; -1 if absent. Both are arrays of plain words.
 */
export function findRun(hay: string[], needle: string[], from = 0): number {
  if (needle.length === 0) return -1;
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Splits after . ! ? (followed by space) into sentences, keeping their punctuation. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+(?=\S)/)
    .filter(Boolean);
}

/**
 * The sentence(s) of `text` that contain the heard words (falling back to the term's words), at most
 * `maxWords` words: two sentences when the words cross a sentence boundary; a longer stretch is cut to a
 * window around the words with "…" where text was left out. Falls back to the last sentence.
 */
export function exampleSentence(text: string, heard: string, term: string, maxWords = 25): string {
  const sents = sentences(text);
  if (sents.length === 0) return "";
  // Original tokens, each with its sentence and its plain form (punctuation-only tokens dropped).
  const tokens: { raw: string; plain: string[]; sent: number }[] = [];
  sents.forEach((s, si) => {
    for (const raw of s.split(" ")) {
      const p = plainWords(raw);
      if (p.length) tokens.push({ raw, plain: p, sent: si });
    }
  });
  // Plain word -> token index (a token like "SOC-2" gives two plain words).
  const flat: string[] = [];
  const owner: number[] = [];
  tokens.forEach((t, ti) => {
    for (const w of t.plain) {
      flat.push(w);
      owner.push(ti);
    }
  });
  let span: [number, number] | null = null;
  for (const needle of [plainWords(heard), plainWords(term)]) {
    const at = findRun(flat, needle);
    if (at >= 0) {
      span = [owner[at], owner[at + needle.length - 1]];
      break;
    }
  }
  if (!span) return trimWindow(tokens.filter((t) => t.sent === sents.length - 1).map((t) => t.raw), 0, 0, maxWords, true);
  const [a, b] = span;
  const firstSent = tokens[a].sent;
  const lastSent = tokens[b].sent;
  const idx = tokens.map((t, i) => i).filter((i) => tokens[i].sent >= firstSent && tokens[i].sent <= lastSent);
  const words = idx.map((i) => tokens[i].raw);
  return trimWindow(words, a - idx[0], b - idx[0], maxWords);
}

/** At most `max` words around [a, b] (inclusive), "…" marking a cut at either end. */
function trimWindow(words: string[], a: number, b: number, max: number, tail = false): string {
  if (words.length <= max) return words.join(" ");
  let from: number;
  if (tail) from = words.length - max;
  else {
    const spanLen = b - a + 1;
    const before = Math.max(0, Math.floor((max - spanLen) / 2));
    from = Math.max(0, Math.min(a - before, words.length - max));
  }
  const to = from + max;
  const body = words.slice(from, to).join(" ");
  return `${from > 0 ? "… " : ""}${body}${to < words.length ? " …" : ""}`;
}
