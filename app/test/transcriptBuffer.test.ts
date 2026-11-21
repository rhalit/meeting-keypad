import { describe, expect, it } from "vitest";
import { TranscriptBuffer } from "../src/pipeline/transcriptBuffer.js";

describe("TranscriptBuffer", () => {
  const make = () => {
    const b = new TranscriptBuffer();
    for (const t of [0, 10, 20, 30, 40]) b.add({ t, speaker: "A", text: `at ${t}` });
    return b;
  };

  it("getLast(seconds) returns lines measured back from the latest line", () => {
    expect(make().getLast(15).map((l) => l.t)).toEqual([30, 40]);
    expect(make().getLast(100).map((l) => l.t)).toEqual([0, 10, 20, 30, 40]);
  });

  it("getLast accepts an explicit now", () => {
    expect(make().getLast(10, 25).map((l) => l.t)).toEqual([20]);
  });

  it("is empty after clear and when nothing was added", () => {
    const b = make();
    b.clear();
    expect(b.getLast(60)).toEqual([]);
    expect(b.all()).toEqual([]);
  });

  it("stores only t, speaker and text", () => {
    const b = new TranscriptBuffer();
    b.add({ t: 1, speaker: "A", text: "x", terms: ["y"] } as never);
    expect(b.all()).toEqual([{ t: 1, speaker: "A", text: "x" }]);
  });
});
