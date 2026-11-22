// Replays a recorded Deepgram session (npm run record:live) through the full live pipeline:
// ReplayStt -> LiveSource -> TranscriptBuffer + TermSpotter -> SlotManager -> LatencyTracker.
//
//   npm run replay:live -- <recording.jsonl>                     fake spotter (acronyms), virtual time, free
//   npm run replay:live -- <file> --terms "NSDR=Health, dopamine=Science"
//                                                                fake spotter with these terms
//   --fake-latency <ms>      simulated spotter call time (default 800)
//   --spotter real           LLM_SPOTTER_MODEL, in real time (costs spotter budget)
//   --interval <ms>          spotter interval (default LLM_SPOTTER_INTERVAL_MS / 8000)
//   --max-words N --max-s S  line length limits (default 12 words / 6 s)
//   --tag <name>             output/replay-<name>.json
//
// Nothing here calls LLM_MODEL (no explanations). The API keys are never printed.

import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AudioInput, AudioStatus } from "../pipeline/audioCapture.js";
import { realClock, type Clock } from "../pipeline/clock.js";
import { LatencyTracker, formatLatency, type TermLatency } from "../pipeline/latency.js";
import { OpenAiCompatClient, loadSpotterLlmConfig, spotterIntervalMs, type LlmClient } from "../pipeline/llm.js";
import { LiveSource, type LiveLine } from "../pipeline/liveSource.js";
import type { ListenerProfile } from "../pipeline/mockData.js";
import { ReplayStt, loadRecording, recordingDuration, type Recording } from "../pipeline/replay.js";
import { SlotManager } from "../pipeline/slots.js";
import type { AssemblerOptions } from "../pipeline/stt.js";
import { TermSpotter, type SpotInfo } from "../pipeline/termSpotter.js";
import type { TermCandidate } from "../pipeline/terms.js";
import { TranscriptBuffer, type TranscriptLine } from "../pipeline/transcriptBuffer.js";
import { KeywordSpotterLlm, parseTermList } from "./keywordSpotter.js";

/** Silent audio input: the replay brings its own transcript. */
class NoAudio extends EventEmitter implements AudioInput {
  private st: AudioStatus = { state: "stopped", text: "Audio: replay" };
  start(): void {
    this.st = { state: "running", text: "Audio: replay" };
  }
  async stop(): Promise<void> {
    this.st = { state: "stopped", text: "Audio: replay" };
  }
  status(): AudioStatus {
    return this.st;
  }
}

/** A clock whose time only moves when the replay loop advances it (fast, deterministic). */
export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  /** Runs every timer due up to now + ms, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

export interface ReplayOptions {
  recording: Recording;
  /** Spotter model; the default is the keyword fake. */
  spotter?: LlmClient;
  /** For the keyword fake. */
  terms?: string;
  fakeLatencyMs?: number;
  intervalMs?: number;
  segmentation?: AssemblerOptions;
  listener?: ListenerProfile;
  /** Real time (real spotter) instead of virtual time. */
  realTime?: boolean;
  log?: (msg: string) => void;
}

export interface ReplayLine {
  t: number;
  end?: number;
  words: number;
  reason?: string;
  finalAt: number;
  text: string;
}

