// Speech-to-text: the interface LiveSource uses, and the Deepgram live implementation.
//
// Time base: every segment's `start` / `end` is in "session audio seconds", i.e. seconds of
// 16 kHz mono Int16 audio handed to send() since start(). LiveSource counts the same bytes, so
// it can map a segment back to meeting time even across reconnects.

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Clock, TimerHandle } from "./clock.js";

export const SAMPLE_RATE = 16000;
/** Int16 mono at 16 kHz. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** One piece of recognised speech. */
export interface SttSegment {
  text: string;
  /** "Speaker 1", "Speaker 2", ... when diarization is on. */
  speaker?: string;
  /** Session audio seconds. */
  start: number;
  end: number;
}

export type SttState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface SttStatus {
  state: SttState;
  /** Short text for the panel, e.g. "Deepgram connected · nova-3 · en". */
  text: string;
  /** What to do, when state is "error". */
  advice?: string;
}

export type SttErrorKind = "config" | "auth" | "bad_request" | "network" | "server";

export class SttError extends Error {
  constructor(
    readonly kind: SttErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SttError";
  }
}

export interface SttOptions {
  /** Deepgram keyterms (meeting topic, names, jargon). */
  keyterms: string[];
}

/**
 * A live STT session. Events: `interim` (SttSegment, may be replaced by the next one),
 * `final` (SttSegment, one per utterance), `status` (SttStatus).
 */
export interface SttSession extends EventEmitter {
  start(): void;
  /** 16 kHz mono Int16 LE PCM. */
  send(pcm: Buffer): void;
  /** Flushes the last words (final events may still arrive), then closes. */
  stop(): Promise<void>;
  status(): SttStatus;
}

export type SttFactory = (opts: SttOptions) => SttSession;

// --- config (app/.env) ---------------------------------------------------------------------

export interface DeepgramConfig {
  apiKey: string;
  /** "en" (default), "multi" for mixed English/French, or any Deepgram language code. */
  language: string;
  model: string;
  diarize: boolean;
  endpointingMs: number;
  utteranceEndMs: number;
  /** Override for tests: ws://127.0.0.1:port/v1/listen */
  baseUrl: string;
}

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

export function loadSttConfig(env: Record<string, string | undefined>): DeepgramConfig {
  const apiKey = (env.DEEPGRAM_API_KEY ?? "").trim();
  if (!apiKey) throw new SttError("config", "DEEPGRAM_API_KEY is not set");
  const language = (env.DEEPGRAM_LANGUAGE ?? "").trim() || "en";
  const num = (v: string | undefined, def: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : def;
  };
  return {
    apiKey,
    language,
    model: (env.DEEPGRAM_MODEL ?? "").trim() || "nova-3",
    diarize: (env.DEEPGRAM_DIARIZE ?? "true").trim().toLowerCase() !== "false",
    // Deepgram recommends 100 ms for code-switching ("multi").
    endpointingMs: num(env.DEEPGRAM_ENDPOINTING_MS, language === "multi" ? 100 : 300),
    utteranceEndMs: num(env.DEEPGRAM_UTTERANCE_END_MS, 1000),
    baseUrl: DEEPGRAM_URL,
  };
}

export function sttAdvice(e: SttError): string {
  switch (e.kind) {
    case "config":
      return "Add DEEPGRAM_API_KEY=... to app/.env (see app/.env.example), then restart the app.";
    case "auth":
      return "Deepgram rejected DEEPGRAM_API_KEY. Check the key in app/.env (console.deepgram.com → API Keys), then restart the app.";
    case "bad_request":
      return `Deepgram refused the settings: ${e.message}. Check DEEPGRAM_LANGUAGE / DEEPGRAM_MODEL in app/.env and the keyterms.`;
    case "network":
      return "Cannot reach api.deepgram.com. Check the internet connection; the app keeps retrying.";
    case "server":
      return "Deepgram had a problem; the app keeps retrying.";
  }
}

