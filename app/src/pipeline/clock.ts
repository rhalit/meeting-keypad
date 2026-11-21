// Injectable clock so timing logic can be tested without sleeping (see test/fakeClock.ts).

export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds, monotonic enough for our purposes. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
