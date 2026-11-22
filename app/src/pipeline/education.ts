// Education mode, bottom row: Flashcard (slot 6) and Quiz me (slot 7). Explain simply (slot 8) is a
// CatchUpController with explainSimplyMessages (see main.ts).

import { access, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmOutcome } from "./catchUp.js";
import type { Clock, TimerHandle } from "./clock.js";
import { DEFAULT_TIMEOUT_MS, LlmError, errorAdvice, toLlmError, withTimeout, type LlmClient } from "./llm.js";
import type { OverlayController } from "./overlay.js";
import {
  FLASHCARD_SCHEMA,
  QUIZ_SCHEMA,
  flashcardMessages,
  quizMessages,
  type FlashcardJson,
  type QuizJson,
} from "./prompts.js";
import type { ActionKeys } from "./slots.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export const FLASHCARD_SLOT = 6;
export const QUIZ_SLOT = 7;
export const ADDED_LABEL = "Added ✓";
export const ADDED_GREEN = "#3FB950";
/** Label colour of Quiz me while a question waits for its answer. */
export const ANSWER_COLOR = "#E3B341";

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const LETTERS = ["A", "B", "C"];

/** Shared by both controllers: transcript, model, key and card plumbing. */
export interface EducationOptions {
  clock: Clock;
  llm: LlmClient;
  transcript: { getLast(seconds: number, now?: number): TranscriptLine[] };
  meetingTime: () => number;
  keys: ActionKeys;
  overlay: OverlayController;
  log: (msg: string) => void;
  onLlmOutcome?: (o: LlmOutcome) => void;
  timeoutMs?: number;
  /** At most one model call per this long; presses in between are ignored. */
  cooldownMs?: number;
  errorMs?: number;
}

// --- Flashcard -------------------------------------------------------------------------------------

export interface Flashcard extends FlashcardJson {
  /** Lecture second of the newest line it was made from. */
  t: number;
}

export function validateFlashcard(v: unknown): FlashcardJson {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
  const o = v as Record<string, unknown>;
  const front = typeof o.front === "string" ? clean(o.front) : "";
  const back = typeof o.back === "string" ? clean(o.back) : "";
  if (!front) throw new Error('"front" must be a non-empty string');
  if (!back) throw new Error('"back" must be a non-empty string');
  return { front, back };
}

export interface FlashcardFile {
  append(row: Flashcard): Promise<void>;
}

const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Anki-ready CSV (File → Import): header lines tell Anki the separator and columns, then
 * one `front,back,tags` row per card. Created with its folder when missing.
 */
export function fileFlashcards(path: string, tag = "meeting-keypad"): FlashcardFile {
  return {
    async append(card: Flashcard): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      let exists = true;
      try {
        await access(path);
      } catch {
        exists = false;
      }
      const header = exists ? "" : "#separator:comma\n#html:false\n#columns:Front,Back,Tags\n";
      await appendFile(path, `${header}${csvField(card.front)},${csvField(card.back)},${csvField(tag)}\n`, "utf8");
    },
  };
}

export interface FlashcardOptions extends EducationOptions {
  file: FlashcardFile;
  windowS?: number;
  flashMs?: number;
  cardMs?: number;
}

export type FlashcardPress = "ignored" | "empty" | "duplicate" | "cooldown" | "started";

/**
 * Flashcard key: the model turns the last 90 s of the lecture into one {front, back} card, appended to
 * output/flashcards.csv (Anki import). The key flashes "Added ✓" and a card shows front and back.
 * Nothing new said since the last card -> that card again, no model call. Cards already made this
 * lecture are passed to the model so it picks another idea.
 */
