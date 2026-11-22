import { EventEmitter } from "node:events";
import type { AudioInput, AudioStatus } from "../src/pipeline/audioCapture.js";
import { BYTES_PER_SECOND, type SttFactory, type SttOptions, type SttSegment, type SttSession, type SttStatus } from "../src/pipeline/stt.js";

/** STT session the test drives: emitInterim / emitFinal. Records what was sent. */
export class FakeStt extends EventEmitter implements SttSession {
  started = false;
  stopped = false;
  bytes = 0;
  private st: SttStatus = { state: "idle", text: "Speech-to-text: idle" };

  constructor(readonly opts: SttOptions) {
    super();
  }

  /** Session audio seconds received so far. */
  get seconds(): number {
    return this.bytes / BYTES_PER_SECOND;
  }

  start(): void {
    this.started = true;
    this.setStatus({ state: "open", text: "Speech-to-text: fake" });
  }

  send(pcm: Buffer): void {
    this.bytes += pcm.length;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.setStatus({ state: "closed", text: "Speech-to-text: stopped" });
  }

  status(): SttStatus {
    return this.st;
  }

  emitInterim(seg: Partial<SttSegment> & { text: string }): void {
    this.emit("interim", { start: 0, end: 0, ...seg });
  }

  emitFinal(seg: Partial<SttSegment> & { text: string }): void {
    this.emit("final", { start: 0, end: 0, ...seg });
  }

  private setStatus(s: SttStatus): void {
    this.st = s;
    this.emit("status", s);
  }
}

/** Factory that keeps every session it made. */
export function fakeSttFactory(): { factory: SttFactory; sessions: FakeStt[]; last(): FakeStt } {
  const sessions: FakeStt[] = [];
  return {
    factory: (opts) => {
      const s = new FakeStt(opts);
      sessions.push(s);
      return s;
    },
    sessions,
    last: () => {
      const s = sessions[sessions.length - 1];
      if (!s) throw new Error("no STT session was created");
      return s;
    },
  };
}

/** Audio input the test drives: chunk(seconds) emits that much PCM (a quiet tone). */
export class FakeAudio extends EventEmitter implements AudioInput {
  running = false;
  private st: AudioStatus = { state: "stopped", text: "Audio: off" };

  start(): void {
    this.running = true;
    this.setStatus({ state: "running", text: "Audio: fake" });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.setStatus({ state: "stopped", text: "Audio: off" });
  }

  status(): AudioStatus {
    return this.st;
  }

  chunk(seconds: number, amplitude = 1000): Buffer {
    const n = Math.round(seconds * 16000);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
    if (this.running) this.emit("pcm", buf);
    return buf;
  }

  setStatus(s: AudioStatus): void {
    this.st = s;
    this.emit("status", s);
  }
}
