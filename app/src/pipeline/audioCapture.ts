// System audio capture: runs tools/audiotee/bin/audiotee (Core Audio taps, macOS 14.2+) and
// reads 16 kHz mono Int16 LE PCM from its stdout. Its stderr is JSON lines
// {timestamp, message_type: metadata|stream_start|stream_stop|info|error|debug, data}.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants } from "node:fs";
import type { Clock, TimerHandle } from "./clock.js";
import { BYTES_PER_SECOND, SAMPLE_RATE } from "./stt.js";

export type AudioState = "stopped" | "missing" | "starting" | "waiting-permission" | "running" | "silent" | "restarting" | "error";

export interface AudioStatus {
  state: AudioState;
  /** Short text for the panel. */
  text: string;
  /** What to do, for missing / waiting-permission / silent / error. */
  advice?: string;
}

/** What LiveSource needs from audio capture (AudioCapture, or a fake in tests). */
export interface AudioInput extends EventEmitter {
  start(): void;
  stop(): Promise<void>;
  status(): AudioStatus;
}

export const PERMISSION_ADVICE =
  "macOS only gives system audio to apps you allow. If a prompt is open, click Allow. Otherwise: " +
  "System Settings → Privacy & Security → Screen & System Audio Recording → \"System Audio Recording Only\" → " +
  "turn on the app Meeting Keypad was started from (Terminal for `npm run dev`; add it with + if missing). " +
  "Then press Stop and Start listening again.";

export const MISSING_ADVICE = "Build it once: cd app && npm run build:audiotee";

/** RMS level of Int16 LE samples in dBFS (-Infinity for digital silence). */
export function rmsDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

function isAllZero(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
  return true;
}

type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

export interface AudioCaptureOptions {
  binPath: string;
  clock: Clock;
  log: (msg: string) => void;
  spawn?: SpawnFn;
  /** Whether the binary exists and is executable. */
  exists?: (path: string) => boolean;
  args?: string[];
  /** Restart delays after an unexpected exit, ms. */
  backoffMs?: number[];
  /** A run this long resets the backoff. */
  stableMs?: number;
  /** No audio this long after stream_start → "waiting for permission". */
  permissionWaitMs?: number;
  /** Only exact zeros this long → "silent" (also what a denied permission looks like). */
  silentMs?: number;
  /** `level` events at most this often. */
  levelMs?: number;
  killWaitMs?: number;
}

const defaultExists = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Events: `pcm` (Buffer, even length), `level` (dBFS number, throttled), `status` (AudioStatus).
 * Restarts audiotee with backoff when it exits while capture is wanted.
 */
export class AudioCapture extends EventEmitter implements AudioInput {
  private readonly o: Required<AudioCaptureOptions>;
  private child: ChildProcess | null = null;
  private st: AudioStatus = { state: "stopped", text: "Audio: off" };
  private wanted = false;
  private attempt = 0;
  private startedAt = 0;
  private leftover: Buffer | null = null;
  private stderrBuf = "";
  private lastError = "";
  private gotAudio = false;
  private zeroMs = 0;
  private levelAcc: Buffer[] = [];
  private lastLevelAt = 0;
  private permTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;

