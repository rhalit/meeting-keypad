import { describe, expect, it } from "vitest";
import { LatencyTracker, formatLatency } from "../src/pipeline/latency.js";

describe("LatencyTracker", () => {
  it("joins spoken / final / spotted / placed times per term", () => {
    const l = new LatencyTracker();
    l.spot("NSDR", 46.2, 41.2, 42.3);
    const r = l.placed("nsdr", 47.9)!;
    expect(r).toMatchObject({ term: "NSDR", spokenAt: 41.2, finalAt: 42.3, spottedAt: 46.2, placedAt: 47.9 });
    expect(r.total).toBeCloseTo(6.7);
    expect(formatLatency(r)).toBe('latency "NSDR": spoken 41.2 s -> key 47.9 s = 6.7 s (final +1.1, spot +3.9, queue +1.7)');
    expect(l.records).toHaveLength(1);
  });

  it("ignores terms it never saw spotted (mock terms) and keeps unknown times as ?", () => {
    const l = new LatencyTracker();
    expect(l.placed("RAG", 10)).toBeNull();
    l.spot("RAG", 5);
    expect(formatLatency(l.placed("RAG", 6)!)).toBe('latency "RAG": spoken ? s -> key 6.0 s = ? s (final +?, spot +?, queue +1.0)');
    l.reset();
    expect(l.records).toEqual([]);
  });
});
