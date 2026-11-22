import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { AudioCapture } from "../pipeline/audioCapture.js";
import { CatchUpController, type LlmOutcome } from "../pipeline/catchUp.js";
import { realClock } from "../pipeline/clock.js";
import { DEFAULT_PORT, KeypadBridge, PortInUseError, type PressEvent } from "../pipeline/keypadBridge.js";
import {
  LlmError,
  MisconfiguredClient,
  OpenAiCompatClient,
  errorAdvice,
  loadLlmConfig,
  loadSpotterLlmConfig,
  spotterIntervalMs,
  warmUp,
  type LlmClient,
} from "../pipeline/llm.js";
import { Explainer } from "../pipeline/explainer.js";
import { LatencyTracker, formatLatency } from "../pipeline/latency.js";
import { TermSpotter, type SpotInfo } from "../pipeline/termSpotter.js";
import { LiveSource, type LiveInterim, type LiveLine } from "../pipeline/liveSource.js";
import { loadConfig, loadGlossary, loadMeeting } from "../pipeline/mockData.js";
import { MockSource } from "../pipeline/mockSource.js";
import { OverlayController, type HideReason, type OverlayCard } from "../pipeline/overlay.js";
import type { KeyState } from "../pipeline/protocol.js";
import { SaveController, fileSavedIdeas } from "../pipeline/save.js";
import { SlotManager } from "../pipeline/slots.js";
import { SttError, deepgramFactory, loadSttConfig, parseKeyterms, sttAdvice, type SttFactory } from "../pipeline/stt.js";
import type { TermCandidate } from "../pipeline/terms.js";
import { TranscriptBuffer, type TranscriptLine } from "../pipeline/transcriptBuffer.js";
import { OverlayWindow } from "./overlayWindow.js";
import type { PanelCommand, PanelLine, PanelLlm, PanelMode, PanelSnapshot } from "./panelTypes.js";

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
const mockSource = new MockSource(meeting, glossary, clock);
let mode: PanelMode = "mock";
const playedLines: PanelLine[] = [];
// Mock terms explain from the glossary, live terms from the Explainer (set up below).
const overlay = new OverlayController({ clock, lookup: (term) => (mode === "live" ? explainer.lookup(term) : glossary[term]) });
const listener = { name: config.listenerName, knows: config.listenerKnows };

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
// Term spotter: a small fast model (LLM_SPOTTER_MODEL), same server and key.
let spotterLlm: LlmClient;
try {
  spotterLlm = new OpenAiCompatClient(loadSpotterLlmConfig(process.env), fetch, (m) => log(`[spotter-llm] ${m}`));
} catch (err) {
  spotterLlm = new MisconfiguredClient(err instanceof LlmError ? err : new LlmError("config", String(err)));
}

// --- live meeting: audiotee -> Deepgram -> LiveSource (Phase 3a) ------------------------------

const audioteePath = process.env.AUDIOTEE_PATH || join(appRoot, "..", "tools", "audiotee", "bin", "audiotee");
const audio = new AudioCapture({ binPath: audioteePath, clock, log: (m) => log(`[audio] ${m}`) });
let sttFactory: SttFactory | null = null;
let sttConfigAdvice: string | undefined;
try {
  sttFactory = deepgramFactory(loadSttConfig(process.env), { clock, log: (m) => log(`[stt] ${m}`) });
} catch (err) {
  const e = err instanceof SttError ? err : new SttError("config", String(err));
  sttConfigAdvice = sttAdvice(e);
  log(`[stt] not configured: ${e.message}`);
}
const liveSource = new LiveSource({
  clock,
  audio,
  stt: (o) => {
    if (!sttFactory) throw new Error("speech-to-text not configured");
    return sttFactory(o);
  },
  log,
});
/** The panel's "meeting topic / keyterms" text, used at the next Start listening. */
let keytermsText = config.keyterms.join(", ");
/** Terms the spotter found in this app session; added to Deepgram's keyterms at the next Start listening. */
const learnedKeyterms: string[] = [];

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

