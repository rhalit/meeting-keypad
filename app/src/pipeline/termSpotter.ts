// Live term spotter: new final transcript lines -> LLM_SPOTTER_MODEL -> TermCandidates (source "live").

import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import { LlmError, toLlmError, withTimeout, type JsonSpec, type LlmClient } from "./llm.js";
import { describeListener, type ListenerProfile } from "./mockData.js";
import { SPOTTER_SCHEMA, spotterMessages } from "./prompts.js";
import { findRun, plain } from "./example.js";
import { isCategory, type Category } from "./protocol.js";
import { normalizeTerm, type TermCandidate } from "./terms.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export interface RawSpotted {
  term: string;
  heard: string;
  full: string;
  variantOf: string;
  category: string;
  confidence: number;
  reason: string;
}

/** What comes with every `term` event besides the candidate. */
export interface SpotInfo {
  /** The line the term was heard in (the "In this meeting" example). */
  line: TranscriptLine;
  /** Up to 2 lines before it. */
  context: TranscriptLine[];
  confidence: number;
  reason: string;
  heard: string;
  /** Full name / expansion from the spotter ("" if none). */
  full: string;
  /** Meeting seconds at which the last heard word ended (word timestamps), if known. */
  spokenAt?: number;
}

export interface SpotterStatus {
  state: "idle" | "ok" | "backoff" | "error";
  text: string;
  advice?: string;
}

