import type { Category } from "./protocol.js";
import { normalizeTerm } from "./terms.js";

/** A term that reached a key; `t` = meeting seconds when it was placed. */
export interface RecordedTerm {
  term: string;
  category: Category;
  t: number;
  opened: boolean;
}

/** Speaking rate used when a line has no word timings (mock lines). */
const WORDS_PER_S = 2.5;

/**
 * What the export needs that no other part keeps: when the meeting started (wall clock), how long people
 * spoke, and every term that reached a key in order, with whether it was opened. One instance for the app;
 * reset() starts a new meeting (and a new `id`, so each meeting gets its own export file).
 */
export class MeetingRecord {
  id = 1;
  startedAt: Date | null = null;
  spokenS = 0;
  private list: RecordedTerm[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** A final line. The first one fixes the start time (its wall time minus its meeting time). */
  addLine(line: { t: number; text: string; end?: number }): void {
    if (this.startedAt === null) this.startedAt = new Date(this.now().getTime() - Math.max(0, line.t) * 1000);
    const words = line.text.split(/\s+/).filter(Boolean).length;
    this.spokenS += line.end !== undefined && line.end > line.t ? line.end - line.t : words / WORDS_PER_S;
  }

  placed(term: string, category: Category, t: number): void {
    const key = normalizeTerm(term);
    if (this.list.some((r) => normalizeTerm(r.term) === key)) return;
    this.list.push({ term, category, t, opened: false });
  }

  opened(term: string): void {
    const key = normalizeTerm(term);
    const r = this.list.find((x) => normalizeTerm(x.term) === key);
    if (r) r.opened = true;
  }

  terms(): RecordedTerm[] {
    return this.list.map((r) => ({ ...r }));
  }

  reset(): void {
    this.id++;
    this.startedAt = null;
    this.spokenS = 0;
    this.list = [];
  }
}
