import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { CatchUpController, type LlmOutcome } from "../pipeline/catchUp.js";
import { realClock } from "../pipeline/clock.js";
import { DEFAULT_PORT, KeypadBridge, PortInUseError, type PressEvent } from "../pipeline/keypadBridge.js";
import {
  LlmError,
  MisconfiguredClient,
  OpenAiCompatClient,
  errorAdvice,
  loadLlmConfig,
  warmUp,
  type LlmClient,
} from "../pipeline/llm.js";
import { loadConfig, loadGlossary, loadMeeting, type MeetingLine } from "../pipeline/mockData.js";
import { MockSource } from "../pipeline/mockSource.js";
import { OverlayController, type HideReason, type OverlayCard } from "../pipeline/overlay.js";
import type { KeyState } from "../pipeline/protocol.js";
import { SaveController, fileSavedIdeas } from "../pipeline/save.js";
import { SlotManager } from "../pipeline/slots.js";
import type { TermCandidate } from "../pipeline/terms.js";
import { TranscriptBuffer } from "../pipeline/transcriptBuffer.js";
import { OverlayWindow } from "./overlayWindow.js";
import type { PanelCommand, PanelLine, PanelLlm, PanelSnapshot } from "./panelTypes.js";

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args: unknown[]) => console.log(ts(), ...args);
const oneLine = (s: string) => s.replace(/\n/g, " ");
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const appRoot = app.getAppPath(); // .../app
const mockDir = join(appRoot, "..", "mock");
const savedIdeasPath = join(appRoot, "..", "output", "saved-ideas.md");

const config = loadConfig(join(mockDir, "config.json"));
const meeting = loadMeeting(join(mockDir, "meeting.json"), config.listenerName);
const glossary = loadGlossary(join(mockDir, "glossary.json"));

const clock = realClock;
const transcript = new TranscriptBuffer();
const slots = new SlotManager({ clock });
const bridge = new KeypadBridge({ initial: slots.getAll(), log: (m) => log(`[keypad] ${m}`) });
const source = new MockSource(meeting, glossary, clock);
const playedLines: PanelLine[] = [];
const overlay = new OverlayController({ clock, lookup: (term) => glossary[term] });

// --- LLM (app/.env, OpenAI-compatible) ---------------------------------------------------------

try {
  process.loadEnvFile(join(appRoot, ".env"));
} catch {
  log("[llm] no app/.env found, using the environment only");
}
let llm: LlmClient;
let llmStatus: PanelLlm = { state: "checking", text: "Model: checking…" };
try {
  llm = new OpenAiCompatClient(loadLlmConfig(process.env), fetch, (m) => log(`[llm] ${m}`));
} catch (err) {
  const e = err instanceof LlmError ? err : new LlmError("config", String(err));
  llm = new MisconfiguredClient(e);
  llmStatus = { state: "error", text: "Model: not configured", advice: errorAdvice(e) };
}

function setLlmStatus(s: PanelLlm): void {
  llmStatus = s;
  pushSnapshot();
}

/** Later calls keep the panel status honest (e.g. a key that stops working). */
function onLlmOutcome(o: LlmOutcome): void {
  if (o.ok) {
    if (llmStatus.state !== "ok") setLlmStatus({ state: "ok", text: `Model ready · ${llm.describe()}` });
  } else if (o.error.kind !== "cancelled") {
    setLlmStatus({ state: "error", text: `Model: ${o.error.kind.replace("_", " ")}`, advice: errorAdvice(o.error) });
  }
}

async function runWarmUp(): Promise<void> {
  if (llm instanceof MisconfiguredClient) {
    log(`[llm] not configured: ${llmStatus.advice}`);
    return;
  }
  log(`[llm] warm-up: ${llm.describe()}`);
  const r = await warmUp(llm, clock);
  if (r.ok) {
    log(`[llm] warm-up ok: ${llm.describe()} in ${r.ms} ms`);
    setLlmStatus({ state: "ok", text: `Model ready · ${llm.describe()} · ${r.ms} ms` });
  } else {
    log(`[llm] WARNING: warm-up failed after ${r.ms} ms: ${r.error.kind}: ${r.error.message}`);
    setLlmStatus({ state: "error", text: `Model: ${r.error.kind.replace("_", " ")}`, advice: errorAdvice(r.error) });
  }
}

