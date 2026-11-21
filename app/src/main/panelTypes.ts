import type { PlaybackState } from "../pipeline/mockSource.js";
import type { KeyState } from "../pipeline/protocol.js";

// Messages between main and the control panel. src/renderer/panel.ts mirrors these shapes
// (it is a plain browser script and cannot import).

export interface PanelKey extends KeyState {
  /** Full term on a term slot. */
  term?: string;
}

export interface PanelSnapshot {
  playback: PlaybackState;
  pluginsConnected: number;
  keys: PanelKey[];
  queued: string[];
}

export interface PanelLine {
  t: number;
  speaker: string;
  text: string;
  terms: string[];
}

export type PanelCommand = "play" | "pause" | "restart" | "speed1" | "speed2";
