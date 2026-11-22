import { beforeEach, describe, expect, it } from "vitest";
import { FocusTracker, type AwayPeriod, type FocusSample, type FocusStatus } from "../src/pipeline/focus.js";
import { FakeClock } from "./fakeClock.js";

const LOOKING: FocusSample = { present: true, onScreen: true };
const OFF_SCREEN: FocusSample = { present: true, onScreen: false };
const NO_FACE: FocusSample = { present: false, onScreen: null };
const FACE_ONLY: FocusSample = { present: true, onScreen: null };

describe("FocusTracker", () => {
  let clock: FakeClock;
  let meeting: number;
  let focus: FocusTracker;
  let changes: FocusStatus[];
  let backs: AwayPeriod[];

  /** Feed one sample every 200 ms (5 Hz, like the gaze client) for `ms`; meeting time follows. */
  function feed(s: FocusSample, ms: number): void {
    for (let t = 0; t < ms; t += 200) {
      focus.sample(s);
      clock.advance(200);
      meeting += 0.2;
    }
  }

  beforeEach(() => {
    clock = new FakeClock();
    meeting = 100;
    focus = new FocusTracker({ clock, meetingTime: () => meeting });
    changes = [];
    backs = [];
    focus.on("change", (s: FocusStatus) => changes.push(s));
    focus.on("back", (p: AwayPeriod) => backs.push(p));
  });

  it("is off until the first sample, then focused", () => {
    expect(focus.status().state).toBe("off");
    feed(LOOKING, 200);
    expect(focus.status().state).toBe("focused");
    expect(focus.isAway()).toBe(false);
  });

  it("a glance away (under 2.5 s) does not count", () => {
    feed(LOOKING, 1000);
    feed(OFF_SCREEN, 2000);
    feed(LOOKING, 2000);
    expect(changes.map((c) => c.state)).toEqual(["focused"]);
    expect(backs).toEqual([]);
  });

  it("looking away ~3 s -> away (off-screen), backdated to when you looked away", () => {
    feed(LOOKING, 1000);
    const lookedAwayAt = clock.now();
    feed(OFF_SCREEN, 3500);
    const s = focus.status();
    expect(s).toMatchObject({ state: "away", reason: "off-screen", simulated: false });
    // majority over 5 samples flips after 3 away samples (400 ms in)
    expect(s.since - lookedAwayAt).toBeLessThanOrEqual(600);
  });

  it("no face -> away with reason no-face; a face without gaze (uncalibrated) counts as focused", () => {
    feed(FACE_ONLY, 1000);
    feed(FACE_ONLY, 3000);
    expect(focus.status().state).toBe("focused");
    feed(NO_FACE, 3500);
    expect(focus.status()).toMatchObject({ state: "away", reason: "no-face" });
  });

  it("back reports the away period in meeting seconds", () => {
    feed(LOOKING, 1000); // meeting 100 -> 101
    feed(NO_FACE, 20_000); // away from ~101.4
    feed(LOOKING, 2000);
    expect(focus.status().state).toBe("focused");
    expect(backs).toHaveLength(1);
    expect(backs[0].from).toBeGreaterThan(101);
    expect(backs[0].from).toBeLessThan(102);
    expect(backs[0].to).toBeGreaterThan(121);
    expect(backs[0].ms).toBeGreaterThan(19_000);
  });

  it("single noisy samples do not flip the state either way", () => {
    feed(LOOKING, 1000);
    for (let i = 0; i < 30; i++) feed(i % 4 === 0 ? OFF_SCREEN : LOOKING, 200);
    expect(focus.status().state).toBe("focused");
    feed(OFF_SCREEN, 4000);
    for (let i = 0; i < 30; i++) feed(i % 4 === 0 ? LOOKING : OFF_SCREEN, 200);
    expect(focus.status().state).toBe("away");
    expect(backs).toEqual([]);
  });

  it("camera lost while away: state off, no back event (nothing is known)", () => {
    feed(LOOKING, 1000);
    feed(NO_FACE, 4000);
    focus.setCameraLive(false);
    expect(focus.status().state).toBe("off");
    expect(backs).toEqual([]);
  });

  it("simulated away works without a camera and reports back on release", () => {
    focus.setSimulatedAway(true);
    expect(focus.status()).toMatchObject({ state: "away", reason: "simulated", simulated: true });
    clock.advance(30_000);
    meeting += 30;
    focus.setSimulatedAway(false);
    expect(focus.status().state).toBe("off");
    expect(backs).toEqual([{ from: 100, to: 130, ms: 30_000 }]);
  });

  it("simulated away overrides a focused camera", () => {
    feed(LOOKING, 1000);
    focus.setSimulatedAway(true);
    feed(LOOKING, 1000);
    expect(focus.isAway()).toBe(true);
    focus.setSimulatedAway(false);
    expect(focus.status().state).toBe("focused");
    expect(backs).toHaveLength(1);
  });

  it("restartPeriod: an away period in progress starts again at the new meeting's time", () => {
    focus.setSimulatedAway(true);
    meeting = 0;
    focus.restartPeriod();
    meeting = 40;
    focus.setSimulatedAway(false);
    expect(backs[0]).toMatchObject({ from: 0, to: 40 });
  });

  it("comes back on two good frames in a row, even when most frames have no face", () => {
    feed(LOOKING, 1000);
    feed(NO_FACE, 4000);
    expect(focus.status().state).toBe("away");
    // Detection drops 3 of 4 frames, then catches the face twice in a row.
    feed(NO_FACE, 600);
    focus.sample(LOOKING);
    clock.advance(200);
    focus.sample(LOOKING);
    expect(focus.status().state).toBe("focused");
    expect(backs).toHaveLength(1);
  });

  it("a single good frame between misses does not bring you back", () => {
    feed(LOOKING, 1000);
    feed(NO_FACE, 4000);
    for (let i = 0; i < 20; i++) feed(i % 2 === 0 ? LOOKING : NO_FACE, 200);
    expect(focus.status().state).toBe("away");
  });
});