const meetingTime = () => (mode === "live" ? liveSource.position() : mockSource.position());
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
const spotter = new TermSpotter({
  clock,
  llm: spotterLlm,
  listener,
  log,
  minIntervalMs: spotterIntervalMs(process.env),
});
const explainer = new Explainer({ clock, llm, listener, log, onLlmOutcome });
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
    mode,
    playback: mockSource.state(),
    live: { ...liveSource.state(), keytermsText, configAdvice: sttConfigAdvice, spotter: spotter.status(), learnedKeyterms },
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

// Speech -> key delay per live term (Deepgram word timestamps), logged when the term reaches a key.
const latency = new LatencyTracker();
/** When each live line became final (meeting seconds). */
const lineFinalAt = new WeakMap<TranscriptLine, number>();

// A live term just landed on a key: write its explanation now, so it is ready before the press.
slots.on("placed", ({ candidate }: { slot: number; candidate: TermCandidate }) => {
  if (candidate.source !== "live") return;
  explainer.prefetch(candidate);
  const r = latency.placed(candidate.term, liveSource.position());
  if (r) log(formatLatency(r));
});

/** A spoken line from either source (mock: with terms; live: finals, terms come from the spotter). */
function onLine(line: LiveLine): void {
  transcript.add(line);
  const pl: PanelLine = { t: line.t, speaker: line.speaker, text: line.text, terms: line.terms };
  playedLines.push(pl);
  log(`[${mmss(line.t)}] ${line.speaker ?? "?"}: ${line.text}`);
  send("line", pl);
}

/** A new meeting: mock Restart, Start listening, or a Mock/Live switch. */
function resetMeeting(why: string): void {
  log(`reset (${why})`);
  catchUp.cancel();
  saver.reset();
  spotter.reset();
  explainer.reset();
  latency.reset();
  overlay.hide("restart");
  slots.reset();
  transcript.clear();
  playedLines.length = 0;
  send("reset");
}

mockSource.on("line", onLine);
mockSource.on("term", (c: TermCandidate) => {
  log(`term "${c.term}" (${c.category}, ${c.source})`);
  slots.add(c);
});
mockSource.on("unknownTerm", (term: string) => log(`WARNING: term "${term}" is not in mock/glossary.json, skipped`));
mockSource.on("restart", () => resetMeeting("restart"));
mockSource.on("state", pushSnapshot);
mockSource.on("end", () => log("meeting finished"));

liveSource.on("line", (line: LiveLine) => {
  lineFinalAt.set(line, liveSource.position());
  if (line.reason === "length") log(`(line cut at ${line.text.split(/\s+/).length} words / ${((line.end ?? line.t) - line.t).toFixed(1)} s)`);
  onLine(line);
  if (mode === "live") spotter.addLine(line);
});
spotter.on("term", (c: TermCandidate, info: SpotInfo) => {
  log(`term "${c.term}" (${c.category}, ${c.source})`);
  explainer.noteHeard(c, info.line, info.context, info.heard);
  latency.spot(c.term, liveSource.position(), info.spokenAt, lineFinalAt.get(info.line));
  if (!learnedKeyterms.some((k) => k.toLowerCase() === c.term.toLowerCase())) learnedKeyterms.push(c.term);
  slots.add(c);
});
spotter.on("status", pushSnapshot);
explainer.on("ready", (term: string) => overlay.refresh(term));
explainer.on("failed", (term: string) => overlay.refresh(term));
liveSource.on("restart", () => resetMeeting("start listening"));
liveSource.on("interim", (i: LiveInterim | null) => send("interim", i));
liveSource.on("level", (db: number) => send("level", Number.isFinite(db) ? db : -100));
liveSource.on("state", pushSnapshot);
liveSource.on("end", () => log("listening stopped"));

