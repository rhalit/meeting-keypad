// Term-spotting eval: plays the voiced mock meeting through the full live pipeline and checks
// which glossary terms reach a key, how many keys go to other terms, and how fast.
//
//   npm run eval:terms                          real audio: say -> speakers -> audiotee -> Deepgram -> ...
//   npm run eval:terms -- --text                no audio: the script lines arrive as finals on the same
//                                               schedule (fast prompt tuning, no speakers, no Deepgram)
//   --profile "<what the listener knows>"       default: a general audience (the glossary's audience);
//   --profile config                            the listenerKnows text from mock/config.json
//   --model <id>                                spotter model (default LLM_SPOTTER_MODEL)
//   --interval <ms>                             spotter interval (default LLM_SPOTTER_INTERVAL_MS / 8000)
//   --keyterms                                  glossary terms as Deepgram keyterms (off by default: honest)
//   --lines N                                   first N lines only
//   --tag <name>                                output/eval-terms-<name>.json
//
// Pipeline (same pieces and wiring as the app's Live mode): LiveSource -> TranscriptBuffer +
// TermSpotter (LLM_SPOTTER_MODEL) -> SlotManager -> Explainer (LLM_MODEL, prefetch on placement).
// Needs the terminal's system-audio permission for the real-audio mode. The API keys are never printed.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AudioCapture } from "../pipeline/audioCapture.js";
import { realClock } from "../pipeline/clock.js";
import { Explainer } from "../pipeline/explainer.js";
import {
  OpenAiCompatClient,
  loadLlmConfig,
  loadSpotterLlmConfig,
  spotterIntervalMs,
  type JsonSpec,
  type LlmClient,
  type LlmRequest,
  type LlmUsage,
} from "../pipeline/llm.js";
import { LiveSource, type LiveLine } from "../pipeline/liveSource.js";
import { loadConfig, loadGlossary, loadMeeting, type Glossary, type ListenerProfile } from "../pipeline/mockData.js";
import { SlotManager } from "../pipeline/slots.js";
import { deepgramFactory, loadSttConfig, parseKeyterms, sttAdvice, SttError } from "../pipeline/stt.js";
import { TermSpotter, type SpotInfo } from "../pipeline/termSpotter.js";
import type { TermCandidate } from "../pipeline/terms.js";
import { TranscriptBuffer, type TranscriptLine } from "../pipeline/transcriptBuffer.js";
import { voiceLines, type Clip } from "./mockAudio.js";

