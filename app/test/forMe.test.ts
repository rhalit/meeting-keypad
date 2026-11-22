import { beforeEach, describe, expect, it } from "vitest";
import { ALERT_RED, ALERT_RED_DIM, FOR_ME_SLOT, ForMeController, validateForMe } from "../src/pipeline/forMe.js";
import { LlmError } from "../src/pipeline/llm.js";
import { OverlayController, type TextCard } from "../src/pipeline/overlay.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { TranscriptBuffer, type TranscriptLine } from "../src/pipeline/transcriptBuffer.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

const ASK_SOC2: TranscriptLine = { t: 152, speaker: "Lena", text: "Rhali, can you own the SOC 2 questionnaire and get a first draft to Priya by Friday?" };
const ASK_PENTEST: TranscriptLine = { t: 270, speaker: "Omar", text: "Rally, can you send me the pen test scope by Wednesday?" };

const soc2Answer = {
  isForListener: true,
  question: "Can you own the SOC 2 questionnaire and send Priya a first draft by Friday?",
  context: "The team is preparing for a customer security review. Lena needs someone to own the questionnaire.",
  suggestedReply: "Yes, I'll take it and send Priya a first draft by Friday.",
};
const pentestAnswer = {
  isForListener: true,
  question: "Can you send Omar the pen test scope by Wednesday?",
  context: "Omar is preparing the staging environment. He needs the scope first.",
  suggestedReply: "Sure, I'll send you the scope by Wednesday.",
};

