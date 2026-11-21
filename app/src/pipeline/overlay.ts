import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import type { GlossaryEntry } from "./mockData.js";
import { CATEGORY_COLORS, type Category } from "./protocol.js";
import type { PressResult } from "./slots.js";
import { normalizeTerm } from "./terms.js";

/** Everything the overlay window needs to draw one card. */
export interface OverlayCard {
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
 * - Bottom-row keys, empty and invalid slots do nothing yet (the visible card stays).
 * - Events: `show` (OverlayCard), `hide` ({ reason: HideReason }).
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
    if (this.card && normalizeTerm(this.card.term) === normalizeTerm(r.term)) {
      this.hide("toggle");
      return "hidden";
    }
    const entry = this.lookup(r.term);
    if (!entry) return "ignored";
    const switched = this.card !== null;
    this.show(r.term, entry);
    return switched ? "switched" : "shown";
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
      id: this.nextId++,
      term,
      title: e.full || term,
      category: e.category,
      color: CATEGORY_COLORS[e.category],
      explanation: e.explanation,
      example: e.example,
      durationMs: this.visibleMs,
    };
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.hide("timeout");
    }, this.visibleMs);
    this.emit("show", this.card);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
