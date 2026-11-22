import { beforeEach, describe, expect, it } from "vitest";
import { EXPLAINING_TEXT, Explainer } from "../src/pipeline/explainer.js";
import { LlmError } from "../src/pipeline/llm.js";
import { OverlayController, type OverlayCard, type TermCard } from "../src/pipeline/overlay.js";
import { SlotManager } from "../src/pipeline/slots.js";
import type { TermCandidate } from "../src/pipeline/terms.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

const S = 1000;
const listener = { name: "Rhali", knows: "robotics student" };
const soc2: TermCandidate = { term: "SOC 2", category: "Law", source: "live" };
const heardLine = { t: 146, speaker: "Speaker 1", text: "The bank pilot won't sign until we have so two." };
const answer = { full: "SOC 2 (Service Organization Control 2)", explanation: "An audit report that shows a company keeps customer data safe." };

describe("Explainer", () => {
  let clock: FakeClock;
  let llm: FakeLlmClient;
  let explainer: Explainer;
  let overlay: OverlayController;
  let events: string[];
  let cards: OverlayCard[];

  beforeEach(() => {
    clock = new FakeClock();
    llm = new FakeLlmClient();
    explainer = new Explainer({ clock, llm, listener, log: () => {} });
    overlay = new OverlayController({ clock, lookup: (t) => explainer.lookup(t) });
    explainer.on("ready", (t: string) => overlay.refresh(t));
    explainer.on("failed", (t: string) => overlay.refresh(t));
    events = [];
    cards = [];
    overlay.on("show", (c: OverlayCard) => {
      cards.push(c);
      events.push(`show ${(c as TermCard).pending ? "pending" : "ready"}`);
    });
    overlay.on("update", (c: OverlayCard) => {
      cards.push(c);
      events.push(`update ${(c as TermCard).pending ? "pending" : "ready"}`);
    });
    overlay.on("hide", ({ reason }: { reason: string }) => events.push(`hide ${reason}`));
    explainer.noteHeard(soc2, heardLine, [{ t: 140, text: "Moving on to security." }]);
  });

  const press = () => overlay.press({ kind: "term", slot: 0, term: "SOC 2" });

  it("asks LLM_MODEL with the term, the sentence it was heard in and the listener", () => {
    explainer.prefetch("SOC 2");
    expect(llm.calls).toHaveLength(1);
    const msgs = llm.calls[0].req.messages.map((m) => m.content).join("\n");
    expect(msgs).toContain("Term: SOC 2");
    expect(msgs).toContain("so two");
    expect(msgs).toContain("Moving on to security.");
    expect(msgs).toContain("Rhali (robotics student)");
    expect(msgs).toContain("40 to 60 words");
  });

  it("caches per term: a second prefetch, or the same term in a new meeting, makes no new call", async () => {
    explainer.prefetch("SOC 2");
    explainer.prefetch("soc 2");
    expect(llm.calls).toHaveLength(1);
    llm.calls[0].end(answer);
    await flush();
    explainer.prefetch("SOC 2");
    explainer.reset(); // new meeting
    explainer.prefetch("SOC 2");
    expect(llm.calls).toHaveLength(1);
    // The example is per meeting: after reset it comes from the new meeting's sentence.
    explainer.noteHeard(soc2, { t: 5, text: "We need SOC 2 by March." });
    expect(explainer.lookup("SOC 2")?.example).toBe("We need SOC 2 by March.");
  });

  it("press after ready: the full card at once, with the heard sentence as the example", async () => {
    explainer.prefetch("SOC 2");
    llm.calls[0].end(answer);
    await flush();
    expect(press()).toBe("shown");
    expect(cards[0]).toMatchObject({
      kind: "term",
      title: answer.full,
      explanation: answer.explanation,
      example: heardLine.text,
      category: "Law", // the key's category, so the chip matches the key
      pending: false,
      durationMs: 15_000,
    });
  });

  it("the card's category is always the key's: the model is not asked for one, and an extra one is ignored", async () => {
    explainer.prefetch(soc2);
    const sys = llm.calls[0].req.messages[0].content;
    expect(sys).not.toMatch(/category/i);
    llm.calls[0].end({ ...answer, category: "Tech" });
    await flush();
    expect(explainer.lookup("SOC 2")?.category).toBe("Law");
    explainer.reset(); // new meeting, cached explanation, not heard yet: still the key's category
    expect(explainer.lookup("SOC 2")?.category).toBe("Law");
  });

  it("the example is only the sentence with the heard words, even across a line boundary", () => {
    const e = new Explainer({ clock, llm, listener, log: () => {} });
    const c: TermCandidate = { term: "NSDR", category: "Health", source: "live" };
    e.noteHeard(
      c,
      { t: 20, text: "deep rest, which people call NSTR. It takes ten minutes. Then you get back to work and the afternoon goes fine." },
      [{ t: 10, text: "We talked about sleep for an hour. My favourite tool is non-sleep" }],
      "non-sleep deep rest",
    );
    expect(e.lookup("NSDR")?.example).toBe("My favourite tool is non-sleep deep rest, which people call NSTR.");
  });

  it("press before ready: shows 'Explaining…' at once with no countdown; a timeout shows the advice", async () => {
    explainer.prefetch("SOC 2");
    expect(press()).toBe("shown");
    expect(cards[0]).toMatchObject({ pending: true, explanation: EXPLAINING_TEXT, example: heardLine.text, durationMs: null });
    clock.advance(19_999); // past the card's usual 15 s: a pending card does not hide
    await flush();
    expect(events).toEqual(["show pending"]);
    clock.advance(1); // the explainer's 20 s timeout
    await flush();
    expect(events).toEqual(["show pending", "update ready"]);
    expect((cards[1] as TermCard).explanation).toMatch(/^Couldn't explain this yet/);
    expect(cards[1].durationMs).toBe(15_000);
  });

  it("press before ready, answer arrives: same card id updated, then the 15 s timer runs", async () => {
    explainer.prefetch("SOC 2");
    press();
    clock.advance(3 * S);
    llm.calls[0].end(answer);
    await flush();
    expect(events).toEqual(["show pending", "update ready"]);
    expect(cards[1].id).toBe(cards[0].id);
    expect(cards[1]).toMatchObject({ explanation: answer.explanation, pending: false, durationMs: 15_000 });
    clock.advance(14_999);
    expect(overlay.current()).not.toBeNull();
    clock.advance(1);
    expect(events).toEqual(["show pending", "update ready", "hide timeout"]);
  });

  it("an answer for a card that is no longer visible changes nothing on screen", async () => {
    explainer.prefetch("SOC 2");
    press();
    press(); // toggle off
    llm.calls[0].end(answer);
    await flush();
    expect(events).toEqual(["show pending", "hide toggle"]);
  });

  it("failures are not cached: the next prefetch asks again", async () => {
    explainer.prefetch("SOC 2");
    llm.calls[0].fail(new LlmError("rate_limit", "HTTP 429"));
    await flush();
    expect(explainer.state("SOC 2")).toBe("failed");
    expect(explainer.lookup("SOC 2")?.explanation).toMatch(/rate limit/i);
    explainer.prefetch("SOC 2");
    expect(llm.calls).toHaveLength(2);
    expect(explainer.lookup("SOC 2")?.pending).toBe(true);
  });

  it("unknown terms have no entry", () => {
    expect(explainer.lookup("nothing")).toBeUndefined();
  });

  it("works with SlotManager's placed event (prefetch on placement)", async () => {
    const slots = new SlotManager({ clock });
    slots.on("placed", ({ candidate }: { candidate: TermCandidate }) => {
      if (candidate.source === "live") explainer.prefetch(candidate.term);
    });
    slots.add(soc2);
    expect(llm.calls).toHaveLength(1);
    slots.add({ term: "RAG", category: "Tech", source: "mock" });
    expect(llm.calls).toHaveLength(1);
  });
});
