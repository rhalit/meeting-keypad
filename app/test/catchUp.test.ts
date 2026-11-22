import { beforeEach, describe, expect, it } from "vitest";
import { CATCH_UP_SLOT, CatchUpController, MISSED_COLOR, cleanBullets } from "../src/pipeline/catchUp.js";
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

  it("press({ windowS }) summarises that span (key menu): card title and prompt follow it", async () => {
    talk(400);
    expect(catchUp.press({ windowS: 30 })).toBe("started");
    expect(text().eyebrow).toBe("Catch-up · last 30 s");
    const req = llm.last().req;
    const user = req.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("line at 370");
    expect(user).not.toContain("line at 365");
    expect(req.messages[0].content).toContain("the last 30 seconds of the transcript");
    llm.last().push("- Said: x").end();
    await catchUp.whenIdle();
    catchUp.press(); // hides the card
    // Same window, nothing new: re-shown. Another window right away: a new summary despite the cooldown.
    expect(catchUp.press({ windowS: 30 })).toBe("reshown");
    catchUp.press();
    expect(catchUp.press({ windowS: 600 })).toBe("started");
    expect(text().eyebrow).toBe("Catch-up · last 10 min");
    expect(llm.calls).toHaveLength(2);
  });

  it("occupied() while running or while its card is visible", async () => {
    talk(200);
    expect(catchUp.occupied()).toBe(false);
    catchUp.press();
    expect(catchUp.occupied()).toBe(true);
    llm.last().push("- Said: x").end();
    await catchUp.whenIdle();
    expect(catchUp.occupied()).toBe(true); // finished card on screen
    catchUp.press();
    expect(catchUp.occupied()).toBe(false);
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
    expect(catchUp.press()).toBe("reshown"); // nothing new said: the same summary, no call
    expect(llm.calls).toHaveLength(1);
  });

  describe("press guards", () => {
    async function summarise(body = "- Said: x") {
      expect(catchUp.press()).toBe("started");
      llm.last().push(body).end();
      await catchUp.whenIdle();
    }

    it("re-shows the last summary when no new line arrived, however long ago, without calling the model", async () => {
      talk(60);
      await summarise("- Said: first");
      catchUp.press(); // hide
      clock.advance(5 * 60_000);
      expect(catchUp.press()).toBe("reshown");
      expect(text()).toMatchObject({ eyebrow: "Catch-up · nothing new", body: "- Said: first", streaming: false, durationMs: 20_000 });
      expect(llm.calls).toHaveLength(1);
      expect(logs.some((l) => l.includes("re-shows the last summary (no new line"))).toBe(true);
      expect(catchUp.press()).toBe("hidden"); // the re-shown card toggles like any other
    });

    it("with new lines, allows a new call only 10 s after the last one started; presses in between re-show", async () => {
      talk(60);
      await summarise("- Said: first");
      catchUp.press(); // hide
      transcript.add({ t: 61, speaker: "Omar", text: "something new" });
      clock.advance(9_999);
      expect(catchUp.press()).toBe("reshown");
      expect(text()).toMatchObject({ eyebrow: "Catch-up · last summary", body: "- Said: first" });
      expect(logs.some((l) => l.includes("cooldown (1 s left)"))).toBe(true);
      catchUp.press(); // hide
      clock.advance(1);
      expect(catchUp.press()).toBe("started");
      expect(llm.calls).toHaveLength(2);
    });

    it("a burst of 117 presses (bumped in a bag) makes at most one call per 10 s", async () => {
      talk(60);
      let t = 60;
      let ended = 0;
      for (let i = 0; i < 117; i++) {
        catchUp.press();
        if (llm.calls.length > ended) {
          llm.last().push("- Said: x").end();
          ended = llm.calls.length;
        }
        await flush();
        clock.advance(1300);
        if (i % 4 === 0) transcript.add({ t: ++t, text: `new ${i}` });
      }
      // 117 presses over ~152 s with new lines all along: at most one call per 10 s.
      expect(llm.calls.length).toBeLessThanOrEqual(16);
      expect(llm.calls.length).toBeGreaterThan(1);
    });

    it("during the cooldown after a failed call, says when it can run again", async () => {
      talk(60);
      catchUp.press();
      llm.last().fail(new LlmError("server", "HTTP 500"));
      await catchUp.whenIdle();
      transcript.add({ t: 61, text: "more" });
      clock.advance(3000);
      catchUp.press(); // hides the error card
      expect(catchUp.press()).toBe("cooldown");
      expect(text().title).toBe("Try again in 7 s.");
      expect(llm.calls).toHaveLength(1);
    });

    it("a new meeting forgets the last summary and the cooldown", async () => {
      talk(60);
      await summarise();
      catchUp.cancel();
      overlay.hide("restart");
      expect(catchUp.press()).toBe("started");
    });
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

  describe("missed span (camera focus)", () => {
    const key = () => slots.getAll()[CATCH_UP_SLOT];

    it("marks the key 'Missed 2m', then summarises from the moment you looked away", async () => {
      talk(400);
      catchUp.setMissed({ from: 250, to: 380 });
      expect(key()).toMatchObject({ label: "Missed 2m", color: MISSED_COLOR, state: "shown" });
      expect(catchUp.press()).toBe("started");
      expect(key().state).toBe("busy");
      expect(text().eyebrow).toBe("Catch-up · while you were away (2 min 10 s)");
      const req = llm.last().req;
      const user = req.messages.find((m) => m.role === "user")!.content;
      expect(user).toContain("line at 250");
      expect(user).toContain("line at 400"); // up to now, not only until you looked back
      expect(user).not.toContain("line at 245");
      expect(req.messages[0].content).toContain("from the moment they looked away until now");
      llm.last().push("- Said: x").end();
      await catchUp.whenIdle();
      expect(key()).toMatchObject({ label: "Catch-up", state: "shown" }); // back to normal after the press
      expect(catchUp.missedSpan()).toBeNull();
    });

    it("after it, the usual guards apply: nothing new -> re-shown; new line + cooldown -> normal 2-minute catch-up", async () => {
      talk(400);
      catchUp.setMissed({ from: 100, to: 380 });
      catchUp.press();
      llm.last().push("- Said: x").end();
      await catchUp.whenIdle();
      catchUp.press(); // hides the finished card
      expect(catchUp.press()).toBe("reshown");
      expect(llm.calls).toHaveLength(1);
      transcript.add({ t: 405, speaker: "Lena", text: "one more thing" });
      now = 405;
      clock.advance(10_000);
      catchUp.press(); // hides the re-shown card
      expect(catchUp.press()).toBe("started");
      expect(text().eyebrow).toBe("Catch-up · last 2 min");
    });

    it("a missed span skips the 'nothing new' re-show guard", async () => {
      talk(400);
      catchUp.press();
      llm.last().push("- Said: x").end();
      await catchUp.whenIdle();
      clock.advance(10_000);
      catchUp.setMissed({ from: 300, to: 400 });
      catchUp.press(); // the summary card is still visible, but a missed span wins over the hide toggle
      expect(text().eyebrow).toBe("Catch-up · while you were away (1 min 40 s)");
      expect(llm.calls).toHaveLength(2);
    });

    it("ignores spans under 10 s; widens an unpressed span; caps at 15 min back", () => {
      talk(2000);
      catchUp.setMissed({ from: 100, to: 105 });
      expect(catchUp.missedSpan()).toBeNull();
      catchUp.setMissed({ from: 300, to: 330 });
      catchUp.setMissed({ from: 400, to: 460 });
      expect(catchUp.missedSpan()).toEqual({ from: 300, to: 460 });
      expect(key().label).toBe("Missed 3m");
      catchUp.press();
      const user = llm.last().req.messages.find((m) => m.role === "user")!.content;
      expect(user).toContain("line at 1100"); // 2000 - 900
      expect(user).not.toContain("line at 1095");
    });

    it("seconds-long spans read like 'Missed 45s'", () => {
      talk(100);
      catchUp.setMissed({ from: 50, to: 95 });
      expect(key().label).toBe("Missed 45s");
    });

    it("nothing said while away -> short card, no model call", () => {
      transcript.add({ t: 10, speaker: "Lena", text: "hello" });
      now = 200;
      catchUp.setMissed({ from: 100, to: 190 });
      expect(catchUp.press()).toBe("not-much");
      expect(llm.calls).toHaveLength(0);
      expect(text().title).toBe("Nothing was said while you were away.");
      expect(key().label).toBe("Catch-up");
    });

    it("expires after 5 min unpressed; cancel() forgets it too", () => {
      talk(100);
      catchUp.setMissed({ from: 20, to: 90 });
      clock.advance(300_000);
      expect(key().label).toBe("Catch-up");
      catchUp.setMissed({ from: 20, to: 90 });
      catchUp.cancel();
      expect(catchUp.missedSpan()).toBeNull();
      expect(key().label).toBe("Catch-up");
      expect(clock.pending()).toBe(0);
    });

    it("a span arriving mid-run shows after the run", async () => {
      talk(200);
      catchUp.press();
      catchUp.setMissed({ from: 100, to: 190 });
      expect(key().state).toBe("busy");
      llm.last().push("- Said: x").end();
      await catchUp.whenIdle();
      expect(key().label).toBe("Missed 2m");
    });
  });
});

describe("cleanBullets", () => {
  it("normalises bullets and drops blank lines", () => {
    expect(cleanBullets("\n• **Said:** a\n\n* Decided: b\n-Now: c\n")).toBe("- Said: a\n- Decided: b\n- Now: c");
    expect(cleanBullets("Said: a\nDecided: b\n- Now: c")).toBe("- Said: a\n- Decided: b\n- Now: c");
  });
});
