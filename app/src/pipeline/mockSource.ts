import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import { glossaryCandidate, type Glossary, type MeetingLine } from "./mockData.js";

export type Speed = 1 | 2;

/** Seconds per word when a line has no recorded word times (a natural speaking pace). */
export const WORD_S = 0.33;

/** A line as emitted: with the start time of every word, for the word-by-word transcript. */
export interface PlayedLine extends MeetingLine {
  wordTimes: number[];
}

const tokens = (text: string) => text.split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");

/** Start of each word: the line's recorded `words`, else an even pace that ends before the next line. */
export function wordTimes(line: MeetingLine, nextT: number | null): number[] {
  const n = tokens(line.text).length;
  if (line.wordStarts && line.wordStarts.length === n) return [...line.wordStarts];
  const room = nextT === null ? n * WORD_S : Math.max(0.3, nextT - line.t - 0.3);
  const step = Math.min(WORD_S, room / Math.max(1, n));
  return Array.from({ length: n }, (_, i) => Math.round((line.t + i * step) * 100) / 100);
}

/** When a term is said in its line: the start of the word where it begins (the line start if not found). */
export function termTime(line: MeetingLine, times: number[], term: string): number {
  const first = norm(term.split(/\s+/)[0] ?? "");
  const words = tokens(line.text).map(norm);
  const i = first ? words.findIndex((w) => w === first || w.startsWith(first)) : -1;
  return i >= 0 && times[i] !== undefined ? Math.max(line.t, times[i]) : line.t;
}

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
 * Events: `line` (PlayedLine: the line plus each word's start time) at the line's start; `term` (TermCandidate,
 * source "mock") for each entry in its `terms` when that word is spoken; `unknownTerm` (string) for a term
 * missing from the glossary, `state` (PlaybackState), `restart`, `end`.
 */
export class MockSource extends EventEmitter {
  private lines: MeetingLine[];
  private playing = false;
  private speed: Speed = 1;
  private pos = 0; // meeting seconds at `anchor`
  private anchor = 0; // clock ms when playback (re)started at `pos`
  private next = 0; // index of the next line to emit
  private timer: TimerHandle | null = null;
  /** Terms of lines already said, waiting for their word (sorted by time). */
  private pendingTerms: { t: number; term: string }[] = [];
  /** Playback runs until here even after the last line (a video scenario: the video's length). */
  private endAt: number | null;

  constructor(
    lines: MeetingLine[],
    private glossary: Glossary,
    private readonly clock: Clock,
    endAt?: number,
  ) {
    super();
    this.lines = [...lines].sort((a, b) => a.t - b.t);
    this.endAt = endAt ?? null;
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
      ended: this.atEnd(),
    };
  }

  duration(): number {
    const last = this.lines.length ? this.lines[this.lines.length - 1].t : 0;
    return Math.max(last, this.endAt ?? 0);
  }

  /** Every line said and the end time reached. */
  private atEnd(): boolean {
    return this.next >= this.lines.length && this.pendingTerms.length === 0 && this.position() >= this.duration() - 1e-3;
  }

  play(): void {
    if (this.playing) return;
    if (this.atEnd()) {
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

  /** Another meeting (Meeting / Education mode, scenario): rewinds to 0, paused. Emits `state`. */
  load(lines: MeetingLine[], glossary: Glossary, endAt?: number): void {
    this.lines = [...lines].sort((a, b) => a.t - b.t);
    this.glossary = glossary;
    this.endAt = endAt ?? null;
    this.rewind();
  }

  /** Back to 0, paused (switching to Live). Emits `state`, not `restart`. */
  rewind(): void {
    this.clearTimer();
    this.playing = false;
    this.pos = 0;
    this.next = 0;
    this.pendingTerms = [];
    this.emitState();
  }

  /** Back to 0 and play. */
  restart(): void {
    this.clearTimer();
    this.playing = false;
    this.pos = 0;
    this.next = 0;
    this.pendingTerms = [];
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
    if (this.next >= this.lines.length && this.pendingTerms.length === 0) {
      // A video scenario keeps playing after its last line until the video ends.
      const left = ((this.duration() - this.position()) * 1000) / this.speed;
      if (left > 1) {
        this.timer = this.clock.setTimeout(() => {
          this.timer = null;
          this.schedule();
        }, Math.round(left));
        return;
      }
      this.pos = this.duration();
      this.playing = false;
      this.emitState();
      this.emit("end");
      return;
    }
    const dueIn = ((this.nextDue() - this.position()) * 1000) / this.speed;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, Math.max(0, Math.round(dueIn)));
  }

  /** Lines and terms that are due, in time order (a line before the terms it contains). */
  private fireDue(): void {
    const now = this.position() + 1e-6;
    for (;;) {
      const lineT = this.next < this.lines.length ? this.lines[this.next].t : Infinity;
      const termT = this.pendingTerms.length ? this.pendingTerms[0].t : Infinity;
      if (Math.min(lineT, termT) > now) return;
      if (lineT <= termT) {
        const line = this.lines[this.next++];
        const times = wordTimes(line, this.next < this.lines.length ? this.lines[this.next].t : null);
        this.emit("line", { ...line, wordTimes: times } satisfies PlayedLine);
        for (const term of line.terms) this.pendingTerms.push({ t: termTime(line, times, term), term });
        this.pendingTerms.sort((a, b) => a.t - b.t);
      } else {
        const { term } = this.pendingTerms.shift()!;
        const c = glossaryCandidate(this.glossary, term);
        if (c) this.emit("term", c);
        else this.emit("unknownTerm", term);
      }
    }
  }

  /** Meeting second of the next line or term, or Infinity. */
  private nextDue(): number {
    const lineT = this.next < this.lines.length ? this.lines[this.next].t : Infinity;
    return Math.min(lineT, this.pendingTerms.length ? this.pendingTerms[0].t : Infinity);
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
