// Control panel. Plain browser script (no imports): shapes mirror src/main/panelTypes.ts.

interface PanelKey {
  slot: number;
  label: string;
  sub?: string;
  color?: string;
  state: string;
  term?: string;
}
interface PanelPlayback {
  playing: boolean;
  speed: 1 | 2;
  position: number;
  duration: number;
  ended: boolean;
}
interface PanelLlmMsg {
  state: "checking" | "ok" | "error";
  text: string;
  advice?: string;
}
interface PanelStatusMsg {
  state: string;
  text: string;
  advice?: string;
}
interface PanelLiveMsg {
  listening: boolean;
  position: number;
  audio: PanelStatusMsg;
  stt: PanelStatusMsg;
  keyterms: string[];
  keytermsText: string;
  configAdvice?: string;
  spotter: PanelStatusMsg;
  learnedKeyterms: string[];
}
interface PanelSnapshotMsg {
  mode: "mock" | "live";
  playback: PanelPlayback;
  live: PanelLiveMsg;
  llm: PanelLlmMsg;
  pluginsConnected: number;
  keys: PanelKey[];
  queued: string[];
  export: { state: "idle" | "busy" | "ok" | "error"; text: string };
}
interface PanelLineMsg {
  t: number;
  speaker?: string;
  text: string;
  terms: string[];
}
interface PanelInterimMsg {
  t: number;
  speaker?: string;
  text: string;
}
interface KeypadApi {
  init(): Promise<{ snapshot: PanelSnapshotMsg; lines: PanelLineMsg[]; listener: string }>;
  control(cmd: string, arg?: string): void;
  on(channel: "snapshot" | "line" | "reset" | "interim" | "level", cb: (payload: any) => void): void;
}
interface Window {
  keypad: KeypadApi;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const playBtn = $<HTMLButtonElement>("play");
const restartBtn = $<HTMLButtonElement>("restart");
const speed1Btn = $<HTMLButtonElement>("speed1");
const speed2Btn = $<HTMLButtonElement>("speed2");
const timeEl = $("time");
const pluginEl = $("plugin");
const llmEl = $("llm");
const llmErrorEl = $("llm-error");
const gridEl = $("grid");
const queueEl = $("queue");
const transcriptEl = $("transcript");
const modeMockBtn = $<HTMLButtonElement>("mode-mock");
const modeLiveBtn = $<HTMLButtonElement>("mode-live");
const mockControls = $("mock-controls");
const liveControls = $("live-controls");
const listenBtn = $<HTMLButtonElement>("listen");
const keytermsEl = $<HTMLInputElement>("keyterms");
const meterFill = $("meter-fill");
const audioText = $("audio-text");
const sttText = $("stt-text");
const liveError = $("live-error");
const spotterText = $("spotter-text");
const learnedEl = $("learned");
const exportBtn = $<HTMLButtonElement>("export");
const exportText = $("export-text");

let playing = false;
let mode: "mock" | "live" = "mock";
let listening = false;
let keytermsTouched = false;
let lastLoudAt = 0;
let audioState = "stopped";
let audioStatusText = "Audio: off";
let interimEl: HTMLElement | null = null;

const AUDIO_OK = ["running", "silent"];
const LOUD_DB = -50;

function renderAudioText(): void {
  const receiving = listening && Date.now() - lastLoudAt < 1500;
  if (receiving && AUDIO_OK.includes(audioState)) {
    audioText.textContent = "Receiving audio";
    audioText.className = "ok";
    return;
  }
  audioText.textContent = audioState === "running" ? "Audio: capturing, silence" : audioStatusText;
  audioText.className =
    audioState === "running" || audioState === "stopped" || audioState === "starting"
      ? ""
      : audioState === "missing" || audioState === "error"
        ? "err"
        : "warn";
}

function renderLive(s: PanelSnapshotMsg): void {
  const l = s.live;
  listening = l.listening;
  listenBtn.textContent = listening ? "Stop listening" : "Start listening";
  listenBtn.classList.toggle("stop", listening);
  listenBtn.disabled = !listening && !!l.configAdvice;
  keytermsEl.disabled = listening;
  if (!keytermsTouched && document.activeElement !== keytermsEl) keytermsEl.value = l.keytermsText;
  audioState = l.audio.state;
  audioStatusText = l.audio.text;
  renderAudioText();
  sttText.textContent = l.configAdvice ? "Speech-to-text: not configured" : l.stt.text;
  sttText.className = l.configAdvice || l.stt.state === "error" ? "err" : l.stt.state === "open" ? "ok" : listening ? "wait" : "";
  const advice = l.configAdvice ?? l.stt.advice ?? (listening || l.audio.state === "missing" ? l.audio.advice : undefined);
  liveError.hidden = !advice;
  liveError.textContent = advice ?? "";
  spotterText.textContent = l.spotter.text;
  spotterText.className = l.spotter.state === "error" ? "err" : l.spotter.state === "backoff" ? "warn" : l.spotter.state === "ok" ? "ok" : "";
  spotterText.title = l.spotter.advice ?? "";
  learnedEl.hidden = l.learnedKeyterms.length === 0;
  learnedEl.textContent = `Learned keyterms (used at next Start): ${l.learnedKeyterms.join(", ")}`;
  if (!listening) meterFill.style.width = "0";
}

function renderSnapshot(s: PanelSnapshotMsg): void {
  mode = s.mode;
  modeMockBtn.classList.toggle("active", mode === "mock");
  modeLiveBtn.classList.toggle("active", mode === "live");
  mockControls.hidden = mode !== "mock";
  liveControls.hidden = mode !== "live";
  renderLive(s);
  playing = s.playback.playing;
  playBtn.textContent = playing ? "Pause" : s.playback.ended ? "Play again" : "Play";
  speed1Btn.classList.toggle("active", s.playback.speed === 1);
  speed2Btn.classList.toggle("active", s.playback.speed === 2);
  timeEl.textContent =
    mode === "live" ? `${fmt(s.live.position)}${listening ? " · listening" : ""}` : `${fmt(s.playback.position)} / ${fmt(s.playback.duration)}`;
  pluginEl.textContent = s.pluginsConnected > 0 ? "Keypad connected" : "Keypad not connected";
  pluginEl.classList.toggle("ok", s.pluginsConnected > 0);
  llmEl.textContent = s.llm.text;
  llmEl.className = `llm-${s.llm.state}`;
  llmErrorEl.hidden = s.llm.state !== "error" || !s.llm.advice;
  llmErrorEl.textContent = s.llm.advice ?? "";

  gridEl.replaceChildren(
    ...s.keys.map((k) => {
      const key = document.createElement("div");
      key.className = `key state-${k.state}`;
      // In alert, `color` is the background (it pulses between two reds) and the label is white.
      if (k.state === "alert") key.style.background = k.color ?? "#e5484d";
      else if (k.color && k.state !== "empty") key.style.setProperty("--accent-key", k.color);
      key.title = k.term ? `${k.term} (${k.state})` : `slot ${k.slot} (${k.state})`;
      const cat = document.createElement("div");
      cat.className = "cat";
      cat.textContent = k.state === "empty" ? "" : (k.sub ?? "");
      const label = document.createElement("div");
      label.className = `label${k.sub ? "" : " plain"}`;
      label.textContent = k.label;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = k.state === "empty" ? `${k.slot}` : `${k.slot} · ${k.state}`;
      key.append(cat);
      key.append(label, meta);
      return key;
    }),
  );
  queueEl.textContent = s.queued.length ? `Queued: ${s.queued.join(", ")}` : "";
  exportText.textContent = s.export.text;
  exportText.className = s.export.state === "ok" ? "ok" : s.export.state === "error" ? "err" : s.export.state === "busy" ? "wait" : "";
  exportBtn.disabled = s.export.state === "busy";
}

/** Appends text to `parent`, wrapping the first mention of each term in <mark>. */
function appendHighlighted(parent: HTMLElement, text: string, terms: string[]): void {
  type Span = { start: number; end: number };
  const spans: Span[] = [];
  for (const term of terms) {
    const i = text.toLowerCase().indexOf(term.toLowerCase());
    if (i >= 0) spans.push({ start: i, end: i + term.length });
  }
  spans.sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const sp of spans) {
    if (sp.start < pos) continue;
    parent.append(text.slice(pos, sp.start));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(sp.start, sp.end);
    parent.append(mark);
    pos = sp.end;
  }
  parent.append(text.slice(pos));
}

