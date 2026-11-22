import { EventEmitter } from "node:events";
import type { Clock } from "./clock.js";

// Are you looking at the meeting? Turns camera samples (Logi Gaze Tracker, see gazeSource.ts) into
// "focused" / "away", and reports each away period in meeting time so Catch-up can cover it.

/** One camera reading. `onScreen` is null when the camera sees a face but has no gaze (uncalibrated). */
export interface FocusSample {
  present: boolean;
  onScreen: boolean | null;
}

/** "off" = no camera data (tracker not running), so nothing is known. */
export type FocusState = "off" | "focused" | "away";
export type AwayReason = "no-face" | "off-screen" | "simulated";

export interface FocusStatus {
  state: FocusState;
  reason?: AwayReason;
  /** Clock ms when this state began (away: backdated to when you actually looked away). */
  since: number;
  simulated: boolean;
}

/** An away period. `from` / `to` are meeting seconds; `ms` is how long you were away on the clock. */
export interface AwayPeriod {
  from: number;
  to: number;
  ms: number;
}

export interface FocusTrackerOptions {
  clock: Clock;
  /** Current meeting time in seconds. */
  meetingTime: () => number;
  /** Looking away this long counts as away (a glance at a note does not). */
  awayAfterMs?: number;
  /** Looking back this long counts as back. */
  backAfterMs?: number;
  /** Majority vote over the last N samples (gaze is noisy). */
  smoothSamples?: number;
}

/**
 * Events: `change` (FocusStatus), `away` (FocusStatus), `back` (AwayPeriod).
 * `back` is not emitted when the camera stops while you are away (nothing is known then).
 * "Simulate away" (panel) forces away without a camera, for demos and testing.
 */
export class FocusTracker extends EventEmitter {
  private readonly clock: Clock;
  private readonly meetingTime: () => number;
  private readonly awayAfterMs: number;
  private readonly backAfterMs: number;
  private readonly smoothSamples: number;

  private camera: FocusState = "off";
  private cameraReason: AwayReason | undefined;
  private cameraSince = 0;
  private recent: { away: boolean; reason: AwayReason }[] = [];
  /** Smoothed raw reading and when it last flipped (clock ms + meeting s). */
  private raw: { away: boolean; at: number; meeting: number } | null = null;
  private simulated = false;
  private status_: FocusStatus;
  private awayStart: { at: number; meeting: number } | null = null;

  constructor(opts: FocusTrackerOptions) {
    super();
    this.clock = opts.clock;
    this.meetingTime = opts.meetingTime;
    this.awayAfterMs = opts.awayAfterMs ?? 2500;
    this.backAfterMs = opts.backAfterMs ?? 800;
    this.smoothSamples = opts.smoothSamples ?? 5;
    this.status_ = { state: "off", since: this.clock.now(), simulated: false };
  }

  status(): FocusStatus {
    return { ...this.status_ };
  }

  isAway(): boolean {
    return this.status_.state === "away";
  }

  sample(s: FocusSample): void {
    const now = this.clock.now();
    const away = !s.present || s.onScreen === false;
    this.recent.push({ away, reason: s.present ? "off-screen" : "no-face" });
    if (this.recent.length > this.smoothSamples) this.recent.shift();
    const awayVotes = this.recent.filter((r) => r.away);
    const smoothed = awayVotes.length * 2 > this.recent.length;
    if (!this.raw || this.raw.away !== smoothed) this.raw = { away: smoothed, at: now, meeting: this.meetingTime() };
    if (smoothed) this.cameraReason = awayVotes[awayVotes.length - 1].reason;

    if (this.camera === "off") this.setCamera("focused", now);
    if (this.camera === "focused" && this.raw.away && now - this.raw.at >= this.awayAfterMs) {
      this.setCamera("away", this.raw.at, this.raw.meeting);
    } else if (this.camera === "away" && !this.raw.away && now - this.raw.at >= this.backAfterMs) {
      this.setCamera("focused", now);
    } else {
      this.update(); // reason may have changed (off-screen <-> no face)
    }
  }

  /** The camera source stopped (false) or (re)started (true). */
  setCameraLive(live: boolean): void {
    if (live || this.camera === "off") return;
    this.recent = [];
    this.raw = null;
    this.cameraReason = undefined;
    this.setCamera("off", this.clock.now(), undefined, true);
  }

  setSimulatedAway(on: boolean): void {
    if (this.simulated === on) return;
    this.simulated = on;
    this.update();
  }

  isSimulated(): boolean {
    return this.simulated;
  }

  /** New meeting: an away period in progress starts again now (old meeting times mean nothing). */
  restartPeriod(): void {
    if (this.awayStart) this.awayStart = { at: this.clock.now(), meeting: this.meetingTime() };
  }

  private setCamera(state: FocusState, at: number, meeting?: number, lost = false): void {
    this.camera = state;
    this.cameraSince = at;
    this.update(meeting, lost);
  }

  private update(awayMeeting?: number, cameraLost = false): void {
    const now = this.clock.now();
    const prev = this.status_;
    let next: FocusStatus;
    if (this.simulated) {
      next = { state: "away", reason: "simulated", since: prev.state === "away" ? prev.since : now, simulated: true };
    } else if (this.camera === "away") {
      next = { state: "away", reason: this.cameraReason, since: prev.state === "away" ? prev.since : this.cameraSince, simulated: false };
    } else {
      next = { state: this.camera, since: prev.state === this.camera ? prev.since : now, simulated: false };
    }
    if (next.state === prev.state && next.reason === prev.reason && next.simulated === prev.simulated) return;
    this.status_ = next;

    if (prev.state !== "away" && next.state === "away") {
      const backdated = !this.simulated && awayMeeting !== undefined;
      this.awayStart = { at: backdated ? next.since : now, meeting: backdated ? awayMeeting : this.meetingTime() };
      this.emit("change", this.status());
      this.emit("away", this.status());
      return;
    }
    if (prev.state === "away" && next.state !== "away") {
      const start = this.awayStart;
      this.awayStart = null;
      this.emit("change", this.status());
      if (start && !cameraLost) {
        const to = this.meetingTime();
        this.emit("back", { from: Math.min(start.meeting, to), to, ms: now - start.at } satisfies AwayPeriod);
      }
      return;
    }
    this.emit("change", this.status());
  }
}
