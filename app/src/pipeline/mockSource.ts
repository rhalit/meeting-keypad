import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import { glossaryCandidate, type Glossary, type MeetingLine } from "./mockData.js";

export type Speed = 1 | 2;

export interface PlaybackState {
  playing: boolean;
  speed: Speed;
  /** Meeting time in seconds. */
  position: number;
  /** Meeting time of the last line. */
  duration: number;
  ended: boolean;
}

/**
 * Plays mock/meeting.json on a clock.
 * Events: `line` (MeetingLine), then `term` (TermCandidate, source "mock") for each entry in its
 * `terms`, `unknownTerm` (string) for a term missing from the glossary, `state` (PlaybackState),
 * `restart`, `end`.
 */
export class MockSource extends EventEmitter {
  private readonly lines: MeetingLine[];
  private playing = false;
  private speed: Speed = 1;
  private pos = 0; // meeting seconds at `anchor`
  private anchor = 0; // clock ms when playback (re)started at `pos`
  private next = 0; // index of the next line to emit
  private timer: TimerHandle | null = null;

  constructor(
    lines: MeetingLine[],
    private readonly glossary: Glossary,
    private readonly clock: Clock,
  ) {
    super();
    this.lines = [...lines].sort((a, b) => a.t - b.t);
  }

  position(): number {
    if (!this.playing) return this.pos;
    return this.pos + ((this.clock.now() - this.anchor) / 1000) * this.speed;
  }

  state(): PlaybackState {
    return {
      playing: this.playing,
      speed: this.speed,
      position: Math.min(this.position(), this.duration()),
      duration: this.duration(),
      ended: this.next >= this.lines.length,
    };
  }

  duration(): number {
    return this.lines.length ? this.lines[this.lines.length - 1].t : 0;
  }

  play(): void {
    if (this.playing) return;
    if (this.next >= this.lines.length) {
      this.restart();
      return;
    }
    this.playing = true;
    this.anchor = this.clock.now();
    this.emitState();
    this.schedule();
  }

  pause(): void {
    if (!this.playing) return;
    this.pos = this.position();
    this.playing = false;
    this.clearTimer();
    this.emitState();
  }

  /** Back to 0 and play. */
  restart(): void {
    this.clearTimer();
    this.playing = false;
    this.pos = 0;
    this.next = 0;
    this.emit("restart");
    this.play();
  }

  setSpeed(speed: Speed): void {
    if (speed === this.speed) return;
    this.pos = this.position();
    this.anchor = this.clock.now();
    this.speed = speed;
    this.emitState();
    if (this.playing) this.schedule();
  }

  dispose(): void {
    this.clearTimer();
    this.removeAllListeners();
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.playing) return;
    this.fireDue(); // lines due now (e.g. t = 0 on play) go out synchronously
    if (this.next >= this.lines.length) {
      this.pos = this.duration();
      this.playing = false;
      this.emitState();
      this.emit("end");
      return;
    }
    const dueIn = ((this.lines[this.next].t - this.position()) * 1000) / this.speed;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, Math.max(0, Math.round(dueIn)));
  }

  private fireDue(): void {
    const now = this.position() + 1e-6;
    while (this.next < this.lines.length && this.lines[this.next].t <= now) {
      const line = this.lines[this.next++];
      this.emit("line", line);
      for (const term of line.terms) {
        const c = glossaryCandidate(this.glossary, term);
        if (c) this.emit("term", c);
        else this.emit("unknownTerm", term);
      }
    }
  }

  private emitState(): void {
    this.emit("state", this.state());
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