describe("ForMeController", () => {
  let clock: FakeClock;
  let llm: FakeLlmClient;
  let transcript: TranscriptBuffer;
  let slots: SlotManager;
  let overlay: OverlayController;
  let forMe: ForMeController;
  let slot8: KeyState[];
  let logs: string[];

  const card = () => overlay.current() as TextCard;
  /** What main.ts does for every final line. */
  const say = (l: TranscriptLine) => {
    transcript.add(l);
    return forMe.addLine(l);
  };
  const key8 = () => slots.getAll()[FOR_ME_SLOT];

  beforeEach(() => {
    clock = new FakeClock();
    llm = new FakeLlmClient();
    transcript = new TranscriptBuffer();
    slots = new SlotManager({ clock });
    overlay = new OverlayController({ clock, lookup: () => undefined });
    logs = [];
    slot8 = [];
    slots.on("change", (keys: KeyState[]) => slot8.push(...keys.filter((k) => k.slot === FOR_ME_SLOT)));
    forMe = new ForMeController({
      clock,
      llm,
      transcript,
      keys: slots,
      overlay,
      log: (m) => logs.push(m),
      listener: { name: "Rhali", aliases: ["Rally"], knows: "a general audience" },
    });
  });

  it("makes no model call for lines without the name", () => {
    for (let i = 0; i < 20; i++) expect(say({ t: i * 5, speaker: "Lena", text: `Really, the latency is fine number ${i}.` })).toBe(false);
    expect(llm.calls).toHaveLength(0);
    expect(forMe.calls).toBe(0);
  });

  it("asks the model once when the name is heard, with the last 60 s as context", async () => {
    say({ t: 80, speaker: "Omar", text: "Too old for the context." });
    say({ t: 100, speaker: "Omar", text: "We have a security review coming." });
    say({ t: 140, speaker: "Priya", text: "The customer wants SOC 2 answers." });
    expect(say(ASK_SOC2)).toBe(true);
    expect(llm.calls).toHaveLength(1);
    const c = llm.last();
    expect(c.kind).toBe("json");
    const user = c.req.messages[1].content;
    expect(user).toContain("security review coming");
    expect(user).toContain("SOC 2 answers");
    expect(user).not.toContain("Too old");
    expect(user).toContain("LINE:\n[2:32] Lena: Rhali, can you own");
    expect(user.split("Rhali, can you own")).toHaveLength(2); // the line itself is not repeated in the context
    expect(c.req.messages[0].content).toContain("Rhali");
    c.end(soc2Answer);
    await forMe.whenIdle();
    expect(forMe.alerting()).toBe(true);
  });

  it("no alert when the line only mentions the listener", async () => {
    say({ t: 30, speaker: "Lena", text: "Thanks Rhali for the notes yesterday." });
    llm.last().end({ isForListener: false, question: "", context: "", suggestedReply: "" });
    await forMe.whenIdle();
    expect(forMe.alerting()).toBe(false);
    expect(slot8).toHaveLength(0);
    expect(forMe.questions()).toHaveLength(0);
    expect(forMe.press()).toBe("nothing");
    expect(card().title).toBe("Nothing for you so far.");
  });

  it("pulses slot 8 between two reds every 600 ms and stops after 90 s; the card stays available", async () => {
    say(ASK_SOC2);
    llm.last().end(soc2Answer);
    await forMe.whenIdle();
    expect(key8()).toEqual({ slot: 8, label: "For me?", state: "alert", color: ALERT_RED });
    clock.advance(600);
    expect(key8().color).toBe(ALERT_RED_DIM);
    clock.advance(600);
    expect(key8().color).toBe(ALERT_RED);
    clock.advance(599);
    expect(key8().color).toBe(ALERT_RED);
    clock.advance(1);
    expect(key8().color).toBe(ALERT_RED_DIM);
    clock.advance(90_000 - 1800 - 1);
    expect(key8().state).toBe("alert");
    clock.advance(1);
    expect(key8()).toEqual({ slot: 8, label: "For me?", state: "shown" });
    expect(forMe.alerting()).toBe(false);
    const changes = slot8.length;
    clock.advance(10_000);
    expect(slot8).toHaveLength(changes); // no more pulse frames
    expect(clock.pending()).toBe(0);
    // Not pressed in time: the card is still there.
    expect(forMe.press()).toBe("shown");
    expect(card().title).toBe(soc2Answer.question);
  });

  it("a press shows question, context and reply, and puts the key back to normal", async () => {
    say(ASK_SOC2);
    llm.last().end(soc2Answer);
    await forMe.whenIdle();
    clock.advance(1300);
    expect(forMe.press()).toBe("shown");
    const c = card();
    expect(c.eyebrow).toBe("For you · Lena · 2:32");
    expect(c.title).toBe(soc2Answer.question);
    expect(c.body).toBe(`Context: ${soc2Answer.context}\nSuggested reply: ${soc2Answer.suggestedReply}`);
    expect(key8()).toEqual({ slot: 8, label: "For me?", state: "shown" });
    expect(forMe.alerting()).toBe(false);
    expect(clock.pending()).toBe(1); // only the card's own timer
    expect(forMe.questions()[0].opened).toBe(true);
    // Same key again: hides; once more: the last card, no model call.
    expect(forMe.press()).toBe("hidden");
    expect(forMe.press()).toBe("reshown");
    expect(card().eyebrow).toBe("Last question for you · Lena · 2:32");
    expect(llm.calls).toHaveLength(1);
  });

  it("several mentions: the latest is shown, with '2 questions' and the earlier one listed", async () => {
    say(ASK_SOC2);
    llm.last().end(soc2Answer);
    await forMe.whenIdle();
    clock.advance(30_000);
    say(ASK_PENTEST);
    llm.last().end(pentestAnswer);
    await forMe.whenIdle();
    expect(forMe.waitingCount()).toBe(2);
    // The 90 s alert restarted at the second question.
    clock.advance(80_000);
    expect(forMe.alerting()).toBe(true);
    expect(forMe.press()).toBe("shown");
    const c = card();
    expect(c.eyebrow).toBe("For you · 2 questions");
    expect(c.title).toBe(pentestAnswer.question);
    expect(c.body).toContain(`Suggested reply: ${pentestAnswer.suggestedReply}`);
    expect(c.body).toContain(`Earlier: ${soc2Answer.question} (Lena, 2:32)`);
    expect(forMe.waitingCount()).toBe(0);
    expect(forMe.questions().map((q) => [q.t, q.opened, q.heard])).toEqual([
      [152, true, "rhali"],
      [270, true, "rally"],
    ]);
  });

  it("one call at a time: a mention during a call waits, and only the latest one", async () => {
    say(ASK_SOC2);
    expect(say({ t: 160, speaker: "Lena", text: "Rhali, also the access review?" })).toBe(true);
    expect(say({ t: 165, speaker: "Lena", text: "Rhali, and the vendor list?" })).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(forMe.press()).toBe("checking");
    llm.calls[0].end(soc2Answer);
    await flush();
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].req.messages[1].content).toContain("LINE:\n[2:45] Lena: Rhali, and the vendor list?");
    llm.calls[1].end({ ...soc2Answer, question: "Can you send the vendor list?" });
    await forMe.whenIdle();
    expect(forMe.waitingCount()).toBe(2);
    expect(forMe.calls).toBe(2);
  });

  it("a failed call is logged, no alert, and the next mention can still run", async () => {
    say(ASK_SOC2);
    llm.last().fail(new LlmError("rate_limit", "Too many requests"));
    await forMe.whenIdle();
    expect(forMe.alerting()).toBe(false);
    expect(logs.some((l) => l.includes("check failed: rate_limit"))).toBe(true);
    say(ASK_PENTEST);
    expect(llm.calls).toHaveLength(2);
  });

  it("reset() aborts a running check and clears the alert and the questions", async () => {
    say(ASK_SOC2);
    llm.last().end(soc2Answer);
    await forMe.whenIdle();
    say(ASK_PENTEST);
    const running = llm.last();
    forMe.reset();
    expect(running.aborted).toBe(true);
    await forMe.whenIdle();
    expect(key8().state).toBe("shown");
    expect(forMe.questions()).toHaveLength(0);
    expect(clock.pending()).toBe(0);
    expect(forMe.press()).toBe("nothing");
  });
});

describe("validateForMe", () => {
  it("accepts booleans as strings and needs a question when it is for the listener", () => {
    expect(validateForMe({ isForListener: "false", question: "", context: "", suggestedReply: "" }).isForListener).toBe(false);
    expect(() => validateForMe({ isForListener: true, question: " ", context: "", suggestedReply: "" })).toThrow();
    expect(() => validateForMe({ question: "x" })).toThrow();
  });
});
