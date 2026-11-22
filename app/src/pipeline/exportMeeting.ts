import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmOutcome } from "./catchUp.js";
import type { Clock } from "./clock.js";
import type { ForMeQuestion } from "./forMe.js";
import { DEFAULT_TIMEOUT_MS, toLlmError, withTimeout, type JsonSpec, type LlmClient } from "./llm.js";
import { SUMMARY_SCHEMA, formatTranscript, mmss, summaryMessages, type MeetingSummaryJson } from "./prompts.js";
import type { Category } from "./protocol.js";
import type { SavedIdea } from "./save.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

export const SUMMARY_BULLETS = 5;
export const MIN_SPOKEN_S = 30;

export interface ExportTerm {
  term: string;
  category: Category;
  /** Meeting seconds when it reached a key. */
  t: number;
  opened: boolean;
  full?: string;
  /** "" when there is none (a live explanation that never arrived). */
  explanation: string;
}

/** Everything the export file shows, captured at once (before a reset can clear it). */
export interface MeetingSnapshot {
  /** MeetingRecord id: the same meeting exported again overwrites its own file. */
  meetingId: number;
  mode: "mock" | "live";
  startedAt: Date;
  /** Meeting seconds (position when exported). */
  durationS: number;
  /** Seconds of speech (line timings, or a words estimate). */
  spokenS: number;
  listenerName: string;
  lines: TranscriptLine[];
  terms: ExportTerm[];
  questions: ForMeQuestion[];
  ideas: SavedIdea[];
  catchUps: { t: number; body: string }[];
}

export type SummaryResult =
  | { kind: "ok"; title: string; bullets: string[] }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

export function validateSummary(v: unknown): MeetingSummaryJson {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
  const o = v as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "") : "";
  const bullets = Array.isArray(o.bullets)
    ? o.bullets
        .map((b) => (typeof b === "string" ? b.replace(/\*\*/g, "").replace(/^\s*[-•*]\s*/, "").replace(/\s+/g, " ").trim() : ""))
        .filter(Boolean)
    : [];
  if (bullets.length === 0) throw new Error('"bullets" must hold at least one non-empty string');
  return { title, bullets: bullets.slice(0, SUMMARY_BULLETS) };
}

export const SUMMARY_SPEC: JsonSpec<MeetingSummaryJson> = { name: "meeting_summary", schema: SUMMARY_SCHEMA, validate: validateSummary };

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-22 1405" (local time), the export file name. */
export function fileStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function dateLine(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "4 min 51 s", "38 s". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
}

const quoteBlock = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** The Markdown file. Sections always appear (with "None." when empty), in this order. */
export function buildMeetingMarkdown(s: MeetingSnapshot, summary: SummaryResult): string {
  const modeName = s.mode === "live" ? "Live meeting" : "Mock meeting";
  const title = summary.kind === "ok" && summary.title ? summary.title : modeName;
  const out: string[] = [];
  out.push(`# ${title}`, "");
  out.push(`**Date:** ${dateLine(s.startedAt)}  `, `**Duration:** ${formatDuration(s.durationS)}  `, `**Source:** ${modeName}`, "");

  out.push("## Summary", "");
  if (summary.kind === "ok") out.push(...summary.bullets.map((b) => `- ${b}`));
  else if (summary.kind === "skipped") out.push(`Skipped: less than ${MIN_SPOKEN_S} s was said.`);
  else out.push(`Summary unavailable (${summary.reason}).`);
  out.push("");

  out.push(`## Questions for ${s.listenerName}`, "");
  if (s.questions.length === 0) out.push("None.", "");
  for (const q of s.questions) {
    out.push(`### ${mmss(q.t)}${q.speaker ? ` · ${q.speaker}` : ""}${q.opened ? " · opened" : " · not opened"}`, "");
    out.push(`**${q.question}**`, "");
    if (q.context) out.push(q.context, "");
    if (q.suggestedReply) out.push(`*Suggested reply:* ${q.suggestedReply}`, "");
    out.push(quoteBlock(`"${q.line}"`), "");
  }

  out.push("## Saved ideas", "");
  if (s.ideas.length === 0) out.push("None.", "");
  for (const i of s.ideas) {
    out.push(`### ${i.title}`, `*Meeting ${mmss(i.t)}*`, "", i.summary, "", quoteBlock(`"${i.quote}"`), "");
  }

  out.push("## Terms", "");
  if (s.terms.length === 0) out.push("None.", "");
  for (const t of s.terms) {
    const full = t.full && t.full.toLowerCase() !== t.term.toLowerCase() ? ` (${t.full})` : "";
    out.push(`- **${t.term}**${full} · ${t.category} · ${mmss(t.t)}${t.opened ? " · opened ✓" : ""}  `);
    out.push(`  ${t.explanation || "*(explanation not ready)*"}`);
  }
  if (s.terms.length > 0) out.push("");

  out.push("## Catch-ups", "");
  if (s.catchUps.length === 0) out.push("None.", "");
  for (const c of s.catchUps) out.push(`### ${mmss(c.t)}`, "", c.body, "");

  out.push("## Transcript", "");
  out.push(s.lines.length ? formatTranscript(s.lines).split("\n").join("  \n") : "Nothing was said.", "");
  return out.join("\n");
}