/**
 * Splits the panel's "meeting topic / keyterms" text (or config entries) into keyterms:
 * comma / semicolon / newline separated, trimmed, de-duplicated, at most 50 terms and ~400 words
 * (Deepgram allows 500 tokens per request).
 */
export function parseKeyterms(input: string | string[]): string[] {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((s) => String(s).split(/[,;\n]/));
  const out: string[] = [];
  const seen = new Set<string>();
  let words = 0;
  for (const p of parts) {
    const term = p.replace(/\s+/g, " ").trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    const w = term.split(" ").length;
    if (out.length >= 50 || words + w > 400) break;
    seen.add(term.toLowerCase());
    out.push(term);
    words += w;
  }
  return out;
}

/** Live streaming URL. The API key never goes into it (it is sent as a header). */
export function deepgramUrl(cfg: Omit<DeepgramConfig, "apiKey">, keyterms: string[]): string {
  const q = new URLSearchParams({
    model: cfg.model,
    language: cfg.language,
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: String(cfg.endpointingMs),
    utterance_end_ms: String(cfg.utteranceEndMs),
    vad_events: "true",
  });
  if (cfg.diarize) q.set("diarize", "true");
  for (const k of keyterms) q.append("keyterm", k);
  return `${cfg.baseUrl}?${q.toString()}`;
}

// --- utterance assembly (pure) ------------------------------------------------------------------

interface DgWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

export interface DgResults {
  type: "Results";
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: DgWord[] }[] };
}

interface Piece {
  text: string;
  start: number;
  end: number;
  speakers: number[];
}

/**
 * Turns Deepgram Results / UtteranceEnd messages into utterances. `is_final` pieces collect
 * until `speech_final` (endpointing) or `UtteranceEnd` (gap in words), then become one final
 * segment. Interim = collected pieces + the current not-yet-final text.
 * `offset` = session audio seconds at which this connection's audio began.
 */
export class DeepgramAssembler {
  private pieces: Piece[] = [];

  results(msg: DgResults, offset: number): { interim?: SttSegment; final?: SttSegment } {
    const alt = msg.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    const words = alt?.words ?? [];
    const start = offset + (words[0]?.start ?? msg.start);
    const end = offset + (words.length ? (words[words.length - 1].end ?? msg.start + msg.duration) : msg.start + msg.duration);
    const speakers = words.map((w) => w.speaker).filter((s): s is number => typeof s === "number");
    if (!msg.is_final) {
      if (!text) return {};
      return { interim: this.join([...this.pieces, { text, start, end, speakers }]) };
    }
    if (text) this.pieces.push({ text, start, end, speakers });
    if (msg.speech_final) {
      const final = this.flush();
      return final ? { final } : {};
    }
    return this.pieces.length ? { interim: this.join(this.pieces) } : {};
  }

  utteranceEnd(): SttSegment | null {
    return this.flush();
  }

  /** Whatever is collected, as a final segment (stop / disconnect). */
  flush(): SttSegment | null {
    if (this.pieces.length === 0) return null;
    const seg = this.join(this.pieces);
    this.pieces = [];
    return seg;
  }

  private join(pieces: Piece[]): SttSegment {
    const speakers = pieces.flatMap((p) => p.speakers);
    return {
      text: pieces.map((p) => p.text).join(" "),
      speaker: majoritySpeaker(speakers),
      start: pieces[0].start,
      end: pieces[pieces.length - 1].end,
    };
  }
}

function majoritySpeaker(speakers: number[]): string | undefined {
  if (speakers.length === 0) return undefined;
  const count = new Map<number, number>();
  for (const s of speakers) count.set(s, (count.get(s) ?? 0) + 1);
  let best = speakers[0];
  for (const [s, n] of count) if (n > (count.get(best) ?? 0)) best = s;
  return `Speaker ${best + 1}`;
}

// --- Deepgram live session ---------------------------------------------------------------------

export interface DeepgramDeps {
  clock: Clock;
  log: (msg: string) => void;
  /** Reconnect delays in ms. */
  backoffMs?: number[];
  /** Audio kept while (re)connecting, seconds. */
  bufferS?: number;
  keepAliveMs?: number;
  /** How long stop() waits for the last results. */
  closeWaitMs?: number;
}

