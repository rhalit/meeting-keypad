import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EDUCATION_ACTION_KEYS, type KeyState } from "../src/pipeline/protocol.js";
import { DEFAULT_SETTINGS, loadSettings, parseKeyBgArg, parseSettings, saveSettings } from "../src/pipeline/settings.js";
import { FLASH_RED, SlotManager } from "../src/pipeline/slots.js";
import { FakeClock } from "./fakeClock.js";

describe("settings file", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("missing or broken file -> defaults (dark, no key colours)", () => {
    dir = mkdtempSync(join(tmpdir(), "settings-"));
    expect(loadSettings(join(dir, "nope.json"))).toEqual(DEFAULT_SETTINGS);
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(loadSettings(join(dir, "bad.json"))).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips and drops invalid values", () => {
    dir = mkdtempSync(join(tmpdir(), "settings-"));
    const path = join(dir, "sub", "settings.json");
    saveSettings(path, { theme: "light", keyBg: { terms: "#112233", "7": "#ABCDEF" }, scenario: { education: "climate" } });
    expect(loadSettings(path)).toEqual({ theme: "light", keyBg: { terms: "#112233", "7": "#ABCDEF" }, scenario: { education: "climate" } });
    expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("light");
    expect(parseSettings({ theme: "pink", keyBg: { terms: "red", "6": "#00ff00", "9": "#000000" }, scenario: { meeting: 3, education: "ml-class" }, extra: 1 })).toEqual({
      theme: "dark",
      keyBg: { "6": "#00FF00" },
      scenario: { education: "ml-class" },
    });
  });

  it("parseKeyBgArg: target=#RRGGBB, target= clears, anything else is rejected", () => {
    expect(parseKeyBgArg("terms=#1f6feb")).toEqual({ target: "terms", color: "#1F6FEB" });
    expect(parseKeyBgArg("8=")).toEqual({ target: "8", color: null });
    expect(parseKeyBgArg("5=#000000")).toBeNull();
    expect(parseKeyBgArg("6=blue")).toBeNull();
    expect(parseKeyBgArg(undefined)).toBeNull();
  });
});

describe("SlotManager key backgrounds", () => {
  it("adds bg to term keys and to each bottom key, never to empty keys; resends all 9", () => {
    const slots = new SlotManager({ clock: new FakeClock() });
    const sent: KeyState[][] = [];
    slots.on("change", (k: KeyState[]) => sent.push(k));
    slots.add({ term: "LoRA", category: "Tech", source: "mock" });
    slots.setBackgrounds({ terms: "#1F6FEB", "6": "#FFFFFF", "8": "#000000" });
    expect(sent[sent.length - 1]).toHaveLength(9);
    const all = slots.getAll();
    expect(all[0]).toMatchObject({ label: "LoRA", bg: "#1F6FEB" });
    expect(all[1]).toEqual({ slot: 1, label: "", state: "empty" }); // empty keys stay black
    expect(all[6]).toMatchObject({ label: "Catch-up", bg: "#FFFFFF" });
    expect(all[7].bg).toBeUndefined();
    expect(all[8].bg).toBeUndefined(); // black is the default, not sent
  });

  it("follows the slot when the layout changes, and is not sent during the red pulse", () => {
    const slots = new SlotManager({ clock: new FakeClock() });
    slots.setBackgrounds({ "7": "#336699" });
    slots.setActionKeys(EDUCATION_ACTION_KEYS);
    expect(slots.getAll()[7]).toMatchObject({ label: "Quiz me", bg: "#336699" });
    slots.setFlash(true);
    expect(slots.getAll()[7]).toMatchObject({ state: "alert", color: FLASH_RED });
    expect(slots.getAll()[7].bg).toBeUndefined();
    slots.setFlash(null);
    expect(slots.getAll()[7].bg).toBe("#336699");
  });
});
