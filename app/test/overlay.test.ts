import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadGlossary, type Glossary } from "../src/pipeline/mockData.js";
import { OverlayController, type OverlayCard, type TermCard, type TextCard } from "../src/pipeline/overlay.js";
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
      events.push(`show ${c.kind === "term" ? c.term : `text ${c.title}`}`);
    });
    overlay.on("update", (c: TextCard) => events.push(`update ${c.body}${c.streaming ? "" : " (done)"}`));
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
    expect((overlay.current() as TermCard).term).toBe("LoRA");
    expect(overlay.current()?.kind).toBe("term");
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
    expect((overlay.current() as TermCard).term).toBe("vector database");
    clock.advance(14_999);
    expect((overlay.current() as TermCard).term).toBe("vector database");
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
    expect((overlay.current() as TermCard).term).toBe("RAG");
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

  describe("text cards", () => {
    it("shows, fills in while streaming, then auto-hides after finishText", () => {
      const id = overlay.showText({ eyebrow: "Catch-up", title: "Catch-up", streaming: true, durationMs: null });
      expect(overlay.isVisible(id)).toBe(true);
      clock.advance(60_000); // no timer while streaming
      expect(overlay.updateText(id, "- Said: a")).toBe(true);
      expect(overlay.updateText(id, "- Said: a")).toBe(true); // unchanged: no event
      expect(overlay.finishText(id, 20_000, "- Said: ab")).toBe(true);
      expect(overlay.current()).toMatchObject({ kind: "text", body: "- Said: ab", streaming: false, durationMs: 20_000 });
      clock.advance(20_000);
      expect(overlay.current()).toBeNull();
      expect(events).toEqual(["show text Catch-up", "update - Said: a", "update - Said: ab (done)", "hide timeout"]);
    });

    it("a term press replaces a text card; updates to the old card are refused", () => {
      const id = overlay.showText({ eyebrow: "Catch-up", title: "Catch-up", streaming: true, durationMs: null });
      expect(overlay.press(term(0, "RAG"))).toBe("switched");
      expect(overlay.updateText(id, "late")).toBe(false);
      expect(overlay.finishText(id, 1000)).toBe(false);
      expect(overlay.isVisible(id)).toBe(false);
      expect((overlay.current() as TermCard).term).toBe("RAG");
    });

    it("a text card replaces a term card, and the term key then opens it again (not a toggle)", () => {
      overlay.press(term(0, "RAG"));
      overlay.showText({ eyebrow: "Save", title: "Saved", durationMs: 3000 });
      expect(overlay.press(term(0, "RAG"))).toBe("switched");
      clock.advance(15_000);
      expect(overlay.current()).toBeNull();
      expect(clock.pending()).toBe(0);
    });

    it("a text card with a duration hides itself", () => {
      overlay.showText({ eyebrow: "Save", title: "Saved", tone: "success", durationMs: 3000 });
      clock.advance(2999);
      expect(overlay.current()).toMatchObject({ tone: "success", streaming: false, body: "" });
      clock.advance(1);
      expect(overlay.current()).toBeNull();
    });
  });
});