interface Chunk {
  buf: Buffer;
  /** Session audio seconds at the chunk's first sample. */
  at: number;
}

const KEEPALIVE = JSON.stringify({ type: "KeepAlive" });
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" });

export class DeepgramStt extends EventEmitter implements SttSession {
  private readonly backoff: number[];
  private readonly bufferS: number;
  private readonly keepAliveMs: number;
  private readonly closeWaitMs: number;
  private ws: WebSocket | null = null;
  private st: SttStatus = { state: "idle", text: "Speech-to-text: idle" };
  private wanted = false;
  private fatal = false;
  private attempt = 0;
  private sentS = 0; // session audio seconds handed to send()
  private connOffset: number | null = null;
  private queue: Chunk[] = [];
  private lastAudioAt = 0;
  private assembler = new DeepgramAssembler();
  private retryTimer: TimerHandle | null = null;
  private keepAliveTimer: TimerHandle | null = null;
  private closed: (() => void) | null = null;

  constructor(
    private readonly cfg: DeepgramConfig,
    private readonly opts: SttOptions,
    private readonly deps: DeepgramDeps,
  ) {
    super();
    this.backoff = deps.backoffMs ?? [1000, 2000, 4000, 8000, 15000];
    this.bufferS = deps.bufferS ?? 10;
    this.keepAliveMs = deps.keepAliveMs ?? 4000;
    this.closeWaitMs = deps.closeWaitMs ?? 2500;
  }

  describe(): string {
    return `${this.cfg.model} · ${this.cfg.language}`;
  }

  status(): SttStatus {
    return this.st;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.fatal = false;
    const terms = this.opts.keyterms.length ? `, ${this.opts.keyterms.length} keyterms` : "";
    this.deps.log(`deepgram: ${this.describe()}${this.cfg.diarize ? ", diarize" : ""}${terms}, endpointing ${this.cfg.endpointingMs} ms`);
    this.connect();
    this.scheduleKeepAlive();
  }

  send(pcm: Buffer): void {
    if (!this.wanted || pcm.length === 0) return;
    const chunk = { buf: pcm, at: this.sentS };
    this.sentS += pcm.length / BYTES_PER_SECOND;
    if (this.ws?.readyState === WebSocket.OPEN && this.queue.length === 0) {
      this.write(chunk);
      return;
    }
    if (this.fatal) return;
    this.queue.push(chunk);
    // Keep only the newest bufferS seconds; drop from the front so the queue stays contiguous.
    while (this.queue.length > 1 && this.sentS - this.queue[0].at > this.bufferS) this.queue.shift();
  }

