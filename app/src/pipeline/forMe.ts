import type { LlmOutcome } from "./catchUp.js";
import type { Clock, TimerHandle } from "./clock.js";
import { DEFAULT_TIMEOUT_MS, LlmError, toLlmError, withTimeout, type JsonSpec, type LlmClient } from "./llm.js";
import { describeListener, type ListenerProfile } from "./mockData.js";
import { mentionsListener } from "./nameMatch.js";
import type { OverlayController, TextCardOptions } from "./overlay.js";
import { FOR_ME_SCHEMA, forMeMessages, mmss, type ForMeJson } from "./prompts.js";
import type { ActionKeys } from "./slots.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export const FOR_ME_SLOT = 8;
/** The two reds slot 8 alternates between while it pulses (protocol: in `alert`, `color` is the background). */
export const ALERT_RED = "#E5484D";
export const ALERT_RED_DIM = "#9E2A2F";

/** A question or request aimed at the listener. `t` = meeting seconds of the line. */
export interface ForMeQuestion {
  t: number;
  speaker?: string;
  /** The transcript line it came from. */
  line: string;
  /** The words that matched the name ("rhali", "rally", ...). */
  heard: string;
  question: string;
  context: string;
  suggestedReply: string;
  /** The listener pressed slot 8 while it was waiting. */
  opened: boolean;
}

const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim() : "");

export function validateForMe(v: unknown): ForMeJson {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
  const o = v as Record<string, unknown>;
  const raw = o.isForListener;
  const isForListener = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
  if (isForListener === null) throw new Error('"isForListener" must be a boolean');
  const out = { isForListener, question: str(o, "question"), context: str(o, "context"), suggestedReply: str(o, "suggestedReply") };
  if (isForListener && !out.question) throw new Error('"question" must be a non-empty string when isForListener is true');
  return out;
}

export const FOR_ME_SPEC: JsonSpec<ForMeJson> = { name: "for_me", schema: FOR_ME_SCHEMA, validate: validateForMe };

export interface ForMeOptions {
  clock: Clock;
  llm: LlmClient;
  transcript: { getLast(seconds: number, now?: number): TranscriptLine[] };
  keys: ActionKeys;
  overlay: OverlayController;
  log: (msg: string) => void;
  onLlmOutcome?: (o: LlmOutcome) => void;
  /** Called for every question aimed at the listener, right after slot 8 starts pulsing (camera focus uses it). */
  onQuestion?: (q: ForMeQuestion) => void;
  listener: ListenerProfile & { aliases: string[] };
  /** Transcript before the line sent as context. */
  contextS?: number;
  /** Slot 8 switches between the two reds this often. */
  pulseMs?: number;
  /** The pulse stops after this long without a press (the card stays available). */
  alertMs?: number;
  cardMs?: number;
  noteMs?: number;
  timeoutMs?: number;
}

/** "hidden": the visible For-me card was closed; "reshown": the last card again; "nothing": no question so far. */
export type ForMePress = "shown" | "hidden" | "reshown" | "checking" | "nothing";

/**
 * "For me?" key (slot 8). Every final line (mock or live) goes through addLine(). Only a line that names the
 * listener (name, an alias, or one edit from the name, see nameMatch.ts) costs a model call: LLM_MODEL decides
 * whether it is a question or request aimed at the listener and writes {question, context, suggestedReply}.
 * One call at a time; a mention during a call waits (only the latest one).
 *
 * When it is for the listener, slot 8 goes to `alert` and pulses (two reds every 600 ms) for at most 90 s.
 * A press never calls the model: it shows the latest waiting question (and "2 questions" when more are waiting),
 * marks them opened and puts the key back to normal. With nothing waiting, it re-shows the last card.
 */
export class ForMeController {
  private readonly o: Required<Omit<ForMeOptions, "onLlmOutcome" | "onQuestion">> & Pick<ForMeOptions, "onLlmOutcome" | "onQuestion">;
  private waiting: ForMeQuestion[] = [];
  private history: ForMeQuestion[] = [];
  private lastCard: TextCardOptions | null = null;
  private cardId: number | null = null;
  private running: AbortController | null = null;
  private pending: { line: TranscriptLine; heard: string } | null = null;
  private pulseTimer: TimerHandle | null = null;
  private alertTimer: TimerHandle | null = null;
  private bright = true;
  private readonly inFlight = new Set<Promise<void>>();
  /** Model calls made (smoke script, tests). */
  calls = 0;

  constructor(opts: ForMeOptions) {
    this.o = {
      contextS: 60,
      pulseMs: 600,
      alertMs: 90_000,
      cardMs: 30_000,
      noteMs: 6_000,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...opts,
    };
  }

  /** A new final line. True if it named the listener (a check started or is queued). */
  addLine(line: TranscriptLine): boolean {
    const heard = mentionsListener(line.text, { name: this.o.listener.name, aliases: this.o.listener.aliases });
    if (!heard) return false;
    if (this.running) {
      if (this.pending) this.o.log(`for-me: "${heard}" heard again during a check, the earlier waiting line is dropped`);
      else this.o.log(`for-me: "${heard}" heard during a check, queued`);
      this.pending = { line, heard };
      return true;
    }
    this.start(line, heard);
    return true;
  }