export class FlashcardController {
  private readonly o: Required<Omit<FlashcardOptions, "onLlmOutcome">> & Pick<FlashcardOptions, "onLlmOutcome">;
  private busy: AbortController | null = null;
  private flashTimer: TimerHandle | null = null;
  private made: Flashcard[] = [];
  private lastCallAt: number | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: FlashcardOptions) {
    this.o = { windowS: 90, timeoutMs: DEFAULT_TIMEOUT_MS, cooldownMs: 3000, errorMs: 8000, flashMs: 1500, cardMs: 8000, ...opts };
  }

  press(): FlashcardPress {
    const { log, overlay } = this.o;
    if (this.busy) {
      log("flashcard: already making one, press ignored");
      return "ignored";
    }
    const lines = this.o.transcript.getLast(this.o.windowS, this.o.meetingTime());
    if (lines.length === 0) {
      overlay.showText({ eyebrow: "Flashcard", title: "Nothing to make a card from yet.", durationMs: 3000 });
      return "empty";
    }
    const last = this.made[this.made.length - 1];
    if (last && lines[lines.length - 1].t <= last.t) {
      log("flashcard: nothing new since the last card, shown again");
      this.confirm(last, true);
      return "duplicate";
    }
    const since = this.lastCallAt === null ? Infinity : this.o.clock.now() - this.lastCallAt;
    if (since < this.o.cooldownMs) {
      log(`flashcard: press during the ${this.o.cooldownMs / 1000} s cooldown, ignored`);
      return "cooldown";
    }
    const p = this.run(lines);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return "started";
  }

  cards(): Flashcard[] {
    return this.made.map((c) => ({ ...c }));
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  reset(): void {
    this.busy?.abort(new LlmError("cancelled", "Cancelled"));
    this.busy = null;
    if (this.flashTimer !== null) this.o.clock.clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.o.keys.setActionOverride(FLASHCARD_SLOT, null);
    this.made = [];
    this.lastCallAt = null;
  }

  private async run(lines: TranscriptLine[]): Promise<void> {
    const { clock, llm, keys, log, overlay } = this.o;
    const ac = new AbortController();
    this.busy = ac;
    this.lastCallAt = clock.now();
    keys.setActionOverride(FLASHCARD_SLOT, { state: "busy" });
    log(`flashcard: ${lines.length} lines -> ${llm.describe()}`);
    try {
      const raw = await withTimeout(
        clock,
        this.o.timeoutMs,
        (signal) =>
          llm.json(
            { messages: flashcardMessages(lines, this.made.map((c) => c.front)), maxTokens: 600, temperature: 0.2, signal },
            { name: "flashcard", schema: FLASHCARD_SCHEMA, validate: validateFlashcard },
          ),
        ac.signal,
      );
      if (this.busy !== ac) return;
      this.o.onLlmOutcome?.({ ok: true });
      const card: Flashcard = { ...raw, t: lines[lines.length - 1].t };
      try {
        await this.o.file.append(card);
      } catch (err) {
        log(`flashcard: could not write the deck: ${(err as Error).message}`);
        overlay.showText({ eyebrow: "Flashcard failed", title: "Couldn't write the deck", body: "output/flashcards.csv could not be written.", tone: "error", durationMs: this.o.errorMs });
        return;
      }
      if (this.busy !== ac) return;
      this.made.push(card);
      log(`flashcard: "${card.front}" added`);
      this.confirm(card, false);
    } catch (err) {
      if (this.busy !== ac) return;
      const e = toLlmError(err);
      log(`flashcard failed: ${e.kind}: ${e.message}`);
      overlay.showText({ eyebrow: "Flashcard failed", title: "Couldn't make a card", body: errorAdvice(e), tone: "error", durationMs: this.o.errorMs });
      this.o.onLlmOutcome?.({ ok: false, error: e });
    } finally {
      if (this.busy === ac) {
        this.busy = null;
        if (this.flashTimer === null) keys.setActionOverride(FLASHCARD_SLOT, null);
      }
    }
  }

  private confirm(card: Flashcard, again: boolean): void {
    const { clock, keys, overlay } = this.o;
    keys.setActionOverride(FLASHCARD_SLOT, { label: ADDED_LABEL, color: ADDED_GREEN, state: "shown" });
    if (this.flashTimer !== null) clock.clearTimeout(this.flashTimer);
    this.flashTimer = clock.setTimeout(() => {
      this.flashTimer = null;
      if (!this.busy) keys.setActionOverride(FLASHCARD_SLOT, null);
    }, this.o.flashMs);
    overlay.showText({
      eyebrow: again ? "Flashcard · already added" : `Flashcard added · ${this.made.length} this lecture`,
      title: card.front,
      body: `- ${card.back}`,
      tone: "success",
      durationMs: this.o.cardMs,
    });
  }
}

// --- Quiz me ----------------------------------------------------------------------------------------

export function validateQuiz(v: unknown): QuizJson {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
  const o = v as Record<string, unknown>;
  const question = typeof o.question === "string" ? clean(o.question) : "";
  if (!question) throw new Error('"question" must be a non-empty string');
  if (!Array.isArray(o.choices) || o.choices.length !== 3) throw new Error('"choices" must have exactly 3 entries');
  const choices = o.choices.map((c) => (typeof c === "string" ? clean(c) : ""));
  if (choices.some((c) => !c)) throw new Error('"choices" must be non-empty strings');
  const idx = typeof o.answerIndex === "string" ? Number.parseInt(o.answerIndex, 10) : o.answerIndex;
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > 2) throw new Error('"answerIndex" must be 0, 1 or 2');
  const explanation = typeof o.explanation === "string" ? clean(o.explanation) : "";
  return { question, choices, answerIndex: idx, explanation };
}

export interface QuizOptions extends EducationOptions {
  windowS?: number;
  /** Less than this much lecture -> "Not much has been taught yet." */
  minSpokenS?: number;
  /** The question card stays up this long (the key keeps "Answer" until pressed). */
  questionMs?: number;
  answerMs?: number;
}