  constructor(opts: AudioCaptureOptions) {
    super();
    this.o = {
      spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }),
      exists: defaultExists,
      args: ["--sample-rate", String(SAMPLE_RATE), "--chunk-duration", "0.1"],
      backoffMs: [1000, 2000, 4000, 8000, 16000, 30000],
      stableMs: 30000,
      permissionWaitMs: 4000,
      silentMs: 10000,
      levelMs: 100,
      killWaitMs: 1500,
      ...opts,
    };
  }

  status(): AudioStatus {
    return this.st;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    this.launch();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.clearTimers();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const t = this.o.clock.setTimeout(() => {
          child.kill("SIGKILL"); // stuck in AudioDeviceStart (permission prompt) ignores SIGTERM
          resolve();
        }, this.o.killWaitMs);
        child.once("exit", () => {
          this.o.clock.clearTimeout(t);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    this.child = null;
    this.setStatus({ state: "stopped", text: "Audio: off" });
  }

  /** Synchronous kill for app quit. */
  killNow(): void {
    this.wanted = false;
    this.clearTimers();
    this.child?.kill("SIGKILL");
    this.child = null;
  }

  private launch(): void {
    if (!this.o.exists(this.o.binPath)) {
      this.o.log(`audiotee not found at ${this.o.binPath}`);
      this.wanted = false;
      this.setStatus({ state: "missing", text: "Audio: audiotee not built", advice: MISSING_ADVICE });
      return;
    }
    this.leftover = null;
    this.stderrBuf = "";
    this.lastError = "";
    this.gotAudio = false;
    this.zeroMs = 0;
    this.startedAt = this.o.clock.now();
    this.setStatus({ state: "starting", text: "Audio: starting…" });
    let child: ChildProcess;
    try {
      child = this.o.spawn(this.o.binPath, this.o.args);
    } catch (err) {
      this.onExit(null, null, (err as Error).message);
      return;
    }
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.child === child && this.onPcm(d));
    child.stderr?.on("data", (d: Buffer) => this.child === child && this.onStderr(d.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(null, null, err.code === "EACCES" ? `not executable: ${this.o.binPath}` : err.message);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(code, signal);
    });
  }

  private onPcm(d: Buffer): void {
    let buf = this.leftover ? Buffer.concat([this.leftover, d]) : d;
    this.leftover = null;
    if (buf.length % 2 === 1) {
      this.leftover = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    if (buf.length === 0) return;
    if (!this.gotAudio) {
      this.gotAudio = true;
      this.clearPermTimer();
    }
    const ms = (buf.length / BYTES_PER_SECOND) * 1000;
    if (isAllZero(buf)) {
      this.zeroMs += ms;
      if (this.zeroMs >= this.o.silentMs && this.st.state !== "silent") {
        this.setStatus({
          state: "silent",
          text: `Audio: silence for ${Math.round(this.zeroMs / 1000)} s`,
          advice: `Nothing is playing, or macOS is blocking system audio. ${PERMISSION_ADVICE}`,
        });
      }
    } else {
      this.zeroMs = 0;
    }
    if (this.zeroMs < this.o.silentMs && this.st.state !== "running") {
      this.setStatus({ state: "running", text: "Audio: capturing system audio" });
    }
    this.emit("pcm", buf);
    this.levelAcc.push(buf);
    const now = this.o.clock.now();
    if (now - this.lastLevelAt >= this.o.levelMs) {
      this.lastLevelAt = now;
      const all = Buffer.concat(this.levelAcc);
      this.levelAcc = [];
      this.emit("level", rmsDbfs(all));
    }
  }

  private onStderr(s: string): void {
    this.stderrBuf += s;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, nl).trim();
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (line) this.onLogLine(line);
    }
  }

  private onLogLine(line: string): void {
    let m: { message_type?: string; data?: { message?: string; context?: Record<string, string> } };
    try {
      m = JSON.parse(line);
    } catch {
      this.o.log(`audiotee: ${line}`);
      if (/^error/i.test(line)) this.lastError = line;
      return;
    }
    const text = m.data?.message ?? "";
    const ctx = m.data?.context ? ` ${JSON.stringify(m.data.context)}` : "";
    switch (m.message_type) {
      case "stream_start":
        this.o.log("audiotee: stream started");
        this.clearPermTimer();
        if (!this.gotAudio) {
          // On first use, macOS holds AudioDeviceStart until the permission prompt is answered.
          this.permTimer = this.o.clock.setTimeout(() => {
            this.permTimer = null;
            if (this.wanted && !this.gotAudio) {
              this.setStatus({ state: "waiting-permission", text: "Audio: waiting for macOS permission", advice: PERMISSION_ADVICE });
            }
          }, this.o.permissionWaitMs);
        }
        break;
      case "error":
        this.lastError = `${text}${ctx}`;
        this.o.log(`audiotee ERROR: ${text}${ctx}`);
        break;
      case "info":
      case "stream_stop":
        this.o.log(`audiotee: ${text || m.message_type}`);
        break;
      default: // debug, metadata: too chatty for the log
        break;
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, err?: string): void {
    this.clearPermTimer();
    const why = err ?? (this.lastError || (signal ? `killed by ${signal}` : `exited with code ${code}`));
    if (!this.wanted) return;
    if (this.o.clock.now() - this.startedAt >= this.o.stableMs) this.attempt = 0;
    const delay = this.o.backoffMs[Math.min(this.attempt, this.o.backoffMs.length - 1)];
    this.attempt++;
    this.o.log(`audiotee stopped (${why}); restart ${this.attempt} in ${delay} ms`);
    this.setStatus({
      state: "restarting",
      text: `Audio: audiotee stopped, restarting in ${Math.round(delay / 1000)} s`,
      advice: this.lastError ? `audiotee: ${this.lastError}. ${PERMISSION_ADVICE}` : undefined,
    });
    this.retryTimer = this.o.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.launch();
    }, delay);
  }

  private clearPermTimer(): void {
    if (this.permTimer !== null) this.o.clock.clearTimeout(this.permTimer);
    this.permTimer = null;
  }

  private clearTimers(): void {
    this.clearPermTimer();
    if (this.retryTimer !== null) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(s: AudioStatus): void {
    if (s.state === this.st.state && s.text === this.st.text && s.advice === this.st.advice) return;
    this.st = s;
    this.emit("status", s);
  }
}
