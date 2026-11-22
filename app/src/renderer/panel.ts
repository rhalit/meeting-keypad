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
  brio: { connected: boolean; name?: string; checked: boolean };
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
  words?: number[];
}
interface PanelInterimMsg {
  t: number;
  speaker?: string;
  text: string;
}
interface SavedIdeaMsg {
  title: string;
  summary: string;
  quote: string;
  t: number;
  savedAt: number;
}
interface SavedCardMsg {
  front: string;
  back: string;
  t: number;
  savedAt: number;
}
interface SessionMsg {
  id: string;
  title: string;
  kind: "meeting" | "course";
  source: "mock" | "live";
  startedAt: number;
  updatedAt: number;
  ideas: SavedIdeaMsg[];
  cards: SavedCardMsg[];
}
interface SavedMsg {
  currentId: string | null;
  current: SessionMsg | null;
  sessions: SessionMsg[];
}
interface KeypadApi {
  init(): Promise<{ snapshot: PanelSnapshotMsg; lines: PanelLineMsg[]; listener: string; saved: SavedMsg }>;
  control(cmd: string, arg?: string): void;
  on(channel: "snapshot" | "line" | "reset" | "interim" | "level" | "saved", cb: (payload: any) => void): void;
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
const savedBtn = $<HTMLButtonElement>("saved-btn");
const savedEl = $("saved");
const savedBody = $("saved-body");
const savedCount = $("saved-count");

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
const brioStatus = $<HTMLButtonElement>("brio-status");
const brioText = $("brio-text");
const openGazeBtn = $<HTMLButtonElement>("open-gaze");
const meterEl = $("meter");
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
const simTools = $("sim-tools");
const simAwayBtn = $<HTMLButtonElement>("sim-away");
const simMentionBtn = $<HTMLButtonElement>("sim-mention");
const diagLlm = $("diag-llm");
const sttText = $("stt-text");
const spotterText = $("spotter-text");

const BG_TARGETS = ["terms", "6", "7", "8"] as const;
/**
 * Preset keypad colours, named after the two worlds the app serves. Meeting tones: Ink, Focus, Indigo, Teal
 * (calm, professional). Classroom tones: Chalkboard, Sage, Pencil, Terracotta, Paper (Paper is light: the
 * keypad then draws dark text). Black is the keypad's own default, sent as "no colour".
 */
const KEY_PALETTE: { name: string; hex: string }[] = [
  { name: "Black", hex: "#000000" },
  { name: "Ink", hex: "#1E2B3C" },
  { name: "Focus", hex: "#2F5D9E" },
  { name: "Indigo", hex: "#3F4A8A" },
  { name: "Teal", hex: "#22706C" },
  { name: "Chalkboard", hex: "#2F4F3E" },
  { name: "Sage", hex: "#5E7F68" },
  { name: "Pencil", hex: "#C08A2E" },
  { name: "Terracotta", hex: "#B4593F" },
  { name: "Paper", hex: "#F1EDE3" },
];
const palettes = BG_TARGETS.map((t) => {
  const el = $(`pal-${t}`);
  const buttons = KEY_PALETTE.map((c) => {
    const b = document.createElement("button");
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", c.name);
    b.addEventListener("click", () => send("key-bg", `${t}=${c.hex === "#000000" ? "" : c.hex}`));
    return b;
  });
  el.replaceChildren(...buttons);
  return buttons;
});
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
  meterEl.hidden = !listening; // the level meter only means something while listening
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
      // On a coloured key the category is drawn soft white / soft dark (custom-* classes), like the plugin.
      if (k.color && !k.bg && k.state !== "empty" && k.state !== "alert") key.style.setProperty("--cat", k.color);
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
  // MX Brio: plugged in (macOS) and tracking (Gaze Tracker).
  const tracking = cam.state === "tracking";
  const brioCls = !f.brio.checked ? "" : !f.brio.connected ? "err" : tracking ? "ok" : "wait";
  brioStatus.className = `status-item status-btn ${brioCls}`;
  brioStatus.title = !f.brio.checked
    ? "Checking for the MX Brio…"
    : !f.brio.connected
      ? "MX Brio not found: plug it in (USB). Click for details."
      : tracking
        ? "MX Brio connected · Gaze Tracker tracking your gaze"
        : `MX Brio connected · ${cam.text.replace(/^Camera: /, "")}. Click for details.`
  if (s.mode === "mock") brioStatus.title += " (Mock mode does not use the camera: Demo → Simulate away)";
  // Focus only when it means something: Live with a camera, or a simulated away.
  focusEl.hidden = !(f.state === "away" || (s.mode === "live" && f.state === "focused"));
  if (f.state === "away") {
    setStatus(focusEl, `Away ${fmt(f.forMs / 1000)}${f.simulated ? " · simulated" : ""}`, "away", `Away · ${AWAY_REASON[f.reason ?? ""] ?? ""}`);
  } else if (s.mode === "mock") {
    setStatus(focusEl, "Camera · live only", "", "In Mock mode the camera is not used. Use Demo → Simulate away.");
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
  document.documentElement.dataset.usage = s.usage; // mode accent (panel.css)
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
    const current = (s.settings.keyBg[t] ?? "#000000").toUpperCase();
    palettes[i].forEach((b, j) => b.setAttribute("aria-checked", String(KEY_PALETTE[j].hex === current)));
    $(`pal-${t}-choice`).textContent = KEY_PALETTE.find((c) => c.hex === current)?.name ?? "Custom";
    if (i > 0) {
      const name = BOTTOM_NAMES[s.usage][i - 1];
      const label = $(`bg-${t}-name`);
      label.textContent = name;
      label.title = `Bottom ${["left", "middle", "right"][i - 1]} key: ${name}`;
    }
  });
  const cam = s.focus.camera;
  const b = s.focus.brio;
  brioText.textContent = !b.checked ? "Checking…" : b.connected ? "Connected" : "Not found: plug it in (USB)";
  brioText.className = `row-value${!b.checked ? "" : b.connected ? " ok" : " err"}`;
  const camText = cam.text.replace(/^Camera: /, "").replace(/^Gaze Tracker /, "");
  cameraText.textContent = camText.charAt(0).toUpperCase() + camText.slice(1);
  cameraText.className = `row-value${cam.state === "tracking" ? " ok" : cam.state === "off" || cam.state === "connecting" ? "" : " warn"}`;
  cameraError.hidden = !cam.advice;
  cameraError.textContent = cam.advice ?? "";
  calibrateBtn.disabled = cam.state === "off" || cam.state === "connecting" || cam.state === "no-tracker";
  // Demo tools: Mock only.
  simTools.hidden = s.mode !== "mock";
  simAway = s.focus.simulated;
  simAwayBtn.textContent = simAway ? "Back from away" : "Simulate away";
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
  syncClock(s);
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

