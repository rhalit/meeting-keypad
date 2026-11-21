import { readFileSync } from "node:fs";
import { isCategory, type Category } from "./protocol.js";
import type { TermCandidate } from "./terms.js";

/** One line of mock/meeting.json. `text` may contain "{listener}" (see mock/config.json). */
export interface MeetingLine {
  t: number;
  speaker: string;
  text: string;
  terms: string[];
}

export interface GlossaryEntry {
  label: string;
  full: string;
  explanation: string;
  example: string;
  category: Category;
}

export type Glossary = Record<string, GlossaryEntry>;

export interface MockConfig {
  /** The person using the keypad; speakers address them by this name. */
  listenerName: string;
}

export const LISTENER_PLACEHOLDER = "{listener}";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadConfig(path: string): MockConfig {
  const raw = readJson(path) as Partial<MockConfig>;
  if (typeof raw.listenerName !== "string" || raw.listenerName.trim() === "") {
    throw new Error(`${path}: "listenerName" must be a non-empty string`);
  }
  return { listenerName: raw.listenerName.trim() };
}

/** Reads meeting.json and fills in the listener's name. */
export function loadMeeting(path: string, listenerName: string): MeetingLine[] {
  const raw = readJson(path);
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of lines`);
  return raw.map((l, i) => {
    if (typeof l?.t !== "number" || typeof l.speaker !== "string" || typeof l.text !== "string" || !Array.isArray(l.terms)) {
      throw new Error(`${path}: line ${i} does not match {t, speaker, text, terms}`);
    }
    return {
      t: l.t,
      speaker: l.speaker,
      text: l.text.split(LISTENER_PLACEHOLDER).join(listenerName),
      terms: l.terms.map(String),
    };
  });
}

export function loadGlossary(path: string): Glossary {
  const raw = readJson(path) as Record<string, GlossaryEntry>;
  for (const [term, e] of Object.entries(raw)) {
    if (!isCategory(e?.category) || typeof e.label !== "string") {
      throw new Error(`${path}: entry "${term}" has no valid label/category`);
    }
  }
  return raw;
}

/** Turns a term from meeting.json into the shared TermCandidate, or null if the glossary lacks it. */
export function glossaryCandidate(glossary: Glossary, term: string): TermCandidate | null {
  const e = glossary[term];
  if (!e) return null;
  return { term, label: e.label, category: e.category, source: "mock" };
}
