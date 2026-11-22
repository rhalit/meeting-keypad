// Control panel. Plain browser script (no imports): shapes mirror src/main/panelTypes.ts.

interface PanelKey {
  slot: number;
  label: string;
  sub?: string;
  color?: string;
  bg?: string;
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
interface PanelFocusMsg {
  state: "off" | "focused" | "away";
  reason?: "no-face" | "off-screen" | "simulated";
  forMs: number;
  simulated: boolean;
  camera: PanelStatusMsg;
  missed?: string;
  mentionFlashing: boolean;
}
interface PanelSnapshotMsg {
  usage: "meeting" | "education";
  settings: { theme: "dark" | "light"; keyBg: Partial<Record<"terms" | "6" | "7" | "8", string>> };
  scenarios: { id: string; title: string }[];
  scenario: string;
  mode: "mock" | "live";
  playback: PanelPlayback;
  live: PanelLiveMsg;
  llm: PanelLlmMsg;
  pluginsConnected: number;
  keys: PanelKey[];
  queued: string[];
  focus: PanelFocusMsg;
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
const usageMeetingBtn = $<HTMLButtonElement>("usage-meeting");
const usageEducationBtn = $<HTMLButtonElement>("usage-education");
const modeLiveBtn = $<HTMLButtonElement>("mode-live");
const mockControls = $("mock-controls");
const liveControls = $("live-controls");
const listenBtn = $<HTMLButtonElement>("listen");
const keytermsEl = $<HTMLInputElement>("keyterms");
const meterFill = $("meter-fill");
const audioText = $("audio-text");
const sttText = $("stt-text");
const liveError = $("live-error");
const cameraText = $("camera-text");
const focusPill = $("focus-pill");
const cameraError = $("camera-error");
const simAwayBtn = $<HTMLButtonElement>("sim-away");
const simMentionBtn = $<HTMLButtonElement>("sim-mention");
const calibrateBtn = $<HTMLButtonElement>("gaze-calibrate");
let simAway = false;
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

const AWAY_REASON: Record<string, string> = { "no-face": "no face", "off-screen": "looking away", simulated: "simulated" };

function renderFocus(f: PanelFocusMsg): void {
  const cam = f.camera;
  cameraText.textContent = cam.text;
  cameraText.className = cam.state === "tracking" ? "ok" : cam.state === "off" || cam.state === "connecting" ? "" : "warn";
  cameraError.hidden = !cam.advice;
  cameraError.textContent = cam.advice ?? "";
  calibrateBtn.disabled = cam.state === "off" || cam.state === "connecting" || cam.state === "no-tracker";
  const secs = fmt(f.forMs / 1000);
  focusPill.className = `pill ${f.state}`;
  focusPill.textContent =
    f.state === "away"
      ? `Away ${secs} · ${AWAY_REASON[f.reason ?? ""] ?? ""}${f.mentionFlashing ? " · mentioned!" : ""}`
      : f.state === "focused"
        ? `Focused${f.missed ? ` · missed ${f.missed}` : ""}`
        : `Focus: unknown${f.missed ? ` · missed ${f.missed}` : ""}`;
  simAway = f.simulated;
  simAwayBtn.textContent = simAway ? "Stop simulating away" : "Simulate away";
  simAwayBtn.classList.toggle("on", simAway);
}

/** Same rule as the plugin: relative luminance above 0.55 counts as a light background. */
function isLight(hex: string): boolean {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.55;
}

const settingsBtn = $<HTMLButtonElement>("settings-btn");
const settingsEl = $("settings");
const summaryEl = $("summary");
const themeDarkBtn = $<HTMLButtonElement>("theme-dark");
const themeLightBtn = $<HTMLButtonElement>("theme-light");
const bgResetBtn = $<HTMLButtonElement>("bg-reset");
const scenarioEl = $<HTMLSelectElement>("scenario");
let scenarioKey = "";
const BG_TARGETS = ["terms", "6", "7", "8"] as const;
const bgInputs = BG_TARGETS.map((t) => $<HTMLInputElement>(`bg-${t}`));
const BOTTOM_NAMES = {
  meeting: ["Catch-up", "Save", "For me?"],
  education: ["Flashcard", "Quiz me", "Explain simply"],
};
const POSITIONS = ["Bottom left", "Bottom middle", "Bottom right"];

function renderSettings(s: PanelSnapshotMsg): void {
  document.documentElement.dataset.theme = s.settings.theme;
  themeDarkBtn.classList.toggle("active", s.settings.theme === "dark");
  themeLightBtn.classList.toggle("active", s.settings.theme === "light");
  const current = s.scenarios.find((x) => x.id === s.scenario);
  summaryEl.textContent =
    `${s.mode === "live" ? "Live" : "Mock"} · ${s.usage === "education" ? "Education" : "Meeting"}` +
    (s.mode === "mock" && current ? ` · ${current.title}` : "");
  // Rebuild the list only when it changes (snapshots arrive twice a second while playing).
  const key = JSON.stringify([s.scenarios, s.scenario]);
  if (key !== scenarioKey) {
    scenarioKey = key;
    scenarioEl.replaceChildren(
      ...s.scenarios.map((x) => {
        const o = document.createElement("option");
        o.value = x.id;
        o.textContent = x.title;
        o.selected = x.id === s.scenario;
        return o;
      }),
    );
  }
  scenarioEl.disabled = s.mode === "live";
  scenarioEl.title = s.mode === "live" ? "Scenarios are mock content: switch Source to Mock" : "Mock content for this mode";
  BG_TARGETS.forEach((t, i) => {
    const input = bgInputs[i];
    if (document.activeElement !== input) input.value = (s.settings.keyBg[t] ?? "#000000").toLowerCase();
    if (i > 0) $(`bg-${t}-name`).textContent = `${POSITIONS[i - 1]} · ${BOTTOM_NAMES[s.usage][i - 1]}`;
  });
}

function renderSnapshot(s: PanelSnapshotMsg): void {
  renderSettings(s);
  mode = s.mode;
  modeMockBtn.classList.toggle("active", mode === "mock");
  usageMeetingBtn.classList.toggle("active", s.usage === "meeting");
  usageEducationBtn.classList.toggle("active", s.usage === "education");
  modeMockBtn.textContent = s.usage === "education" ? "Mock lecture" : "Mock meeting";
  modeLiveBtn.textContent = s.usage === "education" ? "Live lecture" : "Live meeting";
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
      // User background (Settings), drawn like the plugin: near-black text on a light one.
      if (k.bg && k.state !== "alert" && k.state !== "empty") {
        key.style.background = k.bg;
        key.style.borderColor = k.state === "new" ? "" : k.bg;
        if (isLight(k.bg)) {
          key.style.color = "#111111";
          if (!k.color) key.style.setProperty("--accent-key", "#111111");
        }
      }
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
  renderFocus(s.focus);
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
usageMeetingBtn.addEventListener("click", () => window.keypad.control("usage-meeting"));
settingsBtn.addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
  settingsBtn.classList.toggle("on", !settingsEl.hidden);
});
themeDarkBtn.addEventListener("click", () => window.keypad.control("theme-dark"));
themeLightBtn.addEventListener("click", () => window.keypad.control("theme-light"));
bgResetBtn.addEventListener("click", () => window.keypad.control("key-bg-reset"));
scenarioEl.addEventListener("change", () => window.keypad.control("scenario", scenarioEl.value));
// Colour pickers fire `input` continuously while dragging: send at most every 150 ms (the keypad redraws each time).
const bgTimers = new Map<string, number>();
BG_TARGETS.forEach((t, i) =>
  bgInputs[i].addEventListener("input", () => {
    clearTimeout(bgTimers.get(t));
    bgTimers.set(t, window.setTimeout(() => window.keypad.control("key-bg", `${t}=${bgInputs[i].value}`), 150));
  }),
);
usageEducationBtn.addEventListener("click", () => window.keypad.control("usage-education"));
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
simAwayBtn.addEventListener("click", () => window.keypad.control("sim-away", simAway ? "off" : "on"));
simMentionBtn.addEventListener("click", () => window.keypad.control("sim-mention"));
calibrateBtn.addEventListener("click", () => window.keypad.control("gaze-calibrate"));
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
