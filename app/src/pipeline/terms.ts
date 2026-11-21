import type { Category } from "./protocol.js";

/**
 * One spotted term, as handed to the SlotManager. Every term source emits exactly this shape:
 * the mock meeting now (source "mock"), the live term spotter in Phase 3 (source "live").
 */
export interface TermCandidate {
  /** Full term as spoken, e.g. "vector database". Only the overlay shows it in full. */
  term: string;
  /** Key label, max 2 lines x 8 chars, "\n" as the break. */
  label: string;
  category: Category;
  source: "mock" | "live";
}

/**
 * Key used to merge duplicates: case-insensitive, hyphens/whitespace collapsed, and a trailing
 * plural on the last word removed ("LoRAs" -> "lora", "vector databases" -> "vector database").
 */
export function normalizeTerm(term: string): string {
  const words = term.trim().toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return "";
  const last = words[words.length - 1];
  if (last.length > 4 && last.endsWith("ies")) {
    words[words.length - 1] = last.slice(0, -3) + "y";
  } else if (last.length > 3 && last.endsWith("s") && !last.endsWith("ss")) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(" ");
}
