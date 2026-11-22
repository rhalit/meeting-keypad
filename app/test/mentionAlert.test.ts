import { beforeEach, describe, expect, it } from "vitest";
import { MentionAlert } from "../src/pipeline/mentionAlert.js";
import { OverlayController, type TextCard } from "../src/pipeline/overlay.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import { FLASH_RED, SlotManager } from "../src/pipeline/slots.js";
import { FakeClock } from "./fakeClock.js";

describe("MentionAlert", () => {
  let clock: FakeClock;
  let away: boolean;
  let slots: SlotManager;
  let overlay: OverlayController;
  let alert: MentionAlert;
  let frames: KeyState[][];

  const line = { t: 102, speaker: "Lena", text: "Adam, can you take the eval?" };
  const states = () => slots.getAll().map((k) => k.state);

  beforeEach(() => {
    clock = new FakeClock();
    away = true;
    slots = new SlotManager({ clock });
    overlay = new OverlayController({ clock, lookup: () => undefined });
    frames = [];
    slots.on("change", (k: KeyState[]) => frames.push(k));
    alert = new MentionAlert({ clock, focus: { isAway: () => away }, keys: slots, overlay, log: () => {} });
  });

  it("focused: nothing happens here (slot 8 is the mention key's job)", () => {
    away = false;
    expect(alert.mention(line)).toBe("focused");
    expect(frames).toEqual([]);
    expect(alert.consumePress()).toBe(false);
  });

  it("away: all 9 keys pulse alert / normal every 500 ms, labels kept", () => {
    expect(alert.mention(line)).toBe("flashing");
    expect(states()).toEqual(Array(9).fill("alert"));
    expect(slots.getAll().every((k) => k.color === FLASH_RED)).toBe(true); // in alert, color is the background
    expect(slots.getAll()[6].label).toBe("Catch-up");
    expect(frames[0]).toHaveLength(9);
    clock.advance(500);
    expect(states()).toEqual(["empty", "empty", "empty", "empty", "empty", "empty", "shown", "shown", "shown"]);
    clock.advance(500);
    expect(states()[0]).toBe("alert");
  });

  it("a press stops the pulse, is consumed, and shows who said your name", () => {
    alert.mention(line);
    clock.advance(1200);
    expect(alert.consumePress()).toBe(true);
    expect(alert.isFlashing()).toBe(false);
    expect(states()).not.toContain("alert");
    const card = overlay.current() as TextCard;
    expect(card).toMatchObject({ kind: "text", title: "Lena said your name", eyebrow: "While you were away · 1:42" });
    expect(card.body).toContain('"Adam, can you take the eval?"');
    expect(card.body).toContain("Catch-up");
    expect(alert.consumePress()).toBe(false); // next press is a normal press again
    clock.advance(5000);
    expect(states()).not.toContain("alert");
  });

  it("looking back stops the pulse and shows the card; several mentions are counted", () => {
    alert.mention(line);
    alert.mention({ t: 130, speaker: "Marco", text: "Adam?" });
    alert.back();
    expect(alert.isFlashing()).toBe(false);
    expect((overlay.current() as TextCard).title).toBe("Your name came up 2 times");
    expect((overlay.current() as TextCard).body).toContain("[2:10] Marco");
  });

  it("reveal (the For-me card) replaces the built-in card", () => {
    const reveals: number[] = [];
    alert = new MentionAlert({ clock, focus: { isAway: () => away }, keys: slots, overlay, log: () => {}, reveal: () => reveals.push(1) });
    alert.mention(line);
    expect(alert.consumePress()).toBe(true);
    expect(reveals).toEqual([1]);
    expect(overlay.current()).toBeNull();
  });

  it("a term key keeps its label and category during the pulse, and gets its colour back after", () => {
    slots.add({ term: "LoRA", category: "Tech", source: "mock" });
    const before = slots.getAll()[0];
    alert.mention(line);
    expect(slots.getAll()[0]).toMatchObject({ label: before.label, sub: "Tech", color: FLASH_RED, state: "alert" });
    alert.consumePress();
    expect(slots.getAll()[0]).toMatchObject({ label: before.label, color: before.color });
  });

  it("back with no mention does nothing", () => {
    alert.back();
    expect(overlay.current()).toBeNull();
  });

  it("gives up pulsing after 3 min but still shows the card on back", () => {
    alert.mention(line);
    clock.advance(180_000);
    expect(alert.isFlashing()).toBe(false);
    expect(states()).not.toContain("alert");
    alert.back();
    expect((overlay.current() as TextCard).title).toBe("Lena said your name");
  });

  it("reset stops everything", () => {
    alert.mention(line);
    alert.reset();
    expect(alert.isFlashing()).toBe(false);
    expect(clock.pending()).toBe(0);
    alert.back();
    expect(overlay.current()).toBeNull();
  });
});
