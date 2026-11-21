/** A spoken line; `t` is meeting time in seconds. */
export interface TranscriptLine {
  t: number;
  speaker: string;
  text: string;
}

export class TranscriptBuffer {
  private lines: TranscriptLine[] = [];

  add(line: TranscriptLine): void {
    this.lines.push({ t: line.t, speaker: line.speaker, text: line.text });
  }

  /** Lines from the last `seconds` seconds, measured back from `now` (default: the latest line). */
  getLast(seconds: number, now?: number): TranscriptLine[] {
    if (this.lines.length === 0) return [];
    const end = now ?? this.lines[this.lines.length - 1].t;
    const from = end - seconds;
    return this.lines.filter((l) => l.t >= from && l.t <= end);
  }

  all(): TranscriptLine[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }
}
