// Shared types and constants for the app <-> plugin contract (protocol/messages.md).

export const SLOT_COUNT = 9;
export const TERM_SLOTS = 6; // slots 0-5 show terms, 6-8 are action keys

export type SlotState = "empty" | "new" | "shown" | "seen" | "busy" | "alert";

export interface KeyState {
  slot: number;
  /** Full term or action name; the plugin breaks and fits it (protocol v2). */
  label: string;
  /** Category name, term keys only. */
  sub?: string;
  /** #RRGGBB: category colour on term keys, label colour on keys without `sub`. */
  color?: string;
  /** #RRGGBB key background (user setting); absent = black. Not sent for `empty` / `alert`. */
  bg?: string;
  state: SlotState;
}

export type ActionKeyMap = Readonly<Record<number, { label: string; name: string }>>;

/** Meeting mode (default) bottom row. */
export const ACTION_KEYS: ActionKeyMap = {
  6: { label: "Catch-up", name: "catch-up" },
  7: { label: "Save", name: "save" },
  8: { label: "For me?", name: "for-me" },
};

/** Education mode bottom row (slots 0-5 stay term keys). */
export const EDUCATION_ACTION_KEYS: ActionKeyMap = {
  6: { label: "Flashcard", name: "flashcard" },
  7: { label: "Quiz me", name: "quiz" },
  8: { label: "Explain simply", name: "explain" },
};

/** What the app is used for: changes the bottom row and the mock content. */
export type Usage = "meeting" | "education";

export function actionKeysFor(usage: Usage): ActionKeyMap {
  return usage === "education" ? EDUCATION_ACTION_KEYS : ACTION_KEYS;
}

export const CATEGORIES = ["Tech", "Science", "Health", "Business", "Finance", "Law", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

// Distinct, readable as small text and a thin border on a black key. Same colours as tools/fake-core.mjs.
export const CATEGORY_COLORS: Readonly<Record<Category, string>> = {
  Tech: "#58A6FF",
  Science: "#BC8CFF",
  Health: "#3FB950",
  Business: "#F0883E",
  Finance: "#E3B341",
  Law: "#FF7B9C",
  Other: "#39C5CF",
};

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** Longest term the app sends (the spotter keeps terms to 4 words / 40 characters). */
export const MAX_TERM_CHARS = 40;

/**
 * The text a term key shows: the full term, first word capitalised when it is plain lower case
 * ("feature flag" -> "Feature flag"); "p95 latency", "eBPF", "iOS" and acronyms stay as they are.
 */
export function displayTerm(term: string): string {
  const t = term.replace(/\s+/g, " ").trim();
  return /^[a-z]{2,}(?![A-Za-z0-9])/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

export function emptyKey(slot: number): KeyState {
  return { slot, label: "", state: "empty" };
}

export function actionKey(slot: number): KeyState {
  return actionKeyIn(ACTION_KEYS, slot);
}

/** An action key's normal look in a given layout (Meeting / Education). */
export function actionKeyIn(keys: ActionKeyMap, slot: number): KeyState {
  return { slot, label: keys[slot].label, state: "shown" };
}

export function isTermSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < TERM_SLOTS;
}

export function isValidSlot(slot: unknown): slot is number {
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT;
}
