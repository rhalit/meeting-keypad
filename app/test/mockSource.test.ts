import { beforeEach, describe, expect, it } from "vitest";
import { MockSource } from "../src/pipeline/mockSource.js";
import type { Glossary, MeetingLine } from "../src/pipeline/mockData.js";
import type { TermCandidate } from "../src/pipeline/terms.js";
import { FakeClock } from "./fakeClock.js";

const S = 1000;
const LINES: MeetingLine[] = [
  { t: 0, speaker: "A", text: "hi", terms: [] },
  { t: 10, speaker: "B", text: "LoRA and RAG", terms: ["LoRA", "RAG"] },
  { t: 20, speaker: "A", text: "Mystery", terms: ["mystery"] },
  { t: 30, speaker: "B", text: "bye", terms: [] },
];
const GLOSSARY = {
  LoRA: { full: "", explanation: "", example: "", category: "Tech" },
  RAG: { full: "", explanation: "", example: "", category: "Tech" },
} as Glossary;

describe("MockSource", () => {
  let clock: FakeClock;
  let src: MockSource;
  let lines: number[];
  let terms: TermCandidate[];

  beforeEach(() => {
    clock = new FakeClock();
    src = new MockSource(LINES, GLOSSARY, clock);
    lines = [];
    terms = [];
    src.on("line", (l: MeetingLine) => lines.push(l.t));
    src.on("term", (c: TermCandidate) => terms.push(c));
  });

  it("emits nothing until play", () => {
    clock.advance(60 * S);
    expect(lines).toEqual([]);
  });

  it("plays lines on time at 1x and emits a TermCandidate per term", () => {
    src.play();
    expect(lines).toEqual([0]);
    clock.advance(10 * S - 1);
    expect(lines).toEqual([0]);
    clock.advance(1);
    expect(lines).toEqual([0, 10]);
    // "LoRA and RAG": LoRA is word 1 (said at once), RAG word 3 (two words later at the mock pace, 0.33 s each).
    expect(terms).toEqual([{ term: "LoRA", category: "Tech", source: "mock" }]);
    clock.advance(660);
    expect(terms).toEqual([
      { term: "LoRA", category: "Tech", source: "mock" },
      { term: "RAG", category: "Tech", source: "mock" },
    ]);
  });

  it("emits each line with its word times: recorded ones, or an even pace that ends before the next line", () => {
    const seen: number[][] = [];
    src.on("line", (l: { wordTimes: number[] }) => seen.push(l.wordTimes));
    src.play();
    clock.advance(10 * S);
    expect(seen[1]).toEqual([10, 10.33, 10.66]);
    const rec = new MockSource([{ t: 2, speaker: "CEO", text: "Quick sync now", terms: [], wordStarts: [2, 2.5, 3.1] }], {}, new FakeClock());
    const got: number[][] = [];
    rec.on("line", (l: { wordTimes: number[] }) => got.push(l.wordTimes));
    rec.play();
    expect(got).toEqual([]); // not yet at 2 s
  });

  it("emits line before its terms, and unknownTerm for glossary misses", () => {
    const order: string[] = [];
    src.on("line", (l: MeetingLine) => order.push(`line ${l.t}`));
    src.on("term", (c: TermCandidate) => order.push(`term ${c.term}`));
    src.on("unknownTerm", (t: string) => order.push(`unknown ${t}`));
    src.play();
    clock.advance(20 * S);
    expect(order).toEqual(["line 0", "line 10", "term LoRA", "term RAG", "line 20", "unknown mystery"]);
  });

  it("plays twice as fast at 2x", () => {
    src.setSpeed(2);
    src.play();
    clock.advance(5 * S);
    expect(lines).toEqual([0, 10]);
    clock.advance(10 * S);
    expect(lines).toEqual([0, 10, 20, 30]);
  });

  it("changing speed mid-line keeps the meeting position", () => {
    src.play();
    clock.advance(4 * S); // position 4
    src.setSpeed(2);
    expect(src.position()).toBeCloseTo(4);
    clock.advance(3 * S - 1); // position 9.998
    expect(lines).toEqual([0]);
    clock.advance(1);
    expect(lines).toEqual([0, 10]);
  });

  it("pause keeps the position and resume continues from it", () => {
    src.play();
    clock.advance(7 * S);
    src.pause();
    expect(src.position()).toBeCloseTo(7);
    clock.advance(60 * S);
    expect(lines).toEqual([0]);
    src.play();
    clock.advance(3 * S);
    expect(lines).toEqual([0, 10]);
  });

  it("restart goes back to 0, emits restart and plays again", () => {
    let restarts = 0;
    src.on("restart", () => restarts++);
    src.play();
    clock.advance(15 * S);
    src.restart();
    expect(restarts).toBe(1);
    expect(src.position()).toBe(0);
    expect(lines).toEqual([0, 10, 0]);
    clock.advance(10 * S);
    expect(lines).toEqual([0, 10, 0, 10]);
  });

  it("stops at the end and emits end; play after the end restarts", () => {
    let ended = 0;
    src.on("end", () => ended++);
    src.play();
    clock.advance(31 * S);
    expect(ended).toBe(1);
    expect(src.state()).toMatchObject({ playing: false, ended: true, position: 30, duration: 30 });
    src.play();
    expect(src.state().playing).toBe(true);
    expect(lines.at(-1)).toBe(0);
  });

  it("with an end time (video scenario) keeps playing after the last line, then ends", () => {
    const clock2 = new FakeClock();
    const src = new MockSource([{ t: 1, speaker: "CEO", text: "Quick sync.", terms: [] }], {}, clock2, 5);
    let ended = 0;
    src.on("end", () => ended++);
    expect(src.duration()).toBe(5);
    src.play();
    clock2.advance(2000);
    expect(src.state()).toMatchObject({ playing: true, ended: false });
    src.pause();
    src.play(); // paused in the tail: resumes, does not restart
    expect(src.position()).toBeCloseTo(2, 1);
    clock2.advance(3100);
    expect(ended).toBe(1);
    expect(src.state()).toMatchObject({ playing: false, ended: true, position: 5 });
  });
});
