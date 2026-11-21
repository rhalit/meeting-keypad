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
      if (k.state === "new") placed.push([((clock.now() - start) / 1000) * speed, k.slot, k.label.replace("\n", " ")]);
    }
  });
  source.setSpeed(speed);
  source.play();
  clock.advance((310 * 1000) / speed);
  return { placed, queued: slots.queued() };
}

const EXPECTED: [number, number, string][] = [
  [12, 0, "RAG"],
  [24, 1, "Vector DB"],
  [41, 2, "p95 latency"],
  [58, 3, "Quanti- zation"],
  [73, 4, "LoRA"],
  [90, 5, "Feature flag"],
  [108, 0, "Canary release"],
  [124, 1, "Auto- scaling"],
  [139, 2, "Cold start"],
  [146, 3, "SOC 2"],
  [172, 4, "Pen test"],
  [198, 5, "CAC"],
  [205, 0, "Churn"],
  [230, 1, "Runway"],
  [258, 2, "Burn multiple"],
];

describe("mock meeting through the pipeline (no presses)", () => {
  it.each([1, 2] as Speed[])("puts every term on a key the moment it is spoken at %ix", (speed) => {
    const { placed, queued } = play(speed);
    expect(placed).toEqual(EXPECTED);
    expect(queued).toEqual([]);
  });
});