function lineRow(l: { t: number; speaker?: string; text: string }, terms: string[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "line";
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = fmt(l.t);
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = l.speaker ?? "";
  const text = document.createElement("span");
  text.className = "text";
  appendHighlighted(text, l.text, terms);
  row.append(time, who, text);
  return row;
}

function keepScrolled(fn: () => void): void {
  const atBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  fn();
  if (atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addLine(l: PanelLineMsg): void {
  keepScrolled(() => {
    const row = lineRow(l, l.terms);
    if (interimEl) transcriptEl.insertBefore(row, interimEl);
    else transcriptEl.append(row);
  });
}

/** Live text that is not final yet: one grey row at the bottom, replaced each time. */
function setInterim(i: PanelInterimMsg | null): void {
  keepScrolled(() => {
    if (!i) {
      interimEl?.remove();
      interimEl = null;
      return;
    }
    const row = lineRow(i, []);
    row.classList.add("interim");
    if (interimEl) interimEl.replaceWith(row);
    else transcriptEl.append(row);
    interimEl = row;
  });
}

function setLevel(db: number): void {
  if (!listening) return;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meterFill.style.width = `${pct}%`;
  if (db > LOUD_DB) lastLoudAt = Date.now();
  renderAudioText();
}

playBtn.addEventListener("click", () => window.keypad.control(playing ? "pause" : "play"));
modeMockBtn.addEventListener("click", () => window.keypad.control("mode-mock"));
modeLiveBtn.addEventListener("click", () => window.keypad.control("mode-live"));
listenBtn.addEventListener("click", () => {
  if (listening) window.keypad.control("listen-stop");
  else window.keypad.control("listen-start", keytermsEl.value);
});
keytermsEl.addEventListener("input", () => {
  keytermsTouched = true;
  window.keypad.control("keyterms", keytermsEl.value);
});
keytermsEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !listening) window.keypad.control("listen-start", keytermsEl.value);
});
restartBtn.addEventListener("click", () => window.keypad.control("restart"));
exportBtn.addEventListener("click", () => window.keypad.control("export"));
speed1Btn.addEventListener("click", () => window.keypad.control("speed1"));
speed2Btn.addEventListener("click", () => window.keypad.control("speed2"));

window.keypad.on("snapshot", renderSnapshot);
window.keypad.on("line", addLine);
window.keypad.on("reset", () => {
  interimEl = null;
  transcriptEl.replaceChildren();
});
window.keypad.on("interim", setInterim);
window.keypad.on("level", setLevel);
setInterval(renderAudioText, 500); // "Receiving audio" fades back when the level drops

void window.keypad.init().then(({ snapshot, lines }) => {
  renderSnapshot(snapshot);
  lines.forEach(addLine);
});