export interface ExporterOptions {
  clock: Clock;
  llm: LlmClient;
  /** output/meetings */
  dir: string;
  log: (msg: string) => void;
  onLlmOutcome?: (o: LlmOutcome) => void;
  timeoutMs?: number;
  /** Tests: where files go and whether a path is taken. */
  write?: (path: string, text: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
}

export type ExportResult =
  | { status: "written"; path: string; summary: "model" | "cached" | "skipped" | "failed" }
  | { status: "empty" }
  | { status: "failed"; error: string };

/**
 * Writes output/meetings/<YYYY-MM-DD HHmm>.md. One LLM_MODEL call for the summary, only when at least 30 s
 * were said, and none when the same meeting is exported again with no new line (cached). The same meeting
 * always goes to the same file (overwritten with the newer content); another meeting that started in the same
 * minute gets " 2", " 3", ... Exports run one after the other so a quick second export reuses the summary.
 */
export class MeetingExporter {
  private readonly o: Required<Omit<ExporterOptions, "onLlmOutcome">> & Pick<ExporterOptions, "onLlmOutcome">;
  private readonly paths = new Map<number, string>();
  private cache: { key: string; summary: SummaryResult & { kind: "ok" } } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Summary model calls made (tests). */
  calls = 0;

  constructor(opts: ExporterOptions) {
    this.o = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      write: async (path, text) => {
        await mkdir(this.o.dir, { recursive: true });
        await writeFile(path, text, "utf8");
      },
      exists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      ...opts,
    };
  }

  export(snap: MeetingSnapshot): Promise<ExportResult> {
    const p = this.chain.then(() => this.run(snap));
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async run(snap: MeetingSnapshot): Promise<ExportResult> {
    const { log } = this.o;
    if (snap.lines.length === 0) {
      log("export: nothing was said, no file written");
      return { status: "empty" };
    }
    const { summary, how } = await this.summary(snap);
    try {
      const path = await this.pathFor(snap);
      await this.o.write(path, buildMeetingMarkdown(snap, summary));
      log(`export: ${path} (${snap.lines.length} lines, ${snap.terms.length} terms, ${snap.questions.length} questions, summary ${how})`);
      return { status: "written", path, summary: how };
    } catch (err) {
      const msg = (err as Error).message;
      log(`export failed: ${msg}`);
      return { status: "failed", error: msg };
    }
  }

  private async summary(snap: MeetingSnapshot): Promise<{ summary: SummaryResult; how: "model" | "cached" | "skipped" | "failed" }> {
    const { clock, llm, log } = this.o;
    if (snap.spokenS < MIN_SPOKEN_S) {
      log(`export: ${Math.round(snap.spokenS)} s said (< ${MIN_SPOKEN_S} s), summary skipped`);
      return { summary: { kind: "skipped" }, how: "skipped" };
    }
    const last = snap.lines[snap.lines.length - 1];
    const key = `${snap.meetingId}|${snap.lines.length}|${last.t}|${last.text}`;
    if (this.cache?.key === key) {
      log("export: nothing new since the last export, summary reused (no model call)");
      return { summary: this.cache.summary, how: "cached" };
    }
    this.calls++;
    const started = clock.now();
    log(`export: summary of ${snap.lines.length} lines -> ${llm.describe()}`);
    try {
      const r = await withTimeout(clock, this.o.timeoutMs, (signal) =>
        llm.json({ messages: summaryMessages(snap.lines, snap.listenerName), maxTokens: 1200, temperature: 0.2, signal }, SUMMARY_SPEC),
      );
      this.o.onLlmOutcome?.({ ok: true });
      const summary = { kind: "ok" as const, title: r.title, bullets: r.bullets };
      this.cache = { key, summary };
      log(`export: summary in ${clock.now() - started} ms`);
      return { summary, how: "model" };
    } catch (err) {
      const e = toLlmError(err);
      log(`export: summary failed: ${e.kind}: ${e.message}`);
      this.o.onLlmOutcome?.({ ok: false, error: e });
      return { summary: { kind: "failed", reason: e.kind.replace("_", " ") }, how: "failed" };
    }
  }

  private async pathFor(snap: MeetingSnapshot): Promise<string> {
    const known = this.paths.get(snap.meetingId);
    if (known) return known;
    const base = fileStamp(snap.startedAt);
    const claimed = new Set(this.paths.values());
    for (let n = 1; ; n++) {
      const path = join(this.o.dir, `${base}${n > 1 ? ` ${n}` : ""}.md`);
      if (claimed.has(path) || (await this.o.exists(path))) continue;
      this.paths.set(snap.meetingId, path);
      return path;
    }
  }
}
