// IntelliPad companion window. Plain browser script (no imports): shapes mirror src/main/panelTypes.ts.

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
const send = (cmd: string, arg?: string) => window.keypad.control(cmd, arg);

// --- elements ---------------------------------------------------------------------------------------

const stateDot = $("state-dot");
const summaryEl = $("summary");
const timeEl = $("time");
const mockTimeEl = $("mock-time");
const exportBtn = $<HTMLButtonElement>("export");
const settingsBtn = $<HTMLButtonElement>("settings-btn");
const settingsEl = $("settings");

const mockControls = $("mock-controls");
const playBtn = $<HTMLButtonElement>("play");
const restartBtn = $<HTMLButtonElement>("restart");
const progressFill = $("progress-fill");
const speed1Btn = $<HTMLButtonElement>("speed1");
const speed2Btn = $<HTMLButtonElement>("speed2");

const liveControls = $("live-controls");
const listenBtn = $<HTMLButtonElement>("listen");
const listenLabel = $("listen-label");
const keytermsEl = $<HTMLInputElement>("keyterms");
const meterFill = $("meter-fill");
const liveHint = $("live-hint");
const audioText = $("audio-text");
const learnedEl = $("learned");

const gridEl = $("grid");
const queueEl = $("queue");
const mentionNote = $("mention-note");
const missedNote = $("missed-note");
const llmErrorEl = $("llm-error");
const liveError = $("live-error");
const transcriptEl = $("transcript");
const emptyEl = $("empty");

const pluginEl = $("plugin");
const llmEl = $("llm");
const focusEl = $("focus-pill");
const exportText = $("export-text");

const modeMockBtn = $<HTMLButtonElement>("mode-mock");
const modeLiveBtn = $<HTMLButtonElement>("mode-live");
const usageMeetingBtn = $<HTMLButtonElement>("usage-meeting");
const usageEducationBtn = $<HTMLButtonElement>("usage-education");
const scenarioEl = $<HTMLSelectElement>("scenario");
const themeDarkBtn = $<HTMLButtonElement>("theme-dark");
const themeLightBtn = $<HTMLButtonElement>("theme-light");
const bgResetBtn = $<HTMLButtonElement>("bg-reset");
const cameraText = $("camera-text");
const cameraError = $("camera-error");
const calibrateBtn = $<HTMLButtonElement>("gaze-calibrate");
const simAwayBtn = $<HTMLButtonElement>("sim-away");
const simMentionBtn = $<HTMLButtonElement>("sim-mention");
const diagLlm = $("diag-llm");
const sttText = $("stt-text");
const spotterText = $("spotter-text");

const BG_TARGETS = ["terms", "6", "7", "8"] as const;
const bgInputs = BG_TARGETS.map((t) => $<HTMLInputElement>(`bg-${t}`));
const BOTTOM_NAMES = {
  meeting: ["Catch-up", "Save", "For me?"],
  education: ["Flashcard", "Quiz me", "Explain simply"],
};

// --- state ------------------------------------------------------------------------------------------

let snap: PanelSnapshotMsg | null = null;
let playing = false;
let mode: "mock" | "live" = "mock";
let listening = false;
let simAway = false;
let keytermsTouched = false;
let lastLoudAt = 0;
let audioState = "stopped";
let audioStatusText = "Audio off";
let interimEl: HTMLElement | null = null;
let scenarioKey = "";
/** The listener's name (mock/config.json), to mark the lines that address them. */
let listenerRe: RegExp | null = null;
/** The speaker block new lines are appended to (consecutive lines of one speaker share a header). */
let lastTurn: { el: HTMLElement; speaker: string } | null = null;

const AUDIO_OK = ["running", "silent"];
const LOUD_DB = -50;
const AWAY_REASON: Record<string, string> = { "no-face": "no face", "off-screen": "looking away", simulated: "simulated" };

// --- rendering --------------------------------------------------------------------------------------

/** Same rule as the plugin: relative luminance above 0.55 counts as a light background. */
function isLight(hex: string): boolean {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.55;
}