  press(): ForMePress {
    const { overlay, log } = this.o;
    if (this.cardId !== null && overlay.isVisible(this.cardId)) {
      overlay.hide("toggle");
      this.cardId = null;
      return "hidden";
    }
    if (this.waiting.length > 0) {
      const latest = this.waiting[this.waiting.length - 1];
      const earlier = this.waiting.slice(0, -1).reverse();
      const n = this.waiting.length;
      const who = [latest.speaker, mmss(latest.t)].filter(Boolean).join(" · ");
      const body = [
        latest.context && `Context: ${latest.context}`,
        latest.suggestedReply && `Suggested reply: ${latest.suggestedReply}`,
        ...earlier.map((q) => `Earlier: ${q.question} (${[q.speaker, mmss(q.t)].filter(Boolean).join(", ")})`),
      ].filter(Boolean);
      this.lastCard = {
        eyebrow: n > 1 ? `For you · ${n} questions` : `For you · ${who}`,
        title: latest.question,
        body: body.join("\n"),
        durationMs: this.o.cardMs,
      };
      for (const q of this.waiting) q.opened = true;
      this.waiting = [];
      this.stopAlert();
      this.cardId = overlay.showText(this.lastCard);
      log(`for-me: card shows "${latest.question}"${n > 1 ? ` (${n} questions)` : ""}`);
      return "shown";
    }
    if (this.running) {
      this.cardId = overlay.showText({ eyebrow: "For me?", title: "Checking what was just said…", durationMs: this.o.noteMs });
      return "checking";
    }
    if (this.lastCard) {
      this.cardId = overlay.showText({ ...this.lastCard, eyebrow: `Last question for you · ${this.lastCard.eyebrow.replace(/^For you · /, "")}` });
      return "reshown";
    }
    this.cardId = overlay.showText({ eyebrow: "For me?", title: "Nothing for you so far.", durationMs: this.o.noteMs });
    return "nothing";
  }

  /** Every question aimed at the listener in this meeting, oldest first (export). */
  questions(): ForMeQuestion[] {
    return this.history.map((q) => ({ ...q }));
  }

  /** Slot 8 is pulsing. */
  alerting(): boolean {
    return this.pulseTimer !== null;
  }

  /** Questions not opened yet. */
  waitingCount(): number {
    return this.waiting.length;
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** New meeting: stop a check and the pulse, forget every question. */
  reset(): void {
    this.running?.abort(new LlmError("cancelled", "Cancelled"));
    this.running = null;
    this.pending = null;
    this.stopAlert();
    this.waiting = [];
    this.history = [];
    this.lastCard = null;
    this.cardId = null;
  }

  private start(line: TranscriptLine, heard: string): void {
    const p = this.check(line, heard);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  private async check(line: TranscriptLine, heard: string): Promise<void> {
    const { clock, llm, log } = this.o;
    const ac = new AbortController();
    this.running = ac;
    const context = this.o.transcript
      .getLast(this.o.contextS, line.t)
      .filter((l) => !(l.t === line.t && l.text === line.text));
    const started = clock.now();
    this.calls++;
    log(`for-me: "${heard}" heard at ${mmss(line.t)}, asking ${llm.describe()} (${context.length} context lines)`);
    try {
      const r = await withTimeout(
        clock,
        this.o.timeoutMs,
        (signal) =>
          llm.json(
            {
              messages: forMeMessages({ listener: describeListener(this.o.listener), name: this.o.listener.name, heard, line, context }),
              maxTokens: 600,
              temperature: 0.2,
              signal,
            },
            FOR_ME_SPEC,
          ),
        ac.signal,
      );
      if (this.running !== ac) return;
      this.o.onLlmOutcome?.({ ok: true });
      const ms = clock.now() - started;
      if (!r.isForListener) {
        log(`for-me: ${mmss(line.t)} only mentions the listener, no alert (${ms} ms)`);
        return;
      }
      const q: ForMeQuestion = {
        t: line.t,
        speaker: line.speaker,
        line: line.text,
        heard,
        question: r.question,
        context: r.context,
        suggestedReply: r.suggestedReply,
        opened: false,
      };
      this.waiting.push(q);
      this.history.push(q);
      log(`for-me: ALERT "${q.question}" (${ms} ms, ${this.waiting.length} waiting)`);
      this.startAlert();
      this.o.onQuestion?.({ ...q });
    } catch (err) {
      if (this.running !== ac) return;
      const e = toLlmError(err);
      log(`for-me: check failed: ${e.kind}: ${e.message}`);
      if (e.kind !== "cancelled") this.o.onLlmOutcome?.({ ok: false, error: e });
    } finally {
      if (this.running === ac) {
        this.running = null;
        const next = this.pending;
        this.pending = null;
        if (next) this.start(next.line, next.heard);
      }
    }
  }

  /** Alert on (or restarted for a newer question): pulse every pulseMs, stop after alertMs. */
  private startAlert(): void {
    const { clock, keys } = this.o;
    this.stopAlert();
    this.bright = true;
    keys.setActionOverride(FOR_ME_SLOT, { state: "alert", color: ALERT_RED });
    const tick = () => {
      this.bright = !this.bright;
      keys.setActionOverride(FOR_ME_SLOT, { state: "alert", color: this.bright ? ALERT_RED : ALERT_RED_DIM });
      this.pulseTimer = clock.setTimeout(tick, this.o.pulseMs);
    };
    this.pulseTimer = clock.setTimeout(tick, this.o.pulseMs);
    this.alertTimer = clock.setTimeout(() => {
      this.alertTimer = null;
      this.o.log(`for-me: alert stopped after ${this.o.alertMs / 1000} s without a press (${this.waiting.length} still waiting)`);
      this.stopAlert();
    }, this.o.alertMs);
  }

  private stopAlert(): void {
    const { clock, keys } = this.o;
    if (this.pulseTimer !== null) clock.clearTimeout(this.pulseTimer);
    if (this.alertTimer !== null) clock.clearTimeout(this.alertTimer);
    this.pulseTimer = null;
    this.alertTimer = null;
    keys.setActionOverride(FOR_ME_SLOT, null);
  }
}
