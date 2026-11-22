import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatchUpController } from "../src/pipeline/catchUp.js";
import {
  ADDED_GREEN,
  ADDED_LABEL,
  ANSWER_COLOR,
  FLASHCARD_SLOT,
  FlashcardController,
  QUIZ_SLOT,
  QuizController,
  fileFlashcards,
  validateFlashcard,
  validateQuiz,
  type Flashcard,
} from "../src/pipeline/education.js";
import { OverlayController, type TextCard } from "../src/pipeline/overlay.js";
import { EDUCATION_ACTION_KEYS, type KeyState } from "../src/pipeline/protocol.js";
import { explainSimplyMessages } from "../src/pipeline/prompts.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { TranscriptBuffer } from "../src/pipeline/transcriptBuffer.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

function setup() {
  const clock = new FakeClock();
  const llm = new FakeLlmClient();
  const transcript = new TranscriptBuffer();
  const slots = new SlotManager({ clock });
  slots.setActionKeys(EDUCATION_ACTION_KEYS);
  const overlay = new OverlayController({ clock, lookup: () => undefined });
  const logs: string[] = [];
  const state = { now: 0 };
  const talk = (until: number, from = 0) => {
    for (let t = from; t <= until; t += 5) transcript.add({ t, speaker: "Prof. Martin", text: `point at ${t}` });
    state.now = until;
  };
  const base = { clock, llm, transcript, meetingTime: () => state.now, keys: slots, overlay, log: (m: string) => logs.push(m) };
  return { clock, llm, transcript, slots, overlay, logs, state, talk, base, card: () => overlay.current() as TextCard };
}

describe("Education key layout", () => {
  it("bottom row reads Flashcard · Quiz me · Explain simply, and presses map to their actions", () => {
    const { slots } = setup();
    expect(slots.getAll().slice(6).map((k) => k.label)).toEqual(["Flashcard", "Quiz me", "Explain simply"]);
    expect([6, 7, 8].map((s) => slots.press(s))).toEqual([
      { kind: "action", slot: 6, action: "flashcard" },
      { kind: "action", slot: 7, action: "quiz" },
      { kind: "action", slot: 8, action: "explain" },
    ]);
  });

  it("switching the layout resends slots 6-8 and clears their overrides", () => {
    const clock = new FakeClock();
    const slots = new SlotManager({ clock });
    const sent: KeyState[][] = [];
    slots.on("change", (k: KeyState[]) => sent.push(k));
    slots.setActionOverride(7, { label: "Saved ✓", state: "shown" });
    slots.setActionKeys(EDUCATION_ACTION_KEYS);
    expect(sent[1].map((k) => `${k.slot}:${k.label}`)).toEqual(["6:Flashcard", "7:Quiz me", "8:Explain simply"]);
    slots.setActionKeys(EDUCATION_ACTION_KEYS); // same layout: nothing sent
    expect(sent).toHaveLength(2);
  });
});

describe("FlashcardController", () => {
  let t: ReturnType<typeof setup>;
  let written: Flashcard[];
  let fc: FlashcardController;

  beforeEach(() => {
    t = setup();
    written = [];
    fc = new FlashcardController({ ...t.base, file: { append: async (c) => void written.push(c) } });
  });

  it("makes a card from the last 90 s, appends it, flashes 'Added ✓' and shows front + back", async () => {
    t.talk(200);
    expect(fc.press()).toBe("started");
    expect(t.slots.getAll()[FLASHCARD_SLOT].state).toBe("busy");
    const user = t.llm.last().req.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("point at 110");
    expect(user).not.toContain("point at 105");
    t.llm.last().end({ front: "What does sleep do to new memories?", back: "It replays them and moves them to long-term storage." });
    await fc.whenIdle();
    expect(written).toEqual([{ front: "What does sleep do to new memories?", back: "It replays them and moves them to long-term storage.", t: 200 }]);
    expect(t.slots.getAll()[FLASHCARD_SLOT]).toMatchObject({ label: ADDED_LABEL, color: ADDED_GREEN });
    expect(t.card()).toMatchObject({ title: "What does sleep do to new memories?", tone: "success" });
    expect(t.card().body).toBe("- It replays them and moves them to long-term storage.");
    t.clock.advance(1500);
    expect(t.slots.getAll()[FLASHCARD_SLOT].label).toBe("Flashcard");
  });

  it("nothing new said -> the same card again, no model call; new lines -> asks for a different card", async () => {
    t.talk(100);
    fc.press();
    t.llm.last().end({ front: "Q1", back: "A1" });
    await fc.whenIdle();
    expect(fc.press()).toBe("duplicate");
    expect(t.llm.calls).toHaveLength(1);
    t.talk(120, 105);
    t.clock.advance(3000);
    expect(fc.press()).toBe("started");
    expect(t.llm.last().req.messages[0].content).toContain('"Q1"');
  });

  it("nothing said yet -> short card; a bad model answer -> error card, key back to normal", async () => {
    expect(fc.press()).toBe("empty");
    expect(t.llm.calls).toHaveLength(0);
    t.talk(60);
    fc.press();
    t.llm.last().end({ front: "", back: "x" });
    await fc.whenIdle();
    expect(t.card()).toMatchObject({ eyebrow: "Flashcard failed", tone: "error" });
    expect(t.slots.getAll()[FLASHCARD_SLOT]).toMatchObject({ label: "Flashcard", state: "shown" });
    expect(written).toHaveLength(0);
  });

  it("validateFlashcard trims and rejects empty fields", () => {
    expect(validateFlashcard({ front: "  What  is LTP? ", back: "A lasting\\nlink." })).toEqual({ front: "What is LTP?", back: "A lasting\\nlink." });
    expect(() => validateFlashcard({ front: "x" })).toThrow();
  });
});

