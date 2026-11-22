// User settings from the panel's Settings view: app theme and keypad key backgrounds.
// Stored as JSON in Electron's userData folder (settings.json); a missing or broken file gives the defaults.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Theme = "dark" | "light";
/** "terms" = keys 0-5; "6" / "7" / "8" = the bottom row, left to right (whatever mode is active). */
export type KeyBgTarget = "terms" | "6" | "7" | "8";
export const KEY_BG_TARGETS: readonly KeyBgTarget[] = ["terms", "6", "7", "8"];
export type KeyBackgrounds = Partial<Record<KeyBgTarget, string>>;

export interface Settings {
  theme: Theme;
  keyBg: KeyBackgrounds;
  /** Mock scenario id chosen per mode (checked against mock/scenarios/index.json by the app). */
  scenario: { meeting?: string; education?: string };
}

export const DEFAULT_SETTINGS: Settings = { theme: "dark", keyBg: {}, scenario: {} };

export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

/** Lenient: unknown fields are dropped, invalid values fall back to the defaults. Colours are upper-cased. */
export function parseSettings(raw: unknown): Settings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const theme: Theme = o.theme === "light" ? "light" : "dark";
  const keyBg: KeyBackgrounds = {};
  const bg = o.keyBg && typeof o.keyBg === "object" ? (o.keyBg as Record<string, unknown>) : {};
  for (const t of KEY_BG_TARGETS) if (isHex(bg[t])) keyBg[t] = (bg[t] as string).toUpperCase();
  const sc = o.scenario && typeof o.scenario === "object" ? (o.scenario as Record<string, unknown>) : {};
  const scenario: Settings["scenario"] = {};
  for (const u of ["meeting", "education"] as const) if (typeof sc[u] === "string" && sc[u]) scenario[u] = sc[u] as string;
  return { theme, keyBg, scenario };
}

export function loadSettings(path: string): Settings {
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS, keyBg: {}, scenario: {} };
  }
}

/** Written to a temp file first, so a crash never leaves half a file. */
export function saveSettings(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** One background change from the panel: `target=#RRGGBB`, or `target=` to clear it. Null if malformed. */
export function parseKeyBgArg(arg: unknown): { target: KeyBgTarget; color: string | null } | null {
  if (typeof arg !== "string") return null;
  const [target, color = ""] = arg.split("=");
  if (!(KEY_BG_TARGETS as readonly string[]).includes(target)) return null;
  if (color === "") return { target: target as KeyBgTarget, color: null };
  return isHex(color) ? { target: target as KeyBgTarget, color: color.toUpperCase() } : null;
}
