// The mock meeting voiced with macOS `say` (one voice per speaker), cached in tools/mock-audio/
// (gitignored). Shared by the live smoke run and the term eval.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MeetingLine } from "../pipeline/mockData.js";

export const AUDIO_DIR = join(__dirname, "..", "..", "..", "tools", "mock-audio");
export const VOICES: Record<string, string> = { Lena: "Samantha", Omar: "Daniel", Priya: "Tara" };
const FALLBACK_VOICE = "Samantha";

export interface Clip {
  line: MeetingLine;
  voice: string;
  file: string;
  duration: number;
}

/** Voices each line (cached by text + voice) and reads its duration. */
export function voiceLines(lines: MeetingLine[]): Clip[] {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const clips: Clip[] = [];
  lines.forEach((line, i) => {
    const voice = VOICES[line.speaker] ?? FALLBACK_VOICE;
    const hash = createHash("sha1").update(`${voice}\n${line.text}`).digest("hex").slice(0, 8);
    const file = join(AUDIO_DIR, `${String(i).padStart(2, "0")}-${line.speaker}-${hash}.aiff`);
    if (!existsSync(file)) execFileSync("say", ["-v", voice, "-o", file, line.text]);
    const info = execFileSync("afinfo", [file], { encoding: "utf8" });
    const m = /estimated duration: ([\d.]+) sec/.exec(info);
    clips.push({ line, voice, file, duration: m ? Number(m[1]) : 0 });
  });
  return clips;
}