describe("fileFlashcards (Anki CSV)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes Anki header lines once, then quoted rows", async () => {
    dir = mkdtempSync(join(tmpdir(), "flashcards-"));
    const path = join(dir, "sub", "flashcards.csv");
    const f = fileFlashcards(path);
    await f.append({ front: 'What is "LTP"?', back: "Stronger links, after repeats.", t: 36 });
    await f.append({ front: "Second", back: "Card", t: 50 });
    expect(readFileSync(path, "utf8")).toBe(
      '#separator:comma\n#html:false\n#columns:Front,Back,Tags\n"What is ""LTP""?","Stronger links, after repeats.","meeting-keypad"\n"Second","Card","meeting-keypad"\n',
    );
  });
});

describe("QuizController", () => {
  let t: ReturnType<typeof setup>;
  let quiz: QuizController;
  const q1 = { question: "Which study method beats rereading?", choices: ["Highlighting", "Retrieval practice", "Cramming"], answerIndex: 1, explanation: "Recalling from memory strengthens it." };

  beforeEach(() => {
    t = setup();
    quiz = new QuizController(t.base);
  });

  it("press 1: a 3-choice question, key reads 'Answer'; press 2: the answer, key back to 'Quiz me'", async () => {
    t.talk(200);
    expect(quiz.press()).toBe("started");
    expect(t.slots.getAll()[QUIZ_SLOT].state).toBe("busy");
    t.llm.last().end(q1);
    await quiz.whenIdle();
    expect(t.slots.getAll()[QUIZ_SLOT]).toMatchObject({ label: "Answer", color: ANSWER_COLOR, state: "shown" });
    expect(t.card()).toMatchObject({ eyebrow: "Quiz me · question 1", title: q1.question });
    expect(t.card().body).toContain("- B. Retrieval practice");
    expect(quiz.press()).toBe("answered");
    expect(t.llm.calls).toHaveLength(1);
    expect(t.card()).toMatchObject({ title: "B. Retrieval practice", tone: "success" });
    expect(t.card().body).toBe("- Recalling from memory strengthens it.");
    expect(t.slots.getAll()[QUIZ_SLOT]).toMatchObject({ label: "Quiz me", state: "shown" });
  });

  it("the next question avoids the ones already asked", async () => {
    t.talk(200);
    quiz.press();
    t.llm.last().end(q1);
    await quiz.whenIdle();
    quiz.press();
    t.clock.advance(3000);
    expect(quiz.press()).toBe("started");
    expect(t.llm.last().req.messages[0].content).toContain(q1.question);
  });

  it("under 20 s of lecture -> 'Not much has been taught yet.', no model call", () => {
    t.talk(10);
    expect(quiz.press()).toBe("not-much");
    expect(t.llm.calls).toHaveLength(0);
  });

  it("validateQuiz: exactly 3 choices and an index 0-2", () => {
    expect(validateQuiz({ ...q1, answerIndex: "2" }).answerIndex).toBe(2);
    expect(() => validateQuiz({ ...q1, choices: ["a", "b"] })).toThrow();
    expect(() => validateQuiz({ ...q1, answerIndex: 3 })).toThrow();
  });

  it("reset() forgets a waiting question and restores the key", async () => {
    t.talk(200);
    quiz.press();
    t.llm.last().end(q1);
    await quiz.whenIdle();
    quiz.reset();
    expect(quiz.waiting()).toBe(false);
    expect(t.slots.getAll()[QUIZ_SLOT].label).toBe("Quiz me");
  });
});

describe("Explain simply (CatchUpController on slot 8)", () => {
  it("streams on slot 8 with the education prompt, and shows 'Missed' there after an away period", async () => {
    const t = setup();
    const explain = new CatchUpController({ ...t.base, slot: 8, name: "Explain simply", messages: explainSimplyMessages });
    t.talk(200);
    expect(explain.press()).toBe("started");
    expect(t.slots.getAll()[8].state).toBe("busy");
    expect(t.slots.getAll()[6].state).toBe("shown");
    expect(t.card()).toMatchObject({ eyebrow: "Explain simply · last 2 min", title: "Explain simply" });
    expect(t.llm.last().req.messages[0].content).toContain("15-year-old");
    t.llm.last().push("- Idea: sleep fixes memories\n- In plain words: x\n- Example: y").end();
    await explain.whenIdle();
    await flush();
    expect(t.slots.getAll()[8]).toMatchObject({ label: "Explain simply", state: "shown" });
    explain.setMissed({ from: 100, to: 190 });
    expect(t.slots.getAll()[8].label).toBe("Missed 2m");
    expect(t.logs.some((l) => l.startsWith("explain simply: "))).toBe(true);
  });
});
