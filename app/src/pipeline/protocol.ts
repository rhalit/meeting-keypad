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
