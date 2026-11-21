// Control panel. Plain browser script (no imports): shapes mirror src/main/panelTypes.ts.

interface PanelKey {
  slot: number;
  label: string;
  sub?: string;
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
interface PanelSnapshotMsg {
  playback: PanelPlayback;
  pluginsConnected: number;
  keys: PanelKey[];
  queued: string[];
}
interface PanelLineMsg {
  t: number;
  speaker: string;
  text: string;
  terms: string[];
}
interface KeypadApi {
  init(): Promise<{ snapshot: PanelSnapshotMsg; lines: PanelLineMsg[]; listener: string }>;
  control(cmd: string): void;
  on(channel: "snapshot" | "line" | "reset", cb: (payload: any) => void): void;
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
const gridEl = $("grid");
const queueEl = $("queue");
const transcriptEl = $("transcript");

let playing = false;

function renderSnapshot(s: PanelSnapshotMsg): void {
  playing = s.playback.playing;
  playBtn.textContent = playing ? "Pause" : s.playback.ended ? "Play again" : "Play";
  speed1Btn.classList.toggle("active", s.playback.speed === 1);
  speed2Btn.classList.toggle("active", s.playback.speed === 2);
  timeEl.textContent = `${fmt(s.playback.position)} / ${fmt(s.playback.duration)}`;
  pluginEl.textContent = s.pluginsConnected > 0 ? "Keypad connected" : "Keypad not connected";
  pluginEl.classList.toggle("ok", s.pluginsConnected > 0);

  gridEl.replaceChildren(
    ...s.keys.map((k) => {
      const key = document.createElement("div");
      key.className = `key state-${k.state}`;
      if (k.bg && k.state !== "empty") key.style.setProperty("--bg", k.bg);
      key.title = k.term ? `${k.term} (${k.state})` : `slot ${k.slot} (${k.state})`;
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = k.label;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = k.state === "empty" ? `${k.slot}` : `${k.slot} · ${k.sub ?? ""} · ${k.state}`;
      key.append(label, meta);
      return key;
    }),
  );
  queueEl.textContent = s.queued.length ? `Queued: ${s.queued.join(", ")}` : "";
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

function addLine(l: PanelLineMsg): void {
  const atBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  const row = document.createElement("div");
  row.className = "line";
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = fmt(l.t);
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = l.speaker;
  const text = document.createElement("span");
  text.className = "text";
  appendHighlighted(text, l.text, l.terms);
  row.append(time, who, text);
  transcriptEl.append(row);
  if (atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

playBtn.addEventListener("click", () => window.keypad.control(playing ? "pause" : "play"));
restartBtn.addEventListener("click", () => window.keypad.control("restart"));
speed1Btn.addEventListener("click", () => window.keypad.control("speed1"));
speed2Btn.addEventListener("click", () => window.keypad.control("speed2"));

window.keypad.on("snapshot", renderSnapshot);
window.keypad.on("line", addLine);
window.keypad.on("reset", () => transcriptEl.replaceChildren());

void window.keypad.init().then(({ snapshot, lines }) => {
  renderSnapshot(snapshot);
  lines.forEach(addLine);
});
