import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { AudioCapture } from "../pipeline/audioCapture.js";
import { CatchUpController, longSpan, type LlmOutcome } from "../pipeline/catchUp.js";
import { FlashcardController, QuizController, fileFlashcards } from "../pipeline/education.js";
import { realClock } from "../pipeline/clock.js";
import { FocusTracker, type AwayPeriod, type FocusStatus } from "../pipeline/focus.js";
import { DEFAULT_GAZE_URL, GazeClient, type GazeStatus } from "../pipeline/gazeSource.js";
import { DEFAULT_PORT, KeypadBridge, PortInUseError, type NavEvent, type PressEvent } from "../pipeline/keypadBridge.js";
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
import { MeetingExporter, type ExportTerm, type MeetingSnapshot } from "../pipeline/exportMeeting.js";
import { ForMeController } from "../pipeline/forMe.js";
import { MeetingRecord } from "../pipeline/meetingRecord.js";
import { LatencyTracker, formatLatency } from "../pipeline/latency.js";
import { TermSpotter, type SpotInfo } from "../pipeline/termSpotter.js";
import { LiveSource, type LiveInterim, type LiveLine } from "../pipeline/liveSource.js";
import { KeypadMenu } from "../pipeline/keypadMenu.js";
import { MentionAlert } from "../pipeline/mentionAlert.js";
import { loadConfig, loadGlossary, loadMeeting, loadScenarioIndex } from "../pipeline/mockData.js";
import { MockSource } from "../pipeline/mockSource.js";
import { OverlayController, type HideReason, type OverlayCard } from "../pipeline/overlay.js";
import { PressDebouncer } from "../pipeline/pressGuard.js";
import { actionKeysFor, type KeyState, type Usage } from "../pipeline/protocol.js";
import { explainSimplyMessages } from "../pipeline/prompts.js";
import { loadSettings, parseKeyBgArg, saveSettings, type Settings } from "../pipeline/settings.js";
import { SaveController } from "../pipeline/save.js";
import { SessionStore } from "../pipeline/sessions.js";
import { SlotManager } from "../pipeline/slots.js";
import { SttError, deepgramFactory, loadSttConfig, parseKeyterms, sttAdvice, type SttFactory } from "../pipeline/stt.js";
import type { TermCandidate } from "../pipeline/terms.js";
import { TranscriptBuffer, type TranscriptLine } from "../pipeline/transcriptBuffer.js";
import { OverlayWindow } from "./overlayWindow.js";
import { VideoWindow } from "./videoWindow.js";
import type { PanelCommand, PanelExport, PanelLine, PanelLlm, PanelMode, PanelSnapshot } from "./panelTypes.js";

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args: unknown[]) => console.log(ts(), ...args);
const oneLine = (s: string) => s.replace(/\n/g, " ");
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const appRoot = app.getAppPath(); // .../app
const mockDir = join(appRoot, "..", "mock");
const meetingsDir = join(appRoot, "..", "output", "meetings");

const flashcardsPath = join(appRoot, "..", "output", "flashcards.csv");

const config = loadConfig(join(mockDir, "config.json"));

// --- user settings (panel Settings view): theme, key backgrounds, scenario per mode; userData/settings.json ---
const settingsPath = join(app.getPath("userData"), "settings.json");
let settings: Settings = loadSettings(settingsPath);

// --- mock scenarios (mock/scenarios/index.json): several meetings and lectures, one chosen per mode ----------
const scenarios = loadScenarioIndex(join(mockDir, "scenarios", "index.json"));
// The recorded videos (in sync with Play / Pause) are the default demos: the Zoom call, the MIT lecture recap.
const DEFAULT_SCENARIO: Record<Usage, string> = { meeting: "zoom-business", education: "nn-lecture" };
const scenarioInfo = (id: string) => scenarios.find((x) => x.id === id);
/** The chosen scenario for a mode: MOCK_SCENARIO (meeting, at startup), the saved choice, else the default. */
const chosen: Record<Usage, string> = { meeting: DEFAULT_SCENARIO.meeting, education: DEFAULT_SCENARIO.education };
for (const u of ["meeting", "education"] as const) {
  const want = (u === "meeting" ? process.env.MOCK_SCENARIO : undefined) || settings.scenario[u];
  if (want && scenarioInfo(want)?.usage === u) chosen[u] = want;
  else if (want) console.log(`WARNING: unknown ${u} scenario "${want}", using "${chosen[u]}"`);
}
function scenarioFor(u: Usage): string {
  return chosen[u];
}
function loadScenario(id: string) {
  const dir = join(mockDir, scenarioInfo(id)!.path);
  return { meeting: loadMeeting(join(dir, "meeting.json"), config.listenerName), glossary: loadGlossary(join(dir, "glossary.json")) };
}
let usage: Usage = process.env.USAGE === "education" ? "education" : "meeting";
let { meeting, glossary } = loadScenario(scenarioFor(usage));