async function setMode(m: PanelMode): Promise<void> {
  if (m === mode) return;
  if (m === "live") mockSource.rewind();
  else await liveSource.stop();
  mode = m;
  resetMeeting(`mode ${m}`);
  pushSnapshot();
}

function startListening(text: string): void {
  if (mode !== "live" || liveSource.isListening()) return;
  keytermsText = text;
  if (!sttFactory) {
    log(`[stt] cannot start: ${sttConfigAdvice}`);
    pushSnapshot();
    return;
  }
  // The panel's text first, so it wins when the 50-keyterm cap is reached.
  const keyterms = parseKeyterms([text, ...learnedKeyterms]);
  log(`listening${keyterms.length ? ` (keyterms: ${keyterms.join(", ")})` : ""}`);
  liveSource.start(keyterms);
}

bridge.on("press", ({ slot }: PressEvent) => {
  const received = performance.now();
  const r = slots.press(slot);
  switch (r.kind) {
    case "term": {
      // A live term whose explanation failed (or never started) is asked for again; the card waits.
      if (mode === "live" && explainer.state(r.term) !== "pending" && explainer.state(r.term) !== "ready") explainer.prefetch(r.term);
      const outcome = overlay.press(r);
      const card = overlay.current();
      if (card && (outcome === "shown" || outcome === "switched")) pressReceivedAt.set(card.id, { what: `"${r.term}"`, at: received });
      if (outcome === "ignored") log(`WARNING: PRESS slot ${slot}: "${r.term}" has no explanation entry, no card`);
      else log(`PRESS slot ${slot}: "${r.term}" -> card ${outcome}${mode === "live" ? ` (explanation ${explainer.state(r.term)})` : ""}`);
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

ipcMain.on("panel:control", (_e, cmd: PanelCommand, arg?: unknown) => {
  if (cmd !== "keyterms") log(`panel: ${cmd}`);
  switch (cmd) {
    case "play":
      if (mode === "mock") mockSource.play();
      break;
    case "pause":
      mockSource.pause();
      break;
    case "restart":
      if (mode === "mock") mockSource.restart();
      break;
    case "speed1":
      mockSource.setSpeed(1);
      break;
    case "speed2":
      mockSource.setSpeed(2);
      break;
    case "mode-mock":
    case "mode-live":
      void setMode(cmd === "mode-live" ? "live" : "mock");
      break;
    case "listen-start":
      startListening(typeof arg === "string" ? arg : keytermsText);
      break;
    case "listen-stop":
      void liveSource.stop();
      break;
    case "keyterms":
      if (typeof arg === "string") keytermsText = arg;
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
  if (!(spotterLlm instanceof MisconfiguredClient)) {
    void warmUp(spotterLlm, clock).then((r) =>
      log(r.ok ? `[spotter-llm] warm-up ok: ${spotterLlm.describe()} in ${r.ms} ms` : `[spotter-llm] WARNING: warm-up failed: ${r.error.kind}: ${r.error.message}`),
    );
  }
  log(`ready: ${meeting.length} lines, ${Object.keys(glossary).length} glossary terms, listener "${config.listenerName}". Press Play in the panel.`);
  if (process.env.AUTOPLAY === "1") mockSource.play(); // AUTOPLAY=1 npm run dev: start the meeting right away
  if (process.env.AUTOLISTEN === "1") {
    // AUTOLISTEN=1 npm run dev: Live mode, listening right away
    void setMode("live").then(() => startListening(keytermsText));
  }
  setInterval(() => {
    if (mockSource.state().playing || liveSource.isListening()) pushSnapshot();
  }, 500);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  catchUp.cancel();
  saver.reset();
  spotter.dispose();
  mockSource.dispose();
  audio.killNow(); // never leave audiotee running after the app quits
  void liveSource.dispose();
  overlay.dispose();
  overlayWindow?.destroy();
  slots.dispose();
  void bridge.stop();
});