// --- saved view -------------------------------------------------------------------------------------

let saved: SavedMsg | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function entryEls(s: SessionMsg): HTMLElement[] {
  const ideas = s.ideas.map((i) => {
    const box = el("article", "idea");
    const head = el("div", "idea-head");
    head.append(el("span", "idea-title", i.title), el("span", "t", fmt(i.t)));
    box.append(head);
    if (i.summary) box.append(el("p", "idea-summary", i.summary));
    if (i.quote) box.append(el("p", "idea-quote", `“${i.quote}”`));
    return box;
  });
  const cards = s.cards.map((c) => {
    const box = el("article", "idea");
    const head = el("div", "idea-head");
    head.append(el("span", "idea-title", c.front), el("span", "t", fmt(c.t)));
    box.append(head, el("p", "idea-back", c.back));
    return box;
  });
  return [...ideas, ...cards];
}

function countLabel(s: SessionMsg): string {
  const parts = [];
  if (s.ideas.length) parts.push(`${s.ideas.length} idea${s.ideas.length > 1 ? "s" : ""}`);
  if (s.cards.length) parts.push(`${s.cards.length} card${s.cards.length > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

function renderSaved(): void {
  if (!saved) return;
  const cur = saved.current;
  const n = cur ? cur.ideas.length + cur.cards.length : 0;
  savedCount.hidden = n === 0;
  savedCount.textContent = String(n);
  const isCourse = snap?.usage === "education";
  const nodes: HTMLElement[] = [el("h3", "", isCourse ? "This course" : "This meeting")];
  const title = cur?.title ?? (snap?.mode === "live" ? (isCourse ? "Live lecture" : "Live meeting") : (snap?.scenarios.find((x) => x.id === snap?.scenario)?.title ?? ""));
  nodes.push(el("p", "saved-title", title));
  if (cur && (cur.ideas.length || cur.cards.length)) {
    nodes.push(el("p", "saved-meta", countLabel(cur)), ...entryEls(cur));
  } else {
    nodes.push(
      el(
        "p",
        "saved-empty",
        isCourse
          ? "Nothing saved yet. Press Flashcard on the keypad to turn what was just taught into a card."
          : "Nothing saved yet. Press Save on the keypad, then pick how far back to look.",
      ),
    );
  }
  const earlier = saved.sessions.filter((s) => s.id !== saved!.currentId && (s.ideas.length || s.cards.length));
  if (earlier.length) {
    nodes.push(el("h3", "", "Earlier"));
    for (const s of earlier) {
      const d = el("details", "past");
      const sum = el("summary", "");
      sum.append(el("span", "past-title", s.title), el("span", "past-count", countLabel(s)));
      d.append(sum, ...entryEls(s));
      nodes.push(d);
    }
  }
  // Keep which earlier sessions were expanded.
  const open = new Set([...savedBody.querySelectorAll("details[open] .past-title")].map((x) => x.textContent ?? ""));
  savedBody.replaceChildren(...nodes);
  savedBody.querySelectorAll("details").forEach((d) => {
    if (open.has(d.querySelector(".past-title")?.textContent ?? "")) d.open = true;
  });
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

// --- word-by-word reveal (mock): driven by the playback clock, so Pause and 2× apply -------------------

/** Lines still being "spoken": shown up to the words whose start time has passed. */
let revealing: { p: HTMLElement; l: PanelLineMsg; shown: number }[] = [];
let clockPos = 0;
let clockAt = 0;
let clockSpeed = 1;
let clockPlaying = false;
let initialLoad = true;

function playbackPos(): number {
  return clockPlaying ? clockPos + ((performance.now() - clockAt) / 1000) * clockSpeed : clockPos;
}

function syncClock(s: PanelSnapshotMsg): void {
  if (s.mode !== "mock") {
    finishReveal();
    return;
  }
  clockPos = s.playback.position;
  clockAt = performance.now();
  clockSpeed = s.playback.speed;
  clockPlaying = s.playback.playing;
}

function renderPartial(r: { p: HTMLElement; l: PanelLineMsg; shown: number }, n: number): void {
  const words = r.l.text.split(/\s+/).filter(Boolean);
  r.shown = n;
  r.p.replaceChildren();
  appendHighlighted(r.p, words.slice(0, n).join(" "), r.l.terms);
  r.p.classList.toggle("typing", n < words.length);
}

function tickReveal(): void {
  if (!revealing.length) return;
  const pos = playbackPos();
  keepScrolled(() => {
    revealing = revealing.filter((r) => {
      const times = r.l.words!;
      let n = 0;
      while (n < times.length && times[n] <= pos + 0.02) n++;
      if (n !== r.shown) renderPartial(r, n);
      return n < times.length;
    });
  });
}

function finishReveal(): void {
  for (const r of revealing) renderPartial(r, r.l.words!.length);
  revealing = [];
}
setInterval(tickReveal, 60);

function addLine(l: PanelLineMsg): void {
  keepScrolled(() => {
    const speaker = l.speaker ?? "";
    if (!lastTurn || lastTurn.speaker !== speaker) {
      const turn = newTurn(speaker, l.t);
      if (interimEl) transcriptEl.insertBefore(turn, interimEl);
      else transcriptEl.append(turn);
      lastTurn = { el: turn, speaker };
    }
    const p = lineEl(l.text, l.terms, l.t);
    lastTurn.el.append(p);
    // A line arriving now (not history) with word times is revealed word by word.
    if (l.words && l.words.length && snap?.mode === "mock" && !initialLoad) {
      finishReveal(); // a new line: the previous one is complete
      if (playbackPos() < l.t) {
        clockPos = l.t;
        clockAt = performance.now();
      }
      const r = { p, l, shown: -1 };
      revealing.push(r);
      renderPartial(r, 0);
      tickReveal();
    }
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
const savedOpen = () => !savedEl.hidden;

/** One sheet at a time: Settings or Saved. */
function setSettingsOpen(open: boolean): void {
  if (open) setSavedOpen(false);
  settingsEl.hidden = !open;
  settingsBtn.classList.toggle("on", open);
  settingsBtn.setAttribute("aria-expanded", String(open));
}

function setSavedOpen(open: boolean): void {
  if (open) setSettingsOpen(false);
  savedEl.hidden = !open;
  savedBtn.classList.toggle("on", open);
  savedBtn.setAttribute("aria-expanded", String(open));
  if (open) renderSaved();
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
savedBtn.addEventListener("click", () => setSavedOpen(!savedOpen()));

modeMockBtn.addEventListener("click", () => send("mode-mock"));
modeLiveBtn.addEventListener("click", () => send("mode-live"));
usageMeetingBtn.addEventListener("click", () => send("usage-meeting"));
usageEducationBtn.addEventListener("click", () => send("usage-education"));
scenarioEl.addEventListener("change", () => send("scenario", scenarioEl.value));
themeDarkBtn.addEventListener("click", () => send("theme-dark"));
themeLightBtn.addEventListener("click", () => send("theme-light"));
bgResetBtn.addEventListener("click", () => send("key-bg-reset"));
calibrateBtn.addEventListener("click", () => send("gaze-calibrate"));
openGazeBtn.addEventListener("click", () => send("open-gaze-tracker"));
brioStatus.addEventListener("click", () => {
  setSettingsOpen(true);
  $("camera-section").scrollIntoView({ block: "start", behavior: "smooth" });
});
simAwayBtn.addEventListener("click", () => send("sim-away", simAway ? "off" : "on"));
simMentionBtn.addEventListener("click", () => send("sim-mention"));

// Keyboard: Space plays / listens, ⌘1 / ⌘2 mode, ⌘L source, ⌘E export, ⌘, settings, Esc closes settings.
document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === "Escape" && (settingsOpen() || savedOpen())) {
    setSettingsOpen(false);
    setSavedOpen(false);
    e.preventDefault();
    return;
  }
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === ",") setSettingsOpen(!settingsOpen());
    else if (k === "s") setSavedOpen(!savedOpen());
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
  revealing = [];
  interimEl = null;
  lastTurn = null;
  transcriptEl.replaceChildren(emptyEl);
  renderEmpty();
});
window.keypad.on("interim", setInterim);
window.keypad.on("saved", (s: SavedMsg) => {
  saved = s;
  renderSaved();
});
window.keypad.on("level", setLevel);
setInterval(renderAudioText, 500); // "Receiving audio" fades back when the level drops

void window.keypad.init().then(({ snapshot, lines, listener, saved: s }) => {
  saved = s;
  if (listener) listenerRe = new RegExp(`\\b${listener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  lines.forEach(addLine);
  initialLoad = false;
  renderSnapshot(snapshot);
  renderSaved();
});