export interface ReplayResult {
  durationS: number;
  lines: ReplayLine[];
  latencies: TermLatency[];
  /** Terms on slots 0-5 at the end. */
  layout: (string | null)[];
  spotterCalls: number;
  spotted: { term: string; heard: string; at: number }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

/** Runs the recording through the live pipeline and collects lines, latencies and the final layout. */
export async function runReplay(o: ReplayOptions): Promise<ReplayResult> {
  const log = o.log ?? (() => {});
  const vclock = new VirtualClock();
  const clock: Clock = o.realTime ? realClock : vclock;
  const t0 = clock.now();
  const listener = o.listener ?? { name: "Listener", knows: "a general audience: no particular tech, finance or business background" };
  const spotterLlm = o.spotter ?? new KeywordSpotterLlm(parseTermList(o.terms ?? ""), clock, o.fakeLatencyMs ?? 800);

  const transcript = new TranscriptBuffer();
  const slots = new SlotManager({ clock });
  const spotter = new TermSpotter({ clock, llm: spotterLlm, listener, log, minIntervalMs: o.intervalMs ?? 8000 });
  const latency = new LatencyTracker();
  const stt = new ReplayStt(o.recording, { clock, log, segmentation: o.segmentation });
  const live = new LiveSource({ clock, audio: new NoAudio(), stt: () => stt, log: () => {} });
  const meetingNow = () => (clock.now() - t0) / 1000;

  const lines: ReplayLine[] = [];
  const finalAt = new WeakMap<TranscriptLine, number>();
  const spotted: ReplayResult["spotted"] = [];
  live.on("line", (line: LiveLine) => {
    const at = meetingNow();
    finalAt.set(line, at);
    transcript.add(line);
    lines.push({ t: line.t, end: line.end, words: line.text.split(/\s+/).filter(Boolean).length, reason: line.reason, finalAt: at, text: line.text });
    log(`final [${line.t.toFixed(1)}-${(line.end ?? line.t).toFixed(1)} s, ${line.reason ?? "?"}] ${line.text}`);
    spotter.addLine(line);
  });
  spotter.on("term", (c: TermCandidate, info: SpotInfo) => {
    spotted.push({ term: c.term, heard: info.heard, at: meetingNow() });
    latency.spot(c.term, meetingNow(), info.spokenAt, finalAt.get(info.line));
    slots.add(c);
  });
  slots.on("placed", ({ slot, candidate }: { slot: number; candidate: TermCandidate }) => {
    const r = latency.placed(candidate.term, meetingNow());
    log(`KEY ${slot} <- "${candidate.term}" (${candidate.category})${r ? `  ${formatLatency(r)}` : ""}`);
  });

  let done = false;
  stt.once("done", () => (done = true));
  live.start([]);
  const duration = recordingDuration(o.recording);
  if (o.realTime) {
    while (!done) await sleep(100);
  } else {
    while (!done) {
      vclock.advance(50);
      await flushMicrotasks();
    }
  }
  // Let the last spotter call finish (virtual time keeps moving so throttles and timeouts resolve).
  for (let i = 0; i < 400; i++) {
    if (o.realTime) await sleep(100);
    else vclock.advance(100);
    await flushMicrotasks();
    if (spotter.isIdle() && slots.queued().length === 0) break;
  }
  await spotter.whenIdle();
  await live.dispose();
  const result: ReplayResult = {
    durationS: duration,
    lines,
    latencies: [...latency.records],
    layout: [0, 1, 2, 3, 4, 5].map((s) => slots.termAt(s)),
    spotterCalls: spotter.stats.calls,
    spotted,
  };
  spotter.dispose();
  slots.dispose();
  return result;
}

const f1 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(1));
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function printReport(r: ReplayResult, label: string): void {
  const secs = r.lines.map((l) => (l.end ?? l.t) - l.t);
  const byReason = new Map<string, number>();
  for (const l of r.lines) byReason.set(l.reason ?? "?", (byReason.get(l.reason ?? "?") ?? 0) + 1);
  console.log(`\nREPLAY ${label}: ${f1(r.durationS)} s, ${r.lines.length} lines, ${r.spotterCalls} spotter calls`);
  console.log(
    `   line length: median ${f1(median(r.lines.map((l) => l.words)))} words / ${f1(median(secs))} s, max ${Math.max(0, ...r.lines.map((l) => l.words))} words / ${f1(Math.max(0, ...secs))} s`,
  );
  console.log(`   lines ended by: ${[...byReason].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`   final delay (last word -> final line): median ${f1(median(r.lines.map((l) => l.finalAt - (l.end ?? l.t))))} s`);
  console.log(`   term                    spoken    key   speech->key  (final + spot + queue)`);
  for (const x of r.latencies) {
    const final = x.finalAt !== undefined && x.spokenAt !== undefined ? x.finalAt - x.spokenAt : undefined;
    const spot = x.finalAt !== undefined ? x.spottedAt - x.finalAt : undefined;
    console.log(
      `   ${x.term.padEnd(22).slice(0, 22)}  ${f1(x.spokenAt).padStart(6)}  ${f1(x.placedAt).padStart(6)}  ${f1(x.total).padStart(8)} s    (${f1(final)} + ${f1(spot)} + ${f1(x.placedAt - x.spottedAt)})`,
    );
  }
  const totals = r.latencies.map((x) => x.total).filter((x): x is number => x !== undefined);
  console.log(`   speech -> key: median ${f1(median(totals))} s, max ${f1(Math.max(...totals))} s over ${totals.length} terms`);
  console.log(`   keys at the end: ${r.layout.map((t, i) => `${i}:${t ?? "-"}`).join("  ")}`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
  if (!file) {
    console.error("usage: npm run replay:live -- <recording.jsonl> [--terms \"a=Tech, b\"] [--spotter real] [--tag name]");
    return 1;
  }
  const appRoot = join(__dirname, "..", "..");
  try {
    process.loadEnvFile(join(appRoot, ".env"));
  } catch {
    // no app/.env: fine for the fake spotter
  }
  const recording = loadRecording(file);
  const real = opt("--spotter") === "real";
  const segmentation: AssemblerOptions = {
    ...(opt("--max-words") ? { maxLineWords: Number(opt("--max-words")) } : {}),
    ...(opt("--max-s") ? { maxLineS: Number(opt("--max-s")) } : {}),
  };
  const spotter = real ? new OpenAiCompatClient(loadSpotterLlmConfig(process.env), fetch, (m) => console.log(`   [spotter-llm] ${m}`)) : undefined;
  const intervalMs = opt("--interval") ? Number(opt("--interval")) : spotterIntervalMs(process.env);
  console.log(
    `replay ${basename(file)} (${recording.header.model} · ${recording.header.language}, recorded ${recording.header.createdAt}), ` +
      `spotter ${real ? spotter!.describe() : `keyword fake (${opt("--terms") ? "given terms" : "acronyms"})`}, interval ${intervalMs} ms`,
  );
  const result = await runReplay({
    recording,
    spotter,
    terms: opt("--terms"),
    fakeLatencyMs: opt("--fake-latency") ? Number(opt("--fake-latency")) : undefined,
    intervalMs,
    segmentation,
    realTime: real,
    log: (m) => console.log(`   ${m}`),
  });
  printReport(result, basename(file));
  const tag = opt("--tag");
  const repoRoot = join(appRoot, "..");
  mkdirSync(join(repoRoot, "output"), { recursive: true });
  const out = join(repoRoot, "output", `replay${tag ? `-${tag}` : ""}.json`);
  writeFileSync(out, JSON.stringify({ file: basename(file), header: recording.header, intervalMs, segmentation, ...result }, null, 2));
  console.log(`   details: ${out}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`replay failed: ${err.message}`);
      process.exit(1);
    },
  );
}