function setStatus(el: HTMLElement, text: string, cls: string, title?: string): void {
  if (el.textContent !== text) el.textContent = text;
  el.className = `status-item${cls ? ` ${cls}` : ""}`;
  if (title !== undefined) el.title = title;
}

function renderAudioText(): void {
  const receiving = listening && Date.now() - lastLoudAt < 1500;
  if (receiving && AUDIO_OK.includes(audioState)) {
    audioText.textContent = "Receiving audio";
    audioText.className = "ok";
    return;
  }
  audioText.textContent = audioState === "running" ? "Capturing · silence" : audioStatusText.replace(/^Audio: /, "Audio ");
  audioText.className =
    audioState === "running" || audioState === "stopped" || audioState === "starting" ? "" : audioState === "missing" || audioState === "error" ? "err" : "warn";
}

function renderToolbar(s: PanelSnapshotMsg): void {
  const current = s.scenarios.find((x) => x.id === s.scenario);
  const live = s.mode === "live";
  // The bar shows the app name; the session is in the tooltip and in the empty-state hint.
  summaryEl.title = `IntelliPad · ${live ? (listening ? "Listening" : "Live") : "Mock"} · ${s.usage === "education" ? "Education" : "Meeting"}${!live && current ? ` · ${current.title}` : ""}`;
  stateDot.className = `state-dot${live && listening ? " listening" : !live && playing ? " playing" : ""}`;
  // Live: elapsed time in the bar. Mock: position / length sits next to the progress bar instead.
  timeEl.hidden = !live;
  timeEl.textContent = fmt(s.live.position);
  mockTimeEl.textContent = `${fmt(s.playback.position)} / ${fmt(s.playback.duration)}`;
  exportBtn.disabled = s.export.state === "busy";
}

