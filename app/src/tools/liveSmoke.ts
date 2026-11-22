// Real end-to-end check of the live path, without Electron or the keypad:
//   npm run smoke:live                    (no keyterms: the honest baseline)
//   npm run smoke:live -- --keyterms      (glossary terms as Deepgram keyterms)
//   npm run smoke:live -- --lines 10      (only the first 10 lines, for a quick check)
//
// 1. Voices mock/meeting.json with macOS `say`, one voice per speaker, into tools/mock-audio/
//    (gitignored, cached by text + voice).
// 2. Starts AudioCapture (audiotee) + Deepgram + LiveSource, exactly as the app does.
// 3. Plays the lines through the speakers with `afplay` on the meeting.json schedule.
// 4. Reports the delay from the end of each spoken line to its final transcript line, and the
//    word accuracy (1 - WER) against meeting.json.
// Needs the macOS system-audio permission for the terminal it runs in. The API key is never printed.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AudioCapture, type AudioStatus } from "../pipeline/audioCapture.js";
import { realClock } from "../pipeline/clock.js";
import { LiveSource, type LiveLine } from "../pipeline/liveSource.js";
import { loadConfig, loadGlossary, loadMeeting, type MeetingLine } from "../pipeline/mockData.js";
import { deepgramFactory, loadSttConfig, parseKeyterms, sttAdvice, SttError, type SttStatus } from "../pipeline/stt.js";

const appRoot = join(__dirname, "..", "..");
const repoRoot = join(appRoot, "..");
const audioDir = join(repoRoot, "tools", "mock-audio");
const VOICES: Record<string, string> = { Lena: "Samantha", Omar: "Daniel", Priya: "Tara" };
const FALLBACK_VOICE = "Samantha";
const GAP_S = 0.4; // minimum silence between two spoken lines
const TAIL_S = 6; // wait for the last finals after the last line

const args = process.argv.slice(2);
const withKeyterms = args.includes("--keyterms");
const linesArg = args.indexOf("--lines");
const maxLines = linesArg >= 0 ? Number(args[linesArg + 1]) : Infinity;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

interface Clip {
  line: MeetingLine;
  voice: string;
  file: string;
  duration: number;
}

function voiceLines(lines: MeetingLine[]): Clip[] {
  mkdirSync(audioDir, { recursive: true });
  const clips: Clip[] = [];
  lines.forEach((line, i) => {
    const voice = VOICES[line.speaker] ?? FALLBACK_VOICE;
    const hash = createHash("sha1").update(`${voice}\n${line.text}`).digest("hex").slice(0, 8);
    const file = join(audioDir, `${String(i).padStart(2, "0")}-${line.speaker}-${hash}.aiff`);
    if (!existsSync(file)) execFileSync("say", ["-v", voice, "-o", file, line.text]);
    const info = execFileSync("afinfo", [file], { encoding: "utf8" });
    const m = /estimated duration: ([\d.]+) sec/.exec(info);
    clips.push({ line, voice, file, duration: m ? Number(m[1]) : 0 });
  });
  return clips;
}

/** Lowercase words, punctuation removed, hyphens split; keeps decimals like 1.8. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/[^a-z0-9.%$' ]+/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/**
 * Same words with numbers written as digits and units dropped ("forty two thousand dollars" ->
 * "42000", "$42,000" -> "42000", "five percent" -> "5"), so smart_format's number style does not
 * count as an error.
 */
export function numberNormalized(ws: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (w in UNITS || (w in SCALES && out.length === 0)) {
      let total = 0;
      let cur = 0;
      let j = i;
      while (j < ws.length && (ws[j] in UNITS || ws[j] in SCALES || (ws[j] === "and" && j > i && ws[j + 1] in UNITS))) {
        const x = ws[j];
        if (x in UNITS) cur += UNITS[x];
        else if (x === "hundred") cur = (cur || 1) * 100;
        else if (x in SCALES) {
          total += (cur || 1) * SCALES[x];
          cur = 0;
        }
        j++;
      }
      out.push(String(total + cur));
      i = j;
      continue;
    }
    if (w === "dollars" || w === "dollar" || w === "percent") {
      i++;
      continue;
    }
    out.push(w.replace(/[$%]/g, ""));
    i++;
  }
  return out.filter(Boolean);
}

