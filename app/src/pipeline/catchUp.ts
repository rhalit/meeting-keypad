import type { Clock, TimerHandle } from "./clock.js";
import { DEFAULT_TIMEOUT_MS, LlmError, errorAdvice, toLlmError, withTimeout, type LlmClient } from "./llm.js";
import type { OverlayController } from "./overlay.js";
import { catchUpMessages } from "./prompts.js";
import type { ActionKeys } from "./slots.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export const CATCH_UP_SLOT = 6;
export const TTFT_TARGET_MS = 3000;

export type LlmOutcome = { ok: true } | { ok: false; error: LlmError };

export interface CatchUpOptions {
  clock: Clock;
  llm: LlmClient;
  transcript: { getLast(seconds: number, now?: number): TranscriptLine[] };
  /** Current meeting time in seconds. */
  meetingTime: () => number;
  keys: ActionKeys;
  overlay: OverlayController;
  log: (msg: string) => void;
  /** Reported after every real LLM call (panel status). */
  onLlmOutcome?: (o: LlmOutcome) => void;
  listenerName?: string;
  windowS?: number;
  minSpokenS?: number;
  timeoutMs?: number;
  /** Streamed text is pushed to the card at most this often. */
  flushMs?: number;
  /** The finished card stays up this long. */
  visibleMs?: number;
  errorMs?: number;
  notMuchMs?: number;
  /** At most one model call per this long (start to start); a press in between re-shows the last card. */
  cooldownMs?: number;
}

/** "reshown": the last summary again, no model call (nothing new said, or within the cooldown). */
export type CatchUpPress = "ignored" | "hidden" | "not-much" | "started" | "reshown" | "cooldown";

interface Run {
  ac: AbortController;
  cardId: number;
  startedAt: number;
  firstAt: number | null;
  text: string;
  flushTimer: TimerHandle | null;
}

/**
 * Catch-up key (slot 6): streams a 3-bullet summary of the last 120 s into a text card.
 * Slot 6 is "busy" while it runs. A press while running is ignored; a press on the visible
 * Catch-up card hides it. If another card replaces it mid-stream, the request is aborted.
 *
 * Press guards (a bumped keypad must not burn model calls): if no new final line arrived since the
 * last summary, the press re-shows it instead of calling the model; otherwise at most one call per
 * 10 s, and a press during that cooldown re-shows the last summary (or says when it can run again).
 */
export class CatchUpController {
  private readonly o: Required<Omit<CatchUpOptions, "onLlmOutcome" | "listenerName">> &
    Pick<CatchUpOptions, "onLlmOutcome" | "listenerName">;
  private run: Run | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private cardId: number | null = null;
  /** Last finished summary and the newest transcript line it covered. */
  private last: { body: string; lineKey: string } | null = null;
  /** Clock ms of the last model call. */
  private lastCallAt: number | null = null;

  constructor(opts: CatchUpOptions) {
    this.o = {
      windowS: 120,
      minSpokenS: 15,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      flushMs: 80,
      visibleMs: 20_000,
      errorMs: 8_000,
      notMuchMs: 6_000,
      cooldownMs: 10_000,
      ...opts,
    };
  }

  press(): CatchUpPress {
    const { overlay, log } = this.o;
    if (this.run) {
      log("catch-up: still running, press ignored");
      return "ignored";
    }
    if (this.cardId !== null && overlay.isVisible(this.cardId)) {
      overlay.hide("toggle");
      this.cardId = null;
      return "hidden";
    }
    const latest = this.latestLineKey();
    if (this.last && latest === this.last.lineKey) {
      log("catch-up: press re-shows the last summary (no new line since it, no model call)");
      this.reshow("nothing new");
      return "reshown";
    }
    const sinceCall = this.lastCallAt === null ? Infinity : this.o.clock.now() - this.lastCallAt;
    if (sinceCall < this.o.cooldownMs) {
      const left = Math.ceil((this.o.cooldownMs - sinceCall) / 1000);
      log(`catch-up: press during the ${this.o.cooldownMs / 1000} s cooldown (${left} s left), no model call`);
      if (this.last) {
        this.reshow("last summary");
        return "reshown";
      }
      this.cardId = overlay.showText({ eyebrow: "Catch-up", title: `Try again in ${left} s.`, durationMs: this.o.notMuchMs });
      return "cooldown";
    }
    const now = this.o.meetingTime();
    const lines = this.o.transcript.getLast(this.o.windowS, now);
    if (lines.length === 0 || now - lines[0].t < this.o.minSpokenS) {
      log("catch-up: less than 15 s said, nothing to summarise");
      this.cardId = overlay.showText({
        eyebrow: "Catch-up",
        title: "Not much has been said yet.",
        durationMs: this.o.notMuchMs,
      });
      return "not-much";
    }
    const p = this.start(lines);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return "started";
  }

