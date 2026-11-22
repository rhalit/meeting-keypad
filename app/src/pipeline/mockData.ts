import { readFileSync } from "node:fs";
import { isCategory, type Category } from "./protocol.js";
import type { TermCandidate } from "./terms.js";

/** One line of mock/meeting.json. `text` may contain "{listener}" (see mock/config.json). */
export interface MeetingLine {
  t: number;
  speaker: string;
  text: string;
  terms: string[];
  /** Optional (JSON `words`): meeting second at which each word of `text` starts (recorded scenarios, speech-to-text). */
  wordStarts?: number[];
}

export interface GlossaryEntry {
  full: string;
  explanation: string;
  example: string;
  category: Category;
}

export type Glossary = Record<string, GlossaryEntry>;

export interface MockConfig {
  /** The person using the keypad; speakers address them by this name. */
  listenerName: string;
  /** Other spellings speech-to-text writes for the name (e.g. "Rally"); matched exactly, added to Deepgram keyterms. */
  listenerAliases: string[];
  /** What the listener already knows (used in the term spotter and explanation prompts). Optional. */
  listenerKnows: string;
  /** "Meeting topic / keyterms" for live speech-to-text (Deepgram keyterms). Optional. */
  keyterms: string[];
}

/** Who the prompts write for, e.g. "Rhali (2nd-year EPFL master student ...)". */
export interface ListenerProfile {
  name: string;
  knows: string;
}

/** "Rhali (knows: ...)" or just "Rhali". */
export function describeListener(p: ListenerProfile): string {
  return p.knows ? `${p.name} (${p.knows})` : p.name;
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
  const k = (raw as { keyterms?: unknown }).keyterms;
  const keyterms = Array.isArray(k) ? k.map(String) : typeof k === "string" ? [k] : [];
  const knows = (raw as { listenerKnows?: unknown }).listenerKnows;
  const a = (raw as { listenerAliases?: unknown }).listenerAliases;
  const listenerAliases = (Array.isArray(a) ? a.map(String) : typeof a === "string" ? [a] : []).map((s) => s.trim()).filter(Boolean);
  return {
    listenerName: raw.listenerName.trim(),
    listenerAliases,
    listenerKnows: typeof knows === "string" ? knows.trim() : "",
    keyterms,
  };
}

/** Reads meeting.json and fills in the listener's name. */
export function loadMeeting(path: string, listenerName: string): MeetingLine[] {
  const raw = readJson(path);
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of lines`);
  return raw.map((l, i) => {
    if (typeof l?.t !== "number" || typeof l.speaker !== "string" || typeof l.text !== "string" || !Array.isArray(l.terms)) {
      throw new Error(`${path}: line ${i} does not match {t, speaker, text, terms}`);
    }
    const line: MeetingLine = {
      t: l.t,
      speaker: l.speaker,
      text: l.text.split(LISTENER_PLACEHOLDER).join(listenerName),
      terms: l.terms.map(String),
    };
    // Word times only when they still fit the text (a multi-word listener name changes the count).
    const n = line.text.split(/\s+/).filter(Boolean).length;
    if (Array.isArray(l.words) && l.words.length === n && l.words.every((w: unknown) => typeof w === "number")) line.wordStarts = l.words;
    return line;
  });
}

export function loadGlossary(path: string): Glossary {
  const raw = readJson(path) as Record<string, GlossaryEntry>;
  for (const [term, e] of Object.entries(raw)) {
    if (!isCategory(e?.category)) {
      throw new Error(`${path}: entry "${term}" has no valid category`);
    }
  }
  return raw;
}

/** Turns a term from meeting.json into the shared TermCandidate, or null if the glossary lacks it. */
export function glossaryCandidate(glossary: Glossary, term: string): TermCandidate | null {
  const e = glossary[term];
  if (!e) return null;
  return { term, category: e.category, source: "mock" };
}

/** One entry of mock/scenarios/index.json. `path` is relative to mock/ ("." = the default meeting). */
export interface ScenarioInfo {
  id: string;
  title: string;
  usage: "meeting" | "education";
  path: string;
  /** A recorded call to play in sync (file in the scenario folder, e.g. "video.mp4"). */
  video?: string;
  /** Length in seconds when it runs past the last line (the video's length). */
  duration?: number;
}

/** Reads and checks mock/scenarios/index.json (ids unique, usage meeting / education). */
export function loadScenarioIndex(path: string): ScenarioInfo[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of scenarios`);
  const seen = new Set<string>();
  return raw.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const ok =
      typeof o.id === "string" &&
      o.id !== "" &&
      typeof o.title === "string" &&
      typeof o.path === "string" &&
      (o.usage === "meeting" || o.usage === "education");
    if (!ok) throw new Error(`${path}: entry ${i} does not match {id, title, usage: meeting|education, path}`);
    if (seen.has(o.id as string)) throw new Error(`${path}: duplicate id "${o.id}"`);
    if (o.video !== undefined && (typeof o.video !== "string" || o.video === "")) throw new Error(`${path}: entry ${i} "video" must be a file name`);
    if (o.duration !== undefined && (typeof o.duration !== "number" || !(o.duration > 0))) throw new Error(`${path}: entry ${i} "duration" must be seconds`);
    seen.add(o.id as string);
    const info: ScenarioInfo = { id: o.id as string, title: o.title as string, usage: o.usage as ScenarioInfo["usage"], path: o.path as string };
    if (o.video !== undefined) info.video = o.video as string;
    if (o.duration !== undefined) info.duration = o.duration as number;
    return info;
  });
}