/** Word-level edit distance (substitutions + deletions + insertions). */
export function editDistance(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length];
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

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
  const config = loadConfig(join(repoRoot, "mock", "config.json"));
  const meeting = loadMeeting(join(repoRoot, "mock", "meeting.json"), config.listenerName).slice(0, maxLines);
  const keyterms = withKeyterms ? parseKeyterms(Object.keys(loadGlossary(join(repoRoot, "mock", "glossary.json")))) : [];

  console.log(`1) voicing ${meeting.length} lines with say (${Object.entries(VOICES).map(([s, v]) => `${s}=${v}`).join(", ")})`);
  const clips = voiceLines(meeting);
  console.log(`   ${clips.reduce((n, c) => n + c.duration, 0).toFixed(0)} s of speech in ${audioDir}`);

  const log = (m: string) => console.log(`   ${m}`);
  const bin = process.env.AUDIOTEE_PATH || join(repoRoot, "tools", "audiotee", "bin", "audiotee");
  const audio = new AudioCapture({ binPath: bin, clock: realClock, log: (m) => log(`[audio] ${m}`) });
  const live = new LiveSource({ clock: realClock, audio, stt: deepgramFactory(cfg, { clock: realClock, log: (m) => log(`[stt] ${m}`) }), log: () => {} });
  const finals: { line: LiveLine; at: number }[] = [];
  let startWall = 0;
  live.on("line", (line: LiveLine) => {
    finals.push({ line, at: now() });
    console.log(`   final  [${line.t.toFixed(1).padStart(5)}] ${line.speaker ?? "-"}: ${line.text}`);
  });
  let audioState = "stopped" as AudioStatus["state"];
  let sttState = "idle" as SttStatus["state"];
  live.on("state", () => {
    const s = live.state();
    if (s.audio.state !== audioState) {
      audioState = s.audio.state;
      log(`audio: ${s.audio.text}${s.audio.advice ? `\n   -> ${s.audio.advice}` : ""}`);
    }
    if (s.stt.state !== sttState) {
      sttState = s.stt.state;
      log(`stt: ${s.stt.text}${s.stt.advice ? `\n   -> ${s.stt.advice}` : ""}`);
    }
  });

  console.log(`\n2) listening (${cfg.model}, ${cfg.language}${keyterms.length ? `, ${keyterms.length} keyterms` : ", no keyterms"})`);
  live.start(keyterms);
  startWall = now();
  const ready = Date.now() + 15000;
  while (!(audioState === "running" || audioState === "silent") || sttState !== "open") {
    if (Date.now() > ready || sttState === "error" || audioState === "missing") {
      console.error(`   not ready: audio ${audioState}, stt ${sttState}`);
      await live.dispose();
      return 1;
    }
    await sleep(50);
  }
  const meetingAt = (wall: number) => (wall - startWall) / 1000;
  log(`ready after ${meetingAt(now()).toFixed(1)} s`);

  console.log(`\n3) playing through the speakers`);
  const lead = meetingAt(now()) + 1; // meeting.json t = 0 plays 1 s after ready
  const played: { clip: Clip; start: number; end: number }[] = [];
  let prevEnd = 0;
  for (const clip of clips) {
    const due = Math.max(lead + clip.line.t, prevEnd + GAP_S);
    const wait = (due - meetingAt(now())) * 1000;
    if (wait > 0) await sleep(wait);
    const start = meetingAt(now());
    await new Promise<void>((resolve, reject) => {
      const p = spawn("afplay", [clip.file], { stdio: "ignore" });
      p.on("error", reject);
      p.on("exit", () => resolve());
    });
    const end = meetingAt(now());
    played.push({ clip, start, end });
    prevEnd = end;
    console.log(`   spoken [${start.toFixed(1).padStart(5)}–${end.toFixed(1).padStart(5)}] ${clip.line.speaker}: ${clip.line.text}`);
  }
  await sleep(TAIL_S * 1000);
  await live.stop();
  await live.dispose();

  // --- report ---------------------------------------------------------------------------------
  // A final belongs to the last clip that started before it (Deepgram's start can be a bit early).
  const owner = (t: number) => {
    let best = -1;
    played.forEach((p, i) => {
      if (p.start <= t + 0.75) best = i;
    });
    return best;
  };
  const byLine = new Map<number, { line: LiveLine; at: number }[]>();
  for (const f of finals) {
    const i = owner(f.line.t);
    byLine.set(i, [...(byLine.get(i) ?? []), f]);
  }
  // Delay = final arrived - last word ended (Deepgram word timing on the captured audio).
  const delays = finals.filter((f) => f.line.end !== undefined).map((f) => meetingAt(f.at) - f.line.end!);
  // The same against the end of the clip as played (afplay exit, includes the clip's trailing silence).
  const lineDelays: number[] = [];
  let missing = 0;
  const perLine: { i: number; wer: number; ref: string; hyp: string }[] = [];
  played.forEach((p, i) => {
    const fs = byLine.get(i) ?? [];
    if (fs.length === 0) missing++;
    else lineDelays.push(meetingAt(fs[fs.length - 1].at) - p.end);
    const ref = words(p.clip.line.text);
    const hyp = words(fs.map((f) => f.line.text).join(" "));
    perLine.push({ i, wer: ref.length ? editDistance(ref, hyp) / ref.length : 0, ref: p.clip.line.text, hyp: fs.map((f) => f.line.text).join(" ") });
  });
  const stray = byLine.get(-1)?.length ?? 0;
  const refAll = words(played.map((p) => p.clip.line.text).join(" "));
  const hypAll = words(finals.map((f) => f.line.text).join(" "));
  const wer = editDistance(refAll, hypAll) / refAll.length;
  const refNum = numberNormalized(refAll);
  const werNum = editDistance(refNum, numberNormalized(hypAll)) / refNum.length;
  const speakers = new Set(finals.map((f) => f.line.speaker ?? "-"));

  console.log(`\n4) report${keyterms.length ? " (with glossary keyterms)" : " (no keyterms)"}`);
  console.log(`   spoken lines: ${played.length}, final lines: ${finals.length}, lines with no final: ${missing}, stray finals: ${stray}`);
  const stats = (xs: number[]) =>
    `median ${quantile(xs, 0.5).toFixed(2)} s, p90 ${quantile(xs, 0.9).toFixed(2)} s, min ${Math.min(...xs).toFixed(2)} s, max ${Math.max(...xs).toFixed(2)} s`;
  console.log(`   delay last spoken word -> final line: ${stats(delays)}`);
  console.log(`   delay end of clip (afplay exit) -> final line: ${stats(lineDelays)}`);
  console.log(`   word accuracy: ${pct(1 - wer)} raw (WER ${pct(wer)}, ${refAll.length} reference words, ${hypAll.length} recognised)`);
  console.log(`   word accuracy, numbers normalised ("nineteen" = "19", "$42,000" = "forty-two thousand dollars"): ${pct(1 - werNum)}`);
  console.log(`   speakers seen: ${[...speakers].join(", ")} (script has ${new Set(played.map((p) => p.clip.line.speaker)).size})`);
  const worst = [...perLine].sort((a, b) => b.wer - a.wer).slice(0, 8).filter((l) => l.wer > 0);
  if (worst.length) {
    console.log(`   worst lines:`);
    for (const l of worst) console.log(`     ${pct(l.wer).padStart(7)}  said: ${l.ref}\n              got:  ${l.hyp || "(nothing)"}`);
  }
  const out = join(repoRoot, "output", `live-smoke${keyterms.length ? "-keyterms" : ""}.json`);
  mkdirSync(join(repoRoot, "output"), { recursive: true });
  writeFileSync(out, JSON.stringify({ keyterms, played: played.map((p) => ({ t: p.clip.line.t, start: p.start, end: p.end, speaker: p.clip.line.speaker, text: p.clip.line.text })), finals: finals.map((f) => ({ ...f.line, at: meetingAt(f.at) })), delays, lineDelays, wer, werNumbersNormalized: werNum }, null, 2));
  console.log(`   details: ${out}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`live smoke failed: ${err.message}`);
      process.exit(1);
    },
  );
}
