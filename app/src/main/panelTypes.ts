import type { AudioStatus } from "../pipeline/audioCapture.js";
import type { AwayReason, FocusState } from "../pipeline/focus.js";
import type { GazeStatus } from "../pipeline/gazeSource.js";
import type { PlaybackState } from "../pipeline/mockSource.js";
import type { KeyState } from "../pipeline/protocol.js";
import type { SttStatus } from "../pipeline/stt.js";
import type { SpotterStatus } from "../pipeline/termSpotter.js";

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

export type PanelMode = "mock" | "live";

export interface PanelLive {
  listening: boolean;
  /** Meeting seconds since Start listening (frozen after Stop). */
  position: number;
  audio: AudioStatus;
  stt: SttStatus;
  /** Keyterms of the current / last session. */
  keyterms: string[];
  /** The "meeting topic / keyterms" field. */
  keytermsText: string;
  /** Set when Deepgram is not configured (Start is refused). */
  configAdvice?: string;
  /** Live term spotter (LLM_SPOTTER_MODEL). */
  spotter: SpotterStatus;
  /** Spotted terms, added to the keyterms at the next Start listening. */
  learnedKeyterms: string[];
}

/** Camera focus (Logi Gaze Tracker). */
export interface PanelFocus {
  state: FocusState;
  reason?: AwayReason;
  /** How long the current state has lasted. */
  forMs: number;
  simulated: boolean;
  camera: GazeStatus;
  /** Set while Catch-up shows "Missed …": the missed span, e.g. "2 min 10 s". */
  missed?: string;
  mentionFlashing: boolean;
}

export interface PanelSnapshot {
  mode: PanelMode;
  playback: PlaybackState;
  live: PanelLive;
  llm: PanelLlm;
  pluginsConnected: number;
  keys: PanelKey[];
  queued: string[];
  focus: PanelFocus;
  /** Last meeting export. */
  export: PanelExport;
}

export interface PanelExport {
  state: "idle" | "busy" | "ok" | "error";
  text: string;
}

export interface PanelLine {
  t: number;
  speaker?: string;
  text: string;
  terms: string[];
}

/** Live, not yet final; `null` clears it. */
export interface PanelInterim {
  t: number;
  speaker?: string;
  text: string;
}

export type PanelCommand =
  | "play"
  | "pause"
  | "restart"
  | "speed1"
  | "speed2"
  | "mode-mock"
  | "mode-live"
  /** arg: the keyterms text */
  | "listen-start"
  | "listen-stop"
  /** arg: the keyterms text (remembered while typing) */
  | "keyterms"
  /** arg: "on" | "off" */
  | "sim-away"
  /** Pretend the mention detector heard your name now. */
  | "sim-mention"
  /** Ask the Gaze Tracker for its 9-point calibration. */
  | "gaze-calibrate"
  /** Write output/meetings/<date>.md and show it in Finder */
  | "export";
