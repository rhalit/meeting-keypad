// Speech -> key delay per live term, from Deepgram word timestamps. All times are meeting seconds.

import { normalizeTerm } from "./terms.js";

export interface TermLatency {
  term: string;
  /** End of the last heard word (word timestamps); undefined without timings. */
  spokenAt?: number;
  /** The line holding the term became final. */
  finalAt?: number;
  /** The spotter accepted the term. */
  spottedAt: number;
  /** The term reached a key. */
  placedAt: number;
  /** placedAt - spokenAt. */
  total?: number;
}

const f1 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "?" : x.toFixed(1));

/**
 * Collects, per term, when it was spoken, when its line became final, when the spotter accepted it
 * and when it reached a key. placed() returns the finished record (or null for a term the spotter never
 * reported, e.g. a mock term).
 */
export class LatencyTracker {
  private spotted = new Map<string, { term: string; spokenAt?: number; finalAt?: number; spottedAt: number }>();
  readonly records: TermLatency[] = [];

  spot(term: string, at: number, spokenAt?: number, finalAt?: number): void {
    const key = normalizeTerm(term);
    if (key && !this.spotted.has(key)) this.spotted.set(key, { term, spokenAt, finalAt, spottedAt: at });
  }

  placed(term: string, at: number): TermLatency | null {
    const key = normalizeTerm(term);
    const s = this.spotted.get(key);
    if (!s) return null;
    this.spotted.delete(key);
    const r: TermLatency = { ...s, placedAt: at, total: s.spokenAt !== undefined ? at - s.spokenAt : undefined };
    this.records.push(r);
    return r;
  }

  reset(): void {
    this.spotted.clear();
    this.records.length = 0;
  }
}

/** `latency "NSDR": spoken 41.2 s -> key 47.9 s = 6.7 s (final +1.1, spot +5.0, queue +0.6)` */
export function formatLatency(r: TermLatency): string {
  const final = r.finalAt !== undefined && r.spokenAt !== undefined ? r.finalAt - r.spokenAt : undefined;
  const spot = r.finalAt !== undefined ? r.spottedAt - r.finalAt : undefined;
  return (
    `latency "${r.term}": spoken ${f1(r.spokenAt)} s -> key ${f1(r.placedAt)} s = ${f1(r.total)} s ` +
    `(final +${f1(final)}, spot +${f1(spot)}, queue +${f1(r.placedAt - r.spottedAt)})`
  );
}
