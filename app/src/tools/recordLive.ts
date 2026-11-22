// Records a live session's raw Deepgram messages to a fixture for npm run replay:live.
// No term spotter, no LLM: only system audio -> audiotee -> Deepgram, so it costs no spotter budget.
//
//   npm run record:live -- --tag podcast                 until Ctrl+C
//   npm run record:live -- --tag podcast --seconds 180   stops by itself after 3 minutes
//   --keyterms "a, b"                                    Deepgram keyterms (default: none)
//
// Start it, then play the audio (YouTube, a podcast app, a call) on this Mac. Writes
// tools/recordings/<tag>.jsonl (gitignored). Needs the system-audio permission for the terminal app.
// The Deepgram key is never printed or written.

import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AudioCapture } from "../pipeline/audioCapture.js";
import { realClock } from "../pipeline/clock.js";
import { LiveSource, type LiveInterim, type LiveLine } from "../pipeline/liveSource.js";
import { entryLine, headerLine } from "../pipeline/replay.js";
import { deepgramFactory, loadSttConfig, parseKeyterms, sttAdvice, SttError } from "../pipeline/stt.js";

const appRoot = join(__dirname, "..", "..");
const repoRoot = join(appRoot, "..");
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(appRoot, ".env"));
  } catch {
    console.log("no app/.env, using the environment");
  }
  let cfg;
  try {
    cfg = loadSttConfig(process.env);
  } catch (err) {
    console.error(`speech-to-text not configured: ${sttAdvice(err as SttError)}`);
    return 1;
  }
  const tag = (opt("--tag") ?? `rec-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`).replace(/[^\w.-]/g, "_");
  const seconds = opt("--seconds") ? Number(opt("--seconds")) : Infinity;
  const keyterms = parseKeyterms(opt("--keyterms") ?? "");
  const dir = join(repoRoot, "tools", "recordings");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${tag}.jsonl`);
  const out = createWriteStream(path);
  out.write(
    `${headerLine({
      createdAt: new Date().toISOString(),
      model: cfg.model,
      language: cfg.language,
      diarize: cfg.diarize,
      endpointingMs: cfg.endpointingMs,
      utteranceEndMs: cfg.utteranceEndMs,
      keyterms,
    })}\n`,
  );
  let messages = 0;
  const clock = realClock;
  const bin = process.env.AUDIOTEE_PATH || join(repoRoot, "tools", "audiotee", "bin", "audiotee");
  const audio = new AudioCapture({ binPath: bin, clock, log: (m) => console.log(`   [audio] ${m}`) });
  const stt = deepgramFactory(cfg, {
    clock,
    log: (m) => console.log(`   [stt] ${m}`),
    onRaw: (e) => {
      messages++;
      out.write(`${entryLine(e)}\n`);
    },
  });
  const live = new LiveSource({ clock, audio, stt, log: () => {} });
  let lines = 0;
  let lastInterim = 0;
  live.on("line", (l: LiveLine) => {
    lines++;
    console.log(`[${mmss(l.t)}] ${l.reason === "length" ? "(cut) " : ""}${l.text}`);
  });
  live.on("interim", (i: LiveInterim | null) => {
    if (i && Date.now() - lastInterim > 5000) {
      lastInterim = Date.now();
      process.stdout.write(`   … ${i.text.slice(-70)}\n`);
    }
  });

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nstopping (${why}), waiting for the last words…`);
    await live.stop();
    await live.dispose();
    await new Promise<void>((r) => out.end(r));
    console.log(`recorded ${mmss(live.position())}: ${messages} Deepgram messages, ${lines} lines -> ${path}`);
    console.log(`replay it: npm run replay:live -- ${path} --terms "<term>=<Category>, ..."`);
  };
  process.on("SIGINT", () => void stop("Ctrl+C").then(() => process.exit(0)));

  console.log(`recording to ${path}${Number.isFinite(seconds) ? ` for ${seconds} s` : " until Ctrl+C"}${keyterms.length ? `, keyterms: ${keyterms.join(", ")}` : ""}`);
  live.start(keyterms);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const s = live.state();
    if (s.stt.state === "open" && (s.audio.state === "running" || s.audio.state === "silent")) break;
    if (Date.now() > deadline || s.stt.state === "error" || s.audio.state === "missing" || s.audio.state === "error") {
      console.error(`not ready: audio ${s.audio.state} (${s.audio.advice ?? ""}), stt ${s.stt.state} (${s.stt.advice ?? ""})`);
      await stop("not ready");
      return 1;
    }
    await sleep(50);
  }
  console.log("listening: play the audio now.");
  const started = Date.now();
  let warned = false;
  while (!stopping && Date.now() - started < seconds * 1000) {
    await sleep(250);
    const s = live.state();
    if (!warned && s.audio.state === "silent" && Date.now() - started > 10_000 && lines === 0) {
      warned = true;
      console.log(`   (no audio yet: ${s.audio.advice ?? "is something playing?"})`);
    }
  }
  await stop(`${seconds} s`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`record failed: ${err.message}`);
      process.exit(1);
    },
  );
}
