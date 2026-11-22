// Recorded Deepgram sessions: the file format (JSONL), and an SttSession that plays one back
// through the same assembler as the live session, so segmentation and timing can be tuned offline.
//
// File: line 1 = RecordingHeader, then one RecordedEntry per Deepgram text message / (re)connect.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { Clock, TimerHandle } from "./clock.js";
import {
  DeepgramAssembler,
  handleDeepgramMessage,
  type AssemblerOptions,
  type RawSttEntry,
  type SttSegment,
  type SttSession,
  type SttStatus,
} from "./stt.js";

export const RECORDING_VERSION = 1;

export interface RecordingHeader {
  type: "header";
  version: number;
  createdAt: string;
  model: string;
  language: string;
  diarize: boolean;
  endpointingMs: number;
  utteranceEndMs: number;
  keyterms: string[];
}

export interface RecordedEntry {
  /** Clock ms since the STT session started. */
  at: number;
  /** Session audio seconds at which this connection's audio began. */
  offset: number | null;
  /** Parsed Deepgram message (Results, UtteranceEnd, Metadata, SpeechStarted, ...). */
  msg?: unknown;
  type?: "connect";
}

export interface Recording {
  header: RecordingHeader;
  entries: RecordedEntry[];
}

export function headerLine(h: Omit<RecordingHeader, "type" | "version">): string {
  return JSON.stringify({ type: "header", version: RECORDING_VERSION, ...h } satisfies RecordingHeader);
}

/** One JSONL line for a raw tap entry (the message is stored parsed, so the file is readable). */
export function entryLine(e: RawSttEntry): string {
  const out: RecordedEntry = { at: Math.round(e.at), offset: e.offset };
  if (e.type) out.type = e.type;
  if (e.msg !== undefined) {
    try {
      out.msg = JSON.parse(e.msg);
    } catch {
      out.msg = e.msg;
    }
  }
  return JSON.stringify(out);
}

export function parseRecording(text: string): Recording {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("empty recording");
  const header = JSON.parse(lines[0]) as RecordingHeader;
  if (header.type !== "header") throw new Error("recording: first line is not a header");
  if (header.version !== RECORDING_VERSION) throw new Error(`recording: version ${header.version}, expected ${RECORDING_VERSION}`);
  const entries = lines.slice(1).map((l, i) => {
    const e = JSON.parse(l) as RecordedEntry;
    if (typeof e.at !== "number") throw new Error(`recording line ${i + 2}: no "at"`);
    return e;
  });
  entries.sort((a, b) => a.at - b.at);
  return { header, entries };
}

export function loadRecording(path: string): Recording {
  return parseRecording(readFileSync(path, "utf8"));
}

/** Meeting seconds of the last recorded message. */
export function recordingDuration(rec: Recording): number {
  return rec.entries.length ? rec.entries[rec.entries.length - 1].at / 1000 : 0;
}

export interface ReplaySttOptions {
  clock: Clock;
  log?: (msg: string) => void;
  segmentation?: AssemblerOptions;
}

/**
 * Plays a recording as an SttSession: each message is handed to the assembler at its recorded time
 * after start(). Audio sent to it is ignored. Emits `done` after the last message (and the flush).
 */
export class ReplayStt extends EventEmitter implements SttSession {
  private readonly assembler: DeepgramAssembler;
  private timers: TimerHandle[] = [];
  private st: SttStatus = { state: "idle", text: "Speech-to-text: replay" };
  private running = false;

  constructor(
    private readonly rec: Recording,
    private readonly o: ReplaySttOptions,
  ) {
    super();
    this.assembler = new DeepgramAssembler(o.segmentation);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setStatus({ state: "open", text: `Speech-to-text: replay (${this.rec.header.model} · ${this.rec.header.language})` });
    const t0 = this.o.clock.now();
    const out = {
      final: (seg: SttSegment) => this.emit("final", seg),
      interim: (seg: SttSegment) => this.emit("interim", seg),
      log: this.o.log ?? (() => {}),
    };
    for (const e of this.rec.entries) {
      if (e.msg === undefined) continue;
      const raw = typeof e.msg === "string" ? e.msg : JSON.stringify(e.msg);
      this.timers.push(this.o.clock.setTimeout(() => handleDeepgramMessage(this.assembler, raw, e.offset ?? 0, out), Math.max(0, t0 + e.at - this.o.clock.now())));
    }
    const end = recordingDuration(this.rec) * 1000;
    this.timers.push(
      this.o.clock.setTimeout(() => {
        this.flush();
        this.emit("done");
      }, end + 1),
    );
  }

  send(): void {}

  async stop(): Promise<void> {
    if (!this.running) return;
    for (const t of this.timers) this.o.clock.clearTimeout(t);
    this.timers = [];
    this.flush();
    this.setStatus({ state: "closed", text: "Speech-to-text: stopped" });
  }

  status(): SttStatus {
    return this.st;
  }

  private flush(): void {
    if (!this.running) return;
    const seg = this.assembler.flush();
    if (seg) this.emit("final", seg);
    this.running = false;
  }

  private setStatus(s: SttStatus): void {
    this.st = s;
    this.emit("status", s);
  }
}
