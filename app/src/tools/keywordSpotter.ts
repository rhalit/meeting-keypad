// A stand-in for LLM_SPOTTER_MODEL that costs nothing: it reads the NEW block of the spotter prompt
// and "spots" a fixed list of terms (or, without a list, acronyms). It runs behind the real TermSpotter,
// so throttling, the heard-in-new-lines check and the variant drops all still apply.

import type { Clock } from "../pipeline/clock.js";
import { findRun, plain } from "../pipeline/example.js";
import { LlmError, type JsonSpec, type LlmClient, type LlmRequest } from "../pipeline/llm.js";
import { isCategory, type Category } from "../pipeline/protocol.js";

export interface KeywordTerm {
  term: string;
  category: Category;
  full?: string;
}

/** "NSDR=Health, dopamine=Science, vector database" -> terms (category defaults to Other). */
export function parseTermList(text: string): KeywordTerm[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [term, cat] = s.split("=").map((x) => x.trim());
      return { term, category: isCategory(cat) ? cat : "Other" };
    });
}

const words = (s: string) => plain(s).split(" ").filter(Boolean);
const STOP_ACRONYMS = new Set(["I", "OK", "TV", "US", "UK", "AM", "PM"]);

/** The transcript lines of the NEW block, without the "[m:ss] Speaker:" tags. */
export function newBlock(req: LlmRequest): string[] {
  const user = req.messages[req.messages.length - 1]?.content ?? "";
  const i = user.lastIndexOf("NEW:\n");
  if (i < 0) return [];
  return user
    .slice(i + 5)
    .split("\n")
    .map((l) => l.replace(/^\[[^\]]*\]\s*(Speaker \d+:\s*)?/, ""));
}

export class KeywordSpotterLlm implements LlmClient {
  calls = 0;

  constructor(
    private readonly terms: KeywordTerm[],
    private readonly clock: Clock,
    /** Simulated call time. */
    private readonly latencyMs = 0,
  ) {}

  describe(): string {
    return `keyword spotter (${this.terms.length ? `${this.terms.length} terms` : "acronyms"}, ${this.latencyMs} ms)`;
  }

  async *stream(): AsyncIterable<string> {
    throw new LlmError("config", "keyword spotter: stream not supported");
  }

  async complete(): Promise<string> {
    throw new LlmError("config", "keyword spotter: complete not supported");
  }

  async json<T>(req: LlmRequest, spec: JsonSpec<T>): Promise<T> {
    this.calls++;
    const text = newBlock(req).join(" ");
    const found: { term: string; heard: string; full: string; variantOf: string; category: string; confidence: number; reason: string }[] = [];
    if (this.terms.length) {
      const hay = words(text);
      for (const t of this.terms) {
        if (findRun(hay, words(t.term)) >= 0) {
          found.push({ term: t.term, heard: t.term, full: t.full ?? t.term, variantOf: "", category: t.category, confidence: 0.9, reason: "keyword" });
        }
      }
    } else {
      for (const m of new Set(text.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? [])) {
        if (!STOP_ACRONYMS.has(m)) found.push({ term: m, heard: m, full: m, variantOf: "", category: "Other", confidence: 0.9, reason: "acronym" });
      }
    }
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const h = this.clock.setTimeout(resolve, this.latencyMs);
        req.signal?.addEventListener("abort", () => {
          this.clock.clearTimeout(h);
          reject(req.signal!.reason ?? new LlmError("cancelled", "aborted"));
        });
      });
    }
    return spec.validate({ terms: found.slice(0, 3) });
  }
}