export type QuizPress = "ignored" | "not-much" | "cooldown" | "started" | "answered";

/**
 * Quiz me key: first press -> one multiple-choice question (3 options) about the last 3 min; the key
 * reads "Answer" in amber. Next press -> the answer with a short explanation; the key is back to
 * "Quiz me". Questions already asked this lecture are passed to the model so it asks something new.
 */
export class QuizController {
  private readonly o: Required<Omit<QuizOptions, "onLlmOutcome">> & Pick<QuizOptions, "onLlmOutcome">;
  private busy: AbortController | null = null;
  private pending: QuizJson | null = null;
  private asked: QuizJson[] = [];
  private lastCallAt: number | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: QuizOptions) {
    this.o = {
      windowS: 180,
      minSpokenS: 20,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      cooldownMs: 3000,
      errorMs: 8000,
      questionMs: 60_000,
      answerMs: 12_000,
      ...opts,
    };
  }

  press(): QuizPress {
    const { log, overlay } = this.o;
    if (this.busy) {
      log("quiz: still writing a question, press ignored");
      return "ignored";
    }
    if (this.pending) {
      this.reveal();
      return "answered";
    }
    const now = this.o.meetingTime();
    const lines = this.o.transcript.getLast(this.o.windowS, now);
    if (lines.length === 0 || now - lines[0].t < this.o.minSpokenS) {
      overlay.showText({ eyebrow: "Quiz me", title: "Not much has been taught yet.", durationMs: 4000 });
      return "not-much";
    }
    const since = this.lastCallAt === null ? Infinity : this.o.clock.now() - this.lastCallAt;
    if (since < this.o.cooldownMs) {
      log(`quiz: press during the ${this.o.cooldownMs / 1000} s cooldown, ignored`);
      return "cooldown";
    }
    const p = this.run(lines);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return "started";
  }

  /** Questions asked this lecture, oldest first. */
  questions(): QuizJson[] {
    return this.asked.map((q) => ({ ...q, choices: [...q.choices] }));
  }

  waiting(): boolean {
    return this.pending !== null;
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  reset(): void {
    this.busy?.abort(new LlmError("cancelled", "Cancelled"));
    this.busy = null;
    this.pending = null;
    this.asked = [];
    this.lastCallAt = null;
    this.o.keys.setActionOverride(QUIZ_SLOT, null);
  }

  private async run(lines: TranscriptLine[]): Promise<void> {
    const { clock, llm, keys, log, overlay } = this.o;
    const ac = new AbortController();
    this.busy = ac;
    this.lastCallAt = clock.now();
    keys.setActionOverride(QUIZ_SLOT, { state: "busy" });
    log(`quiz: ${lines.length} lines -> ${llm.describe()}`);
    try {
      const q = await withTimeout(
        clock,
        this.o.timeoutMs,
        (signal) =>
          llm.json(
            { messages: quizMessages(lines, this.asked.map((a) => a.question)), maxTokens: 800, temperature: 0.4, signal },
            { name: "quiz", schema: QUIZ_SCHEMA, validate: validateQuiz },
          ),
        ac.signal,
      );
      if (this.busy !== ac) return;
      this.o.onLlmOutcome?.({ ok: true });
      this.busy = null;
      this.pending = q;
      this.asked.push(q);
      log(`quiz: "${q.question}"`);
      keys.setActionOverride(QUIZ_SLOT, { label: "Answer", color: ANSWER_COLOR, state: "shown" });
      overlay.showText({
        eyebrow: `Quiz me · question ${this.asked.length}`,
        title: q.question,
        body: [...q.choices.map((c, i) => `- ${LETTERS[i]}. ${c}`), "- Press the key again for the answer."].join("\n"),
        tone: "info",
        durationMs: this.o.questionMs,
      });
    } catch (err) {
      if (this.busy !== ac) return;
      const e = toLlmError(err);
      log(`quiz failed: ${e.kind}: ${e.message}`);
      overlay.showText({ eyebrow: "Quiz failed", title: "Couldn't write a question", body: errorAdvice(e), tone: "error", durationMs: this.o.errorMs });
      this.o.onLlmOutcome?.({ ok: false, error: e });
    } finally {
      if (this.busy === ac) {
        this.busy = null;
        keys.setActionOverride(QUIZ_SLOT, null);
      }
    }
  }

  private reveal(): void {
    const q = this.pending!;
    this.pending = null;
    this.o.keys.setActionOverride(QUIZ_SLOT, null);
    const letter = LETTERS[q.answerIndex];
    this.o.log(`quiz: answer ${letter}`);
    this.o.overlay.showText({
      eyebrow: "Quiz me · answer",
      title: `${letter}. ${q.choices[q.answerIndex]}`,
      body: q.explanation ? `- ${q.explanation}` : "",
      tone: "success",
      durationMs: this.o.answerMs,
    });
  }
}
