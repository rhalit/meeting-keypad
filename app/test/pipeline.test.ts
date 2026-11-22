import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGlossary, loadMeeting } from "../src/pipeline/mockData.js";
import { MockSource, termTime, wordTimes, type Speed } from "../src/pipeline/mockSource.js";
import { displayTerm } from "../src/pipeline/protocol.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { FakeClock } from "./fakeClock.js";

const MOCK = join(__dirname, "..", "..", "mock");

/** Plays the real mock meeting and records when each term lands on which key (meeting seconds). */
function play(speed: Speed) {
  const clock = new FakeClock();
  const start = clock.now();
  const source = new MockSource(loadMeeting(join(MOCK, "meeting.json"), "Test"), loadGlossary(join(MOCK, "glossary.json")), clock);
  const slots = new SlotManager({ clock });
  source.on("term", (c) => slots.add(c));
  const placed: [number, number, string][] = [];
  slots.on("change", (keys: KeyState[]) => {
    for (const k of keys) {
      // A shift re-sends moved keys that are still "new"; count each term once, where it entered.
      if (k.state === "new" && !placed.some((p) => p[2] === k.label)) placed.push([((clock.now() - start) / 1000) * speed, k.slot, k.label]);
    }
  });
  source.setSpeed(speed);
  source.play();
  clock.advance((310 * 1000) / speed);
  return { placed, queued: slots.queued(), layout: slots.getAll().slice(0, 6).map((k) => k.label) };
}

// FIFO conveyor: every term enters on slot 0 the moment its word is spoken (line start + its word's offset at
// the mock speaking pace); the others move along.
const MEETING = loadMeeting(join(MOCK, "meeting.json"), "Test");
const EXPECTED: [number, number, string][] = MEETING.flatMap((line, i) => {
  const times = wordTimes(line, MEETING[i + 1]?.t ?? null);
  return line.terms.map((term): [number, number, string] => [termTime(line, times, term), 0, displayTerm(term)]);
});

it("terms land a few words into their line, never before it", () => {
  const lineOf = (label: string) => MEETING.find((l) => l.terms.some((t) => displayTerm(t) === label))!;
  for (const [t, , label] of EXPECTED) {
    expect(t).toBeGreaterThanOrEqual(lineOf(label).t);
    expect(t - lineOf(label).t).toBeLessThan(8);
  }
  expect(EXPECTED.find((e) => e[2] === "RAG")![0]).toBeCloseTo(13.04, 2); // "...we'll ship RAG..." is word 4 of its line
});

describe("mock meeting through the pipeline (no presses)", () => {
  it.each([1, 2] as Speed[])("puts every term on slot 0 the moment it is spoken at %ix", (speed) => {
    const { placed, queued, layout } = play(speed);
    expect(placed.map(([t, s, l]) => [Math.round(t * 100) / 100, s, l])).toEqual(EXPECTED.map(([t, s, l]) => [Math.round(t * 100) / 100, s, l]));
    expect(queued).toEqual([]);
    expect(layout).toEqual(["Burn multiple", "Runway", "Churn", "CAC", "Pen test", "SOC 2"]);
  });
});
