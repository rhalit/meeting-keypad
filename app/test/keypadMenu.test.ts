import { beforeEach, describe, expect, it } from "vitest";
import { BACK_COLOR, KeypadMenu, MENU_COLOR, durationLabel, menuKeys, type MenuId } from "../src/pipeline/keypadMenu.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { FakeClock } from "./fakeClock.js";

describe("KeypadMenu (Catch-up / Save durations)", () => {
  let clock: FakeClock;
  let slots: SlotManager;
  let menu: KeypadMenu;
  let picks: [MenuId, number][];
  let sent: KeyState[][];

  const labels = () => slots.getAll().map((k) => k.label);

  beforeEach(() => {
    clock = new FakeClock();
    slots = new SlotManager({ clock });
    picks = [];
    sent = [];
    slots.on("change", (k: KeyState[]) => sent.push(k));
    menu = new KeypadMenu({ clock, keys: slots, log: () => {}, onPick: (m, s) => picks.push([m, s]) });
  });

  it("shows 30 s … 10 min on keys 1-5 and ‹ Back bottom-left, and sends all 9 keys", () => {
    slots.add({ term: "LoRA", category: "Tech", source: "mock" });
    menu.open("catch-up");
    expect(labels()).toEqual(["30 s", "1 min", "2 min", "5 min", "10 min", "", "‹ Back", "", ""]);
    expect(slots.getAll()[0]).toMatchObject({ sub: "Catch-up", color: MENU_COLOR, state: "shown" });
    expect(slots.getAll()[6]).toMatchObject({ color: BACK_COLOR });
    expect(sent[sent.length - 1]).toHaveLength(9);
    expect(menuKeys("save")[2]).toMatchObject({ label: "2 min", sub: "Save" });
  });

  it("a duration press picks it and returns to the normal keys (terms that arrived meanwhile included)", () => {
    menu.open("save");
    slots.add({ term: "RAG", category: "Tech", source: "mock" }); // arrives under the menu
    expect(slots.getAll()[0].label).toBe("30 s");
    expect(menu.press(1)).toBe("picked");
    expect(picks).toEqual([["save", 60]]);
    expect(menu.isOpen()).toBe(false);
    expect(slots.getAll()[0].label).toBe("RAG");
    expect(labels().slice(6)).toEqual(["Catch-up", "Save", "For me?"]);
  });

  it("‹ Back key, the Back action (left arrow) and 15 s of silence all close it without picking", () => {
    menu.open("catch-up");
    expect(menu.press(6)).toBe("back");
    expect(menu.isOpen()).toBe(false);
    menu.open("catch-up");
    expect(menu.back()).toBe(true);
    expect(menu.back()).toBe(false);
    menu.open("save");
    clock.advance(15_000);
    expect(menu.isOpen()).toBe(false);
    expect(picks).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("other keys are ignored but keep the menu open a bit longer", () => {
    menu.open("catch-up");
    clock.advance(10_000);
    expect(menu.press(8)).toBe("ignored");
    clock.advance(10_000);
    expect(menu.isOpen()).toBe(true);
    clock.advance(5_000);
    expect(menu.isOpen()).toBe(false);
  });

  it("the away pulse still shows over a menu", () => {
    menu.open("catch-up");
    slots.setFlash(true);
    expect(slots.getAll().every((k) => k.state === "alert")).toBe(true);
    slots.setFlash(null);
    expect(slots.getAll()[0].label).toBe("30 s");
  });

  it("durationLabel", () => {
    expect([30, 60, 120, 300, 600].map(durationLabel)).toEqual(["30 s", "1 min", "2 min", "5 min", "10 min"]);
  });
});