export interface TermSpotterOptions {
  clock: Clock;
  llm: LlmClient;
  listener: ListenerProfile;
  log: (msg: string) => void;
  /** At most one call per this long (start to start). LLM_SPOTTER_INTERVAL_MS. */
  minIntervalMs?: number;
  timeoutMs?: number;
  minConfidence?: number;
  maxPerCall?: number;
  /** Lines already sent that go along as context. */
  contextLines?: number;
  /** After a back-off only the latest lines are sent: at most this many ... */
  maxBatchLines?: number;
  /** ... and only from the last this many meeting seconds. */
  maxBatchS?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export const SPOTTER_SPEC: JsonSpec<{ terms: RawSpotted[] }> = {
  name: "spotted_terms",
  schema: SPOTTER_SCHEMA,
  validate: (v) => {
    const terms = (v as { terms?: unknown })?.terms;
    if (!Array.isArray(terms)) throw new Error("terms is not an array");
    // Lenient per item (JSON mode may drop a field): malformed items are skipped, not fatal.
    const out: RawSpotted[] = [];
    for (const t of terms) {
      if (typeof t?.term !== "string" || typeof t?.confidence !== "number") continue;
      out.push({
        term: t.term,
        heard: typeof t.heard === "string" ? t.heard : "",
        full: typeof t.full === "string" ? t.full : "",
        variantOf: typeof t.variantOf === "string" ? t.variantOf : "",
        category: typeof t.category === "string" ? t.category : "",
        confidence: t.confidence,
        reason: typeof t.reason === "string" ? t.reason : "",
      });
    }
    return { terms: out };
  },
};

/** The line a term was heard in: `heard` verbatim, else most words of the term, else the last line. */
export function findLine(lines: TranscriptLine[], heard: string, term: string): TranscriptLine {
  const h = plain(heard);
  let best = lines[lines.length - 1];
  let bestScore = 0;
  const termWords = plain(term).split(" ").filter(Boolean);
  const heardWords = h.split(" ").filter(Boolean);
  for (const l of lines) {
    const text = ` ${plain(l.text)} `;
    const compact = text.replace(/ /g, "");
    let score = 0;
    if (h && text.includes(` ${h} `)) score = 100;
    else {
      for (const w of new Set([...termWords, ...heardWords])) if (text.includes(` ${w} `)) score += w.length;
      if (termWords.length && compact.includes(termWords.join(""))) score += 10;
    }
    if (score >= bestScore && score > 0) {
      best = l;
      bestScore = score;
    }
  }
  return best;
}

const words = (s: string) => plain(s).split(" ").filter(Boolean);

/**
 * True if the heard words (else the term's) occur in the NEW lines. A run that starts in the last
 * context line and ends in the new lines also counts (a term cut by a line boundary).
 */
export function heardInNew(heard: string, term: string, newLines: TranscriptLine[], context: TranscriptLine[]): boolean {
  const needle = words(heard).length ? words(heard) : words(term);
  if (needle.length === 0) return false;
  const fresh = newLines.flatMap((l) => words(l.text));
  if (findRun(fresh, needle) >= 0) return true;
  const last = context.length ? words(context[context.length - 1].text) : [];
  const joined = [...last, ...fresh];
  for (let at = findRun(joined, needle); at >= 0; at = findRun(joined, needle, at + 1)) {
    if (at + needle.length > last.length) return true; // at least one word in the new text
  }
  return false;
}

/**
 * Meeting seconds at which the heard words (else the term's) were spoken: the end of the last word of
 * their last occurrence in the lines' word timings. Undefined without word timings.
 */
export function heardSpan(lines: TranscriptLine[], heard: string, term: string): { start: number; end: number } | undefined {
  const timed = lines.flatMap((l) => (l.words ?? []).flatMap((w) => words(w.text).map((p) => ({ p, start: w.start, end: w.end }))));
  if (timed.length === 0) return undefined;
  const flat = timed.map((x) => x.p);
  for (const needle of [words(heard), words(term)]) {
    let found = -1;
    for (let at = findRun(flat, needle); at >= 0; at = findRun(flat, needle, at + 1)) found = at;
    if (found >= 0) return { start: timed[found].start, end: timed[found + needle.length - 1].end };
  }
  return undefined;
}

const isAcronym = (t: string) => {
  const c = t.replace(/[\s\-.]/g, "");
  return c.length >= 2 && c.length <= 6 && !/\s/.test(t.trim()) && (c.match(/[A-Z0-9]/g)?.length ?? 0) >= Math.ceil(c.length * 0.6);
};

/** Levenshtein distance, early exit above 1 is not needed for these short strings. */
export function editDistance(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** First letters of a multi-word phrase ("non-sleep deep rest" -> "nsdr"); "" for one word. */
const initials = (s: string) => {
  const w = words(s);
  return w.length >= 2 ? w.map((x) => x[0]).join("") : "";
};

export interface ShownTerm {
  term: string;
  full: string;
}

/**
 * The already-shown term that `cand` is a variant of, or null: same full name (either way round),
 * an acronym of its words, a short acronym one edit away (NSTR vs NSDR), or the model's variantOf.
 */
export function variantOf(cand: { term: string; full: string; variantOf: string }, shown: ShownTerm[]): string | null {
  const nt = normalizeTerm(cand.term);
  const nf = normalizeTerm(cand.full);
  const nv = normalizeTerm(cand.variantOf);
  const compact = (s: string) => plain(s).replace(/ /g, "");
  for (const s of shown) {
    const st = normalizeTerm(s.term);
    const sf = normalizeTerm(s.full);
    if (nv && (nv === st || nv === sf)) return s.term;
    if (nf && sf && nf === sf) return s.term;
    if (nf && nf === st) return s.term;
    if (sf && sf === nt) return s.term;
    const ci = initials(cand.term) || initials(cand.full);
    if (ci && isAcronym(s.term) && ci === compact(s.term)) return s.term;
    const si = initials(s.term) || initials(s.full);
    if (si && isAcronym(cand.term) && si === compact(cand.term)) return s.term;
    if (isAcronym(cand.term) && isAcronym(s.term)) {
      const a = compact(cand.term);
      const b = compact(s.term);
      if (a !== b && Math.min(a.length, b.length) >= 3 && editDistance(a, b) <= 1) return s.term;
    }
  }
  return null;
}

/**
 * Sends new final lines to the spotter model and emits `term` (TermCandidate, SpotInfo) for each
 * accepted term, plus `status` (SpotterStatus) on changes.
 *
 * - At most one call in flight and one call per `minIntervalMs` (start to start). A call only
 *   happens when new lines arrived, so silence costs nothing.
 * - Keeps terms with confidence >= 0.7 whose heard words are in the NEW lines (checked in code), not
 *   spotted before in this meeting and not a variant / mishearing of one (variantOf()), at most 2 per call.
 * - On a rate limit it waits max(retry-after, 8 s, 16 s, 32 s ... 60 s) and then sends only the
 *   latest lines (6 lines / 45 s): skipped cycles are dropped, never queued.
 * - Auth / config / unknown model errors stop it until reset().
 */
export class TermSpotter extends EventEmitter {
  private readonly o: Required<TermSpotterOptions>;
  private pending: TranscriptLine[] = [];
  private sent: TranscriptLine[] = [];
  private spotted = new Map<string, ShownTerm>();
  private inFlight: { ac: AbortController; done: Promise<void> } | null = null;
  private lastStartAt: number | null = null;
  private timer: TimerHandle | null = null;
  private backoffUntil = 0;
  private backoffStreak = 0;
  private stopped: LlmError | null = null;
  private session = 0;
  private st: SpotterStatus;
  readonly stats = { calls: 0, terms: 0, rateLimited: 0, errors: 0, skippedLines: 0 };

  constructor(opts: TermSpotterOptions) {
    super();
    this.o = {
      minIntervalMs: 8000,
      timeoutMs: 10_000,
      minConfidence: 0.7,
      maxPerCall: 2,
      contextLines: 2,
      maxBatchLines: 6,
      maxBatchS: 45,
      backoffBaseMs: 8000,
      backoffMaxMs: 60_000,
      ...opts,
    };
    this.st = { state: "idle", text: `Spotter ready · ${opts.llm.describe()}` };
  }

  /** A new final line. */
  addLine(line: TranscriptLine): void {
    if (this.stopped || !line.text.trim()) return;
    this.pending.push(line);
    this.schedule();
  }

  /** Every term accepted in this meeting (canonical spelling). */
  spottedTerms(): string[] {
    return [...this.spotted.values()].map((s) => s.term);
  }

  status(): SpotterStatus {
    return this.st;
  }

  /** True when nothing is waiting: no call in flight, no timer, no unsent lines (replay). */
  isIdle(): boolean {
    return !this.inFlight && this.timer === null && (this.pending.length === 0 || this.stopped !== null);
  }

  /** Resolves once no call is in flight (tests, eval). */
  async whenIdle(): Promise<void> {
    while (this.inFlight) await this.inFlight.done;
  }

  /** New meeting: abort the call in flight, forget everything. */
  reset(): void {
    this.session++;
    this.inFlight?.ac.abort(new LlmError("cancelled", "Meeting reset"));
    this.inFlight = null;
    this.cancelTimer();
    this.pending = [];
    this.sent = [];
    this.spotted.clear();
    this.lastStartAt = null;
    this.backoffUntil = 0;
    this.backoffStreak = 0;
    this.stopped = null;
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
    this.setStatus({ state: "idle", text: `Spotter ready · ${this.o.llm.describe()}` });
  }

  dispose(): void {
    this.reset();
    this.removeAllListeners();
  }

  // --- internals ---------------------------------------------------------------------------

  private schedule(): void {
    if (this.timer !== null || this.inFlight || this.stopped || this.pending.length === 0) return;
    const now = this.o.clock.now();
    const at = Math.max(now, this.backoffUntil, this.lastStartAt === null ? 0 : this.lastStartAt + this.o.minIntervalMs);
    if (at <= now) {
      this.start();
      return;
    }
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, at - now);
  }

  private start(): void {
    const { clock, llm, log } = this.o;
    const latest = this.pending[this.pending.length - 1].t;
    let batch = this.pending.filter((l) => l.t >= latest - this.o.maxBatchS).slice(-this.o.maxBatchLines);
    const skipped = this.pending.length - batch.length;
    if (skipped > 0) {
      this.stats.skippedLines += skipped;
      log(`spotter: skipped ${skipped} older line(s) after a pause`);
    }
    this.pending = [];
    const context = this.sent.slice(-this.o.contextLines);
    const session = this.session;
    const ac = new AbortController();
    const startedAt = clock.now();
    this.lastStartAt = startedAt;
    this.stats.calls++;
    const messages = spotterMessages({
      listener: describeListener(this.o.listener),
      alreadyShown: this.spottedTerms(),
      context,
      lines: batch,
    });
    const done = withTimeout(
      clock,
      this.o.timeoutMs,
      (signal) => llm.json({ messages, maxTokens: 1024, temperature: 0, signal }, SPOTTER_SPEC),
      ac.signal,
    ).then(
      (res) => {
        if (session !== this.session) return;
        this.backoffStreak = 0;
        const n = this.accept(res.terms, batch, context);
        log(`spotter: ${batch.length} line(s) -> ${res.terms.length} proposed, ${n} accepted (${clock.now() - startedAt} ms)`);
        this.setStatus({ state: "ok", text: `Spotter · ${llm.describe()} · ${this.stats.calls} calls · ${this.stats.terms} terms` });
      },
      (err) => {
        if (session !== this.session) return;
        const e = toLlmError(err);
        if (e.kind === "cancelled") return;
        if (e.kind === "rate_limit") {
          this.stats.rateLimited++;
          this.backoffStreak++;
          const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (this.backoffStreak - 1));
          const wait = Math.max(exp, (e.extra.retryAfterS ?? 0) * 1000);
          this.backoffUntil = clock.now() + wait;
          // Not analysed yet: keep the lines; the next call trims them to the latest window.
          this.pending = [...batch, ...this.pending];
          batch = [];
          log(`spotter: rate limited, pausing ${Math.round(wait / 1000)} s`);
          this.setStatus({ state: "backoff", text: `Spotter: rate limited, resuming in ${Math.round(wait / 1000)} s` });
          return;
        }
        this.stats.errors++;
        if (e.kind === "auth" || e.kind === "config" || e.kind === "not_found") {
          this.stopped = e;
          log(`spotter stopped: ${e.kind}: ${e.message}`);
          this.setStatus({ state: "error", text: `Spotter: ${e.kind.replace("_", " ")}`, advice: e.message });
          return;
        }
        log(`spotter: call failed (${e.kind}: ${e.message}), those lines are skipped`);
        this.setStatus({ state: "error", text: `Spotter: last call failed (${e.kind.replace("_", " ")})` });
      },
    );
    const entry = {
      ac,
      done: done.finally(() => {
        if (session !== this.session || this.inFlight !== entry) return;
        this.inFlight = null;
        this.sent.push(...batch);
        if (this.sent.length > 20) this.sent = this.sent.slice(-20);
        this.schedule();
      }),
    };
    this.inFlight = entry;
  }

