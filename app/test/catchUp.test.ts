import { beforeEach, describe, expect, it } from "vitest";
import { CATCH_UP_SLOT, CatchUpController, cleanBullets } from "../src/pipeline/catchUp.js";
import { LlmError } from "../src/pipeline/llm.js";
import { OverlayController, type OverlayCard, type TextCard } from "../src/pipeline/overlay.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { TranscriptBuffer } from "../src/pipeline/transcriptBuffer.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

describe("CatchUpController", () => {
  let clock: FakeClock;
  let llm: FakeLlmClient;
  let transcript: TranscriptBuffer;
  let slots: SlotManager;
  let overlay: OverlayController;
  let catchUp: CatchUpController;
  let now: number;
  let logs: string[];
  let slot6: string[];
  let cards: OverlayCard[];
  let outcomes: string[];

  const text = () => overlay.current() as TextCard;

  function talk(until: number): void {
    for (let t = 0; t <= until; t += 5) transcript.add({ t, speaker: "Lena", text: `line at ${t}` });
    now = until;
  }

  beforeEach(() => {
    clock = new FakeClock();
    llm = new FakeLlmClient();
    transcript = new TranscriptBuffer();
    slots = new SlotManager({ clock });
    overlay = new OverlayController({ clock, lookup: () => ({ full: "RAG", explanation: "e", example: "x", category: "Tech" }) });
    logs = [];
    slot6 = [];
    cards = [];
    outcomes = [];
    now = 0;
    slots.on("change", (keys: KeyState[]) => {
      for (const k of keys) if (k.slot === CATCH_UP_SLOT) slot6.push(k.state);
    });
    overlay.on("show", (c: OverlayCard) => cards.push(c));
    catchUp = new CatchUpController({
      clock,
      llm,
      transcript,
      meetingTime: () => now,
      keys: slots,
      overlay,
      log: (m) => logs.push(m),
      onLlmOutcome: (o) => outcomes.push(o.ok ? "ok" : o.error.kind),
    });
  });

  it("says 'Not much has been said yet.' under 15 s and does not call the model", () => {
    talk(10);
    expect(catchUp.press()).toBe("not-much");
    expect(llm.calls).toHaveLength(0);
    expect(text()).toMatchObject({ title: "Not much has been said yet.", tone: "info" });
    expect(slot6).toEqual([]);
  });

  it("with an empty transcript too", () => {
    expect(catchUp.press()).toBe("not-much");
    expect(llm.calls).toHaveLength(0);
  });

  it("streams the last 120 s into a text card, slot 6 busy then shown", async () => {
    talk(200);
    clock.advance(0);
    expect(catchUp.press()).toBe("started");
    expect(slots.getAll()[CATCH_UP_SLOT].state).toBe("busy");
    expect(text()).toMatchObject({ eyebrow: "Catch-up · last 2 min", streaming: true, durationMs: null, body: "" });
    const call = llm.last();
    expect(call.kind).toBe("stream");
    const user = call.req.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("[1:20] Lena: line at 80");
    expect(user).not.toContain("line at 75");
    expect(user).toContain("[3:20] Lena: line at 200");

    clock.advance(850);
    call.push("- Said: Omar ");
    await flush();
    expect(text().body).toBe("- Said: Omar"); // first token goes out right away
    expect(logs).toContain("catch-up: first token after 850 ms");

    call.push("demoed search.\n- Decided: ");
    await flush();
    expect(text().body).toBe("- Said: Omar"); // batched until the 80 ms flush
    clock.advance(80);
    expect(text().body).toBe("- Said: Omar demoed search.\n- Decided:");

    call.push("ship to partners.\n- Now: costs.").end();
    await catchUp.whenIdle();
    expect(text()).toMatchObject({
      body: "- Said: Omar demoed search.\n- Decided: ship to partners.\n- Now: costs.",
      streaming: false,
      durationMs: 20_000,
    });
    expect(slot6).toEqual(["busy", "shown"]);
    expect(outcomes).toEqual(["ok"]);
    clock.advance(20_000);
    expect(overlay.current()).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("warns when the first token takes over 3 s", async () => {
    talk(60);
    catchUp.press();
    clock.advance(3200);
    llm.last().push("- Said: x").end();
    await catchUp.whenIdle();
    expect(logs).toContain("WARNING: catch-up: first token after 3200 ms (target 3000 ms)");
  });

  it("ignores a press while running, hides its finished card on the next press", async () => {
    talk(60);
    catchUp.press();
    expect(catchUp.press()).toBe("ignored");
    expect(llm.calls).toHaveLength(1);
    llm.last().push("- Said: x").end();
    await catchUp.whenIdle();
    expect(catchUp.press()).toBe("hidden");
    expect(overlay.current()).toBeNull();
    expect(catchUp.press()).toBe("started");
    expect(llm.calls).toHaveLength(2);
  });

  it("stops the request when a term card replaces it", async () => {
    talk(60);
    catchUp.press();
    const call = llm.last();
    overlay.press({ kind: "term", slot: 0, term: "RAG" });
    call.push("- Said: x");
    await catchUp.whenIdle();
    expect(call.aborted).toBe(true);
    expect(overlay.current()?.kind).toBe("term");
    expect(slot6).toEqual(["busy", "shown"]);
    expect(logs).toContain("catch-up: card was replaced, request stopped");
  });

  it("rate limit -> error card with advice, key back to shown", async () => {
    talk(60);
    catchUp.press();
    llm.last().fail(new LlmError("rate_limit", "HTTP 429", { status: 429, retryAfterS: 12 }));
    await catchUp.whenIdle();
    expect(text()).toMatchObject({
      eyebrow: "Catch-up failed",
      tone: "error",
      body: "Too many requests (rate limit). Wait 12 s, then press again.",
      durationMs: 8000,
    });
    expect(slot6).toEqual(["busy", "shown"]);
    expect(outcomes).toEqual(["rate_limit"]);
  });

  it("times out after 20 s with no answer", async () => {
    talk(60);
    catchUp.press();
    const call = llm.last();
    clock.advance(19_999);
    await flush();
    expect(slots.getAll()[CATCH_UP_SLOT].state).toBe("busy");
    clock.advance(1);
    await catchUp.whenIdle();
    expect(call.aborted).toBe(true);
    expect(text()).toMatchObject({ tone: "error", body: "No answer within 20 s. Press again in a moment." });
    expect(slots.getAll()[CATCH_UP_SLOT].state).toBe("shown");
  });

  it("an empty answer is an error, not an empty card", async () => {
    talk(60);
    catchUp.press();
    llm.last().end();
    await catchUp.whenIdle();
    expect(text()).toMatchObject({ tone: "error", body: "The model's answer could not be used. Press again." });
  });

  it("cancel() (restart) stops the run and restores the key", async () => {
    talk(60);
    catchUp.press();
    const call = llm.last();
    catchUp.cancel();
    expect(call.aborted).toBe(true);
    expect(slots.getAll()[CATCH_UP_SLOT].state).toBe("shown");
    await catchUp.whenIdle();
    expect(cards.filter((c) => c.kind === "text" && c.tone === "error")).toHaveLength(0);
    expect(catchUp.press()).toBe("started");
  });
});

describe("cleanBullets", () => {
  it("normalises bullets and drops blank lines", () => {
    expect(cleanBullets("\n• **Said:** a\n\n* Decided: b\n-Now: c\n")).toBe("- Said: a\n- Decided: b\n- Now: c");
    expect(cleanBullets("Said: a\nDecided: b\n- Now: c")).toBe("- Said: a\n- Decided: b\n- Now: c");
  });
});
