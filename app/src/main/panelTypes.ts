import type { PlaybackState } from "../pipeline/mockSource.js";
import type { KeyState } from "../pipeline/protocol.js";

// Messages between main and the control panel. src/renderer/panel.ts mirrors these shapes
// (it is a plain browser script and cannot import).

export interface PanelKey extends KeyState {
  /** Full term on a term slot. */
  term?: string;
}

/** Model connection as shown in the panel header. */
export interface PanelLlm {
  state: "checking" | "ok" | "error";
  /** Short status line, e.g. "Model ready · openai/gpt-oss-120b · 412 ms". */
  text: string;
  /** What to do, when state is "error". */
  advice?: string;
}

export interface PanelSnapshot {
  playback: PlaybackState;
  llm: PanelLlm;
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
