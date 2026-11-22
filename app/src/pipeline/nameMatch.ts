// Is the listener named in a transcript line? Cheap, local check that gates the "For me?" model call.

export interface ListenerNames {
  name: string;
  /** Spellings speech-to-text writes instead (e.g. "Rally"), matched exactly. */
  aliases: string[];
}

/** Lower case, accents and apostrophes dropped, punctuation -> space. */
export function nameWords(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’']s\b/g, "") // "Rhali's" -> "rhali"
    .replace(/[‘’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Optimal string alignment distance (Levenshtein + adjacent transposition). */
export function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Shortest word that may match the name with one edit (shorter words collide with ordinary words). */
const FUZZY_MIN_LETTERS = 4;
/**
 * Shortest NAME that gets one-edit matching at all. Short names sit one edit from everyday words
 * ("Alex": "flex", "apex", "Alexa"), so they match exactly (name + aliases) only.
 */
const FUZZY_MIN_NAME_LETTERS = 5;

/**
 * The words of `text` that name the listener, or null.
 * - The name and every alias match exactly (case, accents and punctuation ignored; multi-word aliases as a phrase).
 * - Close spellings of the NAME (one edit or swap, words of 4+ letters: "Rhaly", "Rahli", "Rali") match too,
 *   for names of 5+ letters; a short name like "Alex" relies on its aliases ("Alec", "Alix") instead.
 *   Aliases are not fuzzy-matched on purpose: one edit from "Rally" is "really", which would trigger on most lines.
 */
export function mentionsListener(text: string, names: ListenerNames): string | null {
  const words = nameWords(text);
  if (words.length === 0) return null;
  const phrases = [names.name, ...names.aliases].map(nameWords).filter((p) => p.length > 0);
  for (const p of phrases) {
    for (let i = 0; i + p.length <= words.length; i++) {
      if (p.every((w, k) => words[i + k] === w)) return words.slice(i, i + p.length).join(" ");
    }
  }
  const name = nameWords(names.name);
  if (name.length === 1 && name[0].length >= FUZZY_MIN_NAME_LETTERS) {
    for (const w of words) {
      if (w.length >= FUZZY_MIN_LETTERS && osaDistance(w, name[0]) <= 1) return w;
    }
  }
  return null;
}
