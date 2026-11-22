import { EventEmitter } from "node:events";
import type { AudioInput, AudioStatus } from "./audioCapture.js";
import type { Clock } from "./clock.js";
import { BYTES_PER_SECOND, type SttFactory, type SttSegment, type SttSession, type SttStatus } from "./stt.js";

/** A final utterance, same shape as a mock meeting line (no terms until Phase 3b). */
export interface LiveLine {
  /** Meeting seconds at which the utterance started. */
  t: number;
  speaker?: string;
  text: string;
  terms: string[];
  /** Meeting seconds of the last word (latency measurements). */
  end?: number;
}

/** Not-yet-final text for the control panel only. */
export interface LiveInterim {
  t: number;
  speaker?: string;
  text: string;
}

export interface LiveState {
  listening: boolean;
  /** Meeting time in seconds (frozen after Stop). */
  position: number;
  audio: AudioStatus;
  stt: SttStatus;
  keyterms: string[];
}

export interface LiveSourceOptions {
  clock: Clock;
  audio: AudioInput;
  stt: SttFactory;
  log: (msg: string) => void;
}

/**
 * Live meeting audio → transcript. Same events as MockSource where they overlap:
 * `restart` (a new meeting starts: clear transcript and keys), `line` (LiveLine, finals only),
 * `state` (LiveState), `end` (Stop). Plus `interim` (LiveInterim | null to clear) and `level`
 * (dBFS). Meeting time 0 is the moment Start was pressed. No `term` events yet (Phase 3b).
 */
export class LiveSource extends EventEmitter {
  private listening = false;
  private startedAt = 0;
  private frozen = 0;
  private stt: SttSession | null = null;
  private keyterms: string[] = [];
  /** Session audio seconds sent to STT so far. */
  private audioS = 0;
  /** (audio seconds, meeting seconds) pairs; a new one whenever capture had a gap. */
  private anchors: { a: number; m: number }[] = [];
  private session = 0;
  private sttStatus: SttStatus = { state: "idle", text: "Speech-to-text: idle" };
  private readonly onPcm = (pcm: Buffer) => this.pcm(pcm);
  private readonly onLevel = (db: number) => this.emit("level", db);
  private readonly onAudioStatus = (s: AudioStatus) => {
    this.o.log(`[audio] ${s.text}`);
    this.emitState();
  };

  constructor(private readonly o: LiveSourceOptions) {
    super();
    o.audio.on("pcm", this.onPcm);
    o.audio.on("level", this.onLevel);
    o.audio.on("status", this.onAudioStatus);
  }

  position(): number {
    return this.listening ? (this.o.clock.now() - this.startedAt) / 1000 : this.frozen;
  }

  state(): LiveState {
    return {
      listening: this.listening,
      position: this.position(),
      audio: this.o.audio.status(),
      stt: this.sttStatus,
      keyterms: this.keyterms,
    };
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Starts a new meeting at 0:00. */
  start(keyterms: string[]): void {
    if (this.listening) return;
    const id = ++this.session;
    this.keyterms = keyterms;
    this.audioS = 0;
    this.anchors = [];
    this.frozen = 0;
    this.emit("restart");
    this.listening = true;
    this.startedAt = this.o.clock.now();

    const stt = this.o.stt({ keyterms });
    this.stt = stt;
    stt.on("interim", (seg: SttSegment) => {
      if (id === this.session) this.emit("interim", { t: this.meetingAt(seg.start), speaker: seg.speaker, text: seg.text });
    });
    stt.on("final", (seg: SttSegment) => {
      if (id !== this.session) return;
      const line: LiveLine = { t: this.meetingAt(seg.start), speaker: seg.speaker, text: seg.text, terms: [], end: this.meetingAt(seg.end) };
      this.emit("interim", null);
      this.emit("line", line);
    });
    stt.on("status", (s: SttStatus) => {
      if (id !== this.session) return;
      this.sttStatus = s;
      this.o.log(`[stt] ${s.text}`);
      this.emitState();
    });
    this.sttStatus = stt.status();
    stt.start();
    this.o.audio.start();
    this.emitState();
  }

  /** Ends the meeting; the last words still arrive as lines. Transcript stays for Catch-up/Save. */
  async stop(): Promise<void> {
    if (!this.listening) return;
    this.frozen = this.position();
    this.listening = false;
    this.emitState();
    const stt = this.stt;
    await this.o.audio.stop();
    await stt?.stop();
    stt?.removeAllListeners();
    if (this.stt === stt) this.stt = null;
    this.emit("interim", null);
    this.emitState();
    this.emit("end");
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.o.audio.off("pcm", this.onPcm);
    this.o.audio.off("level", this.onLevel);
    this.o.audio.off("status", this.onAudioStatus);
    this.removeAllListeners();
  }

  private pcm(pcm: Buffer): void {
    if (!this.listening || !this.stt) return;
    const dur = pcm.length / BYTES_PER_SECOND;
    // The chunk arrives when its last sample was captured, so it began `dur` earlier.
    const actualStart = Math.max(0, this.position() - dur);
    if (this.anchors.length === 0 || Math.abs(this.meetingAtRaw(this.audioS) - actualStart) > 1) {
      this.anchors.push({ a: this.audioS, m: actualStart });
    }
    this.audioS += dur;
    this.stt.send(pcm);
  }

  private meetingAtRaw(a: number): number {
    let anchor = this.anchors[0];
    if (!anchor) return a;
    for (const x of this.anchors) {
      if (x.a <= a) anchor = x;
      else break;
    }
    return anchor.m + (a - anchor.a);
  }

  /** Session audio seconds → meeting seconds, 0.1 s resolution. */
  private meetingAt(a: number): number {
    return Math.round(Math.max(0, this.meetingAtRaw(a)) * 10) / 10;
  }

  private emitState(): void {
    this.emit("state", this.state());
  }
}
