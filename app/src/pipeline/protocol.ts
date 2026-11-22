// Shared types and constants for the app <-> plugin contract (protocol/messages.md).

export const SLOT_COUNT = 9;
export const TERM_SLOTS = 6; // slots 0-5 show terms, 6-8 are action keys

export type SlotState = "empty" | "new" | "shown" | "seen" | "busy" | "alert";

export interface KeyState {
  slot: number;
  label: string;
  sub?: string;
  bg?: string;
  state: SlotState;
}

export const ACTION_BG = "#30363D";

export const ACTION_KEYS: Readonly<Record<number, { label: string; name: string }>> = {
  6: { label: "Catch\nup", name: "catch-up" },
  7: { label: "Save", name: "save" },
  8: { label: "For me?", name: "for-me" },
};

export const CATEGORIES = ["AI", "Infra", "Eng", "Biz", "Security"] as const;
export type Category = (typeof CATEGORIES)[number];

// Same colours as tools/fake-core.mjs. fake-core has no Security colour, so Security
// takes fake-core's otherwise unused Crypto pink.
export const CATEGORY_COLORS: Readonly<Record<Category, string>> = {
  AI: "#1F6FEB",
  Infra: "#0E7C7B",
  Eng: "#8250DF",
  Biz: "#B7791F",
  Security: "#BF3989",
};

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** Key label: 1-2 lines, each 1-8 characters, "\n" as the break. */
export function isValidLabel(label: string): boolean {
  const lines = label.split("\n");
  return lines.length >= 1 && lines.length <= 2 && lines.every((l) => l.length >= 1 && l.length <= 8);
}

const MAX_LINE = 8;

interface Packed {
  label: string;
  /** True when something had to be cut off (the label ends a line with "."). */
  cut: boolean;
}

/** Greedy word packing into at most 2 lines of 8 characters; overlong words are split or cut. */
function packLabel(text: string): Packed {
  let cut = false;
  const fit = (s: string) => {
    if (s.length <= MAX_LINE) return s;
    cut = true;
    return `${s.slice(0, MAX_LINE - 1)}.`;
  };
  const words = text.replace(/\\n|\n/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return { label: "", cut: false };
  if (words.length === 1) {
    const w = words[0];
    if (w.length <= MAX_LINE) return { label: w, cut: false };
    const label = `${w.slice(0, MAX_LINE - 1)}-\n${fit(w.slice(MAX_LINE - 1))}`;
    return { label, cut };
  }
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur === "") cur = w;
    else if (cur.length + 1 + w.length <= MAX_LINE) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  lines.push(cur);
  if (lines.length > 2) lines.splice(1, lines.length - 1, lines.slice(1).join(" "));
  const label = lines.map(fit).join("\n");
  return { label, cut };
}

/** True if `small`'s letters appear in `big` in the same order ("db" in "vectordatabase"). */
function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

/**
 * True if a label is the term (shortened), not a paraphrase: the first 3 letters of every label word
 * appear in order in the term ("Vector\nDB" for "vector database", "Auto\nScale" for "autoscaling" yes;
 * "Model\nsize" for "quantization" no).
 */
export function labelMatchesTerm(label: string, term: string): boolean {
  const t = term.toLowerCase().replace(/[^a-z0-9]/g, "");
  return label
    .toLowerCase()
    .split(/[\s\n-]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .every((w) => isSubsequence(w.slice(0, 3), t));
}

/** "feature\nflag" -> "Feature\nflag"; leaves "p95", "eBPF", "iOS" and acronyms alone. */
const capitalize = (s: string) => (/^[a-z]{2,}(?![A-Za-z0-9])/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * A valid key label for a spotted term: the proposed label tidied up (literal "\\n", stray spaces)
 * if it passes isValidLabel and is made of the term's own words (labelMatchesTerm), else one re-packed
 * from the proposed label's words or the term's (whichever needs no cutting, preferring the proposed
 * one; a paraphrase is never used). Always valid for a non-empty term.
 */
export function repairLabel(proposed: string, term: string): string {
  const tidy = String(proposed ?? "")
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const ownWords = tidy !== "" && labelMatchesTerm(tidy, term);
  if (ownWords && isValidLabel(tidy)) return capitalize(tidy);
  const fromTerm = packLabel(term);
  fromTerm.label = capitalize(fromTerm.label);
  const fromTidy = packLabel(tidy);
  fromTidy.label = capitalize(fromTidy.label);
  const candidates = [...(ownWords ? [fromTidy] : []), fromTerm].filter((p) => p.label && isValidLabel(p.label));
  const best = candidates.find((p) => !p.cut) ?? candidates[0];
  return best ? best.label : "?";
}

export function emptyKey(slot: number): KeyState {
  return { slot, label: "", state: "empty" };
}

export function actionKey(slot: number): KeyState {
  return { slot, label: ACTION_KEYS[slot].label, bg: ACTION_BG, state: "shown" };
}

export function isTermSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < TERM_SLOTS;
}

export function isValidSlot(slot: unknown): slot is number {
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT;
}
