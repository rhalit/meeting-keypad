// Client for the Logi Gaze Tracker app (https://logitech.github.io/hackathons/logi-gaze-tracker/):
// a local WebSocket server at ws://127.0.0.1:8964 that streams JSON snapshots
//   { type: "snapshot", timestamp_ms, screen: {width_px, height_px}, gaze: {x_px, y_px, source} | null,
//     face: { bounding_box_norm: {x, y, width, height} }, state: { model_calibrated, ... } }
// Gaze is in screen pixels and can fall outside the screen when you look away.

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Clock, TimerHandle } from "./clock.js";
import type { FocusSample } from "./focus.js";

export const DEFAULT_GAZE_URL = "ws://127.0.0.1:8964";

export type GazeState = "off" | "connecting" | "no-tracker" | "no-data" | "uncalibrated" | "tracking";

export interface GazeStatus {
  state: GazeState;
  /** Short text for the panel. */
  text: string;
  advice?: string;
}

export const TRACKER_ADVICE =
  "Start the Logi Gaze Tracker app (menu bar) and pick the MX Brio in its Setup tab. " +
  "Install: https://github.com/Logitech/hackathons/releases/tag/logi-gaze-tracker (see README, \"Camera focus\").";
export const CALIBRATE_ADVICE =
  "The camera sees your face but cannot tell where you look, so only \"left the desk\" is detected. " +
  "Press Calibrate gaze (or tray icon → Start Calibration) and look at the 9 points.";

export interface ParsedSnapshot {
  timestampMs: number | null;
  sample: FocusSample;
  /** Gaze is available (calibrated, or baseline mode). */
  hasGaze: boolean;
  calibrated: boolean;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * One snapshot -> focus sample. Off-screen = the gaze point is more than `marginFrac` of the screen
 * outside it (gaze is noisy near the edges). Non-snapshot messages give null.
 */
export function parseSnapshot(msg: unknown, marginFrac = 0.1): ParsedSnapshot | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, any>;
  if (m.type !== "snapshot") return null;
  const box = m.face?.bounding_box_norm;
  const hasFace = !!box && num(box.width) && num(box.height) && box.width > 0 && box.height > 0;
  const g = m.gaze;
  const w = m.screen?.width_px;
  const h = m.screen?.height_px;
  const hasGaze = !!g && num(g.x_px) && num(g.y_px);
  let onScreen: boolean | null = null;
  if (hasGaze && num(w) && num(h) && w > 0 && h > 0) {
    const mx = w * marginFrac;
    const my = h * marginFrac;
    onScreen = g.x_px >= -mx && g.x_px <= w + mx && g.y_px >= -my && g.y_px <= h + my;
  }
  const st = m.state ?? {};
  return {
    timestampMs: num(m.timestamp_ms) ? m.timestamp_ms : null,
    sample: { present: hasFace || hasGaze, onScreen },
    hasGaze,
    calibrated: !!(st.model_calibrated || st.geometric_calibrated),
  };
}

type SocketLike = Pick<WebSocket, "on" | "send" | "close" | "terminate" | "readyState">;

export interface GazeClientOptions {
  url?: string;
  clock: Clock;
  log: (msg: string) => void;
  /** Reconnect delay while the tracker is unreachable. */
  retryMs?: number;
  /** Snapshot interval asked from the tracker. */
  intervalMs?: number;
  /** No new snapshot this long -> "no-data" (camera stopped, tracker paused). */
  staleMs?: number;
  connect?: (url: string) => SocketLike;
}

/**
 * Events: `sample` (FocusSample, new frames only), `status` (GazeStatus), `live` (boolean: samples
 * are flowing). Reconnects every 2 s; logs only state changes, so a missing tracker is not noisy.
 */
export class GazeClient extends EventEmitter {
  private readonly o: Required<GazeClientOptions>;
  private ws: SocketLike | null = null;
  private wanted = false;
  private st: GazeStatus = { state: "off", text: "Camera: off" };
  private live = false;
  private lastTs: number | null = null;
  private retryTimer: TimerHandle | null = null;
  private staleTimer: TimerHandle | null = null;

