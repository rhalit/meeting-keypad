import { access, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmOutcome } from "./catchUp.js";
import type { Clock, TimerHandle } from "./clock.js";
import { DEFAULT_TIMEOUT_MS, LlmError, errorAdvice, toLlmError, withTimeout, type LlmClient } from "./llm.js";
import type { OverlayController } from "./overlay.js";
import { SAVE_SCHEMA, mmss, saveMessages, type IdeaJson } from "./prompts.js";
import type { ActionKeys } from "./slots.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export const SAVE_SLOT = 7;
export const SAVED_LABEL = "Saved ✓";
export const SAVED_GREEN = "#3FB950";
export const MAX_QUOTE_WORDS = 20;

/** A saved idea after validation; `t` is the meeting second of the quoted line. */
export type SavedIdea = IdeaJson;

export interface SavedIdeasFile {
  append(markdown: string): Promise<void>;
}

/** Appends to a Markdown file, creating it (and its folder) with a heading when missing. */
export function fileSavedIdeas(path: string): SavedIdeasFile {
  return {
    async append(markdown: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      let exists = true;
      try {
        await access(path);
      } catch {
        exists = false;
      }
      await appendFile(path, (exists ? "" : "# Saved ideas\n\n") + markdown, "utf8");
    },
  };
}

// --- validation and normalisation -------------------------------------------------------------

/** Shape check of the model's JSON (used inside LlmClient.json). */
export function validateIdea(v: unknown): IdeaJson {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
  const o = v as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof o[k] !== "string" || (o[k] as string).trim() === "") throw new Error(`"${k}" must be a non-empty string`);
    return (o[k] as string).trim();
  };
  const t = typeof o.t === "string" ? Number.parseFloat(o.t) : o.t;
  if (typeof t !== "number" || !Number.isFinite(t)) throw new Error('"t" must be a number');
  return { title: str("title"), summary: str("summary"), quote: str("quote"), t };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
const norm = (s: string) => words(s).join(" ");

function capWords(s: string, max: number): string {
  const w = s.split(/\s+/).filter(Boolean);
  return w.length <= max ? w.join(" ") : `${w.slice(0, max).join(" ")}…`;
}

/**
 * Enforces the limits: title on one line, summary at most 2 lines, quote verbatim and at most
 * 20 words. If the quote is not in the transcript, the line nearest `t` is quoted instead.
 * `t` becomes the time of the quoted line.
 */
export function normalizeIdea(raw: IdeaJson, lines: TranscriptLine[]): SavedIdea {
  const title = raw.title.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "").slice(0, 80);
  const summary = raw.summary
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
  let quote = raw.quote.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  const nq = norm(quote);
  const source = nq ? lines.find((l) => norm(l.text).includes(nq)) : undefined;
  let t: number;
  if (source) {
    t = source.t;
  } else if (lines.length > 0) {
    const nearest = lines.reduce((a, b) => (Math.abs(b.t - raw.t) < Math.abs(a.t - raw.t) ? b : a));
    quote = nearest.text;
    t = nearest.t;
  } else {
    t = raw.t;
  }
  return { title, summary, quote: capWords(quote, MAX_QUOTE_WORDS), t };
}

