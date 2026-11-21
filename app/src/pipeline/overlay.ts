import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import type { GlossaryEntry } from "./mockData.js";
import { CATEGORY_COLORS, type Category } from "./protocol.js";
import type { PressResult } from "./slots.js";
import { normalizeTerm } from "./terms.js";

/** A term explanation card (glossary). */
export interface TermCard {
  kind: "term";
  /** New for every show, so the window can report when exactly this card was on screen. */
  id: number;
  /** Term as it sits on the key (glossary key). */
  term: string;
  /** Full term, shown large. */
  title: string;
  category: Category;
  /** Category chip colour, same as the key. */
  color: string;
  explanation: string;
  example: string;
  /** How long the card stays up (drives the countdown bar). */
  durationMs: number;
}

export type TextTone = "info" | "success" | "error";

/** A free-text card (Catch-up, Save confirmation, errors). `body` may fill in while streaming. */
export interface TextCard {
  kind: "text";
  id: number;
  /** Small line above the title, e.g. "Catch-up". */
  eyebrow: string;
  title: string;
  /** Lines starting with "- " are drawn as bullets. */
  body: string;
  tone: TextTone;
  /** True while text is still arriving (the card shows a caret). */
  streaming: boolean;
  /** Auto-hide after this long; null = stay up until finishText() sets a duration. */
  durationMs: number | null;
}

/** Everything the overlay window needs to draw one card. */
export type OverlayCard = TermCard | TextCard;

export interface TextCardOptions {
  eyebrow: string;
  title: string;
  body?: string;
  tone?: TextTone;
  streaming?: boolean;
  durationMs: number | null;
}

export type HideReason = "toggle" | "timeout" | "restart";
export type OverlayPressOutcome = "shown" | "switched" | "hidden" | "ignored";

export interface OverlayControllerOptions {
  clock: Clock;
  /** Explanation for a term, or undefined if there is none. */
  lookup: (term: string) => GlossaryEntry | undefined;
  /** Card hides itself after this long. */
  visibleMs?: number;
}

/**
 * Decides which explanation card is visible. No Electron: the window only follows its events.
 *
 * - A term key press shows that term's card; the same key again while it is visible hides it;
 *   another term key switches the card. A seen term re-opens normally.
 * - The card hides itself `visibleMs` (15 s) after the last show.
 * - press() ignores bottom-row, empty and invalid slots (the visible card stays); the Catch-up and
 *   Save controllers show text cards with showText() / updateText() / finishText().
 * - Events: `show` (OverlayCard), `update` (TextCard, same id with new body/duration),
 *   `hide` ({ reason: HideReason }).
 */
export class OverlayController extends EventEmitter {
  private readonly clock: Clock;
  private readonly lookup: (term: string) => GlossaryEntry | undefined;
  private readonly visibleMs: number;
  private card: OverlayCard | null = null;
  private timer: TimerHandle | null = null;
  private nextId = 1;

  constructor(opts: OverlayControllerOptions) {
    super();
    this.clock = opts.clock;
    this.lookup = opts.lookup;
    this.visibleMs = opts.visibleMs ?? 15_000;
  }

  press(r: PressResult): OverlayPressOutcome {
    if (r.kind !== "term") return "ignored";
    if (this.card?.kind === "term" && normalizeTerm(this.card.term) === normalizeTerm(r.term)) {
      this.hide("toggle");
      return "hidden";
    }
    const entry = this.lookup(r.term);
    if (!entry) return "ignored";
    const switched = this.card !== null;
    this.show(r.term, entry);
    return switched ? "switched" : "shown";
  }

  /** Show a text card (replaces whatever is visible). Returns its id. */
  showText(opts: TextCardOptions): number {
    this.cancelTimer();
    const card: TextCard = {
      kind: "text",
      id: this.nextId++,
      eyebrow: opts.eyebrow,
      title: opts.title,
      body: opts.body ?? "",
      tone: opts.tone ?? "info",
      streaming: opts.streaming ?? false,
      durationMs: opts.durationMs,
    };
    this.card = card;
    if (card.durationMs !== null) this.startTimer(card.durationMs);
    this.emit("show", card);
    return card.id;
  }

  /** New body for a visible text card. False if that card is no longer visible. */
  updateText(id: number, body: string): boolean {
    const c = this.card;
    if (c?.kind !== "text" || c.id !== id) return false;
    if (c.body === body) return true;
    this.card = { ...c, body };
    this.emit("update", this.card);
    return true;
  }

  /** Text is complete: stop the caret and auto-hide after `durationMs`. False if not visible. */
  finishText(id: number, durationMs: number, body?: string): boolean {
    const c = this.card;
    if (c?.kind !== "text" || c.id !== id) return false;
    this.card = { ...c, body: body ?? c.body, streaming: false, durationMs };
    this.startTimer(durationMs);
    this.emit("update", this.card);
    return true;
  }

  isVisible(id: number): boolean {
    return this.card?.id === id;
  }

  /** Hide the visible card, if any. */
  hide(reason: HideReason): void {
    this.cancelTimer();
    if (!this.card) return;
    this.card = null;
    this.emit("hide", { reason });
  }

  current(): OverlayCard | null {
    return this.card;
  }

  dispose(): void {
    this.cancelTimer();
    this.card = null;
    this.removeAllListeners();
  }

  private show(term: string, e: GlossaryEntry): void {
    this.cancelTimer();
    this.card = {
      kind: "term",
      id: this.nextId++,
      term,
      title: e.full || term,
      category: e.category,
      color: CATEGORY_COLORS[e.category],
      explanation: e.explanation,
      example: e.example,
      durationMs: this.visibleMs,
    };
    this.startTimer(this.visibleMs);
    this.emit("show", this.card);
  }

  private startTimer(ms: number): void {
    this.cancelTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.hide("timeout");
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
