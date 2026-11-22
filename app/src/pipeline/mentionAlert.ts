import type { Clock, TimerHandle } from "./clock.js";
import type { OverlayController } from "./overlay.js";
import { mmss } from "./prompts.js";
import type { FlashKeys } from "./slots.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export interface MentionAlertOptions {
  clock: Clock;
  focus: { isAway(): boolean };
  keys: FlashKeys;
  overlay: Pick<OverlayController, "showText">;
  log: (msg: string) => void;
  /**
   * Shows the mention when you look back or press (the app opens the "For me?" card). Without it, a
   * simple card with who said your name is shown.
   */
  reveal?: () => void;
  /** Pulse half-period: red this long, normal this long. */
  flashMs?: number;
  /** The pulse gives up after this long (the card still shows when you come back). */
  maxFlashMs?: number;
  cardMs?: number;
}

export type MentionOutcome = "flashing" | "focused";

/**
 * A question for you was heard ("For me?" calls mention()). If the camera says you are away, all 9 keys
 * pulse red until you look back or press any key; then the mention is shown (reveal, or a simple card).
 * If you are focused, nothing happens here: slot 8 ("For me?") pulses on its own.
 */
export class MentionAlert {
  private readonly o: Required<Omit<MentionAlertOptions, "reveal">> & Pick<MentionAlertOptions, "reveal">;
  private pending: TranscriptLine[] = [];
  private flashing = false;
  private phase = false;
  private pulseTimer: TimerHandle | null = null;
  private giveUpTimer: TimerHandle | null = null;

  constructor(opts: MentionAlertOptions) {
    this.o = { flashMs: 500, maxFlashMs: 180_000, cardMs: 15_000, ...opts };
  }

  mention(line: TranscriptLine): MentionOutcome {
    if (!this.o.focus.isAway()) return "focused";
    this.pending.push(line);
    this.o.log(`mention while away at ${mmss(line.t)}: all keys pulse`);
    if (!this.flashing) this.startFlash();
    return "flashing";
  }

  isFlashing(): boolean {
    return this.flashing;
  }

  /** You looked back (FocusTracker `back`): stop the pulse and show who said your name. */
  back(): void {
    if (this.pending.length === 0) return;
    this.stopFlash();
    this.showCard();
  }

  /** A key press while pulsing only stops the pulse (and shows the card). True if it was used. */
  consumePress(): boolean {
    if (!this.flashing) return false;
    this.stopFlash();
    this.showCard();
    return true;
  }

  /** New meeting. */
  reset(): void {
    this.pending = [];
    this.stopFlash();
  }

  private startFlash(): void {
    this.flashing = true;
    this.phase = true;
    this.o.keys.setFlash(true);
    const tick = () => {
      this.pulseTimer = this.o.clock.setTimeout(() => {
        this.phase = !this.phase;
        this.o.keys.setFlash(this.phase);
        tick();
      }, this.o.flashMs);
    };
    tick();
    this.giveUpTimer = this.o.clock.setTimeout(() => {
      this.giveUpTimer = null;
      this.o.log("mention pulse: nobody looked, stopped");
      this.stopFlash();
    }, this.o.maxFlashMs);
  }

  private stopFlash(): void {
    if (this.pulseTimer !== null) this.o.clock.clearTimeout(this.pulseTimer);
    if (this.giveUpTimer !== null) this.o.clock.clearTimeout(this.giveUpTimer);
    this.pulseTimer = this.giveUpTimer = null;
    if (this.flashing) this.o.keys.setFlash(null);
    this.flashing = false;
  }

  private showCard(): void {
    const lines = this.pending;
    this.pending = [];
    if (lines.length === 0) return;
    if (this.o.reveal) {
      this.o.reveal();
      return;
    }
    const first = lines[0];
    const title = lines.length === 1 ? `${first.speaker ?? "Someone"} said your name` : `Your name came up ${lines.length} times`;
    const quotes = lines.slice(-3).map((l) => `- [${mmss(l.t)}] ${l.speaker ? `${l.speaker}: ` : ""}"${l.text}"`);
    this.o.overlay.showText({
      eyebrow: `While you were away · ${mmss(first.t)}`,
      title,
      body: [...quotes, "- Press Catch-up for what you missed."].join("\n"),
      tone: "info",
      durationMs: this.o.cardMs,
    });
  }
}