  constructor(opts: GazeClientOptions) {
    super();
    this.o = {
      url: DEFAULT_GAZE_URL,
      retryMs: 2000,
      intervalMs: 200,
      staleMs: 3000,
      connect: (url) => new WebSocket(url),
      ...opts,
    };
  }

  status(): GazeStatus {
    return this.st;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.setStatus({ state: "connecting", text: "Camera: connecting to Gaze Tracker…" });
    this.open();
  }

  stop(): void {
    this.wanted = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
    this.setLive(false);
    this.setStatus({ state: "off", text: "Camera: off" });
  }

  /** Ask the tracker to run its fullscreen 9-point calibration. False if not connected. */
  calibrate(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "start_calibration", pose: "center", append: false }));
    this.o.log("asked the Gaze Tracker to calibrate");
    return true;
  }

  private open(): void {
    let ws: SocketLike;
    try {
      ws = this.o.connect(this.o.url);
    } catch (err) {
      this.onClosed(null, (err as Error).message);
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.o.log(`connected to Gaze Tracker at ${this.o.url}`);
      this.lastTs = null;
      ws.send(JSON.stringify({ type: "start_stream", interval_ms: this.o.intervalMs }));
      this.setStatus({ state: "no-data", text: "Camera: Gaze Tracker connected, waiting for frames" });
      this.armStale();
    });
    ws.on("message", (data: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    ws.on("error", () => {}); // "close" follows; ECONNREFUSED just means the tracker is not running
    ws.on("close", () => this.onClosed(ws));
  }

  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; message?: string };
    if (m?.type === "error") {
      this.o.log(`Gaze Tracker error: ${m.message ?? "?"}`);
      return;
    }
    const p = parseSnapshot(msg);
    if (!p) return;
    if (p.timestampMs !== null && p.timestampMs === this.lastTs) return; // same frame re-sent
    this.lastTs = p.timestampMs;
    this.armStale();
    this.setLive(true);
    if (p.hasGaze) this.setStatus({ state: "tracking", text: "Camera: tracking your gaze" });
    else if (!p.calibrated) this.setStatus({ state: "uncalibrated", text: "Camera: not calibrated (presence only)", advice: CALIBRATE_ADVICE });
    else if (this.st.state !== "tracking") this.setStatus({ state: "tracking", text: "Camera: tracking your gaze" });
    this.emit("sample", p.sample);
  }

  private onClosed(ws: SocketLike | null, err?: string): void {
    if (ws && this.ws !== ws) return;
    this.ws = null;
    this.clearStale();
    this.setLive(false);
    if (!this.wanted) return;
    if (this.st.state !== "no-tracker") {
      this.o.log(`Gaze Tracker not reachable at ${this.o.url}${err ? ` (${err})` : ""}; retrying every ${this.o.retryMs / 1000} s`);
    }
    this.setStatus({ state: "no-tracker", text: "Camera: Gaze Tracker not running", advice: TRACKER_ADVICE });
    this.retryTimer = this.o.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, this.o.retryMs);
  }

  private armStale(): void {
    this.clearStale();
    this.staleTimer = this.o.clock.setTimeout(() => {
      this.staleTimer = null;
      this.setLive(false);
      this.setStatus({
        state: "no-data",
        text: "Camera: no frames from Gaze Tracker",
        advice: "Is tracking on in the Gaze Tracker, and is the camera picked in its Setup tab?",
      });
    }, this.o.staleMs);
  }

  private setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    this.emit("live", live);
  }

  private clearStale(): void {
    if (this.staleTimer !== null) this.o.clock.clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  private clearTimers(): void {
    this.clearStale();
    if (this.retryTimer !== null) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(s: GazeStatus): void {
    if (s.state === this.st.state && s.text === this.st.text && s.advice === this.st.advice) return;
    if (s.state !== this.st.state && s.state !== "no-tracker" && s.state !== "connecting") this.o.log(s.text);
    this.st = s;
    this.emit("status", s);
  }
}