  async stop(): Promise<void> {
    if (!this.wanted) return;
    this.wanted = false;
    this.clearTimers();
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (const c of this.queue) this.write(c);
      this.queue = [];
      await new Promise<void>((resolve) => {
        const t = this.deps.clock.setTimeout(() => {
          this.deps.log("deepgram: no close after CloseStream, closing");
          ws.terminate();
          resolve();
        }, this.closeWaitMs);
        this.closed = () => {
          this.deps.clock.clearTimeout(t);
          resolve();
        };
        ws.send(CLOSE_STREAM);
      });
    } else {
      ws?.terminate();
    }
    this.ws = null;
    this.queue = [];
    this.emitFlush();
    this.setStatus({ state: "closed", text: "Speech-to-text: stopped" });
  }

  private connect(): void {
    this.connOffset = null;
    this.setStatus({ state: this.attempt === 0 ? "connecting" : "reconnecting", text: "Speech-to-text: connecting…" });
    const ws = new WebSocket(deepgramUrl(this.cfg, this.opts.keyterms), {
      headers: { Authorization: `Token ${this.cfg.apiKey}` },
    });
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      if (this.ws === ws) this.ws = null; // handled here; its close event is ignored
      const code = res.statusCode ?? 0;
      const detail = String(res.headers["dg-error"] ?? res.statusMessage ?? "");
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString("utf8").slice(0, 300)));
      res.on("end", () => {
        const msg = `HTTP ${code}${detail ? ` ${detail}` : ""}${body && !detail ? ` ${body.trim()}` : ""}`;
        if (code === 401 || code === 403) this.fail(new SttError("auth", msg));
        else if (code === 400) this.fail(new SttError("bad_request", msg));
        else this.retry(new SttError(code >= 500 ? "server" : "network", msg));
      });
      ws.terminate();
    });

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus({ state: "open", text: `Speech-to-text: Deepgram ${this.describe()}` });
      const queued = this.queue;
      this.queue = [];
      for (const c of queued) this.write(c);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || this.ws !== ws) return;
      this.onMessage(String(data));
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      this.deps.log(`deepgram: socket error: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      if (this.closed) {
        const done = this.closed;
        this.closed = null;
        done();
        return;
      }
      if (this.ws !== ws) return;
      this.ws = null;
      this.emitFlush();
      if (!this.wanted || this.fatal) return;
      this.retry(new SttError(code === 1011 ? "server" : "network", `closed ${code}${reason.length ? ` ${reason}` : ""}`));
    });
  }

  private write(c: Chunk): void {
    if (this.connOffset === null) this.connOffset = c.at;
    this.ws!.send(c.buf);
    this.lastAudioAt = this.deps.clock.now();
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const offset = this.connOffset ?? 0;
    if (msg.type === "Results") {
      const r = this.assembler.results(msg as unknown as DgResults, offset);
      if (r.final) this.emit("final", r.final);
      else if (r.interim) this.emit("interim", r.interim);
    } else if (msg.type === "UtteranceEnd") {
      const seg = this.assembler.utteranceEnd();
      if (seg) this.emit("final", seg);
    } else if (msg.type === "Error" || msg.type === "error") {
      this.deps.log(`deepgram: error message: ${JSON.stringify(msg).slice(0, 300)}`);
    }
  }

  private emitFlush(): void {
    const seg = this.assembler.flush();
    if (seg) this.emit("final", seg);
  }

  private fail(e: SttError): void {
    this.fatal = true;
    this.deps.log(`deepgram: ${e.kind}: ${e.message}`);
    this.ws = null;
    this.queue = [];
    this.setStatus({ state: "error", text: `Speech-to-text: ${e.kind.replace("_", " ")}`, advice: sttAdvice(e) });
  }

  private retry(e: SttError): void {
    if (!this.wanted || this.fatal) return;
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt++;
    this.deps.log(`deepgram: ${e.kind}: ${e.message}; reconnecting in ${delay} ms`);
    this.setStatus({
      state: "reconnecting",
      text: `Speech-to-text: reconnecting in ${Math.round(delay / 1000)} s`,
      advice: e.kind === "network" || e.kind === "server" ? sttAdvice(e) : undefined,
    });
    this.ws = null;
    if (this.retryTimer !== null) this.deps.clock.clearTimeout(this.retryTimer);
    this.retryTimer = this.deps.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && !this.fatal) this.connect();
    }, delay);
  }

  private scheduleKeepAlive(): void {
    this.keepAliveTimer = this.deps.clock.setTimeout(() => {
      this.keepAliveTimer = null;
      if (!this.wanted) return;
      const ws = this.ws;
      if (ws?.readyState === WebSocket.OPEN && this.deps.clock.now() - this.lastAudioAt >= this.keepAliveMs) ws.send(KEEPALIVE);
      this.scheduleKeepAlive();
    }, this.keepAliveMs);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) this.deps.clock.clearTimeout(this.retryTimer);
    if (this.keepAliveTimer !== null) this.deps.clock.clearTimeout(this.keepAliveTimer);
    this.retryTimer = this.keepAliveTimer = null;
  }

  private setStatus(s: SttStatus): void {
    this.st = s;
    this.emit("status", s);
  }
}

/** Factory for LiveSource: one Deepgram session per Start. */
export function deepgramFactory(cfg: DeepgramConfig, deps: DeepgramDeps): SttFactory {
  return (opts) => new DeepgramStt(cfg, opts, deps);
}