  /** Resolves when no run is in progress (tests, smoke script). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Stop any run (meeting restart) and forget the last summary. The caller hides the card. */
  cancel(): void {
    const r = this.run;
    this.cardId = null;
    this.last = null;
    this.lastCallAt = null;
    if (!r) return;
    this.run = null;
    this.clearFlush(r);
    r.ac.abort(new LlmError("cancelled", "Cancelled"));
    this.o.keys.setActionOverride(CATCH_UP_SLOT, null);
  }

  private async start(lines: TranscriptLine[]): Promise<void> {
    const { clock, llm, overlay, keys, log } = this.o;
    const cardId = overlay.showText({
      eyebrow: "Catch-up · last 2 min",
      title: "Catch-up",
      streaming: true,
      durationMs: null,
    });
    const run: Run = { ac: new AbortController(), cardId, startedAt: clock.now(), firstAt: null, text: "", flushTimer: null };
    const lineKey = this.latestLineKey();
    this.run = run;
    this.lastCallAt = run.startedAt;
    this.cardId = cardId;
    keys.setActionOverride(CATCH_UP_SLOT, { state: "busy" });
    log(`catch-up: ${lines.length} lines (${lines[0].t}-${lines[lines.length - 1].t} s) -> ${llm.describe()}`);
    try {
      await withTimeout(
        clock,
        this.o.timeoutMs,
        async (signal) => {
          for await (const delta of llm.stream({
            messages: catchUpMessages(lines, this.o.listenerName),
            maxTokens: 700,
            temperature: 0.3,
            signal,
          })) {
            if (this.run !== run) return;
            if (!delta) continue;
            run.text += delta;
            if (run.firstAt === null) {
              run.firstAt = clock.now();
              const ms = run.firstAt - run.startedAt;
              const msg = `catch-up: first token after ${ms} ms`;
              log(ms > TTFT_TARGET_MS ? `WARNING: ${msg} (target ${TTFT_TARGET_MS} ms)` : msg);
              this.flush(run);
            } else if (run.flushTimer === null) {
              run.flushTimer = clock.setTimeout(() => {
                run.flushTimer = null;
                this.flush(run);
              }, this.o.flushMs);
            }
          }
        },
        run.ac.signal,
      );
      if (this.run !== run) return;
      this.clearFlush(run);
      const body = cleanBullets(run.text);
      if (!body) throw new LlmError("bad_response", "The model returned no text");
      overlay.finishText(cardId, this.o.visibleMs, body);
      this.last = { body, lineKey };
      log(`catch-up: done in ${clock.now() - run.startedAt} ms`);
      this.o.onLlmOutcome?.({ ok: true });
    } catch (err) {
      if (this.run !== run) return; // cancel() took care of it
      this.clearFlush(run);
      const e = toLlmError(err);
      if (e.kind === "cancelled") {
        log("catch-up: card was replaced, request stopped");
        return;
      }
      log(`catch-up failed: ${e.kind}: ${e.message}`);
      this.cardId = overlay.showText({
        eyebrow: "Catch-up failed",
        title: "Couldn't catch up",
        body: errorAdvice(e),
        tone: "error",
        durationMs: this.o.errorMs,
      });
      this.o.onLlmOutcome?.({ ok: false, error: e });
    } finally {
      if (this.run === run) {
        this.run = null;
        keys.setActionOverride(CATCH_UP_SLOT, null);
      }
    }
  }

  /** Identity of the newest final line in the whole transcript ("" when empty). */
  private latestLineKey(): string {
    const all = this.o.transcript.getLast(Number.POSITIVE_INFINITY);
    const l = all[all.length - 1];
    return l ? `${l.t}|${l.speaker ?? ""}|${l.text}` : "";
  }

  /** The last summary again, as a finished card (no model call). */
  private reshow(why: string): void {
    if (!this.last) return;
    this.cardId = this.o.overlay.showText({
      eyebrow: `Catch-up · ${why}`,
      title: "Catch-up",
      body: this.last.body,
      durationMs: this.o.visibleMs,
    });
  }

  /** Push the text so far; if the card is gone (another card took over), stop the request. */
  private flush(run: Run): void {
    if (this.run !== run) return;
    if (!this.o.overlay.updateText(run.cardId, cleanBullets(run.text))) {
      run.ac.abort(new LlmError("cancelled", "Card replaced"));
    }
  }

  private clearFlush(run: Run): void {
    if (run.flushTimer !== null) {
      this.o.clock.clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
  }
}

/** Every non-blank line becomes one "- " bullet (models drop or vary the marker). */
export function cleanBullets(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\*\*/g, "").trim().replace(/^(?:[-•*]\s*)+/, ""))
    .filter((l) => l !== "")
    .map((l) => `- ${l}`)
    .join("\n");
}