const clock = realClock;
const transcript = new TranscriptBuffer();
const slots = new SlotManager({ clock });
slots.setActionKeys(actionKeysFor(usage));

slots.setBackgrounds(settings.keyBg);

function updateSettings(next: Settings): void {
  settings = next;
  try {
    saveSettings(settingsPath, settings);
  } catch (err) {
    log(`WARNING: settings not saved: ${(err as Error).message}`);
  }
  pushSnapshot();
}
const bridge = new KeypadBridge({ initial: slots.getAll(), log: (m) => log(`[keypad] ${m}`) });
const mockSource = new MockSource(meeting, glossary, clock, scenarioInfo(scenarioFor(usage))?.duration);

// --- video scenarios: a recorded call plays in its own window, in step with the mock playback ----------
// Play is pressed in the IntelliPad window, so the video may start with sound without a click of its own.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const videoWindow = new VideoWindow({ appRoot, log: (m) => log(`[video] ${m}`) });

// --- Saved view: saved ideas and flashcards per meeting / course (userData/sessions.json) -------------
const sessions = new SessionStore(join(app.getPath("userData"), "sessions.json"), () => Date.now(), log);
const flashcardsCsv = fileFlashcards(flashcardsPath);
/** Start of the current Live listening session (its Saved entry), or null before the first Start. */
let liveSessionAt: number | null = null;

/** Where saves go: the mock scenario, or the Live listening session. */
function openSession(): void {
  const kind = usage === "education" ? "course" : "meeting";
  if (mode === "mock") {
    const info = scenarioInfo(scenarioFor(usage));
    sessions.open({ id: `mock:${scenarioFor(usage)}`, title: info?.title ?? scenarioFor(usage), kind, source: "mock" });
    return;
  }
  const at = liveSessionAt ?? Date.now();
  const when = new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  sessions.open({ id: `live:${at}`, title: `${kind === "course" ? "Live lecture" : "Live meeting"} · ${when}`, kind, source: "live" });
}

function savedSnapshot() {
  return { currentId: sessions.currentId(), current: sessions.current(), sessions: sessions.list() };
}
sessions.on("change", () => send("saved", savedSnapshot()));

/** Open the scenario's video in Mock mode, close it otherwise (Live, or a scenario without one). */
function applyVideo(): void {
  const info = scenarioInfo(scenarioFor(usage));
  const file = info?.video ? join(mockDir, info.path, info.video) : null;
  if (mode === "mock" && file && existsSync(file)) videoWindow.open(file, info!.title);
  else {
    // A third-party clip is kept out of git: without the file the scenario still plays as text.
    if (mode === "mock" && file) log(`[video] ${file} not found: playing "${info!.title}" without the video`);
    videoWindow.close();
  }
}
let mode: PanelMode = "mock";
const playedLines: PanelLine[] = [];
// Mock terms explain from the glossary, live terms from the Explainer (set up below).
const overlay = new OverlayController({ clock, lookup: (term) => (mode === "live" ? explainer.lookup(term) : glossary[term]) });
const listener = { name: config.listenerName, knows: config.listenerKnows, aliases: config.listenerAliases };

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
// --- Education mode: Explain simply (slot 8, the Catch-up engine), Flashcard (6), Quiz me (7) ---------
const explain = new CatchUpController({
  clock,
  llm,
  transcript,
  meetingTime,
  keys: slots,
  overlay,
  log,
  onLlmOutcome,
  listenerName: config.listenerName,
  slot: 8,
  name: "Explain simply",
  messages: explainSimplyMessages,
});
const flashcards = new FlashcardController({
  clock,
  llm,
  transcript,
  meetingTime,
  keys: slots,
  overlay,
  log,
  onLlmOutcome,
  // Anki CSV (output/flashcards.csv) and the course's Saved view.
  file: {
    append: async (card) => {
      await flashcardsCsv.append(card);
      sessions.addCard(card);
    },
  },
});
const quiz = new QuizController({ clock, llm, transcript, meetingTime, keys: slots, overlay, log, onLlmOutcome });