const meetingTime = () => source.position();
const catchUp = new CatchUpController({
  clock,
  llm,
  transcript,
  meetingTime,
  keys: slots,
  overlay,
  log,
  onLlmOutcome,
  listenerName: config.listenerName,
});
const saver = new SaveController({
  clock,
  llm,
  transcript,
  meetingTime,
  keys: slots,
  overlay,
  file: fileSavedIdeas(savedIdeasPath),
  log,
  onLlmOutcome,
});

/** Card shows waiting for their first painted frame: card id -> press received (performance.now()). */
const pressReceivedAt = new Map<number, { what: string; at: number }>();
const SHOW_BUDGET_MS = 200;

let panel: BrowserWindow | null = null;
let overlayWindow: OverlayWindow | null = null;

function send(channel: string, payload?: unknown): void {
  if (panel && !panel.isDestroyed()) panel.webContents.send(`panel:${channel}`, payload);
}

function snapshot(): PanelSnapshot {
  return {
    playback: source.state(),
    llm: llmStatus,
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
  catchUp.cancel();
  saver.reset();
  overlay.hide("restart");
  slots.reset();
  transcript.clear();
  playedLines.length = 0;
  send("reset");
});

source.on("state", pushSnapshot);
source.on("end", () => log("meeting finished"));

bridge.on("press", ({ slot }: PressEvent) => {
  const received = performance.now();
  const r = slots.press(slot);
  switch (r.kind) {
    case "term": {
      const outcome = overlay.press(r);
      const card = overlay.current();
      if (card && (outcome === "shown" || outcome === "switched")) pressReceivedAt.set(card.id, { what: `"${r.term}"`, at: received });
      if (outcome === "ignored") log(`WARNING: PRESS slot ${slot}: "${r.term}" has no glossary entry, no card`);
      else log(`PRESS slot ${slot}: "${r.term}" -> card ${outcome}`);
      break;
    }
    case "action": {
      const before = overlay.current()?.id;
      const outcome = r.action === "catch-up" ? catchUp.press() : r.action === "save" ? saver.press() : null;
      if (outcome === null) {
        log(`PRESS slot ${slot}: ${r.action} (not implemented yet)`);
        break;
      }
      log(`PRESS slot ${slot}: ${r.action} -> ${outcome}`);
      const card = overlay.current();
      if (card && card.id !== before) pressReceivedAt.set(card.id, { what: r.action, at: received }); // only a card this press opened
      break;
    }
    default:
      log(`PRESS slot ${slot}: ${r.kind}`);
  }
});
bridge.on("connected", pushSnapshot);

// --- overlay card ----------------------------------------------------------------------------

overlay.on("show", (card: OverlayCard) => overlayWindow?.show(card));
overlay.on("update", (card: OverlayCard) => overlayWindow?.update(card));
overlay.on("hide", ({ reason }: { reason: HideReason }) => {
  log(`overlay: hidden (${reason})`);
  pressReceivedAt.clear();
  overlayWindow?.hide();
});

function onOverlayShown(id: number): void {
  const p = pressReceivedAt.get(id);
  if (!p) return;
  pressReceivedAt.delete(id);
  const ms = Math.round(performance.now() - p.at);
  const msg = `overlay: ${p.what} card shown ${ms} ms after press`;
  log(ms > SHOW_BUDGET_MS ? `WARNING: ${msg} (budget ${SHOW_BUDGET_MS} ms)` : msg);
}
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
  panel.on("closed", () => {
    panel = null;
    app.quit(); // the hidden overlay window would otherwise keep the app alive
  });
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

  overlayWindow = new OverlayWindow({ appRoot, onShown: onOverlayShown, log: (m) => log(`[overlay] ${m}`) });
  createPanel();
  void runWarmUp();
  log(`ready: ${meeting.length} lines, ${Object.keys(glossary).length} glossary terms, listener "${config.listenerName}". Press Play in the panel.`);
  if (process.env.AUTOPLAY === "1") source.play(); // AUTOPLAY=1 npm run dev: start the meeting right away
  setInterval(() => {
    if (source.state().playing) pushSnapshot();
  }, 500);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  catchUp.cancel();
  saver.reset();
  source.dispose();
  overlay.dispose();
  overlayWindow?.destroy();
  slots.dispose();
  void bridge.stop();
});