function renderTransport(s: PanelSnapshotMsg): void {
  mockControls.hidden = s.mode !== "mock";
  liveControls.hidden = s.mode !== "live";
  liveHint.hidden = s.mode !== "live";
  // Mock
  playBtn.classList.toggle("playing", playing);
  playBtn.title = playing ? "Pause (Space)" : s.playback.ended ? "Play again (Space)" : "Play (Space)";
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  const pct = s.playback.duration > 0 ? Math.min(100, (s.playback.position / s.playback.duration) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  speed1Btn.classList.toggle("active", s.playback.speed === 1);
  speed2Btn.classList.toggle("active", s.playback.speed === 2);
  // Live
  const l = s.live;
  listenBtn.classList.toggle("on", listening);
  listenLabel.textContent = listening ? "Stop" : "Listen";
  listenBtn.title = listening ? "Stop listening (Space)" : l.configAdvice ? "Speech-to-text is not configured" : "Start listening (Space)";
  listenBtn.disabled = !listening && !!l.configAdvice;
  keytermsEl.disabled = listening;
  if (!keytermsTouched && document.activeElement !== keytermsEl) keytermsEl.value = l.keytermsText;
  audioState = l.audio.state;
  audioStatusText = l.audio.text;
  renderAudioText();
  learnedEl.hidden = l.learnedKeyterms.length === 0;
  learnedEl.textContent = `Learned: ${l.learnedKeyterms.join(", ")}`;
  learnedEl.title = "Added to speech-to-text keyterms at the next start";
  if (!listening) meterFill.style.width = "0";
}

function renderKeys(s: PanelSnapshotMsg): void {
  gridEl.replaceChildren(
    ...s.keys.map((k) => {
      const key = document.createElement("div");
      key.className = `key state-${k.state}`;
      if (k.color && k.state !== "empty" && k.state !== "alert") key.style.setProperty("--cat", k.color);
      if (k.bg && k.state !== "alert" && k.state !== "empty") {
        key.style.background = k.bg;
        key.classList.add(isLight(k.bg) ? "custom-dark" : "custom-light");
      }
      key.title = k.term ? `${k.term}${k.sub ? ` · ${k.sub}` : ""}${k.state === "seen" ? " · opened" : ""}` : k.slot < 6 ? `Key ${k.slot + 1}: free` : k.label;
      if (k.state !== "empty") {
        if (k.sub) {
          const cat = document.createElement("div");
          cat.className = "cat";
          cat.textContent = k.sub;
          key.append(cat);
        }
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = k.label;
        // Bottom-row keys without a category may carry a label colour (Saved ✓, Missed 2m).
        if (!k.sub && k.color && k.state !== "alert") label.style.color = k.color;
        key.append(label);
      }
      return key;
    }),
  );
  queueEl.textContent = s.queued.length ? `Up next: ${s.queued.join(", ")}` : "";
}

function renderNotices(s: PanelSnapshotMsg): void {
  const f = s.focus;
  mentionNote.hidden = !f.mentionFlashing;
  mentionNote.textContent = "A question for you · look back or press any key";
  const summaryKey = s.usage === "education" ? "Explain simply" : "Catch-up";
  missedNote.hidden = !f.missed;
  missedNote.textContent = f.missed ? `You missed ${f.missed}. Press ${summaryKey} for a summary.` : "";
  llmErrorEl.hidden = s.llm.state !== "error" || !s.llm.advice;
  llmErrorEl.textContent = s.llm.advice ?? "";
  const l = s.live;
  const advice = s.mode === "live" ? (l.configAdvice ?? l.stt.advice ?? (listening || l.audio.state === "missing" ? l.audio.advice : undefined)) : undefined;
  liveError.hidden = !advice;
  liveError.textContent = advice ?? "";
}

function renderStatusbar(s: PanelSnapshotMsg): void {
  const kp = s.pluginsConnected > 0;
  setStatus(pluginEl, "Keypad", kp ? "ok" : "err", kp ? "MX Keypad connected" : "MX Keypad not connected: is the Logi Plugin Service running?");
  setStatus(llmEl, "Model", s.llm.state === "ok" ? "ok" : s.llm.state === "error" ? "err" : "wait", s.llm.text);
  const f = s.focus;
  const cam = f.camera;
  if (f.state === "away") {
    setStatus(focusEl, `Away ${fmt(f.forMs / 1000)}`, "away", `Away · ${AWAY_REASON[f.reason ?? ""] ?? ""}`);
  } else if (f.state === "focused") {
    setStatus(focusEl, "Focused", "ok", cam.text);
  } else {
    setStatus(focusEl, "Camera off", "", `${cam.text}${cam.advice ? `\n${cam.advice}` : ""}`);
  }
  exportText.textContent = s.export.text;
  exportText.title = s.export.text;
  exportText.className = `status-note ${s.export.state === "ok" ? "ok" : s.export.state === "error" ? "err" : s.export.state === "busy" ? "wait" : ""}`;
}

function renderSettings(s: PanelSnapshotMsg): void {
  document.documentElement.dataset.theme = s.settings.theme;
  modeMockBtn.classList.toggle("active", s.mode === "mock");
  modeLiveBtn.classList.toggle("active", s.mode === "live");
  usageMeetingBtn.classList.toggle("active", s.usage === "meeting");
  usageEducationBtn.classList.toggle("active", s.usage === "education");
  themeDarkBtn.classList.toggle("active", s.settings.theme === "dark");
  themeLightBtn.classList.toggle("active", s.settings.theme === "light");
  // Rebuild the scenario list only when it changes (snapshots arrive twice a second while playing).
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
    if (i > 0) {
      const name = BOTTOM_NAMES[s.usage][i - 1];
      $(`bg-${t}-name`).textContent = name;
      input.parentElement!.title = `Bottom ${["left", "middle", "right"][i - 1]} key: ${name}`;
    }
  });
  const cam = s.focus.camera;
  cameraText.textContent = cam.text.replace(/^Camera: /, "");
  cameraText.className = `row-value${cam.state === "tracking" ? " ok" : ""}`;
  cameraError.hidden = !cam.advice;
  cameraError.textContent = cam.advice ?? "";
  calibrateBtn.disabled = cam.state === "off" || cam.state === "connecting" || cam.state === "no-tracker";
  simAway = s.focus.simulated;
  simAwayBtn.textContent = simAway ? "Stop" : "Simulate away";
  simAwayBtn.classList.toggle("on", simAway);
  diagLlm.textContent = s.llm.text;
  diagLlm.className = s.llm.state === "error" ? "err" : "";
  const l = s.live;
  sttText.textContent = l.configAdvice ? "Not configured" : l.stt.text.replace(/^Speech-to-text: /, "");
  sttText.className = l.configAdvice || l.stt.state === "error" ? "err" : "";
  spotterText.textContent = l.spotter.text.replace(/^Spotter( ·|:)? ?/, "");
  spotterText.title = l.spotter.advice ?? "";
}