const spotter = new TermSpotter({
  clock,
  llm: spotterLlm,
  listener,
  log,
  minIntervalMs: spotterIntervalMs(process.env),
});
const explainer = new Explainer({ clock, llm, listener, log, onLlmOutcome });

// --- camera focus: Logi Gaze Tracker -> FocusTracker -> Catch-up "Missed" + mention pulse ------

const gaze = new GazeClient({ url: process.env.GAZE_WS_URL || DEFAULT_GAZE_URL, clock, log: (m) => log(`[camera] ${m}`) });
const focus = new FocusTracker({ clock, meetingTime });
// Away + a "For me?" question: all keys pulse; looking back or any press opens the For-me card.
const mentionAlert = new MentionAlert({ clock, focus, keys: slots, overlay, log, reveal: () => void forMe.press() });

// The camera only counts in Live mode. In Mock mode "away" comes from the Demo row (Simulate away) alone,
// so "Simulate a question for me" pulses only the For-me key unless Simulate away is on too.
gaze.on("sample", (s) => {
  if (mode === "live") focus.sample(s);
});
gaze.on("live", (live: boolean) => focus.setCameraLive(live && mode === "live"));
gaze.on("status", (_s: GazeStatus) => pushSnapshot());
focus.on("change", (s: FocusStatus) => {
  log(`[focus] ${s.state}${s.reason ? ` (${s.reason})` : ""}`);
  pushSnapshot();
});
focus.on("back", (p: AwayPeriod) => {
  log(`[focus] back after ${Math.round(p.ms / 1000)} s away, meeting ${mmss(p.from)}-${mmss(p.to)}`);
  (usage === "education" ? explain : catchUp).setMissed(p); // the key that summarises: Catch-up or Explain simply
  mentionAlert.back();
});

const saver = new SaveController({
  clock,
  llm,
  transcript,
  meetingTime,
  keys: slots,
  overlay,
  // Saved ideas live in the app (Saved view, per meeting / course), not in a Markdown file.
  onSaved: (idea) => {
    if (sessions.addIdea(idea)) log(`saved to "${sessions.current()?.title ?? "?"}": ${idea.title}`);
  },
  log,
  onLlmOutcome,
});

const forMe = new ForMeController({
  clock,
  llm,
  transcript,
  // Education mode has no For-me key (slot 8 is Explain simply): questions still count for the away pulse.
  keys: { setActionOverride: (slot, o) => (usage === "meeting" ? slots.setActionOverride(slot, o) : undefined) },
  overlay,
  log,
  onLlmOutcome,
  listener,
  // Camera focus: when you look away, a question for you also pulses all keys (mentionAlert).
  onQuestion: (q) => {
    const r = mentionAlert.mention({ t: q.t, speaker: q.speaker, text: q.line });
    if (r === "flashing") log("for-me: you are away, all keys pulse");
  },
});
/** Start time, spoken seconds and the terms that reached a key, for the export. */
const record = new MeetingRecord();
const exporter = new MeetingExporter({ clock, llm, dir: meetingsDir, log, onLlmOutcome });
let exportStatus: PanelExport = { state: "idle", text: "" };
/** Set while quitting (dispose() ends the live source, which must not export) and during a Mock/Live switch. */
let quitting = false;
let switchingMode = false;

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
    usage,
    settings,
    scenarios: scenarios.filter((x) => x.usage === usage).map(({ id, title }) => ({ id, title })),
    scenario: scenarioFor(usage),
    playback: mockSource.state(),
    live: { ...liveSource.state(), keytermsText, configAdvice: sttConfigAdvice, spotter: spotter.status(), learnedKeyterms },
    llm: llmStatus,
    pluginsConnected: bridge.connectedCount(),
    keys: slots.getAll().map((k, i) => ({ ...k, term: slots.termAt(i) ?? undefined })),
    queued: slots.queued(),
    focus: focusSnapshot(),
    export: exportStatus,
  };
}