/** The earlier idea this one repeats, or null. */
export function findDuplicate(idea: SavedIdea, saved: SavedIdea[]): SavedIdea | null {
  const q = norm(idea.quote.replace(/…$/, ""));
  const tw = new Set(words(idea.title));
  for (const s of saved) {
    if (Math.abs(s.t - idea.t) < 0.01) return s;
    const sq = norm(s.quote.replace(/…$/, ""));
    if (q && sq && (q.includes(sq) || sq.includes(q))) return s;
    const sw = new Set(words(s.title));
    const inter = [...tw].filter((w) => sw.has(w)).length;
    const union = new Set([...tw, ...sw]).size;
    if (union > 0 && inter / union >= 0.6) return s;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatEntry(idea: SavedIdea, savedAt: Date): string {
  const stamp =
    `${savedAt.getFullYear()}-${pad(savedAt.getMonth() + 1)}-${pad(savedAt.getDate())} ` +
    `${pad(savedAt.getHours())}:${pad(savedAt.getMinutes())}`;
  return `## ${idea.title}\n*Meeting ${mmss(idea.t)} · saved ${stamp}*\n\n${idea.summary}\n\n> "${idea.quote}"\n\n`;
}

// --- controller --------------------------------------------------------------------------------

export interface SaveOptions {
  clock: Clock;
  llm: LlmClient;
  transcript: { getLast(seconds: number, now?: number): TranscriptLine[] };
  meetingTime: () => number;
  keys: ActionKeys;
  overlay: OverlayController;
  file: SavedIdeasFile;
  log: (msg: string) => void;
  onLlmOutcome?: (o: LlmOutcome) => void;
  /** Wall clock for the "saved" stamp. */
  now?: () => Date;
  windowS?: number;
  timeoutMs?: number;
  flashMs?: number;
  titleCardMs?: number;
  errorMs?: number;
  /** At most one model call per this long (start to start); presses in between are ignored. */
  cooldownMs?: number;
}

export type SavePress = "ignored" | "empty" | "duplicate" | "cooldown" | "started";
export type SaveResult = "saved" | "duplicate" | "failed" | "cancelled";

/**
 * Save key (slot 7): the model picks the main idea of the last 45 s as {title, summary, quote, t};
 * it is appended to output/saved-ideas.md. The key flashes "Saved ✓" in green for 1.5 s and a
 * small card shows the title for 3 s.
 *
 * No duplicates: a press while saving is ignored; with no new transcript line since the last
 * save the model is not asked again; and a result that repeats an idea saved in this meeting
 * (same quoted line, overlapping quote or near-identical title) is not written. On top of that,
 * at most one model call per 3 s: a press in that cooldown is ignored (logged).
 */
export class SaveController {
  private readonly o: Required<Omit<SaveOptions, "onLlmOutcome">> & Pick<SaveOptions, "onLlmOutcome">;
  private busy: AbortController | null = null;
  private flashTimer: TimerHandle | null = null;
  private saved: SavedIdea[] = [];
  private last: { idea: SavedIdea; upTo: number } | null = null;
  /** Clock ms of the last model call. */
  private lastCallAt: number | null = null;
  private readonly inFlight = new Set<Promise<SaveResult>>();
  /** Outcome of the last finished run (tests, smoke script). */
  lastResult: SaveResult | null = null;

  constructor(opts: SaveOptions) {
    this.o = {
      now: () => new Date(),
      windowS: 45,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      flashMs: 1500,
      titleCardMs: 3000,
      errorMs: 8000,
      cooldownMs: 3000,
      ...opts,
    };
  }

  press(): SavePress {
    const { log, overlay } = this.o;
    if (this.busy) {
      log("save: already saving, press ignored");
      return "ignored";
    }
    const lines = this.o.transcript.getLast(this.o.windowS, this.o.meetingTime());
    if (lines.length === 0) {
      overlay.showText({ eyebrow: "Save", title: "Nothing to save yet.", durationMs: this.o.titleCardMs });
      return "empty";
    }
    const upTo = lines[lines.length - 1].t;
    if (this.last && upTo <= this.last.upTo) {
      log(`save: nothing new since "${this.last.idea.title}", not saved again`);
      this.confirm(this.last.idea, true);
      return "duplicate";
    }
    const since = this.lastCallAt === null ? Infinity : this.o.clock.now() - this.lastCallAt;
    if (since < this.o.cooldownMs) {
      log(`save: press during the ${this.o.cooldownMs / 1000} s cooldown (${since} ms after the last save), ignored`);
      return "cooldown";
    }
    const p = this.run(lines);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return "started";
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** New meeting: stop a running save, restore the key, forget what was saved. */
  reset(): void {
    this.busy?.abort(new LlmError("cancelled", "Cancelled"));
    this.busy = null;
    if (this.flashTimer !== null) this.o.clock.clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.o.keys.setActionOverride(SAVE_SLOT, null);
    this.saved = [];
    this.last = null;
    this.lastCallAt = null;
  }

  private async run(lines: TranscriptLine[]): Promise<SaveResult> {
    const { clock, llm, keys, log, overlay } = this.o;
    const ac = new AbortController();
    this.busy = ac;
    keys.setActionOverride(SAVE_SLOT, { state: "busy" });
    const started = clock.now();
    this.lastCallAt = started;
    const upTo = lines[lines.length - 1].t;
    log(`save: ${lines.length} lines (${lines[0].t}-${upTo} s) -> ${llm.describe()}`);
    let result: SaveResult = "failed";
    try {
      const raw = await withTimeout(
        clock,
        this.o.timeoutMs,
        (signal) =>
          llm.json(
            { messages: saveMessages(lines), maxTokens: 800, temperature: 0.2, signal },
            { name: "saved_idea", schema: SAVE_SCHEMA, validate: validateIdea },
          ),
        ac.signal,
      );
      if (this.busy !== ac) return (result = "cancelled");
      this.o.onLlmOutcome?.({ ok: true });
      const idea = normalizeIdea(raw, lines);
      const dup = findDuplicate(idea, this.saved);
      if (dup) {
        this.last = { idea: dup, upTo };
        log(`save: "${idea.title}" repeats "${dup.title}", not saved again`);
        this.confirm(dup, true);
        return (result = "duplicate");
      }
      try {
        await this.o.file.append(formatEntry(idea, this.o.now()));
      } catch (err) {
        log(`save: could not write saved ideas: ${(err as Error).message}`);
        overlay.showText({
          eyebrow: "Save failed",
          title: "Couldn't write the file",
          body: "output/saved-ideas.md could not be written. Check the folder permissions, then press again.",
          tone: "error",
          durationMs: this.o.errorMs,
        });
        return (result = "failed");
      }
      if (this.busy !== ac) return (result = "cancelled");
      this.saved.push(idea);
      this.last = { idea, upTo };
      log(`save: "${idea.title}" (meeting ${mmss(idea.t)}) saved in ${clock.now() - started} ms`);
      this.confirm(idea, false);
      return (result = "saved");
    } catch (err) {
      if (this.busy !== ac) return (result = "cancelled");
      const e = toLlmError(err);
      log(`save failed: ${e.kind}: ${e.message}`);
      overlay.showText({
        eyebrow: "Save failed",
        title: "Couldn't save",
        body: errorAdvice(e),
        tone: "error",
        durationMs: this.o.errorMs,
      });
      this.o.onLlmOutcome?.({ ok: false, error: e });
      return (result = "failed");
    } finally {
      if (this.busy === ac) {
        this.busy = null;
        if (this.flashTimer === null) keys.setActionOverride(SAVE_SLOT, null);
      }
      this.lastResult = result;
    }
  }

  private confirm(idea: SavedIdea, duplicate: boolean): void {
    const { clock, keys, overlay } = this.o;
    keys.setActionOverride(SAVE_SLOT, { label: SAVED_LABEL, color: SAVED_GREEN, state: "shown" });
    if (this.flashTimer !== null) clock.clearTimeout(this.flashTimer);
    this.flashTimer = clock.setTimeout(() => {
      this.flashTimer = null;
      if (!this.busy) keys.setActionOverride(SAVE_SLOT, null);
    }, this.o.flashMs);
    overlay.showText({
      eyebrow: duplicate ? "Already saved" : SAVED_LABEL,
      title: idea.title,
      tone: "success",
      durationMs: this.o.titleCardMs,
    });
  }
}