function renderEmpty(): void {
  const hasLines = transcriptEl.querySelector(".turn") !== null;
  emptyEl.hidden = hasLines;
  if (hasLines || !snap) return;
  const s = snap;
  const span = document.createElement("span");
  if (s.mode === "mock") {
    const title = s.scenarios.find((x) => x.id === s.scenario)?.title.replace(/\s*\(.*\)\s*$/, "") ?? `the mock ${s.usage === "education" ? "lecture" : "meeting"}`;
    const em = document.createElement("em");
    em.textContent = title;
    span.append("Press ", kbd("Space"), " to play ", em, ".");
  } else if (listening) {
    span.textContent = "Listening… the transcript appears as people speak.";
  } else {
    span.append("Press ", kbd("Space"), " to start listening.");
  }
  emptyEl.replaceChildren(span);
}

function kbd(text: string): HTMLElement {
  const k = document.createElement("kbd");
  k.textContent = text;
  return k;
}

function renderSnapshot(s: PanelSnapshotMsg): void {
  snap = s;
  mode = s.mode;
  playing = s.playback.playing;
  listening = s.live.listening;
  renderSettings(s);
  renderToolbar(s);
  renderTransport(s);
  renderKeys(s);
  renderNotices(s);
  renderStatusbar(s);
  renderEmpty();
}

// --- transcript -------------------------------------------------------------------------------------

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

function newTurn(speaker: string, t: number): HTMLElement {
  const turn = document.createElement("section");
  turn.className = "turn";
  const head = document.createElement("div");
  head.className = "turn-head";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = speaker || "Speaker";
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = fmt(t);
  head.append(who, time);
  turn.append(head);
  return turn;
}

function lineEl(text: string, terms: string[], t: number): HTMLElement {
  const p = document.createElement("p");
  p.className = "line";
  p.title = fmt(t);
  if (listenerRe?.test(text)) {
    p.classList.add("for-you");
    p.title = `${fmt(t)} · mentions you`;
  }
  appendHighlighted(p, text, terms);
  return p;
}

function keepScrolled(fn: () => void): void {
  const atBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 48;
  fn();
  if (atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addLine(l: PanelLineMsg): void {
  keepScrolled(() => {
    const speaker = l.speaker ?? "";
    if (!lastTurn || lastTurn.speaker !== speaker) {
      const turn = newTurn(speaker, l.t);
      if (interimEl) transcriptEl.insertBefore(turn, interimEl);
      else transcriptEl.append(turn);
      lastTurn = { el: turn, speaker };
    }
    lastTurn.el.append(lineEl(l.text, l.terms, l.t));
  });
  emptyEl.hidden = true;
}

/** Live text that is not final yet: one grey block at the bottom, replaced each time. */
function setInterim(i: PanelInterimMsg | null): void {
  keepScrolled(() => {
    if (!i) {
      interimEl?.remove();
      interimEl = null;
      return;
    }
    const block = newTurn(i.speaker ?? "", i.t);
    block.classList.add("interim-turn");
    const p = lineEl(i.text, [], i.t);
    p.classList.add("interim");
    block.append(p);
    if (interimEl) interimEl.replaceWith(block);
    else transcriptEl.append(block);
    interimEl = block;
  });
  if (i) emptyEl.hidden = true;
}

function setLevel(db: number): void {
  if (!listening) return;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meterFill.style.width = `${pct}%`;
  if (db > LOUD_DB) lastLoudAt = Date.now();
  renderAudioText();
}

// --- actions ----------------------------------------------------------------------------------------

function togglePlayback(): void {
  if (mode === "mock") send(playing ? "pause" : "play");
  else if (listening) send("listen-stop");
  else if (!listenBtn.disabled) send("listen-start", keytermsEl.value);
}

const settingsOpen = () => !settingsEl.hidden;

function setSettingsOpen(open: boolean): void {
  settingsEl.hidden = !open;
  settingsBtn.classList.toggle("on", open);
  settingsBtn.setAttribute("aria-expanded", String(open));
}

playBtn.addEventListener("click", () => send(playing ? "pause" : "play"));
restartBtn.addEventListener("click", () => send("restart"));
speed1Btn.addEventListener("click", () => send("speed1"));
speed2Btn.addEventListener("click", () => send("speed2"));
listenBtn.addEventListener("click", togglePlayback);
keytermsEl.addEventListener("input", () => {
  keytermsTouched = true;
  send("keyterms", keytermsEl.value);
});
keytermsEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !listening) send("listen-start", keytermsEl.value);
});
exportBtn.addEventListener("click", () => send("export"));
settingsBtn.addEventListener("click", () => setSettingsOpen(!settingsOpen()));