// --- MX Brio: is it plugged in? (macOS camera list; no camera permission needed) ------------------------
let brio: PanelSnapshot["focus"]["brio"] = { connected: false, checked: false };
function checkBrio(): void {
  execFile("system_profiler", ["SPCameraDataType", "-json"], { timeout: 8000 }, (err, out) => {
    let names: string[] = [];
    if (!err) {
      try {
        names = (JSON.parse(out).SPCameraDataType ?? []).map((c: { _name?: string }) => c._name ?? "");
      } catch {
        names = [];
      }
    }
    const name = names.find((n) => /mx\s*brio/i.test(n)) ?? names.find((n) => /brio/i.test(n));
    const next = { connected: !!name, name, checked: true };
    if (next.connected !== brio.connected || !brio.checked) {
      log(`[camera] MX Brio ${next.connected ? `connected (${name})` : "not found"}`);
      brio = next;
      pushSnapshot();
    }
  });
}

function focusSnapshot(): PanelSnapshot["focus"] {
  const f = focus.status();
  const m = catchUp.missedSpan();
  return {
    state: f.state,
    reason: f.reason,
    forMs: clock.now() - f.since,
    simulated: f.simulated,
    camera: gaze.status(),
    missed: m ? longSpan(m.to - m.from) : undefined,
    mentionFlashing: mentionAlert.isFlashing(),
    brio,
  };
}

const pushSnapshot = () => send("snapshot", snapshot());

// --- pipeline wiring: source -> transcript / SlotManager -> keypad ------------------------

/** Slot 8's last logged state: its 600 ms pulse frames (alert -> alert) are not logged one by one. */
let slot8Logged = "";

slots.on("change", (keys: KeyState[]) => {
  for (const k of keys) {
    if (k.slot === 8) {
      if (k.state === slot8Logged) continue;
      slot8Logged = k.state;
    }
    log(`slot ${k.slot} -> ${k.state === "empty" ? "empty" : `"${oneLine(k.label)}" ${k.state}`}`);
  }
  bridge.apply(keys);
  pushSnapshot();
});

// Speech -> key delay per live term (Deepgram word timestamps), logged when the term reaches a key.
const latency = new LatencyTracker();
/** When each live line became final (meeting seconds). */
const lineFinalAt = new WeakMap<TranscriptLine, number>();

// A term just landed on a key: recorded for the export. A live one gets its explanation now, so it is ready before the press.
slots.on("placed", ({ candidate }: { slot: number; candidate: TermCandidate }) => {
  record.placed(candidate.term, candidate.category, meetingTime());
  if (candidate.source !== "live") return;
  explainer.prefetch(candidate);
  const r = latency.placed(candidate.term, liveSource.position());
  if (r) log(formatLatency(r));
});

/** A spoken line from either source (mock: with terms; live: finals, terms come from the spotter). */
function onLine(line: LiveLine): void {
  transcript.add(line);
  record.addLine(line);
  const wordTimes = (line as { wordTimes?: number[] }).wordTimes;
  const pl: PanelLine = { t: line.t, speaker: line.speaker, text: line.text, terms: line.terms, ...(wordTimes ? { words: wordTimes } : {}) };
  playedLines.push(pl);
  log(`[${mmss(line.t)}] ${line.speaker ?? "?"}: ${line.text}`);
  send("line", pl);
  forMe.addLine(line); // a model call only when the listener's name is heard
}

