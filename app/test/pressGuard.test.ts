import { describe, expect, it } from "vitest";
import { PressDebouncer } from "../src/pipeline/pressGuard.js";
import { FakeClock } from "./fakeClock.js";

describe("PressDebouncer", () => {
  it("ignores a repeat of the same slot within 300 ms, with the reason", () => {
    const clock = new FakeClock();
    const d = new PressDebouncer(clock);
    expect(d.check(6)).toEqual({ ok: true });
    clock.advance(120);
    expect(d.check(6)).toEqual({ ok: false, reason: "repeat within 300 ms (120 ms after the previous press)" });
  });

  it("accepts the same slot again once 300 ms have passed", () => {
    const clock = new FakeClock();
    const d = new PressDebouncer(clock);
    d.check(6);
    clock.advance(300);
    expect(d.check(6).ok).toBe(true);
  });

  it("a continuous burst stays ignored until the key is quiet for 300 ms", () => {
    const clock = new FakeClock();
    const d = new PressDebouncer(clock);
    const accepted: number[] = [];
    for (let i = 0; i < 20; i++) {
      if (d.check(6).ok) accepted.push(i);
      clock.advance(100); // bouncing every 100 ms
    }
    expect(accepted).toEqual([0]);
    clock.advance(300);
    expect(d.check(6).ok).toBe(true);
  });

  it("slots are independent", () => {
    const clock = new FakeClock();
    const d = new PressDebouncer(clock);
    expect(d.check(0).ok).toBe(true);
    expect(d.check(1).ok).toBe(true);
    clock.advance(50);
    expect(d.check(0).ok).toBe(false);
    expect(d.check(2).ok).toBe(true);
  });

  it("reset() forgets earlier presses", () => {
    const clock = new FakeClock();
    const d = new PressDebouncer(clock);
    d.check(7);
    d.reset();
    expect(d.check(7).ok).toBe(true);
  });
});
