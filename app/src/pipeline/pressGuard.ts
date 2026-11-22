// Key debounce: a keypad bumped in a bag, or a bouncing key, sends bursts of presses.

import type { Clock } from "./clock.js";

export type DebounceResult = { ok: true } | { ok: false; reason: string };

/**
 * Ignores a press of the same slot within `windowMs` (300 ms) of that slot's previous press.
 * The window counts from the previous press even if it was ignored, so a continuous burst stays
 * ignored until the key has been quiet for 300 ms. Other slots are independent.
 */
export class PressDebouncer {
  private lastAt = new Map<number, number>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs = 300,
  ) {}

  check(slot: number): DebounceResult {
    const now = this.clock.now();
    const prev = this.lastAt.get(slot);
    this.lastAt.set(slot, now);
    if (prev !== undefined && now - prev < this.windowMs) {
      return { ok: false, reason: `repeat within ${this.windowMs} ms (${now - prev} ms after the previous press)` };
    }
    return { ok: true };
  }

  reset(): void {
    this.lastAt.clear();
  }
}