modeMockBtn.addEventListener("click", () => send("mode-mock"));
modeLiveBtn.addEventListener("click", () => send("mode-live"));
usageMeetingBtn.addEventListener("click", () => send("usage-meeting"));
usageEducationBtn.addEventListener("click", () => send("usage-education"));
scenarioEl.addEventListener("change", () => send("scenario", scenarioEl.value));
themeDarkBtn.addEventListener("click", () => send("theme-dark"));
themeLightBtn.addEventListener("click", () => send("theme-light"));
bgResetBtn.addEventListener("click", () => send("key-bg-reset"));
// Colour pickers fire `input` continuously while dragging: send at most every 150 ms (the keypad redraws each time).
const bgTimers = new Map<string, number>();
BG_TARGETS.forEach((t, i) =>
  bgInputs[i].addEventListener("input", () => {
    clearTimeout(bgTimers.get(t));
    bgTimers.set(t, window.setTimeout(() => send("key-bg", `${t}=${bgInputs[i].value}`), 150));
  }),
);
calibrateBtn.addEventListener("click", () => send("gaze-calibrate"));
simAwayBtn.addEventListener("click", () => send("sim-away", simAway ? "off" : "on"));
simMentionBtn.addEventListener("click", () => send("sim-mention"));

// Keyboard: Space plays / listens, ⌘1 / ⌘2 mode, ⌘L source, ⌘E export, ⌘, settings, Esc closes settings.
document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === "Escape" && settingsOpen()) {
    setSettingsOpen(false);
    e.preventDefault();
    return;
  }
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === ",") setSettingsOpen(!settingsOpen());
    else if (k === "e") send("export");
    else if (k === "l") send(mode === "mock" ? "mode-live" : "mode-mock");
    else if (k === "1") send("usage-meeting");
    else if (k === "2") send("usage-education");
    else return;
    e.preventDefault();
    return;
  }
  // Space always means play / listen (a clicked button keeps focus; Enter still activates it).
  if (e.key === " " && !typing && !e.repeat) {
    e.preventDefault();
    togglePlayback();
  }
});

window.keypad.on("snapshot", renderSnapshot);
window.keypad.on("line", addLine);
window.keypad.on("reset", () => {
  interimEl = null;
  lastTurn = null;
  transcriptEl.replaceChildren(emptyEl);
  renderEmpty();
});
window.keypad.on("interim", setInterim);
window.keypad.on("level", setLevel);
setInterval(renderAudioText, 500); // "Receiving audio" fades back when the level drops

void window.keypad.init().then(({ snapshot, lines, listener }) => {
  if (listener) listenerRe = new RegExp(`\\b${listener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  lines.forEach(addLine);
  renderSnapshot(snapshot);
});