  /** Filters and emits. Returns how many terms were accepted. */
  private accept(raw: RawSpotted[], batch: TranscriptLine[], context: TranscriptLine[]): number {
    const { log } = this.o;
    const name = normalizeTerm(this.o.listener.name);
    const seen = new Set<string>();
    const ok: (RawSpotted & { key: string; category: Category })[] = [];
    for (const r of raw) {
      const term = r.term.replace(/\s+/g, " ").trim();
      const key = normalizeTerm(term);
      const nWords = term.split(" ").length;
      const shown = [...this.spotted.values(), ...ok.map((o) => ({ term: o.term, full: o.full }))];
      let why = "";
      let variant: string | null = null;
      if (!key || term.length > 40 || nWords > 4) why = "not a short term";
      else if (r.confidence < this.o.minConfidence) why = `confidence ${r.confidence}`;
      else if (this.spotted.has(key) || seen.has(key)) why = "already shown";
      else if (key === name) why = "listener's name";
      else if (!isCategory(r.category)) why = `category "${r.category}"`;
      else if (!heardInNew(r.heard, term, batch, context)) why = `not heard in new lines ("${r.heard}")`;
      else if ((variant = variantOf({ term, full: r.full, variantOf: r.variantOf }, shown))) why = `variant of "${variant}"`;
      if (why) {
        log(`spotter: skip "${term}" (${why})`);
        continue;
      }
      seen.add(key);
      ok.push({ ...r, term, key, category: r.category as Category });
    }
    ok.sort((a, b) => b.confidence - a.confidence);
    for (const r of ok.slice(this.o.maxPerCall)) log(`spotter: skip "${r.term}" (more than ${this.o.maxPerCall} in one call)`);
    const accepted = ok.slice(0, this.o.maxPerCall);
    for (const r of accepted) {
      this.spotted.set(r.key, { term: r.term, full: r.full.trim() });
      this.stats.terms++;
      const candidate: TermCandidate = { term: r.term, category: r.category, source: "live" };
      const line = findLine(batch, r.heard, r.term);
      const before = [...context, ...batch];
      const idx = before.indexOf(line);
      const span = heardSpan([...context.slice(-1), ...batch], r.heard, r.term);
      const info: SpotInfo = {
        line,
        context: before.slice(Math.max(0, idx - 2), idx),
        confidence: r.confidence,
        reason: r.reason,
        heard: r.heard,
        full: r.full.trim(),
        spokenAt: span?.end,
      };
      log(`spotter: "${r.term}" (${r.category}, ${r.confidence}, heard "${r.heard}"${r.full ? `, full "${r.full}"` : ""}: ${r.reason})`);
      this.emit("term", candidate, info);
    }
    return accepted.length;
  }

  private setStatus(s: SpotterStatus): void {
    this.st = s;
    this.emit("status", s);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.o.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
