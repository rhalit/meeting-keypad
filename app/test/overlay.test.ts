import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadGlossary, type Glossary } from "../src/pipeline/mockData.js";
import { OverlayController, type OverlayCard } from "../src/pipeline/overlay.js";
import { CATEGORY_COLORS } from "../src/pipeline/protocol.js";
import { SlotManager, type PressResult } from "../src/pipeline/slots.js";
import { FakeClock } from "./fakeClock.js";

const glossary: Glossary = loadGlossary(join(__dirname, "..", "..", "mock", "glossary.json"));

const term = (slot: number, t: string): PressResult => ({ kind: "term", slot, term: t });

describe("OverlayController", () => {
  let clock: FakeClock;
  let overlay: OverlayController;
  let events: string[];
  let shown: OverlayCard[];

  beforeEach(() => {
    clock = new FakeClock();
    overlay = new OverlayController({ clock, lookup: (t) => glossary[t] });
    events = [];
    shown = [];
    overlay.on("show", (c: OverlayCard) => {
      shown.push(c);
      events.push(`show ${c.term}`);
    });
    overlay.on("hide", ({ reason }: { reason: string }) => events.push(`hide ${reason}`));
  });

  it("shows the pressed term's card with its glossary content", () => {
    expect(overlay.press(term(4, "LoRA"))).toBe("shown");
    const e = glossary["LoRA"];
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      term: "LoRA",
      title: e.full,
      category: e.category,
      color: CATEGORY_COLORS[e.category],
      explanation: e.explanation,
      example: e.example,
      durationMs: 15_000,
    });
    expect(overlay.current()?.term).toBe("LoRA");
  });

  it("hides the card when the same key is pressed while it is visible", () => {
    overlay.press(term(0, "RAG"));
    clock.advance(3000);
    expect(overlay.press(term(0, "RAG"))).toBe("hidden");
    expect(events).toEqual(["show RAG", "hide toggle"]);
    expect(overlay.current()).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("switches to another term and restarts the 15 s timer", () => {
    overlay.press(term(0, "RAG"));
    clock.advance(10_000);
    expect(overlay.press(term(1, "vector database"))).toBe("switched");
    expect(overlay.current()?.term).toBe("vector database");
    clock.advance(14_999);
    expect(overlay.current()?.term).toBe("vector database");
    clock.advance(1);
    expect(overlay.current()).toBeNull();
    expect(events).toEqual(["show RAG", "show vector database", "hide timeout"]);
  });

  it("hides itself after exactly 15 s", () => {
    overlay.press(term(2, "p95 latency"));
    clock.advance(14_999);
    expect(overlay.current()).not.toBeNull();
    clock.advance(1);
    expect(overlay.current()).toBeNull();
    expect(events).toEqual(["show p95 latency", "hide timeout"]);
    expect(clock.pending()).toBe(0);
  });

  it("re-opens a seen term after a timeout and after a toggle", () => {
    overlay.press(term(0, "RAG"));
    clock.advance(15_000);
    expect(overlay.press(term(0, "RAG"))).toBe("shown");
    overlay.press(term(0, "RAG")); // toggle off
    expect(overlay.press(term(0, "RAG"))).toBe("shown");
    expect(events).toEqual(["show RAG", "hide timeout", "show RAG", "hide toggle", "show RAG"]);
    expect(new Set(shown.map((c) => c.id)).size).toBe(3);
  });

  it("ignores bottom-row, empty and invalid keys and keeps the visible card", () => {
    overlay.press(term(0, "RAG"));
    for (const r of [
      { kind: "action", slot: 6, action: "catch-up" },
      { kind: "action", slot: 7, action: "save" },
      { kind: "action", slot: 8, action: "for-me" },
      { kind: "empty", slot: 3 },
      { kind: "invalid", slot: 42 },
    ] as PressResult[]) {
      expect(overlay.press(r)).toBe("ignored");
    }
    expect(overlay.current()?.term).toBe("RAG");
    expect(events).toEqual(["show RAG"]);
  });

  it("opens nothing for a bottom-row key when no card is visible", () => {
    expect(overlay.press({ kind: "action", slot: 6, action: "catch-up" })).toBe("ignored");
    expect(events).toEqual([]);
  });

  it("ignores a term without a glossary entry", () => {
    expect(overlay.press(term(0, "blockchain synergy"))).toBe("ignored");
    expect(events).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("hide('restart') hides the card and clears its timer", () => {
    overlay.press(term(0, "RAG"));
    overlay.hide("restart");
    expect(events).toEqual(["show RAG", "hide restart"]);
    expect(clock.pending()).toBe(0);
    overlay.hide("restart"); // nothing visible: no event
    expect(events).toHaveLength(2);
  });

  it("works with the real SlotManager, including a seen key", () => {
    const slots = new SlotManager({ clock });
    slots.add({ term: "RAG", label: "RAG", category: "AI", source: "mock" });
    expect(overlay.press(slots.press(0))).toBe("shown");
    expect(slots.getAll()[0].state).toBe("seen");
    expect(overlay.press(slots.press(0))).toBe("hidden");
    expect(overlay.press(slots.press(0))).toBe("shown");
    expect(overlay.press(slots.press(6))).toBe("ignored");
    expect(overlay.current()?.title).toBe(glossary["RAG"].full);
    slots.dispose();
  });
});