const appRoot = join(__dirname, "..", "..");
const repoRoot = join(appRoot, "..");
const GAP_S = 0.4;
const TAIL_S = 10;
/** --text: a final arrives this long after the line was spoken (typical Deepgram delay in smoke:live). */
const TEXT_FINAL_DELAY_S = 0.8;
export const GENERAL_PROFILE = "a general audience: no particular tech, finance or business background";
const TARGETS = { found: 11, fpPer5Min: 2, medianS: 5 };
/** Groq free tier for the gpt-oss models: RPM / RPD / TPM from the response headers, TPD from the docs. */
const FREE = { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");

// --- matching a key's term to a glossary term ------------------------------------------------

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const compact = (s: string) => plain(s).replace(/ /g, "");
const containsWords = (hay: string, needle: string) => ` ${plain(hay)} `.includes(` ${plain(needle)} `);

/** The glossary term a spotted term stands for, or null (a false positive). */
export function matchGlossary(glossary: Glossary, term: string): string | null {
  for (const [g, e] of Object.entries(glossary)) {
    const forms = [g, e.full, e.label.replace(/\n/g, " ").replace(/- /g, "")];
    for (const f of forms) {
      if (compact(f) === compact(term)) return g;
      // Longer spotted term around the glossary one ("SOC 2 Type II", "customer churn rate").
      if (containsWords(term, f)) return g;
      // Shorter spotted term inside the glossary one ("canary" for "canary release"), not tiny words.
      if (containsWords(f, term) && (compact(term).length >= 5 || plain(f).startsWith(`${plain(term)} `))) return g;
    }
  }
  return null;
}

// --- an LlmClient wrapper that times calls -----------------------------------------------------

class TimedClient implements LlmClient {
  readonly durations: number[] = [];
  constructor(private readonly inner: LlmClient) {}
  describe(): string {
    return this.inner.describe();
  }
  stream(req: LlmRequest): AsyncIterable<string> {
    return this.inner.stream(req);
  }
  async json<T>(req: LlmRequest, spec: JsonSpec<T>): Promise<T> {
    const t0 = now();
    try {
      return await this.inner.json(req, spec);
    } finally {
      this.durations.push((now() - t0) / 1000);
    }
  }
  complete(req: LlmRequest): Promise<string> {
    return this.inner.complete(req);
  }
}

interface Played {
  clip: Clip;
  start: number;
  end: number;
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(appRoot, ".env"));
  } catch {
    console.log("no app/.env, using the environment");
  }
  const textMode = flag("--text");
  const config = loadConfig(join(repoRoot, "mock", "config.json"));
  const glossary = loadGlossary(join(repoRoot, "mock", "glossary.json"));
  const maxLines = opt("--lines") ? Number(opt("--lines")) : Infinity;
  const meeting = loadMeeting(join(repoRoot, "mock", "meeting.json"), config.listenerName).slice(0, maxLines);
  const profileArg = opt("--profile");
  const knows = profileArg === "config" ? config.listenerKnows : (profileArg ?? GENERAL_PROFILE);
  const listener: ListenerProfile = { name: config.listenerName, knows };
  const env = { ...process.env, ...(opt("--model") ? { LLM_SPOTTER_MODEL: opt("--model") } : {}) };
  const intervalMs = opt("--interval") ? Number(opt("--interval")) : spotterIntervalMs(env);
  const tag = opt("--tag");
  const keyterms = flag("--keyterms") ? parseKeyterms(Object.keys(glossary)) : parseKeyterms(config.keyterms);

  const usage = { spotter: [] as LlmUsage[], explain: [] as LlmUsage[] };
  const spotterCfg = loadSpotterLlmConfig(env);
  const spotterLlm = new TimedClient(new OpenAiCompatClient(spotterCfg, fetch, (m) => console.log(`   [spotter-llm] ${m}`), (u) => usage.spotter.push(u)));
  const explainLlm = new OpenAiCompatClient(loadLlmConfig(env), fetch, (m) => console.log(`   [llm] ${m}`), (u) => usage.explain.push(u));

  console.log(`term eval: ${textMode ? "text replay (no audio)" : "real audio through the speakers"}, ${meeting.length} lines`);
  console.log(`   spotter ${spotterLlm.describe()}${spotterCfg.reasoningEffort ? ` (reasoning ${spotterCfg.reasoningEffort})` : ""}, every >= ${intervalMs} ms`);
  console.log(`   explanations ${explainLlm.describe()}`);
  console.log(`   listener: ${listener.name} (${listener.knows})`);
  console.log(`   keyterms: ${keyterms.length ? keyterms.join(", ") : "none"}`);

  const clips = voiceLines(meeting);
  const clock = realClock;
  let startWall = now();
  const meetingAt = (wall = now()) => (wall - startWall) / 1000;
  const quiet = () => {};

  const transcript = new TranscriptBuffer();
  const slots = new SlotManager({ clock });
  const spotter = new TermSpotter({ clock, llm: spotterLlm, listener, log: (m) => console.log(`   ${m}`), minIntervalMs: intervalMs });
  const explainer = new Explainer({ clock, llm: explainLlm, listener, log: (m) => console.log(`   ${m}`) });

  const lineArrived = new Map<TranscriptLine, number>();
  const spotted: { c: TermCandidate; info: SpotInfo; at: number }[] = [];
  const placed: { slot: number; c: TermCandidate; at: number }[] = [];
  const ready = new Map<string, number>();

  const onLine = (line: LiveLine) => {
    lineArrived.set(line, meetingAt());
    transcript.add(line);
    console.log(`   final  [${f1(line.t).padStart(5)}] ${line.speaker ?? "-"}: ${line.text}`);
    spotter.addLine(line);
  };
  spotter.on("term", (c: TermCandidate, info: SpotInfo) => {
    spotted.push({ c, info, at: meetingAt() });
    explainer.noteHeard(c, info.line, info.context);
    slots.add(c);
  });
  slots.on("placed", ({ slot, candidate }: { slot: number; candidate: TermCandidate }) => {
    placed.push({ slot, c: candidate, at: meetingAt() });
    console.log(`   KEY ${slot} <- "${candidate.term}" ${JSON.stringify(candidate.label)} at ${f1(meetingAt())} s`);
    explainer.prefetch(candidate.term);
  });
  explainer.on("ready", (term: string) => ready.set(term, meetingAt()));

  const played: Played[] = [];
  let live: LiveSource | null = null;
  if (!textMode) {
    let sttCfg;
    try {
      sttCfg = loadSttConfig(process.env);
    } catch (err) {
      console.error(`speech-to-text not configured: ${sttAdvice(err as SttError)}`);
      return 1;
    }
    const bin = process.env.AUDIOTEE_PATH || join(repoRoot, "tools", "audiotee", "bin", "audiotee");
    const audio = new AudioCapture({ binPath: bin, clock, log: quiet });
    live = new LiveSource({ clock, audio, stt: deepgramFactory(sttCfg, { clock, log: quiet }), log: quiet });
    live.on("line", onLine);
    live.start(keyterms);
    startWall = now();
    const deadline = Date.now() + 15_000;
    for (;;) {
      const s = live.state();
      if ((s.audio.state === "running" || s.audio.state === "silent") && s.stt.state === "open") break;
      if (Date.now() > deadline || s.stt.state === "error" || s.audio.state === "missing") {
        console.error(`   not ready: audio ${s.audio.state} (${s.audio.advice ?? ""}), stt ${s.stt.state} (${s.stt.advice ?? ""})`);
        await live.dispose();
        return 1;
      }
      await sleep(50);
    }
  }

  // --- play the meeting ------------------------------------------------------------------------
  const lead = meetingAt() + 1;
  let prevEnd = 0;
  const speakerIds = new Map<string, string>();
  for (const clip of clips) {
    const due = Math.max(lead + clip.line.t, prevEnd + GAP_S);
    const wait = (due - meetingAt()) * 1000;
    if (wait > 0) await sleep(wait);
    const start = meetingAt();
    if (textMode) {
      await sleep(clip.duration * 1000);
    } else {
      await new Promise<void>((resolve, reject) => {
        const p = spawn("afplay", [clip.file], { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", () => resolve());
      });
    }
    const end = meetingAt();
    played.push({ clip, start, end });
    prevEnd = end;
    if (textMode) {
      if (!speakerIds.has(clip.line.speaker)) speakerIds.set(clip.line.speaker, `Speaker ${speakerIds.size}`);
      const line: LiveLine = { t: Math.round(start * 10) / 10, speaker: speakerIds.get(clip.line.speaker), text: clip.line.text, terms: [], end };
      setTimeout(() => onLine(line), TEXT_FINAL_DELAY_S * 1000);
    }
  }
  await sleep(TAIL_S * 1000);
  if (live) {
    await live.stop();
    await live.dispose();
  }
  await spotter.whenIdle();
  await Promise.race([explainer.whenIdle(), sleep(25_000)]);
  const duration = played.length ? played[played.length - 1].end : 0;

  // --- report ---------------------------------------------------------------------------------
  // Where each glossary term is first said: the first script line listing it.
  const expected = Object.keys(glossary).filter((g) => meeting.some((l) => l.terms.includes(g)));
  const saidAt = new Map<string, Played>();
  for (const g of expected) {
    const p = played.find((x) => x.clip.line.terms.includes(g));
    if (p) saidAt.set(g, p);
  }
  interface Row {
    glossary: string;
    found: boolean;
    asSpotted?: string;
    label?: string;
    slot?: number;
    /** End of the spoken line -> key, seconds. */
    delay?: number;
    finalDelay?: number;
    spotDelay?: number;
    queueDelay?: number;
    explainReadyAfterKey?: number;
  }
  const rows: Row[] = expected.map((g) => ({ glossary: g, found: false }));
  const falsePositives: { term: string; label: string; slot: number; at: number; reason: string }[] = [];
  for (const p of placed) {
    const g = matchGlossary(glossary, p.c.term);
    const s = spotted.find((x) => x.c.term === p.c.term);
    const row = g ? rows.find((r) => r.glossary === g && !r.found) : undefined;
    if (!g || !row) {
      if (!g) falsePositives.push({ term: p.c.term, label: p.c.label, slot: p.slot, at: p.at, reason: s?.info.reason ?? "" });
      continue;
    }
    const said = saidAt.get(g);
    const arrived = s ? lineArrived.get(s.info.line) : undefined;
    const readyAt = ready.get(p.c.term);
    Object.assign(row, {
      found: true,
      asSpotted: p.c.term,
      label: p.c.label,
      slot: p.slot,
      delay: said ? p.at - said.end : undefined,
      finalDelay: said && arrived !== undefined ? arrived - said.end : undefined,
      spotDelay: s && arrived !== undefined ? s.at - arrived : undefined,
      queueDelay: s ? p.at - s.at : undefined,
      explainReadyAfterKey: readyAt !== undefined ? readyAt - p.at : undefined,
    });
  }
  const found = rows.filter((r) => r.found);
  const delays = found.map((r) => r.delay).filter((d): d is number => d !== undefined);
  const fpPer5 = duration > 0 ? (falsePositives.length * 300) / duration : 0;
  const med = median(delays);
  const explainReady = found.map((r) => r.explainReadyAfterKey).filter((d): d is number => d !== undefined);

  console.log(`\nREPORT (${textMode ? "text replay" : "real audio"}, spotter ${spotterLlm.describe()}, interval ${intervalMs} ms, listener "${listener.knows}")`);
  console.log(`   glossary term       key  spotted as             label          speech->key  (final + spot + queue)  explained after`);
  for (const r of rows) {
    if (!r.found) {
      console.log(`   ${r.glossary.padEnd(18)}  --   MISSED`);
      continue;
    }
    console.log(
      `   ${r.glossary.padEnd(18)}  ${String(r.slot).padStart(2)}   ${(r.asSpotted ?? "").padEnd(21)}  ${JSON.stringify(r.label).padEnd(13)}  ${f1(r.delay ?? NaN).padStart(6)} s     (${f1(r.finalDelay ?? NaN)} + ${f1(r.spotDelay ?? NaN)} + ${f1(r.queueDelay ?? NaN)})          ${f1(r.explainReadyAfterKey ?? NaN)} s`,
    );
  }
  console.log(`   false positives (on a key, not in the glossary): ${falsePositives.length}`);
  for (const fp of falsePositives) console.log(`     - "${fp.term}" ${JSON.stringify(fp.label)} at ${f1(fp.at)} s (${fp.reason})`);
  const unplaced = spotted.filter((s) => !placed.some((p) => p.c.term === s.c.term)).map((s) => s.c.term);
  if (unplaced.length) console.log(`   spotted but never reached a key (queue): ${unplaced.join(", ")}`);

  const calls = spotter.stats.calls;
  const sp = usage.spotter;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const tokPerCall = avg(sp.map((u) => u.totalTokens));
  const billedPerCall = avg(sp.map((u) => u.totalTokens - u.cachedTokens));
  console.log(`\n   spotter: ${calls} calls, ${spotter.stats.rateLimited} rate-limited, ${spotter.stats.errors} errors, call time median ${f1(median(spotterLlm.durations))} s / p90 ${f1(quantile(spotterLlm.durations, 0.9))} s`);
  console.log(`   spotter tokens per call: ${f1(tokPerCall)} total (prompt ${f1(avg(sp.map((u) => u.promptTokens)))}, completion ${f1(avg(sp.map((u) => u.completionTokens)))}, cached ${f1(avg(sp.map((u) => u.cachedTokens)))})`);
  console.log(`   explanations: ${usage.explain.length} calls, ready after key: median ${f1(median(explainReady))} s, max ${f1(Math.max(...explainReady))} s, ${explainReady.filter((x) => x <= 5).length}/${found.length} within 5 s`);

  // Shortest interval the free limits allow for one hour of continuous speech (a call every interval).
  const perCall = Number.isFinite(billedPerCall) ? billedPerCall : 900;
  const limits = {
    rpm: 60 / FREE.rpm,
    rpd: 3600 / FREE.rpd,
    tpm: (60 * perCall) / FREE.tpm,
    tpd: (3600 * perCall) / FREE.tpd,
  };
  const shortest = Math.max(...Object.values(limits));
  console.log(
    `   free-tier floor for 1 h of non-stop speech at ${f1(perCall)} counted tokens/call: RPM ${f1(limits.rpm)} s, RPD ${f1(limits.rpd)} s, TPM ${f1(limits.tpm)} s, TPD ${f1(limits.tpd)} s -> interval >= ${f1(shortest)} s`,
  );

  const pass = {
    found: found.length >= TARGETS.found,
    fp: fpPer5 <= TARGETS.fpPer5Min,
    median: med < TARGETS.medianS,
  };
  console.log(`\n   reached a key: ${found.length}/${rows.length}  (target >= ${TARGETS.found})  ${pass.found ? "PASS" : "FAIL"}`);
  console.log(`   false positives: ${falsePositives.length} in ${f1(duration / 60)} min = ${f1(fpPer5)} per 5 min  (target <= ${TARGETS.fpPer5Min})  ${pass.fp ? "PASS" : "FAIL"}`);
  console.log(`   speech -> key: median ${f1(med)} s, p90 ${f1(quantile(delays, 0.9))} s  (target median < ${TARGETS.medianS} s)  ${pass.median ? "PASS" : "FAIL"}`);

  const out = join(repoRoot, "output", `eval-terms${tag ? `-${tag}` : ""}.json`);
  mkdirSync(join(repoRoot, "output"), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        mode: textMode ? "text" : "audio",
        spotter: spotterLlm.describe(),
        intervalMs,
        listener,
        keyterms,
        durationS: duration,
        rows,
        falsePositives,
        spotted: spotted.map((s) => ({ ...s.c, at: s.at, heardIn: s.info.line.text, confidence: s.info.confidence, reason: s.info.reason })),
        placed: placed.map((p) => ({ ...p.c, slot: p.slot, at: p.at })),
        spotterStats: spotter.stats,
        spotterCallS: spotterLlm.durations,
        usage,
        freeTierFloorS: { ...limits, shortest, countedTokensPerCall: perCall },
        summary: { found: found.length, of: rows.length, falsePositives: falsePositives.length, fpPer5Min: fpPer5, medianS: med, pass },
      },
      null,
      2,
    ),
  );
  console.log(`   details: ${out}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`term eval failed: ${err.message}`);
      process.exit(1);
    },
  );
}
