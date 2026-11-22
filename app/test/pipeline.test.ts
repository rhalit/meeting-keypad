import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGlossary, loadMeeting } from "../src/pipeline/mockData.js";
import { MockSource, type Speed } from "../src/pipeline/mockSource.js";
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

// FIFO conveyor: every term enters on slot 0 the moment it is spoken; the others move along.
const EXPECTED: [number, number, string][] = [
  [12, 0, "RAG"],
  [24, 0, "Vector database"],
  [41, 0, "p95 latency"],
  [58, 0, "Quantization"],
  [73, 0, "LoRA"],
  [90, 0, "Feature flag"],
  [108, 0, "Canary release"],
  [124, 0, "Autoscaling"],
  [139, 0, "Cold start"],
  [146, 0, "SOC 2"],
  [172, 0, "Pen test"],
  [198, 0, "CAC"],
  [205, 0, "Churn"],
  [230, 0, "Runway"],
  [258, 0, "Burn multiple"],
];

describe("mock meeting through the pipeline (no presses)", () => {
  it.each([1, 2] as Speed[])("puts every term on slot 0 the moment it is spoken at %ix", (speed) => {
    const { placed, queued, layout } = play(speed);
    expect(placed).toEqual(EXPECTED);
    expect(queued).toEqual([]);
    expect(layout).toEqual(["Burn multiple", "Runway", "Churn", "CAC", "Pen test", "SOC 2"]);
  });
});
