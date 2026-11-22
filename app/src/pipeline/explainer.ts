// Explanations for live terms (LLM_MODEL), fetched as soon as a term lands on a key.

import { EventEmitter } from "node:events";
import type { LlmOutcome } from "./catchUp.js";
import type { Clock } from "./clock.js";
import { DEFAULT_TIMEOUT_MS, errorAdvice, toLlmError, withTimeout, type JsonSpec, type LlmClient, type LlmError } from "./llm.js";
import { describeListener, type ListenerProfile } from "./mockData.js";
import type { CardEntry } from "./overlay.js";
import { EXPLAIN_SCHEMA, explainMessages } from "./prompts.js";
import { isCategory, type Category } from "./protocol.js";
import { normalizeTerm, type TermCandidate } from "./terms.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export interface Explanation {
  full: string;
  explanation: string;
  category: Category;
}

export const EXPLAIN_SPEC: JsonSpec<Explanation> = {
  name: "term_explanation",
  schema: EXPLAIN_SCHEMA,
  validate: (v) => {
    const o = v as Partial<Record<keyof Explanation, unknown>>;
    if (typeof o?.explanation !== "string" || o.explanation.trim() === "") throw new Error("no explanation");
    return {
      full: typeof o.full === "string" ? o.full.trim() : "",
      explanation: o.explanation.trim(),
      category: isCategory(o.category) ? o.category : "Eng",
    };
  },
};

export const EXPLAINING_TEXT = "Explaining…";

type CacheEntry =
  | { status: "pending"; since: number }
  | { status: "ready"; value: Explanation; ms: number }
  | { status: "failed"; error: LlmError };

interface Heard {
  candidate: TermCandidate;
  line?: TranscriptLine;
  context: TranscriptLine[];
}

export interface ExplainerOptions {
  clock: Clock;
  /** LLM_MODEL (not the spotter model). */
  llm: LlmClient;
  listener: ListenerProfile;
  log: (msg: string) => void;
  onLlmOutcome?: (o: LlmOutcome) => void;
  timeoutMs?: number;
}

/**
 * Explanation cards for live terms.
 *
 * - noteHeard() remembers where a term was heard (per meeting, the card's "In this meeting" line).
 * - prefetch() asks LLM_MODEL once per term; results are cached per term for the app session,
 *   failures are not (prefetch() after a failure tries again).
 * - lookup() is the OverlayController lookup: the explanation, a pending entry ("Explaining…"),
 *   or the error advice. Emits `ready` (term) and `failed` (term) so the visible card can refresh.
 */
export class Explainer extends EventEmitter {
  private readonly o: Required<Omit<ExplainerOptions, "onLlmOutcome">> & Pick<ExplainerOptions, "onLlmOutcome">;
  private cache = new Map<string, CacheEntry>();
  private heard = new Map<string, Heard>();
  private inFlight = new Set<Promise<void>>();

  constructor(opts: ExplainerOptions) {
    super();
    this.o = { timeoutMs: DEFAULT_TIMEOUT_MS, ...opts };
  }

  noteHeard(candidate: TermCandidate, line: TranscriptLine | undefined, context: TranscriptLine[] = []): void {
    const key = normalizeTerm(candidate.term);
    if (key && !this.heard.has(key)) this.heard.set(key, { candidate, line, context });
  }

  /** Start the explanation unless it is cached or on its way. */
  prefetch(term: string): void {
    const key = normalizeTerm(term);
    if (!key) return;
    const c = this.cache.get(key);
    if (c && c.status !== "failed") return;
    this.cache.set(key, { status: "pending", since: this.o.clock.now() });
    const p = this.fetch(term, key);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** "pending" | "ready" | "failed" | "none". */
  state(term: string): CacheEntry["status"] | "none" {
    return this.cache.get(normalizeTerm(term))?.status ?? "none";
  }

  lookup(term: string): CardEntry | undefined {
    const key = normalizeTerm(term);
    const h = this.heard.get(key);
    const c = this.cache.get(key);
    if (!h && !c) return undefined;
    const base = {
      label: h?.candidate.label ?? term,
      category: h?.candidate.category ?? (c?.status === "ready" ? c.value.category : "Eng"),
      example: h?.line?.text ?? "",
    };
    if (c?.status === "ready") return { ...base, full: c.value.full || term, explanation: c.value.explanation, pending: false };
    if (c?.status === "failed") {
      return { ...base, full: term, explanation: `Couldn't explain this yet. ${errorAdvice(c.error)}`, pending: false };
    }
    return { ...base, full: term, explanation: EXPLAINING_TEXT, pending: true };
  }

  /** New meeting: forget where terms were heard. Cached explanations stay. */
  reset(): void {
    this.heard.clear();
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async fetch(term: string, key: string): Promise<void> {
    const { clock, llm, log } = this.o;
    const started = clock.now();
    const h = this.heard.get(key);
    try {
      const value = await withTimeout(clock, this.o.timeoutMs, (signal) =>
        llm.json(
          {
            messages: explainMessages({ term, listener: describeListener(this.o.listener), heard: h?.line, context: h?.context ?? [] }),
            maxTokens: 1024,
            temperature: 0.3,
            signal,
          },
          EXPLAIN_SPEC,
        ),
      );
      const ms = clock.now() - started;
      this.cache.set(key, { status: "ready", value, ms });
      const words = value.explanation.split(/\s+/).length;
      log(`explain: "${term}" ready in ${ms} ms (${words} words, ${value.category}${value.full ? `, "${value.full}"` : ""})`);
      this.o.onLlmOutcome?.({ ok: true });
      this.emit("ready", term);
    } catch (err) {
      const e = toLlmError(err);
      this.cache.set(key, { status: "failed", error: e });
      log(`explain: "${term}" failed after ${clock.now() - started} ms: ${e.kind}: ${e.message}`);
      if (e.kind !== "cancelled") this.o.onLlmOutcome?.({ ok: false, error: e });
      this.emit("failed", term);
    }
  }
}