/** A new meeting: mock Restart, Start listening, or a Mock/Live switch. */
function resetMeeting(why: string): void {
  log(`reset (${why})`);
  menu.close();
  catchUp.cancel();
  saver.reset();
  explain.cancel();
  flashcards.reset();
  quiz.reset();
  forMe.reset();
  record.reset();
  spotter.reset();
  explainer.reset();
  latency.reset();
  mentionAlert.reset();
  focus.restartPeriod();
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
mockSource.on("state", () => {
  pushSnapshot();
  videoWindow.sync(mockSource.state());
});
mockSource.on("end", () => {
  log("meeting finished");
  exportMeeting("end of the mock meeting", false); // silently: no Finder window
});

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
liveSource.on("end", () => {
  log("listening stopped");
  // The last words have arrived. A Mock/Live switch exports silently (no Finder); quitting does not export.
  if (!quitting) exportMeeting(switchingMode ? "mode switch" : "stop listening", !switchingMode);
});

async function setMode(m: PanelMode): Promise<void> {
  if (m === mode) return;
  switchingMode = true;
  try {
    if (m === "live") {
      exportMeeting("mode switch", false); // the mock meeting so far, silently
      mockSource.rewind();
    } else await liveSource.stop(); // its "end" exports silently
  } finally {
    switchingMode = false;
  }
  mode = m;
  if (m === "mock") focus.setCameraLive(false); // forget the camera's state; Live picks it up again from the next frame
  else focus.setSimulatedAway(false); // the Demo row is hidden in Live: never leave a simulation running there
  resetMeeting(`mode ${m}`);
  applyVideo();
  openSession();
  pushSnapshot();
}

/** Meeting <-> Education: new bottom row, and in Mock mode the matching mock content. */
function setUsage(u: Usage): void {
  if (u === usage) return;
  usage = u;
  ({ meeting, glossary } = loadScenario(scenarioFor(u)));
  mockSource.load(meeting, glossary, scenarioInfo(scenarioFor(u))?.duration);
  resetMeeting(`usage ${u}`);
  applyVideo();
  openSession();
  slots.setActionKeys(actionKeysFor(u));
  log(`usage: ${u}, scenario "${scenarioFor(u)}" (${meeting.length} mock lines, ${Object.keys(glossary).length} glossary terms)`);
  pushSnapshot();
}

/** Another mock scenario for the current mode (Settings → Scenario). Rewinds; remembered per mode. */
function setScenario(id: string): void {
  const info = scenarioInfo(id);
  if (!info || info.usage !== usage) {
    log(`panel: ignored scenario "${id}" (not a ${usage} scenario)`);
    return;
  }
  if (id === chosen[usage]) return;
  chosen[usage] = id;
  ({ meeting, glossary } = loadScenario(id));
  mockSource.load(meeting, glossary, info.duration);
  resetMeeting(`scenario ${id}`);
  applyVideo();
  openSession();
  log(`scenario: ${info.title} (${meeting.length} lines, ${Object.keys(glossary).length} glossary terms)`);
  updateSettings({ ...settings, scenario: { ...settings.scenario, [usage]: id } });
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
  // The listener's name and aliases first, so Deepgram writes the name (a few entries, far below the cap).
  const keyterms = parseKeyterms([config.listenerName, ...config.listenerAliases, text, ...learnedKeyterms]);
  log(`listening${keyterms.length ? ` (keyterms: ${keyterms.join(", ")})` : ""}`);
  liveSource.start(keyterms);
  liveSessionAt = Date.now();
  openSession();
}

// --- key menus: Catch-up / Save first ask how far back (protocol/messages.md, "Key menus") -------------
const menu = new KeypadMenu({
  clock,
  keys: slots,
  log,
  onPick: (m, seconds) => {
    const outcome = m === "catch-up" ? catchUp.press({ windowS: seconds }) : saver.press({ windowS: seconds });
    log(`${m} over the last ${seconds} s -> ${outcome}`);
  },
});

/** Same-slot repeats within 300 ms are dropped (a bumped keypad, a bouncing key). */
const debouncer = new PressDebouncer(clock);

bridge.on("press", ({ slot }: PressEvent) => {
  const received = performance.now();
  const guard = debouncer.check(slot);
  if (!guard.ok) {
    log(`PRESS slot ${slot} ignored: ${guard.reason}`);
    return;
  }
  if (mentionAlert.consumePress()) {
    log(`PRESS slot ${slot}: stopped the away-mention pulse`);
    return;
  }
  if (menu.isOpen()) {
    log(`PRESS slot ${slot}: ${menu.openMenu()} menu -> ${menu.press(slot)}`);
    return;
  }
  const r = slots.press(slot);
  switch (r.kind) {
    case "term": {
      // A live term whose explanation failed (or never started) is asked for again; the card waits.
      record.opened(r.term);
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
      // Catch-up / Save ask how far back first, unless Catch-up shows "Missed" (summarises that span),
      // is busy or has its card up (the press hides it), or Save is busy.
      if (r.action === "catch-up" && !catchUp.missedSpan() && !catchUp.occupied()) {
        menu.open("catch-up");
        break;
      }
      if (r.action === "save" && !saver.busyNow()) {
        menu.open("save");
        break;
      }
      const outcome =
        r.action === "catch-up"
          ? catchUp.press()
          : r.action === "save"
            ? saver.press()
            : r.action === "for-me"
              ? forMe.press()
              : r.action === "flashcard"
                ? flashcards.press()
                : r.action === "quiz"
                  ? quiz.press()
                  : r.action === "explain"
                    ? explain.press()
                    : null;
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
bridge.on("nav", ({ dir }: NavEvent) => {
  if (dir === "left" && menu.back()) return;
  log(`NAV ${dir}: nothing to go back from`);
});

// --- meeting export (output/meetings/<YYYY-MM-DD HHmm>.md) --------------------------------------

/** Everything the file shows, taken now: a reset right after (mode switch) cannot empty it. */
function meetingSnapshot(): MeetingSnapshot {
  const lines = transcript.all();
  const terms: ExportTerm[] = record.terms().map((r) => {
    const e = mode === "live" ? explainer.lookup(r.term) : glossary[r.term];
    const ready = e && !(e as { pending?: boolean }).pending;
    return { ...r, full: ready ? e.full : undefined, explanation: ready ? e.explanation : "" };
  });
  const last = lines[lines.length - 1];
  return {
    meetingId: record.id,
    mode,
    startedAt: record.startedAt ?? new Date(),
    durationS: Math.max(meetingTime(), last?.t ?? 0),
    spokenS: record.spokenS,
    listenerName: config.listenerName,
    lines,
    terms,
    questions: forMe.questions(),
    ideas: saver.savedIdeas(),
    catchUps: catchUp.history(),
  };
}

function setExportStatus(s: PanelExport): void {
  exportStatus = s;
  pushSnapshot();
}

/** Writes the export; `reveal` shows it in Finder (button, Stop listening). */
function exportMeeting(why: string, reveal: boolean): void {
  const snap = meetingSnapshot();
  if (snap.lines.length === 0) {
    log(`export (${why}): nothing was said, skipped`);
    if (why === "button") setExportStatus({ state: "error", text: "Nothing to export yet." });
    return;
  }
  log(`export (${why})${reveal ? "" : ", silent"}`);
  setExportStatus({ state: "busy", text: "Exporting…" });
  void exporter.export(snap).then((r) => {
    if (r.status === "written") {
      const rel = r.path.slice(r.path.indexOf("output/"));
      setExportStatus({ state: "ok", text: `Exported: ${rel}` });
      if (reveal && !quitting) shell.showItemInFolder(r.path);
    } else if (r.status === "failed") setExportStatus({ state: "error", text: `Export failed: ${r.error}` });
  });
}

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

ipcMain.handle("panel:init", () => ({ snapshot: snapshot(), lines: playedLines, listener: config.listenerName, saved: savedSnapshot() }));

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
    case "theme-dark":
    case "theme-light": {
      const theme = cmd === "theme-light" ? "light" : "dark";
      overlayWindow?.setTheme(theme);
      panel?.setBackgroundColor(panelBackground(theme));
      updateSettings({ ...settings, theme });
      break;
    }
    case "key-bg": {
      const change = parseKeyBgArg(arg);
      if (!change) {
        log(`panel: ignored key-bg "${String(arg)}"`);
        break;
      }
      const keyBg = { ...settings.keyBg };
      if (change.color) keyBg[change.target] = change.color;
      else delete keyBg[change.target];
      slots.setBackgrounds(keyBg);
      updateSettings({ ...settings, keyBg });
      break;
    }
    case "key-bg-reset":
      slots.setBackgrounds({});
      updateSettings({ ...settings, keyBg: {} });
      break;
    case "scenario":
      if (typeof arg === "string") setScenario(arg);
      break;
    case "usage-meeting":
    case "usage-education":
      setUsage(cmd === "usage-education" ? "education" : "meeting");
      break;
    case "export":
      exportMeeting("button", true);
      break;
    case "sim-away":
      focus.setSimulatedAway(arg === "on");
      break;
    case "sim-mention":
      // Goes through the real "For me?" check (one model call), as if this line had been said.
      forMe.addLine({ t: meetingTime(), speaker: "Demo", text: `${config.listenerName}, can you send me the latency numbers by Friday?` });
      break;
    case "open-gaze-tracker":
      execFile("open", ["-a", "Gaze Tracker"], (err) => {
        if (err) log(`[camera] could not open the Gaze Tracker app: ${err.message}`);
      });
      break;
    case "gaze-calibrate":
      if (!gaze.calibrate()) log("[camera] cannot calibrate: Gaze Tracker not connected");
      break;
  }
});

/** Window background behind the page (shown while resizing): same as --bg in panel.css. */
function panelBackground(theme: "dark" | "light"): string {
  return theme === "light" ? "#F7F7F8" : "#1C1C1E";
}

function createPanel(): void {
  // Compact companion window next to the meeting: native title bar inset into the toolbar (panel.css).
  // Docked at the right edge, so a video scenario (top-left) and the pop-up cards (bottom-left) stay clear of it.
  const { workArea } = screen.getPrimaryDisplay();
  panel = new BrowserWindow({
    x: workArea.x + workArea.width - 360 - 24,
    y: workArea.y + 24,
    width: 360,
    height: Math.min(640, workArea.height - 48),
    minWidth: 320,
    minHeight: 460,
    title: "IntelliPad",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 12 },
    backgroundColor: panelBackground(settings.theme),
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
    dialog.showErrorBox("IntelliPad", msg);
    app.exit(1);
    return;
  }

  overlayWindow = new OverlayWindow({ appRoot, onShown: onOverlayShown, onClose: () => overlay.hide("dismiss"), log: (m) => log(`[overlay] ${m}`) });
  overlayWindow.setTheme(settings.theme);
  createPanel();
  applyVideo();
  openSession();
  void runWarmUp();
  gaze.start(); // retries every 2 s, so the Gaze Tracker app can start before or after us
  checkBrio();
  setInterval(checkBrio, 10_000); // plugged in / out
  if (!(spotterLlm instanceof MisconfiguredClient)) {
    void warmUp(spotterLlm, clock).then((r) =>
      log(r.ok ? `[spotter-llm] warm-up ok: ${spotterLlm.describe()} in ${r.ms} ms` : `[spotter-llm] WARNING: warm-up failed: ${r.error.kind}: ${r.error.message}`),
    );
  }
  log(`ready (${usage}, scenario ${scenarioFor(usage)}): ${meeting.length} lines, ${Object.keys(glossary).length} glossary terms, listener "${config.listenerName}". Press Play in the panel.`);
  if (process.env.AUTOPLAY === "1") mockSource.play(); // AUTOPLAY=1 npm run dev: start the meeting right away
  if (process.env.AUTOLISTEN === "1") {
    // AUTOLISTEN=1 npm run dev: Live mode, listening right away
    void setMode("live").then(() => startListening(keytermsText));
  }
  setInterval(() => {
    if (mockSource.state().playing || liveSource.isListening() || focus.status().state !== "off") pushSnapshot();
    if (mockSource.state().playing) videoWindow.sync(mockSource.state()); // keeps the video within 0.35 s
  }, 500);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  videoWindow.close();
  forMe.reset();
  catchUp.cancel();
  saver.reset();
  explain.cancel();
  flashcards.reset();
  quiz.reset();
  mentionAlert.reset();
  gaze.stop();
  spotter.dispose();
  mockSource.dispose();
  audio.killNow(); // never leave audiotee running after the app quits
  void liveSource.dispose();
  overlay.dispose();
  overlayWindow?.destroy();
  slots.dispose();
  void bridge.stop();
});
