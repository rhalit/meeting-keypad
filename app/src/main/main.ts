import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { realClock } from "../pipeline/clock.js";
import { DEFAULT_PORT, KeypadBridge, PortInUseError, type PressEvent } from "../pipeline/keypadBridge.js";
import { loadConfig, loadGlossary, loadMeeting, type MeetingLine } from "../pipeline/mockData.js";
import { MockSource } from "../pipeline/mockSource.js";
import type { KeyState } from "../pipeline/protocol.js";
import { SlotManager } from "../pipeline/slots.js";
import type { TermCandidate } from "../pipeline/terms.js";
import { TranscriptBuffer } from "../pipeline/transcriptBuffer.js";
import type { PanelCommand, PanelLine, PanelSnapshot } from "./panelTypes.js";

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args: unknown[]) => console.log(ts(), ...args);
const oneLine = (s: string) => s.replace(/\n/g, " ");
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const appRoot = app.getAppPath(); // .../app
const mockDir = join(appRoot, "..", "mock");

const config = loadConfig(join(mockDir, "config.json"));
const meeting = loadMeeting(join(mockDir, "meeting.json"), config.listenerName);
const glossary = loadGlossary(join(mockDir, "glossary.json"));

const clock = realClock;
const transcript = new TranscriptBuffer();
const slots = new SlotManager({ clock });
const bridge = new KeypadBridge({ initial: slots.getAll(), log: (m) => log(`[keypad] ${m}`) });
const source = new MockSource(meeting, glossary, clock);
const playedLines: PanelLine[] = [];

let panel: BrowserWindow | null = null;

function send(channel: string, payload?: unknown): void {
  if (panel && !panel.isDestroyed()) panel.webContents.send(`panel:${channel}`, payload);
}

function snapshot(): PanelSnapshot {
  return {
    playback: source.state(),
    pluginsConnected: bridge.connectedCount(),
    keys: slots.getAll().map((k, i) => ({ ...k, term: slots.termAt(i) ?? undefined })),
    queued: slots.queued(),
  };
}

const pushSnapshot = () => send("snapshot", snapshot());

// --- pipeline wiring: source -> transcript / SlotManager -> keypad ------------------------

slots.on("change", (keys: KeyState[]) => {
  for (const k of keys) log(`slot ${k.slot} -> ${k.state === "empty" ? "empty" : `"${oneLine(k.label)}" ${k.state}`}`);
  bridge.apply(keys);
  pushSnapshot();
});

source.on("line", (line: MeetingLine) => {
  transcript.add(line);
  const pl: PanelLine = { t: line.t, speaker: line.speaker, text: line.text, terms: line.terms };
  playedLines.push(pl);
  log(`[${mmss(line.t)}] ${line.speaker}: ${line.text}`);
  send("line", pl);
});

source.on("term", (c: TermCandidate) => {
  log(`term "${c.term}" (${c.category}, ${c.source})`);
  slots.add(c);
});

source.on("unknownTerm", (term: string) => log(`WARNING: term "${term}" is not in mock/glossary.json, skipped`));

source.on("restart", () => {
  log("restart");
  slots.reset();
  transcript.clear();
  playedLines.length = 0;
  send("reset");
});

source.on("state", pushSnapshot);
source.on("end", () => log("meeting finished"));

bridge.on("press", ({ slot }: PressEvent) => {
  const r = slots.press(slot);
  switch (r.kind) {
    case "term":
      log(`PRESS slot ${slot}: "${r.term}" -> seen (overlay card comes in the next step)`);
      break;
    case "action":
      log(`PRESS slot ${slot}: ${r.action} (not implemented yet)`);
      break;
    default:
      log(`PRESS slot ${slot}: ${r.kind}`);
  }
});
bridge.on("connected", pushSnapshot);
bridge.on("disconnected", pushSnapshot);

// --- panel ---------------------------------------------------------------------------------

ipcMain.handle("panel:init", () => ({ snapshot: snapshot(), lines: playedLines, listener: config.listenerName }));

ipcMain.on("panel:control", (_e, cmd: PanelCommand) => {
  log(`panel: ${cmd}`);
  switch (cmd) {
    case "play":
      source.play();
      break;
    case "pause":
      source.pause();
      break;
    case "restart":
      source.restart();
      break;
    case "speed1":
      source.setSpeed(1);
      break;
    case "speed2":
      source.setSpeed(2);
      break;
  }
});

function createPanel(): void {
  panel = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    title: "Meeting Keypad",
    backgroundColor: "#0D1117",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void panel.loadFile(join(appRoot, "static", "panel.html"));
  panel.on("closed", () => (panel = null));
}

// --- startup -------------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    await bridge.start();
  } catch (err) {
    const msg =
      err instanceof PortInUseError
        ? `Port ${DEFAULT_PORT} is already in use, so the keypad plugin cannot reach this app.\n` +
          `Is tools/fake-core still running? Stop it (Ctrl+C in its terminal) and start the app again.\n` +
          `To see what holds the port: lsof -nP -iTCP:${DEFAULT_PORT} -sTCP:LISTEN`
        : `Could not start the keypad server: ${(err as Error).message}`;
    console.error(`\nERROR: ${msg}\n`);
    dialog.showErrorBox("Meeting Keypad", msg);
    app.exit(1);
    return;
  }

  createPanel();
  log(`ready: ${meeting.length} lines, ${Object.keys(glossary).length} glossary terms, listener "${config.listenerName}". Press Play in the panel.`);
  if (process.env.AUTOPLAY === "1") source.play(); // AUTOPLAY=1 npm run dev: start the meeting right away
  setInterval(() => {
    if (source.state().playing) pushSnapshot();
  }, 500);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  source.dispose();
  slots.dispose();
  void bridge.stop();
});
